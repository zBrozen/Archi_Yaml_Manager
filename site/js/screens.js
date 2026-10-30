// Écrans des joueurs pour un stream : chaque joueur partage la fenêtre de son jeu depuis la page de la room,
// et l'overlay (page à mettre en source navigateur dans OBS) affiche les écrans partagés en grille.
//
// Les images vont directement du navigateur du joueur à l'overlay (WebRTC). Le service des rooms ne fait que
// les mettre en relation (WebSocket, Durable Object ScreenRoom du dossier worker/) : le joueur envoie une offre
// à chaque overlay qui lui demande son flux, l'overlay répond.
import { html, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { CopyButton, plural, useAction } from "./ui.js";
import { api, overlayLink, saveAccess, savedAccess, screensSocketUrl } from "./rooms-api.js";

// Serveurs STUN publics : suffisent pour la plupart des connexions. Sans relais TURN, certains réseaux
// (NAT strict, 4G, réseaux d'entreprise) ne passent pas : l'overlay l'indique sur l'écran du joueur.
const ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
const VIDEO = { width: { max: 1280 }, height: { max: 720 }, frameRate: { ideal: 30, max: 30 } };
const MAX_BITRATE = 2_500_000; // par overlay, en bit/s
const MAX_VIEWERS = 3; // overlays servis par un joueur (le service en refuse un quatrième)
const DEFAULT_SHOWN = 4;
const MAX_SHOWN = 6; // au-delà, les écrans deviennent trop petits pour être suivis sur Twitch
const RETRY = 8000;
const OFFER_TIMEOUT = 20000;

// Connexion au service, reprise seule après une coupure. `onState(state, message)` : connecting, ready,
// retrying, ou refused (accès refusé par le service : pas de nouvelle tentative).
function signaling(code, hello, onMessage, onState) {
  let ws = null;
  let retry = null;
  let ping = null;
  let stopped = false;
  const open = () => {
    onState("connecting");
    ws = new WebSocket(screensSocketUrl(code));
    ws.onopen = () => {
      ws.send(JSON.stringify(hello));
      ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("ping"), 25000);
    };
    ws.onmessage = (event) => {
      if (event.data === "pong") return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "error") { stopped = true; onState("refused", msg.message); return; }
      if (msg.type === "welcome") onState("ready");
      else onMessage(msg);
    };
    ws.onclose = () => {
      clearInterval(ping);
      if (stopped) return;
      onState("retrying");
      retry = setTimeout(open, 3000);
    };
  };
  open();
  return {
    send: (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
    close: () => { stopped = true; clearTimeout(retry); clearInterval(ping); ws?.close(); },
  };
}

// Messages traités un par un : une réponse doit être appliquée avant les candidats ICE qui la suivent.
function serial() {
  let queue = Promise.resolve();
  return (fn) => { queue = queue.then(fn).catch((e) => console.warn("écrans :", e)); };
}

// --- Joueur : partage de la fenêtre du jeu ---------------------------------------------

class Broadcast {
  constructor(code, token, stream, onChange) {
    this.stream = stream;
    this.peers = new Map(); // overlay → RTCPeerConnection
    this.state = "connecting";
    this.message = null;
    this.onChange = onChange;
    const queue = serial();
    this.signal = signaling(code, { type: "hello", role: "player", token }, (msg) => queue(() => this.receive(msg)), (state, message) => {
      this.state = state;
      this.message = message || null;
      // Après une coupure, les overlays redemandent le flux : les anciennes connexions ne servent plus.
      if (state !== "ready") this.closePeers();
      if (state === "refused") this.stopTracks();
      this.changed();
    });
  }

  get viewers() { return [...this.peers.values()].filter((pc) => pc.connectionState === "connected").length; }

  changed() { this.onChange(this); }

  async receive(msg) {
    if (msg.type === "left") return this.drop(msg.id);
    if (msg.type !== "signal" || !msg.data) return;
    const { from, data } = msg;
    if (data.type === "request") return this.offer(from);
    const pc = this.peers.get(from);
    if (!pc) return;
    if (data.type === "answer") await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
    else if (data.type === "ice") await pc.addIceCandidate(data.candidate);
    else if (data.type === "bye") this.drop(from);
  }

