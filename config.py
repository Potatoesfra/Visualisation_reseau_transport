"""
config.py
=========
Configuration centrale du projet : chemins relatifs à la racine du dépôt
et paramètres du serveur (surchargables par variables d'environnement).

Aucun chemin absolu : le projet est autonome et déplaçable.
"""

import os
import sys
from pathlib import Path

# Console Windows souvent en cp1252 : forcer UTF-8 pour les prints (Δ, ⚠, …)
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

RACINE = Path(__file__).resolve().parent

DATA_BRUTE = RACINE / "data_brute"
DATA_DERIVEE = RACINE / "data_derivee"
GTFS_DIR = DATA_BRUTE / "gtfs_stm"

# --- Serveur Flask ---
# Surchargeable par VIZ_HOTE / VIZ_PORT. Sur un PaaS (Render, Heroku…), la
# plateforme impose le port d'écoute via $PORT et exige une écoute sur 0.0.0.0 :
# on s'y adapte automatiquement sans casser le défaut local (127.0.0.1:5000).
_PORT_PAAS = os.environ.get("PORT")   # défini par l'hébergeur (Render, Heroku…)
HOTE = os.environ.get("VIZ_HOTE", "0.0.0.0" if _PORT_PAAS else "127.0.0.1")
PORT = int(os.environ.get("VIZ_PORT", _PORT_PAAS or "5000"))

# Mode allégé (hébergement à faible RAM, ex. Render gratuit 512 Mo) : saute au
# démarrage le chargement du mode FUSION et de la CONSOMMATION synthétique (donc
# aussi la SIMULATION, qui en dépend). Le serveur tombe alors sous ~450 Mo. Non
# défini en local → toutes les fonctionnalités restent chargées.
VIZ_LIGHT = os.environ.get("VIZ_LIGHT", "0").strip().lower() not in ("", "0", "false", "no", "off")

# Clé de l'API GTFS-Realtime STM (portail développeurs, gratuite). Absente →
# couche « bus en temps réel » désactivée, le reste de l'app fonctionne. Ne
# jamais la versionner : variable d'environnement locale / secret sur l'hébergeur.
STM_API_KEY = os.environ.get("STM_API_KEY", "").strip()

# Actions manuelles sur les détours (valider, supprimer, sourdine, tracer) : elles
# modifient l'état partagé par tous les visiteurs. Autorisées en local, en LECTURE
# SEULE par défaut sur un hébergeur public ($PORT défini). VIZ_DETOURS_ACTIONS=1/0 force.
_actions = os.environ.get("VIZ_DETOURS_ACTIONS", "").strip().lower()
DETOURS_ACTIONS = (_actions not in ("0", "false", "no", "off")) if _actions else not _PORT_PAAS
