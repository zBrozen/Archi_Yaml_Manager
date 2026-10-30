// API des rooms (Cloudflare Worker + base D1). Le site (GitHub Pages) l'appelle en JSON.
//
// Pas de compte : à la création, l'hôte reçoit un jeton d'administration, et chaque joueur
// reçoit un jeton en rejoignant la room avec son pseudo. Les jetons voyagent dans les en-têtes
// X-Admin-Token et X-Player-Token (jamais en cookie) : l'API peut donc accepter toutes les origines.
//
// La génération ne se fait pas ici : l'hôte télécharge les YAML et génère avec son Archipelago, ou
// demande une génération en ligne, faite par le workflow GitHub generate-room.yml. Ce workflow lit les YAML
// et renvoie ses résultats avec le secret partagé GENERATOR_SECRET (en-tête X-Generator-Secret) ;
// les fichiers produits sont gardés dans le stockage KV (binding FILES).
//
// Écrans des joueurs (overlay OBS) : le Durable Object ScreenRoom (binding SCREENS), un par room, met en
// relation par WebSocket les joueurs qui partagent la fenêtre de leur jeu et les overlays ouverts avec l'un des
// liens créés par l'hôte (table overlay_links). Il ne fait que relayer les messages WebRTC : les images vont
// directement d'un navigateur à l'autre.
import { DurableObject } from "cloudflare:workers";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // sans 0/O, 1/I/L
const LIMITS = {
  title: 80,
  notes: 2000,
  pseudo: 32,
  slotName: 16,
  game: 120,
  filename: 120,
  content: 512 * 1024,
  issues: 50,
  playersPerRoom: 100,
  maxSlots: 20,
  wishes: 100, // objets par wishlist
  wishName: 120,
};
const ROOM_LIFETIME_DAYS = 90; // rooms sans activité supprimées par la tâche planifiée

// Génération en ligne.
const FILE_KINDS = ["output", "spoiler"];
const FILE_LIFETIME_DAYS = 30;
const MAX_FILE_SIZE = 25 * 1024 * 1024; // limite d'une valeur KV
const QUEUED_TIMEOUT = 15 * 60 * 1000; // workflow jamais démarré
const RUNNING_TIMEOUT = 45 * 60 * 1000; // le workflow s'arrête de lui-même au bout de 30 minutes
const GEN_DEFAULTS = { spoiler: false, release_mode: "auto", collect_mode: "auto", remaining_mode: "goal", hint_cost: 10 };
const GEN_CHOICES = {
  release_mode: ["auto", "enabled", "disabled", "goal", "auto-enabled"],
  collect_mode: ["auto", "enabled", "disabled", "goal", "auto-enabled"],
  remaining_mode: ["enabled", "disabled", "goal"],
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token, X-Player-Token",
  "Access-Control-Max-Age": "86400",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
});

// --- Outils --------------------------------------------------------------------

function randomString(alphabet, length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const newId = () => randomString("abcdefghijklmnopqrstuvwxyz0123456789", 16);

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch { /* corps invalide */ }
  throw new HttpError(400, "Requête invalide.");
}

