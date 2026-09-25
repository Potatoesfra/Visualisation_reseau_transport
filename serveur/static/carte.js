/* =====================================================
   carte.js — Carte Leaflet interactive
   Principe : on instancie chaque segment UNE SEULE FOIS
   en tant que polyline, et on change ses styles à la volée.
   AUCUN refresh complet à chaque clic → pas de recentrage.

   Logique de visibilité :
   - Par défaut, AUCUN segment n'est visible.
   - Sélectionner une ou plusieurs lignes dans le panneau
     affiche uniquement leurs segments.
   - La synchronisation avec le graphe peut aussi forcer
     un ensemble de segments à devenir visibles (mode
     "afficher seulement la sélection courante").
   ===================================================== */

let map = null;
// segment_id -> { polylines: [L.Polyline], midMarker: L.CircleMarker, seg, visible: bool }
let segmentLayers = new Map();
let stopLayer    = null;
let relArcLayer  = null;

// Sélecteurs Choices.js (Lignes / Parcours types)
let lineChoices = null;
let parcoursChoices = null;
// Empêche les mises à jour programmatiques des sélecteurs de repartir dans SyncBus
let suppressSelectorEvents = false;

// parcours (shape_id) -> route_id, pour appliquer le filtre parcours par ligne
const PARCOURS_TO_LINE = new Map();
for (const [ligne, arr] of Object.entries(SERVER_META.lignes_parcours || {})) {
  for (const p of (arr || [])) PARCOURS_TO_LINE.set(p.id, ligne);
}

// Couleur unique des lignes créées : toute la ligne d'une seule couleur, les
// arrêts (points de découpage) étant marqués par des points. Un tronçon rerouté
// ne change donc jamais de couleur.
const PERSO_LINE_COLOR = "#ff7043";

// Quand true, seuls les segments dont l'id est dans SyncBus.getSelection()
// (propagé par le graphe) sont affichés. Togglé par le bouton du graphe.
let focusModeActive = false;
let focusIds = new Set();   // set d'ids imposés par le graphe ("afficher seulement ces 2 nodes")

// ===== Fond de carte =====
// OpenFreeMap (style Positron, tuiles vectorielles OSM) : libre, sans clé ni quota.
// Rendu par MapLibre dans le tilePane, non interactif : ne capte ni survol ni clic.
const FOND_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const FOND_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> ' +
  '© <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> ' +
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

function ajouterFondDeCarte(m) {
  // Le style n'embarque pas d'attribution : on la fournit au plugin.
  L.maplibreGL({
    style: FOND_STYLE_URL,
    attributionControl: { customAttribution: FOND_ATTRIBUTION },
  }).addTo(m);
}

// ===== Initialisation Leaflet =====
function initMap() {
  map = L.map("map", {
    center: SERVER_META.center,
    zoom: 12,
    maxZoom: 19,
    zoomControl: true,
    preferCanvas: true,
  });

  ajouterFondDeCarte(map);

  relArcLayer = L.layerGroup().addTo(map);
  stopLayer   = L.layerGroup().addTo(map);
  // Menu du clic droit sur un segment : fermé au clic ailleurs, au déplacement, par Échap
  map.on("click movestart zoomstart", fermerMenuSegment);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") fermerMenuSegment(); });
  document.addEventListener("mousedown", (e) => {
    const menu = document.getElementById("segMenu");
    if (menu && !menu.contains(e.target)) fermerMenuSegment();
  });
}

// ===== Création des UI du panneau =====
function buildSidebar() {
  buildLineParcoursSelectors();

  // Checkboxes types de relations
  const wrap = document.getElementById("relTypeCheckboxes");
  for (const t of SERVER_META.types_relations) {
    const label = document.createElement("label");
    label.className = "chk-row";
    label.innerHTML = `
      <input type="checkbox" data-rel="${t}" checked>
      <span class="legend-line" style="background:${SERVER_META.couleurs[t] || '#888'};"></span>
      <span>${t}</span>`;
    wrap.appendChild(label);
  }
  wrap.addEventListener("change", () => {
    const active = Array.from(wrap.querySelectorAll('input[type="checkbox"]:checked'))
                        .map(cb => cb.dataset.rel);
    SyncBus.setRelTypes(active);
    refreshRelationArcs();
    refreshSegInfoPanel();
  });
  SyncBus.setRelTypes(SERVER_META.types_relations);

  document.getElementById("chkShowStops").addEventListener("change", e => {
    SyncBus.setShowStops(e.target.checked);
    if (e.target.checked) renderStops(); else stopLayer.clearLayers();
  });
  document.getElementById("chkShowRelArcs").addEventListener("change", refreshRelationArcs);

  document.getElementById("btnClear").addEventListener("click", () => {
    persoSegInfoActive = null;
    SyncBus.clear();
    closeSegInfo();
    refreshSidebarSegInfo();
    // Même bouton pour les bus temps réel sélectionnés (focus / Ctrl+clic)
    if (RT.selection.size) {
      RT.selection.clear();
      if (RT.dernier) afficherBus(RT.dernier);
    }
  });
  document.getElementById("btnFitSelection").addEventListener("click", fitToSelection);
  document.getElementById("btnOpenGraph").addEventListener("click", (e) => {
    e.preventDefault();
    const url = new URL("/graphe", window.location.origin).href;
    window.open(url, "relations-graphe");
  });
  document.getElementById("btnOpenConso")?.addEventListener("click", (e) => {
    e.preventDefault();
    const url = new URL("/consommation", window.location.origin).href;
    window.open(url, "relations-consommation");
  });

  // Bouton de bascule Normal / Fusion
  document.getElementById("btnModeNormal")?.addEventListener("click", () => SyncBus.setMode("normal"));
  document.getElementById("btnModeFusion")?.addEventListener("click", () => {
    if (DataLoader.meta && DataLoader.meta.fusion_disponible) SyncBus.setMode("fusion");
  });

  initSectionsRepliables();
}

// ===== Sections repliables du panneau =====
// Clic (ou Entrée / Espace) sur le titre d'une section = replier / déplier.
// État mémorisé par navigateur ; un résumé à droite du titre garde l'essentiel
// visible quand la section est repliée (lignes choisies, couches actives…).
const CLE_SECTIONS_REPLIEES = "carte.sectionsRepliees";

function sectionsDuPanneau() {
  return Array.from(document.querySelectorAll("#panel > .section"))
              .filter(s => s.querySelector(":scope > .sec-label"));
}

function cleSection(sec) {
  return sec.id || sec.querySelector(":scope > .sec-label").dataset.titre;
}

function sauverSectionsRepliees() {
  const repliees = sectionsDuPanneau().filter(s => s.classList.contains("replie")).map(cleSection);
  try { localStorage.setItem(CLE_SECTIONS_REPLIEES, JSON.stringify(repliees)); } catch (e) { /* stockage indisponible */ }
}

function replierSection(sec, replie) {
  sec.classList.toggle("replie", replie);
  sec.querySelector(":scope > .sec-label").setAttribute("aria-expanded", String(!replie));
}

function majBoutonReplierTout() {
  const btn = document.getElementById("btnReplierTout");
  if (!btn) return;
  const visibles = sectionsDuPanneau().filter(sectionAffichee);
  const toutReplie = visibles.length > 0 && visibles.every(s => s.classList.contains("replie"));
  btn.textContent = toutReplie ? "Tout déplier" : "Tout replier";
  btn.title = toutReplie ? "Déplier toutes les sections" : "Replier toutes les sections";
}

function initSectionsRepliables() {
  let repliees = [];
  try { repliees = JSON.parse(localStorage.getItem(CLE_SECTIONS_REPLIEES) || "[]"); } catch (e) { repliees = []; }
  const setRepliees = new Set(Array.isArray(repliees) ? repliees : []);

  for (const sec of sectionsDuPanneau()) {
    const titre = sec.querySelector(":scope > .sec-label");
    titre.dataset.titre = titre.textContent.trim();
    titre.classList.add("repliable");
    titre.setAttribute("role", "button");
    titre.tabIndex = 0;
    const resume = document.createElement("span");
    resume.className = "sec-resume";
    titre.appendChild(resume);
    replierSection(sec, setRepliees.has(cleSection(sec)));
    const basculer = () => {
      replierSection(sec, !sec.classList.contains("replie"));
      sauverSectionsRepliees();
      majBoutonReplierTout();
    };
    titre.addEventListener("click", basculer);
    titre.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); basculer(); }
    });
  }

  document.getElementById("btnReplierTout")?.addEventListener("click", () => {
    const visibles = sectionsDuPanneau().filter(sectionAffichee);
    const replier = !visibles.every(s => s.classList.contains("replie"));
    for (const sec of visibles) replierSection(sec, replier);
    sauverSectionsRepliees();
    majBoutonReplierTout();
  });

  // Toute modification dans le panneau peut changer un résumé
  document.getElementById("panel").addEventListener("change", majResumesSections);
  initReglagesSections();
  majBoutonReplierTout();
  majResumesSections();
}

// Section affichée : ni masquée par l'utilisateur (⚙), ni sans objet (données absentes)
const sectionAffichee = s => s.style.display !== "none" && !s.classList.contains("masque-utilisateur");

// ===== Réglages des sections (⚙) : ordre et visibilité, mémorisés par navigateur =====
const CLE_SECTIONS_ORDRE = "carte.sectionsOrdre";
const CLE_SECTIONS_MASQUEES = "carte.sectionsMasquees";
let ORDRE_SECTIONS_DEFAUT = [];

function lireStockage(cle) {
  try { const v = JSON.parse(localStorage.getItem(cle) || "null"); return Array.isArray(v) ? v : null; }
  catch (e) { return null; }
}
function ecrireStockage(cle, valeur) {
  try { if (valeur == null) localStorage.removeItem(cle); else localStorage.setItem(cle, JSON.stringify(valeur)); }
  catch (e) { /* stockage indisponible */ }
}

// Réordonne les sections dans le panneau (les sections inconnues de l'ordre gardent leur rang relatif, à la fin)
function appliquerOrdreSections(ordre) {
  const panel = document.getElementById("panel");
  const parCle = new Map(sectionsDuPanneau().map(s => [cleSection(s), s]));
  const cles = ordre.filter(c => parCle.has(c)).concat([...parCle.keys()].filter(c => !ordre.includes(c)));
  for (const c of cles) panel.appendChild(parCle.get(c));
}

function appliquerMasquesSections(masquees) {
  const set = new Set(masquees);
  for (const s of sectionsDuPanneau()) s.classList.toggle("masque-utilisateur", set.has(cleSection(s)));
}

function sauverReglagesSections() {
  const ordre = sectionsDuPanneau().map(cleSection);
  const masquees = sectionsDuPanneau().filter(s => s.classList.contains("masque-utilisateur")).map(cleSection);
  const defaut = ordre.join("|") === ORDRE_SECTIONS_DEFAUT.join("|");
  ecrireStockage(CLE_SECTIONS_ORDRE, defaut ? null : ordre);
  ecrireStockage(CLE_SECTIONS_MASQUEES, masquees.length ? masquees : null);
}

function rendreReglagesSections() {
  const ul = document.getElementById("secReglagesListe");
  ul.replaceChildren();
  const sections = sectionsDuPanneau();
  sections.forEach((sec, i) => {
    const cle = cleSection(sec);
    const titre = sec.querySelector(":scope > .sec-label").dataset.titre;
    const sansObjet = sec.style.display === "none";
    const li = document.createElement("li");
    li.className = "sec-reglage";
    li.draggable = true;
    li.dataset.cle = cle;
    li.innerHTML =
      `<span class="poignee" title="Glisser pour déplacer" aria-hidden="true">⋮⋮</span>` +
      `<label><input type="checkbox" ${sec.classList.contains("masque-utilisateur") ? "" : "checked"}> ` +
      `<span></span>${sansObjet ? ' <em title="Données absentes sur ce déploiement">(indisponible)</em>' : ""}</label>` +
      `<button type="button" class="haut" title="Monter" ${i === 0 ? "disabled" : ""}>↑</button>` +
      `<button type="button" class="bas" title="Descendre" ${i === sections.length - 1 ? "disabled" : ""}>↓</button>`;
    li.querySelector("label span").textContent = titre;
    li.querySelector("input").addEventListener("change", (e) => {
      sec.classList.toggle("masque-utilisateur", !e.target.checked);
      sauverReglagesSections();
      majBoutonReplierTout();
    });
    const deplacer = (delta) => {
      const ordre = sectionsDuPanneau().map(cleSection);
      const j = i + delta;
      [ordre[i], ordre[j]] = [ordre[j], ordre[i]];
      appliquerOrdreSections(ordre);
      sauverReglagesSections();
      rendreReglagesSections();
      ul.querySelector(`li[data-cle="${CSS.escape(cle)}"] .${delta < 0 ? "haut" : "bas"}`)?.focus();
    };
    li.querySelector(".haut").addEventListener("click", () => deplacer(-1));
    li.querySelector(".bas").addEventListener("click", () => deplacer(1));
    // Glisser-déposer : la ligne survolée indique l'emplacement (avant / après selon la moitié)
    li.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", cle);
      e.dataTransfer.effectAllowed = "move";
      li.classList.add("glisse");
    });
    li.addEventListener("dragend", () => li.classList.remove("glisse"));
    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const apres = e.clientY > r.top + r.height / 2;
      li.classList.toggle("cible-avant", !apres);
      li.classList.toggle("cible-apres", apres);
    });
    li.addEventListener("dragleave", () => li.classList.remove("cible-avant", "cible-apres"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      const source = e.dataTransfer.getData("text/plain");
      const apres = li.classList.contains("cible-apres");
      li.classList.remove("cible-avant", "cible-apres");
      if (!source || source === cle) return;
      const ordre = sectionsDuPanneau().map(cleSection).filter(c => c !== source);
      ordre.splice(ordre.indexOf(cle) + (apres ? 1 : 0), 0, source);
      appliquerOrdreSections(ordre);
      sauverReglagesSections();
      rendreReglagesSections();
    });
    ul.appendChild(li);
  });
}

function basculerReglagesSections(ouvrir) {
  const pop = document.getElementById("secReglages");
  const btn = document.getElementById("btnReglagesSections");
  const ouvert = ouvrir ?? pop.hidden;
  if (ouvert) rendreReglagesSections();
  pop.hidden = !ouvert;
  btn.setAttribute("aria-expanded", String(ouvert));
  btn.classList.toggle("actif", ouvert);
}

function initReglagesSections() {
  ORDRE_SECTIONS_DEFAUT = sectionsDuPanneau().map(cleSection);
  const ordre = lireStockage(CLE_SECTIONS_ORDRE);
  if (ordre) appliquerOrdreSections(ordre);
  appliquerMasquesSections(lireStockage(CLE_SECTIONS_MASQUEES) || []);
  document.getElementById("btnReglagesSections").addEventListener("click", () => basculerReglagesSections());
  document.getElementById("btnReglagesFermer").addEventListener("click", () => basculerReglagesSections(false));
  document.getElementById("btnSectionsDefaut").addEventListener("click", () => {
    appliquerOrdreSections(ORDRE_SECTIONS_DEFAUT);
    appliquerMasquesSections([]);
    sauverReglagesSections();
    rendreReglagesSections();
    majBoutonReplierTout();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("secReglages").hidden) basculerReglagesSections(false);
  });
}

function resumeSection(sec, texte) {
  const el = sec?.querySelector(":scope > .sec-label > .sec-resume");
  if (el && el.textContent !== texte) { el.textContent = texte; el.title = texte; }
}

function majResumesSections() {
  const sections = new Map(sectionsDuPanneau().map(s => [s.querySelector(":scope > .sec-label").dataset.titre, s]));
  const liste = (valeurs, max) =>
    valeurs.length <= max ? valeurs.join(", ") : `${valeurs.slice(0, max).join(", ")} +${valeurs.length - max}`;

  resumeSection(document.getElementById("secModeSegments"),
                DataLoader.mode === "fusion" ? "Fusion" : "Normal");

  const lignes = Array.from(document.getElementById("lineSelect").selectedOptions)
                      .map(o => o.value.startsWith("perso:") ? o.textContent.trim() : o.value);
  const nParcours = document.getElementById("parcoursSelect").selectedOptions.length;
  resumeSection(sections.get("Lignes"), (lignes.length ? liste(lignes, 4) : "toutes") +
                (nParcours ? ` · ${nParcours} parcours` : ""));
  document.getElementById("btnLignesAucune").disabled = !lignes.length;

  const rel = document.querySelectorAll('#relTypeCheckboxes input[type="checkbox"]');
  const relCoches = Array.from(rel).filter(cb => cb.checked).length;
  resumeSection(document.getElementById("secRelations"), rel.length ? `${relCoches}/${rel.length}` : "");

  const couches = [["chkRelief", "relief"], ["chkReseauRoutier", "réseau routier"]]
    .filter(([id]) => document.getElementById(id)?.checked).map(([, nom]) => nom);
  resumeSection(sections.get("Fonds et couches"), couches.join(", "));
  resumeSection(document.getElementById("secEnergie"), typeof resumeEnergie === "function" ? resumeEnergie() : "");

  let rt = "";
  if (document.getElementById("chkBusTempsReel").checked) {
    rt = "actif";
    if (RT.selection.size) rt += ` · ${RT.selection.size} bus sél.`;
    if (RT.filtreEtat) rt += " · filtré";
  }
  resumeSection(document.getElementById("secTempsReel"), rt);

  const enCours = HISTO.liste.filter(ep => episodeEnCours(ep)).length;
  resumeSection(document.getElementById("secHistorique"),
                HISTO.liste.length ? `${enCours} en cours · ${HISTO.liste.length}` : "");
}

// ===== Bascule de mode (Normal / Fusion) =====
function updateModeButtonsUI() {
  const bN = document.getElementById("btnModeNormal");
  const bF = document.getElementById("btnModeFusion");
  if (!bN || !bF) return;
  const fusionOk = !!(DataLoader.meta && DataLoader.meta.fusion_disponible);
  // Sans mode fusion (déploiement allégé ou fichiers absents), le sélecteur
  // Normal/Fusion n'a plus d'objet : on masque toute la section.
  const sec = document.getElementById("secModeSegments");
  if (sec) sec.style.display = fusionOk ? "" : "none";
  bF.disabled = !fusionOk;
  bF.title = fusionOk ? "" : "Fichiers de fusion absents — lancez Fusion_segments.py puis Relations_segments.py en mode fusion.";
  bN.classList.toggle("primary", DataLoader.mode === "normal");
  bF.classList.toggle("primary", DataLoader.mode === "fusion");
  majResumesSections();
  majBoutonReplierTout();
}

function teardownSegments() {
  for (const [, entry] of segmentLayers) {
    entry.polylines.forEach(p => { if (map.hasLayer(p)) map.removeLayer(p); });
    if (map.hasLayer(entry.midMarker)) map.removeLayer(entry.midMarker);
  }
  segmentLayers.clear();
  relArcLayer.clearLayers();
  stopLayer.clearLayers();
  SyncBus._lastApplied = new Set();
}

async function reloadForMode(mode) {
  if (focusModeActive) exitFocusMode();
  SyncBus.clear();
  await DataLoader.loadAll(mode);
  indexFusionInverse = null;   // la correspondance seg_id -> nœud dépend du mode
  teardownSegments();
  renderSegments();   // reconstruit les layers + applyVisibility()
  renderLignesPerso();
  updateModeButtonsUI();

  // Retracer le voyage courant avec les géométries du nouveau mode
  const voyage = VoyageTrace.voyage;
  if (voyage != null) {
    VoyageTrace.voyage = null;
    tracerVoyageSurCarte(voyage, /*fit=*/false);
  }
}

// ===== Sélecteurs Lignes + Parcours types (Choices.js, chips avec croix ×) =====
function buildLineParcoursSelectors() {
  const lineSelect     = document.getElementById("lineSelect");
  const parcoursSelect = document.getElementById("parcoursSelect");

  const lineOptions = SERVER_META.lignes.map(l => ({ value: l, label: "Ligne " + l }));

  lineChoices = new Choices(lineSelect, {
    choices: lineOptions,
    removeItemButton: true,
    searchPlaceholderValue: "Rechercher une ligne…",
    placeholderValue: "Choisir des lignes…",
    itemSelectText: "",
    shouldSort: false,
  });

  parcoursChoices = new Choices(parcoursSelect, {
    removeItemButton: true,
    searchPlaceholderValue: "Rechercher un parcours…",
    placeholderValue: "Tous les parcours des lignes choisies",
    itemSelectText: "",
    shouldSort: false,
  });

  lineSelect.addEventListener("change", onLignesChange);
  parcoursSelect.addEventListener("change", onParcoursChange);
  document.getElementById("btnLignesAucune").addEventListener("click", () => modifierLignes({ remplacer: [] }));
}

