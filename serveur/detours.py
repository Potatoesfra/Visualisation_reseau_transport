"""
detours.py
==========
Détours observés en temps réel (GTFS-RT) : tracé estimé et validation.

Un bus est « hors tracé » à plus de SEUIL_HORS_TRACE_M du tracé GTFS de SON
trajet (même seuil que la carte). On suit chaque sortie de tracé (excursion) :

  1. entrée : dernière position sur le tracé avant la sortie ; une sortie qui
     commence à moins de MARGE_TERMINUS_M d'un terminus est ignorée (pause,
     boucle de terminus) ;
  2. chaque position hors tracé doit être sur une rue du réseau routier
     routable (à moins de ACCROCHE_RUE_M d'une rue du graphe p08) : sinon elle
     n'est pas retenue (bruit GPS, garage, stationnement) ;
  3. deux positions successives sont reliées par le plus court chemin sur ce
     réseau (sens de circulation respecté), borné à SAUT_MAX_FACTEUR × la
     distance à vol d'oiseau : le tracé estimé suit donc des rues existantes ;
  4. sortie : retour sur le tracé. Le passage est retenu s'il compte au moins
     POINTS_MIN positions hors tracé et si au moins PART_VERIFIEE_MIN d'entre
     elles ont été vérifiées sur le réseau. Un changement de trajet avant le
     retour (bus au terminus) abandonne l'excursion.

Le chemin estimé est ensuite rogné de ses rues de tête et de queue posées sur
le tracé normal (à moins de SUR_TRACE_M) : le détour commence là où le bus
quitte vraiment son parcours, et deux bus sortis à des instants différents
décrivent le même chemin.

Deux passages de la même ligne et direction décrivent le même détour s'ils
partagent au moins RECOUVREMENT_MIN de la longueur du plus court. La
validation se fait rue par rue : une portion est « validée » quand au moins
BUS_VALIDATION bus distincts l'ont empruntée (un bus encore dans son excursion
compte déjà, mais seulement pour la portion qu'il a parcourue). Le détour est
validé quand PART_VALIDEE_MIN de son tracé de référence (le passage complet le
mieux validé) l'est ; un bus est en « détour validé » quand PART_VALIDEE_MIN
de son propre chemin a aussi été emprunté par un autre bus. Les portions
parcourues par un seul bus (prolongement, variante) restent potentielles.

Un bus hors tracé sans tracé estimé en donne la raison (`RAISONS`).

Détour d'un seul bus infirmé : si un bus suivant de la même ligne/direction
franchit sur le tracé normal la portion que le détour contournait, le détour
était un mouvement ponctuel (et non une déviation) : il quitte la carte et
rejoint l'historique des « détours 1 bus », avec sa trace GPS, le tracé estimé
et ses statistiques (distance ajoutée, temps hors tracé, bus, voyage). Idem
pour un détour d'un seul bus sans nouveau passage depuis ACTIF_S (« expiré »).

Actions manuelles (clic droit sur un tracé de la carte) : valider un détour,
le supprimer (avec, au choix, une sourdine de la ligne/direction pendant N
minutes ou jusqu'à la fin de la session de la page), ou tracer un détour à la
main (points reliés par le réseau routier) : un détour tracé à la main est
validé d'office et reste affiché jusqu'à sa suppression.

Tout est en mémoire, depuis le démarrage du serveur, et n'avance que lorsque
le flux est interrogé (au moins une page ouverte).
"""
import json

import numpy as np

