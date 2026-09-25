"""
collecteur_gtfs_rt.py
=====================
Collecte en continu les flux GTFS-Realtime de la STM (positions des véhicules
et prévisions de passage) et les archive en Parquet pour l'analyse
exploratoire (notebooks/) et la détection d'anomalies.

Sorties (non versionnées, data_brute/ est ignoré par git) :
  <sortie>/positions/date_utc=AAAA-MM-JJ/*.parquet
  <sortie>/trip_updates/date_utc=AAAA-MM-JJ/*.parquet
  <sortie>/journal.jsonl   une ligne par appel : statut HTTP, durée, fraîcheur
                           du flux, volumes. Les échecs y sont consignés aussi :
                           la qualité du flux est elle-même une donnée à analyser.
  <sortie>/gtfs_statique/  chaque version du GTFS STM publiée pendant la collecte.
                           Indispensable : tripUpdates ne donne que des heures
                           prévues absolues (aucun champ delay), le retard se
                           calcule contre l'horaire théorique EN VIGUEUR, et les
                           trip_id changent d'une version GTFS à l'autre.

Les positions inchangées d'un appel à l'autre (même véhicule, même horodatage
GPS) ne sont pas réécrites ; le journal garde le décompte total et nouveau.

Clé API : variable d'environnement STM_API_KEY (portail développeurs STM).

Usage :
    set STM_API_KEY=...                       (Windows cmd)
    python scripts/collecteur_gtfs_rt.py      (Ctrl+C pour arrêter proprement)
    python scripts/collecteur_gtfs_rt.py --duree-h 72 --sortie D:/gtfs_rt
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))
sys.path.insert(0, str(RACINE / "serveur"))

import requests  # noqa: E402

from config import DATA_BRUTE  # noqa: E402
from gtfs_rt import decoder_positions, decoder_trip_updates, telecharger_flux  # noqa: E402
from telecharger_donnees import URL_GTFS_STM  # noqa: E402

VERIF_GTFS_H = 6   # fréquence de vérification d'une nouvelle version du GTFS statique


def _arguments():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--sortie", type=Path, default=DATA_BRUTE / "gtfs_rt",
                   help="dossier d'archive (défaut : data_brute/gtfs_rt)")
    p.add_argument("--intervalle-positions", type=float, default=30.0,
                   help="secondes entre deux appels vehiclePositions (défaut 30)")
    p.add_argument("--intervalle-trips", type=float, default=120.0,
                   help="secondes entre deux appels tripUpdates (défaut 120 ; ~300 ko Parquet par appel)")
    p.add_argument("--arrets-max", type=int, default=10,
                   help="arrêts à venir gardés par trajet dans tripUpdates (défaut 10)")
    p.add_argument("--vidage-min", type=float, default=10.0,
                   help="minutes entre deux écritures Parquet (défaut 10)")
    p.add_argument("--duree-h", type=float, default=None,
                   help="arrêt automatique après N heures (défaut : illimité)")
    return p.parse_args()


class Tampon:
    """Accumule les lignes d'un flux et les écrit par lots Parquet partitionnés par jour UTC."""

    def __init__(self, dossier):
        self.dossier = dossier
        self.lignes = []

    def vider(self):
        if not self.lignes:
            return 0
        df = pd.DataFrame(self.lignes)
        self.lignes = []
        # Les entiers optionnels (None) deviennent float sinon : on garde des entiers nullables.
        for col in df.columns:
            if col.startswith(("t_", "stop_sequence", "retard_", "arrivee_", "depart_")):
                df[col] = df[col].astype("Int64")
        n = 0
        jours = pd.to_datetime(df["t_collecte"], unit="s", utc=True).dt.strftime("%Y-%m-%d")
        for jour, bloc in df.groupby(jours):
            d = self.dossier / f"date_utc={jour}"
            d.mkdir(parents=True, exist_ok=True)
            horo = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            bloc.to_parquet(d / f"{self.dossier.name}_{horo}.parquet", index=False)
            n += len(bloc)
        return n


def archiver_gtfs_statique(dossier):
    """
    Archive le GTFS STM s'il a changé depuis la dernière archive (comparaison
    par ETag, sans retélécharger les 40+ Mo). Renvoie le chemin écrit ou None.
    Un échec est signalé mais n'interrompt pas la collecte temps réel.
    """
    try:
        entetes = requests.head(URL_GTFS_STM, timeout=30).headers
        etag = entetes.get("ETag", "").strip('"').replace("/", "_") or "sans-etag"
        if any(dossier.glob(f"*_{etag}.zip")):
            return None
        date = pd.to_datetime(entetes.get("Last-Modified", datetime.now(timezone.utc)))
        cible = dossier / f"gtfs_stm_{date:%Y-%m-%d}_{etag}.zip"
        rep = requests.get(URL_GTFS_STM, timeout=600)
        rep.raise_for_status()
        dossier.mkdir(parents=True, exist_ok=True)
        cible.write_bytes(rep.content)
        return cible
    except (requests.RequestException, OSError) as e:
        print(f"  ⚠ archivage GTFS statique impossible ({e}) — nouvel essai dans {VERIF_GTFS_H} h")
        return None


