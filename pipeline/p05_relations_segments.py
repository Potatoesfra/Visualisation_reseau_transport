"""
p05_relations_segments.py
=========================
Étape 5 du pipeline : construction du graphe de relations entre les segments
GTFS (p02/p03). Chaque segment est une portion de shape comprise entre deux
stop_codes consécutifs sur une ligne donnée. Traite les deux jeux :
"normal" (segments.gpkg) et "fusion" (segments_merge_identiques.gpkg).

Relations modélisées
--------------------
- suivant          : A se termine à un arrêt où B commence (même route_id, sens du parcours)
- portion_partagee : A et B se superposent géométriquement sur >= SEUIL_PORTION mètres
- intersection     : A et B se croisent en un point ou sur < SEUIL_PORTION mètres (et ne sont PAS en portion_partagee)
- merge            : sous-cas de portion_partagee où la superposition touche les FINS communes des deux segments
- diverge          : sous-cas de portion_partagee où la superposition touche les DEBUTS communs des deux segments
- oppose           : portion_partagee parcourue en sens inverse (lignes aller/retour qui empruntent la même rue)
- parallele_proche : segments dont les buffers se recouvrent largement sans superposition exacte
                     (corridors de rues à sens unique parallèles)

Sorties (data_derivee/)
-----------------------
- relations_segments{_merge_identiques}.parquet  : table d'arêtes typées
- relations_segments{_merge_identiques}.gpkg     : version géospatiale (QGIS)
- centralite_segments{_merge_identiques}.parquet : degree in/out, PageRank, radiality
"""

# %%
import sys
import warnings
from collections import deque
from pathlib import Path

import numpy as np
import pandas as pd
import geopandas as gpd
from shapely.geometry import Point
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import DATA_DERIVEE  # noqa: E402

warnings.filterwarnings("ignore", category=RuntimeWarning)
warnings.filterwarnings("ignore", category=UserWarning)

# %% =============================================================
# PARAMÈTRES
# ===============================================================

# CRS projeté pour les mesures métriques (MTM zone 8, adapté au Québec / Montréal)
CRS_METRIQUE = "EPSG:32188"
CRS_GEO = "EPSG:4326"

# Seuils (en mètres, dans le CRS métrique)
SEUIL_PORTION = 20.0          # >= 20 m de recouvrement => portion_partagee, sinon intersection
SEUIL_MERGE_DIVERGE = 30.0    # tolérance pour considérer qu'une superposition touche une extrémité
SEUIL_PARALLELE_BUFFER = 25.0  # rayon du buffer pour parallele_proche (=> corridor de ~50 m de large)
SEUIL_PARALLELE_RECOUVR = 100.0  # longueur min de recouvrement de buffers pour parallele_proche
SEUIL_INTERSECTION_PIVOT_SUIVANT_M = 10.0  # si intersection proche du pivot d'un "suivant", on supprime "intersection"

# PageRank
PAGERANK_DAMPING = 0.85
PAGERANK_MAX_ITER = 100
PAGERANK_TOL = 1e-8


