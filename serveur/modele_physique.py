# -*- coding: utf-8 -*-
"""
modele_physique.py
==================
Modèle physique « road-load » (dynamique longitudinale d'un bus) partagé par
tout le projet — source unique de vérité pour :

  - pipeline/p04_attributs_segments.py : énergies statiques par segment ;
  - pipeline/p06_conso_synthetique.py  : consommation synthétique par voyage ;
  - serveur/serveur_viz.py             : simulation cinématique seconde par
                                         seconde et estimation d'énergie d'un
                                         trajet tracé sur le réseau routier.

Contenu :
  1. Constantes physiques du bus et coefficients de roulement.
  2. `puissance_auxiliaire_kw`  : chauffage électrique / climatisation selon T.
  3. `energie_segment_wh`      : énergie de traction d'un segment (Wh) à partir
                                 des attributs road-load (colonnes *_J_kg).
  4. `energie_arete_wh`        : énergie d'une arête du graphe routier (Wh)
                                 calculée depuis ses attributs bruts.
  5. `profil_cinematique`      : profil vitesse/puissance à 1 s (simulation).
  6. `GrapheRoutier`           : plus court chemin (Dijkstra) sur le réseau
                                 routier OSM précalculé par p08.
"""

import heapq

import numpy as np
import pandas as pd

# =============================================================
# 1. CONSTANTES (road-load / dynamique longitudinale d'un bus)
# =============================================================
MASSE_BUS_KG        = 13000.0   # bus 40 pi, à vide + équipements
G                   = 9.81      # m/s²
RHO_AIR             = 1.20      # kg/m³ (air ~15 °C)
CD_BUS              = 0.60      # coefficient de traînée
AIRE_FRONTALE_M2    = 8.0       # ≈ 2.55 m × 3.2 m
N_ARRETS_EXTREMITES = 2         # arrêts garantis aux deux bouts d'un segment

# Coefficient de résistance au roulement : base selon la surface OSM…
C_RR_SURFACE = {"asphalt": 0.010, "concrete": 0.011,
                "paving_stones": 0.015, "sett": 0.015, "_default": 0.012}
# …ajusté par un multiplicateur selon l'état de chaussée (PCI, Ville de MTL)
MULT_ETAT_CHAUSSEE = {"Excellent": 1.00, "Bon": 1.05, "Moyen": 1.15,
                      "Mauvais": 1.30, "Très mauvais": 1.50, "_default": 1.10}

VITESSE_DEFAUT_KMH = 40         # repli quand aucune limite OSM n'est rattachée

MASSE_PASSAGER_KG  = 70.0       # masse moyenne par passager

# Chaîne de traction électrique
RENDEMENT_CHAINE   = 0.85       # batterie -> roue
RENDEMENT_REGEN    = 0.60       # fraction de l'énergie de freinage récupérée
P_REGEN_MAX_KW     = 150.0      # puissance de récupération maximale

# Auxiliaires (chauffage électrique / climatisation)
T_CONFORT_CHAUFFAGE_C = 18.0    # consigne sous laquelle on chauffe
T_CONFORT_CLIM_C      = 24.0    # consigne au-dessus de laquelle on climatise
PENTE_CHAUFFAGE_KW_C  = 0.7     # kW par °C sous la consigne
PENTE_CLIM_KW_C       = 1.0     # kW par °C au-dessus de la consigne
P_CHAUFFAGE_MAX_KW    = 22.0
P_CLIM_MAX_KW         = 12.0
P_AUX_BASE_KW         = 2.0     # électronique, ventilation, portes…

# Cinématique (simulation)
ACCELERATION_MS2   = 1.0
FREINAGE_MS2       = 1.2
V_CROISIERE_MAX_KMH = 60.0      # plafond urbain réaliste pour un bus


# =============================================================
# 2. AUXILIAIRES (chauffage / climatisation selon la température)
# =============================================================
def puissance_auxiliaire_kw(temperature_C):
    """Puissance auxiliaire totale (kW) : base + chauffage élec. ou clim."""
    t = float(temperature_C)
    chauffage = min(max(PENTE_CHAUFFAGE_KW_C * (T_CONFORT_CHAUFFAGE_C - t), 0.0),
                    P_CHAUFFAGE_MAX_KW)
    clim = min(max(PENTE_CLIM_KW_C * (t - T_CONFORT_CLIM_C), 0.0), P_CLIM_MAX_KW)
    return P_AUX_BASE_KW + chauffage + clim


