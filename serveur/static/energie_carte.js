/* =====================================================
   Prévision énergétique sur la carte (section « Prévision énergétique »)
   Colore les segments affichés selon la consommation estimée par le modèle
   physique road-load (p06, traction + chauffage) :
   - « Consommation par segment » : moyenne des passages sur chaque segment ;
   - « Consommation totale » : moyenne d'un voyage de la ligne-direction,
     toute la ligne-direction prend la même couleur ;
   - en kWh ou en kWh/km, sur une plage de mois (déc → fév passe par janvier).
   Échelle vert (min) → rouge (max) sur ce qui est affiché : toutes les lignes
   affichées, ou la seule ligne / direction choisie.
   Données : /api/energie/carte (sommes mensuelles, agrégées ici).
   Chargé après carte.js (segmentLayers, SyncBus, DataLoader, map, MOIS_COURTS).
   ===================================================== */

const CLE_ENERGIE = "carte.energie";
const ENERGIE_COULEURS = ["#1a9850", "#91cf60", "#fee08b", "#fc8d59", "#d73027"];   // vert → rouge
const ENERGIE_PREREGLAGES = [["Année", 1, 12], ["Hiver", 12, 2], ["Printemps", 3, 5], ["Été", 6, 8], ["Automne", 9, 11]];
const ENERGIE_QUANTILE = 0.02;   // « ignorer les valeurs extrêmes » : 2 % de chaque côté

const ENERGIE = {
  donnees: null,        // payload /api/energie/carte
  index: null,          // segment_id (jeu normal) -> rang dans le payload
  chargement: null,     // promesse en cours
  erreur: null,
  sommes: null,         // agrégats de la période courante (cache par période)
  valeurs: new Map(),   // segment affiché (id carte) -> {v, n, ...} de la dernière mise à jour
  bornes: null,         // {min, max, borneBasse, borneHaute, n}
  applique: false,      // des couleurs sont actuellement posées sur la carte
  bulle: null,          // infobulle de survol (L.tooltip unique)
  legende: null,        // contrôle Leaflet
  reglages: { actif: false, agregation: "segment", unite: "kwhkm", de: 1, a: 12, robuste: false, reseau: false },
};

const fmtNombre = (x, d = 1) => x.toLocaleString("fr-CA", { minimumFractionDigits: d, maximumFractionDigits: d });
const libUnite = () => (ENERGIE.reglages.unite === "kwh" ? "kWh" : "kWh/km");

// Mois de la période, plage circulaire (déc → fév = 12, 1, 2)
function moisPeriode(de, a) {
  const mois = [];
  for (let m = de; ; m = m % 12 + 1) { mois.push(m); if (m === a || mois.length === 12) break; }
  return mois;
}

function libellePeriode() {
  const { de, a } = ENERGIE.reglages;
  const pre = ENERGIE_PREREGLAGES.find(([, d, f]) => d === de && f === a);
  if (pre) return pre[0] === "Année" ? "année complète" : pre[0].toLowerCase();
  return de === a ? MOIS_COURTS[de] : `${MOIS_COURTS[de]} → ${MOIS_COURTS[a]}`;
}

function temperaturePeriode() {
  const t = moisPeriode(ENERGIE.reglages.de, ENERGIE.reglages.a)
    .map(m => ENERGIE.donnees?.temperature_mois?.[m - 1]).filter(x => x != null);
  return t.length ? t.reduce((s, x) => s + x, 0) / t.length : null;
}

// ----- Réglages (mémorisés dans ce navigateur) -----
function lireReglagesEnergie() {
  try {
    const r = JSON.parse(localStorage.getItem(CLE_ENERGIE) || "null");
    if (!r || typeof r !== "object") return;
    const R = ENERGIE.reglages;
    if (["segment", "voyage"].includes(r.agregation)) R.agregation = r.agregation;
    if (["kwh", "kwhkm"].includes(r.unite)) R.unite = r.unite;
    for (const k of ["de", "a"]) if (Number.isInteger(r[k]) && r[k] >= 1 && r[k] <= 12) R[k] = r[k];
    for (const k of ["actif", "robuste", "reseau"]) R[k] = !!r[k];
  } catch (e) { /* stockage indisponible */ }
}

