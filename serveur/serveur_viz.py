"""
serveur_viz.py
==============
Serveur Flask de visualisation du réseau bus (100 % open data) :
  - /              → carte interactive (Leaflet) : segments, relations, arrêts,
                     relief, géobase, création de trajet avec estimé d'énergie
  - /graphe        → graphe abstrait (Cytoscape)
  - /graphe_calcul → arbre de voisinage avec moteur physique (Cytoscape)
  - /consommation  → profils de consommation simulée par segment (Plotly)
  - /simulation    → profil vitesse / puissance seconde par seconde (Plotly)

Les pages se synchronisent via BroadcastChannel (API navigateur native) :
la sélection effectuée dans l'une se reflète instantanément dans les autres.

Deux jeux de données sont chargés au démarrage et exposés via le paramètre
?mode= des routes /api/* :
  - mode "normal" : segments.gpkg + relations_segments.parquet
  - mode "fusion" : segments_merge_identiques.gpkg + relations_segments_merge_identiques.parquet
    (segments partageant le même couple start/end fusionnés en un seul nœud ;
     le dictionnaire de liaison est servi par /api/liaison)

La consommation affichée est SYNTHÉTIQUE : générée par le modèle physique
road-load (pipeline/p06_conso_synthetique.py) à partir du GTFS et de données
ouvertes — aucune donnée mesurée.

Lancement :
    python serveur/serveur_viz.py
"""

# %% =============================================================
# IMPORTS
# ===============================================================
import gc
import gzip
import json
import os
import sys
import threading
import time
from collections import deque
from pathlib import Path

import numpy as np
import pandas as pd
from flask import Flask, render_template, jsonify, request, send_from_directory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import (DATA_BRUTE, DATA_DERIVEE, GTFS_DIR, HOTE, PORT, VIZ_LIGHT, STM_API_KEY,  # noqa: E402
                    DETOURS_ACTIONS)
from modele_physique import profil_cinematique, GrapheRoutier  # noqa: E402

# Temps réel GTFS-RT : optionnel (clé STM + bindings protobuf). Sans l'un ou
# l'autre, la couche est simplement désactivée.
try:
    import gtfs_rt  # noqa: E402
    _GTFS_RT_IMPORT_OK = True
except ImportError:
    _GTFS_RT_IMPORT_OK = False
from service_prevu import ServicePrevu  # noqa: E402
from regularite import Regularite  # noqa: E402
from detours import SuiviDetours  # noqa: E402

# geopandas / shapely ne sont importés que si les payloads doivent être
# reconstruits : en mode statique (payloads pré-calculés), ~100 Mo de
# bibliothèques géo ne sont jamais chargés.
gpd = None
Point = None


def _import_geo():
    global gpd, Point
    if gpd is None:
        import geopandas as _gpd
        from shapely.geometry import Point as _Point
        gpd, Point = _gpd, _Point


# %% =============================================================
# PARAMÈTRES
# ===============================================================

# --- Jeu "normal" ---
PATH_SEGMENTS   = DATA_DERIVEE / "segments.gpkg"
PATH_RELATIONS  = DATA_DERIVEE / "relations_segments.parquet"
PATH_CENTRALITE = DATA_DERIVEE / "centralite_segments.parquet"
PATH_ATTRIBUTS  = DATA_DERIVEE / "attributs_segments.parquet"

# --- Jeu "fusion" (segments identiques fusionnés) ---
PATH_SEGMENTS_FUSION   = DATA_DERIVEE / "segments_merge_identiques.gpkg"
PATH_RELATIONS_FUSION  = DATA_DERIVEE / "relations_segments_merge_identiques.parquet"
PATH_CENTRALITE_FUSION = DATA_DERIVEE / "centralite_segments_merge_identiques.parquet"
PATH_ATTRIBUTS_FUSION  = DATA_DERIVEE / "attributs_segments_merge_identiques.parquet"
PATH_LIAISON_FUSION    = DATA_DERIVEE / "liaison_fusion.parquet"

# --- Consommation synthétique (p06) et graphe routier (p08) ---
PATH_CONSO        = DATA_DERIVEE / "conso_synthetique_segments.parquet"
PATH_GRAPHE_NOEUDS = DATA_DERIVEE / "graphe_routier_noeuds.parquet"
PATH_GRAPHE_ARETES = DATA_DERIVEE / "graphe_routier_aretes.parquet"

# --- Relief (p07). Le « réseau routier » affichable est désormais dérivé des
# arêtes du graphe de routage (p08) — cf. /api/reseau_routier — donc léger et
# versionné, sans dépendre de la géobase brute (43 Mo). ---
DIR_RELIEF          = DATA_DERIVEE / "relief"
PATH_RELIEF_PNG     = DIR_RELIEF / "altitude_overlay.png"
PATH_RELIEF_BOUNDS  = DIR_RELIEF / "altitude_overlay_bounds.json"

# --- Arrêts GTFS ---
PATH_STOPS = GTFS_DIR / "stops.txt"

# --- Parcours (route patterns) GTFS : shape_id -> ligne / direction / destination ---
PATH_TRIPS          = GTFS_DIR / "trips.txt"
PATH_DIRECTIONS     = GTFS_DIR / "directions.txt"
PATH_ROUTE_PATTERNS = GTFS_DIR / "route_patterns.txt"

# --- Normales climatiques (température par mois pour le trajet tracé) ---
PATH_NORMALES = DATA_BRUTE / "normales_climatiques_montreal.csv"

# --- Payloads statiques pré-calculés (scripts/exporter_payloads_statiques.py) ---
DIR_PAYLOADS      = DATA_DERIVEE / "payloads_statiques"
PATH_PL_SEGMENTS  = DIR_PAYLOADS / "segments_normal.json.gz"
PATH_PL_RELATIONS = DIR_PAYLOADS / "relations_normal.json.gz"
PATH_PL_STOPS     = DIR_PAYLOADS / "stops.json.gz"
PATH_PL_RESEAU    = DIR_PAYLOADS / "reseau_routier.json.gz"
PATH_PL_META      = DIR_PAYLOADS / "meta_statique.json"
PATH_PL_ENERGIE   = DIR_PAYLOADS / "energie_carte.json.gz"

# Mode statique : en VIZ_LIGHT, si les payloads pré-calculés existent, ils sont
# servis tels quels — aucune reconstruction, ni geopandas, ni pic de boot.
# VIZ_FORCE_CALCUL=1 force la reconstruction (utilisé par l'exporteur).
MODE_STATIQUE = (VIZ_LIGHT
                 and os.environ.get("VIZ_FORCE_CALCUL", "") != "1"
                 and all(p.exists() for p in (
                     PATH_PL_SEGMENTS, PATH_PL_RELATIONS, PATH_PL_STOPS,
                     PATH_PL_RESEAU, PATH_PL_META)))

# Colonnes d'attributs (p04_attributs_segments.py) exposées dans les panneaux.
# L'ordre est conservé pour l'affichage groupé côté client.
ATTR_COLS = [
    # Géographie
    "distance_m", "sinuosite", "orientation_deg",
    "altitude_debut_m", "altitude_fin_m", "denivele_pos_m", "denivele_neg_m", "pente_moy_pct",
    # Réseau
    "highway", "surface", "nb_voies", "sens_unique", "vitesse_limite_kmh",
    "nb_feux", "etat_chaussee",
    # Énergie (modèle road-load) — versions absolues kJ + traçabilité
    "energie_traction_totale_kJ", "energie_pot_nette_kJ", "energie_pot_montee_kJ",
    "energie_pot_descente_kJ", "travail_roulement_kJ", "travail_aero_kJ",
    "energie_arrets_kJ", "energie_regen_kJ", "taux_regen_pct",
    "coef_roulement", "vitesse_calc_kmh",
]

SEUIL_INTERSECTION_PIVOT_SUIVANT_M = 20.0

# Palette cohérente entre les vues
COULEURS_RELATIONS = {
    "suivant":          "#1976d2",
    "portion_partagee": "#2e7d32",
    "intersection":     "#0288d1",
    "merge":            "#7b1fa2",
    "diverge":          "#c2185b",
    "oppose":           "#f57c00",
    "parallele_proche": "#5d4037",
}


# %% =============================================================
# HELPERS GÉOMÉTRIE / FILTRE (partagés entre les deux jeux)
# ===============================================================
def extract_coords(geom):
    """Renvoie une liste de [lat, lon] (format Leaflet) ou une liste de listes pour MultiLineString."""
    if geom.geom_type == "LineString":
        return [[lat, lon] for lon, lat in geom.coords]
    if geom.geom_type == "MultiLineString":
        return [[[lat, lon] for lon, lat in g.coords] for g in geom.geoms]
    return []


def midpoint(geom):
    """Point au milieu de la géométrie pour les nodes du graphe et les marqueurs cliquables."""
    line = geom if geom.geom_type == "LineString" else max(geom.geoms, key=lambda g: g.length)
    pt = line.interpolate(0.5, normalized=True)
    return [pt.y, pt.x]  # [lat, lon]


def _segment_end_point(geom):
    if geom.geom_type == "LineString":
        x, y = geom.coords[-1]
        return Point(x, y)
    if geom.geom_type == "MultiLineString":
        g = max(geom.geoms, key=lambda part: part.length)
        x, y = g.coords[-1]
        return Point(x, y)
    return None


def _filter_intersections_near_suivant_pivot(rel_df, segments_gdf, threshold_m=20.0):
    inter_mask = rel_df["type_relation"] == "intersection"
    suiv_mask = rel_df["type_relation"] == "suivant"
    if not inter_mask.any() or not suiv_mask.any():
        return rel_df, 0

    seg_m = segments_gdf[["segment_id", "geometry"]].to_crs("EPSG:32188")
    geom_by_seg = {int(r.segment_id): r.geometry for r in seg_m.itertuples(index=False)}
    end_pt_by_seg = {
        int(r.segment_id): _segment_end_point(r.geometry)
        for r in seg_m.itertuples(index=False)
    }

    suiv_by_pair = {}
    for r in rel_df[suiv_mask].itertuples(index=False):
        a = int(r.segment_id_a)
        b = int(r.segment_id_b)
        key = tuple(sorted((a, b)))
        suiv_by_pair.setdefault(key, []).append(a)

    to_drop = []
    for idx, r in rel_df[inter_mask].iterrows():
        a = int(r["segment_id_a"])
        b = int(r["segment_id_b"])
        key = tuple(sorted((a, b)))
        seg_a_list = suiv_by_pair.get(key)
        if not seg_a_list:
            continue

        geom_a = geom_by_seg.get(a)
        geom_b = geom_by_seg.get(b)
        if geom_a is None or geom_b is None:
            continue
        inter_geom = geom_a.intersection(geom_b)
        if inter_geom.is_empty:
            continue

        remove = False
        for seg_a in seg_a_list:
            pivot_pt = end_pt_by_seg.get(int(seg_a))
            if pivot_pt is None:
                continue
            if inter_geom.distance(pivot_pt) <= threshold_m:
                remove = True
                break

        if remove:
            to_drop.append(idx)

    if not to_drop:
        return rel_df, 0
    return rel_df.drop(index=to_drop).copy(), len(to_drop)


