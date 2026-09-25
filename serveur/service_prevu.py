"""
service_prevu.py
================
Service prévu (horaire GTFS en vigueur) contre service réel (flux GTFS-RT) :
quels voyages devraient rouler maintenant, lesquels ont un véhicule, lesquels
sont annulés, lesquels manquent.

Statut d'un voyage prévu en cours (fenêtre début ≤ maintenant ≤ fin) :
  vu            un véhicule l'a porté dans le flux positions depuis son début ;
  annule        annulé par la STM (tripUpdates, schedule_relationship CANCELED) ;
  sans_vehicule ni vu ni annulé, commencé depuis ≥ GRACE_DEBUT_S et fini dans
                ≥ GRACE_FIN_S : voyage prévu vraisemblablement non livré ;
  a_confirmer   ni vu ni annulé, mais trop près du début ou de la fin pour
                conclure (bus encore en pause au terminus, fin anticipée…).

Mesures qui fixent ces marges (flux réel, 19 h en semaine) : 87 % des voyages
prévus ont un véhicule ; les bus sont affectés à leur trajet suivant ~5 min
avant son début et finissent ~6 min après la fin prévue ; 71 voyages sans
véhicule, dont 12 commencés depuis < 5 min et 15 finissant dans < 5 min.

Heures GTFS : secondes depuis minuit du jour de service, > 86 400 pour les
trajets après minuit (rattachés au jour de service de la veille).
"""
import numpy as np
import pandas as pd

FUSEAU = "America/Montreal"
GRACE_DEBUT_S = 300
GRACE_FIN_S = 120
HORIZON_ANNULATIONS_S = 3600   # annulations à venir listées dans l'heure


def hhmm(secondes):
    """Heure GTFS (s, éventuellement > 24 h) -> « HH:MM » sur 24 h."""
    s = int(secondes) % 86_400
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}"


