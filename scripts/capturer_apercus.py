"""
capturer_apercus.py
===================
Captures des pages de l'application pour les aperçus de la visite guidée
(serveur/static/apercus/<page>.jpg + apercus.json), copiées dans docs/apercus/
(page de présentation GitHub Pages).

Le serveur est lancé dans ce processus, en mode complet (VIZ_LIGHT ignoré :
Consommation et Simulation en ont besoin). Edge ou Chrome headless est piloté
par le protocole DevTools (client websocket minimal, bibliothèque standard) :
chaque page est ouverte, préparée par un script exécuté dans l'onglet (choix
d'un voyage, d'un segment… : le code des pages n'est pas modifié), attendue
jusqu'à ce qu'elle soit dessinée, puis capturée en JPEG réduit.

Tableau de bord : flux GTFS-RT réel si STM_API_KEY est définie ; sinon (ou avec
--simule), flux simulé : un bus par voyage prévu en cours (96 %), placé sur son
tracé au prorata de l'horaire. L'aperçu est alors légendé « données temps réel
simulées » dans la visite guidée (champ `simule` de apercus.json).

Usage : python scripts/capturer_apercus.py [--simule] [--navigateur CHEMIN] [--pages graphe,consommation]
"""
import argparse
import base64
import datetime as dt
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

RACINE = Path(__file__).resolve().parents[1]
SORTIE = RACINE / "serveur" / "static" / "apercus"
SORTIE_PAGES = RACINE / "docs" / "apercus"   # page de présentation GitHub Pages (copie)
LARGEUR_FENETRE, HAUTEUR_FENETRE = 1440, 900
LARGEUR_APERCU = 880            # affiché à 440 px (écrans haute densité)
NAVIGATEURS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "msedge", "google-chrome", "chromium", "chromium-browser",
]

# Préparation des pages (exécutée dans l'onglet) : attend une condition, puis agit
JS_COMMUN = """
const attendre = (f, ms = 60000) => new Promise((ok, ko) => {
  const t0 = Date.now();
  (function boucle() {
    let v = null; try { v = f(); } catch (e) {}
    if (v) ok(v); else if (Date.now() - t0 > ms) ko(new Error("délai")); else setTimeout(boucle, 200);
  })();
});
const choisir = (sel, i = 0) => { sel.selectedIndex = i; sel.dispatchEvent(new Event("change", { bubbles: true })); };
"""
PREP_VOYAGE = """(async () => {
  const p = await attendre(() => document.getElementById("parcoursSelect").options.length && document.getElementById("parcoursSelect"));
  choisir(p, Math.min(__PARCOURS__, p.options.length - 1));
  const v = await attendre(() => document.getElementById("voyageSelect").options.length && document.getElementById("voyageSelect"));
  choisir(v);
  document.getElementById("__BOUTON__").click();
})();"""
# nom -> (URL, préparation, condition « page prête », secondes de stabilisation, finition avant capture)
PAGES = {
    # Page principale (image d'accueil du README) : lignes colorées par la prévision énergétique
    "carte": ("/?apercu=1",
              """(async () => {
                 await attendre(() => typeof DataLoader !== 'undefined' && DataLoader.segments && document.getElementById('lineSelect').options.length);
                 const arrets = document.getElementById('chkShowStops'); if (arrets.checked) arrets.click();
                 modifierLignes({ remplacer: ['18', '24', '51', '55', '67', '80', '105', '121', '139', '165'] });
                 await new Promise(r => setTimeout(r, 1500));
                 const e = document.getElementById('chkEnergie'); if (!e.checked) e.click();
                 const r = await attendre(() => document.getElementById('chkEnergieRobuste')); if (!r.checked) r.click(); })();""",
              "document.getElementById('chkEnergie').checked && lignesGtfsSelectionnees().length > 5", 6,
              """map.fitBounds(L.featureGroup([...segmentLayers.values()].filter(e => e.visible).flatMap(e => e.polylines))
                 .getBounds(), { padding: [20, 20] })"""),
    # Courbes : dessinées à partir du 2e instantané du flux (~20 à 40 s)
    "tableau_de_bord": ("/tableau_de_bord?apercu=1", "",
                        "document.querySelectorAll('.pan .pan-tuiles > *').length > 0 && "
                        "!!document.querySelector('.pan [data-g=service] .graphe-zone svg')", 2, ""),
    # Mode « Toutes les lignes filtrées » (graphe plafonné à 300 nœuds)
    "graphe": ("/graphe?apercu=1",
               """(async () => { await attendre(() => DataLoader.relationsBySegment && document.querySelector('#cy canvas'));
                  document.getElementById('btnModeAll').click(); })();""",
               "Number(document.getElementById('statNodes')?.textContent || 0) > 50", 8,
               "document.getElementById('btnFitGraph').click()"),
    # Expansion manuelle décochée : l'arbre est construit jusqu'à la profondeur demandée
    "graphe_calcul": ("/graphe_calcul?apercu=1&depth=2&roots=__SEGMENT__",
                      """(async () => { const c = await attendre(() => document.getElementById('chkExpandMode'));
                         if (c.checked) c.click();
                         document.getElementById('btnRebuild').click(); })();""",
                      "Number(document.getElementById('statNodes')?.textContent || 0) > 1", 6,
                      "document.getElementById('btnFit').click()"),
    "consommation": ("/consommation?apercu=1", PREP_VOYAGE.replace("__BOUTON__", "btnTracer"),
                     "!!document.querySelector('#consoChart .main-svg')", 2, ""),
    "simulation": ("/simulation?apercu=1", PREP_VOYAGE.replace("__BOUTON__", "btnSimuler"),
                   "!!document.querySelector('#simChart .main-svg')", 2, ""),
}


