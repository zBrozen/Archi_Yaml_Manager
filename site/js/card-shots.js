// Photos des cartes de la pêche (fishing.js) : pendant que le joueur partage son écran (screens.js), son navigateur
// écoute la partie (connexion « TextOnly », comme l'overlay, rien n'est envoyé au serveur de jeu) ; quand il trouve un
// objet important (progression, utile ou piège), il prend une image de son propre partage, la recadre (tout l'écran,
// ou le cadre qu'il a réglé pour ce jeu), la réduit à 320 × 240 et l'envoie au service des rooms. La carte de ce check
// la montre ensuite à tous ceux qui la pêchent.
// Désactivé par défaut (réglage « cardShots ») : une capture d'écran gardée peut montrer plus que le jeu. Chacun peut
// supprimer ses photos. Jamais sur l'overlay de stream.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js";
import { Client } from "../vendor/archipelago.js";
import { api, apRoomStatus } from "./rooms-api.js";
import { plural, useSetting } from "./ui.js";

export const SHOT_RATIO = 4 / 3; // format de l'image des cartes (.tcard-art)
const SHOT_W = 320, SHOT_H = 240;
const SHOT_MAX = 38 * 1024; // le service en accepte 40 Ko
const SHOT_DELAY = 350; // l'image juste après la trouvaille (souvent l'animation de l'objet obtenu)
const RETRY_MS = 30000;
const DEFAULT_FRAME = { mode: "full", zoom: 1.6, x: 0.5, y: 0.5 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const readSetting = (name, fallback) => { try { return JSON.parse(localStorage.getItem(name)) ?? fallback; } catch { return fallback; } };
export const frameFor = (game) => {
  const frames = readSetting("cardShotFrames", {});
  return { ...DEFAULT_FRAME, ...(frames[game] || frames[""] || {}) };
};

// Rectangle de l'image source gardé : au format de la carte, le plus grand possible (tout l'écran, recadré au centre),
// ou plus petit d'autant que le zoom et centré là où le joueur l'a placé (sans sortir de l'image).
export function shotRect(vw, vh, frame) {
  let w = Math.min(vw, vh * SHOT_RATIO), h = w / SHOT_RATIO;
  const framed = frame?.mode === "frame";
  if (framed) { const z = clamp(Number(frame.zoom) || 1, 1, 4); w /= z; h /= z; }
  const cx = framed ? clamp(Number(frame.x) || 0.5, 0, 1) * vw : vw / 2;
  const cy = framed ? clamp(Number(frame.y) || 0.5, 0, 1) * vh : vh / 2;
  return { x: clamp(cx - w / 2, 0, vw - w), y: clamp(cy - h / 2, 0, vh - h), w, h };
}

// Une image du partage : par ImageCapture (Chrome, Edge : marche aussi onglet caché, pendant que le joueur est dans son
// jeu), sinon par un élément vidéo hors de la page.
const videos = new WeakMap();
async function videoOf(stream) {
  let video = videos.get(stream);
  if (!video) {
    video = document.createElement("video");
    video.muted = true; video.playsInline = true; video.srcObject = stream;
    videos.set(stream, video);
  }
  if (video.readyState < 2) {
    video.play().catch(() => {});
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("L'image du partage n'arrive pas.")), 3000);
      video.addEventListener("loadeddata", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  return video;
}

export async function takeShot(stream, frame) {
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== "live") throw new Error("Aucun partage d'écran en cours.");
  let source = null, vw = 0, vh = 0;
  if (window.ImageCapture) {
    try { source = await new ImageCapture(track).grabFrame(); vw = source.width; vh = source.height; } catch { source = null; }
  }
  if (!source) { source = await videoOf(stream); vw = source.videoWidth; vh = source.videoHeight; }
  if (!vw || !vh) throw new Error("L'image du partage n'arrive pas.");
  const r = shotRect(vw, vh, frame);
  const canvas = document.createElement("canvas");
  canvas.width = SHOT_W; canvas.height = SHOT_H;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, r.x, r.y, r.w, r.h, 0, 0, SHOT_W, SHOT_H);
  source.close?.();
  // WebP si le navigateur sait l'écrire (Safari non : JPEG), qualité baissée jusqu'à tenir dans la limite.
  for (const [type, quality] of [["image/webp", 0.62], ["image/webp", 0.45], ["image/jpeg", 0.62], ["image/jpeg", 0.42]]) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    if (blob && blob.type === type && blob.size <= SHOT_MAX) return blob;
  }
  throw new Error("Image trop lourde.");
}

