// API des rooms (Cloudflare Worker + base D1). Le site (GitHub Pages) l'appelle en JSON.
//
// Pas de compte : à la création, l'hôte reçoit un jeton d'administration, et chaque joueur
// reçoit un jeton en rejoignant la room avec son pseudo. Les jetons voyagent dans les en-têtes
// X-Admin-Token et X-Player-Token (jamais en cookie) : l'API peut donc accepter toutes les origines.
//
// La génération ne se fait pas ici : l'hôte télécharge les YAML et génère avec son Archipelago.

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
};
const ROOM_LIFETIME_DAYS = 90; // rooms sans activité supprimées par la tâche planifiée

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

function requireOpen(room) {
  if (!isOpen(room)) throw new HttpError(409, "Les dépôts de YAML sont fermés pour cette room.");
}

const touch = (env, room) => env.DB.prepare("UPDATE rooms SET updated_at = ? WHERE code = ?").bind(Date.now(), room.code);

// --- Routes --------------------------------------------------------------------

async function createRoom(request, env) {
  const body = await readJson(request);
  const now = Date.now();
  const token = newToken();
  const values = {
    title: text(body.title, "nom de la room", LIMITS.title),
    mode: mode(body.mode),
    closes_at: closesAt(body.closes_at),
    max_slots: maxSlots(body.max_slots ?? 3),
    notes: text(body.notes, "message", LIMITS.notes, { required: false }),
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomString(CODE_ALPHABET, 6);
    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO rooms (code, title, mode, closes_at, max_slots, notes, admin_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(code, values.title, values.mode, values.closes_at, values.max_slots, values.notes, await sha256(token), now, now).run();
    if (result.meta.changes) return json({ code, admin_token: token }, 201);
  }
  throw new HttpError(500, "Impossible de créer un code de room, réessayez.");
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
    created_at: room.created_at,
    updated_at: room.updated_at,
  };
}

async function getRoom(request, env, room) {
  const [admin, me, players, slots] = await Promise.all([
    isAdmin(request, room),
    currentPlayer(request, env, room),
    env.DB.prepare("SELECT id, pseudo, created_at FROM players WHERE room_code = ? ORDER BY created_at").bind(room.code).all(),
    env.DB.prepare("SELECT id, player_id, name, game, filename, issues, updated_at FROM slots WHERE room_code = ? ORDER BY created_at")
      .bind(room.code).all(),
  ]);
  return json({
    room: publicRoom(room),
    admin,
    me: me ? { id: me.id, pseudo: me.pseudo } : null,
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
  next.updated_at = Date.now();
  await env.DB.prepare(
    `UPDATE rooms SET title = ?, mode = ?, closes_at = ?, locked = ?, max_slots = ?, notes = ?, ap_room_url = ?, updated_at = ?
     WHERE code = ?`,
  ).bind(next.title, next.mode, next.closes_at, next.locked, next.max_slots, next.notes, next.ap_room_url, next.updated_at, room.code).run();
  return json({ room: publicRoom(next) });
}

async function deleteRoom(request, env, room) {
  await requireAdmin(request, room);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM slots WHERE room_code = ?").bind(room.code),
    env.DB.prepare("DELETE FROM players WHERE room_code = ?").bind(room.code),
    env.DB.prepare("DELETE FROM rooms WHERE code = ?").bind(room.code),
  ]);
  return json({ ok: true });
}

async function joinRoom(request, env, room) {
  const body = await readJson(request);
  const pseudo = text(body.pseudo, "pseudo", LIMITS.pseudo);
  if (!isOpen(room) && !(await isAdmin(request, room))) throw new HttpError(409, "Cette room n'accepte plus de nouveaux joueurs.");
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

async function removePlayer(request, env, room, playerId) {
  const me = await currentPlayer(request, env, room);
  if (me?.id !== playerId) await requireAdmin(request, room);
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

async function addSlot(request, env, room) {
  const player = await requirePlayer(request, env, room);
  if (!(await isAdmin(request, room))) requireOpen(room);
  const fields = slotFields(await readJson(request));
  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM slots WHERE player_id = ?").bind(player.id).first();
  if (count >= room.max_slots) throw new HttpError(409, `Limite atteinte : ${room.max_slots} YAML par joueur dans cette room.`);
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
  if (player?.id === slot.player_id) return { slot, admin: await isAdmin(request, room) };
  if (adminAllowed && (await isAdmin(request, room))) return { slot, admin: true };
  throw new HttpError(403, "Ce YAML appartient à un autre joueur.");
}

async function getSlot(request, env, room, slotId) {
  const { slot } = await ownedSlot(request, env, room, slotId, { adminAllowed: true });
  const { id, name, game, filename, content, updated_at } = slot;
  return json({ id, name, game, filename, content, updated_at, issues: JSON.parse(slot.issues) });
}

async function replaceSlot(request, env, room, slotId) {
  const { slot, admin } = await ownedSlot(request, env, room, slotId, { adminAllowed: false });
  if (!admin) requireOpen(room);
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
  const { slot, admin } = await ownedSlot(request, env, room, slotId, { adminAllowed: true });
  if (!admin) requireOpen(room);
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
    if (id && method === "DELETE") return removePlayer(request, env, room, id);
  } else if (sub === "slots") {
    if (!id && method === "POST") return addSlot(request, env, room);
    if (id && method === "GET") return getSlot(request, env, room, id);
    if (id && method === "PUT") return replaceSlot(request, env, room, id);
    if (id && method === "DELETE") return deleteSlot(request, env, room, id);
  } else if (sub === "export" && method === "GET") {
    return exportSlots(request, env, room);
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
      await env.DB.batch([
        env.DB.prepare("DELETE FROM slots WHERE room_code = ?").bind(code),
        env.DB.prepare("DELETE FROM players WHERE room_code = ?").bind(code),
        env.DB.prepare("DELETE FROM rooms WHERE code = ?").bind(code),
      ]);
    }
  },
};