function sauverReglagesEnergie() {
  try { localStorage.setItem(CLE_ENERGIE, JSON.stringify(ENERGIE.reglages)); } catch (e) { /* idem */ }
}

// ----- Données -----
async function chargerEnergie() {
  if (ENERGIE.donnees) return ENERGIE.donnees;
  ENERGIE.chargement ??= fetch("/api/energie/carte").then(async (r) => {
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    ENERGIE.donnees = d;
    ENERGIE.index = new Map(d.segments.id.map((id, i) => [id, i]));
    ENERGIE.erreur = null;
    return d;
  }).catch((err) => {
    ENERGIE.erreur = err.message;
    ENERGIE.chargement = null;
    throw err;
  });
  return ENERGIE.chargement;
}

// Sommes de la période : Σ Wh / passages par segment, Σ Wh / km / voyages par parcours
function sommesPeriode() {
  const { de, a } = ENERGIE.reglages;
  const cle = `${de}-${a}`;
  if (ENERGIE.sommes?.cle === cle) return ENERGIE.sommes;
  const D = ENERGIE.donnees, mois = moisPeriode(de, a);
  const S = D.segments, P = D.parcours;
  const N = S.id.length, NP = P.id.length;
  const segWh = new Float64Array(N), segN = new Float64Array(N);
  for (let i = 0; i < N; i++) for (const m of mois) { segWh[i] += S.wh[i * 12 + m - 1]; segN[i] += S.n[i * 12 + m - 1]; }
  const pcWh = new Float64Array(NP), pcKm = new Float64Array(NP), pcN = new Float64Array(NP);
  for (let j = 0; j < NP; j++) {
    for (const m of mois) { pcWh[j] += P.wh[j * 12 + m - 1]; pcKm[j] += P.km[j * 12 + m - 1]; pcN[j] += P.n[j * 12 + m - 1]; }
  }
  ENERGIE.sommes = { cle, segWh, segN, pcWh, pcKm, pcN };
  return ENERGIE.sommes;
}

// Segments du modèle (jeu normal) derrière un segment de la carte. En mode
// fusion, un nœud regroupe plusieurs segments (plusieurs lignes) : on ne garde
// que ceux des lignes affichées quand un filtre de lignes est actif.
function constituantsEnergie(entry) {
  const idx = ENERGIE.index;
  if (DataLoader.mode !== "fusion") {
    const i = idx.get(Number(entry.seg.id));
    return i == null ? [] : [i];
  }
  const lignes = SyncBus.getState().visibleLines;
  const out = [];
  for (const s of (DataLoader.liaison.get(Number(entry.seg.id))?.segments || [])) {
    if (lignes.size && !lignes.has(String(s.route_id))) continue;
    const i = idx.get(Number(s.seg_id));
    if (i != null) out.push(i);
  }
  return out;
}

// Valeur d'un ensemble de segments du modèle selon l'agrégation et l'unité
function valeurEnergie(rangs) {
  if (!rangs.length) return null;
  const S = ENERGIE.donnees.segments, T = sommesPeriode();
  const parKm = ENERGIE.reglages.unite === "kwhkm";
  if (ENERGIE.reglages.agregation === "segment") {
    let wh = 0, n = 0, nm = 0;
    for (const i of rangs) { wh += T.segWh[i]; n += T.segN[i]; nm += T.segN[i] * S.distance_m[i]; }
    if (!n) return null;
    // kWh : moyenne par passage ; kWh/km : Σ Wh / Σ m parcourus (= kWh/km)
    const routes = [...new Set(rangs.filter(i => T.segN[i]).map(i => S.route[i]))].sort(triLignes);
    return { v: parKm ? (nm ? wh / nm : null) : wh / n / 1000, n, kwh: wh / n / 1000, kwhkm: nm ? wh / nm : null, routes };
  }
  const pcs = new Set(rangs.map(i => S.parcours[i]));
  let wh = 0, km = 0, n = 0;
  for (const j of pcs) { wh += T.pcWh[j]; km += T.pcKm[j]; n += T.pcN[j]; }
  if (!n) return null;
  // kWh : moyenne par voyage ; kWh/km : Σ kWh / Σ km des voyages
  return { v: parKm ? (km ? wh / km / 1000 : null) : wh / n / 1000, n, kwh: wh / n / 1000, kwhkm: km ? wh / km / 1000 : null, pcs };
}

