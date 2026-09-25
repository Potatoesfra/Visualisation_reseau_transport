"""Tests du bus bunching / des gaps de service sur une ligne synthétique (projection unitaire : 1 « degré » = 1 m)."""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE / "serveur"))

from regularite import Regularite  # noqa: E402
from service_prevu import FUSEAU, ServicePrevu  # noqa: E402

H = 3600
T = int(pd.Timestamp("2026-09-24 19:10", tz=FUSEAU).timestamp())


def _trace(points_xy):
    xy = np.asarray(points_xy, dtype=float)
    a = xy[:-1]
    d = xy[1:] - a
    return a, d, np.maximum((d * d).sum(axis=1), 1e-9)


def _regularite():
    # Ligne X direction 0 : tracé rectiligne de 18 km (sommet intermédiaire à 9 km),
    # départs toutes les 10 min de 17:00 à 21:00, trajets de 60 min -> 5 m/s, intervalle 600 s.
    trips = [[f"t{k}", 0, 0, "X", 0, 17 * H + k * 600, 17 * H + k * 600 + H, 0] for k in range(25)]
    index = {r[0]: i for i, r in enumerate(trips)}
    sp = ServicePrevu(index, trips, ["S"], {"0": ["1111111", "20260101", "20261231"]}, {},
                      ["Est"], {("X", "0"): "Est"})
    traces = [_trace([[0, 0], [9000, 0], [18000, 0]])]
    return Regularite(sp, np.zeros(len(trips), dtype=int), traces, 1.0, 1.0)


def _bus(bid, x, y=0.0):
    return {"id": bid, "route": "X", "dir_id": 0, "direction": "Est", "lat": y, "lon": x}


def test_intervalle_et_vitesse_prevus():
    h, v = _regularite().intervalle_prevu(("X", 0), T)
    assert h == 600 and abs(v - 5.0) < 1e-9


def test_trains_trous_et_indice():
    bus = [_bus("A", 500), _bus("B", 600),      # 100 m = 20 s  -> rapport 0,03 : bunching
           _bus("C", 3600),                      # 3 000 m = 600 s -> rapport 1   : normal
           _bus("D", 11000),                     # 7 400 m = 1 480 s -> 2,47      : gap
           _bus("E", 17950),                     # à 50 m du terminus : exclu
           _bus("F", 8000, y=400)]               # à 400 m du tracé : exclu
    r = _regularite().analyser(T, bus)
    ligne = r["lignes"]["X|Est"]
    assert ligne["n_bus"] == 4 and ligne["intervalle_min"] == 10.0
    assert (ligne["n_ecarts"], ligne["n_reguliers"], ligne["indice"]) == (3, 1, 33)
    assert (ligne["trains"], ligne["trous"]) == (1, 1)
    types = {(e["suiveur"], e["meneur"]): e["type"] for e in r["ecarts"]}
    assert types == {("A", "B"): "train", ("C", "D"): "trou"}
    trou = next(e for e in r["ecarts"] if e["type"] == "trou")
    assert trou["dist_m"] == 7400 and trou["minutes"] == 24.7 and trou["rapport"] == 2.47
    # Portion de tracé du gap : de C à D, en passant par le sommet à 9 km ([lat, lon])
    assert trou["coords"][0] == [0.0, 3600.0] and trou["coords"][-1] == [0.0, 11000.0]
    assert [0.0, 9000.0] in trou["coords"]
    # Infos par bus : écarts devant/derrière, appartenance à un bunching, gap devant
    assert r["bus"]["A"]["train"] and r["bus"]["B"]["train"]
    assert r["bus"]["C"]["trou_devant"] and r["bus"]["C"]["devant_min"] == 24.7
    assert r["bus"]["B"]["derriere_min"] == 0.3
    assert "E" not in r["bus"] and "F" not in r["bus"]
    assert r["resume"] == {"indice": 33, "ecarts": 3, "trains": 1, "trous": 1}


def test_sans_intervalle_pas_de_classement():
    # À 23:30, plus aucun départ dans la fenêtre : écarts mesurés mais non classés
    t = int(pd.Timestamp("2026-09-24 23:30", tz=FUSEAU).timestamp())
    r = _regularite().analyser(t, [_bus("A", 500), _bus("B", 600)])
    ligne = r["lignes"]["X|Est"]
    assert ligne["intervalle_min"] is None and ligne["indice"] is None
    assert r["ecarts"] == [] and r["resume"]["ecarts"] == 0


def test_detour_valide_remplace_la_portion_du_trace():
    # Détour validé de x = 4000 à 6000 m par y = 1000 m (4 000 m de parcours au lieu de 2 000) ;
    # coords en [lat, lon] avec 1 « degré » = 1 m
    detour = {"id": 1, "route": "X", "dir_id": 0, "coords": [[0, 4000], [1000, 4000], [1000, 6000], [0, 6000]]}
    bus = [_bus("A", 3000), _bus("B", 5000, y=1000), _bus("C", 7000)]
    sans = _regularite().analyser(T, bus)
    assert sans["lignes"]["X|Est"]["n_bus"] == 2          # B, dans le détour, est exclu
    reg = _regularite()
    r = reg.analyser(T, bus, [detour])
    ligne = r["lignes"]["X|Est"]
    assert ligne["n_bus"] == 3 and ligne["detours"] == 1
    # Écarts le long du parcours réel : A -> B = 1 000 + 1 000 + 1 000, B -> C = 1 000 + 1 000 + 1 000
    assert r["bus"]["A"]["devant_min"] == r["bus"]["B"]["derriere_min"] == 10.0     # 3 000 m à 5 m/s
    assert r["bus"]["B"]["devant_min"] == 10.0
    # Détour disparu : retour au tracé GTFS
    assert reg.analyser(T, bus)["lignes"]["X|Est"]["n_bus"] == 2
