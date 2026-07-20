"""
p01_shapes_par_ligne.py
=======================
Étape 1 du pipeline : export des tracés (shapes) GTFS par ligne de bus.

Entrées (data_brute/gtfs_stm/) : routes.txt, trips.txt, shapes.txt
Sortie  (data_derivee/)        : shapes_par_ligne.gpkg
                                 (une LineString par couple (route_id, shape_id))

Seules les lignes de bus sont conservées (route_type == 3).
"""

import sys
from pathlib import Path

import pandas as pd
import geopandas as gpd
from shapely.geometry import LineString

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import GTFS_DIR, DATA_DERIVEE  # noqa: E402

PATH_OUTPUT = DATA_DERIVEE / "shapes_par_ligne.gpkg"


# %% =============================================================
# 1. CHARGEMENT GTFS
# ===============================================================
print("=== Export des shapes GTFS par ligne de bus ===")

routes = pd.read_csv(GTFS_DIR / "routes.txt", dtype={"route_id": str})
routes_bus = routes[routes["route_type"] == 3]["route_id"].unique()
print(f"  {len(routes_bus)} lignes de bus (route_type == 3).")

trips = pd.read_csv(GTFS_DIR / "trips.txt", dtype={"route_id": str, "shape_id": str})
paires = (trips[trips["route_id"].isin(routes_bus)][["route_id", "shape_id"]]
          .dropna()
          .drop_duplicates())
print(f"  {len(paires)} couples (route_id, shape_id) uniques.")

shapes = pd.read_csv(GTFS_DIR / "shapes.txt", dtype={"shape_id": str})


# %% =============================================================
# 2. UNE LINESTRING PAR SHAPE
# ===============================================================
def build_linestring(grp):
    """Construit une LineString par shape_id (séquence ordonnée)."""
    grp = grp.sort_values("shape_pt_sequence")
    coords = list(zip(grp["shape_pt_lon"], grp["shape_pt_lat"]))
    if len(coords) >= 2:
        return LineString(coords)
    return None


geom_par_shape = (shapes.groupby("shape_id")
                  .apply(build_linestring, include_groups=False)
                  .rename("geometry"))

gdf = paires.merge(geom_par_shape, left_on="shape_id", right_index=True, how="inner")
gdf = gpd.GeoDataFrame(gdf.dropna(subset=["geometry"]), geometry="geometry", crs="EPSG:4326")


# %% =============================================================
# 3. EXPORT
# ===============================================================
DATA_DERIVEE.mkdir(exist_ok=True)
gdf.to_file(PATH_OUTPUT, driver="GPKG")
print(f"  -> {PATH_OUTPUT} ({len(gdf):,} shapes | {gdf['route_id'].nunique()} lignes)")
