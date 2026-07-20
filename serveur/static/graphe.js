/* =====================================================
   graphe.js — Vue graphe Cytoscape
   Principe : ajout/retrait incrémental de nœuds.
   Layout relancé uniquement pour les nouveaux nœuds.

   Nouveauté : bouton "Afficher seulement ces segments
   sur la carte" dans le panneau info d'un nœud.
   Quand activé, envoie un message focus_map via
   BroadcastChannel pour que carte.js masque tout
   sauf les segments sélectionnés.
   ===================================================== */

let cy = null;
let displayMode = "neighbors";   // 'neighbors' | 'all'
let currentLayout = "cose-bilkent";

// Highlight depuis le graphe de calcul : { levels: Map<segId(Number), level>, maxLevel }
let calcHighlight = null;

// Hover sur les arêtes
let edgeHoverActive = false;

function levelColorGraphe(lv, maxLv) {
  const t = maxLv > 0 ? Math.min(1, lv / maxLv) : 0;
  return `hsl(${(220 - 170 * t).toFixed(1)}, 77%, 50%)`;
}

function clearCalcHighlight() {
  calcHighlight = null;
}

const MAX_NODES_ALL_MODE = 300;

let pendingNewNodeIds      = new Set();
let currentLayoutInstance  = null;
let freezeViewActive       = false;

// Focus-mode carte : true si on a demandé à la carte de n'afficher
// que la sélection courante.
let mapFocusActive = false;

// Canal BroadcastChannel partagé (même nom que dans sync.js)
const _focusChannel = new BroadcastChannel("relations-segments-sync");

function broadcastFocusMap(active, ids = []) {
  _focusChannel.postMessage({
    type: "focus_map",
    from: SyncBus.tabId,
    active,
    ids,
  });
}

// Réception du highlight depuis le graphe de calcul
_focusChannel.addEventListener("message", evt => {
  const msg = evt.data;
  if (!msg || msg.from === SyncBus.tabId) return;
  if (msg.type === "calc_highlight") {
    const levelsMap = new Map();
    for (const [k, v] of Object.entries(msg.levels || {})) levelsMap.set(Number(k), Number(v));
    calcHighlight = { levels: levelsMap, maxLevel: Number(msg.maxLevel || 0) };
    refreshGraph(true);
  }
});

// ===== Stylesheet Cytoscape =====
function buildStylesheet() {
  const edgeStyles = Object.entries(SERVER_META.couleurs).map(([t, c]) => ({
    selector: `edge.${t}`,
    style: { "line-color": c, "target-arrow-color": c },
  }));
  return [
    { selector: "node", style: {
        "background-color": "#90a4ae", "label": "data(label)",
        "color": "#1a1a1a", "text-valign": "center", "text-halign": "center",
        "font-size": "10px", "font-weight": 600,
        // taille proportionnelle au PageRank normalisé [0,1] → [18,52] px
        "width":  ele => 18 + (ele.data("pagerank_norm") || 0) * 34,
        "height": ele => 18 + (ele.data("pagerank_norm") || 0) * 34,
        "border-width": 1, "border-color": "#546e7a",
        "transition-property": "background-color, border-color, border-width, width, height",
        "transition-duration": "0.15s",
    }},
    { selector: "node.selected-by-app", style: {
        "background-color": "#ffd54f", "border-color": "#f57f17",
        "border-width": 3, "width": 40, "height": 40,
        "font-size": "12px", "z-index": 100,
    }},
    { selector: "node.calc-hl", style: {
        "background-color": "data(calcColor)",
        "border-color": "#111", "border-width": 3, "z-index": 90,
    }},
    { selector: "node.neighbor-of-selected", style: {
        "background-color": "#bbdefb", "border-color": "#1976d2", "border-width": 2,
    }},
    { selector: "node:active", style: { "overlay-opacity": 0.1 }},
    { selector: "edge", style: {
        "width": 2, "curve-style": "bezier", "opacity": 0.75,
        "target-arrow-shape": "none",
        "transition-property": "width, opacity", "transition-duration": "0.15s",
    }},
    { selector: "edge.highlighted", style: { "width": 4, "opacity": 1.0 }},
    { selector: "edge.suivant", style: {
        "target-arrow-shape": "triangle",
        "target-arrow-color": SERVER_META.couleurs.suivant,
    }},
    ...edgeStyles,
  ];
}

// ===== Tooltip arêtes =====
function makeEdgeTooltip() {
  const el = document.createElement("div");
  el.id = "edgeTooltip";
  el.className = "edge-tooltip";
  document.getElementById("main-view").appendChild(el);
  return el;
}

