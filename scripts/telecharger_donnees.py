"""
telecharger_donnees.py
======================
Téléchargement (au mieux) des données brutes open data dans data_brute/.

Chaque source est tentée automatiquement quand une URL directe stable existe ;
sinon le script imprime la procédure manuelle. Relancer le script est sans
danger : les fichiers déjà présents sont sautés.

Sources et licences : voir data_brute/README.md.
"""

import io
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import DATA_BRUTE, GTFS_DIR  # noqa: E402

try:
    import requests
except ImportError:
    print("Le module 'requests' est requis : pip install requests")
    sys.exit(1)


URL_GTFS_STM = "https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip"

# Requête Overpass ayant servi à produire OSM.geojson (réseau routier de Montréal).
# À exécuter sur https://overpass-turbo.eu (Exporter -> GeoJSON) si le
# téléchargement automatique échoue ou pour un extrait plus récent.
REQUETE_OVERPASS = """
[out:json][timeout:600];
(
  way["highway"~"motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"]
     (45.35,-74.05,45.75,-73.35);
);
out geom;
"""

FICHIERS_MANUELS = {
    "montreal_copernicus_dem_30m.tif": (
        "MNT Copernicus GLO-30 découpé sur Montréal.\n"
        "    1. Créer un compte gratuit sur https://portal.opentopography.org/\n"
        "    2. Jeu de données « Copernicus GLO-30 », bbox 45.35 -> 45.75 N, -74.05 -> -73.35 O\n"
        "    3. Exporter en GeoTIFF et enregistrer sous ce nom."
    ),
    "feux-circulation.json": (
        "Feux de circulation (GeoJSON) :\n"
        "    https://donnees.montreal.ca/dataset/feux-circulation"
    ),
    "auscultation-chaussee-2024.gpkg": (
        "Auscultation des chaussées 2024 (GeoPackage) :\n"
        "    https://donnees.montreal.ca/dataset/auscultation-des-chaussees"
    ),
    "geobase_reseau_routier.json": (
        "Géobase — réseau routier (GeoJSON) :\n"
        "    https://donnees.montreal.ca/dataset/geobase"
    ),
    "geobase_intersections.json": (
        "Géobase double — intersections (GeoJSON) :\n"
        "    https://donnees.montreal.ca/dataset/geobase-double"
    ),
}


def telecharger(url, destination, timeout=600):
    print(f"  Téléchargement : {url}")
    reponse = requests.get(url, timeout=timeout, stream=True)
    reponse.raise_for_status()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with open(destination, "wb") as f:
        for morceau in reponse.iter_content(chunk_size=1 << 20):
            f.write(morceau)
    print(f"  -> {destination} ({destination.stat().st_size / 1e6:.1f} Mo)")


def gtfs_stm():
    if (GTFS_DIR / "stop_times.txt").exists():
        print("GTFS STM déjà présent — sauté.")
        return
    print("GTFS STM…")
    try:
        reponse = requests.get(URL_GTFS_STM, timeout=600)
        reponse.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(reponse.content)) as z:
            z.extractall(GTFS_DIR)
        print(f"  -> {GTFS_DIR} (dézippé)")
    except Exception as e:  # noqa: BLE001
        print(f"  ÉCHEC ({e}). Télécharger manuellement {URL_GTFS_STM}")
        print(f"  puis dézipper dans {GTFS_DIR}")


def osm_via_overpass():
    cible = DATA_BRUTE / "OSM.geojson"
    if cible.exists():
        print("OSM.geojson déjà présent — sauté.")
        return
    print("OSM.geojson : export à faire manuellement via Overpass (fichier volumineux).")
    print("  Requête à coller sur https://overpass-turbo.eu puis Exporter -> GeoJSON :")
    print(REQUETE_OVERPASS)


def fichiers_manuels():
    for nom, instructions in FICHIERS_MANUELS.items():
        cible = DATA_BRUTE / nom
        if cible.exists():
            print(f"{nom} déjà présent — sauté.")
            continue
        print(f"{nom} : téléchargement manuel requis.")
        print(f"    {instructions}")


if __name__ == "__main__":
    DATA_BRUTE.mkdir(exist_ok=True)
    gtfs_stm()
    osm_via_overpass()
    fichiers_manuels()
    print("\nTerminé. Vérifier que tous les fichiers listés dans data_brute/README.md sont présents.")
