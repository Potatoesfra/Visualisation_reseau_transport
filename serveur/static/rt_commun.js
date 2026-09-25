/* =====================================================
   Temps réel (GTFS-RT STM) : définitions partagées entre la carte (carte.js)
   et le tableau de bord plein écran (tableau_de_bord.js).
   Mêmes seuils, mêmes agrégats, même historique : les deux pages affichent
   exactement les mêmes chiffres pour un même périmètre.
   ===================================================== */

// Actualisation calée sur les versions du flux : la STM publie une nouvelle version
// toutes les ~20 s ; le serveur apprend ce rythme et indique dans chaque réponse
// quand revenir (`prochain_ms` : juste après la publication attendue, puis toutes
// les 2 s tant qu'elle tarde). Sans cette indication (erreur, ancien serveur) : 10 s.
const RT_RAFRAICHISSEMENT_MS = 10000;
const delaiProchainFlux = data =>
  Math.min(30000, Math.max(500, Number.isFinite(data?.prochain_ms) ? data.prochain_ms : RT_RAFRAICHISSEMENT_MS));

// Boucle d'actualisation : `tour()` interroge le flux et renvoie le délai avant le suivant.
// Un setTimeout enchaîné (et non un setInterval) : chaque appel tombe à l'échéance annoncée.
class BoucleFlux {
  constructor(tour) { this.tour = tour; this.id = null; }
  get active() { return this.id !== null; }
  demarrer(delaiMs = 0) {
    this.arreter();
    const suivant = async () => {
      const ms = await this.tour();
      if (this.id === id) id = this.id = setTimeout(suivant, ms ?? RT_RAFRAICHISSEMENT_MS);
    };
    let id = this.id = setTimeout(suivant, delaiMs);
  }
  arreter() { if (this.id !== null) clearTimeout(this.id); this.id = null; }
}
// Au-delà de cette distance au tracé GTFS de SON trajet, le bus est signalé hors
// tracé. Mesuré sur le flux réel : médiane 3 m, p95 15 m ; ~4 % des bus au-delà
// de 150 m (détours, terminus hors tracé).
const RT_SEUIL_DETOUR_M = 150;
const RT_OCCUPATION = {   // code GTFS-RT → [couleur, libellé]
  EMPTY:                      ["#43a047", "Vide"],
  MANY_SEATS_AVAILABLE:       ["#43a047", "Places assises"],
  FEW_SEATS_AVAILABLE:        ["#fdd835", "Peu de places assises"],
  STANDING_ROOM_ONLY:         ["#fb8c00", "Places debout seulement"],
  CRUSHED_STANDING_ROOM_ONLY: ["#fb8c00", "Bondé"],
  FULL:                       ["#e53935", "Plein"],
  NOT_ACCEPTING_PASSENGERS:   ["#e53935", "N'accepte plus de passagers"],
};

// ----- États d'un bus (filtres de la carte, tuiles du tableau de bord) -----
const RT_FIGE_S = 180;   // position plus vieille que 3 min : véhicule « perdu » (le flux se renouvelle aux 20 s)
const RT_PLEINS = new Set(["FULL", "CRUSHED_STANDING_ROOM_ONLY", "NOT_ACCEPTING_PASSENGERS"]);
// Détour validé : le serveur (serveur/detours.py) a vu au moins un autre bus
// emprunter (80 % de) son chemin hors GTFS ; un tel bus n'est plus compté « hors trajet ».
const detourValide = (v, i) => v[i.detour_statut] === "valide";
// Bus hors tracé sans tracé estimé : raison donnée par le serveur (detours.py, RAISONS)
const RT_RAISONS_SANS_TRACE = {
  attente: "première position hors tracé, estimé à la position suivante",
  entree: "sortie du tracé non observée (bus apparu hors tracé ou flux interrompu)",
  terminus: "sortie à moins de 300 m d'un terminus (boucle, pause)",
  reseau: "positions hors des rues du réseau routier (bruit GPS, stationnement)",
  confondu: "chemin estimé confondu avec le tracé normal",
  supprime: "détour supprimé à la main",
  sourdine: "ligne/direction en sourdine",
};
const RT_ETATS = {
  hors_trajet: { libelle: "hors trajet",
                 teste: (v, i) => (v[i.ecart_trace_m] ?? 0) > RT_SEUIL_DETOUR_M && !detourValide(v, i) },
  detour_valide: { libelle: "en détour validé",
                   teste: detourValide },
  depassement: { libelle: "en dépassement de fin prévue",
                 teste: (v, i) => v[i.depassement_min] != null },
  pleins:      { libelle: "pleins",
                 teste: (v, i) => RT_PLEINS.has(v[i.occupation]) },
  train:       { libelle: "en train de bus",
                 teste: (v, i, maintenant, reg) => !!reg[v[i.vehicule_id]]?.train },
  figes:       { libelle: "à position figée",
                 teste: (v, i, maintenant) => v[i.t_position] != null && maintenant - v[i.t_position] > RT_FIGE_S },
};

