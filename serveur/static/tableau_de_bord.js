/* =====================================================
   Tableau de bord plein écran : performance du réseau en temps réel (sans carte)
   - un panneau par périmètre : réseau entier, une ligne ou plusieurs lignes ;
     plusieurs panneaux = écran partagé (ex. réseau + la ligne qu'on surveille) ;
   - indicateurs, courbes depuis l'ouverture de la page, tableaux et événements ;
   - même calcul que la barre du bas de la carte (rt_commun.js).
   Configuration dans l'adresse (#reseau|51,80|747) : partageable, et la carte
   peut rouvrir cet onglet sur un autre périmètre sans perdre les courbes.
   ===================================================== */

const SERIE_MAX = 2160;     // instantanés gardés pour les courbes (12 h à 20 s)
const BLOC_MAX = 150;       // lignes affichées par tableau
const EVENEMENTS_MAX = 60;
const CLE_PANNEAUX = "tdbp.panneaux";
const CLE_FILTRES = "tdbp.filtres";   // tris et filtres des tableaux, par périmètre

// Indicateurs par ligne et par instantané (courbes de n'importe quel périmètre,
// y compris d'un panneau ajouté après coup : l'historique est déjà là)
const K = { prevus: 0, vu: 1, annule: 2, sans: 3, ecarts: 4, reguliers: 5, trous: 6,
            trains: 7, hors: 8, figes: 9, dep: 10, pleins: 11, bus: 12, detours: 13 };
const NK = 14;

const TDBP = {
  panneaux: [],               // [{lignes: Set|null, cle, el, vues: {bloc: {tri, filtres}}, donnees, scroll}]
  solo: null,                 // clé du panneau agrandi (null = écran partagé)
  dernier: null,              // dernière réponse /api/rt/vehicules
  maintenant: null,           // horloge locale à la réception
  histo: new HistoriqueRT(),
  serie: { routes: new Map(), instantanes: [] },
  enVol: false,
  erreur: null,
};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = x => (x == null ? "–" : `${Math.round(x)} %`);
const nombre = n => (n == null ? "–" : n.toLocaleString("fr-CA"));
const niveauTaux = t => (t == null ? "" : t >= 95 ? "ok" : t >= 85 ? "moyen" : "faible");
const niveauIndice = i => (i == null ? "" : i >= 80 ? "ok" : i >= 60 ? "moyen" : "faible");

// ===== Périmètres et configuration =====
function cleDepuisLignes(lignes) { return lignes ? [...lignes].sort(triLignes).join(",") : "reseau"; }

function parserPerimetre(texte) {
  const mots = String(texte || "").split(/[\s,;|]+/).map(x => x.trim())
    .filter(x => x && !/^lignes?$/i.test(x));
  if (!mots.length || mots.some(m => /^r[ée]seau$/i.test(m))) return null;
  return new Set(mots);
}

function titrePerimetre(lignes) {
  if (!lignes) return "Réseau";
  const l = [...lignes].sort(triLignes);
  return l.length === 1 ? `Ligne ${l[0]}` : `Lignes ${l.join(", ")}`;
}

function lireConfiguration() {
  let brut = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (!brut) { try { brut = localStorage.getItem(CLE_PANNEAUX) || ""; } catch (e) { brut = ""; } }
  const cles = brut ? brut.split("|") : ["reseau"];
  const vus = new Set();
  const panneaux = [];
  for (const c of cles) {
    const lignes = parserPerimetre(c);
    const cle = cleDepuisLignes(lignes);
    if (vus.has(cle)) continue;
    vus.add(cle);
    panneaux.push(lignes);
  }
  return panneaux.length ? panneaux : [null];
}

function sauverConfiguration() {
  const brut = TDBP.panneaux.map(p => p.cle).join("|");
  history.replaceState(null, "", `#${brut}`);   // ne déclenche pas hashchange
  try { localStorage.setItem(CLE_PANNEAUX, brut); } catch (e) { /* stockage indisponible */ }
}

function appliquerConfiguration(listeLignes) {
  for (const p of TDBP.panneaux) p.el.remove();
  TDBP.panneaux = [];
  TDBP.solo = null;
  fermerMenu();
  for (const lignes of listeLignes) ajouterPanneau(lignes, { sauver: false, rendre: false });
  sauverConfiguration();
  disposer();
  rendreTout();
  majBandeauFiltres();
}

// ===== Panneaux =====
function ajouterPanneau(lignes, { sauver = true, rendre = true } = {}) {
  const cle = cleDepuisLignes(lignes);
  const existant = TDBP.panneaux.find(p => p.cle === cle);
  if (existant) { signaler(existant.el); return existant; }
  const p = { lignes, cle, vues: vuesStockees(cle), donnees: {}, scroll: {} };
  p.el = creerElementPanneau(p);
  TDBP.panneaux.push(p);
  document.getElementById("tdbpGrille").appendChild(p.el);
  if (sauver) sauverConfiguration();
  if (rendre) { disposer(); rendrePanneau(p); majBandeauFiltres(); }
  return p;
}

function fermerPanneau(p) {
  if (MENU.p === p) fermerMenu();
  p.el.remove();
  TDBP.panneaux = TDBP.panneaux.filter(x => x !== p);
  if (TDBP.solo === p.cle) TDBP.solo = null;
  sauverConfiguration();
  sauverFiltres();
  majBandeauFiltres();
  disposer();
  if (!TDBP.panneaux.length) rendreVide();
}

function changerPerimetre(p, lignes) {
  const cle = cleDepuisLignes(lignes);
  if (cle === p.cle) return;
  if (TDBP.panneaux.some(x => x.cle === cle)) { signaler(TDBP.panneaux.find(x => x.cle === cle).el); return; }
  if (TDBP.solo === p.cle) TDBP.solo = cle;
  if (MENU.p === p) fermerMenu();
  Object.assign(p, { lignes, cle, vues: vuesStockees(cle), donnees: {}, scroll: {} });
  sauverConfiguration();
  sauverFiltres();
  rendrePanneau(p);
  majBandeauFiltres();
}

function signaler(el) {
  el.classList.remove("signale");
  void el.offsetWidth;   // relance l'animation
  el.classList.add("signale");
}

// Écran partagé : 1 à 3 panneaux côte à côte, au-delà sur deux rangées
function disposer() {
  const grille = document.getElementById("tdbpGrille");
  if (!grille) return;
  const visibles = TDBP.panneaux.filter(p => !TDBP.solo || p.cle === TDBP.solo);
  for (const p of TDBP.panneaux) {
    p.el.hidden = !visibles.includes(p);
    p.el.querySelector('[data-action="solo"]').title =
      TDBP.solo ? "Revenir à l'écran partagé" : "Agrandir ce panneau (les autres restent ouverts)";
    p.el.querySelector('[data-action="solo"]').textContent = TDBP.solo ? "⤡" : "⤢";
  }
  const n = Math.max(1, visibles.length);
  const cols = n <= 3 ? n : n === 4 ? 2 : 3;
  grille.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  grille.style.gridTemplateRows = `repeat(${Math.ceil(n / cols)}, minmax(0, 1fr))`;
  requestAnimationFrame(redessinerGraphes);
}