// Lignes sélectionnées (hors lignes personnalisées) actuellement dans le sélecteur.
function lignesGtfsSelectionnees() {
  const lineSelect = document.getElementById("lineSelect");
  return Array.from(lineSelect.selectedOptions)
              .map(o => o.value).filter(v => !v.startsWith("perso:"));
}

function onLignesChange() {
  if (suppressSelectorEvents) return;
  if (focusModeActive) exitFocusMode();
  const gtfsLines = lignesGtfsSelectionnees();
  SyncBus.setVisibleLines(gtfsLines);   // → onFilterChange → applyVisibility
  rebuildParcoursChoices(gtfsLines);    // peuple les parcours des lignes choisies
  renderLignesPerso();                  // lignes personnalisées (état local)
  renderLignesPersoManager();
}

function onParcoursChange() {
  if (suppressSelectorEvents) return;
  const parcoursSelect = document.getElementById("parcoursSelect");
  const selected = Array.from(parcoursSelect.selectedOptions).map(o => o.value);
  SyncBus.setVisibleParcours(selected); // → onFilterChange → applyVisibility
}

// (Re)construit le sélecteur de parcours, groupé par ligne, en conservant la
// sélection de parcours encore valide. Élague visibleParcours si besoin.
function rebuildParcoursChoices(gtfsLines) {
  if (!parcoursChoices) return;
  const parcoursSelect = document.getElementById("parcoursSelect");
  const current = new Set(Array.from(parcoursSelect.selectedOptions).map(o => o.value));
  const lp = SERVER_META.lignes_parcours || {};
  const groups = [];
  const valides = new Set();
  for (const line of gtfsLines) {
    const arr = lp[line] || [];
    if (!arr.length) continue;
    groups.push({
      label: "Ligne " + line,
      choices: arr.map(p => {
        valides.add(p.id);
        const etoile = Number(p.typicality) > 0 ? "★ " : "";
        return { value: p.id, label: `${etoile}${p.label}  ·  ${p.id}`, selected: current.has(p.id) };
      }),
    });
  }
  withSelectorGuard(() => {
    parcoursChoices.clearStore();
    parcoursChoices.setChoices(groups, "value", "label", true);
  });
  const nouvelleSel = Array.from(parcoursSelect.selectedOptions)
                           .map(o => o.value).filter(v => valides.has(v));
  SyncBus.setVisibleParcours(nouvelleSel);
}

// Modifie la sélection de lignes par programme (bouton « Tout désélectionner »,
// menu du clic droit, « Afficher toutes les lignes »…), puis même traitement
// qu'un choix manuel. `remplacer` : nouvelle sélection complète.
function modifierLignes({ ajouter = [], retirer = [], remplacer = null } = {}) {
  withSelectorGuard(() => {
    if (remplacer) { lineChoices.removeActiveItems(); ajouter = remplacer; }
    for (const l of retirer) lineChoices.removeActiveItemsByValue(String(l));
    if (ajouter.length) lineChoices.setChoiceByValue(ajouter.map(String));
  });
  setTimeout(onLignesChange, 0);   // après la levée de la garde (même file d'attente)
}

// Exécute une modification programmatique des sélecteurs sans redéclencher SyncBus.
function withSelectorGuard(fn) {
  suppressSelectorEvents = true;
  try { fn(); }
  finally { setTimeout(() => { suppressSelectorEvents = false; }, 0); }
}

// ===== Rendu des segments (une seule fois, au chargement) =====
// Les segments sont créés mais PAS ajoutés à la carte immédiatement.
// C'est applyVisibility() qui décide quels segments ajouter/retirer.
function renderSegments() {
  for (const seg of DataLoader.segments) {
    const polylines = [];
    try {
      if (seg.is_multi) {
        for (const part of seg.coords) {
          polylines.push(L.polyline(part, baseSegmentStyle(seg.id)));
        }
      } else {
        polylines.push(L.polyline(seg.coords, baseSegmentStyle(seg.id)));
      }

      const midMarker = L.circleMarker(seg.midpoint, baseMarkerStyle(seg.id));

      segmentLayers.set(seg.id, { polylines, midMarker, seg, visible: false });

      // Attacher les events (les layers ne sont pas encore sur la carte)
      [...polylines, midMarker].forEach(layer => attachSegmentEvents(layer, seg.id));
    } catch (err) {
      console.error(`Segment ${seg.id} : erreur de rendu —`, err);
    }
  }
  document.getElementById("statTotalSeg").textContent = DataLoader.segments.length;

  // Premier rendu : on applique le filtre (rien par défaut si aucune ligne sélectionnée)
  applyVisibility();
}

// Style « au repos » d'un segment : gris, ou couleur de la prévision énergétique
// quand elle est active (energie_carte.js)
function baseSegmentStyle(segId) {
  const energie = segId != null && typeof styleEnergie === "function" ? styleEnergie(segId) : null;
  return energie || { color: "#90a4ae", weight: 3, opacity: 0.75, lineCap: "round", dashArray: null };
}
// Point milieu (cible de clic) : même couleur que le segment quand la
// prévision énergétique est active, sinon il masquerait la coloration
function baseMarkerStyle(segId) {
  const energie = segId != null && typeof styleEnergie === "function" ? styleEnergie(segId) : null;
  if (energie && !energie.dashArray) return { radius: 4, fillColor: energie.color, color: "#263238", weight: 1, fillOpacity: 0.95 };
  return { radius: 4, fillColor: "#90a4ae", color: "#37474f", weight: 1, fillOpacity: 0.65 };
}
function selectedSegmentStyle() {
  return { color: "#ffd54f", weight: 6, opacity: 1.0, lineCap: "round" };
}

function attachSegmentEvents(layer, segId) {
  layer.on("click", evt => {
    L.DomEvent.stopPropagation(evt);
    if (typeof clicTraceDetour === "function" && clicTraceDetour(evt)) return;   // detours_carte.js
    const additive = evt.originalEvent.ctrlKey || evt.originalEvent.metaKey || evt.originalEvent.shiftKey;
    SyncBus.select(segId, additive);
  });
  layer.on("mouseover", (evt) => {
    if (typeof survolEnergie === "function") survolEnergie(segId, evt);
    if (!document.getElementById("chkHighlightOnHover").checked) return;
    if (!SyncBus.getSelection().has(segId)) {
      segmentLayers.get(segId)?.polylines.forEach(p => p.setStyle({ color: "#4f9fff", weight: 4, opacity: 1.0 }));
    }
  });
  layer.on("contextmenu", evt => ouvrirMenuSegment(segId, evt));
  layer.on("mousemove", (evt) => { if (typeof deplacerSurvolEnergie === "function") deplacerSurvolEnergie(evt); });
  layer.on("mouseout", () => {
    if (typeof finSurvolEnergie === "function") finSurvolEnergie();
    if (!SyncBus.getSelection().has(segId)) {
      segmentLayers.get(segId)?.polylines.forEach(p => p.setStyle(baseSegmentStyle(segId)));
    }
  });
}

// ===== Clic droit sur un segment : lignes liées par une relation =====
// Liste les lignes des segments reliés à celui-ci (types de relations cochés),
// avec une case par ligne pour l'afficher ou la masquer, et deux actions groupées.
function lignesLiees(segId) {
  const seg = DataLoader.segmentById.get(segId);
  const propres = new Set((seg.routes || [seg.route_id]).filter(Boolean).map(String));
  const parLigne = new Map();   // ligne -> Map(type -> nb de relations)
  for (const r of DataLoader.getRelationsFor(segId, SyncBus.getState().activeRelTypes)) {
    const autre = DataLoader.segmentById.get(r.a === segId ? r.b : r.a);
    if (!autre) continue;
    for (const l of (autre.routes || [autre.route_id]).filter(Boolean).map(String)) {
      if (!parLigne.has(l)) parLigne.set(l, new Map());
      parLigne.get(l).set(r.type, (parLigne.get(l).get(r.type) || 0) + 1);
    }
  }
  const connues = new Set(SERVER_META.lignes || []);
  const liees = [...parLigne.keys()].filter(l => connues.has(l)).sort(triLignes);
  return { propres, parLigne, liees, connues };
}

function ouvrirMenuSegment(segId, evt) {
  L.DomEvent.stopPropagation(evt);
  L.DomEvent.preventDefault(evt.originalEvent);
  fermerMenuSegment();
  const { propres, parLigne, liees, connues } = lignesLiees(segId);
  const affichees = new Set(lignesGtfsSelectionnees());
  const menu = document.createElement("div");
  menu.id = "segMenu";
  menu.className = "seg-menu";
  menu.setAttribute("role", "menu");
  const lignesSeg = [...propres].sort(triLignes).join(", ");
  let html = `<div class="seg-menu-titre">${DataLoader.mode === "fusion" ? "Nœud" : "Segment"} ${segId}` +
             `<span>ligne${propres.size > 1 ? "s" : ""} ${lignesSeg || "?"}</span></div>`;
  if (!liees.length) {
    html += `<div class="instructions">Aucune ligne liée par les types de relations cochés.</div>`;
  } else {
    html += `<div class="seg-menu-sous">${liees.length} ligne(s) liée(s) par une relation · cocher = afficher</div><div class="seg-menu-liste">`;
    for (const l of liees) {
      const types = [...parLigne.get(l)].sort((a, b) => b[1] - a[1]).map(([t, n]) =>
        `<span class="seg-menu-type" style="border-color:${SERVER_META.couleurs[t] || "#888"}" title="${n} relation(s) ${t}">${t}${n > 1 ? " ×" + n : ""}</span>`).join("");
      html += `<label class="seg-menu-ligne"><input type="checkbox" value="${l}"${affichees.has(l) ? " checked" : ""}>` +
              `<b>${l}</b>${propres.has(l) ? "<em>(ce segment)</em>" : ""}<span class="seg-menu-types">${types}</span></label>`;
    }
    html += `</div><div class="btn-row">` +
            `<button type="button" class="action-btn primary" data-action="ajouter">Afficher toutes (${liees.length})</button>` +
            `<button type="button" class="action-btn" data-action="seules" title="Remplace la sélection : ligne(s) du segment + lignes liées">Seulement celles-ci</button></div>`;
  }
  menu.innerHTML = html;
  menu.addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (cb) modifierLignes(cb.checked ? { ajouter: [cb.value] } : { retirer: [cb.value] });
  });
  menu.addEventListener("click", (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "ajouter") modifierLignes({ ajouter: liees });
    else if (action === "seules") modifierLignes({ remplacer: [...new Set([...propres].filter(l => connues.has(l)).concat(liees))] });
    else return;
    fermerMenuSegment();
  });
  placerMenuCarte(menu, evt.originalEvent);
}

