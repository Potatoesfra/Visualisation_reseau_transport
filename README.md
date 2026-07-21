# Visualisation géospatiale du réseau bus de Montréal (100 % open data)

Application Flask de visualisation et d'analyse du réseau d'autobus,
construite **exclusivement à partir de données ouvertes** : GTFS (STM),
OpenStreetMap, MNT Copernicus, données ouvertes de la Ville de Montréal et
normales climatiques d'Environnement Canada.

Le réseau est découpé en **segments** (portions de tracé entre deux arrêts
consécutifs d'une ligne), reliés entre eux par des **relations** typées
(suivant, portion partagée, intersection, merge, diverge, opposé, parallèle
proche). Chaque segment porte des attributs géographiques (pente, altitude,
sinuosité), routiers (type de voie, limite de vitesse, feux, état de la
chaussée) et énergétiques (modèle physique *road-load* d'un bus).

> **Note** — Les consommations affichées sont **simulées** par un modèle
> physique documenté (aucune donnée mesurée) : elles illustrent la mécanique de
> visualisation et les ordres de grandeur, pas des mesures réelles.

## Les cinq pages

| Page | URL | Contenu |
|---|---|---|
| Carte | `/` | Carte Leaflet : segments, relations, arrêts, overlay relief, **réseau routier routable**, **outil de création de trajet** (routage sur le réseau routier réel + estimation d'énergie) |
| Graphe | `/graphe` | Graphe abstrait Cytoscape : nœuds = segments, arêtes = relations typées |
| Graphe de calcul | `/graphe_calcul` | Arbre de voisinage avec moteur physique |
| Consommation | `/consommation` | Profils de consommation simulée par segment (Plotly) : par voyage, par mois ou par plage de température |
| Simulation | `/simulation` | Profil vitesse / puissance seconde par seconde d'un voyage, avec **lecture animée** |

Les pages ouvertes dans plusieurs onglets/fenêtres se **synchronisent**
automatiquement (BroadcastChannel) : sélectionner un segment sur une page le
surligne sur les autres.

> **Mode allégé (`VIZ_LIGHT=1`)** — pour l'hébergement à faible RAM (voir
> [Déploiement](#déploiement)), le serveur saute au démarrage le **mode
> fusion**, la **Consommation** et la **Simulation** (qui dépend de la conso),
> et désactive les pages **Graphe** et **Graphe de calcul** (purement côté
> client, retirées pour épurer l'UI en ligne). Seule la page Carte reste
> active ; les contrôles correspondants sont masqués. En local (variable non
> définie), tout reste chargé.

### Outil de création de trajet

Le bouton « Outil de création de trajet » (page carte) ouvre une carte en
surimpression dédiée à la construction d'un parcours :

- chaque clic ajoute un **jalon** ; l'itinéraire est calculé par Dijkstra sur le
  graphe routier OSM (`p08`) — le tracé suit les rues ;
- les jalons se **réordonnent** (▲ ▼), se suppriment (✕ ou clic droit sur le
  marqueur) et se déplacent par glisser-déposer ;
- le bouton 📍 propose les **arrêts existants les plus proches** ; en choisir un
  replace le jalon exactement sur cet arrêt ;
- l'énergie du trajet est estimée par le modèle *road-load* (traction, chauffage
  ou climatisation selon le mois, auxiliaires), avec la charge de passagers en
  paramètre ;
- un tracé peut être déplacé pour passer par une autre rue, il suffit de clic droit sur
  le segment d'intérêt;
- « Exporter la ligne » enregistre le trajet sous le nom choisi : il rejoint le
  groupe **★ Lignes créées** du sélecteur « Lignes affichées » et devient
  sélectionnable comme n'importe quelle ligne. Les lignes créées sont conservées
  dans le `localStorage` du navigateur (elles ne sont pas écrites sur le serveur).
  Les caractéristiques de ligne (longueur, dénivelé...) sont alors estimées pour la nouvelle
  ligne afin d'afficher les mêmes informations qu'une ligne legacy du flux GTFS.

### Lecture animée de la simulation

La page Simulation rejoue le voyage en temps réel (ou ×2, ×4, ×10), avec
pause et déplacement libre dans le temps :

- une **barre d'avancement** verticale parcourt les graphiques de vitesse et de
  puissance ;
- une **icône de bus** progresse simultanément sur le tracé du voyage dans
  l'onglet carte, positionnée par intégration de la vitesse le long du segment
  courant.

Sur la page Consommation, sélectionner une observation trace également le
voyage correspondant sur la carte. Le tracé fonctionne dans les deux modes :
en mode fusion, les identifiants de segments sont traduits via la table de
liaison, car un même entier n'y désigne pas le même nœud. Le mode fusion permet 
de passer d'un calcul par ligne à un calcul partagé. Un segment défini par deux arrêts, 
même s'il commence et se termine à des arrêts identiques entre plusieurs lignes de bus va générer
plusieurs segments dans le graphe. En mode fusion, deux arrêts définissent un segment qui peut être 
partagé par plusieurs lignes de bus. 

## Installation

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows  (source .venv/bin/activate sur Linux/Mac)
pip install -r requirements.txt
```

## Démarrage rapide (dérivés versionnés)

Les fichiers de `data_derivee/` sont versionnés : l'application fonctionne dès
le clone, sans télécharger les données brutes.

```bash
python serveur/serveur_viz.py
# puis ouvrir http://127.0.0.1:5000/
```

L'overlay « réseau routier routable » de la carte est dérivé du graphe de
routage (`data_derivee/`, versionné) : il ne dépend d'aucune donnée brute et
fonctionne dès le clone.

## Déploiement

Le serveur lit ses variables d'environnement via `config.py` :

| Variable | Rôle | Défaut |
|---|---|---|
| `VIZ_HOTE` / `VIZ_PORT` | hôte / port d'écoute | `127.0.0.1` / `5000` |
| `PORT` | port imposé par un PaaS (Render, Heroku…) : bascule automatiquement l'écoute sur `0.0.0.0:$PORT` | — |
| `VIZ_LIGHT` | `1` = mode allégé (saute fusion + consommation + simulation) → RSS ≈ 220 Mo, tient sur une instance 512 Mo | non défini |

Au démarrage, les gros payloads (segments, relations, arrêts) sont **sérialisés
une seule fois en JSON compact** puis les objets Python sont libérés : le RSS
chute fortement et les routes `/api/*` servent la chaîne telle quelle.

Un blueprint **Render** (`render.yaml`) et un **`Procfile`** sont fournis.
La commande de production utilise gunicorn (ajouté à `requirements.txt`),
**sans `--preload`** : sous Linux, le fork gunicorn combiné au refcounting
Python casse le copy-on-write et duplique les données maître/worker (→ OOM) ;
sans preload, seul le worker porte les données.

```bash
gunicorn --chdir serveur serveur_viz:app --workers 1 --timeout 300 --bind 0.0.0.0:$PORT
```

- `render.yaml` déploie en plan **gratuit** avec `VIZ_LIGHT=1` (les pages
  Consommation/Simulation et le mode fusion sont désactivés en ligne). Pour tout
  activer, retirer `VIZ_LIGHT` et passer en plan **standard** (≥ 2 Go de RAM).
- Le serveur est en **lecture seule** ; les lignes créées sont stockées dans le
  `localStorage` du navigateur — le disque éphémère d'un PaaS convient.

## Régénérer les dérivés depuis les sources brutes

1. Récupérer les données brutes (voir `data_brute/README.md`) :

```bash
python scripts/telecharger_donnees.py
```

2. Dérouler le pipeline dans l'ordre :

```bash
python pipeline/p01_shapes_par_ligne.py     # GTFS -> tracés par ligne de bus
python pipeline/p02_creation_segments.py    # paires d'arrêts -> segments géométriques
python pipeline/p03_fusion_segments.py      # jeu "fusion" (segments identiques regroupés)
python pipeline/p04_attributs_segments.py   # attributs OSM / MNT / ville + modèle road-load
python pipeline/p05_relations_segments.py   # relations typées + centralités (PageRank, radiality)
python pipeline/p06_conso_synthetique.py    # consommation simulée par voyages GTFS
python pipeline/p07_relief_overlay.py       # overlay de relief (hillshade)
python pipeline/p08_graphe_routier.py       # graphe routier routable (trajet cliqué)
python serveur/serveur_viz.py
```

Les générateurs aléatoires sont initialisés avec une graine fixe : les dérivés
sont reproductibles à l'identique.

## Modèle physique (résumé)

Le cœur physique est centralisé dans `serveur/modele_physique.py` (constantes
et formules partagées par le pipeline, la simulation et le trajet cliqué) :

- **Road-load** : demande de traction = gravité (pente du MNT) + résistance au
  roulement (surface OSM × état de chaussée) + traînée aérodynamique +
  stop-and-go (feux + arrêts), moins la régénération au freinage
  (η_regen = 0,60), le tout ramené à la batterie (η_chaîne = 0,85).
- **Charge passagers** : la masse totale module les termes proportionnels à la
  masse (70 kg/passager).
- **Auxiliaires** : chauffage électrique/climatisation proportionnels à l'écart
  de température (normales mensuelles ECCC) + base fixe.
- **Simulation** : profil trapèze accélération / croisière / freinage entre
  arrêts, arrêts aléatoires aux feux, puissance instantanée au pas de 1 s.
- **Trajet cliqué** : plus court chemin (Dijkstra) sur le graphe routier OSM
  (sens uniques respectés) ; l'énergie est sommée arête par arête.

## Structure du dépôt

```
config.py                  chemins + hôte/port + drapeau VIZ_LIGHT
render.yaml, Procfile      déploiement PaaS (Render / gunicorn)
scripts/                   téléchargement des données brutes
pipeline/p01..p08          étapes de production des dérivés (voir ci-dessus)
serveur/serveur_viz.py     serveur Flask (pages + API JSON)
serveur/modele_physique.py modèle road-load / cinématique / Dijkstra
serveur/templates,static   pages HTML + JS (Leaflet, Cytoscape, Plotly)
data_brute/                sources ouvertes (non versionnées, sauf normales ECCC)
data_derivee/              dérivés versionnés (l'app marche dès le clone)
```

## API principale

`/api/segments`, `/api/relations`, `/api/stops`, `/api/liaison`, `/api/meta`
(paramètre `?mode=normal|fusion` ; `fusion` indisponible en mode allégé) ;
`/api/trajet/estimation?points=lat,lon;lat,lon&charge=20&mois=1` ;
`/api/reseau_routier` (réseau routable en polylignes, dérivé du graphe) ;
`/api/relief`. Selon les données chargées :
`/api/conso/{options,voyages,profil}` et `/api/simulation/voyage?voyage=ID`
(absents en mode allégé `VIZ_LIGHT`). Le drapeau de chaque fonctionnalité est
exposé par `/api/meta` (`fusion_disponible`, `graphe_disponible`,
`conso_disponible`, `simulation_disponible`, `trajet_disponible`,
`relief_disponible`).

## Sources et licences des données

| Source | Licence | Usage |
|---|---|---|
| [GTFS STM](https://www.stm.info/fr/a-propos/developpeurs) | Conditions STM (données ouvertes) | tracés, arrêts, horaires, voyages |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | ODbL | attributs routiers, graphe routier |
| [Copernicus DEM GLO-30](https://dataspace.copernicus.eu/) | Licence Copernicus (libre) | altitudes, pentes, relief |
| [Données ouvertes Montréal](https://donnees.montreal.ca/) (feux, chaussée, géobase) | CC-BY 4.0 | feux, état chaussée, couches carte |
| [Normales climatiques ECCC](https://climat.meteo.gc.ca/climate_normals/index_f.html) | Licence ouverte Canada | températures mensuelles |


