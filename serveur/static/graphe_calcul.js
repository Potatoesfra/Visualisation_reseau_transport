/* =====================================================
   graphe_calcul.js — Arbre de voisinage avec moteur physique
   Paramètres URL :
     roots=4050,4030   ids des nœuds racines (virgule)
     depth=2           profondeur initiale (1–5, défaut 1)
   ===================================================== */

// ===== Constantes du moteur =====
const LAYOUT_STORAGE_KEY = 'stm.calc_graph.layout_params.v1';

const PARAM_SCHEMA = {
  repulsion:           { default: 5000,  min: 300,   max: 30000, integer: false },
  springK:             { default: 0.042, min: 0.001, max: 0.3,   integer: false },
  gravityK:            { default: 0.115, min: 0.001, max: 0.5,   integer: false },
  centerXK:            { default: 0.0035,min: 0,     max: 0.05,  integer: false },
  parentClusterK:      { default: 0.16,  min: 0,     max: 0.6,   integer: false },
  sameLevelRepulsionK: { default: 760,   min: 0,     max: 8000,  integer: false },
  siblingBlobAttractK: { default: 0.048, min: 0,     max: 0.4,   integer: false },
  siblingBlobCenterK:  { default: 0.022, min: 0,     max: 0.3,   integer: false },
  blobCollisionK:      { default: 0.52,  min: 0,     max: 2.5,   integer: false },
  blobCollisionGap:    { default: 24,    min: 0,     max: 140,   integer: false },
  deepestDownK:        { default: 0.08,  min: 0,     max: 0.6,   integer: false },
  damping:             { default: 0.84,  min: 0.35,  max: 0.98,  integer: false },
  maxSpeed:            { default: 13,    min: 1,     max: 80,    integer: false },
  steps:               { default: 240,   min: 30,    max: 5000,  integer: true  },
};

// ===== État global =====
let cy = null;
let activeTypes = new Set(SERVER_META.types_relations);
let currentDepth = 1;
let rootIds = [];
let dataMode = 'normal';         // "normal" | "fusion" (lu depuis l'URL)
let maxTreeNodes = 1500;
let expandMode = true;           // "Ne pas étendre" coché par défaut
let nodeCounter = 0;             // compteur global pour les ids d'instances
let expandedInstances = new Set(); // instanceIds déjà étendus
let layoutRunToken = 0;
let labelsHidden = false;
let activeUltraLightRuns = 0;

let currentParams = defaultParams();
let currentUltraLight = true;
let ctxTargetId = '';            // instanceId ciblé par le menu contextuel
let edgeHoverActive = false;

// ===== Lecture URL =====
(function parseUrlParams() {
  const p = new URLSearchParams(window.location.search);
  const raw = p.get('roots') || '';
  rootIds = raw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  currentDepth = Math.min(5, Math.max(1, parseInt(p.get('depth') || '1', 10)));
  dataMode = p.get('mode') === 'fusion' ? 'fusion' : 'normal';
})();

// ===== Utilitaires paramètres =====
function defaultParams() {
  const o = {};
  for (const [k, s] of Object.entries(PARAM_SCHEMA))
    o[k] = s.integer ? Math.round(s.default) : Number(s.default);
  return o;
}

function clampParam(name, raw) {
  const s = PARAM_SCHEMA[name];
  if (!s) return Number(raw);
  let v = parseFloat(String(raw).replace(',', '.'));
  if (!isFinite(v)) v = s.default;
  v = Math.max(s.min, Math.min(s.max, v));
  return s.integer ? Math.round(v) : v;
}

function normalizeParams(raw) {
  const o = {};
  for (const k of Object.keys(PARAM_SCHEMA)) o[k] = clampParam(k, raw[k]);
  return o;
}

// ===== Persistance localStorage =====
function saveParams(params, ultraLight) {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({ params, ultraLightMode: !!ultraLight }));
    return true;
  } catch { return false; }
}

function loadParams() {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return { params: defaultParams(), ultraLightMode: true, fromCache: false };
    const parsed = JSON.parse(raw);
    if (parsed && parsed.params)
      return { params: normalizeParams(parsed.params), ultraLightMode: !!parsed.ultraLightMode, fromCache: true };
    return { params: normalizeParams(parsed), ultraLightMode: true, fromCache: true };
  } catch {
    return { params: defaultParams(), ultraLightMode: true, fromCache: false };
  }
}

// ===== Lecture des contrôles UI =====
function readParamsFromUI() {
  const o = {};
  for (const k of Object.keys(PARAM_SCHEMA)) {
    const el = document.getElementById('param_' + k);
    o[k] = el ? el.value : PARAM_SCHEMA[k].default;
  }
  return normalizeParams(o);
}

function writeParamsToUI(params) {
  for (const k of Object.keys(PARAM_SCHEMA)) {
    const el = document.getElementById('param_' + k);
    if (el) el.value = String(params[k]);
  }
}

