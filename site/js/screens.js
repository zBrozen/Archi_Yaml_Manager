// Écrans des joueurs pour un stream : chaque joueur partage la fenêtre de son jeu depuis la page de la room,
// et l'overlay (page à mettre en source navigateur dans OBS) affiche les écrans partagés en grille.
//
// Les images vont directement du navigateur du joueur à l'overlay (WebRTC). Le service des rooms ne fait que
// les mettre en relation (WebSocket, Durable Object ScreenRoom du dossier worker/) : le joueur envoie une offre
// à chaque overlay qui lui demande son flux, l'overlay répond.
//
// L'overlay peut aussi montrer les messages de la partie (objets envoyés, objectifs atteints…) : il se connecte au
// serveur de la partie sur archipelago.gg comme client texte du premier joueur, comme le client texte de la room.
import { html, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { Client } from "../vendor/archipelago.js";
import { CopyButton, plural, useAction, useSetting } from "./ui.js";
import { MessagePart } from "./room-live.js";
import { api, apRoomStatus, overlayLink, saveAccess, savedAccess, screensSocketUrl } from "./rooms-api.js";

// Serveurs STUN publics : suffisent pour la plupart des connexions. Sans relais TURN, certains réseaux
// (NAT strict, 4G, réseaux d'entreprise) ne passent pas : l'overlay l'indique sur l'écran du joueur.
const ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

// Qualité du partage, choisie par chaque joueur. `bitrate` : débit maximum envoyé à chaque overlay, en bit/s.
// La connexion du joueur (envoi), son processeur (encodage) et la connexion du streamer (réception de tous les
// écrans) limitent ce qui passe réellement : le navigateur baisse la qualité de lui-même s'il le faut.
const QUALITIES = {
  legere: { label: "Légère", detail: "720p, 30 images/s, 1,5 Mb/s", width: 1280, height: 720, fps: 30, bitrate: 1_500_000 },
  normale: { label: "Normale", detail: "720p, 30 images/s, 3 Mb/s", width: 1280, height: 720, fps: 30, bitrate: 3_000_000 },
  haute: { label: "Haute", detail: "1080p, 30 images/s, 6 Mb/s", width: 1920, height: 1080, fps: 30, bitrate: 6_000_000 },
  max: { label: "Maximale", detail: "1080p, 60 images/s, 12 Mb/s", width: 1920, height: 1080, fps: 60, bitrate: 12_000_000 },
};
// Ce que le navigateur sacrifie quand le débit manque. `hint` : nature de l'image, pour l'encodeur.
const PRIORITIES = {
  equilibre: { label: "Équilibre", detail: "baisse un peu la netteté et la fluidité", hint: "motion", degradation: "balanced" },
  nettete: { label: "Netteté", detail: "garde la définition, quitte à saccader (jeux lents, pixel art)", hint: "detail", degradation: "maintain-resolution" },
  fluidite: { label: "Fluidité", detail: "garde les images par seconde, quitte à flouter (jeux rapides)", hint: "motion", degradation: "maintain-framerate" },
};
const DEFAULT_QUALITY = "normale";
const DEFAULT_PRIORITY = "equilibre";
const qualityOf = (name) => QUALITIES[name] || QUALITIES[DEFAULT_QUALITY];
const priorityOf = (name) => PRIORITIES[name] || PRIORITIES[DEFAULT_PRIORITY];
const captureConstraints = (q) => ({ width: { max: q.width }, height: { max: q.height }, frameRate: { ideal: q.fps, max: q.fps } });

const MAX_VIEWERS = 3; // overlays servis par un joueur (le service en refuse un quatrième)
const DEFAULT_SHOWN = 4;
const MAX_SHOWN = 6; // au-delà, les écrans deviennent trop petits pour être suivis sur Twitch
const RETRY = 8000;
const OFFER_TIMEOUT = 20000;
const FEED_LINES = 40; // messages gardés ; ceux qui ne tiennent pas dans la hauteur sont coupés en haut
const FEED_RETRY = 30000;
const FEED_WAIT = 60000; // partie pas encore hébergée : la room est relue de temps en temps

// Réglages de l'overlay, dans son adresse (#/overlay/CODE/CLÉ?max=4&console=droite&objets=tous).
const CONSOLE_PLACES = { droite: "À droite des écrans", bas: "Sous les écrans", non: "Masqués" };
const ITEM_FILTERS = { tous: "Tous les objets", importants: "Objets importants seulement (progression, utiles, pièges)" };

export function overlayOptions(params = {}) {
  const max = params.max == null || params.max === "" ? DEFAULT_SHOWN : Math.round(Number(params.max));
  return {
    max: Number.isFinite(max) ? Math.min(MAX_SHOWN, Math.max(0, max)) : DEFAULT_SHOWN,
    console: params.console in CONSOLE_PLACES ? params.console : "droite",
    objets: params.objets in ITEM_FILTERS ? params.objets : "tous",
  };
}

// Adresse de l'overlay avec les réglages qui diffèrent de ceux par défaut.
function overlayUrl(code, key, options) {
  const defaults = overlayOptions();
  const query = new URLSearchParams(Object.entries(options).filter(([k, v]) => v !== defaults[k]).map(([k, v]) => [k, String(v)]));
  return overlayLink(code, key) + (query.size ? `?${query}` : "");
}

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
  constructor(code, token, stream, quality, priority, onChange) {
    this.stream = stream;
    this.quality = quality;
    this.priority = priority;
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
    const senders = this.stream.getVideoTracks().map((track) => pc.addTransceiver(track, {
      direction: "sendonly",
      streams: [this.stream],
      sendEncodings: [{ maxBitrate: this.quality.bitrate, maxFramerate: this.quality.fps }],
    }).sender);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await Promise.all(senders.map((sender) => this.tune(sender)));
    this.signal.send({ type: "signal", to, data: { type: "offer", sdp: offer.sdp } });
  }

  // Débit, images par seconde et priorité d'un envoi. Le choix de priorité n'est pas connu de tous les
  // navigateurs : sans lui, le reste s'applique quand même.
  async tune(sender) {
    const apply = async (withPriority) => {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      for (const encoding of params.encodings) Object.assign(encoding, { maxBitrate: this.quality.bitrate, maxFramerate: this.quality.fps });
      if (withPriority) params.degradationPreference = this.priority.degradation;
      await sender.setParameters(params);
    };
    try { await apply(true); } catch {
      try { await apply(false); } catch (e) { console.warn("écrans :", e); }
    }
  }

  // Nouvelle qualité, appliquée tout de suite à la capture et à chaque overlay, sans couper le partage.
  async configure(quality, priority) {
    this.quality = quality;
    this.priority = priority;
    const [track] = this.stream.getVideoTracks();
    if (track) {
      track.contentHint = priority.hint;
      try { await track.applyConstraints(captureConstraints(quality)); } catch (e) { console.warn("écrans :", e); }
    }
    const senders = [...this.peers.values()].flatMap((pc) => pc.getSenders().filter((s) => s.track?.kind === "video"));
    await Promise.all(senders.map((sender) => this.tune(sender)));
  }

  // Ce qui part réellement vers le premier overlay connecté, et ce qui le limite (connexion, processeur).
  async sending(previous) {
    const pc = [...this.peers.values()].find((p) => p.connectionState === "connected");
    if (!pc) return null;
    for (const s of (await pc.getStats()).values()) {
      if (s.type !== "outbound-rtp" || s.kind !== "video") continue;
      const elapsed = previous ? s.timestamp - previous.at : 0;
      return {
        width: s.frameWidth,
        height: s.frameHeight,
        fps: s.framesPerSecond,
        bytes: s.bytesSent,
        at: s.timestamp,
        bitrate: elapsed > 0 && s.bytesSent >= previous.bytes ? ((s.bytesSent - previous.bytes) * 8000) / elapsed : null,
        limit: s.qualityLimitationReason,
      };
    }
    return null;
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

async function captureWindow(quality, priority) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { ...captureConstraints(quality), displaySurface: "window" }, // propose d'abord les fenêtres, pas l'écran entier
    audio: false,
    selfBrowserSurface: "exclude",
  });
  const [track] = stream.getVideoTracks();
  if (track) track.contentHint = priority.hint;
  return stream;
}

