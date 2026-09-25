"""
regularite.py
=============
Régularité du service en temps réel : bus bunching et gaps de service.

Pour chaque ligne et direction, les bus sont projetés sur le tracé principal
(le tracé le plus fréquent des trajets de cette ligne/direction dans le GTFS en
vigueur) et ordonnés par abscisse curviligne, dans le sens de circulation.
L'écart entre deux bus consécutifs, en mètres, est converti en minutes par la
vitesse commerciale prévue (longueur du tracé / durée prévue des trajets autour
de maintenant), puis rapporté à l'intervalle prévu (écart médian entre départs
prévus autour de maintenant) :

  rapport = écart observé / intervalle prévu
  train de bus     rapport < SEUIL_TRAIN  (bunching : définition usuelle 25 %)
  gap de service   rapport > SEUIL_TROU
  indice de régularité d'une ligne/direction : part des écarts dont le
  rapport est dans [0,5 ; 1,5] (au moins 2 écarts, soit 3 bus placés).

Détours validés (serveur/detours.py) : le tracé principal de la ligne/direction
est remplacé, entre l'entrée et la sortie du détour, par le tracé estimé du
détour. Les bus qui l'empruntent sont donc placés, et les écarts (et le tracé
des gaps de service) suivent le parcours réel.

Bus non pris en compte :
  - à plus de ECART_MAX_M du tracé (principal, ou modifié par un détour validé) ;
  - à moins de MARGE_TERMINUS_M d'un terminus (pause, bus déjà affecté à son
    trajet suivant ~5 min avant son départ) : ils fausseraient les écarts.

Sans intervalle prévu (moins de 2 départs dans la fenêtre), les écarts sont
donnés en mètres/minutes mais ne sont pas classés.
"""
from collections import Counter, defaultdict

import numpy as np

SEUIL_TRAIN = 0.25
SEUIL_TROU = 2.0
REGULIER = (0.5, 1.5)
ECART_MAX_M = 250.0
MARGE_TERMINUS_M = 150.0
FENETRE_AVANT_S = 45 * 60    # départs prévus pris en compte : [maintenant - 45 min,
FENETRE_APRES_S = 15 * 60    #                                 maintenant + 15 min]
CACHE_INTERVALLES_S = 300
DETOUR_LONGUEUR_MIN_M = 20.0   # portion du tracé remplacée par un détour : au moins 20 m


