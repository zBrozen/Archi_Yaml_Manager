// Ce que montre l'overlay d'un espace de partage : ses réglages, gardés par le service des rooms (mode automatique,
// ou une disposition par nombre d'écrans faite avec l'éditeur). Tout finit en disposition : chaque élément a une
// position en pourcentage de la page de l'overlay (x, y : coin haut gauche ; w, h : taille), pour s'adapter à la
// taille de la source du logiciel de stream. Une page 16/9 rend un élément de même w et h lui aussi en 16/9.
// Les anciens liens gardent leurs réglages dans l'adresse (?max=…&console=…) ou une disposition de l'hôte (?disposition=…).

// --- Grille automatique ------------------------------------------------------------------

// La grille s'adapte au nombre de joueurs qui partagent ; au-delà de 6, les écrans deviennent trop petits pour être
// suivis sur Twitch. Les anciens liens peuvent encore fixer un maximum plus bas (`max`) ; 0 : messages seulement.
export const MAX_SHOWN = 6;
export const DEFAULT_SHOWN = MAX_SHOWN;

export const CONSOLE_PLACES = { droite: "À droite des écrans", bas: "Sous les écrans", non: "Masqués" };
export const ITEM_FILTERS = {
  tous: "Tous les objets",
  resumes: "Tous, objets sans importance résumés (une ligne cumulée)",
  importants: "Objets importants seulement (progression, utiles, pièges)",
};
// Cases des messages de la partie (réglages automatiques d'un espace et éléments « messages » d'une disposition).
export const FEED_CHECKS = { lieux: "Lieu des objets envoyés", heure: "Heure des messages", chat: "Messages écrits par les joueurs" };
export const SCREEN_MODES = { grille: "En grille, tous de la même taille", vedette: "Un écran en grand, les autres en petit", aucun: "Pas d'écran (infos seulement)" };
export const PROGRESS_MODES = { non: "Masquée", oui: "Affichée", goal: "Affichée, avec le goal de chacun" };
export const ROTATIONS = { 0: "À la main seulement", 15: "Toutes les 15 s", 30: "Toutes les 30 s", 60: "Toutes les minutes", 120: "Toutes les 2 minutes" };

// Réglages d'un espace (les mêmes que le service, voir spaceConfig dans worker/src/index.js).
export const DEFAULT_SPACE = {
  mode: "auto", ecrans: "grille", joueurs: [], messages: "droite", objets: "tous", lieux: true, heure: false, chat: false,
  progression: "non", rotation: 0, variants: [],
};
export const spaceOf = (config) => ({ ...DEFAULT_SPACE, ...(config || {}) });

// Ancien lien avec ses réglages dans l'adresse (#/overlay/CODE/CLÉ?max=4&console=droite&objets=tous) : ils passent
// avant ceux de l'espace. null s'il n'y en a pas.
export function spaceFromParams(params = {}) {
  if (!["max", "console", "objets", "joueurs"].some((k) => params[k] != null)) return null;
  const options = overlayOptions(params);
  return spaceOf({
    ecrans: options.max ? "grille" : "aucun", messages: options.console, objets: options.objets,
    joueurs: options.joueurs ? options.joueurs.split(",") : [],
  });
}

