/* =====================================================
   Visite guidée (« tour du propriétaire ») — toutes les pages
   -----------------------------------------------------
   Chargé en dernier par chaque page : <script src="visite_guidee.js"
   data-page="carte|graphe|graphe_calcul|consommation|simulation|tableau_de_bord"
   data-demarrage="{{ demarrage }}">.

   Une page d'introduction (interface), puis une page courte par partie de
   l'écran ; les parties masquées ou sans objet sont sautées. Ce dont parle la
   page est mis en surbrillance : voile sombre percé autour des éléments
   (masque SVG), contour bleu. Le voile laisse passer la souris : on peut
   essayer en suivant le guide. Quand une étape parle d'une autre page, un
   aperçu (capture, static/apercus/, scripts/capturer_apercus.py) s'affiche à
   droite de l'étape.

   Ouverte automatiquement une fois par lancement du serveur et par page, sauf
   si « Ne plus l'afficher » est coché ; relançable à tout moment par le bouton
   « ? » en bas à droite. Clavier : ← → pour naviguer, Échap pour quitter.
   `?apercu` dans l'URL : ni visite ni bouton (captures des aperçus).
   ===================================================== */

const VISITE_SCRIPT = document.currentScript;
const VISITE_PAGE = VISITE_SCRIPT?.dataset.page || "carte";
const VISITE_DEMARRAGE = VISITE_SCRIPT?.dataset.demarrage || "";
const CLE_VISITE_VUE = `visite.vu.${VISITE_PAGE}`;   // lancement du serveur pour lequel la visite a été vue
const CLE_VISITE_JAMAIS = "visite.jamais";           // « Ne plus l'afficher au lancement » (toutes les pages)

// Aperçus des autres pages (captures) ; `simule` : données temps réel simulées (apercus.json)
const VISITE_APERCUS = {
  tableau_de_bord: "Tableau de bord plein écran",
  consommation: "Page Consommation",
  simulation: "Page Simulation",
  graphe: "Page Graphe",
  graphe_calcul: "Graphe de calcul",
};

// Section du panneau dont le titre commence par `titre` (pages sans id de section)
function sectionVisite(titre) {
  return [...document.querySelectorAll("#panel .section")].find(s =>
    (s.querySelector(".sec-label")?.textContent || "").trim().startsWith(titre)) || null;
}
const INTRO_PANNEAU = `<b>Le menu de gauche</b> regroupe les réglages ; <b>‹‹</b> le replie : il réapparaît au survol
  du bord gauche, et un clic sur ce bord (ou sur <b>››</b>) le fixe ouvert.`;
const INTRO_GUIDE = `<b>Ce guide</b> présente ensuite chaque partie. Passez-le ou suivez-le : le bouton <b>?</b> en bas à
  droite le relance quand vous voulez. Clavier : ← → pour naviguer, Échap pour quitter.`;