class Regularite:
    """
    `sp` : ServicePrevu (horaire du référentiel) ; `trace_par_trip` : index du
    tracé de chaque trajet (même rang que sp.index) ; `traces` : tracés en
    mètres [(a, d, l2)] (sommets, vecteurs des tronçons, longueurs²) ;
    `kx, ky` : projection locale (m/degré).
    """

    def __init__(self, sp, trace_par_trip, traces, kx, ky):
        self.sp = sp
        self.traces = traces
        self.kx, self.ky = kx, ky
        self.long_trace = np.array([float(np.sqrt(l2).sum()) for _, _, l2 in traces])
        # Abscisse cumulée au début de chaque tronçon, par tracé (calculée à la demande)
        self._cumul = {}
        # Trajets groupés par (ligne, direction_id), triés par heure de début
        groupes = defaultdict(list)
        for i in range(len(sp.trip_ids)):
            groupes[(sp.route[i], int(sp.direction_id[i]))].append(i)
        self.trips = {}
        self.principal = {}
        for cle, idx in groupes.items():
            idx = np.array(sorted(idx, key=lambda i: sp.debut[i]), dtype=np.int64)
            self.trips[cle] = idx
            self.principal[cle] = Counter(int(trace_par_trip[i]) for i in idx).most_common(1)[0][0]
        self.trace_par_trip = trace_par_trip
        self._intervalles = {}
        self._mods = {}   # (route, dir_id) -> tracé principal modifié par les détours validés

    # --- géométrie -----------------------------------------------------------
    # k : indice d'un tracé GTFS, ou ("mod", clé) pour un tracé modifié par des détours
    def _geo(self, k):
        return self._mods[k[1]]["trace"] if isinstance(k, tuple) else self.traces[k]

    def _longueur(self, k):
        return self._mods[k[1]]["longueur"] if isinstance(k, tuple) else self.long_trace[k]

    def _cumul_trace(self, k):
        if isinstance(k, tuple):
            return self._mods[k[1]]["cumul"]
        if k not in self._cumul:
            _, _, l2 = self.traces[k]
            self._cumul[k] = np.concatenate([[0.0], np.cumsum(np.sqrt(l2))[:-1]])
        return self._cumul[k]

    def _tracer_detours(self, cle, detours):
        """Tracé principal de `cle` où chaque détour validé remplace la portion entre ses
        extrémités (projetées sur le tracé). Renvoie la clé du tracé à utiliser."""
        k = self.principal[cle]
        signature = tuple((d["id"], len(d["coords"])) for d in detours)
        mod = self._mods.get(cle)
        if mod is not None and mod["signature"] == signature:
            return ("mod", cle) if mod["trace"] is not None else k
        a, d, _ = self.traces[k]
        pts = np.vstack([a, a[-1] + d[-1]])
        cum = np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(pts, axis=0).T))])
        morceaux = []   # (s_entree, s_sortie, points du détour en m)
        for det in detours:
            xy = np.asarray(det["coords"], dtype=float)[:, ::-1] * (self.kx, self.ky)
            if len(xy) < 2:
                continue
            (s1, e1), (s2, e2) = (self.projeter(k, *det["coords"][0]), self.projeter(k, *det["coords"][-1]))
            if max(e1, e2) > ECART_MAX_M or s2 - s1 < DETOUR_LONGUEUR_MIN_M:
                continue   # extrémités loin du tracé principal (variante), ou sens inverse
            morceaux.append((s1, s2, xy))
        morceaux.sort(key=lambda m: m[0])
        garde, fin = [], -1.0
        for m in morceaux:            # détours qui se chevauchent : le premier l'emporte
            if m[0] >= fin:
                garde.append(m)
                fin = m[1]
        if not garde:
            self._mods[cle] = {"signature": signature, "trace": None}
            return k
        interp = lambda s: np.array([np.interp(s, cum, pts[:, 0]), np.interp(s, cum, pts[:, 1])])
        sortie, s_prec = [], 0.0
        for s1, s2, xy in garde:
            sortie.append(pts[(cum >= s_prec) & (cum < s1)])
            sortie.append(np.vstack([interp(s1), xy, interp(s2)]))
            s_prec = s2
        sortie.append(pts[cum > s_prec])
        xy = np.vstack([m for m in sortie if len(m)])
        xy = xy[np.r_[True, np.hypot(*np.diff(xy, axis=0).T) > 1e-6]]   # sommets confondus
        am, dm = xy[:-1], np.diff(xy, axis=0)
        l2 = np.maximum((dm * dm).sum(axis=1), 1e-9)
        long = np.sqrt(l2)
        self._mods[cle] = {"signature": signature, "trace": (am, dm, l2), "longueur": float(long.sum()),
                           "cumul": np.concatenate([[0.0], np.cumsum(long)[:-1]]), "n": len(garde)}
        return ("mod", cle)

    def projeter(self, k, lat, lon):
        """(abscisse curviligne en m, distance au tracé en m) du point sur le tracé k."""
        a, d, l2 = self._geo(k)
        x, y = lon * self.kx, lat * self.ky
        t = np.clip(((x - a[:, 0]) * d[:, 0] + (y - a[:, 1]) * d[:, 1]) / l2, 0.0, 1.0)
        dist = np.hypot(a[:, 0] + t * d[:, 0] - x, a[:, 1] + t * d[:, 1] - y)
        j = int(np.argmin(dist))
        return float(self._cumul_trace(k)[j] + t[j] * np.sqrt(l2[j])), float(dist[j])

    def sous_trace(self, k, s1, s2):
        """Portion du tracé k entre les abscisses s1 < s2, en [[lat, lon], ...]."""
        a, d, l2 = self._geo(k)
        cum = self._cumul_trace(k)
        long = np.sqrt(l2)
        def point(s):
            j = int(np.clip(np.searchsorted(cum, s, side="right") - 1, 0, len(cum) - 1))
            u = np.clip((s - cum[j]) / long[j], 0.0, 1.0)
            return a[j] + u * d[j], j
        p1, j1 = point(s1)
        p2, j2 = point(s2)
        xy = np.vstack([p1, a[j1 + 1:j2 + 1], p2])
        return np.round(np.c_[xy[:, 1] / self.ky, xy[:, 0] / self.kx], 5).tolist()

    def point(self, k, s):
        return self.sous_trace(k, s, s)[0]

    # --- horaire ---------------------------------------------------------------
    def intervalle_prevu(self, cle, t):
        """(intervalle prévu en s, vitesse commerciale prévue en m/s) autour de t, ou (None, None)."""
        tranche = int(t // CACHE_INTERVALLES_S)
        cache = self._intervalles.get(cle)
        if cache and cache[0] == tranche:
            return cache[1], cache[2]
        idx = self.trips.get(cle)
        debuts, vitesses = [], []
        if idx is not None:
            for date, s in self.sp.fenetres(t):
                actif = self.sp.services_actifs(date)[self.sp.service[idx]]
                deb = self.sp.debut[idx]
                m = actif & (deb >= s - FENETRE_AVANT_S) & (deb <= s + FENETRE_APRES_S)
                sel = idx[m]
                debuts.extend(self.sp.debut[sel].tolist())
                duree = (self.sp.fin[sel] - self.sp.debut[sel]).astype(float)
                ok = duree > 0
                vitesses.extend((self.long_trace[self.trace_par_trip[sel[ok]]] / duree[ok]).tolist())
        h = float(np.median(np.diff(np.sort(debuts)))) if len(debuts) >= 2 else None
        if h is not None and h <= 0:
            h = None
        v = float(np.median(vitesses)) if vitesses else None
        self._intervalles[cle] = (tranche, h, v)
        return h, v

    # --- analyse ---------------------------------------------------------------
    def analyser(self, t, bus, detours=None):
        """
        `bus` : liste de dicts {id, route, dir_id, direction, lat, lon, i_trip}.
        `detours` : détours validés [{id, route, dir_id, coords}] (tracé estimé, [lat, lon]).
        Renvoie {"lignes": {...}, "ecarts": [...], "bus": {id: {...}}, "resume": {...}}.
        """
        par_cle = defaultdict(list)
        for b in bus:
            par_cle[(b["route"], b["dir_id"])].append(b)
        detours_cle = defaultdict(list)
        for d in (detours or []):
            detours_cle[(d["route"], d["dir_id"])].append(d)
        for cle in [c for c in self._mods if c not in detours_cle]:
            del self._mods[cle]      # détour disparu : retour au tracé GTFS

        lignes, ecarts, par_bus = {}, [], {}
        n_reg = n_ecarts = 0
        for cle, groupe in par_cle.items():
            k = self.principal.get(cle)
            if k is None:
                continue
            if cle in detours_cle:
                k = self._tracer_detours(cle, detours_cle[cle])
            longueur = self._longueur(k)
            places = []
            for b in groupe:
                s, dist = self.projeter(k, b["lat"], b["lon"])
                if dist > ECART_MAX_M or s < MARGE_TERMINUS_M or s > longueur - MARGE_TERMINUS_M:
                    continue
                places.append((s, b))
            places.sort(key=lambda p: p[0])
            h, v = self.intervalle_prevu(cle, t)
            route, direction = cle[0], groupe[0]["direction"]
            rapports = []
            for (s1, b1), (s2, b2) in zip(places, places[1:]):
                dist_m = s2 - s1
                minutes = dist_m / v / 60 if v else None
                rapport = (dist_m / v) / h if (v and h) else None
                type_ = None
                if rapport is not None:
                    rapports.append(rapport)
                    type_ = "train" if rapport < SEUIL_TRAIN else "trou" if rapport > SEUIL_TROU else "normal"
                e = {"route": route, "direction": direction, "suiveur": b1["id"], "meneur": b2["id"],
                     "dist_m": round(dist_m), "minutes": None if minutes is None else round(minutes, 1),
                     "rapport": None if rapport is None else round(rapport, 2), "type": type_}
                if type_ == "trou":
                    e["coords"] = self.sous_trace(k, s1, s2)
                elif type_ == "train":
                    e["point"] = self.point(k, (s1 + s2) / 2)
                if type_ in ("train", "trou"):
                    ecarts.append(e)
                # Écarts devant/derrière chaque bus (infobulles)
                par_bus.setdefault(b1["id"], {})["devant_min"] = e["minutes"]
                par_bus.setdefault(b2["id"], {})["derriere_min"] = e["minutes"]
                for bid in (b1["id"], b2["id"]):
                    if type_ == "train":
                        par_bus[bid]["train"] = True
                if type_ == "trou":
                    par_bus[b1["id"]]["trou_devant"] = True
            regulier = [r for r in rapports if REGULIER[0] <= r <= REGULIER[1]]
            n_reg += len(regulier)
            n_ecarts += len(rapports)
            if len(places) < 2:
                continue   # aucun écart mesurable sur cette ligne/direction
            lignes[f"{route}|{direction or cle[1]}"] = {
                "route": route, "direction": direction, "n_bus": len(places),
                "intervalle_min": None if h is None else round(h / 60, 1),
                "indice": round(100 * len(regulier) / len(rapports)) if len(rapports) >= 2 else None,
                # comptes bruts : agrégation sur un périmètre quelconque (tableau de bord)
                "n_ecarts": len(rapports), "n_reguliers": len(regulier),
                "trains": sum(r < SEUIL_TRAIN for r in rapports),
                "trous": sum(r > SEUIL_TROU for r in rapports),
                "detours": self._mods[cle]["n"] if isinstance(k, tuple) else 0,   # tracé adapté aux détours
            }
        return {
            "lignes": lignes, "ecarts": ecarts, "bus": par_bus,
            "resume": {"indice": round(100 * n_reg / n_ecarts) if n_ecarts else None,
                       "ecarts": n_ecarts,
                       "trains": sum(e["type"] == "train" for e in ecarts),
                       "trous": sum(e["type"] == "trou" for e in ecarts)},
        }
