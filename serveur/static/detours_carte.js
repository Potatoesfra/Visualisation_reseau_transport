/* =====================================================
   Détours GTFS-RT sur la carte : actions manuelles (serveur/detours.py)
   - clic droit sur un tracé : valider, supprimer (avec sourdine de la
     ligne/direction pendant N minutes ou jusqu'à la fin de la session),
     retracer à la main ;
   - « ✏ Tracer un détour » : points cliqués reliés par les rues, validé d'office ;
   - liste des sourdines en cours (section « Bus en temps réel »).
   L'état est sur le serveur : la carte et le tableau de bord voient la même chose.
   Une sourdine « session » est levée quand cette page est rechargée ou fermée
   (sendBeacon), ou au redémarrage du serveur.
   Chargé après carte.js (map, RT, rafraichirBus, afficherAvisBus, placerMenuCarte…).
   ===================================================== */

const RT_SESSION = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let rtSessionSourdine = false;   // cette page a posé une sourdine « fin de session »

const libLigneDir = (route, direction) => `ligne ${route}${direction ? " " + direction : ""}`;
const kmDetour = m => (m / 1000).toLocaleString("fr-CA", { maximumFractionDigits: 1 });

async function actionDetour(chemin, corps) {
  const rep = await fetch(`/api/rt/detours/${chemin}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps),
  });
  const data = await rep.json().catch(() => ({}));
  if (!rep.ok) throw new Error(data.error || `HTTP ${rep.status}`);
  return data;
}

// Action puis actualisation immédiate (le serveur a déjà reconstruit l'état)
async function executerActionDetour(chemin, corps, message) {
  try {
    const r = await actionDetour(chemin, corps);
    await rafraichirBus();
    if (message) afficherAvisBus(message);
    return r;
  } catch (err) {
    afficherAvisBus(`Action impossible : ${err.message}`);
    return null;
  }
}

// ----- Clic droit sur un tracé de détour -----
function ouvrirMenuDetour(d, evt) {
  L.DomEvent.stopPropagation(evt);
  L.DomEvent.preventDefault(evt.originalEvent);
  fermerMenuSegment();
  const ligne = libLigneDir(d.route, d.direction);
  const etat = d.manuel ? "tracé à la main" : d.force ? "validé manuellement"
             : d.valide ? `validé par ${d.n_bus} bus` : "potentiel (1 seul bus)";
  const menu = document.createElement("div");
  menu.id = "segMenu";                       // même fermeture que le menu des segments
  menu.className = "seg-menu detour-menu";
  menu.setAttribute("role", "menu");
  const entete =
    `<div class="seg-menu-titre">${d.valide ? "↪ Détour validé" : "Détour potentiel"}<span>${ligne}</span></div>` +
    `<div class="seg-menu-sous">${etat} · ${kmDetour(d.longueur_m)} km · depuis ${hhmm(d.debut)}</div>`;
  if (RT.detoursActions === false) {   // démo publique : état partagé, lecture seule
    menu.innerHTML = entete + `<div class="instructions">Valider, supprimer ou retracer un détour : disponible
      en local seulement (sur la démo en ligne, l'état est partagé par tous les visiteurs).</div>`;
    placerMenuCarte(menu, evt.originalEvent);
    return;
  }
  menu.innerHTML = entete +
    (d.valide ? "" : `<button type="button" class="action-btn primary" data-action="valider"
        title="Le considérer comme un détour réel sans attendre un 2e bus">✔ Valider manuellement</button>`) +
    `<button type="button" class="action-btn" data-action="retracer"
        title="Dessiner le bon tracé ; celui-ci est remplacé">✏ Retracer à la main</button>` +
    `<fieldset class="detour-menu-suppr"><legend>Supprimer ce détour, puis…</legend>` +
    `<label><input type="radio" name="detourSourdine" value="aucune" checked> le signaler de nouveau s'il réapparaît</label>` +
    `<label><input type="radio" name="detourSourdine" value="minutes"> ne plus signaler de détour sur la ${ligne} pendant ` +
    `<input type="number" class="detour-minutes" min="1" max="1440" value="30" aria-label="Minutes"> min</label>` +
    `<label><input type="radio" name="detourSourdine" value="session"> …jusqu'à la fin de la session ` +
    `<span class="instructions">(rechargement de cette page ou redémarrage du serveur)</span></label>` +
    `<button type="button" class="action-btn danger" data-action="supprimer">🗑 Supprimer</button></fieldset>`;
  menu.querySelector(".detour-minutes").addEventListener("focus", () => {
    menu.querySelector('input[value="minutes"]').checked = true;
  });
  menu.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (!action) return;
    fermerMenuSegment();
    if (action === "valider") {
      await executerActionDetour("valider", { id: d.id }, `Détour de la ${ligne} validé manuellement.`);
    } else if (action === "retracer") {
      demarrerTraceDetour({ route: d.route, direction: d.direction, remplace: d.id });
    } else if (action === "supprimer") {
      const choix = menu.querySelector('input[name="detourSourdine"]:checked').value;
      const corps = { id: d.id };
      let suite = "";
      if (choix === "minutes") {
        corps.minutes = Math.min(1440, Math.max(1, Number(menu.querySelector(".detour-minutes").value) || 30));
        suite = ` Plus de détour signalé sur la ${ligne} pendant ${corps.minutes} min.`;
      } else if (choix === "session") {
        corps.session = RT_SESSION;
        rtSessionSourdine = true;
        suite = ` Plus de détour signalé sur la ${ligne} jusqu'à la fin de la session.`;
      }
      await executerActionDetour("supprimer", corps, `Détour de la ${ligne} supprimé.${suite}`);
    }
  });
  placerMenuCarte(menu, evt.originalEvent);
}