// ----- Carte : une page par section du panneau (dans l'ordre choisi avec ⚙) -----
const VISITE_SECTIONS_CARTE = {
  secModeSegments: {
    titre: "Mode segments",
    texte: `<p>Un <b>segment</b> est la portion de tracé entre deux arrêts consécutifs d'une ligne.</p>
      <ul><li><b>Normal</b> : un segment par ligne.</li>
      <li><b>Fusion</b> : les segments qui relient les mêmes arrêts (toutes lignes confondues) ne forment plus qu'un nœud.</li></ul>`,
  },
  secLignes: {
    titre: "Lignes et parcours types",
    texte: `<p>Choisissez les <b>lignes</b> à afficher (vide = tout le réseau) ; la croix ✕ d'une puce la retire,
      <b>Tout désélectionner</b> vide la liste.</p>
      <p><b>Parcours types</b> (facultatif) : ne garder que certains parcours (direction · destination).</p>
      <p>Astuce : <b>clic droit sur un segment</b> de la carte pour afficher les lignes qui lui sont liées.</p>`,
  },
  secRelations: {
    titre: "Relations entre segments",
    texte: `<p>Les segments sont reliés par des <b>relations typées</b> : suivant, portion partagée,
      intersection, merge, diverge, opposé, parallèle proche. Cochez les types à tracer.</p>
      <p>Sélectionnez un segment : ses relations apparaissent en <b>arcs colorés</b>, et sa fiche en bas à droite.
      <b>Affichage</b> : arrêts, arcs de relation, surbrillance au survol.</p>
      <p><b>Lignes liées</b> : <b>clic droit sur un segment</b> (ou « Choisir… » dans sa fiche) pour cocher les lignes
      reliées à afficher, ou <b>Afficher</b> pour les ajouter toutes d'un coup.</p>`,
  },
  secCouches: {
    titre: "Fonds et couches",
    texte: `<ul><li><b>Relief</b> : modèle numérique de terrain Copernicus, opacité réglable.</li>
      <li><b>Réseau routier routable</b> (OpenStreetMap) : celui qui sert au routage des trajets
      et à l'estimation des détours.</li></ul>`,
  },
  secEnergie: {
    titre: "Prévision énergétique",
    apercus: ["consommation"],
    texte: `<p>Colore les segments selon la consommation <b>estimée par un modèle physique</b> (ce n'est pas une mesure) :
      vert = la plus faible, rouge = la plus élevée.</p>
      <ul><li>par <b>segment</b> ou pour le <b>voyage complet</b>, en kWh ou kWh/km ;</li>
      <li>sur une <b>période</b> (mois) au choix.</li></ul>
      <p><b>Ouvrir la consommation ⚡</b> : profils détaillés dans une autre page (aperçu à droite).</p>`,
  },
  secTempsReel: {
    titre: "Bus en temps réel",
    apercus: ["tableau_de_bord"],
    texte: `<p>Positions des bus (GTFS-RT de la STM), colorées par <b>occupation</b>, actualisées dès qu'une
      nouvelle version du flux est publiée. <b>Clic</b> sur un bus = focus, <b>Ctrl+clic</b> = sélection multiple.</p>
      <ul><li><b>⚠ hors tracé</b>, <b>détours</b> estimés (jaune : 1 bus, orange : validé par ≥ 2 bus ;
      clic droit pour valider, supprimer ou retracer, en local) ;</li>
      <li><b>bus bunching</b> et <b>gaps de service</b> ;</li>
      <li><b>tableau de bord</b> en bas de la carte, ou <b>plein écran</b> dans un nouvel onglet (aperçu à droite).</li></ul>`,
  },
  secHistorique: {
    titre: "Historique",
    texte: `<p>Les événements du réseau depuis l'ouverture de la page (hors tracé, détours, gaps de service, bus bunching, annulations…).</p>
      <ul><li>Pastilles de types : <b>clic</b> = afficher / masquer, <b>double-clic</b> = ce type seulement ;</li>
      <li><b>clic sur un événement</b> : la carte s'y rend ;</li>
      <li><b>Exporter CSV</b> pour garder une trace.</li></ul>`,
  },
  secTrajet: {
    titre: "Trajet personnalisé",
    texte: `<p>Construisez un <b>nouveau trajet</b> jalon par jalon : l'itinéraire suit le réseau routier réel
      et son énergie est estimée par le modèle physique.</p>
      <p>Exporté, il devient une ligne sélectionnable (puces ★ dans « Lignes »).</p>`,
  },
  secActions: {
    titre: "Actions",
    apercus: ["graphe", "simulation"],
    texte: `<ul><li><b>Effacer la sélection</b> (segments et bus) ;</li>
      <li><b>Recadrer</b> la carte sur la sélection ;</li>
      <li>ouvrir le <b>graphe</b> des relations ou la <b>simulation</b> d'un voyage (aperçus à droite), dans
      d'autres onglets synchronisés avec cette carte.</li></ul>`,
  },
  secStats: {
    titre: "Statistiques",
    texte: `<p>Nombre de segments, de relations affichées et de lignes visibles.</p>
      <p>Sélectionnez un segment : sa <b>fiche physique</b> s'affiche ici (distance, dénivelé, feux, vitesse…).</p>`,
  },
};

function pagesCarte() {
  const pages = [{
    titre: "Bienvenue dans l'outil d'exploration GTFS",
    cibles: ["#btnCollapseSidebar", "#btnReplierTout", "#btnReglagesSections", "#btnVisite"],
    panneau: false, peek: true,
    texte: `<p><b>La carte</b> montre le réseau de bus de la STM découpé en segments (données ouvertes).
      <b>Survol</b> = surbrillance · <b>clic</b> = sélectionner un segment (fiche en bas à droite) ·
      <b>Ctrl+clic</b> = en ajouter · <b>clic droit</b> = lignes liées. Molette et glisser pour naviguer.</p>
      <p><b>Le menu de gauche</b> regroupe les réglages en sections : clic sur un titre pour la replier,
      <b>Tout replier</b>, <b>⚙</b> pour les réordonner ou les masquer. <b>‹‹</b> replie le menu : il réapparaît
      au survol du bord gauche, et un clic sur ce bord (ou sur <b>››</b>) le fixe ouvert.</p>
      <p>${INTRO_GUIDE}</p>`,
  }];
  for (const sec of sectionsDuPanneau()) {
    const def = VISITE_SECTIONS_CARTE[sec.id];
    if (def && sectionAffichee(sec)) pages.push({ ...def, section: sec, cibles: [sec], panneau: true });
  }
  pages.push({
    titre: "À vous de jouer",
    cibles: ["#btnVisite"],
    texte: `<p>Commencez par choisir une ou deux lignes, puis cliquez un segment ou affichez les bus en temps réel.</p>
      <p>Ce guide reste disponible à tout moment avec le bouton <b>?</b>.</p>`,
  });
  return pages;
}

