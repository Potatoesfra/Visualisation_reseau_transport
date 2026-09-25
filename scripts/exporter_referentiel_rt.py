"""
exporter_referentiel_rt.py
==========================
Construit le référentiel compact qui permet d'interpréter le flux GTFS-Realtime
STM sur la carte : pour chaque trajet (trip_id) du GTFS EN VIGUEUR, son tracé
(shape) et sa direction, plus les tracés simplifiés.

Pourquoi un référentiel à part, et pas le GTFS du pipeline (p01–p08) :
  - les trip_id changent à chaque publication du GTFS : ceux du flux temps réel
    n'existent que dans le GTFS en vigueur (0 % de correspondance avec une
    version antérieure, mesuré) ;
  - le direction_id du flux temps réel contredit celui du GTFS pour ~30 % des
    trajets : la direction fiable est celle du trajet dans le GTFS ;
  - l'écart d'un bus à SON tracé (détection de détour) doit se mesurer contre
    le tracé en vigueur, pas contre des segments construits sur une version
    antérieure.

Il porte aussi l'horaire minimal du tableau de bord réseau (service prévu vs
service réel) : pour chaque trajet, sa ligne, son service (calendrier), ses
heures de début et de fin (secondes depuis minuit du jour de service, > 86 400
pour les trajets après minuit) et sa destination ; plus le calendrier des
services (calendar.txt + exceptions calendar_dates.txt). stop_times.txt
(~200 Mo) n'est lu que par blocs, ici, jamais par le serveur.

Sortie (versionnée, ~1,5 Mo) : data_derivee/payloads_statiques/referentiel_rt.json.gz

À relancer à chaque nouvelle publication du GTFS STM (la validité du GTFS
utilisé est affichée à la fin ; le serveur signale un référentiel périmé quand
trop de trajets du flux y sont inconnus).

Usage :
    python scripts/exporter_referentiel_rt.py                    (télécharge le GTFS STM courant)
    python scripts/exporter_referentiel_rt.py --gtfs chemin.zip  (ex. archive du collecteur)
"""
import argparse
import gzip
import io
import json
import math
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from shapely.geometry import LineString

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))
sys.path.insert(0, str(RACINE / "scripts"))

from config import DATA_DERIVEE  # noqa: E402
from telecharger_donnees import URL_GTFS_STM  # noqa: E402

SORTIE = DATA_DERIVEE / "payloads_statiques" / "referentiel_rt.json.gz"
TOLERANCE_SIMPLIFICATION_M = 3.0   # bien en deçà du seuil de détour (~150 m)
# Projection locale équirectangulaire (m) autour de Montréal : suffisante pour
# simplifier des tracés à quelques mètres près.
KX = 111_320 * math.cos(math.radians(45.5))
KY = 110_950


def _ouvrir_gtfs(chemin):
    if chemin:
        return zipfile.ZipFile(chemin)
    print(f"Téléchargement du GTFS STM courant ({URL_GTFS_STM})…")
    rep = requests.get(URL_GTFS_STM, timeout=600)
    rep.raise_for_status()
    return zipfile.ZipFile(io.BytesIO(rep.content))


def _secondes(heures):
    """« HH:MM:SS » GTFS (HH peut dépasser 23) -> secondes depuis minuit du jour de service."""
    p = heures.str.split(":", expand=True).astype(int)
    return p[0] * 3600 + p[1] * 60 + p[2]


