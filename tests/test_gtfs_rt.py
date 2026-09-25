"""Tests du décodage GTFS-RT et de l'archivage Parquet, sur des flux synthétiques (sans réseau)."""
import sys
from pathlib import Path

import pandas as pd
from google.transit import gtfs_realtime_pb2

RACINE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RACINE))
sys.path.insert(0, str(RACINE / "serveur"))
sys.path.insert(0, str(RACINE / "scripts"))

from gtfs_rt import decoder_annulations, decoder_positions, decoder_trip_updates  # noqa: E402
from collecteur_gtfs_rt import Tampon  # noqa: E402

T0 = 1_760_000_000


def _flux_positions():
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    feed.header.timestamp = T0 - 12
    v = feed.entity.add(id="1").vehicle
    v.trip.trip_id, v.trip.route_id = "290160559", "1"
    v.trip.direction_id = 0          # 0 est une valeur réelle, pas une absence
    v.vehicle.id = "38001"
    v.position.latitude, v.position.longitude = 45.51, -73.56
    v.position.speed = 8.5
    v.stop_id, v.current_stop_sequence = "52370", 7
    v.current_status = gtfs_realtime_pb2.VehiclePosition.IN_TRANSIT_TO
    v.timestamp = T0 - 20
    # Véhicule minimal : aucun champ optionnel renseigné
    feed.entity.add(id="2").vehicle.vehicle.id = "38002"
    # Entité sans véhicule (alerte) : ignorée
    feed.entity.add(id="3").alert.cause = gtfs_realtime_pb2.Alert.WEATHER
    return feed.SerializeToString()


def _flux_trip_updates(n_arrets=5):
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    feed.header.timestamp = T0
    tu = feed.entity.add(id="t1").trip_update
    tu.trip.trip_id, tu.trip.route_id = "290160559", "1"
    for i in range(n_arrets):
        stu = tu.stop_time_update.add(stop_sequence=7 + i, stop_id=str(52370 + i))
        stu.arrival.time = T0 + 60 * (i + 1)
        if i == 0:
            stu.arrival.delay = 90
    return feed.SerializeToString()


def test_positions_champs_et_absences():
    t_flux, lignes = decoder_positions(_flux_positions(), T0)
    assert t_flux == T0 - 12
    assert len(lignes) == 2                       # l'alerte est ignorée
    complet, minimal = lignes
    assert complet["trip_id"] == "290160559" and complet["stop_id"] == "52370"
    assert complet["statut_arret"] == "IN_TRANSIT_TO"
    assert complet["direction_id"] == 0 and minimal["direction_id"] is None
    assert complet["t_position"] == T0 - 20
    assert abs(complet["vitesse_ms"] - 8.5) < 1e-6
    # Champs optionnels absents → None, pas 0 (0 serait une valeur plausible et fausse)
    assert minimal["vehicule_id"] == "38002"
    assert minimal["lat"] is None and minimal["stop_sequence"] is None
    assert minimal["t_position"] is None and minimal["statut_arret"] is None


def test_trip_updates_borne_arrets():
    _, lignes = decoder_trip_updates(_flux_trip_updates(5), T0, arrets_max=3)
    assert [l["stop_id"] for l in lignes] == ["52370", "52371", "52372"]
    assert lignes[0]["retard_arrivee_s"] == 90
    assert lignes[1]["retard_arrivee_s"] is None  # delay absent ≠ retard nul


def test_annulations():
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.header.gtfs_realtime_version = "2.0"
    ok = feed.entity.add(id="a").trip_update
    ok.trip.trip_id = "prevu"
    ann = feed.entity.add(id="b").trip_update
    ann.trip.trip_id = "annule"
    ann.trip.schedule_relationship = gtfs_realtime_pb2.TripDescriptor.CANCELED
    assert decoder_annulations(feed.SerializeToString()) == {"annule"}


def test_tampon_parquet_entiers_nullables(tmp_path):
    _, lignes = decoder_positions(_flux_positions(), T0)
    tampon = Tampon(tmp_path / "positions")
    tampon.lignes.extend(lignes)
    assert tampon.vider() == 2
    assert tampon.lignes == []
    fichiers = list((tmp_path / "positions").glob("date_utc=*/*.parquet"))
    assert len(fichiers) == 1
    relu = pd.read_parquet(fichiers[0])
    assert len(relu) == 2
    assert relu["stop_sequence"].isna().sum() == 1
    assert relu.loc[relu["vehicule_id"] == "38001", "stop_sequence"].iloc[0] == 7