# %% =============================================================
# CONSTRUCTION D'UN JEU DE DONNÉES (segments + relations + centralité)
# ===============================================================
def _load_attributs(path_attributs):
    """Dict {segment_id: {col: valeur}} pour les colonnes de ATTR_COLS présentes.

    Les NaN sont convertis en None (sérialisable JSON). Renvoie {} si absent.
    """
    if not path_attributs or not Path(path_attributs).exists():
        return {}
    df = pd.read_parquet(path_attributs)
    if "segment_id" not in df.columns:
        return {}
    # Colonnes fixes (ATTR_COLS) + colonnes dynamiques de répartition par limite
    dyn = [c for c in df.columns if c.startswith("dist_vmax_")]
    cols = [c for c in ATTR_COLS if c in df.columns] + dyn
    out = {}
    for r in df[["segment_id"] + cols].itertuples(index=False):
        d = r._asdict() if hasattr(r, "_asdict") else dict(zip(["segment_id"] + cols, r))
        sid = int(d.pop("segment_id"))
        out[sid] = {k: (None if pd.isna(v) else v) for k, v in d.items()}
    return out


def build_dataset(path_segments, path_relations, path_centralite,
                  routes_by_seg=None, path_attributs=None, parcours_by_seg=None):
    """Construit les payloads d'un jeu de données.

    routes_by_seg : dict optionnel {segment_id: [route_id, ...]} pour le mode
    fusion (un nœud regroupe plusieurs lignes). Si None, chaque segment porte
    sa seule route_id.
    parcours_by_seg : dict optionnel {segment_id: [shape_id, ...]} pour le mode
    fusion (un nœud regroupe plusieurs parcours). Si None, chaque segment porte
    son seul shape_id (colonne de segments.gpkg).
    path_attributs : parquet d'attributs (p04) joint par segment_id ; ses
    colonnes (ATTR_COLS) sont exposées sous la clé "attributs".

    Retourne un dict : segments, relations, lignes, types, center, codes_utiles.
    """
    _import_geo()
    segments = gpd.read_file(path_segments).to_crs("EPSG:4326").reset_index(drop=True)
    segments["segment_id"] = segments.index.astype(int)
    segments["route_id"] = segments["route_id"].astype(str)
    segments["start_stop_code"] = segments["start_stop_code"].astype(int)
    segments["end_stop_code"] = segments["end_stop_code"].astype(int)
    has_shape = "shape_id" in segments.columns
    if has_shape:
        segments["shape_id"] = segments["shape_id"].astype(str)

    attributs_by_id = _load_attributs(path_attributs)

    # Centralité
    centralite_by_id = {}
    if Path(path_centralite).exists():
        _c = pd.read_parquet(path_centralite)
        centralite_by_id = {
            int(r["segment_id"]): {
                "degree_in":      int(r["degree_in"]),
                "degree_out":     int(r["degree_out"]),
                "degree_total":   int(r["degree_total"]),
                "pagerank":       float(r["pagerank"]),
                "pagerank_norm":  float(r["pagerank_norm"]),
                "radiality":      float(r.get("radiality",      0.0)),
                "radiality_norm": float(r.get("radiality_norm", 0.0)),
            }
            for _, r in _c.iterrows()
        }

    segments_payload = []
    for _, row in segments.iterrows():
        sid = int(row["segment_id"])
        c = centralite_by_id.get(sid, {})
        routes = routes_by_seg.get(sid, [row["route_id"]]) if routes_by_seg else [row["route_id"]]
        shape_id = str(row["shape_id"]) if has_shape else None
        if parcours_by_seg:
            parcours = parcours_by_seg.get(sid, [shape_id] if shape_id else [])
        else:
            parcours = [shape_id] if shape_id else []
        segments_payload.append({
            "id":              sid,
            "route_id":        row["route_id"],   # ligne représentative
            "routes":          routes,            # toutes les lignes du nœud (1 en normal)
            "shape_id":        shape_id,          # parcours représentatif (None en fusion)
            "parcours":        parcours,          # tous les parcours du nœud (1 en normal)
            "start_stop_code": int(row["start_stop_code"]),
            "end_stop_code":   int(row["end_stop_code"]),
            "coords":          extract_coords(row.geometry),
            "is_multi":        row.geometry.geom_type == "MultiLineString",
            "midpoint":        midpoint(row.geometry),
            "degree_in":       c.get("degree_in",       0),
            "degree_out":      c.get("degree_out",      0),
            "degree_total":    c.get("degree_total",    0),
            "pagerank":        c.get("pagerank",        0.0),
            "pagerank_norm":   c.get("pagerank_norm",   0.0),
            "radiality":       c.get("radiality",       0.0),
            "radiality_norm":  c.get("radiality_norm",  0.0),
            "attributs":       attributs_by_id.get(sid, {}),
        })

    # Relations
    relations = pd.read_parquet(path_relations)
    relations["segment_id_a"] = relations["segment_id_a"].astype(int)
    relations["segment_id_b"] = relations["segment_id_b"].astype(int)
    relations, n_filtered = _filter_intersections_near_suivant_pivot(
        relations, segments, threshold_m=SEUIL_INTERSECTION_PIVOT_SUIVANT_M,
    )

    relations_payload = []
    for _, r in relations.iterrows():
        relations_payload.append({
            "a": int(r["segment_id_a"]),
            "b": int(r["segment_id_b"]),
            "type": r["type_relation"],
            "route_a": r.get("route_id_a") if pd.notna(r.get("route_id_a")) else None,
            "route_b": r.get("route_id_b") if pd.notna(r.get("route_id_b")) else None,
            "longueur_m": (float(r["longueur_recouvrement_m"])
                           if pd.notna(r.get("longueur_recouvrement_m")) else None),
            "stop_pivot": (int(r["stop_pivot"])
                           if pd.notna(r.get("stop_pivot")) else None),
        })

    lignes = sorted(segments["route_id"].unique(), key=lambda x: (len(x), x))
    types = sorted({r["type"] for r in relations_payload})
    # Centre initial de la carte : moyenne des centres des boîtes englobantes (un
    # .centroid en lat/lon déclenche un UserWarning de GeoPandas ; écart négligeable ici)
    b = segments.geometry.bounds
    center = [float(((b["miny"] + b["maxy"]) / 2).mean()),
              float(((b["minx"] + b["maxx"]) / 2).mean())]
    codes_utiles = set(segments["start_stop_code"]) | set(segments["end_stop_code"])

    print(f"    {len(segments_payload)} seg | {len(relations_payload)} rel "
          f"(filtre intersection/pivot: {n_filtered} retirées)")

    return {
        "segments":     segments_payload,
        "relations":    relations_payload,
        "lignes":       lignes,
        "types":        types,
        "center":       center,
        "codes_utiles": codes_utiles,
    }


# %% =============================================================
# CHARGEMENT DES DONNÉES (une fois au démarrage)
# ===============================================================
print("=== Chargement des données ===")

