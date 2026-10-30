// Onglet « Écrans » de la room : chaque joueur partage la fenêtre de son jeu, et l'hôte crée le lien de
// l'overlay OBS (grille automatique ou dispositions de l'éditeur, overlay-editor.js). L'overlay est dans overlay.js.
//
// Les images vont directement du navigateur du joueur à l'overlay (WebRTC). Le service des rooms ne fait que
// les mettre en relation (screens-net.js) : le joueur envoie une offre à chaque overlay qui lui demande son flux,
// l'overlay répond.
import { html, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { CopyButton, plural, useAction, useSetting } from "./ui.js";
import { api, overlayLink, saveAccess, savedAccess } from "./rooms-api.js";
import { ICE_SERVERS, serial, signaling } from "./screens-net.js";
import { CONSOLE_PLACES, DEFAULT_SHOWN, ITEM_FILTERS, overlayOptions } from "./overlay-layout.js";
import { LayoutEditor } from "./overlay-editor.js";

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

// Adresse de l'overlay avec les réglages qui diffèrent de ceux par défaut.
function overlayUrl(code, key, options) {
  const defaults = overlayOptions();
  const query = new URLSearchParams(Object.entries(options).filter(([k, v]) => v !== defaults[k]).map(([k, v]) => [k, String(v)]));
  return overlayLink(code, key) + (query.size ? `?${query}` : "");
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
      try { await track.applyConstraints(captureConstraints(quality)); } catch (e) { console.warn("écrans :", e); }
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
  return html`<div class="stack full">
    <p class="hint" role="status">Envoyé à l'overlay : ${sent.width} × ${sent.height}${sent.fps ? `, ${Math.round(sent.fps)} images/s` : ""}${sent.bitrate != null ? `, ${decimal(sent.bitrate / 1e6)} Mb/s` : ""}${encoder ? `, encodé en ${encoder}` : ""}.</p>
    ${network.length > 0 && html`<p class="hint">Réseau : ${network.join(" · ")}.</p>`}
    ${limit && html`<div class="notice warn full">${limit}</div>`}
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
    <${SentInfo} sent=${sent} quality=${quality} />
    ${view && html`<video class="screen-preview" ref=${preview} autoplay muted playsinline aria-label="Aperçu de votre partage"></video>`}
    ${error && html`<div class="notice error full">${error}</div>`}
    <ul class="hint tips">
      <li>Choisissez une <strong>fenêtre</strong> plutôt que l'écran entier : rien d'autre que le jeu ne sera visible.</li>
      <li>Écran noir dans l'aperçu ? Passez le jeu en mode fenêtré, ou en plein écran fenêtré (sans bordure).</li>
      <li>Jugez la qualité avec le jeu en mouvement : une image immobile n'envoie presque rien.</li>
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
      de la room), et à côté les messages de la partie (objets envoyés, objectifs atteints…). Pour placer vous-même
      chaque élément, créez une disposition plus bas : elle utilise la même clé, avec son propre lien.</p>
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
      <li>Chaque joueur envoie son image à chaque overlay qui affiche son écran : ${MAX_VIEWERS} au maximum.</li>
    </ol>
  </section>`;
}

export function ScreensTab({ room, me, admin, data, setData }) {
  return html`${me && html`<${ShareScreen} room=${room} />`}
    ${admin && html`<${OverlayPanel} room=${room} data=${data} setData=${setData} />
      <${LayoutEditor} room=${room} data=${data} setData=${setData} />`}`;
}