SEUIL_HORS_TRACE_M = 150.0
ACCROCHE_RUE_M = 40.0
NOEUD_MAX_M = 250.0
SAUT_MAX_FACTEUR = 4.0
SAUT_MARGE_M = 600.0
POINTS_MIN = 2
PART_VERIFIEE_MIN = 2 / 3     # une position sur trois peut tomber hors rue (bruit GPS)
MARGE_TERMINUS_M = 300.0
ENTREE_MAX_AGE_S = 600        # trous du flux : la dernière position sur le tracé reste l'entrée
SUR_TRACE_M = 30.0            # rue confondue avec le tracé normal (rognée du chemin)
RECOUVREMENT_MIN = 0.5
BUS_VALIDATION = 2
PART_VALIDEE_MIN = 0.8
ACTIF_S = 45 * 60           # détour affiché jusqu'à 45 min après son dernier passage
OUBLI_S = 4 * 3600
VEHICULE_PERDU_S = 10 * 60
MANUEL_ACCROCHE_M = 300.0   # point cliqué : rue du réseau à moins de 300 m
MANUEL_SAUT_MARGE_M = 3000.0
FRANCHISSEMENT_MIN_M = 50.0  # portion contournée parcourue sur le tracé normal pour infirmer
PONCTUELS_MAX = 300          # détours 1 bus gardés en mémoire (les plus anciens oubliés)

# Bus hors tracé sans tracé estimé : raison (champ detour_statut du flux)
RAISONS = {
    "attente": "première position hors tracé, tracé estimé à la suivante",
    "entree": "sortie du tracé non observée (bus apparu hors tracé ou flux interrompu)",
    "terminus": "sortie à moins de 300 m d'un terminus (boucle, pause)",
    "reseau": "positions hors des rues du réseau routier (bruit GPS, stationnement)",
    "confondu": "chemin estimé confondu avec le tracé normal",
    "supprime": "détour supprimé à la main",
    "sourdine": "ligne/direction en sourdine",
}