// --- Écoute de la partie pendant le partage ------------------------------------------------------------------
// Une seule à la fois (un seul partage à la fois). `opts` : { code, roomUrl, names (joueurs de la partie de cet inscrit),
// stream() }. Reste active quand on quitte l'onglet « Écrans » ; s'arrête avec le partage.
const watch = { run: null, listeners: new Set() };
const changed = () => { for (const listener of watch.listeners) listener(); };

export function setShotWatch(opts) {
  const key = opts ? `${opts.code}|${[...opts.names].sort().join("|")}|${opts.roomUrl}` : "";
  if (watch.run?.key === key) { watch.run.opts = opts; return; }
  stopRun(watch.run);
  watch.run = opts ? { key, opts, alive: true, client: null, timer: 0, seen: new Set(), state: "connecting", sent: 0, error: null } : null;
  if (watch.run) connect(watch.run);
  changed();
}

function stopRun(run) {
  if (!run) return;
  run.alive = false;
  clearTimeout(run.timer);
  run.client?.socket.disconnect();
  run.client = null;
}

async function connect(run) {
  const { code, roomUrl } = run.opts;
  try {
    await api.apLinks(code).catch(() => {}); // réveille le serveur de la partie s'il est en veille
    const status = await apRoomStatus(code, roomUrl);
    if (!run.alive) return;
    if (!status?.port || !status.slots?.length) throw new Error("Le serveur de la partie ne répond pas encore.");
    const client = new Client();
    client.messages.on("itemSent", (text, item) => found(run, item));
    client.socket.on("disconnected", () => {
      if (run.client !== client || !run.alive) return;
      run.client = null; run.state = "retrying"; changed();
      run.timer = setTimeout(() => connect(run), RETRY_MS);
    });
    run.client = client;
    await client.login(`wss://${status.host}:${status.port}`, status.slots[0].name, undefined, { slotData: false, tags: ["TextOnly"] });
    if (!run.alive) { client.socket.disconnect(); return; }
    run.state = "live"; run.error = null; changed();
  } catch (e) {
    if (!run.alive) return;
    run.client?.socket.disconnect();
    run.client = null; run.state = "retrying"; run.error = e?.message || String(e); changed();
    run.timer = setTimeout(() => connect(run), RETRY_MS);
  }
}

function found(run, item) {
  if (!run.alive || !(item.progression || item.useful || item.trap)) return;
  const sender = item.sender;
  if (!sender || !run.opts.names.has(String(sender.name).toLowerCase())) return;
  const shot = `${sender.slot}-${item.locationId}`;
  if (run.seen.has(shot)) return;
  run.seen.add(shot);
  setTimeout(async () => {
    const stream = run.opts.stream();
    if (!run.alive || !stream) return;
    try {
      const blob = await takeShot(stream, frameFor(sender.game));
      await api.saveShot(run.opts.code, shot, sender.name, blob);
      run.sent += 1; run.error = null;
    } catch (e) {
      run.error = e?.message || String(e);
    }
    changed();
  }, SHOT_DELAY);
}

function useShotWatch() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const listener = () => setTick((n) => n + 1);
    watch.listeners.add(listener);
    return () => watch.listeners.delete(listener);
  }, []);
  return watch.run;
}