// ----- Autres pages : [titre de section du panneau, titre de l'étape, texte, aperçus] -----
function pagesPanneau(intro, etapes) {
  const pages = [intro];
  for (const [sec, titre, texte, apercus] of etapes) {
    const el = typeof sec === "string" ? sectionVisite(sec) : sec;
    if (el) pages.push({ titre, texte: `<p>${texte}</p>`, cibles: [el], panneau: true, apercus, section: el });
  }
  return pages;
}

const VISITE_DEFINITIONS = {
  carte: pagesCarte,

  graphe: () => pagesPanneau({
    titre: "Le graphe des relations",
    cibles: ["#cy", "#btnVisite"], peek: true,
    texte: `<p>Chaque <b>nœud</b> est un segment, chaque <b>arête</b> une relation typée. <b>Clic</b> = sélectionner,
      <b>Ctrl/Maj+clic</b> = ajouter, <b>glisser</b> sur le fond = sélection par zone. La sélection est
      synchronisée avec la carte ouverte dans un autre onglet.</p><p>${INTRO_PANNEAU}</p><p>${INTRO_GUIDE}</p>`,
  }, [
    ["Mode segments", "Mode segments", "<b>Normal</b> : un nœud par segment de ligne ; <b>Fusion</b> : un nœud pour les segments reliant les mêmes arrêts."],
    ["Mode d'affichage", "Mode d'affichage", "<b>Sélection + voisins</b> : les segments sélectionnés et ceux qui leur sont reliés. <b>Toutes les lignes filtrées</b> : le graphe complet des lignes choisies (plafonné)."],
    ["Lignes affichées", "Lignes affichées", "Lignes du mode « Toutes » (vide = toutes, 300 nœuds au plus)."],
    ["Types de relations", "Types de relations", "Cochez les relations à afficher ; la légende des couleurs est en bas du menu."],
    ["Layout", "Disposition", "Algorithme de placement des nœuds ; <b>Relancer le layout</b> pour réorganiser."],
    ["Actions", "Actions", "Figer la vue, effacer la sélection, recadrer, ouvrir la carte, ou construire le <b>graphe de calcul</b> (arbre de voisinage des nœuds sélectionnés, aperçu à droite).", ["graphe_calcul"]],
    ["Statistiques", "Statistiques", "Nœuds sélectionnés, nœuds et arêtes affichés."],
  ]),

  graphe_calcul: () => pagesPanneau({
    titre: "Le graphe de calcul",
    cibles: ["#cy", "#btnVisite"], peek: true,
    texte: `<p>L'<b>arbre de voisinage</b> des segments sélectionnés : les racines en haut, un niveau par degré de
      voisinage (chaque chemin est représenté, doublons compris). <b>Clic droit</b> sur un nœud pour l'étendre ou le réduire.</p>
      <p>${INTRO_PANNEAU}</p><p>${INTRO_GUIDE}</p>`,
  }, [
    ["Nœuds racines", "Nœuds racines", "Les segments de départ : ceux sélectionnés sur la carte ou le graphe."],
    ["Profondeur", "Profondeur", "Nombre de niveaux de voisinage ; en <b>expansion manuelle</b>, chaque « Étendre » (clic droit) descend d'un niveau."],
    ["Types de relations", "Types de relations", "Relations suivies pour construire l'arbre."],
    ["Actions", "Actions", "Recadrer, relancer la disposition, reconstruire l'arbre ou l'afficher dans le graphe."],
    ["Statistiques", "Statistiques", "Taille de l'arbre (nœuds uniques et avec doublons, arêtes, profondeur)."],
    ["Limite de nœuds", "Limite de nœuds", "Au-delà, l'arbre est tronqué (le navigateur reste fluide)."],
  ]),

  consommation: () => pagesPanneau({
    titre: "La consommation segment par segment",
    cibles: ["#main-view", "#btnVisite"], peek: true,
    texte: `<p>Consommation <b>simulée</b> par le modèle physique (traction + auxiliaires), segment par segment le long
      d'un parcours. <b>Clic</b> sur un segment du graphique : il est surligné sur la carte ouverte dans un autre onglet.</p>
      <p>${INTRO_PANNEAU}</p><p>${INTRO_GUIDE}</p>`,
  }, [
    ["Mode de sélection", "Mode de sélection", "Un <b>voyage</b> précis, ou la moyenne d'un parcours par <b>mois</b> ou par <b>plage de température</b>."],
    ["Parcours", "Parcours", "Choisissez le parcours (ligne · direction), filtrable au clavier."],
    ["Voyage", "Voyage", "Le voyage à tracer (mode « Voyage précis »)."],
    [document.getElementById("btnTracer")?.closest(".section"), "Tracer", "Trace la consommation du choix courant."],
    ["Affichage", "Affichage", "Wh ou kWh/km, moyenne du parcours, décomposition traction / auxiliaires, tracé du voyage sur la carte."],
    ["Statistiques", "Statistiques", "Parcours, nombre d'observations et de segments, consommation totale."],
    ["Navigation", "Navigation", "Ouvrir la carte ou la <b>simulation</b> seconde par seconde (aperçu à droite).", ["simulation"]],
  ]),

  simulation: () => pagesPanneau({
    titre: "La simulation d'un voyage",
    cibles: ["#main-view", "#btnVisite"], peek: true,
    texte: `<p>Profil <b>vitesse / puissance seconde par seconde</b> d'un voyage, généré par le modèle physique
      (cinématique + road-load). <b>Clic</b> sur une bande de segment : surlignage sur la carte.</p>
      <p>${INTRO_PANNEAU}</p><p>${INTRO_GUIDE}</p>`,
  }, [
    ["Parcours", "Parcours", "Choisissez le parcours (ligne · direction)."],
    ["Voyage", "Voyage", "Puis le voyage à simuler."],
    [document.getElementById("btnSimuler")?.closest(".section"), "Lancer la simulation", "Calcule le profil ; options : consommation instantanée (kWh/km), bandes de segments."],
    ["Lecture", "Lecture", "Rejoue le voyage (temps réel à × 10) : le bus se déplace aussi sur la carte."],
    ["Statistiques du voyage", "Statistiques du voyage", "Parcours, météo, passagers, distance, durée et consommation simulées."],
    ["Navigation", "Navigation", "Ouvrir la carte ou la <b>consommation</b> par segment (aperçu à droite).", ["consommation"]],
  ]),

  tableau_de_bord: () => [
    {
      titre: "Le tableau de bord du réseau",
      cibles: [".tdbp-titre", ".tdbp-statut", "#btnVisite"],
      texte: `<p>Performance du réseau <b>en temps réel</b> (flux GTFS-RT de la STM), actualisée à chaque nouvelle version
        du flux. Il continue en arrière-plan : c'est un écran de suivi.</p><p>${INTRO_GUIDE}</p>`,
    },
    { titre: "Panneaux", cibles: ["#tdbpAjout"],
      texte: `<p>Ajoutez un panneau pour le <b>réseau</b> ou des <b>lignes</b> (ex. « 51, 80 ») : les panneaux s'affichent
        côte à côte. Sur chaque panneau : ✎ modifier le périmètre, ⤢ l'agrandir seul, × le fermer.</p>` },
    { titre: "Indicateurs", cibles: [".pan .pan-grands", ".pan .pan-tuiles"],
      texte: `<p><b>Service livré</b>, <b>régularité</b>, puis les tuiles : voyages sans véhicule ou annulés, gaps de service,
        bus en bunching, hors trajet, détours, en dépassement, pleins, positions figées.</p>` },
    { titre: "Courbes", cibles: [".pan .pan-graphes"],
      texte: `<p>Évolution depuis l'ouverture de la page : service livré et régularité, incidents en cours.
        Survolez une courbe pour lire les valeurs.</p>` },
    { titre: "Tableaux détaillés", cibles: [".pan .pan-blocs"],
      texte: `<p>Détail par ligne, bus, détour ou événement. <b>Clic sur un titre de colonne</b> : tri croissant / décroissant ;
        l'icône d'entonnoir au survol : <b>filtre</b>. Les filtres actifs sont rappelés dans la barre du haut
        (« Modifier les filtres »).</p>` },
    { titre: "Outils", cibles: [".tdbp-outils"],
      texte: `<p>Historique des événements en CSV, ouverture de la carte, plein écran (Échap pour sortir), ⓘ : définitions.</p>` },
  ],
};

