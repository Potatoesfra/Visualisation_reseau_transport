# -*- coding: utf-8 -*-
"""
p08_graphe_routier.py
=====================
Étape 8 du pipeline : construction d'un graphe ROUTIER ROUTABLE à partir du
réseau OpenStreetMap, pour la fonctionnalité « créer un trajet » de la carte
(le trajet suit les rues réelles, jamais de ligne droite).

Construction
------------
- Seules les routes carrossables sont retenues (HIGHWAYS_ROUTABLES).
- Les nœuds du graphe = intersections réelles : sommets partagés par
  plusieurs chemins OSM + extrémités de chemins. Les sommets intermédiaires
  (degré 2) sont contractés dans l'arête, dont la géométrie complète est
  conservée (colonne `coords`) pour l'affichage.
- Chaque arête porte : distance, limite de vitesse (maxspeed OSM, sinon défaut
  par type de route), pente (MNT Copernicus aux extrémités), coefficient de
  roulement (surface OSM) et présence d'un feu de circulation au nœud d'arrivée.
- Les sens uniques OSM (`oneway`) sont respectés : une arête par sens autorisé.

Entrées : data_brute/{OSM.geojson, montreal_copernicus_dem_30m.tif, feux-circulation.json}
Sorties : data_derivee/graphe_routier_noeuds.parquet  (node_id, lat, lon)
          data_derivee/graphe_routier_aretes.parquet  (node_a, node_b, distance_m,
              vitesse_kmh, pente_pct, coef_roulement, nb_feux, coords)
"""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import geopandas as gpd
import rasterio
from pyproj import Transformer
from scipy.spatial import cKDTree
from tqdm import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import DATA_BRUTE, DATA_DERIVEE  # noqa: E402
from serveur.modele_physique import C_RR_SURFACE, MULT_ETAT_CHAUSSEE  # noqa: E402

PATH_OSM = DATA_BRUTE / "OSM.geojson"
PATH_DEM = DATA_BRUTE / "montreal_copernicus_dem_30m.tif"
PATH_FEUX = DATA_BRUTE / "feux-circulation.json"
PATH_NOEUDS = DATA_DERIVEE / "graphe_routier_noeuds.parquet"
PATH_ARETES = DATA_DERIVEE / "graphe_routier_aretes.parquet"

# Routes carrossables par un bus (exclut footway/cycleway/path/steps…)
HIGHWAYS_ROUTABLES = {
    "motorway", "motorway_link", "trunk", "trunk_link",
    "primary", "primary_link", "secondary", "secondary_link",
    "tertiary", "tertiary_link", "residential", "unclassified",
    "living_street", "service", "busway", "road",
}

# Limite de vitesse par défaut (km/h) quand maxspeed est absent
VITESSE_DEFAUT_PAR_HIGHWAY = {
    "motorway": 100, "motorway_link": 70, "trunk": 90, "trunk_link": 60,
    "primary": 60, "primary_link": 50, "secondary": 50, "secondary_link": 40,
    "tertiary": 50, "tertiary_link": 40, "residential": 30, "unclassified": 40,
    "living_street": 20, "service": 20, "busway": 50, "road": 40,
}

RAYON_FEU_M = 25.0     # un feu à moins de 25 m d'un nœud = arrêt probable
ARRONDI_SOMMET = 7     # décimales pour identifier les sommets partagés


def cle_sommet(lon, lat):
    return (round(float(lon), ARRONDI_SOMMET), round(float(lat), ARRONDI_SOMMET))


# %% =============================================================
# 1. CHARGEMENT OSM
# ===============================================================
print("=== Construction du graphe routier (OSM) ===")

osm = gpd.read_file(PATH_OSM)
osm = osm[osm["highway"].isin(HIGHWAYS_ROUTABLES)].reset_index(drop=True)
osm = osm[osm.geometry.type.isin(["LineString", "MultiLineString"])]
osm = osm.explode(index_parts=False).reset_index(drop=True)
print(f"  {len(osm)} chemins carrossables retenus")

# Attributs par chemin
maxspeed = pd.to_numeric(osm.get("maxspeed"), errors="coerce")
highway = osm["highway"].astype(str)
vitesse_way = maxspeed.fillna(highway.map(VITESSE_DEFAUT_PAR_HIGHWAY)).fillna(40.0)
surface = osm["surface"].astype(str) if "surface" in osm.columns else pd.Series("", index=osm.index)
crr_way = (surface.map(C_RR_SURFACE).fillna(C_RR_SURFACE["_default"])
           * MULT_ETAT_CHAUSSEE["_default"])