// Population de l'échelle « réseau entier » : tous les segments, ou tous les parcours
function valeursReseau() {
  const S = ENERGIE.donnees.segments, T = sommesPeriode();
  const parKm = ENERGIE.reglages.unite === "kwhkm";
  const vals = [];
  if (ENERGIE.reglages.agregation === "segment") {
    for (let i = 0; i < S.id.length; i++) {
      if (!T.segN[i]) continue;
      vals.push(parKm ? T.segWh[i] / (T.segN[i] * S.distance_m[i]) : T.segWh[i] / T.segN[i] / 1000);
    }
  } else {
    for (let j = 0; j < T.pcN.length; j++) {
      if (!T.pcN[j]) continue;
      vals.push(parKm ? T.pcWh[j] / T.pcKm[j] / 1000 : T.pcWh[j] / T.pcN[j] / 1000);
    }
  }
  return vals.filter(Number.isFinite);
}

function quantile(tries, q) {
  if (!tries.length) return null;
  const x = q * (tries.length - 1), i = Math.floor(x), f = x - i;
  return i + 1 < tries.length ? tries[i] + f * (tries[i + 1] - tries[i]) : tries[i];
}

function bornesEchelle(vals) {
  const t = Float64Array.from(vals).sort();
  if (!t.length) return null;
  const min = t[0], max = t[t.length - 1];
  const b = ENERGIE.reglages.robuste
    ? { borneBasse: quantile(t, ENERGIE_QUANTILE), borneHaute: quantile(t, 1 - ENERGIE_QUANTILE) }
    : { borneBasse: min, borneHaute: max };
  return { min, max, ...b, n: t.length };
}

function couleurEnergie(v) {
  const b = ENERGIE.bornes;
  if (!b) return ENERGIE_COULEURS[2];
  const e = b.borneHaute - b.borneBasse;
  const t = e > 0 ? Math.min(1, Math.max(0, (v - b.borneBasse) / e)) : 0.5;
  const x = t * (ENERGIE_COULEURS.length - 1), i = Math.min(Math.floor(x), ENERGIE_COULEURS.length - 2), f = x - i;
  const rgb = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16));
  const [c1, c2] = [rgb(ENERGIE_COULEURS[i]), rgb(ENERGIE_COULEURS[i + 1])];
  return `rgb(${c1.map((c, k) => Math.round(c + f * (c2[k] - c))).join(",")})`;
}

// Style de base d'un segment quand la coloration est active (appelé par
// baseSegmentStyle de carte.js) ; null = style gris habituel
function styleEnergie(segId) {
  if (!ENERGIE.applique) return null;
  const r = ENERGIE.valeurs.get(segId);
  if (!r || r.v == null) return { color: "#9e9e9e", weight: 2, opacity: 0.5, lineCap: "round", dashArray: "3 6" };
  return { color: couleurEnergie(r.v), weight: 4, opacity: 0.95, lineCap: "round", dashArray: null };
}