def classifier_intersection(geom_a, geom_b):
    """
    Retourne un dict décrivant la relation géométrique entre deux segments,
    ou None si pas de relation pertinente.
    """
    inter = geom_a.intersection(geom_b)

    if inter.is_empty:
        return None

    # Longueur de l'intersection (0 si points purs)
    try:
        inter_len = inter.length
    except Exception:
        inter_len = 0.0

    # Récupérer tous les LineString éventuels dans l'intersection
    if inter.geom_type in ("LineString", "MultiLineString") and inter_len > 0:
        # === Superposition linéaire ===
        if inter_len >= SEUIL_PORTION:
            kind = "portion_partagee"
        else:
            # Courte superposition => on traite comme intersection « élargie »
            kind = "intersection"

        # Sens (oppose ?) : on projette les points d'extrémité de l'intersection
        # sur chaque segment et on regarde si les paramètres curvilignes
        # croissent dans le même sens.
        if inter.geom_type == "MultiLineString":
            # Prendre le plus long composant pour le calcul de sens
            longest = max(inter.geoms, key=lambda g: g.length)
        else:
            longest = inter

        p_start = Point(longest.coords[0])
        p_end = Point(longest.coords[-1])

        sa1 = geom_a.project(p_start)
        sa2 = geom_a.project(p_end)
        sb1 = geom_b.project(p_start)
        sb2 = geom_b.project(p_end)

        sens_a = np.sign(sa2 - sa1)
        sens_b = np.sign(sb2 - sb1)
        oppose = (sens_a != 0 and sens_b != 0 and sens_a != sens_b)

        # Merge / Diverge : positions de l'intersection le long de chaque segment
        len_a = geom_a.length
        len_b = geom_b.length
        s_a_min, s_a_max = min(sa1, sa2), max(sa1, sa2)
        s_b_min, s_b_max = min(sb1, sb2), max(sb1, sb2)

        a_touche_debut = s_a_min <= SEUIL_MERGE_DIVERGE
        a_touche_fin = (len_a - s_a_max) <= SEUIL_MERGE_DIVERGE
        b_touche_debut = s_b_min <= SEUIL_MERGE_DIVERGE
        b_touche_fin = (len_b - s_b_max) <= SEUIL_MERGE_DIVERGE

        merge_diverge = None
        if kind == "portion_partagee":
            if oppose:
                # En sens inverse, "merge" et "diverge" ne sont pas significatifs
                # de la même façon ; on n'attribue pas ce sous-type.
                merge_diverge = None
            else:
                # Même sens : les deux extrémités finales coïncident => merge
                if a_touche_fin and b_touche_fin and not (a_touche_debut and b_touche_debut):
                    merge_diverge = "merge"
                # Les deux extrémités initiales coïncident => diverge
                elif a_touche_debut and b_touche_debut and not (a_touche_fin and b_touche_fin):
                    merge_diverge = "diverge"

        return {
            "type_relation": kind,
            "oppose": bool(oppose),
            "longueur_recouvrement_m": float(inter_len),
            "sous_type": merge_diverge,
            "geometry": inter,
        }

    elif inter.geom_type in ("Point", "MultiPoint"):
        # === Croisement ponctuel ===
        return {
            "type_relation": "intersection",
            "oppose": False,
            "longueur_recouvrement_m": 0.0,
            "sous_type": None,
            "geometry": inter,
        }

    elif inter.geom_type == "GeometryCollection":
        # Mélange : on extrait les lignes et les points
        lines = [g for g in inter.geoms if g.geom_type in ("LineString", "MultiLineString")]
        total_line_len = sum(g.length for g in lines)
        if total_line_len >= SEUIL_PORTION:
            # Traite comme portion_partagee, sans détail merge/diverge fiable
            return {
                "type_relation": "portion_partagee",
                "oppose": False,
                "longueur_recouvrement_m": float(total_line_len),
                "sous_type": None,
                "geometry": inter,
            }
        else:
            return {
                "type_relation": "intersection",
                "oppose": False,
                "longueur_recouvrement_m": float(total_line_len),
                "sous_type": None,
                "geometry": inter,
            }

    return None