function setParamsStatus(msg, isError) {
  const el = document.getElementById('layoutParamsStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? '#ef4444' : 'var(--text-muted)';
}

// ===== Couleur par niveau =====
function levelColor(level, maxLevel) {
  const t = maxLevel > 0 ? Math.max(0, Math.min(1, level / maxLevel)) : 0;
  return `hsl(${(220 - 170 * t).toFixed(1)}, 77%, 50%)`;
}

// ===== Labels =====
function setLabelsVisible(visible) {
  if (visible === !labelsHidden) return;
  labelsHidden = !visible;
  if (!cy) return;
  cy.style().selector('node')
    .style('label', visible ? 'data(segLabel)' : '')
    .style('text-outline-width', visible ? 2 : 0)
    .update();
}

// ===== Stylesheet =====
function buildStylesheet() {
  const edgeStyles = Object.entries(SERVER_META.couleurs).map(([t, c]) => ({
    selector: `edge[relType="${t}"]`,
    style: { 'line-color': c, 'target-arrow-color': c },
  }));
  return [
    { selector: 'node', style: {
        'background-color': 'data(nodeColor)',
        'label': 'data(segLabel)',
        'color': '#1a1a1a', 'text-valign': 'center', 'text-halign': 'center',
        'font-size': '9px', 'font-weight': 600,
        'width': 'data(nodeSize)', 'height': 'data(nodeSize)',
        'border-width': 2, 'border-color': 'data(nodeBorder)',
        'text-outline-color': '#ffffff', 'text-outline-width': 2,
    }},
    { selector: 'node.root-node', style: { 'border-width': 3, 'border-color': '#b91c1c', 'z-index': 100 }},
    { selector: 'node.expanded', style: { 'border-style': 'double' }},
    { selector: 'edge', style: {
        'width': 2, 'curve-style': 'bezier', 'opacity': 0.8,
        'target-arrow-shape': 'triangle', 'line-color': '#888', 'target-arrow-color': '#888',
    }},
    ...edgeStyles,
  ];
}

// ===== Utilitaire : données d'un nœud BFS =====
function makeNodeData(iid, segId, level) {
  const ml = Math.max(currentDepth, level);
  return {
    id: iid, segId, segLabel: String(segId), level,
    nodeColor: level === 0 ? '#ffd54f' : levelColor(level, ml),
    nodeBorder: level === 0 ? '#b91c1c' : (level === currentDepth ? '#7f1d1d' : '#1f2937'),
    nodeSize: level === 0 ? 36 : Math.max(16, 31 - level * 3),
  };
}

// ===== Comptage léger (sans créer d'objets) =====
function countTreeNodes(roots, depth, types) {
  const MAX_COUNT = 50000; // garde-fou pour éviter un freeze du navigateur
  let count = roots.length;
  const queue = roots.map(r => ({ segId: r, level: 0 }));
  while (queue.length && count < MAX_COUNT) {
    const { segId, level } = queue.shift();
    if (level >= depth) continue;
    const rels = DataLoader.getRelationsFor(segId, types);
    const seen = new Set();
    for (const r of rels) {
      const nbId = r.a === segId ? r.b : r.a;
      if (seen.has(nbId)) continue;
      seen.add(nbId);
      if (!DataLoader.segmentById.has(nbId)) continue;
      count++;
      queue.push({ segId: nbId, level: level + 1 });
    }
  }
  return { count, capped: count >= MAX_COUNT };
}

// ===== BFS arbre complet (doublons autorisés) =====
function buildTree(roots, depth, types, limit) {
  const nodes = [], edges = [];
  let count = 0, truncated = false, maxDepthReached = 0;

  for (const rootSegId of roots) {
    if (!DataLoader.segmentById.has(rootSegId)) continue;
    const iid = `root_${rootSegId}_${nodeCounter++}`;
    nodes.push({ group: 'nodes', data: makeNodeData(iid, rootSegId, 0), classes: 'root-node' });
    count++;
  }

  // BFS à partir des racines (pas de queue séparée pour les racines)
  const queue = nodes.map(n => ({ instanceId: n.data.id, segId: n.data.segId, level: 0 }));

  while (queue.length > 0) {
    const { instanceId, segId, level } = queue.shift();
    if (level >= depth) continue;
    const rels = DataLoader.getRelationsFor(segId, types);
    const seen = new Set();
    for (const r of rels) {
      const nbId = r.a === segId ? r.b : r.a;
      if (seen.has(nbId)) continue;
      seen.add(nbId);
      if (!DataLoader.segmentById.has(nbId)) continue;
      if (count >= limit) { truncated = true; break; }
      const childIid = `n_${nodeCounter++}`;
      const childLevel = level + 1;
      if (childLevel > maxDepthReached) maxDepthReached = childLevel;
      nodes.push({ group: 'nodes', data: makeNodeData(childIid, nbId, childLevel) });
      edges.push({ group: 'edges', data: { id: `e_${instanceId}_${childIid}`, source: instanceId, target: childIid, relType: r.type }});
      count++;
      queue.push({ instanceId: childIid, segId: nbId, level: childLevel });
    }
    if (truncated) break;
  }
  return { nodes, edges, truncated, maxDepthReached };
}

// ===== Mode expand : initialisation (niveau 0 seulement) =====
function initExpandTree() {
  const nodes = [];
  expandedInstances.clear();
  for (const rootSegId of rootIds) {
    if (!DataLoader.segmentById.has(rootSegId)) continue;
    const iid = `root_${rootSegId}_${nodeCounter++}`;
    nodes.push({ group: 'nodes', data: makeNodeData(iid, rootSegId, 0), classes: 'root-node' });
  }
  if (!cy) {
    cy = cytoscape({ container: document.getElementById('cy'), elements: nodes, style: buildStylesheet(), wheelSensitivity: 0.2, layout: { name: 'preset', fit: false } });
  } else {
    cy.elements().remove();
    cy.style(buildStylesheet());
    cy.add(nodes);
  }
  assignInitialPositions();
  runGravityLayout(currentParams, currentUltraLight);
  updateStats();
  updateTotals();
  hideBanner();
}

// ===== Mode expand : étendre un nœud =====
function expandNode(instanceId) {
  const nd = cy.getElementById(instanceId)?.data();
  if (!nd) return;
  if (nd.level >= currentDepth) {
    flashBanner(`⚠ Profondeur maximale (${currentDepth}) atteinte. Augmentez le slider pour aller plus loin.`);
    return;
  }
  if (expandedInstances.has(instanceId)) {
    flashBanner('Ce nœud est déjà étendu.');
    return;
  }

  const parentPos = cy.getElementById(instanceId).position();
  const rels = DataLoader.getRelationsFor(nd.segId, activeTypes);
  const seen = new Set();
  const newNodes = [], newEdges = [];
  let limitHit = false;

  for (const r of rels) {
    const nbId = r.a === nd.segId ? r.b : r.a;
    if (seen.has(nbId)) continue;
    seen.add(nbId);
    if (!DataLoader.segmentById.has(nbId)) continue;
    if (cy.nodes().length >= maxTreeNodes) { limitHit = true; break; }
    const childIid = `n_${nodeCounter++}`;
    const childLevel = nd.level + 1;
    newNodes.push({ group: 'nodes', data: makeNodeData(childIid, nbId, childLevel) });
    newEdges.push({ group: 'edges', data: { id: `e_${instanceId}_${childIid}`, source: instanceId, target: childIid, relType: r.type }});
  }

  if (newNodes.length > 0) {
    // Positionner les nouveaux nœuds près du parent avant l'ajout
    newNodes.forEach((n, i) => {
      const angle = (i / Math.max(1, newNodes.length)) * Math.PI * 2;
      n.data._initX = parentPos.x + Math.cos(angle) * 50;
      n.data._initY = parentPos.y + 70 + Math.random() * 20;
    });
    cy.add([...newNodes, ...newEdges]);
    newNodes.forEach(n => {
      cy.getElementById(n.data.id).position({ x: n.data._initX, y: n.data._initY });
    });
    expandedInstances.add(instanceId);
    cy.getElementById(instanceId).addClass('expanded');
    runGravityLayout(currentParams, currentUltraLight);
    updateStats();
  }

  if (limitHit) {
    showBanner(`⚠ Limite de ${maxTreeNodes} nœuds atteinte pendant l'expansion. Augmentez la limite si nécessaire.`);
  }
}

// ===== Mode expand : étendre tous les nœuds d'un niveau donné =====
function expandLevel(level) {
  const toExpand = cy.nodes().filter(n => Number(n.data('level')) === level && !expandedInstances.has(n.id())).map(n => n.id());
  for (const iid of toExpand) expandNode(iid);
}

// ===== Mode expand : réduire un nœud (supprimer ses descendants, sans relayout) =====
function collapseNode(instanceId) {
  const subtree = cy.getElementById(instanceId).successors();
  if (!subtree.length) { flashBanner('Ce nœud n\'a pas de descendants à réduire.'); return; }
  subtree.nodes().forEach(n => { expandedInstances.delete(n.id()); });
  cy.getElementById(instanceId).removeClass('expanded');
  subtree.remove();
  updateStats();
}

// ===== Mode expand : réduire tous les nœuds d'un niveau (sans relayout) =====
function collapseLevel(level) {
  const toCollapse = cy.nodes().filter(n => Number(n.data('level')) === level && expandedInstances.has(n.id())).map(n => n.id());
  if (!toCollapse.length) { flashBanner(`Aucun nœud étendu au niveau ${level}.`); return; }
  for (const iid of toCollapse) {
    const subtree = cy.getElementById(iid).successors();
    subtree.nodes().forEach(n => { expandedInstances.delete(n.id()); });
    cy.getElementById(iid).removeClass('expanded');
    subtree.remove();
  }
  updateStats();
}

// ===== Comptage unique (un segId une seule fois) =====
function countUniqueNodes(roots, depth, types) {
  const visited = new Set();
  roots.forEach(r => { if (DataLoader.segmentById.has(r)) visited.add(r); });
  const queue = roots.filter(r => DataLoader.segmentById.has(r)).map(r => ({ segId: r, level: 0 }));
  while (queue.length) {
    const { segId, level } = queue.shift();
    if (level >= depth) continue;
    const rels = DataLoader.getRelationsFor(segId, types);
    const seen = new Set();
    for (const r of rels) {
      const nbId = r.a === segId ? r.b : r.a;
      if (seen.has(nbId)) continue;
      seen.add(nbId);
      if (!DataLoader.segmentById.has(nbId)) continue;
      if (!visited.has(nbId)) { visited.add(nbId); queue.push({ segId: nbId, level: level + 1 }); }
    }
  }
  return visited.size;
}

// ===== Totaux potentiels à la profondeur courante =====
function updateTotals() {
  const noData = '—';
  if (!rootIds.length || !DataLoader.segments) {
    document.getElementById('statTotalUnique').textContent = noData;
    document.getElementById('statTotalDup').textContent = noData;
    return;
  }
  const uniq = countUniqueNodes(rootIds, currentDepth, activeTypes);
  const { count: dup, capped } = countTreeNodes(rootIds, currentDepth, activeTypes);
  document.getElementById('statTotalUnique').textContent = uniq.toLocaleString('fr-CA');
  document.getElementById('statTotalDup').textContent = (capped ? '>' : '') + dup.toLocaleString('fr-CA');
}

// ===== Stats affichées =====
function updateStats() {
  if (!cy) return;
  let maxLevel = 0;
  cy.nodes().forEach(n => { maxLevel = Math.max(maxLevel, Number(n.data('level') || 0)); });
  document.getElementById('statNodes').textContent = cy.nodes().length;
  document.getElementById('statEdges').textContent = cy.edges().length;
  document.getElementById('statDepth').textContent = maxLevel;
}

// ===== Bannière =====
function showBanner(msg) {
  const b = document.getElementById('warningBanner');
  b.style.display = 'block';
  b.textContent = msg;
}
function hideBanner() {
  document.getElementById('warningBanner').style.display = 'none';
}
let _flashTimer = null;
function flashBanner(msg) {
  showBanner(msg);
  if (_flashTimer) clearTimeout(_flashTimer);
  _flashTimer = setTimeout(hideBanner, 3500);
}

// ===== Menu contextuel =====
function showCtxMenu(renderedPos, instanceId) {
  ctxTargetId = instanceId;
  const nd = cy.getElementById(instanceId)?.data() || {};
  const level = Number(nd.level || 0);
  const canExpand  = level < currentDepth && !expandedInstances.has(instanceId);
  const alreadyExp = expandedInstances.has(instanceId);
  const hasDesc    = cy.getElementById(instanceId).successors().length > 0;

  const menu = document.getElementById('ctxMenu');
  document.getElementById('ctxExpand').classList.toggle('ctx-disabled', !canExpand);
  document.getElementById('ctxExpand').title = alreadyExp ? 'Déjà étendu' : (level >= currentDepth ? 'Profondeur max atteinte' : '');
  document.getElementById('ctxExpandLevel').title = `Étendre tous les nœuds du niveau ${level}`;
  document.getElementById('ctxCollapse').classList.toggle('ctx-disabled', !hasDesc);
  // Réduire tout ce niveau : actif si au moins un nœud de ce niveau est étendu
  const levelHasExpanded = cy.nodes().some(n => Number(n.data('level')) === level && expandedInstances.has(n.id()));
  document.getElementById('ctxCollapseLevel').classList.toggle('ctx-disabled', !levelHasExpanded);
  document.getElementById('ctxNodeInfo').textContent = `Nœud ${nd.segId} · Niveau ${level}`;

  const mainView = document.getElementById('main-view');
  const bounds = mainView.getBoundingClientRect();
  const x = Math.min(renderedPos.x + 8, bounds.width - 180);
  const y = Math.min(renderedPos.y + 8, bounds.height - 160);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  menu.style.display = 'block';
}

function hideCtxMenu() {
  document.getElementById('ctxMenu').style.display = 'none';
  ctxTargetId = '';
}

// ===== Positions initiales =====
function assignInitialPositions() {
  if (!cy || !cy.nodes().length) return;
  const width  = Math.max(320, cy.width());
  const height = Math.max(260, cy.height());
  const topY = Math.max(55, Math.round(height * 0.12));
  const sidePadding = 32;

  let maxLevel = 0;
  const byLevel = new Map();
  cy.nodes().forEach(n => {
    const lv = Number(n.data('level') || 0);
    maxLevel = Math.max(maxLevel, lv);
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(n);
  });

  const levelGap = Math.max(72, (height - topY - 40) / Math.max(1, maxLevel + 1));
  const parentByChild = new Map();
  const childrenByParent = new Map();
  cy.edges().forEach(e => {
    const src = e.source().id(), tgt = e.target().id();
    parentByChild.set(tgt, src);
    if (!childrenByParent.has(src)) childrenByParent.set(src, []);
    childrenByParent.get(src).push(tgt);
  });

  const xById = new Map();
  const roots0 = byLevel.get(0) || [];
  if (roots0.length === 1) xById.set(roots0[0].id(), width * 0.5);
  else roots0.forEach((n, i) => xById.set(n.id(), sidePadding + (roots0.length <= 1 ? 0.5 : i / (roots0.length - 1)) * (width - 2 * sidePadding)));

  for (let lv = 1; lv <= maxLevel; lv++) {
    const levelNodes = byLevel.get(lv) || [];
    const groups = new Map(), noParent = [];
    levelNodes.forEach(n => {
      const pid = parentByChild.get(n.id());
      if (pid && xById.has(pid)) { if (!groups.has(pid)) groups.set(pid, []); groups.get(pid).push(n); }
      else noParent.push(n);
    });
    let cursor = sidePadding;
    [...groups.keys()].sort((a, b) => (xById.get(a) || 0) - (xById.get(b) || 0)).forEach(pid => {
      const kids = groups.get(pid), childGap = 34, clusterW = (kids.length - 1) * childGap;
      let left = Math.max(cursor, (xById.get(pid) || width * 0.5) - clusterW * 0.5);
      left = Math.min(left, width - sidePadding - clusterW);
      kids.forEach((n, i) => xById.set(n.id(), left + i * childGap));
      cursor = Math.max(cursor, left + clusterW + 28);
    });
    noParent.forEach((n, i) => xById.set(n.id(), Math.max(cursor, sidePadding) + i * 34));
  }

  cy.startBatch();
  byLevel.forEach((list, lv) => {
    const y = topY + lv * levelGap;
    list.forEach(n => {
      const x = xById.get(n.id()) ?? width * 0.5;
      n.position({ x: Math.max(20, Math.min(width - 20, x + (lv === 0 ? 0 : (Math.random() - 0.5) * 6))), y });
    });
  });
  cy.endBatch();
}

// ===== Simulation physique =====
function runGravityLayout(params, ultraLight) {
  if (!cy || !cy.nodes().length) return;
  layoutRunToken++;
  const token = layoutRunToken;
  activeUltraLightRuns = 0;
  setLabelsVisible(true);
  if (ultraLight) { activeUltraLightRuns++; setLabelsVisible(false); }

  const width  = Math.max(320, cy.width());
  const height = Math.max(260, cy.height());
  const topY   = Math.max(55, Math.round(height * 0.12));

  let maxLevel = 0;
  cy.nodes().forEach(n => { maxLevel = Math.max(maxLevel, Number(n.data('level') || 0)); });
  const levelGap = Math.max(72, (height - topY - 40) / Math.max(1, maxLevel + 1));

  const parentByChild = new Map(), childrenByParent = new Map(), links = [];
  cy.edges().forEach(e => {
    const src = e.source().id(), tgt = e.target().id();
    parentByChild.set(tgt, src);
    if (!childrenByParent.has(src)) childrenByParent.set(src, []);
    childrenByParent.get(src).push(tgt);
    links.push({ source: src, target: tgt });
  });

  const siblingInfo = new Map();
  childrenByParent.forEach((children, pid) => {
    const sorted = [...children].sort();
    sorted.forEach((cid, idx) => siblingInfo.set(cid, { parentId: pid, siblingIndex: idx, siblingCount: sorted.length }));
  });

  const ids = cy.nodes().map(n => n.id());
  const state = new Map();
  ids.forEach(id => {
    const n = cy.getElementById(id), p = n.position();
    const lv = Number(n.data('level') || 0);
    const sib = siblingInfo.get(id) || { parentId: parentByChild.get(id) || '', siblingIndex: 0, siblingCount: 1 };
    state.set(id, { x: isFinite(p.x) ? p.x : width * 0.5, y: isFinite(p.y) ? p.y : topY + lv * levelGap, vx: 0, vy: 0, level: lv, targetY: topY + lv * levelGap, fixed: n.hasClass('root-node') && lv === 0, ...sib });
  });

  const blobsByKey = new Map(), blobGroups = [];
  ids.forEach(id => {
    const s = state.get(id);
    if (!s || !s.parentId || s.level <= 0) return;
    const key = `${s.parentId}::${s.level}`;
    if (!blobsByKey.has(key)) { const g = { key, parentId: s.parentId, level: s.level, nodeIds: [], cx: width * 0.5, cy: topY + s.level * levelGap, radius: 28 }; blobsByKey.set(key, g); blobGroups.push(g); }
    blobsByKey.get(key).nodeIds.push(id);
  });

  function recomputeBlobs() {
    blobGroups.forEach(g => {
      let sx = 0, sy = 0, n = 0;
      g.nodeIds.forEach(id => { const s = state.get(id); if (s) { sx += s.x; sy += s.y; n++; } });
      if (!n) return;
      g.cx = sx / n; g.cy = sy / n;
      let far = 0;
      g.nodeIds.forEach(id => { const s = state.get(id); if (s) far = Math.max(far, Math.hypot(s.x - g.cx, s.y - g.cy)); });
      g.radius = Math.max(24, Math.sqrt(n) * 18, far + 14);
    });
  }

  const { repulsion, springK, gravityK, centerXK, parentClusterK, sameLevelRepulsionK, siblingBlobAttractK, siblingBlobCenterK, blobCollisionK, blobCollisionGap, deepestDownK, damping, maxSpeed, steps } = params;
  const isLarge = ids.length >= 140;
  const renderStride = isLarge ? 3 : 2, blobStride = isLarge ? 2 : 1, collStride = isLarge ? 2 : 1;
  const farCutoff2 = Math.pow(Math.max(width, height) * 0.6, 2);
  const minSteps = Math.max(40, Math.round(steps * 0.3));
  const convThreshold = isLarge ? 0.1 : 0.07;
  const softPadX = Math.max(90, Math.round(width * 0.18)), softPadTop = Math.max(80, Math.round(height * 0.18)), softPadBot = Math.max(100, Math.round(height * 0.2));
  const clampX = width * 2.5, clampY = height * 2.5;
  let step = 0, stableTicks = 0, runFinalized = false;

  function finalize(fit) {
    if (runFinalized) return; runFinalized = true;
    if (ultraLight) { activeUltraLightRuns = Math.max(0, activeUltraLightRuns - 1); if (!activeUltraLightRuns) setLabelsVisible(true); } else setLabelsVisible(true);
    if (fit) cy.fit(undefined, 40);
  }

  function tick() {
    if (token !== layoutRunToken) { finalize(false); return; }
    step++;
    if (step === 1 || step % blobStride === 0) recomputeBlobs();

    const forces = new Map();
    ids.forEach(id => forces.set(id, { fx: 0, fy: 0 }));

    for (let i = 0; i < ids.length; i++) {
      const a = state.get(ids[i]);
      for (let j = i + 1; j < ids.length; j++) {
        const b = state.get(ids[j]);
        const sameParent = a.parentId && a.parentId === b.parentId;
        if (!sameParent && Math.abs(a.level - b.level) > 2) continue;
        let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
        if (d2 < 25) { dx += (Math.random() - 0.5) * 4; dy += (Math.random() - 0.5) * 4; d2 = dx * dx + dy * dy; }
        if (!sameParent && a.level !== b.level && d2 > farCutoff2) continue;
        const d = Math.max(1e-6, Math.sqrt(d2));
        const scale = sameParent ? 0.2 : (a.level === b.level ? 0.66 : 1.0);
        const f = repulsion * scale / Math.max(90, d2), fx = f * dx / d, fy = f * dy / d;
        forces.get(ids[i]).fx -= fx; forces.get(ids[i]).fy -= fy;
        forces.get(ids[j]).fx += fx; forces.get(ids[j]).fy += fy;
        if (a.level === b.level && a.level < maxLevel) {
          const lf = sameLevelRepulsionK / Math.max(120, d2), lfx = lf * dx / d, lfy = lf * dy / d;
          forces.get(ids[i]).fx -= lfx; forces.get(ids[i]).fy -= lfy * 0.2;
          forces.get(ids[j]).fx += lfx; forces.get(ids[j]).fy += lfy * 0.2;
        }
      }
    }

    blobGroups.forEach(g => {
      const n = g.nodeIds.length; if (!n) return;
      const slotR = Math.min(g.radius * 0.58, 22 + n * 3.2), arcSpan = Math.min(Math.PI * 1.35, Math.max(Math.PI * 0.55, (n - 1) * 0.45));
      g.nodeIds.forEach(id => {
        const s = state.get(id), f = forces.get(id);
        const t = n <= 1 ? 0.5 : s.siblingIndex / (n - 1), angle = -Math.PI * 0.5 + (t - 0.5) * arcSpan;
        f.fx += (g.cx + Math.cos(angle) * slotR - s.x) * siblingBlobAttractK;
        f.fy += (g.cy + Math.sin(angle) * slotR * 0.58 - s.y) * siblingBlobAttractK;
        f.fx += (g.cx - s.x) * siblingBlobCenterK; f.fy += (g.cy - s.y) * siblingBlobCenterK;
      });
    });

    if (step % collStride === 0) {
      for (let i = 0; i < blobGroups.length; i++) {
        const a = blobGroups[i]; if (!a.nodeIds.length) continue;
        for (let j = i + 1; j < blobGroups.length; j++) {
          const b = blobGroups[j]; if (!b.nodeIds.length || a.level !== b.level) continue;
          let dx = b.cx - a.cx, dy = (b.cy - a.cy) * 0.72, d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = (Math.random() - 0.5) * 2; dy = (Math.random() - 0.5) * 2; d2 = dx * dx + dy * dy; }
          const d = Math.max(1e-6, Math.sqrt(d2)), minD = a.radius + b.radius + blobCollisionGap;
          if (d >= minD) continue;
          const push = (minD - d) * blobCollisionK, nx = dx / d, ny = dy / d;
          const ac = Math.max(1, a.nodeIds.length), bc = Math.max(1, b.nodeIds.length);
          a.nodeIds.forEach(id => { const f = forces.get(id); if (f) { f.fx -= nx * push / ac; f.fy -= ny * push * 0.4 / ac; } });
          b.nodeIds.forEach(id => { const f = forces.get(id); if (f) { f.fx += nx * push / bc; f.fy += ny * push * 0.4 / bc; } });
        }
      }
    }

    links.forEach(({ source: src, target: tgt }) => {
      const a = state.get(src), b = state.get(tgt); if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.max(1e-6, Math.hypot(dx, dy));
      const f = springK * (d - (92 + Math.abs(a.level - b.level) * 18));
      forces.get(src).fx += f * dx / d; forces.get(src).fy += f * dy / d;
      forces.get(tgt).fx -= f * dx / d; forces.get(tgt).fy -= f * dy / d;
    });

    let speedAcc = 0;
    ids.forEach(id => {
      const s = state.get(id), f = forces.get(id);
      const lr = maxLevel > 0 ? s.level / maxLevel : 0;
      f.fy += (s.targetY - s.y) * gravityK * (0.9 + 0.35 * lr);
      f.fx += (width * 0.5 - s.x) * centerXK * (s.level === 0 ? 1.0 : s.level === 1 ? 0.2 : 0.0);
      if (s.parentId && state.has(s.parentId)) {
        const p = state.get(s.parentId), spread = s.siblingCount <= 1 ? 0 : (s.siblingIndex - (s.siblingCount - 1) * 0.5) * 26;
        f.fx += (p.x + spread - s.x) * parentClusterK;
        f.fy += (p.y + Math.max(40, levelGap * 0.72) - s.y) * parentClusterK * 0.52;
      }
      if (maxLevel > 0 && s.level === maxLevel) f.fy += (height - 32 - s.y) * deepestDownK;
      if (s.x < -softPadX) f.fx += (-softPadX - s.x) * 0.02;
      if (s.x > width + softPadX) f.fx += (width + softPadX - s.x) * 0.02;
      if (s.y < -softPadTop) f.fy += (-softPadTop - s.y) * 0.02;
      if (s.y > height + softPadBot) f.fy += (height + softPadBot - s.y) * 0.025;

      if (s.fixed) { f.fx += (width * 0.5 - s.x) * 0.3; f.fy += (topY - s.y) * 0.3; s.vx = 0; s.vy = 0; s.x += f.fx * 0.5; s.y += f.fy * 0.5; return; }
      s.vx = (s.vx + f.fx) * damping; s.vy = (s.vy + f.fy) * damping;
      const speed = Math.hypot(s.vx, s.vy); speedAcc += speed;
      if (speed > maxSpeed) { s.vx = s.vx / speed * maxSpeed; s.vy = s.vy / speed * maxSpeed; }
      s.x = Math.max(-clampX, Math.min(width + clampX, s.x + s.vx));
      s.y = Math.max(-clampY, Math.min(height + clampY, s.y + s.vy));
    });

    const avgSpeed = speedAcc / Math.max(1, ids.length);
    if (step >= minSteps) stableTicks = avgSpeed < convThreshold ? stableTicks + 1 : 0;
    const shouldStop = step >= steps || stableTicks >= 8;
    if (step % renderStride === 0 || shouldStop) {
      cy.startBatch();
      ids.forEach(id => { const n = cy.getElementById(id), s = state.get(id); if (n && s) n.position({ x: s.x, y: s.y }); });
      cy.endBatch();
    }
    if (!shouldStop) requestAnimationFrame(tick); else finalize(true);
  }
  requestAnimationFrame(tick);
}