function creerElementPanneau(p) {
  const el = document.createElement("section");
  el.className = "pan";
  el.innerHTML = `
    <header class="pan-tete">
      <div class="pan-nom"><h2></h2><span class="pan-sous"></span></div>
      <form class="pan-edition" hidden>
        <input type="text" list="tdbpLignes" aria-label="Périmètre du panneau" placeholder="Réseau, ou lignes : 51, 80">
        <button type="submit" class="action-btn primary">OK</button>
      </form>
      <div class="pan-actions">
        <button type="button" data-action="editer" title="Modifier le périmètre (réseau ou lignes)">✎</button>
        <button type="button" data-action="solo">⤢</button>
        <button type="button" data-action="fermer" title="Fermer ce panneau">×</button>
      </div>
    </header>
    <div class="pan-corps">
      <div class="pan-grands"></div>
      <div class="pan-tuiles"></div>
      <div class="pan-graphes">
        <figure class="graphe" data-g="service"><figcaption>Service livré et régularité</figcaption>
          <div class="graphe-zone"></div><div class="graphe-legende"></div></figure>
        <figure class="graphe" data-g="incidents"><figcaption>Incidents en cours</figcaption>
          <div class="graphe-zone"></div><div class="graphe-legende"></div></figure>
      </div>
      <div class="pan-blocs"></div>
    </div>`;
  const form = el.querySelector(".pan-edition");
  const input = form.querySelector("input");
  el.querySelector(".pan-actions").addEventListener("click", (e) => {
    const action = e.target.closest("button")?.dataset.action;
    if (action === "fermer") fermerPanneau(p);
    else if (action === "solo") { TDBP.solo = TDBP.solo ? null : p.cle; disposer(); }
    else if (action === "editer") {
      form.hidden = !form.hidden;
      input.value = p.lignes ? [...p.lignes].sort(triLignes).join(", ") : "réseau";
      if (!form.hidden) { input.focus(); input.select(); }
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    form.hidden = true;
    changerPerimetre(p, parserPerimetre(input.value));
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Escape") form.hidden = true; });
  // Délégation : liens de ligne (ouvrent un panneau), tuiles, en-têtes de colonne, pastilles
  el.querySelector(".pan-corps").addEventListener("click", (e) => {
    const lien = e.target.closest("[data-ligne]");
    if (lien) {
      const ligne = lien.dataset.ligne;
      if (!(p.lignes && p.lignes.size === 1 && p.lignes.has(ligne))) ajouterPanneau(new Set([ligne]));
      return;
    }
    const tuile = e.target.closest("[data-tuile]");
    if (tuile) {
      const t = TUILES.find(x => x.cle === tuile.dataset.tuile);
      if (t.etat) basculerFiltreSimple(p, "bus", "etat", t.etat);
      const bloc = el.querySelector(`[data-bloc="${t.bloc}"]`);
      if (bloc) { bloc.scrollIntoView({ behavior: "smooth", block: "nearest" }); signaler(bloc); }
      return;
    }
    const cleBloc = e.target.closest("[data-bloc]")?.dataset.bloc;
    if (!cleBloc) return;
    const menu = e.target.closest("[data-menu-col]");
    if (menu) {
      const col = menu.dataset.menuCol;
      if (MENU.p === p && MENU.bloc === cleBloc && MENU.col?.cle === col && !MENU.el.hidden) fermerMenu();
      else ouvrirMenuColonne(p, cleBloc, col, menu.closest("th"));
      return;
    }
    const tri = e.target.closest("[data-tri-col]");
    if (tri) {
      // Un clic : croissant, puis décroissant, puis croissant…
      const vue = vueBloc(p, cleBloc), col = tri.dataset.triCol;
      vue.tri = { col, dir: vue.tri?.col === col && vue.tri.dir === "asc" ? "desc" : "asc" };
      majVue(p);
      p.el.querySelector(`[data-bloc="${cleBloc}"] [data-tri-col="${col}"]`)?.focus();
      return;
    }
    if (e.target.closest("[data-reinit-bloc]")) { p.vues[cleBloc] = { tri: null, filtres: {} }; majVue(p); return; }
    const pastille = e.target.closest("[data-filtre-bus]");
    if (pastille) {
      const vue = vueBloc(p, "bus");
      if (pastille.dataset.filtreBus) vue.filtres.etat = { type: "liste", mode: "inclus", valeurs: [pastille.dataset.filtreBus] };
      else delete vue.filtres.etat;
      majVue(p);
      return;
    }
    if (e.target.closest("[data-histo-en-cours]")) basculerFiltreSimple(p, "evenements", "etat", "en cours");
  });
  return el;
}

// ===== Indicateurs =====
const TUILES = [
  { cle: "sans_vehicule", lib: "Voyages sans véhicule", bloc: "voyages",   def: "Voyage prévu en cours depuis ≥ 5 min, jamais vu dans le flux ni annoncé annulé" },
  { cle: "annule",        lib: "Voyages annulés",        bloc: "voyages",   def: "Marqué CANCELED dans tripUpdates (GTFS-RT STM)" },
  { cle: "lignes_sans",   lib: "Lignes sans aucun bus",  bloc: "lignes",    def: "Service prévu en cours, aucun bus vu", multi: true },
  { cle: "pires",         lib: "Lignes touchées",        bloc: "lignes",    def: "≥ 1 voyage en cours non livré (annulé ou sans véhicule)", multi: true },
  { cle: "trous",         lib: "Gaps de service",        bloc: "trous",     def: "Écart entre deux bus > 2 × l'intervalle prévu" },
  { cle: "train",         lib: "Bus en bunching",        bloc: "bus", etat: "train",       def: "Écart avec le bus voisin < 0,25 × l'intervalle prévu" },
  { cle: "hors_trajet",   lib: "Bus hors trajet",        bloc: "bus", etat: "hors_trajet", def: `À plus de ${RT_SEUIL_DETOUR_M} m du tracé GTFS de leur voyage, hors détour validé` },
  { cle: "detours",       lib: "Détours validés",        bloc: "detours",  def: "Même tracé hors GTFS emprunté par au moins 2 bus de la ligne/direction (estimé sur le réseau routier routable)" },
  { cle: "depassement",   lib: "Bus en dépassement",     bloc: "bus", etat: "depassement", def: "Plus de 5 min après la fin prévue de leur voyage" },
  { cle: "pleins",        lib: "Bus pleins",             bloc: "bus", etat: "pleins",      def: "Occupation déclarée pleine" },
  { cle: "figes",         lib: "Positions figées",       bloc: "bus", etat: "figes",       def: `Plus de ${RT_FIGE_S / 60} min sans mise à jour de position` },
];

function rendrePanneau(p) {
  const data = TDBP.dernier;
  const el = p.el;
  el.querySelector(".pan-nom h2").textContent = titrePerimetre(p.lignes);
  if (!data) {
    el.querySelector(".pan-sous").textContent = TDBP.erreur ? `Flux indisponible : ${TDBP.erreur}` : "En attente du flux…";
    return;
  }
  const r = agregerPerimetre(data, p.lignes, null, TDBP.maintenant);
  const multi = !p.lignes || p.lignes.size > 1;
  const s = data.service;

  // En-tête : bus et lignes en service ; lignes inconnues signalées
  const connues = lignesConnues(data);
  const inconnues = p.lignes ? [...p.lignes].filter(l => !connues.has(l)) : [];
  const nLignes = s ? Object.entries(s.par_ligne).filter(([l, c]) => (!p.lignes || p.lignes.has(l)) && c[0] > 0).length : null;
  el.querySelector(".pan-sous").textContent =
    `${nombre(r.nBus)} bus en service` + (multi && nLignes != null ? ` · ${nLignes} ligne(s) avec service prévu` : "") +
    (inconnues.length ? ` · ⚠ inconnue(s) du GTFS en vigueur : ${inconnues.join(", ")}` : "");

  // Grands indicateurs
  const l = r.livraison;
  const taux = r.taux == null ? null : 100 * r.taux;
  const aConfirmer = l.prevus - l.vu - l.annule - l.sans;
  el.querySelector(".pan-grands").innerHTML = `
    <div class="grand ${niveauTaux(taux)}" title="Voyages prévus en cours portés par un bus du flux">
      <div class="grand-val">${pct(taux)}</div><div class="grand-lib">service livré</div>
      <div class="jauge"><span style="width:${taux == null ? 0 : Math.round(taux)}%"></span></div>
      <div class="grand-sous">${s ? (l.prevus ? `${nombre(l.vu)} / ${nombre(l.prevus)} voyages en cours ont un bus<br>${nombre(l.annule)} annulé(s) · ${nombre(l.sans)} sans véhicule · ${nombre(aConfirmer)} à confirmer`
                                              : "aucun voyage prévu en ce moment") : "horaire indisponible"}</div>
    </div>
    <div class="grand ${niveauIndice(r.indice)}" title="Part des écarts entre bus consécutifs compris entre 0,5 et 1,5 × l'intervalle prévu">
      <div class="grand-val">${pct(r.indice)}</div><div class="grand-lib">régularité</div>
      <div class="jauge"><span style="width:${r.indice ?? 0}%"></span></div>
      <div class="grand-sous">${r.nEcarts ? `${nombre(r.nReguliers)} écart(s) régulier(s) sur ${nombre(r.nEcarts)} mesuré(s)` : "pas d'écart mesurable (moins de 2 bus placés par direction)"}</div>
    </div>`;

  // Tuiles
  const valeurs = {
    sans_vehicule: s ? l.sans : null, annule: s ? l.annule : null,
    lignes_sans: s ? r.lignesSans.length : null, pires: s ? r.pires.length : null,
    trous: data.regularite ? r.trous.length : null, ...r.comptesEtats,
    detours: r.detoursValides ? r.detoursValides.length : null,
  };
  el.querySelector(".pan-tuiles").innerHTML = TUILES.filter(t => multi || !t.multi).map(t => {
    const v = valeurs[t.cle];
    const extra = t.cle === "annule" && r.aVenir.length ? `<span class="tuile-plus">+${r.aVenir.length} dans l'heure</span>` : "";
    const actif = t.etat && filtreSimple(vueBloc(p, "bus").filtres.etat) === t.etat ? " actif" : "";
    return `<button type="button" class="tuile ${v == null ? "" : v === 0 ? "ok" : "alerte"}${actif}" data-tuile="${t.cle}"
              title="${esc(t.lib)} : ${esc(t.def)}\nClic : ${t.etat ? "filtrer « Bus à surveiller »" : "voir le détail"}">
              <span class="tuile-val">${nombre(v)}</span><span class="tuile-lib">${t.lib}${extra}</span></button>`;
  }).join("");

  rendreGraphes(p);
  rendreBlocs(p, r, data, multi);
  if (MENU.p === p) repositionnerMenu();
}

function lignesConnues(data) {
  if (TDBP._connues && TDBP._connues.data === data) return TDBP._connues.set;
  const set = new Set(Object.keys(data.service?.par_ligne || {}));
  const idx = indexChamps(data);
  for (const v of data.vehicules) if (v[idx.route_id] != null) set.add(String(v[idx.route_id]));
  TDBP._connues = { data, set };
  return set;
}

// ===== Tableaux : colonnes, tri et filtres =====
// Chaque bloc déclare ses colonnes : val (valeur triée/filtrée), html (cellule), type de filtre.
// Tri et filtres sont propres à chaque panneau et mémorisés par périmètre (localStorage).
const lienLigne = route => `<button type="button" class="lien-ligne" data-ligne="${esc(route)}" title="Ouvrir la ligne ${esc(route)} dans un nouveau panneau">${esc(route)}</button>`;
const COLLATEUR = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });
const normaliser = s => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const LIB_ETAT = { hors_trajet: "Hors trajet", detour_valide: "Détour validé", train: "Bunching", figes: "Figés", depassement: "Dépassement", pleins: "Pleins" };
const ICONE_FILTRE = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M1.5 2.5h13l-5 6v4.5l-3 1.5v-6z" fill="currentColor"/></svg>`;
const texteCle = v => String(v ?? "");

// Colonnes communes
const colLigne = (route, html) => ({ cle: "ligne", titre: "Ligne", type: "liste", val: (x, c) => texteCle(route(x, c)),
                                     html: html || ((x, c) => lienLigne(route(x, c))) });
const colDirection = dir => ({ cle: "direction", titre: "Direction", type: "liste", val: (x, c) => texteCle(dir(x, c)) });

function puces(b, c) {
  const v = b.v, idx = c.idx;
  return b.etats.map(etat => {
    if (etat === "hors_trajet") return `<span class="puce hors_trajet">⚠ ${nombre(v[idx.ecart_trace_m])} m du tracé</span>`;
    if (etat === "detour_valide") return `<span class="puce detour_valide">↪ détour validé (${nombre(v[idx.ecart_trace_m])} m du tracé)</span>`;
    if (etat === "figes") return `<span class="puce figes">⏸ ${fmtDuree(c.maintenant - v[idx.t_position])} sans position</span>`;
    if (etat === "depassement") return `<span class="puce depassement">⏱ +${fmtMin(v[idx.depassement_min])}</span>`;
    if (etat === "pleins") return `<span class="puce pleins">👥 ${esc((RT_OCCUPATION[v[idx.occupation]] || [])[1] || "plein")}</span>`;
    if (etat === "train") {
      const rb = c.regBus[v[idx.vehicule_id]] || {};
      const ecart = Math.min(rb.devant_min ?? Infinity, rb.derriere_min ?? Infinity);
      return `<span class="puce train">🚌 bunching${isFinite(ecart) ? ` (${fmtMin(ecart)})` : ""}</span>`;
    }
    return "";
  }).join(" ");
}

const etatEpisode = ep => (ep.type === "detour_1bus" ? "ponctuel" : HISTO_TYPES[ep.type].ponctuel ? "annoncé"
                           : ep.fin == null ? "en cours" : "terminé");
const dureeMin = (ep, c) => (ep.type === "detour_1bus" ? ep.detail.duree_s / 60
                             : HISTO_TYPES[ep.type].ponctuel ? null : ((ep.fin ?? c.tRef ?? ep.vu) - ep.debut) / 60);

const BLOCS = {
  regularite: { titre: "Régularité par ligne et direction", colonnes: [
    colLigne(x => x.route),
    { ...colDirection(x => x.direction),
      html: x => esc(x.direction) + (x.detours ? ' <span class="puce detour_valide" title="Tracé adapté au détour validé">↪</span>' : "") },
    { cle: "indice", titre: "Régularité", type: "nombre", unite: "%", val: x => x.indice, html: x => `${x.indice} %`, cls: x => niveauIndice(x.indice) },
    { cle: "bus", titre: "Bus", type: "nombre", val: x => x.n_bus },
    { cle: "intervalle", titre: "Intervalle prévu", type: "nombre", unite: "min", val: x => x.intervalle_min, html: x => fmtMin(x.intervalle_min) },
    { cle: "trains", titre: "Bunching", type: "nombre", val: x => x.trains || 0, html: x => x.trains || "" },
    { cle: "trous", titre: "Gaps", type: "nombre", val: x => x.trous || 0, html: x => x.trous || "" },
  ] },
  trous: { titre: "Gaps de service", colonnes: [
    colLigne(e => e.route),
    colDirection(e => e.direction),
    { cle: "ecart", titre: "Écart", type: "nombre", unite: "min", val: e => e.minutes, html: e => fmtMin(e.minutes), cls: () => "faible" },
    { cle: "prevu", titre: "Prévu", type: "nombre", unite: "min", val: (e, c) => c.reg?.lignes[`${e.route}|${e.direction}`]?.intervalle_min ?? null,
      html: (e, c) => fmtMin(c.reg?.lignes[`${e.route}|${e.direction}`]?.intervalle_min) },
    { cle: "rapport", titre: "Rapport", type: "nombre", val: e => e.rapport, html: e => `×${e.rapport.toLocaleString("fr-CA")}` },
    { cle: "bus", titre: "Entre les bus", type: "texte", val: e => `${e.suiveur} → ${e.meneur}` },
  ] },
  bus: { titre: "Bus à surveiller", colonnes: [
    colLigne((b, c) => b.v[c.idx.route_id]),
    colDirection((b, c) => b.v[c.idx.direction]),
    { cle: "bus", titre: "Bus", type: "texte", val: (b, c) => texteCle(b.v[c.idx.vehicule_id]) },
    { cle: "etat", titre: "État", type: "liste", val: b => b.etats, lib: e => LIB_ETAT[e] || e,
      tri: b => b.etats.length, html: puces, aide: "Tri : nombre d'états signalés" },
  ] },
  voyages: { titre: "Voyages non livrés", colonnes: [
    colLigne(x => x.v[1]),
    colDirection(x => x.v[2]),
    { cle: "horaire", titre: "Horaire", type: "texte", num: true, val: x => texteCle(x.v[4]), html: x => `${esc(x.v[4])} → ${esc(x.v[5])}` },
    { cle: "destination", titre: "Destination", type: "texte", val: x => (x.v[3] && x.v[3] !== x.v[2] ? x.v[3] : "") },
    { cle: "statut", titre: "Statut", type: "liste", val: x => x.lib, html: x => `<span class="puce ${x.cls}">${x.lib}</span>` },
  ] },
  lignes: { titre: "Service non livré par ligne", colonnes: [
    colLigne(x => x.route, x => lienLigne(x.route) + (x.c[1] === 0 && x.c[0] - x.c[2] > 0 ? ' <span class="puce faible">aucun bus</span>' : "")),
    { cle: "prevus", titre: "Prévus", type: "nombre", val: x => x.c[0] },
    { cle: "livres", titre: "Livrés", type: "nombre", val: x => x.c[1] },
    { cle: "annules", titre: "Annulés", type: "nombre", val: x => x.c[2], html: x => x.c[2] || "" },
    { cle: "sans", titre: "Sans véhicule", type: "nombre", val: x => x.c[3], html: x => x.c[3] || "" },
    { cle: "taux", titre: "Taux", type: "nombre", unite: "%", val: x => x.t, html: x => pct(x.t), cls: x => niveauTaux(x.t) },
  ] },
  evenements: { titre: "Événements", classeLigne: ep => (episodeEnCours(ep) ? "en-cours" : "termine"), colonnes: [
    { cle: "debut", titre: "Début", type: "heure", num: true, val: ep => ep.debut, html: ep => `${ep.debutConnu ? "" : "≤ "}${hhmm(ep.debut)}` },
    { cle: "type", titre: "Type", type: "liste", val: ep => ep.type, lib: t => `${HISTO_TYPES[t]?.icone || ""} ${HISTO_TYPES[t]?.lib || t}`,
      tri: ep => HISTO_TYPES[ep.type].lib, html: ep => `<span title="${esc(HISTO_TYPES[ep.type].lib)}">${HISTO_TYPES[ep.type].icone}</span>` },
    { ...colLigne(ep => ep.route, ep => (ep.route != null ? lienLigne(ep.route) : "")), lib: v => v || "(aucune)" },
    colDirection(ep => ep.direction),
    { cle: "detail", titre: "Détail", type: "texte", large: true, val: ep => texteEpisode(ep) },
    { cle: "duree", titre: "Durée", type: "nombre", unite: "min", val: dureeMin,
      html: (ep, c) => { const m = dureeMin(ep, c); return m == null ? "" : fmtDuree(Math.round(m * 60)) + (ep.debutConnu ? "" : " +"); } },
    { cle: "etat", titre: "État", type: "liste", val: etatEpisode,
      html: ep => (etatEpisode(ep) === "terminé" ? `terminé ${hhmm(ep.fin)}` : `<span class="puce ${ep.fin == null ? "encours" : ""}">${etatEpisode(ep)}</span>`) },
  ] },
};
BLOCS.detours = { titre: "Détours observés", colonnes: [
  colLigne(d => d.route),
  colDirection(d => d.direction),
  { cle: "etat", titre: "État", type: "liste",
    val: d => (d.manuel ? "tracé à la main" : d.force ? "validé manuellement" : d.valide ? "validé"
               : d.longueur_validee_m > 0 ? "partiellement validé" : "potentiel"),
    html: d => `<span class="puce ${d.valide ? "detour_valide" : "hors_trajet"}">` +
               `${d.manuel ? "✏ tracé à la main" : d.force ? "↪ validé (manuel)" : d.valide ? "↪ validé"
                 : d.longueur_validee_m > 0 ? "partiellement validé" : "potentiel"}</span>` },
  { cle: "bus", titre: "Bus", type: "nombre", val: d => d.n_bus, html: d => `<span title="${esc(d.bus.join(", "))}">${d.n_bus}</span>` },
  { cle: "passages", titre: "Passages", type: "nombre", val: d => d.passages, aide: "Passages terminés (bus revenu sur son tracé)" },
  { cle: "longueur", titre: "Longueur", type: "nombre", unite: "km", val: d => d.longueur_m / 1000,
    html: d => `${(d.longueur_m / 1000).toLocaleString("fr-CA", { maximumFractionDigits: 1 })} km` },
  { cle: "validee", titre: "Validée", type: "nombre", unite: "%", aide: "Part du tracé empruntée par au moins 2 bus",
    val: d => (d.longueur_m > 0 ? Math.round(100 * (d.longueur_validee_m ?? (d.valide ? d.longueur_m : 0)) / d.longueur_m) : 0),
    html: d => `${d.longueur_m > 0 ? Math.round(100 * (d.longueur_validee_m ?? (d.valide ? d.longueur_m : 0)) / d.longueur_m) : 0} %` },
  { cle: "debut", titre: "Depuis", type: "heure", num: true, val: d => d.debut, html: d => hhmm(d.debut) },
  { cle: "dernier", titre: "Dernier passage", type: "heure", num: true, val: d => d.dernier, html: d => hhmm(d.dernier) },
  { cle: "en_cours", titre: "En cours", type: "texte", val: d => d.en_cours.join(", ") },
] };
const colonne = (cleBloc, cleCol) => BLOCS[cleBloc]?.colonnes.find(c => c.cle === cleCol) || null;

// ----- État (par panneau, mémorisé par périmètre) -----
function lireFiltresStockes() {
  try { return JSON.parse(localStorage.getItem(CLE_FILTRES) || "{}") || {}; } catch (e) { return {}; }
}

function filtreValide(f) {
  if (!f || typeof f !== "object") return false;
  if (f.type === "liste") return Array.isArray(f.valeurs);
  return ["nombre", "texte", "heure"].includes(f.type);
}

function vuesStockees(cle) {
  const brut = lireFiltresStockes()[cle];
  const vues = {};
  if (!brut || typeof brut !== "object") return vues;
  for (const [b, v] of Object.entries(brut)) {
    if (!BLOCS[b] || !v || typeof v !== "object") continue;
    const filtres = {};
    for (const [c, f] of Object.entries(v.filtres || {})) if (colonne(b, c) && filtreValide(f)) filtres[c] = f;
    const tri = v.tri && colonne(b, v.tri.col) ? { col: v.tri.col, dir: v.tri.dir === "desc" ? "desc" : "asc" } : null;
    vues[b] = { tri, filtres };
  }
  return vues;
}

function sauverFiltres() {
  const tout = {};
  for (const p of TDBP.panneaux) {
    const vues = {};
    for (const [b, v] of Object.entries(p.vues)) if (v.tri || Object.keys(v.filtres).length) vues[b] = v;
    if (Object.keys(vues).length) tout[p.cle] = vues;
  }
  try { localStorage.setItem(CLE_FILTRES, JSON.stringify(tout)); } catch (e) { /* stockage indisponible */ }
}

function vueBloc(p, cleBloc) { return (p.vues[cleBloc] ??= { tri: null, filtres: {} }); }

// Filtre « une seule valeur incluse » (pastilles et tuiles) → cette valeur, sinon null
const filtreSimple = f => (f && f.type === "liste" && f.mode === "inclus" && f.valeurs.length === 1 ? f.valeurs[0] : null);

function basculerFiltreSimple(p, cleBloc, cleCol, valeur) {
  const vue = vueBloc(p, cleBloc);
  if (filtreSimple(vue.filtres[cleCol]) === valeur) delete vue.filtres[cleCol];
  else vue.filtres[cleCol] = { type: "liste", mode: "inclus", valeurs: [valeur] };
  majVue(p);
}

// Après tout changement de tri/filtre : mémoriser, redessiner le panneau, mettre à jour le bandeau
function majVue(p) {
  sauverFiltres();
  rendrePanneau(p);
  majBandeauFiltres();
}

// ----- Application -----
const minutesDuJour = t => { const d = new Date(t * 1000); return d.getHours() * 60 + d.getMinutes(); };

function passeFiltre(f, v) {
  switch (f.type) {
    case "liste": {
      // Valeur multiple (états d'un bus) : gardée si au moins une de ses valeurs est cochée
      const vals = (Array.isArray(v) ? v : [v]).map(texteCle);
      const set = new Set(f.valeurs);
      return f.mode === "exclus" ? vals.some(x => !set.has(x)) : vals.some(x => set.has(x));
    }
    case "nombre":
      if (v == null || Number.isNaN(v)) return false;
      return (f.min == null || v >= f.min) && (f.max == null || v <= f.max);
    case "texte":
      return normaliser(v).includes(normaliser(f.texte));
    case "heure": {
      if (v == null) return false;
      const m = minutesDuJour(v), de = f.de ?? 0, a = f.a ?? 1439;
      return de <= a ? m >= de && m <= a : m >= de || m <= a;   // plage à cheval sur minuit
    }
  }
  return true;
}

// Tri stable ; valeurs vides toujours en bas, quel que soit le sens
function trier(lignes, col, dir, c) {
  const cle = col.tri || col.val;
  const sens = dir === "desc" ? -1 : 1;
  const vide = v => v == null || v === "" || Number.isNaN(v);
  return lignes.map((x, i) => [x, cle(x, c), i]).sort((A, B) => {
    const va = vide(A[1]), vb = vide(B[1]);
    if (va || vb) return va === vb ? A[2] - B[2] : va ? 1 : -1;
    const d = typeof A[1] === "number" && typeof B[1] === "number" ? A[1] - B[1] : COLLATEUR.compare(String(A[1]), String(B[1]));
    return sens * d || A[2] - B[2];
  }).map(A => A[0]);
}

// Rend un tableau trié/filtré. lignes : ordre par défaut du bloc.
function tableau(p, cleBloc, lignes, c, vide = "Aucun.", max = BLOC_MAX, noteSuite = "") {
  const def = BLOCS[cleBloc];
  const vue = vueBloc(p, cleBloc);
  p.donnees[cleBloc] = { lignes, c };   // valeurs proposées dans les menus de filtre
  const actifs = def.colonnes.filter(col => vue.filtres[col.cle]);
  let rangs = actifs.length ? lignes.filter(x => actifs.every(col => passeFiltre(vue.filtres[col.cle], col.val(x, c)))) : lignes;
  const colTri = vue.tri && colonne(cleBloc, vue.tri.col);
  if (colTri) rangs = trier(rangs, colTri, vue.tri.dir, c);
  const res = { n: rangs.length, total: lignes.length, filtre: actifs.length > 0 };
  if (!lignes.length && !actifs.length) { res.html = `<div class="vide">${vide}</div>`; return res; }

  const entete = def.colonnes.map(col => {
    const dir = colTri === col ? vue.tri.dir : "";
    const num = col.num ?? col.type === "nombre";
    const aide = `Clic : trier par ${col.titre.toLowerCase()} (${dir === "asc" ? "décroissant" : "croissant"})${col.aide ? `\n${col.aide}` : ""}`;
    return `<th data-col="${col.cle}" class="${num ? "num" : ""}${dir ? " trie" : ""}${vue.filtres[col.cle] ? " filtre-actif" : ""}"` +
           ` aria-sort="${dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}"><span class="th-contenu">` +
           `<button type="button" class="th-lib" data-tri-col="${col.cle}" title="${esc(aide)}">${col.titre}` +
           `<span class="th-tri" aria-hidden="true">${dir === "asc" ? "▲" : dir === "desc" ? "▼" : ""}</span></button>` +
           `<button type="button" class="th-menu" data-menu-col="${col.cle}" title="Trier et filtrer « ${esc(col.titre)} »"` +
           ` aria-label="Trier et filtrer la colonne ${esc(col.titre)}">${ICONE_FILTRE}</button></span></th>`;
  }).join("");
  const corps = rangs.slice(0, max).map(x =>
    `<tr${def.classeLigne ? ` class="${def.classeLigne(x, c)}"` : ""}>` + def.colonnes.map(col => {
      const num = col.num ?? col.type === "nombre";
      const cls = [num ? "num" : "", col.large ? "large" : "", col.cls ? col.cls(x, c) : ""].filter(Boolean).join(" ");
      return `<td${cls ? ` class="${cls}"` : ""}>${col.html ? col.html(x, c) : esc(col.val(x, c))}</td>`;
    }).join("") + `</tr>`).join("");
  const aucun = !rangs.length
    ? `<tr><td colspan="${def.colonnes.length}" class="vide">${lignes.length ? "Aucune ligne ne correspond aux filtres." : vide}` +
      ` <button type="button" class="lien-discret" data-reinit-bloc="1">Retirer les filtres de ce tableau</button></td></tr>` : "";
  const reste = rangs.length > max ? `<div class="vide">… et ${rangs.length - max} autre(s)${noteSuite}</div>` : "";
  res.html = `<table><thead><tr>${entete}</tr></thead><tbody>${corps}${aucun}</tbody></table>${reste}`;
  return res;
}

function bloc(p, cleBloc, res, { titre = BLOCS[cleBloc].titre, outils = "" } = {}) {
  const vue = vueBloc(p, cleBloc);
  const nReglages = Object.keys(vue.filtres).length + (vue.tri ? 1 : 0);
  const compte = res.filtre
    ? `<span class="n" title="${nombre(res.n)} affiché(s) sur ${nombre(res.total)} (filtré)">${nombre(res.n)} / ${nombre(res.total)}</span>`
    : `<span class="n">${nombre(res.total)}</span>`;
  const reinit = nReglages
    ? `<button type="button" class="bloc-reinit" data-reinit-bloc="1" title="Retirer le tri et les filtres de ce tableau">${ICONE_FILTRE} ${nReglages} ×</button>` : "";
  return `<section class="bloc" data-bloc="${cleBloc}"><h3>${titre} ${compte}${reinit}${outils}</h3>` +
         `<div class="bloc-corps">${res.html}</div></section>`;
}

function rendreBlocs(p, r, data, multi) {
  const reg = data.regularite;
  const c = { idx: indexChamps(data), reg, regBus: reg?.bus || {}, maintenant: TDBP.maintenant, tRef: TDBP.histo.tRef };
  const blocs = [];

  // Régularité par ligne et direction (par défaut : du moins au plus régulier)
  blocs.push(bloc(p, "regularite", tableau(p, "regularite", r.lignesReg, c,
    reg ? "Aucune ligne avec au moins 2 écarts mesurables." : "Régularité indisponible.")));

  // Gaps de service
  blocs.push(bloc(p, "trous", tableau(p, "trous", r.trous, c, "Aucun gap de service.")));

  // Bus à surveiller (pastilles et tuiles = raccourcis du filtre de la colonne « État »)
  const busListe = [...r.bus].sort((a, b) => b.etats.length - a.etats.length || triLignes(a.v[c.idx.route_id], b.v[c.idx.route_id]));
  const etatSeul = filtreSimple(vueBloc(p, "bus").filtres.etat);
  const etatAutre = !etatSeul && vueBloc(p, "bus").filtres.etat;
  const pastilles = `<span class="filtres">` + [["", "Tous"], ...Object.entries(LIB_ETAT)].map(([etat, lib]) =>
    `<button type="button" class="filtre${(etat ? etatSeul === etat : !etatSeul && !etatAutre) ? " actif" : ""}" data-filtre-bus="${etat}">${lib}` +
    `${etat ? ` <span class="n">${r.comptesEtats[etat]}</span>` : ""}</button>`).join("") + `</span>`;
  blocs.push(bloc(p, "bus", tableau(p, "bus", busListe, c, "Aucun bus en anomalie."), { outils: pastilles }));

  // Détours observés (serveur/detours.py) : validés d'abord, puis par nombre de bus
  if (Array.isArray(r.detours)) {
    const detours = [...r.detours].sort((a, b) => b.valide - a.valide || b.n_bus - a.n_bus || triLignes(a.route, b.route));
    blocs.push(bloc(p, "detours", tableau(p, "detours", detours, c,
      "Aucun détour observé depuis le démarrage du serveur (tracé estimé dès qu'un bus quitte son tracé GTFS puis le rejoint).")));
  }

  // Voyages non livrés : sans véhicule, annulés en cours, annulations dans l'heure
  if (data.service) {
    const statut = { sans_vehicule: ["sans véhicule", "faible"], annule: ["annulé", "annule"] };
    const voyages = r.voyages.filter(v => statut[v[6]]).map(v => ({ v, lib: statut[v[6]][0], cls: statut[v[6]][1] }))
      .concat(r.aVenir.map(v => ({ v, lib: "annulé · à venir", cls: "annule" })))
      .sort((a, b) => triLignes(a.v[1], b.v[1]) || String(a.v[4]).localeCompare(String(b.v[4])));
    blocs.push(bloc(p, "voyages", tableau(p, "voyages", voyages, c, "Tous les voyages en cours ont un bus.")));
  }

  // Service non livré par ligne (réseau / plusieurs lignes)
  if (multi && data.service) {
    const lignes = r.pires.map(([route, cpt]) => ({ route, c: cpt, t: cpt[0] ? 100 * cpt[1] / cpt[0] : null }));
    blocs.push(bloc(p, "lignes", tableau(p, "lignes", lignes, c, "Aucune ligne touchée.")));
  }

  // Événements du périmètre depuis l'ouverture de la page (par défaut : plus récents en haut)
  const H = TDBP.histo;
  const eps = H.liste.filter(ep => !p.lignes || (ep.route != null && p.lignes.has(String(ep.route))))
    .sort((a, b) => b.debut - a.debut || b.vu - a.vu);
  const enCours = filtreSimple(vueBloc(p, "evenements").filtres.etat) === "en cours";
  const outilsHisto = `<span class="filtres"><button type="button" class="filtre${enCours ? " actif" : ""}" data-histo-en-cours="1">En cours seulement</button></span>`;
  blocs.push(bloc(p, "evenements", tableau(p, "evenements", eps, c, "Aucun événement pour l'instant.", EVENEMENTS_MAX, " (export CSV pour tout)"),
    { titre: `Événements depuis ${hhmm(H.ouverture)}`, outils: outilsHisto }));

  // Conserver le défilement interne des blocs d'une actualisation à l'autre
  const conteneur = p.el.querySelector(".pan-blocs");
  for (const b of conteneur.querySelectorAll(".bloc")) p.scroll[b.dataset.bloc] = b.querySelector(".bloc-corps").scrollTop;
  conteneur.innerHTML = blocs.join("");
  for (const b of conteneur.querySelectorAll(".bloc")) {
    const y = p.scroll[b.dataset.bloc];
    if (y) b.querySelector(".bloc-corps").scrollTop = y;
  }
}

// ===== Menu d'une colonne : trier, filtrer =====
const MENU = { el: null, p: null, bloc: null, col: null };

function creerMenu() {
  const el = document.createElement("div");
  el.className = "menu-col";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.addEventListener("click", clicMenu);
  el.addEventListener("input", saisieMenu);
  document.body.appendChild(el);
  return el;
}

function ouvrirMenuColonne(p, cleBloc, cleCol, ancre) {
  const col = colonne(cleBloc, cleCol);
  if (!col) return;
  document.getElementById("tdbpGestion").hidden = true;
  MENU.el ??= creerMenu();
  Object.assign(MENU, { p, bloc: cleBloc, col });
  MENU.el.setAttribute("aria-label", `Trier et filtrer : ${col.titre}`);
  rendreMenu();
  const r = ancre.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight) ancre.scrollIntoView({ block: "center" });
  placerMenu(ancre.getBoundingClientRect());
  (MENU.el.querySelector(".menu-cherche, .menu-filtre input") || MENU.el.querySelector("button"))?.focus({ preventScroll: true });
}

