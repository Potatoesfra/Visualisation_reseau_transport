/* =====================================================
   sync.js — Synchronisation entre la carte et le graphe
   via BroadcastChannel (API navigateur native).
   ===================================================== */

const SyncBus = (function() {
  const CHANNEL_NAME = "relations-segments-sync";
  const channel = new BroadcastChannel(CHANNEL_NAME);

  // Identifiant unique de cet onglet (évite l'écho)
  const tabId = Math.random().toString(36).slice(2, 10);

  // Sélection courante (set de segment_id en int)
  const state = {
    selectedIds: new Set(),
    activeRelTypes: new Set(),  // types de relations cochés
    visibleLines: new Set(),    // route_id filtrés ; vide = toutes
    visibleParcours: new Set(), // shape_id (parcours) filtrés ; affine visibleLines
    showStops: true,
    mode: "normal",             // "normal" | "fusion"
  };

  const handlers = {
    selectionChanged: [],
    filterChanged: [],
    peerStateRequested: [],
    modeChanged: [],
  };

  channel.onmessage = function(evt) {
    const msg = evt.data;
    if (!msg || msg.from === tabId) return;  // ignore l'écho

    switch (msg.type) {
      case "selection":
        applySelectionFromPeer(msg.ids);
        break;
      case "filter":
        if (msg.activeRelTypes)  state.activeRelTypes   = new Set(msg.activeRelTypes);
        if (msg.visibleLines)    state.visibleLines     = new Set(msg.visibleLines);
        if (msg.visibleParcours) state.visibleParcours  = new Set(msg.visibleParcours);
        if (typeof msg.showStops === "boolean") state.showStops = msg.showStops;
        handlers.filterChanged.forEach(fn => fn(state));
        break;
      case "mode":
        if (msg.mode && msg.mode !== state.mode) {
          state.mode = msg.mode;
          handlers.modeChanged.forEach(fn => fn(state.mode, /*fromPeer=*/true));
        }
        break;
      case "request_state":
        // Un onglet vient de s'ouvrir et nous demande notre état
        channel.postMessage({
          type: "selection",
          from: tabId,
          ids: Array.from(state.selectedIds),
        });
        break;
    }
  };

  function applySelectionFromPeer(ids) {
    state.selectedIds = new Set(ids.map(Number));
    handlers.selectionChanged.forEach(fn => fn(state.selectedIds, /*fromPeer=*/true));
  }

  function broadcastSelection() {
    channel.postMessage({
      type: "selection",
      from: tabId,
      ids: Array.from(state.selectedIds),
    });
  }

  // ===== API publique =====

  return {
    // Sélection
    select: function(id, additive=false) {
      const i = Number(id);
      if (additive) {
        if (state.selectedIds.has(i)) {
          state.selectedIds.delete(i);
        } else {
          state.selectedIds.add(i);
        }
      } else {
        // toggle simple : si déjà seul élément, désélectionne ; sinon remplace
        if (state.selectedIds.size === 1 && state.selectedIds.has(i)) {
          state.selectedIds.clear();
        } else {
          state.selectedIds.clear();
          state.selectedIds.add(i);
        }
      }
      handlers.selectionChanged.forEach(fn => fn(state.selectedIds, /*fromPeer=*/false));
      broadcastSelection();
    },

    addMany: function(ids) {
      ids.forEach(i => state.selectedIds.add(Number(i)));
      handlers.selectionChanged.forEach(fn => fn(state.selectedIds, false));
      broadcastSelection();
    },

    setSelection: function(ids) {
      state.selectedIds = new Set(ids.map(Number));
      handlers.selectionChanged.forEach(fn => fn(state.selectedIds, false));
      broadcastSelection();
    },

    clear: function() {
      if (state.selectedIds.size === 0) return;
      state.selectedIds.clear();
      handlers.selectionChanged.forEach(fn => fn(state.selectedIds, false));
      broadcastSelection();
    },

    getSelection: function() { return new Set(state.selectedIds); },

    // Filtres
    setRelTypes: function(types) {
      state.activeRelTypes = new Set(types);
      handlers.filterChanged.forEach(fn => fn(state));
      channel.postMessage({
        type: "filter",
        from: tabId,
        activeRelTypes: Array.from(state.activeRelTypes),
      });
    },

    setVisibleLines: function(lines) {
      state.visibleLines = new Set(lines);
      handlers.filterChanged.forEach(fn => fn(state));
      channel.postMessage({
        type: "filter",
        from: tabId,
        visibleLines: Array.from(state.visibleLines),
      });
    },

    setVisibleParcours: function(parcours) {
      state.visibleParcours = new Set(parcours);
      handlers.filterChanged.forEach(fn => fn(state));
      channel.postMessage({
        type: "filter",
        from: tabId,
        visibleParcours: Array.from(state.visibleParcours),
      });
    },

    setShowStops: function(show) {
      state.showStops = !!show;
      handlers.filterChanged.forEach(fn => fn(state));
      channel.postMessage({
        type: "filter",
        from: tabId,
        showStops: state.showStops,
      });
    },

    // Mode segments ("normal" | "fusion") — propagé aux autres onglets
    setMode: function(mode) {
      if (mode === state.mode) return;
      state.mode = mode;
      handlers.modeChanged.forEach(fn => fn(state.mode, /*fromPeer=*/false));
      channel.postMessage({ type: "mode", from: tabId, mode: state.mode });
    },

    getMode: function() { return state.mode; },

    getState: function() { return state; },

    // Événements
    onSelectionChange: function(fn) { handlers.selectionChanged.push(fn); },
    onFilterChange: function(fn) { handlers.filterChanged.push(fn); },
    onModeChange: function(fn) { handlers.modeChanged.push(fn); },

    // Au démarrage, demander l'état du peer (au cas où l'autre fenêtre est déjà ouverte)
    requestPeerState: function() {
      channel.postMessage({ type: "request_state", from: tabId });
    },

    // Message libre vers les autres onglets (tracé de voyage, position du bus…).
    // Les types inconnus de sync.js sont traités par les pages qui les écoutent.
    post: function(msg) {
      channel.postMessage({ ...msg, from: tabId });
    },

    tabId: tabId,
    channelName: CHANNEL_NAME,
  };
})();


