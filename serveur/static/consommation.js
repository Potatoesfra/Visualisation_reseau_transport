/* =====================================================
   consommation.js — Page Consommation (Plotly)
   Trace la consommation réelle segment par segment pour
   un voyage ou une agrégation (mois×parcours, temp×parcours).
   Clic sur un segment → sélection propagée à la carte via SyncBus.
   ===================================================== */

const MOIS_LABELS = ["", "Jan", "Fév", "Mar", "Avr", "Mai", "Juin",
                     "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];

const ConsoState = {
  options: null,
  unit: "wh",            // "wh" | "kwh_km"
  showMean: false,
  decompose: false,
  lastProfil: null,      // dernière réponse /api/conso/profil
  segIdByCurve: [],      // index x -> segment_id (pour le clic)
  tracerSurCarte: true,  // demander à la carte de tracer le voyage sélectionné
};

// Demande à l'onglet carte de tracer le voyage (ouvre la carte si besoin).
function demanderTraceVoyage(voyageId) {
  if (!ConsoState.tracerSurCarte || voyageId == null) return;
  SyncBus.post({ type: "trace_voyage", voyage: Number(voyageId) });
}

// ===== Utilitaires UI =====
function getSelMode() {
  return document.querySelector('input[name="selMode"]:checked').value;
}

function setStat(id, val) { document.getElementById(id).textContent = val; }

function updateModeBlocks() {
  const mode = getSelMode();
  document.getElementById("blockVoyage").style.display = (mode === "voyage") ? "" : "none";
  document.getElementById("blockMois").style.display   = (mode === "mois")   ? "" : "none";
  document.getElementById("blockTemp").style.display   = (mode === "temp")   ? "" : "none";
}

// ===== Chargement des options =====
async function loadOptions() {
  const opt = await fetch("/api/conso/options").then(r => r.json());
  ConsoState.options = opt;
  if (!opt.disponible) {
    document.getElementById("hintText").textContent =
      "Données de consommation absentes — lancez pipeline/p06_conso_synthetique.py.";
    return;
  }

  // Parcours
  const sel = document.getElementById("parcoursSelect");
  sel.innerHTML = "";
  for (const pc of opt.parcours) {
    const o = document.createElement("option");
    o.value = pc; o.textContent = pc; o.dataset.label = pc.toLowerCase();
    sel.appendChild(o);
  }
  document.getElementById("parcoursSearch").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    for (const o of sel.options) {
      const m = !q || o.dataset.label.includes(q);
      o.hidden = !m; o.style.display = m ? "" : "none";
    }
  });
  sel.addEventListener("change", () => {
    if (getSelMode() === "voyage") loadVoyages(sel.value);
  });

  // Mois
  const moisWrap = document.getElementById("moisCheckboxes");
  moisWrap.innerHTML = "";
  for (const m of opt.mois) {
    const label = document.createElement("label");
    label.className = "chk-row";
    label.innerHTML = `<input type="checkbox" value="${m}"> ${MOIS_LABELS[m] || m}`;
    moisWrap.appendChild(label);
  }

  // Température (bornes par défaut)
  if (opt.temp_min != null) document.getElementById("tempMin").value = Math.floor(opt.temp_min);
  if (opt.temp_max != null) document.getElementById("tempMax").value = Math.ceil(opt.temp_max);
}

// ===== Liste des voyages d'un parcours =====
async function loadVoyages(parcours) {
  const sel = document.getElementById("voyageSelect");
  const hint = document.getElementById("voyageHint");
  if (!parcours) { sel.innerHTML = ""; hint.textContent = "Choisissez d'abord un parcours."; return; }
  hint.textContent = "Chargement…";
  const voyages = await fetch("/api/conso/voyages?parcours=" + encodeURIComponent(parcours))
                        .then(r => r.json());
  sel.innerHTML = "";
  for (const v of voyages) {
    const o = document.createElement("option");
    o.value = v.voyage_id;
    const t = (v.temperature_C != null) ? `${v.temperature_C}°C` : "—";
    const kwh = (v.conso_totale_Wh != null) ? `${(v.conso_totale_Wh / 1000).toFixed(1)} kWh` : "";
    o.textContent = `${v.voyage_id} · ${MOIS_LABELS[v.mois] || ""} · ${t} · ${kwh}`;
    o.dataset.label = String(v.voyage_id);
    sel.appendChild(o);
  }
  hint.textContent = `${voyages.length} voyage(s).`;
  document.getElementById("voyageSearch").oninput = (e) => {
    const q = e.target.value.trim();
    for (const o of sel.options) {
      const m = !q || o.dataset.label.includes(q);
      o.hidden = !m; o.style.display = m ? "" : "none";
    }
  };
  // Sélectionner une observation = tracer la ligne associée sur la carte
  sel.onchange = () => demanderTraceVoyage(sel.value);
}