// --- Réglages (onglet « Écrans », partager mon jeu) ------------------------------------------------------------
// `stream` : le partage en cours (ou null) ; `games` : les jeux de l'inscrit (un cadre par jeu).
// `names` : ses joueurs dans la partie ; `getStream()` : le partage en cours, lu au moment de la photo.
export function ShotSettings({ room, stream, games, names, getStream }) {
  const [on, setOn] = useSetting("cardShots", false);
  const [frames, setFrames] = useSetting("cardShotFrames", {});
  const list = games.length ? games : [""];
  const [game, setGame] = useState(list[0]);
  const current = list.includes(game) ? game : list[0];
  const frame = { ...DEFAULT_FRAME, ...(frames[current] || {}) };
  const set = (patch) => setFrames({ ...frames, [current]: { ...frame, ...patch } });
  const run = useShotWatch();
  const [test, setTest] = useState(null); // { url, size } ou { error }
  const [removed, setRemoved] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => () => { if (test?.url) URL.revokeObjectURL(test.url); }, [test]);
  // Écoute de la partie : tant que la case est cochée et que le partage tourne (elle continue si l'on quitte l'onglet).
  const nameKey = names.map((n) => String(n).toLowerCase()).sort().join("|");
  useEffect(() => {
    if (on && stream && room.ap_room_url && nameKey) {
      setShotWatch({ code: room.code, roomUrl: room.ap_room_url, names: new Set(nameKey.split("|")), stream: getStream });
    } else setShotWatch(null);
  }, [on, stream, room.code, room.ap_room_url, nameKey]);

  const tryShot = async () => {
    setBusy(true);
    try {
      const blob = await takeShot(stream, frame);
      setTest({ url: URL.createObjectURL(blob), size: blob.size });
    } catch (e) { setTest({ error: e?.message || String(e) }); }
    setBusy(false);
  };
  const removeMine = async () => {
    setBusy(true);
    try { const r = await api.deleteShots(room.code); setRemoved(r.removed ?? 0); } catch (e) { setRemoved(e?.message || String(e)); }
    setBusy(false);
  };

  return html`<details class="more shot-settings">
    <summary>Photos des cartes de la pêche <span class="hint">(${on ? "activées" : "désactivées"})</span></summary>
    <div class="stack full">
      <p class="hint">Pendant votre partage, quand vous trouvez un objet important (progression, utile ou piège), votre navigateur
        prend une petite image de votre écran (320 × 240, moins de 40 Ko) et l'envoie à la room : la carte de ce check la
        montre à tous ceux qui la pêchent. Elle peut montrer tout ce qui est dans le cadre (une notification, une autre
        fenêtre) : réglez-le, et vous pouvez supprimer vos photos à tout moment.</p>
      <label class="check"><input type="checkbox" checked=${on} onChange=${(e) => setOn(e.target.checked)} />
        Photographier mes trouvailles importantes</label>
      ${on && !room.ap_room_url && html`<p class="notice warn">La partie n'est pas encore hébergée : les photos commenceront une fois son lien ajouté à la room.</p>`}
      ${on && run && html`<p class="hint" role="status">${run.state === "live" ? "À l'écoute de la partie." : "Connexion à la partie…"}
        ${run.sent ? ` ${plural(run.sent, "photo envoyée", "photos envoyées")} pendant ce partage.` : ""}
        ${run.error ? html` <strong class="shot-error">${run.error}</strong>` : ""}</p>`}
      ${list.length > 1 && html`<label><span>Cadre du jeu</span>
        <select value=${current} onChange=${(e) => setGame(e.target.value)}>${list.map((g) => html`<option value=${g}>${g}</option>`)}</select></label>`}
      <div class="segmented" role="radiogroup" aria-label="Zone photographiée">
        ${[["full", "Tout l'écran"], ["frame", "Un cadre"]].map(([id, label]) => html`<button type="button" role="radio"
          aria-checked=${frame.mode === id} class=${frame.mode === id ? "active" : ""} onClick=${() => set({ mode: id })}>${label}</button>`)}
      </div>
      ${stream ? html`<${FrameEditor} stream=${stream} frame=${frame} set=${set} />`
        : html`<p class="hint">Lancez le partage pour voir et régler la zone photographiée.</p>`}
      ${frame.mode === "frame" && html`<label class="shot-zoom"><span>Zoom ×${frame.zoom.toFixed(1)}</span>
        <input type="range" min="1" max="4" step="0.1" value=${frame.zoom} onInput=${(e) => set({ zoom: Number(e.target.value) })} /></label>`}
      <div class="row">
        <button type="button" class="ghost" disabled=${!stream || busy} onClick=${tryShot}>Essayer</button>
        <button type="button" class="ghost" disabled=${busy} onClick=${removeMine}>Supprimer mes photos de cette room</button>
      </div>
      ${test?.url && html`<figure class="shot-test"><img src=${test.url} alt="Essai : la photo telle qu'elle serait envoyée" />
        <figcaption class="hint">Essai (non envoyé) : ${Math.round(test.size / 1024)} Ko.</figcaption></figure>`}
      ${test?.error && html`<p class="notice error">${test.error}</p>`}
      ${removed != null && html`<p class="hint" role="status">${typeof removed === "number" ? `${plural(removed, "photo supprimée", "photos supprimées")}.` : removed}</p>`}
    </div>
  </details>`;
}

// Aperçu du partage avec la zone photographiée : on la déplace en la faisant glisser (ou aux flèches du clavier).
function FrameEditor({ stream, frame, set }) {
  const video = useRef(null);
  const box = useRef(null);
  const drag = useRef(false);
  const settings = stream.getVideoTracks()[0]?.getSettings() || {};
  const vw = settings.width || 1280, vh = settings.height || 720;
  useEffect(() => { if (video.current && video.current.srcObject !== stream) video.current.srcObject = stream; });
  const r = shotRect(vw, vh, frame);
  const framed = frame.mode === "frame";
  const moveTo = (e) => {
    const rect = box.current.getBoundingClientRect();
    set({ x: clamp((e.clientX - rect.left) / rect.width, 0, 1), y: clamp((e.clientY - rect.top) / rect.height, 0, 1) });
  };
  const onKey = (e) => {
    const step = e.shiftKey ? 0.01 : 0.04;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (!moves[e.key]) return;
    e.preventDefault();
    // Repartir du centre réel du cadre (borné par l'image), pas de la position demandée.
    const cx = (r.x + r.w / 2) / vw, cy = (r.y + r.h / 2) / vh;
    set({ x: clamp(cx + moves[e.key][0], 0, 1), y: clamp(cy + moves[e.key][1], 0, 1) });
  };
  return html`<div class="shot-editor" ref=${box} style=${{ aspectRatio: `${vw} / ${vh}` }}
    onPointerDown=${(e) => { if (!framed) return; drag.current = true; e.currentTarget.setPointerCapture(e.pointerId); moveTo(e); }}
    onPointerMove=${(e) => { if (drag.current) moveTo(e); }}
    onPointerUp=${() => { drag.current = false; }} onPointerCancel=${() => { drag.current = false; }}>
    <video ref=${video} autoplay muted playsinline aria-hidden="true"></video>
    <div class=${`shot-frame ${framed ? "movable" : ""}`} tabindex=${framed ? 0 : -1} onKeyDown=${framed ? onKey : undefined}
      role=${framed ? "slider" : undefined} aria-label="Zone photographiée (flèches pour la déplacer)"
      aria-valuetext=${`${Math.round(((r.x + r.w / 2) / vw) * 100)} % de la largeur, ${Math.round(((r.y + r.h / 2) / vh) * 100)} % de la hauteur`}
      style=${{ left: `${(r.x / vw) * 100}%`, top: `${(r.y / vh) * 100}%`, width: `${(r.w / vw) * 100}%`, height: `${(r.h / vh) * 100}%` }}>
      <span>Carte</span></div>
  </div>`;
}