def _masse_totale_kg(charge_passagers):
    charge = float(charge_passagers) if pd.notna(charge_passagers) else 0.0
    return MASSE_BUS_KG + max(charge, 0.0) * MASSE_PASSAGER_KG


# =============================================================
# 3. ÉNERGIE D'UN SEGMENT GTFS (depuis les attributs road-load)
# =============================================================
def energie_segment_wh(attrs, charge_passagers=0.0):
    """Énergie de traction nette (Wh) d'un segment pour une charge donnée.

    `attrs` : dict ou ligne pandas portant les colonnes de
    attributs_segments.parquet. Les termes proportionnels à la masse sont
    rescalés via les colonnes spécifiques (*_J_kg) ; la traînée aéro (kJ)
    est indépendante de la masse. Peut être négative (surplus de regen en
    forte descente).
    """
    m_tot = _masse_totale_kg(charge_passagers)

    def _j_kg(nom):
        v = attrs.get(nom) if isinstance(attrs, dict) else attrs[nom]
        return float(v) if pd.notna(v) else 0.0

    e_montee    = _j_kg("energie_pot_montee_J_kg") * m_tot
    e_roulement = _j_kg("travail_roulement_J_kg") * m_tot
    e_arrets    = _j_kg("energie_arrets_J_kg") * m_tot
    e_aero      = _j_kg("travail_aero_kJ") * 1000.0
    e_regen     = _j_kg("energie_regen_J_kg") * m_tot

    e_net_j = ((e_montee + e_roulement + e_arrets + e_aero)
               - RENDEMENT_REGEN * e_regen) / RENDEMENT_CHAINE
    return e_net_j / 3600.0  # J -> Wh


# =============================================================
# 4. ÉNERGIE D'UNE ARÊTE DU GRAPHE ROUTIER (trajet tracé sur la carte)
# =============================================================
def energie_arete_wh(distance_m, pente_pct, coef_roul, vitesse_kmh,
                     nb_feux, charge_passagers=0.0):
    """Énergie de traction nette (Wh) d'une arête routière.

    Mêmes formules que le modèle segment, calculées depuis les attributs
    bruts de l'arête. Les arrêts pris en compte = feux rencontrés (espérance :
    un feu sur deux impose un arrêt complet).
    """
    m_tot = _masse_totale_kg(charge_passagers)
    d = max(float(distance_m), 0.0)
    v_ms = max(float(vitesse_kmh), 5.0) / 3.6
    dh = float(pente_pct) / 100.0 * d if pd.notna(pente_pct) else 0.0
    crr = float(coef_roul) if pd.notna(coef_roul) else C_RR_SURFACE["_default"]
    n_arrets = 0.5 * (float(nb_feux) if pd.notna(nb_feux) else 0.0)

    e_montee    = m_tot * G * max(dh, 0.0)
    e_descente  = m_tot * G * max(-dh, 0.0)
    e_roulement = crr * m_tot * G * d
    e_aero      = 0.5 * RHO_AIR * CD_BUS * AIRE_FRONTALE_M2 * v_ms ** 2 * d
    e_arrets    = n_arrets * 0.5 * m_tot * v_ms ** 2
    e_regen     = e_descente + e_arrets

    e_net_j = ((e_montee + e_roulement + e_aero + e_arrets)
               - RENDEMENT_REGEN * e_regen) / RENDEMENT_CHAINE
    return e_net_j / 3600.0


# =============================================================
# 5. PROFIL CINÉMATIQUE (simulation seconde par seconde)
# =============================================================
def _profil_vitesse_troncon(distance_m, v_cible_ms, rng):
    """Profil de vitesse (m/s, pas de 1 s) d'un tronçon entre deux arrêts.

    Trapèze accélération / croisière / freinage ; profil triangulaire si le
    tronçon est trop court pour atteindre la vitesse cible.
    """
    d = max(float(distance_m), 1.0)
    a_acc = ACCELERATION_MS2
    a_dec = FREINAGE_MS2

    d_acc = v_cible_ms ** 2 / (2 * a_acc)
    d_dec = v_cible_ms ** 2 / (2 * a_dec)
    if d_acc + d_dec > d:
        # Profil triangulaire : vitesse de pointe atteignable sur la distance
        v_pointe = np.sqrt(2 * d * a_acc * a_dec / (a_acc + a_dec))
    else:
        v_pointe = v_cible_ms

    vitesses = []
    v = 0.0
    pos = 0.0
    # Distance à partir de laquelle il faut freiner
    while pos < d - 0.5:
        d_freinage = v ** 2 / (2 * a_dec)
        if d - pos <= d_freinage + v:  # marge d'une seconde
            v = max(v - a_dec, 0.0)
        elif v < v_pointe:
            v = min(v + a_acc, v_pointe)
        # légère variation de croisière (conduite réelle)
        v_eff = max(v + rng.normal(0.0, 0.15), 0.0) if v > 1.0 else v
        pos += v_eff
        vitesses.append(v_eff)
        if len(vitesses) > 3600:  # garde-fou (tronçon > 1 h impossible)
            break
    vitesses.append(0.0)
    return vitesses