function text(value, field, max, { required = true } = {}) {
  if (value == null || value === "") {
    if (required) throw new HttpError(400, `Champ manquant : ${field}.`);
    return "";
  }
  if (typeof value !== "string") throw new HttpError(400, `Champ invalide : ${field}.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(400, `Champ manquant : ${field}.`);
  if (trimmed.length > max) throw new HttpError(400, `${field} : ${max} caractères au maximum.`);
  return trimmed;
}

function mode(value) {
  if (value !== "sync" && value !== "async") throw new HttpError(400, "Le type de room doit être « sync » ou « async ».");
  return value;
}

function closesAt(value) {
  if (value == null || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw new HttpError(400, "Date de fermeture invalide.");
  return Math.round(ms);
}

function maxSlots(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxSlots) throw new HttpError(400, `Nombre de YAML par joueur : entre 1 et ${LIMITS.maxSlots}.`);
  return n;
}

function apRoomUrl(value) {
  if (value == null || value === "") return null;
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new HttpError(400, "Lien de room invalide."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "Lien de room invalide.");
  if (!/^\/room\/[\w-]+\/?$/.test(url.pathname)) throw new HttpError(400, "Il faut le lien d'une room, de la forme https://archipelago.gg/room/…");
  return url.origin + url.pathname.replace(/\/$/, "");
}

// Nom du joueur dans la partie : celui que verra Archipelago. Les noms à motif ({number}, {player}…)
// sont refusés, sinon on ne pourrait pas garantir qu'ils restent uniques dans la room.
function slotName(value) {
  const name = text(value, "nom du joueur (name)", 64);
  if (/[{}]/.test(name)) throw new HttpError(400, `Le nom « ${name} » contient un motif ({number}, {player}…) : donnez un nom fixe.`);
  if (name.length > LIMITS.slotName) throw new HttpError(400, `Le nom « ${name} » dépasse ${LIMITS.slotName} caractères.`);
  return name;
}

function issues(value) {
  if (!Array.isArray(value)) return "[]";
  return JSON.stringify(value.slice(0, LIMITS.issues).map((i) => String(i).slice(0, 300)));
}

const isOpen = (room, now = Date.now()) => !room.locked && (room.closes_at == null || now < room.closes_at);

// --- Accès ---------------------------------------------------------------------

async function loadRoom(env, code) {
  const room = await env.DB.prepare("SELECT * FROM rooms WHERE code = ?").bind(code.toUpperCase()).first();
  if (!room) throw new HttpError(404, "Aucune room avec ce code.");
  return room;
}

async function isAdmin(request, room) {
  const token = request.headers.get("X-Admin-Token");
  return !!token && (await sha256(token)) === room.admin_hash;
}

async function requireAdmin(request, room) {
  if (!(await isAdmin(request, room))) throw new HttpError(403, "Réservé à l'hôte de la room.");
}

async function currentPlayer(request, env, room) {
  const token = request.headers.get("X-Player-Token");
  if (!token) return null;
  return env.DB.prepare("SELECT * FROM players WHERE room_code = ? AND token_hash = ?")
    .bind(room.code, await sha256(token)).first();
}

async function requirePlayer(request, env, room) {
  const player = await currentPlayer(request, env, room);
  if (!player) throw new HttpError(403, "Rejoignez d'abord la room avec votre pseudo.");
  return player;
}

// Dépôts fermés : la liste des YAML est figée pour tout le monde, hôte compris, pour qu'elle corresponde
// à la partie générée. L'hôte rouvre les dépôts pour la changer.
function requireOpen(room) {
  if (!isOpen(room)) throw new HttpError(409, "Les dépôts sont fermés : les YAML ne peuvent plus être ajoutés, modifiés ni retirés.");
}

// Room créée avec le lien d'une partie déjà hébergée : on y suit la partie, sans YAML ni génération.
function requireYamlRoom(room) {
  if (room.direct) throw new HttpError(409, "Cette room suit une partie déjà hébergée sur archipelago.gg : il n'y a pas de YAML à déposer ni de partie à générer.");
}

const touch = (env, room) => env.DB.prepare("UPDATE rooms SET updated_at = ? WHERE code = ?").bind(Date.now(), room.code);

// --- Routes --------------------------------------------------------------------

async function createRoom(request, env) {
  const body = await readJson(request);
  const now = Date.now();
  const token = newToken();
  // Avec `ap_room_url`, la room suit directement une partie déjà hébergée (pas de dépôts : ni date ni limite).
  const ap_room_url = apRoomUrl(body.ap_room_url);
  const direct = ap_room_url ? 1 : 0;
  const values = {
    title: text(body.title, "nom de la room", LIMITS.title),
    mode: mode(body.mode),
    closes_at: direct ? null : closesAt(body.closes_at),
    max_slots: direct ? 3 : maxSlots(body.max_slots ?? 3),
    notes: text(body.notes, "message", LIMITS.notes, { required: false }),
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomString(CODE_ALPHABET, 6);
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO rooms (code, title, mode, closes_at, max_slots, notes, ap_room_url, direct, admin_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(code, values.title, values.mode, values.closes_at, values.max_slots, values.notes, ap_room_url, direct,
      await sha256(token), now, now).run();
    if (result.meta.changes) return json({ code, admin_token: token }, 201);
  }
  throw new HttpError(500, "Impossible de créer un code de room, réessayez.");
}

// État de la génération en ligne ; une demande restée sans nouvelles est considérée comme échouée.
function generation(room, now = Date.now()) {
  let status = room.gen_status || null;
  let message = room.gen_message || null;
  if (status === "queued" && now - room.gen_at > QUEUED_TIMEOUT) {
    status = "failed";
    message = "Le workflow de génération n'a pas démarré (réglages GitHub à vérifier).";
  } else if (status === "running" && now - room.gen_at > RUNNING_TIMEOUT) {
    status = "failed";
    message = "La génération a dépassé le temps maximum.";
  }
  return {
    status,
    message,
    at: room.gen_at || null,
    run_url: room.gen_run_url || null,
    options: { ...GEN_DEFAULTS, ...JSON.parse(room.gen_options || "{}") },
    files: status === "done" ? JSON.parse(room.gen_files || "{}") : {},
  };
}

function publicRoom(room) {
  return {
    code: room.code,
    title: room.title,
    mode: room.mode,
    closes_at: room.closes_at,
    locked: !!room.locked,
    open: isOpen(room),
    max_slots: room.max_slots,
    notes: room.notes,
    ap_room_url: room.ap_room_url,
    direct: !!room.direct,
    overlay: !!room.overlay_hash, // ancienne clé unique, pas encore reprise dans la liste des liens
    generation: generation(room),
    created_at: room.created_at,
    updated_at: room.updated_at,
  };
}

async function getRoom(request, env, room) {
  const [admin, me, players, slots, wishes] = await Promise.all([
    isAdmin(request, room),
    currentPlayer(request, env, room),
    env.DB.prepare("SELECT id, pseudo, created_at FROM players WHERE room_code = ? ORDER BY created_at").bind(room.code).all(),
    env.DB.prepare("SELECT id, player_id, name, game, filename, issues, updated_at FROM slots WHERE room_code = ? ORDER BY created_at")
      .bind(room.code).all(),
    env.DB.prepare("SELECT slot, items FROM wishlists WHERE room_code = ?").bind(room.code).all(),
  ]);
  return json({
    room: publicRoom(room),
    admin,
    online_generation: generatorConfigured(env),
    screens: !!env.SCREENS,
    ...(admin ? { overlay_layouts: JSON.parse(room.overlay_layouts || "[]"), overlay_links: await overlayLinks(env, room) } : {}),
    me: me ? { id: me.id, pseudo: me.pseudo } : null,
    wishlists: Object.fromEntries(wishes.results.map((w) => [w.slot, JSON.parse(w.items)])),
    players: players.results.map((p) => ({
      ...p,
      slots: slots.results.filter((s) => s.player_id === p.id).map(({ player_id, issues: list, ...s }) => ({ ...s, issues: JSON.parse(list) })),
    })),
  });
}

async function updateRoom(request, env, room) {
  await requireAdmin(request, room);
  const body = await readJson(request);
  const next = { ...room };
  if ("title" in body) next.title = text(body.title, "nom de la room", LIMITS.title);
  if ("mode" in body) next.mode = mode(body.mode);
  if ("closes_at" in body) next.closes_at = closesAt(body.closes_at);
  if ("locked" in body) next.locked = body.locked ? 1 : 0;
  if ("max_slots" in body) next.max_slots = maxSlots(body.max_slots);
  if ("notes" in body) next.notes = text(body.notes, "message", LIMITS.notes, { required: false });
  if ("ap_room_url" in body) next.ap_room_url = apRoomUrl(body.ap_room_url);
  if (room.direct && !next.ap_room_url) throw new HttpError(400, "Cette room suit une partie hébergée : son lien est obligatoire.");
  next.updated_at = Date.now();
  await env.DB.prepare(
    `UPDATE rooms SET title = ?, mode = ?, closes_at = ?, locked = ?, max_slots = ?, notes = ?, ap_room_url = ?, updated_at = ?
     WHERE code = ?`,
  ).bind(next.title, next.mode, next.closes_at, next.locked, next.max_slots, next.notes, next.ap_room_url, next.updated_at, room.code).run();
  return json({ room: publicRoom(next) });
}

async function deleteFiles(env, code) {
  if (env.FILES) await Promise.all(FILE_KINDS.map((kind) => env.FILES.delete(`${code}/${kind}`)));
}

async function deleteRoom(request, env, room) {
  await requireAdmin(request, room);
  await deleteFiles(env, room.code);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM slots WHERE room_code = ?").bind(room.code),
    env.DB.prepare("DELETE FROM players WHERE room_code = ?").bind(room.code),
    env.DB.prepare("DELETE FROM wishlists WHERE room_code = ?").bind(room.code),
    env.DB.prepare("DELETE FROM overlay_links WHERE room_code = ?").bind(room.code),
    env.DB.prepare("DELETE FROM rooms WHERE code = ?").bind(room.code),
  ]);
  return json({ ok: true });
}

async function joinRoom(request, env, room) {
  const body = await readJson(request);
  const pseudo = text(body.pseudo, "pseudo", LIMITS.pseudo);
  if (!room.direct && !isOpen(room)) throw new HttpError(409, "Les dépôts sont fermés : cette room n'accepte plus de nouveaux joueurs.");
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM players WHERE room_code = ?").bind(room.code).first();
  if (count >= LIMITS.playersPerRoom) throw new HttpError(409, "Cette room est pleine.");
  const taken = await env.DB.prepare("SELECT 1 FROM players WHERE room_code = ? AND pseudo = ? COLLATE NOCASE").bind(room.code, pseudo).first();
  if (taken) throw new HttpError(409, `Le pseudo « ${pseudo} » est déjà pris dans cette room. Si c'est le vôtre, utilisez votre lien personnel.`);
  const id = newId();
  const token = newToken();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO players (id, room_code, pseudo, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, room.code, pseudo, await sha256(token), Date.now()),
    touch(env, room),
  ]);
  return json({ player: { id, pseudo }, token }, 201);
}

