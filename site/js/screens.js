// Onglet « Écrans » de la room : chaque joueur partage la fenêtre de son jeu, et chaque streamer (l'hôte ou un joueur)
// crée ses liens d'overlay pour la source « Navigateur » de son logiciel de stream (grille automatique, ou dispositions
// de l'éditeur de l'hôte, overlay-editor.js). L'overlay est dans overlay.js.
//
// Les images vont directement du navigateur du joueur à l'overlay (WebRTC). Le service des rooms ne fait que
// les mettre en relation (screens-net.js) : le joueur envoie une offre à chaque overlay qui lui demande son flux,
// l'overlay répond.
import { html, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { CopyButton, plural, useAction, useSetting } from "./ui.js";
import { api, overlayLink, saveAccess, savedAccess } from "./rooms-api.js";
import { ICE_SERVERS, serial, signaling } from "./screens-net.js";
import { CONSOLE_PLACES, ITEM_FILTERS, PROGRESS_MODES, ROTATIONS, SCREEN_MODES, spaceOf, spaceUses } from "./overlay-layout.js";
import { SpaceLayouts } from "./overlay-editor.js";

// Qualité du partage, choisie par chaque joueur. `bitrate` : débit maximum envoyé à chaque overlay, en bit/s.
// La connexion du joueur (envoi), son processeur (encodage) et la connexion du streamer (réception de tous les
// écrans) limitent ce qui passe réellement : le navigateur baisse la qualité de lui-même s'il le faut.
// `start` et `floor` (kbit/s) : débit de départ et minimum imposés à Chrome. Sans eux, il démarre vers 0,3 Mb/s
// et met des dizaines de secondes à monter ; le minimum n'est imposé qu'aux qualités choisies pour une bonne connexion.
const QUALITIES = {
  legere: { label: "Légère", detail: "720p, 30 images/s, 1,5 Mb/s", width: 1280, height: 720, fps: 30, bitrate: 1_500_000, start: 800, floor: 0 },
  normale: { label: "Normale", detail: "720p, 30 images/s, 3 Mb/s", width: 1280, height: 720, fps: 30, bitrate: 3_000_000, start: 1500, floor: 0 },
  haute: { label: "Haute", detail: "1080p, 30 images/s, 6 Mb/s", width: 1920, height: 1080, fps: 30, bitrate: 6_000_000, start: 4000, floor: 1500 },
  max: { label: "Maximale", detail: "1080p, 60 images/s, 12 Mb/s", width: 1920, height: 1080, fps: 60, bitrate: 12_000_000, start: 8000, floor: 3000 },
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
// Une caméra (celle d'OBS surtout) choisit sinon une petite définition : on lui demande celle de la qualité.
const cameraConstraints = (q) => ({ width: { ideal: q.width, max: q.width }, height: { ideal: q.height, max: q.height }, frameRate: { ideal: q.fps, max: q.fps } });
const isCamera = (track) => !track.getSettings().displaySurface; // une capture d'écran indique sa surface, pas une caméra

// Débits de la qualité ajoutés aux codecs vidéo de la réponse de l'overlay (paramètres x-google-*, lus par Chrome
// pour l'envoi, ignorés par les autres navigateurs). Un codec sans ligne a=fmtp (VP8) en reçoit une.
function withBitrates(sdp, quality) {
  const extra = [`x-google-start-bitrate=${quality.start}`, `x-google-max-bitrate=${quality.bitrate / 1000}`]
    .concat(quality.floor ? [`x-google-min-bitrate=${quality.floor}`] : []).join(";");
  const lines = sdp.split("\r\n");
  const codecs = new Set();
  let video = false;
  for (const line of lines) {
    if (line.startsWith("m=")) video = line.startsWith("m=video");
    const rtpmap = video && /^a=rtpmap:(\d+) ([\w-]+)\//.exec(line);
    if (rtpmap && !/^(rtx|red|ulpfec|flexfec)/i.test(rtpmap[2])) codecs.add(rtpmap[1]);
  }
  const hasFmtp = new Set(lines.map((line) => /^a=fmtp:(\d+) /.exec(line)?.[1]).filter((pt) => codecs.has(pt)));
  return lines.flatMap((line) => {
    const fmtp = /^a=fmtp:(\d+) /.exec(line);
    if (fmtp && codecs.has(fmtp[1])) return [`${line};${extra}`];
    const rtpmap = /^a=rtpmap:(\d+) /.exec(line);
    if (rtpmap && codecs.has(rtpmap[1]) && !hasFmtp.has(rtpmap[1])) return [line, `a=fmtp:${rtpmap[1]} ${extra}`];
    return [line];
  }).join("\r\n");
}

// Codec encodé par la carte graphique, s'il y en a un pour cette qualité : meilleure image à débit égal, et le
// processeur reste libre pour le jeu. Proposé en premier ; l'overlay en prend un autre s'il ne sait pas le lire.
const HARDWARE_CODECS = [
  ["video/AV1", "video/AV1"],
  ["video/VP9", "video/VP9"],
  ["video/H264", "video/H264;level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"],
];
const hardwareChoices = new Map();

function hardwareCodec(quality) {
  if (!hardwareChoices.has(quality)) {
    hardwareChoices.set(quality, (async () => {
      if (!navigator.mediaCapabilities?.encodingInfo) return null;
      for (const [mime, contentType] of HARDWARE_CODECS) {
        try {
          const info = await navigator.mediaCapabilities.encodingInfo({
            type: "webrtc",
            video: { contentType, width: quality.width, height: quality.height, bitrate: quality.bitrate, framerate: quality.fps },
          });
          if (info.supported && info.powerEfficient) return mime;
        } catch { /* codec inconnu de ce navigateur */ }
      }
      return null;
    })());
  }
  return hardwareChoices.get(quality);
}

function preferCodec(transceiver, mime) {
  if (!mime || !transceiver.setCodecPreferences) return;
  for (const source of [RTCRtpSender, RTCRtpReceiver]) {
    const codecs = source.getCapabilities?.("video")?.codecs || [];
    if (!codecs.some((c) => c.mimeType === mime)) continue;
    try {
      transceiver.setCodecPreferences([...codecs.filter((c) => c.mimeType === mime), ...codecs.filter((c) => c.mimeType !== mime)]);
      return;
    } catch { /* liste refusée : essai avec l'autre */ }
  }
}

const MAX_VIEWERS = 3; // overlays auxquels un joueur envoie son image ; les suivants reçoivent « busy »

// --- Joueur : partage de la fenêtre du jeu ---------------------------------------------

// `game` : jeu affiché à côté du nom sur les overlays ("" : tous ses jeux, "aucun" : aucun).
class Broadcast {
  constructor(code, token, stream, quality, priority, onChange, game = "") {
    this.stream = stream;
    this.quality = quality;
    this.priority = priority;
    this.peers = new Map(); // overlay → RTCPeerConnection
    this.state = "connecting";
    this.message = null;
    this.onChange = onChange;
    const queue = serial();
    // Présentation renvoyée à chaque reconnexion : elle garde le dernier jeu choisi.
    this.hello = { type: "hello", role: "player", token, game };
    this.signal = signaling(code, this.hello, (msg) => queue(() => this.receive(msg)), (state, message) => {
      this.state = state;
      this.message = message || null;
      // Après une coupure, les overlays redemandent le flux : les anciennes connexions ne servent plus.
      if (state !== "ready") this.closePeers();
      if (state === "refused") this.stopTracks();
      this.changed();
    });
  }

  setGame(game) {
    this.hello.game = game;
    this.signal.send({ type: "game", game });
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
    if (data.type === "answer") await pc.setRemoteDescription({ type: "answer", sdp: withBitrates(data.sdp, this.quality) });
    else if (data.type === "ice") await pc.addIceCandidate(data.candidate);
    else if (data.type === "bye") this.drop(from);
  }

  async offer(to) {
    const codec = await hardwareCodec(this.quality);
    this.drop(to);
    if (this.peers.size >= MAX_VIEWERS) return this.signal.send({ type: "signal", to, data: { type: "busy" } });
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(to, pc);
    pc.onicecandidate = (e) => e.candidate && this.signal.send({ type: "signal", to, data: { type: "ice", candidate: e.candidate.toJSON() } });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") this.drop(to);
      this.changed();
    };
    const transceivers = this.stream.getVideoTracks().map((track) => pc.addTransceiver(track, {
      direction: "sendonly",
      streams: [this.stream],
      sendEncodings: [{ maxBitrate: this.quality.bitrate, maxFramerate: this.quality.fps }],
    }));
    for (const transceiver of transceivers) preferCodec(transceiver, codec);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await Promise.all(transceivers.map((transceiver) => this.tune(transceiver.sender)));
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

  // Nouvelle qualité, appliquée tout de suite à la capture et à chaque overlay. Les débits de départ et le codec
  // se négocient à la connexion : chaque overlay reçoit alors une nouvelle offre (l'image se fige un instant).
  async configure(quality, priority) {
    const renegotiate = quality !== this.quality;
    this.quality = quality;
    this.priority = priority;
    const [track] = this.stream.getVideoTracks();
    if (track) {
      track.contentHint = priority.hint;
      const constraints = isCamera(track) ? cameraConstraints(quality) : captureConstraints(quality);
      try { await track.applyConstraints(constraints); } catch (e) { console.warn("écrans :", e); }
    }
    if (renegotiate) {
      for (const id of [...this.peers.keys()]) await this.offer(id);
      return;
    }
    const senders = [...this.peers.values()].flatMap((pc) => pc.getSenders().filter((s) => s.track?.kind === "video"));
    await Promise.all(senders.map((sender) => this.tune(sender)));
  }

  // Ce qui part réellement vers le premier overlay connecté, et ce qui le limite : débit que le navigateur
  // s'autorise vers l'overlay, latence et pertes (réseau), encodeur (processeur ou carte graphique).
  async sending(previous) {
    const pc = [...this.peers.values()].find((p) => p.connectionState === "connected");
    if (!pc) return null;
    const stats = await pc.getStats();
    let out = null;
    let remote = null;
    let pair = null;
    for (const s of stats.values()) {
      if (s.type === "outbound-rtp" && s.kind === "video") out = s;
      else if (s.type === "remote-inbound-rtp" && s.kind === "video") remote = s;
      else if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
      else if (!pair && s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s;
    }
    if (!out) return null;
    const same = previous?.id === out.id;
    const elapsed = same ? out.timestamp - previous.at : 0;
    return {
      id: out.id,
      width: out.frameWidth,
      height: out.frameHeight,
      fps: out.framesPerSecond,
      bytes: out.bytesSent,
      at: out.timestamp,
      bitrate: elapsed > 0 && out.bytesSent >= previous.bytes ? ((out.bytesSent - previous.bytes) * 8000) / elapsed : null,
      limit: out.qualityLimitationReason,
      codec: stats.get(out.codecId)?.mimeType?.replace(/^video\//, "") || null,
      hardware: out.powerEfficientEncoder ?? null,
      available: pair?.availableOutgoingBitrate ?? null,
      rtt: pair?.currentRoundTripTime ?? null,
      lost: remote?.fractionLost ?? null,
    };
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

// Partage par une caméra : surtout la caméra virtuelle d'OBS, qui reprend une « Capture de jeu » et passe donc
// là où le navigateur ne voit rien (jeux en plein écran exclusif). Sans caméra choisie, celle d'OBS est prise
// si elle existe. Les noms des caméras ne sont connus qu'après la première autorisation.
const isObsCamera = (device) => /obs/i.test(device.label);
const listCameras = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");

async function captureCamera(quality, priority, deviceId) {
  const open = async (id) => {
    const device = id ? { deviceId: { exact: id } } : {};
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...cameraConstraints(quality), ...device } });
    } catch (e) {
      // Définition ou images par seconde refusées par la caméra : on prend ce qu'elle donne.
      if (e.name !== "OverconstrainedError" || e.constraint === "deviceId") throw e;
      return navigator.mediaDevices.getUserMedia({ audio: false, video: id ? device : true });
    }
  };
  const obs = async () => (await listCameras()).find(isObsCamera)?.deviceId || null;
  // Essais : la caméra choisie (sinon celle d'OBS si son nom est déjà connu), puis celle d'OBS, puis celle par
  // défaut. Une webcam occupée ou une caméra mémorisée disparue n'empêche donc pas d'ouvrir celle d'OBS, dont le
  // nom n'apparaît qu'une fois la caméra autorisée.
  const tried = new Set();
  let failure = null;
  for (const pick of [async () => deviceId || obs(), obs, async () => null]) {
    const id = await pick();
    if (tried.has(id)) continue;
    tried.add(id);
    try {
      let stream = await open(id);
      const target = deviceId ? null : await obs();
      if (target && stream.getVideoTracks()[0]?.getSettings().deviceId !== target) {
        try {
          const better = await open(target);
          for (const track of stream.getTracks()) track.stop();
          stream = better;
        } catch { /* on garde la caméra déjà ouverte */ }
      }
      const [track] = stream.getVideoTracks();
      if (track) track.contentHint = priority.hint;
      return stream;
    } catch (e) {
      if (e.name === "NotAllowedError") throw e;
      failure ??= e;
    }
  }
  throw failure;
}

const CAMERA_ERRORS = {
  NotAllowedError: "Accès à la caméra refusé : autorisez la caméra pour ce site (icône à gauche de l'adresse), puis réessayez.",
  NotReadableError: "La caméra ne répond pas : elle est peut-être utilisée par une autre application, ou la caméra virtuelle d'OBS est arrêtée.",
};

// Le navigateur ne voit pas la caméra d'OBS : ce qu'il voit, et ce qui l'en empêche le plus souvent.
function CameraHelp({ error, seen }) {
  const names = seen.map((d) => d.label).filter(Boolean);
  return html`<div class="notice error full">
    <strong>Le navigateur ne trouve pas la caméra virtuelle d'OBS.</strong>
    ${" "}${seen.length === 0 ? "Il ne voit aucune caméra."
      : names.length ? `Caméras qu'il voit : ${names.join(", ")}.` : `Il voit ${seen.length} caméra(s), dont il ne donne le nom qu'après autorisation.`}
    <ul>
      <li>Dans OBS, la caméra virtuelle est bien démarrée (le bouton affiche « Arrêter la caméra virtuelle »).</li>
      <li>Fermez complètement le navigateur (toutes ses fenêtres) puis rouvrez-le : s'il était ouvert pendant l'installation
        d'OBS, il ne voit pas encore sa caméra.</li>
      <li>Windows autorise la caméra aux applications de bureau : Paramètres → Confidentialité et sécurité → Caméra.</li>
      <li>Avec un OBS « portable » (sans installation), la caméra virtuelle doit être installée à part : lancez une fois
        OBS en administrateur et démarrez la caméra virtuelle.</li>
      <li>Pour vérifier, dans Chrome ou Edge : Paramètres → Confidentialité et sécurité → Paramètres des sites → Caméra.
        La liste en haut montre les caméras que le navigateur voit ; « OBS Virtual Camera » doit y être.</li>
    </ul>
    ${error?.message && html`<span class="hint">Erreur du navigateur : ${error.name} (${error.message}).</span>`}
  </div>`;
}

const SOURCES = {
  window: { label: "La fenêtre du jeu", text: "Le plus simple : choisissez la fenêtre du jeu ou de l'émulateur." },
  camera: { label: "La caméra virtuelle d'OBS", text: "Si vous streamez déjà avec OBS, ou si le jeu est en plein écran." },
};

const decimal = (n) => n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
const LOSSY = 0.02; // au-delà de 2 % de paquets perdus, la limite vient vraiment du réseau

// Pourquoi l'image est réduite. Le débit « autorisé » est l'estimation du navigateur vers l'overlay, pas la
// capacité de la connexion : il la monte tant que rien ne se perd, et une image immobile la fait peu monter.
function limitText(sent, quality) {
  if (sent.limit === "cpu") {
    return `Image réduite : l'encodage est trop lourd pour l'ordinateur.${sent.hardware === false ? " Il se fait par le processeur (aucun codec de la carte graphique n'a été trouvé pour cette qualité)." : ""}
      Choisissez une qualité plus basse, ou moins d'images par seconde.`;
  }
  if (sent.limit !== "bandwidth") return null;
  if (sent.available && sent.available >= quality.bitrate * 0.95) {
    return `Image réduite pour tenir dans le débit de la qualité choisie (${decimal(quality.bitrate / 1e6)} Mb/s) :
      choisissez une qualité plus haute si votre connexion et celle du streamer le permettent.`;
  }
  const allowed = sent.available ? ` (${decimal(sent.available / 1e6)} Mb/s pour l'instant)` : "";
  return sent.lost != null && sent.lost > LOSSY
    ? `Image réduite au débit que le navigateur s'autorise vers l'overlay${allowed}, et des paquets se perdent :
      la limite vient du réseau entre vous et le streamer. Choisissez une qualité plus basse.`
    : `Image réduite au débit que le navigateur s'autorise vers l'overlay${allowed}. Il l'augmente tant que rien
      ne se perd ; une image presque immobile (menu, pause, autre fenêtre) le fait monter moins vite.`;
}

function SentInfo({ sent, quality }) {
  if (!sent?.width) return null;
  const encoder = sent.codec && `${sent.codec}${sent.hardware === true ? " (carte graphique)" : sent.hardware === false ? " (processeur)" : ""}`;
  const network = [
    sent.available != null && `le navigateur s'autorise ${decimal(sent.available / 1e6)} Mb/s`,
    sent.rtt != null && `latence ${Math.round(sent.rtt * 1000)} ms`,
    sent.lost != null && `pertes ${decimal(sent.lost * 100)} %`,
  ].filter(Boolean);
  const limit = limitText(sent, quality);
  // Mesures repliées : seule une image réduite mérite d'être signalée d'emblée.
  return html`<div class="stack full">
    ${limit && html`<div class="notice warn full">${limit}</div>`}
    <details class="more">
      <summary>Ce qui part vers l'overlay</summary>
      <p class="hint" role="status">${sent.width} × ${sent.height}${sent.fps ? `, ${Math.round(sent.fps)} images/s` : ""}${sent.bitrate != null ? `, ${decimal(sent.bitrate / 1e6)} Mb/s` : ""}${encoder ? `, encodé en ${encoder}` : ""}.</p>
      ${network.length > 0 && html`<p class="hint">Réseau : ${network.join(" · ")}.</p>`}
    </details>
  </div>`;
}

// `games` : jeux des YAML du joueur, dont il choisit celui affiché à côté de son nom.
function ShareScreen({ room, games = [] }) {
  const [view, setView] = useState(null); // { state, message, viewers } pendant le partage
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [qualityName, setQualityName] = useSetting("screenQuality", DEFAULT_QUALITY);
  const [priorityName, setPriorityName] = useSetting("screenPriority", DEFAULT_PRIORITY);
  const [sourceName, setSourceName] = useSetting("screenSource", "window");
  const [cameraId, setCameraId] = useSetting("screenCamera", "");
  const [gameName, setGameName] = useSetting(`screenGame:${room.code}`, "");
  const shownGame = gameName === "aucun" || games.includes(gameName) ? gameName : "";
  const pickGame = (next) => { setGameName(next); live.current?.setGame(next); };
  const [cameras, setCameras] = useState([]); // caméras dont le nom est connu (après une première autorisation)
  const [sent, setSent] = useState(null);
  const live = useRef(null);
  const preview = useRef(null);
  const windowSupported = !!navigator.mediaDevices?.getDisplayMedia;
  const cameraSupported = !!navigator.mediaDevices?.getUserMedia;
  // Sur téléphone, pas de partage de fenêtre : seulement une caméra.
  const source = windowSupported && sourceName in SOURCES ? sourceName : cameraSupported ? "camera" : "window";
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

  // Liste des caméras, tenue à jour quand on en branche ou qu'OBS démarre sa caméra virtuelle.
  const refreshCameras = () => listCameras()
    .then((list) => setCameras(list.filter((d) => d.label)))
    .catch(() => {});
  useEffect(() => {
    if (!cameraSupported) return undefined;
    refreshCameras();
    navigator.mediaDevices.addEventListener?.("devicechange", refreshCameras);
    return () => navigator.mediaDevices.removeEventListener?.("devicechange", refreshCameras);
  }, []);

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

  // Démarre le partage, ou remplace l'image en cours (autre fenêtre, autre caméra, autre source).
  const share = async (nextSource = source, nextCamera = cameraId) => {
    setError(null);
    setBusy(true);
    try {
      const stream = nextSource === "camera"
        ? await captureCamera(quality, priority, nextCamera)
        : await captureWindow(quality, priority);
      if (nextSource === "camera") {
        setCameraId(stream.getVideoTracks()[0]?.getSettings().deviceId || "");
        refreshCameras();
      }
      // Partage arrêté depuis le bandeau du navigateur, ou caméra débranchée.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (live.current?.stream === stream) stop(); });
      if (live.current) live.current.replace(stream);
      else {
        live.current = new Broadcast(room.code, savedAccess(room.code).player, stream, quality, priority, update, shownGame);
        update(live.current);
      }
    } catch (e) {
      if (nextSource === "camera") {
        setError(CAMERA_ERRORS[e?.name]
          || html`<${CameraHelp} error=${e} seen=${await listCameras().catch(() => [])} />`);
      }
      // Fenêtre de choix fermée sans rien choisir : pas une erreur.
      else if (e?.name !== "NotAllowedError" && e?.name !== "AbortError") setError(`Partage impossible : ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  const pickSource = (next) => {
    setSourceName(next);
    if (live.current) share(next);
  };
  const pickCamera = (next) => {
    setCameraId(next);
    if (live.current) share("camera", next);
  };

  const status = !view ? null
    : view.state === "retrying" ? "Connexion perdue, nouvelle tentative…"
    : view.state === "connecting" ? "Connexion…"
    : view.viewers ? `Votre jeu est affiché dans le stream (${plural(view.viewers, "overlay")}). Gardez cette page ouverte.`
    : "Prêt : votre jeu apparaîtra dès qu'un streamer ouvrira son overlay. Gardez cette page ouverte.";
  const camera = source === "camera";
  const startLabel = busy ? (camera ? "Ouverture de la caméra…" : "Choix de la fenêtre…")
    : camera ? "Partager la caméra d'OBS" : "Partager la fenêtre de mon jeu";
  const qualityKey = qualityName in QUALITIES ? qualityName : DEFAULT_QUALITY;
  const priorityKey = priorityName in PRIORITIES ? priorityName : DEFAULT_PRIORITY;

  // L'essentiel d'abord (quoi partager, le bouton) ; qualité et dépannage repliés.
  return html`<section class="card stack">
    <div class="row full">
      <h2 class="grow">Montrer mon jeu dans le stream</h2>
      ${view && html`<span class="badge ok">● En partage</span>`}
    </div>
    <p>Votre image (sans le son) va directement aux overlays des streamers de la room. Le site ne l'enregistre pas.</p>
    ${!windowSupported && !cameraSupported && html`<div class="notice warn full">Ce navigateur ne peut pas partager d'image :
      ouvrez la room dans Chrome, Edge ou Firefox, sur l'ordinateur où vous jouez.</div>`}
    ${(windowSupported || cameraSupported) && html`
    ${windowSupported && cameraSupported && html`<fieldset class="start-choice full">
      <legend class="sr-only">Image à partager</legend>
      ${Object.entries(SOURCES).map(([name, s]) => html`<label class=${`start-option ${source === name ? "selected" : ""}`}>
        <input type="radio" name="screen-source" value=${name} checked=${source === name} disabled=${busy} onChange=${() => pickSource(name)} />
        <span><strong>${s.label}</strong><span class="hint">${s.text}</span></span>
      </label>`)}
    </fieldset>`}
    ${camera && html`<ol class="steps">
      <li>Dans OBS, mettez votre jeu dans la scène (source <strong>Capture de jeu</strong>).</li>
      <li>Cliquez sur <strong>Démarrer la caméra virtuelle</strong> (en bas à droite d'OBS).</li>
      <li>Ici, cliquez sur « Partager la caméra d'OBS » et autorisez la caméra.</li>
    </ol>`}
    ${camera && cameras.length > 0 && html`<div class="fields full"><label><span>Caméra</span>
      <select value=${cameras.some((c) => c.deviceId === cameraId) ? cameraId : ""} disabled=${busy} onChange=${(e) => pickCamera(e.target.value)}>
        <option value="">Automatique (OBS en priorité)</option>
        ${cameras.map((c) => html`<option value=${c.deviceId}>${c.label}</option>`)}
      </select></label></div>`}
    ${games.length > 0 && html`<div class="fields full"><label><span>Jeu affiché à côté de votre nom</span>
      <select value=${shownGame} onChange=${(e) => pickGame(e.target.value)}>
        ${games.length > 1 && html`<option value="">Tous mes jeux (${games.join(", ")})</option>`}
        ${games.map((g) => html`<option value=${g}>${g}</option>`)}
        <option value="aucun">Aucun (seulement mon nom)</option>
      </select>
      <span class="hint">Se change pendant le partage.</span></label></div>`}
    <div class="row">
      ${view
        ? html`${!camera && html`<button type="button" class="ghost" disabled=${busy} onClick=${() => share()}>Changer de fenêtre</button>`}
          <button type="button" class="ghost" onClick=${stop}>Arrêter le partage</button>`
        : html`<button type="button" disabled=${busy} onClick=${() => share()}>${startLabel}</button>`}
    </div>`}
    ${status && html`<p role="status"><strong>${status}</strong></p>`}
    ${error && (typeof error === "string" ? html`<div class="notice error full">${error}</div>` : error)}
    ${view && html`<video class="screen-preview" ref=${preview} autoplay muted playsinline aria-label="Aperçu de votre partage"></video>`}
    <${SentInfo} sent=${sent} quality=${quality} />
    ${(windowSupported || cameraSupported) && html`<details class="more">
      <summary>Qualité de l'image <span class="hint">(${QUALITIES[qualityKey].label}, ${PRIORITIES[priorityKey].label.toLowerCase()})</span></summary>
      <div class="fields full">
        <label><span>Qualité</span>
          <select value=${qualityKey} onChange=${(e) => choose(e.target.value, priorityName)}>
            ${Object.entries(QUALITIES).map(([name, q]) => html`<option value=${name}>${q.label} (${q.detail})</option>`)}
          </select></label>
        <label><span>Si la connexion ne suit pas, garder</span>
          <select value=${priorityKey} onChange=${(e) => choose(qualityName, e.target.value)}>
            ${Object.entries(PRIORITIES).map(([name, p]) => html`<option value=${name}>${p.label}</option>`)}
          </select>
          <span class="hint">${priority.detail}</span></label>
      </div>
      <p class="hint">Se change pendant le partage. Jugez avec le jeu en mouvement : une image immobile n'envoie presque rien.</p>
    </details>
    <details class="more">
      <summary>Image noire, figée ou floue ?</summary>
      <ul class="hint tips">
        ${!camera && html`<li>Choisissez une <strong>fenêtre</strong> plutôt que l'écran entier : seul le jeu sera visible.</li>
          <li>Image noire ou figée : le jeu est en plein écran exclusif. Passez-le en fenêtré, ou partagez la caméra d'OBS.</li>`}
        <li>Image floue : avec plusieurs écrans dans le stream, chacun est petit ; le 1080p ne sert qu'avec peu d'écrans.</li>
        <li>Les autres onglets de la room n'arrêtent pas le partage ; fermer cette page, si.</li>
      </ul>
    </details>`}
  </section>`;
}

// --- Espaces de partage d'écrans ----------------------------------------------------------
// Un espace = un lien d'overlay (`#/overlay/CODE/CLÉ`). L'hôte et chaque joueur en créent ; tous les inscrits voient
// la liste et peuvent copier n'importe quel espace. Seuls son créateur et l'hôte le renomment ou le suppriment.

const formatDay = (ms) => new Date(ms).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

const canManage = (link, me, admin) => admin || (!!me && link.player_id === me.id);

function SpaceRow({ room, link, manage, action, onLinks, onSettings }) {
  const [name, setName] = useState(null); // nom en cours de modification
  // Les réglages de l'overlay sont gardés par le service : le lien est le même pour tous.
  const url = overlayLink(room.code, link.key);
  const rename = (e) => {
    e.preventDefault();
    action.run(async () => {
      onLinks((await api.updateOverlayLink(room.code, link.id, { name })).links);
      setName(null);
    });
  };
  const remove = () => confirm(`Supprimer l'espace « ${link.name} » ? Les overlays ouverts avec lui s'arrêteront.`)
    && action.run(async () => onLinks((await api.deleteOverlayLink(room.code, link.id)).links));

  return html`<li>
    ${name === null
      ? html`<div class="grow"><strong>${link.name}</strong>${" "}<span class="hint">par ${link.by || "l'hôte"} · ${formatDay(link.created_at)}</span></div>
        <${CopyButton} text=${url} label="Copier le lien pour OBS" className="small" />
        <button type="button" class="ghost small" onClick=${() => onSettings(link.id)}>Overlay</button>
        <a class="button ghost small" href=${url} target="_blank" rel="noopener">Ouvrir</a>
        ${manage && html`<button type="button" class="ghost small" disabled=${action.busy} onClick=${() => setName(link.name)}>Renommer</button>
          <button type="button" class="ghost small" disabled=${action.busy} onClick=${remove}>Supprimer</button>`}`
      : html`<form class="row grow" onSubmit=${rename}>
        <input type="text" class="grow" required maxLength="40" value=${name} aria-label="Nouveau nom de l'espace"
          onInput=${(e) => setName(e.target.value)} />
        <button type="submit" class="small" disabled=${action.busy || !name.trim()}>Enregistrer</button>
        <button type="button" class="ghost small" onClick=${() => setName(null)}>Annuler</button>
      </form>`}
  </li>`;
}

// Liste commune des espaces. `onSettings(id)` : ouvre la vue « Overlay » de l'espace (aussi juste après sa création).
function SpacesPanel({ room, data, setData, me, admin, onSettings }) {
  const action = useAction();
  const access = savedAccess(room.code);
  const links = data.overlay_links || [];
  const [name, setName] = useState("");
  const onLinks = (next) => setData((d) => ({ ...d, overlay_links: next, room: { ...d.room, overlay: false } }));

  // Lien unique d'avant la liste, gardé par le navigateur de l'hôte : il rejoint la liste, et les sources qui
  // l'utilisent continuent de marcher.
  useEffect(() => {
    const old = access.overlay;
    if (!admin || !old) return;
    if (links.some((l) => l.key === old)) { saveAccess(room.code, { overlay: null }); return; }
    if (!room.overlay) return;
    api.createOverlayLink(room.code, { name: "Lien d'origine", key: old })
      .then((result) => onLinks(result.links))
      .catch(() => {})
      .finally(() => saveAccess(room.code, { overlay: null }));
  }, [room.overlay]);

  const create = (e) => {
    e.preventDefault();
    action.run(async () => {
      const next = (await api.createOverlayLink(room.code, { name })).links;
      onLinks(next);
      setName("");
      const added = next.find((l) => !links.some((o) => o.id === l.id));
      if (added) onSettings(added.id);
    });
  };

  return html`<section class="card stack">
    <h2>Espaces de partage</h2>
    <p>Un espace réunit les jeux partagés et les infos de la partie, pour un stream. Tous les joueurs voient cette liste
      et peuvent copier n'importe quel espace.</p>
    ${links.length > 0
      ? html`<ul class="link-list full">${links.map((link) => html`<${SpaceRow} key=${link.id} room=${room} link=${link}
          manage=${canManage(link, me, admin)} action=${action} onLinks=${onLinks} onSettings=${onSettings} />`)}</ul>`
      : html`<p class="hint">Aucun espace pour l'instant.</p>`}
    <form class="row full" onSubmit=${create}>
      <input type="text" class="grow" maxLength="40" value=${name} placeholder=${`Nom de l'espace (ex. Stream de ${me?.pseudo || "l'hôte"})`}
        aria-label="Nom du nouvel espace" onInput=${(e) => setName(e.target.value)} />
      <button type="submit" class=${links.length ? "ghost" : ""} disabled=${action.busy}>Créer un espace</button>
    </form>
    <p class="hint">« Copier le lien pour OBS », puis dans OBS : <strong>Sources → + → Navigateur</strong>, collez-le, taille
      1920 × 1080. Marche aussi avec Streamlabs, XSplit… Ne montrez jamais le lien à l'écran.</p>
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
  </section>`;
}

// --- Overlay d'un espace : ce qu'il montre, et l'écran en vedette en direct -------------------------

const select = (value, choices, onChange) => html`<select value=${value} onChange=${(e) => onChange(e.target.value)}>
  ${Object.entries(choices).map(([k, label]) => html`<option value=${k}>${label}</option>`)}
</select>`;

// Écran en vedette, changé en direct par le créateur de l'espace ou l'hôte : les overlays ouverts suivent aussitôt.
function FeaturedControl({ room, link, players, rotation, onLinks }) {
  const action = useAction();
  const pick = (player) => action.run(async () => onLinks((await api.setFeatured(room.code, link.id, player)).links));
  return html`<section class="card stack">
    <h2>En direct : écran en vedette</h2>
    <p class="hint">${rotation
      ? `Roulement ${ROTATIONS[rotation].toLowerCase()} : un clic met ce joueur en vedette tout de suite, puis le roulement repart de lui.`
      : "Un clic met ce joueur en grand sur l'overlay, tout de suite. S'il ne partage pas son jeu, c'est le premier qui partage."}</p>
    <div class="items-players-list">
      <button type="button" class=${`player-check ${!link.featured ? "on" : ""}`} aria-pressed=${!link.featured} disabled=${action.busy}
        onClick=${() => pick(null)}>${!link.featured ? "✓ " : ""}Premier qui partage</button>
      ${players.map((p) => html`<button type="button" class=${`player-check ${link.featured === p.id ? "on" : ""}`}
        aria-pressed=${link.featured === p.id} disabled=${action.busy} onClick=${() => pick(p.id)}>
        ${link.featured === p.id ? "✓ " : ""}<strong>${p.pseudo}</strong></button>`)}
    </div>
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
  </section>`;
}

function OverlayPanel({ room, data, setData, me, admin, linkId, onLink, onBack }) {
  const action = useAction();
  const links = data.overlay_links || [];
  const players = data.players || [];
  const link = links.find((l) => l.id === linkId) || links[0] || null;
  const [draft, setDraft] = useState(null); // réglages modifiés, pas encore enregistrés
  useEffect(() => setDraft(null), [link?.id]);
  if (!link) {
    return html`<section class="card stack"><h2>Overlay</h2>
      <p>Créez d'abord un espace (vue « Espaces de partage »).</p></section>`;
  }
  const manage = canManage(link, me, admin);
  const config = draft || spaceOf(link.config);
  const set = (patch) => setDraft({ ...config, ...patch });
  const onLinks = (next) => setData((d) => ({ ...d, overlay_links: next }));
  const save = () => action.run(async () => { onLinks((await api.saveSpaceConfig(room.code, link.id, config)).links); setDraft(null); });
  const auto = config.mode !== "manuel";

  return html`<section class="card stack">
    <div class="row full">
      <h2 class="grow">Overlay de l'espace</h2>
      ${draft && html`<span class="badge warn">Modifications non enregistrées</span>`}
    </div>
    <div class="fields full">
      <label class="span-all"><span>Espace</span>
        <select value=${link.id} onChange=${(e) => { if (!draft || confirm("Abandonner les modifications non enregistrées ?")) onLink(e.target.value); }}>
          ${links.map((l) => html`<option value=${l.id}>${l.name} (par ${l.by || "l'hôte"})</option>`)}
        </select></label>
    </div>
    ${!manage && html`<p class="hint">Réglé par ${link.by || "l'hôte"} : seuls son créateur et l'hôte peuvent le modifier.</p>`}
    <fieldset class="plain-fieldset stack full" disabled=${!manage}>
      <legend class="sr-only">Réglages de l'overlay</legend>
      <div class="start-choice full">
        ${[["auto", "Automatique", "Le plus simple : écrans et infos se placent tout seuls."],
          ["manuel", "À la main", "Une disposition par nombre d'écrans, qui change quand un joueur arrive ou part."]]
          .map(([value, title, text]) => html`<label class=${`start-option ${config.mode === value ? "selected" : ""}`}>
            <input type="radio" name="space-mode" value=${value} checked=${config.mode === value} onChange=${() => set({ mode: value })} />
            <span><strong>${title}</strong><span class="hint">${text}</span></span>
          </label>`)}
      </div>

      <div class="stack full">
        <strong>Joueurs montrés</strong>
        <label class="check"><input type="radio" name="space-players" checked=${!config.joueurs.length} onChange=${() => set({ joueurs: [] })} />
          Tous ceux qui partagent leur jeu</label>
        <label class="check"><input type="radio" name="space-players" checked=${config.joueurs.length > 0} disabled=${!players.length}
          onChange=${() => set({ joueurs: [players[0].id] })} /> Seulement ceux-ci :</label>
        ${config.joueurs.length > 0 && html`<div class="items-players-list">${players.map((p) => html`<span
          class=${`player-check ${config.joueurs.includes(p.id) ? "on" : ""}`}><input type="checkbox" aria-label=${p.pseudo}
          checked=${config.joueurs.includes(p.id)} onChange=${(e) => set({ joueurs: e.target.checked
            ? [...config.joueurs, p.id] : config.joueurs.filter((id) => id !== p.id) })} /> <strong>${p.pseudo}</strong></span>`)}</div>`}
      </div>

      ${auto && html`<div class="fields full">
        <label class="span-all"><span>Écrans de jeu</span>${select(config.ecrans, SCREEN_MODES, (v) => set({ ecrans: v }))}</label>
        <label><span>Messages de la partie</span>${select(config.messages, CONSOLE_PLACES, (v) => set({ messages: v }))}</label>
        ${config.messages !== "non" && html`<label><span>Objets montrés</span>${select(config.objets, ITEM_FILTERS, (v) => set({ objets: v }))}</label>`}
        <label class="span-all"><span>Progression des joueurs</span>${select(config.progression, PROGRESS_MODES, (v) => set({ progression: v }))}</label>
      </div>`}
      ${!auto && html`<${SpaceLayouts} variants=${config.variants} players=${players} onChange=${(variants) => set({ variants })} />`}

      ${spaceUses(config, "vedette") && html`<div class="fields full">
        <label class="span-all"><span>Écran en vedette : roulement</span>
          ${select(String(config.rotation), ROTATIONS, (v) => set({ rotation: Number(v) }))}
          <span class="hint">Le roulement passe d'un joueur qui partage au suivant ; à la main, on choisit ci-dessous.</span></label>
      </div>`}
    </fieldset>

    ${action.error && html`<div class="notice error full">${action.error}</div>`}
    <div class="row">
      ${manage && html`<button type="button" disabled=${!draft || action.busy} onClick=${save}>${action.busy ? "Enregistrement…" : "Enregistrer"}</button>
        ${draft && html`<button type="button" class="ghost" onClick=${() => setDraft(null)}>Annuler</button>`}`}
      <${CopyButton} text=${overlayLink(room.code, link.key)} label="Copier le lien pour OBS" className="ghost" />
      <button type="button" class="ghost" onClick=${onBack}>Retour aux espaces</button>
    </div>
    <p class="hint">Les overlays ouverts suivent les réglages dès l'enregistrement : pas besoin de recopier le lien.</p>
    <details class="more">
      <summary>Comment ça marche</summary>
      <ul class="hint tips">
        <li>En automatique, tout se place seul sans qu'un écran en recouvre un autre ; à la main, l'éditeur signale les
          écrans qui se recouvrent.</li>
        <li>Le goal de chaque joueur est lu dans son YAML de la room (absent dans une room de partie déjà hébergée).</li>
        <li>Les messages arrivent une fois la partie en ligne : l'overlay s'y connecte comme client texte du premier joueur.</li>
        <li>Chaque joueur envoie son image à ${MAX_VIEWERS} overlays au plus : après avoir vérifié avec « Ouvrir », fermez l'onglet.</li>
      </ul>
    </details>
  </section>
  ${manage && spaceUses(spaceOf(link.config), "vedette") && html`<${FeaturedControl} room=${room} link=${link} players=${players}
    rotation=${spaceOf(link.config).rotation} onLinks=${onLinks} />`}`;
}

// Trois vues : partager son jeu (joueurs), les espaces de partage (liste commune, lien à copier pour OBS), et
// l'overlay d'un espace (ce qu'il montre, écran en vedette en direct). Le partage reste actif quand on change de vue.
export function ScreensTab({ room, me, admin, data, setData }) {
  const views = [...(me ? [["share", "Partager mon jeu"]] : []), ["spaces", "Espaces de partage"], ["overlay", "Overlay"]];
  const [view, setView] = useSetting("screensView", "share");
  const own = (data.overlay_links || []).find((l) => me && l.player_id === me.id);
  const [linkId, setLinkId] = useState(own?.id || null);
  const current = views.some(([id]) => id === view) ? view : views[0][0];
  const openSettings = (id) => { setLinkId(id); setView("overlay"); };
  return html`
    <div class="segmented" role="tablist" aria-label="Écrans">${views.map(([id, label]) => html`<button type="button" role="tab"
      aria-selected=${current === id} class=${current === id ? "active" : ""} onClick=${() => setView(id)}>${label}</button>`)}</div>
    ${me && html`<div class="room-panel" hidden=${current !== "share"}><${ShareScreen} room=${room}
      games=${[...new Set((data.players || []).find((p) => p.id === me.id)?.slots.map((s) => s.game) || [])]} /></div>`}
    ${current === "spaces" && html`<${SpacesPanel} room=${room} data=${data} setData=${setData} me=${me} admin=${admin} onSettings=${openSettings} />`}
    ${current === "overlay" && html`<${OverlayPanel} room=${room} data=${data} setData=${setData} me=${me} admin=${admin}
      linkId=${linkId} onLink=${setLinkId} onBack=${() => setView("spaces")} />`}`;
}