// ===== Construction de la requête profil =====
function buildProfilUrl() {
  const mode = getSelMode();
  const params = new URLSearchParams({ mode });
  if (ConsoState.showMean) params.set("include_mean", "1");

  if (mode === "voyage") {
    const vid = document.getElementById("voyageSelect").value;
    if (!vid) { alert("Sélectionnez un voyage."); return null; }
    params.set("voyage", vid);
  } else {
    const pc = document.getElementById("parcoursSelect").value;
    if (!pc) { alert("Sélectionnez un parcours."); return null; }
    params.set("parcours", pc);
    if (mode === "mois") {
      const mois = Array.from(document.querySelectorAll('#moisCheckboxes input:checked'))
                        .map(cb => cb.value);
      if (!mois.length) { alert("Cochez au moins un mois."); return null; }
      params.set("mois", mois.join(","));
    } else if (mode === "temp") {
      params.set("tmin", document.getElementById("tempMin").value || "-100");
      params.set("tmax", document.getElementById("tempMax").value || "100");
    }
  }
  return "/api/conso/profil?" + params.toString();
}

// ===== Tracer =====
async function tracer() {
  const url = buildProfilUrl();
  if (!url) return;
  document.getElementById("consoEmpty").style.display = "none";
  const data = await fetch(url).then(r => r.json());
  if (data.error) { alert(data.error); return; }
  ConsoState.lastProfil = data;
  renderChart();
  updateStats(data);
  if (getSelMode() === "voyage") {
    demanderTraceVoyage(document.getElementById("voyageSelect").value);
  }
}

function updateStats(data) {
  setStat("statParcours", data.meta.parcours || "—");
  setStat("statNobs", data.meta.n_observations);
  setStat("statNseg", data.segments.length);
  const totalWh = data.segments.reduce((s, x) => s + (x.wh || 0), 0);
  setStat("statTotal", (totalWh / 1000).toFixed(1) + " kWh");
}

// ===== Valeur selon l'unité =====
function val(seg, key) {
  // key: "wh" | "traction_wh" | "aux_wh"
  const wh = seg[key];
  if (wh == null) return null;
  if (ConsoState.unit === "wh") return wh;
  const d = seg.distance_m;
  return (d && d > 0) ? wh / d : null;   // kWh/km = Wh / distance_m
}
function meanVal(m) {
  return ConsoState.unit === "wh" ? m.wh : m.wh_per_km;
}
function yTitle() {
  return ConsoState.unit === "wh" ? "Consommation (Wh)" : "Consommation (kWh/km)";
}

// ===== Rendu Plotly =====
function renderChart() {
  const data = ConsoState.lastProfil;
  if (!data || !data.segments.length) {
    Plotly.purge("consoChart");
    document.getElementById("consoEmpty").style.display = "";
    return;
  }
  const segs = data.segments;
  ConsoState.segIdByCurve = segs.map(s => s.segment_id);

  const x = segs.map((s, i) => i);
  const labels = segs.map(s => `${s.seg_start_stop_code}→${s.seg_end_stop_code}`);
  const fmt = (v, suffix = "") => (v == null ? "—" : `${v}${suffix}`);
  const hover = segs.map(s =>
    `Seg. ${s.segment_id} (ligne ${s.route_id})<br>` +
    `${s.seg_start_stop_code} → ${s.seg_end_stop_code}<br>` +
    `${s.distance_m} m · ${s.n_obs} obs.<br>` +
    `Pente: ${fmt(s.pente_moy_pct, " %")} · Dénivelé +${fmt(s.denivele_pos_m, " m")} / −${fmt(s.denivele_neg_m, " m")}<br>` +
    `Feux: ${fmt(s.nb_feux)}`);

  const traces = [];

  if (ConsoState.decompose) {
    traces.push({
      type: "bar", name: "Traction", x, customdata: ConsoState.segIdByCurve,
      y: segs.map(s => val(s, "traction_wh")),
      marker: { color: "#1976d2" },
      text: hover, hovertemplate: "%{text}<br>Traction: %{y:.1f}<extra></extra>",
    });
    traces.push({
      type: "bar", name: "Auxiliaires (chauffage élec.)", x, customdata: ConsoState.segIdByCurve,
      y: segs.map(s => val(s, "aux_wh")),
      marker: { color: "#f57c00" },
      text: hover, hovertemplate: "%{text}<br>Auxiliaires: %{y:.1f}<extra></extra>",
    });
  } else {
    traces.push({
      type: "bar", name: "Consommation", x, customdata: ConsoState.segIdByCurve,
      y: segs.map(s => val(s, "wh")),
      marker: { color: "#2e7d32" },
      text: hover, hovertemplate: "%{text}<br>Conso: %{y:.1f}<extra></extra>",
    });
  }

  // Moyenne du parcours (ligne superposée)
  if (ConsoState.showMean && Array.isArray(data.mean) && data.mean.length) {
    const meanById = new Map(data.mean.map(m => [m.segment_id, m]));
    traces.push({
      type: "scatter", mode: "lines+markers", name: "Moyenne parcours",
      x, y: segs.map(s => { const m = meanById.get(s.segment_id); return m ? meanVal(m) : null; }),
      line: { color: "#c62828", width: 2 }, marker: { size: 5 },
      hovertemplate: "Moyenne: %{y:.1f}<extra></extra>",
      connectgaps: false,
    });
  }

  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#cfd8dc", size: 11 },
    margin: { l: 60, r: 16, t: 28, b: 90 },
    barmode: ConsoState.decompose ? "stack" : "group",
    bargap: 0.15,
    legend: { orientation: "h", y: 1.12 },
    xaxis: {
      title: "Segments (ordre du parcours)",
      tickmode: "array", tickvals: x, ticktext: labels,
      tickangle: -60, tickfont: { size: 8 }, gridcolor: "#37474f",
    },
    yaxis: { title: yTitle(), gridcolor: "#37474f", zeroline: true, zerolinecolor: "#607d8b" },
  };

  Plotly.react("consoChart", traces, layout, { responsive: true, displaylogo: false });

  // Clic sur un segment → sélection sur la carte
  const gd = document.getElementById("consoChart");
  gd.removeAllListeners && gd.removeAllListeners("plotly_click");
  gd.on("plotly_click", (ev) => {
    const pt = ev.points && ev.points[0];
    if (!pt) return;
    const segId = (pt.customdata != null) ? pt.customdata
                 : ConsoState.segIdByCurve[pt.pointIndex];
    if (segId == null) return;
    const additive = ev.event && (ev.event.ctrlKey || ev.event.metaKey || ev.event.shiftKey);
    SyncBus.select(Number(segId), !!additive);
  });
}