/* =====================================================
   API de chargement des données
   ===================================================== */

const DataLoader = {
  segments: null,
  relations: null,
  stops: null,
  meta: null,
  mode: "normal",
  liaison: new Map(),   // mode fusion : segment_id -> { routes:[...], segments:[{seg_id,route_id,shape_id}] }

  async loadAll(mode = "normal") {
    const q = `?mode=${encodeURIComponent(mode)}`;
    const [segs, rels, stops, meta, liaison] = await Promise.all([
      fetch("/api/segments" + q).then(r => r.json()),
      fetch("/api/relations" + q).then(r => r.json()),
      fetch("/api/stops").then(r => r.json()),
      fetch("/api/meta" + q).then(r => r.json()),
      fetch("/api/liaison" + q).then(r => r.json()),
    ]);
    this.mode = mode;
    this.segments = segs;
    this.relations = rels;
    this.stops = stops;
    this.meta = meta;

    // Dictionnaire de liaison (clés -> Number)
    this.liaison = new Map(Object.entries(liaison).map(([k, v]) => [Number(k), v]));

    // Index par segment_id
    this.segmentById = new Map(segs.map(s => [s.id, s]));

    // Index des relations par segment
    this.relationsBySegment = new Map();
    for (const r of rels) {
      if (!this.relationsBySegment.has(r.a)) this.relationsBySegment.set(r.a, []);
      if (!this.relationsBySegment.has(r.b)) this.relationsBySegment.set(r.b, []);
      this.relationsBySegment.get(r.a).push(r);
      this.relationsBySegment.get(r.b).push(r);
    }
    return this;
  },

  getRelationsFor(segId, activeTypes=null) {
    const rels = this.relationsBySegment.get(Number(segId)) || [];
    if (!activeTypes) return rels;
    return rels.filter(r => activeTypes.has(r.type));
  },

  getRelationsBetween(idsSet, activeTypes=null) {
    /* Toutes les relations dont AU MOINS UN bout est dans idsSet */
    return this.relations.filter(r => {
      if (!idsSet.has(r.a) && !idsSet.has(r.b)) return false;
      if (activeTypes && !activeTypes.has(r.type)) return false;
      return true;
    });
  },
};


