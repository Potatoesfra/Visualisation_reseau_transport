# -*- coding: utf-8 -*-
"""
p06_conso_synthetique.py
========================
Étape 6 du pipeline : génération d'une consommation d'énergie SYNTHÉTIQUE par
segment, à partir du modèle physique road-load et de voyages échantillonnés
dans le GTFS. Aucune donnée mesurée : tout est simulé et reproductible
(graine aléatoire fixe).

Principe
--------
1. Les voyages GTFS (trips) de chaque parcours (route_id + direction) sont
   regroupés par variante (séquence exacte d'arrêts) ; on conserve les
   variantes couvrant >= SEUIL_COUVERTURE_VARIANTES des départs.
2. Pour chaque parcours × mois (1..12), on tire N_VOYAGES_PAR_MOIS départs à
   des heures variées (pointe AM / journée / pointe PM / soir).
3. Chaque paire d'arrêts consécutifs du voyage est associée à son segment
   (segments.gpkg) ; l'énergie de traction vient du modèle road-load
   (attributs_segments.parquet + charge passagers), le chauffage/clim de la
   température du mois (normales climatiques ECCC).

Schéma de sortie (1 ligne = 1 segment d'un voyage synthétique)
--------------------------------------------------------------
  voyage_id            int    identifiant du voyage synthétique
  parcours_type        str    "{route_id}-{direction_id}"
  route_id             str
  segment_id           int    identifiant du segment (jeu "normal")
  ordre                int    position du segment le long du voyage (0..n)
  arret_debut_code     int    stop_code GTFS de l'arrêt de départ
  arret_fin_code       int    stop_code GTFS de l'arrêt d'arrivée
  distance_m           float  longueur du segment
  mois                 int    1..12
  temperature_C        float  température simulée du voyage
  charge_passagers     float  passagers à bord (constant le long du voyage)
  temps_parcours_s     float  temps de parcours du segment (horaire GTFS bruité)
  vitesse_moy_kmh      float  vitesse moyenne déduite
  conso_traction_Wh    float  traction nette (modèle road-load, bruitée)
  conso_chauffage_Wh   float  auxiliaires (chauffage élec. / clim / base)
  conso_totale_Wh      float  traction + auxiliaires

Entrées : data_derivee/{segments.gpkg, attributs_segments.parquet, liaison_fusion.parquet}
          data_brute/gtfs_stm/{trips,stop_times,stops}.txt
          data_brute/normales_climatiques_montreal.csv
Sorties : data_derivee/conso_synthetique_segments.parquet
          data_derivee/conso_synthetique_segments_merge_identiques.parquet
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import geopandas as gpd
from tqdm import tqdm

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import GTFS_DIR, DATA_BRUTE, DATA_DERIVEE  # noqa: E402
from serveur.modele_physique import (  # noqa: E402
    energie_segment_wh, puissance_auxiliaire_kw,
)

# --- Paramètres de génération ---
N_VOYAGES_PAR_MOIS = 3           # voyages synthétiques par parcours et par mois
SEUIL_COUVERTURE_VARIANTES = 0.90  # variantes conservées (part cumulée des départs)
GRAINE = 42                      # reproductibilité
BRUIT_TEMPS_SIGMA = 0.08         # bruit lognormal sur les temps GTFS
BRUIT_VOYAGE_SIGMA = 0.08        # facteur conduite/véhicule (constant par voyage)
BRUIT_SEGMENT_SIGMA = 0.12      # variabilité segment à segment
CHARGE_MAX = 60.0                # capacité passagers

PATH_SORTIE = DATA_DERIVEE / "conso_synthetique_segments.parquet"
PATH_SORTIE_FUSION = DATA_DERIVEE / "conso_synthetique_segments_merge_identiques.parquet"

rng = np.random.default_rng(GRAINE)


def parse_hhmmss(s):
    """'HH:MM:SS' GTFS (heures > 24 permises) -> secondes depuis minuit."""
    try:
        h, m, sec = str(s).strip().split(":")
        return int(h) * 3600 + int(m) * 60 + int(sec)
    except (ValueError, AttributeError):
        return np.nan


def periode_depart(sec_minuit):
    """Période de la journée d'un départ (stratification de l'échantillonnage)."""
    h = (sec_minuit / 3600.0) % 24
    if 6 <= h < 9:
        return "pointe_am"
    if 9 <= h < 15:
        return "journee"
    if 15 <= h < 18:
        return "pointe_pm"
    return "soir"


def tirer_charge(periode):
    """Charge passagers (gamma tronquée) selon la période du départ."""
    moyenne = 25.0 if periode in ("pointe_am", "pointe_pm") else 10.0
    charge = rng.gamma(shape=2.0, scale=moyenne / 2.0)
    return float(np.clip(round(charge), 0, CHARGE_MAX))


# %% =============================================================
# 1. CHARGEMENT
# ===============================================================
print("=== Génération de la consommation synthétique ===")

print("1. Segments et attributs…")
segments = gpd.read_file(DATA_DERIVEE / "segments.gpkg").reset_index(drop=True)
segments["segment_id"] = segments.index.astype(int)
segments["route_id"] = segments["route_id"].astype(str)

attrs = pd.read_parquet(DATA_DERIVEE / "attributs_segments.parquet")
attrs = attrs.set_index("segment_id")

# Index (route_id, start_code, end_code) -> segment_id
seg_index = {}
for r in segments.itertuples(index=False):
    seg_index[(r.route_id, int(r.start_stop_code), int(r.end_stop_code))] = int(r.segment_id)
print(f"   {len(segments)} segments | {len(attrs)} lignes d'attributs")

print("2. GTFS…")
trips = pd.read_csv(GTFS_DIR / "trips.txt",
                    usecols=["trip_id", "route_id", "direction_id"],
                    dtype={"route_id": str})
routes_segments = set(segments["route_id"])
trips = trips[trips["route_id"].isin(routes_segments)]

stop_times = pd.read_csv(
    GTFS_DIR / "stop_times.txt",
    usecols=["trip_id", "arrival_time", "departure_time", "stop_id", "stop_sequence"],
    dtype={"stop_id": str},
)
stop_times = stop_times[stop_times["trip_id"].isin(set(trips["trip_id"]))]

stops = pd.read_csv(GTFS_DIR / "stops.txt", usecols=["stop_id", "stop_code"],
                    dtype={"stop_id": str})
stops["stop_code"] = pd.to_numeric(stops["stop_code"], errors="coerce")
stop_times = stop_times.merge(stops, on="stop_id", how="left")
stop_times = stop_times.dropna(subset=["stop_code"])
stop_times["stop_code"] = stop_times["stop_code"].astype(int)
stop_times = stop_times.sort_values(["trip_id", "stop_sequence"])
print(f"   {trips['trip_id'].nunique():,} trips bus | {len(stop_times):,} arrêts desservis")

print("3. Normales climatiques…")
normales = pd.read_csv(DATA_BRUTE / "normales_climatiques_montreal.csv", comment="#")
normales = normales.set_index("mois")

print("4. Liaison fusion…")
liaison_fusion = pd.read_parquet(DATA_DERIVEE / "liaison_fusion.parquet")
merged_par_segment = dict(zip(liaison_fusion["segment_id_origine"].astype(int),
                              liaison_fusion["merged_id"].astype(int)))


# %% =============================================================
# 2. PARCOURS, VARIANTES ET ÉCHANTILLONNAGE DES VOYAGES
# ===============================================================
print("\n5. Regroupement des trips par parcours et variante…")

# Signature de variante = séquence exacte des stop_codes du trip
signatures = (stop_times.groupby("trip_id")["stop_code"]
              .agg(lambda s: ",".join(map(str, s))))
premier_depart = stop_times.groupby("trip_id")["departure_time"].first()

trips = trips.merge(signatures.rename("signature"), left_on="trip_id", right_index=True)
trips = trips.merge(premier_depart.rename("heure_depart"), left_on="trip_id", right_index=True)
trips["depart_s"] = trips["heure_depart"].map(parse_hhmmss)
trips = trips.dropna(subset=["depart_s"])
trips["periode"] = trips["depart_s"].map(periode_depart)
trips["parcours_type"] = trips["route_id"] + "-" + trips["direction_id"].astype(int).astype(str)

# Variantes couvrant >= SEUIL_COUVERTURE_VARIANTES des départs de chaque parcours
trips_retenus = []
for parcours, grp in trips.groupby("parcours_type"):
    freq = grp["signature"].value_counts(normalize=True)
    couverture = freq.cumsum()
    variantes_ok = set(couverture[couverture <= SEUIL_COUVERTURE_VARIANTES].index)
    if not variantes_ok:  # au moins la variante majoritaire
        variantes_ok = {freq.index[0]}
    else:
        # inclure la première variante qui fait franchir le seuil
        restantes = [s for s in couverture.index if s not in variantes_ok]
        if restantes:
            variantes_ok.add(restantes[0])
    trips_retenus.append(grp[grp["signature"].isin(variantes_ok)])

trips_retenus = pd.concat(trips_retenus, ignore_index=True)
print(f"   {trips_retenus['parcours_type'].nunique()} parcours | "
      f"{len(trips_retenus):,}/{len(trips):,} trips retenus (variantes majeures)")

# Table des arrêts par trip (pour dérouler les segments des voyages tirés)
stop_times_retenus = stop_times[stop_times["trip_id"].isin(set(trips_retenus["trip_id"]))]
arrets_par_trip = {tid: grp for tid, grp in stop_times_retenus.groupby("trip_id")}


# %% =============================================================
# 3. GÉNÉRATION DES VOYAGES SYNTHÉTIQUES
# ===============================================================
print("\n6. Génération des voyages synthétiques…")

ORDRE_PERIODES = ["pointe_am", "journee", "pointe_pm", "soir"]
lignes = []
voyage_id = 0
paires_absentes = 0
paires_totales = 0

parcours_groupes = dict(list(trips_retenus.groupby("parcours_type")))

for parcours in tqdm(sorted(parcours_groupes), desc="Parcours"):
    grp = parcours_groupes[parcours]
    route_id = grp["route_id"].iloc[0]
    par_periode = {p: g for p, g in grp.groupby("periode")}

    for mois in range(1, 13):
        t_moy = float(normales.at[mois, "temp_moy_C"])
        sigma_t = (float(normales.at[mois, "temp_max_C"])
                   - float(normales.at[mois, "temp_min_C"])) / 4.0

        # Tirage stratifié : une période différente pour chaque voyage du mois
        for k in range(N_VOYAGES_PAR_MOIS):
            periode = ORDRE_PERIODES[k % len(ORDRE_PERIODES)]
            pool = par_periode.get(periode, grp)
            trip = pool.iloc[int(rng.integers(len(pool)))]

            arrets = arrets_par_trip.get(trip["trip_id"])
            if arrets is None or len(arrets) < 2:
                continue

            temperature = round(t_moy + float(rng.normal(0.0, sigma_t)), 1)
            charge = tirer_charge(periode)
            facteur_voyage = max(float(rng.normal(1.0, BRUIT_VOYAGE_SIGMA)), 0.1)
            p_aux_kw = puissance_auxiliaire_kw(temperature)

            codes = arrets["stop_code"].to_numpy()
            dep_s = arrets["departure_time"].map(parse_hhmmss).to_numpy()
            arr_s = arrets["arrival_time"].map(parse_hhmmss).to_numpy()

            lignes_voyage = []
            for i in range(len(codes) - 1):
                paires_totales += 1
                cle = (route_id, int(codes[i]), int(codes[i + 1]))
                sid = seg_index.get(cle)
                if sid is None:
                    paires_absentes += 1
                    continue

                a = attrs.loc[sid]
                distance_m = float(a["distance_m"])

                # Temps GTFS (départ arrêt i -> arrivée arrêt i+1) + bruit lognormal
                temps_gtfs = arr_s[i + 1] - dep_s[i]
                if not np.isfinite(temps_gtfs) or temps_gtfs <= 0:
                    # repli : vitesse commerciale de 18 km/h
                    temps_gtfs = distance_m / (18.0 / 3.6)
                temps_s = float(temps_gtfs) * float(rng.lognormal(0.0, BRUIT_TEMPS_SIGMA))
                temps_s = max(temps_s, distance_m / (120.0 / 3.6))  # vitesse plafonnée
                vitesse_kmh = min(distance_m / temps_s * 3.6, 120.0)

                # Traction (road-load, rescalé par la charge) + bruit segment
                facteur_segment = max(float(rng.normal(1.0, BRUIT_SEGMENT_SIGMA)), 0.1)
                traction_wh = (energie_segment_wh(a, charge)
                               * facteur_voyage * facteur_segment)

                # Auxiliaires : puissance (chauffage/clim/base) × temps
                chauffage_wh = p_aux_kw * temps_s / 3.6  # kW × s -> Wh

                lignes_voyage.append({
                    "voyage_id": voyage_id,
                    "parcours_type": parcours,
                    "route_id": route_id,
                    "segment_id": sid,
                    "ordre": len(lignes_voyage),
                    "arret_debut_code": int(codes[i]),
                    "arret_fin_code": int(codes[i + 1]),
                    "distance_m": round(distance_m, 1),
                    "mois": mois,
                    "temperature_C": temperature,
                    "charge_passagers": charge,
                    "temps_parcours_s": round(temps_s, 1),
                    "vitesse_moy_kmh": round(vitesse_kmh, 2),
                    "conso_traction_Wh": round(traction_wh, 1),
                    "conso_chauffage_Wh": round(chauffage_wh, 1),
                    "conso_totale_Wh": round(traction_wh + chauffage_wh, 1),
                })

            if lignes_voyage:
                lignes.extend(lignes_voyage)
                voyage_id += 1

conso = pd.DataFrame(lignes)
part_resolue = 1.0 - paires_absentes / max(paires_totales, 1)
print(f"\n   {voyage_id:,} voyages | {len(conso):,} lignes | "
      f"paires arrêt->segment résolues : {part_resolue:.1%}")


# %% =============================================================
# 4. EXPORTS (jeu normal + jeu fusion)
# ===============================================================
print("\n7. Exports…")
conso.to_parquet(PATH_SORTIE, index=False)
print(f"   -> {PATH_SORTIE} ({PATH_SORTIE.stat().st_size / 1e6:.1f} Mo)")

# Variante fusion : remap segment_id -> merged_id (liaison_fusion.parquet)
conso_fusion = conso.copy()
conso_fusion["segment_id"] = conso_fusion["segment_id"].map(merged_par_segment)
n_sans_merged = int(conso_fusion["segment_id"].isna().sum())
if n_sans_merged:
    print(f"   ({n_sans_merged} lignes sans merged_id retirées)")
    conso_fusion = conso_fusion.dropna(subset=["segment_id"])
conso_fusion["segment_id"] = conso_fusion["segment_id"].astype(int)
conso_fusion.to_parquet(PATH_SORTIE_FUSION, index=False)
print(f"   -> {PATH_SORTIE_FUSION} ({PATH_SORTIE_FUSION.stat().st_size / 1e6:.1f} Mo)")

print("\n=== Terminé ===")