def main():
    args = _arguments()
    cle = os.environ.get("STM_API_KEY", "").strip()
    if not cle:
        sys.exit("STM_API_KEY non définie : créer une clé sur le portail développeurs "
                 "STM puis `set STM_API_KEY=...` (cmd) ou `export STM_API_KEY=...` (bash).")

    args.sortie.mkdir(parents=True, exist_ok=True)
    journal = open(args.sortie / "journal.jsonl", "a", encoding="utf-8")
    tampons = {
        "positions": Tampon(args.sortie / "positions"),
        "trip_updates": Tampon(args.sortie / "trip_updates"),
    }
    intervalles = {"positions": args.intervalle_positions,
                   "trip_updates": args.intervalle_trips}
    prochain = {f: 0.0 for f in intervalles}
    echecs = {f: 0 for f in intervalles}
    deja_reussi = {f: False for f in intervalles}
    derniere_position = {}   # vehicule_id -> t_position déjà archivé
    t_debut = time.time()
    prochain_vidage = t_debut + args.vidage_min * 60
    prochaine_verif_gtfs = 0.0

    print(f"Collecte GTFS-RT STM → {args.sortie}  (Ctrl+C pour arrêter)")
    try:
        while args.duree_h is None or time.time() - t_debut < args.duree_h * 3600:
            maintenant = time.time()
            if maintenant >= prochaine_verif_gtfs:
                archive = archiver_gtfs_statique(args.sortie / "gtfs_statique")
                if archive:
                    print(f"  → GTFS statique archivé : {archive.name}")
                prochaine_verif_gtfs = time.time() + VERIF_GTFS_H * 3600
                maintenant = time.time()
            for flux in intervalles:
                if maintenant < prochain[flux]:
                    continue
                t_collecte = int(time.time())
                contenu, http, duree_ms = telecharger_flux(flux, cle)
                entree = {"flux": flux, "t_collecte": t_collecte, "http": http,
                          "duree_ms": duree_ms, "octets": len(contenu) if contenu else 0}
                if contenu is not None:
                    try:
                        if flux == "positions":
                            t_flux, lignes = decoder_positions(contenu, t_collecte)
                            nouvelles = [l for l in lignes
                                         if derniere_position.get(l["vehicule_id"]) != l["t_position"]]
                            for l in nouvelles:
                                derniere_position[l["vehicule_id"]] = l["t_position"]
                            entree.update(n_total=len(lignes), n_nouvelles=len(nouvelles))
                        else:
                            t_flux, nouvelles = decoder_trip_updates(contenu, t_collecte, args.arrets_max)
                            entree.update(n_total=len(nouvelles), n_nouvelles=len(nouvelles))
                        tampons[flux].lignes.extend(nouvelles)
                        entree["age_flux_s"] = t_collecte - t_flux if t_flux else None
                        echecs[flux] = 0
                    except Exception as e:  # flux corrompu : on journalise et on continue
                        entree["erreur"] = f"decodage: {e}"
                        echecs[flux] += 1
                else:
                    echecs[flux] += 1
                journal.write(json.dumps(entree) + "\n")
                journal.flush()
                print(json.dumps(entree))
                if http in (400, 401, 403) and not deja_reussi[flux]:
                    # Refus dès le premier appel = clé invalide : inutile de tourner des jours à vide.
                    sys.exit(f"Appel {flux} refusé (HTTP {http}) dès le départ : vérifier STM_API_KEY.")
                deja_reussi[flux] = deja_reussi[flux] or contenu is not None
                # Recul progressif après des échecs consécutifs (quota, panne), plafonné à 5 min.
                recul = min(300.0, intervalles[flux] * (2 ** min(echecs[flux], 4))) if echecs[flux] else 0.0
                prochain[flux] = maintenant + intervalles[flux] + recul

            if time.time() >= prochain_vidage:
                for flux, tampon in tampons.items():
                    n = tampon.vider()
                    if n:
                        print(f"  → {n:,} lignes {flux} écrites")
                prochain_vidage = time.time() + args.vidage_min * 60
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\nArrêt demandé.")
    finally:
        for flux, tampon in tampons.items():
            n = tampon.vider()
            if n:
                print(f"  → {n:,} lignes {flux} écrites (vidage final)")
        journal.close()


if __name__ == "__main__":
    main()