// Nouveau lien personnel d'un joueur, par l'hôte (joueur ajouté par lui, ou lien perdu) : l'ancien cesse de marcher.
async function resetPlayerToken(request, env, room, playerId) {
  await requireAdmin(request, room);
  const player = await env.DB.prepare("SELECT id, pseudo FROM players WHERE room_code = ? AND id = ?").bind(room.code, playerId).first();
  if (!player) throw new HttpError(404, "Ce joueur n'est plus dans la room.");
  const token = newToken();
  await env.DB.prepare("UPDATE players SET token_hash = ? WHERE id = ?").bind(await sha256(token), player.id).run();
  return json({ player, token });
}

async function removePlayer(request, env, room, playerId) {
  const me = await currentPlayer(request, env, room);
  if (me?.id !== playerId) await requireAdmin(request, room);
  if (!room.direct) requireOpen(room); // retirer un joueur retire aussi ses YAML
  await env.DB.batch([
    env.DB.prepare("DELETE FROM slots WHERE room_code = ? AND player_id = ?").bind(room.code, playerId),
    env.DB.prepare("DELETE FROM players WHERE room_code = ? AND id = ?").bind(room.code, playerId),
    touch(env, room),
  ]);
  return json({ ok: true });
}

function slotFields(body) {
  const content = typeof body.content === "string" ? body.content : "";
  if (!content.trim()) throw new HttpError(400, "Le YAML est vide.");
  if (content.length > LIMITS.content) throw new HttpError(413, "Ce YAML est trop gros.");
  return {
    name: slotName(body.name),
    game: text(body.game, "jeu", LIMITS.game),
    filename: text(body.filename, "nom du fichier", LIMITS.filename, { required: false }) || "joueur.yaml",
    content,
    issues: issues(body.issues),
  };
}

async function nameTaken(env, room, name, exceptId) {
  const row = await env.DB.prepare("SELECT id FROM slots WHERE room_code = ? AND name = ? COLLATE NOCASE AND id != ?")
    .bind(room.code, name, exceptId || "").first();
  if (row) throw new HttpError(409, `Le nom « ${name} » est déjà utilisé par un autre YAML de la room : chaque slot doit avoir son propre nom.`);
}

// Joueur à qui revient un YAML déposé : soi-même, ou (pour l'hôte seulement) un autre joueur de la room.
async function slotOwner(request, env, room, playerId) {
  const me = await currentPlayer(request, env, room);
  if (!playerId || playerId === me?.id) {
    if (!me) throw new HttpError(403, "Rejoignez d'abord la room avec votre pseudo.");
    return me;
  }
  await requireAdmin(request, room);
  const player = await env.DB.prepare("SELECT * FROM players WHERE room_code = ? AND id = ?").bind(room.code, String(playerId)).first();
  if (!player) throw new HttpError(404, "Ce joueur n'est plus dans la room.");
  return player;
}

