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
export const overlayLink = (code, key) => `${pageUrl()}#/overlay/${code}/${key}`;
export const screensSocketUrl = (code) => `${ROOMS_API.replace(/^http/, "ws")}/api/rooms${at(code, "/screens")}`;

// `file: true` : la réponse est un fichier, rendu en { blob, name }. Un `body` fichier (Blob) est envoyé tel quel.
async function call(method, path, { code, body, file = false } = {}) {
  const access = code ? savedAccess(code) : {};
  const headers = {};
  const raw = body instanceof Blob;
  if (body !== undefined) headers["Content-Type"] = raw ? "application/octet-stream" : "application/json";
  if (access.admin) headers["X-Admin-Token"] = access.admin;
  if (access.player) headers["X-Player-Token"] = access.player;
  let response;
  try {
    response = await fetch(`${ROOMS_API}/api/rooms${path}`, {
      method,
      headers,
      body: body === undefined || raw ? body : JSON.stringify(body),
    });
  } catch {
    throw new Error("Le serveur des rooms ne répond pas. Vérifiez votre connexion et réessayez.");
  }
  if (file && response.ok) {
    const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "")?.[1] || "fichier";
    return { blob: await response.blob(), name };
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
  resetPlayerLink: (code, id) => call("POST", at(code, `/players/${id}/token`), { code }),
  addSlot: (code, slot) => call("POST", at(code, "/slots"), { code, body: slot }),
  getSlot: (code, id) => call("GET", at(code, `/slots/${id}`), { code }),
  replaceSlot: (code, id, slot) => call("PUT", at(code, `/slots/${id}`), { code, body: slot }),
  deleteSlot: (code, id) => call("DELETE", at(code, `/slots/${id}`), { code }),
  exportSlots: (code) => call("GET", at(code, "/export"), { code }),
  apLinks: (code) => call("GET", at(code, "/ap-links"), { code }),
  apInventory: (code, slot) => call("GET", at(code, `/ap-inventory/${slot}`), { code }),
  generate: (code, options) => call("POST", at(code, "/generate"), { code, body: { options } }),
  file: (code, kind) => call("GET", at(code, `/files/${kind}`), { code, file: true }),
  uploadApworld: (code, game, name, file) => call("PUT", at(code, `/apworlds/${encodeURIComponent(name)}?game=${encodeURIComponent(game)}`), { code, body: file }),
  deleteApworld: (code, name) => call("DELETE", at(code, `/apworlds/${encodeURIComponent(name)}`), { code }),
  saveApworldData: (code, name, data) => call("PUT", at(code, `/apworlds/${encodeURIComponent(name)}/data`), { code, body: data }),
  apworldData: (code, name) => call("GET", at(code, `/apworlds/${encodeURIComponent(name)}/data`), { code }),
  downloadApworld: (code, name) => call("GET", at(code, `/apworlds/${encodeURIComponent(name)}`), { code, file: true }),
  createOverlayLink: (code, body) => call("POST", at(code, "/screens/links"), { code, body }),
  updateOverlayLink: (code, id, patch) => call("PATCH", at(code, `/screens/links/${id}`), { code, body: patch }),
  deleteOverlayLink: (code, id) => call("DELETE", at(code, `/screens/links/${id}`), { code }),
  saveSpaceConfig: (code, id, config) => call("PUT", at(code, `/screens/links/${id}/config`), { code, body: { config } }),
  setFeatured: (code, id, player) => call("PUT", at(code, `/screens/links/${id}/featured`), { code, body: { player } }),
  saveLayouts: (code, layouts) => call("PUT", at(code, "/screens/layouts"), { code, body: { layouts } }),
  setSpoilerAccess: (code, id, on) => call("PATCH", at(code, `/players/${id}`), { code, body: { spoiler_access: on } }),
  shareSpoiler: (code, { name, at: when, text }) => call("PUT", at(code, `/spoiler?name=${encodeURIComponent(name)}&at=${when}`),
    { code, body: new Blob([text], { type: "text/plain" }) }),
  unshareSpoiler: (code) => call("DELETE", at(code, "/spoiler"), { code }),
  sharedSpoiler: (code) => call("GET", at(code, "/spoiler"), { code, file: true }),
  saveWishlist: (code, slot, items) => call("PUT", at(code, `/wishlists/${encodeURIComponent(slot)}`), { code, body: { items } }),
};

// --- Partie hébergée sur archipelago.gg (ou un autre site Archipelago) ---------------

// État public de la room (l'API room_status accepte les appels d'autres sites), complété par les liens
// de la page de la room, lus par le service : pour les jeux non officiels, le lien de téléchargement
// de l'API (/slot_file/) ne marche pas, celui de la page (/dl_patch/) oui.
export async function apRoomStatus(code, roomUrl) {
  const url = new URL(roomUrl);
  const id = url.pathname.split("/").filter(Boolean)[1];
  const [response, links] = await Promise.all([
    fetch(`${url.origin}/api/room_status/${id}`),
    api.apLinks(code).then((r) => r.slots).catch(() => []),
  ]);
  if (!response.ok) throw new Error(`La room Archipelago ne répond pas (${response.status}).`);
  const data = await response.json();
  const port = data.last_port || null;
  return {
    origin: url.origin,
    host: url.hostname,
    port,
    tracker: data.tracker ? `${url.origin}/tracker/${data.tracker}` : null,
    trackerId: data.tracker || null,
    // players : [[nom, jeu], …] dans l'ordre des slots (slot = position + 1).
    slots: (data.players || []).map(([name, game], i) => {
      const slot = i + 1;
      const page = links.find((l) => l.slot === slot);
      const file = (data.downloads || []).find((d) => d.slot === slot);
      const fromApi = file && !file.download.includes("/slot_file/") ? new URL(file.download, url.origin).href : null;
      return {
        slot,
        name,
        game,
        download: page ? page.download : fromApi,
        // Sans les liens de la page, un fichier de l'API en /slot_file/ se télécharge depuis la page de la room.
        onRoomPage: !page && !!file && !fromApi,
        tracker: page?.tracker || null,
        // Lien qui ouvre le client Archipelago déjà rempli, comme sur la page de la room.
        connect: port ? `archipelago://${encodeURIComponent(name)}:None@${url.hostname}:${port}?game=${encodeURIComponent(game)}&room=${id}` : null,
      };
    }),
  };
}
