// Overlay d'un espace de partage (#/overlay/CODE/CLÉ) : page à mettre en source « Navigateur » d'un logiciel de
// stream (OBS, Streamlabs…), sans en-tête ni pied de page.
//
// La page suit les réglages de l'espace (voir overlay-layout.js) : le service les envoie à la connexion puis à
// chaque enregistrement, avec l'écran mis en vedette en direct, sans recharger la page. Les anciens liens gardent
// leurs réglages dans l'adresse, ou une disposition de l'hôte (?disposition=ID).
//
// Les images arrivent directement du navigateur de chaque joueur (WebRTC) ; les messages et la progression
// viennent du serveur de la partie sur archipelago.gg (client texte du premier joueur, API du tracker).
import { html, useState, useEffect, useLayoutEffect, useRef } from "../vendor/preact-htm.js";
import { Client, Hint } from "../vendor/archipelago.js";
import { MessageLine, displayLines, progressRows, wishHit, wishIndex } from "./room-live.js";
import { api, apRoomStatus } from "./rooms-api.js";
import { AUDIO_CHANNELS, ICE_SERVERS, audioChannels, serial, signaling } from "./screens-net.js";
import {
  TEXT_SIZES, assignScreens, gridLayout, shownPlayers, shownStreams, spaceFromParams, spaceItems, spaceOf, spaceUses,
} from "./overlay-layout.js";

const RETRY = 8000;
const OFFER_TIMEOUT = 20000;
const FEED_LINES = 300; // messages gardés, pour remonter le fil
const FEED_RETRY = 30000;
const SCROLL_BACK = 20000; // fil remonté à la main : retour aux derniers messages après ce temps sans défiler
const GAME_WAIT = 60000; // partie pas encore hébergée : la room est relue de temps en temps
const GAP = 8;

// --- Écrans ---------------------------------------------------------------------------------

