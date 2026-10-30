// Ce que montre l'overlay OBS : soit une grille automatique (réglages dans son adresse), soit une disposition
// libre créée par l'hôte avec l'éditeur et gardée par le service des rooms. Dans une disposition, chaque élément
// a une position en pourcentage de la page de l'overlay (x, y : coin haut gauche ; w, h : taille), pour
// s'adapter à la taille de la source OBS. Une page 16/9 rend un élément de même w et h lui aussi en 16/9.

// --- Grille automatique ------------------------------------------------------------------

export const DEFAULT_SHOWN = 4;
export const MAX_SHOWN = 6; // au-delà, les écrans deviennent trop petits pour être suivis sur Twitch

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

const DEFAULTS = {
  screen: { w: 32, h: 32, source: "auto", label: true, size: "m", background: false },
  feed: { w: 24, h: 60, objets: "tous", size: "m", background: true },
  progress: { w: 30, h: 40, size: "m", background: true },
  text: { w: 30, h: 8, text: "Équipe 1", align: "center", size: "l", background: true },
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
  const item = { id: newId(), type, x: Math.min(100 - base.w, shift), y: Math.min(100 - base.h, shift), ...base };
  if (type === "screen") item.slot = nextSlot(items);
  return item;
}

// Joueur montré par chaque écran : ceux choisis par l'hôte, s'ils partagent ; puis, pour les écrans
// automatiques (dans l'ordre de leur numéro), les autres joueurs dans l'ordre où ils ont commencé à partager.
export function assignScreens(items, streams) {
  const screens = items.filter((i) => i.type === "screen");
  const chosen = new Set(screens.filter((s) => s.source !== "auto").map((s) => s.source));
  const result = new Map();
  for (const screen of screens) {
    if (screen.source === "auto") continue;
    const stream = streams.find((s) => s.player === screen.source);
    if (stream) result.set(screen.id, stream);
  }
  const free = streams.filter((s) => !chosen.has(s.player));
  screens.filter((s) => s.source === "auto").sort((a, b) => a.slot - b.slot)
    .forEach((screen, i) => { if (free[i]) result.set(screen.id, free[i]); });
  return result;
}

// --- Modèles ------------------------------------------------------------------------------

const screen = (slot, x, y, size) => ({ type: "screen", ...DEFAULTS.screen, slot, x, y, w: size, h: size });
const text = (value, x, y, w, h) => ({ type: "text", ...DEFAULTS.text, text: value, x, y, w, h });

export const PRESETS = {
  grille: {
    label: "4 écrans en grille",
    items: () => [screen(1, 0, 0, 49.75), screen(2, 50.25, 0, 49.75), screen(3, 0, 50.25, 49.75), screen(4, 50.25, 50.25, 49.75)],
  },
  complet: {
    label: "4 écrans, messages et progression",
    items: () => [
      screen(1, 0, 0, 37.75), screen(2, 38.25, 0, 37.75), screen(3, 0, 38.25, 37.75), screen(4, 38.25, 38.25, 37.75),
      { type: "feed", ...DEFAULTS.feed, x: 76.5, y: 0, w: 23.5, h: 100 },
      { type: "progress", ...DEFAULTS.progress, x: 0, y: 76.5, w: 76, h: 23.5 },
    ],
  },
  vedette: {
    label: "1 grand écran et 3 petits",
    items: () => [
      screen(1, 0, 0, 75), screen(2, 75.5, 0, 24.5), screen(3, 75.5, 25.25, 24.5), screen(4, 75.5, 50.5, 24.5),
      { type: "feed", ...DEFAULTS.feed, objets: "importants", x: 0, y: 75.5, w: 100, h: 24.5 },
    ],
  },
  equipes: {
    label: "2 équipes de 2 joueurs",
    items: () => [
      text("Équipe 1", 0, 0, 49.5, 7), screen(1, 1.75, 7.5, 46), screen(2, 1.75, 53.75, 46),
      text("Équipe 2", 50.5, 0, 49.5, 7), screen(3, 52.25, 7.5, 46), screen(4, 52.25, 53.75, 46),
    ],
  },
};

export const presetItems = (name) => PRESETS[name].items().map((item) => ({ id: newId(), ...item }));