// ===== Init Cytoscape =====
function initCy() {
  cy = cytoscape({
    container: document.getElementById("cy"),
    elements: [],
    style: buildStylesheet(),
    boxSelectionEnabled: true,
    selectionType: "additive",
    autoungrabify: false,
    wheelSensitivity: 0.2,
  });

  const edgeTip = makeEdgeTooltip();
  let edgeTipScheduled = false;

  cy.on("tap", "node", evt => {
    const id = Number(evt.target.id());
    const additive = evt.originalEvent.ctrlKey || evt.originalEvent.metaKey || evt.originalEvent.shiftKey;
    clearCalcHighlight();
    SyncBus.select(id, additive);
  });

  cy.on("tap", evt => { /* clic dans le vide : ne pas effacer */ });

  cy.on("boxend", () => {
    const ids = cy.$("node:selected").map(n => Number(n.id()));
    if (ids.length > 0) { clearCalcHighlight(); SyncBus.addMany(ids); }
    cy.$("node:selected").unselect();
  });

  cy.on("mouseover", "node", evt => evt.target.connectedEdges().addClass("highlighted"));
  cy.on("mouseout",  "node", ()  => cy.edges(".highlighted").removeClass("highlighted"));

  // Hover arêtes
  cy.on("mouseover", "edge", evt => {
    if (!edgeHoverActive) return;
    const d = evt.target.data();
    const srcSeg = DataLoader.segmentById.get(Number(d.source));
    const tgtSeg = DataLoader.segmentById.get(Number(d.target));
    const color = SERVER_META.couleurs[d.type] || "#888";
    let html = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:5px;vertical-align:middle;"></span>`
             + `<b>${d.type || d.edge_type || "?"}</b><br>`
             + `${d.source} → ${d.target}<br>`;
    const lbl = DataLoader.mode === "fusion" ? "Lignes" : "Ligne";
    if (srcSeg) html += `${lbl} A : ${(srcSeg.routes || [srcSeg.route_id]).join(", ")}<br>`;
    if (tgtSeg) html += `${lbl} B : ${(tgtSeg.routes || [tgtSeg.route_id]).join(", ")}<br>`;
    if (d.longueur_m != null) html += `Longueur : ${Number(d.longueur_m).toFixed(0)} m`;
    edgeTip.innerHTML = html;
    edgeTip.style.display = "block";
  });
  cy.on("mousemove", "edge", evt => {
    if (!edgeHoverActive) return;
    if (!edgeTipScheduled) {
      edgeTipScheduled = true;
      requestAnimationFrame(() => {
        edgeTipScheduled = false;
        const p = evt.renderedPosition || { x: 0, y: 0 };
        edgeTip.style.left = (p.x + 14) + "px";
        edgeTip.style.top  = (p.y + 14) + "px";
      });
    }
  });
  cy.on("mouseout", "edge", () => { edgeTip.style.display = "none"; });
}

