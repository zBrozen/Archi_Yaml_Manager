// Ce que montre l'overlay OBS : soit une grille automatique (réglages dans son adresse), soit une disposition
// libre créée par l'hôte avec l'éditeur et gardée par le service des rooms. Dans une disposition, chaque élément
// a une position en pourcentage de la page de l'overlay (x, y : coin haut gauche ; w, h : taille), pour
// s'adapter à la taille de la source OBS. Une page 16/9 rend un élément de même w et h lui aussi en 16/9.

// --- Grille automatique ------------------------------------------------------------------

// La grille s'adapte au nombre de joueurs qui partagent ; au-delà de 6, les écrans deviennent trop petits pour être
// suivis sur Twitch. Les anciens liens peuvent encore fixer un maximum plus bas (`max`) ; 0 : messages seulement.
export const MAX_SHOWN = 6;
export const DEFAULT_SHOWN = MAX_SHOWN;

// Réglages de la grille, dans l'adresse (#/overlay/CODE/CLÉ?max=4&console=droite&objets=tous).
export const CONSOLE_PLACES = { droite: "À droite des écrans", bas: "Sous les écrans", non: "Masqués" };
export const ITEM_FILTERS = { tous: "Tous les objets", importants: "Objets importants seulement (progression, utiles, pièges)" };

export function overlayOptions(params = {}) {
  const max = params.max == null || params.max === "" ? DEFAULT_SHOWN : Math.round(Number(params.max));
  return {
    max: Number.isFinite(max) ? Math.min(MAX_SHOWN, Math.max(0, max)) : DEFAULT_SHOWN,
    console: params.console in CONSOLE_PLACES ? params.console : "droite",
    objets: params.objets in ITEM_FILTERS ? params.objets : "tous",
  };
}

// --- Dispositions libres -------------------------------------------------------------------

export const LAYOUT_LIMITS = { layouts: 12, items: 40, name: 40, text: 200 }; // les mêmes que le service

export const ITEM_TYPES = {
  screens: { label: "Zone d'écrans" },
  screen: { label: "Écran d'un joueur" },
  feed: { label: "Messages de la partie" },
  progress: { label: "Progression des joueurs" },
  text: { label: "Texte" },
};
// Taille du texte : `unit` en pourcentage de la hauteur de la page (1080 px de haut : moyen = 32 px).
export const TEXT_SIZES = {
  s: { label: "Petit", unit: 2.2 },
  m: { label: "Moyen", unit: 3 },
  l: { label: "Grand", unit: 4.2 },
  xl: { label: "Très grand", unit: 6 },
};
export const ALIGNS = { left: "À gauche", center: "Centré", right: "À droite" };

export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");

// `screens` : zone qui place en grille les joueurs qui partagent, autant qu'il y en a (jusqu'à `max`) : tous ceux
// qui ne sont pas montrés ailleurs, ou seulement ceux de `players`.
const DEFAULTS = {
  screens: { w: 60, h: 60, players: [], max: MAX_SHOWN, label: true, size: "m", background: false },
  screen: { w: 32, h: 32, source: "auto", label: true, size: "m", background: false },
  feed: { w: 24, h: 60, objets: "tous", size: "m", background: true },
  progress: { w: 30, h: 40, size: "m", background: true },
  text: { w: 30, h: 8, text: "Titre", align: "center", size: "l", background: true },
};

// Numéro du prochain écran automatique libre.
export function nextSlot(items) {
  const used = new Set(items.filter((i) => i.type === "screen" && i.source === "auto").map((i) => i.slot));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

// Nouvel élément, décalé des précédents pour ne pas les recouvrir exactement.
export function newItem(type, items) {
  const base = DEFAULTS[type];
  const shift = 4 + (items.length % 8) * 4;
  const item = { id: newId(), type, x: Math.min(100 - base.w, shift), y: Math.min(100 - base.h, shift), ...structuredClone(base) };
  if (type === "screen") item.slot = nextSlot(items);
  return item;
}

// Ce que montre chaque élément : un joueur pour un écran, une liste pour une zone. D'abord les joueurs choisis
// par l'hôte (écrans d'un joueur, zones limitées à certains joueurs), s'ils partagent ; puis les autres, dans
// l'ordre où ils ont commencé à partager : aux écrans automatiques (par numéro), et ce qui reste aux zones.
export function assignScreens(items, streams) {
  const screens = items.filter((i) => i.type === "screen");
  const zones = items.filter((i) => i.type === "screens");
  const chosen = new Set([...screens.filter((s) => s.source !== "auto").map((s) => s.source), ...zones.flatMap((z) => z.players)]);
  const result = new Map();
  for (const screen of screens) {
    if (screen.source === "auto") continue;
    const stream = streams.find((s) => s.player === screen.source);
    if (stream) result.set(screen.id, stream);
  }
  for (const zone of zones) {
    if (zone.players.length) result.set(zone.id, streams.filter((s) => zone.players.includes(s.player)).slice(0, zone.max));
  }
  const free = streams.filter((s) => !chosen.has(s.player));
  let next = 0;
  for (const screen of screens.filter((s) => s.source === "auto").sort((a, b) => a.slot - b.slot)) {
    if (free[next]) result.set(screen.id, free[next++]);
  }
  for (const zone of zones) {
    if (zone.players.length) continue;
    const taken = free.slice(next, next + zone.max);
    result.set(zone.id, taken);
    next += taken.length;
  }
  return result;
}

// Joueurs dont la disposition demande l'image.
export const shownStreams = (items, streams) => [...new Set([...assignScreens(items, streams).values()].flat())];

// --- Modèles ------------------------------------------------------------------------------

const screen = (slot, x, y, size) => ({ type: "screen", ...DEFAULTS.screen, slot, x, y, w: size, h: size });
const zone = (x, y, w, h, extra = {}) => ({ type: "screens", ...DEFAULTS.screens, x, y, w, h, ...extra });

// Les zones d'écrans s'adaptent au nombre de joueurs qui partagent : un seul prend toute la zone, six se partagent
// la place en grille.
export const PRESETS = {
  grille: {
    label: "Écrans en grille",
    items: () => [zone(0, 0, 100, 100)],
  },
  complet: {
    label: "Écrans, messages et progression",
    items: () => [
      zone(0, 0, 76, 76),
      { type: "feed", ...DEFAULTS.feed, x: 76.5, y: 0, w: 23.5, h: 100 },
      { type: "progress", ...DEFAULTS.progress, x: 0, y: 76.5, w: 76, h: 23.5 },
    ],
  },
  vedette: {
    label: "1 écran en vedette, les autres à côté",
    items: () => [
      screen(1, 0, 0, 75), zone(75.5, 0, 24.5, 75, { max: 3 }),
      { type: "feed", ...DEFAULTS.feed, objets: "importants", x: 0, y: 75.5, w: 100, h: 24.5 },
    ],
  },
};

export const presetItems = (name) => PRESETS[name].items().map((item) => ({ id: newId(), ...structuredClone(item) }));