const VISITE = {
  pages: [], i: 0, ouverte: false,
  racine: null, voile: null, carte: null, apercu: null, manifeste: null,
  sectionDepliee: null,   // section repliée (carte) ouverte le temps de sa page
  peek: false, peekAjoute: false,   // panneau replié (‹‹) montré le temps des pages qui en parlent
  signature: "",
};

function lireVisite(cle) { try { return localStorage.getItem(cle); } catch (e) { return null; } }
function ecrireVisite(cle, v) {
  try { if (v == null) localStorage.removeItem(cle); else localStorage.setItem(cle, v); } catch (e) { /* stockage indisponible */ }
}

function elementsVisite(cibles) {
  return (cibles || []).map(c => (typeof c === "string" ? document.querySelector(c) : c))
                       .filter(el => el && el.getClientRects().length);
}

// Toute première étape, sur chaque page : provenance des données et statut non officiel
const VISITE_AVERTISSEMENT = {
  titre: "Avant de commencer",
  etape: "Avertissement",
  bouton: "J'ai compris ›",
  cibles: [],
  texte: `<p>Application développée à titre de <b>projet de formation en développement web</b>. Il ne s'agit
      <b>pas d'une application officielle de la STM</b> : elle n'est ni affiliée, ni approuvée par la STM.</p>
    <p>Les <b>données temps réel</b> (positions et occupation des bus, annulations) proviennent de
      l'<b>API GTFS-Realtime de la Société de transport de Montréal (STM)</b>, fournies sous licence
      <b>CC-BY 4.0</b>. Ces données sont fournies « telles quelles », sans garantie d'exactitude ou de disponibilité.</p>
    <p>Les autres données sont elles aussi ouvertes (GTFS de la STM, OpenStreetMap sous ODbL, MNT Copernicus,
      données de la Ville de Montréal, normales climatiques ECCC). Les consommations d'énergie sont
      <b>estimées par un modèle physique</b>, pas mesurées. Le code est sous licence MIT.</p>`,
};

