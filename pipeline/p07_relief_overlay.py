"""
p07_relief_overlay.py
=====================
Étape 7 du pipeline : génère l'overlay de relief affiché sur la carte Leaflet.

À partir du MNT Copernicus 30 m (data_brute/), produit :
  - data_derivee/relief/altitude_overlay.png          (hillshade colorisé, RGBA)
  - data_derivee/relief/altitude_overlay_bounds.json  (emprise WGS84 pour L.imageOverlay)

Le PNG est sous-échantillonné à MAX_DIM px pour rester léger (versionnable).
"""

import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform_bounds

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import LightSource  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import DATA_BRUTE, DATA_DERIVEE  # noqa: E402

PATH_DEM = DATA_BRUTE / "montreal_copernicus_dem_30m.tif"
DIR_RELIEF = DATA_DERIVEE / "relief"
PATH_PNG = DIR_RELIEF / "altitude_overlay.png"
PATH_BOUNDS = DIR_RELIEF / "altitude_overlay_bounds.json"

MAX_DIM = 1400          # dimension max du PNG (px)
ALPHA_OVERLAY = 0.85    # opacité de base intégrée au PNG


print("=== Génération de l'overlay de relief (DEM Copernicus) ===")

with rasterio.open(PATH_DEM) as src:
    dem = src.read(1).astype(float)
    if src.nodata is not None:
        dem[dem == src.nodata] = np.nan
    # Emprise en WGS84 (ordre rasterio : ouest, sud, est, nord)
    ouest, sud, est, nord = transform_bounds(src.crs, "EPSG:4326", *src.bounds)

print(f"  DEM {dem.shape[1]}x{dem.shape[0]} px | altitudes "
      f"{np.nanmin(dem):.0f} -> {np.nanmax(dem):.0f} m")

# Sous-échantillonnage (pas entier) pour tenir dans MAX_DIM
pas = max(1, int(np.ceil(max(dem.shape) / MAX_DIM)))
dem_petit = dem[::pas, ::pas]
print(f"  Sous-échantillonnage x{pas} -> {dem_petit.shape[1]}x{dem_petit.shape[0]} px")

# Hillshade colorisé (éclairage nord-ouest, rendu type carte topographique)
dem_rempli = np.where(np.isnan(dem_petit), np.nanmin(dem_petit), dem_petit)
ls = LightSource(azdeg=315, altdeg=45)
rgb = ls.shade(dem_rempli, cmap=plt.cm.terrain, blend_mode="overlay",
               vert_exag=3.0)

# Canal alpha : transparent hors données, semi-opaque ailleurs
rgba = np.zeros((*rgb.shape[:2], 4))
rgba[..., :3] = rgb[..., :3]
rgba[..., 3] = np.where(np.isnan(dem_petit), 0.0, ALPHA_OVERLAY)

DIR_RELIEF.mkdir(parents=True, exist_ok=True)
plt.imsave(PATH_PNG, rgba)
print(f"  -> {PATH_PNG} ({PATH_PNG.stat().st_size / 1e3:.0f} Ko)")

# Bounds au format Leaflet : [[sud, ouest], [nord, est]]
with open(PATH_BOUNDS, "w", encoding="utf-8") as f:
    json.dump({"bounds": [[sud, ouest], [nord, est]]}, f, indent=2)
print(f"  -> {PATH_BOUNDS}")
print("Terminé.")