def traiter(mode):
    """Construit relations + centralités pour un jeu ("normal" ou "fusion")."""
    suf = "" if mode == "normal" else "_merge_identiques"
    path_segments = DATA_DERIVEE / f"segments{suf}.gpkg"

    # =========================================================
    # CHARGEMENT
    # =========================================================
    print("\n" + "=" * 55)
    print(f"MODE {mode} — Chargement des segments")
    print("=" * 55)
    segments = gpd.read_file(path_segments)
    print(f"  {len(segments)} segments chargés dans le CRS d'origine {segments.crs}.")

    # Identifiant stable
    segments = segments.reset_index(drop=True)
    segments["segment_id"] = segments.index.astype(int)

    # Projection métrique
    segments_m = segments.to_crs(CRS_METRIQUE).copy()
    segments_m["longueur_m"] = segments_m.geometry.length

    print(f"  Reprojetés en {CRS_METRIQUE}.")
    print(f"  Longueur moyenne : {segments_m['longueur_m'].mean():.1f} m")
    print(f"  Longueur médiane : {segments_m['longueur_m'].median():.1f} m")

    # Cache des géométries et endpoints pour usage répété
    geoms = segments_m.geometry.values
    end_pts = np.array([(g.coords[-1]) for g in geoms])     # (n, 2)
    route_ids = segments_m["route_id"].astype(str).values
    seg_ids = segments_m["segment_id"].values

    tree = STRtree(list(geoms))
    print("\nIndex spatial STRtree construit.")

    # =========================================================
    # 1) SUIVANT
    # =========================================================
    # Définition : segment A précède B si A.end_stop_code == B.start_stop_code
    # et qu'ils partagent le même route_id (choix « souple » : on accepte toute
    # variante de tracé pour la même ligne).
    print("\n=== 1) Relations 'suivant' ===")

    df_left = segments_m[["segment_id", "route_id", "end_stop_code"]].rename(
        columns={"segment_id": "segment_id_a", "end_stop_code": "stop_lien"}
    )
    df_right = segments_m[["segment_id", "route_id", "start_stop_code"]].rename(
        columns={"segment_id": "segment_id_b", "start_stop_code": "stop_lien"}
    )

    # En mode "normal", un lien 'suivant' exige la même route_id (consécutivité sur
    # une ligne donnée). En mode "fusion", les nœuds regroupent plusieurs lignes et
    # leur route_id n'est que représentatif : on retient TOUTE consécutivité
    # (end_code(a) == start_code(b)), peu importe la ligne.
    suivant_keys = ["route_id", "stop_lien"] if mode == "normal" else ["stop_lien"]
    rel_suivant = df_left.merge(df_right, on=suivant_keys, how="inner")
    # Pas d'auto-boucle
    rel_suivant = rel_suivant[rel_suivant["segment_id_a"] != rel_suivant["segment_id_b"]].copy()
    rel_suivant["type_relation"] = "suivant"
    rel_suivant = rel_suivant.rename(columns={"stop_lien": "stop_pivot"})
    # En mode fusion, le merge sur la seule clé stop_lien produit route_id_x/route_id_y :
    # on conserve route_id_x (côté A) comme route_id représentatif du lien.
    if "route_id" not in rel_suivant.columns:
        rel_suivant["route_id"] = rel_suivant["route_id_x"]
    rel_suivant = rel_suivant[["segment_id_a", "segment_id_b", "type_relation", "route_id", "stop_pivot"]]

    print(f"  {len(rel_suivant)} relations 'suivant' détectées.")

    # =========================================================
    # 2) PORTION_PARTAGEE, INTERSECTION, MERGE, DIVERGE, OPPOSE
    # =========================================================
    # On parcourt les paires de segments dont les BOUNDING BOXES s'intersectent
    # (filtrage par STRtree, donc on ne fait pas O(n²) en pratique).
    # Pour chaque paire, on calcule l'intersection géométrique exacte.
    print("\n=== 2) Relations géométriques (portion, intersection, merge/diverge, oppose) ===")

    relations_geom = []
    n_segments = len(geoms)
    deja_vu = set()

    for i in range(n_segments):
        geom_i = geoms[i]
        cand_idx = tree.query(geom_i, predicate="intersects")
        for j in cand_idx:
            j = int(j)
            if j <= i:
                continue
            key = (i, j)
            if key in deja_vu:
                continue
            deja_vu.add(key)

            res = classifier_intersection(geom_i, geoms[j])
            if res is None:
                continue

            relations_geom.append({
                "segment_id_a": int(seg_ids[i]),
                "segment_id_b": int(seg_ids[j]),
                "route_id_a": route_ids[i],
                "route_id_b": route_ids[j],
                **res,
            })

        if (i + 1) % 500 == 0:
            print(f"  ...{i+1}/{n_segments} segments traités")

    rel_geom_df = pd.DataFrame(relations_geom)
    print(f"  {len(rel_geom_df)} relations géométriques brutes détectées.")

    # Décompte par type
    if not rel_geom_df.empty:
        print("\n  Répartition :")
        print(rel_geom_df["type_relation"].value_counts().to_string())
        print("\n  Dont 'oppose' :", int(rel_geom_df["oppose"].sum()))
        print("  Dont 'merge'  :", int((rel_geom_df["sous_type"] == "merge").sum()))
        print("  Dont 'diverge':", int((rel_geom_df["sous_type"] == "diverge").sum()))

    # =========================================================
    # 3) Aplatissement en arêtes typées
    # =========================================================
    # Chaque ligne de rel_geom_df peut donner plusieurs arêtes :
    #   - une arête "portion_partagee" ou "intersection" (type principal)
    #   - une arête "oppose" si oppose=True
    #   - une arête "merge" ou "diverge" si sous_type est défini
    print("\n=== 3) Aplatissement en arêtes typées ===")

    aretes = []

    # Suivant
    for _, r in rel_suivant.iterrows():
        aretes.append({
            "segment_id_a": int(r["segment_id_a"]),
            "segment_id_b": int(r["segment_id_b"]),
            "type_relation": "suivant",
            "longueur_recouvrement_m": np.nan,
            "stop_pivot": int(r["stop_pivot"]),
            "route_id_a": r["route_id"],
            "route_id_b": r["route_id"],
            "geometry": None,
        })

    # Relations géométriques
    if not rel_geom_df.empty:
        for _, r in rel_geom_df.iterrows():
            base = {
                "segment_id_a": r["segment_id_a"],
                "segment_id_b": r["segment_id_b"],
                "route_id_a": r["route_id_a"],
                "route_id_b": r["route_id_b"],
                "longueur_recouvrement_m": r["longueur_recouvrement_m"],
                "stop_pivot": pd.NA,
                "geometry": r["geometry"],
            }
            # Arête principale
            aretes.append({**base, "type_relation": r["type_relation"]})
            # Oppose
            if r["oppose"]:
                aretes.append({**base, "type_relation": "oppose"})
            # Merge / diverge
            if r["sous_type"] in ("merge", "diverge"):
                aretes.append({**base, "type_relation": r["sous_type"]})

    # =========================================================
    # 4) PARALLELE_PROCHE
    # =========================================================
    # On bufferise chaque segment, on cherche les paires dont les buffers se
    # recouvrent significativement, MAIS qui ne sont pas déjà en portion_partagee
    # (le but est de capturer les rues parallèles, pas les superpositions exactes).
    print("\n=== 4) Relations 'parallele_proche' ===")

    buffers = [g.buffer(SEUIL_PARALLELE_BUFFER) for g in geoms]
    tree_buf = STRtree(buffers)

    # Set des paires déjà classées en portion_partagee (pour exclusion)
    paires_portion = set()
    if not rel_geom_df.empty:
        mask_pp = rel_geom_df["type_relation"] == "portion_partagee"
        for _, r in rel_geom_df[mask_pp].iterrows():
            a, b = sorted([int(r["segment_id_a"]), int(r["segment_id_b"])])
            paires_portion.add((a, b))

    n_parallele = 0
    for i in range(n_segments):
        buf_i = buffers[i]
        cand_idx = tree_buf.query(buf_i, predicate="intersects")
        for j in cand_idx:
            j = int(j)
            if j <= i:
                continue
            pair_key = (i, j)
            if pair_key in paires_portion:
                continue

            # Longueur de la portion du segment i comprise dans le buffer de j
            inter_i_dans_bufj = geoms[i].intersection(buffers[j])
            if inter_i_dans_bufj.is_empty:
                continue
            try:
                l_overlap = inter_i_dans_bufj.length
            except Exception:
                continue
            if l_overlap < SEUIL_PARALLELE_RECOUVR:
                continue

            # Vérifier que ce n'est pas une superposition quasi-exacte
            # (dans ce cas, c'est portion_partagee et ça aurait été capté plus haut ;
            # mais on filtre par sécurité avec la distance minimale)
            dist_min = geoms[i].distance(geoms[j])
            if dist_min < 1.0:
                # presque collés -> ce sera traité comme portion partagée
                continue

            aretes.append({
                "segment_id_a": int(seg_ids[i]),
                "segment_id_b": int(seg_ids[j]),
                "type_relation": "parallele_proche",
                "longueur_recouvrement_m": float(l_overlap),
                "stop_pivot": pd.NA,
                "route_id_a": route_ids[i],
                "route_id_b": route_ids[j],
                "geometry": inter_i_dans_bufj,
            })
            n_parallele += 1

        if (i + 1) % 500 == 0:
            print(f"  ...{i+1}/{n_segments} segments traités (parallele)")

    print(f"  {n_parallele} relations 'parallele_proche' détectées.")

    # =========================================================
    # 5) ASSEMBLAGE FINAL
    # =========================================================
    print("\n=== 5) Assemblage final ===")

    aretes_df = pd.DataFrame(aretes)
    print(f"  Total des arêtes : {len(aretes_df)}")
    print("\n  Décompte par type :")
    print(aretes_df["type_relation"].value_counts().to_string())

    # Filtre métier : si A-B a un lien "suivant" et un lien "intersection",
    # et que la géométrie d'intersection est proche du stop pivot du "suivant",
    # on conserve seulement "suivant".
    def filter_intersections_near_suivant_pivot(df):
        inter_mask = df["type_relation"] == "intersection"
        suiv_mask = df["type_relation"] == "suivant"
        if not inter_mask.any() or not suiv_mask.any():
            return df, 0

        intersections = df[inter_mask].copy()
        suiv_df = df[suiv_mask].copy()

        # Point pivot d'un lien "suivant" = extrémité finale du segment_id_a.
        end_point_by_seg = {
            int(seg_id): Point(end_pts[idx][0], end_pts[idx][1])
            for idx, seg_id in enumerate(seg_ids)
        }

        suiv_by_pair = {}
        for _, r in suiv_df.iterrows():
            a = int(r["segment_id_a"])
            b = int(r["segment_id_b"])
            suiv_by_pair.setdefault((a, b), []).append(a)

        to_drop = []
        for idx, r in intersections.iterrows():
            a = int(r["segment_id_a"])
            b = int(r["segment_id_b"])
            geom = r.get("geometry", None)
            if geom is None or pd.isna(geom):
                continue

            # Une relation "intersection" est non orientée ; on teste les deux sens
            # possibles de "suivant" entre les mêmes segments.
            candidates = []
            candidates.extend(suiv_by_pair.get((a, b), []))
            candidates.extend(suiv_by_pair.get((b, a), []))

            keep_intersection = True
            for seg_a in candidates:
                pivot_pt = end_point_by_seg.get(int(seg_a))
                if pivot_pt is None:
                    continue
                if geom.distance(pivot_pt) <= SEUIL_INTERSECTION_PIVOT_SUIVANT_M:
                    keep_intersection = False
                    break

            if not keep_intersection:
                to_drop.append(idx)

        if not to_drop:
            return df, 0

        filtered = df.drop(index=to_drop).copy()
        return filtered, len(to_drop)

    aretes_df, n_intersections_filtrees = filter_intersections_near_suivant_pivot(aretes_df)
    print(
        f"\n  Filtre suivant/intersection (<={SEUIL_INTERSECTION_PIVOT_SUIVANT_M:.0f} m du pivot) : "
        f"{n_intersections_filtrees} arêtes 'intersection' supprimées."
    )

    # Dédoublonnage (a, b, type) — pour 'suivant' on garde le sens, pour les autres on canonicalise
    def canonical_pair(row):
        a, b = row["segment_id_a"], row["segment_id_b"]
        if row["type_relation"] in ("suivant",):
            return (a, b)  # orienté
        return tuple(sorted([a, b]))

    aretes_df["_pair"] = aretes_df.apply(canonical_pair, axis=1)
    aretes_df = aretes_df.drop_duplicates(subset=["_pair", "type_relation"]).drop(columns=["_pair"])
    print(f"  Après dédoublonnage : {len(aretes_df)} arêtes.")

    # =========================================================
    # 6) EXPORTS
    # =========================================================

    # Version tabulaire (sans géométrie)
    out_parquet = DATA_DERIVEE / f"relations_segments{suf}.parquet"
    aretes_df.drop(columns=["geometry"]).to_parquet(out_parquet, index=False)
    print(f"\n  Parquet exporté : {out_parquet}")

    # Version géospatiale (uniquement les arêtes avec une géométrie)
    aretes_geo = aretes_df[aretes_df["geometry"].notna()].copy()
    if not aretes_geo.empty:
        aretes_gdf = gpd.GeoDataFrame(aretes_geo, geometry="geometry", crs=CRS_METRIQUE)
        aretes_gdf = aretes_gdf.to_crs(CRS_GEO)
        out_gpkg = DATA_DERIVEE / f"relations_segments{suf}.gpkg"
        # Une couche par type pour faciliter la visualisation dans QGIS
        for t, sub in aretes_gdf.groupby("type_relation"):
            sub.to_file(out_gpkg, layer=t, driver="GPKG")
        print(f"  GPKG exporté : {out_gpkg} (une couche par type de relation)")

    # =========================================================
    # 7) MÉTRIQUES DE CENTRALITÉ (degree entrant/sortant, PageRank, radiality)
    # =========================================================
    # Le graphe est DIRIGÉ pour les arêtes "suivant" (A→B) et non
    # dirigé pour tous les autres types (A↔B dans les deux sens).
    print("\n=== 7) Métriques de centralité ===")

    seg_ids_set = set(segments_m["segment_id"].values.tolist())
    out_nb = {sid: set() for sid in seg_ids_set}   # dirigé (suivant: A→B)
    in_nb = {sid: set() for sid in seg_ids_set}
    nb_undir = {sid: set() for sid in seg_ids_set}  # non-dirigé (radiality)

    for _, row in aretes_df.iterrows():
        a, b = int(row["segment_id_a"]), int(row["segment_id_b"])
        if a not in seg_ids_set or b not in seg_ids_set:
            continue
        if row["type_relation"] == "suivant":
            out_nb[a].add(b)
            in_nb[b].add(a)
        else:
            out_nb[a].add(b)
            out_nb[b].add(a)
            in_nb[a].add(b)
            in_nb[b].add(a)
        # Radiality : graphe non-dirigé, toutes relations bidirectionnelles
        nb_undir[a].add(b)
        nb_undir[b].add(a)

    id_list = sorted(seg_ids_set)
    id_to_idx = {sid: i for i, sid in enumerate(id_list)}
    n_nodes = len(id_list)
    out_deg = np.array([len(out_nb[sid]) for sid in id_list], dtype=float)

    pr = np.full(n_nodes, 1.0 / n_nodes)
    for _ in range(PAGERANK_MAX_ITER):
        prev = pr.copy()
        dangling_mass = float(np.sum(prev[out_deg == 0]))
        new_pr = np.full(n_nodes, (1.0 - PAGERANK_DAMPING) / n_nodes
                         + PAGERANK_DAMPING * dangling_mass / n_nodes)
        for i, sid in enumerate(id_list):
            if out_deg[i] == 0:
                continue
            contrib = PAGERANK_DAMPING * prev[i] / out_deg[i]
            for nb in out_nb[sid]:
                new_pr[id_to_idx[nb]] += contrib
        pr = new_pr
        if float(np.abs(pr - prev).sum()) < PAGERANK_TOL:
            break

    pr_max = float(pr.max()) if pr.max() > 0 else 1.0

    # ---- Radiality (Valente-Foreman, graphe non-dirigé) -------------------
    # Distances BFS tous-vers-tous calculées par blocs avec scipy.sparse.csgraph
    # (équivalent au BFS pur Python, mais en C — indispensable à cette échelle).
    print("  Calcul de la radiality (BFS par blocs scipy)…")
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import dijkstra

    lignes_adj = []
    colonnes_adj = []
    for sid, voisins in nb_undir.items():
        i = id_to_idx[sid]
        for nb in voisins:
            lignes_adj.append(i)
            colonnes_adj.append(id_to_idx[nb])
    adj = csr_matrix((np.ones(len(lignes_adj), dtype=np.int8),
                      (lignes_adj, colonnes_adj)),
                     shape=(n_nodes, n_nodes))

    radiality_raw = np.zeros(n_nodes, dtype=float)
    reachable_arr = np.zeros(n_nodes, dtype=float)
    sum_dist_arr = np.zeros(n_nodes, dtype=float)
    diameter = 0
    bloc = 512
    for debut in range(0, n_nodes, bloc):
        indices = np.arange(debut, min(debut + bloc, n_nodes))
        d = dijkstra(adj, directed=False, unweighted=True, indices=indices)
        finis = np.isfinite(d)
        # distance à soi-même = 0 (comptée dans reachable via -1 plus bas)
        reachable_arr[indices] = finis.sum(axis=1) - 1
        sum_dist_arr[indices] = np.where(finis, d, 0.0).sum(axis=1)
        d_max = d[finis].max() if finis.any() else 0
        diameter = max(diameter, int(d_max))

    if n_nodes > 1:
        avec_voisins = reachable_arr > 0
        radiality_raw[avec_voisins] = (
            ((diameter + 1) * reachable_arr[avec_voisins] - sum_dist_arr[avec_voisins])
            / (n_nodes - 1)
        )

    rad_max = float(radiality_raw.max()) if radiality_raw.max() > 0 else 1.0

    centralite_df = pd.DataFrame({
        "segment_id":      id_list,
        "degree_in":       [len(in_nb[sid]) for sid in id_list],
        "degree_out":      [len(out_nb[sid]) for sid in id_list],
        "degree_total":    [len(in_nb[sid] | out_nb[sid]) for sid in id_list],
        "pagerank":        [float(pr[id_to_idx[sid]]) for sid in id_list],
        "pagerank_norm":   [float(pr[id_to_idx[sid]]) / pr_max for sid in id_list],
        "radiality":       [float(radiality_raw[id_to_idx[sid]]) for sid in id_list],
        "radiality_norm":  [float(radiality_raw[id_to_idx[sid]]) / rad_max for sid in id_list],
    })

    out_centralite = DATA_DERIVEE / f"centralite_segments{suf}.parquet"
    centralite_df.to_parquet(out_centralite, index=False)

    print(f"  {n_nodes} segments traités  |  diamètre du graphe = {diameter}")
    print(f"  PageRank   — moy {centralite_df['pagerank'].mean():.2e}  "
          f"max {centralite_df['pagerank'].max():.2e}")
    print(f"  Radiality  — moy {centralite_df['radiality'].mean():.4f}  "
          f"max {centralite_df['radiality'].max():.4f}")
    print(f"  Exporté : {out_centralite}")


if __name__ == "__main__":
    for mode in ("normal", "fusion"):
        traiter(mode)
    print("\n=== Terminé ===")
# %%