// Menu contextuel (segment, détour) : au point cliqué, sans sortir de la zone carte
function placerMenuCarte(menu, p) {
  L.DomEvent.disableClickPropagation(menu);
  L.DomEvent.disableScrollPropagation(menu);
  const vue = document.getElementById("main-view");
  vue.appendChild(menu);
  const r = vue.getBoundingClientRect();
  const x = Math.min(p.clientX - r.left, r.width - menu.offsetWidth - 8);
  const y = Math.min(p.clientY - r.top, r.height - menu.offsetHeight - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
}

function fermerMenuSegment() {
  document.getElementById("segMenu")?.remove();
}

// ===== Visibilité d'un segment individuel sur la carte =====
// Le renderer canvas de Leaflet mémorise le dernier layer survolé dans
// `_hoveredLayer` et ne le purge PAS quand ce layer est retiré de la carte.
// Si on masque un tronçon en cours de survol (changement de ligne/parcours),
// sa référence reste : au ré-affichage, comme le layer candidat est identique
// à `_hoveredLayer`, Leaflet ne redéclenche plus l'événement `mouseover` et le
// survol paraît « cassé ». On purge donc cette référence au retrait.
function purgeHoveredLayer(layer) {
  const r = layer && layer._renderer;
  if (r && r._hoveredLayer === layer) r._hoveredLayer = null;
}

function setSegmentOnMap(entry, show) {
  if (show === entry.visible) return;
  entry.visible = show;
  try {
    if (show) {
      const selected = SyncBus.getSelection().has(entry.seg.id);
      entry.polylines.forEach(p => {
        p.addTo(map);
        if (!selected) p.setStyle(baseSegmentStyle(entry.seg.id));  // jamais coincé sur un survol
      });
      if (!selected) entry.midMarker.setStyle(baseMarkerStyle(entry.seg.id));
      entry.midMarker.addTo(map);
    } else {
      entry.polylines.forEach(p => {
        purgeHoveredLayer(p);
        if (map.hasLayer(p)) map.removeLayer(p);
      });
      purgeHoveredLayer(entry.midMarker);
      if (map.hasLayer(entry.midMarker)) map.removeLayer(entry.midMarker);
    }
  } catch(e) {
    console.error("Erreur setSegmentOnMap:", e);
  }
}

// ===== Logique centrale de visibilité =====
// Appelée à chaque changement de filtre (lignes, focus-mode, synchro graphe).
function applyVisibility() {
  if (!DataLoader.segments || segmentLayers.size === 0) return;
  const state = SyncBus.getState();
  const visibleLines    = state.visibleLines;
  const visibleParcours = state.visibleParcours || new Set();
  const selectedIds     = state.selectedIds;
  const filterActive    = visibleLines.size > 0;
  let nVisible = 0;

  // Lignes portant un filtre parcours actif (au moins un parcours coché).
  const lignesFiltrees = new Set();
  for (const pid of visibleParcours) {
    const ln = PARCOURS_TO_LINE.get(pid);
    if (ln) lignesFiltrees.add(ln);
  }

  try {
    for (const [segId, entry] of segmentLayers) {
      let show;
      if (focusModeActive) {
        show = focusIds.has(segId);
      } else if (selectedIds.has(segId)) {
        show = true;
      } else if (filterActive) {
        const routes = entry.seg.routes || [entry.seg.route_id];
        // Une ligne du segment est-elle sélectionnée SANS filtre parcours ?
        const ligneLibreMatch = routes.some(r => visibleLines.has(r) && !lignesFiltrees.has(r));
        if (ligneLibreMatch) {
          show = true;
        } else if (routes.some(r => visibleLines.has(r))) {
          // Seules des lignes filtrées par parcours matchent : exiger un parcours coché.
          const segParcours = entry.seg.parcours
            || (entry.seg.shape_id ? [entry.seg.shape_id] : []);
          show = segParcours.some(p => visibleParcours.has(p));
        } else {
          show = false;
        }
      } else {
        show = false;
      }
      setSegmentOnMap(entry, show);
      if (show) nVisible++;
    }
  } catch(e) {
    console.error("Erreur applyVisibility:", e);
  }
  // Bus temps réel filtrés sur la même sélection (sans nouvel appel au serveur)
  if (RT.dernier && document.getElementById("chkBusTempsReel").checked) afficherBus(RT.dernier);
  // Prévision énergétique : l'échelle suit les segments affichés
  if (typeof majEnergie === "function") majEnergie();
  majResumesSections();

  try {
    document.getElementById("statLines").textContent =
      focusModeActive  ? `Focus (${focusIds.size} seg.)` :
      filterActive     ? `${visibleLines.size} / ${SERVER_META.lignes.length}` :
                         `Aucune — sélectionnez une ligne`;
  } catch(e) {}

  // Réafficher les arrêts cohérents avec la visibilité actuelle
  if (SyncBus.getState().showStops) renderStops();
  refreshRelationArcs();
}

// ===== Focus-mode : n'afficher que les segments du graphe =====
// Activé/désactivé par un message BroadcastChannel spécial venant de graphe.js.
function enterFocusMode(ids) {
  focusModeActive = true;
  focusIds = new Set(ids.map(Number));
  document.getElementById("focusModeBanner")?.remove();

  // Bannière informative
  const banner = document.createElement("div");
  banner.id = "focusModeBanner";
  banner.style.cssText = `
    position:absolute; top:52px; left:12px; z-index:1001;
    background:rgba(255,213,79,0.95); color:#1a1a1a;
    border-radius:6px; padding:6px 12px; font-size:0.78rem;
    font-weight:600; box-shadow:0 2px 8px rgba(0,0,0,0.3);
    display:flex; align-items:center; gap:8px;`;
  banner.innerHTML = `
    <span>🎯 Focus : ${ids.length} segment(s) du graphe</span>
    <button onclick="exitFocusMode()" style="
      background:#c8960c; border:none; border-radius:4px;
      padding:2px 8px; cursor:pointer; font-size:0.75rem; font-weight:700;">
      Désactiver
    </button>`;
  document.getElementById("main-view").appendChild(banner);

  applyVisibility();
}

function exitFocusMode() {
  focusModeActive = false;
  focusIds = new Set();
  document.getElementById("focusModeBanner")?.remove();
  applyVisibility();
}

// ===== Styles visuels selon sélection =====
function updateSegmentVisual(segId, selected) {
  const entry = segmentLayers.get(segId);
  if (!entry) return;
  const style = selected ? selectedSegmentStyle() : baseSegmentStyle(segId);
  entry.polylines.forEach(p => {
    p.setStyle(style);
    if (selected) p.bringToFront();
  });
  if (selected) {
    entry.midMarker.setStyle({ radius: 7, fillColor: "#ffd54f", color: "#f57f17", weight: 2, fillOpacity: 1.0 });
    entry.midMarker.bringToFront();
  } else {
    entry.midMarker.setStyle(baseMarkerStyle(segId));
  }
}

// ===== Rendu des arrêts =====
function renderStops() {
  if (!Array.isArray(DataLoader.stops)) return;
  stopLayer.clearLayers();
  if (!SyncBus.getState().showStops) return;

  // N'afficher que les arrêts des segments actuellement visibles
  const codesVisibles = new Set();
  for (const [segId, entry] of segmentLayers) {
    if (!entry.visible) continue;
    codesVisibles.add(entry.seg.start_stop_code);
    codesVisibles.add(entry.seg.end_stop_code);
  }

  for (const s of DataLoader.stops) {
    if (!codesVisibles.has(s.stop_code)) continue;
    const m = L.circleMarker([s.lat, s.lon], {
      radius: 3, color: "#37474f", weight: 1,
      fillColor: "#cfd8dc", fillOpacity: 0.85,
    });
    m.bindTooltip(`Arrêt ${s.stop_code}${s.stop_name ? ' — ' + s.stop_name : ''}`,
                  { direction: "top", offset: [0, -4] });
    stopLayer.addLayer(m);
  }
}

// ===== Arcs de relation =====
// Segments non sélectionnés colorés parce qu'ils sont liés à la sélection :
// on les mémorise pour remettre leur style de base au rafraîchissement suivant
// (sinon le surlignage persiste après une désélection).
let relHighlightedIds = new Set();

function resetRelHighlights(sel) {
  for (const id of relHighlightedIds) {
    if (sel && sel.has(id)) continue;
    updateSegmentVisual(id, false);
  }
  relHighlightedIds = new Set();
}

function refreshRelationArcs() {
  if (!Array.isArray(DataLoader.relations)) return;
  relArcLayer.clearLayers();
  const sel = SyncBus.getSelection();
  resetRelHighlights(sel);
  if (!document.getElementById("chkShowRelArcs").checked) {
    document.getElementById("statRelShown").textContent = "0";
    return;
  }
  if (sel.size === 0) { document.getElementById("statRelShown").textContent = "0"; return; }

  const activeTypes = SyncBus.getState().activeRelTypes;
  const rels = DataLoader.getRelationsBetween(sel, activeTypes);
  let nDrawn = 0;

  for (const r of rels) {
    const segA = DataLoader.segmentById.get(r.a);
    const segB = DataLoader.segmentById.get(r.b);
    if (!segA || !segB) continue;
    const color = SERVER_META.couleurs[r.type] || "#666";

    const arc = L.polyline([segA.midpoint, segB.midpoint], {
      color, weight: 2.5, opacity: 0.85,
      dashArray: r.type === "suivant" ? null : "4 6",
    });
    arc.bindTooltip(
      `${r.type}${r.longueur_m != null ? ` (${r.longueur_m.toFixed(0)} m)` : ''} : ${r.a} ↔ ${r.b}`,
      { direction: "top", sticky: true }
    );
    arc.on("click", evt => { L.DomEvent.stopPropagation(evt); SyncBus.addMany([r.a, r.b]); });
    relArcLayer.addLayer(arc);

    const otherId = sel.has(r.a) ? r.b : r.a;
    if (!sel.has(otherId)) {
      const oe = segmentLayers.get(otherId);
      if (oe) {
        oe.polylines.forEach(p => p.setStyle({ color, weight: 4, opacity: 0.9 }));
        oe.midMarker.setStyle({ radius: 6, fillColor: color, color: "#fff", weight: 1.5, fillOpacity: 1.0 });
        relHighlightedIds.add(otherId);
      }
    }
    nDrawn++;
  }
  document.getElementById("statRelShown").textContent = nDrawn;
}

// ===== Panneau d'info segment =====
// Lignes liées au segment (types de relations cochés) : les afficher toutes, ou
// choisir lesquelles (même menu que le clic droit sur le segment)
function blocLignesLiees(segId) {
  const { liees } = lignesLiees(segId);
  if (!liees.length) return "";
  const affichees = new Set(lignesGtfsSelectionnees());
  const manquantes = liees.filter(l => !affichees.has(l)).length;
  return `<div class="seg-liees">
      <div class="seg-row"><div class="k">Lignes liées</div><div class="v">${liees.join(", ")}</div></div>
      <div class="btn-row">
        <button type="button" class="action-btn" data-liees="afficher" ${manquantes ? "" : "disabled"}
                title="Ajoute ces lignes à la sélection (section « Lignes »)">${manquantes ? `Afficher (${manquantes})` : "Toutes affichées"}</button>
        <button type="button" class="action-btn" data-liees="choisir" title="Choisir les lignes à afficher (aussi : clic droit sur le segment)">Choisir…</button>
      </div></div>`;
}

function refreshSegInfoPanel() {
  const sel = Array.from(SyncBus.getSelection());
  const panel = document.getElementById("seg-info-panel");
  if (sel.length === 0) { panel.classList.remove("visible"); return; }
  panel.classList.add("visible");

  const title = document.getElementById("segInfoTitle");
  const body  = document.getElementById("segInfoBody");
  const activeTypes = SyncBus.getState().activeRelTypes;

  if (sel.length === 1) {
    const seg = DataLoader.segmentById.get(sel[0]);
    if (!seg) return;
    const fusion = DataLoader.mode === "fusion";
    title.textContent = fusion ? `Nœud fusionné ${seg.id}` : `Segment ${seg.id}`;
    const rels = DataLoader.getRelationsFor(seg.id, activeTypes);
    const ligneRow = fusion
      ? `<div class="seg-row"><div class="k">Lignes</div><div class="v">${(seg.routes || [seg.route_id]).join(", ")}</div></div>`
      : `<div class="seg-row"><div class="k">Ligne</div><div class="v">${seg.route_id}</div></div>`;
    let html = `
      ${ligneRow}
      <div class="seg-row"><div class="k">Départ</div><div class="v">${seg.start_stop_code}</div></div>
      <div class="seg-row"><div class="k">Arrivée</div><div class="v">${seg.end_stop_code}</div></div>
      <div class="seg-row"><div class="k">Relations</div><div class="v">${rels.length}</div></div>
      ${blocLignesLiees(seg.id)}
      ${fusion ? renderFusionBlock(seg.id) : ""}
      <div class="rel-block">
        <div class="rel-title">Centralité</div>
        <div class="seg-row"><div class="k">Liens entrants</div><div class="v">${seg.degree_in ?? 0}</div></div>
        <div class="seg-row"><div class="k">Liens sortants</div><div class="v">${seg.degree_out ?? 0}</div></div>
        <div class="seg-row"><div class="k">Voisins total</div><div class="v">${seg.degree_total ?? 0}</div></div>
        <div class="seg-row"><div class="k">PageRank</div><div class="v">${(seg.pagerank ?? 0).toExponential(3)}</div></div>
        <div class="seg-row"><div class="k">PR normalisé</div><div class="v">${((seg.pagerank_norm ?? 0) * 100).toFixed(1)} %</div></div>
        <div class="seg-row"><div class="k">Radiality</div><div class="v">${(seg.radiality ?? 0).toFixed(4)}</div></div>
        <div class="seg-row"><div class="k">Rad. normalisée</div><div class="v">${((seg.radiality_norm ?? 0) * 100).toFixed(1)} %</div></div>
      </div>
      ${renderAttributsBlocks(seg)}`;
    const byType = {};
    for (const r of rels) { if (!byType[r.type]) byType[r.type] = []; byType[r.type].push(r); }
    for (const t of Object.keys(byType).sort()) {
      html += `<div class="rel-block"><div class="rel-title">${t} (${byType[t].length})</div>`;
      for (const r of byType[t]) {
        const otherId = r.a === seg.id ? r.b : r.a;
        const otherSeg = DataLoader.segmentById.get(otherId);
        const color = SERVER_META.couleurs[t] || "#666";
        html += `<div class="rel-item" data-seg="${otherId}">
          <span class="type-tag" style="background:${color};">${t}</span>
          <span>Seg. ${otherId} (ligne ${otherSeg?.route_id ?? '?'})${r.longueur_m != null ? ' · '+r.longueur_m.toFixed(0)+' m' : ''}</span>
        </div>`;
      }
      html += `</div>`;
    }
    body.innerHTML = html;
    body.querySelectorAll(".rel-item").forEach(el => {
      el.addEventListener("click", () => SyncBus.select(Number(el.dataset.seg), true));
    });
    body.querySelector(".seg-liees")?.addEventListener("click", (e) => {
      const action = e.target.closest("[data-liees]")?.dataset.liees;
      if (action === "afficher") {
        modifierLignes({ ajouter: lignesLiees(seg.id).liees });
        setTimeout(refreshSegInfoPanel, 50);   // libellé du bouton (« Toutes affichées »)
      }
      else if (action === "choisir") {
        // Même menu que le clic droit, ouvert au niveau du bouton (recalé dans la zone carte)
        const r = e.target.closest("button").getBoundingClientRect();
        ouvrirMenuSegment(seg.id, { originalEvent: { clientX: r.left, clientY: r.top, preventDefault() {} } });
      }
    });
  } else {
    title.textContent = `${sel.length} segments sélectionnés`;
    const rels = DataLoader.getRelationsBetween(SyncBus.getSelection(), activeTypes);
    const counts = {};
    for (const r of rels) counts[r.type] = (counts[r.type] || 0) + 1;
    let html = `<div class="seg-row"><div class="k">Segments</div><div class="v">${sel.slice(0,15).join(", ")}${sel.length>15?"…":""}</div></div>
      <div class="seg-row"><div class="k">Relations total</div><div class="v">${rels.length}</div></div>`;
    if (Object.keys(counts).length) {
      html += `<div class="rel-block"><div class="rel-title">Répartition par type</div>`;
      for (const t of Object.keys(counts).sort()) {
        const color = SERVER_META.couleurs[t] || "#666";
        html += `<div class="seg-row">
          <div class="k"><span class="legend-dot" style="background:${color};"></span> ${t}</div>
          <div class="v">${counts[t]}</div></div>`;
      }
      html += `</div>`;
    }
    body.innerHTML = html;
  }
}

function closeSegInfo() {
  document.getElementById("seg-info-panel").classList.remove("visible");
}

// ===== Caractéristiques physiques du segment sélectionné (sidebar Statistiques) =====
// Affiche, pour un unique segment sélectionné, toutes les infos physiques du
// segment ET de sa ligne (distance, dénivelé, feux, vitesse max, pentes, énergie…).
// Tronçon d'une ligne créée dont la fiche est affichée dans « Statistiques »
// (les lignes perso ne sont pas des segments SyncBus : on gère leur fiche à part).
let persoSegInfoActive = null;   // { nom, i, n, leg } ou null

function refreshSidebarSegInfo() {
  const box = document.getElementById("statSegInfo");
  if (!box) return;
  const sel = Array.from(SyncBus.getSelection());
  if (sel.length !== 1) {
    // Aucun vrai segment : garder la fiche d'un tronçon perso s'il y en a une.
    if (sel.length === 0 && persoSegInfoActive) { renderPersoSegInfo(); return; }
    persoSegInfoActive = null;
    box.innerHTML = sel.length > 1
      ? `<div class="instructions">${sel.length} segments sélectionnés — n'en gardez qu'un seul pour voir ses caractéristiques physiques.</div>`
      : `<div class="instructions">Sélectionnez un segment sur la carte pour voir ses caractéristiques physiques (distance, dénivelé, feux, vitesse max…).</div>`;
    return;
  }
  persoSegInfoActive = null;   // un vrai segment sélectionné prend la main
  const seg = DataLoader.segmentById.get(sel[0]);
  if (!seg) { box.innerHTML = ""; return; }
  const fusion = DataLoader.mode === "fusion";
  const ligneRow = fusion
    ? `<div class="seg-row"><div class="k">Lignes</div><div class="v">${(seg.routes || [seg.route_id]).join(", ")}</div></div>`
    : `<div class="seg-row"><div class="k">Ligne</div><div class="v">${seg.route_id}</div></div>`;
  let html = `<div class="rel-block">
      <div class="rel-title">${fusion ? "Nœud fusionné " + seg.id : "Segment " + seg.id}</div>
      ${ligneRow}
      <div class="seg-row"><div class="k">Départ</div><div class="v">${seg.start_stop_code ?? "—"}</div></div>
      <div class="seg-row"><div class="k">Arrivée</div><div class="v">${seg.end_stop_code ?? "—"}</div></div>
    </div>`;
  html += renderAttributsBlocks(seg);
  if (!seg.attributs || Object.keys(seg.attributs).length === 0) {
    html += `<div class="instructions">Attributs physiques indisponibles pour ce segment (parquet p04 absent ?).</div>`;
  }
  box.innerHTML = html;
}

// Clic sur un tronçon d'une ligne créée → afficher sa fiche dans « Statistiques »,
// comme pour un vrai segment. On déselectionne les segments GTFS pour éviter que
// les deux fiches se disputent le panneau.
function showPersoLegInfo(nom, i, n, leg) {
  persoSegInfoActive = { nom, i, n, leg };
  if (SyncBus.getSelection().size) SyncBus.clear();   // déclenche refreshSidebarSegInfo → renderPersoSegInfo
  else renderPersoSegInfo();
}

// Bloc énergie road-load (Wh) d'un tronçon perso — l'équivalent « Énergie » des
// vrais segments, mais dans l'unité réellement calculée par le modèle de trajet.
function persoEnergieBlockHtml(leg) {
  const e = leg && leg.energie;
  if (!e) return "";
  const rows = [
    ["Traction",    e.traction_Wh,    " Wh"],
    ["Chauffage",   e.chauffage_Wh,   " Wh"],
    ["Auxiliaires", e.auxiliaires_Wh, " Wh"],
    ["Totale",      e.totale_Wh,      " Wh"],
    ["Consommation", e.kwh_per_km,    " kWh/km"],
  ].filter(([, v]) => v !== null && v !== undefined);
  if (!rows.length) return "";
  let h = `<div class="rel-block"><div class="rel-title">Énergie (road-load)</div>`;
  for (const [label, v, unit] of rows)
    h += `<div class="seg-row"><div class="k">${label}</div><div class="v">${_fmtAttr(v)}${unit}</div></div>`;
  return h + `</div>`;
}

function renderPersoSegInfo() {
  const box = document.getElementById("statSegInfo");
  if (!box || !persoSegInfoActive) return;
  const { nom, i, n, leg } = persoSegInfoActive;
  const titre = (n > 1) ? `Tronçon ${i + 1}/${n}` : "Tronçon";
  let html = `<div class="rel-block">
      <div class="rel-title">${titre}</div>
      <div class="seg-row"><div class="k">Ligne créée</div><div class="v">★ ${nom}</div></div>
    </div>`;
  const hasAttr = leg && leg.attributs && Object.keys(leg.attributs).length;
  if (hasAttr) {
    html += renderAttributsBlocks({ attributs: leg.attributs });
    html += persoEnergieBlockHtml(leg);
  } else {
    html += persoEnergieBlockHtml(leg);
    html += `<div class="instructions">Statistiques détaillées indisponibles pour ce tronçon — rouvrez l'outil de trajet et ré-enregistrez la ligne pour les (re)calculer.</div>`;
  }
  box.innerHTML = html;
}

function fitToSelection() {
  const sel = SyncBus.getSelection();
  if (sel.size === 0) return;
  const bounds = L.latLngBounds([]);
  for (const id of sel) {
    segmentLayers.get(id)?.polylines.forEach(p => bounds.extend(p.getBounds()));
  }
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
}

// ===== Handlers SyncBus =====
SyncBus.onSelectionChange((selectedIds, fromPeer) => {
  // On met à jour la visibilité globale pour afficher les segments sélectionnés
  applyVisibility();

  const previouslyApplied = SyncBus._lastApplied || new Set();
  const toDeselect = [...previouslyApplied].filter(x => !selectedIds.has(x));
  const toSelect   = [...selectedIds].filter(x => !previouslyApplied.has(x));
  toDeselect.forEach(id => updateSegmentVisual(id, false));
  toSelect.forEach(id   => updateSegmentVisual(id, true));
  SyncBus._lastApplied = new Set(selectedIds);

  refreshRelationArcs();
  refreshSegInfoPanel();
  refreshSidebarSegInfo();
  document.getElementById("statSelSeg").textContent = selectedIds.size;
});

SyncBus.onFilterChange((state) => {
  // Synchro checkboxes
  document.querySelectorAll('#relTypeCheckboxes input[type="checkbox"]').forEach(cb => {
    cb.checked = state.activeRelTypes.has(cb.dataset.rel);
  });
  // Les puces Lignes/Parcours (Choices.js) sont pilotées localement par l'utilisateur ;
  // on ne les reconstruit pas ici (évite les boucles). La visibilité de la carte, elle,
  // suit toujours l'état partagé (visibleLines / visibleParcours).
  document.getElementById("chkShowStops").checked = state.showStops;

  applyVisibility();
  refreshRelationArcs();
  refreshSegInfoPanel();
});

// Message spécial venant du graphe pour le focus-mode
const _origOnMessage = SyncBus._channel?.onmessage;
(function patchBroadcastChannel() {
  // On écoute directement via un second BroadcastChannel en lecture seule
  const bc = new BroadcastChannel("relations-segments-sync");
  bc.addEventListener("message", evt => {
    const msg = evt.data;
    if (!msg || msg.from === SyncBus.tabId) return;
    if (msg.type === "focus_map") {
      if (msg.active) enterFocusMode(msg.ids);
      else            exitFocusMode();
    } else if (msg.type === "trace_voyage") {
      // Une page consommation/simulation demande le tracé d'un voyage
      tracerVoyageSurCarte(msg.voyage);
    } else if (msg.type === "sim_position") {
      // Lecture de la simulation : déplacer le bus le long du voyage
      deplacerBus(msg);
    }
  });
})();

// Bascule de mode demandée localement ou par l'autre fenêtre
SyncBus.onModeChange((mode) => { reloadForMode(mode); });

/* =====================================================
   EXTENSIONS — relief (MNT), couches géobase, création
   de trajet routé sur le réseau routier réel avec
   estimation d'énergie par le modèle physique.
   (Déclarées AVANT le démarrage : les const/let ne sont
   pas hissées, le démarrage est tout en bas du fichier.)
   ===================================================== */

let reliefLayer = null;

let reseauRoutierLayer = null;   // L.polyline multi-tronçons (réseau routable p08)
const reseauRoutierRenderer = L.canvas({ padding: 0.5 });

// Bus en temps réel (GTFS-RT STM via le proxy /api/rt/vehicules, actualisé à chaque version du flux).
// Rendu SVG dans un pane dédié au-dessus des segments : un 2e canvas superposé
// capterait tous les événements souris du canvas des segments, alors qu'en SVG
// seuls les cercles sont interactifs.
// Constantes partagées (seuils, occupation, états) : rt_commun.js
const RT_STATUT = { STOPPED_AT: "À l'arrêt", INCOMING_AT: "Arrive à", IN_TRANSIT_TO: "En route vers" };
const RT = {
  layer: null,          // L.layerGroup des marqueurs
  renderer: null,       // L.svg dans le pane « busTempsReel »
  marqueurs: new Map(), // vehicule_id -> L.circleMarker (mis à jour sur place)
  triangles: new Map(), // vehicule_id -> L.marker ⚠ (bus hors tracé)
  dernier: null,        // dernière réponse /api/rt/vehicules (refiltrage sans nouvel appel)
  // Sélection de bus (clic = focus, Ctrl+clic = ajout), indépendante des segments
  selection: new Set(), // vehicule_id, dans l'ordre de sélection
  tracesLayer: null,    // L.layerGroup des tracés des bus sélectionnés
  infosTrip: new Map(), // trip_id -> {trace_id, coords} | {erreur} | "chargement"
  traces: new Map(),    // trace_id -> {polyline, couleur} (un tracé partagé n'est dessiné qu'une fois)
  cleAvis: null,        // sélection (lignes + directions) déjà examinée pour l'avis « aucun véhicule »
  minuteurAvis: null,
  detoursSignales: new Set(), // bus hors trajet déjà annoncés pour la sélection courante
  // Filtre d'état : null | "hors_trajet" | "depassement" | "pleins" | "figes".
  // Seuls les bus dans cet état restent affichés (bouton « Afficher hors trajet »,
  // tuiles du tableau de bord). Pas de surbrillance : les autres disparaissent.
  filtreEtat: null,
  comptesEtats: {},           // état -> nb de bus dans le périmètre (filtre de lignes)
  tdbDetail: null,            // tuile « liste » du tableau de bord dont le détail est ouvert
  tdbCtx: null,               // listes du tableau de bord pour le périmètre courant
  regLayer: null,             // gaps de service (traits) et bus bunching (pastilles)
  rendererReg: null,
  minuteur: null,
  enVol: false,
  nomsArrets: null,     // stop_code -> nom (construit à la 1re utilisation)
};

// Outil de création de trajet (overlay avec sa propre carte Leaflet)
const Trajet = {
  map: null,          // créée à la première ouverture de l'overlay
  jalons: [],         // [{lat, lon, nom, marker}] — ordonnés
  legsLayer: null,    // L.layerGroup : tronçons colorés (rendu segmenté)
  enCours: false,
  relance: false,     // un recalcul est arrivé pendant qu'un autre était en vol
  dernier: null,      // dernière estimation serveur (pour l'export)
  editId: null,       // id de la ligne perso en cours de modification (sinon null)
  suggestionMarkers: null, // L.layerGroup : arrêts proches candidats sur la carte
  suggestionJalon: null,   // index du jalon dont on affiche les arrêts proches
  rerouteMenu: null,       // menu contextuel « Déplacer ce tronçon » (DOM)
};

const MOIS_COURTS = ["", "Jan", "Fév", "Mar", "Avr", "Mai", "Juin",
                     "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];

function buildExtras() {
  // --- Relief ---
  document.getElementById("chkRelief").addEventListener("change", toggleRelief);
  document.getElementById("reliefOpacity").addEventListener("input", (e) => {
    if (reliefLayer) reliefLayer.setOpacity(Number(e.target.value) / 100);
  });

  // --- Réseau routier routable (dérivé du graphe p08) ---
  document.getElementById("chkReseauRoutier").addEventListener("change", toggleReseauRoutier);

  // --- Bus en temps réel (GTFS-RT) ---
  document.getElementById("chkBusTempsReel").addEventListener("change", toggleBusTempsReel);
  // Tableau de bord plein écran : panneau « Réseau », plus un panneau pour les
  // lignes sélectionnées s'il y en a (écran partagé réseau / lignes)
  document.getElementById("btnOuvrirTdb").addEventListener("click", () => {
    const lignes = lignesGtfsSelectionnees().sort(triLignes);
    const panneaux = ["reseau"].concat(lignes.length ? [lignes.join(",")] : []);
    window.open(new URL(`/tableau_de_bord#${panneaux.join("|")}`, window.location.origin).href, "tableau-de-bord-reseau");
  });
  for (const id of ["chkBusFiltre", "chkBusTraces", "chkBusMasquerAutres", "chkRegularite", "chkDetours"]) {
    document.getElementById(id).addEventListener("change", () => {
      if (id === "chkBusFiltre") RT.cleAvis = null;   // recocher le filtre réexamine la sélection
      if (RT.dernier) afficherBus(RT.dernier);
    });
  }
  document.getElementById("rtAvisFermer").addEventListener("click", masquerAvisBus);
  document.getElementById("btnBusHorsTrajet").addEventListener("click", () => basculerFiltreEtat("hors_trajet"));
  document.getElementById("rtAvisAction").addEventListener("click", () => {
    masquerAvisBus();
    basculerFiltreEtat("hors_trajet", true);
  });
  // Tableau de bord : affiché ou non (préférence locale), fermeture par le ×
  const chkTdb = document.getElementById("chkTdb");
  try { if (localStorage.getItem("tdbAffiche") === "0") chkTdb.checked = false; } catch (e) { /* stockage indisponible */ }
  chkTdb.addEventListener("change", () => {
    try { localStorage.setItem("tdbAffiche", chkTdb.checked ? "1" : "0"); } catch (e) { /* idem */ }
    majVisibiliteTdb();
  });
  document.getElementById("tdbFermer").addEventListener("click", () => {
    chkTdb.checked = false;
    chkTdb.dispatchEvent(new Event("change"));
  });
  surveillerHauteurTdb();
  document.getElementById("chkBusSuivre").addEventListener("change", (e) => {
    if (e.target.checked && RT.dernier) recadrerSelectionBus(RT.dernier);
  });
  document.getElementById("btnBusDeselection").addEventListener("click", () => {
    RT.selection.clear();
    if (RT.dernier) afficherBus(RT.dernier);
  });
  // Onglet masqué : on suspend les appels, sauf si l'historique enregistre ;
  // au retour, rafraîchissement immédiat.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && collecteBusActive()) { demarrerMinuteurBus(); return; }
    majCollecteBus();
  });
  initHistorique();

  // --- Outil de création de trajet (overlay) ---
  const selMois = document.getElementById("trajetMois");
  for (let m = 1; m <= 12; m++) {
    const o = document.createElement("option");
    o.value = m; o.textContent = MOIS_COURTS[m];
    selMois.appendChild(o);
  }
  selMois.value = String(new Date().getMonth() + 1);
  selMois.addEventListener("change", () => recalculerTrajet());
  document.getElementById("trajetCharge").addEventListener("change", () => recalculerTrajet());
  document.getElementById("btnOuvrirTrajet").addEventListener("click", ouvrirOutilTrajet);
  document.getElementById("btnTrajetFermer").addEventListener("click", fermerOutilTrajet);
  document.getElementById("btnTrajetClear").addEventListener("click", effacerTrajet);
  document.getElementById("btnTrajetExport").addEventListener("click", exporterLignePerso);
  setupTrajetFolds();

  // --- Navigation ---
  document.getElementById("btnOpenSimulation")?.addEventListener("click", (e) => {
    e.preventDefault();
    window.open(new URL("/simulation", window.location.origin).href, "relations-simulation");
  });
}