async function addSlot(request, env, room) {
  requireYamlRoom(room);
  requireOpen(room);
  const body = await readJson(request);
  const player = await slotOwner(request, env, room, body.player_id);
  const fields = slotFields(body);
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM slots WHERE player_id = ?").bind(player.id).first();
  if (count >= room.max_slots) throw new HttpError(409, `Limite atteinte pour ${player.pseudo} : ${room.max_slots} YAML par joueur dans cette room.`);
  await nameTaken(env, room, fields.name);
  const id = newId();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO slots (id, room_code, player_id, name, game, filename, content, issues, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, room.code, player.id, fields.name, fields.game, fields.filename, fields.content, fields.issues, now, now),
    touch(env, room),
  ]);
  return json({ id }, 201);
}

async function ownedSlot(request, env, room, slotId, { adminAllowed }) {
  const slot = await env.DB.prepare("SELECT * FROM slots WHERE room_code = ? AND id = ?").bind(room.code, slotId).first();
  if (!slot) throw new HttpError(404, "Ce YAML n'existe plus.");
  const player = await currentPlayer(request, env, room);
  if (player?.id === slot.player_id) return { slot };
  if (adminAllowed && (await isAdmin(request, room))) return { slot };
  throw new HttpError(403, "Ce YAML appartient à un autre joueur.");
}

async function getSlot(request, env, room, slotId) {
  const { slot } = await ownedSlot(request, env, room, slotId, { adminAllowed: true });
  const { id, name, game, filename, content, updated_at } = slot;
  return json({ id, name, game, filename, content, updated_at, issues: JSON.parse(slot.issues) });
}

async function replaceSlot(request, env, room, slotId) {
  const { slot } = await ownedSlot(request, env, room, slotId, { adminAllowed: false });
  requireOpen(room);
  const fields = slotFields(await readJson(request));
  await nameTaken(env, room, fields.name, slot.id);
  await env.DB.batch([
    env.DB.prepare("UPDATE slots SET name = ?, game = ?, filename = ?, content = ?, issues = ?, updated_at = ? WHERE id = ?")
      .bind(fields.name, fields.game, fields.filename, fields.content, fields.issues, Date.now(), slot.id),
    touch(env, room),
  ]);
  return json({ id: slot.id });
}

async function deleteSlot(request, env, room, slotId) {
  const { slot } = await ownedSlot(request, env, room, slotId, { adminAllowed: true });
  requireOpen(room);
  await env.DB.batch([env.DB.prepare("DELETE FROM slots WHERE id = ?").bind(slot.id), touch(env, room)]);
  return json({ ok: true });
}

// Tous les YAML avec leur contenu, pour la vérification et la génération par l'hôte.
async function exportSlots(request, env, room) {
  await requireAdmin(request, room);
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.name, s.game, s.filename, s.content, s.issues, s.updated_at, p.pseudo
     FROM slots s JOIN players p ON p.id = s.player_id WHERE s.room_code = ? ORDER BY s.created_at`,
  ).bind(room.code).all();
  return json({ slots: results.map((s) => ({ ...s, issues: JSON.parse(s.issues) })) });
}

// --- Partie hébergée -----------------------------------------------------------------

const AP_PAGE_HOSTS = ["archipelago.gg"];

// Liens de chaque slot lus sur la page de la room archipelago.gg. L'API room_status renvoie pour les jeux
// qu'archipelago.gg n'a pas installés (non officiels) un lien /slot_file/ qui ne marche pas, alors que sa page
// propose le bon (/dl_patch/). Le navigateur ne peut pas lire cette page (pas de CORS) : le service le fait.
async function apRoomLinks(env, room) {
  if (!room.ap_room_url) throw new HttpError(404, "Aucune room archipelago.gg pour cette room.");
  const url = new URL(room.ap_room_url);
  if (!AP_PAGE_HOSTS.includes(url.hostname)) return json({ slots: [] });
  const response = await fetch(url.href, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!response.ok) throw new HttpError(502, `La page de la room archipelago.gg ne répond pas (${response.status}).`);
  const page = await response.text();
  const slots = [];
  for (const row of page.split(/<tr[\s>]/i).slice(1)) {
    const slot = /<td>\s*(\d+)\s*<\/td>/.exec(row)?.[1];
    if (!slot) continue;
    const link = (pattern) => {
      const path = pattern.exec(row)?.[1];
      return path ? new URL(path.replace(/&amp;/g, "&"), url.origin).href : null;
    };
    slots.push({
      slot: Number(slot),
      download: link(/href="(\/(?:dl_patch|slot_file)\/[^"]+)"/),
      tracker: link(/href="(\/tracker\/[^"]+)"/),
    });
  }
  return json({ slots });
}

// --- Génération en ligne -------------------------------------------------------------

function genOptions(body) {
  const options = { ...GEN_DEFAULTS };
  if (!body || typeof body !== "object") return options;
  if ("spoiler" in body) options.spoiler = !!body.spoiler;
  for (const [key, values] of Object.entries(GEN_CHOICES)) {
    if (!(key in body)) continue;
    if (!values.includes(body[key])) throw new HttpError(400, `Valeur invalide pour ${key}.`);
    options[key] = body[key];
  }
  if ("hint_cost" in body) {
    const cost = Number(body.hint_cost);
    if (!Number.isInteger(cost) || cost < 0 || cost > 100) throw new HttpError(400, "Coût des indices : entre 0 et 100 (%).");
    options.hint_cost = cost;
  }
  return options;
}

const generatorConfigured = (env) => !!(env.FILES && env.GH_DISPATCH_TOKEN && env.GENERATOR_SECRET && env.GITHUB_REPO);

async function startGeneration(request, env, room) {
  await requireAdmin(request, room);
  requireYamlRoom(room);
  if (!generatorConfigured(env)) throw new HttpError(501, "La génération en ligne n'est pas configurée sur ce serveur.");
  if (isOpen(room)) throw new HttpError(409, "Fermez d'abord les dépôts : la partie doit être générée avec les YAML définitifs.");
  const { status } = generation(room);
  if (status === "queued" || status === "running") throw new HttpError(409, "Une génération est déjà en cours.");
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM slots WHERE room_code = ?").bind(room.code).first();
  if (!count) throw new HttpError(409, "Aucun YAML à générer.");
  const options = genOptions((await readJson(request)).options);

  const workflow = env.GENERATE_WORKFLOW || "generate-room.yml";
  const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "archi-rooms",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs: { room: room.code } }),
  });
  if (!response.ok) {
    console.error("dispatch", response.status, await response.text());
    throw new HttpError(502, `GitHub a refusé de lancer la génération (${response.status}).`);
  }
  await deleteFiles(env, room.code);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE rooms SET gen_status = 'queued', gen_message = NULL, gen_run_url = NULL, gen_at = ?, gen_options = ?, gen_files = '{}', updated_at = ?
     WHERE code = ?`,
  ).bind(now, JSON.stringify(options), now, room.code).run();
  return json({ room: publicRoom(await loadRoom(env, room.code)) });
}

