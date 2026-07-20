# -*- coding: utf-8 -*-
"""
p04_attributs_segments.py
=========================
Étape 4 du pipeline : enrichit les segments (segments.gpkg) avec des attributs
géographiques et physiques pour la modélisation par graphe. Traite les deux
jeux : "normal" (segments.gpkg) et "fusion" (segments_merge_identiques.gpkg).

Features calculées
------------------
  distance_m         : longueur curviligne (m)
  sinuosite          : ratio longueur / distance euclidienne
  orientation_deg    : azimut moyen (0 = Nord, sens horaire)
  altitude_debut_m   : altitude au départ (m)
  altitude_fin_m     : altitude à l'arrivée (m)
  denivele_pos_m     : dénivelé positif cumulé (m)
  denivele_neg_m     : dénivelé négatif cumulé (m, valeur absolue)
  pente_moy_pct      : pente nette = (alt_fin − alt_debut) / distance × 100
  highway            : type de route OSM (motorway, residential, …)
  surface            : type de surface OSM (asphalt, concrete, …)
  nb_voies           : nombre de voies OSM (champ "lanes")
  sens_unique        : sens unique OSM ("yes" / "no", champ "oneway")
  vitesse_limite_kmh : limite de vitesse dominante (km/h) = limite qui couvre le
                       plus de distance le long du segment (valeur réelle 30/40/…)
  dist_vmax_{X}_m    : distance parcourue (m) sous la limite X km/h (une colonne
                       par limite présente) ; dist_vmax_inconnu_m = portion sans
                       limite OSM rattachée
  nb_feux            : nombre de feux de circulation dans le buffer du segment
  etat_chaussee      : état de la chaussée (Ville de Montréal, mode spatial)

Features physiques (modèle road-load — constantes dans serveur/modele_physique.py)
----------------------------------------------------------------------------------
  Énergies déclinées en absolu (..._kJ, masse assumée) et spécifique (..._J_kg) :
    energie_pot_nette        : M·g·(alt_fin − alt_debut)        (variation nette d'Ep)
    energie_pot_montee       : M·g·denivele_pos                 (travail contre gravité)
    energie_pot_descente     : M·g·denivele_neg                 (Ep libérée en descente)
    travail_roulement        : C_rr·M·g·distance                (résistance au roulement)
    travail_aero             : ½·ρ·Cd·A·v²·distance             (traînée aérodynamique)
    energie_arrets           : (nb_feux+2)·½·M·v²               (freinage stop-and-go)
    energie_traction_totale  : montee + roulement + aero + arrets
    energie_regen            : descente + arrets                (récupérable au freinage)
  taux_regen_pct     : energie_regen / energie_traction_totale × 100
  coef_roulement     : C_rr effectif (base surface × état chaussée) — traçabilité
  vitesse_calc_kmh   : vitesse utilisée (vitesse_limite_kmh avec repli) — traçabilité

Sources (data_brute/)
---------------------
  montreal_copernicus_dem_30m.tif   → altitudes
  OSM.geojson                       → highway, surface, lanes, oneway, maxspeed
  feux-circulation.json             → nb_feux
  auscultation-chaussee-2024.gpkg   → etat_chaussee

Sorties (data_derivee/)
-----------------------
  attributs_segments{_merge_identiques}.gpkg     : GeoPackage WGS84 (QGIS)
  attributs_segments{_merge_identiques}.parquet  : table sans géométrie
"""
# %%
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import geopandas as gpd
import rasterio
from tqdm import tqdm
from shapely.geometry import Point

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import DATA_BRUTE, DATA_DERIVEE  # noqa: E402
from serveur.modele_physique import (  # noqa: E402
    MASSE_BUS_KG, G, RHO_AIR, CD_BUS, AIRE_FRONTALE_M2, N_ARRETS_EXTREMITES,
    C_RR_SURFACE, MULT_ETAT_CHAUSSEE, VITESSE_DEFAUT_KMH,
)

warnings.filterwarnings("ignore")

# =============================================================
# PARAMÈTRES
# =============================================================

PATH_DEM      = DATA_BRUTE / "montreal_copernicus_dem_30m.tif"
PATH_OSM      = DATA_BRUTE / "OSM.geojson"
PATH_FEUX     = DATA_BRUTE / "feux-circulation.json"
PATH_CHAUSSEE = DATA_BRUTE / "auscultation-chaussee-2024.gpkg"

CRS_METRIQUE = "EPSG:32188"   # MTM zone 8
CRS_GEO      = "EPSG:4326"    # WGS84

