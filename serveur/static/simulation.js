/* =====================================================
   simulation.js — Page Simulation (Plotly)
   Profil vitesse / puissance seconde par seconde généré
   par le modèle physique (serveur : /api/simulation/voyage).
   Deux sous-graphiques empilés à axe temps partagé ;
   bandes verticales = segments du voyage ; clic sur une
   bande → sélection propagée à la carte via SyncBus.
   ===================================================== */

const MOIS_LABELS = ["", "Jan", "Fév", "Mar", "Avr", "Mai", "Juin",
                     "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];

const SimState = {
  lastData: null,        // dernière réponse /api/simulation/voyage
  showConso: false,
  showBandes: true,
  distCum: [],           // distance cumulée (m) à chaque seconde du profil
  dureeS: 0,
};

// Lecture animée du profil : le temps simulé avance en temps réel (× vitesse),
// le curseur suit sur les graphiques et le bus se déplace sur la carte.
const Playback = {
  t: 0,                  // temps simulé courant (s)
  enLecture: false,
  vitesse: 1,            // 1 | 2 | 4 | 10
  rafId: null,
  dernierFrameMs: 0,
  dernierCurseurMs: 0,
  dernierBusMs: 0,
  busSurCarte: true,
};

function setStat(id, val) { document.getElementById(id).textContent = val; }

// ===== Sélecteurs parcours / voyage (mêmes API que la page consommation) =====
async function loadOptions() {
  const opt = await fetch("/api/conso/options").then(r => r.json());
  if (!opt.disponible) {
    document.getElementById("hintText").textContent =
      "Données absentes — lancez pipeline/p06_conso_synthetique.py.";
    return;
  }
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
  sel.addEventListener("change", () => loadVoyages(sel.value));
}

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
}

// ===== Simulation =====
async function simuler() {
  const vid = document.getElementById("voyageSelect").value;
  if (!vid) { alert("Sélectionnez un voyage."); return; }
  document.getElementById("hintText").textContent = "Simulation en cours…";
  const data = await fetch("/api/simulation/voyage?voyage=" + vid).then(r => r.json());
  if (data.error) {
    alert(data.error);
    document.getElementById("hintText").textContent = "Erreur de simulation.";
    return;
  }
  SimState.lastData = data;
  document.getElementById("simEmpty").style.display = "none";
  document.getElementById("hintText").textContent =
    `Voyage ${data.voyage_id} — « Lecture » anime le trajet ; clic sur une bande = surlignage du segment.`;
  preparerLecture(data);
  renderChart();
  updateStats(data);
  // Tracer le trajet du voyage sur la carte (le bus s'y déplacera)
  SyncBus.post({ type: "trace_voyage", voyage: Number(data.voyage_id) });
}

function updateStats(data) {
  const m = data.meta || {};
  setStat("statParcours", m.parcours || "—");
  setStat("statMeteo", `${MOIS_LABELS[m.mois] || "—"} · ${m.temperature_C ?? "—"} °C`);
  setStat("statCharge", m.charge_passagers ?? "—");
  setStat("statDistance", m.distance_totale_m != null
          ? (m.distance_totale_m / 1000).toFixed(2) + " km" : "—");
  const d = m.duree_s ?? 0;
  setStat("statDuree", `${Math.floor(d / 60)} min ${String(d % 60).padStart(2, "0")} s`);

  // Conso intégrée du profil simulé (somme P×1s sur les points valides)
  let wh = 0;
  for (const p of data.series) { if (p[2] != null) wh += p[2] / 3.6; }
  setStat("statConso", (wh / 1000).toFixed(2) + " kWh");
}

// ===== Rendu Plotly =====
function segmentAtTime(t) {
  const segs = SimState.lastData?.segments || [];
  for (const s of segs) {
    if (t >= s.t_debut_s && t < s.t_fin_s) return s;
  }
  return null;
}

/* =====================================================
   Lecture animée (play / pause / vitesse)
   ===================================================== */

// Distance cumulée seconde par seconde : intégration de la vitesse (pas de 1 s).
// Sert à situer le bus le long du tracé du segment courant.
function preparerLecture(data) {
  const dist = new Array(data.series.length);
  let cum = 0;
  for (let i = 0; i < data.series.length; i++) {
    cum += (data.series[i][1] || 0) / 3.6;   // km/h -> m/s, pas de 1 s
    dist[i] = cum;
  }
  SimState.distCum = dist;
  SimState.dureeS = data.series.length ? data.series[data.series.length - 1][0] : 0;

  pause();
  Playback.t = 0;
  const slider = document.getElementById("playSlider");
  slider.max = String(SimState.dureeS);
  slider.value = "0";
  slider.disabled = false;
  document.getElementById("btnPlayPause").disabled = false;
  document.getElementById("btnRewind").disabled = false;
  majAffichageTemps();
}

