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

export function gameEntry(name) {
  return index?.games.find((g) => g.game === name) || local.get(name) || null;
}

export function cachedGame(name) {
  return games.get(name) || null;
}

function prepare(data) {
  data.options = new Map();
  for (const group of data.groups) for (const option of group.options) data.options.set(option.key, option);
  return data;
}

export function loadGame(name) {
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
      games.set(name, prepare(data));
      pending.delete(name);
      return data;
    });
  pending.set(name, promise);
  return promise;
}

// --- Jeux lus depuis un apworld ---------------------------------------------------

export function localGames() {
  return [...local.values()];
}

function addLocal(data) {
  if (index?.games.some((g) => g.game === data.game)) return false; // la base du site a priorité
  data.source = "apworld";
  local.set(data.game, { game: data.game, source: "apworld", world_version: data.world_version, apworld: data.apworld });
  games.set(data.game, prepare(data));
  return true;
}

export function registerLocalGame(data) {
  if (!addLocal(data)) return;
  try {
    const { options, ...plain } = data;
    localStorage.setItem(STORAGE_PREFIX + data.game, JSON.stringify(plain));
  } catch { /* stockage plein ou indisponible : il faudra redéposer l'apworld la prochaine fois */ }
}

export function forgetLocalGame(name) {
  local.delete(name);
  games.delete(name);
  try { localStorage.removeItem(STORAGE_PREFIX + name); } catch { /* rien à faire */ }
}

function restoreLocalGames() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.startsWith(STORAGE_PREFIX)) continue;
      try { addLocal(JSON.parse(localStorage.getItem(key))); } catch { /* entrée illisible : ignorée */ }
    }
  } catch { /* stockage indisponible */ }
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