// ----- Sourdines en cours (section « Bus en temps réel ») -----
function majSourdines(data) {
  const bloc = document.getElementById("rtSourdines");
  const liste = data.detours_sourdines || [];
  bloc.hidden = !liste.length;
  if (!liste.length) { bloc.replaceChildren(); return; }
  const cle = liste.map(x => `${x.route}|${x.dir_id}|${x.jusqu_a}|${x.session}`).join(";");
  if (bloc.dataset.cle === cle) return;
  bloc.dataset.cle = cle;
  bloc.innerHTML = `<div class="rt-sourdines-titre">🔇 Détours en sourdine</div>` + liste.map(x =>
    `<div class="rt-sourdine"><span><b>${libLigneDir(x.route, x.direction)}</b> · ` +
    (x.jusqu_a ? `jusqu'à ${hhmm(x.jusqu_a)}` : `jusqu'à la fin de la session${x.session === RT_SESSION ? "" : " (autre page)"}`) +
    `</span><button type="button" class="sec-tout" data-route="${x.route}" data-dir="${x.dir_id}">Lever</button></div>`).join("");
}

// ----- Tracé manuel -----
const TD = { actif: false, points: [], remplace: null, couche: null, renderer: null, jeton: 0, apercu: null };

function optionsTrace(route, direction) {
  const lignes = new Set(SERVER_META.lignes || []);
  const idx = RT.dernier ? indexChamps(RT.dernier) : null;
  for (const v of (RT.dernier?.vehicules || [])) if (v[idx.route_id] != null) lignes.add(String(v[idx.route_id]));
  const selLigne = document.getElementById("traceDetourLigne");
  selLigne.replaceChildren(...[...lignes].sort(triLignes).map(l => new Option(`Ligne ${l}`, l)));
  selLigne.value = String(route ?? lignesGtfsSelectionnees()[0] ?? selLigne.options[0]?.value ?? "");
  majDirectionsTrace(direction);
}

// Directions : celles vues dans le flux pour cette ligne, puis celles des parcours de la carte
function majDirectionsTrace(direction) {
  const route = document.getElementById("traceDetourLigne").value;
  const dirs = new Set();
  const idx = RT.dernier ? indexChamps(RT.dernier) : null;
  for (const v of (RT.dernier?.vehicules || [])) {
    if (String(v[idx.route_id]) === route && v[idx.direction]) dirs.add(v[idx.direction]);
  }
  for (const p of (SERVER_META.lignes_parcours?.[route] || [])) if (p.direction) dirs.add(p.direction);
  if (direction) dirs.add(direction);
  const sel = document.getElementById("traceDetourDirection");
  sel.replaceChildren(...[...dirs].sort().map(d => new Option(d, d)));
  if (direction) sel.value = direction;
}

function demarrerTraceDetour({ route = null, direction = null, remplace = null } = {}) {
  arreterTraceDetour();
  Object.assign(TD, { actif: true, points: [], remplace, apercu: null });
  if (!map.getPane("traceDetour")) {
    // Calque d'aperçu non interactif. Sans renderer explicite, Leaflet (preferCanvas)
    // y créerait un canvas couvrant toute la carte, au-dessus des bus et des
    // segments : il capterait survols et clics, même vidé après le tracé.
    const pane = map.createPane("traceDetour");
    pane.style.zIndex = 460;
    pane.style.pointerEvents = "none";
    TD.renderer = L.svg({ pane: "traceDetour" });
  }
  TD.couche = L.layerGroup().addTo(map);
  optionsTrace(route, direction);
  document.getElementById("traceDetour").hidden = false;
  document.querySelector("#traceDetour .trace-detour-titre").textContent =
    remplace != null ? "✏ Retracer le détour" : "✏ Tracer un détour";
  map.getContainer().classList.add("trace-detour-actif");
  majTraceDetour();
}

