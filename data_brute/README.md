# Données brutes (non versionnées)

Ce dossier contient les données sources open data. Elles sont **exclues du dépôt git**
(trop volumineuses) : seuls ce README, `normales_climatiques_montreal.csv` et
`gtfs_stm/stops.txt` (arrêts, requis par le serveur) sont versionnés.

Pour les récupérer : `python scripts/telecharger_donnees.py` (téléchargement automatique
quand c'est possible, sinon le script imprime les URL et instructions), ou suivre le
tableau ci-dessous manuellement.

| Fichier / dossier | Contenu | Source (licence ouverte) |
|---|---|---|
| `gtfs_stm/` | Feed GTFS complet de la STM (stops.txt, trips.txt, stop_times.txt, shapes.txt, routes.txt…) | STM — <https://www.stm.info/fr/a-propos/developpeurs> (zip : `https://www.stm.info/sites/default/files/gtfs/gtfs_stm.zip`) |
| `montreal_copernicus_dem_30m.tif` | Modèle numérique de terrain Copernicus GLO-30 (30 m) découpé sur la région de Montréal | Copernicus DEM (ESA) — via <https://portal.opentopography.org/> (jeu « Copernicus GLO-30 »), bbox ≈ 45.35→45.75 N, −74.05→−73.35 O |
| `OSM.geojson` | Réseau routier OpenStreetMap de Montréal (attributs `highway`, `maxspeed`, `surface`, `lanes`, `oneway`) | OpenStreetMap (ODbL) — export Overpass, voir la requête dans `scripts/telecharger_donnees.py` |
| `feux-circulation.json` | Feux de circulation de la Ville de Montréal (GeoJSON de points) | Données ouvertes Montréal — <https://donnees.montreal.ca/dataset/feux-circulation> |
| `auscultation-chaussee-2024.gpkg` | État des chaussées 2024 (indice PCI) | Données ouvertes Montréal — <https://donnees.montreal.ca/dataset/auscultation-des-chaussees> |
| `geobase_reseau_routier.json` | Géobase — tronçons du réseau routier (GeoJSON) | Données ouvertes Montréal — <https://donnees.montreal.ca/dataset/geobase> |
| `geobase_intersections.json` | Géobase double — intersections (GeoJSON) | Données ouvertes Montréal — <https://donnees.montreal.ca/dataset/geobase-double> |
| `normales_climatiques_montreal.csv` | Normales climatiques mensuelles (ECCC, station Montréal-Trudeau) — **versionné** | ECCC — <https://climat.meteo.gc.ca/climate_normals/index_f.html> |

Notes :
- Le millésime GTFS utilisé pour produire les dérivés versionnés est `20260401074928_26M`
  (période 2026-01-05 → 2026-06-14). Un feed plus récent fonctionnera, mais les identifiants
  de shapes/trips peuvent différer : relancer alors tout le pipeline.
- Les couches géobase ne servent qu'à l'affichage sur la carte : l'application démarre
  sans elles (les cases correspondantes sont simplement désactivées).