// ----- Formats -----
const triLignes = (a, b) => String(a).localeCompare(String(b), "fr", { numeric: true });
const fmtMin = m => (m == null ? "?" : m < 1 ? "< 1 min" : `${Math.round(m)} min`);
// Heure locale compacte (toLocaleTimeString fr-CA donne « 10 h 07 min 25 s »)
const deux = n => String(n).padStart(2, "0");
const hhmm = t => { const d = new Date(t * 1000); return `${deux(d.getHours())}:${deux(d.getMinutes())}`; };
const hhmmss = t => `${hhmm(t)}:${deux(new Date(t * 1000).getSeconds())}`;
const fmtDuree = s => {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${deux(Math.floor((s % 3600) / 60))}`;
};
const indexChamps = data => Object.fromEntries(data.champs.map((c, i) => [c, i]));

// ----- Agrégats d'un périmètre (réseau, lignes, lignes + directions) -----
// lignes : Set des lignes du périmètre (null = réseau) ; garder(route, direction) :
// filtre fin des bus et des écarts (null = toutes les directions des lignes).
// Voyage : [trip_id, route, direction, destination, début, fin, statut].
function agregerPerimetre(data, lignes, garder, maintenant = Math.floor(Date.now() / 1000)) {
  const dansLignes = route => !lignes || lignes.has(String(route));
  const dans = (route, direction) => dansLignes(route) && (!garder || garder(String(route), direction));
  const r = {
    nBus: 0, comptesEtats: Object.fromEntries(Object.keys(RT_ETATS).map(e => [e, 0])), bus: [],
    livraison: { prevus: 0, vu: 0, annule: 0, sans: 0 },
    lignesSans: [], pires: [], voyages: [], aVenir: [],
    lignesReg: [], trous: [], trains: [], nEcarts: 0, nReguliers: 0, indice: null,
    detours: [], detoursValides: [],
  };
  const idx = indexChamps(data);
  const regBus = (data.regularite && data.regularite.bus) || {};
  for (const v of data.vehicules) {
    if (!dans(v[idx.route_id], v[idx.direction])) continue;
    r.nBus++;
    const etats = [];
    for (const [etat, def] of Object.entries(RT_ETATS)) {
      if (def.teste(v, idx, maintenant, regBus)) { r.comptesEtats[etat]++; etats.push(etat); }
    }
    if (etats.length) r.bus.push({ v, etats });
  }
  const s = data.service;
  if (s) {
    for (const [route, c] of Object.entries(s.par_ligne)) {
      if (!dansLignes(route)) continue;
      const l = r.livraison;
      l.prevus += c[0]; l.vu += c[1]; l.annule += c[2]; l.sans += c[3];
      if (c[1] === 0 && c[0] - c[2] > 0) r.lignesSans.push([route, c]);
      if (c[2] + c[3] > 0) r.pires.push([route, c]);
    }
    r.voyages = s.voyages.filter(v => dansLignes(v[1]));
    r.aVenir = s.annulations_a_venir.filter(v => dansLignes(v[1]));
    r.lignesSans.sort((a, b) => triLignes(a[0], b[0]));
    r.pires.sort((a, b) => (b[1][2] + b[1][3]) - (a[1][2] + a[1][3]) || triLignes(a[0], b[0]));
  }
  const reg = data.regularite;
  if (reg) {
    for (const l of Object.values(reg.lignes)) {
      if (!dans(l.route, l.direction)) continue;
      r.nEcarts += l.n_ecarts;
      r.nReguliers += l.n_reguliers;
      if (l.indice != null) r.lignesReg.push(l);
    }
    r.lignesReg.sort((a, b) => a.indice - b.indice || b.n_bus - a.n_bus);
    const ecarts = reg.ecarts.filter(e => dans(e.route, e.direction));
    r.trous = ecarts.filter(e => e.type === "trou").sort((a, b) => b.rapport - a.rapport);
    r.trains = ecarts.filter(e => e.type === "train");
  }
  // Détours observés (tracé estimé, validés à partir de 2 bus) : null si le serveur ne les calcule pas
  if (Array.isArray(data.detours)) {
    r.detours = data.detours.filter(d => dans(d.route, d.direction));
    r.detoursValides = r.detours.filter(d => d.valide);
  } else {
    r.detours = r.detoursValides = null;
  }
  r.indice = r.nEcarts ? Math.round(100 * r.nReguliers / r.nEcarts) : null;
  r.taux = s && r.livraison.prevus ? r.livraison.vu / r.livraison.prevus : null;
  return r;
}

// ===== Historique des événements du réseau (depuis l'ouverture de la page) =====
// À chaque NOUVEL instantané du flux (t_flux change), on relève les conditions
// présentes (gap de service, bunching, bus hors trajet, figé…) : une condition nouvelle ouvre
// un épisode, une condition encore présente le prolonge, une condition absente
// de HISTO_GRACE instantanés consécutifs le clôt (fin = dernière fois vue). La
// tolérance évite qu'un bus oscillant autour d'un seuil crée un épisode par
// actualisation. Tout reste en mémoire dans l'onglet (rien côté serveur).
const HISTO_GRACE = 2;            // instantanés d'absence avant clôture (~40 s, flux aux 20 s)
const HISTO_MAX = 5000;           // épisodes conservés (les plus vieux terminés sont oubliés)
const HISTO_TYPES = {
  trou:        { icone: "⇹", lib: "Gaps de service" },
  train:       { icone: "🚌", lib: "Bus bunching" },
  hors_trajet: { icone: "⚠", lib: "Hors trajet" },
  detour:      { icone: "↪", lib: "Détours validés" },
  // Détour d'un seul bus infirmé (bus suivant passé par le tracé normal) ou expiré : mouvement ponctuel
  detour_1bus: { icone: "↯", lib: "Détours 1 bus", ponctuel: true },
  fige:        { icone: "⏸", lib: "Figés" },
  depassement: { icone: "⏱", lib: "Dépassements" },
  plein:       { icone: "👥", lib: "Pleins" },
  annule:      { icone: "✖", lib: "Annulations", ponctuel: true },
  ligne_sans:  { icone: "∅", lib: "Lignes sans bus" },
  flux:        { icone: "📡", lib: "Flux STM", grace: 1 },
};
const episodeEnCours = ep => ep.fin == null && !HISTO_TYPES[ep.type].ponctuel;

// Conditions présentes dans un instantané : Map clé -> {type, route, direction, bus, valeur, loc, detail}
function conditionsInstantane(data, t) {
  const cond = new Map();
  const ajouter = (cle, c) => cond.set(cle, c);
  const idx = indexChamps(data);
  for (const v of data.vehicules) {
    const id = v[idx.vehicule_id];
    const base = { route: v[idx.route_id], direction: v[idx.direction], bus: [id], loc: [v[idx.lat], v[idx.lon]] };
    const ecart = v[idx.ecart_trace_m];
    if (ecart != null && ecart > RT_SEUIL_DETOUR_M && v[idx.detour_statut] !== "valide") {
      ajouter(`hors_trajet|${id}`, { ...base, type: "hors_trajet", valeur: ecart });
    }
    const tp = v[idx.t_position];
    if (tp != null && t - tp > RT_FIGE_S) ajouter(`fige|${id}`, { ...base, type: "fige", valeur: t - tp });
    if (v[idx.depassement_min] != null) ajouter(`depassement|${id}`, { ...base, type: "depassement", valeur: v[idx.depassement_min] });
    if (RT_PLEINS.has(v[idx.occupation])) {
      ajouter(`plein|${id}`, { ...base, type: "plein", valeur: 0, detail: (RT_OCCUPATION[v[idx.occupation]] || [])[1] });
    }
  }
  const reg = data.regularite;
  if (reg) {
    for (const e of reg.ecarts) {
      const base = { route: e.route, direction: e.direction, bus: [e.suiveur, e.meneur] };
      if (e.type === "trou") {
        // Clé = bus qui suit le gap : le meneur peut changer (terminus) sans que le gap se résorbe
        ajouter(`trou|${e.route}|${e.direction}|${e.suiveur}`, { ...base, type: "trou", valeur: e.minutes,
          detail: { rapport: e.rapport, prevu: reg.lignes[`${e.route}|${e.direction}`]?.intervalle_min }, loc: e.coords });
      } else if (e.type === "train") {
        const paire = [e.suiveur, e.meneur].sort().join("+");
        ajouter(`train|${e.route}|${paire}`, { ...base, type: "train", valeur: e.minutes, loc: e.point });
      }
    }
  }
  for (const d of (data.detours || [])) {
    if (!d.valide) continue;
    ajouter(`detour|${d.id}`, { type: "detour", route: d.route, direction: d.direction, bus: d.bus, valeur: d.n_bus,
                                detail: { longueur_m: d.longueur_m, passages: d.passages },
                                loc: d.coords });   // tout le tracé : clic sur l'épisode = cadrer dessus
  }
  for (const p of (data.detours_ponctuels || [])) {
    // Heure de l'événement : celle du détour (serveur), même s'il date d'avant l'ouverture de la page
    ajouter(`detour_1bus|${p.id}`, { type: "detour_1bus", route: p.route, direction: p.direction, bus: [p.bus],
                                     valeur: p.distance_ajoutee_m, debut: p.debut, detail: p });
  }
  const s = data.service;
  if (s) {
    for (const v of s.voyages.filter(v => v[6] === "annule").concat(s.annulations_a_venir)) {
      ajouter(`annule|${v[0]}`, { type: "annule", route: v[1], direction: v[2], bus: [], valeur: 0,
                                  detail: { depart: v[4], destination: v[3] } });
    }
    for (const [route, c] of Object.entries(s.par_ligne)) {
      if (c[1] === 0 && c[0] - c[2] > 0) ajouter(`ligne_sans|${route}`, { type: "ligne_sans", route, bus: [], valeur: c[0] - c[2] });
    }
  }
  if (data.perime) ajouter("flux|perime", { type: "flux", bus: [], valeur: 0, detail: "STM injoignable : données figées" });
  return cond;
}

// Pire valeur de l'épisode : écart max (gap, détour), écart min (bunching), âge max (figé)…
function histoPire(type, a, b) {
  if (a == null) return b;
  return type === "train" ? Math.min(a, b) : Math.max(a, b);
}

class HistoriqueRT {
  constructor() {
    this.ouverture = Math.floor(Date.now() / 1000);
    this.ouverts = new Map();   // clé -> épisode en cours
    this.liste = [];            // tous les épisodes, dans l'ordre d'ouverture
    this.dernierFlux = null;    // t_flux du dernier instantané traité
    this.premier = true;        // 1er instantané : les conditions présentes datent d'avant l'ouverture
    this.tRef = null;           // horodatage du dernier instantané (durées des épisodes en cours)
  }

  // Renvoie true si l'instantané est nouveau (et a donc été traité)
  enregistrer(data) {
    const t = data.t_flux || data.t_collecte || Math.floor(Date.now() / 1000);
    // Un même instantané peut revenir (version en retard, action sur un détour) : traité une fois
    if (t === this.dernierFlux) return false;
    this.dernierFlux = t;
    this.observer(conditionsInstantane(data, t), t);
    return true;
  }

  observer(cond, t) {
    for (const [cle, c] of cond) {
      let ep = this.ouverts.get(cle);
      if (!ep) {
        ep = { cle, type: c.type, route: c.route ?? null, direction: c.direction ?? null,
               debut: c.debut ?? t, debutConnu: c.debut != null || !this.premier,
               fin: null, vu: t, absences: 0, pire: null };
        this.ouverts.set(cle, ep);
        this.liste.push(ep);
      }
      ep.vu = t;
      ep.absences = 0;
      ep.bus = c.bus;
      ep.pire = histoPire(c.type, ep.pire, c.valeur);
      if (c.detail !== undefined) ep.detail = c.detail;
      if (c.loc) ep.loc = c.loc;
    }
    for (const [cle, ep] of this.ouverts) {
      if (cond.has(cle)) continue;
      if (++ep.absences >= (HISTO_TYPES[ep.type].grace || HISTO_GRACE)) {
        ep.fin = ep.vu;
        this.ouverts.delete(cle);
      }
    }
    if (this.liste.length > HISTO_MAX) {
      const trop = this.liste.length - HISTO_MAX;
      let n = 0;
      this.liste = this.liste.filter(ep => ep.fin == null || ++n > trop);
    }
    this.premier = false;
    this.tRef = t;
  }

  // Erreur d'appel : seule la condition « flux » change, les autres épisodes restent ouverts
  erreurFlux(message) {
    const t = Math.floor(Date.now() / 1000);
    let ep = this.ouverts.get("flux|erreur");
    if (!ep) {
      ep = { cle: "flux|erreur", type: "flux", route: null, direction: null, bus: [], debut: t,
             debutConnu: true, fin: null, vu: t, absences: 0, pire: 0 };
      this.ouverts.set(ep.cle, ep);
      this.liste.push(ep);
    }
    ep.vu = t;
    ep.detail = `Temps réel indisponible : ${message}`;
  }

  fluxRetabli() {
    const ep = this.ouverts.get("flux|erreur");
    if (!ep) return;
    ep.fin = ep.vu;
    this.ouverts.delete(ep.cle);
  }

  // Oublie les épisodes terminés (et les annulations déjà annoncées)
  vider() { this.liste = this.liste.filter(episodeEnCours); }

  nbEnCours() { return this.liste.filter(episodeEnCours).length; }
}

function texteEpisode(ep) {
  const bus = ep.bus || [];
  switch (ep.type) {
    case "trou":
      return `Gap de service de ${fmtMin(ep.pire)} entre les bus ${bus[0]} et ${bus[1]}` +
             (ep.detail?.prevu != null ? ` (prévu ${fmtMin(ep.detail.prevu)})` : "");
    case "train":       return `Bus bunching : ${bus.join(" et ")} à ${fmtMin(ep.pire)} d'écart`;
    case "detour":      return `Détour validé : ${bus.length} bus (${bus.join(", ")}) sur un tracé hors GTFS` +
                               (ep.detail?.longueur_m ? ` de ${(ep.detail.longueur_m / 1000).toLocaleString("fr-CA", { maximumFractionDigits: 1 })} km` : "");
    case "detour_1bus": {
      const p = ep.detail || {};
      return `Détour 1 bus : bus ${p.bus}${p.trip_debut ? ` (voyage de ${p.trip_debut})` : ""} hors tracé ${fmtDuree(p.duree_s)}, ` +
             `${p.distance_ajoutee_m >= 0 ? "+" : ""}${Number(p.distance_ajoutee_m).toLocaleString("fr-CA")} m ` +
             `(${Number(p.longueur_m).toLocaleString("fr-CA")} m au lieu de ${Number(p.distance_nominale_m).toLocaleString("fr-CA")} m) — ` +
             (p.motif === "infirme" ? `non repris : bus ${p.infirme_par} passé par le tracé normal` : "non repris depuis 45 min");
    }
    case "hors_trajet": return `Bus ${bus[0]} hors trajet, jusqu'à ${Math.round(ep.pire).toLocaleString("fr-CA")} m du tracé`;
    case "fige":        return `Bus ${bus[0]} : position figée (${fmtDuree(ep.pire)} sans mise à jour)`;
    case "depassement": return `Bus ${bus[0]} : ${fmtMin(ep.pire)} après la fin prévue de son voyage`;
    case "plein":       return `Bus ${bus[0]} : ${(ep.detail || "plein").toLowerCase()}`;
    case "annule":      return `Voyage annulé : départ ${ep.detail?.depart ?? "?"}` +
                               (ep.detail?.destination ? ` vers ${ep.detail.destination}` : "");
    case "ligne_sans":  return `Aucun bus en service (${ep.pire} voyage(s) prévu(s) en cours)`;
    case "flux":        return ep.detail || "Flux STM indisponible";
  }
  return ep.type;
}