function pagesVisite() {
  const def = VISITE_DEFINITIONS[VISITE_PAGE];
  const pages = def ? def() : [];
  // Étapes dont aucune cible n'est affichée (section absente ou masquée) : sautées, sauf l'introduction
  return [VISITE_AVERTISSEMENT,
          ...pages.filter((p, i) => i === 0 || !p.cibles?.length || elementsVisite(p.cibles).length)];
}

function construireVisite() {
  const r = document.createElement("div");
  r.id = "visite";
  r.className = "visite";
  r.hidden = true;
  r.innerHTML =
    `<svg class="visite-voile" aria-hidden="true"><defs><mask id="visiteMasque"></mask></defs>
       <rect class="visite-fond" width="100%" height="100%" mask="url(#visiteMasque)"></rect>
       <g class="visite-contours"></g></svg>
     <div class="visite-carte" role="dialog" aria-modal="false" aria-labelledby="visiteTitre">
       <div class="visite-entete"><span class="visite-etape" id="visiteEtape"></span>
         <button type="button" class="visite-fermer" data-visite="passer" title="Quitter le guide (Échap)">×</button></div>
       <h2 id="visiteTitre" class="visite-titre"></h2>
       <div class="visite-texte" id="visiteTexte"></div>
       <div class="visite-points" id="visitePoints"></div>
       <div class="visite-pied">
         <label class="visite-jamais"><input type="checkbox" id="visiteJamais"> Ne plus l'afficher au lancement</label>
         <div class="visite-boutons">
           <button type="button" class="action-btn" data-visite="passer" id="visitePasser">Passer</button>
           <button type="button" class="action-btn" data-visite="precedent" id="visitePrecedent">‹ Précédent</button>
           <button type="button" class="action-btn primary" data-visite="suivant" id="visiteSuivant">Suivant ›</button>
         </div>
       </div>
     </div>
     <div class="visite-apercu" id="visiteApercu" hidden></div>`;
  document.body.appendChild(r);
  VISITE.racine = r;
  VISITE.voile = r.querySelector(".visite-voile");
  VISITE.carte = r.querySelector(".visite-carte");
  VISITE.apercu = r.querySelector("#visiteApercu");
  r.addEventListener("click", (e) => {
    const b = e.target.closest("[data-visite]");
    if (!b) return;
    if (b.dataset.visite === "suivant") allerPageVisite(VISITE.i + 1);
    else if (b.dataset.visite === "precedent") allerPageVisite(VISITE.i - 1);
    else fermerVisite();
  });
  r.querySelector("#visitePoints").addEventListener("click", (e) => {
    const p = e.target.closest("[data-page]");
    if (p) allerPageVisite(Number(p.dataset.page));
  });
  r.querySelector("#visiteJamais").addEventListener("change", (e) => ecrireVisite(CLE_VISITE_JAMAIS, e.target.checked ? "1" : null));
  // Une image chargée change la taille de l'aperçu : repositionner
  VISITE.apercu.addEventListener("load", () => { VISITE.signature = ""; }, true);
  VISITE.apercu.addEventListener("error", (e) => {
    e.target.closest?.("figure")?.remove();   // capture absente : on n'affiche pas de cadre vide
    VISITE.apercu.hidden = !VISITE.apercu.querySelector("figure");
    VISITE.signature = "";
  }, true);
  document.addEventListener("keydown", (e) => {
    if (!VISITE.ouverte || e.target.closest?.("input, select, textarea")) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); fermerVisite(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); allerPageVisite(VISITE.i + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); allerPageVisite(VISITE.i - 1); }
  }, true);
  // Manifeste des aperçus (captures en données simulées ou réelles, date)
  fetch("/static/apercus/apercus.json", { cache: "no-cache" }).then(r => (r.ok ? r.json() : null))
    .then(m => { VISITE.manifeste = m; if (VISITE.ouverte) majApercuVisite(); }).catch(() => {});
}