export function overlayOptions(params = {}) {
  const max = params.max == null || params.max === "" ? DEFAULT_SHOWN : Math.round(Number(params.max));
  return {
    max: Number.isFinite(max) ? Math.min(MAX_SHOWN, Math.max(0, max)) : DEFAULT_SHOWN,
    console: params.console in CONSOLE_PLACES ? params.console : "droite",
    objets: params.objets in ITEM_FILTERS ? params.objets : "tous",
    // Joueurs montrés (identifiants séparés par des virgules) ; vide : tous ceux qui partagent.
    joueurs: String(params.joueurs || "").split(",").filter(Boolean).join(","),
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
  feed: { w: 24, h: 60, objets: "tous", lieux: true, heure: false, chat: false, size: "m", background: true },
  progress: { w: 30, h: 40, size: "m", background: true, goal: false },
  text: { w: 30, h: 8, text: "Titre", align: "center", size: "l", background: true },
};

// --- Espaces : disposition affichée -----------------------------------------------------------

// Joueurs montrés par l'espace, dans l'ordre où ils ont commencé à partager.
export const shownPlayers = (config, streams) => (config.joueurs.length ? streams.filter((s) => config.joueurs.includes(s.player)) : streams);

const box = (x, y, w, h) => ({ x, y, w, h });

// Mode automatique : écrans (en grille, ou un en grand et les autres en colonne), messages et progression placés
// d'office, sans se recouvrir. `count` : écrans à afficher. `main` : élément où dire qu'aucun joueur ne partage.
export function autoItems(config, count) {
  const feed = config.messages !== "non";
  const progress = config.progression !== "non";
  const info = feed || progress;
  const items = [];
  let screens = null;
  let side = null;
  if (config.ecrans === "aucun") side = box(0, 0, 100, 100);
  else if (!info) screens = box(0, 0, 100, 100);
  else if (config.messages === "bas") { screens = box(0, 0, 100, 76); side = box(0, 76.5, 100, 23.5); }
  else { screens = box(0, 0, 76, 100); side = box(76.5, 0, 23.5, 100); }

  if (screens && config.ecrans === "vedette" && count > 1) {
    // Les petits écrans dans une colonne à droite de l'écran en vedette.
    const small = Math.round(screens.w * 0.24 * 100) / 100;
    items.push({ id: "vedette", type: "screen", source: "vedette", slot: 1, label: true, size: "m", background: false, main: true,
      ...box(screens.x, screens.y, screens.w - small - 0.5, screens.h) });
    items.push({ id: "autres", type: "screens", players: [], max: MAX_SHOWN, label: true, size: "s", background: false,
      ...box(screens.x + screens.w - small, screens.y, small, screens.h) });
  } else if (screens) {
    items.push({ id: "ecrans", type: "screens", players: [], max: MAX_SHOWN, label: true, size: "m", background: false, main: true, ...screens });
  }
  if (side) {
    const wide = side.w > side.h;
    const split = (share) => (wide
      ? [box(side.x, side.y, side.w * share - 0.25, side.h), box(side.x + side.w * share + 0.25, side.y, side.w * (1 - share) - 0.25, side.h)]
      : [box(side.x, side.y, side.w, side.h * share - 0.25), box(side.x, side.y + side.h * share + 0.25, side.w, side.h * (1 - share) - 0.25)]);
    const [first, second] = feed && progress ? split(0.6) : [side, side];
    if (feed) {
      items.push({ id: "messages", type: "feed", objets: config.objets, lieux: config.lieux, heure: config.heure, chat: config.chat,
        size: "m", background: true, ...first });
    }
    if (progress) items.push({ id: "progression", type: "progress", goal: config.progression === "goal", size: "m", background: true, ...(feed ? second : first) });
  }
  return items;
}

// Mode à la main : la disposition prévue pour ce nombre d'écrans, sinon celle du nombre inférieur le plus proche
// (ou, à défaut, la plus petite).
export function variantFor(config, count) {
  const sorted = [...config.variants].sort((a, b) => a.count - b.count);
  return [...sorted].reverse().find((v) => v.count <= count) || sorted[0] || null;
}

export const spaceItems = (config, count) => (config.mode === "manuel" ? variantFor(config, count)?.items || [] : autoItems(config, count));

// Éléments que l'espace peut afficher, quel que soit le nombre d'écrans.
export function spaceUses(config, type) {
  if (config.mode !== "manuel") {
    if (type === "feed") return config.messages !== "non";
    if (type === "progress") return config.progression !== "non";
    if (type === "vedette") return config.ecrans === "vedette";
    return false;
  }
  const items = config.variants.flatMap((v) => v.items);
  return type === "vedette" ? items.some((i) => i.type === "screen" && i.source === "vedette") : items.some((i) => i.type === type);
}

// Taille des écrans (16/9) : le nombre de colonnes qui les rend les plus grands possible dans la zone (overlay, et
// aperçu de l'éditeur).
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

// Deux écrans (écran ou zone d'écrans) qui se recouvrent : permis, mais l'éditeur en avertit.
export const SCREEN_TYPES = ["screen", "screens"];
export const crosses = (a, b) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
export const coversScreen = (item, items) => SCREEN_TYPES.includes(item.type)
  && items.some((other) => other.id !== item.id && SCREEN_TYPES.includes(other.type) && crosses(item, other));

// Numéro du prochain écran automatique libre.
export function nextSlot(items) {
  const used = new Set(items.filter((i) => i.type === "screen" && i.source === "auto").map((i) => i.slot));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

// Nouvel élément, décalé des précédents pour ne pas les recouvrir exactement. Un écran se place à la première
// place libre (sur rien d'autre si possible, sinon seulement sans toucher un autre écran), en plus petit s'il le
// faut : null s'il n'y en a plus.
export function newItem(type, items, extra = {}) {
  const base = { ...structuredClone(DEFAULTS[type]), ...extra };
  if (SCREEN_TYPES.includes(type)) {
    const free = (item, strict) => (strict ? !items.some((other) => crosses(item, other)) : !coversScreen(item, items));
    for (const strict of [true, false]) {
      for (const size of [base.w, 24, 16, 10]) {
        for (let y = 0; y <= 100 - size; y += 2) {
          for (let x = 0; x <= 100 - size; x += 2) {
            const item = { id: newId(), type, ...base, x, y, w: size, h: size };
            if (!free(item, strict)) continue;
            if (type === "screen" && item.source === "auto") item.slot = nextSlot(items);
            return item;
          }
        }
      }
    }
    return null;
  }
  const shift = 4 + (items.length % 8) * 4;
  return { id: newId(), type, x: Math.min(100 - base.w, shift), y: Math.min(100 - base.h, shift), ...base };
}

// Ce que montre chaque élément : un joueur pour un écran, une liste pour une zone. D'abord l'écran en vedette
// (`featured` : joueur choisi en direct ou par le roulement, sinon le premier qui partage), puis les joueurs choisis
// dans la disposition (écrans d'un joueur, zones limitées à certains joueurs), s'ils partagent ; puis les autres,
// dans l'ordre où ils ont commencé à partager : aux écrans automatiques (par numéro), et ce qui reste aux zones.
export function assignScreens(items, streams, featured = null) {
  const screens = items.filter((i) => i.type === "screen");
  const zones = items.filter((i) => i.type === "screens");
  const star = screens.some((s) => s.source === "vedette") ? streams.find((s) => s.player === featured) || streams[0] : null;
  const chosen = new Set([...screens.filter((s) => !["auto", "vedette"].includes(s.source)).map((s) => s.source), ...zones.flatMap((z) => z.players)]);
  if (star) chosen.add(star.player);
  const result = new Map();
  for (const screen of screens) {
    if (screen.source === "auto") continue;
    const stream = screen.source === "vedette" ? star : streams.find((s) => s.player === screen.source);
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
export const shownStreams = (items, streams, featured = null) => [...new Set([...assignScreens(items, streams, featured).values()].flat())];

// --- Modèles ------------------------------------------------------------------------------

const screen = (slot, x, y, size) => ({ type: "screen", ...DEFAULTS.screen, slot, x, y, w: size, h: size });
const zone = (x, y, w, h, extra = {}) => ({ type: "screens", ...DEFAULTS.screens, x, y, w, h, ...extra });

// Les zones d'écrans s'adaptent au nombre de joueurs qui partagent : un seul prend toute la zone, six se partagent
// la place en grille.
export const PRESETS = {
  vide: { label: "Page vide", items: () => [] },
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
      { ...screen(1, 0, 0, 75), source: "vedette" }, zone(75.5, 0, 24.5, 75, { max: 3 }),
      { type: "feed", ...DEFAULTS.feed, objets: "importants", x: 0, y: 75.5, w: 100, h: 24.5 },
    ],
  },
};

export const presetItems = (name) => PRESETS[name].items().map((item) => ({ id: newId(), ...structuredClone(item) }));