oneway = (osm["oneway"].astype(str).str.strip().str.lower()
          if "oneway" in osm.columns else pd.Series("", index=osm.index))


# %% =============================================================
# 2. SOMMETS PARTAGÉS -> NŒUDS DU GRAPHE
# ===============================================================
print("\n1. Détection des intersections (sommets partagés)…")

usage = {}
for geom in tqdm(osm.geometry, desc="  Comptage sommets"):
    coords = list(geom.coords)
    for k, (lon, lat) in enumerate(coords):
        cle = cle_sommet(lon, lat)
        # Extrémités : +2 pour forcer un nœud même sans partage
        usage[cle] = usage.get(cle, 0) + (2 if k in (0, len(coords) - 1) else 1)

noeuds_cles = {cle for cle, n in usage.items() if n >= 2}
print(f"  {len(usage):,} sommets | {len(noeuds_cles):,} nœuds (intersections + extrémités)")

# Identifiants de nœuds
node_id_par_cle = {}
noeuds_lon = []
noeuds_lat = []
for cle in noeuds_cles:
    node_id_par_cle[cle] = len(noeuds_lon)
    noeuds_lon.append(cle[0])
    noeuds_lat.append(cle[1])
noeuds_lon = np.array(noeuds_lon)
noeuds_lat = np.array(noeuds_lat)


# %% =============================================================
# 3. ALTITUDES + FEUX AUX NŒUDS
# ===============================================================
print("\n2. Altitudes (DEM) et feux de circulation aux nœuds…")

with rasterio.open(PATH_DEM) as src:
    dem = src.read(1)
    nodata = src.nodata
    alts = np.full(len(noeuds_lon), np.nan)
    for i, (lon, lat) in enumerate(zip(noeuds_lon, noeuds_lat)):
        try:
            row, col = src.index(lon, lat)
            if 0 <= row < dem.shape[0] and 0 <= col < dem.shape[1]:
                v = dem[row, col]
                if v != nodata:
                    alts[i] = float(v)
        except (IndexError, ValueError):
            pass
alts = np.where(np.isnan(alts), np.nanmean(alts), alts)
print(f"  Altitude moyenne des nœuds : {np.nanmean(alts):.1f} m")

# Feux : présence d'un feu à moins de RAYON_FEU_M de chaque nœud
feux = gpd.read_file(PATH_FEUX).to_crs("EPSG:4326")
lat0 = float(np.mean(noeuds_lat))
lat_scale = 111320.0
lon_scale = 111320.0 * np.cos(np.radians(lat0))
xy_noeuds = np.column_stack((noeuds_lon * lon_scale, noeuds_lat * lat_scale))
xy_feux = np.column_stack((feux.geometry.x.to_numpy() * lon_scale,
                           feux.geometry.y.to_numpy() * lat_scale))
arbre_feux = cKDTree(xy_feux)
d_feu, _ = arbre_feux.query(xy_noeuds)
feu_au_noeud = d_feu <= RAYON_FEU_M
print(f"  {int(feu_au_noeud.sum()):,} nœuds avec feu de circulation")


# %% =============================================================
# 4. DÉCOUPAGE DES CHEMINS EN ARÊTES (contraction des degré-2)
# ===============================================================
print("\n3. Découpage des chemins en arêtes…")

transformer = Transformer.from_crs("EPSG:4326", "EPSG:32188", always_xy=True)

aretes = {
    "node_a": [], "node_b": [], "distance_m": [], "vitesse_kmh": [],
    "pente_pct": [], "coef_roulement": [], "nb_feux": [], "coords": [],
}


def ajouter_arete(na, nb, dist, vit, crr, coords_latlon):
    """Ajoute une arête orientée na -> nb (pente signée, feu au nœud d'arrivée)."""
    dh = alts[nb] - alts[na]
    aretes["node_a"].append(na)
    aretes["node_b"].append(nb)
    aretes["distance_m"].append(round(dist, 1))
    aretes["vitesse_kmh"].append(float(vit))
    aretes["pente_pct"].append(round(dh / max(dist, 1.0) * 100.0, 2))
    aretes["coef_roulement"].append(round(float(crr), 5))
    aretes["nb_feux"].append(int(feu_au_noeud[nb]))
    # Géométrie de l'arête encodée en JSON (portable entre engines parquet)
    aretes["coords"].append(json.dumps([[round(lat, 6), round(lon, 6)]
                                        for lon, lat in coords_latlon]))


