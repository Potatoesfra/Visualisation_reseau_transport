"""Tests du bilan service prévu / service réel sur un mini-horaire synthétique."""
import sys
from pathlib import Path

import pandas as pd

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE / "serveur"))

from service_prevu import FUSEAU, ServicePrevu, hhmm  # noqa: E402

H = 3600
# Jeudi 24 septembre 2026, 19:10 heure de Montréal
T = int(pd.Timestamp("2026-09-24 19:10", tz=FUSEAU).timestamp())
S_19H10 = 19 * H + 10 * 60

# [trip_id, trace, direction_id, route_id, service, début, fin, destination]
TRIPS = [
    ["vu",        0, 0, "24", 0, 18 * H + 50 * 60, 19 * H + 40 * 60, 0],   # en cours, vu
    ["manquant",  0, 1, "24", 0, 18 * H + 55 * 60, 19 * H + 45 * 60, 1],   # en cours depuis 15 min, jamais vu
    ["annule",    0, 0, "24", 0, 19 * H,           19 * H + 50 * 60, 0],   # annulé STM
    ["debut",     0, 0, "24", 0, 19 * H + 8 * 60,  20 * H,           0],   # commencé il y a 2 min
    ["fin",       0, 0, "24", 0, 18 * H,           19 * H + 11 * 60, 0],   # finit dans 1 min
    ["futur",     0, 0, "24", 0, 19 * H + 30 * 60, 20 * H,           0],   # pas commencé
    ["weekend",   0, 0, "24", 1, 18 * H,           20 * H,           0],   # service du samedi
    ["retire",    0, 0, "55", 2, 18 * H,           20 * H,           0],   # service retiré ce jour
    ["nuit",      0, 0, "355", 0, 26 * H,          27 * H,           0],   # 02:00→03:00 (service de la veille)
    ["futur_ann", 0, 0, "24", 0, 19 * H + 40 * 60, 20 * H + 30 * 60, 0],  # annulé, dans 30 min
]
CALENDRIER = {"0": ["1111111", "20260101", "20261231"],
              "1": ["0000011", "20260101", "20261231"],
              "2": ["1111111", "20260101", "20261231"]}
EXCEPTIONS = {"2": [["20260924", 2]]}
DIRECTIONS = {("24", "0"): "Est", ("24", "1"): "Ouest"}


def _service():
    index = {r[0]: i for i, r in enumerate(TRIPS)}
    return ServicePrevu(index, TRIPS, ["S", "W", "X"], CALENDRIER, EXCEPTIONS,
                        ["Est", "Ouest destination Angrignon"], DIRECTIONS)


def test_hhmm_apres_minuit():
    assert hhmm(25 * H + 5 * 60) == "01:05"
    assert hhmm(S_19H10) == "19:10"


def test_bilan_statuts():
    b = _service().bilan(T, vus={"vu"}, annules={"annule", "futur_ann"})
    statuts = {v[0]: v[6] for v in b["voyages"]}
    assert b["heure"] == "19:10" and b["jour"] == "2026-09-24"
    # Prévus maintenant : vu, manquant, annule, debut, fin (pas futur, weekend, retire, nuit)
    assert b["prevus"] == 5
    assert (b["vu"], b["annule"], b["sans_vehicule"], b["a_confirmer"]) == (1, 1, 1, 2)
    assert statuts == {"manquant": "sans_vehicule", "annule": "annule"}
    assert b["par_ligne"] == {"24": [5, 1, 1, 1]}
    manquant = next(v for v in b["voyages"] if v[0] == "manquant")
    assert manquant[2] == "Ouest" and manquant[3] == "Ouest destination Angrignon"
    assert manquant[4:6] == ["18:55", "19:45"]
    assert [v[0] for v in b["annulations_a_venir"]] == ["futur_ann"]


def test_trajet_apres_minuit_rattache_a_la_veille():
    # 00:30 le vendredi : un trajet 23:50 → 25:00 du service de jeudi est en cours ;
    # « nuit » (02:00 → 03:00 du service de jeudi) pas encore.
    trips = TRIPS + [["minuit", 0, 0, "355", 0, 23 * H + 50 * 60, 25 * H, 0]]
    index = {r[0]: i for i, r in enumerate(trips)}
    sp = ServicePrevu(index, trips, ["S", "W", "X"], CALENDRIER, EXCEPTIONS, ["Est", "Ouest"], DIRECTIONS)
    t = int(pd.Timestamp("2026-09-25 00:30", tz=FUSEAU).timestamp())
    b = sp.bilan(t, vus=set(), annules=set())
    assert b["jour"] == "2026-09-25"
    assert [v[0] for v in b["voyages"]] == ["minuit"]


def test_depassement():
    sp = _service()
    i = sp.index["fin"]                              # fin prévue 19:11
    assert sp.depassement_s(i, "20260924", T) == -60
    assert sp.depassement_s(i, "20260924", T + 10 * 60) == 9 * 60
    assert sp.depassement_s(i, None, T) is None