const LIMITS = {
  bandwidth: "Image réduite par votre connexion (envoi trop lent) : c'est normal les premières secondes ; si ça dure, choisissez une qualité plus basse.",
  cpu: "Image réduite par votre ordinateur (encodage trop lourd) : choisissez une qualité plus basse, ou moins d'images par seconde.",
};
const decimal = (n) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });

function SentInfo({ sent }) {
  if (!sent?.width) return null;
  return html`<div class="stack full">
    <p class="hint" role="status">Envoyé à l'overlay : ${sent.width} × ${sent.height}${sent.fps ? `, ${Math.round(sent.fps)} images/s` : ""}${sent.bitrate != null ? `, ${decimal(sent.bitrate / 1e6)} Mb/s` : ""}.</p>
    ${LIMITS[sent.limit] && html`<div class="notice warn full">${LIMITS[sent.limit]}</div>`}
  </div>`;
}

function ShareScreen({ room }) {
  const [view, setView] = useState(null); // { state, message, viewers } pendant le partage
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [qualityName, setQualityName] = useSetting("screenQuality", DEFAULT_QUALITY);
  const [priorityName, setPriorityName] = useSetting("screenPriority", DEFAULT_PRIORITY);
  const [sent, setSent] = useState(null);
  const live = useRef(null);
  const preview = useRef(null);
  const supported = !!navigator.mediaDevices?.getDisplayMedia;
  const quality = qualityOf(qualityName);
  const priority = priorityOf(priorityName);

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

  // Mesure de ce qui part, tant qu'un overlay affiche le jeu.
  const watched = !!view?.viewers;
  useEffect(() => {
    if (!watched) { setSent(null); return undefined; }
    let alive = true;
    let previous = null;
    const read = async () => {
      const next = await live.current?.sending(previous).catch(() => null);
      if (!alive) return;
      previous = next;
      setSent(next);
    };
    read();
    const timer = setInterval(read, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [watched]);

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

  const choose = (nextQuality, nextPriority) => {
    setQualityName(nextQuality);
    setPriorityName(nextPriority);
    live.current?.configure(qualityOf(nextQuality), priorityOf(nextPriority));
  };

  const share = async () => {
    setError(null);
    setBusy(true);
    try {
      const stream = await captureWindow(quality, priority);
      // Partage arrêté depuis le bandeau du navigateur.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (live.current?.stream === stream) stop(); });
      if (live.current) live.current.replace(stream);
      else {
        live.current = new Broadcast(room.code, savedAccess(room.code).player, stream, quality, priority, update);
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
    ${supported && html`<div class="fields full">
      <label><span>Qualité de l'image</span>
        <select value=${qualityName in QUALITIES ? qualityName : DEFAULT_QUALITY} onChange=${(e) => choose(e.target.value, priorityName)}>
          ${Object.entries(QUALITIES).map(([name, q]) => html`<option value=${name}>${q.label} (${q.detail})</option>`)}
        </select></label>
      <label><span>Si le débit manque, garder</span>
        <select value=${priorityName in PRIORITIES ? priorityName : DEFAULT_PRIORITY} onChange=${(e) => choose(qualityName, e.target.value)}>
          ${Object.entries(PRIORITIES).map(([name, p]) => html`<option value=${name}>${p.label}</option>`)}
        </select>
        <span class="hint">${priority.detail}</span></label>
    </div>
    <div class="row">
      ${view
        ? html`<button type="button" class="ghost" disabled=${busy} onClick=${share}>Changer de fenêtre</button>
          <button type="button" class="ghost" onClick=${stop}>Arrêter le partage</button>`
        : html`<button type="button" disabled=${busy} onClick=${share}>${busy ? "Choix de la fenêtre…" : "Partager la fenêtre de mon jeu"}</button>`}
    </div>`}
    ${status && html`<p role="status">${status}</p>`}
    <${SentInfo} sent=${sent} />
    ${view && html`<video class="screen-preview" ref=${preview} autoplay muted playsinline aria-label="Aperçu de votre partage"></video>`}
    ${error && html`<div class="notice error full">${error}</div>`}
    <ul class="hint tips">
      <li>Choisissez une <strong>fenêtre</strong> plutôt que l'écran entier : rien d'autre que le jeu ne sera visible.</li>
      <li>Écran noir dans l'aperçu ? Passez le jeu en mode fenêtré, ou en plein écran fenêtré (sans bordure).</li>
      <li>La qualité se change pendant le partage. Chaque overlay qui affiche votre jeu reçoit son propre envoi :
        le débit choisi compte une fois par overlay. Le 1080p ne se voit que si l'overlay affiche peu d'écrans
        (avec 4 écrans, chacun fait environ 960 × 540 dans un stream en 1080p).</li>
      <li>Gardez cette page ouverte pendant la partie (les autres onglets de la room ne l'arrêtent pas).</li>
    </ul>
  </section>`;
}

// --- Hôte : lien de l'overlay ----------------------------------------------------------

function OverlayPanel({ room, data, setData }) {
  const action = useAction();
  const access = savedAccess(room.code);
  const key = access.overlay;
  const [options, setOptions] = useState(() => overlayOptions(access.overlayOptions));
  const set = (name, value) => {
    const next = { ...options, [name]: value };
    setOptions(next);
    saveAccess(room.code, { overlayOptions: next });
  };
  const link = room.overlay && key ? overlayUrl(room.code, key, options) : null;
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
      de la room), et à côté les messages de la partie (objets envoyés, objectifs atteints…).</p>
    <div class="fields full">
      <label><span>Écrans affichés</span>
        <select value=${options.max} onChange=${(e) => set("max", Number(e.target.value))}>
          <option value="0">Aucun (messages seulement)</option>
          ${[1, 2, 3, 4, 5, 6].map((n) => html`<option value=${n}>${n === DEFAULT_SHOWN ? `${n} (conseillé)` : n}</option>`)}
        </select></label>
      ${options.max > 0 && html`<label><span>Messages de la partie</span>
        <select value=${options.console} onChange=${(e) => set("console", e.target.value)}>
          ${Object.entries(CONSOLE_PLACES).map(([value, label]) => html`<option value=${value}>${label}</option>`)}
        </select></label>`}
      ${(options.max === 0 || options.console !== "non") && html`<label class="span-all"><span>Objets montrés</span>
        <select value=${options.objets} onChange=${(e) => set("objets", e.target.value)}>
          ${Object.entries(ITEM_FILTERS).map(([value, label]) => html`<option value=${value}>${label}</option>`)}
        </select></label>`}
    </div>
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
      <li>Les écrans se placent seuls en grille, dans l'ordre où les joueurs ont commencé à partager.
        Au-delà de ${DEFAULT_SHOWN}, ils deviennent difficiles à suivre sur Twitch.</li>
      <li>Les réglages ci-dessus sont dans le lien copié : après un changement, recopiez-le dans OBS. Pour placer les
        messages ailleurs dans la scène, ajoutez une deuxième source avec « Écrans affichés : aucun ».</li>
      <li>Les messages arrivent une fois la partie en ligne : l'overlay s'y connecte comme client texte du premier joueur,
        qui apparaît donc connecté une fois de plus.</li>
      <li>Chaque joueur envoie son image à chaque overlay qui affiche des écrans : ${MAX_VIEWERS} au maximum par room.</li>
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

// Taille d'un élément (la zone des écrans, qui partage la page avec les messages de la partie).
function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
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

function Screens({ view, code, size }) {
  if (!view) return null;
  if (!view.tiles.length) {
    return html`<p class="overlay-message">
      ${view.state === "ready" ? `Room ${code} : aucun joueur ne partage son écran pour l'instant.` : "Connexion au serveur des rooms…"}
    </p>`;
  }
  const grid = gridLayout(view.tiles.length, size.width, size.height, GAP);
  if (!grid.width) return null;
  return html`<div class="overlay-grid" style=${{ width: `${grid.columns * grid.width + (grid.columns - 1) * GAP}px`, gap: `${GAP}px` }}>
    ${view.tiles.map((tile) => html`<${Tile} key=${tile.id} tile=${tile} width=${grid.width} height=${grid.height} />`)}
  </div>`;
}

// --- Overlay : messages de la partie -----------------------------------------------------

// Objets envoyés, objectifs atteints, release et collect, reçus en client texte du premier joueur.
// `important` : seulement les objets de progression, utiles et les pièges.
function useGameFeed(code, enabled, important) {
  const [feed, setFeed] = useState({ state: "loading", message: null, lines: [] });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let client = null;
    let timer = null;
    let nextId = 0;
    const update = (patch) => alive && setFeed((f) => ({ ...f, ...patch }));
    const push = (nodes) => alive && setFeed((f) => ({ ...f, lines: [...f.lines.slice(1 - FEED_LINES), { id: nextId++, nodes }] }));
    const later = (delay) => { clearTimeout(timer); timer = setTimeout(connect, delay); };
    const shown = (item) => !important || item.progression || item.useful || item.trap;

    const connect = async () => {
      try {
        const { room } = await api.get(code);
        if (!room.ap_room_url) { update({ state: "waiting", message: null }); later(FEED_WAIT); return; }
        // Lire la page de la room (par le service) réveille le serveur s'il est en veille ; le port peut alors changer.
        await api.apLinks(code).catch(() => {});
        const status = await apRoomStatus(code, room.ap_room_url);
        if (!status.port || !status.slots.length) throw new Error("Le serveur de la partie ne répond pas encore.");
        const next = new Client();
        next.messages.on("itemSent", (text, item, nodes) => shown(item) && push(nodes));
        next.messages.on("itemCheated", (text, item, nodes) => shown(item) && push(nodes));
        for (const event of ["goaled", "released", "collected"]) next.messages.on(event, (text, player, nodes) => push(nodes));
        next.socket.on("disconnected", () => {
          if (client !== next || !alive) return;
          client = null;
          update({ state: "retrying" });
          later(RETRY);
        });
        client = next;
        await next.login(`wss://${status.host}:${status.port}`, status.slots[0].name, undefined, { slotData: false, tags: ["TextOnly"] });
        update({ state: "live", message: null });
      } catch (e) {
        if (!alive) return;
        const failed = client;
        client = null;
        failed?.socket.disconnect();
        update({ state: "error", message: e?.message || String(e) });
        later(FEED_RETRY);
      }
    };
    connect();
    return () => {
      alive = false;
      clearTimeout(timer);
      const current = client;
      client = null;
      current?.socket.disconnect();
    };
  }, [code, enabled, important]);
  return feed;
}

const FEED_STATES = {
  loading: "Connexion à la partie…",
  waiting: "La partie n'est pas encore en ligne : les objets envoyés s'afficheront ici.",
  retrying: "Connexion à la partie perdue, nouvelle tentative…",
  live: "Connecté à la partie : les objets envoyés s'afficheront ici.",
};

function GameFeed({ feed }) {
  const status = feed.state === "error" ? `${feed.message} Nouvelle tentative dans ${FEED_RETRY / 1000} s.`
    : feed.state === "live" && feed.lines.length ? null
    : FEED_STATES[feed.state];
  return html`<div class="game-feed" role="log" aria-live="polite">
    ${feed.lines.map((line) => html`<div key=${line.id}>${line.nodes.map((node) => html`<${MessagePart} node=${node} marks />`)}</div>`)}
    ${status && html`<div class="feed-status">${status}</div>`}
  </div>`;
}

// --- Overlay : la page ---------------------------------------------------------------

// `params` : réglages lus dans l'adresse (voir overlayOptions). Sans écran (max=0), la page ne montre que les messages.
export function ScreensOverlay({ code, overlayKey, params }) {
  const options = overlayOptions(params);
  const place = options.max === 0 ? "plein" : options.console;
  const [view, setView] = useState(null);
  const [area, size] = useElementSize();
  const feed = useGameFeed(code, place !== "non" && view?.state !== "refused", options.objets === "importants");

  useEffect(() => {
    document.documentElement.classList.add("overlay-page");
    document.title = `Écrans · room ${code}`;
    if (!options.max) return undefined;
    const viewer = new Viewer(code, overlayKey, options.max, setView);
    return () => viewer.close();
  }, []);

  if (view?.state === "refused") {
    return html`<div class="overlay"><div class="overlay-screens"><p class="overlay-message">${view.message}</p></div></div>`;
  }
  return html`<div class=${`overlay overlay-${place}`}>
    ${options.max > 0 && html`<div class="overlay-screens" ref=${area}><${Screens} view=${view} code=${code} size=${size} /></div>`}
    ${place !== "non" && html`<${GameFeed} feed=${feed} />`}
  </div>`;
}