function fermerMenu() {
  if (MENU.el) MENU.el.hidden = true;
  MENU.p = null;
}

function rendreMenu() {
  const { p, bloc: cleBloc, col } = MENU;
  const vue = vueBloc(p, cleBloc);
  const f = vue.filtres[col.cle];
  const dir = vue.tri?.col === col.cle ? vue.tri.dir : "";
  MENU.el.innerHTML =
    `<div class="menu-tete"><b>${esc(col.titre)}</b><span>${esc(titrePerimetre(p.lignes))} · ${esc(BLOCS[cleBloc].titre)}</span></div>` +
    `<div class="menu-section"><div class="menu-lib">Trier</div><div class="menu-tri">` +
    [["asc", "▲ Croissant"], ["desc", "▼ Décroissant"], ["", "Par défaut"]].map(([d, lib]) =>
      `<button type="button" data-tri="${d}" class="${(d ? dir === d : !vue.tri) ? "actif" : ""}">${lib}</button>`).join("") +
    `</div>${col.aide ? `<div class="menu-aide">${esc(col.aide)}</div>` : ""}</div>` +
    `<div class="menu-section menu-filtre"><div class="menu-lib">Filtrer` +
    `<button type="button" class="lien-discret" data-effacer="1"${f ? "" : " hidden"}>Effacer le filtre</button></div>` +
    corpsFiltre(col, f, p.donnees[cleBloc]) + `</div>` +
    `<div class="menu-pied"><button type="button" class="action-btn" data-fermer="1">Fermer</button></div>`;
}