function fmtDuree(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function majAffichageTemps() {
  document.getElementById("playTime").textContent =
    `${fmtDuree(Playback.t)} / ${fmtDuree(SimState.dureeS)}`;
}

// Position du bus : segment courant + fraction parcourue (0-1) de sa longueur.
function positionAt(t) {
  const seg = segmentAtTime(t);
  if (!seg || !SimState.distCum.length) return null;
  const idx = (x) => Math.min(Math.max(Math.round(x), 0), SimState.distCum.length - 1);
  const d0 = SimState.distCum[idx(seg.t_debut_s)];
  const d1 = SimState.distCum[idx(seg.t_fin_s - 1)];
  const d  = SimState.distCum[idx(t)];
  const fraction = (d1 > d0) ? (d - d0) / (d1 - d0) : 0;
  return { segment_id: seg.segment_id, fraction: Math.min(Math.max(fraction, 0), 1) };
}

function envoyerPositionBus() {
  if (!Playback.busSurCarte || !SimState.lastData) return;
  const pos = positionAt(Playback.t);
  if (!pos || pos.segment_id == null || pos.segment_id < 0) return;
  SyncBus.post({
    type: "sim_position",
    voyage: Number(SimState.lastData.voyage_id),
    segment_id: pos.segment_id,
    fraction: pos.fraction,
  });
}

// Barre d'avancement sur les graphiques : ligne verticale ajoutée aux bandes.
function majCurseur() {
  const gd = document.getElementById("simChart");
  if (!gd || !SimState.lastData) return;
  try {
    Plotly.relayout(gd, { shapes: buildShapes(true) });
  } catch (e) { /* graphique pas encore prêt */ }
}

function boucleLecture(ts) {
  if (!Playback.enLecture) return;
  if (!Playback.dernierFrameMs) Playback.dernierFrameMs = ts;
  const dt = (ts - Playback.dernierFrameMs) / 1000 * Playback.vitesse;
  Playback.dernierFrameMs = ts;
  Playback.t += dt;

  if (Playback.t >= SimState.dureeS) {
    Playback.t = SimState.dureeS;
    majInterfaceLecture(ts, /*forcer=*/true);
    pause();
    return;
  }
  majInterfaceLecture(ts, false);
  Playback.rafId = requestAnimationFrame(boucleLecture);
}

// Le curseur Plotly et le bus sont rafraîchis à cadence réduite (relayout coûteux).
function majInterfaceLecture(ts, forcer) {
  document.getElementById("playSlider").value = String(Math.round(Playback.t));
  majAffichageTemps();
  const now = ts || performance.now();
  if (forcer || now - Playback.dernierCurseurMs > 70) {
    Playback.dernierCurseurMs = now;
    majCurseur();
  }
  if (forcer || now - Playback.dernierBusMs > 120) {
    Playback.dernierBusMs = now;
    envoyerPositionBus();
  }
}

function lecture() {
  if (!SimState.lastData || Playback.enLecture) return;
  if (Playback.t >= SimState.dureeS) Playback.t = 0;   // relancer depuis le début
  Playback.enLecture = true;
  Playback.dernierFrameMs = 0;
  document.getElementById("btnPlayPause").textContent = "⏸ Pause";
  Playback.rafId = requestAnimationFrame(boucleLecture);
}

function pause() {
  Playback.enLecture = false;
  if (Playback.rafId) cancelAnimationFrame(Playback.rafId);
  Playback.rafId = null;
  const btn = document.getElementById("btnPlayPause");
  if (btn) btn.textContent = "▶ Lecture";
}

function togglePlayPause() {
  if (Playback.enLecture) pause(); else lecture();
}

// Bandes alternées des segments + (optionnel) barre d'avancement de la lecture.
function buildShapes(avecCurseur) {
  const data = SimState.lastData;
  const shapes = [];
  if (!data) return shapes;
  if (SimState.showBandes) {
    (data.segments || []).forEach((s, i) => {
      shapes.push({
        type: "rect", xref: "x", yref: "paper",
        x0: s.t_debut_s, x1: s.t_fin_s, y0: 0, y1: 1,
        fillcolor: i % 2 === 0 ? "rgba(120,144,156,0.10)" : "rgba(120,144,156,0.02)",
        line: { width: 0 },
        layer: "below",
      });
    });
  }
  if (avecCurseur) {
    shapes.push({
      type: "line", xref: "x", yref: "paper",
      x0: Playback.t, x1: Playback.t, y0: 0, y1: 1,
      line: { color: "#ffd54f", width: 2 },
      layer: "above",
    });
  }
  return shapes;
}

function renderChart() {
  const data = SimState.lastData;
  if (!data || !data.series.length) {
    Plotly.purge("simChart");
    document.getElementById("simEmpty").style.display = "";
    return;
  }

  const t = data.series.map(p => p[0]);
  const v = data.series.map(p => p[1]);
  const pw = data.series.map(p => p[2]);
  const conso = data.series.map(p => p[3]);
  const segId = data.series.map(p => segmentAtTime(p[0])?.segment_id ?? null);

  const traces = [
    {
      type: "scatter", mode: "lines", name: "Vitesse (km/h)",
      x: t, y: v, customdata: segId,
      line: { color: "#4f9fff", width: 1.5 },
      yaxis: "y1",
      hovertemplate: "t=%{x}s · %{y:.1f} km/h · seg %{customdata}<extra></extra>",
    },
    {
      type: "scatter", mode: "lines", name: "Puissance (kW)",
      x: t, y: pw, customdata: segId,
      line: { color: "#ffb74d", width: 1.2 },
      fill: "tozeroy", fillcolor: "rgba(255,183,77,0.15)",
      yaxis: "y2",
      hovertemplate: "t=%{x}s · %{y:.1f} kW · seg %{customdata}<extra></extra>",
    },
  ];

  if (SimState.showConso) {
    traces.push({
      type: "scatter", mode: "lines", name: "Conso (kWh/km)",
      x: t, y: conso, customdata: segId,
      line: { color: "#81c784", width: 1, dash: "dot" },
      yaxis: "y3",
      connectgaps: false,
      hovertemplate: "t=%{x}s · %{y:.2f} kWh/km<extra></extra>",
    });
  }

  const shapes = buildShapes(true);

  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: "#cfd8dc", size: 11 },
    margin: { l: 60, r: 55, t: 30, b: 46 },
    legend: { orientation: "h", y: 1.08 },
    shapes,
    xaxis: { title: "Temps (s)", gridcolor: "#37474f", domain: [0, 1] },
    yaxis:  { title: "Vitesse (km/h)", gridcolor: "#37474f",
              domain: [0.56, 1.0], zeroline: false },
    yaxis2: { title: "Puissance (kW)", gridcolor: "#37474f",
              domain: [0.0, 0.48], zeroline: true, zerolinecolor: "#607d8b" },
    yaxis3: { title: "kWh/km", overlaying: "y2", side: "right",
              showgrid: false, rangemode: "tozero" },
  };

  Plotly.react("simChart", traces, layout, { responsive: true, displaylogo: false });

  // Clic n'importe où sur les courbes → sélection du segment correspondant
  const gd = document.getElementById("simChart");
  gd.removeAllListeners && gd.removeAllListeners("plotly_click");
  gd.on("plotly_click", (ev) => {
    const pt = ev.points && ev.points[0];
    if (!pt) return;
    const seg = segmentAtTime(Number(pt.x));
    if (!seg || seg.segment_id == null || seg.segment_id < 0) return;
    const additive = ev.event && (ev.event.ctrlKey || ev.event.metaKey || ev.event.shiftKey);
    SyncBus.select(Number(seg.segment_id), !!additive);
  });
}