def _lire_gz_texte(path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return f.read()


if MODE_STATIQUE:
    print("Mode statique : payloads pré-calculés servis tels quels "
          "(régénération : scripts/exporter_payloads_statiques.py)")
    with open(PATH_PL_META, "r", encoding="utf-8") as f:
        _meta_stat = json.load(f)
    # Décompressés UNE FOIS ici et servis tels quels par /api/* (même mécanisme
    # que la compaction JSON du mode dynamique, cf. plus bas) : on évite de
    # renvoyer un Content-Encoding: gzip manuel, fragile derrière un proxy PaaS
    # (risque de double compression / décodage cassé côté navigateur, constaté
    # sur Render — cause du hover/clic segments non fonctionnel).
    DATASETS = {"normal": {
        "lignes":        _meta_stat["lignes"],
        "types":         _meta_stat["types_relations"],
        "center":        _meta_stat["center"],
        "n_segments":    int(_meta_stat["n_segments"]),
        "n_relations":   int(_meta_stat["n_relations"]),
        "segments_json":  _lire_gz_texte(PATH_PL_SEGMENTS),
        "relations_json": _lire_gz_texte(PATH_PL_RELATIONS),
    }}
    print(f"    {DATASETS['normal']['n_segments']} seg | "
          f"{DATASETS['normal']['n_relations']} rel (pré-calculés)")
else:
    print("Jeu normal...")
    DATASETS = {"normal": build_dataset(PATH_SEGMENTS, PATH_RELATIONS, PATH_CENTRALITE,
                                        path_attributs=PATH_ATTRIBUTS)}

# --- Jeu fusion (si les fichiers existent et hors mode allégé) ---
LIAISON_PAYLOAD = {}
_fusion_dispo = (not VIZ_LIGHT) and all(p.exists() for p in (
    PATH_SEGMENTS_FUSION, PATH_RELATIONS_FUSION, PATH_LIAISON_FUSION))
if _fusion_dispo:
    print("Jeu fusion...")
    _liaison = pd.read_parquet(PATH_LIAISON_FUSION)
    _liaison["merged_id"] = _liaison["merged_id"].astype(int)
    routes_by_merged = {}
    parcours_by_merged = {}
    for mid, grp in _liaison.groupby("merged_id"):
        routes_by_merged[int(mid)] = sorted(grp["route_id"].astype(str).unique(),
                                            key=lambda x: (len(x), x))
        if "shape_id" in grp.columns:
            parcours_by_merged[int(mid)] = sorted(grp["shape_id"].astype(str).unique(),
                                                  key=lambda x: (len(x), x))
        LIAISON_PAYLOAD[int(mid)] = {
            "routes": routes_by_merged[int(mid)],
            "segments": [
                {
                    "seg_id":   int(rr["segment_id_origine"]),
                    "route_id": str(rr["route_id"]),
                    "shape_id": str(rr["shape_id"]),
                }
                for _, rr in grp.iterrows()
            ],
        }
    DATASETS["fusion"] = build_dataset(
        PATH_SEGMENTS_FUSION, PATH_RELATIONS_FUSION, PATH_CENTRALITE_FUSION,
        routes_by_seg=routes_by_merged, path_attributs=PATH_ATTRIBUTS_FUSION,
        parcours_by_seg=parcours_by_merged,
    )
    print(f"  Liaison : {len(LIAISON_PAYLOAD)} nœuds fusionnés.")
elif VIZ_LIGHT:
    print("  (mode allégé VIZ_LIGHT — jeu fusion non chargé)")
else:
    print("  (jeu fusion absent — bouton Fusion désactivé)")

MODES_DISPONIBLES = list(DATASETS.keys())
FUSION_DISPONIBLE = "fusion" in DATASETS


def _dataset(mode):
    """Renvoie le jeu demandé, avec repli sur 'normal'."""
    return DATASETS.get(mode, DATASETS["normal"])


# --- Arrêts (communs aux deux jeux) ---
if MODE_STATIQUE:
    STOPS_PAYLOAD = None            # servis depuis stops.json.gz
    N_STOPS = int(_meta_stat["n_stops"])
else:
    print("Arrêts...")
    if PATH_STOPS.exists():
        _stops = pd.read_csv(PATH_STOPS)
    else:
        print(f"  ⚠ {PATH_STOPS} absent — arrêts non affichés "
              "(voir data_brute/README.md).")
        _stops = pd.DataFrame(columns=["stop_code", "stop_name", "stop_lat", "stop_lon"])
    _stops["stop_code"] = pd.to_numeric(_stops["stop_code"], errors="coerce")
    _stops = _stops.dropna(subset=["stop_code"]).copy()
    _stops["stop_code"] = _stops["stop_code"].astype(int)

    _codes_utiles = set()
    for ds in DATASETS.values():
        _codes_utiles |= ds["codes_utiles"]
    _stops_filtre = _stops[_stops["stop_code"].isin(_codes_utiles)]
    STOPS_PAYLOAD = [
        {
            "stop_code": int(r["stop_code"]),
            "stop_name": r.get("stop_name", "") if pd.notna(r.get("stop_name")) else "",
            "lat": float(r["stop_lat"]),
            "lon": float(r["stop_lon"]),
        }
        for _, r in _stops_filtre.iterrows()
    ]
    N_STOPS = len(STOPS_PAYLOAD)

# Lignes / types : union des jeux (pour que SERVER_META reste valable après bascule)
LIGNES_DISPONIBLES = sorted(
    {l for ds in DATASETS.values() for l in ds["lignes"]},
    key=lambda x: (len(x), x),
)
TYPES_RELATIONS = sorted({t for ds in DATASETS.values() for t in ds["types"]})
CENTER_LAT, CENTER_LON = DATASETS["normal"]["center"]


# --- Parcours (route patterns) dérivés du GTFS ------------------------
# Un « parcours » = un shape_id GTFS (== route_pattern_id chez la STM).
# On dérive un libellé lisible « direction · destination » via trips.txt,
# directions.txt et route_patterns.txt (aucune donnée Mobilestats/conso).
def _load_parcours_gtfs():
    """Renvoie {shape_id: {parcours_id, route_id, label, direction, headsign, typicality}}."""
    info = {}
    if not PATH_TRIPS.exists():
        return info
    keep = {"route_id", "shape_id", "direction_id", "trip_headsign", "route_pattern_id"}
    trips = pd.read_csv(PATH_TRIPS, dtype=str, usecols=lambda c: c in keep)

    dir_map = {}
    if PATH_DIRECTIONS.exists():
        d = pd.read_csv(PATH_DIRECTIONS, dtype=str)
        if {"route_id", "direction_id", "direction"} <= set(d.columns):
            for r in d.itertuples(index=False):
                dir_map[(str(r.route_id), str(r.direction_id))] = str(r.direction or "")

    typ_map = {}
    if PATH_ROUTE_PATTERNS.exists():
        rp = pd.read_csv(PATH_ROUTE_PATTERNS, dtype=str)
        if {"route_pattern_id", "route_pattern_typicality"} <= set(rp.columns):
            typ_map = {
                str(k): int(v) if pd.notna(v) else 0
                for k, v in zip(rp["route_pattern_id"],
                                pd.to_numeric(rp["route_pattern_typicality"], errors="coerce"))
            }

    trips = trips.dropna(subset=["shape_id"]).drop_duplicates("shape_id")
    for r in trips.itertuples(index=False):
        shape_id = str(r.shape_id)
        rid      = str(getattr(r, "route_id", "") or "")
        did      = str(getattr(r, "direction_id", "") or "")
        headsign = str(getattr(r, "trip_headsign", "") or "")
        pat      = str(getattr(r, "route_pattern_id", "") or "") or shape_id
        direction = dir_map.get((rid, did), "")
        # Libellé « direction · destination ». Le trip_headsign STM commence
        # souvent déjà par la direction (« Sud », « Ouest destination … ») :
        # on évite alors de la répéter en préfixe.
        if direction and headsign:
            if headsign.lower().startswith(direction.lower()):
                label = headsign
            else:
                label = f"{direction} · {headsign}"
        else:
            label = headsign or direction or shape_id
        info[shape_id] = {
            "parcours_id": pat,
            "route_id":    rid,
            "label":       label,
            "direction":   direction,
            "headsign":    headsign,
            "typicality":  typ_map.get(pat, 0),
        }
    return info


if MODE_STATIQUE:
    LIGNES_PARCOURS = _meta_stat["lignes_parcours"]
    print(f"  Parcours GTFS : {sum(len(v) for v in LIGNES_PARCOURS.values())} "
          f"parcours pré-calculés sur {len(LIGNES_PARCOURS)} ligne(s)")
else:
    PARCOURS_INFO = _load_parcours_gtfs()

    # shape_id réellement présents dans au moins un jeu de segments
    _shapes_presentes = set()
    for ds in DATASETS.values():
        for sp in ds["segments"]:
            for p in (sp.get("parcours") or []):
                if p:
                    _shapes_presentes.add(p)

    # LIGNES_PARCOURS : {route_id: [{id, label, direction, headsign, typicality}, ...]}
    LIGNES_PARCOURS = {}
    for shape_id in _shapes_presentes:
        meta = PARCOURS_INFO.get(shape_id)
        if meta is None:
            rid = shape_id.split("_")[0] if "_" in shape_id else "?"
            meta = {"route_id": rid, "label": shape_id, "direction": "",
                    "headsign": "", "typicality": 0}
        LIGNES_PARCOURS.setdefault(meta["route_id"], []).append({
            "id":         shape_id,
            "label":      meta["label"],
            "direction":  meta["direction"],
            "headsign":   meta["headsign"],
            "typicality": meta["typicality"],
        })
    for _rid, _lst in LIGNES_PARCOURS.items():
        _lst.sort(key=lambda d: (-int(d.get("typicality") or 0), len(d["id"]), d["id"]))

    print(f"  Parcours GTFS : {len(_shapes_presentes)} shape(s) présent(s) "
          f"sur {len(LIGNES_PARCOURS)} ligne(s)")

print(f"  Données prêtes : modes={MODES_DISPONIBLES} | {N_STOPS} arrêts")


# %% =============================================================
# CONSOMMATION SYNTHÉTIQUE — modèle physique road-load (p06)
# ===============================================================
CONSO_DISPONIBLE   = False
CONSO_BY_PARCOURS  = {}    # parcours_type -> DataFrame
VOYAGE_PARCOURS    = {}    # voyage_id -> parcours_type
CONSO_ORDER        = {}    # parcours_type -> [segment_id, ...] (ordre le long du parcours)
SEG_INFO_CONSO     = {}    # segment_id -> {route_id, seg_start, seg_end, distance_m}
CONSO_OPTIONS      = {"parcours": [], "mois": [], "temp_min": None, "temp_max": None}

# Colonnes énergie du parquet synthétique.
_COL_CONSO = "conso_totale_Wh"
_COL_AUX   = "conso_chauffage_Wh"


def _safe(v, digits=1):
    """float arrondi JSON-safe, ou None si NaN/inf."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(f):
        return None
    return round(f, digits)


if VIZ_LIGHT:
    print("  (mode allégé VIZ_LIGHT — consommation/simulation non chargées)")
elif PATH_CONSO.exists():
    print("Consommation synthétique (modèle physique)...")
    _lc = pd.read_parquet(PATH_CONSO)
    _lc["segment_id"]    = _lc["segment_id"].astype(int)
    _lc["parcours_type"] = _lc["parcours_type"].astype(str)
    _lc["mois"]          = pd.to_numeric(_lc["mois"], errors="coerce")
    _lc["temperature_C"] = pd.to_numeric(_lc["temperature_C"], errors="coerce")

    # Métadonnées de segment (route, arrêts, longueur) depuis la table conso.
    _seg = (_lc.drop_duplicates("segment_id")
               .set_index("segment_id")[["route_id", "arret_debut_code",
                                          "arret_fin_code", "distance_m"]])
    for sid, r in _seg.iterrows():
        SEG_INFO_CONSO[int(sid)] = {
            "route_id":   str(r["route_id"]),
            "seg_start":  int(r["arret_debut_code"]),
            "seg_end":    int(r["arret_fin_code"]),
            "distance_m": float(r["distance_m"]),
        }

    # Enrichissement avec les features physiques (attributs_segments.parquet déjà
    # chargé dans le jeu "normal") : pente, dénivelés et nombre de feux pour le hover.
    for _sp in DATASETS["normal"]["segments"]:
        info = SEG_INFO_CONSO.get(int(_sp["id"]))
        if info is None:
            continue
        a = _sp.get("attributs", {}) or {}
        info["pente_moy_pct"]  = a.get("pente_moy_pct")
        info["denivele_pos_m"] = a.get("denivele_pos_m")
        info["denivele_neg_m"] = a.get("denivele_neg_m")
        info["nb_feux"]        = a.get("nb_feux")

    # Ordre canonique des segments le long de chaque parcours :
    # position représentative = médiane de la colonne `ordre` des voyages.
    _ord = (_lc.groupby(["parcours_type", "segment_id"])
               .agg(k1=("ordre", "median"))
               .reset_index()
               .sort_values(["k1"]))
    for pc, g in _ord.groupby("parcours_type"):
        CONSO_ORDER[pc] = g["segment_id"].tolist()

    # Sous-tables par parcours (filtrage rapide) + voyage -> parcours.
    for pc, g in _lc.groupby("parcours_type"):
        CONSO_BY_PARCOURS[pc] = g
    VOYAGE_PARCOURS = (_lc.drop_duplicates("voyage_id")
                          .set_index("voyage_id")["parcours_type"]
                          .astype(str).to_dict())

    _mois = sorted(int(m) for m in _lc["mois"].dropna().unique())
    CONSO_OPTIONS = {
        "parcours":  sorted(CONSO_BY_PARCOURS.keys(), key=lambda x: (len(x), x)),
        "mois":      _mois,
        "temp_min":  _safe(_lc["temperature_C"].min()),
        "temp_max":  _safe(_lc["temperature_C"].max()),
    }
    CONSO_DISPONIBLE = True
    print(f"  {len(_lc):,} lignes | {len(CONSO_BY_PARCOURS)} parcours | "
          f"{len(VOYAGE_PARCOURS):,} voyages")
else:
    print("  (conso synthétique absente — pages Consommation/Simulation désactivées ; "
          "lancer pipeline/p06_conso_synthetique.py)")


def _conso_profil(df_sel, parcours, with_mean):
    """Agrège un sous-ensemble (df_sel) par segment, ordonné le long du parcours.

    Retourne (segments[], mean[], n_observations). Les valeurs sont en Wh
    (moyenne par segment) ; le client dérive les kWh/km via distance_m.
    """
    order = CONSO_ORDER.get(parcours, [])
    rank = {sid: i for i, sid in enumerate(order)}

    def _agg(df):
        g = df.groupby("segment_id").agg(
            wh=(_COL_CONSO, "mean"),
            aux_wh=(_COL_AUX, "mean"),
            n=("voyage_id", "count"),
        )
        return g

    g = _agg(df_sel)
    segments = []
    for sid in order:
        if sid not in g.index:
            continue
        info = SEG_INFO_CONSO.get(sid, {})
        wh = g.at[sid, "wh"]
        aux = g.at[sid, "aux_wh"]
        dist = info.get("distance_m", 0.0) or 0.0
        wh_per_km = (wh / dist) if (dist > 0 and pd.notna(wh)) else None
        segments.append({
            "segment_id":          int(sid),
            "ordre":               rank.get(sid, len(segments)),
            "route_id":            info.get("route_id"),
            "seg_start_stop_code": info.get("seg_start"),
            "seg_end_stop_code":   info.get("seg_end"),
            "distance_m":          _safe(dist, 1),
            "wh":                  _safe(wh, 1),
            "wh_per_km":           _safe(wh_per_km, 3),
            "aux_wh":              _safe(aux, 1),
            "traction_wh":         _safe((wh - aux) if (pd.notna(wh) and pd.notna(aux)) else wh, 1),
            "n_obs":               int(g.at[sid, "n"]),
            "pente_moy_pct":       _safe(info.get("pente_moy_pct"), 2),
            "denivele_pos_m":      _safe(info.get("denivele_pos_m"), 1),
            "denivele_neg_m":      _safe(info.get("denivele_neg_m"), 1),
            "nb_feux":             (int(info["nb_feux"]) if info.get("nb_feux") is not None else None),
        })

    mean_payload = []
    if with_mean and parcours in CONSO_BY_PARCOURS:
        gm = _agg(CONSO_BY_PARCOURS[parcours])
        for sid in order:
            if sid not in gm.index:
                continue
            info = SEG_INFO_CONSO.get(sid, {})
            wh = gm.at[sid, "wh"]
            dist = info.get("distance_m", 0.0) or 0.0
            mean_payload.append({
                "segment_id": int(sid),
                "wh":         _safe(wh, 1),
                "wh_per_km":  _safe((wh / dist) if (dist > 0 and pd.notna(wh)) else None, 3),
            })

    n_obs = int(df_sel["voyage_id"].nunique())
    return segments, mean_payload, n_obs


# %% =============================================================
# PRÉVISION ÉNERGÉTIQUE SUR LA CARTE — agrégats mensuels du modèle physique
# ===============================================================
# La carte colore les segments selon la consommation estimée par le modèle
# road-load (p06), pour une plage de mois choisie côté client. On sert des
# SOMMES mensuelles (additives) : le navigateur agrège n'importe quelle plage
# sans rappeler le serveur, et le même fichier sert en mode statique (Render).
#   segments : Σ Wh des passages et nombre de passages, par segment × mois ;
#   parcours (ligne-direction) : Σ Wh et Σ km des voyages, nombre de voyages,
#   par parcours × mois — unité « voyage » de la consommation totale.
ENERGIE_JSON = None


def _libelles_directions():
    """(route_id, direction_id) -> libellé GTFS (« Nord », « Est »…), si disponible."""
    if not PATH_DIRECTIONS.exists():
        return {}
    d = pd.read_csv(PATH_DIRECTIONS, dtype=str)
    if not {"route_id", "direction_id", "direction"} <= set(d.columns):
        return {}
    return {(str(r.route_id), str(r.direction_id)): str(r.direction or "")
            for r in d.itertuples(index=False)}


def _construire_energie_carte(lc):
    """Payload compact des agrégats mensuels (voir en-tête de section)."""
    lc = lc[["voyage_id", "parcours_type", "route_id", "segment_id", "distance_m",
             "mois", "temperature_C", _COL_CONSO]].dropna(subset=["mois", _COL_CONSO])
    lc = lc.assign(mois=lc["mois"].astype(int), route_id=lc["route_id"].astype(str),
                   parcours_type=lc["parcours_type"].astype(str))

    # Parcours (ligne-direction) : un voyage = somme de ses segments
    v = (lc.groupby("voyage_id")
           .agg(parcours=("parcours_type", "first"), mois=("mois", "first"),
                wh=(_COL_CONSO, "sum"), km=("distance_m", lambda s: s.sum() / 1000))
           .reset_index())
    pcs = sorted(v["parcours"].unique(), key=lambda x: (len(x), x))
    i_pc = {p: i for i, p in enumerate(pcs)}
    gp = v.groupby(["parcours", "mois"]).agg(wh=("wh", "sum"), km=("km", "sum"), n=("voyage_id", "count"))
    P = len(pcs)
    p_wh, p_km, p_n = np.zeros(P * 12), np.zeros(P * 12), np.zeros(P * 12, dtype=int)
    gp = gp.reset_index()
    k = gp["parcours"].map(i_pc).to_numpy() * 12 + gp["mois"].to_numpy() - 1
    p_wh[k], p_km[k], p_n[k] = gp["wh"].to_numpy(), gp["km"].to_numpy(), gp["n"].to_numpy()
    libs = _libelles_directions()
    p_route = [p.rsplit("-", 1)[0] for p in pcs]
    p_dir = [libs.get((p.rsplit("-", 1)[0], p.rsplit("-", 1)[-1]), "") for p in pcs]

    # Segments : parcours majoritaire (26 segments sur ~15 800 en portent deux)
    seg = (lc.groupby("segment_id")
             .agg(route=("route_id", "first"), dist=("distance_m", "first"),
                  parcours=("parcours_type", lambda s: s.value_counts().index[0])))
    ids = seg.index.to_numpy()
    i_seg = {s: i for i, s in enumerate(ids)}
    gs = lc.groupby(["segment_id", "mois"]).agg(wh=(_COL_CONSO, "sum"), n=("voyage_id", "count"))
    N = len(ids)
    s_wh, s_n = np.zeros(N * 12), np.zeros(N * 12, dtype=int)
    gs = gs.reset_index()
    k = gs["segment_id"].map(i_seg).to_numpy() * 12 + gs["mois"].to_numpy() - 1
    s_wh[k], s_n[k] = gs["wh"].to_numpy(), gs["n"].to_numpy()

    t_mois = lc.drop_duplicates("voyage_id").groupby("mois")["temperature_C"].mean()
    return {
        "source": "Modèle physique road-load (pipeline/p06_conso_synthetique.py) : "
                  "consommation synthétique traction + chauffage, aucune donnée mesurée.",
        "temperature_mois": [_safe(t_mois.get(m), 1) for m in range(1, 13)],
        "segments": {
            "id": [int(s) for s in ids],
            "route": seg["route"].tolist(),
            "parcours": [i_pc[p] for p in seg["parcours"]],
            "distance_m": [round(float(d), 1) for d in seg["dist"]],
            "wh": np.round(s_wh).astype(int).tolist(),     # Σ Wh, [segment * 12 + mois - 1]
            "n": s_n.tolist(),                              # passages
        },
        "parcours": {
            "id": pcs, "route": p_route, "direction": p_dir,
            "wh": np.round(p_wh).astype(int).tolist(),      # Σ Wh des voyages
            "km": np.round(p_km, 3).tolist(),               # Σ km des voyages
            "n": p_n.tolist(),                              # voyages
        },
    }


def _energie_json(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


if VIZ_LIGHT and PATH_PL_ENERGIE.exists() and os.environ.get("VIZ_FORCE_CALCUL", "") != "1":
    ENERGIE_JSON = _lire_gz_texte(PATH_PL_ENERGIE)
elif CONSO_DISPONIBLE:
    ENERGIE_JSON = _energie_json(_construire_energie_carte(_lc))
elif PATH_CONSO.exists():
    # Mode allégé sans payload pré-calculé : calcul ponctuel, parquet libéré aussitôt
    _lce = pd.read_parquet(PATH_CONSO, columns=["voyage_id", "parcours_type", "route_id", "segment_id",
                                                "distance_m", "mois", "temperature_C", _COL_CONSO])
    ENERGIE_JSON = _energie_json(_construire_energie_carte(_lce))
    del _lce
    gc.collect()
ENERGIE_DISPONIBLE = ENERGIE_JSON is not None
if ENERGIE_DISPONIBLE:
    print(f"Prévision énergétique (carte) : agrégats mensuels prêts ({len(ENERGIE_JSON) / 1e6:.1f} Mo JSON)")


# %% =============================================================
# SIMULATION — attributs physiques par segment (jeu normal)
# ===============================================================
SIM_ATTRS = None
SIMULATION_DISPONIBLE = False
if CONSO_DISPONIBLE and PATH_ATTRIBUTS.exists():
    _a = pd.read_parquet(PATH_ATTRIBUTS)
    cols_sim = ["segment_id", "distance_m", "vitesse_calc_kmh", "pente_moy_pct",
                "coef_roulement", "nb_feux"]
    SIM_ATTRS = _a[[c for c in cols_sim if c in _a.columns]].set_index("segment_id")
    SIMULATION_DISPONIBLE = True
    print(f"Simulation : attributs physiques chargés ({len(SIM_ATTRS)} segments)")


# %% =============================================================
# COMPACTION MÉMOIRE — payloads figés en JSON
# ===============================================================
# Les payloads segments/relations/arrêts sont immuables après le démarrage.
# Les garder en objets Python (des millions de petits dicts/listes/floats)
# coûte plusieurs centaines de Mo de RSS ; on les sérialise une seule fois en
# JSON compact puis on libère les objets. Les routes /api/* renvoient la chaîne
# telle quelle (aucune re-sérialisation par requête). Indispensable pour tenir
# sur une instance à 512 Mo.
def _np_item(o):
    if hasattr(o, "item"):        # scalaires numpy (int64, float64…)
        return o.item()
    raise TypeError(f"Type non sérialisable en JSON : {type(o)!r}")


def _fige_json(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"),
                      default=_np_item)


if MODE_STATIQUE:
    STOPS_JSON = _lire_gz_texte(PATH_PL_STOPS)
    # Réseau routier : pré-décompressé ici aussi (même raison : pas de
    # Content-Encoding manuel), servi tel quel par /api/reseau_routier.
    _RESEAU_ROUTIER_CACHE = _lire_gz_texte(PATH_PL_RESEAU)
else:
    for _ds in DATASETS.values():
        _ds["n_segments"]     = len(_ds["segments"])
        _ds["n_relations"]    = len(_ds["relations"])
        _ds["segments_json"]  = _fige_json(_ds["segments"])
        _ds["relations_json"] = _fige_json(_ds["relations"])
        _ds["segments"] = _ds["relations"] = None
        _ds.pop("codes_utiles", None)

    STOPS_JSON = _fige_json(STOPS_PAYLOAD)
    STOPS_PAYLOAD = None
    _RESEAU_ROUTIER_CACHE = None   # construit à la demande, cf. /api/reseau_routier
    gc.collect()


# %% =============================================================
# GRAPHE ROUTIER — trajet tracé sur la carte (p08)
# ===============================================================
GRAPHE_ROUTIER = None
TRAJET_DISPONIBLE = False
if PATH_GRAPHE_NOEUDS.exists() and PATH_GRAPHE_ARETES.exists():
    print("Graphe routier (trajet)...")
    GRAPHE_ROUTIER = GrapheRoutier(PATH_GRAPHE_NOEUDS, PATH_GRAPHE_ARETES)
    TRAJET_DISPONIBLE = True
    print(f"  {len(GRAPHE_ROUTIER.noeuds):,} nœuds | {len(GRAPHE_ROUTIER.aretes):,} arêtes")
else:
    print("  (graphe routier absent — création de trajet désactivée ; "
          "lancer pipeline/p08_graphe_routier.py)")

# Températures moyennes mensuelles (trajet tracé : conversion mois -> T)
TEMP_PAR_MOIS = {}
if PATH_NORMALES.exists():
    _n = pd.read_csv(PATH_NORMALES, comment="#")
    TEMP_PAR_MOIS = dict(zip(_n["mois"].astype(int), _n["temp_moy_C"].astype(float)))

RELIEF_DISPONIBLE = PATH_RELIEF_PNG.exists() and PATH_RELIEF_BOUNDS.exists()

# Pages Graphe / Graphe de calcul : purement côté client (Cytoscape sur les
# mêmes payloads /api/segments + /api/relations que la carte, déjà servis
# statiquement en VIZ_LIGHT). Toujours disponibles : aucune donnée ni calcul
# serveur qui leur soit propre.
GRAPHE_DISPONIBLE = True


# %% =============================================================
# FLASK APP
# ===============================================================
app = Flask(__name__,
            template_folder="templates",
            static_folder="static")


# Identifiant du lancement du serveur : la visite guidée de chaque page s'ouvre une fois par lancement
SERVEUR_DEMARRAGE = str(int(time.time()))


@app.context_processor
def _contexte_pages():
    return {"demarrage": SERVEUR_DEMARRAGE}   # visite_guidee.js (data-demarrage)


@app.route("/")
def page_carte():
    return render_template("carte.html",
                           lignes=LIGNES_DISPONIBLES,
                           lignes_parcours=LIGNES_PARCOURS,
                           types_relations=TYPES_RELATIONS,
                           couleurs=COULEURS_RELATIONS,
                           center_lat=CENTER_LAT,
                           center_lon=CENTER_LON)


@app.route("/graphe")
def page_graphe():
    if not GRAPHE_DISPONIBLE:
        return "Page désactivée en mode allégé (VIZ_LIGHT).", 404
    return render_template("graphe.html",
                           lignes=LIGNES_DISPONIBLES,
                           types_relations=TYPES_RELATIONS,
                           couleurs=COULEURS_RELATIONS)


@app.route("/graphe_calcul")
def page_graphe_calcul():
    if not GRAPHE_DISPONIBLE:
        return "Page désactivée en mode allégé (VIZ_LIGHT).", 404
    return render_template("graphe_calcul.html",
                           types_relations=TYPES_RELATIONS,
                           couleurs=COULEURS_RELATIONS)


@app.route("/consommation")
def page_consommation():
    return render_template("consommation.html",
                           conso_disponible=CONSO_DISPONIBLE)


@app.route("/simulation")
def page_simulation():
    return render_template("simulation.html",
                           simulation_disponible=SIMULATION_DISPONIBLE)


@app.route("/tableau_de_bord")
def page_tableau_de_bord():
    # Tableau de bord temps réel plein écran (sans carte) : n'utilise que /api/rt/vehicules
    return render_template("tableau_de_bord.html", rt_disponible=RT_DISPONIBLE)


# --- API Consommation -------------------------------------------------
@app.route("/api/conso/options")
def api_conso_options():
    return jsonify({**CONSO_OPTIONS, "disponible": CONSO_DISPONIBLE})


@app.route("/api/energie/carte")
def api_energie_carte():
    # Agrégats mensuels pour colorer la carte (section « Prévision énergétique »)
    if not ENERGIE_DISPONIBLE:
        return jsonify({"error": "Prévision énergétique indisponible (lancer pipeline/p06_conso_synthetique.py)."}), 404
    return app.response_class(ENERGIE_JSON, mimetype="application/json")


@app.route("/api/conso/voyages")
def api_conso_voyages():
    parcours = request.args.get("parcours", "")
    df = CONSO_BY_PARCOURS.get(parcours)
    if df is None:
        return jsonify([])
    # Un voyage = une suite de segments ; on agrège pour le sélecteur.
    # min_count=1 -> NaN si aucune énergie ; on écarte ces voyages (inutiles ici).
    g = (df.groupby("voyage_id")
           .agg(mois=("mois", "first"),
                temperature_C=("temperature_C", "first"),
                conso_totale_Wh=(_COL_CONSO, lambda s: s.sum(min_count=1)))
           .reset_index())
    g = g[g["conso_totale_Wh"].notna()].sort_values("voyage_id")
    out = [{
        "voyage_id":       int(r["voyage_id"]),
        "mois":            (int(r["mois"]) if pd.notna(r["mois"]) else None),
        "temperature_C":   _safe(r["temperature_C"], 1),
        "conso_totale_Wh": _safe(r["conso_totale_Wh"], 0),
    } for _, r in g.iterrows()]
    return jsonify(out)


@app.route("/api/conso/profil")
def api_conso_profil():
    if not CONSO_DISPONIBLE:
        return jsonify({"error": "Données de consommation indisponibles."}), 404

    mode = request.args.get("mode", "voyage")
    with_mean = request.args.get("include_mean", "0") == "1"

    if mode == "voyage":
        try:
            vid = int(request.args.get("voyage", ""))
        except ValueError:
            return jsonify({"error": "Paramètre 'voyage' invalide."}), 400
        parcours = VOYAGE_PARCOURS.get(vid)
        if parcours is None:
            return jsonify({"error": f"Voyage {vid} introuvable."}), 404
        df_sel = CONSO_BY_PARCOURS[parcours]
        df_sel = df_sel[df_sel["voyage_id"] == vid]
    else:
        parcours = request.args.get("parcours", "")
        df = CONSO_BY_PARCOURS.get(parcours)
        if df is None:
            return jsonify({"error": f"Parcours '{parcours}' introuvable."}), 404
        if mode == "mois":
            mois_raw = request.args.get("mois", "")
            mois_set = {int(m) for m in mois_raw.split(",") if m.strip().isdigit()}
            if not mois_set:
                return jsonify({"error": "Paramètre 'mois' requis."}), 400
            df_sel = df[df["mois"].isin(mois_set)]
        elif mode == "temp":
            try:
                tmin = float(request.args.get("tmin", "-100"))
                tmax = float(request.args.get("tmax", "100"))
            except ValueError:
                return jsonify({"error": "Bornes de température invalides."}), 400
            df_sel = df[(df["temperature_C"] >= tmin) & (df["temperature_C"] <= tmax)]
        else:
            return jsonify({"error": f"Mode '{mode}' inconnu."}), 400

    if df_sel.empty:
        return jsonify({"meta": {"mode": mode, "parcours": parcours,
                                 "n_observations": 0}, "segments": [], "mean": []})

    segments, mean_payload, n_obs = _conso_profil(df_sel, parcours, with_mean)
    return jsonify({
        "meta": {"mode": mode, "parcours": parcours, "n_observations": n_obs},
        "segments": segments,
        "mean": mean_payload,
    })


# --- API Simulation ---------------------------------------------------
@app.route("/api/simulation/voyage")
def api_simulation_voyage():
    if not SIMULATION_DISPONIBLE:
        return jsonify({"error": "Simulation indisponible (conso ou attributs absents)."}), 404
    try:
        vid = int(request.args.get("voyage", ""))
    except ValueError:
        return jsonify({"error": "Paramètre 'voyage' invalide."}), 400

    parcours = VOYAGE_PARCOURS.get(vid)
    if parcours is None:
        return jsonify({"error": f"Voyage {vid} introuvable."}), 404

    df = CONSO_BY_PARCOURS[parcours]
    df_v = df[df["voyage_id"] == vid].sort_values("ordre")
    if df_v.empty:
        return jsonify({"error": f"Voyage {vid} vide."}), 404

    temperature = float(df_v["temperature_C"].iloc[0])
    charge = float(df_v["charge_passagers"].iloc[0])
    mois = int(df_v["mois"].iloc[0])

    segments_sim = []
    for r in df_v.itertuples(index=False):
        sid = int(r.segment_id)
        seg = {"segment_id": sid, "distance_m": float(r.distance_m)}
        if SIM_ATTRS is not None and sid in SIM_ATTRS.index:
            a = SIM_ATTRS.loc[sid]
            seg.update({
                "vitesse_calc_kmh": a.get("vitesse_calc_kmh"),
                "pente_moy_pct":    a.get("pente_moy_pct"),
                "coef_roulement":   a.get("coef_roulement"),
                "nb_feux":          a.get("nb_feux"),
            })
        segments_sim.append(seg)

    series, bornes = profil_cinematique(
        segments_sim, temperature_C=temperature,
        charge_passagers=charge, seed=vid,
    )

    conso_totale = _safe(df_v[_COL_CONSO].sum(), 0)
    return jsonify({
        "voyage_id": vid,
        "series": series,
        "segments": bornes,
        "meta": {
            "parcours": parcours,
            "mois": mois,
            "temperature_C": _safe(temperature, 1),
            "charge_passagers": _safe(charge, 0),
            "distance_totale_m": _safe(df_v["distance_m"].sum(), 0),
            "conso_totale_Wh": conso_totale,
            "duree_s": int(series[-1][0]) if series else 0,
        },
    })


# --- API Trajet (routage sur le réseau routier réel) ------------------
@app.route("/api/trajet/estimation")
def api_trajet_estimation():
    if not TRAJET_DISPONIBLE:
        return jsonify({"error": "Graphe routier indisponible "
                                 "(lancer pipeline/p08_graphe_routier.py)."}), 404

    brut = request.args.get("points", "")
    points = []
    try:
        for morceau in brut.split(";"):
            if not morceau.strip():
                continue
            lat_s, lon_s = morceau.split(",")
            points.append((float(lat_s), float(lon_s)))
    except ValueError:
        return jsonify({"error": "Paramètre 'points' invalide "
                                 "(attendu : lat,lon;lat,lon;...)."}), 400
    if len(points) < 2:
        return jsonify({"error": "Au moins deux points sont requis."}), 400

    try:
        charge = float(request.args.get("charge", "20"))
    except ValueError:
        charge = 20.0

    # Température : explicite (temp) sinon dérivée du mois, sinon 15 °C
    temperature = None
    if request.args.get("temp") not in (None, ""):
        try:
            temperature = float(request.args.get("temp"))
        except ValueError:
            temperature = None
    if temperature is None:
        try:
            mois = int(request.args.get("mois", "0"))
            temperature = float(TEMP_PAR_MOIS.get(mois, 15.0))
        except ValueError:
            temperature = 15.0

    # Snap de chaque point au nœud routier le plus proche
    noeuds = []
    for lat, lon in points:
        n = GRAPHE_ROUTIER.noeud_le_plus_proche(lat, lon)
        if n is None:
            return jsonify({"error": f"Aucune route à moins de 300 m du point "
                                     f"({lat:.5f}, {lon:.5f})."}), 404
        noeuds.append(n)

    # Drapeaux arrêt/via par point : "stops=1,0,1,..." où 1 = arrêt (limite de
    # tronçon) et 0 = point de tracé « via » interne, qui infléchit l'itinéraire
    # SANS créer de tronçon ni d'arrêt. Absent => tous les points sont des arrêts
    # (compatibilité ascendante). Les premier et dernier points sont des arrêts.
    brut_stops = request.args.get("stops", "")
    if brut_stops.strip():
        stop_flags = [s.strip() == "1" for s in brut_stops.split(",")]
    else:
        stop_flags = [True] * len(points)
    if len(stop_flags) != len(points):
        stop_flags = [True] * len(points)
    stop_flags[0] = True
    stop_flags[-1] = True

    # Dijkstra enchaîné entre points successifs. Un tronçon (leg) va d'un arrêt au
    # suivant : les portions traversant des vias sont accumulées dans le même leg.
    # Le trajet reste une ligne « coupée en segments » par les seuls arrêts.
    chemin_complet = []
    legs = []
    cur_edges = []
    for i, (a, b) in enumerate(zip(noeuds[:-1], noeuds[1:])):
        chemin = GRAPHE_ROUTIER.plus_court_chemin(a, b)
        if chemin is None:
            return jsonify({"error": "Aucun chemin routier entre deux jalons "
                                     "(réseau non connexe à cet endroit)."}), 404
        chemin_complet.extend(chemin)
        cur_edges.extend(chemin)
        # b == point d'indice i+1 : on ferme le tronçon si ce point est un arrêt.
        if stop_flags[i + 1]:
            est_leg = GRAPHE_ROUTIER.estimation_trajet(
                cur_edges, charge_passagers=charge, temperature_C=temperature)
            legs.append({
                "coords":         GRAPHE_ROUTIER.coords_chemin(cur_edges),
                "distance_m":     est_leg["distance_m"],
                "temps_estime_s": est_leg["temps_estime_s"],
                "energie":        est_leg["energie"],
                "n_aretes":       len(cur_edges),
                # Attributs physiques agrégés du tronçon (dénivelé, feux, vitesse
                # max, pente…), au format des vrais segments : permet de cliquer
                # un tronçon d'une ligne créée et d'en voir la fiche complète.
                "attributs":      GRAPHE_ROUTIER.attributs_chemin(cur_edges),
            })
            cur_edges = []

    estimation = GRAPHE_ROUTIER.estimation_trajet(
        chemin_complet, charge_passagers=charge, temperature_C=temperature)
    return jsonify({
        **estimation,
        "coords": GRAPHE_ROUTIER.coords_chemin(chemin_complet),
        "legs": legs,
        "n_aretes": len(chemin_complet),
        "temperature_C": _safe(temperature, 1),
        "charge_passagers": _safe(charge, 0),
    })


# --- Relief et géobase (couches carte) --------------------------------
@app.route("/api/relief")
def api_relief():
    if not RELIEF_DISPONIBLE:
        return jsonify({"error": "Relief indisponible "
                                 "(lancer pipeline/p07_relief_overlay.py)."}), 404
    import json as _json
    with open(PATH_RELIEF_BOUNDS, "r", encoding="utf-8") as f:
        bounds = _json.load(f)["bounds"]
    return jsonify({"url": "/relief/altitude_overlay.png", "bounds": bounds})


@app.route("/relief/<path:fichier>")
def relief_fichier(fichier):
    return send_from_directory(DIR_RELIEF, fichier)


def _construire_reseau_routier_json():
    """Chaîne JSON {"lignes": [...]} du réseau routable : arêtes du graphe p08
    en polylignes [lat, lon], dédupliquées par paire de nœuds (aller/retour)."""
    aretes = GRAPHE_ROUTIER.aretes
    na = aretes["node_a"].to_list()
    nb = aretes["node_b"].to_list()
    coords_col = aretes["coords"].to_list()
    vus = set()
    lignes = []
    for i in range(len(coords_col)):
        a, b = int(na[i]), int(nb[i])
        cle = (a, b) if a <= b else (b, a)
        if cle in vus:
            continue
        vus.add(cle)
        pts = coords_col[i]
        if isinstance(pts, str):
            pts = json.loads(pts)
        lignes.append([[float(p[0]), float(p[1])] for p in pts])
    return json.dumps({"lignes": lignes}, separators=(",", ":"))


@app.route("/api/reseau_routier")
def api_reseau_routier():
    """Réseau routier ROUTABLE = exactement le réseau sur lequel les trajets
    sont tracés. En mode statique : pré-décompressé au démarrage ; sinon
    construit 1× à la demande et mis en cache (chaîne JSON, servie telle
    quelle — jamais de Content-Encoding manuel, fragile derrière un proxy PaaS)."""
    global _RESEAU_ROUTIER_CACHE
    if _RESEAU_ROUTIER_CACHE is None:
        if not TRAJET_DISPONIBLE:
            return jsonify({"error": "Graphe routier indisponible "
                                     "(lancer pipeline/p08_graphe_routier.py)."}), 404
        _RESEAU_ROUTIER_CACHE = _construire_reseau_routier_json()
    return app.response_class(_RESEAU_ROUTIER_CACHE, mimetype="application/json")


# --- Temps réel GTFS-RT (positions des bus STM) ------------------------
# Proxy avec cache partagé, calé sur les versions du flux : la STM publie une
# nouvelle version à intervalle régulier (~20 s, horodatée dans l'en-tête).
# Le serveur apprend ce rythme (période médiane entre versions, délai minimal
# entre l'horodatage et la mise en ligne) et n'appelle la STM qu'à l'échéance
# de la prochaine version, puis toutes les RT_APPEL_MIN_S secondes tant qu'elle
# n'est pas là. Chaque réponse indique à la page quand revenir (`prochain_ms`) :
# la carte s'actualise dans les ~2 s qui suivent la publication, quel que soit
# le nombre de visiteurs (un seul appel STM partagé). Pas de connexion tenue
# ouverte (long-polling) : le serveur de démo n'a qu'un worker synchrone.
# Si l'appel échoue, on ressert la dernière réponse connue (marquée « perime »)
# tant qu'elle a moins de RT_PERIME_MAX_S secondes.
RT_DISPONIBLE = _GTFS_RT_IMPORT_OK and bool(STM_API_KEY)
RT_CACHE_S = 10          # sans horodatage de version : rappel toutes les 10 s
RT_APPEL_MIN_S = 2       # attente d'une version en retard : un appel STM toutes les 2 s au plus
RT_RETARD_LONG_S = 30    # version en retard de plus de 30 s (flux figé) : appels espacés…
RT_APPEL_LENT_S = 10     # … à 10 s
RT_CACHE_MAX_S = 30      # rappel de sécurité même si aucune version n'est attendue
RT_PERIODE_DEFAUT_S = 20
RT_PERIME_MAX_S = 300
RT_CHAMPS = ["vehicule_id", "route_id", "trip_id", "direction", "lat", "lon", "cap",
             "vitesse_kmh", "stop_id", "statut_arret", "occupation", "t_position",
             "ecart_trace_m", "depassement_min", "detour", "detour_statut"]
RT_ANNULATIONS_CACHE_S = 60      # tripUpdates pèse ~2 Mo : annulations rafraîchies à la minute
RT_VUS_MEMOIRE_S = 6 * 3600      # trajets vus dans le flux, retenus 6 h (un bus qui finit
                                 # en avance et enchaîne son trajet suivant reste « livré »)
RT_DEPASSEMENT_SEUIL_S = 300     # bus signalé au-delà de 5 min après la fin prévue de son trajet
PATH_REF_RT = DIR_PAYLOADS / "referentiel_rt.json.gz"
# Projection locale équirectangulaire (m), identique à scripts/exporter_referentiel_rt.py
_RT_KX = 111_320 * np.cos(np.radians(45.5))
_RT_KY = 110_950


def _charger_referentiel_rt():
    """
    Référentiel du GTFS EN VIGUEUR (scripts/exporter_referentiel_rt.py) :
    trip_id -> (tracé, direction_id) et tracés en mètres. C'est lui qui donne la
    direction fiable d'un bus (le direction_id du flux contredit le GTFS pour
    ~30 % des trajets) et l'écart au tracé de SON trajet (détours).
    """
    if not PATH_REF_RT.exists():
        print(f"  ⚠ {PATH_REF_RT.name} absent — direction et détours non calculés "
              "(lancer scripts/exporter_referentiel_rt.py)")
        return None
    with gzip.open(PATH_REF_RT, "rt", encoding="utf-8") as f:
        ref = json.load(f)
    traces = []
    for pts in ref["traces"]:
        xy = np.asarray(pts, dtype=float)[:, ::-1] * (_RT_KX, _RT_KY)   # [lat, lon] -> [x, y] m
        a = xy[:-1]
        d = xy[1:] - a
        traces.append((a, d, np.maximum((d * d).sum(axis=1), 1e-9)))
    lignes = ref["trips"]
    directions = {tuple(k.split("|")): v for k, v in ref["directions"].items()}
    out = {
        "version": ref.get("version"), "valide_au": ref.get("valide_au"),
        "index": {r[0]: i for i, r in enumerate(lignes)},          # trip_id -> rang
        "trace": np.array([r[1] for r in lignes], dtype=np.int32),
        "dir": np.array([r[2] for r in lignes], dtype=np.int8),
        "traces": traces,
        "directions": directions,
        "service": None,
        "regularite": None,
    }
    # Horaire minimal (tableau de bord : service prévu vs réel), absent des
    # référentiels antérieurs à son ajout.
    if lignes and len(lignes[0]) >= 8:
        out["service"] = ServicePrevu(out["index"], lignes, ref["services"], ref["calendrier"],
                                      ref["exceptions"], ref["destinations"], directions)
        # Bus bunching / gaps de service : tracés principaux + intervalles prévus
        out["regularite"] = Regularite(out["service"], out["trace"], traces, _RT_KX, _RT_KY)
    print(f"  Référentiel temps réel : GTFS {out['version']} (valide au {out['valide_au']}), "
          f"{len(lignes):,} trajets, {len(traces)} tracés"
          + ("" if out["service"] else " — sans horaire (régénérer pour le tableau de bord)"))
    return out


def _ecart_trace_m(trace, lat, lon):
    """Distance (m) du point au tracé : minimum sur les tronçons du tracé."""
    a, d, l2 = trace
    x, y = lon * _RT_KX, lat * _RT_KY
    t = np.clip(((x - a[:, 0]) * d[:, 0] + (y - a[:, 1]) * d[:, 1]) / l2, 0.0, 1.0)
    return float(np.min(np.hypot(a[:, 0] + t * d[:, 0] - x, a[:, 1] + t * d[:, 1] - y)))


RT_REF = _charger_referentiel_rt() if RT_DISPONIBLE else None
_rt_cache = {"t": 0.0, "json": None, "t_ok": 0.0}
_rt_verrou = threading.Lock()
_rt_annulations = {"t": 0.0, "t_ok": 0.0, "trips": set()}
_rt_vus = {}   # trip_id -> dernier instant où un véhicule le portait
_rt_flux = None   # dernier flux décodé (t_collecte, t_flux, lignes) : réponse reconstruite après une action
# Rythme de publication : dernière version, périodes entre versions, délais de mise en ligne
_rt_versions = {"t_flux": None, "periodes": deque(maxlen=15), "delais": deque(maxlen=15)}
# Détours observés : tracé estimé sur le réseau routier routable (p08), validé
# quand au moins 2 bus l'empruntent (serveur/detours.py)
RT_DETOURS = (SuiviDetours(GRAPHE_ROUTIER, RT_REF["traces"], _RT_KX, _RT_KY)
              if RT_REF and GRAPHE_ROUTIER is not None else None)
print("Temps réel GTFS-RT : " + (
    "actif (proxy /api/rt/vehicules)" if RT_DISPONIBLE else
    "désactivé (STM_API_KEY non définie)" if _GTFS_RT_IMPORT_OK else
    "désactivé (pip install gtfs-realtime-bindings)"))


def _rt_trips_annules(t):
    """Trajets annulés (tripUpdates), rafraîchis à la minute. Renvoie (ensemble, à_jour)."""
    if t - _rt_annulations["t"] >= RT_ANNULATIONS_CACHE_S:
        _rt_annulations["t"] = t
        contenu, http, duree_ms = gtfs_rt.telecharger_flux("trip_updates", STM_API_KEY)
        try:
            if contenu is None:
                raise ValueError(f"HTTP {http}")
            _rt_annulations["trips"] = gtfs_rt.decoder_annulations(contenu)
            _rt_annulations["t_ok"] = t
        except Exception as e:
            print(f"  ⚠ GTFS-RT tripUpdates (annulations) : {e} ({duree_ms} ms)")
    a_jour = t - _rt_annulations["t_ok"] <= 3 * RT_ANNULATIONS_CACHE_S
    return _rt_annulations["trips"], a_jour


def _rt_rafraichir():
    """Interroge la STM et renvoie la chaîne JSON compacte, ou None si échec."""
    t_collecte = int(time.time())
    contenu, http, duree_ms = gtfs_rt.telecharger_flux("positions", STM_API_KEY)
    if contenu is None:
        print(f"  ⚠ GTFS-RT positions : HTTP {http} ({duree_ms} ms)")
        return None
    try:
        t_flux, lignes = gtfs_rt.decoder_positions(contenu, t_collecte)
    except Exception as e:   # flux corrompu : traité comme une panne
        print(f"  ⚠ GTFS-RT positions illisible : {e}")
        return None
    global _rt_flux
    _rt_flux = (t_collecte, t_flux, lignes)
    _rt_noter_version(t_flux, time.time())
    return _rt_construire(t_collecte, t_flux, lignes)


def _rt_noter_version(t_flux, t_vu):
    """Nouvelle version du flux (horodatage `t_flux`) vue à `t_vu` : période et délai de mise en ligne."""
    v = _rt_versions
    if not t_flux or t_flux == v["t_flux"]:
        return
    if v["t_flux"] is not None and 0 < t_flux - v["t_flux"] <= 120:
        v["periodes"].append(t_flux - v["t_flux"])
    v["delais"].append(t_vu - t_flux)   # peut être négatif (horloges STM / serveur décalées)
    v["t_flux"] = t_flux


def _rt_prochaine_version():
    """Instant (horloge du serveur) où la prochaine version devrait être en ligne, ou None.
    Le délai retenu est le plus court observé : c'est la version vue au plus près de sa
    mise en ligne (les autres ont été vues en retard, faute d'appel au bon moment)."""
    v = _rt_versions
    if not v["t_flux"]:
        return None
    periode = float(np.median(v["periodes"])) if v["periodes"] else RT_PERIODE_DEFAUT_S
    delai = min(v["delais"]) if v["delais"] else 0.0
    return v["t_flux"] + min(max(periode, 5.0), 60.0) + min(max(delai, -30.0), 30.0)


def _rt_intervalle(maintenant):
    """(appel STM dû maintenant ?, secondes avant le prochain passage conseillé à la page)."""
    depuis = maintenant - _rt_cache["t"]
    prochaine = _rt_prochaine_version()
    if prochaine is None:                          # pas d'horodatage : rythme fixe
        return depuis >= RT_CACHE_S, max(RT_CACHE_S - depuis, 1.0)
    if maintenant < prochaine:                     # version en cours encore valable
        return depuis >= RT_CACHE_MAX_S, prochaine - maintenant + 0.3
    pas = RT_APPEL_MIN_S if maintenant - prochaine < RT_RETARD_LONG_S else RT_APPEL_LENT_S
    return depuis >= pas, max(pas - depuis, 0.0) + 0.2


def _hhmm_service(s):
    """Heure GTFS (secondes depuis minuit du jour de service, parfois > 24 h) -> « HH:MM »."""
    s = int(s)
    return f"{s // 3600 % 24:02d}:{s // 60 % 60:02d}"


def _rt_construire(t_collecte, t_flux, lignes):
    """Réponse JSON compacte de /api/rt/vehicules pour un flux décodé."""
    sp = RT_REF["service"] if RT_REF else None
    vehicules = []
    bus_regularite = []   # bus rattachés à un trajet connu : ordonnés par ligne/direction
    bus_detours = []      # mêmes bus, pour le suivi des sorties de tracé
    inconnus = 0
    for l in lignes:
        if l["trip_id"]:
            _rt_vus[l["trip_id"]] = t_collecte
        if l["lat"] is None or l["lon"] is None:
            continue
        vit = l["vitesse_ms"]
        direction = ecart = depassement = None
        i = RT_REF["index"].get(l["trip_id"]) if RT_REF else None
        if i is not None:
            direction = RT_REF["directions"].get((l["route_id"], str(int(RT_REF["dir"][i]))))
            ecart = round(_ecart_trace_m(RT_REF["traces"][RT_REF["trace"][i]], l["lat"], l["lon"]))
            if sp is not None:
                d = sp.depassement_s(i, l["start_date"], t_collecte)
                if d is not None and d > RT_DEPASSEMENT_SEUIL_S:
                    depassement = round(d / 60)
            bus_regularite.append({"id": l["vehicule_id"], "route": l["route_id"],
                                   "dir_id": int(RT_REF["dir"][i]), "direction": direction,
                                   "lat": l["lat"], "lon": l["lon"]})
            bus_detours.append({"id": l["vehicule_id"], "trip": l["trip_id"], "k": int(RT_REF["trace"][i]),
                                "route": l["route_id"], "dir_id": int(RT_REF["dir"][i]),
                                "direction": direction, "lat": l["lat"], "lon": l["lon"],
                                "ecart": ecart, "t_position": l["t_position"],
                                "trip_debut": _hhmm_service(sp.debut[i]) if sp is not None else None})
        elif RT_REF:
            inconnus += 1
        vehicules.append([
            l["vehicule_id"], l["route_id"], l["trip_id"], direction,
            round(l["lat"], 5), round(l["lon"], 5),
            None if l["cap"] is None else round(l["cap"]),
            None if vit is None else round(vit * 3.6, 1),
            l["stop_id"], l["statut_arret"], l["occupation"], l["t_position"], ecart, depassement,
            None, None,   # détour (id, statut) : complétés ci-dessous
        ])
    for trip in [k for k, v in _rt_vus.items() if t_collecte - v > RT_VUS_MEMOIRE_S]:
        del _rt_vus[trip]

    referentiel = service = None
    if RT_REF:
        referentiel = {"version": RT_REF["version"], "valide_au": RT_REF["valide_au"],
                       "trajets_inconnus": inconnus}
    if sp is not None:
        annules, annulations_ok = _rt_trips_annules(t_collecte)
        service = sp.bilan(t_collecte, _rt_vus, annules)
        service["annulations_ok"] = annulations_ok
    detours = sourdines = ponctuels = None
    if RT_DETOURS is not None:
        try:
            detours, statut_bus = RT_DETOURS.mettre_a_jour(t_collecte, bus_detours)
            sourdines = RT_DETOURS.etat_sourdines(t_collecte)
            ponctuels = RT_DETOURS.etat_ponctuels()
            for v in vehicules:
                if v[0] in statut_bus:
                    v[-2], v[-1] = statut_bus[v[0]]
        except Exception as e:   # le suivi des détours ne doit jamais couper le flux
            print(f"  ⚠ Suivi des détours : {e!r}")
    regularite = None
    if RT_REF and RT_REF["regularite"] is not None:
        # Les détours validés remplacent la portion du tracé qu'ils contournent :
        # leurs bus sont placés et gaps de service et bus bunching suivent le parcours réel.
        regularite = RT_REF["regularite"].analyser(t_collecte, bus_regularite,
                                                    [d for d in (detours or []) if d["valide"]])
    return json.dumps({"t_flux": t_flux, "t_collecte": t_collecte, "champs": RT_CHAMPS,
                       "referentiel": referentiel, "service": service, "regularite": regularite,
                       "detours": detours, "detours_sourdines": sourdines, "detours_ponctuels": ponctuels,
                       "vehicules": vehicules},
                      separators=(",", ":"), ensure_ascii=False)


@app.route("/api/rt/vehicules")
def api_rt_vehicules():
    if not RT_DISPONIBLE:
        return jsonify({"error": "Temps réel indisponible (STM_API_KEY non définie "
                                 "ou gtfs-realtime-bindings absent)."}), 404
    maintenant = time.time()
    with _rt_verrou:   # une seule requête vers la STM à la fois, même sous charge
        if _rt_intervalle(maintenant)[0]:
            _rt_cache["t"] = maintenant
            frais = _rt_rafraichir()
            if frais is not None:
                _rt_cache["json"], _rt_cache["t_ok"] = frais, maintenant
        texte, age_ok = _rt_cache["json"], maintenant - _rt_cache["t_ok"]
        attente = _rt_intervalle(time.time())[1]
    if texte is None or age_ok > RT_PERIME_MAX_S:
        return jsonify({"error": "Flux GTFS-RT STM injoignable pour l'instant."}), 503
    # Quand revenir : juste après la publication attendue de la prochaine version
    suite = f',"prochain_ms":{round(attente * 1000)}'
    if age_ok > RT_CACHE_MAX_S + RT_APPEL_LENT_S:
        suite += ',"perime":true'
    return app.response_class(texte[:-1] + suite + "}", mimetype="application/json")


# --- Détours : actions manuelles (clic droit sur un tracé de la carte) ------
# État partagé (serveur) : la carte et le tableau de bord voient la même chose.
# Après l'action, la réponse temps réel est reconstruite sur le dernier flux
# reçu (sans rappeler la STM) : les pages voient le changement tout de suite.
def _rt_action(action):
    if RT_DETOURS is None:
        return jsonify({"error": "Suivi des détours indisponible (référentiel temps réel ou graphe routier absent)."}), 404
    if not DETOURS_ACTIONS:   # démo publique : l'état est partagé par tous les visiteurs
        return jsonify({"error": "Actions sur les détours désactivées sur cette démo (lecture seule). "
                                 "Elles sont disponibles en local."}), 403
    corps = request.get_json(silent=True)
    if corps is None:   # navigator.sendBeacon : corps texte
        try:
            corps = json.loads(request.get_data(as_text=True) or "{}")
        except ValueError:
            corps = {}
    with _rt_verrou:
        try:
            resultat = action(corps, int(time.time()))
        except (KeyError, ValueError, TypeError) as e:
            return jsonify({"error": str(e.args[0]) if e.args else str(e)}), 400
        if _rt_flux is not None:
            _rt_cache["json"] = _rt_construire(*_rt_flux)
    return jsonify({"ok": True, **(resultat or {})})


def _dir_id(route, direction):
    """direction_id GTFS d'une ligne à partir de son libellé (« Est »…)."""
    for (r, di), lib in RT_REF["directions"].items():
        if r == str(route) and lib == direction:
            return int(di)
    raise ValueError(f"Direction « {direction} » inconnue pour la ligne {route}.")


@app.route("/api/rt/detours/valider", methods=["POST"])
def api_rt_detour_valider():
    return _rt_action(lambda c, t: {"id": RT_DETOURS.valider(c["id"], t)})


@app.route("/api/rt/detours/supprimer", methods=["POST"])
def api_rt_detour_supprimer():
    return _rt_action(lambda c, t: RT_DETOURS.supprimer(c["id"], t, minutes=c.get("minutes"), session=c.get("session")))


@app.route("/api/rt/detours/apercu", methods=["POST"])
def api_rt_detour_apercu():
    return _rt_action(lambda c, t: RT_DETOURS.apercu(c["points"]))


@app.route("/api/rt/detours/tracer", methods=["POST"])
def api_rt_detour_tracer():
    def tracer(c, t):
        route = str(c["route"])
        return {"id": RT_DETOURS.tracer(route, _dir_id(route, c["direction"]), c["direction"],
                                        c["points"], t, remplace=c.get("remplace"))}
    return _rt_action(tracer)


@app.route("/api/rt/detours/ponctuel/<ident>")
def api_rt_detour_ponctuel(ident):
    # Détour 1 bus archivé : trace GPS, tracé estimé et portion normale contournée (clic dans l'historique)
    if RT_DETOURS is None:
        return jsonify({"error": "Suivi des détours indisponible."}), 404
    with _rt_verrou:
        try:
            return jsonify(RT_DETOURS.ponctuel(ident))
        except KeyError as e:
            return jsonify({"error": e.args[0]}), 404


@app.route("/api/rt/detours/sourdines/lever", methods=["POST"])
def api_rt_detour_lever_sourdine():
    # {route, dir_id} : une sourdine ; {session} : celles d'une page fermée ou rechargée (sendBeacon)
    return _rt_action(lambda c, t: RT_DETOURS.lever_sourdine(
        route=c.get("route"), dir_id=c.get("dir_id"), session=c.get("session")))


@app.route("/api/rt/trace")
def api_rt_trace():
    """Tracé GTFS (en vigueur) du trajet en cours d'un bus. `trace_id` permet au
    client de ne dessiner qu'une fois un tracé partagé par plusieurs bus."""
    if not RT_REF:
        return jsonify({"error": "Référentiel temps réel absent "
                                 "(lancer scripts/exporter_referentiel_rt.py)."}), 404
    i = RT_REF["index"].get(request.args.get("trip", ""))
    if i is None:
        return jsonify({"error": "Trajet absent du référentiel GTFS "
                                 "(nouveau GTFS publié ?)."}), 404
    i_trace = int(RT_REF["trace"][i])
    a, d, _ = RT_REF["traces"][i_trace]
    xy = np.vstack([a, a[-1] + d[-1]])            # sommets du tracé, en mètres
    coords = np.round(np.c_[xy[:, 1] / _RT_KY, xy[:, 0] / _RT_KX], 5).tolist()   # [lat, lon]
    return jsonify({"trace_id": i_trace, "coords": coords})


# --- API génériques ----------------------------------------------------
# Chaînes JSON pré-sérialisées au démarrage (mode statique : décompressées
# depuis les .json.gz pré-calculés ; sinon compactées depuis les objets
# Python, cf. COMPACTION MÉMOIRE) : les routes les servent telles quelles.
@app.route("/api/segments")
def api_segments():
    ds = _dataset(request.args.get("mode", "normal"))
    return app.response_class(ds["segments_json"], mimetype="application/json")


@app.route("/api/relations")
def api_relations():
    ds = _dataset(request.args.get("mode", "normal"))
    return app.response_class(ds["relations_json"], mimetype="application/json")


@app.route("/api/stops")
def api_stops():
    return app.response_class(STOPS_JSON, mimetype="application/json")


@app.route("/api/liaison")
def api_liaison():
    # Dictionnaire de liaison : seulement pertinent en mode fusion.
    if request.args.get("mode", "normal") == "fusion":
        return jsonify(LIAISON_PAYLOAD)
    return jsonify({})


@app.route("/api/meta")
def api_meta():
    mode = request.args.get("mode", "normal")
    ds = _dataset(mode)
    return jsonify({
        "lignes": LIGNES_DISPONIBLES,
        "lignes_parcours": LIGNES_PARCOURS,
        "types_relations": TYPES_RELATIONS,
        "couleurs": COULEURS_RELATIONS,
        "center": ds["center"],
        "mode": mode if mode in DATASETS else "normal",
        "modes_disponibles": MODES_DISPONIBLES,
        "fusion_disponible": FUSION_DISPONIBLE,
        "graphe_disponible": GRAPHE_DISPONIBLE,
        "conso_disponible": CONSO_DISPONIBLE,
        "energie_disponible": ENERGIE_DISPONIBLE,
        "simulation_disponible": SIMULATION_DISPONIBLE,
        "trajet_disponible": TRAJET_DISPONIBLE,
        "relief_disponible": RELIEF_DISPONIBLE,
        "rt_disponible": RT_DISPONIBLE,
        "detours_actions": DETOURS_ACTIONS,
        "n_segments": ds["n_segments"],
        "n_relations": ds["n_relations"],
        "n_stops": N_STOPS,
    })


# %% =============================================================
# MAIN
# ===============================================================
if __name__ == "__main__":
    print("\n=== Serveur prêt ===")
    print(f"  Carte        : http://{HOTE}:{PORT}/")
    print(f"  Graphe       : http://{HOTE}:{PORT}/graphe")
    print(f"  Graphe calc. : http://{HOTE}:{PORT}/graphe_calcul")
    print(f"  Consommation : http://{HOTE}:{PORT}/consommation")
    print(f"  Simulation   : http://{HOTE}:{PORT}/simulation")
    print(f"  Modes disponibles : {MODES_DISPONIBLES}\n")
    app.run(host=HOTE, port=PORT, debug=False)