function corpsFiltre(col, f, donnees) {
  const lignes = donnees?.lignes || [];
  const val = x => col.val(x, donnees.c);
  if (col.type === "liste") {
    const compte = new Map();
    for (const x of lignes) for (const v of [].concat(val(x))) { const k = texteCle(v); compte.set(k, (compte.get(k) || 0) + 1); }
    if (f) for (const v of f.valeurs) if (!compte.has(v)) compte.set(v, 0);   // valeur filtrée absente en ce moment
    const lib = v => (col.lib ? col.lib(v) : v) || "(vide)";
    const valeurs = [...compte.keys()].sort((a, b) => COLLATEUR.compare(lib(a), lib(b)));
    if (!valeurs.length) return `<div class="menu-aide">Aucune valeur en ce moment.</div>`;
    const set = new Set(f?.valeurs || []);
    const coche = v => (!f ? true : f.mode === "exclus" ? !set.has(v) : set.has(v));
    return (valeurs.length > 8 ? `<input type="search" class="menu-cherche" placeholder="Chercher une valeur…" aria-label="Chercher une valeur">` : "") +
      `<div class="menu-liens"><button type="button" class="lien-discret" data-cocher="1">Tout cocher</button>` +
      `<button type="button" class="lien-discret" data-cocher="0">Tout décocher</button></div>` +
      `<div class="menu-valeurs">` + valeurs.map(v =>
        `<label><input type="checkbox" value="${esc(v)}"${coche(v) ? " checked" : ""}><span class="menu-val">${esc(lib(v))}</span>` +
        `<span class="n">${compte.get(v)}</span></label>`).join("") + `</div>`;
  }
  if (col.type === "nombre") {
    const vals = lignes.map(val).filter(v => v != null && !Number.isNaN(v));
    const fmt = v => (Math.round(v * 10) / 10).toLocaleString("fr-CA");
    const u = col.unite ? ` ${col.unite}` : "";
    return `<div class="menu-bornes"><label>Min <input type="number" step="any" data-borne="min" value="${f?.min ?? ""}"></label>` +
      `<label>Max <input type="number" step="any" data-borne="max" value="${f?.max ?? ""}"></label>${u ? `<span>${esc(u)}</span>` : ""}</div>` +
      (vals.length ? `<div class="menu-aide">Valeurs actuelles : ${fmt(Math.min(...vals))} à ${fmt(Math.max(...vals))}${esc(u)}</div>` : "");
  }
  if (col.type === "heure") {
    const hm = m => (m == null ? "" : `${deux(Math.floor(m / 60))}:${deux(m % 60)}`);
    return `<div class="menu-bornes"><label>De <input type="time" data-heure="de" value="${hm(f?.de)}"></label>` +
      `<label>À <input type="time" data-heure="a" value="${hm(f?.a)}"></label></div>`;
  }
  return `<input type="text" data-texte="1" placeholder="Contient…" aria-label="Contient" value="${esc(f?.texte || "")}">`;
}