function arreterTraceDetour() {
  if (!TD.actif) return;
  TD.actif = false;
  TD.jeton++;
  TD.couche?.remove();
  document.getElementById("traceDetour").hidden = true;
  map.getContainer().classList.remove("trace-detour-actif");
}

// Clic sur la carte, un segment ou un bus pendant le tracé : ajoute un point
function clicTraceDetour(evt) {
  if (!TD.actif) return false;
  TD.points.push([evt.latlng.lat, evt.latlng.lng]);
  majTraceDetour();
  return true;
}

async function majTraceDetour() {
  const aide = document.getElementById("traceDetourAide");
  TD.couche.clearLayers();
  TD.points.forEach((p, i) => L.circleMarker(p, {
    pane: "traceDetour", renderer: TD.renderer, radius: i === 0 || i === TD.points.length - 1 ? 6 : 4,
    color: "#e65100", weight: 2, fillColor: "#fff3e0", fillOpacity: 1, interactive: false,
  }).addTo(TD.couche));
  document.getElementById("traceDetourRetour").disabled = !TD.points.length;
  TD.apercu = null;
  document.getElementById("traceDetourOk").disabled = true;
  aide.classList.remove("erreur");
  if (TD.points.length < 2) {
    aide.textContent = TD.points.length
      ? "Point d'entrée posé : cliquez la suite du détour jusqu'à la sortie (le tracé suit les rues)."
      : "Cliquez les points du détour, de l'entrée à la sortie : le tracé suit les rues.";
    return;
  }
  const jeton = ++TD.jeton;
  aide.textContent = "Calcul du tracé…";
  try {
    const r = await actionDetour("apercu", { points: TD.points });
    if (jeton !== TD.jeton) return;
    TD.apercu = r;
    L.polyline(r.coords, { pane: "traceDetour", renderer: TD.renderer, color: "#fb8c00", weight: 5, opacity: 0.9,
                           dashArray: "10 6", interactive: false }).addTo(TD.couche);
    aide.textContent = `${TD.points.length} points · ${kmDetour(r.longueur_m)} km sur le réseau routier.`;
    document.getElementById("traceDetourOk").disabled = false;
  } catch (err) {
    if (jeton !== TD.jeton) return;
    aide.textContent = `⚠ ${err.message}`;
    aide.classList.add("erreur");
  }
}

async function enregistrerTraceDetour() {
  const route = document.getElementById("traceDetourLigne").value;
  const direction = document.getElementById("traceDetourDirection").value;
  const corps = { route, direction, points: TD.points, remplace: TD.remplace };
  const ok = await executerActionDetour("tracer", corps,
    `Détour tracé sur la ${libLigneDir(route, direction)} : validé, et pris en compte pour le bus bunching et les gaps de service.`);
  if (!ok) return;
  arreterTraceDetour();
  const chk = document.getElementById("chkBusTempsReel");
  if (!chk.checked && !chk.disabled) { chk.checked = true; chk.dispatchEvent(new Event("change")); }
}

// ----- Détour 1 bus retracé depuis l'historique -----
// Détour d'un seul bus non repris (bus suivant passé par le tracé normal, ou
// aucun passage en 45 min) : retiré de la carte par le serveur, retracé ici à la
// demande avec la trace GPS, le tracé estimé sur les rues, la portion normale
// contournée et les statistiques du passage.
const DP = { couche: null, renderer: null };

function effacerDetourPonctuel() {
  DP.couche?.remove();
  DP.couche = null;
  document.getElementById("detourPonctuelBanniere")?.remove();
}