// Désactive les contrôles dont les données sont absentes (flags de /api/meta)
function updateExtrasAvailability() {
  const meta = DataLoader.meta || {};
  const setDispo = (id, dispo, titre) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !dispo;
    if (!dispo) el.title = titre;
  };
  setDispo("chkRelief", !!meta.relief_disponible,
           "Relief absent — lancez pipeline/p07_relief_overlay.py");
  setDispo("chkReseauRoutier", !!meta.trajet_disponible,
           "Réseau routier absent — lancez pipeline/p08_graphe_routier.py");
  setDispo("btnOuvrirTrajet", !!meta.trajet_disponible,
           "Graphe routier absent — lancez pipeline/p08_graphe_routier.py");
  setDispo("chkBusTempsReel", !!meta.rt_disponible,
           "Temps réel indisponible — définir STM_API_KEY (clé du portail développeurs STM)");
  // Historique : sans flux temps réel, la section n'a pas d'objet. Sinon, il
  // enregistre dès l'ouverture de la page (« Enregistrer en continu » coché).
  document.getElementById("secHistorique").style.display = meta.rt_disponible ? "" : "none";
  setDispo("chkHistorique", !!meta.rt_disponible, "Temps réel indisponible");
  setDispo("btnOuvrirTdb", !!meta.rt_disponible, "Temps réel indisponible — définir STM_API_KEY");
  majCollecteBus();
  rendreHistorique();
  majBoutonReplierTout();
  // Pages Consommation / Simulation : masquées si leurs données ne sont pas
  // chargées (déploiement allégé VIZ_LIGHT ou parquet conso absent).
  const hideIf = (id, absent) => {
    const el = document.getElementById(id);
    if (el) el.style.display = absent ? "none" : "";
  };
  hideIf("btnOpenConso", !meta.conso_disponible);
  // Prévision énergétique : agrégats du modèle physique (servis aussi en mode statique)
  if (typeof disponibiliteEnergie === "function") disponibiliteEnergie(!!meta.energie_disponible);
  hideIf("btnOpenSimulation", !meta.simulation_disponible);
  // Pages Graphe / Graphe de calcul : désactivées en mode allégé VIZ_LIGHT.
  hideIf("btnOpenGraph", meta.graphe_disponible === false);
  // Démo publique : détours en lecture seule (valider, supprimer, tracer : en local seulement)
  RT.detoursActions = meta.detours_actions !== false;
  hideIf("btnTracerDetour", !RT.detoursActions);
}

// ===== Relief =====
async function toggleRelief(e) {
  if (!e.target.checked) {
    if (reliefLayer && map.hasLayer(reliefLayer)) map.removeLayer(reliefLayer);
    return;
  }
  if (!reliefLayer) {
    const res = await fetch("/api/relief");
    if (!res.ok) {
      alert("Relief indisponible (lancez pipeline/p07_relief_overlay.py).");
      e.target.checked = false;
      return;
    }
    const data = await res.json();
    const opacity = Number(document.getElementById("reliefOpacity").value) / 100;
    reliefLayer = L.imageOverlay(data.url, data.bounds, { opacity });
  }
  reliefLayer.addTo(map);
  reliefLayer.bringToBack();
}

// ===== Réseau routier routable (arêtes du graphe p08) =====
// Overlay = EXACTEMENT le réseau sur lequel les trajets sont tracés (dérivé du
// graphe, pas de la géobase brute). Rendu en une seule polyligne multi-tronçons
// sur renderer canvas pour la performance (~35 000 tronçons).
async function toggleReseauRoutier(e) {
  if (!e.target.checked) {
    if (reseauRoutierLayer && map.hasLayer(reseauRoutierLayer)) map.removeLayer(reseauRoutierLayer);
    return;
  }
  if (!reseauRoutierLayer) {
    setHint("Chargement du réseau routier…");
    try {
      const data = await fetch("/api/reseau_routier").then(r => {
        if (!r.ok) throw new Error("absent");
        return r.json();
      });
      reseauRoutierLayer = L.polyline(data.lignes || [], {
        color: "#78909c", weight: 1, opacity: 0.45,
        interactive: false, renderer: reseauRoutierRenderer,
      });
    } catch (err) {
      alert("Réseau routier indisponible (lancez pipeline/p08_graphe_routier.py).");
      e.target.checked = false;
      setHint("");
      return;
    }
    setHint("");
  }
  reseauRoutierLayer.addTo(map);
  reseauRoutierLayer.bringToBack();
  if (reliefLayer && map.hasLayer(reliefLayer)) reliefLayer.bringToBack();
}

// ===== Bus en temps réel (GTFS-RT STM) =====
function toggleBusTempsReel(e) {
  const panneau = document.getElementById("rtPanneau");
  if (!e.target.checked) {
    majCollecteBus();   // l'historique peut continuer à interroger le flux
    if (RT.layer && map.hasLayer(RT.layer)) map.removeLayer(RT.layer);
    if (RT.tracesLayer && map.hasLayer(RT.tracesLayer)) map.removeLayer(RT.tracesLayer);
    if (RT.regLayer && map.hasLayer(RT.regLayer)) map.removeLayer(RT.regLayer);
    panneau.hidden = true;
    majVisibiliteTdb();
    masquerAvisBus();
    return;
  }
  RT.cleAvis = null;   // à la réactivation, la sélection courante est réexaminée
  if (!RT.layer) {
    map.createPane("busTempsReel").style.zIndex = 450;   // au-dessus des segments (overlayPane = 400)
    RT.renderer = L.svg({ pane: "busTempsReel" });
    RT.layer = L.layerGroup();
    // Tracés des bus sélectionnés : sous les bus, au-dessus des segments, non interactifs
    const paneTraces = map.createPane("busTraces");
    paneTraces.style.zIndex = 440;
    paneTraces.style.pointerEvents = "none";
    RT.rendererTraces = L.svg({ pane: "busTraces" });
    RT.tracesLayer = L.layerGroup();
    // Gaps de service / bus bunching : entre les tracés et les bus. En SVG, seuls
    // les traits et pastilles captent la souris (infobulles), pas le reste du pane.
    map.createPane("busRegularite").style.zIndex = 445;
    RT.rendererReg = L.svg({ pane: "busRegularite" });
    RT.regLayer = L.layerGroup();
  }
  RT.tracesLayer.addTo(map);
  RT.regLayer.addTo(map);
  RT.layer.addTo(map);
  panneau.hidden = false;
  if (RT.dernier) afficherBus(RT.dernier);   // déjà collecté par l'historique : affichage immédiat
  demarrerMinuteurBus();
}

// Actualisation dès qu'une nouvelle version du flux est en ligne (rt_commun.js, BoucleFlux)
function demarrerMinuteurBus() {
  RT.boucle ??= new BoucleFlux(rafraichirBus);
  RT.boucle.demarrer();
}

function arreterMinuteurBus() {
  RT.boucle?.arreter();
}

const collecteBusActive = () => !!RT.boucle?.active;

function nomArret(code) {
  if (!RT.nomsArrets) {
    RT.nomsArrets = new Map();
    for (const s of (DataLoader.stops || [])) RT.nomsArrets.set(String(s.stop_code), s.stop_name || "");
  }
  return RT.nomsArrets.get(String(code)) || "";
}

function setStatutBus(texte, erreur = false) {
  const el = document.getElementById("rtStatut");
  el.textContent = texte;
  el.classList.toggle("rt-statut-erreur", erreur);
}

// Renvoie le délai avant l'appel suivant (juste après la prochaine version du flux)
async function rafraichirBus() {
  if (RT.enVol) return 1000;
  RT.enVol = true;
  let delai = RT_RAFRAICHISSEMENT_MS;
  try {
    const rep = await fetch("/api/rt/vehicules", { cache: "no-store" });
    const data = await rep.json();
    if (!rep.ok) throw new Error(data.error || `HTTP ${rep.status}`);
    delai = delaiProchainFlux(data);
    RT.dernier = data;
    historiqueFluxRetabli();
    enregistrerHistorique(data);
    // La couche a pu être décochée pendant l'appel : ne rien redessiner.
    if (document.getElementById("chkBusTempsReel").checked) afficherBus(data);
  } catch (err) {
    setStatutBus(`Temps réel indisponible : ${err.message}`, true);
    historiqueErreurFlux(err.message);
  } finally {
    RT.enVol = false;
  }
  return delai;
}

// Filtre « lignes / directions sélectionnées » (coché par défaut) : même sélection
// que les segments (sélecteurs Lignes et Parcours types). Renvoie null si aucun
// filtre ne s'applique, sinon {garder(route, direction), lignes, dirsChoisies}.
function filtreBus() {
  if (!document.getElementById("chkBusFiltre").checked) return null;
  const state = SyncBus.getState();
  if (!state.visibleLines.size) return null;
  const lp = SERVER_META.lignes_parcours || {};
  const dirsChoisies = new Map();   // ligne -> directions des parcours cochés
  for (const pid of (state.visibleParcours || [])) {
    const ligne = PARCOURS_TO_LINE.get(pid);
    const p = (lp[ligne] || []).find(x => x.id === pid);
    if (!p) continue;
    if (!dirsChoisies.has(ligne)) dirsChoisies.set(ligne, new Set());
    dirsChoisies.get(ligne).add(p.direction);
  }
  const garder = (route, direction) => {
    if (!state.visibleLines.has(route)) return false;
    const choisies = dirsChoisies.get(route);
    if (!choisies || !direction) return true;
    // Direction inconnue des parcours de la carte (construits sur un GTFS antérieur,
    // ex. ligne 119 passée de Nord/Sud à Est/Ouest) : on ne masque pas le bus.
    const connues = new Set((lp[route] || []).map(x => x.direction));
    return !connues.has(direction) || choisies.has(direction);
  };
  return { garder, lignes: [...state.visibleLines], dirsChoisies };
}

// ----- Avis sur la sélection de lignes : aucun véhicule, bus hors trajet -----
// Émis quand la sélection (lignes + directions) change, pas à chaque
// actualisation : RT.cleAvis mémorise la dernière sélection examinée. Pendant
// les actualisations, seul un NOUVEAU bus hors trajet rouvre l'avis.
const RT_AVIS_DETOURS_MAX = 5;   // bus listés nommément dans l'avis

function libelleLigneDir(ligne, dirsChoisies) {
  const dirs = dirsChoisies.get(ligne);
  return `${ligne}${dirs && dirs.size ? " (" + [...dirs].sort().join(", ") + ")" : ""}`;
}


function majAvisSelection(filtre, compteParLigne, detours) {
  if (!filtre) {
    // Désélection des lignes : l'avis portait sur l'ancienne sélection
    if (RT.cleAvis !== null) masquerAvisBus();
    RT.cleAvis = null;
    RT.detoursSignales.clear();
    return;
  }
  const cle = filtre.lignes.slice().sort().join(",") + "|" +
    [...filtre.dirsChoisies].map(([l, d]) => l + ":" + [...d].sort().join("+")).sort().join(",");
  const nouvelleSel = cle !== RT.cleAvis;
  if (nouvelleSel) { RT.cleAvis = cle; RT.detoursSignales = new Set(); }
  const nouveaux = detours.filter(d => !RT.detoursSignales.has(d.id));
  for (const d of detours) RT.detoursSignales.add(d.id);

  const messages = [];
  if (nouvelleSel) {
    const vides = filtre.lignes.filter(l => !compteParLigne.get(l)).sort(triLignes);
    if (vides.length) {
      const liste = vides.map(l => libelleLigneDir(l, filtre.dirsChoisies)).join(", ");
      const lignes = vides.length > 1 ? "les lignes" : "la ligne";
      messages.push(`Aucun véhicule n'est actuellement en service sur ${lignes} ${liste}.` +
        (vides.length < filtre.lignes.length ? " Les autres lignes sélectionnées sont affichées." : ""));
    }
  }
  const aAnnoncer = nouvelleSel ? detours : nouveaux;
  if (aAnnoncer.length) {
    const n = aAnnoncer.length;
    messages.push({
      titre: nouvelleSel
        ? `⚠ ${n} bus hors trajet sur la sélection (détour probable) :`
        : `⚠ ${n > 1 ? `${n} nouveaux bus hors trajet` : "Nouveau bus hors trajet"} sur la sélection :`,
      items: aAnnoncer
        .slice().sort((a, b) => triLignes(a.route, b.route) || b.ecart - a.ecart)
        .map(d => `Ligne ${d.route}${d.direction ? " " + d.direction : ""} — bus ${d.id}, ` +
                  `à ${d.ecart.toLocaleString("fr-CA")} m de son tracé`),
    });
  }
  if (messages.length) {
    afficherAvisBus(messages, { actionHorsTrajet: aAnnoncer.length > 0 && RT.filtreEtat !== "hors_trajet" });
  } else if (nouvelleSel) {
    masquerAvisBus();
  }
}

// messages : chaînes et/ou {titre, items} (liste à puces, tronquée au-delà de RT_AVIS_DETOURS_MAX)
function afficherAvisBus(messages, { actionHorsTrajet = false } = {}) {
  const conteneur = document.getElementById("rtAvisTexte");
  conteneur.replaceChildren();
  for (const msg of [].concat(messages)) {
    const bloc = document.createElement("div");
    bloc.className = "rt-avis-ligne";
    if (typeof msg === "string") {
      bloc.textContent = msg;
    } else {
      bloc.textContent = msg.titre;
      const ul = document.createElement("ul");
      ul.className = "rt-avis-detours";
      for (const item of msg.items.slice(0, RT_AVIS_DETOURS_MAX)) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      }
      if (msg.items.length > RT_AVIS_DETOURS_MAX) {
        const li = document.createElement("li");
        li.textContent = `… et ${msg.items.length - RT_AVIS_DETOURS_MAX} autre(s)`;
        ul.appendChild(li);
      }
      bloc.appendChild(ul);
    }
    conteneur.appendChild(bloc);
  }
  document.getElementById("rtAvisAction").hidden = !actionHorsTrajet;
  document.getElementById("rtAvis").hidden = false;
  clearTimeout(RT.minuteurAvis);
  RT.minuteurAvis = setTimeout(masquerAvisBus, actionHorsTrajet ? 12000 : 8000);
}

// ----- Filtres d'état : ne garder que les bus hors trajet / en dépassement / pleins / figés -----
// Pas de surbrillance : les bus en fonctionnement normal disparaissent, simplement.
// États d'un bus (RT_ETATS) : rt_commun.js

function basculerFiltreEtat(etat, forcer) {
  const actif = forcer === undefined ? RT.filtreEtat !== etat : forcer;
  RT.filtreEtat = actif ? etat : (RT.filtreEtat === etat ? null : RT.filtreEtat);
  if (RT.dernier) afficherBus(RT.dernier);
  if (RT.filtreEtat === etat && RT.dernier && !RT.comptesEtats[etat]) {
    afficherAvisBus(`Aucun bus ${RT_ETATS[etat].libelle} ${filtreBus() ? "sur les lignes sélectionnées" : "sur le réseau"} actuellement.`);
  }
}

function majBoutonHorsTrajet() {
  const btn = document.getElementById("btnBusHorsTrajet");
  const actif = RT.filtreEtat === "hors_trajet";
  const n = RT.dernier ? ` (${RT.comptesEtats.hors_trajet || 0})` : "";
  btn.textContent = actif ? `⚠ Hors trajet seulement${n} — tout afficher` : `⚠ Afficher hors trajet${n}`;
  btn.classList.toggle("primary", actif);
  btn.setAttribute("aria-pressed", String(actif));
}

function masquerAvisBus() {
  clearTimeout(RT.minuteurAvis);
  document.getElementById("rtAvis").hidden = true;
}

