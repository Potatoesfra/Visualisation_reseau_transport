"""Tests du suivi des détours (serveur/detours.py) sur un réseau routier synthétique en grille.

Grille de 11 × 3 intersections espacées de 200 m (rues à double sens). Le tracé
GTFS suit la rangée du bas ; le détour passe par la rangée du milieu (200 m au
nord, donc hors tracé) entre x = 800 et x = 1200 m.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE / "serveur"))

from detours import SuiviDetours  # noqa: E402
from modele_physique import GrapheRoutier  # noqa: E402

LAT0, LON0 = 45.5, -73.6
KX = 111_320 * np.cos(np.radians(45.5))
KY = 110_950
PAS = 200.0


def ll(x, y):
    return LAT0 + y / KY, LON0 + x / KX


@pytest.fixture(scope="module")
def graphe(tmp_path_factory):
    d = tmp_path_factory.mktemp("graphe")
    noeuds, aretes = [], []
    nid = lambda i, j: j * 11 + i
    for j in range(3):
        for i in range(11):
            lat, lon = ll(i * PAS, j * PAS)
            noeuds.append({"node_id": nid(i, j), "lat": lat, "lon": lon})
    def relier(a, b):
        for u, v in ((a, b), (b, a)):
            pu, pv = noeuds[u], noeuds[v]
            aretes.append({"node_a": u, "node_b": v, "distance_m": PAS, "vitesse_kmh": 40.0,
                           "pente_pct": 0.0, "coef_roulement": 0.008, "nb_feux": 0.0,
                           "coords": json.dumps([[pu["lat"], pu["lon"]], [pv["lat"], pv["lon"]]])})
    for j in range(3):
        for i in range(11):
            if i < 10:
                relier(nid(i, j), nid(i + 1, j))
            if j < 2:
                relier(nid(i, j), nid(i, j + 1))
    pd.DataFrame(noeuds).to_parquet(d / "n.parquet")
    pd.DataFrame(aretes).to_parquet(d / "a.parquet")
    return GrapheRoutier(d / "n.parquet", d / "a.parquet")


def _trace():
    xy = np.array([[0.0, 0.0], [2000.0, 0.0]]) + np.array([LON0 * KX, LAT0 * KY])
    a = xy[:-1]
    dd = xy[1:] - a
    return a, dd, (dd * dd).sum(axis=1)


def _bus(vid, x, y, t, trip="T1"):
    lat, lon = ll(x, y)
    return {"id": vid, "trip": trip, "k": 0, "route": "51", "dir_id": 0, "direction": "Est",
            "lat": lat, "lon": lon, "ecart": abs(y), "t_position": t}


# Passage par la rangée du milieu entre x = 800 et 1200 m, puis retour sur le tracé
PARCOURS = [(400, 0), (600, 0), (800, 200), (1000, 200), (1200, 200), (1400, 0), (1600, 0)]


def _rouler(suivi, vid, t0, parcours=PARCOURS, trip="T1"):
    out = None
    for k, (x, y) in enumerate(parcours):
        out = suivi.mettre_a_jour(t0 + 20 * k, [_bus(vid, x, y, t0 + 20 * k, trip)])
    return out


def test_un_bus_donne_un_detour_potentiel_sur_des_rues(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    detours, statut = _rouler(suivi, "A", 1000)
    assert len(detours) == 1
    d = detours[0]
    assert not d["valide"] and d["n_bus"] == 1 and d["bus"] == ["A"] and d["en_cours"] == []
    # Le tracé estimé suit la rangée du milieu (y = 200 m) entre x = 800 et 1200 m
    ys = [(la - LAT0) * KY for la, lo in d["coords"]]
    assert max(ys) == pytest.approx(200, abs=1)
    assert 800 <= d["longueur_m"] <= 1400
    assert statut == {}


def test_bus_en_cours_ne_valide_que_la_portion_parcourue(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    _rouler(suivi, "A", 1000)
    # B est encore dans le détour (à x = 1200, y = 200) : seule la portion qu'il a
    # parcourue est validée ; lui-même suit un chemin déjà emprunté → détour validé
    detours, statut = _rouler(suivi, "B", 2000, PARCOURS[:5])
    (d,) = detours
    assert d["en_cours"] == ["B"] and d["n_bus"] == 2
    assert not d["valide"] and 0 < d["longueur_validee_m"] < d["longueur_m"]
    assert {t["valide"] for t in d["troncons"]} == {True, False}
    assert statut["B"] == (d["id"], "valide")
    # Il rejoint le tracé par le même chemin : tout le détour est validé, 2 passages
    detours, statut = suivi.mettre_a_jour(2200, [_bus("B", 1400, 0, 2200)])
    d = detours[0]
    assert d["valide"] and d["passages"] == 2 and "B" not in statut
    assert d["longueur_validee_m"] == d["longueur_m"] and all(t["valide"] for t in d["troncons"])


def _ys_troncons(d, valide):
    return [(la - LAT0) * KY for t in d["troncons"] if t["valide"] == valide for la, lo in t["coords"]]


def _xs_troncons(d, valide):
    return [(lo - LON0) * KX for t in d["troncons"] if t["valide"] == valide for la, lo in t["coords"]]


def test_prolongement_en_amont_affiche_en_potentiel(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    _rouler(suivi, "A", 1000)
    # C quitte le tracé plus tôt (x = 400) puis rejoint le chemin de A
    detours, statut = _rouler(suivi, "C", 2000, [(200, 0), (400, 0), (400, 200), (600, 200), (800, 200),
                                                 (1000, 200), (1200, 200), (1400, 0), (1600, 0)])
    (d,) = detours
    assert d["n_bus"] == 2
    # Le prolongement (400 → 800 m au nord) est tracé, en potentiel ; le tronc commun est validé
    assert min(_xs_troncons(d, False)) == pytest.approx(400, abs=1)
    assert min(_xs_troncons(d, True)) >= 800 - 1
    assert max(_ys_troncons(d, True)) == pytest.approx(200, abs=1)


def test_portion_commune_seule_validee(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    _rouler(suivi, "A", 1000)
    # D prend le début du détour de A puis redescend dès x = 1000
    detours, _ = _rouler(suivi, "D", 2000, [(400, 0), (600, 0), (800, 200), (1000, 200), (1000, 0), (1200, 0)])
    (d,) = detours
    assert max(_xs_troncons(d, True)) <= 1000 + 1          # validé jusqu'à x = 1000 seulement
    assert max(_xs_troncons(d, False)) >= 1200 - 1         # la suite (A seul) reste potentielle


def test_raisons_sans_trace_estime(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    # Bus apparu hors tracé : sortie jamais observée
    _, statut = suivi.mettre_a_jour(1000, [_bus("E", 1000, 200, 1000)])
    assert statut["E"] == (None, "entree")
    # Première position hors tracé : en attente de la suivante
    _, statut = _rouler(suivi, "F", 2000, [(400, 0), (600, 0), (800, 200)])
    assert statut["F"] == (None, "attente")


def test_meme_bus_deux_fois_ne_valide_pas(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    _rouler(suivi, "A", 1000)
    detours, _ = _rouler(suivi, "A", 3000, trip="T2")
    assert len(detours) == 1 and not detours[0]["valide"] and detours[0]["passages"] == 2


def test_sortie_au_terminus_ignoree(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    # Sort du tracé 200 m après le départ (marge terminus 300 m)
    detours, _ = _rouler(suivi, "A", 1000, [(0, 0), (200, 0), (200, 200), (400, 200), (600, 0)])
    assert detours == []


def test_positions_hors_reseau_rejetees(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    # 1 km au nord : aucune rue du réseau à moins de 40 m
    detours, _ = _rouler(suivi, "A", 1000, [(400, 0), (600, 0), (800, 1000), (1000, 1000), (1400, 0)])
    assert detours == []


def test_changement_de_trajet_abandonne_l_excursion(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    _rouler(suivi, "A", 1000, PARCOURS[:5])
    detours, _ = suivi.mettre_a_jour(1200, [_bus("A", 1400, 0, 1200, trip="T9")])
    assert detours == []


def test_validation_manuelle_d_un_detour_potentiel(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    detours, _ = _rouler(suivi, "A", 1000, PARCOURS[:5])      # A encore dans le détour
    assert detours[0]["id"] == "pA" and not detours[0]["valide"]
    ident = suivi.valider("pA", 1100)
    detours, statut = suivi.mettre_a_jour(1100, [])
    assert detours[0]["id"] == ident and detours[0]["valide"] and detours[0]["force"]
    assert statut["A"] == (ident, "valide")


def test_suppression_et_sourdine(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    detours, _ = _rouler(suivi, "A", 1000)
    suivi.supprimer(detours[0]["id"], 1200, minutes=30)
    assert suivi.mettre_a_jour(1200, [])[0] == []
    assert suivi.etat_sourdines(1200)[0]["jusqu_a"] == 1200 + 1800
    # Pendant la sourdine, un nouveau passage n'est pas suivi
    assert _rouler(suivi, "B", 2000)[0] == []
    # Après : de nouveau détecté
    assert len(_rouler(suivi, "C", 4000)[0]) == 1 and suivi.etat_sourdines(4000) == []


def test_sourdine_de_session_levee(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    detours, _ = _rouler(suivi, "A", 1000)
    suivi.supprimer(detours[0]["id"], 1200, session="page-1")
    assert _rouler(suivi, "B", 2000)[0] == []
    suivi.lever_sourdine(session="page-1")
    assert len(_rouler(suivi, "C", 3000)[0]) == 1


def test_detour_trace_a_la_main(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    points = [ll(600, 0), ll(800, 200), ll(1200, 200), ll(1400, 0)]
    apercu = suivi.apercu(points)
    assert apercu["longueur_m"] == 1200 and len(apercu["coords"]) >= 5
    ident = suivi.tracer("51", 0, "Est", points, 1000)
    detours, _ = suivi.mettre_a_jour(1000 + 10 * 3600, [])     # jamais oublié
    assert detours[0]["id"] == ident and detours[0]["valide"] and detours[0]["manuel"]
    # Un bus qui l'emprunte y est rattaché comme détour validé
    detours, statut = _rouler(suivi, "B", 50_000, PARCOURS[:5])
    assert statut["B"] == (ident, "valide")
    with pytest.raises(ValueError):
        suivi.apercu([ll(600, 0), ll(600, 5000)])               # 5 km au nord : hors réseau


def test_bus_suivant_sur_le_trace_normal_archive_le_detour_1_bus(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    detours, _ = _rouler(suivi, "A", 1000)                     # détour potentiel (jaune)
    assert len(detours) == 1 and not detours[0]["valide"]
    # Le bus B roule ensuite sur le tracé normal, à travers la portion contournée
    detours, _ = _rouler(suivi, "B", 2000, [(400, 0), (600, 0), (900, 0), (1200, 0), (1500, 0)])
    assert detours == []                                       # retiré de la carte
    (p,) = suivi.etat_ponctuels()
    assert p["motif"] == "infirme" and p["infirme_par"] == "B" and p["bus"] == "A" and p["trip_id"] == "T1"
    # Entrée (600, 0) -> (800, 200) -> ... -> (1200, 200) -> sortie (1400, 0) : 1 200 m au lieu de 800
    assert (p["longueur_m"], p["distance_nominale_m"], p["distance_ajoutee_m"]) == (1200, 800, 400)
    assert p["duree_s"] == 80 and p["debut"] == 1020 and p["fin"] == 1100
    d = suivi.ponctuel(p["id"])
    assert len(d["gps"]) == 5 and d["gps"][0][2] == 1020 and len(d["coords"]) >= 5 and len(d["nominal"]) >= 2
    with pytest.raises(KeyError):
        suivi.ponctuel("u999")


def test_bus_suivant_dans_le_meme_detour_le_valide_sans_archiver(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    _rouler(suivi, "A", 1000)
    detours, _ = _rouler(suivi, "B", 2000)
    assert detours[0]["valide"] and suivi.etat_ponctuels() == []


def test_detour_1_bus_expire_archive(graphe):
    suivi = SuiviDetours(graphe, [_trace()], KX, KY)
    _rouler(suivi, "A", 1000)
    detours, _ = suivi.mettre_a_jour(1100 + 46 * 60, [])
    assert detours == [] and suivi.etat_ponctuels()[0]["motif"] == "expire"