function lireFiltreMenu() {
  const { p, bloc: cleBloc, col, el } = MENU;
  let f = null;
  if (col.type === "liste") {
    const cases = [...el.querySelectorAll('.menu-valeurs input[type="checkbox"]')];
    const oui = cases.filter(x => x.checked).map(x => x.value);
    const non = cases.filter(x => !x.checked).map(x => x.value);
    // Mémoriser la liste la plus courte : exclusions → une nouvelle valeur (ligne, état) reste visible
    if (non.length) f = non.length <= oui.length ? { type: "liste", mode: "exclus", valeurs: non } : { type: "liste", mode: "inclus", valeurs: oui };
  } else if (col.type === "nombre") {
    const lire = b => { const s = el.querySelector(`[data-borne="${b}"]`).value; return s === "" || Number.isNaN(+s) ? null : +s; };
    const min = lire("min"), max = lire("max");
    if (min != null || max != null) f = { type: "nombre", min, max };
  } else if (col.type === "heure") {
    const lire = b => { const s = el.querySelector(`[data-heure="${b}"]`).value; if (!s) return null; const [h, m] = s.split(":").map(Number); return h * 60 + m; };
    const de = lire("de"), a = lire("a");
    if (de != null || a != null) f = { type: "heure", de, a };
  } else {
    const s = el.querySelector("[data-texte]").value.trim();
    if (s) f = { type: "texte", texte: s };
  }
  const vue = vueBloc(p, cleBloc);
  if (f) vue.filtres[col.cle] = f; else delete vue.filtres[col.cle];
  el.querySelector("[data-effacer]").hidden = !f;
  majVue(p);
}