// Fichiers produits : réservés à l'hôte (le spoiler surtout).
async function downloadFile(request, env, room, kind) {
  await requireAdmin(request, room);
  const name = generation(room).files[kind];
  const file = FILE_KINDS.includes(kind) && name && env.FILES ? await env.FILES.get(`${room.code}/${kind}`, "stream") : null;
  if (!file) throw new HttpError(404, "Ce fichier n'existe plus : relancez la génération.");
  return new Response(file, {
    headers: {
      "Content-Type": kind === "output" ? "application/zip" : "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
      "Access-Control-Expose-Headers": "Content-Disposition",
      ...CORS,
    },
  });
}

async function requireGenerator(request, env) {
  const given = request.headers.get("X-Generator-Secret");
  if (!env.GENERATOR_SECRET || !given || (await sha256(given)) !== (await sha256(env.GENERATOR_SECRET))) {
    throw new HttpError(403, "Accès réservé au générateur.");
  }
}

function requireGenerating(room) {
  const { status } = generation(room);
  if (status !== "queued" && status !== "running") throw new HttpError(409, "Aucune génération en cours pour cette room.");
}

// Ce qu'il faut au workflow : les YAML et les réglages choisis par l'hôte.
async function generatorInput(env, room) {
  requireGenerating(room);
  const { results } = await env.DB.prepare("SELECT name, filename, content FROM slots WHERE room_code = ? ORDER BY created_at")
    .bind(room.code).all();
  return json({ code: room.code, mode: room.mode, options: generation(room).options, slots: results });
}

async function generatorUpload(request, env, room, kind) {
  requireGenerating(room);
  if (!FILE_KINDS.includes(kind)) throw new HttpError(404, "Type de fichier inconnu.");
  const size = Number(request.headers.get("Content-Length"));
  if (!size || size > MAX_FILE_SIZE) throw new HttpError(413, "Fichier vide ou trop gros (25 Mo au maximum).");
  await env.FILES.put(`${room.code}/${kind}`, request.body, { expirationTtl: FILE_LIFETIME_DAYS * 24 * 3600 });
  return json({ ok: true });
}

// Avancement envoyé par le workflow : { status: "running" | "done" | "failed", message, run_url, files }.
async function generatorReport(request, env, room) {
  requireGenerating(room);
  const body = await readJson(request);
  if (!["running", "done", "failed"].includes(body.status)) throw new HttpError(400, "Statut inconnu.");
  const files = {};
  if (body.status === "done") {
    for (const kind of FILE_KINDS) if (body.files?.[kind]) files[kind] = text(body.files[kind], "nom de fichier", 200);
    if (!files.output) throw new HttpError(400, "Fichier de la partie manquant.");
  }
  const message = text(body.message, "message", 2000, { required: false }) || null;
  const runUrl = typeof body.run_url === "string" && body.run_url.startsWith("https://github.com/") ? body.run_url : room.gen_run_url;
  const now = Date.now();
  await env.DB.prepare("UPDATE rooms SET gen_status = ?, gen_message = ?, gen_run_url = ?, gen_at = ?, gen_files = ?, updated_at = ? WHERE code = ?")
    .bind(body.status, message, runUrl, now, JSON.stringify(files), now, room.code).run();
  return json({ ok: true });
}

// --- Écrans des joueurs (overlay OBS) -------------------------------------------------

const SCREEN_LIMITS = {
  // Overlays ouverts en même temps (sources OBS). Chaque joueur n'envoie son image qu'à 3 d'entre eux au plus
  // (MAX_VIEWERS dans site/js/screens.js) : les autres affichent messages, progression ou texte.
  overlays: 6,
  sockets: 120,
  message: 64 * 1024,
  hello: 15 * 1000, // délai pour se présenter après l'ouverture de la connexion
};

const screens = (env, room) => env.SCREENS.get(env.SCREENS.idFromName(room.code));

function screensSocket(request, env, room) {
  if (!env.SCREENS) throw new HttpError(501, "Le partage des écrans n'est pas configuré sur ce serveur.");
  if (request.headers.get("Upgrade") !== "websocket") throw new HttpError(426, "Connexion WebSocket attendue.");
  const forward = new Request(request);
  forward.headers.set("X-Room-Code", room.code);
  return screens(env, room).fetch(forward);
}

// Liens de l'overlay (table overlay_links) : chacun a sa clé, et le supprimer ne coupe que les overlays ouverts
// avec lui. Ils restent dans la liste pour être recopiés plus tard, depuis n'importe quel appareil de l'hôte.
const OVERLAY_LINKS = { count: 10, name: 40 };

const overlayLinks = async (env, room) => (await env.DB.prepare(
  "SELECT id, name, key, created_at FROM overlay_links WHERE room_code = ? ORDER BY created_at",
).bind(room.code).all()).results;