  async offer(to) {
    this.drop(to);
    if (this.peers.size >= MAX_VIEWERS) return this.signal.send({ type: "signal", to, data: { type: "busy" } });
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(to, pc);
    pc.onicecandidate = (e) => e.candidate && this.signal.send({ type: "signal", to, data: { type: "ice", candidate: e.candidate.toJSON() } });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.drop(to);
      this.changed();
    };
    for (const track of this.stream.getVideoTracks()) {
      pc.addTransceiver(track, { direction: "sendonly", streams: [this.stream], sendEncodings: [{ maxBitrate: MAX_BITRATE, maxFramerate: 30 }] });
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal.send({ type: "signal", to, data: { type: "offer", sdp: offer.sdp } });
  }

  // Autre fenêtre : la nouvelle image remplace l'ancienne sans refaire les connexions.
  replace(stream) {
    const [track] = stream.getVideoTracks();
    for (const pc of this.peers.values()) {
      for (const sender of pc.getSenders()) if (sender.track?.kind === "video") sender.replaceTrack(track);
    }
    this.stopTracks();
    this.stream = stream;
    this.changed();
  }

  drop(id) {
    const pc = this.peers.get(id);
    if (!pc) return;
    this.peers.delete(id);
    pc.close();
    this.changed();
  }

  closePeers() {
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
  }

  stopTracks() {
    for (const track of this.stream.getTracks()) track.stop();
  }

  stop() {
    this.signal.close();
    this.closePeers();
    this.stopTracks();
  }
}

async function captureWindow() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { ...VIDEO, displaySurface: "window" }, // propose d'abord les fenêtres, pas l'écran entier
    audio: false,
    selfBrowserSurface: "exclude",
  });
  const [track] = stream.getVideoTracks();
  if (track) track.contentHint = "motion"; // un jeu : garder la fluidité plutôt que la netteté du texte
  return stream;
}