// ----- Mise à jour (réglages, visibilité des lignes, mode normal/fusion) -----
function majEnergie() {
  const R = ENERGIE.reglages;
  const pret = R.actif && ENERGIE.donnees && typeof segmentLayers !== "undefined";
  if (!pret) {
    if (ENERGIE.applique) { ENERGIE.applique = false; ENERGIE.valeurs.clear(); ENERGIE.bornes = null; restylerSegments(); }
    majLegendeEnergie();
    majStatutEnergie();
    return;
  }
  const valeurs = new Map();
  const vus = [];
  for (const [id, entry] of segmentLayers) {
    if (!entry.visible) continue;
    const r = valeurEnergie(constituantsEnergie(entry));
    valeurs.set(id, r);
    if (r && r.v != null && Number.isFinite(r.v)) vus.push(r.v);
  }
  ENERGIE.valeurs = valeurs;
  ENERGIE.bornes = bornesEchelle(R.reseau ? valeursReseau() : vus);
  ENERGIE.nAffiches = vus.length;
  ENERGIE.nSansDonnee = valeurs.size - vus.length;
  ENERGIE.applique = true;
  restylerSegments();
  majLegendeEnergie();
  majStatutEnergie();
}

function restylerSegments() {
  const sel = SyncBus.getSelection();
  for (const [id, entry] of segmentLayers) {
    if (!entry.visible || sel.has(id)) continue;
    const style = baseSegmentStyle(id);
    for (const p of entry.polylines) p.setStyle(style);
    entry.midMarker.setStyle(baseMarkerStyle(id));
  }
}

// ----- Légende (sur la carte) et statut (dans la section) -----
function majLegendeEnergie() {
  const R = ENERGIE.reglages, b = ENERGIE.bornes;
  if (!ENERGIE.applique || !b) { ENERGIE.legende?.remove(); return; }
  if (!ENERGIE.legende) {
    ENERGIE.legende = L.control({ position: "bottomleft" });
    ENERGIE.legende.onAdd = () => {
      const d = L.DomUtil.create("div", "energie-legende");
      L.DomEvent.disableClickPropagation(d);
      return d;
    };
  }
  if (!ENERGIE.legende._map) ENERGIE.legende.addTo(map);
  const d = ENERGIE.legende.getContainer();
  const dec = R.unite === "kwh" && R.agregation === "voyage" ? 0 : R.unite === "kwh" ? 2 : 1;
  const coupeBas = R.robuste && b.borneBasse > b.min, coupeHaut = R.robuste && b.borneHaute < b.max;
  const t = temperaturePeriode();
  d.innerHTML =
    `<div class="energie-legende-titre">${R.agregation === "segment" ? "Consommation moyenne par segment" : "Consommation d'un voyage (ligne-direction)"}</div>` +
    `<div class="energie-degrade" style="background:linear-gradient(90deg,${ENERGIE_COULEURS.join(",")})"></div>` +
    `<div class="energie-bornes"><span>${coupeBas ? "≤ " : ""}${fmtNombre(b.borneBasse, dec)}</span><span>${libUnite()}</span>` +
    `<span>${coupeHaut ? "≥ " : ""}${fmtNombre(b.borneHaute, dec)}</span></div>` +
    `<div class="energie-legende-sous">${libellePeriode()}${t != null ? ` · T moy. ${fmtNombre(t, 1)} °C` : ""} · échelle : ` +
    `${R.reseau ? "réseau entier" : "lignes affichées"}${R.robuste ? ", sans les 2 % extrêmes" : ""}` +
    `${coupeBas || coupeHaut ? `<br>valeurs réelles : ${fmtNombre(b.min, dec)} à ${fmtNombre(b.max, dec)}` : ""}</div>` +
    `<div class="energie-legende-sous">Modèle physique road-load (estimation synthétique)` +
    `${ENERGIE.nSansDonnee ? ` · <span class="energie-tirets"></span> ${ENERGIE.nSansDonnee} sans estimation` : ""}</div>`;
}