class IndexRues:
    """Points échantillonnés tous les `pas_m` le long des rues du graphe routier :
    distance d'une position à la rue la plus proche (KD-tree)."""

    def __init__(self, graphe, pas_m=20.0):
        from scipy.spatial import cKDTree
        self.kx, self.ky = graphe._lon_scale, graphe._lat_scale
        debuts, fins = [], []
        for c in graphe.aretes["coords"]:
            ll = np.asarray(json.loads(c) if isinstance(c, str) else c, dtype=float)   # [lat, lon]
            if len(ll) < 2:
                continue
            xy = np.c_[ll[:, 1] * self.kx, ll[:, 0] * self.ky]
            debuts.append(xy[:-1])
            fins.append(xy[1:])
        p, q = np.vstack(debuts), np.vstack(fins)
        n = np.maximum(1, (np.hypot(*(q - p).T) // pas_m).astype(int))
        i = np.repeat(np.arange(len(p)), n)
        k = np.arange(n.sum()) - np.repeat(np.cumsum(n) - n, n)
        pts = p[i] + (q - p)[i] * (k / n[i])[:, None]
        self.arbre = cKDTree(np.vstack([pts, q]))

    def distance(self, lat, lon):
        d, _ = self.arbre.query([lon * self.kx, lat * self.ky])
        return float(d)


class SuiviDetours:
    """
    `graphe` : GrapheRoutier (p08) ; `traces` : tracés GTFS en mètres [(a, d, l2)]
    (référentiel temps réel) ; `kx, ky` : projection de ces tracés (m/degré).
    """

    def __init__(self, graphe, traces, kx, ky):
        self.g = graphe
        self.traces = traces
        self.kx, self.ky = kx, ky
        self._cumul = {}
        self._rues = None             # IndexRues, construit au premier bus hors tracé
        self.vehicules = {}           # vehicule_id -> état de suivi
        self.detours = []             # détours connus (passages terminés regroupés)
        self._prochain_id = 1
        self.sourdines = {}           # (route, dir_id) -> {jusqu_a, session, direction}
        self.ponctuels = []           # détours 1 bus archivés (infirmés ou expirés)
        self._na = graphe.aretes["node_a"].to_numpy(dtype=np.int64)
        self._nb = graphe.aretes["node_b"].to_numpy(dtype=np.int64)
        self._noeud_sur = {}          # (trace, nœud) -> nœud à moins de SUR_TRACE_M du tracé
        self._coords = {}             # tuple(arêtes) -> polyline (tronçons affichés)

    # --- géométrie -------------------------------------------------------------
    def _abscisse(self, k, lat, lon, avec_distance=False):
        """(abscisse curviligne, longueur du tracé[, distance au tracé]) du point projeté sur le tracé k."""
        a, d, l2 = self.traces[k]
        if k not in self._cumul:
            long = np.sqrt(l2)
            self._cumul[k] = (np.concatenate([[0.0], np.cumsum(long)[:-1]]), float(long.sum()))
        cum, total = self._cumul[k]
        x, y = lon * self.kx, lat * self.ky
        t = np.clip(((x - a[:, 0]) * d[:, 0] + (y - a[:, 1]) * d[:, 1]) / l2, 0.0, 1.0)
        dist = np.hypot(a[:, 0] + t * d[:, 0] - x, a[:, 1] + t * d[:, 1] - y)
        j = int(np.argmin(dist))
        s = float(cum[j] + t[j] * np.sqrt(l2[j]))
        return (s, total, float(dist[j])) if avec_distance else (s, total)

    def _portion(self, k, s1, s2):
        """Portion du tracé k entre les abscisses s1 < s2, en [[lat, lon], ...]."""
        a, d, l2 = self.traces[k]
        self._abscisse(k, 0.0, 0.0)                       # cumul en cache
        cum = self._cumul[k][0]
        long = np.sqrt(l2)
        def point(s):
            j = int(np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(cum) - 1))
            return a[j] + np.clip((s - cum[j]) / long[j], 0.0, 1.0) * d[j], j
        (p1, j1), (p2, j2) = point(s1), point(s2)
        xy = np.vstack([p1, a[j1 + 1:j2 + 1], p2])
        return np.round(np.c_[xy[:, 1] / self.ky, xy[:, 0] / self.kx], 5).tolist()

    def _vol_oiseau(self, n1, n2):
        g = self.g
        return float(np.hypot((g._lons[n1] - g._lons[n2]) * g._lon_scale,
                              (g._lats[n1] - g._lats[n2]) * g._lat_scale))

    def _longueur(self, aretes):
        return float(sum(self.g._dist[e] for e in aretes))

    def _recouvrement(self, a, b):
        commun = self._longueur(a & b)
        plus_court = min(self._longueur(a), self._longueur(b))
        return commun / plus_court if plus_court > 0 else 0.0

    def _sur_trace(self, k, n):
        cle = (k, int(n))
        if cle not in self._noeud_sur:
            if len(self._noeud_sur) > 200_000:
                self._noeud_sur.clear()
            self._noeud_sur[cle] = self._abscisse(k, self.g._lats[n], self.g._lons[n], avec_distance=True)[2] <= SUR_TRACE_M
        return self._noeud_sur[cle]

    def _coeur(self, k, chemin):
        """Chemin sans ses arêtes de tête et de queue posées sur le tracé normal k."""
        sur = lambda e: self._sur_trace(k, self._na[e]) and self._sur_trace(k, self._nb[e])
        i, j = 0, len(chemin)
        while i < j and sur(chemin[i]):
            i += 1
        while j > i and sur(chemin[j - 1]):
            j -= 1
        return chemin[i:j]

    def _coeur_exc(self, exc):
        """Chemin rogné de l'excursion (mis en cache tant qu'il ne s'allonge pas)."""
        if exc.get("_n") != len(exc["chemin"]):
            exc["_coeur"], exc["_n"] = self._coeur(exc["k"], exc["chemin"]), len(exc["chemin"])
        return exc["_coeur"]

    def _polyline(self, aretes):
        cle = tuple(aretes)
        if cle not in self._coords:
            if len(self._coords) > 5000:
                self._coords.clear()
            self._coords[cle] = [[round(la, 5), round(lo, 5)] for la, lo in self.g.coords_chemin(list(aretes))]
        return self._coords[cle]

    # --- excursions --------------------------------------------------------------
    def _relier(self, exc, lat, lon):
        """Ajoute une position au chemin estimé de l'excursion. Renvoie True si
        la position est sur une rue du réseau et reliée par un chemin routier."""
        if self._rues.distance(lat, lon) > ACCROCHE_RUE_M:
            return False
        noeud = self.g.noeud_le_plus_proche(lat, lon, NOEUD_MAX_M)
        if noeud is None:
            return False
        if exc["noeud"] is not None and noeud != exc["noeud"]:
            borne = SAUT_MAX_FACTEUR * self._vol_oiseau(exc["noeud"], noeud) + SAUT_MARGE_M
            chemin = self.g.plus_court_chemin(exc["noeud"], noeud, distance_max=borne)
            if chemin is None:
                return False
            exc["chemin"].extend(chemin)
        exc["noeud"] = noeud
        return True

    def _ouvrir(self, st, t):
        """Nouvelle excursion depuis la dernière position sur le tracé (ou None si
        l'entrée est inconnue, trop ancienne ou au terminus)."""
        sur = st["dernier_sur"]
        if sur is None or t - sur[2] > ENTREE_MAX_AGE_S:
            return {"invalide": True, "raison": "entree"}
        s, total = self._abscisse(st["k"], sur[0], sur[1])
        if s < MARGE_TERMINUS_M or s > total - MARGE_TERMINUS_M:
            return {"invalide": True, "raison": "terminus"}
        exc = {"invalide": False, "noeud": None, "chemin": [], "points": 0, "verifies": 0, "k": st["k"],
               "t0": sur[2], "entree": sur[:2], "gps": [list(sur)], "s_entree": s}
        self._relier(exc, sur[0], sur[1])
        return exc

    def _raison(self, exc):
        """None si l'excursion est retenue (tracé estimé), sinon la raison (clé de RAISONS)."""
        if exc["invalide"]:
            return exc.get("raison", "supprime")
        if exc["points"] < POINTS_MIN:
            return "attente"
        if not exc["chemin"] or exc["verifies"] / exc["points"] < PART_VERIFIEE_MIN:
            return "reseau"
        if not self._coeur_exc(exc):
            return "confondu"
        return None

    def _retenue(self, exc):
        return self._raison(exc) is None

    def _chercher(self, route, dir_id, aretes, exclure=None):
        for d in self.detours:
            if d is exclure or d["route"] != route or d["dir_id"] != dir_id:
                continue
            if self._recouvrement(d["aretes"], aretes) >= RECOUVREMENT_MIN:
                return d
        return None

    def _terminer(self, vid, st, t, sortie):
        exc = st["exc"]
        st["exc"] = None
        if not self._retenue(exc):
            return
        coeur = self._coeur_exc(exc)
        aretes = set(coeur)
        d = self._chercher(st["route"], st["dir_id"], aretes)
        if d is None:
            d = self._nouveau(st["route"], st["dir_id"], st["direction"], coeur, exc["t0"], t)
        else:
            d["aretes"] |= aretes         # prolongements et variantes : comparés aux passages suivants
        # Détail du passage : trace GPS, entrée/sortie sur le tracé du voyage (statistiques)
        d.setdefault("detail", []).append({
            "bus": vid, "trip": st["trip"], "trip_debut": st.get("trip_debut"), "k": st["k"],
            "t0": exc["t0"], "t1": t, "gps": exc["gps"] + [[sortie[0], sortie[1], t]],
            "chemin": list(exc["chemin"]), "coeur": list(coeur), "s_entree": exc["s_entree"],
            "s_sortie": self._abscisse(st["k"], sortie[0], sortie[1])[0]})
        d["bus"].add(vid)
        d["passages"] += 1
        d["dernier"] = t

    def _archiver(self, d, t, motif, par=None):
        """Détour d'un seul bus → historique des « détours 1 bus » (retiré de la carte)."""
        self.detours.remove(d)
        p = d["detail"][0]
        longueur = float(sum(self.g._dist[e] for e in p["chemin"]))   # distance parcourue (ordre du trajet)
        nominale = max(0.0, p["s_sortie"] - p["s_entree"])
        self.ponctuels.append({
            "id": f"u{d['id']}", "route": d["route"], "direction": d["direction"], "dir_id": d["dir_id"],
            "bus": p["bus"], "trip_id": p["trip"], "trip_debut": p["trip_debut"],
            "debut": int(p["t0"]), "fin": int(p["t1"]), "duree_s": int(p["t1"] - p["t0"]),
            "longueur_m": round(longueur), "distance_nominale_m": round(nominale),
            "distance_ajoutee_m": round(longueur - nominale), "n_gps": len(p["gps"]),
            "motif": motif, "infirme_par": par, "t_archive": int(t),
            "_coords": [[round(la, 5), round(lo, 5)] for la, lo in self.g.coords_chemin(p["chemin"])],
            "_gps": [[round(la, 5), round(lo, 5), int(tp)] for la, lo, tp in p["gps"]],
            "_nominal": self._portion(p["k"], p["s_entree"], p["s_sortie"]) if nominale > 0 else [],
        })
        del self.ponctuels[:-PONCTUELS_MAX]

    def _un_seul_bus(self, d):
        return not d["manuel"] and not d["force"] and len(d["bus"]) == 1 and d.get("detail")

    def _infirmer(self, route, dir_id, vid, avant, apres):
        """Un bus a roulé sur son tracé de `avant` à `apres` ([lat, lon, t]) : infirme les
        détours d'un seul bus de la ligne/direction dont il a parcouru la portion contournée."""
        for d in [d for d in self.detours if d["route"] == route and d["dir_id"] == dir_id
                  and self._un_seul_bus(d) and avant[2] > d["dernier"]]:
            p = d["detail"][0]
            s1, _, e1 = self._abscisse(p["k"], avant[0], avant[1], avec_distance=True)
            s2, _, e2 = self._abscisse(p["k"], apres[0], apres[1], avec_distance=True)
            if max(e1, e2) > SEUIL_HORS_TRACE_M or s2 <= s1:
                continue
            requis = min(FRANCHISSEMENT_MIN_M, (p["s_sortie"] - p["s_entree"]) / 2)
            if requis > 0 and min(s2, p["s_sortie"]) - max(s1, p["s_entree"]) >= requis:
                self._archiver(d, apres[2], "infirme", vid)

    def etat_ponctuels(self):
        """Détours 1 bus archivés, sans géométrie (voir `ponctuel`)."""
        return [{k: v for k, v in p.items() if not k.startswith("_")} for p in self.ponctuels]

    def ponctuel(self, id_):
        for p in self.ponctuels:
            if p["id"] == str(id_):
                return {**{k: v for k, v in p.items() if not k.startswith("_")},
                        "coords": p["_coords"], "gps": p["_gps"], "nominal": p["_nominal"]}
        raise KeyError(f"Détour 1 bus {id_} introuvable (oublié depuis ?)")

    def _nouveau(self, route, dir_id, direction, chemin, debut, t, **options):
        d = {"id": self._prochain_id, "route": route, "dir_id": dir_id, "direction": direction,
             "aretes": set(chemin), "chemin": list(chemin), "bus": set(), "passages": 0,
             "debut": debut, "dernier": t, "coords": None, "manuel": False, "force": False, **options}
        self._prochain_id += 1
        self.detours.append(d)
        return d

    # --- actions manuelles (clic droit sur la carte) -----------------------------------
    def _excursions_de(self, route, dir_id, aretes):
        """Véhicules dont l'excursion en cours recouvre ce tracé."""
        for vid, st in self.vehicules.items():
            exc = st["exc"]
            if (exc and not exc["invalide"] and st["route"] == route and st["dir_id"] == dir_id
                    and exc["chemin"] and self._recouvrement(set(self._coeur_exc(exc)), aretes) >= RECOUVREMENT_MIN):
                yield vid, st

    def _resoudre(self, id_):
        """Détour connu, ou (None, véhicule) pour un détour provisoire « p<vehicule> »."""
        for d in self.detours:
            if str(d["id"]) == str(id_):
                return d, None
        vid = str(id_)[1:] if str(id_).startswith("p") else None
        st = self.vehicules.get(vid) if vid is not None else None
        if st is None or st["exc"] is None or not self._retenue(st["exc"]):
            raise KeyError(f"Détour {id_} introuvable (terminé ou déjà supprimé ?)")
        return None, (vid, st)

    def valider(self, id_, t):
        """Validation manuelle (un seul bus suffit). Renvoie l'id du détour."""
        d, prov = self._resoudre(id_)
        if d is None:
            vid, st = prov
            d = self._nouveau(st["route"], st["dir_id"], st["direction"], self._coeur_exc(st["exc"]), st["exc"]["t0"], t)
        d["force"] = True
        return d["id"]

    def supprimer(self, id_, t, minutes=None, session=None):
        """Supprime le détour (et ignore les excursions en cours qui le suivent). Avec
        `minutes` ou `session` : sourdine de la ligne/direction."""
        d, prov = self._resoudre(id_)
        if d is not None:
            self.detours.remove(d)
            route, dir_id, direction, aretes = d["route"], d["dir_id"], d["direction"], d["aretes"]
        else:
            vid, st = prov
            route, dir_id, direction, aretes = st["route"], st["dir_id"], st["direction"], set(self._coeur_exc(st["exc"]))
        for _, st in list(self._excursions_de(route, dir_id, aretes)):
            st["exc"]["invalide"] = True      # jusqu'à ce que le bus rejoigne son tracé
            st["exc"]["raison"] = "supprime"
        if minutes is not None or session is not None:
            self.sourdines[(route, dir_id)] = {
                "jusqu_a": None if minutes is None else int(t + 60 * float(minutes)),
                "session": session if minutes is None else None, "direction": direction}

    def _router(self, points):
        """Points [[lat, lon], ...] reliés par le plus court chemin routier."""
        noeuds = []
        for i, (la, lo) in enumerate(points, 1):
            n = self.g.noeud_le_plus_proche(float(la), float(lo), MANUEL_ACCROCHE_M)
            if n is None:
                raise ValueError(f"Point {i} : aucune rue du réseau routier à moins de {MANUEL_ACCROCHE_M:.0f} m.")
            if not noeuds or noeuds[-1] != n:
                noeuds.append(n)
        if len(noeuds) < 2:
            raise ValueError("Au moins deux points distincts sont nécessaires.")
        chemin = []
        for i, (n1, n2) in enumerate(zip(noeuds, noeuds[1:]), 1):
            morceau = self.g.plus_court_chemin(n1, n2, distance_max=SAUT_MAX_FACTEUR * self._vol_oiseau(n1, n2) + MANUEL_SAUT_MARGE_M)
            if morceau is None:
                raise ValueError(f"Pas de chemin routier du point {i} au point {i + 1} (sens de circulation ?).")
            chemin.extend(morceau)
        return chemin

    def apercu(self, points):
        chemin = self._router(points)
        return {"coords": [[round(la, 5), round(lo, 5)] for la, lo in self.g.coords_chemin(chemin)],
                "longueur_m": round(self._longueur(set(chemin)))}

    def tracer(self, route, dir_id, direction, points, t, remplace=None):
        """Détour tracé à la main : validé d'office, affiché jusqu'à sa suppression."""
        chemin = self._router(points)
        if remplace is not None:
            try:
                self.supprimer(remplace, t)
            except KeyError:
                pass
        self.sourdines.pop((route, dir_id), None)
        return self._nouveau(route, dir_id, direction, chemin, t, t, manuel=True, force=True)["id"]

    def lever_sourdine(self, route=None, dir_id=None, session=None):
        """Lève la sourdine d'une ligne/direction, ou toutes celles d'une session de page."""
        for cle in [c for c, v in self.sourdines.items()
                    if (session is not None and v["session"] == session) or c == (route, dir_id)]:
            del self.sourdines[cle]

    def etat_sourdines(self, t):
        return [{"route": r, "dir_id": di, "direction": v["direction"], "jusqu_a": v["jusqu_a"],
                 "session": v["session"]} for (r, di), v in self.sourdines.items()
                if v["jusqu_a"] is None or v["jusqu_a"] > t]

    # --- mise à jour (un appel par instantané du flux) ---------------------------------
    def mettre_a_jour(self, t, bus):
        """
        `bus` : [{id, trip, k, route, dir_id, direction, lat, lon, ecart, t_position}]
        (bus rattachés à un trajet du référentiel). Renvoie (détours à afficher,
        {vehicule_id: (id_détour, "valide" | "potentiel")}).
        """
        for cle in [c for c, v in self.sourdines.items() if v["jusqu_a"] is not None and v["jusqu_a"] <= t]:
            del self.sourdines[cle]
        for b in bus:
            vid = b["id"]
            st = self.vehicules.get(vid)
            if st is None or st["trip"] != b["trip"]:
                # Nouveau trajet : une excursion non refermée (terminus) est abandonnée
                st = {"trip": b["trip"], "k": b["k"], "route": b["route"], "dir_id": b["dir_id"],
                      "direction": b["direction"], "dernier_sur": None, "exc": None, "t_pos": None,
                      "trip_debut": b.get("trip_debut")}
                self.vehicules[vid] = st
            st["vu"] = t
            tp = b["t_position"] or t
            if tp == st["t_pos"]:
                continue                 # même position (flux publié aux 20 s, cache 10 s)
            st["t_pos"] = tp
            st["muet"] = (b["route"], b["dir_id"]) in self.sourdines
            st["hors"] = b["ecart"] > SEUIL_HORS_TRACE_M
            if st["muet"]:                    # ligne/direction en sourdine : pas de suivi
                st["exc"] = None
                if b["ecart"] <= SEUIL_HORS_TRACE_M:
                    st["dernier_sur"] = (b["lat"], b["lon"], tp)
                continue
            if b["ecart"] <= SEUIL_HORS_TRACE_M:
                if st["exc"] is not None:
                    if not st["exc"]["invalide"]:
                        self._relier(st["exc"], b["lat"], b["lon"])   # retour sur le tracé
                    self._terminer(vid, st, tp, (b["lat"], b["lon"]))
                elif st["dernier_sur"] is not None and tp - st["dernier_sur"][2] <= ENTREE_MAX_AGE_S:
                    self._infirmer(b["route"], b["dir_id"], vid, st["dernier_sur"], (b["lat"], b["lon"], tp))
                st["dernier_sur"] = (b["lat"], b["lon"], tp)
                continue
            if st["exc"] is None:
                if self._rues is None:
                    self._rues = IndexRues(self.g)
                st["exc"] = self._ouvrir(st, tp)
            exc = st["exc"]
            if not exc["invalide"]:
                exc["points"] += 1
                exc["verifies"] += self._relier(exc, b["lat"], b["lon"])
                exc["gps"].append([b["lat"], b["lon"], tp])

        for vid in [v for v, st in self.vehicules.items() if t - st["vu"] > VEHICULE_PERDU_S]:
            del self.vehicules[vid]
        # Détour d'un seul bus sans nouveau passage : ponctuel, lui aussi
        en_cours = [set(self._coeur_exc(st["exc"])) for st in self.vehicules.values()
                    if st["exc"] and self._retenue(st["exc"])]
        for d in [d for d in self.detours if self._un_seul_bus(d) and t - d["dernier"] > ACTIF_S]:
            if not any(self._recouvrement(d["aretes"], a) >= RECOUVREMENT_MIN for a in en_cours):
                self._archiver(d, t, "expire")
        self.detours = [d for d in self.detours if d["manuel"] or t - d["dernier"] <= OUBLI_S]
        return self._etat(t)

    def _etat(self, t):
        """Détours actifs (connus + excursions en cours), statut des bus et, pour
        chaque détour, ses tronçons validés (≥ BUS_VALIDATION bus) ou potentiels."""
        rattaches = {}                   # id(détour) -> [(vehicule_id, chemin rogné)]
        provisoires = []                 # excursions en cours sans détour connu
        statut_bus = {}
        for vid, st in self.vehicules.items():
            exc = st["exc"]
            if exc is None:
                if st.get("muet") and st.get("hors"):
                    statut_bus[vid] = (None, "sourdine")
                continue
            raison = self._raison(exc)
            if raison is not None:
                statut_bus[vid] = (None, raison)
                continue
            coeur = self._coeur_exc(exc)
            aretes = set(coeur)
            d = self._chercher(st["route"], st["dir_id"], aretes)
            if d is None:
                d = next((p for p in provisoires if p["route"] == st["route"] and p["dir_id"] == st["dir_id"]
                          and self._recouvrement(p["aretes"], aretes) >= RECOUVREMENT_MIN), None)
                if d is None:
                    d = {"id": f"p{vid}", "route": st["route"], "dir_id": st["dir_id"],
                         "direction": st["direction"], "aretes": set(), "chemin": list(coeur),
                         "bus": set(), "passages": 0, "debut": exc["t0"], "dernier": t, "coords": None,
                         "manuel": False, "force": False}
                    provisoires.append(d)
                d["aretes"] = d["aretes"] | aretes
            rattaches.setdefault(id(d), []).append((vid, coeur))

        out = []
        for d in self.detours + provisoires:
            if (d["route"], d["dir_id"]) in self.sourdines:
                continue
            actuels = rattaches.get(id(d), [])
            if not actuels and not d["manuel"] and t - d["dernier"] > ACTIF_S:
                continue
            passages = [(p["bus"], p.get("coeur", p["chemin"])) for p in d.get("detail", [])]
            # Bus distincts par rue : une portion n'est validée que si ≥ 2 bus l'ont parcourue
            bus_arete = {}
            for vid, ch in passages + actuels:
                for e in ch:
                    bus_arete.setdefault(e, set()).add(vid)
            ok = (lambda e: True) if d["force"] else (lambda e: len(bus_arete.get(e, ())) >= BUS_VALIDATION)
            long_ok = lambda ch: sum(self.g._dist[e] for e in set(ch) if ok(e))
            # Tracé de référence : le passage complet le mieux validé (régularité, longueur)
            ref = max([d["chemin"]] + [ch for _, ch in passages], key=lambda ch: (long_ok(ch), self._longueur(set(ch))))
            longueur = self._longueur(set(ref))
            validee = long_ok(ref)
            valide = d["force"] or (longueur > 0 and validee / longueur >= PART_VALIDEE_MIN)
            for vid, ch in actuels:
                a_moi = set(ch)
                propre = self._longueur(a_moi)
                part = sum(self.g._dist[e] for e in a_moi if d["force"] or len(bus_arete[e] - {vid}) >= 1)
                statut_bus[vid] = (d["id"], "valide" if d["force"] or (propre > 0 and part / propre >= PART_VALIDEE_MIN)
                                   else "potentiel")
            if d.get("_ref") != ref:
                d["_ref"], d["coords"] = list(ref), self._polyline(ref)
            tous = d["bus"] | {vid for vid, _ in actuels}
            en_cours = sorted({vid for vid, _ in actuels})
            out.append({
                "id": d["id"], "route": d["route"], "direction": d["direction"], "dir_id": d["dir_id"],
                "valide": bool(valide), "n_bus": len(tous), "bus": sorted(tous), "en_cours": en_cours,
                "passages": d["passages"], "debut": int(d["debut"]), "dernier": int(max(d["dernier"], t if actuels else 0)),
                "longueur_m": round(longueur), "longueur_validee_m": round(longueur if d["force"] else validee),
                "coords": d["coords"], "troncons": self._troncons([ref] + [ch for _, ch in passages + actuels], ok),
                "manuel": d["manuel"], "force": d["force"],
            })
        out.sort(key=lambda x: (not x["valide"], -x["n_bus"], str(x["route"])))
        return out, statut_bus

    def _troncons(self, chemins, ok):
        """Union des chemins découpée en tronçons continus de même statut :
        [{coords, valide}] (chaque rue une seule fois, la référence d'abord)."""
        emises, sortie = set(), []
        for ch in chemins:
            morceau, etat = [], None
            for e in list(ch) + [None]:
                v = None if e is None or e in emises else bool(ok(e))
                if morceau and v != etat:
                    sortie.append({"coords": self._polyline(morceau), "valide": etat})
                    morceau = []
                if v is not None:
                    emises.add(e)
                    morceau.append(e)
                    etat = v
        return sortie