def navigateur(chemin=None):
    for c in ([chemin] if chemin else NAVIGATEURS):
        if c and (Path(c).exists() or shutil.which(c)):
            return str(Path(c)) if Path(c).exists() else shutil.which(c)
    sys.exit("Edge ou Chrome introuvable : préciser --navigateur CHEMIN")


class DevTools:
    """Client minimal du protocole DevTools (websocket texte, sans dépendance)."""

    def __init__(self, url_ws):
        u = urlparse(url_ws)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=120)
        cle = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {cle}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        self.flux = self.sock.makefile("rb")
        entete = b""
        while not entete.endswith(b"\r\n\r\n"):
            entete += self.flux.read(1)
        if b" 101 " not in entete.split(b"\r\n")[0]:
            raise RuntimeError(f"Connexion DevTools refusée : {entete[:200]!r}")
        self.n = 0

    def _envoyer(self, texte):
        data, masque = texte.encode(), os.urandom(4)
        n = len(data)
        if n < 126:
            tete = bytes([0x81, 0x80 | n])
        elif n < 65536:
            tete = bytes([0x81, 0x80 | 126]) + struct.pack(">H", n)
        else:
            tete = bytes([0x81, 0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(tete + masque + bytes(b ^ masque[i % 4] for i, b in enumerate(data)))

    def _recevoir(self):
        morceaux = []
        while True:
            b1, b2 = self.flux.read(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self.flux.read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self.flux.read(8))[0]
            charge = self.flux.read(n)
            op = b1 & 0x0F
            if op == 8:
                raise RuntimeError("Connexion DevTools fermée")
            if op in (0, 1, 2):
                morceaux.append(charge)
                if b1 & 0x80:
                    return b"".join(morceaux).decode()

    def cmd(self, methode, **params):
        self.n += 1
        self._envoyer(json.dumps({"id": self.n, "method": methode, "params": params}))
        while True:
            m = json.loads(self._recevoir())
            if m.get("id") == self.n:
                if "error" in m:
                    raise RuntimeError(f"{methode} : {m['error']}")
                return m.get("result", {})

    def js(self, expression):
        r = self.cmd("Runtime.evaluate", expression=expression, returnByValue=True)
        return r.get("result", {}).get("value")


def ouvrir_navigateur(nav, dossier):
    proc = subprocess.Popen([nav, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
                             "--remote-debugging-port=0", f"--user-data-dir={dossier}",
                             f"--window-size={LARGEUR_FENETRE},{HAUTEUR_FENETRE}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    fichier = Path(dossier) / "DevToolsActivePort"
    for _ in range(150):
        if fichier.exists() and fichier.read_text().strip():
            break
        time.sleep(0.2)
    port = int(fichier.read_text().split()[0])
    for _ in range(50):
        try:
            cibles = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
            page = next(c for c in cibles if c["type"] == "page")
            return proc, DevTools(page["webSocketDebuggerUrl"])
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    raise RuntimeError("Navigateur headless injoignable")


def flux_simule(sv):
    """Remplace le téléchargement du flux STM par des positions simulées sur l'horaire en vigueur."""
    import numpy as np
    ref, sp = sv.RT_REF, sv.RT_REF["service"]
    rng = np.random.default_rng(7)
    occupations = ["MANY_SEATS_AVAILABLE", "FEW_SEATS_AVAILABLE", "STANDING_ROOM_ONLY", "FULL"]
    cumul = {}

    def point(k, frac):
        a, d, l2 = ref["traces"][k]
        if k not in cumul:
            long = np.sqrt(l2)
            cumul[k] = (np.concatenate([[0.0], np.cumsum(long)]), long)
        c, long = cumul[k]
        s = frac * c[-1]
        j = int(np.clip(np.searchsorted(c, s, side="right") - 1, 0, len(long) - 1))
        x, y = a[j] + d[j] * np.clip((s - c[j]) / long[j], 0, 1)
        return float(y / sv._RT_KY), float(x / sv._RT_KX)

    def decoder(contenu, t_collecte):
        t_flux = int(t_collecte // 20 * 20)
        lignes = []
        for date, s in sp.fenetres(t_flux):
            actifs = sp.services_actifs(date)[sp.service]
            for i in np.nonzero(actifs & (sp.debut <= s) & (sp.fin >= s))[0]:
                r = np.random.default_rng(hash(sp.trip_ids[i]) % 2**32)   # stable d'un instantané à l'autre
                if r.random() < 0.04:
                    continue                                             # voyage sans véhicule
                frac = (s - sp.debut[i]) / max(sp.fin[i] - sp.debut[i], 1) + r.normal(0, 0.02)
                lat, lon = point(int(ref["trace"][i]), float(np.clip(frac, 0, 1)))
                lignes.append({
                    "t_collecte": t_collecte, "t_position": t_flux - int(rng.integers(0, 15)),
                    "vehicule_id": f"S{int(i)}", "trip_id": sp.trip_ids[i],
                    "route_id": sp.route[i], "direction_id": int(sp.direction_id[i]),
                    "start_date": date.strftime("%Y%m%d"), "lat": lat, "lon": lon,
                    "cap": float(r.integers(0, 360)), "vitesse_ms": float(r.uniform(0, 12)),
                    "stop_id": None, "stop_sequence": None, "statut_arret": "IN_TRANSIT_TO",
                    "occupation": occupations[int(r.choice(4, p=[0.55, 0.25, 0.15, 0.05]))],
                })
        return t_flux, lignes

    sv.gtfs_rt.telecharger_flux = lambda flux, cle, timeout=10.0: (b"simulation", 200, 1)
    sv.gtfs_rt.decoder_positions = decoder
    sv.gtfs_rt.decoder_annulations = lambda contenu: set()


def segment_exemple(client):
    """Segment bien relié (graphe, graphe de calcul) : ~10 relations."""
    from collections import Counter
    rels = client.get("/api/relations?mode=normal").get_json()
    compte = Counter()
    for r in rels:
        compte[r["a"]] += 1
        compte[r["b"]] += 1
    candidats = sorted((abs(n - 10), s) for s, n in compte.items())
    return candidats[0][1]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--simule", action="store_true", help="flux temps réel simulé même si STM_API_KEY est définie")
    ap.add_argument("--navigateur", help="chemin d'Edge ou de Chrome")
    ap.add_argument("--pages", help="pages à capturer (séparées par des virgules), défaut : toutes")
    ap.add_argument("--parcours", type=int, default=0, help="rang du parcours choisi (Consommation, Simulation)")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    nav = navigateur(args.navigateur)

    simule = args.simule or not os.environ.get("STM_API_KEY")
    if simule:
        os.environ["STM_API_KEY"] = "simulation"
    os.environ.pop("VIZ_LIGHT", None)
    sys.path.insert(0, str(RACINE / "serveur"))
    os.chdir(RACINE / "serveur")
    import serveur_viz as sv   # noqa: E402  (charge les données : ~1 min)
    from werkzeug.serving import make_server  # noqa: E402
    if simule and sv.RT_REF:
        flux_simule(sv)

    segment = segment_exemple(sv.app.test_client())
    serveur = make_server("127.0.0.1", 0, sv.app, threaded=True)
    port = serveur.server_port
    threading.Thread(target=serveur.serve_forever, daemon=True).start()
    SORTIE.mkdir(parents=True, exist_ok=True)
    manifeste_path = SORTIE / "apercus.json"
    manifeste = json.loads(manifeste_path.read_text(encoding="utf-8")) if manifeste_path.exists() else {}
    choix = args.pages.split(",") if args.pages else list(PAGES)
    echelle = LARGEUR_APERCU / LARGEUR_FENETRE

    with tempfile.TemporaryDirectory() as tmp:
        proc, onglet = ouvrir_navigateur(nav, tmp)
        try:
            onglet.cmd("Page.enable")
            onglet.cmd("Emulation.setDeviceMetricsOverride", width=LARGEUR_FENETRE, height=HAUTEUR_FENETRE,
                       deviceScaleFactor=1, mobile=False)
            for nom in choix:
                chemin, prep, pret, stabilisation, finition = PAGES[nom]
                t0 = time.time()
                onglet.cmd("Page.navigate", url=f"http://127.0.0.1:{port}{chemin.replace('__SEGMENT__', str(segment))}")
                time.sleep(0.5)
                while onglet.js("document.readyState") != "complete" and time.time() - t0 < 60:
                    time.sleep(0.3)
                if prep:
                    onglet.js(JS_COMMUN + prep.replace("__SEGMENT__", str(segment)).replace("__PARCOURS__", str(args.parcours)) + "; 0")
                while not onglet.js(pret) and time.time() - t0 < 90:
                    time.sleep(0.5)
                if not onglet.js(pret):
                    print(f"  ✗ {nom} : page pas prête après 90 s (capture quand même)")
                time.sleep(stabilisation)
                if finition:
                    onglet.js(f"void ({finition})")   # sans valeur de retour (objets non sérialisables)
                    time.sleep(3)
                img =onglet.cmd("Page.captureScreenshot", format="jpeg", quality=82,
                                 clip={"x": 0, "y": 0, "width": LARGEUR_FENETRE, "height": HAUTEUR_FENETRE, "scale": echelle})
                (SORTIE / f"{nom}.jpg").write_bytes(base64.b64decode(img["data"]))
                if SORTIE_PAGES.parent.exists():
                    SORTIE_PAGES.mkdir(exist_ok=True)
                    (SORTIE_PAGES / f"{nom}.jpg").write_bytes(base64.b64decode(img["data"]))
                manifeste[nom] = {"date": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
                                  "simule": bool(simule and nom == "tableau_de_bord")}
                print(f"  ✓ {nom} ({(SORTIE / f'{nom}.jpg').stat().st_size // 1024} Ko, {time.time() - t0:.0f} s)")
        finally:
            proc.terminate()
            proc.wait(timeout=20)
    manifeste_path.write_text(json.dumps(manifeste, ensure_ascii=False, indent=1), encoding="utf-8")
    serveur.shutdown()
    print(f"Aperçus dans {SORTIE}" + (" — tableau de bord en données simulées" if simule else ""))


if __name__ == "__main__":
    main()