def _bornes_trajets(z, trip_ids):
    """Heure de début (1er départ) et de fin (dernière arrivée) de chaque trajet,
    lues par blocs dans stop_times.txt pour borner la mémoire."""
    blocs = []
    for bloc in pd.read_csv(z.open("stop_times.txt"), dtype=str, chunksize=1_000_000,
                            usecols=["trip_id", "arrival_time", "departure_time"]):
        bloc = bloc[bloc["trip_id"].isin(trip_ids)].dropna(subset=["arrival_time", "departure_time"])
        bloc = bloc.assign(dep=_secondes(bloc["departure_time"]), arr=_secondes(bloc["arrival_time"]))
        blocs.append(bloc.groupby("trip_id").agg(debut=("dep", "min"), fin=("arr", "max")))
    return pd.concat(blocs).groupby(level=0).agg(debut=("debut", "min"), fin=("fin", "max"))


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--gtfs", type=Path, default=None, help="zip GTFS à utiliser (défaut : téléchargement)")
    args = p.parse_args()

    z = _ouvrir_gtfs(args.gtfs)
    routes = pd.read_csv(z.open("routes.txt"), dtype=str)
    trips = pd.read_csv(z.open("trips.txt"), dtype=str,
                        usecols=["route_id", "service_id", "trip_id", "trip_headsign",
                                 "direction_id", "shape_id"])
    calendrier = pd.read_csv(z.open("calendar.txt"), dtype=str)
    exceptions = (pd.read_csv(z.open("calendar_dates.txt"), dtype=str)
                  if "calendar_dates.txt" in z.namelist()
                  else pd.DataFrame(columns=["service_id", "date", "exception_type"]))
    directions = pd.read_csv(z.open("directions.txt"), dtype=str)
    shapes = pd.read_csv(z.open("shapes.txt"), dtype={"shape_id": str})
    info = (pd.read_csv(z.open("feed_info.txt"), dtype=str).iloc[0].to_dict()
            if "feed_info.txt" in z.namelist() else {})

    bus = set(routes.loc[routes["route_type"] == "3", "route_id"])
    trips = trips[trips["route_id"].isin(bus)].dropna(subset=["shape_id", "direction_id"])
    shapes = (shapes[shapes["shape_id"].isin(set(trips["shape_id"]))]
              .sort_values(["shape_id", "shape_pt_sequence"]))

    traces, index_trace = [], {}
    n_avant = 0
    for sid, g in shapes.groupby("shape_id"):
        ligne = LineString(np.c_[g["shape_pt_lon"] * KX, g["shape_pt_lat"] * KY])
        simple = ligne.simplify(TOLERANCE_SIMPLIFICATION_M)
        n_avant += len(g)
        index_trace[sid] = len(traces)
        traces.append([[round(y / KY, 5), round(x / KX, 5)] for x, y in simple.coords])

    trips = trips[trips["shape_id"].isin(index_trace)]
    print("Heures de début / fin des trajets (stop_times.txt, par blocs)…")
    trips = trips.join(_bornes_trajets(z, set(trips["trip_id"])), on="trip_id").dropna(subset=["debut", "fin"])

    services = sorted(trips["service_id"].unique())
    index_service = {s: i for i, s in enumerate(services)}
    destinations = sorted(trips["trip_headsign"].fillna("").unique())
    index_destination = {d: i for i, d in enumerate(destinations)}
    jours = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    cal = calendrier[calendrier["service_id"].isin(index_service)]
    exc = exceptions[exceptions["service_id"].isin(index_service)]

    referentiel = {
        "version": info.get("feed_version"),
        "valide_du": info.get("feed_start_date"),
        "valide_au": info.get("feed_end_date"),
        "genere_le": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        # "route_id|direction_id" -> libellé (« Est », « Nord »…), même vocabulaire
        # que les parcours de /api/meta (filtre par direction sur la carte).
        "directions": {f"{r}|{d}": lib for r, d, lib in
                       zip(directions["route_id"], directions["direction_id"], directions["direction"])},
        "traces": traces,
        "services": services,
        "destinations": destinations,
        # index de service -> [jours "lundi..dimanche" en 0/1, date début, date fin]
        "calendrier": {str(index_service[r["service_id"]]):
                       ["".join(r[j] for j in jours), r["start_date"], r["end_date"]]
                       for _, r in cal.iterrows()},
        # index de service -> [[date AAAAMMJJ, 1 = ajout | 2 = retrait], ...]
        "exceptions": {str(index_service[s]): g[["date", "exception_type"]].astype({"exception_type": int}).values.tolist()
                       for s, g in exc.groupby("service_id")},
        # [trip_id, index du tracé, direction_id, route_id, index de service,
        #  début (s depuis minuit du jour de service), fin (s), index de destination]
        "trips": [[t, index_trace[s], int(d), r, index_service[sv], int(deb), int(fin),
                   index_destination[h if isinstance(h, str) else ""]]
                  for t, s, d, r, sv, deb, fin, h in
                  zip(trips["trip_id"], trips["shape_id"], trips["direction_id"], trips["route_id"],
                      trips["service_id"], trips["debut"], trips["fin"], trips["trip_headsign"])],
    }
    texte = json.dumps(referentiel, separators=(",", ":"), ensure_ascii=False)
    SORTIE.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(SORTIE, "wt", encoding="utf-8") as f:
        f.write(texte)

    n_apres = sum(len(t) for t in traces)
    print(f"GTFS {referentiel['version']} (valide du {referentiel['valide_du']} "
          f"au {referentiel['valide_au']})")
    print(f"  {len(referentiel['trips']):,} trajets bus | {len(traces)} tracés | "
          f"{n_avant:,} → {n_apres:,} points (simplification {TOLERANCE_SIMPLIFICATION_M:g} m)")
    print(f"  {len(services)} services | {len(referentiel['exceptions'])} avec exceptions | "
          f"{(trips['fin'] > 86_400).sum():,} trajets après minuit | {len(destinations)} destinations")
    print(f"  → {SORTIE} ({SORTIE.stat().st_size / 1e6:.2f} Mo)")


if __name__ == "__main__":
    main()