// Libellé « quand / durée » d'un épisode, relatif au dernier instantané tRef
function dureeEpisode(ep, tRef) {
  const def = HISTO_TYPES[ep.type];
  const plus = ep.debutConnu ? "" : " +";
  if (ep.type === "detour_1bus") return `${fmtDuree(ep.detail?.duree_s)} hors tracé · clic : retracer`;
  if (def.ponctuel) return ep.debutConnu ? "annoncé" : "annoncé avant l'ouverture";
  if (ep.fin == null) return `en cours · ${fmtDuree(tRef - ep.debut)}${plus}`;
  return `terminé à ${hhmm(ep.fin)} · ${fmtDuree(ep.fin - ep.debut)}${plus}`;
}

function csvHistorique(liste, tRef) {
  const champ = x => {
    const s = x == null ? "" : String(x);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const iso = t => (t == null ? "" : new Date(t * 1000).toISOString());
  const lignes = [["type", "ligne", "direction", "bus", "debut", "debut_connu", "fin", "duree_s", "en_cours", "description"].join(";")];
  for (const ep of liste) {
    const ponctuel = !!HISTO_TYPES[ep.type].ponctuel;
    lignes.push([ep.type, ep.route, ep.direction, (ep.bus || []).join(" "), iso(ep.debut), ep.debutConnu ? 1 : 0,
                 ponctuel ? "" : iso(ep.fin), ponctuel ? "" : (ep.fin ?? tRef) - ep.debut,
                 episodeEnCours(ep) ? 1 : 0, texteEpisode(ep)].map(champ).join(";"));
  }
  return "﻿" + lignes.join("\n");   // BOM : accents lus correctement par Excel
}

function telechargerTexte(texte, nom, type = "text/csv;charset=utf-8") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([texte], { type }));
  a.download = nom;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