// ===== Éléments du graphe =====
function buildElements() {
  const sel         = SyncBus.getSelection();
  const activeTypes = SyncBus.getState().activeRelTypes;
  const visibleLines = SyncBus.getState().visibleLines;

  // Mode highlight depuis le graphe de calcul
  if (calcHighlight) {
    const nodes = [];
    for (const [segId, level] of calcHighlight.levels) {
      const seg = DataLoader.segmentById.get(segId);
      if (!seg) continue;
      nodes.push({ group: "nodes", data: {
        id: String(segId), label: String(segId),
        route_id: seg.route_id,
        start_stop: seg.start_stop_code, end_stop: seg.end_stop_code,
        pagerank_norm: seg.pagerank_norm ?? 0,
        degree_in: seg.degree_in ?? 0,
        degree_out: seg.degree_out ?? 0,
        degree_total: seg.degree_total ?? 0,
        calcColor: levelColorGraphe(level, calcHighlight.maxLevel),
        calcLevel: level,
      }});
    }
    const hlNodeIds = new Set(nodes.map(n => n.data.id));
    const edges = [];
    for (const r of DataLoader.relations) {
      if (!activeTypes.has(r.type)) continue;
      if (!hlNodeIds.has(String(r.a)) || !hlNodeIds.has(String(r.b))) continue;
      edges.push({ group: "edges", data: {
        id: `e_${r.a}_${r.b}_${r.type}`,
        source: String(r.a), target: String(r.b),
        type: r.type, longueur_m: r.longueur_m,
      }, classes: r.type });
    }
    return { nodes, edges };
  }

  let nodeIds;
  if (displayMode === "neighbors" && sel.size > 0) {
    const rels = DataLoader.getRelationsBetween(sel, activeTypes);
    const ids  = new Set(sel);
    for (const r of rels) { ids.add(r.a); ids.add(r.b); }
    nodeIds = ids;
  } else {
    const filterActive = visibleLines.size > 0;
    let candidates = DataLoader.segments;
    // En mode fusion, un nœud agrège plusieurs lignes : on l'affiche si l'une
    // quelconque de ses lignes est sélectionnée (pas seulement la représentative).
    if (filterActive) candidates = candidates.filter(s =>
      (s.routes || [s.route_id]).some(r => visibleLines.has(r)));
    candidates = candidates.slice(0, MAX_NODES_ALL_MODE);
    nodeIds = new Set(candidates.map(s => s.id));
    sel.forEach(id => nodeIds.add(id));
  }

  const nodes = [];
  for (const id of nodeIds) {
    const seg = DataLoader.segmentById.get(id);
    if (!seg) continue;
    nodes.push({ group: "nodes", data: {
      id: String(id), label: String(id),
      route_id: seg.route_id,
      start_stop: seg.start_stop_code, end_stop: seg.end_stop_code,
      pagerank_norm: seg.pagerank_norm ?? 0,
      degree_in:     seg.degree_in    ?? 0,
      degree_out:    seg.degree_out   ?? 0,
      degree_total:  seg.degree_total ?? 0,
    }});
  }

  const edges = [];
  for (const r of DataLoader.relations) {
    if (!activeTypes.has(r.type)) continue;
    if (!nodeIds.has(r.a) || !nodeIds.has(r.b)) continue;
    edges.push({ group: "edges", data: {
      id: `e_${r.a}_${r.b}_${r.type}`,
      source: String(r.a), target: String(r.b),
      type: r.type, longueur_m: r.longueur_m,
    }, classes: r.type });
  }

  return { nodes, edges };
}

// ===== Mise à jour incrémentale =====
function refreshGraph(force = false) {
  const { nodes, edges } = buildElements();
  const newNodeIds  = new Set(nodes.map(n => n.data.id));
  const newEdgeIds  = new Set(edges.map(e => e.data.id));
  const existNodeIds = new Set(cy.nodes().map(n => n.id()));
  const existEdgeIds = new Set(cy.edges().map(e => e.id()));

  const nodesToAdd    = nodes.filter(n => !existNodeIds.has(n.data.id));
  const nodesToRemove = [...existNodeIds].filter(id => !newNodeIds.has(id));
  const edgesToAdd    = edges.filter(e => !existEdgeIds.has(e.data.id));
  const edgesToRemove = [...existEdgeIds].filter(id => !newEdgeIds.has(id));

  cy.batch(() => {
    if (nodesToRemove.length) cy.remove(cy.collection(nodesToRemove.map(id => cy.getElementById(id))));
    if (edgesToRemove.length) cy.remove(cy.collection(edgesToRemove.map(id => cy.getElementById(id))));
    if (nodesToAdd.length)    cy.add(nodesToAdd);
    if (edgesToAdd.length)    cy.add(edgesToAdd);
  });

  pendingNewNodeIds = new Set(nodesToAdd.map(n => n.data.id));

  if (nodesToAdd.length > 0 || force) {
    runLayout(nodesToAdd.length > 0 && existNodeIds.size > 0 && !force ? "incremental" : "full");
  }

  updateSelectionClasses();
  updateStats();
}

// ===== Layout =====
function runLayout(mode = "full") {
  // Annuler le layout en cours et déverrouiller immédiatement
  if (currentLayoutInstance) {
    try { currentLayoutInstance.stop(); } catch (e) {}
    currentLayoutInstance = null;
  }
  cy.nodes().unlock();

  let opts;
  if (currentLayout === "cose-bilkent") {
    opts = {
      name: "cose-bilkent", animate: false,
      randomize: mode === "full",
      nodeRepulsion: 8000, idealEdgeLength: 90,
      edgeElasticity: 0.1, gravity: 0.25,
      numIter: 2500, fit: mode === "full", padding: 30,
    };
    if (mode === "incremental") {
      cy.nodes().forEach(n => { if (!pendingNewNodeIds.has(n.id())) n.lock(); });
      opts.fit = false;
    }
  } else if (currentLayout === "concentric") {
    opts = {
      name: "concentric", animate: false,
      concentric: node => node.degree(), levelWidth: () => 1,
      minNodeSpacing: 30, fit: true, padding: 30,
    };
  } else if (currentLayout === "circle") {
    opts = { name: "circle", animate: false, fit: true, padding: 30 };
  } else {
    opts = { name: "grid", animate: false, fit: true };
  }

  const layout = cy.layout(opts);
  currentLayoutInstance = layout;
  layout.on("layoutstop", () => {
    cy.nodes().unlock();
    if (currentLayoutInstance === layout) currentLayoutInstance = null;
    pendingNewNodeIds = new Set();
  });
  layout.run();
}