function afficherBus(data) {
  const idx = Object.fromEntries(data.champs.map((c, i) => [c, i]));
  const maintenant = Math.floor(Date.now() / 1000);
  const filtre = filtreBus();
  const garder = filtre && filtre.garder;
  const compteParLigne = new Map();   // ligne sélectionnée -> nb de bus retenus par le filtre
  // Bus sélectionnés : toujours affichés (comme les segments sélectionnés), et
  // seuls affichés si « Masquer les autres bus » est coché.
  const presents = new Set(data.vehicules.map(v => v[idx.vehicule_id]));
  for (const id of [...RT.selection]) if (!presents.has(id)) RT.selection.delete(id);  // sortis du flux
  const focus = RT.selection.size > 0;
  const masquerAutres = focus && document.getElementById("chkBusMasquerAutres").checked;
  const vus = new Set();
  let nDetours = 0;
  const detoursFiltre = [];   // bus hors trajet parmi ceux retenus par le filtre de lignes
  const comptesEtats = Object.fromEntries(Object.keys(RT_ETATS).map(e => [e, 0]));
  let nPerimetre = 0;         // bus retenus par le filtre de lignes (périmètre du tableau de bord)
  const testeEtat = RT.filtreEtat ? RT_ETATS[RT.filtreEtat].teste : null;
  const regBus = (data.regularite && data.regularite.bus) || {};   // vehicule_id -> écarts devant/derrière
  for (const v of data.vehicules) {
    const id = v[idx.vehicule_id];
    const route = v[idx.route_id];
    const direction = v[idx.direction];
    const ecart = v[idx.ecart_trace_m];
    const detour = ecart != null && ecart > RT_SEUIL_DETOUR_M;
    const statutDetour = v[idx.detour_statut];   // "valide" | "potentiel" | null (serveur/detours.py)
    const choisi = RT.selection.has(id);
    const retenu = !garder || garder(route, direction);
    if (garder && retenu) compteParLigne.set(route, (compteParLigne.get(route) || 0) + 1);
    if (retenu) {
      nPerimetre++;
      if (detour && statutDetour !== "valide") detoursFiltre.push({ id, route, direction, ecart });
      for (const [etat, def] of Object.entries(RT_ETATS)) if (def.teste(v, idx, maintenant, regBus)) comptesEtats[etat]++;
    }
    if (!choisi && (masquerAutres || !retenu || (testeEtat && !testeEtat(v, idx, maintenant, regBus)))) continue;
    vus.add(id);
    const [couleur, libelle] = RT_OCCUPATION[v[idx.occupation]] || ["#9e9e9e", "Occupation inconnue"];
    const arret = v[idx.stop_id];
    const nom = nomArret(arret);
    const vitesse = v[idx.vitesse_kmh];
    const age = v[idx.t_position] ? maintenant - v[idx.t_position] : null;
    if (detour) nDetours++;
    const infobulle =
      `<b>Ligne ${route ?? "?"}${direction ? " " + direction : ""}</b> · bus ${id}<br>` +
      `${RT_STATUT[v[idx.statut_arret]] || "Prochain arrêt"} ${arret ?? "?"}${nom ? " — " + nom : ""}<br>` +
      `${libelle}${vitesse != null ? ` · ${Math.round(vitesse)} km/h` : ""}` +
      (statutDetour === "valide"
        ? `<br><b style="color:#fb8c00">↪ Détour validé : même tracé hors GTFS emprunté par au moins 2 bus</b>` +
          `<br><span style="opacity:.8">à ${ecart.toLocaleString("fr-CA")} m du tracé GTFS du trajet</span>`
        : statutDetour === "potentiel"
        ? `<br><b style="color:#ffb300">⚠ Hors tracé : à ${ecart.toLocaleString("fr-CA")} m du tracé GTFS (détour potentiel, tracé estimé en jaune)</b>`
        : detour ? `<br><b style="color:#ffb300">⚠ Hors tracé : à ${ecart.toLocaleString("fr-CA")} m du tracé GTFS du trajet (détour ?)</b>` +
          (RT_RAISONS_SANS_TRACE[statutDetour] ? `<br><span style="opacity:.8">Pas de tracé estimé : ${RT_RAISONS_SANS_TRACE[statutDetour]}</span>` : "")
        : "") +
      infobulleRegularite(regBus[id]) +
      (age != null ? `<br><span style="opacity:.7">position d'il y a ${age} s</span>` : "");
    const ll = [v[idx.lat], v[idx.lon]];

    const style = styleBus(couleur, choisi, focus);
    let m = RT.marqueurs.get(id);
    if (m) {
      m.setLatLng(ll);
      m.setStyle(style);
      m.setRadius(style.radius);
      m.setTooltipContent(infobulle);
    } else {
      m = L.circleMarker(ll, { renderer: RT.renderer, pane: "busTempsReel", ...style })
        .bindTooltip(infobulle, { direction: "top", offset: [0, -4] });
      m.on("click", (evt) => {
        L.DomEvent.stopPropagation(evt);
        if (typeof clicTraceDetour === "function" && clicTraceDetour(evt)) return;
        const oe = evt.originalEvent;
        cliquerBus(id, oe.ctrlKey || oe.metaKey || oe.shiftKey);
      });
      RT.marqueurs.set(id, m);
      RT.layer.addLayer(m);
    }
    if (choisi) m.bringToFront();

    // Triangle ⚠ (hors tracé) ou flèche ↪ (détour validé) accolé en haut à droite du
    // bus, non interactif (le survol reste au cercle)
    let t = RT.triangles.get(id);
    const signe = statutDetour === "valide" ? "↪" : "⚠";
    if (detour && t && t.options.signe !== signe) { RT.layer.removeLayer(t); RT.triangles.delete(id); t = null; }
    if (detour && !t) {
      t = L.marker(ll, {
        pane: "busTempsReel", interactive: false, keyboard: false, signe,
        icon: L.divIcon({ className: signe === "↪" ? "rt-detour rt-detour-valide" : "rt-detour", html: signe,
                          iconSize: [14, 14], iconAnchor: [-3, 17] }),
      });
      RT.triangles.set(id, t);
      RT.layer.addLayer(t);
    } else if (detour) {
      t.setLatLng(ll);
    } else if (t) {
      RT.layer.removeLayer(t);
      RT.triangles.delete(id);
    }
  }
  // Bus disparus du flux (fin de service, perte de signal) ou exclus par le filtre
  for (const [id, m] of RT.marqueurs) {
    if (vus.has(id)) continue;
    RT.layer.removeLayer(m);
    RT.marqueurs.delete(id);
    const t = RT.triangles.get(id);
    if (t) { RT.layer.removeLayer(t); RT.triangles.delete(id); }
  }
  majSelectionBus(data, idx);
  RT.comptesEtats = comptesEtats;
  majBoutonHorsTrajet();
  majAvisSelection(filtre, compteParLigne, detoursFiltre);
  if (typeof majSourdines === "function") majSourdines(data);   // detours_carte.js
  dessinerRegularite(data, vus);
  dessinerDetours(data, filtre);
  majTableauDeBord(data, filtre, nPerimetre, maintenant);
  majResumesSections();

  const total = data.vehicules.length;
  const ref = data.referentiel;
  const ageFlux = data.t_flux ? maintenant - data.t_flux : null;
  const filtreCoche = document.getElementById("chkBusFiltre").checked;
  let statut = `${vus.size.toLocaleString("fr-CA")} bus` +
               (garder ? ` sur ${total.toLocaleString("fr-CA")}` : "") +
               (filtreCoche && !garder ? " (aucune ligne sélectionnée)" : "") +
               (garder && !compteParLigne.size ? " · aucun véhicule en service sur la sélection" : "") +
               (RT.filtreEtat ? ` · bus ${RT_ETATS[RT.filtreEtat].libelle} seulement` : "") +
               (ref ? ` · ${nDetours} hors tracé` : "") +
               (ageFlux != null ? ` · flux STM d'il y a ${ageFlux} s` : "");
  let alerte = !!data.perime;
  if (data.perime) statut += " · ⚠ STM injoignable, dernières données connues";
  if (!ref) {
    statut += " · détours non calculés (référentiel GTFS absent)";
  } else if (total && ref.trajets_inconnus / total > 0.2) {
    // Nouveau GTFS publié : les trip_id du flux ne sont plus dans le référentiel.
    statut += ` · ⚠ référentiel GTFS ${ref.version} périmé (scripts/exporter_referentiel_rt.py)`;
    alerte = true;
  }
  setStatutBus(statut, alerte);
}

// ===== Régularité : bus bunching et gaps de service =====
// Calcul côté serveur (serveur/regularite.py) : bus ordonnés le long du tracé
// principal de leur ligne/direction ; écart / intervalle prévu < 0,25 = bus bunching,
// > 2 = gap de service. Ici : infobulles, traits des gaps, pastilles du bunching.

function infobulleRegularite(r) {
  if (!r) return "";
  let html = "";
  if (r.devant_min != null || r.derriere_min != null) {
    html += `<br>Bus devant : ${r.devant_min != null ? fmtMin(r.devant_min) : "—"} · ` +
            `derrière : ${r.derriere_min != null ? fmtMin(r.derriere_min) : "—"}`;
  }
  if (r.train) html += `<br><b style="color:#ce93d8">🚌 En train de bus</b>`;
  if (r.trou_devant) html += `<br><b style="color:#ef9a9a">Gap de service devant ce bus</b>`;
  return html;
}

// visibles : bus affichés sur la carte. Un gap ou un bunching n'est dessiné que si
// ses deux bus le sont : il suit ainsi le filtre de lignes, les filtres d'état du
// tableau de bord (hors trajet, pleins, en bunching…) et « Masquer les autres bus ».
function dessinerRegularite(data, visibles) {
  if (!RT.regLayer) return;
  RT.regLayer.clearLayers();
  const reg = data.regularite;
  if (!reg || !document.getElementById("chkRegularite").checked) return;
  const ecarts = reg.ecarts.filter(e => visibles.has(e.suiveur) && visibles.has(e.meneur));
  const intervalle = e => reg.lignes[`${e.route}|${e.direction}`]?.intervalle_min;

  for (const e of ecarts.filter(e => e.type === "trou")) {
    L.polyline(e.coords, {
      renderer: RT.rendererReg, pane: "busRegularite",
      color: "#e53935", weight: 6, opacity: 0.75, dashArray: "10 7", lineCap: "butt",
    }).bindTooltip(
      `<b>Gap de service</b> · ligne ${e.route}${e.direction ? " " + e.direction : ""}<br>` +
      `${fmtMin(e.minutes)} entre le bus ${e.suiveur} et le bus ${e.meneur} ` +
      `(${(e.dist_m / 1000).toLocaleString("fr-CA", { maximumFractionDigits: 1 })} km)<br>` +
      `Intervalle prévu : ${fmtMin(intervalle(e))} · ×${e.rapport.toLocaleString("fr-CA")}`,
      { sticky: true }
    ).addTo(RT.regLayer);
  }

  // Bunching : les paires qui partagent un bus forment un seul groupe (A-B + B-C = 3 bus)
  const trains = ecarts.filter(e => e.type === "train");
  const parent = new Map();
  const racine = x => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (const e of trains) for (const b of [e.suiveur, e.meneur]) if (!parent.has(b)) parent.set(b, b);
  for (const e of trains) parent.set(racine(e.suiveur), racine(e.meneur));
  const groupes = new Map();   // racine -> {bus: Set, paires: []}
  for (const e of trains) {
    const r = racine(e.suiveur);
    if (!groupes.has(r)) groupes.set(r, { bus: new Set(), paires: [] });
    groupes.get(r).bus.add(e.suiveur).add(e.meneur);
    groupes.get(r).paires.push(e);
  }
  for (const g of groupes.values()) {
    const e0 = g.paires[0];
    const n = g.bus.size;
    L.marker(e0.point, {
      pane: "busRegularite", keyboard: false,
      icon: L.divIcon({ className: "", html: `<span class="rt-train">🚌×${n}</span>`,
                        iconSize: null, iconAnchor: [22, 26] }),
    }).bindTooltip(
      `<b>Bus bunching : ${n} bus</b> · ligne ${e0.route}${e0.direction ? " " + e0.direction : ""}<br>` +
      g.paires.map(e => `bus ${e.suiveur} → ${e.meneur} : ${fmtMin(e.minutes)} (${e.dist_m} m)`).join("<br>") +
      `<br>Intervalle prévu : ${fmtMin(intervalle(e0))}`,
      { direction: "top" }
    ).addTo(RT.regLayer);
  }
}

// ===== Détours observés (serveur/detours.py) =====
// Tracé estimé sur le réseau routier routable, validé rue par rue : pointillés
// jaunes pour les portions empruntées par un seul bus (potentielles), orange
// pour celles empruntées par au moins 2 bus (validées). Un détour est « validé »
// quand 80 % de son tracé l'est. Suivent le filtre de lignes ; avec un filtre
// d'état, seuls « hors trajet » (potentiels) et « détour validé » (validés) les gardent.
const kmFr = m => (m / 1000).toLocaleString("fr-CA", { maximumFractionDigits: 1 });
function dessinerDetours(data, filtre) {
  if (!RT.regLayer || !Array.isArray(data.detours) || !document.getElementById("chkDetours").checked) return;
  const garder = filtre && filtre.garder;
  for (const d of data.detours) {
    if (garder && !garder(String(d.route), d.direction)) continue;
    if (RT.filtreEtat && RT.filtreEtat !== (d.valide ? "detour_valide" : "hors_trajet")) continue;
    const troncons = Array.isArray(d.troncons) ? d.troncons : [{ coords: d.coords, valide: d.valide }];
    const partiel = !d.valide && d.longueur_validee_m > 0;
    const infobulle =
      `<b>${d.valide ? "↪ Détour validé" : partiel ? "Détour partiellement validé" : "Détour potentiel"}</b>` +
      ` · ligne ${d.route}${d.direction ? " " + d.direction : ""}` +
      `${d.manuel ? " · tracé à la main" : d.force ? " · validé manuellement" : ""}<br>` +
      (d.manuel && !d.n_bus ? "Aucun bus observé dessus pour l'instant<br>"
        : `${d.n_bus} bus : ${d.bus.join(", ")}<br>`) +
      `Tracé estimé sur le réseau routier : ${kmFr(d.longueur_m)} km` +
      (d.force ? "" : ` dont ${kmFr(d.longueur_validee_m ?? 0)} km emprunté(s) par ≥ 2 bus`) +
      `<br>${d.passages} passage(s) terminé(s) · depuis ${hhmm(d.debut)} · dernier passage ${hhmm(d.dernier)}` +
      (d.en_cours.length ? `<br>En cours : bus ${d.en_cours.join(", ")}` : "") +
      (d.force ? "" : `<br><span style="opacity:.8">Orange : rues empruntées par ≥ 2 bus · jaune : par un seul</span>`) +
      (RT.detoursActions !== false ? `<br><span style="opacity:.7">Clic droit : valider, supprimer, retracer</span>` : "");
    for (const t of troncons) {
      if (!t.coords || t.coords.length < 2) continue;
      L.polyline(t.coords, {
        renderer: RT.rendererReg, pane: "busRegularite", lineCap: "round", lineJoin: "round",
        ...(t.valide ? { color: "#fb8c00", weight: 5, opacity: 0.95, dashArray: "10 6" }
                     : { color: "#fdd835", weight: 4, opacity: 0.95, dashArray: "1 8" }),
      }).on("contextmenu", (evt) => ouvrirMenuDetour(d, evt))   // detours_carte.js
      .bindTooltip(infobulle, { sticky: true }).addTo(RT.regLayer);
    }
  }
}

// ===== Tableau de bord réseau =====
// Périmètre : les lignes sélectionnées (même filtre que la carte), sinon tout le réseau.
// Tuiles « liste » : ouvrent un détail cliquable (clic sur une ligne = la sélectionner).
// Tuiles « filtre » : ne gardent sur la carte que les bus dans cet état.
const TDB_TUILES = [
  { cle: "sans_vehicule", type: "liste",  lib: "Voyages sans véhicule",   sous: "prévus en cours, non annoncés" },
  { cle: "annule",        type: "liste",  lib: "Voyages annulés",         sous: "annoncés par la STM" },
  { cle: "lignes_sans",   type: "liste",  lib: "Lignes sans aucun bus",   sous: "service prévu en cours" },
  { cle: "pires",         type: "liste",  lib: "Lignes touchées",         sous: "≥ 1 voyage non livré" },
  { cle: "regularite",    type: "liste",  lib: "Régularité",              sous: "part des écarts entre bus compris entre 0,5 et 1,5 × l'intervalle prévu" },
  { cle: "trous",         type: "liste",  lib: "Gaps de service",         sous: "écart entre deux bus > 2 × l'intervalle prévu" },
  { cle: "detours",       type: "liste",  lib: "Détours validés",         sous: "même tracé hors GTFS emprunté par ≥ 2 bus (estimé sur le réseau routier)" },
  { cle: "train",         type: "filtre", lib: "Bus en bunching",         sous: "écart avec le bus voisin < 0,25 × l'intervalle prévu" },
  { cle: "hors_trajet",   type: "filtre", lib: "Bus hors trajet",         sous: `> ${RT_SEUIL_DETOUR_M} m de leur tracé` },
  { cle: "depassement",   type: "filtre", lib: "Bus en dépassement",      sous: "> 5 min après la fin prévue" },
  { cle: "pleins",        type: "filtre", lib: "Bus pleins",              sous: "occupation déclarée" },
  { cle: "figes",         type: "filtre", lib: "Positions figées",        sous: `> ${RT_FIGE_S / 60} min sans mise à jour` },
];
const TDB_LISTE_MAX = 40;

function construireTuilesTdb() {
  const grille = document.getElementById("tdbGrille");
  if (grille.childElementCount) return;
  for (const t of TDB_TUILES) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tdb-tuile";
    b.dataset.cle = t.cle;
    // Barre compacte : la précision (« sous ») passe dans l'infobulle
    b.title = `${t.lib} : ${t.sous}\n` + (t.type === "filtre"
      ? "Clic : ne garder sur la carte que ces bus (re-cliquer pour tout afficher)"
      : "Clic : afficher la liste (clic sur une ligne = la sélectionner)");
    b.innerHTML = `<span class="val">–</span><span class="lib">${t.lib}</span>`;
    b.addEventListener("click", () => {
      if (t.type === "filtre") {
        basculerFiltreEtat(t.cle);
      } else {
        RT.tdbDetail = RT.tdbDetail === t.cle ? null : t.cle;
        rendreDetailTdb();
        majEtatTuilesTdb();
      }
    });
    grille.appendChild(b);
  }
}

// Barre visible si la couche temps réel est active ET la case « Tableau de bord » cochée.
function majVisibiliteTdb() {
  const tdb = document.getElementById("tdb");
  const visible = document.getElementById("chkBusTempsReel").checked
               && document.getElementById("chkTdb").checked
               && RT.dernier !== null;
  if (tdb.hidden === !visible) return;
  tdb.hidden = !visible;
}

// La carte se réduit de la hauteur de la barre (flex) : Leaflet doit recalculer
// sa taille, et les éléments positionnés en bas (avis, panneau segment) remontent
// d'autant via --tdb-h.
function surveillerHauteurTdb() {
  const tdb = document.getElementById("tdb");
  const vue = document.getElementById("main-view");
  const maj = () => {
    vue.style.setProperty("--tdb-h", `${tdb.hidden ? 0 : tdb.offsetHeight}px`);
    map.invalidateSize({ pan: false });
  };
  if ("ResizeObserver" in window) {
    const obs = new ResizeObserver(maj);
    obs.observe(tdb);
    obs.observe(document.getElementById("map"));
  }
  new MutationObserver(maj).observe(tdb, { attributes: true, attributeFilter: ["hidden"] });
}

function selectionnerLigne(route) {
  if (!(SERVER_META.lignes || []).includes(String(route))) {
    afficherAvisBus(`La ligne ${route} n'existe pas sur la carte : ses segments ont été construits ` +
                    `sur un GTFS antérieur (relancer le pipeline p01–p08).`);
    return;
  }
  lineChoices.removeActiveItems();
  lineChoices.setChoiceByValue(String(route));
  document.getElementById("lineSelect").dispatchEvent(new Event("change"));
}

