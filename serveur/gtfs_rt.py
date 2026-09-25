"""
gtfs_rt.py
==========
Accès aux flux GTFS-Realtime de la STM (API publique, clé gratuite sur le
portail développeurs) et décodage en enregistrements plats.

Partagé par le collecteur (scripts/collecteur_gtfs_rt.py, stockage Parquet pour
l'analyse) et par le serveur (couche « bus en temps réel » de la carte) : un
seul décodeur, testable sans réseau.

Deux flux :
  vehiclePositions : position GPS, trajet, arrêt courant/suivant, occupation
  tripUpdates      : prévisions d'arrivée/départ par arrêt restant du trajet

Chez la STM, stop_id == stop_code pour les arrêts de bus : les arrêts du flux
se rattachent donc directement aux segments (route_id, start_stop_code,
end_stop_code) du pipeline (p02).
"""

import time

import requests
from google.transit import gtfs_realtime_pb2

URLS_STM = {
    "positions": "https://api.stm.info/pub/od/gtfs-rt/ic/v2/vehiclePositions",
    "trip_updates": "https://api.stm.info/pub/od/gtfs-rt/ic/v2/tripUpdates",
}
ENTETE_CLE = "apiKey"   # en-tête HTTP attendu par l'API STM

# Libellés des énumérations GTFS-RT (plus lisibles que les entiers en analyse)
_STATUT_ARRET = {0: "INCOMING_AT", 1: "STOPPED_AT", 2: "IN_TRANSIT_TO"}
_OCCUPATION = {
    0: "EMPTY", 1: "MANY_SEATS_AVAILABLE", 2: "FEW_SEATS_AVAILABLE",
    3: "STANDING_ROOM_ONLY", 4: "CRUSHED_STANDING_ROOM_ONLY", 5: "FULL",
    6: "NOT_ACCEPTING_PASSENGERS", 7: "NO_DATA_AVAILABLE", 8: "NOT_BOARDABLE",
}


def telecharger_flux(flux, cle, timeout=10.0):
    """
    Télécharge un flux brut. Renvoie (contenu | None, statut_http, durée_ms).
    Ne lève pas sur les erreurs réseau : statut_http = 0 dans ce cas, pour que
    l'appelant journalise l'échec au lieu de s'interrompre.
    """
    t0 = time.perf_counter()
    try:
        rep = requests.get(URLS_STM[flux], headers={ENTETE_CLE: cle}, timeout=timeout)
        duree_ms = round((time.perf_counter() - t0) * 1000)
        return (rep.content if rep.ok else None), rep.status_code, duree_ms
    except requests.RequestException:
        return None, 0, round((time.perf_counter() - t0) * 1000)


def _feed(contenu):
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(contenu)
    return feed


def _opt(msg, champ):
    """Valeur d'un champ optionnel proto2, ou None s'il est absent."""
    return getattr(msg, champ) if msg.HasField(champ) else None


def decoder_positions(contenu, t_collecte):
    """
    Décode vehiclePositions. Renvoie (horodatage_flux, liste de dicts), une
    ligne par véhicule. `t_collecte` (epoch s) permet de mesurer la fraîcheur
    de chaque position (t_collecte - horodatage) indépendamment du flux.
    """
    feed = _feed(contenu)
    lignes = []
    for ent in feed.entity:
        if not ent.HasField("vehicle"):
            continue
        v = ent.vehicle
        trip = v.trip
        pos = v.position if v.HasField("position") else None
        lignes.append({
            "t_collecte": t_collecte,
            "t_position": _opt(v, "timestamp"),
            "vehicule_id": v.vehicle.id if v.HasField("vehicle") else None,
            "trip_id": trip.trip_id or None,
            "route_id": trip.route_id or None,
            "direction_id": _opt(trip, "direction_id"),
            "start_date": trip.start_date or None,
            "lat": pos.latitude if pos else None,
            "lon": pos.longitude if pos else None,
            "cap": _opt(pos, "bearing") if pos else None,
            "vitesse_ms": _opt(pos, "speed") if pos else None,
            "stop_id": v.stop_id or None,
            "stop_sequence": _opt(v, "current_stop_sequence"),
            "statut_arret": _STATUT_ARRET.get(v.current_status) if v.HasField("current_status") else None,
            "occupation": _OCCUPATION.get(v.occupancy_status) if v.HasField("occupancy_status") else None,
        })
    return feed.header.timestamp or None, lignes


def decoder_annulations(contenu):
    """
    trip_id annulés dans tripUpdates (schedule_relationship CANCELED au niveau
    du trajet). La STM les publie, y compris à l'avance : c'est ce qui distingue
    un voyage annulé d'un voyage simplement sans véhicule dans le flux.
    """
    feed = _feed(contenu)
    annule = gtfs_realtime_pb2.TripDescriptor.CANCELED
    return {e.trip_update.trip.trip_id for e in feed.entity
            if e.HasField("trip_update") and e.trip_update.trip.schedule_relationship == annule}


def decoder_trip_updates(contenu, t_collecte, arrets_max=None):
    """
    Décode tripUpdates. Renvoie (horodatage_flux, liste de dicts), une ligne
    par (trajet, arrêt restant). `arrets_max` borne le nombre d'arrêts gardés
    par trajet (les plus proches) : le flux complet pèse des dizaines de
    milliers de lignes par appel.
    """
    feed = _feed(contenu)
    lignes = []
    for ent in feed.entity:
        if not ent.HasField("trip_update"):
            continue
        tu = ent.trip_update
        maj = tu.stop_time_update
        if arrets_max is not None:
            maj = maj[:arrets_max]
        base = {
            "t_collecte": t_collecte,
            "t_prevision": _opt(tu, "timestamp"),
            "vehicule_id": tu.vehicle.id if tu.HasField("vehicle") else None,
            "trip_id": tu.trip.trip_id or None,
            "route_id": tu.trip.route_id or None,
            "start_date": tu.trip.start_date or None,
        }
        for stu in maj:
            arr = stu.arrival if stu.HasField("arrival") else None
            dep = stu.departure if stu.HasField("departure") else None
            lignes.append({
                **base,
                "stop_sequence": _opt(stu, "stop_sequence"),
                "stop_id": stu.stop_id or None,
                "arrivee_prevue": _opt(arr, "time") if arr else None,
                "retard_arrivee_s": _opt(arr, "delay") if arr else None,
                "depart_prevu": _opt(dep, "time") if dep else None,
                "retard_depart_s": _opt(dep, "delay") if dep else None,
            })
    return feed.header.timestamp or None, lignes