function saisieMenu(e) {
  if (e.target.classList.contains("menu-cherche")) {
    const q = normaliser(e.target.value);
    for (const lab of MENU.el.querySelectorAll(".menu-valeurs label")) lab.hidden = !normaliser(lab.textContent).includes(q);
    return;
  }
  lireFiltreMenu();
}

function clicMenu(e) {
  const b = e.target.closest("button");
  if (!b || !MENU.p) return;
  const { p, bloc: cleBloc, col } = MENU;
  const vue = vueBloc(p, cleBloc);
  if (b.dataset.tri != null) {
    vue.tri = b.dataset.tri ? { col: col.cle, dir: b.dataset.tri } : null;
    for (const x of MENU.el.querySelectorAll("[data-tri]")) {
      x.classList.toggle("actif", x.dataset.tri ? vue.tri?.col === col.cle && vue.tri.dir === x.dataset.tri : !vue.tri);
    }
    majVue(p);
  } else if (b.dataset.effacer) {
    delete vue.filtres[col.cle];
    rendreMenu();
    majVue(p);
  } else if (b.dataset.cocher != null) {
    for (const lab of MENU.el.querySelectorAll(".menu-valeurs label")) if (!lab.hidden) lab.querySelector("input").checked = b.dataset.cocher === "1";
    lireFiltreMenu();
  } else if (b.dataset.fermer) {
    fermerMenu();
  }
}

function placerMenu(rect) {
  const m = MENU.el;
  m.hidden = false;
  const w = m.offsetWidth, h = m.offsetHeight;
  const left = Math.max(8, Math.min(rect.left, innerWidth - w - 8));
  let top = rect.bottom + 4;
  if (top + h > innerHeight - 8) top = rect.top - h - 4;
  top = Math.max(8, Math.min(top, innerHeight - h - 8));   // toujours entièrement dans la fenêtre
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
}

// Le panneau est redessiné toutes les 10 s et défile : le menu suit son en-tête de colonne
function repositionnerMenu() {
  if (!MENU.p || MENU.el.hidden) return;
  const th = MENU.p.el.querySelector(`[data-bloc="${MENU.bloc}"] th[data-col="${MENU.col.cle}"]`);
  if (th && !MENU.p.el.hidden) placerMenu(th.getBoundingClientRect());
}

// ===== Bandeau « N filtres actifs » et gestion globale =====
function listeReglages() {
  const liste = [];
  TDBP.panneaux.forEach((p, i) => {
    for (const [cleBloc, vue] of Object.entries(p.vues)) {
      if (!BLOCS[cleBloc]) continue;
      for (const [cleCol, f] of Object.entries(vue.filtres)) {
        const col = colonne(cleBloc, cleCol);
        if (col) liste.push({ p, i, bloc: cleBloc, col, f });
      }
      const col = vue.tri && colonne(cleBloc, vue.tri.col);
      if (col) liste.push({ p, i, bloc: cleBloc, col, tri: vue.tri.dir });
    }
  });
  return liste;
}

function descFiltre(col, f) {
  const u = col.unite ? ` ${col.unite}` : "";
  const n = v => v.toLocaleString("fr-CA");
  if (f.type === "liste") {
    const libs = f.valeurs.map(v => (col.lib ? col.lib(v) : v) || "(vide)");
    const txt = libs.length > 5 ? `${libs.slice(0, 5).join(", ")} +${libs.length - 5}` : libs.join(", ");
    return f.mode === "exclus" ? `tout sauf ${txt}` : libs.length ? txt : "aucune valeur";
  }
  if (f.type === "nombre") {
    if (f.min != null && f.max != null) return `entre ${n(f.min)} et ${n(f.max)}${u}`;
    return f.min != null ? `≥ ${n(f.min)}${u}` : `≤ ${n(f.max)}${u}`;
  }
  if (f.type === "heure") {
    const hm = m => `${deux(Math.floor(m / 60))}:${deux(m % 60)}`;
    if (f.de != null && f.a != null) return `de ${hm(f.de)} à ${hm(f.a)}`;
    return f.de != null ? `à partir de ${hm(f.de)}` : `jusqu'à ${hm(f.a)}`;
  }
  return `contient « ${f.texte} »`;
}

function majBandeauFiltres() {
  const liste = listeReglages();
  const nF = liste.filter(x => x.f).length, nT = liste.length - nF;
  const el = document.getElementById("tdbpFiltres");
  el.hidden = !liste.length;
  const s = (k, mot) => `${k} ${mot}${k > 1 ? "s" : ""}`;
  document.getElementById("tdbpFiltresTexte").textContent =
    nF ? `${s(nF, "filtre")} ${nF > 1 ? "actifs" : "actif"}${nT ? ` · ${s(nT, "tri")}` : ""}` : `${s(nT, "tri")} ${nT > 1 ? "actifs" : "actif"}`;
  document.getElementById("tdbpFiltresTexte").title = liste.map(x =>
    `${titrePerimetre(x.p.lignes)} · ${BLOCS[x.bloc].titre} · ${x.col.titre} : ${x.f ? descFiltre(x.col, x.f) : x.tri === "asc" ? "tri croissant" : "tri décroissant"}`).join("\n");
  const g = document.getElementById("tdbpGestion");
  if (!g.hidden) { if (liste.length) rendreGestion(); else g.hidden = true; }
}

function rendreGestion() {
  const g = document.getElementById("tdbpGestion");
  const liste = listeReglages();
  let html = `<div class="menu-tete"><b>Filtres et tris actifs</b><span>tous les panneaux</span></div>`;
  let dernier = null;
  for (const x of liste) {
    if (x.p !== dernier) {
      html += `${dernier ? "</ul>" : ""}<div class="gestion-pan">${esc(titrePerimetre(x.p.lignes))}</div><ul class="gestion-liste">`;
      dernier = x.p;
    }
    const ref = `${x.i}|${x.bloc}|${x.col.cle}`;
    const quoi = x.f ? `<b>${esc(x.col.titre)}</b> : ${esc(descFiltre(x.col, x.f))}`
                     : `tri par <b>${esc(x.col.titre)}</b> ${x.tri === "asc" ? "▲ croissant" : "▼ décroissant"}`;
    html += `<li><span class="gestion-lib"><span class="gestion-bloc">${esc(BLOCS[x.bloc].titre)}</span>${quoi}</span>` +
            `<button type="button" class="lien-discret" data-modifier="${ref}">Modifier</button>` +
            `<button type="button" class="gestion-x" data-retirer="${ref}" data-tri="${x.f ? "" : "1"}" ` +
            `title="Supprimer" aria-label="Supprimer">×</button></li>`;
  }
  html += dernier ? "</ul>" : `<div class="menu-aide">Aucun filtre actif.</div>`;
  html += `<div class="menu-pied"><button type="button" class="action-btn" data-tout-supprimer="1"${liste.length ? "" : " disabled"}>Tout supprimer</button>` +
          `<button type="button" class="action-btn" data-fermer="1">Fermer</button></div>`;
  g.innerHTML = html;
}