function majTableauDeBord(data, filtre, nPerimetre, maintenant) {
  construireTuilesTdb();
  majVisibiliteTdb();
  document.getElementById("tdbPerimetre").textContent =
    !filtre ? "réseau" : filtre.lignes.length === 1 ? `ligne ${filtre.lignes[0]}` : `${filtre.lignes.length} lignes`;

  // Agrégats du périmètre (lignes + directions sélectionnées, sinon réseau) :
  // même calcul que la page « Tableau de bord » plein écran (rt_commun.js)
  const s = data.service;
  const reg = data.regularite;
  const ctx = agregerPerimetre(data, filtre ? new Set(filtre.lignes) : null, filtre ? filtre.garder : null, maintenant);
  ctx.s = s;
  const livraison = ctx.livraison;
  const indiceRegularite = ctx.indice;
  RT.tdbCtx = ctx;
  document.getElementById("tdbHeure").textContent = s ? s.heure : "";

  // Service livré : voyages prévus en cours portés par un bus
  const barre = document.querySelector(".tdb-barre");
  if (s && livraison.prevus) {
    const taux = livraison.vu / livraison.prevus;
    const aConfirmer = livraison.prevus - livraison.vu - livraison.annule - livraison.sans;
    document.getElementById("tdbTaux").textContent = `${Math.round(taux * 100)} %`;
    document.getElementById("tdbTauxDetail").textContent =
      `${livraison.vu} / ${livraison.prevus} voyages en cours ont un bus`;
    document.getElementById("tdbBarre").style.width = `${Math.round(taux * 100)}%`;
    barre.classList.toggle("moyen", taux < 0.95 && taux >= 0.85);
    barre.classList.toggle("faible", taux < 0.85);
    document.getElementById("tdbLivraisonSous").textContent =
      `${livraison.annule} annulé(s) · ${livraison.sans} sans véhicule · ${aConfirmer} à confirmer · ` +
      `${nPerimetre} bus`;
  } else {
    document.getElementById("tdbTaux").textContent = "–";
    document.getElementById("tdbTauxDetail").textContent = s
      ? "aucun voyage prévu en ce moment sur ce périmètre"
      : "horaire indisponible (régénérer le référentiel : scripts/exporter_referentiel_rt.py)";
    document.getElementById("tdbBarre").style.width = "0";
    document.getElementById("tdbLivraisonSous").textContent = `${nPerimetre} bus dans le flux`;
  }

  // Valeurs des tuiles
  const valeurs = {
    sans_vehicule: s ? livraison.sans : null,
    annule: s ? livraison.annule : null,
    lignes_sans: s ? ctx.lignesSans.length : null,
    pires: s ? ctx.pires.length : null,
    trous: reg ? ctx.trous.length : null,
    detours: ctx.detoursValides ? ctx.detoursValides.length : null,
    ...RT.comptesEtats,
  };
  for (const b of document.querySelectorAll("#tdbGrille .tdb-tuile")) {
    const cle = b.dataset.cle;
    if (cle === "regularite") {   // pourcentage : bon au-delà de 80 %
      const i = indiceRegularite;
      b.querySelector(".val").textContent = i == null ? "–" : `${i} %`;
      b.classList.toggle("ok", i != null && i >= 80);
      b.classList.toggle("alerte", i != null && i < 80);
      b.disabled = !reg;
      continue;
    }
    const val = valeurs[cle];
    b.querySelector(".val").textContent = val == null ? "–" : val.toLocaleString("fr-CA");
    b.classList.toggle("ok", val === 0);
    b.classList.toggle("alerte", val > 0);
    b.disabled = val == null;
    if (cle === "annule") {
      b.querySelector(".lib").textContent = s && ctx.aVenir.length
        ? `Voyages annulés (+${ctx.aVenir.length} dans l'heure)` : "Voyages annulés";
    }
  }
  majEtatTuilesTdb();
  rendreDetailTdb();

  const ageFlux = data.t_flux ? maintenant - data.t_flux : null;
  const ref = data.referentiel;
  const info = document.getElementById("tdbInfo");
  info.title =
    (ageFlux != null ? `Flux STM d'il y a ${ageFlux} s` : "Flux STM") +
    (s && !s.annulations_ok ? "\n⚠ Annulations indisponibles (comptées « sans véhicule »)" : "") +
    (ref ? `\nHoraire GTFS ${ref.version}` : "") +
    "\n« Sans véhicule » = voyage en cours depuis ≥ 5 min, jamais vu dans le flux ni annulé." +
    "\n« Annulé » = marqué CANCELED dans tripUpdates (GTFS-RT STM)." +
    "\nRégularité : bus ordonnés le long du tracé de leur ligne/direction ; écart (converti en minutes " +
    "par la vitesse prévue) ÷ intervalle prévu : < 0,25 = bus bunching, > 2 = gap de service. " +
    "Un vide en bout de ligne (sans bus devant) n'est pas détecté ; bus aux terminus exclus. " +
    "Un détour validé remplace la portion du tracé qu'il contourne : ses bus sont comptés." +
    "\nDétours : le tracé d'un bus hors de son tracé GTFS est estimé sur le réseau routier routable " +
    "(positions à moins de 40 m d'une rue, reliées par le plus court chemin) ; validé quand ≥ 2 bus " +
    "de la ligne/direction empruntent le même tracé (≥ 50 % de rues en commun).";
  info.setAttribute("aria-label", info.title);
  info.classList.toggle("rt-statut-erreur", !!(s && !s.annulations_ok));
}

function majEtatTuilesTdb() {
  for (const b of document.querySelectorAll("#tdbGrille .tdb-tuile")) {
    const cle = b.dataset.cle;
    const active = RT.filtreEtat === cle || RT.tdbDetail === cle;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  }
}

function rendreDetailTdb() {
  const bloc = document.getElementById("tdbDetail");
  const ctx = RT.tdbCtx;
  bloc.replaceChildren();
  bloc.hidden = !RT.tdbDetail || !ctx || (!ctx.s && RT.tdbDetail !== "detours");
  if (bloc.hidden) return;

  const titre = (texte) => {
    const d = document.createElement("div");
    d.className = "tdb-detail-titre";
    d.textContent = texte;
    bloc.appendChild(d);
  };
  const items = (liste, rendu) => {
    if (!liste.length) {
      const d = document.createElement("div");
      d.className = "tdb-vide";
      d.textContent = "Aucun.";
      bloc.appendChild(d);
      return;
    }
    const colonnes = document.createElement("div");   // liste en colonnes sur la largeur de la barre
    colonnes.className = "tdb-detail-liste";
    for (const x of liste.slice(0, TDB_LISTE_MAX)) {
      const [route, texte, meta, coords] = rendu(x);   // coords : portion à cadrer (gap de service)
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tdb-item";
      b.title = `Sélectionner la ligne ${route} sur la carte` + (coords ? " et cadrer dessus" : "");
      b.innerHTML = `<b>Ligne ${route}</b> ${texte}${meta ? ` <span class="meta">${meta}</span>` : ""}`;
      b.addEventListener("click", () => {
        selectionnerLigne(route);
        if (coords) map.fitBounds(L.latLngBounds(coords).pad(0.25), { maxZoom: 16 });
      });
      colonnes.appendChild(b);
    }
    bloc.appendChild(colonnes);
    if (liste.length > TDB_LISTE_MAX) {
      const d = document.createElement("div");
      d.className = "tdb-vide";
      d.textContent = `… et ${liste.length - TDB_LISTE_MAX} autre(s)`;
      bloc.appendChild(d);
    }
  };
  // voyage : [trip_id, route, direction, destination, début, fin, statut]
  const voyage = v => [v[1], `${v[2] || ""} · ${v[4]} → ${v[5]}`,
                       v[3] && v[3] !== v[2] ? v[3] : ""];

  if (RT.tdbDetail === "sans_vehicule") {
    titre("Voyages prévus en cours sans véhicule");
    items(ctx.voyages.filter(v => v[6] === "sans_vehicule"), voyage);
  } else if (RT.tdbDetail === "annule") {
    titre("Voyages annulés en cours");
    items(ctx.voyages.filter(v => v[6] === "annule"), voyage);
    titre("Annulations dans l'heure");
    items(ctx.aVenir, v => [v[1], `${v[2] || ""} · départ ${v[4]}`, v[3] && v[3] !== v[2] ? v[3] : ""]);
  } else if (RT.tdbDetail === "lignes_sans") {
    titre("Lignes avec service prévu, aucun bus vu");
    items(ctx.lignesSans, ([route, c]) => [route, `· ${c[0] - c[2]} voyage(s) prévu(s) en cours`,
                                           c[2] ? `(+${c[2]} annulé(s))` : ""]);
  } else if (RT.tdbDetail === "regularite") {
    titre("Régularité par ligne (du moins au plus régulier ; ≥ 3 bus placés)");
    items(ctx.lignesReg, l => [l.route, `${l.direction || ""} · ${l.indice} %`,
      `${l.n_bus} bus · intervalle prévu ${fmtMin(l.intervalle_min)}` +
      (l.trains ? ` · bunching ×${l.trains}` : "") + (l.trous ? ` · ${l.trous} gap(s)` : "") +
      (l.detours ? " · ↪ tracé adapté au détour" : "")]);
  } else if (RT.tdbDetail === "trous") {
    titre("Gaps de service (du plus grand au plus petit) — clic : cadrer sur le gap");
    const reg = RT.dernier && RT.dernier.regularite;
    items(ctx.trous, e => [e.route, `${e.direction || ""} · ${fmtMin(e.minutes)} entre 2 bus`,
      `prévu ${fmtMin(reg?.lignes[`${e.route}|${e.direction}`]?.intervalle_min)} · ×${e.rapport.toLocaleString("fr-CA")}`, e.coords]);
  } else if (RT.tdbDetail === "detours") {
    const km = d => (d.longueur_m / 1000).toLocaleString("fr-CA", { maximumFractionDigits: 1 });
    const rendu = d => [d.route, `${d.direction || ""} · ${d.n_bus} bus · ${km(d)} km`,
      `depuis ${hhmm(d.debut)} · dernier passage ${hhmm(d.dernier)}${d.en_cours.length ? ` · en cours (${d.en_cours.join(", ")})` : ""}`, d.coords];
    titre("Détours validés (même tracé hors GTFS emprunté par ≥ 2 bus) — clic : cadrer sur le détour");
    items(ctx.detoursValides || [], rendu);
    titre("Détours potentiels (un seul bus pour l'instant)");
    items((ctx.detours || []).filter(d => !d.valide), rendu);
  } else if (RT.tdbDetail === "pires") {
    titre("Lignes par voyages non livrés");
    items(ctx.pires, ([route, c]) => [route, `· ${c[1]} / ${c[0]} livrés`,
                                      `(${c[2]} annulé(s), ${c[3]} sans véhicule)`]);
  }
}

// ===== Historique des événements du réseau (depuis l'ouverture de la page) =====
// À chaque NOUVEL instantané du flux (t_flux change), on relève les conditions
// présentes (gap de service, bunching, bus hors trajet, figé…) : une condition nouvelle ouvre
// un épisode, une condition encore présente le prolonge, une condition absente
// de HISTO_GRACE instantanés consécutifs le clôt (fin = dernière fois vue). La
// tolérance évite qu'un bus oscillant autour d'un seuil crée un épisode par
// actualisation. Tout reste en mémoire dans l'onglet (rien côté serveur).
// Logique des épisodes (HistoriqueRT, conditionsInstantane…) : rt_commun.js
const HISTO_AFFICHES = 300;       // éléments rendus dans la liste
const HISTO = new HistoriqueRT();
HISTO.types = new Set(Object.keys(HISTO_TYPES));   // types affichés dans la liste

function historiqueActif() {
  const chk = document.getElementById("chkHistorique");
  return !!(chk && chk.checked && !chk.disabled);
}

// Collecte du flux : voulue si la couche est affichée OU si l'historique enregistre.
function majCollecteBus() {
  const voulue = document.getElementById("chkBusTempsReel").checked || historiqueActif();
  // Onglet masqué : seul l'historique justifie de continuer (le navigateur espace alors les appels)
  const suspendue = document.hidden && !historiqueActif();
  if (voulue && !suspendue) { if (!collecteBusActive()) demarrerMinuteurBus(); }
  else arreterMinuteurBus();
}

function enregistrerHistorique(data) { if (HISTO.enregistrer(data)) rendreHistorique(); }
function historiqueErreurFlux(message) { HISTO.erreurFlux(message); rendreHistorique(); }
function historiqueFluxRetabli() { HISTO.fluxRetabli(); }

function episodesFiltres() {
  const lignes = document.getElementById("chkHistoLignes").checked ? SyncBus.getState().visibleLines : null;
  const enCours = document.getElementById("chkHistoEnCours").checked;
  return HISTO.liste.filter(ep =>
    HISTO.types.has(ep.type)
    && (!enCours || (episodeEnCours(ep)))
    && (!lignes || !lignes.size || ep.route == null || lignes.has(String(ep.route))));
}

function construireTypesHistorique() {
  const wrap = document.getElementById("histoTypes");
  for (const [type, def] of Object.entries(HISTO_TYPES)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `histo-type histo-${type}`;
    b.dataset.type = type;
    b.setAttribute("aria-pressed", "true");
    b.title = `Clic : afficher / masquer « ${def.lib} »\nDouble-clic : n'afficher que ce type (re-double-clic : tous)`;
    b.innerHTML = `<span class="histo-ico">${def.icone}</span>${def.lib}<span class="n">0</span>`;
    b.addEventListener("click", () => {
      if (HISTO.types.has(type)) HISTO.types.delete(type); else HISTO.types.add(type);
      majPastillesHistorique();
      rendreHistorique();
    });
    // Les deux clics du double-clic se sont annulés : on part de l'état d'avant
    b.addEventListener("dblclick", () => {
      const seul = HISTO.types.size === 1 && HISTO.types.has(type);
      HISTO.types.clear();
      for (const t of (seul ? Object.keys(HISTO_TYPES) : [type])) HISTO.types.add(t);
      majPastillesHistorique();
      rendreHistorique();
    });
    wrap.appendChild(b);
  }
}

function majPastillesHistorique() {
  for (const b of document.querySelectorAll("#histoTypes .histo-type")) {
    b.setAttribute("aria-pressed", String(HISTO.types.has(b.dataset.type)));
  }
}

function rendreHistorique() {
  const liste = document.getElementById("histoListe");
  if (!liste) return;
  const tRef = HISTO.tRef || Math.floor(Date.now() / 1000);
  // Compteurs par type (tous les épisodes, en cours entre parenthèses)
  const comptes = {};
  for (const ep of HISTO.liste) {
    const c = comptes[ep.type] || (comptes[ep.type] = [0, 0]);
    c[0]++;
    if (episodeEnCours(ep)) c[1]++;
  }
  for (const b of document.querySelectorAll("#histoTypes .histo-type")) {
    const [n, o] = comptes[b.dataset.type] || [0, 0];
    b.querySelector(".n").textContent = o ? `${n} · ${o} en cours` : String(n);
  }
  const enCours = HISTO.liste.filter(ep => episodeEnCours(ep)).length;
  document.getElementById("histoStatut").textContent = HISTO.dernierFlux
    ? `Depuis ${hhmm(HISTO.ouverture)} · ${HISTO.liste.length} événement(s), ${enCours} en cours · dernier flux ${hhmmss(HISTO.dernierFlux)}`
    : historiqueActif() || document.getElementById("chkBusTempsReel").checked
      ? `Depuis ${hhmm(HISTO.ouverture)} · en attente du flux STM…`
      : "Enregistrement arrêté (cocher « Enregistrer en continu » ou afficher les bus).";

  // Plus récents d'abord (début, puis dernière observation)
  const eps = episodesFiltres().sort((a, b) => b.debut - a.debut || b.vu - a.vu).slice(0, HISTO_AFFICHES);
  const frag = document.createDocumentFragment();
  for (const ep of eps) {
    const def = HISTO_TYPES[ep.type];
    const enCoursEp = ep.fin == null && !def.ponctuel;
    const b = document.createElement("button");
    b.type = "button";
    b.className = `histo-item histo-${ep.type}${enCoursEp ? " en-cours" : ""}`;
    const quand = ep.debutConnu ? hhmm(ep.debut) : `≤ ${hhmm(ep.debut)}`;
    const duree = dureeEpisode(ep, tRef);
    const ligne = ep.route != null ? `Ligne ${ep.route}${ep.direction ? " " + ep.direction : ""}` : "Réseau";
    b.innerHTML = `<span class="histo-ico">${def.icone}</span>` +
      `<span class="histo-corps"><b>${ligne}</b> ${texteEpisode(ep)}<span class="meta">${duree}</span></span>` +
      `<span class="histo-heure">${quand}</span>`;
    b.title = (ep.debutConnu ? "" : "Déjà en cours à l'ouverture de la page (début réel inconnu).\n") +
              (ep.route != null ? "Clic : sélectionner la ligne et cadrer sur l'événement" : "");
    b.addEventListener("click", () => allerEpisode(ep));
    frag.appendChild(b);
  }
  if (!eps.length) {
    const d = document.createElement("div");
    d.className = "tdb-vide";
    d.textContent = HISTO.liste.length ? "Aucun événement pour ces filtres." : "Aucun événement pour l'instant.";
    frag.appendChild(d);
  }
  // Conserver la position de défilement quand la liste est rafraîchie en cours de lecture
  const defil = liste.scrollTop;
  liste.replaceChildren(frag);
  liste.scrollTop = defil;
  majResumesSections();
}

// Clic sur un événement : ligne sélectionnée, couche des bus affichée, puis focus
// sur le(s) bus s'ils sont encore dans le flux, sinon cadrage sur le dernier lieu connu.
function allerEpisode(ep) {
  if (ep.type === "detour_1bus") { retracerDetourPonctuel(ep.detail); return; }   // detours_carte.js
  if (ep.route == null) return;
  const chk = document.getElementById("chkBusTempsReel");
  if (!chk.checked && !chk.disabled) { chk.checked = true; chk.dispatchEvent(new Event("change")); }
  selectionnerLigne(String(ep.route));
  const presents = new Set(RT.dernier ? RT.dernier.vehicules.map(v => v[RT.dernier.champs.indexOf("vehicule_id")]) : []);
  const bus = (ep.bus || []).filter(id => presents.has(id));
  if (ep.fin == null && bus.length) {
    RT.selection = new Set(bus);
    if (RT.dernier) afficherBus(RT.dernier);
    const pts = bus.map(id => RT.marqueurs.get(id)).filter(Boolean).map(m => m.getLatLng());
    if ((ep.type === "trou" || ep.type === "detour") && ep.loc) map.fitBounds(L.latLngBounds(ep.loc).pad(0.25), { maxZoom: 16 });
    else if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 15));
    else recadrerSelectionBus();
  } else if (ep.loc) {
    const pts = Array.isArray(ep.loc[0]) ? ep.loc : [ep.loc];
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 16 });
    else map.setView(pts[0], Math.max(map.getZoom(), 15));
  }
}

function exporterHistorique() {
  const d = new Date();
  telechargerTexte(csvHistorique(HISTO.liste, HISTO.tRef),
                   `historique_reseau_${d.toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`);
}

function initHistorique() {
  construireTypesHistorique();
  document.getElementById("chkHistorique").addEventListener("change", () => { majCollecteBus(); rendreHistorique(); });
  document.getElementById("chkHistoLignes").addEventListener("change", rendreHistorique);
  document.getElementById("chkHistoEnCours").addEventListener("change", rendreHistorique);
  document.getElementById("btnHistoExport").addEventListener("click", exporterHistorique);
  document.getElementById("btnHistoVider").addEventListener("click", () => {
    HISTO.vider();
    rendreHistorique();
  });
  rendreHistorique();
}

// ----- Sélection de bus : focus (clic) et multi-sélection (Ctrl+clic) -----
// Une couleur par tracé distinct ; deux bus sur le même parcours partagent le tracé.
const RT_COULEURS_TRACES = ["#4f9fff", "#ff7043", "#ab47bc", "#26a69a",
                            "#ec407a", "#8d6e63", "#29b6f6", "#c0ca33"];

function styleBus(couleur, choisi, focus) {
  if (choisi) return { radius: 8, color: "#ffffff", weight: 3, opacity: 1, fillColor: couleur, fillOpacity: 1 };
  // Focus : les autres bus s'estompent sans disparaître
  return { radius: 5, color: "#263238", weight: 1, fillColor: couleur,
           opacity: focus ? 0.35 : 1, fillOpacity: focus ? 0.3 : 0.9 };
}

function cliquerBus(id, additif) {
  if (additif) {
    if (RT.selection.has(id)) RT.selection.delete(id); else RT.selection.add(id);
  } else {
    RT.selection.clear();
    RT.selection.add(id);
    const m = RT.marqueurs.get(id);
    if (m) map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
  }
  if (RT.dernier) afficherBus(RT.dernier);
}

function recadrerSelectionBus() {
  const pts = [...RT.selection].map(id => RT.marqueurs.get(id)).filter(Boolean).map(m => m.getLatLng());
  if (pts.length === 1) map.panTo(pts[0]);
  else if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 16 });
}

// Tracé du trajet en cours (mis en cache par trip_id ; un bus qui enchaîne un
// nouveau trajet change de trip_id, donc de tracé, à l'actualisation suivante).
function chargerInfosTrip(trip) {
  RT.infosTrip.set(trip, "chargement");
  fetch(`/api/rt/trace?trip=${encodeURIComponent(trip)}`)
    .then(r => r.json().then(j => (r.ok ? j : { erreur: j.error || `HTTP ${r.status}` })))
    .catch(err => ({ erreur: err.message }))
    .then(info => {
      RT.infosTrip.set(trip, info);
      if (RT.dernier && document.getElementById("chkBusTempsReel").checked) afficherBus(RT.dernier);
    });
}