// ===== Classes de sélection =====
function updateSelectionClasses() {
  const sel = SyncBus.getSelection();
  cy.batch(() => {
    cy.nodes().removeClass("selected-by-app neighbor-of-selected calc-hl");
    if (calcHighlight) {
      cy.nodes().forEach(n => { n.addClass("calc-hl"); });
      return;
    }
    cy.nodes().forEach(n => {
      const id = Number(n.id());
      if (sel.has(id)) {
        n.addClass("selected-by-app");
      } else {
        const isNeighbor = n.connectedEdges().some(e =>
          sel.has(Number(e.source().id())) || sel.has(Number(e.target().id()))
        );
        if (isNeighbor) n.addClass("neighbor-of-selected");
      }
    });
  });
}

function updateStats() {
  document.getElementById("statSel").textContent   = SyncBus.getSelection().size;
  document.getElementById("statNodes").textContent = cy.nodes().length;
  document.getElementById("statEdges").textContent = cy.edges().length;
}

function updateFreezeButtonUI() {
  const btn = document.getElementById("btnFreezeView");
  if (!btn) return;
  btn.textContent = freezeViewActive ? "Vue figée (actif)" : "Figer la vue";
  btn.classList.toggle("primary", freezeViewActive);
}

function toggleFreezeView() {
  freezeViewActive = !freezeViewActive;
  updateFreezeButtonUI();
}