# Profil altimétrique
SAMPLE_INTERVAL_M = 30.0
MIN_SAMPLE_POINTS = 3

# Buffer pour les jointures spatiales (m)
BUFFER_M = 10.0

# Colonne d'état de chaussée (auscultation Ville de Montréal)
COL_ETAT_CHAUSSEE = "Etat_PCI"

# --- Répartition de la vitesse par limite le long du segment ---
SPEED_SAMPLE_INTERVAL_M = 10.0   # pas d'échantillonnage du segment
SPEED_MATCH_TOL_M       = 25.0   # distance max point<->route OSM pour rattacher une limite
# Types OSM carrossables (le bus y circule) — exclut footway/cycleway/path…
ROAD_HIGHWAYS = {
    "motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link",
    "secondary", "secondary_link", "tertiary", "tertiary_link",
    "residential", "unclassified", "living_street", "service", "busway", "road",
}


# =============================================================
# UTILITAIRES
# =============================================================

def mode_or_nan(s):
    """Valeur la plus fréquente, ou NaN si série vide."""
    vals = s.dropna()
    return vals.mode().iloc[0] if len(vals) else np.nan


def mean_numeric(s):
    """Moyenne numérique, ou NaN si série vide."""
    vals = pd.to_numeric(s, errors="coerce").dropna()
    return round(vals.mean(), 1) if len(vals) else np.nan


def sample_points(geom_m, interval_m, min_pts):
    """Points uniformément espacés le long du segment (inclut début et fin)."""
    length = geom_m.length
    if length < 1e-6:
        return [Point(geom_m.coords[0])]
    n = max(min_pts - 1, int(np.ceil(length / interval_m)))
    return [geom_m.interpolate(d) for d in np.linspace(0, length, n + 1)]


def read_altitudes(lons, lats, src, data, nodata):
    """Extrait les altitudes depuis un raster rasterio déjà ouvert (WGS84 en entrée)."""
    alts = np.full(len(lons), np.nan)
    for i, (lon, lat) in enumerate(zip(lons, lats)):
        try:
            row, col = src.index(lon, lat)
            if 0 <= row < data.shape[0] and 0 <= col < data.shape[1]:
                val = data[row, col]
                if val != nodata:
                    alts[i] = float(val)
        except (IndexError, ValueError):
            pass
    return alts


def azimut(geom_m):
    """Azimut du segment (0 = Nord, sens horaire)."""
    coords = list(geom_m.coords)
    if len(coords) < 2:
        return np.nan
    dx = coords[-1][0] - coords[0][0]
    dy = coords[-1][1] - coords[0][1]
    return round(np.degrees(np.arctan2(dx, dy)) % 360, 1)


def bin_vitesse(v):
    """Arrondit une limite (km/h) au multiple de 10 le plus proche (plancher 10).

    Consolide les valeurs OSM (5, 8, 15, 25, 78…) vers des limites standard.
    """
    if pd.isna(v):
        return np.nan
    return max(10, int(round(float(v) / 10.0)) * 10)


def vitesse_effective(vit_kmh, highway, vmax_by_highway):
    """Vitesse (km/h) avec repli quand aucune limite n'est rattachée au segment.

    Repli : vitesse max observée pour le même type de route OSM
    (`vmax_by_highway`, calculée depuis les données), sinon VITESSE_DEFAUT_KMH.
    Entrées et sortie sont des séries pandas alignées.
    """
    v = pd.to_numeric(vit_kmh, errors="coerce")
    repli = highway.map(vmax_by_highway).fillna(VITESSE_DEFAUT_KMH)
    return v.fillna(repli)


def coef_roulement(surface, etat):
    """Coefficient de résistance au roulement C_rr (sans dimension).

    C_rr = base(surface OSM) × multiplicateur(état de chaussée PCI),
    avec valeurs par défaut si la donnée est absente.
    """
    base = surface.map(C_RR_SURFACE).fillna(C_RR_SURFACE["_default"])
    mult = etat.map(MULT_ETAT_CHAUSSEE).fillna(MULT_ETAT_CHAUSSEE["_default"])
    return base * mult


def sjoin_agg(segs_buf, layer, agg_spec):
    """
    Jointure spatiale buffer → layer, puis agrégation par segment_id.
    Seules les colonnes présentes dans la couche sont agrégées.
    Retourne un DataFrame indexé par segment_id.
    """
    joined = gpd.sjoin(segs_buf, layer, how="left", predicate="intersects")
    present = {k: v for k, v in agg_spec.items() if k in joined.columns}
    if not present:
        return pd.DataFrame({"segment_id": segs_buf["segment_id"]})
    return joined.groupby("segment_id").agg(present).reset_index()