class ServicePrevu:
    """
    Horaire minimal issu du référentiel (scripts/exporter_referentiel_rt.py).
    Les tableaux sont indexés comme `index` (trip_id -> rang), partagé avec le
    serveur pour ne pas dupliquer l'index des 136 000 trajets.
    """

    def __init__(self, index, lignes_trips, services, calendrier, exceptions,
                 destinations, directions):
        self.index = index
        self.trip_ids = np.array([r[0] for r in lignes_trips], dtype=object)
        self.direction_id = np.array([r[2] for r in lignes_trips], dtype=np.int8)
        self.route = np.array([r[3] for r in lignes_trips], dtype=object)
        self.service = np.array([r[4] for r in lignes_trips], dtype=np.int16)
        self.debut = np.array([r[5] for r in lignes_trips], dtype=np.int32)
        self.fin = np.array([r[6] for r in lignes_trips], dtype=np.int32)
        self.destination = np.array([r[7] for r in lignes_trips], dtype=np.int16)
        self.n_services = len(services)
        self.calendrier = {int(k): v for k, v in calendrier.items()}
        self.exceptions = {int(k): v for k, v in exceptions.items()}
        self.destinations = destinations
        self.directions = directions          # (route_id, "0"/"1") -> libellé
        self._actifs_cache = {}
        self._minuit_cache = {}

    # --- calendrier ---------------------------------------------------------
    def services_actifs(self, date):
        """Tableau booléen (par service) des services qui roulent le jour `date` (local)."""
        cle = date.strftime("%Y%m%d")
        if cle not in self._actifs_cache:
            actifs = np.zeros(self.n_services, dtype=bool)
            jour = date.weekday()
            for i, (jours, debut, fin) in self.calendrier.items():
                actifs[i] = jours[jour] == "1" and debut <= cle <= fin
            for i, liste in self.exceptions.items():
                for d, typ in liste:
                    if d == cle:
                        actifs[i] = (typ == 1)
            if len(self._actifs_cache) > 8:
                self._actifs_cache.clear()
            self._actifs_cache[cle] = actifs
        return self._actifs_cache[cle]

    def minuit(self, date_aaaammjj):
        """Epoch (s) du minuit local du jour de service AAAAMMJJ."""
        if date_aaaammjj not in self._minuit_cache:
            self._minuit_cache[date_aaaammjj] = pd.Timestamp(date_aaaammjj, tz=FUSEAU).timestamp()
        return self._minuit_cache[date_aaaammjj]

    def depassement_s(self, i, start_date, t):
        """Secondes écoulées depuis la fin prévue du trajet i (négatif = pas encore fini)."""
        if not start_date:
            return None
        return t - (self.minuit(start_date) + int(self.fin[i]))

    # --- bilan ------------------------------------------------------------
    def _libelle(self, i):
        route = self.route[i]
        return (route, self.directions.get((route, str(int(self.direction_id[i])))),
                self.destinations[int(self.destination[i])])

    @staticmethod
    def fenetres(t):
        """[(jour de service, secondes GTFS de t dans ce jour)] : jour courant, puis
        veille (trajets après minuit, heures > 24:00)."""
        jour = pd.Timestamp(t, unit="s", tz="UTC").tz_convert(FUSEAU).normalize()
        secs = t - jour.timestamp()
        return [(jour, secs), ((jour - pd.Timedelta(days=1)).normalize(), secs + 86_400)]

    def bilan(self, t, vus, annules):
        """
        Bilan du service à l'instant t (epoch s). `vus` : trip_id portés par un
        véhicule depuis leur début ; `annules` : trip_id annulés par la STM.
        """
        local = pd.Timestamp(t, unit="s", tz="UTC").tz_convert(FUSEAU)
        jour = local.normalize()
        fenetres = self.fenetres(t)

        compte = {"vu": 0, "annule": 0, "sans_vehicule": 0, "a_confirmer": 0}
        par_ligne = {}
        voyages = []
        for date, s in fenetres:
            actif = self.services_actifs(date)[self.service]
            for i in np.nonzero(actif & (self.debut <= s) & (self.fin >= s))[0]:
                trip = self.trip_ids[i]
                if trip in annules:
                    statut = "annule"
                elif trip in vus:
                    statut = "vu"
                elif s - self.debut[i] >= GRACE_DEBUT_S and self.fin[i] - s >= GRACE_FIN_S:
                    statut = "sans_vehicule"
                else:
                    statut = "a_confirmer"
                compte[statut] += 1
                route, direction, destination = self._libelle(i)
                c = par_ligne.setdefault(route, [0, 0, 0, 0])   # prévus, vus, annulés, sans véhicule
                c[0] += 1
                c[1] += statut == "vu"
                c[2] += statut == "annule"
                c[3] += statut == "sans_vehicule"
                if statut in ("annule", "sans_vehicule"):
                    voyages.append([trip, route, direction, destination,
                                    hhmm(self.debut[i]), hhmm(self.fin[i]), statut])

        a_venir = []
        for trip in annules:
            i = self.index.get(trip)
            if i is None:
                continue
            for date, s in fenetres:
                if (self.services_actifs(date)[self.service[i]]
                        and s < self.debut[i] <= s + HORIZON_ANNULATIONS_S):
                    route, direction, destination = self._libelle(i)
                    a_venir.append([trip, route, direction, destination, hhmm(self.debut[i])])
                    break

        cle_ligne = lambda r: (len(str(r)), str(r))   # 10 < 24 < 105
        voyages.sort(key=lambda v: (cle_ligne(v[1]), v[4]))
        a_venir.sort(key=lambda v: v[4])
        prevus = sum(compte.values())
        return {
            "heure": local.strftime("%H:%M"), "jour": jour.strftime("%Y-%m-%d"),
            "prevus": prevus, **compte,
            "par_ligne": par_ligne, "voyages": voyages, "annulations_a_venir": a_venir,
        }