// ===== Panneau info nœud =====
function refreshNodeInfoPanel() {
  const sel   = Array.from(SyncBus.getSelection());
  const panel = document.getElementById("seg-info-panel");
  if (sel.length === 0) { panel.classList.remove("visible"); return; }
  panel.classList.add("visible");

  const title       = document.getElementById("segInfoTitle");
  const body        = document.getElementById("segInfoBody");
  const activeTypes = SyncBus.getState().activeRelTypes;

  if (sel.length === 1) {
    const seg = DataLoader.segmentById.get(sel[0]);
    if (!seg) return;
    const fusion = DataLoader.mode === "fusion";
    title.textContent = fusion ? `Nœud fusionné ${seg.id}` : `Nœud ${seg.id}`;
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
        const otherId  = r.a === seg.id ? r.b : r.a;
        const otherSeg = DataLoader.segmentById.get(otherId);
        const color    = SERVER_META.couleurs[t] || "#666";
        html += `<div class="rel-item" data-seg="${otherId}">
          <span class="type-tag" style="background:${color};">${t}</span>
          <span>Nœud ${otherId} (ligne ${otherSeg?.route_id ?? '?'})${r.longueur_m != null ? ' · '+r.longueur_m.toFixed(0)+' m' : ''}</span>
        </div>`;
      }
      html += `</div>`;
    }
    body.innerHTML = html;

    body.querySelectorAll(".rel-item").forEach(el => {
      el.addEventListener("click", () => SyncBus.select(Number(el.dataset.seg), true));
    });
  } else {
    // Plusieurs nœuds sélectionnés — afficher le résumé + bouton focus-map
    title.textContent = `${sel.length} nœuds sélectionnés`;
    const rels   = DataLoader.getRelationsBetween(SyncBus.getSelection(), activeTypes);
    const counts = {};
    for (const r of rels) counts[r.type] = (counts[r.type] || 0) + 1;

    let html = `
      <div class="seg-row"><div class="k">Nœuds</div><div class="v">${sel.slice(0,15).join(", ")}${sel.length>15?"…":""}</div></div>
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

    // ===== BOUTON FOCUS-MAP =====
    const focusBtnLabel = mapFocusActive
      ? "🗺️ Afficher tous les segments du graphe"
      : "🎯 N'afficher que ces segments sur la carte";
    const focusBtnClass = mapFocusActive ? "action-btn danger" : "action-btn primary";
    html += `<div style="margin-top:10px;">
      <button class="${focusBtnClass}" id="btnFocusMap">${focusBtnLabel}</button>
    </div>`;

    body.innerHTML = html;

    document.getElementById("btnFocusMap").addEventListener("click", () => {
      toggleMapFocus(sel);
    });
  }
}

// ===== Toggle focus-map =====
function toggleMapFocus(ids) {
  if (mapFocusActive) {
    // Désactiver le focus : montrer TOUS les nodes visibles dans le graphe
    mapFocusActive = false;
    const allGraphIds = cy.nodes().map(n => Number(n.id()));
    broadcastFocusMap(false, allGraphIds);
  } else {
    // Activer le focus : n'afficher que les ids sélectionnés sur la carte
    mapFocusActive = true;
    broadcastFocusMap(true, ids);
  }
  // Rafraîchir le panneau pour mettre à jour le libellé du bouton
  refreshNodeInfoPanel();
}

function closeSegInfo() {
  document.getElementById("seg-info-panel").classList.remove("visible");
}

// Quand la sélection change, si le focus-map est actif, mettre à jour les ids envoyés
SyncBus.onSelectionChange((selectedIds, fromPeer) => {
  if (displayMode === "neighbors" && !freezeViewActive) {
    refreshGraph();
  } else {
    updateSelectionClasses();
    updateStats();
  }
  refreshNodeInfoPanel();

  // Si focus actif, mettre à jour la carte avec les nouveaux ids sélectionnés
  if (mapFocusActive && selectedIds.size > 0) {
    broadcastFocusMap(true, Array.from(selectedIds));
  }
});

// ===== Sidebar =====
function buildSidebar() {
  buildLineSelectorWithSearch();

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
    clearCalcHighlight();
    const active = Array.from(wrap.querySelectorAll('input[type="checkbox"]:checked'))
                        .map(cb => cb.dataset.rel);
    SyncBus.setRelTypes(active);
    refreshGraph();
    refreshNodeInfoPanel();
  });
  SyncBus.setRelTypes(SERVER_META.types_relations);

  const btnNeighbors = document.getElementById("btnModeNeighbors");
  const btnAll       = document.getElementById("btnModeAll");
  btnNeighbors.addEventListener("click", () => {
    clearCalcHighlight();
    displayMode = "neighbors";
    btnNeighbors.classList.add("primary"); btnAll.classList.remove("primary");
    refreshGraph(true);
  });
  btnAll.addEventListener("click", () => {
    clearCalcHighlight();
    displayMode = "all";
    btnAll.classList.add("primary"); btnNeighbors.classList.remove("primary");
    refreshGraph(true);
  });

  document.getElementById("btnLayoutCose").addEventListener("click",       () => { currentLayout = "cose-bilkent"; runLayout("full"); });
  document.getElementById("btnLayoutConcentric").addEventListener("click", () => { currentLayout = "concentric";   runLayout("full"); });
  document.getElementById("btnLayoutCircle").addEventListener("click",     () => { currentLayout = "circle";       runLayout("full"); });
  document.getElementById("btnRelayout").addEventListener("click",         () => runLayout("full"));

  document.getElementById("btnClear").addEventListener("click", () => {
    clearCalcHighlight();
    if (mapFocusActive) { mapFocusActive = false; broadcastFocusMap(false, []); }
    SyncBus.clear();
    closeSegInfo();
  });
  document.getElementById("btnFreezeView").addEventListener("click", toggleFreezeView);
  document.getElementById("btnFitGraph").addEventListener("click", () => cy.fit(undefined, 40));
  document.getElementById("btnOpenMap").addEventListener("click", e => {
    e.preventDefault();
    const url = new URL("/", window.location.origin).href;
    window.open(url, "relations-carte");
  });

  document.getElementById("btnEdgeHover").addEventListener("click", () => {
    edgeHoverActive = !edgeHoverActive;
    const btn = document.getElementById("btnEdgeHover");
    if (edgeHoverActive) {
      btn.textContent = "🔍 Désactiver hover liens";
      btn.classList.add("primary");
    } else {
      btn.textContent = "🔍 Activer hover liens";
      btn.classList.remove("primary");
      const tip = document.getElementById("edgeTooltip");
      if (tip) tip.style.display = "none";
    }
  });

  document.getElementById("btnGrapheCalcul").addEventListener("click", () => {
    const sel = SyncBus.getSelection();
    if (sel.size === 0) {
      alert("Sélectionnez au moins un nœud avant d'ouvrir le graphe de calcul.");
      return;
    }
    const roots = Array.from(sel).join(",");
    const url = new URL("/graphe_calcul", window.location.origin);
    url.searchParams.set("roots", roots);
    url.searchParams.set("depth", "1");
    url.searchParams.set("mode", DataLoader.mode);
    window.open(url.href, "relations-graphe-calcul");
  });

  // Bouton de bascule Normal / Fusion
  document.getElementById("btnModeNormal")?.addEventListener("click", () => SyncBus.setMode("normal"));
  document.getElementById("btnModeFusion")?.addEventListener("click", () => {
    if (DataLoader.meta && DataLoader.meta.fusion_disponible) SyncBus.setMode("fusion");
  });

  const legend = document.getElementById("legend");
  for (const t of SERVER_META.types_relations) {
    const row = document.createElement("div");
    row.className = "chk-row";
    row.style.cursor = "default";
    row.innerHTML = `
      <span class="legend-line" style="background:${SERVER_META.couleurs[t] || '#888'};"></span>
      <span style="font-size:0.78rem;">${t}</span>`;
    legend.appendChild(row);
  }

  updateFreezeButtonUI();
}

function buildLineSelectorWithSearch() {
  const lineSelect = document.getElementById("lineSelect");
  const searchInput = document.createElement("input");
  searchInput.type          = "text";
  searchInput.id            = "lineSearch";
  searchInput.placeholder   = "🔍 Filtrer les lignes…";
  searchInput.autocomplete  = "off";
  searchInput.style.marginBottom = "6px";
  lineSelect.parentNode.insertBefore(searchInput, lineSelect);

  for (const l of SERVER_META.lignes) {
    const opt = document.createElement("option");
    opt.value = l; opt.textContent = l; opt.dataset.label = l.toLowerCase();
    lineSelect.appendChild(opt);
  }
  searchInput.addEventListener("input", () => {
    const q = searchInput.value.trim().toLowerCase();
    for (const opt of lineSelect.options) {
      const m = !q || opt.dataset.label.includes(q);
      opt.hidden = !m; opt.style.display = m ? "" : "none";
    }
  });
  lineSelect.addEventListener("change", () => {
    clearCalcHighlight();
    const selected = Array.from(lineSelect.selectedOptions).map(o => o.value);
    SyncBus.setVisibleLines(selected);
    if (mapFocusActive) {
      const allGraphIds = cy.nodes().map(n => Number(n.id()));
      broadcastFocusMap(false, allGraphIds);
      mapFocusActive = false;
    }
    refreshGraph();
  });
}

SyncBus.onFilterChange((state) => {
  document.querySelectorAll('#relTypeCheckboxes input[type="checkbox"]').forEach(cb => {
    cb.checked = state.activeRelTypes.has(cb.dataset.rel);
  });
  const lineSelect = document.getElementById("lineSelect");
  for (const opt of lineSelect.options) opt.selected = state.visibleLines.has(opt.value);
  refreshGraph();
});

// ===== Bascule de mode (Normal / Fusion) =====
function updateModeButtonsUI() {
  const bN = document.getElementById("btnModeNormal");
  const bF = document.getElementById("btnModeFusion");
  if (!bN || !bF) return;
  const fusionOk = !!(DataLoader.meta && DataLoader.meta.fusion_disponible);
  const sec = document.getElementById("secModeSegments");
  if (sec) sec.style.display = fusionOk ? "" : "none";
  bF.disabled = !fusionOk;
  bF.title = fusionOk ? "" : "Fichiers de fusion absents — lancez Fusion_segments.py puis Relations_segments.py en mode fusion.";
  bN.classList.toggle("primary", DataLoader.mode === "normal");
  bF.classList.toggle("primary", DataLoader.mode === "fusion");
}

async function reloadForMode(mode) {
  clearCalcHighlight();
  if (mapFocusActive) { mapFocusActive = false; broadcastFocusMap(false, []); }
  SyncBus.clear();
  await DataLoader.loadAll(mode);
  cy.elements().remove();
  refreshGraph(true);
  updateModeButtonsUI();
}

SyncBus.onModeChange((mode) => { reloadForMode(mode); });

// ===== Démarrage =====
(async function start() {
  await DataLoader.loadAll();
  initCy();
  buildSidebar();
  updateModeButtonsUI();
  refreshGraph(true);
  setupSyncStatus();
  SyncBus.requestPeerState();
  console.log("Graphe prêt. Tab id:", SyncBus.tabId);
})();