// `key` : ancienne clé unique, gardée par le navigateur de l'hôte (rooms.overlay_hash) ; elle rejoint la liste
// telle quelle, pour que les sources OBS qui l'utilisent continuent de marcher.
async function createOverlayLink(request, env, room) {
  await requireAdmin(request, room);
  if (!env.SCREENS) throw new HttpError(501, "Le partage des écrans n'est pas configuré sur ce serveur.");
  const body = await readJson(request);
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM overlay_links WHERE room_code = ?").bind(room.code).first();
  if (count >= OVERLAY_LINKS.count) throw new HttpError(409, `${OVERLAY_LINKS.count} liens d'overlay au maximum : supprimez-en un.`);
  const name = text(body.name, "nom du lien", OVERLAY_LINKS.name, { required: false }) || `Lien ${count + 1}`;
  const legacy = typeof body.key === "string" && !!room.overlay_hash && (await sha256(body.key)) === room.overlay_hash;
  if (body.key != null && !legacy) throw new HttpError(409, "Cet ancien lien n'est plus valable.");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO overlay_links (id, room_code, name, key, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(newId(), room.code, name, legacy ? body.key : newToken(), Date.now()),
    ...(legacy ? [env.DB.prepare("UPDATE rooms SET overlay_hash = NULL WHERE code = ?").bind(room.code)] : []),
  ]);
  return json({ links: await overlayLinks(env, room) }, 201);
}

async function renameOverlayLink(request, env, room, linkId) {
  await requireAdmin(request, room);
  const name = text((await readJson(request)).name, "nom du lien", OVERLAY_LINKS.name);
  const result = await env.DB.prepare("UPDATE overlay_links SET name = ? WHERE room_code = ? AND id = ?").bind(name, room.code, linkId).run();
  if (!result.meta.changes) throw new HttpError(404, "Ce lien n'existe plus.");
  return json({ links: await overlayLinks(env, room) });
}

// Les overlays ouverts avec ce lien sont fermés tout de suite.
async function deleteOverlayLink(request, env, room, linkId) {
  await requireAdmin(request, room);
  await env.DB.prepare("DELETE FROM overlay_links WHERE room_code = ? AND id = ?").bind(room.code, linkId).run();
  if (env.SCREENS) await screens(env, room).fetch(`https://screens/overlays?link=${encodeURIComponent(linkId)}`, { method: "DELETE" });
  return json({ links: await overlayLinks(env, room) });
}

// Dispositions de l'overlay (éditeur de l'hôte, voir site/js/overlay-layout.js) : positions en pourcentage
// de la page, quatre types d'éléments. Tout ce qui n'est pas reconnu est retiré ou remplacé par sa valeur par défaut.
const LAYOUT_LIMITS = { layouts: 12, items: 40, name: 40, text: 200, size: 64 * 1024 };
const LAYOUT_ITEMS = ["screen", "feed", "progress", "text"];
const choice = (value, list, fallback) => (list.includes(value) ? value : fallback);

function layoutId(value) {
  if (typeof value !== "string" || !/^[a-z0-9]{1,16}$/.test(value)) throw new HttpError(400, "Identifiant invalide dans la disposition.");
  return value;
}

function percent(value, min) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new HttpError(400, "Position invalide dans la disposition.");
  return Math.round(Math.min(100, Math.max(min, n)) * 100) / 100;
}

function layoutItem(item) {
  const type = choice(item?.type, LAYOUT_ITEMS, null);
  if (!type) throw new HttpError(400, "Élément inconnu dans la disposition.");
  const result = {
    id: layoutId(item.id), type,
    x: percent(item.x, 0), y: percent(item.y, 0), w: percent(item.w, 1), h: percent(item.h, 1),
    size: choice(item.size, ["s", "m", "l", "xl"], "m"),
    background: !!item.background,
  };
  if (type === "screen") {
    result.source = item.source == null || item.source === "auto" ? "auto" : layoutId(item.source);
    result.slot = Math.round(percent(item.slot ?? 1, 1));
    result.label = item.label !== false;
  } else if (type === "feed") {
    result.objets = choice(item.objets, ["tous", "importants"], "tous");
  } else if (type === "text") {
    result.text = text(item.text, "texte", LAYOUT_LIMITS.text, { required: false });
    result.align = choice(item.align, ["left", "center", "right"], "center");
  }
  return result;
}

function overlayLayouts(value) {
  if (!Array.isArray(value) || value.length > LAYOUT_LIMITS.layouts) {
    throw new HttpError(400, `${LAYOUT_LIMITS.layouts} dispositions au maximum.`);
  }
  const layouts = value.map((layout) => {
    if (!Array.isArray(layout?.items) || layout.items.length > LAYOUT_LIMITS.items) {
      throw new HttpError(400, `${LAYOUT_LIMITS.items} éléments au maximum par disposition.`);
    }
    return { id: layoutId(layout.id), name: text(layout.name, "nom de la disposition", LAYOUT_LIMITS.name), items: layout.items.map(layoutItem) };
  });
  const saved = JSON.stringify(layouts);
  if (saved.length > LAYOUT_LIMITS.size) throw new HttpError(413, "Dispositions trop grandes.");
  return saved;
}

// Les overlays ouverts reçoivent tout de suite les nouvelles dispositions.
async function saveLayouts(request, env, room) {
  await requireAdmin(request, room);
  const saved = overlayLayouts((await readJson(request)).layouts);
  await env.DB.prepare("UPDATE rooms SET overlay_layouts = ? WHERE code = ?").bind(saved, room.code).run();
  if (env.SCREENS) await screens(env, room).fetch("https://screens/layouts", { method: "POST", body: saved });
  return json({ layouts: JSON.parse(saved) });
}

const sendTo = (ws, message) => {
  try { ws.send(JSON.stringify(message)); } catch { /* connexion déjà fermée */ }
};