// ===== Rendu principal (mode BFS complet) =====
function renderTree() {
  maxTreeNodes = Math.max(50, Math.min(10000, parseInt(document.getElementById('inputMaxNodes')?.value || '1500', 10)));
  nodeCounter = 0; // reset du compteur à chaque rebuild complet

  if (expandMode) { initExpandTree(); return; }

  const { nodes, edges, truncated, maxDepthReached } = buildTree(rootIds, currentDepth, activeTypes, maxTreeNodes);

  if (!cy) {
    cy = cytoscape({ container: document.getElementById('cy'), elements: [...nodes, ...edges], style: buildStylesheet(), wheelSensitivity: 0.2, layout: { name: 'preset', fit: false } });
  } else {
    cy.elements().remove();
    cy.style(buildStylesheet());
    cy.add([...nodes, ...edges]);
  }

  assignInitialPositions();
  runGravityLayout(currentParams, currentUltraLight);

  document.getElementById('statRoots').textContent = rootIds.length;
  document.getElementById('statNodes').textContent = nodes.length;
  document.getElementById('statEdges').textContent = edges.length;
  document.getElementById('statDepth').textContent = maxDepthReached;

  updateTotals();

  if (truncated) {
    const { count: total, capped } = countTreeNodes(rootIds, currentDepth, activeTypes);
    const totalStr = capped ? `>${total.toLocaleString('fr-CA')}` : total.toLocaleString('fr-CA');
    showBanner(`⚠ Arbre tronqué : ${nodes.length.toLocaleString('fr-CA')} nœuds affichés sur un total de ${totalStr} disponibles. Augmentez la limite ou réduisez la profondeur.`);
  } else {
    hideBanner();
  }
}