function clicGestion(e) {
  const g = document.getElementById("tdbpGestion");
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.fermer) { g.hidden = true; return; }
  if (b.dataset.toutSupprimer) {
    fermerMenu();
    for (const p of TDBP.panneaux) p.vues = {};
    sauverFiltres();
    rendreTout();
    g.hidden = true;
    majBandeauFiltres();
    return;
  }
  const ref = b.dataset.retirer || b.dataset.modifier;
  if (!ref) return;
  const [i, cleBloc, cleCol] = ref.split("|");
  const p = TDBP.panneaux[+i];
  if (!p) return;
  if (b.dataset.retirer) {
    const vue = vueBloc(p, cleBloc);
    if (b.dataset.tri) vue.tri = null; else delete vue.filtres[cleCol];
    if (MENU.p === p && MENU.bloc === cleBloc && MENU.col.cle === cleCol) rendreMenu();
    majVue(p);
    if (!g.hidden) rendreGestion();
    return;
  }
  // Modifier : amener le tableau à l'écran et ouvrir le menu de la colonne
  g.hidden = true;
  if (p.el.hidden) { TDBP.solo = null; disposer(); }
  const blocEl = p.el.querySelector(`[data-bloc="${cleBloc}"]`);
  const th = blocEl?.querySelector(`th[data-col="${cleCol}"]`);
  if (blocEl) { blocEl.scrollIntoView({ block: "nearest" }); signaler(blocEl); }
  ouvrirMenuColonne(p, cleBloc, cleCol, th || document.getElementById("tdbpFiltresModifier"));
}

function initFiltres() {
  const g = document.getElementById("tdbpGestion");
  g.addEventListener("click", clicGestion);
  document.getElementById("tdbpFiltresModifier").addEventListener("click", () => {
    fermerMenu();
    if (!g.hidden) { g.hidden = true; return; }
    rendreGestion();
    g.hidden = false;
    const r = document.getElementById("tdbpFiltres").getBoundingClientRect();
    g.style.left = `${Math.max(8, Math.min(r.left, innerWidth - g.offsetWidth - 8))}px`;
    g.style.top = `${r.bottom + 6}px`;
  });
  // Fermer menus et gestion : clic ailleurs, Échap
  document.addEventListener("mousedown", (e) => {
    const t = e.target;
    if (MENU.el && !MENU.el.hidden && !MENU.el.contains(t) && !t.closest("[data-menu-col]") && !g.contains(t)) fermerMenu();
    if (!g.hidden && !g.contains(t) && !t.closest("#tdbpFiltresModifier") && !(MENU.el && MENU.el.contains(t))) g.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (MENU.el && !MENU.el.hidden) fermerMenu();
    else g.hidden = true;
  });
  let prevu = false;
  document.addEventListener("scroll", () => {
    if (prevu || !MENU.p) return;
    prevu = true;
    requestAnimationFrame(() => { prevu = false; repositionnerMenu(); });
  }, true);
  window.addEventListener("resize", () => { repositionnerMenu(); g.hidden = true; });
}

// ===== Séries temporelles (courbes depuis l'ouverture) =====
function ajouterInstantane(data, maintenant) {
  const S = TDBP.serie;
  const idx = indexChamps(data);
  const iRoute = route => {
    const r = String(route ?? "");   // "" : bus sans ligne (compté dans le réseau seulement)
    let i = S.routes.get(r);
    if (i == null) { i = S.routes.size; S.routes.set(r, i); }
    return i;
  };
  const s = data.service, reg = data.regularite;
  if (s) for (const r of Object.keys(s.par_ligne)) iRoute(r);
  if (reg) for (const l of Object.values(reg.lignes)) iRoute(l.route);
  for (const v of data.vehicules) iRoute(v[idx.route_id]);
  const n = S.routes.size;
  const a = new Int16Array(n * NK);
  const plus = (route, k, x = 1) => { a[iRoute(route) * NK + k] += x; };
  if (s) {
    for (const [r, c] of Object.entries(s.par_ligne)) {
      plus(r, K.prevus, c[0]); plus(r, K.vu, c[1]); plus(r, K.annule, c[2]); plus(r, K.sans, c[3]);
    }
  }
  if (reg) {
    for (const l of Object.values(reg.lignes)) { plus(l.route, K.ecarts, l.n_ecarts); plus(l.route, K.reguliers, l.n_reguliers); }
    for (const e of reg.ecarts) if (e.type === "trou") plus(e.route, K.trous);
  }
  for (const d of (data.detours || [])) if (d.valide) plus(d.route, K.detours);
  const regBus = reg?.bus || {};
  const etatsK = { train: K.trains, hors_trajet: K.hors, figes: K.figes, depassement: K.dep, pleins: K.pleins };
  for (const v of data.vehicules) {
    const r = v[idx.route_id];
    plus(r, K.bus);
    for (const [etat, k] of Object.entries(etatsK)) if (RT_ETATS[etat].teste(v, idx, maintenant, regBus)) plus(r, k);
  }
  const tot = new Int32Array(NK);
  for (let i = 0; i < n; i++) for (let k = 0; k < NK; k++) tot[k] += a[i * NK + k];
  S.instantanes.push({ t: data.t_flux || maintenant, n, a, tot });
  if (S.instantanes.length > SERIE_MAX) S.instantanes.shift();
}

function seriePerimetre(lignes) {
  const S = TDBP.serie;
  const ids = lignes ? [...lignes].map(l => S.routes.get(l)).filter(i => i != null) : null;
  return S.instantanes.map(ins => {
    let v = ins.tot;
    if (ids) {
      v = new Int32Array(NK);
      for (const i of ids) if (i < ins.n) for (let k = 0; k < NK; k++) v[k] += ins.a[i * NK + k];
    }
    return { t: ins.t,
             taux: v[K.prevus] ? 100 * v[K.vu] / v[K.prevus] : null,
             indice: v[K.ecarts] ? 100 * v[K.reguliers] / v[K.ecarts] : null,
             trous: v[K.trous], trains: v[K.trains], hors: v[K.hors], figes: v[K.figes], dep: v[K.dep],
             detours: v[K.detours] };
  });
}

const GRAPHES = {
  service: { max: 100, unite: " %", series: [
    { cle: "taux", nom: "Service livré", couleur: "#4f9fff" },
    { cle: "indice", nom: "Régularité", couleur: "#6db86d" }] },
  incidents: { series: [
    { cle: "trous", nom: "Gaps de service", couleur: "#ef5350" },
    { cle: "trains", nom: "Bus en bunching", couleur: "#ce93d8" },
    { cle: "hors", nom: "Hors trajet", couleur: "#ffb300" },
    { cle: "detours", nom: "Détours validés", couleur: "#fb8c00" },
    { cle: "figes", nom: "Figés", couleur: "#90a4ae" },
    { cle: "dep", nom: "Dépassements", couleur: "#ff8a65" }] },
};

function rendreGraphes(p) {
  const points = seriePerimetre(p.lignes);
  p.points = points;
  for (const fig of p.el.querySelectorAll(".graphe")) dessinerGraphique(fig, points, GRAPHES[fig.dataset.g]);
}

function redessinerGraphes() {
  for (const p of TDBP.panneaux) {
    if (p.el.hidden || !p.points) continue;
    for (const fig of p.el.querySelectorAll(".graphe")) dessinerGraphique(fig, p.points, GRAPHES[fig.dataset.g]);
  }
}

const echelleRonde = m => {
  if (m <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(m));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= m) return f * p;
  return 10 * p;
};