// Protocole (messages JSON) :
//   client → service : { type: "hello", role: "player", token } ou { type: "hello", role: "overlay", key },
//                      puis { type: "signal", to, data } (relayé à un joueur s'il vient d'un overlay, et inversement).
//   service → client : { type: "welcome", id }, { type: "error", message } (puis fermeture),
//                      { type: "signal", from, data }, { type: "left", id } (aux joueurs : un overlay est parti),
//                      { type: "streams", list: [{ id, player, label, games }] } (aux overlays : joueurs qui partagent).
// Un joueur connecté est un joueur qui partage son écran : arrêter le partage ferme la connexion.
export class ScreenRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    if (request.method === "DELETE") {
      const link = new URL(request.url).searchParams.get("link");
      for (const ws of this.sockets("overlay")) {
        if (ws.deserializeAttachment().link === link) this.refuse(ws, "Ce lien d'overlay a été supprimé par l'hôte : copiez-en un autre depuis la room.");
      }
      return new Response(null, { status: 204 });
    }
    if (request.method === "POST") {
      const layouts = JSON.parse(await request.text());
      for (const ws of this.sockets("overlay")) sendTo(ws, { type: "layouts", layouts });
      return new Response(null, { status: 204 });
    }
    if (this.ctx.getWebSockets().length >= SCREEN_LIMITS.sockets) return json({ error: "Trop de connexions pour cette room." }, 429);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: newId(), code: request.headers.get("X-Room-Code"), role: null, at: Date.now() });
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + SCREEN_LIMITS.hello);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Connexions qui ne se sont pas présentées à temps.
  async alarm() {
    const limit = Date.now() - SCREEN_LIMITS.hello;
    let waiting = false;
    for (const ws of this.ctx.getWebSockets()) {
      const me = ws.deserializeAttachment();
      if (me.role) continue;
      if (me.at <= limit) this.refuse(ws, "Connexion sans présentation.");
      else waiting = true;
    }
    if (waiting) await this.ctx.storage.setAlarm(Date.now() + SCREEN_LIMITS.hello);
  }

  sockets(role, except = null) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.deserializeAttachment()?.role === role);
  }

  refuse(ws, message) {
    sendTo(ws, { type: "error", message });
    try { ws.close(4003, "refused"); } catch { /* déjà fermée */ }
  }

  // Liste des joueurs qui partagent, envoyée à tous les overlays (ou à un seul, qui vient d'arriver).
  publish(except = null, only = null) {
    const list = this.sockets("player", except).map((ws) => {
      const { id, player, label, games } = ws.deserializeAttachment();
      return { id, player, label, games };
    });
    for (const ws of only ? [only] : this.sockets("overlay", except)) sendTo(ws, { type: "streams", list });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > SCREEN_LIMITS.message) return;
    let msg;
    try { msg = JSON.parse(message); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const me = ws.deserializeAttachment();
    if (!me.role) return this.hello(ws, me, msg);
    if (msg.type !== "signal" || typeof msg.to !== "string") return;
    const target = this.ctx.getWebSockets().find((other) => other.deserializeAttachment()?.id === msg.to);
    const them = target?.deserializeAttachment();
    if (them?.role && them.role !== me.role) sendTo(target, { type: "signal", from: me.id, data: msg.data });
  }

  async hello(ws, me, msg) {
    try {
      if (msg.type !== "hello") throw new HttpError(400, "Message inattendu.");
      const room = await this.env.DB.prepare("SELECT code, overlay_hash, overlay_layouts FROM rooms WHERE code = ?").bind(me.code).first();
      if (!room) throw new HttpError(404, "Aucune room avec ce code.");
      if (msg.role === "overlay") {
        // Un lien de la liste, ou l'ancienne clé unique tant qu'elle n'y a pas été reprise.
        const link = typeof msg.key === "string"
          ? await this.env.DB.prepare("SELECT id FROM overlay_links WHERE room_code = ? AND key = ?").bind(room.code, msg.key).first()
          : null;
        const legacy = !link && typeof msg.key === "string" && !!room.overlay_hash && (await sha256(msg.key)) === room.overlay_hash;
        if (!link && !legacy) {
          throw new HttpError(403, "Lien d'overlay invalide ou supprimé : copiez un lien depuis la room (onglet « Écrans »).");
        }
        if (this.sockets("overlay").length >= SCREEN_LIMITS.overlays) {
          throw new HttpError(409, `Déjà ${SCREEN_LIMITS.overlays} overlays ouverts pour cette room : fermez-en un.`);
        }
        Object.assign(me, { role: "overlay", link: link?.id || "ancien" });
      } else if (msg.role === "player") {
        const player = typeof msg.token === "string"
          ? await this.env.DB.prepare("SELECT id, pseudo FROM players WHERE room_code = ? AND token_hash = ?").bind(room.code, await sha256(msg.token)).first()
          : null;
        if (!player) throw new HttpError(403, "Rejoignez d'abord la room avec votre pseudo.");
        const { results } = await this.env.DB.prepare("SELECT game FROM slots WHERE player_id = ? ORDER BY created_at").bind(player.id).all();
        // Un seul partage par joueur : le dernier ouvert remplace les autres.
        for (const other of this.sockets("player")) {
          if (other.deserializeAttachment().player === player.id) this.refuse(other, "Partage repris depuis une autre page.");
        }
        Object.assign(me, { role: "player", player: player.id, label: player.pseudo, games: [...new Set(results.map((r) => r.game))] });
      } else {
        throw new HttpError(400, "Rôle inconnu.");
      }
      ws.serializeAttachment(me);
      sendTo(ws, me.role === "overlay"
        ? { type: "welcome", id: me.id, layouts: JSON.parse(room.overlay_layouts || "[]") }
        : { type: "welcome", id: me.id });
      if (me.role === "overlay") this.publish(null, ws);
      else this.publish();
    } catch (error) {
      if (!(error instanceof HttpError)) console.error(error);
      this.refuse(ws, error instanceof HttpError ? error.message : "Erreur du serveur des rooms.");
    }
  }

  async webSocketClose(ws, code) {
    const me = ws.deserializeAttachment();
    if (me?.role === "overlay") for (const player of this.sockets("player", ws)) sendTo(player, { type: "left", id: me.id });
    if (me?.role === "player") this.publish(ws);
    try { ws.close(code >= 3000 && code < 5000 ? code : 1000, "bye"); } catch { /* déjà fermée */ }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }
}