def profil_cinematique(segments, temperature_C=15.0, charge_passagers=20.0,
                       seed=0):
    """Profil vitesse / puissance / consommation à 1 s pour une suite de segments.

    `segments` : liste de dicts (ordonnés le long du voyage) portant
    `segment_id`, `distance_m`, `vitesse_calc_kmh`, `pente_moy_pct`,
    `coef_roulement`, `nb_feux`.

    Retourne (series, bornes_segments) :
      series          : [[t_s, v_kmh, p_kw, conso_kwh_km], ...]
      bornes_segments : [{segment_id, t_debut_s, t_fin_s, distance_m}, ...]
    La puissance inclut la traction (positive), la régénération (négative,
    bornée) et les auxiliaires (chauffage/clim selon la température).
    """
    rng = np.random.default_rng(seed)
    m_tot = _masse_totale_kg(charge_passagers)
    p_aux_kw = puissance_auxiliaire_kw(temperature_C)

    series = []
    bornes = []
    t = 0

    for seg in segments:
        t_debut = t
        d_seg = max(float(seg.get("distance_m") or 0.0), 1.0)
        v_cible_kmh = seg.get("vitesse_calc_kmh")
        if v_cible_kmh is None or pd.isna(v_cible_kmh):
            v_cible_kmh = VITESSE_DEFAUT_KMH
        v_cible_ms = min(float(v_cible_kmh), V_CROISIERE_MAX_KMH) / 3.6
        pente = float(seg.get("pente_moy_pct") or 0.0) / 100.0
        crr = seg.get("coef_roulement")
        crr = float(crr) if crr is not None and pd.notna(crr) else C_RR_SURFACE["_default"]
        nb_feux = int(seg.get("nb_feux") or 0)

        # Arrêts intermédiaires : chaque feu impose un arrêt avec proba 0.5.
        # Le segment est découpé en tronçons entre arrêts effectifs.
        fractions = [rng.uniform(0.15, 0.85) for _ in range(nb_feux)
                     if rng.random() < 0.5]
        positions = sorted(fractions) + [1.0]
        prec = 0.0
        troncons = []
        for frac in positions:
            troncons.append((frac - prec) * d_seg)
            prec = frac

        v_prec = 0.0
        for i_tr, d_tr in enumerate(troncons):
            vitesses = _profil_vitesse_troncon(d_tr, v_cible_ms, rng)
            for v in vitesses:
                a = v - v_prec  # pas de 1 s -> accélération en m/s²
                # Puissance mécanique à la roue (W)
                p_mec = (m_tot * a * v
                         + m_tot * G * pente * v
                         + crr * m_tot * G * v
                         + 0.5 * RHO_AIR * CD_BUS * AIRE_FRONTALE_M2 * v ** 3)
                if p_mec >= 0:
                    p_elec = p_mec / RENDEMENT_CHAINE
                else:
                    p_elec = max(p_mec, -P_REGEN_MAX_KW * 1000.0) * RENDEMENT_REGEN
                p_kw = p_elec / 1000.0 + p_aux_kw
                v_kmh = v * 3.6
                conso = round(p_kw / v_kmh, 4) if v_kmh > 0.72 else None
                series.append([t, round(v_kmh, 2), round(p_kw, 2), conso])
                t += 1
                v_prec = v

            # Temps d'arrêt : feu intermédiaire (10-30 s) ou arrêt de bus (15-25 s)
            est_feu = i_tr < len(troncons) - 1
            duree_arret = int(rng.uniform(10, 30) if est_feu else rng.uniform(15, 25))
            for _ in range(duree_arret):
                series.append([t, 0.0, round(p_aux_kw, 2), None])
                t += 1
            v_prec = 0.0

        bornes.append({
            "segment_id": int(seg.get("segment_id", -1)),
            "t_debut_s": int(t_debut),
            "t_fin_s": int(t),
            "distance_m": round(d_seg, 1),
        })

    return series, bornes