function dessinerTracesBus(data, idx) {
  const requis = new Map();   // trace_id -> coords
  if (document.getElementById("chkBusTraces").checked) {
    const parId = new Map(data.vehicules.map(v => [v[idx.vehicule_id], v]));
    for (const id of RT.selection) {
      const trip = parId.get(id)?.[idx.trip_id];
      if (!trip) continue;
      const info = RT.infosTrip.get(trip);
      if (info === undefined) { chargerInfosTrip(trip); continue; }
      if (info === "chargement" || info.erreur) continue;
      requis.set(info.trace_id, info.coords);
    }
  }
  for (const [tid, t] of RT.traces) {
    if (!requis.has(tid)) { RT.tracesLayer.removeLayer(t.polyline); RT.traces.delete(tid); }
  }
  for (const [tid, coords] of requis) {
    if (RT.traces.has(tid)) continue;
    const prises = new Set([...RT.traces.values()].map(t => t.couleur));
    const couleur = RT_COULEURS_TRACES.find(c => !prises.has(c))
                 || RT_COULEURS_TRACES[RT.traces.size % RT_COULEURS_TRACES.length];
    const polyline = L.polyline(coords, {
      renderer: RT.rendererTraces, pane: "busTraces", interactive: false,
      color: couleur, weight: 5, opacity: 0.8, lineJoin: "round",
    });
    RT.tracesLayer.addLayer(polyline);
    RT.traces.set(tid, { polyline, couleur });
  }
}

function majSelectionBus(data, idx) {
  const bloc = document.getElementById("rtSelection");
  dessinerTracesBus(data, idx);
  bloc.hidden = RT.selection.size === 0;
  if (bloc.hidden) return;

  document.getElementById("rtSelectionTitre").textContent =
    RT.selection.size === 1 ? "Bus en focus" : `${RT.selection.size} bus sélectionnés`;
  const parId = new Map(data.vehicules.map(v => [v[idx.vehicule_id], v]));
  const liste = document.getElementById("rtSelectionListe");
  liste.innerHTML = "";
  for (const id of RT.selection) {
    const v = parId.get(id);
    if (!v) continue;
    const info = RT.infosTrip.get(v[idx.trip_id]);
    const trace = info && info.trace_id != null ? RT.traces.get(info.trace_id) : null;
    const ecart = v[idx.ecart_trace_m];
    const occupation = (RT_OCCUPATION[v[idx.occupation]] || [null, "Occupation inconnue"])[1];
    const item = document.createElement("button");
    item.type = "button";
    item.className = "rt-bus-item";
    item.title = "Centrer la carte sur ce bus";
    item.innerHTML =
      `<span class="rt-trait" style="background:${trace ? trace.couleur : "transparent"}"></span>` +
      `<span><b>Ligne ${v[idx.route_id]}${v[idx.direction] ? " " + v[idx.direction] : ""}</b> · bus ${id}<br>` +
      `<span class="rt-bus-meta">${occupation}` +
      (ecart != null && ecart > RT_SEUIL_DETOUR_M ? ` · ⚠ ${ecart.toLocaleString("fr-CA")} m du tracé` : "") +
      (info && info.erreur ? " · tracé indisponible" : "") + `</span></span>`;
    item.addEventListener("click", () => {
      const m = RT.marqueurs.get(id);
      if (m) map.setView(m.getLatLng(), Math.max(map.getZoom(), 15));
    });
    liste.appendChild(item);
  }
  if (document.getElementById("chkBusSuivre").checked) recadrerSelectionBus();
}

function setHint(txt) {
  const el = document.getElementById("hintText");
  if (el && txt) el.dataset.prev = el.dataset.prev || el.textContent;
  if (el) el.textContent = txt || el.dataset.prev || "";
}

// ===== Outil de création de trajet (overlay, réseau routier réel) =====
function ouvrirOutilTrajet() {
  document.getElementById("trajet-overlay").classList.add("visible");
  if (!Trajet.map) {
    Trajet.map = L.map("trajetMap", {
      center: map.getCenter(), zoom: Math.max(map.getZoom(), 12),
      maxZoom: 19, zoomControl: true, preferCanvas: true,
    });
    ajouterFondDeCarte(Trajet.map);
    Trajet.map.on("click", (e) => ajouterJalon(e.latlng));
  }
  // On repart d'un trajet vierge à chaque ouverture (le bouton de l'outil
  // n'est PAS une reprise d'édition ; « Modifier » recharge, lui, ses jalons).
  effacerTrajet();
  // La div vient d'être affichée : recadrer après le layout
  setTimeout(() => Trajet.map.invalidateSize(), 60);
}

function fermerOutilTrajet() {
  document.getElementById("trajet-overlay").classList.remove("visible");
}

// ===== Sections repliables de l'outil (Lignes créées / Jalons / Paramètres) =====
function setupTrajetFolds() {
  document.querySelectorAll("#trajet-overlay .fold-header").forEach(h => {
    h.addEventListener("click", () => {
      h.closest(".fold-section")?.classList.toggle("collapsed");
    });
  });
}

// Replie (collapsed=true) ou déplie une section nommée par son data-fold.
function setFoldCollapsed(name, collapsed) {
  const sec = document.querySelector(`#trajet-overlay .fold-section[data-fold="${name}"]`);
  if (sec) sec.classList.toggle("collapsed", collapsed);
}

function ajouterJalon(latlng, nom = null, recalc = true, index = null) {
  const lat = (latlng && latlng.lat !== undefined) ? latlng.lat : latlng[0];
  const lon = (latlng && latlng.lng !== undefined) ? latlng.lng : latlng[1];
  const marker = L.marker([lat, lon], { draggable: true });
  marker.bindTooltip("", { direction: "top" });
  const jalon = { lat, lon, nom, marker, vias: [] };
  marker.on("dragend", () => {
    const ll = marker.getLatLng();
    jalon.lat = ll.lat; jalon.lon = ll.lng;
    jalon.nom = null;   // déplacé à la main : plus accroché à un arrêt
    renderJalonsList();
    recalculerTrajet();
  });
  marker.on("contextmenu", () => supprimerJalon(Trajet.jalons.indexOf(jalon)));
  marker.addTo(Trajet.map);
  // index != null : insertion (re-routage d'un tronçon) ; sinon ajout en fin.
  if (index != null && index >= 0 && index <= Trajet.jalons.length) {
    Trajet.jalons.splice(index, 0, jalon);
  } else {
    Trajet.jalons.push(jalon);
  }
  renderJalonsList();
  if (recalc) recalculerTrajet();
  return jalon;
}

function supprimerJalon(i) {
  if (i < 0 || i >= Trajet.jalons.length) return;
  const jal = Trajet.jalons[i];
  Trajet.map.removeLayer(jal.marker);
  for (const v of (jal.vias || [])) if (v.marker) Trajet.map.removeLayer(v.marker);
  Trajet.jalons.splice(i, 1);
  elaguerViasFinales();
  renderJalonsList();
  recalculerTrajet();
}

function deplacerJalon(i, delta) {
  const j = i + delta;
  if (i < 0 || j < 0 || j >= Trajet.jalons.length) return;
  [Trajet.jalons[i], Trajet.jalons[j]] = [Trajet.jalons[j], Trajet.jalons[i]];
  elaguerViasFinales();
  renderJalonsList();
  recalculerTrajet();
}

// Les vias (points de tracé) du DERNIER arrêt ne forment aucun tronçon :
// on les retire pour ne pas laisser de poignée orpheline après suppression/réordre.
function elaguerViasFinales() {
  if (!Trajet.jalons.length) return;
  const last = Trajet.jalons[Trajet.jalons.length - 1];
  if (last.vias && last.vias.length) {
    for (const v of last.vias) if (v.marker && Trajet.map) Trajet.map.removeLayer(v.marker);
    last.vias = [];
  }
}

// ===== Points de tracé « via » (dévient l'itinéraire SANS créer d'arrêt) =====
// Un via appartient au tronçon situé après l'arrêt d'index `jalonIndex`.
function ajouterVia(jalonIndex, lat, lon, recalc = true) {
  const jalon = Trajet.jalons[jalonIndex];
  if (!jalon) return null;
  if (!jalon.vias) jalon.vias = [];
  const marker = L.marker([lat, lon], {
    draggable: true,
    icon: L.divIcon({ className: "via-handle", html: "", iconSize: [14, 14], iconAnchor: [7, 7] }),
    zIndexOffset: 1200,
  });
  marker.bindTooltip("Point de tracé — glissez pour dévier l'itinéraire, clic droit pour retirer",
                     { direction: "top", offset: [0, -8] });
  const via = { lat, lon, marker };
  marker.on("dragend", () => {
    const ll = marker.getLatLng();
    via.lat = ll.lat; via.lon = ll.lng;
    recalculerTrajet();
  });
  marker.on("contextmenu", (e) => {
    if (e.originalEvent) e.originalEvent.preventDefault();
    L.DomEvent.stopPropagation(e);
    supprimerVia(via);
  });
  marker.addTo(Trajet.map);
  jalon.vias.push(via);
  if (recalc) recalculerTrajet();
  return via;
}

function supprimerVia(via) {
  for (const j of Trajet.jalons) {
    const k = (j.vias || []).indexOf(via);
    if (k >= 0) { j.vias.splice(k, 1); break; }
  }
  if (via.marker && Trajet.map) Trajet.map.removeLayer(via.marker);
  recalculerTrajet();
}

// Séquence de points pour le routage : arrêts + vias intercalés, avec drapeaux
// (1 = arrêt, 0 = via). Les vias du dernier arrêt sont ignorés (aucun tronçon).
function sequencePoints() {
  const pts = [], flags = [];
  const n = Trajet.jalons.length;
  Trajet.jalons.forEach((j, idx) => {
    pts.push(`${j.lat.toFixed(6)},${j.lon.toFixed(6)}`); flags.push("1");
    if (idx < n - 1) {
      for (const v of (j.vias || [])) {
        pts.push(`${v.lat.toFixed(6)},${v.lon.toFixed(6)}`); flags.push("0");
      }
    }
  });
  return { points: pts.join(";"), stops: flags.join(",") };
}

function renderJalonsList() {
  effacerSuggestionsArrets();   // les marqueurs candidats deviennent obsolètes au rebuild
  const wrap = document.getElementById("trajetJalonsList");
  wrap.innerHTML = "";
  if (!Trajet.jalons.length) {
    wrap.innerHTML = '<div class="instructions">Aucun jalon — cliquez sur la carte.</div>';
    return;
  }
  Trajet.jalons.forEach((jalon, i) => {
    jalon.marker.setTooltipContent(`Jalon ${i + 1}${jalon.nom ? " — " + jalon.nom : ""}`);
    const item = document.createElement("div");
    item.className = "jalon-item";
    const nom = jalon.nom || `${jalon.lat.toFixed(5)}, ${jalon.lon.toFixed(5)}`;
    item.innerHTML = `
      <div class="jalon-row">
        <span class="jalon-nom"><span class="num">${i + 1}.</span> ${nom}</span>
        <button data-act="up"   title="Monter dans l'ordre"    ${i === 0 ? "disabled" : ""}>▲</button>
        <button data-act="down" title="Descendre dans l'ordre" ${i === Trajet.jalons.length - 1 ? "disabled" : ""}>▼</button>
        <button data-act="snap" title="Arrêts existants les plus proches">📍</button>
        <button data-act="del"  title="Supprimer le jalon">✕</button>
      </div>`;
    item.querySelector('[data-act="up"]').addEventListener("click", () => deplacerJalon(i, -1));
    item.querySelector('[data-act="down"]').addEventListener("click", () => deplacerJalon(i, +1));
    item.querySelector('[data-act="del"]').addEventListener("click", () => supprimerJalon(i));
    item.querySelector('[data-act="snap"]').addEventListener("click", () => toggleSuggestionsArrets(item, i));
    wrap.appendChild(item);
  });
}

