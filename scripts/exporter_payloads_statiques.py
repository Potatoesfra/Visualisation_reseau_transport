"""
exporter_payloads_statiques.py
==============================
Pré-calcule sur le poste local les payloads /api/* du jeu "normal" et les écrit
en JSON compressé dans data_derivee/payloads_statiques/ (versionné).

En ligne (VIZ_LIGHT=1), le serveur détecte ces fichiers et les sert tels quels :
aucune reconstruction au démarrage, ni geopandas en RAM — c'est le « mode
statique », taillé pour les instances à 512 Mo. Seul le graphe routier reste
chargé (routage Dijkstra des trajets créés).

À relancer après toute régénération du pipeline (p01–p08), puis committer les
fichiers produits.

Usage :
    python scripts/exporter_payloads_statiques.py
"""
import gzip
import json
import os
import sys
from pathlib import Path

# Reconstruction forcée du jeu normal seul (celui servi en ligne), même si des
# payloads statiques existent déjà.
os.environ["VIZ_LIGHT"] = "1"
os.environ["VIZ_FORCE_CALCUL"] = "1"

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE / "serveur"))

import serveur_viz as sv  # noqa: E402  (charge et compacte les données)


def _ecrire_gz(path, texte):
    """gzip reproductible (mtime=0) : le fichier ne change que si le contenu change."""
    data = texte.encode("utf-8")
    with open(path, "wb") as f:
        with gzip.GzipFile(fileobj=f, mode="wb", mtime=0) as g:
            g.write(data)
    print(f"  {path.name:28s} {path.stat().st_size / 1e6:6.2f} Mo "
          f"(brut : {len(data) / 1e6:.1f} Mo)")


def main():
    dest = sv.DIR_PAYLOADS
    dest.mkdir(parents=True, exist_ok=True)
    print(f"\n=== Export des payloads statiques -> {dest} ===")

    ds = sv.DATASETS["normal"]
    _ecrire_gz(sv.PATH_PL_SEGMENTS,  ds["segments_json"])
    _ecrire_gz(sv.PATH_PL_RELATIONS, ds["relations_json"])
    _ecrire_gz(sv.PATH_PL_STOPS,     sv.STOPS_JSON)
    _ecrire_gz(sv.PATH_PL_RESEAU,    sv._construire_reseau_routier_json())

    meta = {
        "lignes":          sv.LIGNES_DISPONIBLES,
        "lignes_parcours": sv.LIGNES_PARCOURS,
        "types_relations": sv.TYPES_RELATIONS,
        "center":          [sv.CENTER_LAT, sv.CENTER_LON],
        "n_segments":      ds["n_segments"],
        "n_relations":     ds["n_relations"],
        "n_stops":         sv.N_STOPS,
    }
    sv.PATH_PL_META.write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  {sv.PATH_PL_META.name:28s} {sv.PATH_PL_META.stat().st_size / 1e3:6.1f} ko")
    print("Terminé. Committer data_derivee/payloads_statiques/ pour le déploiement.")


if __name__ == "__main__":
    main()