function dessinerGraphique(fig, points, def) {
  const zone = fig.querySelector(".graphe-zone");
  const legende = fig.querySelector(".graphe-legende");
  const dernier = points.at(-1);
  legende.innerHTML = def.series.map(s => {
    const v = dernier ? dernier[s.cle] : null;
    return `<span><i style="background:${s.couleur}"></i>${s.nom} <b>${v == null ? "–" : Math.round(v)}${def.unite || ""}</b></span>`;
  }).join("");
  if (points.length < 2) {
    zone.innerHTML = `<div class="graphe-vide">Courbe après 2 instantanés du flux (≈ 40 s)…</div>`;
    return;
  }
  const w = Math.max(200, zone.clientWidth || 400), h = 150;
  const m = { g: 34, d: 10, h: 8, b: 20 };
  const t0 = points[0].t, t1 = dernier.t;
  const valeurs = points.flatMap(pt => def.series.map(s => pt[s.cle])).filter(v => v != null);
  const yMax = def.max ?? echelleRonde(Math.max(1, ...valeurs));
  const x = t => m.g + (t1 === t0 ? 0 : (t - t0) / (t1 - t0)) * (w - m.g - m.d);
  const y = v => m.h + (1 - v / yMax) * (h - m.h - m.b);
  let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(fig.querySelector("figcaption").textContent)}">`;
  for (const f of [0, 0.5, 1]) {
    const v = yMax * f, yy = y(v);
    svg += `<line class="grille" x1="${m.g}" x2="${w - m.d}" y1="${yy}" y2="${yy}"/>` +
           `<text class="axe" x="${m.g - 4}" y="${yy + 3}" text-anchor="end">${Math.round(v)}</text>`;
  }
  const tm = (t0 + t1) / 2;
  svg += `<text class="axe" x="${m.g}" y="${h - 5}">${hhmm(t0)}</text>` +
         `<text class="axe" x="${x(tm)}" y="${h - 5}" text-anchor="middle">${hhmm(tm)}</text>` +
         `<text class="axe" x="${w - m.d}" y="${h - 5}" text-anchor="end">${hhmm(t1)}</text>`;
  for (const s of def.series) {
    let d = "", leve = true;
    for (const pt of points) {
      const v = pt[s.cle];
      if (v == null) { leve = true; continue; }
      d += `${leve ? "M" : "L"}${x(pt.t).toFixed(1)},${y(v).toFixed(1)}`;
      leve = false;
    }
    svg += `<path d="${d}" fill="none" stroke="${s.couleur}" stroke-width="1.8" stroke-linejoin="round"/>`;
  }
  svg += `<line class="curseur" x1="0" x2="0" y1="${m.h}" y2="${h - m.b}" visibility="hidden"/>` +
         `<rect class="survol" x="${m.g}" y="0" width="${w - m.g - m.d}" height="${h}" fill="transparent"/></svg>` +
         `<div class="graphe-bulle" hidden></div>`;
  zone.innerHTML = svg;

  // Survol : valeurs de l'instantané le plus proche
  const rect = zone.querySelector(".survol");
  const curseur = zone.querySelector(".curseur");
  const bulle = zone.querySelector(".graphe-bulle");
  rect.addEventListener("mousemove", (e) => {
    const bx = e.clientX - zone.getBoundingClientRect().left;
    const t = t0 + (bx - m.g) / (w - m.g - m.d) * (t1 - t0);
    let i = 0;
    while (i < points.length - 1 && Math.abs(points[i + 1].t - t) <= Math.abs(points[i].t - t)) i++;
    const pt = points[i], xx = x(pt.t);
    curseur.setAttribute("x1", xx); curseur.setAttribute("x2", xx);
    curseur.setAttribute("visibility", "visible");
    bulle.innerHTML = `<b>${hhmmss(pt.t)}</b>` + def.series.map(s =>
      `<div><i style="background:${s.couleur}"></i>${s.nom} : ${pt[s.cle] == null ? "–" : Math.round(pt[s.cle]) + (def.unite || "")}</div>`).join("");
    bulle.hidden = false;
    bulle.style.left = `${Math.min(xx + 8, w - bulle.offsetWidth - 4)}px`;
  });
  rect.addEventListener("mouseleave", () => { curseur.setAttribute("visibility", "hidden"); bulle.hidden = true; });
}

// ===== Collecte =====
// Renvoie le délai avant l'appel suivant (juste après la prochaine version du flux)
async function rafraichir() {
  if (TDBP.enVol) return 1000;
  TDBP.enVol = true;
  let delai = RT_RAFRAICHISSEMENT_MS;
  try {
    const rep = await fetch("/api/rt/vehicules", { cache: "no-store" });
    const data = await rep.json();
    if (!rep.ok) throw new Error(data.error || `HTTP ${rep.status}`);
    delai = delaiProchainFlux(data);
    TDBP.erreur = null;
    TDBP.histo.fluxRetabli();
    const maintenant = Math.floor(Date.now() / 1000);
    const nouveau = TDBP.histo.enregistrer(data);
    TDBP.dernier = data;
    TDBP.maintenant = maintenant;
    if (nouveau) {
      ajouterInstantane(data, maintenant);
      majListeLignes(data);
      rendreTout();
    }
  } catch (err) {
    TDBP.erreur = err.message;
    TDBP.histo.erreurFlux(err.message);
    if (!TDBP.dernier) rendreTout();
  } finally {
    TDBP.enVol = false;
    majStatut();
  }
  return delai;
}

function rendreTout() {
  if (!TDBP.panneaux.length) { rendreVide(); return; }
  document.querySelector(".tdbp-vide")?.remove();
  for (const p of TDBP.panneaux) rendrePanneau(p);
}

function rendreVide() {
  const grille = document.getElementById("tdbpGrille");
  if (!grille || grille.querySelector(".tdbp-vide")) return;
  const d = document.createElement("div");
  d.className = "tdbp-vide";
  d.innerHTML = `<p>Aucun panneau ouvert.</p><button type="button" class="action-btn primary">+ Panneau « Réseau »</button>`;
  d.querySelector("button").addEventListener("click", () => { d.remove(); ajouterPanneau(null); });
  grille.style.gridTemplateColumns = "1fr";
  grille.appendChild(d);
}

function majListeLignes(data) {
  const liste = document.getElementById("tdbpLignes");
  const lignes = [...lignesConnues(data)].sort(triLignes);
  if (liste.childElementCount === lignes.length + 1) return;
  liste.innerHTML = `<option value="réseau">` + lignes.map(l => `<option value="${esc(l)}">`).join("");
}

function majStatut() {
  const el = document.getElementById("tdbpStatut");
  const data = TDBP.dernier;
  if (!data) {
    el.textContent = TDBP.erreur ? `⚠ Flux indisponible : ${TDBP.erreur}` : "Connexion au flux…";
    el.classList.toggle("erreur", !!TDBP.erreur);
    return;
  }
  const maintenant = Math.floor(Date.now() / 1000);
  const age = data.t_flux ? maintenant - data.t_flux : null;
  const ref = data.referentiel;
  el.textContent =
    `Flux STM ${data.t_flux ? hhmmss(data.t_flux) : "?"}${age != null ? ` (il y a ${age} s)` : ""}` +
    ` · ${nombre(data.vehicules.length)} bus` + (ref ? ` · horaire GTFS ${ref.version}` : "") +
    ` · courbes depuis ${hhmm(TDBP.histo.ouverture)} (${TDBP.serie.instantanes.length} instantanés)` +
    (data.perime ? " · ⚠ STM injoignable, dernières données connues" : "") +
    (TDBP.erreur ? ` · ⚠ ${TDBP.erreur}` : "");
  el.classList.toggle("erreur", !!(data.perime || TDBP.erreur || (age != null && age > 120)));
}

// ===== Démarrage =====
function init() {
  document.getElementById("tdbpInfo").title =
    "Service livré : voyages prévus en cours (horaire GTFS) portés par un bus du flux.\n" +
    "« Sans véhicule » : voyage en cours depuis ≥ 5 min, jamais vu dans le flux ni annulé.\n" +
    "« Annulé » : marqué CANCELED dans tripUpdates (GTFS-RT STM).\n" +
    "Régularité : bus ordonnés le long du tracé de leur ligne/direction ; écart (en minutes, à la vitesse prévue) ÷ " +
    "intervalle prévu : < 0,25 = bus bunching, > 2 = gap de service ; indice = part des écarts entre 0,5 et 1,5. " +
    "Un vide en bout de ligne (sans bus devant) n'est pas détecté ; bus aux terminus exclus.\n" +
    "Détours : quand un bus quitte le tracé GTFS de son voyage, son tracé est estimé sur le réseau routier routable " +
    "(positions à moins de 40 m d'une rue, reliées par le plus court chemin) ; validé quand au moins 2 bus de la " +
    "ligne/direction empruntent le même tracé (≥ 50 % de rues en commun). Un bus en détour validé n'est plus « hors trajet ».\n" +
    "Courbes et événements : depuis l'ouverture de cet onglet (rien n'est conservé côté serveur).\n" +
    "Clic sur un numéro de ligne : l'ouvrir dans un nouveau panneau (écran partagé).\n" +
    "Tableaux : clic sur un titre de colonne = trier (croissant ↔ décroissant) ; l'entonnoir qui apparaît au survol = trier et filtrer. " +
    "Tris et filtres sont propres à chaque panneau et mémorisés dans ce navigateur.";
  document.getElementById("tdbpCarte").addEventListener("click", () => window.open("/", "carte-segments"));
  document.getElementById("tdbpExport").addEventListener("click", () => {
    const d = new Date();
    telechargerTexte(csvHistorique(TDBP.histo.liste, TDBP.histo.tRef),
                     `historique_reseau_${d.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`);
  });
  const btnPE = document.getElementById("tdbpPleinEcran");
  btnPE.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => { /* refusé par le navigateur */ });
  });
  document.addEventListener("fullscreenchange", () => {
    btnPE.textContent = document.fullscreenElement ? "⛶ Quitter le plein écran" : "⛶ Plein écran";
  });
  if (!TDBP_RT_DISPONIBLE) {
    document.getElementById("tdbpStatut").textContent = "⚠ Temps réel indisponible (STM_API_KEY absente)";
    document.getElementById("tdbpAjout").hidden = true;
    return;
  }
  document.getElementById("tdbpAjout").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("tdbpPerimetre");
    document.querySelector(".tdbp-vide")?.remove();
    ajouterPanneau(parserPerimetre(input.value));
    input.value = "";
  });
  // La carte rouvre cet onglet avec un autre périmètre : on garde courbes et événements
  window.addEventListener("hashchange", () => appliquerConfiguration(lireConfiguration()));
  if ("ResizeObserver" in window) {
    let prevu = false;
    new ResizeObserver(() => {
      if (prevu) return;
      prevu = true;
      requestAnimationFrame(() => { prevu = false; redessinerGraphes(); });
    }).observe(document.getElementById("tdbpGrille"));
  }
  initFiltres();
  appliquerConfiguration(lireConfiguration());
  new BoucleFlux(rafraichir).demarrer();   // continue en arrière-plan : c'est un écran de suivi
  setInterval(majStatut, 5000);
}

init();