// Arrêts GTFS les plus proches d'un point (distance équirectangulaire, ~m)
function arretsProches(lat, lon, n = 5) {
  if (!Array.isArray(DataLoader.stops) || !DataLoader.stops.length) return [];
  const coslat = Math.cos(lat * Math.PI / 180);
  return DataLoader.stops
    .map(s => {
      const dx = (s.lon - lon) * coslat, dy = s.lat - lat;
      return { s, d: Math.sqrt(dx * dx + dy * dy) * 111320 };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, n);
}

// Affiche les arrêts GTFS les plus proches d'un jalon comme marqueurs CLIQUABLES
// sur la carte de l'outil. Re-cliquer sur 📍 (ou « Garder le point libre ») annule
// sans accrocher : on n'est jamais forcé de choisir un arrêt.
function toggleSuggestionsArrets(item, i) {
  if (Trajet.suggestionJalon === i) { effacerSuggestionsArrets(); return; }
  effacerSuggestionsArrets();

  const jalon = Trajet.jalons[i];
  const proches = arretsProches(jalon.lat, jalon.lon, 6);

  const div = document.createElement("div");
  div.className = "jalon-suggestions";
  if (!proches.length) {
    div.innerHTML = '<div class="instructions">Aucun arrêt connu (stops.txt absent ?).</div>';
    item.appendChild(div);
    Trajet.suggestionJalon = i;
    return;
  }

  if (!Trajet.suggestionMarkers) Trajet.suggestionMarkers = L.layerGroup().addTo(Trajet.map);
  const bounds = L.latLngBounds([[jalon.lat, jalon.lon]]);
  for (const { s, d } of proches) {
    const m = L.marker([s.lat, s.lon], {
      icon: L.divIcon({ className: "stop-candidate-icon", html: "🚏",
                        iconSize: [22, 22], iconAnchor: [11, 11] }),
      zIndexOffset: 1500,
    });
    m.bindTooltip(`${s.stop_name || "Arrêt"} (${s.stop_code}) · ${Math.round(d)} m — cliquer pour accrocher`,
                  { direction: "top", offset: [0, -6] });
    m.on("click", () => {
      jalon.lat = s.lat; jalon.lon = s.lon;
      jalon.nom = `${s.stop_name || "Arrêt"} (${s.stop_code})`;
      jalon.marker.setLatLng([s.lat, s.lon]);
      effacerSuggestionsArrets();
      renderJalonsList();
      recalculerTrajet();
    });
    Trajet.suggestionMarkers.addLayer(m);
    bounds.extend([s.lat, s.lon]);
  }
  Trajet.suggestionJalon = i;

  div.innerHTML =
    `<div class="instructions">${proches.length} arrêt(s) proche(s) affiché(s) sur la carte — ` +
    `cliquez-en un pour y accrocher le jalon.</div>` +
    `<div class="suggestion-cancel">✕ Garder le point libre</div>`;
  div.querySelector(".suggestion-cancel").addEventListener("click", () => effacerSuggestionsArrets());
  item.appendChild(div);

  if (bounds.isValid()) Trajet.map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
}

// Retire les marqueurs candidats de la carte et le panneau de suggestions.
function effacerSuggestionsArrets() {
  if (Trajet.suggestionMarkers) Trajet.suggestionMarkers.clearLayers();
  Trajet.suggestionJalon = null;
  document.querySelectorAll("#trajetJalonsList .jalon-suggestions").forEach(el => el.remove());
}

async function recalculerTrajet() {
  const resume = document.getElementById("trajetResume");
  const exportMsg = document.getElementById("trajetExportMsg");
  if (exportMsg) exportMsg.style.display = "none";
  Trajet.dernier = null;
  if (Trajet.legsLayer) Trajet.legsLayer.clearLayers();
  if (Trajet.jalons.length < 2) {
    resume.style.display = Trajet.jalons.length ? "" : "none";
    resume.textContent = Trajet.jalons.length ? "Ajoutez un second jalon…" : "";
    return;
  }
  if (Trajet.enCours) { Trajet.relance = true; return; }
  Trajet.enCours = true;
  resume.style.display = "";
  resume.textContent = "Calcul de l'itinéraire…";

  const seq = sequencePoints();
  const charge = document.getElementById("trajetCharge").value || "20";
  const mois = document.getElementById("trajetMois").value || "";
  try {
    const res = await fetch(`/api/trajet/estimation?points=${seq.points}&stops=${seq.stops}&charge=${charge}&mois=${mois}`);
    const data = await res.json();
    if (!res.ok || data.error) {
      resume.innerHTML = `⚠️ ${data.error || "Erreur de calcul du trajet."}<br>` +
        `Déplacez, réordonnez ou supprimez un jalon pour réessayer.`;
      return;
    }
    Trajet.dernier = data;
    if (!Trajet.legsLayer) Trajet.legsLayer = L.layerGroup().addTo(Trajet.map);
    dessinerLegs(Trajet.legsLayer, data.legs, data.coords, {
      tooltip: true, jalonMarkers: true, reroutable: true, titre: "Trajet",
      total: { distance_m: data.distance_m, temps_estime_s: data.temps_estime_s, energie: data.energie },
    });

    const e = data.energie || {};
    const km = (data.distance_m / 1000).toFixed(2);
    const minutes = Math.round(data.temps_estime_s / 60);
    resume.innerHTML =
      `<b>Trajet routé (${Trajet.jalons.length} jalons, ${data.n_aretes} arêtes)</b><br>` +
      `Distance : <b>${km} km</b> · Temps estimé : <b>${minutes} min</b><br>` +
      `Température : ${data.temperature_C} °C · ${data.charge_passagers} passagers<br>` +
      `Énergie totale : <b>${((e.totale_Wh || 0) / 1000).toFixed(2)} kWh</b> ` +
      `(<b>${e.kwh_per_km ?? "—"} kWh/km</b>)<br>` +
      `— traction : ${((e.traction_Wh || 0) / 1000).toFixed(2)} kWh · ` +
      `chauffage/clim : ${((e.chauffage_Wh || 0) / 1000).toFixed(2)} kWh · ` +
      `aux. base : ${((e.auxiliaires_Wh || 0) / 1000).toFixed(2)} kWh`;
  } catch (err) {
    resume.innerHTML = "⚠️ Erreur réseau pendant le calcul du trajet.";
  } finally {
    Trajet.enCours = false;
    if (Trajet.relance) {   // l'état a changé pendant la requête : recalculer
      Trajet.relance = false;
      recalculerTrajet();
    }
  }
}

function effacerTrajet() {
  effacerSuggestionsArrets();
  fermerMenuReroute();
  if (Trajet.map) {
    for (const j of Trajet.jalons) {
      Trajet.map.removeLayer(j.marker);
      for (const v of (j.vias || [])) if (v.marker) Trajet.map.removeLayer(v.marker);
    }
    if (Trajet.legsLayer) Trajet.legsLayer.clearLayers();
  }
  Trajet.jalons = [];
  Trajet.dernier = null;
  Trajet.editId = null;              // « Effacer » annule aussi une modification en cours
  const nomInput = document.getElementById("trajetNom");
  if (nomInput) nomInput.value = "";
  renderJalonsList();
  updateExportButtonLabel();
  renderLignesPersoManager();
  const resume = document.getElementById("trajetResume");
  resume.style.display = "none";
  resume.textContent = "";
  document.getElementById("trajetExportMsg").style.display = "none";
}

// Dessine une liste de tronçons (legs) colorés dans un layerGroup Leaflet.
// Repli monochrome si `legs` absent (anciennes lignes stockées sans découpage).
function dessinerLegs(layer, legs, coordsFallback, opts = {}) {
  layer.clearLayers();
  const bounds = L.latLngBounds([]);
  const parts = (Array.isArray(legs) && legs.length)
    ? legs
    : (coordsFallback ? [{ coords: coordsFallback }] : []);
  parts.forEach((leg, i) => {
    if (!Array.isArray(leg.coords) || leg.coords.length < 2) return;
    const color = PERSO_LINE_COLOR;
    const pl = L.polyline(leg.coords, { color, weight: 5, opacity: 0.9, lineCap: "round" });
    if (opts.tooltip) {
      pl.bindTooltip(legTooltipHtml(opts.titre || "Trajet", i, parts.length, leg, opts.total),
                     { sticky: true });
    }
    if (opts.reroutable) {
      pl.on("contextmenu", (evt) => {
        if (evt.originalEvent) evt.originalEvent.preventDefault();
        L.DomEvent.stopPropagation(evt);
        ouvrirMenuReroute(evt, i);
      });
    }
    layer.addLayer(pl);
    for (const c of leg.coords) bounds.extend(c);
  });
  if (opts.jalonMarkers && parts.length) {
    const bornes = [];
    if (parts[0].coords && parts[0].coords.length) bornes.push(parts[0].coords[0]);
    for (const leg of parts) {
      if (leg.coords && leg.coords.length) bornes.push(leg.coords[leg.coords.length - 1]);
    }
    for (const pt of bornes) {
      layer.addLayer(L.circleMarker(pt, {
        radius: 5, color: "#fff", weight: 2, fillColor: "#1a1f3a", fillOpacity: 1,
      }));
    }
  }
  return bounds;
}

// Tooltip d'un tronçon : détail DU tronçon survolé ET total de la ligne, avec
// les 4 grandeurs demandées (distance, temps, énergie, consommation au km).
function legTooltipHtml(titre, i, n, leg, total) {
  const bloc = (o) => {
    const km  = ((o.distance_m || 0) / 1000).toFixed(2);
    const min = Math.round((o.temps_estime_s || 0) / 60);
    const e   = o.energie || {};
    const kwh = ((e.totale_Wh || 0) / 1000).toFixed(2);
    const perkm = (e.kwh_per_km != null) ? e.kwh_per_km
                : (o.distance_m ? ((e.totale_Wh || 0) / o.distance_m).toFixed(3) : "—");
    return `${km} km · ${min} min · ${kwh} kWh · ${perkm} kWh/km`;
  };
  const multi = n > 1;
  const legHasData = leg && leg.distance_m != null;
  let html = `<b>${titre}</b>`;
  if (multi) html += ` — tronçon ${i + 1}/${n}`;
  if (multi && legHasData)
    html += `<br><span style="color:#ffd54f;">Tronçon</span> : ${bloc(leg)}`;
  if (total)
    html += `<br><span style="color:#4f9fff;">Ligne totale</span> : ${bloc(total)}`;
  else if (legHasData)
    html += `<br>${bloc(leg)}`;
  return html;
}

// ===== Re-routage d'un tronçon (clic droit → « Déplacer ce tronçon ») =====
// Le clic molette/pan reste inchangé : on ajoute juste une entrée au clic droit.
function ouvrirMenuReroute(evt, legIndex) {
  fermerMenuReroute();
  const menu = document.createElement("div");
  menu.className = "reroute-menu";
  menu.innerHTML = `<button type="button">↔ Déplacer ce tronçon</button>`;
  const oe = evt.originalEvent || {};
  menu.style.left = ((oe.clientX || 0) + 2) + "px";
  menu.style.top  = ((oe.clientY || 0) + 2) + "px";
  document.body.appendChild(menu);
  Trajet.rerouteMenu = menu;
  menu.querySelector("button").addEventListener("click", (ev) => {
    ev.stopPropagation();
    demarrerReroute(legIndex, evt.latlng);
  });
  // Refermer le menu au prochain clic ailleurs ou dès qu'on déplace la carte.
  setTimeout(() => {
    document.addEventListener("click", fermerMenuReroute, { once: true });
    if (Trajet.map) Trajet.map.once("movestart", fermerMenuReroute);
  }, 0);
}

function fermerMenuReroute() {
  if (Trajet.rerouteMenu) { Trajet.rerouteMenu.remove(); Trajet.rerouteMenu = null; }
}

// Ajoute un point de tracé « via » sur le tronçon : en le glissant sur une autre
// voie, l'itinéraire est dévié SANS créer d'arrêt ni couper le tronçon. C'est
// l'édition « sur quelle route passe la ligne » demandée, sans nouveau stop.
function demarrerReroute(legIndex, latlng) {
  fermerMenuReroute();
  const via = ajouterVia(legIndex, latlng.lat, latlng.lng);
  if (via && via.marker) via.marker.openTooltip();
}

// Libellé + tooltip du bouton d'export selon l'état (création vs modification).
function updateExportButtonLabel() {
  const btn = document.getElementById("btnTrajetExport");
  if (!btn) return;
  if (Trajet.editId) {
    btn.textContent = "💾 Enregistrer les modifications";
    btn.title = "Met à jour la ligne en cours de modification (remplace l'entrée). « Effacer le trajet » annule.";
  } else {
    btn.textContent = "💾 Exporter la ligne";
    btn.title = "Enregistre le trajet comme nouvelle ligne, sélectionnable dans « Lignes ».";
  }
}

// ===== Lignes personnalisées (trajets exportés, persistés en localStorage) =====
const CLE_LIGNES_PERSO = "lignes_perso_v1";
let persoLayer = null;   // L.layerGroup, initialisé au démarrage

function chargerLignesPerso() {
  try { return JSON.parse(localStorage.getItem(CLE_LIGNES_PERSO)) || []; }
  catch (e) { return []; }
}

function sauverLignesPerso(lignes) {
  try { localStorage.setItem(CLE_LIGNES_PERSO, JSON.stringify(lignes)); }
  catch (e) { alert("Impossible d'enregistrer la ligne (localStorage plein ?)."); }
}

// (Re)construit les options du sélecteur de lignes (Choices) : lignes GTFS +
// puces « ★ Lignes créées » (perso), en conservant la sélection courante.
function refreshLignesPersoOptions() {
  if (!lineChoices) return;
  const lineSelect = document.getElementById("lineSelect");
  const selGtfs  = new Set(Array.from(lineSelect.selectedOptions)
                                .map(o => o.value).filter(v => !v.startsWith("perso:")));
  const selPerso = new Set(Array.from(lineSelect.selectedOptions)
                                .map(o => o.value).filter(v => v.startsWith("perso:")));
  const list = SERVER_META.lignes.map(l => ({
    value: l, label: "Ligne " + l, selected: selGtfs.has(l),
  }));
  for (const l of chargerLignesPerso()) {
    list.push({ value: l.id, label: "★ " + l.nom, selected: selPerso.has(l.id) });
  }
  withSelectorGuard(() => {
    lineChoices.clearStore();
    lineChoices.setChoices(list, "value", "label", true);
  });
}

// Affiche sur la carte principale les lignes personnalisées sélectionnées,
// découpées en tronçons (legs) — même logique visuelle que les vrais segments.
function renderLignesPerso() {
  if (!persoLayer) return;
  persoLayer.clearLayers();
  const lineSelect = document.getElementById("lineSelect");
  const ids = new Set(Array.from(lineSelect.selectedOptions)
                           .map(o => o.value).filter(v => v.startsWith("perso:")));
  if (!ids.size) return;
  const bounds = L.latLngBounds([]);
  for (const l of chargerLignesPerso()) {
    if (!ids.has(l.id)) continue;
    const e = l.energie || {};
    const total = { distance_m: l.distance_m, temps_estime_s: l.temps_estime_s, energie: e };
    const parts = (Array.isArray(l.legs) && l.legs.length) ? l.legs : [{ coords: l.coords }];
    parts.forEach((leg, i) => {
      if (!Array.isArray(leg.coords) || leg.coords.length < 2) return;
      const color = PERSO_LINE_COLOR;
      const pl = L.polyline(leg.coords, { color, weight: 5, opacity: 0.9, lineCap: "round" });
      // Hover : détail du tronçon ET total de la ligne (les deux infos).
      pl.bindTooltip(legTooltipHtml("★ " + l.nom, i, parts.length, leg, total), { sticky: true });
      // Clic : fiche physique du tronçon dans « Statistiques » (comme un segment).
      pl.on("click", (evt) => {
        L.DomEvent.stopPropagation(evt);
        showPersoLegInfo(l.nom, i, parts.length, leg);
      });
      persoLayer.addLayer(pl);
      for (const c of leg.coords) bounds.extend(c);
    });
    // Marqueurs de bornes = jalons (points de découpage)
    for (const j of (l.jalons || [])) {
      persoLayer.addLayer(L.circleMarker([j.lat, j.lon], {
        radius: 4, color: "#fff", weight: 2, fillColor: "#1a1f3a", fillOpacity: 1,
      }));
    }
  }
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
}

// ===== Gestion des lignes créées (liste dans l'outil : supprimer / modifier) =====
function renderLignesPersoManager() {
  const wrap = document.getElementById("lignesPersoManager");
  if (!wrap) return;
  const lignes = chargerLignesPerso();
  if (!lignes.length) {
    wrap.innerHTML = '<div class="instructions">Aucune ligne créée pour l\'instant.</div>';
    return;
  }
  wrap.innerHTML = "";
  for (const l of lignes) {
    const e = l.energie || {};
    const km = ((l.distance_m || 0) / 1000).toFixed(2);
    const kwh = ((e.totale_Wh || 0) / 1000).toFixed(2);
    const nJalons = (l.jalons || []).length;
    const item = document.createElement("div");
    item.className = "perso-item" + (Trajet.editId === l.id ? " is-editing" : "");
    item.innerHTML = `
      <div class="perso-row">
        <span class="perso-nom">★ ${l.nom}</span>
        <button data-act="edit" title="Modifier ce trajet">✏️</button>
        <button data-act="del" class="danger" title="Supprimer cette ligne">🗑</button>
      </div>
      <div class="perso-stats">${km} km · ${nJalons} jalon(s) · ${kwh} kWh</div>`;
    item.querySelector('[data-act="edit"]').addEventListener("click", () => modifierLignePerso(l.id));
    item.querySelector('[data-act="del"]').addEventListener("click", () => supprimerLignePerso(l.id));
    wrap.appendChild(item);
  }
}

function supprimerLignePerso(id) {
  const restantes = chargerLignesPerso().filter(l => l.id !== id);
  sauverLignesPerso(restantes);
  if (Trajet.editId === id) { Trajet.editId = null; updateExportButtonLabel(); }
  refreshLignesPersoOptions();
  renderLignesPersoManager();
  renderLignesPerso();
}

// Recharge les jalons d'une ligne créée dans l'éditeur pour la modifier.
async function modifierLignePerso(id) {
  const ligne = chargerLignesPerso().find(l => l.id === id);
  if (!ligne) return;
  effacerTrajet();                 // remet l'éditeur à zéro (reset editId inclus)
  Trajet.editId = id;
  document.getElementById("trajetNom").value = ligne.nom || "";
  const stops = ligne.jalons || [];
  for (const j of stops) {
    ajouterJalon(L.latLng(j.lat, j.lon), j.nom || null, /*recalc=*/false);
  }
  stops.forEach((j, idx) => {          // recréer les vias (points de tracé) de chaque arrêt
    for (const v of (j.vias || [])) ajouterVia(idx, v.lat, v.lon, /*recalc=*/false);
  });
  setFoldCollapsed("jalons", false);   // s'assurer que la liste des jalons est visible
  updateExportButtonLabel();
  renderLignesPersoManager();
  if (Trajet.map && (ligne.jalons || []).length) {
    const b = L.latLngBounds(ligne.jalons.map(j => [j.lat, j.lon]));
    if (b.isValid()) Trajet.map.fitBounds(b, { padding: [40, 40], maxZoom: 15 });
  }
  // Recalcul attendu : Trajet.dernier est prêt (route tracée) avant tout export.
  await recalculerTrajet();
}

async function exporterLignePerso() {
  const msg = document.getElementById("trajetExportMsg");
  msg.style.display = "";
  const invalide = () => !Trajet.dernier || !Array.isArray(Trajet.dernier.coords)
                         || Trajet.dernier.coords.length < 2;
  // Trajet pas encore estimé mais assez de jalons (ex. juste après « Modifier ») :
  // on (re)calcule d'abord pour ne pas refuser l'export à tort.
  if (invalide() && Trajet.jalons.length >= 2) {
    msg.textContent = "Calcul de l'itinéraire…";
    await recalculerTrajet();
  }
  if (invalide()) {
    msg.textContent = "⚠️ Tracez d'abord un trajet valide (au moins 2 jalons reliés).";
    return;
  }
  // S'assurer que chaque tronçon porte ses attributs physiques (calculés côté
  // serveur). Si absents (trajet issu d'un ancien calcul), on relance l'estimation.
  const legsPrets = Array.isArray(Trajet.dernier.legs) && Trajet.dernier.legs.length
    && Trajet.dernier.legs.every(l => l.attributs && Object.keys(l.attributs).length);
  if (!legsPrets && Trajet.jalons.length >= 2) {
    msg.textContent = "🧮 Calcul des statistiques des tronçons de la nouvelle ligne…";
    await recalculerTrajet();
  }
  let nom = document.getElementById("trajetNom").value.trim();
  if (!nom) nom = `Trajet du ${new Date().toLocaleDateString("fr-CA")}`;
  const lignes = chargerLignesPerso();
  const enEdition = Trajet.editId && lignes.some(l => l.id === Trajet.editId);
  const ligne = {
    id: enEdition ? Trajet.editId : "perso:" + Date.now(),
    nom,
    coords: Trajet.dernier.coords,
    legs: Trajet.dernier.legs || null,
    distance_m: Trajet.dernier.distance_m,
    temps_estime_s: Trajet.dernier.temps_estime_s,
    energie: Trajet.dernier.energie || {},
    charge_passagers: Trajet.dernier.charge_passagers,
    temperature_C: Trajet.dernier.temperature_C,
    jalons: Trajet.jalons.map(j => ({
      lat: j.lat, lon: j.lon, nom: j.nom,
      vias: (j.vias || []).map(v => ({ lat: v.lat, lon: v.lon })),
    })),
  };
  if (enEdition) {
    lignes[lignes.findIndex(l => l.id === Trajet.editId)] = ligne;
  } else {
    lignes.push(ligne);
  }
  sauverLignesPerso(lignes);
  Trajet.editId = null;
  updateExportButtonLabel();
  refreshLignesPersoOptions();
  renderLignesPersoManager();

  // Sélectionner la ligne dans le sélecteur et l'afficher immédiatement
  withSelectorGuard(() => { lineChoices.setChoiceByValue(ligne.id); });
  renderLignesPerso();

  msg.innerHTML = enEdition
    ? `✅ Ligne « <b>${nom}</b> » mise à jour.`
    : `✅ Ligne « <b>${nom}</b> » exportée — sélectionnable dans « Lignes » (puces ★).`;
}

// ===== Tracé de voyage + bus animé (messages des pages conso/simulation) =====
let voyageTraceLayer = null;   // L.layerGroup, initialisé au démarrage
let busMarker = null;
const VoyageTrace = { voyage: null, chargement: null };

// Les identifiants de la conso sont ceux du jeu NORMAL. En mode fusion, les mêmes
// entiers désignent d'autres nœuds (97 % des ids diffèrent de leur nœud fusionné) :
// il faut traduire via la liaison, sinon on tracerait la mauvaise géométrie.
let indexFusionInverse = null;   // seg_id d'origine -> merged_id (construit à la demande)

function indexInverseFusion() {
  if (indexFusionInverse) return indexFusionInverse;
  const idx = new Map();
  for (const [mergedId, info] of DataLoader.liaison) {
    for (const s of (info.segments || [])) idx.set(Number(s.seg_id), Number(mergedId));
  }
  indexFusionInverse = idx;
  return idx;
}

function segmentAffichable(consoSegId) {
  const sid = Number(consoSegId);
  if (DataLoader.mode !== "fusion") return DataLoader.segmentById?.get(sid) || null;
  const mergedId = indexInverseFusion().get(sid);
  return (mergedId != null) ? (DataLoader.segmentById?.get(mergedId) || null) : null;
}

async function tracerVoyageSurCarte(voyageId, fit = true) {
  if (voyageId == null || !voyageTraceLayer) return;
  voyageId = Number(voyageId);
  if (VoyageTrace.voyage === voyageId || VoyageTrace.chargement === voyageId) return;
  VoyageTrace.chargement = voyageId;
  try {
    const res = await fetch(`/api/conso/profil?mode=voyage&voyage=${voyageId}`);
    if (!res.ok) return;
    const data = await res.json();
    const segIds = (data.segments || []).map(s => s.segment_id);
    if (!segIds.length) return;
    voyageTraceLayer.clearLayers();
    VoyageTrace.voyage = voyageId;
    const bounds = L.latLngBounds([]);
    let nTrouves = 0;
    const vus = new Set();
    for (const sid of segIds) {
      const seg = segmentAffichable(sid);
      if (!seg) continue;
      nTrouves++;
      if (vus.has(seg.id)) continue;   // fusion : plusieurs segments -> un même nœud
      vus.add(seg.id);
      const parts = seg.is_multi ? seg.coords : [seg.coords];
      for (const part of parts) {
        voyageTraceLayer.addLayer(L.polyline(part, {
          color: "#ab47bc", weight: 5, opacity: 0.85,
          lineCap: "round", interactive: false,
        }));
        for (const c of part) bounds.extend(c);
      }
    }
    afficherBanniereVoyage(voyageId, nTrouves, segIds.length);
    if (fit && bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  } finally {
    VoyageTrace.chargement = null;
  }
}

function afficherBanniereVoyage(voyageId, nTrouves, nTotal) {
  document.getElementById("voyage-trace-banner")?.remove();
  const b = document.createElement("div");
  b.id = "voyage-trace-banner";
  const detail = (nTrouves < nTotal) ? ` (${nTrouves}/${nTotal} segments retrouvés)` : "";
  b.innerHTML = `<span>🚌 Voyage ${voyageId} tracé${detail}</span>`;
  const btn = document.createElement("button");
  btn.textContent = "Effacer";
  btn.addEventListener("click", effacerTraceVoyage);
  b.appendChild(btn);
  document.getElementById("main-view").appendChild(b);
}

function effacerTraceVoyage() {
  voyageTraceLayer?.clearLayers();
  VoyageTrace.voyage = null;
  document.getElementById("voyage-trace-banner")?.remove();
  if (busMarker && map.hasLayer(busMarker)) map.removeLayer(busMarker);
}

// Point à `fraction` (0-1) de la longueur du tracé d'un segment.
function pointSurSegment(seg, fraction) {
  const coords = seg.is_multi ? seg.coords.flat() : seg.coords;
  if (!Array.isArray(coords) || !coords.length) return null;
  if (coords.length === 1) return coords[0];
  const f = Math.min(Math.max(Number(fraction) || 0, 0), 1);
  const coslat = Math.cos(coords[0][0] * Math.PI / 180);
  const dists = [0];
  for (let i = 1; i < coords.length; i++) {
    const dx = (coords[i][1] - coords[i - 1][1]) * coslat;
    const dy = coords[i][0] - coords[i - 1][0];
    dists.push(dists[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const cible = f * dists[dists.length - 1];
  for (let i = 1; i < coords.length; i++) {
    if (dists[i] >= cible) {
      const w = dists[i] > dists[i - 1] ? (cible - dists[i - 1]) / (dists[i] - dists[i - 1]) : 0;
      return [coords[i - 1][0] + w * (coords[i][0] - coords[i - 1][0]),
              coords[i - 1][1] + w * (coords[i][1] - coords[i - 1][1])];
    }
  }
  return coords[coords.length - 1];
}

async function deplacerBus(msg) {
  if (msg.voyage != null && VoyageTrace.voyage !== Number(msg.voyage)) {
    await tracerVoyageSurCarte(msg.voyage);
  }
  const seg = segmentAffichable(msg.segment_id);
  if (!seg) return;
  const pt = pointSurSegment(seg, msg.fraction);
  if (!pt) return;
  if (!busMarker) {
    busMarker = L.marker(pt, {
      icon: L.divIcon({ className: "bus-icon", html: "🚌",
                        iconSize: [24, 24], iconAnchor: [12, 12] }),
      interactive: false, zIndexOffset: 2000,
    });
  }
  busMarker.setLatLng(pt);
  if (!map.hasLayer(busMarker)) busMarker.addTo(map);
}

// ===== Démarrage =====
// Tout en bas du fichier : toutes les déclarations (y compris les const/let
// des extensions, non hissées) sont exécutées avant ce bloc.
(async function start() {
  initMap();
  buildSidebar();
  buildExtras();
  persoLayer = L.layerGroup().addTo(map);
  voyageTraceLayer = L.layerGroup().addTo(map);
  refreshLignesPersoOptions();
  await DataLoader.loadAll();
  updateModeButtonsUI();
  updateExtrasAvailability();
  renderSegments();      // crée les layers mais n'en affiche aucun (pas de ligne sélectionnée)
  renderStops();
  setupSyncStatus();
  // Corriger un éventuel problème de taille si la div était pas encore layoutée
  setTimeout(() => map.invalidateSize(), 100);
  SyncBus.requestPeerState();
  console.log("Carte prête. Tab id:", SyncBus.tabId);
})();