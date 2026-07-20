"""
p02_creation_segments.py
========================
Étape 2 du pipeline : création des segments géographiques entre paires
d'arrêts consécutifs, à partir des shapes GTFS.

Pour chaque paire (arrêt de départ, arrêt d'arrivée) observée dans les trips
d'une ligne, on retient la shape GTFS qui passe au plus près des deux arrêts,
puis on en découpe la portion correspondante (shapely.ops.substring).

Entrées : data_derivee/shapes_par_ligne.gpkg (p01)
          data_brute/gtfs_stm/{routes,trips,stop_times,stops}.txt
Sortie  : data_derivee/segments.gpkg
          (colonnes : route_id, shape_id, start_stop_code, end_stop_code, geometry)
"""

import sys
import warnings
from pathlib import Path

import pandas as pd
import geopandas as gpd
from shapely.ops import substring

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import GTFS_DIR, DATA_DERIVEE  # noqa: E402

PATH_SHAPES = DATA_DERIVEE / "shapes_par_ligne.gpkg"
PATH_OUTPUT = DATA_DERIVEE / "segments.gpkg"


# %% =============================================================
# 1. CHARGEMENT
# ===============================================================
print("=== Création des segments à partir des shapes GTFS ===")

shapes_gdf = gpd.read_file(PATH_SHAPES)
shapes_gdf["route_id"] = shapes_gdf["route_id"].astype(str)

routes = pd.read_csv(GTFS_DIR / "routes.txt", dtype={"route_id": str})
routes_bus = set(routes[routes["route_type"] == 3]["route_id"])

data_stops = pd.read_csv(GTFS_DIR / "stops.txt")
data_trips = pd.read_csv(GTFS_DIR / "trips.txt", dtype={"route_id": str})
data_trips = data_trips[data_trips["route_id"].isin(routes_bus)]
data_stoptimes = pd.read_csv(GTFS_DIR / "stop_times.txt")

# Cast stop_id pour le merge afin d'éviter les erreurs de types mélangés
data_stops["stop_id"] = data_stops["stop_id"].astype(str)
data_stoptimes["stop_id"] = data_stoptimes["stop_id"].astype(str)

# Pour éviter le conflit des shape_ids qui diffèrent d'une source GTFS à l'autre,
# on extrait toutes les paires d'arrêts (start, end) par route_id depuis les trips et stop_times
trip_routes = data_trips[["trip_id", "route_id"]].drop_duplicates()
st = data_stoptimes.merge(trip_routes, on="trip_id", how="inner")
st = st.merge(data_stops[["stop_id", "stop_code", "stop_lat", "stop_lon"]], on="stop_id", how="left")
st["route_id"] = st["route_id"].astype(str)

st = st.sort_values(by=["trip_id", "stop_sequence"])
st["start_code"] = st["stop_code"]
st["end_code"] = st.groupby("trip_id")["stop_code"].shift(-1)
st["start_lon"] = st["stop_lon"]
st["start_lat"] = st["stop_lat"]
st["end_lon"] = st.groupby("trip_id")["stop_lon"].shift(-1)
st["end_lat"] = st.groupby("trip_id")["stop_lat"].shift(-1)

# Nettoyage des fins de trips et doublons
st = st.dropna(subset=["end_code"])
unique_segments = st[["route_id", "start_code", "end_code",
                      "start_lon", "start_lat", "end_lon", "end_lat"]].drop_duplicates()
print(f"  {len(unique_segments)} paires (route, arrêt départ, arrêt arrivée) uniques.")


# %% =============================================================
# 2. EXTRACTION GÉOMÉTRIQUE
# ===============================================================
segments = []
with warnings.catch_warnings():
    warnings.simplefilter("ignore", RuntimeWarning)  # ignorer les alertes Shapely sur géométries invalides éventuelles
    for route_id, group in unique_segments.groupby("route_id"):
        route_shapes = shapes_gdf[shapes_gdf["route_id"] == route_id]
        if route_shapes.empty:
            continue

        # Pour chaque séquence d'arrêts sur cette ligne, chercher la shape optimale (distance min)
        for idx, row in group.iterrows():
            p1 = gpd.points_from_xy([row["start_lon"]], [row["start_lat"]])[0]
            p2 = gpd.points_from_xy([row["end_lon"]], [row["end_lat"]])[0]

            best_shape = None
            min_dist = float("inf")
            best_dist1 = None
            best_dist2 = None
            shape_id_retenu = None

            for _, s_row in route_shapes.iterrows():
                geom = s_row["geometry"]
                # on évalue quelle géométrie GTFS passe au plus près des deux arrêts
                d1 = geom.distance(p1)
                d2 = geom.distance(p2)
                if d1 + d2 < min_dist:
                    min_dist = d1 + d2
                    best_shape = s_row
                    best_dist1 = geom.project(p1)
                    best_dist2 = geom.project(p2)
                    shape_id_retenu = s_row["shape_id"]

            if best_shape is not None:
                dist1, dist2 = min(best_dist1, best_dist2), max(best_dist1, best_dist2)
                if dist1 != dist2:
                    seg_geom = substring(best_shape["geometry"], dist1, dist2)
                    segments.append({
                        "route_id": route_id,
                        "shape_id": shape_id_retenu,
                        "start_stop_code": int(row["start_code"]),
                        "end_stop_code": int(row["end_code"]),
                        "geometry": seg_geom,
                    })


# %% =============================================================
# 3. EXPORT
# ===============================================================
if len(segments) > 0:
    segments_gdf = gpd.GeoDataFrame(segments, crs="EPSG:4326")
    print(f"Création de {len(segments_gdf)} segments géographiques "
          f"(arête entre start_stop_code et end_stop_code) terminée.")

    segments_gdf.to_file(PATH_OUTPUT, driver="GPKG")
    print(f"Segments sauvegardés avec succès dans :\n{PATH_OUTPUT}")
else:
    print("Erreur : Aucun segment n'a pu être généré.")