async function retracerDetourPonctuel(info) {
  if (!info) return;
  let p;
  try {
    const rep = await fetch(`/api/rt/detours/ponctuel/${encodeURIComponent(info.id)}`);
    p = await rep.json();
    if (!rep.ok) throw new Error(p.error || `HTTP ${rep.status}`);
  } catch (err) {
    afficherAvisBus(`Détour 1 bus : ${err.message}`);
    return;
  }
  effacerDetourPonctuel();
  if (!map.getPane("detourPonctuel")) {
    map.createPane("detourPonctuel").style.zIndex = 446;   // sous les bus, au-dessus des segments
    DP.renderer = L.svg({ pane: "detourPonctuel" });       // SVG : ne capte que ses propres tracés
  }
  DP.couche = L.layerGroup().addTo(map);
  const o = { pane: "detourPonctuel", renderer: DP.renderer };
  if (p.nominal.length > 1) {
    L.polyline(p.nominal, { ...o, color: "#4f9fff", weight: 4, opacity: 0.85, interactive: false }).addTo(DP.couche);
  }
  if (p.coords.length > 1) {
    L.polyline(p.coords, { ...o, color: "#ab47bc", weight: 5, opacity: 0.95, dashArray: "8 6", interactive: false }).addTo(DP.couche);
  }
  const n = p.gps.length;
  p.gps.forEach(([la, lo, t], i) => {
    const bout = i === 0 ? "#6db86d" : i === n - 1 ? "#ef5350" : null;
    L.circleMarker([la, lo], { ...o, radius: bout ? 6 : 4, color: "#4a148c", weight: 1.5,
                               fillColor: bout || "#e1bee7", fillOpacity: 1 })
      .bindTooltip(`${i === 0 ? "Entrée : dernière position sur le tracé" : i === n - 1 ? "Retour sur le tracé"
                    : `Position GPS ${i}`} · ${hhmmss(t)}`, { direction: "top" })
      .addTo(DP.couche);
  });
  const bornes = L.latLngBounds([...p.coords, ...p.nominal, ...p.gps.map(g => [g[0], g[1]])]);
  if (bornes.isValid()) map.fitBounds(bornes.pad(0.3), { maxZoom: 17 });

  const m = v => Number(v).toLocaleString("fr-CA");
  const b = document.createElement("div");
  b.id = "detourPonctuelBanniere";
  b.className = "detour-ponctuel-banniere";
  b.setAttribute("role", "status");
  b.innerHTML =
    `<b class="titre">↯ Détour 1 bus · ${libLigneDir(p.route, p.direction)}</b>` +
    `<button type="button" class="close-btn" title="Effacer ce tracé">×</button>` +
    `<div class="detour-ponctuel-stats">` +
    `<div><span>Bus</span> <b>${p.bus}</b></div>` +
    `<div title="trip_id ${p.trip_id}"><span>Voyage</span> <b>${p.trip_debut ? `départ ${p.trip_debut}` : p.trip_id}</b></div>` +
    `<div><span>Hors tracé</span> <b>${hhmm(p.debut)} → ${hhmm(p.fin)} (${fmtDuree(p.duree_s)})</b></div>` +
    `<div><span>Distance ajoutée</span> <b>${p.distance_ajoutee_m >= 0 ? "+" : ""}${m(p.distance_ajoutee_m)} m</b></div>` +
    `<div><span>Parcouru</span> <b>${kmDetour(p.longueur_m)} km au lieu de ${kmDetour(p.distance_nominale_m)} km</b></div>` +
    `<div><span>Positions GPS</span> <b>${p.n_gps}</b></div></div>` +
    `<div class="detour-ponctuel-legende"><span><i style="border-top:4px dashed #ab47bc"></i>tracé estimé (rues)</span>` +
    `<span><i style="border-top:4px solid #4f9fff"></i>tracé normal contourné</span>` +
    `<span>● positions GPS (vert : entrée, rouge : retour)</span></div>` +
    `<div class="detour-ponctuel-legende">${p.motif === "infirme"
      ? `Non repris : le bus ${p.infirme_par} est ensuite passé par le tracé normal (${hhmm(p.t_archive)}).`
      : "Non repris : aucun autre bus ne l'a emprunté pendant 45 min."}</div>`;
  b.querySelector(".close-btn").addEventListener("click", effacerDetourPonctuel);
  L.DomEvent.disableClickPropagation(b);
  document.getElementById("main-view").appendChild(b);
}

function initDetoursCarte() {
  document.getElementById("btnTracerDetour").addEventListener("click", () => demarrerTraceDetour());
  document.getElementById("traceDetourLigne").addEventListener("change", () => majDirectionsTrace());
  document.getElementById("traceDetourRetour").addEventListener("click", () => { TD.points.pop(); majTraceDetour(); });
  document.getElementById("traceDetourOk").addEventListener("click", enregistrerTraceDetour);
  document.getElementById("traceDetourAnnuler").addEventListener("click", arreterTraceDetour);
  L.DomEvent.disableClickPropagation(document.getElementById("traceDetour"));
  map.on("click", (evt) => clicTraceDetour(evt));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && TD.actif) arreterTraceDetour(); });
  document.getElementById("rtSourdines").addEventListener("click", (e) => {
    const b = e.target.closest("[data-route]");
    if (b) executerActionDetour("sourdines/lever", { route: b.dataset.route, dir_id: Number(b.dataset.dir) });
  });
  // Fin de session de la page : ses sourdines « jusqu'à la fin de la session » sont levées
  window.addEventListener("pagehide", () => {
    if (rtSessionSourdine) navigator.sendBeacon("/api/rt/detours/sourdines/lever", JSON.stringify({ session: RT_SESSION }));
  });
}

initDetoursCarte();