// ===== Tooltip =====
function makeTooltip() {
  const el = document.createElement('div');
  el.id = 'calcTooltip';
  el.style.cssText = 'position:absolute;display:none;pointer-events:none;background:rgba(37,40,64,0.97);border:1px solid #353a60;border-radius:6px;padding:7px 10px;font-size:0.74rem;color:#fff;max-width:240px;z-index:2000;box-shadow:0 4px 12px rgba(0,0,0,0.4);line-height:1.5;';
  document.getElementById('main-view').appendChild(el);
  return el;
}

// ===== Sidebar =====
function buildSidebar() {
  document.getElementById('rootList').textContent = rootIds.length ? rootIds.join(', ') : 'Aucun nœud sélectionné.';

  const slider = document.getElementById('depthSlider');
  const depthVal = document.getElementById('depthValue');
  slider.value = currentDepth;
  depthVal.textContent = currentDepth;
  slider.addEventListener('input', () => {
    currentDepth = parseInt(slider.value, 10);
    depthVal.textContent = currentDepth;
    updateTotals();
    if (!expandMode) renderTree();
  });

  // Checkbox "Ne pas étendre"
  const chkExpand = document.getElementById('chkExpandMode');
  if (chkExpand) {
    chkExpand.checked = expandMode;
    chkExpand.addEventListener('change', e => {
      expandMode = e.target.checked;
      nodeCounter = 0;
      renderTree();
    });
  }

  // Cases types de relations
  const wrap = document.getElementById('relTypeCheckboxes');
  for (const t of SERVER_META.types_relations) {
    const label = document.createElement('label');
    label.className = 'chk-row';
    label.innerHTML = `<input type="checkbox" data-rel="${t}" checked><span class="legend-line" style="background:${SERVER_META.couleurs[t] || '#888'};"></span><span>${t}</span>`;
    wrap.appendChild(label);
  }
  wrap.addEventListener('change', () => {
    activeTypes = new Set([...wrap.querySelectorAll('input:checked')].map(cb => cb.dataset.rel));
    updateTotals();
    renderTree();
  });

  // Légende
  const legend = document.getElementById('legend');
  for (const t of SERVER_META.types_relations) {
    const row = document.createElement('div');
    row.className = 'chk-row'; row.style.cursor = 'default';
    row.innerHTML = `<span class="legend-line" style="background:${SERVER_META.couleurs[t] || '#888'};"></span><span style="font-size:0.78rem;">${t}</span>`;
    legend.appendChild(row);
  }

  // Actions
  document.getElementById('btnFit').addEventListener('click', () => cy?.fit(undefined, 40));
  document.getElementById('btnRebuild').addEventListener('click', () => { nodeCounter = 0; expandedInstances.clear(); renderTree(); });
  document.getElementById('btnRelayout').addEventListener('click', () => { if (cy?.nodes().length) runGravityLayout(currentParams, currentUltraLight); });
  document.getElementById('btnEdgeHover')?.addEventListener('click', () => {
    edgeHoverActive = !edgeHoverActive;
    const btn = document.getElementById('btnEdgeHover');
    if (edgeHoverActive) {
      btn.textContent = '🔍 Désactiver hover liens';
      btn.classList.add('primary');
    } else {
      btn.textContent = '🔍 Activer hover liens';
      btn.classList.remove('primary');
    }
  });

  // Afficher dans le graphe abstrait
  const _vizChannel = new BroadcastChannel('relations-segments-sync');
  document.getElementById('btnShowInGraph').addEventListener('click', () => {
    if (!cy || !cy.nodes().length) { flashBanner('Aucun nœud à afficher.'); return; }
    const levels = {};
    cy.nodes().forEach(n => {
      const segId = n.data('segId'), lv = Number(n.data('level'));
      if (!(segId in levels) || lv < levels[segId]) levels[segId] = lv;
    });
    const maxLevel = Math.max(0, ...Object.values(levels));
    _vizChannel.postMessage({ type: 'calc_highlight', from: SyncBus.tabId, levels, maxLevel });
    flashBanner('Nœuds envoyés au graphe abstrait.');
  });

  // Params layout
  const { params: savedParams, ultraLightMode: savedUL, fromCache } = loadParams();
  currentParams = savedParams; currentUltraLight = savedUL;
  writeParamsToUI(currentParams);
  const chkUL = document.getElementById('chkUltraLight');
  if (chkUL) chkUL.checked = currentUltraLight;
  setParamsStatus(fromCache ? 'Paramètres restaurés depuis le cache.' : 'Paramètres par défaut actifs.', false);

  document.getElementById('btnApplyParams')?.addEventListener('click', () => {
    currentParams = readParamsFromUI(); currentUltraLight = document.getElementById('chkUltraLight')?.checked ?? true;
    writeParamsToUI(currentParams); setParamsStatus('Paramètres appliqués (non sauvegardés).', false);
    if (cy?.nodes().length) runGravityLayout(currentParams, currentUltraLight);
  });
  document.getElementById('btnSaveParams')?.addEventListener('click', () => {
    currentParams = readParamsFromUI(); currentUltraLight = document.getElementById('chkUltraLight')?.checked ?? true;
    writeParamsToUI(currentParams);
    setParamsStatus(saveParams(currentParams, currentUltraLight) ? 'Paramètres sauvegardés.' : 'Erreur sauvegarde localStorage.', false);
    if (cy?.nodes().length) runGravityLayout(currentParams, currentUltraLight);
  });
  document.getElementById('btnResetParams')?.addEventListener('click', () => {
    currentParams = defaultParams(); currentUltraLight = true;
    writeParamsToUI(currentParams);
    const chk = document.getElementById('chkUltraLight'); if (chk) chk.checked = true;
    try { localStorage.removeItem(LAYOUT_STORAGE_KEY); } catch {}
    setParamsStatus('Paramètres réinitialisés aux valeurs par défaut.', false);
    if (cy?.nodes().length) runGravityLayout(currentParams, currentUltraLight);
  });
}