function ouvrirVisite(page = 0) {
  masquerRappelVisite();
  if (!VISITE.racine) construireVisite();
  VISITE.pages = pagesVisite();
  if (!VISITE.pages.length) return;
  VISITE.ouverte = true;
  VISITE.racine.hidden = false;
  document.getElementById("visiteJamais").checked = lireVisite(CLE_VISITE_JAMAIS) === "1";
  document.getElementById("btnVisite")?.classList.add("actif");
  allerPageVisite(page);
  requestAnimationFrame(boucleVisite);
}

function fermerVisite() {
  if (!VISITE.ouverte) return;
  quitterPageVisite();
  VISITE.ouverte = false;
  majPeekVisite();
  VISITE.racine.hidden = true;
  document.getElementById("btnVisite")?.classList.remove("actif");
  ecrireVisite(CLE_VISITE_VUE, VISITE_DEMARRAGE);
  document.getElementById("btnVisite")?.focus({ preventScroll: true });
  afficherRappelVisite();
}

// Bulle « Pssst » issue du bouton « ? » après la visite (quittée ou terminée) :
// 5 s, ou jusqu'à un clic dessus
const RAPPEL_VISITE_MS = 5000;
function afficherRappelVisite() {
  const btn = document.getElementById("btnVisite");
  if (!btn || !btn.getClientRects().length) return;
  let b = document.getElementById("visiteRappel");
  if (!b) {
    b = document.createElement("div");
    b.id = "visiteRappel";
    b.className = "visite-rappel";
    b.setAttribute("role", "status");
    b.title = "Cliquer pour fermer";
    b.innerHTML = "<b>Pssst</b>, le tutoriel reste accessible ici";
    b.addEventListener("click", masquerRappelVisite);
    document.body.appendChild(b);
  }
  b.hidden = false;
  b.classList.remove("visible");
  // Pointe de la bulle (à 17 px de son bord droit) sur le centre du bouton
  const r = btn.getBoundingClientRect();
  const w = b.offsetWidth, h = b.offsetHeight;
  b.style.left = `${Math.round(Math.max(8, Math.min(r.left + r.width / 2 + 17 - w, innerWidth - w - 8)))}px`;
  b.style.top = `${Math.round(Math.max(8, r.top - h - 12))}px`;
  requestAnimationFrame(() => b.classList.add("visible"));
  clearTimeout(VISITE.minuteurRappel);
  VISITE.minuteurRappel = setTimeout(masquerRappelVisite, RAPPEL_VISITE_MS);
}

function masquerRappelVisite() {
  clearTimeout(VISITE.minuteurRappel);
  const b = document.getElementById("visiteRappel");
  if (!b || b.hidden) return;
  b.classList.remove("visible");
  setTimeout(() => { if (!b.classList.contains("visible")) b.hidden = true; }, 200);
}