function ShareScreen({ room }) {
  const [view, setView] = useState(null); // { state, message, viewers } pendant le partage
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const live = useRef(null);
  const preview = useRef(null);
  const supported = !!navigator.mediaDevices?.getDisplayMedia;

  const stop = () => {
    live.current?.stop();
    live.current = null;
    setView(null);
  };
  useEffect(() => () => live.current?.stop(), []);
  useEffect(() => {
    const stream = live.current?.stream || null;
    if (preview.current && preview.current.srcObject !== stream) preview.current.srcObject = stream;
  });

  const update = (broadcast) => {
    if (broadcast !== live.current) return;
    if (broadcast.state === "refused") {
      live.current = null;
      setView(null);
      setError(broadcast.message);
      return;
    }
    setView({ state: broadcast.state, viewers: broadcast.viewers });
  };

  const share = async () => {
    setError(null);
    setBusy(true);
    try {
      const stream = await captureWindow();
      // Partage arrêté depuis le bandeau du navigateur.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (live.current?.stream === stream) stop(); });
      if (live.current) live.current.replace(stream);
      else {
        live.current = new Broadcast(room.code, savedAccess(room.code).player, stream, update);
        update(live.current);
      }
    } catch (e) {
      // Fenêtre de choix fermée sans rien choisir : pas une erreur.
      if (e?.name !== "NotAllowedError" && e?.name !== "AbortError") setError(`Partage impossible : ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const status = !view ? null
    : view.state === "retrying" ? "Connexion au serveur perdue, nouvelle tentative…"
    : view.state === "connecting" ? "Connexion au serveur des rooms…"
    : view.viewers ? `Affiché sur ${plural(view.viewers, "overlay")} de stream.`
    : "Votre jeu est prêt à être affiché : il apparaîtra dès que l'overlay de l'hôte sera ouvert.";

  return html`<section class="card stack">
    <div class="row full">
      <h2 class="grow">Partager mon jeu</h2>
      ${view && html`<span class="badge ok">● Partage en cours</span>`}
    </div>
    <p>L'hôte peut afficher votre jeu dans son stream (overlay OBS). Partagez la fenêtre du jeu ou de l'émulateur :
      l'image va directement à l'overlay, sans son, et n'est pas enregistrée par le site.</p>
    ${!supported && html`<div class="notice warn full">Ce navigateur ne permet pas de partager une fenêtre (c'est le cas sur téléphone).
      Ouvrez la room dans Chrome, Edge ou Firefox sur l'ordinateur où vous jouez.</div>`}
    ${supported && html`<div class="row">
      ${view
        ? html`<button type="button" class="ghost" disabled=${busy} onClick=${share}>Changer de fenêtre</button>
          <button type="button" class="ghost" onClick=${stop}>Arrêter le partage</button>`
        : html`<button type="button" disabled=${busy} onClick=${share}>${busy ? "Choix de la fenêtre…" : "Partager la fenêtre de mon jeu"}</button>`}
    </div>`}
    ${status && html`<p role="status">${status}</p>`}
    ${view && html`<video class="screen-preview" ref=${preview} autoplay muted playsinline aria-label="Aperçu de votre partage"></video>`}
    ${error && html`<div class="notice error full">${error}</div>`}
    <ul class="hint tips">
      <li>Choisissez une <strong>fenêtre</strong> plutôt que l'écran entier : rien d'autre que le jeu ne sera visible.</li>
      <li>Écran noir dans l'aperçu ? Passez le jeu en mode fenêtré, ou en plein écran fenêtré (sans bordure).</li>
      <li>Gardez cette page ouverte pendant la partie (les autres onglets de la room ne l'arrêtent pas).
        Le partage envoie environ 2,5 Mb/s par overlay qui l'affiche.</li>
    </ul>
  </section>`;
}

// --- Hôte : lien de l'overlay ----------------------------------------------------------

function OverlayPanel({ room, data, setData }) {
  const action = useAction();
  const key = savedAccess(room.code).overlay;
  const link = room.overlay && key ? overlayLink(room.code, key) : null;
  const create = () => {
    if (room.overlay && !confirm(link
      ? "Remplacer le lien ? L'ancien cessera de marcher, y compris dans OBS."
      : "Un lien d'overlay existe déjà (créé depuis un autre navigateur). En créer un nouveau rend l'ancien inutilisable. Continuer ?")) return;
    action.run(async () => {
      const result = await api.overlayKey(room.code);
      saveAccess(room.code, { overlay: result.key });
      setData({ ...data, room: { ...room, overlay: true } });
    });
  };

  return html`<section class="card stack">
    <h2>Overlay pour OBS</h2>
    <p>Une page à ajouter dans OBS : elle affiche en grille le jeu des joueurs qui le partagent (onglet « Écrans »
      de la room), ${DEFAULT_SHOWN} à la fois.</p>
    ${link
      ? html`<div class="row">
          <${CopyButton} text=${link} label="Copier le lien de l'overlay" className="small" />
          <a class="button ghost small" href=${link} target="_blank" rel="noopener">Ouvrir l'overlay</a>
          <button type="button" class="ghost small" disabled=${action.busy} onClick=${create}>Remplacer le lien</button>
        </div>
        <p class="hint">Le lien n'est pas affiché pour ne pas apparaître dans votre stream : quiconque l'a voit les écrans partagés.
          S'il a fuité, remplacez-le.</p>`
      : html`<div class="row"><button type="button" disabled=${action.busy} onClick=${create}>
          ${room.overlay ? "Créer un nouveau lien d'overlay" : "Créer le lien de l'overlay"}</button></div>
        ${room.overlay && html`<p class="hint">Un lien existe déjà, créé depuis un autre navigateur : copiez-le là-bas, ou créez-en un nouveau ici.</p>`}`}
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
    <ol class="steps">
      <li>Dans OBS : <strong>Sources → + → Navigateur</strong>, collez le lien, avec une largeur de 1920 et une hauteur de 1080
        (ou la taille de la zone de votre scène réservée aux écrans).</li>
      <li>Les écrans se placent seuls en grille, dans l'ordre où les joueurs ont commencé à partager : ${DEFAULT_SHOWN} au maximum,
        pour rester lisibles sur Twitch. Ajoutez <code>?max=6</code> à la fin du lien pour en afficher jusqu'à 6,
        ou <code>?max=2</code> pour moins.</li>
      <li>Chaque joueur envoie son image à chaque overlay ouvert : ${MAX_VIEWERS} overlays au maximum par room.</li>
    </ol>
  </section>`;
}

export function ScreensTab({ room, me, admin, data, setData }) {
  return html`${me && html`<${ShareScreen} room=${room} />`}
    ${admin && html`<${OverlayPanel} room=${room} data=${data} setData=${setData} />`}`;
}

// --- Overlay : écrans en grille ----------------------------------------------------------

class Viewer {
  constructor(code, key, max, onChange) {
    this.max = max;
    this.streams = []; // joueurs qui partagent, dans l'ordre du service
    this.peers = new Map(); // joueur → { state, pc, stream, timer }
    this.state = "connecting";
    this.message = null;
    this.onChange = onChange;
    const queue = serial();
    this.signal = signaling(code, { type: "hello", role: "overlay", key }, (msg) => queue(() => this.receive(msg)), (state, message) => {
      this.state = state;
      this.message = message || null;
      if (state !== "ready") {
        for (const id of [...this.peers.keys()]) this.drop(id);
        this.streams = [];
      }
      this.changed();
    });
  }

  changed() {
    this.onChange({
      state: this.state,
      message: this.message,
      tiles: this.streams.slice(0, this.max).map((s) => {
        const peer = this.peers.get(s.id);
        return { ...s, state: peer?.state || "connecting", stream: peer?.stream || null };
      }),
    });
  }

  async receive(msg) {
    if (msg.type === "streams") {
      this.streams = msg.list;
      const wanted = new Set(this.streams.slice(0, this.max).map((s) => s.id));
      for (const id of [...this.peers.keys()]) {
        if (wanted.has(id)) continue;
        this.signal.send({ type: "signal", to: id, data: { type: "bye" } });
        this.drop(id);
      }
      for (const id of wanted) if (!this.peers.has(id)) this.request(id);
      this.changed();
    } else if (msg.type === "signal" && msg.data) {
      await this.answer(msg.from, msg.data);
    }
  }

  request(id, peer = { state: "connecting", pc: null, stream: null, timer: null }) {
    this.peers.set(id, peer);
    clearTimeout(peer.timer);
    // Sans réponse du joueur, nouvelle demande (l'écran garde son état : en attente, échec ou trop d'overlays).
    peer.timer = setTimeout(() => peer.state !== "live" && this.retry(id, peer.state === "connecting" ? "failed" : peer.state), OFFER_TIMEOUT);
    this.signal.send({ type: "signal", to: id, data: { type: "request" } });
  }

  // Nouvelle demande un peu plus tard ; l'écran indique en attendant pourquoi il est vide.
  retry(id, state) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc?.close();
    Object.assign(peer, { state, pc: null, stream: null });
    clearTimeout(peer.timer);
    peer.timer = setTimeout(() => this.peers.get(id) === peer && this.request(id, peer), RETRY);
    this.changed();
  }

  async answer(id, data) {
    const peer = this.peers.get(id);
    if (!peer) return;
    if (data.type === "busy") return this.retry(id, "busy");
    if (data.type === "ice") return peer.pc?.addIceCandidate(data.candidate);
    if (data.type !== "offer") return;
    peer.pc?.close();
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peer.pc = pc;
    pc.ontrack = (e) => {
      peer.stream = e.streams[0] || new MediaStream([e.track]);
      this.changed();
    };
    pc.onicecandidate = (e) => e.candidate && this.signal.send({ type: "signal", to: id, data: { type: "ice", candidate: e.candidate.toJSON() } });
    pc.onconnectionstatechange = () => {
      if (peer.pc !== pc) return;
      if (pc.connectionState === "connected") { peer.state = "live"; clearTimeout(peer.timer); }
      else if (pc.connectionState === "disconnected") peer.state = "unstable";
      else if (pc.connectionState === "failed") return this.retry(id, "failed");
      this.changed();
    };
    await pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.signal.send({ type: "signal", to: id, data: { type: "answer", sdp: answer.sdp } });
  }

  drop(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    clearTimeout(peer.timer);
    peer.pc?.close();
    this.peers.delete(id);
  }

  close() {
    this.signal.close();
    for (const id of [...this.peers.keys()]) this.drop(id);
  }
}

// Taille des écrans (16/9) : le nombre de colonnes qui les rend les plus grands possible dans la page.
export function gridLayout(count, width, height, gap) {
  let best = { columns: 1, width: 0 };
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const tile = Math.min((width - gap * (columns - 1)) / columns, ((height - gap * (rows - 1)) / rows) * 16 / 9);
    if (tile > best.width) best = { columns, width: tile };
  }
  const tile = Math.max(0, Math.floor(best.width));
  return { columns: best.columns, width: tile, height: Math.floor(tile * 9 / 16) };
}

function useWindowSize() {
  const read = () => ({ width: window.innerWidth, height: window.innerHeight });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const change = () => setSize(read());
    window.addEventListener("resize", change);
    return () => window.removeEventListener("resize", change);
  }, []);
  return size;
}

const TILE_STATES = {
  connecting: "Connexion à l'écran…",
  failed: "Connexion impossible avec ce joueur (réseau). Nouvelle tentative…",
  busy: "Ce joueur envoie déjà son écran à trop d'overlays.",
};

function Tile({ tile, width, height }) {
  const video = useRef(null);
  useEffect(() => {
    if (video.current && video.current.srcObject !== tile.stream) video.current.srcObject = tile.stream;
  }, [tile.stream]);
  // Texte proportionnel à l'écran, jamais trop petit pour être lu dans un stream.
  const font = Math.round(Math.min(40, Math.max(20, width / 34)));
  return html`<figure class="screen-tile" style=${{ width: `${width}px`, height: `${height}px`, fontSize: `${font}px` }}>
    ${tile.stream
      ? html`<video ref=${video} autoplay muted playsinline></video>`
      : html`<div class="screen-wait">${TILE_STATES[tile.state] || TILE_STATES.connecting}</div>`}
    <figcaption>
      <strong>${tile.label}</strong>${tile.games.length > 0 && html`<span class="screen-game"> · ${tile.games.join(", ")}</span>`}
      ${tile.state === "unstable" && html`<span class="screen-flag">Connexion instable</span>`}
    </figcaption>
  </figure>`;
}

const GAP = 8;

export function ScreensOverlay({ code, overlayKey, max }) {
  const [view, setView] = useState(null);
  const size = useWindowSize();
  const shown = Math.min(MAX_SHOWN, Math.max(1, Math.round(max) || DEFAULT_SHOWN));

  useEffect(() => {
    document.documentElement.classList.add("overlay-page");
    document.title = `Écrans · room ${code}`;
    const viewer = new Viewer(code, overlayKey, shown, setView);
    return () => viewer.close();
  }, []);

  if (!view) return null;
  if (view.state === "refused") return html`<div class="overlay"><p class="overlay-message">${view.message}</p></div>`;
  if (!view.tiles.length) {
    return html`<div class="overlay"><p class="overlay-message">
      ${view.state === "ready" ? `Room ${code} : aucun joueur ne partage son écran pour l'instant.` : "Connexion au serveur des rooms…"}
    </p></div>`;
  }
  const grid = gridLayout(view.tiles.length, size.width, size.height, GAP);
  return html`<div class="overlay">
    <div class="overlay-grid" style=${{ width: `${grid.columns * grid.width + (grid.columns - 1) * GAP}px`, gap: `${GAP}px` }}>
      ${view.tiles.map((tile) => html`<${Tile} key=${tile.id} tile=${tile} width=${grid.width} height=${grid.height} />`)}
    </div>
  </div>`;
}