/* =====================================================
   Helpers d'affichage
   ===================================================== */

// Bloc HTML listant les segments d'origine d'un nœud fusionné (mode fusion).
// Renvoie "" si le nœud n'a pas d'entrée de liaison.
function renderFusionBlock(segId) {
  const info = DataLoader.liaison.get(Number(segId));
  if (!info || !Array.isArray(info.segments)) return "";
  const segs = info.segments;
  let html = `<div class="rel-block"><div class="rel-title">Segments fusionnés (${segs.length})</div>`;
  for (const s of segs) {
    html += `<div class="seg-row"><div class="k">Seg. ${s.seg_id}</div>`
          + `<div class="v">ligne ${s.route_id}</div></div>`;
  }
  html += `</div>`;
  return html;
}

// Attributs (ajout_features_segments.py) affichés en blocs groupés.
// Chaque ligne : [clé du payload, libellé, unité].
const ATTR_GROUPS = [
  { title: "Géographie", rows: [
    ["distance_m",       "Distance",         " m"],
    ["sinuosite",        "Sinuosité",        ""],
    ["orientation_deg",  "Orientation",      " °"],
    ["altitude_debut_m", "Altitude départ",  " m"],
    ["altitude_fin_m",   "Altitude arrivée", " m"],
    ["denivele_pos_m",   "Dénivelé +",       " m"],
    ["denivele_neg_m",   "Dénivelé −",       " m"],
    ["pente_moy_pct",    "Pente moyenne",    " %"],
  ]},
  { title: "Réseau", rows: [
    ["highway",            "Type de route",  ""],
    ["surface",            "Surface",        ""],
    ["nb_voies",           "Voies",          ""],
    ["sens_unique",        "Sens unique",    ""],
    ["vitesse_limite_kmh", "Vitesse limite", " km/h"],
    ["nb_feux",            "Feux",           ""],
    ["etat_chaussee",      "État chaussée",  ""],
  ]},
  { title: "Énergie (road-load)", rows: [
    ["energie_traction_totale_kJ", "Traction totale", " kJ"],
    ["energie_pot_nette_kJ",       "Ep nette",        " kJ"],
    ["energie_pot_montee_kJ",      "Ep montée",       " kJ"],
    ["energie_pot_descente_kJ",    "Ep descente",     " kJ"],
    ["travail_roulement_kJ",       "Roulement",       " kJ"],
    ["travail_aero_kJ",            "Aéro",            " kJ"],
    ["energie_arrets_kJ",          "Arrêts",          " kJ"],
    ["energie_regen_kJ",           "Regen",           " kJ"],
    ["taux_regen_pct",             "Taux regen",      " %"],
    ["coef_roulement",             "C_rr",            ""],
    ["vitesse_calc_kmh",           "Vitesse utilisée"," km/h"],
  ]},
];

function _fmtAttr(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number")
    return Number.isInteger(v) ? String(v)
         : v.toLocaleString("fr-CA", { maximumFractionDigits: 2 });
  return String(v);
}