// Rend la section telle que l'utilisateur l'avait (repliée)
function quitterPageVisite() {
  if (VISITE.sectionDepliee) {
    if (typeof replierSection === "function") replierSection(VISITE.sectionDepliee, true);
    VISITE.sectionDepliee = null;
  }
}

function allerPageVisite(i) {
  if (i >= VISITE.pages.length) { fermerVisite(); return; }
  i = Math.max(0, i);
  quitterPageVisite();
  VISITE.i = i;
  const p = VISITE.pages[i];
  VISITE.peek = !!(p.panneau || p.peek);
  majPeekVisite();
  if (p.section) {
    if (p.section.classList.contains("replie") && typeof replierSection === "function") {
      replierSection(p.section, false);   // sans mémoriser : refermée en quittant la page
      VISITE.sectionDepliee = p.section;
    }
    p.section.scrollIntoView({ block: "nearest" });
  } else {
    elementsVisite(p.cibles)[0]?.scrollIntoView({ block: "nearest" });
  }
  document.getElementById("visiteEtape").textContent = p.etape || (i <= 1 ? "Visite guidée" : `Étape ${i} sur ${VISITE.pages.length - 1}`);
  document.getElementById("visiteTitre").textContent = p.titre;
  document.getElementById("visiteTexte").innerHTML = p.texte;
  document.getElementById("visitePoints").innerHTML = VISITE.pages.map((q, j) =>
    `<button type="button" class="visite-point${j === i ? " actif" : ""}" data-page="${j}" title="${q.titre}" aria-label="${q.titre}"></button>`).join("");
  document.getElementById("visitePrecedent").disabled = i === 0;
  const dernier = i === VISITE.pages.length - 1;
  document.getElementById("visiteSuivant").textContent = p.bouton || (dernier ? "Terminer" : i === 1 ? "Commencer la visite ›" : "Suivant ›");
  document.getElementById("visitePasser").hidden = dernier;
  majApercuVisite();
  VISITE.signature = "";
  placerVisite();
  document.getElementById("visiteSuivant").focus({ preventScroll: true });
}

// Aperçus des pages dont parle l'étape, à droite de la fiche
function majApercuVisite() {
  const p = VISITE.pages[VISITE.i];
  const noms = (p.apercus || []).filter(n => VISITE_APERCUS[n]);
  const a = VISITE.apercu;
  a.hidden = !noms.length;
  const m = VISITE.manifeste || {};
  a.innerHTML = noms.map(n => {
    const info = m[n] || {};
    const note = info.simule ? " · données temps réel simulées" : "";
    return `<figure><img src="/static/apercus/${n}.jpg${info.date ? `?v=${encodeURIComponent(info.date)}` : ""}"
      alt="Aperçu : ${VISITE_APERCUS[n]}"><figcaption>Aperçu : ${VISITE_APERCUS[n]}${note}</figcaption></figure>`;
  }).join("");
  VISITE.signature = "";
}

// Panneau replié (‹‹) : montré par-dessus le contenu le temps des pages qui en parlent
function majPeekVisite() {
  const replie = document.body.classList.contains("sidebar-collapsed");
  if (replie && VISITE.ouverte && VISITE.peek) {
    document.body.classList.add("peek");
    VISITE.peekAjoute = true;
  } else if (VISITE.peekAjoute) {
    if (replie) document.body.classList.remove("peek");
    VISITE.peekAjoute = false;
  }
}