# =============================================================
# 6. GRAPHE ROUTIER (plus court chemin pour le trajet tracé)
# =============================================================
class GrapheRoutier:
    """Réseau routier routable précalculé par p08_graphe_routier.py.

    Charge graphe_routier_noeuds.parquet / graphe_routier_aretes.parquet,
    construit l'adjacence orientée et répond aux requêtes :
      - noeud_le_plus_proche(lat, lon)
      - plus_court_chemin(noeud_a, noeud_b) -> liste d'indices d'arêtes
      - estimation_trajet(chemin, ...)     -> distance / temps / énergie
    """

    def __init__(self, path_noeuds, path_aretes):
        self.noeuds = pd.read_parquet(path_noeuds)
        if "node_id" in self.noeuds.columns:
            self.noeuds = self.noeuds.set_index("node_id").sort_index()
        self.aretes = pd.read_parquet(path_aretes)

        self._lats = self.noeuds["lat"].to_numpy(dtype=float)
        self._lons = self.noeuds["lon"].to_numpy(dtype=float)

        # KDTree en coordonnées métriques approchées (plate carrée locale)
        from scipy.spatial import cKDTree
        lat0 = float(np.nanmean(self._lats))
        self._lat_scale = 111320.0
        self._lon_scale = 111320.0 * np.cos(np.radians(lat0))
        xy = np.column_stack((self._lons * self._lon_scale,
                              self._lats * self._lat_scale))
        self._kdtree = cKDTree(xy)

        # Adjacence orientée : node_a -> [(node_b, idx_arete), ...]
        self._adj = {}
        na = self.aretes["node_a"].to_numpy(dtype=np.int64)
        nb = self.aretes["node_b"].to_numpy(dtype=np.int64)
        for idx in range(len(self.aretes)):
            self._adj.setdefault(int(na[idx]), []).append((int(nb[idx]), idx))

        self._dist = self.aretes["distance_m"].to_numpy(dtype=float)

    def noeud_le_plus_proche(self, lat, lon, distance_max_m=300.0):
        """Nœud routier le plus proche du point cliqué (None si trop loin)."""
        x = float(lon) * self._lon_scale
        y = float(lat) * self._lat_scale
        d, idx = self._kdtree.query([x, y])
        if d > distance_max_m:
            return None
        return int(idx)

    def plus_court_chemin(self, noeud_a, noeud_b):
        """Dijkstra pondéré par la distance. Renvoie une liste d'indices
        d'arêtes ordonnée de a vers b, ou None si aucun chemin n'existe."""
        if noeud_a == noeud_b:
            return []
        dist = {noeud_a: 0.0}
        prev = {}
        file_prio = [(0.0, noeud_a)]
        vus = set()
        while file_prio:
            d_cur, n_cur = heapq.heappop(file_prio)
            if n_cur in vus:
                continue
            if n_cur == noeud_b:
                break
            vus.add(n_cur)
            for n_suiv, idx_arete in self._adj.get(n_cur, []):
                if n_suiv in vus:
                    continue
                d_new = d_cur + self._dist[idx_arete]
                if d_new < dist.get(n_suiv, np.inf):
                    dist[n_suiv] = d_new
                    prev[n_suiv] = (n_cur, idx_arete)
                    heapq.heappush(file_prio, (d_new, n_suiv))

        if noeud_b not in prev:
            return None
        chemin = []
        n = noeud_b
        while n != noeud_a:
            n_prec, idx_arete = prev[n]
            chemin.append(idx_arete)
            n = n_prec
        return list(reversed(chemin))

    def coords_chemin(self, chemin):
        """Polyline [[lat, lon], ...] suivant les rues (géométrie des arêtes)."""
        import json as _json
        if not chemin:
            return []
        coords = []
        for idx in chemin:
            pts = self.aretes.at[idx, "coords"]
            if isinstance(pts, str):
                pts = _json.loads(pts)
            pts = [[float(p[0]), float(p[1])] for p in pts]
            if coords and pts and coords[-1] == pts[0]:
                pts = pts[1:]
            coords.extend(pts)
        return coords

    def estimation_trajet(self, chemin, charge_passagers=20.0,
                          temperature_C=15.0):
        """Distance, temps et énergie (modèle road-load) d'un chemin d'arêtes."""
        distance = 0.0
        temps_s = 0.0
        traction_wh = 0.0
        for idx in chemin:
            a = self.aretes.iloc[idx]
            d = float(a["distance_m"])
            v = float(a["vitesse_kmh"]) if pd.notna(a["vitesse_kmh"]) else VITESSE_DEFAUT_KMH
            nb_feux = float(a.get("nb_feux", 0.0) or 0.0)
            distance += d
            # temps de roulage + espérance d'attente aux feux (arrêt 20 s, proba 0.5)
            temps_s += d / (max(v, 5.0) / 3.6) + 0.5 * nb_feux * 20.0
            traction_wh += energie_arete_wh(
                d, a.get("pente_pct"), a.get("coef_roulement"), v,
                nb_feux, charge_passagers,
            )

        chauffage_wh = ((puissance_auxiliaire_kw(temperature_C) - P_AUX_BASE_KW)
                        * temps_s / 3.6)  # kW × s -> Wh
        aux_base_wh = P_AUX_BASE_KW * temps_s / 3.6
        totale_wh = traction_wh + chauffage_wh + aux_base_wh
        return {
            "distance_m": round(distance, 1),
            "temps_estime_s": round(temps_s, 0),
            "energie": {
                "traction_Wh": round(traction_wh, 1),
                "chauffage_Wh": round(chauffage_wh, 1),
                "auxiliaires_Wh": round(aux_base_wh, 1),
                "totale_Wh": round(totale_wh, 1),
                "kwh_per_km": (round(totale_wh / distance, 3)
                               if distance > 0 else None),
            },
        }

    def attributs_chemin(self, chemin):
        """Attributs physiques agrégés d'un chemin d'arêtes, au format des
        segments GTFS (mêmes clés que attributs_segments.parquet) afin d'être
        rendus par le même bloc sidebar `renderAttributsBlocks`. Sert à décrire
        un tronçon d'une ligne créée exactement comme un vrai segment.
        Champs produits : distance, dénivelés ± (depuis la pente), pente moyenne,
        vitesse max autorisée, feux, C_rr, vitesse utilisée, et la distance
        parcourue sous chaque limite de vitesse (dist_vmax_<v>_m)."""
        if not chemin:
            return {}
        d_tot = 0.0
        denivele_pos = 0.0
        denivele_neg = 0.0
        pente_pond = 0.0
        crr_pond = 0.0
        v_pond = 0.0
        nb_feux = 0
        vmax = 0.0
        dist_par_vlimite = {}
        for idx in chemin:
            a = self.aretes.iloc[idx]
            d = float(a["distance_m"])
            if d <= 0:
                continue
            v = float(a["vitesse_kmh"]) if pd.notna(a["vitesse_kmh"]) else VITESSE_DEFAUT_KMH
            pente = float(a["pente_pct"]) if pd.notna(a["pente_pct"]) else 0.0
            crr = float(a["coef_roulement"]) if pd.notna(a["coef_roulement"]) else 0.0
            f = int(a.get("nb_feux", 0) or 0)
            dz = pente / 100.0 * d           # variation d'altitude sur l'arête
            d_tot += d
            denivele_pos += max(dz, 0.0)
            denivele_neg += max(-dz, 0.0)    # magnitude positive (convention p04)
            pente_pond += pente * d
            crr_pond += crr * d
            v_pond += v * d
            nb_feux += f
            vmax = max(vmax, v)
            cle = int(round(v)) if v > 0 else 0
            dist_par_vlimite[cle] = dist_par_vlimite.get(cle, 0.0) + d
        if d_tot <= 0:
            return {}
        attrs = {
            "distance_m":         round(d_tot, 1),
            "denivele_pos_m":     round(denivele_pos, 1),
            "denivele_neg_m":     round(denivele_neg, 1),
            "pente_moy_pct":      round(pente_pond / d_tot, 2),
            "vitesse_limite_kmh": round(vmax, 0),
            "nb_feux":            nb_feux,
            "coef_roulement":     round(crr_pond / d_tot, 4),
            "vitesse_calc_kmh":   round(v_pond / d_tot, 1),
        }
        for v, dd in sorted(dist_par_vlimite.items()):
            attrs[f"dist_vmax_{v}_m"] = round(dd, 1)
        return attrs