// `select(streams, layouts)` : joueurs dont l'overlay demande l'image (les autres ne lui envoient rien).
class Viewer {
  constructor(code, key, select, onChange) {
    this.select = select;
    this.streams = []; // joueurs qui partagent, dans l'ordre du service
    this.layouts = null; // dispositions de la room, reçues du service
    this.space = undefined; // réglages de l'espace et écran en vedette ({ config, featured }), reçus du service
    this.peers = new Map(); // joueur → { state, pc, stream, audio: { jeu, voix } (pistes de son reçues), timer }
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
      layouts: this.layouts,
      space: this.space,
      streams: this.streams,
      peers: Object.fromEntries([...this.peers].map(([id, p]) => [id, { state: p.state, stream: p.stream, audio: p.audio }])),
    });
  }

  async receive(msg) {
    if (msg.type === "welcome" || msg.type === "layouts") {
      this.layouts = msg.layouts || [];
      if (msg.type === "welcome") this.space = msg.space || null;
      this.sync();
    } else if (msg.type === "space") {
      this.space = msg.space;
      this.sync();
    } else if (msg.type === "streams") {
      this.streams = msg.list;
      this.sync();
    } else if (msg.type === "signal" && msg.data) {
      await this.answer(msg.from, msg.data);
    }
  }

  sync() {
    const wanted = new Set(this.select(this.streams, this.layouts || [], this.space));
    for (const id of [...this.peers.keys()]) {
      if (wanted.has(id)) continue;
      this.signal.send({ type: "signal", to: id, data: { type: "bye" } });
      this.drop(id);
    }
    for (const id of wanted) if (!this.peers.has(id)) this.request(id);
    this.changed();
  }

  request(id, peer = { state: "connecting", pc: null, stream: null, audio: {}, timer: null }) {
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
    Object.assign(peer, { state, pc: null, stream: null, audio: {} });
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
    peer.audio = {};
    pc.ontrack = (e) => {
      if (e.track.kind === "audio") {
        // Pistes de son reconnues à leur ordre (voir AUDIO_CHANNELS) : le jeu, puis la voix.
        const at = pc.getTransceivers().filter((t) => t.receiver.track.kind === "audio").indexOf(e.transceiver);
        if (AUDIO_CHANNELS[at]) peer.audio = { ...peer.audio, [AUDIO_CHANNELS[at]]: e.track };
      } else peer.stream = e.streams[0] || new MediaStream([e.track]);
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


// Taille d'un élément (zone des écrans, ou page entière pour une disposition).
function useElementSize() {
  const ref = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!ref.current) return undefined;
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

// Haut-parleur, barré quand le son de l'écran est coupé (la forme change, pas seulement la couleur).
const SpeakerIcon = ({ on }) => html`<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2"
  stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
  ${on ? html`<path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" />` : html`<path d="M17 9l5 6M22 9l-5 6" />`}</svg>`;

const CHANNEL_LABELS = { jeu: "Jeu", voix: "Voix" };

// Son d'un écran : le haut-parleur choisit le joueur entendu (un seul à la fois) ; au survol (ou au clavier), le jeu et la
// voix se coupent et se règlent à part. Dans OBS, le survol se fait avec « Interagir » : rien ne s'affiche dans le stream.
function TileSound({ tile, sound }) {
  const channels = audioChannels(tile.audio);
  const settings = sound.settings(tile.player);
  return html`<div class="screen-audio">
    <button type="button" class=${`screen-sound ${tile.heard ? "on" : ""}`} aria-pressed=${!!tile.heard}
      title=${tile.heard ? `Couper le son de ${tile.label}` : `Écouter ${tile.label} (coupe les autres)`}
      onClick=${() => sound.choose(tile.heard ? null : tile.player)}>
      <${SpeakerIcon} on=${tile.heard} />${tile.heard && html`<span>Son</span>`}
      <span class="sr-only">${tile.heard ? `Son de ${tile.label} entendu` : `Son de ${tile.label} coupé`}</span>
    </button>
    <div class="screen-audio-panel">
      ${AUDIO_CHANNELS.filter((c) => channels[c]).map((c) => {
        const { on, volume } = settings[c];
        const name = `${CHANNEL_LABELS[c]} de ${tile.label}`;
        return html`<div class="screen-audio-row" key=${c}>
          <button type="button" class=${`screen-channel ${on ? "on" : ""}`} aria-pressed=${on} title=${on ? `Couper : ${name}` : `Rétablir : ${name}`}
            onClick=${() => sound.set(tile.player, c, { on: !on })}><${SpeakerIcon} on=${on} /> ${CHANNEL_LABELS[c]}</button>
          <input type="range" min="0" max="100" step="5" value=${volume} disabled=${!on} aria-label=${`Volume : ${name}`}
            onInput=${(e) => sound.set(tile.player, c, { volume: Number(e.target.value) })} />
          <span class="screen-audio-value">${on ? `${volume} %` : "coupé"}</span>
        </div>`;
      })}
    </div>
  </div>`;
}

// Écran d'un joueur. `font` : taille du texte en px ; `label` : nom du joueur et jeu en bas à gauche. `sound` : voir
// useOverlaySound (écrans qui envoient leur son) ; `tile.heard` : c'est ce joueur qu'on entend.
function Tile({ tile, style, font, label = true, sound }) {
  const video = useRef(null);
  useEffect(() => {
    if (video.current && video.current.srcObject !== tile.stream) video.current.srcObject = tile.stream;
  }, [tile.stream]);
  return html`<figure class="screen-tile" style=${{ ...style, fontSize: `${font}px` }}>
    ${tile.stream
      ? html`<video ref=${video} autoplay muted playsinline></video>`
      : html`<div class="screen-wait">${TILE_STATES[tile.state] || TILE_STATES.connecting}</div>`}
    ${tile.audio && sound && html`<${TileSound} tile=${tile} sound=${sound} />`}
    ${label && html`<figcaption>
      <strong>${tile.label}</strong>${tile.games.length > 0 && html`<span class="screen-game"> · ${tile.games.join(", ")}</span>`}
      ${tile.state === "unstable" && html`<span class="screen-flag">Connexion instable</span>`}
    </figcaption>`}
  </figure>`;
}

// `heard` : joueur dont on entend le son.
const tileOf = (stream, view, heard) => ({
  ...stream, heard: !!stream.audio && stream.player === heard,
  state: view.peers[stream.id]?.state || "connecting", stream: view.peers[stream.id]?.stream || null,
});

// Écrans en grille dans une zone de `width` × `height` px, aussi grands que possible quel que soit leur nombre.
// `scale` : taille du nom des joueurs par rapport à la taille moyenne.
function ScreenGrid({ tiles, width, height, label = true, scale = 1, sound }) {
  const grid = gridLayout(tiles.length, width, height, GAP);
  if (!tiles.length || !grid.width) return null;
  // Texte proportionnel à l'écran, jamais trop petit pour être lu dans un stream.
  const font = Math.round(Math.min(40, Math.max(20, grid.width / 34)) * scale);
  return html`<div class="overlay-grid" style=${{ width: `${grid.columns * grid.width + (grid.columns - 1) * GAP}px`, gap: `${GAP}px` }}>
    ${tiles.map((tile) => html`<${Tile} key=${tile.id} tile=${tile} font=${font} label=${label} sound=${sound}
      style=${{ width: `${grid.width}px`, height: `${grid.height}px` }} />`)}
  </div>`;
}


// --- Partie en ligne : messages et progression ---------------------------------------------

// Partie hébergée de la room (adresse, joueurs, tracker), ou null si l'hôte n'a pas encore collé son lien.
async function onlineGame(code) {
  const { room } = await api.get(code);
  return room.ap_room_url ? apRoomStatus(code, room.ap_room_url) : null;
}

// Indice sous la forme du message du serveur (« [Hint]: … is at … in …'s World. »), à partir de son entrée dans
// le stockage de la partie.
function hintNodes(client, raw) {
  const hint = new Hint(client, raw);
  const { item } = hint;
  const player = (p) => ({ type: "player", text: p.alias || p.name, player: p });
  return [
    { type: "text", text: "[Hint]: " }, player(item.receiver), { type: "text", text: "'s " },
    { type: "item", text: item.name, item }, { type: "text", text: " is at " },
    { type: "location", text: item.locationName }, { type: "text", text: " in " }, player(item.sender),
    { type: "text", text: `'s World${hint.entrance !== "Vanilla" ? ` (${hint.entrance})` : ""}.${hint.found ? " (found)" : ""}` },
  ];
}

// Objets envoyés, objectifs atteints, release et collect, reçus en client texte du premier joueur, et indices.
// `important` sur chaque ligne : objet (envoyé ou indiqué) de progression, utile ou piège, ou événement d'un joueur.
function useGameFeed(code, enabled) {
  const [feed, setFeed] = useState({ state: "loading", message: null, lines: [] });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let client = null;
    let timer = null;
    let nextId = 0;
    const update = (patch) => alive && setFeed((f) => ({ ...f, ...patch }));
    const push = (nodes, important, chat = false) => alive && setFeed((f) => ({
      ...f, lines: [...f.lines.slice(1 - FEED_LINES), { id: nextId++, time: Date.now(), nodes, important, chat }],
    }));
    const later = (delay) => { clearTimeout(timer); timer = setTimeout(connect, delay); };
    const important = (item) => !!(item.progression || item.useful || item.trap);

    const connect = async () => {
      try {
        // Lire la page de la room (par le service) réveille le serveur s'il est en veille ; le port peut alors changer.
        await api.apLinks(code).catch(() => {});
        const status = await onlineGame(code);
        if (!status) { update({ state: "waiting", message: null }); later(GAME_WAIT); return; }
        if (!status.port || !status.slots.length) throw new Error("Le serveur de la partie ne répond pas encore.");
        const next = new Client();
        next.messages.on("itemSent", (text, item, nodes) => push(nodes, important(item)));
        next.messages.on("itemCheated", (text, item, nodes) => push(nodes, important(item)));
        for (const event of ["goaled", "released", "collected"]) next.messages.on(event, (text, player, nodes) => push(nodes, true));
        // Chat des joueurs (affiché si l'élément le demande). Le serveur répète aussi à tous les commandes (!hint…) : écartées.
        next.messages.on("chat", (message, player, nodes) => {
          if (String(message).trim().startsWith("!")) return;
          push(player ? [{ type: "player", text: player.alias || player.name, player }, { type: "text", text: `: ${message}` }] : nodes, false, true);
        });
        next.socket.on("disconnected", () => {
          if (client !== next || !alive) return;
          client = null;
          update({ state: "retrying" });
          later(RETRY);
        });
        client = next;
        await next.login(`wss://${status.host}:${status.port}`, status.slots[0].name, undefined, { slotData: false, tags: ["TextOnly"] });
        // Indices : le serveur n'en envoie le message qu'aux deux joueurs concernés, mais le stockage de la partie
        // les donne pour tous (une liste par joueur, mise à jour à chaque nouvel indice). Ceux d'avant la connexion
        // ne sont pas affichés ; un indice est dans la liste de celui qui le trouve et de celui qui le reçoit.
        const seen = new Set();
        const hintId = (raw) => `${raw.finding_player}:${raw.location}`;
        const team = next.players.self.team;
        const known = await next.storage.notify(status.slots.map((s) => `_read_hints_${team}_${s.slot}`), (key, hints) => {
          for (const raw of hints || []) {
            if (seen.has(hintId(raw))) continue;
            seen.add(hintId(raw));
            if (client !== next) continue;
            const nodes = hintNodes(next, raw);
            push(nodes, important(nodes.find((node) => node.type === "item").item));
          }
        });
        for (const hints of Object.values(known || {})) for (const raw of hints || []) seen.add(hintId(raw));
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
  }, [code, enabled]);
  return feed;
}

// Wishlists des joueurs (leurs objets sont mis en avant quand ils sont envoyés) et joueurs de la room avec leurs noms
// dans la partie (pour surligner les objets des joueurs de l'espace), relus de temps en temps.
function useRoomInfo(code, enabled) {
  const [info, setInfo] = useState({ wishes: null, players: [], direct: false });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer = null;
    const load = () => api.get(code)
      .then((data) => alive && setInfo({ wishes: wishIndex(data.wishlists), players: data.players || [], direct: !!data.room?.direct }))
      .catch(() => {})
      .finally(() => { if (alive) timer = setTimeout(load, GAME_WAIT); });
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [code, enabled]);
  return info;
}

// Noms dans la partie (en minuscules) des joueurs `ids` : ses YAML, ou son pseudo dans une room de partie déjà hébergée.
const slotNames = (info, ids) => new Set(info.players.filter((p) => ids.includes(p.id))
  .flatMap((p) => (info.direct || !p.slots?.length ? [p.pseudo] : p.slots.map((s) => s.name))).map((n) => n.toLowerCase()));

const FEED_STATES = {
  loading: "Connexion à la partie…",
  waiting: "La partie n'est pas encore en ligne : les objets envoyés et les indices s'afficheront ici.",
  retrying: "Connexion à la partie perdue, nouvelle tentative…",
  live: "Connecté à la partie : les objets envoyés et les indices s'afficheront ici.",
};

// Options d'un élément « messages » (disposition, ou réglages automatiques d'un espace) : `objets` (tous, résumés :
// objets sans importance en une ligne cumulée, importants : progression, utiles, pièges, événements des joueurs et
// objets des wishlists), `lieux`, `heure`, `chat` (messages écrits par les joueurs). Anciennes dispositions : lieux affichés.
const feedOptions = (item) => ({
  important: item.objets === "importants", chat: !!item.chat,
  display: { lieux: item.lieux !== false, heure: !!item.heure, resumes: item.objets === "resumes" },
});

// `mine` : joueurs dont les objets sont surlignés. Les messages défilent : remonté plus haut, le fil reste en place
// (bouton pour revenir aux derniers), puis y revient seul après SCROLL_BACK sans défiler.
function GameFeed({ feed, wishes, mine, options, style, plain = false }) {
  const box = useRef(null);
  const timer = useRef(null);
  const [away, setAway] = useState(false);
  const kept = feed.lines.filter((l) => (l.chat ? options.chat : !options.important || l.important || wishHit(wishes, l.nodes)));
  const lines = displayLines(kept, options.display, wishes);
  const status = feed.state === "error" ? `${feed.message} Nouvelle tentative dans ${FEED_RETRY / 1000} s.`
    : feed.state === "live" && lines.length ? null
    : FEED_STATES[feed.state];
  const toBottom = () => { if (box.current) box.current.scrollTop = box.current.scrollHeight; };
  useLayoutEffect(() => { if (!away) toBottom(); });
  useEffect(() => () => clearTimeout(timer.current), []);
  const onScroll = () => {
    const el = box.current;
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > 4;
    setAway(far);
    clearTimeout(timer.current);
    if (far) timer.current = setTimeout(() => { setAway(false); toBottom(); }, SCROLL_BACK);
  };
  return html`<div class=${`game-feed ${plain ? "plain" : ""}`} style=${style} ref=${box} onScroll=${onScroll} role="log" aria-live="polite">
    ${lines.map((line) => html`<div key=${line.id} class=${line.wish ? "wish-hit" : line.chat ? "feed-chat" : ""}>
      <${MessageLine} line=${line} options=${options.display} marks wishes=${wishes} mine=${mine} /></div>`)}
    ${status && html`<div class="feed-status">${status}</div>`}
    ${away && html`<button type="button" class="feed-latest" onClick=${() => { setAway(false); toBottom(); }}>↓ Derniers messages</button>`}
  </div>`;
}

// Checks de chaque joueur (API du tracker d'archipelago.gg, en cache une minute chez eux).
function useProgress(code, enabled) {
  const [progress, setProgress] = useState({ rows: [], state: "loading", message: null });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer = null;
    const load = async () => {
      try {
        const status = await onlineGame(code);
        if (!status?.trackerId) {
          if (alive) setProgress({ rows: [], state: "waiting", message: null });
        } else {
          const get = (path) => fetch(`${status.origin}/api/${path}/${status.trackerId}`).then((r) => {
            if (!r.ok) throw new Error(`Tracker indisponible (${r.status}).`);
            return r.json();
          });
          const [live, fixed, data] = await Promise.all([get("tracker"), get("static_tracker"), api.get(code).catch(() => null)]);
          const goals = new Map((data?.players || []).flatMap((pl) => pl.slots).filter((s) => s.goal).map((s) => [s.name.toLowerCase(), s.goal]));
          const rows = progressRows(status, live, fixed).map((r) => ({ ...r, goal: goals.get(r.name.toLowerCase()) || null }));
          if (alive) setProgress({ rows, state: "live", message: null });
        }
      } catch (e) {
        if (alive) setProgress((p) => ({ ...p, state: p.rows.length ? "live" : "error", message: e?.message || String(e) }));
      }
      if (alive) timer = setTimeout(load, GAME_WAIT);
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [code, enabled]);
  return progress;
}

const pct = (a, b) => (b ? Math.floor((a / b) * 100) : 0);

// `goal` : le goal de chaque joueur en petit sous son nom (rooms avec YAML seulement).
function ProgressBox({ progress, style, plain, goal = false }) {
  const { rows } = progress;
  const sum = rows.reduce((n, r) => n + r.checks, 0);
  const all = rows.reduce((n, r) => n + r.total, 0);
  return html`<div class=${`overlay-box progress-box ${plain ? "plain" : ""}`} style=${style}>
    ${!rows.length && html`<div class="feed-status">${progress.state === "waiting"
      ? "Progression : la partie n'est pas encore en ligne."
      : progress.message || "Chargement de la progression…"}</div>`}
    ${rows.length > 0 && html`<div class="progress-total">Total : ${sum} / ${all} checks (${pct(sum, all)} %)</div>`}
    ${rows.map((r) => html`<div class="progress-line" key=${r.slot}>
      <span class="progress-name"><strong>${r.name}</strong>${goal && r.goal && html`<span class="progress-goal">${r.goal}</span>`}</span>
      <span class="progress-bar"><span class=${r.finished ? "done" : ""} style=${{ width: `${pct(r.checks, r.total)}%` }}></span></span>
      <span class="progress-count">${r.finished ? "✓ Terminé" : `${r.checks} / ${r.total}`}</span>
    </div>`)}
  </div>`;
}

// --- Disposition libre -------------------------------------------------------------------------

const boxStyle = (item) => ({ left: `${item.x}%`, top: `${item.y}%`, width: `${item.w}%`, height: `${item.h}%` });

// `items` : éléments à afficher ; `streams` : joueurs montrés ; `featured` : joueur en vedette. `empty` : message
// affiché dans l'élément principal (`main`) quand aucun joueur montré ne partage. `heard`, `sound` : voir Tile.
function LayoutView({ items, view, streams, featured, feed, wishes, mine, progress, heard, sound, empty = null }) {
  const [ref, size] = useElementSize();
  const unit = size.height / 100; // 1 % de la hauteur de la page
  const assigned = assignScreens(items, streams, featured);
  const content = (item) => {
    const font = { fontSize: `${Math.round(unit * TEXT_SIZES[item.size].unit)}px` };
    const plain = !item.background;
    const nobody = item.main && empty && html`<div class="overlay-zone"><p class="overlay-message">${empty}</p></div>`;
    if (item.type === "screen") {
      const stream = assigned.get(item.id);
      return stream ? html`<${Tile} tile=${tileOf(stream, view, heard)} label=${item.label} font=${Math.round(unit * TEXT_SIZES[item.size].unit)}
        style=${{ width: "100%", height: "100%" }} sound=${sound} />` : nobody;
    }
    if (item.type === "screens") {
      const tiles = (assigned.get(item.id) || []).map((s) => tileOf(s, view, heard));
      return tiles.length > 0 ? html`<div class="overlay-zone"><${ScreenGrid} tiles=${tiles} label=${item.label} sound=${sound}
        width=${(size.width * item.w) / 100} height=${(size.height * item.h) / 100}
        scale=${TEXT_SIZES[item.size].unit / TEXT_SIZES.m.unit} /></div>` : nobody;
    }
    if (item.type === "feed") return html`<${GameFeed} feed=${feed} wishes=${wishes} mine=${mine} options=${feedOptions(item)} style=${font} plain=${plain} />`;
    if (item.type === "progress") return html`<${ProgressBox} progress=${progress} style=${font} plain=${plain} goal=${item.goal} />`;
    return html`<div class=${`overlay-box overlay-text ${plain ? "plain" : ""}`} style=${{ ...font, textAlign: item.align }}>${item.text}</div>`;
  };
  return html`<div class="overlay-canvas" ref=${ref}>
    ${size.height > 0 && items.map((item) => html`<div class="overlay-item" key=${item.id} style=${boxStyle(item)}>${content(item)}</div>`)}
  </div>`;
}

// --- La page ------------------------------------------------------------------------------------

// Écran en vedette : celui choisi en direct (`chosen`), puis, avec un roulement, le suivant toutes les `rotation`
// secondes parmi ceux qui partagent. Un choix en direct repart de ce joueur.
function useFeatured(chosen, rotation, players) {
  const [featured, setFeatured] = useState(chosen);
  const list = useRef(players);
  list.current = players;
  useEffect(() => setFeatured(chosen), [chosen]);
  useEffect(() => {
    if (!rotation) return undefined;
    const timer = setInterval(() => setFeatured((current) => {
      const all = list.current;
      if (all.length < 2) return current;
      const at = all.indexOf(current);
      return all[(at + 1) % all.length];
    }), rotation * 1000);
    return () => clearInterval(timer);
  }, [rotation, chosen]);
  return featured;
}

// Son du joueur entendu, joué à part de l'image : les vidéos restent muettes (un navigateur met en pause une vidéo dont
// on rétablit le son sans clic). OBS joue le son sans clic ; un navigateur peut attendre un clic sur la page.
function SoundPlayer({ audio, settings }) {
  const players = useRef({});
  const [blocked, setBlocked] = useState(false);
  const play = (el) => el.play().then(() => setBlocked(false)).catch((e) => { if (e?.name === "NotAllowedError") setBlocked(true); });
  const tracks = AUDIO_CHANNELS.map((c) => audio?.[c] || null);
  useEffect(() => {
    AUDIO_CHANNELS.forEach((c, i) => {
      const el = players.current[c];
      if (!el || el.track === tracks[i]) return;
      el.track = tracks[i];
      el.srcObject = tracks[i] ? new MediaStream([tracks[i]]) : null;
      if (tracks[i]) play(el);
    });
    if (!tracks.some(Boolean)) setBlocked(false);
  }, tracks);
  // Volume et coupure de chaque piste, réglés au survol des écrans.
  useEffect(() => {
    for (const c of AUDIO_CHANNELS) {
      const el = players.current[c];
      if (!el || !settings) continue;
      el.volume = settings[c].volume / 100;
      el.muted = !settings[c].on;
    }
  });
  const retry = () => { for (const el of Object.values(players.current)) if (el?.srcObject) play(el); };
  return html`${AUDIO_CHANNELS.map((c) => html`<audio key=${c} ref=${(el) => { players.current[c] = el; }} autoplay></audio>`)}
    ${blocked && html`<button type="button" class="sound-blocked" onClick=${retry}>Le navigateur bloque le son : cliquez ici pour l'activer</button>`}`;
}

// Réglages du son de chaque joueur sur cet overlay (jeu et voix : coupés ou non, volume en %), gardés par le navigateur
// (la source OBS garde les siens d'une séance à l'autre).
const SOUND_KEY = "overlaySound";
const SOUND_DEFAULT = { on: true, volume: 100 };

function useOverlaySound(choose) {
  const [saved, setSaved] = useState(() => {
    try { return JSON.parse(localStorage.getItem(SOUND_KEY)) || {}; } catch { return {}; }
  });
  const settings = (player) => Object.fromEntries(AUDIO_CHANNELS.map((c) => [c, { ...SOUND_DEFAULT, ...saved[player]?.[c] }]));
  const set = (player, channel, patch) => setSaved((all) => {
    const next = { ...all, [player]: { ...all[player], [channel]: { ...SOUND_DEFAULT, ...all[player]?.[channel], ...patch } } };
    try { localStorage.setItem(SOUND_KEY, JSON.stringify(next)); } catch { /* stockage indisponible */ }
    return next;
  });
  return { choose, settings, set };
}

// `params` : anciens réglages dans l'adresse (voir spaceFromParams), et `disposition` pour une disposition de l'hôte.
export function ScreensOverlay({ code, overlayKey, params }) {
  const layoutId = params.disposition || null;
  const fromUrl = spaceFromParams(params);
  const [view, setView] = useState(null);
  const config = fromUrl || spaceOf(view?.space?.config);
  const known = !!fromUrl || view?.space !== undefined; // réglages reçus du service (ou dans l'adresse)
  const layout = layoutId ? view?.layouts?.find((l) => l.id === layoutId) : null;
  const refused = view?.state === "refused";
  const streams = layoutId ? view?.streams || [] : shownPlayers(config, view?.streams || []);
  const featured = useFeatured(view?.space?.featured || null, layoutId ? 0 : config.rotation, streams.map((s) => s.player));
  const items = layoutId ? layout?.items || [] : spaceItems(config, streams.length);
  const uses = (type) => !refused && (layoutId ? !!layout?.items.some((i) => i.type === type) : known && spaceUses(config, type));
  const feed = useGameFeed(code, uses("feed"));
  const info = useRoomInfo(code, uses("feed"));
  const { wishes } = info;
  // Objets surlignés : ceux des joueurs montrés par l'espace, sinon ceux de son créateur (le streamer).
  const mine = slotNames(info, config.joueurs.length ? config.joueurs : [view?.space?.owner].filter(Boolean));
  const progress = useProgress(code, uses("progress"));
  // Son entendu : celui choisi depuis la room (`sound` de l'espace : un joueur, "vedette" ou aucun), ou par un clic sur
  // un haut-parleur de l'overlay, jusqu'au prochain choix depuis la room.
  const [clicked, setClicked] = useState(undefined);
  useEffect(() => setClicked(undefined), [view?.space]);
  const sound = clicked !== undefined ? clicked : view?.space?.sound || null;
  const heard = sound === "vedette" ? featured || streams[0]?.player || null : sound;
  const heardStream = streams.find((s) => s.audio && s.player === heard);
  const heardAudio = (heardStream && view?.peers[heardStream.id]?.audio) || null;
  const controls = useOverlaySound(setClicked);
  const player = html`<${SoundPlayer} audio=${heardAudio} settings=${heardStream ? controls.settings(heardStream.player) : null} />`;

  // Joueurs dont l'overlay demande l'image : relu à chaque changement des réglages ou de l'écran en vedette.
  const select = useRef(null);
  select.current = (all, layouts, space) => {
    if (layoutId) {
      const current = layouts.find((l) => l.id === layoutId);
      return current ? shownStreams(current.items, all).map((s) => s.id) : [];
    }
    const cfg = fromUrl || spaceOf(space?.config);
    const shown = shownPlayers(cfg, all);
    return shownStreams(spaceItems(cfg, shown.length), shown, featured).map((s) => s.id);
  };
  const viewer = useRef(null);
  useEffect(() => {
    document.documentElement.classList.add("overlay-page");
    document.title = `Écrans · room ${code}`;
    viewer.current = new Viewer(code, overlayKey, (...args) => select.current(...args), setView);
    return () => viewer.current.close();
  }, []);
  useEffect(() => { if (view?.state === "ready") viewer.current?.sync(); }, [featured]);

  const message = (text) => html`<div class="overlay"><div class="overlay-screens"><p class="overlay-message">${text}</p></div></div>`;
  if (refused) return message(view.message);
  if (layoutId) {
    if (!view?.layouts) return view?.state === "retrying" ? message("Connexion au serveur des rooms perdue, nouvelle tentative…") : null;
    if (!layout) return message("Cette disposition n'existe plus : copiez le lien d'un espace depuis la room (onglet « Écrans »).");
    return html`<${LayoutView} items=${layout.items} view=${view} streams=${streams} featured=${featured} feed=${feed} wishes=${wishes} mine=${mine} progress=${progress}
      heard=${heard} sound=${controls} />${player}`;
  }
  if (!known) return view?.state === "retrying" ? message("Connexion au serveur des rooms perdue, nouvelle tentative…") : null;
  if (config.mode === "manuel" && !config.variants.length) return message("Cet espace n'a pas encore de disposition : réglez-la dans la room (onglet « Écrans », vue « Overlay »).");
  const empty = view?.state !== "ready" ? "Connexion au serveur des rooms…"
    : `Room ${code} : ${config.joueurs.length ? "les joueurs choisis ne partagent pas" : "aucun joueur ne partage"} leur écran pour l'instant.`;
  return html`<${LayoutView} items=${items} view=${view} streams=${streams} featured=${featured} feed=${feed} wishes=${wishes}
    mine=${mine} progress=${progress} heard=${heard} sound=${controls} empty=${streams.length ? null : empty} />
    ${player}`;
}