function majStatutEnergie() {
  const el = document.getElementById("energieStatut");
  if (!el) return;
  const R = ENERGIE.reglages;
  let txt = "";
  if (ENERGIE.erreur) txt = `⚠ ${ENERGIE.erreur}`;
  else if (R.actif && !ENERGIE.donnees) txt = "Chargement des estimations…";
  else if (ENERGIE.applique && !ENERGIE.valeurs.size) txt = "Choisissez des lignes (section « Lignes » ou bouton ci-dessous) : seuls les segments affichés sont colorés.";
  else if (ENERGIE.applique) {
    const b = ENERGIE.bornes;
    txt = `${ENERGIE.nAffiches.toLocaleString("fr-CA")} segment(s) colorés` +
      (ENERGIE.nSansDonnee ? ` · ${ENERGIE.nSansDonnee.toLocaleString("fr-CA")} sans estimation (tirets gris)` : "") +
      (b ? ` · ${fmtNombre(b.min, 2)} à ${fmtNombre(b.max, 2)} ${libUnite()}` : "");
  }
  el.textContent = txt;
  el.classList.toggle("erreur", !!ENERGIE.erreur);
}

// Résumé affiché à droite du titre de la section (appelé par majResumesSections)
function resumeEnergie() {
  const R = ENERGIE.reglages;
  if (!R.actif) return "";
  return `${R.agregation === "segment" ? "par segment" : "totale"} · ${libUnite()} · ${libellePeriode()}`;
}

// ----- Infobulle de survol -----
function survolEnergie(segId, evt) {
  if (!ENERGIE.applique) return;
  const r = ENERGIE.valeurs.get(segId);
  const entry = segmentLayers.get(segId);
  if (!entry) return;
  const R = ENERGIE.reglages, P = ENERGIE.donnees.parcours;
  let html;
  if (!r || r.v == null) {
    html = `<b>Ligne ${entry.seg.route_id ?? "?"}</b><br>Aucune estimation sur ce segment pour la période.`;
  } else if (R.agregation === "segment") {
    const k = R.unite === "kwh";
    html = `<b>Ligne${r.routes.length > 1 ? "s" : ""} ${r.routes.join(", ")}</b> · segment ${segId}<br>` +
      `<b>${k ? fmtNombre(r.kwh, 2) + " kWh" : fmtNombre(r.kwhkm, 2) + " kWh/km"}</b> par passage` +
      ` <span class="energie-bulle-sec">(${k ? fmtNombre(r.kwhkm, 2) + " kWh/km" : fmtNombre(r.kwh, 2) + " kWh"})</span><br>` +
      `<span class="energie-bulle-sec">moyenne de ${r.n} passage(s) · ${libellePeriode()}</span>`;
  } else {
    const noms = [...r.pcs].map(j => `${P.route[j]}${P.direction[j] ? " " + P.direction[j] : ""}`).join(", ");
    const k = R.unite === "kwh";
    html = `<b>Ligne ${noms}</b><br>` +
      `<b>${k ? fmtNombre(r.kwh, 1) + " kWh" : fmtNombre(r.kwhkm, 2) + " kWh/km"}</b> par voyage` +
      ` <span class="energie-bulle-sec">(${k ? fmtNombre(r.kwhkm, 2) + " kWh/km" : fmtNombre(r.kwh, 1) + " kWh"})</span><br>` +
      `<span class="energie-bulle-sec">moyenne de ${r.n} voyage(s) · ${libellePeriode()}</span>`;
  }
  ENERGIE.bulle ??= L.tooltip({ direction: "top", offset: [0, -10], className: "energie-bulle" });
  ENERGIE.bulle.setLatLng(evt.latlng).setContent(html);
  if (!map.hasLayer(ENERGIE.bulle)) ENERGIE.bulle.openOn(map);
}

function deplacerSurvolEnergie(evt) {
  if (ENERGIE.bulle && map.hasLayer(ENERGIE.bulle)) ENERGIE.bulle.setLatLng(evt.latlng);
}

function finSurvolEnergie() {
  if (ENERGIE.bulle && map.hasLayer(ENERGIE.bulle)) map.closeTooltip(ENERGIE.bulle);
}