// --- Wishlists -------------------------------------------------------------------
// Objets qu'un joueur attend, par nom de joueur dans la partie (slot). Seul ce joueur (ou l'hôte) la modifie :
// le slot doit être l'un de ses YAML, ou, dans une room de partie déjà hébergée, son pseudo.
async function saveWishlist(request, env, room, slot) {
  const name = decodeURIComponent(slot).trim();
  if (!name || name.length > LIMITS.slotName * 4) throw new HttpError(400, "Nom de joueur invalide.");
  if (!(await isAdmin(request, room))) {
    const player = await requirePlayer(request, env, room);
    const owns = room.direct
      ? player.pseudo.toLowerCase() === name.toLowerCase()
      : !!(await env.DB.prepare("SELECT 1 FROM slots WHERE player_id = ? AND name = ? COLLATE NOCASE").bind(player.id, name).first());
    if (!owns) throw new HttpError(403, `La wishlist de « ${name} » ne peut être modifiée que par ce joueur.`);
  }
  const body = await readJson(request);
  if (!Array.isArray(body.items)) throw new HttpError(400, "Liste d'objets attendue.");
  const items = [...new Set(body.items.map((i) => String(i).trim()).filter(Boolean))];
  if (items.length > LIMITS.wishes) throw new HttpError(400, `Au plus ${LIMITS.wishes} objets par wishlist.`);
  if (items.some((i) => i.length > LIMITS.wishName)) throw new HttpError(400, "Nom d'objet trop long.");
  const now = Date.now();
  await env.DB.batch([
    items.length
      ? env.DB.prepare(
        `INSERT INTO wishlists (room_code, slot, items, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (room_code, slot) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at`,
      ).bind(room.code, name, JSON.stringify(items), now)
      : env.DB.prepare("DELETE FROM wishlists WHERE room_code = ? AND slot = ?").bind(room.code, name),
    touch(env, room),
  ]);
  return json({ slot: name, items });
}

async function route(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const method = request.method;
  if (parts[0] !== "api" || parts[1] !== "rooms") throw new HttpError(404, "Route inconnue.");
  if (parts.length === 2 && method === "POST") return createRoom(request, env);
  if (parts.length < 3) throw new HttpError(404, "Route inconnue.");

  const room = await loadRoom(env, parts[2]);
  const [, , , sub, id] = parts;
  if (!sub) {
    if (method === "GET") return getRoom(request, env, room);
    if (method === "PATCH") return updateRoom(request, env, room);
    if (method === "DELETE") return deleteRoom(request, env, room);
  } else if (sub === "players") {
    if (!id && method === "POST") return joinRoom(request, env, room);
    if (id && !parts[5] && method === "DELETE") return removePlayer(request, env, room, id);
    if (id && parts[5] === "token" && method === "POST") return resetPlayerToken(request, env, room, id);
  } else if (sub === "slots") {
    if (!id && method === "POST") return addSlot(request, env, room);
    if (id && method === "GET") return getSlot(request, env, room, id);
    if (id && method === "PUT") return replaceSlot(request, env, room, id);
    if (id && method === "DELETE") return deleteSlot(request, env, room, id);
  } else if (sub === "wishlists" && id && method === "PUT") {
    return saveWishlist(request, env, room, id);
  } else if (sub === "export" && method === "GET") {
    return exportSlots(request, env, room);
  } else if (sub === "ap-links" && !id && method === "GET") {
    return apRoomLinks(env, room);
  } else if (sub === "generate" && !id && method === "POST") {
    return startGeneration(request, env, room);
  } else if (sub === "files" && id && method === "GET") {
    return downloadFile(request, env, room, id);
  } else if (sub === "screens") {
    if (!id && method === "GET") return screensSocket(request, env, room);
    const linkId = parts[5];
    if (id === "links" && !linkId && method === "POST") return createOverlayLink(request, env, room);
    if (id === "links" && linkId && method === "PATCH") return renameOverlayLink(request, env, room, linkId);
    if (id === "links" && linkId && method === "DELETE") return deleteOverlayLink(request, env, room, linkId);
    if (id === "layouts" && method === "PUT") return saveLayouts(request, env, room);
  } else if (sub === "generator") {
    await requireGenerator(request, env);
    const kind = parts[5];
    if (!id && method === "GET") return generatorInput(env, room);
    if (!id && method === "POST") return generatorReport(request, env, room);
    if (id === "files" && kind && method === "PUT") return generatorUpload(request, env, room, kind);
  }
  throw new HttpError(404, "Route inconnue.");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "Erreur du serveur des rooms." }, 500);
    }
  },

  // Tâche planifiée (voir wrangler.toml) : supprime les rooms sans activité depuis longtemps.
  async scheduled(event, env) {
    const limit = Date.now() - ROOM_LIFETIME_DAYS * 24 * 3600 * 1000;
    const { results } = await env.DB.prepare("SELECT code FROM rooms WHERE updated_at < ?").bind(limit).all();
    for (const { code } of results) {
      await deleteFiles(env, code);
      await env.DB.batch([
        env.DB.prepare("DELETE FROM slots WHERE room_code = ?").bind(code),
        env.DB.prepare("DELETE FROM players WHERE room_code = ?").bind(code),
        env.DB.prepare("DELETE FROM wishlists WHERE room_code = ?").bind(code),
        env.DB.prepare("DELETE FROM overlay_links WHERE room_code = ?").bind(code),
        env.DB.prepare("DELETE FROM rooms WHERE code = ?").bind(code),
      ]);
    }
  },
};