for idx, geom in enumerate(tqdm(osm.geometry, desc="  Arêtes")):
    coords = list(geom.coords)
    if len(coords) < 2:
        continue
    vit = float(vitesse_way.iloc[idx])
    crr = float(crr_way.iloc[idx])
    ow = str(oneway.iloc[idx])

    xs, ys = transformer.transform([c[0] for c in coords], [c[1] for c in coords])
    longueurs = np.hypot(np.diff(xs), np.diff(ys))

    # Découpe aux nœuds (sommets partagés / extrémités)
    debut = 0
    for k in range(1, len(coords)):
        cle = cle_sommet(*coords[k])
        if cle not in noeuds_cles:
            continue
        cle_debut = cle_sommet(*coords[debut])
        na = node_id_par_cle.get(cle_debut)
        nb = node_id_par_cle[cle]
        if na is not None and na != nb:
            dist = float(longueurs[debut:k].sum())
            if dist >= 1.0:
                troncon = coords[debut:k + 1]
                if ow in ("-1", "reverse"):
                    ajouter_arete(nb, na, dist, vit, crr, list(reversed(troncon)))
                else:
                    ajouter_arete(na, nb, dist, vit, crr, troncon)
                    if ow not in ("yes", "true", "1"):
                        ajouter_arete(nb, na, dist, vit, crr, list(reversed(troncon)))
        debut = k

df_noeuds = pd.DataFrame({
    "node_id": np.arange(len(noeuds_lon), dtype=np.int64),
    "lat": noeuds_lat,
    "lon": noeuds_lon,
})
df_aretes = pd.DataFrame(aretes)
print(f"  {len(df_noeuds):,} nœuds | {len(df_aretes):,} arêtes orientées")


# %% =============================================================
# 5. COMPOSANTE CONNEXE PRINCIPALE (retire les îlots isolés)
# ===============================================================
print("\n4. Composante connexe principale…")

adj = {}
for na, nb in zip(df_aretes["node_a"], df_aretes["node_b"]):
    adj.setdefault(int(na), set()).add(int(nb))
    adj.setdefault(int(nb), set()).add(int(na))

vus = set()
meilleure = set()
for depart in adj:
    if depart in vus:
        continue
    composante = {depart}
    pile = [depart]
    vus.add(depart)
    while pile:
        n = pile.pop()
        for v in adj.get(n, ()):
            if v not in vus:
                vus.add(v)
                composante.add(v)
                pile.append(v)
    if len(composante) > len(meilleure):
        meilleure = composante

part = len(meilleure) / max(len(adj), 1)
print(f"  Composante principale : {len(meilleure):,}/{len(adj):,} nœuds ({part:.1%})")

masque = (df_aretes["node_a"].isin(meilleure) & df_aretes["node_b"].isin(meilleure))
df_aretes = df_aretes[masque].reset_index(drop=True)

# Ré-indexation compacte des nœuds conservés
conserves = sorted(meilleure)
nouveau_id = {ancien: i for i, ancien in enumerate(conserves)}
df_noeuds = df_noeuds[df_noeuds["node_id"].isin(meilleure)].reset_index(drop=True)
df_noeuds["node_id"] = df_noeuds["node_id"].map(nouveau_id)
df_noeuds = df_noeuds.sort_values("node_id").reset_index(drop=True)
df_aretes["node_a"] = df_aretes["node_a"].map(nouveau_id)
df_aretes["node_b"] = df_aretes["node_b"].map(nouveau_id)


# %% =============================================================
# 6. EXPORTS
# ===============================================================
print("\n5. Exports…")
df_noeuds.to_parquet(PATH_NOEUDS, index=False)
df_aretes.to_parquet(PATH_ARETES, index=False)
print(f"  -> {PATH_NOEUDS} ({PATH_NOEUDS.stat().st_size / 1e6:.1f} Mo, {len(df_noeuds):,} nœuds)")
print(f"  -> {PATH_ARETES} ({PATH_ARETES.stat().st_size / 1e6:.1f} Mo, {len(df_aretes):,} arêtes)")
print("\n=== Terminé ===")
