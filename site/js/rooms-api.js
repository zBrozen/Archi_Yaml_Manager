// Appels au service des rooms (worker/) et accès mémorisés dans le navigateur.
//
// Pour chaque room, le navigateur garde le jeton d'hôte et/ou le jeton du joueur. Les liens
// personnels (#/room/CODE/p/JETON, #/room/CODE/h/JETON) permettent de les retrouver ailleurs.
import { ROOMS_API } from "./config.js";

const STORE = "room:";

export const roomsEnabled = () => !!ROOMS_API;

export const normalizeCode = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export function savedAccess(code) {
  try { return JSON.parse(localStorage.getItem(STORE + code)) || {}; } catch { return {}; }
}

export function saveAccess(code, patch) {
  const next = { ...savedAccess(code), ...patch, seen: Date.now() };
  for (const [key, value] of Object.entries(next)) if (value == null) delete next[key];
  try { localStorage.setItem(STORE + code, JSON.stringify(next)); } catch { /* stockage indisponible */ }
  return next;
}

export function forgetAccess(code) {
  try { localStorage.removeItem(STORE + code); } catch { /* rien à faire */ }
}

// Rooms ouvertes dans ce navigateur, les plus récentes d'abord.
export function knownRooms() {
  const rooms = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.startsWith(STORE)) continue;
      try { rooms.push({ code: key.slice(STORE.length), ...JSON.parse(localStorage.getItem(key)) }); } catch { /* ignorée */ }
    }
  } catch { /* stockage indisponible */ }
  return rooms.sort((a, b) => (b.seen || 0) - (a.seen || 0));
}

const pageUrl = () => location.href.replace(/#.*$/, "");
export const inviteLink = (code) => `${pageUrl()}#/room/${code}`;
export const playerLink = (code, token) => `${pageUrl()}#/room/${code}/p/${token}`;
export const hostLink = (code, token) => `${pageUrl()}#/room/${code}/h/${token}`;

async function call(method, path, { code, body } = {}) {
  const access = code ? savedAccess(code) : {};
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (access.admin) headers["X-Admin-Token"] = access.admin;
  if (access.player) headers["X-Player-Token"] = access.player;
  let response;
  try {
    response = await fetch(`${ROOMS_API}/api/rooms${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Le serveur des rooms ne répond pas. Vérifiez votre connexion et réessayez.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Erreur du serveur des rooms (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const at = (code, rest = "") => `/${encodeURIComponent(code)}${rest}`;

export const api = {
  create: (body) => call("POST", "", { body }),
  get: (code) => call("GET", at(code), { code }),
  update: (code, body) => call("PATCH", at(code), { code, body }),
  remove: (code) => call("DELETE", at(code), { code }),
  join: (code, pseudo) => call("POST", at(code, "/players"), { code, body: { pseudo } }),
  removePlayer: (code, id) => call("DELETE", at(code, `/players/${id}`), { code }),
  addSlot: (code, slot) => call("POST", at(code, "/slots"), { code, body: slot }),
  getSlot: (code, id) => call("GET", at(code, `/slots/${id}`), { code }),
  replaceSlot: (code, id, slot) => call("PUT", at(code, `/slots/${id}`), { code, body: slot }),
  deleteSlot: (code, id) => call("DELETE", at(code, `/slots/${id}`), { code }),
  exportSlots: (code) => call("GET", at(code, "/export"), { code }),
};

// --- Partie hébergée sur archipelago.gg (ou un autre site Archipelago) ---------------

// État public de la room (l'API room_status accepte les appels d'autres sites).
export async function apRoomStatus(roomUrl) {
  const url = new URL(roomUrl);
  const id = url.pathname.split("/").filter(Boolean)[1];
  const response = await fetch(`${url.origin}/api/room_status/${id}`);
  if (!response.ok) throw new Error(`La room Archipelago ne répond pas (${response.status}).`);
  const data = await response.json();
  return {
    origin: url.origin,
    host: url.hostname,
    port: data.last_port || null,
    tracker: data.tracker ? `${url.origin}/tracker/${data.tracker}` : null,
    // players : [[nom, jeu], …] dans l'ordre des slots (slot = position + 1).
    slots: (data.players || []).map(([name, game], i) => {
      const file = (data.downloads || []).find((d) => d.slot === i + 1);
      return { slot: i + 1, name, game, download: file ? new URL(file.download, url.origin).href : null };
    }),
  };
}
