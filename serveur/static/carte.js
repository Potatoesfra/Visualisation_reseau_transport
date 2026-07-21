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

// ===== Initialisation Leaflet =====
function initMap() {
  map = L.map("map", {
    center: SERVER_META.center,
    zoom: 12,
    zoomControl: true,
    preferCanvas: true,
  });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    subdomains: "abcd",
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a>, © <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);

  relArcLayer = L.layerGroup().addTo(map);
  stopLayer   = L.layerGroup().addTo(map);
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
          polylines.push(L.polyline(part, baseSegmentStyle()));
        }
      } else {
        polylines.push(L.polyline(seg.coords, baseSegmentStyle()));
      }

      const midMarker = L.circleMarker(seg.midpoint, {
        radius: 4, color: "#37474f", weight: 1,
        fillColor: "#90a4ae", fillOpacity: 0.65,
      });

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

function baseSegmentStyle() {
  return { color: "#90a4ae", weight: 3, opacity: 0.75, lineCap: "round" };
}
function selectedSegmentStyle() {
  return { color: "#ffd54f", weight: 6, opacity: 1.0, lineCap: "round" };
}

function attachSegmentEvents(layer, segId) {
  layer.on("click", evt => {
    L.DomEvent.stopPropagation(evt);
    const additive = evt.originalEvent.ctrlKey || evt.originalEvent.metaKey || evt.originalEvent.shiftKey;
    SyncBus.select(segId, additive);
  });
  layer.on("mouseover", () => {
    if (!document.getElementById("chkHighlightOnHover").checked) return;
    if (!SyncBus.getSelection().has(segId)) {
      segmentLayers.get(segId)?.polylines.forEach(p => p.setStyle({ color: "#4f9fff", weight: 4, opacity: 1.0 }));
    }
  });
  layer.on("mouseout", () => {
    if (!SyncBus.getSelection().has(segId)) {
      segmentLayers.get(segId)?.polylines.forEach(p => p.setStyle(baseSegmentStyle()));
    }
  });
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
        if (!selected) p.setStyle(baseSegmentStyle());  // jamais coincé sur un survol
      });
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
  const style = selected ? selectedSegmentStyle() : baseSegmentStyle();
  entry.polylines.forEach(p => {
    p.setStyle(style);
    if (selected) p.bringToFront();
  });
  if (selected) {
    entry.midMarker.setStyle({ radius: 7, fillColor: "#ffd54f", color: "#f57f17", weight: 2, fillOpacity: 1.0 });
    entry.midMarker.bringToFront();
  } else {
    entry.midMarker.setStyle({ radius: 4, fillColor: "#90a4ae", color: "#37474f", weight: 1, fillOpacity: 0.65 });
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
  // Pages Consommation / Simulation : masquées si leurs données ne sont pas
  // chargées (déploiement allégé VIZ_LIGHT ou parquet conso absent).
  const hideIf = (id, absent) => {
    const el = document.getElementById(id);
    if (el) el.style.display = absent ? "none" : "";
  };
  hideIf("btnOpenConso", !meta.conso_disponible);
  hideIf("btnOpenSimulation", !meta.simulation_disponible);
  // Pages Graphe / Graphe de calcul : désactivées en mode allégé VIZ_LIGHT.
  hideIf("btnOpenGraph", meta.graphe_disponible === false);
  hideIf("lnkGrapheWrap", meta.graphe_disponible === false);
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
      zoomControl: true, preferCanvas: true,
    });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 19, subdomains: "abcd",
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a>, © <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(Trajet.map);
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