// Construit les blocs HTML d'attributs d'un segment (vide si pas d'attributs).
function renderAttributsBlocks(seg) {
  const a = seg && seg.attributs;
  if (!a || Object.keys(a).length === 0) return "";
  let html = "";
  for (const g of ATTR_GROUPS) {
    const rows = g.rows.filter(([k]) => k in a);
    if (!rows.length) continue;
    html += `<div class="rel-block"><div class="rel-title">${g.title}</div>`;
    for (const [k, label, unit] of rows) {
      const val = _fmtAttr(a[k]);
      const suffix = (a[k] === null || a[k] === undefined) ? "" : unit;
      html += `<div class="seg-row"><div class="k">${label}</div><div class="v">${val}${suffix}</div></div>`;
    }
    html += `</div>`;
  }

  // Bloc dynamique : distance parcourue sous chaque limite de vitesse
  const vrows = Object.keys(a)
    .filter(k => /^dist_vmax_/.test(k) && a[k] != null && a[k] > 0)
    .map(k => {
      const m = k.match(/^dist_vmax_(\d+)_m$/);
      return {
        speed: m ? parseInt(m[1], 10) : Infinity,
        label: m ? `Distance ${m[1]} km/h max` : "Distance limite inconnue",
        val: a[k],
      };
    })
    .sort((x, y) => x.speed - y.speed);
  if (vrows.length) {
    html += `<div class="rel-block"><div class="rel-title">Vitesses (par limite)</div>`;
    for (const r of vrows)
      html += `<div class="seg-row"><div class="k">${r.label}</div><div class="v">${_fmtAttr(r.val)} m</div></div>`;
    html += `</div>`;
  }
  return html;
}

function setupSyncStatus() {
  const status = document.getElementById("sync-status");
  if (!status) return;
  // Le statut reste "connecté" tant que BroadcastChannel fonctionne
  // (impossible de détecter directement le peer, mais on peut afficher tab id)
  const sp = status.querySelector(".label");
  if (sp) sp.textContent = "Synchronisation active (onglet " + SyncBus.tabId + ")";
}


/* =====================================================
   Sidebar repliable — mutualisé aux 3 pages
   ===================================================== */

function setupSidebarCollapse() {
  const panel = document.getElementById("panel");
  if (!panel) return;

  // Barre de repli insérée en tête du panneau
  const bar = document.createElement("div");
  bar.className = "panel-collapse-bar";
  const btn = document.createElement("button");
  btn.id = "btnCollapseSidebar";
  btn.className = "collapse-btn";
  btn.title = "Replier / Épingler le panneau";
  btn.textContent = "‹‹";
  bar.appendChild(btn);
  panel.prepend(bar);

  // Zone-bord gauche révélatrice
  const edge = document.createElement("div");
  edge.id = "sidebar-edge";
  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "›";
  edge.appendChild(chev);
  document.body.appendChild(edge);

  function isCollapsed() {
    return document.body.classList.contains("sidebar-collapsed");
  }

  function collapse() {
    document.body.classList.add("sidebar-collapsed");
    document.body.classList.remove("peek");
    btn.textContent = "››";
    btn.title = "Épingler le panneau ouvert";
  }

  function expand() {
    document.body.classList.remove("sidebar-collapsed", "peek");
    btn.textContent = "‹‹";
    btn.title = "Replier le panneau";
  }

  // Clic sur le bouton : bascule
  btn.addEventListener("click", () => {
    if (isCollapsed()) expand(); else collapse();
  });

  // Survol de la zone bord → peek (overlay temporaire)
  edge.addEventListener("mouseenter", () => {
    if (isCollapsed()) document.body.classList.add("peek");
  });

  // Clic sur la zone bord → épingler ouvert
  edge.addEventListener("click", () => {
    if (isCollapsed()) expand();
  });

  // Quitter le panneau en overlay → retirer peek
  panel.addEventListener("mouseleave", () => {
    if (isCollapsed()) document.body.classList.remove("peek");
  });
}

// Auto-exécution après le chargement du DOM
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupSidebarCollapse);
} else {
  setupSidebarCollapse();
}
