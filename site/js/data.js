// Chargement des définitions d'options : celles de la base (générées par tools/extract_options.py)
// et celles des jeux lus depuis un apworld déposé par le joueur (mémorisées dans son navigateur).
let index = null;
const games = new Map();
const pending = new Map();
const local = new Map();
const STORAGE_PREFIX = "apworld:";

export async function loadIndex() {
  const response = await fetch("data/index.json", { cache: "no-cache" });
  if (!response.ok) throw new Error(`index.json introuvable (${response.status})`);
  index = await response.json();
  restoreLocalGames();
  return index;
}

export function apVersion() {
  return index?.ap_version || null;
}

// Un apworld déposé par le joueur passe avant le jeu de la base (il est souvent plus récent), et sur la page
// d'une room, l'apworld déposé dans la room passe avant les deux : c'est lui qui servira à générer.
export function gameEntry(name) {
  return room.get(name)?.entry || local.get(name) || serverEntry(name);
}

// Jeu de la base du site seule (sans apworld déposé), ou null.
export function serverEntry(name) {
  return index?.games.find((g) => g.game === name) || null;
}

// Noms de tous les jeux connus : ceux de la base et ceux ajoutés avec un apworld.
export function knownGames() {
  return new Set([...(index?.games || []), ...local.values(), ...[...room.values()].map((r) => r.entry)].map((g) => g.game));
}

export function cachedGame(name) {
  return room.get(name)?.data || games.get(name) || null;
}

function prepare(data) {
  data.options = new Map();
  for (const group of data.groups) for (const option of group.options) data.options.set(option.key, option);
  return data;
}

export function loadGame(name) {
  if (room.has(name)) return Promise.resolve(room.get(name).data);
  if (games.has(name)) return Promise.resolve(games.get(name));
  if (pending.has(name)) return pending.get(name);
  const entry = index?.games.find((g) => g.game === name);
  if (!entry) return Promise.resolve(null);
  const promise = fetch(`data/${entry.file}`)
    .then((r) => {
      if (!r.ok) throw new Error(`Données de « ${name} » introuvables (${r.status})`);
      return r.json();
    })
    .then((data) => {
      // Un apworld déposé pendant le téléchargement garde la priorité.
      if (!local.has(name)) games.set(name, prepare(data));
      pending.delete(name);
      return games.get(name);
    });
  pending.set(name, promise);
  return promise;
}

// --- Jeux lus depuis un apworld ---------------------------------------------------

export function localGames() {
  return [...local.values()];
}

// `server` : le jeu de la base que l'apworld remplace (sa source et sa version), s'il y en a un.
function addLocal(data) {
  const server = serverEntry(data.game);
  data.source = "apworld";
  local.set(data.game, {
    game: data.game, source: "apworld", world_version: data.world_version, apworld: data.apworld, rom: data.rom, sheet: server?.sheet,
    server: server && { source: server.source, world_version: server.world_version || null },
  });
  games.set(data.game, prepare(data));
}

export function registerLocalGame(data) {
  addLocal(data);
  try {
    const { options, ...plain } = data;
    // Version du serveur au moment du dépôt : voir restoreLocalGames.
    plain.replaced = serverEntry(data.game)?.world_version || null;
    localStorage.setItem(STORAGE_PREFIX + data.game, JSON.stringify(plain));
  } catch { /* stockage plein ou indisponible : il faudra redéposer l'apworld la prochaine fois */ }
}

// Un apworld mémorisé est oublié quand le serveur a changé de version depuis son dépôt et l'a
// rattrapé : celui du serveur est alors aussi récent, et ses descriptions sont traduites.
function outdated(data) {
  const server = serverEntry(data.game);
  if (!server || (server.world_version || null) === (data.replaced ?? null)) return false;
  return !data.world_version || !server.world_version || compareVersions(server.world_version, data.world_version) >= 0;
}

export function forgetLocalGame(name) {
  local.delete(name);
  games.delete(name);
  try { localStorage.removeItem(STORAGE_PREFIX + name); } catch { /* rien à faire */ }
  fileStore("readwrite", (store) => store.delete(name)).catch(() => {});
}

// Options de l'apworld mémorisé (sans la table `options`), telles qu'envoyées à une room.
export function localGameData(name) {
  if (!local.has(name)) return null;
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_PREFIX + name));
    if (stored) return stored;
  } catch { /* stockage indisponible */ }
  const { options, ...plain } = games.get(name);
  return plain;
}

function restoreLocalGames() {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
    for (const key of keys.filter((k) => k?.startsWith(STORAGE_PREFIX))) {
      try {
        const data = JSON.parse(localStorage.getItem(key));
        if (outdated(data)) forgetLocalGame(data.game);
        else addLocal(data);
      } catch { /* entrée illisible : ignorée */ }
    }
  } catch { /* stockage indisponible */ }
}

// --- Fichiers des apworlds ------------------------------------------------------------
// Le fichier .apworld lui-même est gardé (IndexedDB, trop gros pour localStorage) pour être envoyé à une room
// avec les YAML du joueur : l'hôte et le générateur n'ont que lui. Un apworld mémorisé avant cet ajout n'a
// que ses options : il faut redéposer le fichier.

function fileStore(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("apworld-files", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("files");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = action(db.transaction("files", mode).objectStore("files"));
      request.onsuccess = () => { resolve(request.result); db.close(); };
      request.onerror = () => { reject(request.error); db.close(); };
    };
  });
}

// `name` : nom attendu par Archipelago (celui du dossier du monde), pas celui du fichier déposé.
export function storeApworldFile(game, name, blob) {
  return fileStore("readwrite", (store) => store.put({ name, blob }, game)).catch(() => {});
}

// { name, blob } ou null.
export function apworldFileOf(game) {
  return fileStore("readonly", (store) => store.get(game)).then((f) => f || null, () => null);
}

// --- Apworlds d'une room ---------------------------------------------------------------
// Sur la page d'une room, les options des apworlds déposés dans la room (lus par le navigateur de celui qui les
// a envoyés) servent à vérifier les YAML. Rien n'est gardé une fois la page quittée.
const room = new Map();

// `list` : [{ data, by }] (by : pseudo de celui qui l'a déposé, null pour l'hôte).
export function setRoomGames(list) {
  room.clear();
  for (const { data, by } of list) {
    const server = serverEntry(data.game);
    room.set(data.game, {
      data: prepare({ ...data, source: "room" }),
      entry: {
        game: data.game, source: "room", world_version: data.world_version || null, apworld: data.apworld, rom: data.rom, by,
        sheet: server?.sheet, server: server && { source: server.source, world_version: server.world_version || null },
      },
    });
  }
}

// Compare deux versions « 0.6.8 » ; renvoie <0, 0 ou >0.
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return diff;
  }
  return 0;
}