// ===== Réagir à la sélection (depuis la carte) — surligner les barres =====
function highlightSelection(selectedIds) {
  const gd = document.getElementById("consoChart");
  if (!gd || !ConsoState.lastProfil || !ConsoState.segIdByCurve.length) return;
  // On épaissit la bordure des barres sélectionnées via marker.line.
  const widths = ConsoState.segIdByCurve.map(id => selectedIds.has(Number(id)) ? 3 : 0);
  const colors = ConsoState.segIdByCurve.map(() => "#ffd54f");
  const nBarTraces = ConsoState.decompose ? [0, 1] : [0];
  try {
    Plotly.restyle(gd, { "marker.line.width": [widths], "marker.line.color": [colors] }, nBarTraces);
  } catch (e) { /* graphique pas encore tracé */ }
}

// ===== Initialisation =====
function bindUI() {
  document.querySelectorAll('input[name="selMode"]').forEach(r =>
    r.addEventListener("change", updateModeBlocks));

  document.getElementById("btnTracer").addEventListener("click", tracer);

  const setAllMois = (checked) =>
    document.querySelectorAll('#moisCheckboxes input[type="checkbox"]')
            .forEach(cb => { cb.checked = checked; });
  document.getElementById("btnMoisAll").addEventListener("click", () => setAllMois(true));
  document.getElementById("btnMoisNone").addEventListener("click", () => setAllMois(false));

  document.getElementById("btnUnitWh").addEventListener("click", () => setUnit("wh"));
  document.getElementById("btnUnitKwhKm").addEventListener("click", () => setUnit("kwh_km"));

  document.getElementById("chkMoyenne").addEventListener("change", e => {
    ConsoState.showMean = e.target.checked;
    // recharger pour récupérer/retirer la moyenne côté serveur
    if (ConsoState.lastProfil) tracer();
  });
  document.getElementById("chkDecomp").addEventListener("change", e => {
    ConsoState.decompose = e.target.checked;
    renderChart();
  });
  document.getElementById("chkTracerCarte").addEventListener("change", e => {
    ConsoState.tracerSurCarte = e.target.checked;
    if (e.target.checked && getSelMode() === "voyage") {
      demanderTraceVoyage(document.getElementById("voyageSelect").value);
    }
  });

  document.getElementById("btnOpenCarte").addEventListener("click", () => {
    window.open(new URL("/", window.location.origin).href, "relations-carte");
  });
  document.getElementById("btnOpenSimulation")?.addEventListener("click", () => {
    window.open(new URL("/simulation", window.location.origin).href, "relations-simulation");
  });
}

function setUnit(u) {
  ConsoState.unit = u;
  document.getElementById("btnUnitWh").classList.toggle("primary", u === "wh");
  document.getElementById("btnUnitKwhKm").classList.toggle("primary", u === "kwh_km");
  renderChart();
}

// Surlignage bidirectionnel depuis SyncBus
SyncBus.onSelectionChange((selectedIds) => highlightSelection(selectedIds));

(async function start() {
  bindUI();
  updateModeBlocks();
  setUnit("wh");
  if (CONSO_DISPONIBLE) await loadOptions();
  setupSyncStatus();
  SyncBus.requestPeerState();
  console.log("Page consommation prête. Tab id:", SyncBus.tabId);
})();