# =============================================================
# CHARGEMENT DES SOURCES COMMUNES (une seule fois pour les deux modes)
# =============================================================

print("=== Chargement des sources open data ===")
osm = gpd.read_file(PATH_OSM).to_crs(CRS_METRIQUE)
feux = gpd.read_file(PATH_FEUX).to_crs(CRS_METRIQUE)
chaussee = gpd.read_file(PATH_CHAUSSEE).to_crs(CRS_METRIQUE)
with rasterio.open(PATH_DEM) as src:
    dem_data = src.read(1)
    dem_nodata = src.nodata
    dem_src_meta = src.meta
print(f"  OSM {len(osm)} | feux {len(feux)} | chaussée {len(chaussee)} | DEM {dem_data.shape}")


def traiter(mode):
    """Calcule et exporte les attributs pour un jeu ("normal" ou "fusion")."""
    suf = "" if mode == "normal" else "_merge_identiques"
    path_segments = DATA_DERIVEE / f"segments{suf}.gpkg"

    # =========================================================
    # 1. CHARGEMENT DES SEGMENTS
    # =========================================================
    print("\n" + "=" * 55)
    print(f"MODE {mode} — 1. Chargement des segments")
    print("=" * 55)

    segs = gpd.read_file(path_segments).reset_index(drop=True)
    segs["segment_id"] = segs.index.astype(int)
    print(f"  {len(segs)} segments  |  CRS : {segs.crs}")

    segs_m = segs.to_crs(CRS_METRIQUE).copy()

    # =========================================================
    # 2. FEATURES GÉOMÉTRIQUES
    # =========================================================
    print("\n2. Géométrie (distance, sinuosité, orientation)")

    segs_m["distance_m"] = segs_m.geometry.length.round(2)
    segs_m["sinuosite"] = segs_m.geometry.apply(
        lambda g: round(
            g.length / max(Point(g.coords[0]).distance(Point(g.coords[-1])), 1e-6), 4
        )
    )
    segs_m["orientation_deg"] = segs_m.geometry.apply(azimut)

    print(f"  Distance moy.  {segs_m['distance_m'].mean():.1f} m")
    print(f"  Sinuosité moy. {segs_m['sinuosite'].mean():.4f}")

    # =========================================================
    # 3. PROFIL ALTIMÉTRIQUE (Copernicus DEM)
    # =========================================================
    print("\n3. Altimétrie (Copernicus DEM 30 m)")

    records = [
        {"segment_id": row["segment_id"], "order": k, "geometry": pt}
        for _, row in tqdm(segs_m.iterrows(), total=len(segs_m), desc="  Echantillonnage")
        for k, pt in enumerate(sample_points(row.geometry, SAMPLE_INTERVAL_M, MIN_SAMPLE_POINTS))
    ]
    pts_m = gpd.GeoDataFrame(records, geometry="geometry", crs=CRS_METRIQUE)
    pts_wgs = pts_m.to_crs(CRS_GEO)
    pts_wgs["lon"] = pts_wgs.geometry.x
    pts_wgs["lat"] = pts_wgs.geometry.y
    print(f"  {len(pts_wgs):,} points pour {len(segs_m)} segments")

    with rasterio.open(PATH_DEM) as src:
        alts = read_altitudes(
            pts_wgs["lon"].values, pts_wgs["lat"].values,
            src, dem_data, dem_nodata
        )

    pts_wgs["alt_m"] = alts
    pts_wgs["alt_m"] = pts_wgs["alt_m"].fillna(np.nanmean(alts))

    def compute_denivele(grp):
        a = grp.sort_values("order")["alt_m"].values
        d = np.diff(a)
        return pd.Series({
            "altitude_debut_m": round(float(a[0]), 2),
            "altitude_fin_m":   round(float(a[-1]), 2),
            "denivele_pos_m":   round(float(d[d > 0].sum()), 2),
            "denivele_neg_m":   round(float(abs(d[d < 0].sum())), 2),
        })

    deniv = (pts_wgs.groupby("segment_id")[["order", "alt_m"]]
             .apply(compute_denivele).reset_index())
    segs_m = segs_m.merge(deniv, on="segment_id", how="left")
    segs_m["pente_moy_pct"] = (
        (segs_m["altitude_fin_m"] - segs_m["altitude_debut_m"])
        / segs_m["distance_m"].replace(0, np.nan) * 100
    ).round(2)

    print(f"  Altitude moy.  {np.nanmean(alts):.1f} m  |  "
          f"Δ+ moy. {segs_m['denivele_pos_m'].mean():.2f} m  |  "
          f"Δ− moy. {segs_m['denivele_neg_m'].mean():.2f} m")

    # =========================================================
    # BUFFER COMMUN POUR TOUTES LES JOINTURES SPATIALES
    # =========================================================
    segs_buf = segs_m[["segment_id", "geometry"]].copy()
    segs_buf["geometry"] = segs_buf.geometry.buffer(BUFFER_M)

    # =========================================================
    # 4. OSM — highway, surface, lanes, oneway, maxspeed
    # =========================================================
    print("\n4. OSM (highway, surface, nb_voies, sens_unique)")

    osm_sub = osm[[c for c in ["highway", "surface", "lanes", "oneway"]
                   if c in osm.columns] + ["geometry"]].copy()

    osm_agg = sjoin_agg(
        segs_buf, osm_sub,
        {
            "highway":  mode_or_nan,
            "surface":  mode_or_nan,
            "lanes":    mean_numeric,   # string → numeric via mean_numeric
            "oneway":   mode_or_nan,
        }
    ).rename(columns={
        "lanes":    "nb_voies",
        "oneway":   "sens_unique",
    })

    segs_m = segs_m.merge(osm_agg, on="segment_id", how="left")

    for col in ["highway", "surface", "nb_voies", "sens_unique"]:
        if col in segs_m.columns:
            n = segs_m[col].notna().sum()
            print(f"  {col:25s} → {n}/{len(segs_m)} segments renseignés")

    # =========================================================
    # 4b. VITESSE PAR LIMITE — répartition des distances le long du segment
    # =========================================================
    # On échantillonne finement chaque segment ; chaque point est rattaché à la
    # route OSM carrossable la plus proche (dans SPEED_MATCH_TOL_M). La distance
    # parcourue sous chaque limite = proportion de points × longueur du segment.
    # Produit : dist_vmax_{X}_m par limite, dist_vmax_inconnu_m, et
    # vitesse_limite_kmh = limite couvrant le plus de distance (valeur réelle).
    print("\n4b. Vitesse par limite (répartition des distances)")

    # Routes carrossables avec une limite numérique, ramenée à un palier standard
    road = osm[osm["highway"].isin(ROAD_HIGHWAYS)].copy()
    road["maxspeed_num"] = pd.to_numeric(road["maxspeed"], errors="coerce")
    road = road.dropna(subset=["maxspeed_num"])
    # Vitesse max observée par type de route (repli pour segments sans limite)
    vmax_by_highway = road.groupby("highway")["maxspeed_num"].max().to_dict()
    road["vbin"] = road["maxspeed_num"].apply(bin_vitesse).astype(int)
    road = road[["vbin", "geometry"]].reset_index(drop=True)
    print(f"  {len(road)} tronçons routiers avec limite  |  paliers : "
          f"{sorted(road['vbin'].unique().tolist())}")

    # Échantillonnage fin des segments (points en CRS métrique)
    speed_pts = [
        {"segment_id": row["segment_id"], "geometry": pt}
        for _, row in segs_m.iterrows()
        for pt in sample_points(row.geometry, SPEED_SAMPLE_INTERVAL_M, MIN_SAMPLE_POINTS)
    ]
    speed_pts = gpd.GeoDataFrame(speed_pts, geometry="geometry", crs=CRS_METRIQUE)
    speed_pts["pid"] = np.arange(len(speed_pts))
    n_pts = speed_pts.groupby("segment_id").size().rename("n_pts")

    # Rattachement de chaque point à la route la plus proche (limite la plus proche)
    sj = gpd.sjoin_nearest(speed_pts, road, how="left", max_distance=SPEED_MATCH_TOL_M)
    sj = sj.drop_duplicates(subset="pid")            # 1 ligne/point (égalités éventuelles)
    sj["vbin"] = sj["vbin"].fillna(-1).astype(int)   # -1 = aucune limite rattachée

    # Distance par (segment, limite) = proportion de points × distance du segment
    cnt = sj.groupby(["segment_id", "vbin"]).size().reset_index(name="c")
    cnt = cnt.merge(n_pts, on="segment_id").merge(
        segs_m[["segment_id", "distance_m"]], on="segment_id")
    cnt["dist_m"] = (cnt["c"] / cnt["n_pts"] * cnt["distance_m"]).round(1)

    piv = cnt.pivot_table(index="segment_id", columns="vbin",
                          values="dist_m", fill_value=0.0)
    piv.columns = [("dist_vmax_inconnu_m" if b == -1 else f"dist_vmax_{int(b)}_m")
                   for b in piv.columns]
    piv = piv.reset_index()
    dist_cols = [c for c in piv.columns if c.startswith("dist_vmax_")]
    segs_m = segs_m.merge(piv, on="segment_id", how="left")
    for c in dist_cols:
        segs_m[c] = segs_m[c].fillna(0.0)

    # Limite dominante (sur la distance), hors "inconnu" → vitesse_limite_kmh réelle
    reel_cols = [c for c in dist_cols if c != "dist_vmax_inconnu_m"]
    if reel_cols:
        vitesses = np.array([int(c.split("_")[2]) for c in reel_cols])
        arr = segs_m[reel_cols].to_numpy()
        dom_idx = arr.argmax(axis=1)
        dom_val = arr.max(axis=1)
        segs_m["vitesse_limite_kmh"] = np.where(dom_val > 0, vitesses[dom_idx], np.nan)
    else:
        segs_m["vitesse_limite_kmh"] = np.nan

    n_ok = segs_m["vitesse_limite_kmh"].notna().sum()
    print(f"  vitesse_limite_kmh (dominante) → {n_ok}/{len(segs_m)} segments  |  "
          f"colonnes : {sorted(reel_cols)}")

    # =========================================================
    # 5. FEUX DE CIRCULATION — nb_feux par segment
    # =========================================================
    print("\n5. Feux de circulation (comptage)")

    # On compte simplement les feux dans le buffer de chaque segment
    feux_join = gpd.sjoin(
        segs_buf, feux[["geometry"]], how="left", predicate="intersects"
    )
    nb_feux = (
        feux_join.groupby("segment_id")["index_right"]
        .count()
        .reset_index()
        .rename(columns={"index_right": "nb_feux"})
    )
    segs_m = segs_m.merge(nb_feux, on="segment_id", how="left")
    segs_m["nb_feux"] = segs_m["nb_feux"].fillna(0).astype(int)

    print(f"  nb_feux moy. {segs_m['nb_feux'].mean():.2f}  |  "
          f"max {segs_m['nb_feux'].max()}")

    # =========================================================
    # 6. ÉTAT DE LA CHAUSSÉE
    # =========================================================
    print("\n6. État de la chaussée (auscultation 2024)")

    if COL_ETAT_CHAUSSEE in chaussee.columns:
        chaussee_sub = chaussee[[COL_ETAT_CHAUSSEE, "geometry"]].copy()
        etat_agg = sjoin_agg(
            segs_buf, chaussee_sub,
            {COL_ETAT_CHAUSSEE: mode_or_nan}
        ).rename(columns={COL_ETAT_CHAUSSEE: "etat_chaussee"})
        segs_m = segs_m.merge(etat_agg, on="segment_id", how="left")
        n = segs_m["etat_chaussee"].notna().sum()
        print(f"  etat_chaussee renseigné pour {n}/{len(segs_m)} segments")
    else:
        print(f"  ⚠ Colonne '{COL_ETAT_CHAUSSEE}' introuvable "
              f"(colonnes : {chaussee.columns.tolist()})")

    # =========================================================
    # 7. FEATURES PHYSIQUES (modèle road-load)
    # =========================================================
    # Décomposition de la demande énergétique de traction d'un bus sur le segment :
    #   gravité + roulement + aérodynamique + (ré)accélération aux arrêts,
    # plus l'énergie potentiellement récupérable au freinage (regen).
    # Chaque énergie est produite en absolu (kJ, masse assumée) et en spécifique
    # (J/kg). Calcul 100 % vectorisé.
    print("\n7. Features physiques (modèle road-load)")

    def _col(df, name):
        """Série de la colonne si présente, sinon série de NaN alignée."""
        return df[name] if name in df.columns else pd.Series(np.nan, index=df.index)

    # Vitesse effective (avec repli) et coefficient de roulement
    v_kmh = vitesse_effective(_col(segs_m, "vitesse_limite_kmh"),
                              _col(segs_m, "highway"), vmax_by_highway)
    v_ms = v_kmh / 3.6
    crr = coef_roulement(_col(segs_m, "surface"), _col(segs_m, "etat_chaussee"))
    segs_m["vitesse_calc_kmh"] = v_kmh.round(1)
    segs_m["coef_roulement"] = crr.round(5)

    # Variables intermédiaires
    dist = segs_m["distance_m"]
    dh = segs_m["altitude_fin_m"] - segs_m["altitude_debut_m"]   # net signé
    n_arrets = segs_m["nb_feux"].fillna(0) + N_ARRETS_EXTREMITES
    M = MASSE_BUS_KG

    # Énergies (en Joules)
    E = {
        "energie_pot_nette":    M * G * dh,
        "energie_pot_montee":   M * G * segs_m["denivele_pos_m"],
        "energie_pot_descente": M * G * segs_m["denivele_neg_m"],
        "travail_roulement":    crr * M * G * dist,
        "travail_aero":         0.5 * RHO_AIR * CD_BUS * AIRE_FRONTALE_M2 * v_ms ** 2 * dist,
        "energie_arrets":       n_arrets * 0.5 * M * v_ms ** 2,
    }
    E["energie_traction_totale"] = (
        E["energie_pot_montee"] + E["travail_roulement"]
        + E["travail_aero"] + E["energie_arrets"]
    )
    E["energie_regen"] = E["energie_pot_descente"] + E["energie_arrets"]

    # Déclinaison absolue (kJ) et spécifique (J/kg)
    for nom, e_j in E.items():
        segs_m[f"{nom}_kJ"] = (e_j / 1000.0).round(2)
        segs_m[f"{nom}_J_kg"] = (e_j / M).round(2)

    # Taux de récupération potentiel (sans dimension, %)
    segs_m["taux_regen_pct"] = np.where(
        E["energie_traction_totale"] > 0,
        (E["energie_regen"] / E["energie_traction_totale"] * 100).round(2),
        0.0,
    )

    print(f"  Traction totale moy. {segs_m['energie_traction_totale_kJ'].mean():.1f} kJ  |  "
          f"Regen moy. {segs_m['energie_regen_kJ'].mean():.1f} kJ  |  "
          f"Taux regen moy. {segs_m['taux_regen_pct'].mean():.1f} %")

    # =========================================================
    # 8. EXPORT
    # =========================================================
    print("\n8. Export")

    base_cols = [
        "segment_id", "route_id", "shape_id", "start_stop_code", "end_stop_code",
        "distance_m", "sinuosite", "orientation_deg",
        "altitude_debut_m", "altitude_fin_m", "denivele_pos_m", "denivele_neg_m", "pente_moy_pct",
    ]
    opt_cols = [
        "highway", "surface", "nb_voies", "sens_unique", "vitesse_limite_kmh",
        "nb_feux", "etat_chaussee",
    ]
    # Features physiques (modèle road-load) : énergies en kJ (absolu) et J/kg (spécifique)
    _energies = [
        "energie_pot_nette", "energie_pot_montee", "energie_pot_descente",
        "travail_roulement", "travail_aero", "energie_arrets",
        "energie_traction_totale", "energie_regen",
    ]
    physics_cols = (
        ["vitesse_calc_kmh", "coef_roulement"]
        + [f"{e}_kJ" for e in _energies]
        + [f"{e}_J_kg" for e in _energies]
        + ["taux_regen_pct"]
    )
    # Répartition des distances par limite de vitesse (colonnes dynamiques)
    vitesse_cols = sorted(
        [c for c in segs_m.columns if c.startswith("dist_vmax_")],
        key=lambda c: (c == "dist_vmax_inconnu_m",
                       int(c.split("_")[2]) if c.split("_")[2].isdigit() else 9999),
    )
    feature_cols = (
        base_cols
        + [c for c in opt_cols if c in segs_m.columns]
        + vitesse_cols
        + [c for c in physics_cols if c in segs_m.columns]
    )

    result = gpd.GeoDataFrame(
        segs_m[feature_cols], geometry=segs_m.geometry, crs=CRS_METRIQUE
    ).to_crs(CRS_GEO)

    gpkg_path = DATA_DERIVEE / f"attributs_segments{suf}.gpkg"
    parquet_path = DATA_DERIVEE / f"attributs_segments{suf}.parquet"

    result.to_file(gpkg_path, driver="GPKG")
    result.drop(columns=["geometry"]).to_parquet(parquet_path, index=False)

    print(f"  GPKG    : {gpkg_path}")
    print(f"  Parquet : {parquet_path}")


if __name__ == "__main__":
    for mode in ("normal", "fusion"):
        traiter(mode)
    print("\nTerminé.")
