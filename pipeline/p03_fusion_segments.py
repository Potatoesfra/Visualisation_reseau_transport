"""
p03_fusion_segments.py
======================
Étape 3 du pipeline : version FUSIONNÉE des segments GTFS. Tous les segments
qui commencent ET se terminent exactement aux mêmes stop_codes (couple ordonné
(start_stop_code, end_stop_code)), PEU IMPORTE leur ligne, sont regroupés en
un seul nœud.

Exemple
-------
Un segment de la ligne 16 qui va de l'arrêt 5768 à l'arrêt 9764 et un segment
de la ligne 33 qui va aussi de 5768 à 9764 sont fusionnés en un seul nœud.
(Un segment 9764 -> 5768 n'est PAS fusionné : le couple est ordonné.)

Géométrie représentative
-------------------------
Quand un groupe contient plusieurs tracés (shapes GTFS différentes), on garde
la géométrie de la SHAPE LA PLUS FRÉQUENTE du groupe (mode de shape_id ;
départage = première occurrence). Cette shape fournit aussi le route_id et le
shape_id représentatifs.

Entrée  : data_derivee/segments.gpkg (p02)
Sorties : data_derivee/segments_merge_identiques.gpkg
              un nœud par couple (start, end), même schéma que segments.gpkg
              + colonne nb_lignes. Le segment_id du nœud fusionné = son index
              de ligne (convention partagée avec tout le pipeline).
          data_derivee/liaison_fusion.parquet
              dictionnaire de liaison (format long, une ligne par segment
              d'origine) : merged_id, segment_id_origine, route_id, shape_id,
              start_stop_code, end_stop_code.
"""

# %%
import sys
import warnings
from pathlib import Path

import pandas as pd
import geopandas as gpd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import DATA_DERIVEE  # noqa: E402

warnings.filterwarnings("ignore", category=UserWarning)

# %% =============================================================
# PARAMÈTRES
# ===============================================================

PATH_SEGMENTS = DATA_DERIVEE / "segments.gpkg"

CRS_GEO = "EPSG:4326"

PATH_SEGMENTS_FUSION = DATA_DERIVEE / "segments_merge_identiques.gpkg"
PATH_LIAISON = DATA_DERIVEE / "liaison_fusion.parquet"


# %% =============================================================
# 1. CHARGEMENT
# ===============================================================

print("=== Chargement des segments ===")
segments = gpd.read_file(PATH_SEGMENTS).to_crs(CRS_GEO).reset_index(drop=True)
# Identifiant stable = index de ligne (même convention que tout le pipeline)
segments["segment_id"] = segments.index.astype(int)
segments["route_id"] = segments["route_id"].astype(str)
segments["start_stop_code"] = segments["start_stop_code"].astype(int)
segments["end_stop_code"] = segments["end_stop_code"].astype(int)

print(f"  {len(segments)} segments chargés.")
n_couples = segments.groupby(["start_stop_code", "end_stop_code"], sort=False).ngroups
print(f"  {n_couples} couples (start, end) uniques.")


# %% =============================================================
# 2. FUSION PAR COUPLE (start_stop_code, end_stop_code)
# ===============================================================

print("\n=== Fusion par couple d'arrêts ===")


def _representant(grp):
    """Renvoie l'index (dans grp) du segment portant la shape la plus fréquente.

    Départage = première occurrence (ordre d'apparition dans le groupe).
    """
    counts = grp["shape_id"].value_counts()  # trié par fréquence décroissante
    shape_freq = counts.index[0]
    # première ligne du groupe portant cette shape
    return grp.index[grp["shape_id"] == shape_freq][0]


merged_rows = []
liaison_rows = []

# sort=False : on conserve l'ordre d'apparition pour des merged_id stables
for (start_code, end_code), grp in segments.groupby(
    ["start_stop_code", "end_stop_code"], sort=False
):
    merged_id = len(merged_rows)  # index de ligne du fichier fusionné
    rep_idx = _representant(grp)
    rep = segments.loc[rep_idx]

    merged_rows.append({
        "route_id":        rep["route_id"],      # ligne représentative
        "shape_id":        rep["shape_id"],      # shape la plus fréquente
        "start_stop_code": int(start_code),
        "end_stop_code":   int(end_code),
        "nb_lignes":       int(grp["route_id"].nunique()),
        "geometry":        rep.geometry,
    })

    for _, seg in grp.iterrows():
        liaison_rows.append({
            "merged_id":          merged_id,
            "segment_id_origine": int(seg["segment_id"]),
            "route_id":           seg["route_id"],
            "shape_id":           seg["shape_id"],
            "start_stop_code":    int(start_code),
            "end_stop_code":      int(end_code),
        })

segments_fusion = gpd.GeoDataFrame(merged_rows, geometry="geometry", crs=CRS_GEO)
segments_fusion["segment_id"] = segments_fusion.index.astype(int)
liaison = pd.DataFrame(liaison_rows)

print(f"  {len(segments)} segments -> {len(segments_fusion)} nœuds fusionnés.")
taille_groupes = liaison.groupby("merged_id").size()
print(f"  Taille de groupe : moy {taille_groupes.mean():.2f} | max {taille_groupes.max()}")
print(f"  Nœuds multi-lignes (>1 segment) : {int((taille_groupes > 1).sum())}")


# %% =============================================================
# 3. EXPORTS
# ===============================================================

print("\n=== Exports ===")

# On écrit les mêmes colonnes que segments.gpkg (+ nb_lignes), sans la colonne
# segment_id (recalculée à la lecture comme index, convention du pipeline).
cols_out = ["route_id", "shape_id", "start_stop_code", "end_stop_code", "nb_lignes", "geometry"]
segments_fusion[cols_out].to_file(PATH_SEGMENTS_FUSION, driver="GPKG")
print(f"  Segments fusionnés : {PATH_SEGMENTS_FUSION}")

liaison.to_parquet(PATH_LIAISON, index=False)
print(f"  Dictionnaire de liaison : {PATH_LIAISON}")

print("\n=== Terminé ===")
# %%