// ===== Démarrage =====
(async function start() {
  await DataLoader.loadAll(dataMode);
  buildSidebar();

  const tooltip = makeTooltip();
  let tooltipScheduled = false;

  if (rootIds.length === 0) {
    document.getElementById('rootList').textContent = 'Aucun nœud — revenez sur /graphe, sélectionnez des nœuds, puis cliquez sur « Visualiser le graphe de calcul ».';
    return;
  }

  renderTree();

  // Attendre que cy soit initialisé
  setTimeout(() => {
    if (!cy) return;

    // Tooltip nœuds
    cy.on('mouseover', 'node', evt => {
      const d = evt.target.data();
      const lignesLine = dataMode === 'fusion'
        ? `Lignes : ${(DataLoader.liaison.get(Number(d.segId))?.routes || []).join(', ')}`
        : '';
      tooltip.innerHTML = [`<b>${d.segLabel}</b>`, `Segment id : ${d.segId}`, lignesLine, `Niveau : ${d.level}`, expandedInstances.has(d.id) ? '(étendu)' : ''].filter(Boolean).join('<br>');
      tooltip.style.display = 'block';
    });
    cy.on('mousemove', 'node', evt => {
      if (!tooltipScheduled) {
        tooltipScheduled = true;
        requestAnimationFrame(() => {
          tooltipScheduled = false;
          const p = evt.renderedPosition || { x: 0, y: 0 };
          tooltip.style.left = (p.x + 12) + 'px'; tooltip.style.top = (p.y + 12) + 'px';
        });
      }
    });
    cy.on('mouseout', 'node', () => { tooltip.style.display = 'none'; });

    // Tooltip arêtes
    cy.on('mouseover', 'edge', evt => {
      if (!edgeHoverActive) return;
      const d = evt.target.data();
      const srcNode = cy.getElementById(d.source);
      const tgtNode = cy.getElementById(d.target);
      const color = SERVER_META.couleurs[d.relType] || '#888';
      let html = `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};margin-right:5px;vertical-align:middle;"></span>`
               + `<b>${d.relType || '?'}</b><br>`
               + `${srcNode.data('segLabel') || d.source} → ${tgtNode.data('segLabel') || d.target}`;
      tooltip.innerHTML = html;
      tooltip.style.display = 'block';
    });
    cy.on('mousemove', 'edge', evt => {
      if (!edgeHoverActive) return;
      if (!tooltipScheduled) {
        tooltipScheduled = true;
        requestAnimationFrame(() => {
          tooltipScheduled = false;
          const p = evt.renderedPosition || { x: 0, y: 0 };
          tooltip.style.left = (p.x + 12) + 'px'; tooltip.style.top = (p.y + 12) + 'px';
        });
      }
    });
    cy.on('mouseout', 'edge', () => { tooltip.style.display = 'none'; });

    // Clic droit → menu contextuel
    cy.on('cxttap', 'node', evt => {
      tooltip.style.display = 'none';
      showCtxMenu(evt.renderedPosition || { x: 0, y: 0 }, evt.target.id());
    });

    // Clic dans le vide → fermer menu
    cy.on('tap', () => hideCtxMenu());

    // Boutons du menu contextuel
    document.getElementById('ctxExpand').addEventListener('click', () => {
      if (!document.getElementById('ctxExpand').classList.contains('ctx-disabled')) expandNode(ctxTargetId);
      hideCtxMenu();
    });
    document.getElementById('ctxExpandLevel').addEventListener('click', () => {
      const lv = Number(cy.getElementById(ctxTargetId)?.data('level') || 0);
      expandLevel(lv);
      hideCtxMenu();
    });
    document.getElementById('ctxCollapse').addEventListener('click', () => {
      if (!document.getElementById('ctxCollapse').classList.contains('ctx-disabled')) collapseNode(ctxTargetId);
      hideCtxMenu();
    });
    document.getElementById('ctxCollapseLevel').addEventListener('click', () => {
      const lv = Number(cy.getElementById(ctxTargetId)?.data('level') || 0);
      collapseLevel(lv);
      hideCtxMenu();
    });
    document.getElementById('ctxClose').addEventListener('click', hideCtxMenu);
    document.addEventListener('click', e => { if (!document.getElementById('ctxMenu').contains(e.target)) hideCtxMenu(); });
  }, 200);
})();
