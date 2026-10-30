// Overlay OBS (#/overlay/CODE/CLÉ) : page à mettre en source navigateur dans OBS, sans en-tête ni pied de page.
//
// Sans disposition, les écrans partagés se placent seuls en grille, avec les messages de la partie à côté
// (réglages dans l'adresse, voir overlayOptions). Avec ?disposition=ID, la page suit la disposition créée par
// l'hôte avec l'éditeur ; le service l'envoie à la connexion puis à chaque enregistrement, sans recharger la page.
//
// Les images arrivent directement du navigateur de chaque joueur (WebRTC) ; les messages et la progression
// viennent du serveur de la partie sur archipelago.gg (client texte du premier joueur, API du tracker).
import { html, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { Client } from "../vendor/archipelago.js";
import { MessagePart, progressRows, wishHit, wishIndex } from "./room-live.js";
import { api, apRoomStatus } from "./rooms-api.js";
import { ICE_SERVERS, serial, signaling } from "./screens-net.js";
import { TEXT_SIZES, assignScreens, overlayOptions } from "./overlay-layout.js";

const RETRY = 8000;
const OFFER_TIMEOUT = 20000;
const FEED_LINES = 40; // messages gardés ; ceux qui ne tiennent pas dans la hauteur sont coupés en haut
const FEED_RETRY = 30000;
const GAME_WAIT = 60000; // partie pas encore hébergée : la room est relue de temps en temps
const GAP = 8;

// --- Écrans ---------------------------------------------------------------------------------

// `select(streams, layouts)` : joueurs dont l'overlay demande l'image (les autres ne lui envoient rien).
class Viewer {
  constructor(code, key, select, onChange) {
    this.select = select;
    this.streams = []; // joueurs qui partagent, dans l'ordre du service
    this.layouts = null; // dispositions de la room, reçues du service
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
      layouts: this.layouts,
      streams: this.streams,
      peers: Object.fromEntries([...this.peers].map(([id, p]) => [id, { state: p.state, stream: p.stream }])),
    });
  }

  async receive(msg) {
    if (msg.type === "welcome" || msg.type === "layouts") {
      this.layouts = msg.layouts || [];
      this.sync();
    } else if (msg.type === "streams") {
      this.streams = msg.list;
      this.sync();
    } else if (msg.type === "signal" && msg.data) {
      await this.answer(msg.from, msg.data);
    }
  }

  sync() {
    const wanted = new Set(this.select(this.streams, this.layouts || []));
    for (const id of [...this.peers.keys()]) {
      if (wanted.has(id)) continue;
      this.signal.send({ type: "signal", to: id, data: { type: "bye" } });
      this.drop(id);
    }
    for (const id of wanted) if (!this.peers.has(id)) this.request(id);
    this.changed();
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

// Écran d'un joueur. `font` : taille du texte en px ; `label` : nom du joueur et jeu en bas à gauche.
function Tile({ tile, style, font, label = true }) {
  const video = useRef(null);
  useEffect(() => {
    if (video.current && video.current.srcObject !== tile.stream) video.current.srcObject = tile.stream;
  }, [tile.stream]);
  return html`<figure class="screen-tile" style=${{ ...style, fontSize: `${font}px` }}>
    ${tile.stream
      ? html`<video ref=${video} autoplay muted playsinline></video>`
      : html`<div class="screen-wait">${TILE_STATES[tile.state] || TILE_STATES.connecting}</div>`}
    ${label && html`<figcaption>
      <strong>${tile.label}</strong>${tile.games.length > 0 && html`<span class="screen-game"> · ${tile.games.join(", ")}</span>`}
      ${tile.state === "unstable" && html`<span class="screen-flag">Connexion instable</span>`}
    </figcaption>`}
  </figure>`;
}

const tileOf = (stream, view) => ({ ...stream, state: view.peers[stream.id]?.state || "connecting", stream: view.peers[stream.id]?.stream || null });

function Screens({ view, code, size, max }) {
  if (!view) return null;
  const tiles = view.streams.slice(0, max).map((s) => tileOf(s, view));
  if (!tiles.length) {
    return html`<p class="overlay-message">
      ${view.state === "ready" ? `Room ${code} : aucun joueur ne partage son écran pour l'instant.` : "Connexion au serveur des rooms…"}
    </p>`;
  }
  const grid = gridLayout(tiles.length, size.width, size.height, GAP);
  if (!grid.width) return null;
  // Texte proportionnel à l'écran, jamais trop petit pour être lu dans un stream.
  const font = Math.round(Math.min(40, Math.max(20, grid.width / 34)));
  return html`<div class="overlay-grid" style=${{ width: `${grid.columns * grid.width + (grid.columns - 1) * GAP}px`, gap: `${GAP}px` }}>
    ${tiles.map((tile) => html`<${Tile} key=${tile.id} tile=${tile} font=${font}
      style=${{ width: `${grid.width}px`, height: `${grid.height}px` }} />`)}
  </div>`;
}

// --- Partie en ligne : messages et progression ---------------------------------------------

// Partie hébergée de la room (adresse, joueurs, tracker), ou null si l'hôte n'a pas encore collé son lien.
async function onlineGame(code) {
  const { room } = await api.get(code);
  return room.ap_room_url ? apRoomStatus(code, room.ap_room_url) : null;
}

// Objets envoyés, objectifs atteints, release et collect, reçus en client texte du premier joueur.
// `important` sur chaque ligne : objet de progression, utile ou piège, ou événement d'un joueur.
function useGameFeed(code, enabled) {
  const [feed, setFeed] = useState({ state: "loading", message: null, lines: [] });
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let client = null;
    let timer = null;
    let nextId = 0;
    const update = (patch) => alive && setFeed((f) => ({ ...f, ...patch }));
    const push = (nodes, important) => alive && setFeed((f) => ({ ...f, lines: [...f.lines.slice(1 - FEED_LINES), { id: nextId++, nodes, important }] }));
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
  }, [code, enabled]);
  return feed;
}

// Wishlists des joueurs, relues de temps en temps : leurs objets sont mis en avant quand ils sont envoyés.
function useWishlists(code, enabled) {
  const [wishes, setWishes] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer = null;
    const load = () => api.get(code)
      .then((data) => alive && setWishes(wishIndex(data.wishlists)))
      .catch(() => {})
      .finally(() => { if (alive) timer = setTimeout(load, GAME_WAIT); });
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [code, enabled]);
  return wishes;
}

const FEED_STATES = {
  loading: "Connexion à la partie…",
  waiting: "La partie n'est pas encore en ligne : les objets envoyés s'afficheront ici.",
  retrying: "Connexion à la partie perdue, nouvelle tentative…",
  live: "Connecté à la partie : les objets envoyés s'afficheront ici.",
};

// `important` : seulement les objets de progression, utiles et les pièges (et les événements des joueurs),
// plus ceux des wishlists.
function GameFeed({ feed, wishes, important = false, style, plain = false }) {
  const lines = feed.lines.map((l) => ({ ...l, wish: wishHit(wishes, l.nodes) })).filter((l) => !important || l.important || l.wish);
  const status = feed.state === "error" ? `${feed.message} Nouvelle tentative dans ${FEED_RETRY / 1000} s.`
    : feed.state === "live" && lines.length ? null
    : FEED_STATES[feed.state];
  return html`<div class=${`game-feed ${plain ? "plain" : ""}`} style=${style} role="log" aria-live="polite">
    ${lines.map((line) => html`<div key=${line.id} class=${line.wish ? "wish-hit" : ""}>
      ${line.wish && html`<span class="wish-label">♥ Wishlist</span>`}
      ${line.nodes.map((node) => html`<${MessagePart} node=${node} marks wishes=${wishes} />`)}</div>`)}
    ${status && html`<div class="feed-status">${status}</div>`}
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
          const [live, fixed] = await Promise.all([get("tracker"), get("static_tracker")]);
          if (alive) setProgress({ rows: progressRows(status, live, fixed), state: "live", message: null });
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

function ProgressBox({ progress, style, plain }) {
  const { rows } = progress;
  const sum = rows.reduce((n, r) => n + r.checks, 0);
  const all = rows.reduce((n, r) => n + r.total, 0);
  return html`<div class=${`overlay-box progress-box ${plain ? "plain" : ""}`} style=${style}>
    ${!rows.length && html`<div class="feed-status">${progress.state === "waiting"
      ? "Progression : la partie n'est pas encore en ligne."
      : progress.message || "Chargement de la progression…"}</div>`}
    ${rows.length > 0 && html`<div class="progress-total">Total : ${sum} / ${all} checks (${pct(sum, all)} %)</div>`}
    ${rows.map((r) => html`<div class="progress-line" key=${r.slot}>
      <strong>${r.name}</strong>
      <span class="progress-bar"><span class=${r.finished ? "done" : ""} style=${{ width: `${pct(r.checks, r.total)}%` }}></span></span>
      <span class="progress-count">${r.finished ? "✓ Terminé" : `${r.checks} / ${r.total}`}</span>
    </div>`)}
  </div>`;
}

// --- Disposition libre -------------------------------------------------------------------------

const boxStyle = (item) => ({ left: `${item.x}%`, top: `${item.y}%`, width: `${item.w}%`, height: `${item.h}%` });

function LayoutView({ layout, view, feed, wishes, progress }) {
  const [ref, size] = useElementSize();
  const unit = size.height / 100; // 1 % de la hauteur de la page
  const assigned = assignScreens(layout.items, view.streams);
  const content = (item) => {
    const font = { fontSize: `${Math.round(unit * TEXT_SIZES[item.size].unit)}px` };
    const plain = !item.background;
    if (item.type === "screen") {
      const stream = assigned.get(item.id);
      return stream && html`<${Tile} tile=${tileOf(stream, view)} label=${item.label} font=${Math.round(unit * TEXT_SIZES[item.size].unit)}
        style=${{ width: "100%", height: "100%" }} />`;
    }
    if (item.type === "feed") return html`<${GameFeed} feed=${feed} wishes=${wishes} important=${item.objets === "importants"} style=${font} plain=${plain} />`;
    if (item.type === "progress") return html`<${ProgressBox} progress=${progress} style=${font} plain=${plain} />`;
    return html`<div class=${`overlay-box overlay-text ${plain ? "plain" : ""}`} style=${{ ...font, textAlign: item.align }}>${item.text}</div>`;
  };
  return html`<div class="overlay-canvas" ref=${ref}>
    ${size.height > 0 && layout.items.map((item) => html`<div class="overlay-item" key=${item.id} style=${boxStyle(item)}>${content(item)}</div>`)}
  </div>`;
}

// --- La page ------------------------------------------------------------------------------------

// `params` : réglages lus dans l'adresse (voir overlayOptions), et `disposition` pour une disposition libre.
export function ScreensOverlay({ code, overlayKey, params }) {
  const layoutId = params.disposition || null;
  const options = overlayOptions(params);
  const place = options.max === 0 ? "plein" : options.console;
  const [view, setView] = useState(null);
  const [area, size] = useElementSize();
  const layout = layoutId ? view?.layouts?.find((l) => l.id === layoutId) : null;
  const refused = view?.state === "refused";
  const uses = (type) => !refused && (layoutId ? !!layout?.items.some((i) => i.type === type) : type === "feed" && place !== "non");
  const feed = useGameFeed(code, uses("feed"));
  const wishes = useWishlists(code, uses("feed"));
  const progress = useProgress(code, uses("progress"));

  useEffect(() => {
    document.documentElement.classList.add("overlay-page");
    document.title = `Écrans · room ${code}`;
    // Grille sans écran (messages seuls) : pas besoin du service.
    if (!layoutId && !options.max) return undefined;
    const select = layoutId
      ? (streams, layouts) => {
        const current = layouts.find((l) => l.id === layoutId);
        return current ? [...new Set([...assignScreens(current.items, streams).values()].map((s) => s.id))] : [];
      }
      : (streams) => streams.slice(0, options.max).map((s) => s.id);
    const viewer = new Viewer(code, overlayKey, select, setView);
    return () => viewer.close();
  }, []);

  const message = (text) => html`<div class="overlay"><div class="overlay-screens"><p class="overlay-message">${text}</p></div></div>`;
  if (refused) return message(view.message);
  if (layoutId) {
    if (!view?.layouts) return view?.state === "retrying" ? message("Connexion au serveur des rooms perdue, nouvelle tentative…") : null;
    if (!layout) return message("Cette disposition n'existe plus : copiez à nouveau son lien depuis la room (onglet « Écrans »).");
    return html`<${LayoutView} layout=${layout} view=${view} feed=${feed} wishes=${wishes} progress=${progress} />`;
  }
  return html`<div class=${`overlay overlay-${place}`}>
    ${options.max > 0 && html`<div class="overlay-screens" ref=${area}><${Screens} view=${view} code=${code} size=${size} max=${options.max} /></div>`}
    ${place !== "non" && html`<${GameFeed} feed=${feed} wishes=${wishes} important=${options.objets === "importants"} />`}
  </div>`;
}