// ----- Interface de la section -----
function majControlesEnergie() {
  const R = ENERGIE.reglages;
  document.getElementById("chkEnergie").checked = R.actif;
  document.getElementById("energiePanneau").hidden = !R.actif;
  for (const b of document.querySelectorAll("[data-energie-agregation]")) {
    const on = b.dataset.energieAgregation === R.agregation;
    b.classList.toggle("primary", on);
    b.setAttribute("aria-pressed", String(on));
  }
  for (const b of document.querySelectorAll("[data-energie-unite]")) {
    const on = b.dataset.energieUnite === R.unite;
    b.classList.toggle("primary", on);
    b.setAttribute("aria-pressed", String(on));
  }
  for (const b of document.querySelectorAll("[data-energie-periode]")) {
    const [de, a] = b.dataset.energiePeriode.split("-").map(Number);
    b.classList.toggle("actif", de === R.de && a === R.a);
  }
  document.getElementById("energieDe").value = String(R.de);
  document.getElementById("energieA").value = String(R.a);
  document.getElementById("chkEnergieRobuste").checked = R.robuste;
  document.getElementById("chkEnergieReseau").checked = R.reseau;
}

async function appliquerReglagesEnergie() {
  sauverReglagesEnergie();
  majControlesEnergie();
  if (ENERGIE.reglages.actif && !ENERGIE.donnees) {
    majStatutEnergie();
    try { await chargerEnergie(); } catch (e) { /* message dans le statut */ }
  }
  majEnergie();
  if (typeof majResumesSections === "function") majResumesSections();
}

function afficherToutesLignes() {
  modifierLignes({ remplacer: SERVER_META.lignes.slice() });   // carte.js
}

function initEnergie() {
  const selDe = document.getElementById("energieDe"), selA = document.getElementById("energieA");
  for (let m = 1; m <= 12; m++) {
    selDe.add(new Option(MOIS_COURTS[m], m));
    selA.add(new Option(MOIS_COURTS[m], m));
  }
  document.getElementById("energiePrereglages").innerHTML = ENERGIE_PREREGLAGES.map(([lib, de, a]) =>
    `<button type="button" class="energie-puce" data-energie-periode="${de}-${a}" title="${MOIS_COURTS[de]} → ${MOIS_COURTS[a]}">${lib}</button>`).join("");
  lireReglagesEnergie();
  majControlesEnergie();
  const R = ENERGIE.reglages;
  document.getElementById("chkEnergie").addEventListener("change", (e) => { R.actif = e.target.checked; appliquerReglagesEnergie(); });
  document.getElementById("secEnergie").addEventListener("click", (e) => {
    const b = e.target.closest("[data-energie-agregation], [data-energie-unite], [data-energie-periode]");
    if (!b) return;
    if (b.dataset.energieAgregation) R.agregation = b.dataset.energieAgregation;
    else if (b.dataset.energieUnite) R.unite = b.dataset.energieUnite;
    else [R.de, R.a] = b.dataset.energiePeriode.split("-").map(Number);
    appliquerReglagesEnergie();
  });
  selDe.addEventListener("change", () => { R.de = Number(selDe.value); appliquerReglagesEnergie(); });
  selA.addEventListener("change", () => { R.a = Number(selA.value); appliquerReglagesEnergie(); });
  document.getElementById("chkEnergieRobuste").addEventListener("change", (e) => { R.robuste = e.target.checked; appliquerReglagesEnergie(); });
  document.getElementById("chkEnergieReseau").addEventListener("change", (e) => { R.reseau = e.target.checked; appliquerReglagesEnergie(); });
  document.getElementById("btnEnergieToutes").addEventListener("click", afficherToutesLignes);
}

// Appelé par updateExtrasAvailability (après /api/meta)
function disponibiliteEnergie(dispo) {
  document.getElementById("secEnergie").style.display = dispo ? "" : "none";
  if (!dispo) { ENERGIE.reglages.actif = false; majEnergie(); return; }
  if (ENERGIE.reglages.actif) appliquerReglagesEnergie();
}

initEnergie();