// ===== Initialisation =====
function bindUI() {
  document.getElementById("btnSimuler").addEventListener("click", simuler);
  document.getElementById("chkConsoInstant").addEventListener("change", e => {
    SimState.showConso = e.target.checked;
    if (SimState.lastData) renderChart();
  });
  document.getElementById("chkBandes").addEventListener("change", e => {
    SimState.showBandes = e.target.checked;
    if (SimState.lastData) renderChart();
  });

  // --- Lecture ---
  document.getElementById("btnPlayPause").addEventListener("click", togglePlayPause);
  document.getElementById("btnRewind").addEventListener("click", () => {
    pause();
    Playback.t = 0;
    document.getElementById("playSlider").value = "0";
    majAffichageTemps();
    majCurseur();
    envoyerPositionBus();
  });
  document.getElementById("selVitesse").addEventListener("change", e => {
    Playback.vitesse = Number(e.target.value) || 1;
  });
  document.getElementById("playSlider").addEventListener("input", e => {
    Playback.t = Number(e.target.value) || 0;
    majAffichageTemps();
    majCurseur();
    envoyerPositionBus();
  });
  document.getElementById("chkBusCarte").addEventListener("change", e => {
    Playback.busSurCarte = e.target.checked;
    if (e.target.checked) envoyerPositionBus();
  });
  document.getElementById("btnOpenCarte").addEventListener("click", () => {
    window.open(new URL("/", window.location.origin).href, "relations-carte");
  });
  document.getElementById("btnOpenConso").addEventListener("click", () => {
    window.open(new URL("/consommation", window.location.origin).href, "relations-consommation");
  });
}

(async function start() {
  bindUI();
  if (SIMULATION_DISPONIBLE) await loadOptions();
  else document.getElementById("hintText").textContent =
    "Simulation indisponible — lancez pipeline/p06_conso_synthetique.py puis relancez le serveur.";
  setupSyncStatus();
  SyncBus.requestPeerState();
  console.log("Page simulation prête. Tab id:", SyncBus.tabId);
})();