// Voile percé autour des cibles, position de la fiche et des aperçus
function placerVisite() {
  const p = VISITE.pages[VISITE.i];
  const rects = elementsVisite(p.cibles).map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
  const carte = VISITE.carte, apercu = VISITE.apercu;
  const w = carte.offsetWidth, h = carte.offsetHeight;
  const aw = apercu.hidden ? 0 : apercu.offsetWidth, ah = apercu.hidden ? 0 : apercu.offsetHeight;
  const sig = rects.map(r => [r.left, r.top, r.width, r.height].map(Math.round).join(",")).join("|") +
              `|${innerWidth}x${innerHeight}|${w}x${h}|${aw}x${ah}`;
  if (sig === VISITE.signature) return;
  VISITE.signature = sig;

  const M = 6;   // marge autour de la cible
  const ns = "http://www.w3.org/2000/svg";
  const masque = VISITE.voile.querySelector("mask");
  const contours = VISITE.voile.querySelector(".visite-contours");
  masque.replaceChildren();
  contours.replaceChildren();
  const fond = document.createElementNS(ns, "rect");
  Object.entries({ width: "100%", height: "100%", fill: "white" }).forEach(([k, v]) => fond.setAttribute(k, v));
  masque.appendChild(fond);
  for (const r of rects) {
    // Cible plus grande que l'écran (zone principale) : bornée à la fenêtre
    const x1 = Math.max(r.left - M, 2), y1 = Math.max(r.top - M, 2);
    const x2 = Math.min(r.right + M, innerWidth - 2), y2 = Math.min(r.bottom + M, innerHeight - 2);
    const attrs = { x: x1, y: y1, width: Math.max(x2 - x1, 0), height: Math.max(y2 - y1, 0), rx: 8 };
    const trou = document.createElementNS(ns, "rect");
    const bord = document.createElementNS(ns, "rect");
    for (const [k, v] of Object.entries(attrs)) { trou.setAttribute(k, v); bord.setAttribute(k, v); }
    trou.setAttribute("fill", "black");
    bord.setAttribute("class", "visite-contour");
    masque.appendChild(trou);
    contours.appendChild(bord);
  }

  // Fiche : à droite du panneau (étapes du panneau), sinon sous / au-dessus de la
  // 1re cible, sinon centrée. Largeur réservée aux aperçus à sa droite.
  const panneau = document.getElementById("panel");
  const reserve = aw ? aw + 14 : 0;
  let left, top;
  const r0 = rects[0];
  const grande = r0 && r0.width * r0.height > innerWidth * innerHeight * 0.3;
  if (p.panneau && panneau && r0 && innerWidth > 700) {
    left = panneau.getBoundingClientRect().right + 18;
    top = r0.top;
  } else if (r0 && !grande && r0.bottom + 14 + h < innerHeight) {
    left = r0.left; top = r0.bottom + 14;
  } else if (r0 && !grande && r0.top - 14 - h > 0) {
    left = r0.left; top = r0.top - 14 - h;
  } else {
    const zone = (document.getElementById("main-view") || document.body).getBoundingClientRect();
    left = zone.left + (zone.width - w - reserve) / 2;
    top = zone.top + (zone.height - h) / 2;
  }
  left = Math.min(Math.max(left, 12), innerWidth - w - reserve - 12);
  if (left < 12) left = 12;
  top = Math.min(Math.max(top, 12), innerHeight - h - 12);
  carte.style.left = `${Math.round(left)}px`;
  carte.style.top = `${Math.round(top)}px`;
  if (aw) {
    // À droite de la fiche si la place le permet, sinon masqué (petits écrans)
    const ax = left + w + 14;
    const place = ax + aw <= innerWidth - 8;
    apercu.style.visibility = place ? "visible" : "hidden";
    apercu.style.left = `${Math.round(ax)}px`;
    apercu.style.top = `${Math.round(Math.min(Math.max(top, 12), innerHeight - ah - 12))}px`;
  }
}

// Suit les cibles (défilement du panneau, redimensionnement, contenu qui se charge)
function boucleVisite() {
  if (!VISITE.ouverte) return;
  majPeekVisite();
  placerVisite();
  requestAnimationFrame(boucleVisite);
}

function initVisite() {
  if (new URLSearchParams(location.search).has("apercu")) return;   // capture d'un aperçu
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "btnVisite";
  btn.className = "visite-btn";
  btn.textContent = "?";
  btn.title = "Visite guidée : présentation de la page et de chacune de ses parties";
  btn.setAttribute("aria-label", "Visite guidée");
  btn.addEventListener("click", () => (VISITE.ouverte ? fermerVisite() : ouvrirVisite()));
  const vue = document.getElementById("main-view");
  if (vue) vue.appendChild(btn); else { btn.classList.add("visite-btn-fixe"); document.body.appendChild(btn); }

  // Une fois par lancement du serveur (et par page), sauf refus explicite
  if (lireVisite(CLE_VISITE_JAMAIS) !== "1" && lireVisite(CLE_VISITE_VUE) !== VISITE_DEMARRAGE) {
    // Tableau de bord : attendre que les panneaux soient construits
    const delai = VISITE_PAGE === "tableau_de_bord" ? 2500 : 900;
    const lancer = () => setTimeout(() => { if (!VISITE.ouverte) ouvrirVisite(); }, delai);
    if (document.readyState === "complete") lancer(); else window.addEventListener("load", lancer, { once: true });
  }
}

initVisite();
