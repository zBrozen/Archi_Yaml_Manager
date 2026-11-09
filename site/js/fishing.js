// Pêche au large : petit jeu d'attente pour un joueur bloqué (BK). La feuille se roule (main.js) et laisse la mer du
// fond (sea.js). Chaque poisson porte une carte : un check de la room ouverte (sinon d'une partie de démonstration).
// Son espèce dit la rareté de l'objet (sardine : ordinaire ; rouget : utile ; raie, espadon, kraken : progression ;
// murène : piège ; poisson doré : objet d'une wishlist) ; plus la carte est précieuse, plus le poisson est rusé et
// résiste. On lance la ligne près de celui qu'on veut, on ferre quand il mord, on le remonte : la carte rejoint le
// catalogue (un onglet par joueur). Les doubles donnent des doublons, qui achètent des cartes au trésor (le prochain
// poisson porte une carte manquante de l'île choisie). L'adresse paie en chance, pas en score : un combo de prises
// rend les cartes rares, nouvelles et brillantes plus fréquentes. Chaque nouveau check de la partie amène un banc.
// Tout reste dans le navigateur ; rien n'est envoyé nulle part, aucun avantage dans la partie. Jamais sur l'overlay.
// Les cartes ne montrent que des objets déjà envoyés, déjà visibles sur le tracker : aucun spoiler.
import { html, useState, useEffect, useMemo, useRef } from "../vendor/preact-htm.js";
import { usePackages, wishIndex } from "./room-live.js";
import { plural } from "./ui.js";
import { api, savedAccess, shotUrl } from "./rooms-api.js";
import { BIOMES, biomeOf, createScene, drawEdges } from "./fishing-scene.js";

// --- Partie de la room ouverte ---------------------------------------------------------------
// La page d'une room (rooms.js) publie ici sa partie (joueurs, tracker, wishlists, vos joueurs) tant qu'elle est ouverte.
let feed = null;
const feedListeners = new Set();
const publish = (next) => {
  feed = next;
  for (const listener of feedListeners) listener(next);
};

export function useFishingFeed(code, status, tracker, mine, wishlists, shots) {
  const names = mine.map((m) => String(m.name).toLowerCase()).join("\n");
  const shotKey = (shots || []).join(",");
  useEffect(() => {
    if (status && tracker?.data) {
      publish({ code, status, data: tracker.data, mine: names ? names.split("\n") : [], wishlists: wishlists || {}, shots: shotKey ? shotKey.split(",") : [] });
    }
  }, [code, status, tracker?.data, names, wishlists, shotKey]);
  useEffect(() => () => { if (feed?.code === code) publish(null); }, [code]);
}

function useFeed() {
  const [value, setValue] = useState(feed);
  useEffect(() => {
    feedListeners.add(setValue);
    setValue(feed);
    return () => feedListeners.delete(setValue);
  }, []);
  return value;
}

// --- Règles du jeu ---------------------------------------------------------------------------
// Poissons imaginaires de l'archipel, un par rareté de carte (`kind` ; `wish` : objet d'une wishlist). `trait` : curious
// (vient au bouchon), shy (fuit un bouchon tombé trop près, ne vient qu'après un moment), hidden (sous le sable : ses
// remous seulement, ne vient que de tout près), fast (fonce, touche très brève) ; `window` : temps pour ferrer (ms) ;
// `notice` : distance à laquelle il voit le bouchon (px) ; `time` : day ou night (sinon toujours) ; `the` : nom court
// avec l'article, pour les messages.
const FISH = [
  { id: "sardine", kind: "filler", the: "la sardine", name: "Sardine des brumes", size: 17, speed: 70, color: "#a9c1cc", shape: "slim", trait: "curious", window: 950, notice: 190 },
  { id: "hareng", kind: "filler", the: "le hareng", name: "Hareng de la boussole", size: 20, speed: 60, color: "#d3ad5c", shape: "slim", trait: "curious", window: 850, notice: 180 },
  { id: "rouget", kind: "useful", the: "le rouget", name: "Rouget du récif", size: 22, speed: 50, color: "#d8664c", shape: "round", trait: "shy", window: 750, notice: 160, time: "day" },
  { id: "lanterne", kind: "useful", the: "le poisson-lanterne", name: "Poisson-lanterne", size: 22, speed: 40, color: "#5a6a92", shape: "lantern", trait: "curious", window: 750, notice: 190, time: "night" },
  { id: "raie", kind: "progression", the: "la raie", name: "Raie des cartographes", size: 32, speed: 30, color: "#a8946f", shape: "ray", trait: "hidden", window: 650, notice: 110 },
  { id: "espadon", kind: "progression", the: "l'espadon", name: "Espadon des tempêtes", size: 32, speed: 125, color: "#6a8fbe", shape: "sword", trait: "fast", window: 420, notice: 220, time: "day" },
  { id: "kraken", kind: "progression", the: "le bébé kraken", name: "Bébé kraken", size: 26, speed: 30, color: "#a866a4", shape: "squid", trait: "shy", window: 600, notice: 140, time: "night" },
  { id: "murene", kind: "trap", the: "la murène", name: "Murène maudite", size: 24, speed: 80, color: "#56703f", shape: "slim", trait: "curious", window: 800, notice: 200 },
  { id: "dore", kind: "wish", the: "le poisson doré", name: "Poisson doré", size: 22, speed: 95, color: "#f2c25b", shape: "round", trait: "fast", window: 520, notice: 210 },
];
// Espèce qui porte une carte : selon sa rareté, parmi celles de l'heure (jour ou nuit).
function speciesFor(card, night) {
  const kind = card.wish ? "wish" : card.kind;
  const all = FISH.filter((f) => f.kind === kind);
  const now = all.filter((f) => !f.time || (f.time === "night") === night);
  return pick(now.length ? now : all);
}
// Remontée : clics nécessaires (chacun le tire d'un coup sec vers la canne) et force avec laquelle il tire en arrière
// entre deux clics (part du chemin par seconde). Il ne peut pas s'échapper. Sardines, harengs, murènes : d'un coup.
const REEL = {
  rouget: { taps: 2, back: 0.1 },
  lanterne: { taps: 2, back: 0.1 },
  raie: { taps: 4, back: 0.14 },
  espadon: { taps: 4, back: 0.22 },
  kraken: { taps: 5, back: 0.16 },
  dore: { taps: 3, back: 0.2 },
};
const JUMP_MS = 750; // saut final : le poisson sort de l'eau et file vers le compteur du catalogue
// Rythme : ferrer tout au début de la morsure est « Parfait ! » (compte double dans le combo) ; les prises enchaînées
// font un combo tant que la suivante arrive à temps, et le combo donne de la chance (cartes rares, nouvelles et
// brillantes plus fréquentes, jusqu'à ×2) ; un raté le casse. Chaque nouveau check de la partie amène un banc.
const PERFECT = 0.4; // part de la morsure (au début) où le ferrage est parfait
const COMBO_MS = 9000; // temps pour enchaîner la prise suivante
const luckOf = (n) => Math.min(2, 1 + 0.15 * Math.max(0, n - 1));
const BANC_MS = 10000; // banc : les poissons affluent et mordent tout de suite
const MAX_FISH = 7;
const DAY_MS = 150000; // cycle propre au jeu : 2 min 30 de jour, 1 min 15 de nuit
const NIGHT_MS = 75000;
const lowerFirst = (text) => text.charAt(0).toLowerCase() + text.slice(1);
const ofName = (name) => (/^[aeiouyâàéèêëîïôöûü]/i.test(name) ? `d'${name}` : `de ${name}`); // « l'île d'Alex », « de Sam »

// Cartes : importance de l'objet (drapeaux d'Archipelago). Symbole en plus de la couleur ; doublons d'un double ;
// fréquence au tirage.
const KINDS = {
  progression: { mark: "★", label: "Objet de progression", dup: 4, weight: 12, tag: "#f2c25b" },
  useful: { mark: "◆", label: "Objet utile", dup: 2, weight: 20, tag: "#9ec6e8" },
  filler: { mark: "•", label: "Objet ordinaire", dup: 1, weight: 60, tag: "#efe6cf" },
  trap: { mark: "⚠", label: "Piège", dup: 1, weight: 8, tag: "#e07a5f" },
};
const KIND_ORDER = ["progression", "useful", "trap", "filler"];
const WISH = { mark: "♥", tag: "#ec9bbb" };
const kindOf = (flags) => (flags & 1 ? "progression" : flags & 4 ? "trap" : flags & 2 ? "useful" : "filler");
const SCARE_MS = 6000; // carte maudite : les poissons fuient
// Carte nouvelle : rare exprès, pour que la collection dure (une île d'une dizaine de cartes, un bon quart d'heure).
// Chance de base, qui monte à chaque double d'affilée ; certaine après PITY doubles. Le combo ajoute un peu.
const NEW_CHANCE = 0.08;
const NEW_STEP = 0.015;
const NEW_LUCK = 0.06; // au plus, combo maximal
const PITY = 25;
const SHINY = 1 / 40;
// Carte au trésor : chère exprès, une récompense de longue pêche (environ 150 prises, une demi-heure).
const TREASURE_PRICE = 200; // doublons (un double en rapporte 1 à 4)
// Une carte pêchée plusieurs fois s'améliore : argentée au 3ᵉ exemplaire, dorée au 6ᵉ. Chaque double fait avancer.
const TIERS = [["gold", 6, "Or"], ["silver", 3, "Argent"]];
const tierOf = (n) => TIERS.find(([, at]) => n >= at)?.[0] || "";
const tierLabel = (n) => TIERS.find(([, at]) => n >= at)?.[2] || "";
const nextTier = (n) => (n < 3 ? 3 : n < 6 ? 6 : 0);
const SYNC_MS = 4000; // envoi de la collection à la room, après un moment sans prise

// Partie de démonstration, sans room ouverte : des cartes fictives, pour essayer (catalogue « DEMO » à part).
const DEMO_FEED = {
  code: "DEMO", mine: [], wishlists: {},
  status: { slots: [{ slot: 1, name: "Alex", game: "Hollow Knight" }, { slot: 2, name: "Sam", game: "A Link to the Past" },
    { slot: 3, name: "Lou", game: "Stardew Valley" }] },
  data: { fixed: { player_locations_total: [1, 2, 3].map((player) => ({ team: 0, player, total_locations: 24 })) } },
};
const DEMO_CARDS = [
  ["Mantis Claw", "progression", 1, 2, "Kakariko Well"], ["Monarch Wings", "progression", 1, 3, "Pelican Town Museum"],
  ["Mask Shard", "useful", 1, 1, "Greenpath"], ["Grub", "filler", 1, 1, "Forgotten Crossroads"], ["Geo Rock", "filler", 1, 2, "Lake Hylia"],
  ["Hookshot", "progression", 2, 1, "Crystal Peak"], ["Moon Pearl", "progression", 2, 3, "Cindersap Forest", true],
  ["Piece of Heart", "useful", 2, 2, "Death Mountain"], ["Rupees (20)", "filler", 2, 1, "City of Tears"], ["Ice Trap", "trap", 2, 3, "The Mines"],
  ["Bombs (10)", "filler", 2, 2, "Hyrule Castle"], ["Return Scepter", "progression", 3, 1, "Queen's Gardens"],
  ["Stardrop", "useful", 3, 2, "Skull Woods"], ["Wood (50)", "filler", 3, 3, "Farm Cave"], ["Copper Ore", "filler", 3, 1, "Fungal Wastes"],
  ["Progressive Hoe", "progression", 3, 3, "Community Center"], ["Coal", "filler", 3, 2, "Desert Palace"], ["Vessel Fragment", "useful", 1, 3, "Secret Woods"],
].map(([name, kind, to, from, place, wish], i) => {
  const slot = (n) => DEMO_FEED.status.slots[n - 1];
  return { key: `demo:${i}`, kind, name, game: slot(to).game, to: slot(to).name, from: slot(from).name, fromSlot: from, place, wish: !!wish };
});

// Une carte par objet envoyé dans la partie (tracker : [objet, lieu, joueur qui l'envoie, drapeaux]), clé
// « joueur qui reçoit:rang ». Les objets du serveur (inventaire de départ) ne sont pas des checks : écartés.
// `name` reste vide tant que le datapackage du jeu n'est pas chargé. `fromSlot` : île (monde) où le check a été fait.
function roomCards(current, loaded) {
  const slots = new Map(current.status.slots.map((s) => [s.slot, s]));
  const wishes = wishIndex(current.wishlists);
  const cards = [];
  for (const entry of current.data.live?.player_items_received || []) {
    const to = entry.team === 0 && slots.get(entry.player);
    if (!to) continue;
    entry.items.forEach((raw, index) => {
      const [item, location, sender, flags = 0] = Array.isArray(raw) ? raw : [raw.item, raw.location, raw.player, raw.flags];
      if (!sender) return;
      const from = slots.get(sender);
      const name = loaded[to.game]?.items.get(item) || "";
      cards.push({
        key: `${entry.player}:${index}`, kind: kindOf(flags), name, game: to.game, to: to.name, fromSlot: sender, shot: `${sender}-${location}`,
        from: from?.name || `Joueur ${sender}`, place: (from && loaded[from.game]?.locations.get(location)) || "",
        wish: !!name && !!wishes.get(to.name.toLowerCase())?.has(name),
      });
    });
  }
  return cards;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
function pickWeighted(entries) { // [[valeur, poids]]
  let r = Math.random() * entries.reduce((n, [, w]) => n + w, 0);
  for (const [value, w] of entries) if ((r -= w) < 0) return value;
  return entries.at(-1)?.[0];
}

// Tirage d'une carte parmi les checks connus (`pool`), `owned` : cartes déjà au classeur, `dry` : doubles d'affilée.
// Nouvelle ou double d'abord (NEW_CHANCE, plus NEW_STEP par double d'affilée, certaine après PITY doubles), puis le type
// selon sa fréquence parmi les cartes possibles. `target` : île visée par une carte au trésor (carte manquante).
// `luck` (combo, de 1 à 2) : rares et utiles plus fréquentes, cartes nouvelles et brillantes un peu plus probables.
function drawCard(pool, owned, dry, { target, luck = 1 } = {}) {
  if (!pool.length) return null;
  const missing = pool.filter((c) => !owned[c.key]);
  const shiny = Math.random() < SHINY * luck;
  if (target !== undefined) {
    const aimed = missing.filter((c) => c.fromSlot === target);
    if (aimed.length) return { card: pick(aimed), shiny };
  }
  const have = pool.filter((c) => owned[c.key]);
  const chance = dry >= PITY ? 1 : NEW_CHANCE + NEW_STEP * dry + NEW_LUCK * (luck - 1);
  const source = missing.length && (!have.length || Math.random() < chance) ? missing : have;
  const present = KIND_ORDER.filter((k) => source.some((c) => c.kind === k));
  const kind = pickWeighted(present.map((k) => [k, KINDS[k].weight * (k === "progression" || k === "useful" ? luck : 1)]));
  return { card: pick(source.filter((c) => c.kind === kind)), shiny };
}

// Classeur d'une room : { at, dry, cards: { clé: { n, s (brillantes), name, game, to, from, fromSlot, place, kind, wish } } }.
// Les 5 rooms les plus récentes sont gardées (une grosse room fait vite un millier de cartes).
function withRoom(albums, code, room) {
  const rooms = { ...albums.rooms, [code]: room };
  return { rooms: Object.fromEntries(Object.entries(rooms).sort((a, b) => b[1].at - a[1].at).slice(0, 5)) };
}
const roomOf = (albums, code) => {
  const room = albums.rooms[code];
  return room && !Array.isArray(room.cards) ? room : { at: 0, dry: 0, cards: {} };
};

// Îles de la partie : cartes connues (checks faits) et au classeur, checks au total (tracker).
function islandsOf(current, pool, owned) {
  const totals = new Map((current.data.fixed?.player_locations_total || []).filter((e) => e.team === 0).map((e) => [e.player, e.total_locations]));
  return current.status.slots.map((s) => {
    const cards = pool.filter((c) => c.fromSlot === s.slot);
    const stars = cards.filter((c) => c.kind === "progression");
    const have = cards.filter((c) => owned[c.key]).length;
    return {
      slot: s.slot, name: s.name, game: s.game, total: Math.max(totals.get(s.slot) || 0, cards.length), known: cards.length,
      have, missing: cards.length - have, starSet: stars.length > 0 && stars.every((c) => owned[c.key]),
    };
  }).filter((i) => i.total > 0);
}

// Sauvegarde dans le navigateur, avec mises à jour successives (plusieurs prises dans la même seconde).
function useStored(key, initial) {
  const [value, setValue] = useState(() => {
    try { return { ...initial, ...JSON.parse(localStorage.getItem(key)) }; } catch { return initial; }
  });
  const update = (change) => setValue((previous) => {
    const next = change(previous);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* stockage indisponible ou plein */ }
    return next;
  });
  return [value, update];
}

function useReducedMotion() {
  const query = useMemo(() => matchMedia("(prefers-reduced-motion: reduce)"), []);
  const [reduced, setReduced] = useState(query.matches);
  useEffect(() => {
    const change = () => setReduced(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return reduced;
}

// Zone de pêche : la mer visible, hors du menu, du tableau de bord et des boutons du bas.
function playArea() {
  const side = document.querySelector(".site-side")?.getBoundingClientRect();
  const hud = document.querySelector(".fishing-hud")?.getBoundingClientRect();
  const bar = document.querySelector(".fishing-actions")?.getBoundingClientRect();
  let x0 = 0, y0 = 0;
  if (side && side.height > innerHeight * 0.6) x0 = side.right;
  else if (side) y0 = side.bottom;
  if (hud) y0 = Math.max(y0, hud.bottom);
  const y1 = bar?.height ? bar.top : innerHeight;
  return { x0, y0: y0 + 12, x1: innerWidth, y1: Math.max(y0 + 140, y1 - 12) };
}

// --- La mer, la ligne et ce qui y passe (canvas) ------------------------------------------------
const FRAME = 1000 / 30;
const CAST_MS = 320; // vol du bouchon
const SHY_RADIUS = 75; // un poisson méfiant fuit un bouchon tombé plus près
const isDarkTheme = () => {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
};

// `hooks` : area(), nextCard() (carte que portera un nouveau poisson : { card, shiny, treasure }, ou null),
// line(état : none, flying, waiting, nibble, bite, reel), lost(poisson au trésor parti sans être pêché), event(type,
// espèce) (bite, late, fled), night(vrai ou faux), reel(clics restants pour remonter le poisson), caught(poisson arrivé
// au compteur), scoreAt() (où il saute : le compteur du catalogue).
// La pêche se voit et se sent : canne qui plie, gerbes d'eau, bouchon arraché sous l'eau, petite secousse à la touche,
// poisson tiré le long du fil en se débattant avec son sillage, puis qui saute jusqu'au compteur.
// Mouvement réduit : rien ne nage ; les poissons apparaissent puis s'effacent sur place, un poisson attiré
// apparaît près du bouchon, le bouchon ne plonge pas (son état est écrit).
// Couleur des paillettes selon la carte (en plus du symbole et du mot, jamais seules à porter l'information).
const GLINT = { progression: "255, 209, 102", useful: "158, 198, 232", filler: "255, 243, 207", trap: "150, 214, 110", wish: "255, 158, 199" };

function createPond(canvas, hooks) {
  const ctx = canvas.getContext("2d");
  let w = 0, h = 0, dpr = 1, area = { x0: 0, y0: 0, x1: 0, y1: 0 };
  let reduced = false, raf = 0, last = 0, lastFrame = 0, dark = isDarkTheme();
  let items = [], effects = [], nextFish = 0, scaredUntil = 0;
  let line = null; // { x, y, fromX, fromY, t0, state, fish, nibbles, nextAt, dipUntil, until }
  const aim = { x: 0, y: 0, shown: false };
  let particles = []; // gouttes et écume : { x, y, vx, vy, start, life, r, foam }
  let shakeUntil = 0, shakePower = 0, bend = 0; // secousse de la mer ; canne qui plie (0 à 1)
  // Paillettes : étoiles qui scintillent ({ x, y, vx, vy, start, life, size, color, rainbow, spin }) ; ondes de choc
  // ({ x, y, start, life, r0, r1, color, width }) ; éclair bref sur la mer ; arrêt sur image à l'impact ; effets différés.
  let glints = [], rings = [], later = [];
  let flash = { until: 0, start: 0, color: "255, 236, 180", power: 0 };
  let freezeUntil = 0;
  // Décor (île, traversée, courants) et effets de bords d'écran : teintes durables et éclats ({ color, power, start, life }).
  const scene = createScene();
  let pulses = [], luck = 1, alertOn = false;
  let frenzyUntil = 0; // banc en cours
  const clock0 = performance.now();
  let night = false;

  function layout() {
    dpr = Math.min(1.5, devicePixelRatio || 1);
    w = innerWidth; h = innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    area = hooks.area();
    scene.resize(area, w, h, dpr);
    if (!aim.shown) { aim.x = (area.x0 + area.x1) / 2; aim.y = (area.y0 + area.y1) / 2; }
    clampAim();
  }
  const right = () => area.x1 - scene.cut(); // bord droit de la mer où l'on pêche (l'île prend le reste)
  const inside = (x, y, margin = 0) => x >= area.x0 - margin && x <= right() + margin && y >= area.y0 - margin && y <= area.y1 + margin;
  const between = (a, b, margin) => a + margin + Math.random() * Math.max(1, b - a - 2 * margin);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function clampAim() {
    aim.x = clamp(aim.x, area.x0 + 12, right() - 12);
    aim.y = clamp(aim.y, area.y0 + 12, area.y1 - 12);
  }
  // La canne est tenue en bas à droite de la mer ; le fil part de son scion, qui plie vers ce qui tire.
  const rodBase = () => ({ x: area.x1 + 12, y: h + 40 });
  const rodRest = () => ({ x: area.x1 - 90, y: area.y1 - 34 });
  function rod() {
    const rest = rodRest();
    if (!line || bend < 0.01) return rest;
    const dx = line.x - rest.x, dy = line.y - rest.y, d = Math.hypot(dx, dy) || 1;
    return { x: rest.x + (dx / d) * bend * 28, y: rest.y + (dy / d) * bend * 28 };
  }
  const setLine = (next) => { line = next; hooks.line(next ? next.state : "none"); };

  // Un poisson et sa carte : de l'un des bords (une raie apparaît n'importe où, sous le sable).
  function spawn(content, t) {
    const data = speciesFor(content.card, night);
    const fromLeft = Math.random() < 0.5;
    const item = { kind: "fish", data, card: content.card, shiny: content.shiny, treasure: content.treasure, t0: t,
      phase: Math.random() * 6, alpha: 0, y: between(area.y0, area.y1, 30), dir: fromLeft ? 1 : -1, mode: "cruise" };
    if (reduced) Object.assign(item, { x: between(area.x0, right(), 50), vx: 0, life: 9000 + Math.random() * 6000 });
    else {
      Object.assign(item, { x: fromLeft ? area.x0 - 40 : right() + 40, vx: item.dir * data.speed * (0.8 + Math.random() * 0.4), life: Infinity });
      if (data.trait === "hidden") Object.assign(item, { x: between(area.x0, right(), 60), vx: item.dir * data.speed * 0.3 });
    }
    items.push(item);
  }
  // Un poisson qui quitte la mer sans être pêché ; celui d'une carte au trésor reviendra.
  function gone(item) {
    if (item.treasure) hooks.lost(item);
    return false;
  }

  function flee(fish, fromX, fromY) {
    if (!fish) return;
    fish.mode = "flee";
    fish.fromX = fromX ?? fish.x - fish.dir;
    fish.fromY = fromY ?? fish.y;
    fish.fleeAt = performance.now();
  }

  // Gerbe d'eau : un rond, et des gouttes qui jaillissent puis retombent (sans gouttes si le mouvement est réduit).
  function splash(x, y, n, power = 1) {
    const t = performance.now();
    effects.push({ x, y, start: t });
    if (reduced) return;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, v = (50 + Math.random() * 110) * power;
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.6 - 60 * power, start: t, life: 380 + Math.random() * 320, r: 1.4 + Math.random() * 2.2 });
    }
  }
  function shake(ms, power) {
    if (reduced) return;
    shakeUntil = performance.now() + ms;
    shakePower = power;
  }
  // Gerbe de paillettes, de la couleur de la carte (arc-en-ciel si elle est brillante). Rien si le mouvement est réduit.
  function sparkle(x, y, n, { color = GLINT.filler, rainbow = false, speed = 1, size = 1, up = 0, life = 1 } = {}) {
    if (reduced) return;
    const t = performance.now();
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, v = (40 + Math.random() * 170) * speed;
      glints.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - up, start: t, life: (500 + Math.random() * 500) * life,
        size: (4 + Math.random() * 5) * size, color, rainbow, hue: Math.random() * 360, spin: Math.random() * Math.PI });
    }
  }
  function ring(x, y, { color = "255, 255, 255", r0 = 6, r1 = 60, life = 420, width = 4 } = {}) {
    if (reduced) return;
    rings.push({ x, y, start: performance.now(), life, r0, r1, color, width });
  }
  function flashSea(power, color = "255, 236, 180") {
    if (reduced) return;
    const t = performance.now();
    flash = { start: t, until: t + 260, color, power };
  }
  const freeze = (ms) => { if (!reduced) freezeUntil = performance.now() + ms; };
  const pulse = (color, power, life = 600) => { if (!reduced) pulses.push({ color, power, life, start: performance.now() }); };
  const glintOf = (f) => (f.card.wish ? GLINT.wish : GLINT[f.card.kind] || GLINT.filler);

  function land(t) {
    splash(line.x, line.y, 10, 0.9);
    let scared = false;
    for (const fish of items) {
      if (fish.kind === "fish" && fish.data.trait === "shy" && fish.mode === "cruise" && Math.hypot(fish.x - line.x, fish.y - line.y) < SHY_RADIUS) {
        flee(fish, line.x, line.y);
        scared = true;
      }
    }
    line.state = "waiting";
    line.t0 = t;
    setLine(line);
    if (scared) hooks.event("fled");
  }

  // Un poisson remarque le bouchon : le plus proche parmi ceux qui le voient (et osent venir).
  function attract(t) {
    const age = t - line.t0;
    let best = null, bestDistance = Infinity;
    for (const fish of items) {
      if (fish.kind !== "fish" || fish.mode !== "cruise" || fish.alpha < 0.5) continue;
      const sp = fish.data, distance = Math.hypot(fish.x - line.x, fish.y - line.y);
      // L'appât finit par attirer de plus loin quand personne ne vient (et de très loin pendant une frénésie).
      const lure = t < frenzyUntil ? 2.2 : age > 1800 ? 2.5 : 1;
      const reach = sp.notice * lure;
      if (distance > reach || (sp.trait === "shy" && age < 900 && t >= frenzyUntil)) continue;
      if (distance < bestDistance) { best = fish; bestDistance = distance; }
    }
    if (!best) return;
    best.mode = "approach";
    // Côté du bouchon où il viendra, fixé une fois pour toutes (sinon, arrivé juste au-dessus du bouchon, il change de
    // côté à chaque image et fait des allers-retours sans jamais l'atteindre).
    best.side = best.x <= line.x ? 1 : -1;
    best.arriveAt = t + 500 + Math.random() * 400; // mouvement réduit : il apparaît au bouchon
    line.fish = best;
  }

  function update(dt, t) {
    const wasNight = night;
    night = (t - clock0) % (DAY_MS + NIGHT_MS) >= DAY_MS;
    if (night !== wasNight) hooks.night(night);
    const scared = t < scaredUntil;
    const frenzy = t < frenzyUntil;
    const moved = scene.update(dt, t, reduced);
    if (moved.dx) for (const i of items) if (i.mode !== "jump") { i.x -= moved.dx; if (i.fromX != null) i.fromX -= moved.dx; }
    if (moved.arrived) { nextFish = t + 300; hooks.arrived(moved.arrived.island); }
    pulses = pulses.filter((p) => t - p.start < p.life);
    const fishCount = items.filter((i) => i.mode !== "flee").length;
    if (!scene.traveling() && !scared && fishCount < MAX_FISH + (frenzy ? 6 : 0) && t >= nextFish) {
      const content = hooks.nextCard();
      if (content) spawn(content, t);
      nextFish = t + (frenzy ? 250 : 900) * (0.6 + Math.random() * 0.8);
    }

    // La canne plie quand ça tire, puis se redresse.
    const wantBend = line?.state === "reel" ? 0.55 + 0.35 * Math.abs(Math.sin(t / 90)) * (line.reel.taps > 0 ? 1 : 0.4)
      : line?.state === "bite" ? 0.45 : line?.state === "nibble" && t < line.dipUntil ? 0.15 : 0;
    bend += (wantBend - bend) * Math.min(1, dt * 10);
    // La ligne : vol du bouchon, attente, touches, morsure.
    if (line) {
      if (line.state === "flying" && t - line.t0 >= CAST_MS) land(t);
      if (line?.state === "waiting") {
        if (line.fish && line.fish.mode !== "approach") line.fish = null;
        if (scared && line.fish) { flee(line.fish, line.x, line.y); line.fish = null; }
        if (!line.fish && !scared) attract(t);
      }
      if (line?.state === "nibble" && t >= line.nextAt) {
        line.nibbles -= 1;
        if (line.nibbles > 0) {
          line.dipUntil = t + 200;
          line.nextAt = t + 280 + Math.random() * 220;
          splash(line.x, line.y, 3, 0.4);
        } else bite(t);
      }
      if (line?.state === "reel") updateReel(dt, t);
      if (line?.state === "bite" && t > line.until) {
        const fish = line.fish;
        splash(line.x, line.y, 8, 0.8);
        flee(fish, line.x, line.y);
        setLine(null);
        pulse("90, 100, 120", 0.35, 650); // raté : les bords se ternissent
        hooks.event("late", fish.data);
      }
    }

    items = items.filter((i) => {
      const age = t - i.t0;
      if (i.mode === "jump") return flyToScore(i, t);
      if (i.mode === "reel") return true; // tiré par la ligne (updateReel)
      if (i.mode === "flee") {
        i.alpha = Math.max(0, i.alpha - dt * (reduced ? 2.5 : 0.6));
        if (reduced) return i.alpha > 0 || gone(i);
        const dx = i.x - i.fromX, dy = i.y - i.fromY, d = Math.hypot(dx, dy) || 1;
        const speed = Math.max(220, i.data.speed * 3);
        i.x += (dx / d) * speed * dt; i.y += (dy / d) * speed * dt * 0.4;
        i.dir = dx < 0 ? -1 : 1;
        return (i.alpha > 0 && inside(i.x, i.y, 80)) || gone(i);
      }
      if (scared && i.mode === "cruise") { flee(i); return true; }
      i.alpha = Math.min(1, age / 400);
      // Une carte précieuse se devine : de petites étoiles s'échappent du poisson (souvent s'il est brillant).
      const precious = i.shiny ? 0.12 : i.treasure || i.card.wish || i.card.kind === "progression" ? 0.05 : 0;
      if (!reduced && precious && i.alpha > 0.5 && !(i.data.trait === "hidden" && i.mode === "cruise") && Math.random() < precious) {
        glints.push({ x: i.x + (Math.random() - 0.5) * i.data.size * 1.6, y: i.y + (Math.random() - 0.5) * i.data.size,
          vx: 0, vy: -18, start: t, life: 600, size: 2.5 + Math.random() * 2.5, color: glintOf(i), rainbow: i.shiny,
          hue: Math.random() * 360, spin: Math.random() * Math.PI });
      }
      if (i.mode === "approach" && line?.fish === i) {
        // Sa place : à côté du bouchon, tête vers lui.
        const tx = line.x - i.side * i.data.size * 0.9, ty = line.y;
        if (reduced) {
          if (t >= i.arriveAt) { i.dir = i.side; i.x = tx; i.y = ty; arrive(t); }
        } else {
          const dx = tx - i.x, dy = ty - i.y, d = Math.hypot(dx, dy);
          const speed = Math.max(170, i.data.speed * 2.4) * (i.data.trait === "fast" ? 1.3 : 1); // il fonce sur l'appât
          const step = speed * dt;
          if (d <= step + 1) { i.x = tx; i.y = ty; i.dir = i.side; arrive(t); }
          else { i.x += (dx / d) * step; i.y += (dy / d) * step; i.dir = Math.abs(dx) > 6 ? Math.sign(dx) : i.side; }
        }
        return true;
      }
      if (line?.fish === i) return true; // au bouchon : il grignote ou mord
      if (i.mode === "approach") { i.mode = "cruise"; i.dir = i.vx < 0 ? -1 : 1; } // ligne ramenée
      let stays;
      if (reduced) {
        stays = age <= i.life;
        if (stays && age > i.life - 600) i.alpha = Math.max(0, (i.life - age) / 600);
      } else {
        i.x += i.vx * dt;
        stays = inside(i.x, i.y, 80);
      }
      return stays || gone(i);
    });
    particles = particles.filter((d) => {
      if (t - d.start > d.life) return false;
      d.x += d.vx * dt; d.y += d.vy * dt;
      if (!d.foam) d.vy += 220 * dt;
      return true;
    });
    glints = glints.filter((g) => {
      if (t - g.start > g.life) return false;
      if (t < g.start) return true; // pas encore apparue (pluie de paillettes)
      g.x += g.vx * dt; g.y += g.vy * dt;
      g.vx *= 1 - Math.min(1, dt * 2.6); g.vy = g.vy * (1 - Math.min(1, dt * 2.6)) + 60 * dt; // freinées, puis retombent
      return true;
    });
    later = later.filter((job) => (t >= job.at ? (job.run(), false) : true));
  }

  // Ferré : le poisson est tiré le long du fil vers la canne. Les petits viennent d'un coup ; les autres demandent
  // quelques clics, et tirent en arrière entre deux (sans pouvoir s'échapper).
  function startReel() {
    const fish = line.fish, rules = REEL[fish.data.id];
    const taps = rules ? rules.taps : 0;
    fish.mode = "reel";
    fish.angle = Math.atan2(rod().y - fish.y, rod().x - fish.x);
    line.state = "reel";
    line.reel = { sx: fish.x, sy: fish.y, progress: 0, target: taps ? 0.12 : 1, floor: 0, taps, step: taps ? 0.85 / taps : 0, nextFoam: 0 };
    splash(fish.x, fish.y, 12, 1);
    shake(120, 3.5);
    ring(fish.x, fish.y, { color: glintOf(fish), r1: 70, width: 5 });
    pulse("255, 255, 255", 0.22, 380);
    sparkle(fish.x, fish.y, 8, { color: glintOf(fish), rainbow: fish.shiny, speed: 0.8 });
    bend = 1;
    setLine(line);
    hooks.reel(taps);
  }
  function tap() {
    const r = line.reel;
    if (!r.taps) return 0;
    r.taps -= 1;
    r.target = r.taps ? Math.min(0.97, Math.max(r.target, r.progress) + r.step) : 1;
    r.floor = Math.max(0, r.target - r.step * 0.6); // il recule entre deux clics, mais jamais jusqu'au départ
    splash(line.fish.x, line.fish.y, 7, 0.8);
    shake(70, 2);
    ring(line.fish.x, line.fish.y, { color: glintOf(line.fish), r1: 38 + (r.taps ? 0 : 30), life: 300, width: 3 });
    sparkle(line.fish.x, line.fish.y, r.taps ? 4 : 12, { color: glintOf(line.fish), rainbow: line.fish.shiny, speed: 0.7 });
    if (!r.taps) { freeze(60); pulse(glintOf(line.fish), 0.35, 450); }
    bend = 1;
    hooks.reel(r.taps);
    return r.taps;
  }
  function updateReel(dt, t) {
    const r = line.reel, fish = line.fish, tip = rod();
    const rules = REEL[fish.data.id];
    // Mouvement réduit : il avance par bonds (un par clic), sans glisser ni reculer.
    if (r.taps > 0 && rules && !reduced) r.target = Math.max(r.floor, r.target - rules.back * dt);
    r.progress = reduced ? r.target : r.progress + (r.target - r.progress) * Math.min(1, dt * (r.taps > 0 ? 10 : 4.5));
    const ang = Math.atan2(tip.y - r.sy, tip.x - r.sx);
    const px = r.sx + (tip.x - r.sx) * r.progress, py = r.sy + (tip.y - r.sy) * r.progress;
    // Il se débat de part et d'autre du fil, tête vers la canne (plus fort tant qu'il reste des clics).
    const fierce = r.taps > 0 ? 1 : 0.45;
    const wob = reduced ? 0 : Math.sin(t / 65 + fish.phase) * fish.data.size * 0.8 * fierce * (1 - r.progress * 0.6);
    fish.x = px - Math.sin(ang) * wob;
    fish.y = py + Math.cos(ang) * wob;
    fish.angle = ang + (reduced ? 0 : Math.sin(t / 55 + fish.phase) * 0.45 * fierce);
    line.x = fish.x + Math.cos(fish.angle) * fish.data.size * 0.9;
    line.y = fish.y + Math.sin(fish.angle) * fish.data.size * 0.9;
    if (!reduced && t >= r.nextFoam) { // sillage d'écume derrière lui
      const back = fish.data.size * 1.1;
      particles.push({ x: fish.x - Math.cos(fish.angle) * back, y: fish.y - Math.sin(fish.angle) * back,
        vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30, start: t, life: 520, r: 2 + Math.random() * 2.2, foam: true });
      r.nextFoam = t + 45;
    }
    if (r.taps === 0 && r.progress > 0.95) jump(t);
  }
  // Arrivé à la canne : il saute hors de l'eau et file vers le compteur du catalogue (directement compté si le mouvement
  // est réduit).
  function jump(t) {
    const fish = line.fish;
    setLine(null);
    hooks.reel(0);
    if (reduced) {
      items = items.filter((i) => i !== fish);
      hooks.caught(fish);
      return;
    }
    splash(fish.x, fish.y, 16, 1.3);
    ring(fish.x, fish.y, { r1: 80, life: 480, width: 5 });
    sparkle(fish.x, fish.y, 10, { color: glintOf(fish), rainbow: fish.shiny, up: 120 });
    const to = hooks.scoreAt() || { x: area.x0 + 60, y: area.y0 - 20 };
    fish.mode = "jump";
    fish.jump = { t0: t, x0: fish.x, y0: fish.y, x1: to.x, y1: to.y, a0: fish.angle, spin: (Math.random() < 0.5 ? -1 : 1) * Math.PI * 2 };
  }
  function flyToScore(fish, t) {
    const j = fish.jump, p = Math.min(1, (t - j.t0) / JUMP_MS);
    if (p >= 1) {
      ring(j.x1, j.y1, { color: glintOf(fish), r1: 44, life: 360, width: 4 });
      sparkle(j.x1, j.y1, 10, { color: glintOf(fish), rainbow: fish.shiny, speed: 0.9, up: -40 });
      hooks.caught(fish);
      return false;
    }
    // Traînée de paillettes derrière lui (plus dense pour une carte précieuse).
    const rich = fish.shiny || fish.card.wish || fish.card.kind === "progression" ? 2 : 1;
    if (!reduced && Math.random() < 0.7 * rich) {
      glints.push({ x: fish.x + (Math.random() - 0.5) * 14, y: fish.y + (Math.random() - 0.5) * 14, vx: (Math.random() - 0.5) * 40,
        vy: 30 + Math.random() * 40, start: t, life: 450 + Math.random() * 300, size: 2.5 + Math.random() * 3 * rich,
        color: glintOf(fish), rainbow: fish.shiny, hue: Math.random() * 360, spin: Math.random() * Math.PI });
    }
    const e = 1 - (1 - p) * (1 - p);
    const cx = (j.x0 + j.x1) / 2, cy = Math.min(j.y0, j.y1) - 170;
    fish.x = (1 - e) * (1 - e) * j.x0 + 2 * (1 - e) * e * cx + e * e * j.x1;
    fish.y = (1 - e) * (1 - e) * j.y0 + 2 * (1 - e) * e * cy + e * e * j.y1;
    fish.angle = j.a0 + j.spin * e;
    fish.scale = 1 + Math.sin(p * Math.PI) * 0.9 - p * 0.5;
    fish.alpha = p > 0.8 ? (1 - p) / 0.2 : 1;
    return true;
  }

  // Arrivé au bouchon : une ou deux touches rapides (une seule pendant un banc), puis il mord.
  function arrive(t) {
    if (line.state !== "waiting") return;
    line.state = "nibble";
    line.nibbles = t < frenzyUntil ? 1 : 1 + Math.floor(Math.random() * 3);
    line.dipUntil = t + 200;
    line.nextAt = t + 220 + Math.random() * 200;
    splash(line.x, line.y, 4, 0.5);
    setLine(line);
  }
  // Ça mord : le bouchon est arraché sous l'eau.
  function bite(t) {
    line.state = "bite";
    line.biteAt = t;
    line.until = t + line.fish.data.window * (t < frenzyUntil ? 1.3 : 1);
    line.dipUntil = line.until;
    splash(line.x, line.y, 14, 1.1);
    shake(140, 3);
    ring(line.x, line.y, { r1: 46, life: 320, width: 3 });
    pulse("200, 240, 255", 0.4, 520);
    setLine(line);
    hooks.event("bite", line.fish.data);
  }

  // --- Dessin ---
  const outline = () => (dark || night ? "rgba(228, 240, 255, 0.7)" : "rgba(14, 30, 38, 0.65)");

  function drawFish(f, t) {
    const sp = f.data, s = sp.size;
    const still = reduced || f.mode !== "cruise";
    const pulled = f.mode === "reel" || f.mode === "jump";
    const bob = still ? 0 : Math.sin(t / 700 + f.phase) * 3;
    const wag = reduced ? 0 : Math.sin(t / (f.mode === "cruise" ? 110 : pulled ? 38 : 60) + f.phase) * (pulled ? 0.55 : 0.35);
    const lineColor = outline();
    if (f.mode === "jump") { // son ombre reste sur l'eau, de plus en plus pâle
      const p = Math.min(1, (t - f.jump.t0) / JUMP_MS);
      ctx.fillStyle = `rgba(0, 20, 30, ${0.25 * (1 - p)})`;
      ctx.beginPath(); ctx.ellipse(f.jump.x0, f.jump.y0, s * (1.1 - p * 0.5), s * (0.5 - p * 0.2), 0, 0, Math.PI * 2); ctx.fill();
    }
    // Raie cachée : seulement ses remous et une ombre, tant qu'elle ne vient pas au bouchon.
    if (sp.trait === "hidden" && f.mode === "cruise") {
      ctx.save();
      ctx.globalAlpha = f.alpha;
      ctx.fillStyle = "rgba(0, 20, 30, 0.22)";
      ctx.beginPath(); ctx.ellipse(f.x, f.y, s * 0.9, s * 0.55, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = dark || night ? "rgba(220, 235, 255, 0.55)" : "rgba(255, 255, 255, 0.75)"; ctx.lineWidth = 1.5;
      const p = reduced ? 0.5 : (t / 1400 + f.phase) % 1;
      for (const k of [0, 0.5]) {
        const q = (p + k) % 1;
        ctx.globalAlpha = f.alpha * (1 - q);
        ctx.beginPath(); ctx.ellipse(f.x, f.y, s * (0.5 + q * 0.9), s * (0.3 + q * 0.5), 0, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
      if (f.treasure) { ctx.strokeStyle = "rgba(242, 194, 91, 0.8)"; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(f.x, f.y, s * 1.6, s * 0.95, 0, 0, Math.PI * 2); ctx.stroke(); }
      return;
    }
    ctx.save();
    ctx.globalAlpha = f.alpha;
    ctx.translate(f.x, f.y + bob);
    if (pulled) ctx.rotate(f.angle); else ctx.scale(f.dir, 1);
    if (f.mode === "jump") ctx.scale(f.scale, f.scale);
    else {
      ctx.fillStyle = "rgba(0, 20, 30, 0.2)";
      ctx.beginPath(); ctx.ellipse(4, 5, s * 1.05, s * 0.45, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = sp.color; ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5;
    if (sp.shape === "ray") {
      ctx.beginPath(); ctx.moveTo(s, 0); ctx.quadraticCurveTo(0, -s * 1.1, -s * 0.6, 0); ctx.quadraticCurveTo(0, s * 1.1, s, 0);
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s * 0.6, 0); ctx.quadraticCurveTo(-s * 1.2, wag * s * 0.5, -s * 1.7, wag * s); ctx.stroke();
    } else if (sp.shape === "squid") {
      ctx.lineWidth = 3; ctx.strokeStyle = sp.color;
      for (const k of [-1.5, -0.5, 0.5, 1.5]) {
        ctx.beginPath(); ctx.moveTo(-s * 0.1, k * s * 0.18);
        ctx.quadraticCurveTo(-s * 0.7, k * s * 0.3 + wag * s * 0.4, -s * 1.3, k * s * 0.42 - wag * s * 0.3); ctx.stroke();
      }
      ctx.lineWidth = 1.5; ctx.strokeStyle = lineColor;
      ctx.beginPath(); ctx.ellipse(s * 0.25, 0, s * 0.6, s * 0.48, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(-s * 0.75, 0); ctx.lineTo(-s * 1.3, -s * 0.45 + wag * s * 0.3); ctx.lineTo(-s * 1.12, wag * s * 0.3);
      ctx.lineTo(-s * 1.3, s * 0.45 + wag * s * 0.3); ctx.closePath(); ctx.fill(); ctx.stroke();
      const wide = sp.shape === "round" || sp.shape === "lantern";
      const ry = sp.shape === "sword" ? 0.28 : wide ? 0.55 : 0.34;
      ctx.beginPath(); ctx.ellipse(0, 0, s * (wide ? 0.85 : 1), s * ry, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (sp.shape === "sword") {
        ctx.strokeStyle = sp.color; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(s * 0.95, 0); ctx.lineTo(s * 1.8, 0); ctx.stroke();
      }
      ctx.strokeStyle = "rgba(0, 0, 0, 0.2)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(s * 0.3, 0); ctx.lineTo(-s * 0.5, 0); ctx.stroke();
      if (sp.shape === "lantern") {
        ctx.strokeStyle = lineColor; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(s * 0.6, 0); ctx.quadraticCurveTo(s * 1.05, -s * 0.35, s * 1.3, 0); ctx.stroke();
        const glow = ctx.createRadialGradient(s * 1.3, 0, 0, s * 1.3, 0, s * 0.8);
        glow.addColorStop(0, "rgba(255, 226, 140, 0.9)"); glow.addColorStop(1, "rgba(255, 226, 140, 0)");
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(s * 1.3, 0, s * 0.8, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.fillStyle = "#101418";
    const er = Math.max(1.4, s * 0.08);
    for (const ey of [-s * 0.16, s * 0.16]) { ctx.beginPath(); ctx.arc(s * 0.55, ey, er, 0, Math.PI * 2); ctx.fill(); }
    if (f.shiny || sp.kind === "wish") { // carte brillante (ou poisson doré) : une étincelle
      const r = 2 + 4 * (reduced ? 1 : 0.5 + 0.5 * Math.sin(t / 250 + f.phase));
      ctx.fillStyle = "#fff6c8"; ctx.strokeStyle = "rgba(90, 60, 0, 0.6)"; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let p = 0; p < 8; p++) {
        const a = (p / 8) * Math.PI * 2, rr = p % 2 ? r * 0.35 : r;
        ctx.lineTo(Math.cos(a) * rr, -s * 0.95 + Math.sin(a) * rr);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    // Ce qu'il porte : étiquette de la rareté (symbole, pas la couleur seule), sauf objet ordinaire ; halo d'une carte
    // au trésor. Pas d'étiquette pendant le saut.
    if (f.mode === "jump") return;
    const tag = f.card.wish ? WISH : f.card.kind !== "filler" ? KINDS[f.card.kind] : null;
    const tx = f.x, ty = f.y + bob - s * 0.9 - 14;
    if (f.treasure) {
      ctx.strokeStyle = `rgba(242, 194, 91, ${reduced ? 0.8 : 0.5 + 0.3 * Math.sin(t / 200)})`; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(f.x, f.y + bob, s * 1.6, s * 0.95, 0, 0, Math.PI * 2); ctx.stroke();
    }
    if (!tag || (sp.trait === "hidden" && f.mode === "cruise" && !f.treasure)) return;
    ctx.globalAlpha = f.alpha;
    ctx.fillStyle = tag.tag; ctx.strokeStyle = "rgba(20, 14, 6, 0.8)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(tx, ty, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#24170a"; ctx.font = "700 12px Lexend, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(tag.mark, tx, ty + 0.5);
    ctx.globalAlpha = 1;
  }

  function drawLine(t) {
    if (!line) return;
    const from = rod();
    let x = line.x, y = line.y;
    if (line.state === "flying") {
      const p = Math.min(1, (t - line.t0) / CAST_MS);
      x = line.fromX + (line.x - line.fromX) * p;
      y = line.fromY + (line.y - line.fromY) * p - Math.sin(p * Math.PI) * 60;
    }
    // Remontée : le fil est tendu (il vibre), le bouchon suit la gueule du poisson.
    if (line.state === "reel") {
      const jitter = reduced ? 0 : Math.sin(t / 28) * 2.5;
      const mx = (from.x + x) / 2, my = (from.y + y) / 2, a = Math.atan2(y - from.y, x - from.x);
      ctx.strokeStyle = dark || night ? "rgba(240, 245, 255, 0.9)" : "rgba(25, 25, 25, 0.8)"; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(mx - Math.sin(a) * jitter, my + Math.cos(a) * jitter, x, y); ctx.stroke();
      drawBobber(x, y, true);
      return;
    }
    ctx.strokeStyle = dark || night ? "rgba(235, 240, 250, 0.6)" : "rgba(30, 30, 30, 0.55)"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo((from.x + x) / 2, Math.min(from.y, y) - 40, x, y); ctx.stroke();
    if (line.state === "flying") { drawBobber(x, y, false); return; }
    const dipping = t < (line.dipUntil || 0);
    const biting = line.state === "bite";
    // Ronds dans l'eau autour du bouchon qui touche ou plonge.
    if (dipping || biting) {
      const p = reduced ? 0.4 : ((t - line.t0) / 600) % 1;
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 - p * 0.6})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(x, y, 9 + p * 16, 5 + p * 8, 0, 0, Math.PI * 2); ctx.stroke();
    }
    const sink = reduced ? 0 : biting ? 5 : dipping ? 2 : Math.sin(t / 600) * 1;
    if (biting) { // bouchon arraché sous l'eau : à peine visible, des bulles autour
      ctx.globalAlpha = 0.55;
      drawBobber(x, y + sink, true);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
      for (let k = 0; k < 5; k++) {
        const a = k * 1.3 + (reduced ? 0 : t / 300), rr = 10 + (k % 3) * 4;
        ctx.beginPath(); ctx.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.6, 1.6 + (k % 2), 0, Math.PI * 2); ctx.fill();
      }
      // « ! » qui jaillit (plus grand un instant, sauf mouvement réduit).
      const p = Math.min(1, (t - (line.biteAt || t)) / 220);
      const size = reduced ? 22 : 22 * (1 + 0.6 * Math.sin(p * Math.PI));
      ctx.font = `800 ${Math.round(size)}px Lexend, system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.lineWidth = 5; ctx.strokeStyle = "rgba(20, 14, 6, 0.9)"; ctx.strokeText("!", x, y - 28);
      ctx.fillStyle = "#fff3cf"; ctx.fillText("!", x, y - 28);
    } else drawBobber(x, y + sink, dipping);
  }

  // La canne, en bas à droite : manche sombre, scion clair qui plie vers ce qui tire.
  function drawRod() {
    const base = rodBase(), tip = rod(), rest = rodRest();
    const mx = (base.x + tip.x) / 2, my = (base.y + tip.y) / 2;
    const cx = mx + (tip.x - rest.x) * 0.9 - bend * 10, cy = my + (tip.y - rest.y) * 0.9 + bend * 6;
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(20, 14, 6, 0.85)"; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.quadraticCurveTo(cx, cy, tip.x, tip.y); ctx.stroke();
    ctx.strokeStyle = "#8a5a30"; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.quadraticCurveTo(cx, cy, tip.x, tip.y); ctx.stroke();
    ctx.strokeStyle = "#3b2a1a"; ctx.lineWidth = 9; // manche
    ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(base.x + (cx - base.x) * 0.45, base.y + (cy - base.y) * 0.45); ctx.stroke();
    ctx.fillStyle = "#e9e2cf"; ctx.strokeStyle = "rgba(20, 14, 6, 0.85)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(tip.x, tip.y, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.lineCap = "butt";
  }

  function drawParticles(t) {
    for (const d of particles) {
      const k = 1 - (t - d.start) / d.life;
      ctx.fillStyle = d.foam ? `rgba(255, 255, 255, ${0.55 * k})` : `rgba(235, 248, 255, ${0.9 * k})`;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r * (d.foam ? 1 + (1 - k) : 1), 0, Math.PI * 2); ctx.fill();
    }
  }

  // Étoile à quatre branches, qui scintille et s'éteint ; les ondes de choc s'élargissent en s'amincissant.
  function drawGlints(t) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const g of glints) {
      if (t < g.start) continue;
      // L'horodatage de l'image peut précéder de peu la création de la paillette : on borne.
      const k = Math.min(1, Math.max(0, (t - g.start) / g.life)), a = (1 - k) * (0.65 + 0.35 * Math.sin(t / 60 + g.spin * 9));
      const r = Math.max(0.1, g.size * (k < 0.1 ? k / 0.1 : 1 - k * 0.35));
      const tint = (alpha) => (g.rainbow ? `hsla(${(g.hue + t / 4) % 360}, 95%, 72%, ${alpha})` : `rgba(${g.color}, ${alpha})`);
      ctx.save(); ctx.translate(g.x, g.y);
      ctx.fillStyle = tint(a * 0.22); // halo
      ctx.beginPath(); ctx.arc(0, 0, r * 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = tint(a);
      ctx.rotate(g.spin + k * 1.5);
      ctx.beginPath();
      ctx.moveTo(0, -r * 2); ctx.quadraticCurveTo(0, 0, r * 2, 0); ctx.quadraticCurveTo(0, 0, 0, r * 2);
      ctx.quadraticCurveTo(0, 0, -r * 2, 0); ctx.quadraticCurveTo(0, 0, 0, -r * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255, 255, 255, ${a})`;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
  function drawRings(t) {
    rings = rings.filter((o) => {
      const k = Math.max(0, (t - o.start) / o.life);
      if (k >= 1) return false;
      const e = 1 - (1 - k) ** 3;
      ctx.strokeStyle = `rgba(${o.color}, ${0.9 * (1 - k)})`; ctx.lineWidth = Math.max(0.5, o.width * (1 - k));
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r0 + (o.r1 - o.r0) * e, 0, Math.PI * 2); ctx.stroke();
      return true;
    });
  }

  // Bords d'écran selon ce qui se passe (toujours avec un message écrit à côté) : nuit, banc, carte maudite, combo,
  // objet arrivé pour vos joueurs, traversée, morsure, remontée qui tire, puis les éclats du moment.
  function edgeLayers(t) {
    const wave = (ms, lo = 0.6) => (reduced ? 1 : lo + (1 - lo) * (0.5 + 0.5 * Math.sin(t / ms)));
    const layers = [];
    if (night || dark) layers.push({ color: "4, 10, 32", alpha: night ? 0.45 : 0.25, size: 0.3 });
    if (t < frenzyUntil) layers.push({ color: GLINT.progression, alpha: 0.4 * wave(160), size: 0.2 });
    if (t < scaredUntil) layers.push({ color: "120, 60, 140", alpha: 0.45 * wave(420), size: 0.26 }, { color: GLINT.trap, alpha: 0.25 * wave(300), size: 0.12 });
    if (luck > 1.01) layers.push({ color: "255, 170, 60", alpha: Math.min(0.32, (luck - 1) * 0.32) * wave(500, 0.75), size: 0.14 });
    if (alertOn) layers.push({ color: GLINT.wish, alpha: 0.35 * wave(350, 0.4), size: 0.18 });
    if (scene.traveling()) layers.push({ color: "8, 24, 48", alpha: 0.4 * Math.min(1, scene.speed() / 700), size: 0.22 });
    if (line?.state === "bite") layers.push({ color: "200, 240, 255", alpha: 0.3 * wave(70, 0.3), size: 0.12 });
    if (line?.state === "reel" && line.reel.taps > 0) layers.push({ color: "230, 90, 50", alpha: 0.12 + 0.22 * bend, size: 0.15 });
    for (const p of pulses) {
      const k = Math.max(0, (t - p.start) / p.life);
      layers.push({ color: p.color, alpha: p.power * (1 - k) * (1 - k), size: 0.12 + 0.12 * k });
    }
    return layers;
  }

  function drawBobber(x, y, under) {
    ctx.save();
    ctx.translate(x, y);
    const r = under ? 5 : 7;
    ctx.fillStyle = "#fbf4e2"; ctx.strokeStyle = "rgba(20, 14, 6, 0.85)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#c8432c";
    ctx.beginPath(); ctx.arc(0, 0, r, Math.PI, Math.PI * 2); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  function drawAim() {
    if (!aim.shown || line) return;
    ctx.strokeStyle = "rgba(20, 14, 6, 0.8)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(aim.x, aim.y, 14, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#fff8e8"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(aim.x, aim.y, 14, 0, Math.PI * 2);
    ctx.moveTo(aim.x - 20, aim.y); ctx.lineTo(aim.x - 8, aim.y); ctx.moveTo(aim.x + 8, aim.y); ctx.lineTo(aim.x + 20, aim.y);
    ctx.moveTo(aim.x, aim.y - 20); ctx.lineTo(aim.x, aim.y - 8); ctx.moveTo(aim.x, aim.y + 8); ctx.lineTo(aim.x, aim.y + 20);
    ctx.stroke();
  }

  function draw(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    scene.drawBack(ctx, t, { dark, night, reduced });
    if (t < frenzyUntil) { // banc : la mer se dore, un cadre doré qui pulse (fixe si le mouvement est réduit)
      const pulse = reduced ? 0.6 : 0.5 + 0.3 * Math.sin(t / 180);
      ctx.fillStyle = `rgba(255, 196, 70, ${0.1 * pulse})`;
      ctx.fillRect(area.x0, 0, area.x1 - area.x0, h);
      ctx.strokeStyle = `rgba(242, 194, 91, ${0.75 * pulse})`; ctx.lineWidth = 6;
      ctx.strokeRect(area.x0 + 3, area.y0 + 3, area.x1 - area.x0 - 6, area.y1 - area.y0 - 6);
    }
    if (night) { // nuit du jeu : la mer s'assombrit (le reste de la page ne change pas)
      ctx.fillStyle = "rgba(4, 10, 32, 0.38)";
      ctx.fillRect(area.x0, 0, area.x1 - area.x0, h);
    }
    // Petite secousse à la touche et à chaque coup de moulinet (jamais si le mouvement est réduit).
    ctx.save();
    if (t < shakeUntil) ctx.translate((Math.random() - 0.5) * 2 * shakePower, (Math.random() - 0.5) * 2 * shakePower);
    for (const item of items) if (item.mode !== "jump") drawFish(item, t);
    drawLine(t);
    drawRod();
    drawAim();
    drawParticles(t);
    drawRings(t);
    for (const item of items) if (item.mode === "jump") drawFish(item, t); // le poisson qui saute passe par-dessus tout
    drawGlints(t);
    ctx.restore();
    if (t < flash.until) { // éclair bref et doux sur la mer (jamais si le mouvement est réduit)
      const k = Math.max(0, (t - flash.start) / (flash.until - flash.start));
      ctx.fillStyle = `rgba(${flash.color}, ${flash.power * (1 - k) * (1 - k)})`;
      ctx.fillRect(area.x0, 0, area.x1 - area.x0, h);
    }
    scene.drawFront(ctx, t, { reduced });
    drawEdges(ctx, w, h, edgeLayers(t));
    effects = effects.filter((e) => {
      const p = (t - e.start) / (e.text ? 900 : 700);
      if (p >= 1) return false;
      if (e.text) {
        const y = e.y - (reduced ? 0 : p * 28);
        ctx.globalAlpha = 1 - p * p;
        ctx.font = `${e.gold ? "800 24px" : "700 18px"} Lexend, system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.lineWidth = 4; ctx.strokeStyle = "rgba(20, 14, 6, 0.85)"; ctx.strokeText(e.text, e.x, y);
        ctx.fillStyle = e.gold ? "#ffd166" : "#fff3cf"; ctx.fillText(e.text, e.x, y);
        ctx.globalAlpha = 1;
      } else {
        const grow = reduced ? 0.5 : p;
        ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - p) * 0.9})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(e.x, e.y, 8 + grow * 30, 4 + grow * 16, 0, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(e.x, e.y, 3 + grow * 16, 2 + grow * 8, 0, 0, Math.PI * 2); ctx.stroke();
      }
      return true;
    });
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - lastFrame < FRAME) return;
    lastFrame = t;
    const dt = Math.min(0.1, (t - (last || t)) / 1000);
    last = t;
    dark = isDarkTheme();
    if (t >= freezeUntil) update(dt, t);
    draw(t);
  }

  return {
    layout,
    start() { cancelAnimationFrame(raf); last = 0; raf = requestAnimationFrame(loop); },
    stop() { cancelAnimationFrame(raf); },
    setReduced(on) { reduced = on; },
    isNight: () => night,
    // Lancer le bouchon (là où l'on vise) ; rien si la ligne est déjà dehors.
    cast(x = aim.x, y = aim.y) {
      if (line) return false;
      const from = rod(), t = performance.now();
      setLine({ x: clamp(x, area.x0 + 10, right() - 10), y: clamp(y, area.y0 + 10, area.y1 - 10), fromX: from.x, fromY: from.y, t0: t, state: "flying", fish: null });
      if (reduced) land(t);
      return true;
    },
    // Le geste : ferrer pendant la morsure (le poisson est remonté), un clic de plus pendant la remontée (coup de
    // moulinet), trop tôt pendant qu'il grignote (il fuit), sinon la ligne est ramenée.
    strike() {
      if (!line || line.state === "flying") return { type: "none" };
      const fish = line.fish;
      if (line.state === "reel") return { type: "yank", left: tap() };
      if (line.state === "bite") {
        const t = performance.now();
        const perfect = t - line.biteAt <= PERFECT * (line.until - line.biteAt);
        if (perfect) {
          effects.push({ x: line.x, y: line.y - 34, text: "Parfait !", gold: true, start: t });
          freeze(90); // arrêt sur image : le coup porte
          pulse(GLINT.progression, 0.5, 750);
          ring(line.x, line.y, { color: GLINT.progression, r1: 110, life: 520, width: 7 });
          sparkle(line.x, line.y, 22, { color: GLINT.progression, speed: 1.3, size: 1.2 });
          shake(160, 5);
        }
        startReel();
        return { type: "hooked", fish, taps: line.reel.taps, perfect };
      }
      if (line.state === "nibble") {
        splash(line.x, line.y, 6, 0.7);
        pulse("90, 100, 120", 0.35, 650);
        flee(fish, line.x, line.y);
        setLine(null);
        return { type: "early", fish };
      }
      if (fish) { fish.mode = "cruise"; fish.dir = fish.vx < 0 ? -1 : 1; }
      setLine(null);
      return { type: "retrieved" };
    },
    moveAim(dx, dy) { aim.shown = true; aim.x += dx; aim.y += dy; clampAim(); },
    showAim() { aim.shown = true; },
    float(x, y, text) { effects.push({ x, y, text, start: performance.now() }); },
    // Ce que vaut la prise, vu depuis la page : 0 double, 1 carte nouvelle, 2 événement (rare, brillante, palier, île).
    celebrate(level, card, shiny) {
      if (reduced || level < 1) return;
      const at = hooks.scoreAt() || { x: area.x0 + 60, y: area.y0 + 20 };
      const color = card.wish ? GLINT.wish : GLINT[card.kind] || GLINT.filler, t = performance.now();
      pulse(color, level >= 2 ? 0.75 : 0.4, level >= 2 ? 1500 : 800);
      ring(at.x, at.y, { color, r1: 90, life: 560, width: 6 });
      sparkle(at.x, at.y, 26, { color, rainbow: shiny, speed: 1.3, size: 1.2, up: -80 });
      if (level < 2) return;
      flashSea(0.22, shiny ? "220, 235, 255" : color);
      freeze(80);
      // Feu d'artifice : trois gerbes sur la mer, puis une pluie de paillettes.
      for (let k = 0; k < 3; k++) {
        later.push({ at: t + 140 + k * 170, run: () => {
          const x = between(area.x0, area.x1, 80), y = between(area.y0, (area.y0 + area.y1) / 2, 40);
          ring(x, y, { color, r1: 120, life: 620, width: 6 });
          sparkle(x, y, 30, { color, rainbow: shiny || k === 1, speed: 1.6, size: 1.3, life: 1.3 });
        } });
      }
      for (let k = 0; k < 40; k++) {
        glints.push({ x: between(area.x0, area.x1, 10), y: area.y0 - Math.random() * 120, vx: (Math.random() - 0.5) * 30,
          vy: 90 + Math.random() * 120, start: t + Math.random() * 500, life: 1400 + Math.random() * 600,
          size: 2.5 + Math.random() * 3.5, color, rainbow: shiny || Math.random() < 0.3, hue: Math.random() * 360, spin: Math.random() * Math.PI });
      }
    },
    scare(ms) { scaredUntil = performance.now() + ms; },
    spawnSoon() { nextFish = 0; },
    setLuck(value) { luck = value; },
    setAlert(on) { alertOn = on; },
    // Île où l'on pêche : sur place (ouverture), ou en traversée (la ligne est ramenée, les poissons restent derrière).
    place(island) { scene.place(island); },
    travel(island) {
      if (!scene.go(island, reduced)) return false;
      if (line) { if (line.fish && line.fish.mode !== "reel") line.fish.mode = "cruise"; else if (line.fish) flee(line.fish); setLine(null); hooks.reel(0); }
      return true;
    },
    isTraveling: () => scene.traveling(),
    banc(ms) { frenzyUntil = performance.now() + ms; nextFish = 0; },
  };
}

// --- Interface --------------------------------------------------------------------------------
const Tag = ({ card }) => {
  const tag = card.wish ? WISH : KINDS[card.kind];
  return html`<span class=${`fishing-tag ${card.wish ? "is-wish" : `kind-${card.kind}`}`} aria-hidden="true">${tag.mark}</span>`;
};
const kindText = (card) => `${KINDS[card.kind].label}${card.wish ? ` · dans la wishlist ${ofName(card.to)}` : ""}`;

// --- Cartes à collectionner ---
// Une carte a l'allure d'une carte à jouer : cadre selon la rareté (avec son symbole et son nom, pas la couleur seule),
// emblème aux initiales de l'objet sur un fond propre au jeu (teinte tirée de son nom), nom, destinataire.
const RARITY = { progression: "Rare", useful: "Utile", filler: "Commune", trap: "Maudite" };
const hueOf = (text) => [...String(text)].reduce((h, ch) => (h * 31 + ch.codePointAt(0)) % 360, 7);
function initials(name) {
  const words = String(name).replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2)).toUpperCase();
}
// Photos de la room ouverte (card-shots.js) : la carte d'un check photographié montre l'écran de celui qui l'a trouvé.
const photos = { code: null, set: new Set() };
const photoOf = (card) => (card.shot && photos.code && photos.set.has(card.shot) ? shotUrl(photos.code, card.shot) : null);
const Art = ({ card, big = false }) => {
  const src = photoOf(card);
  return html`<span class=${`tcard-art ${big ? "big" : ""} ${src ? "has-photo" : ""}`} style=${{ "--hue": hueOf(card.game) }} aria-hidden="true">
    ${src ? html`<img class="tcard-photo" src=${src} alt="" loading="lazy" decoding="async" />` : html`<span>${initials(card.name)}</span>`}</span>`;
};
const photoText = (card) => photoOf(card) && html`<p class="hint">📷 Photo prise par ${card.from} au moment de la trouvaille.</p>`;
const cardClass = (card, shiny) => `kind-${card.kind} ${card.wish ? "is-wish" : ""} ${shiny ? "shiny" : ""} ${card.n ? `tier-${tierOf(card.n)}` : ""}`;

// Carte du catalogue (au classeur) : un clic l'ouvre en grand.
function TradingCard({ card, onOpen }) {
  const label = `${card.name}, ${KINDS[card.kind].label}${card.wish ? ", wishlist" : ""}${card.s ? ", brillante" : ""}`
    + `${tierLabel(card.n) ? `, ${tierLabel(card.n).toLowerCase()}` : ""}${card.n > 1 ? `, ${card.n} exemplaires` : ""}`;
  return html`<button type="button" class=${`tcard ${cardClass(card, card.s)}`} onClick=${onOpen} aria-label=${label}>
    <span class="tcard-top"><${Tag} card=${{ kind: card.kind }} /><span>${RARITY[card.kind]}</span>
      ${card.wish && html`<span class="tcard-wish" title=${`Dans la wishlist ${ofName(card.to)}`}>♥</span>`}
      ${card.n > 1 && html`<span class="tcard-count">×${card.n}</span>`}</span>
    <${Art} card=${card} />
    <span class="tcard-name" lang="en">${card.name}</span>
    <span class="tcard-meta">pour ${card.to}${card.s ? " · ✦" : ""}${nextTier(card.n) ? ` · ${card.n}/${nextTier(card.n)}` : ""}
      ${tierLabel(card.n) && html` <span class="tcard-tier">${tierLabel(card.n)}</span>`}</span>
  </button>`;
}

// Emplacement d'une carte connue (check fait) pas encore pêchée : dos de carte, avec sa rareté (de quoi chasser).
const CardBack = ({ kind }) => html`<div class=${`tcard back kind-${kind}`} role="img" aria-label=${`Carte à pêcher : ${KINDS[kind].label}`}>
  <span class="tcard-top"><span class=${`fishing-tag kind-${kind}`} aria-hidden="true">${KINDS[kind].mark}</span><span>${RARITY[kind]}</span></span>
  <span class="tcard-back-mark" aria-hidden="true">?</span>
  <span class="tcard-meta">À pêcher</span>
</div>`;

const placeText = (card) => card.place && html`<p class="hint">Lieu : <span lang="en">${card.place}</span>${card.from === card.to ? "" : ` (île ${ofName(card.from)})`}</p>`;
const routeText = (card) => (card.from === card.to ? html`Trouvé par <strong>${card.to}</strong> dans son propre monde`
  : html`Envoyé par <strong>${card.from}</strong> à <strong>${card.to}</strong>`);

// Une carte obtenue : nouvelle, ou double (doublons).
function CardFace({ result }) {
  const { card, shiny, fresh } = result;
  return html`<article class=${`fishing-card ${cardClass(card, shiny)}`}>
    <p class="fishing-card-kind"><${Tag} card=${card} /> ${kindText(card)}</p>
    <${Art} card=${card} big />
    <p class="fishing-card-state">${fresh ? "Nouvelle carte !" : `Double (×${result.n} au catalogue)`}${shiny ? " · ✦ Brillante" : ""}</p>
    <h3 class="fishing-card-name" lang="en">${card.name}</h3>
    <p>${routeText(card)}</p>
    ${placeText(card)}
    ${photoText(card)}
    <p class="hint">Jeu : <span lang="en">${card.game}</span></p>
    <p class="fishing-gain">${fresh ? "Ajoutée au catalogue" : `+${plural(result.doublons, "doublon")}`}</p>
  </article>`;
}

// Une carte du catalogue ouverte en grand.
function CardDetail({ card }) {
  return html`<article class=${`fishing-card ${cardClass(card, card.s)}`}>
    <p class="fishing-card-kind"><${Tag} card=${card} /> ${kindText(card)}</p>
    <${Art} card=${card} big />
    <h3 class="fishing-card-name" lang="en">${card.name}</h3>
    <p>${routeText(card)}</p>
    ${placeText(card)}
    ${photoText(card)}
    <p class="hint">Jeu : <span lang="en">${card.game}</span></p>
    <p class="fishing-card-state">${plural(card.n, "exemplaire")}${tierLabel(card.n) ? ` · carte ${tierLabel(card.n) === "Or" ? "dorée" : "argentée"}` : ""}
      ${card.s ? ` · ✦ ${plural(card.s, "brillante")}` : ""}</p>
    ${nextTier(card.n) > 0 && html`<p class="hint">Encore ${plural(nextTier(card.n) - card.n, "exemplaire")}${" "}
      pour la carte ${nextTier(card.n) === 3 ? "argentée" : "dorée"}.</p>`}
  </article>`;
}

function Dialog({ title, onClose, wide = false, xl = false, children, action = "Continuer à pêcher" }) {
  const button = useRef(null);
  useEffect(() => { button.current?.focus(); }, []);
  return html`<div class="modal fishing-modal" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${`modal-box ${wide ? `fishing-panel ${xl ? "xl" : ""}` : "fishing-reveal"}`} role="dialog" aria-modal="true" aria-label=${title}>
      ${wide ? html`<div class="toolbar-row"><h2>${title}</h2><span class="spacer"></span>
          <button type="button" class="ghost" ref=${button} onClick=${onClose}>Fermer</button></div>
        <div class="fishing-panel-body">${children}</div>`
        : html`${children}<button type="button" ref=${button} onClick=${onClose}>${action}</button>`}
    </div>
  </div>`;
}

// Catalogue : un onglet par joueur de la room (les checks faits dans son monde). Les cartes pêchées
// sont face visible, les cartes connues pas encore pêchées de dos (avec leur rareté), et un dernier emplacement compte
// les checks pas encore faits dans ce monde.
const CATALOGUE_FILTERS = [["all", "Toutes"], ["owned", "Au catalogue"], ["missing", "À pêcher"], ["shiny", "Brillantes"]];
function Catalogue({ demo, pool, room, islands, onOpen }) {
  const [tab, setTab] = useState(() => islands[0]?.slot);
  const [filter, setFilter] = useState("all");
  const owned = room.cards;
  const island = islands.find((i) => i.slot === tab);
  const have = pool.filter((c) => owned[c.key]).length;
  let slots = [];
  if (island) {
    const known = pool.filter((c) => c.fromSlot === island.slot);
    const byKind = (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    slots = [
      ...known.filter((c) => owned[c.key]).map((c) => ({ key: c.key, kind: c.kind, card: { ...owned[c.key], key: c.key, shot: c.shot } })),
      ...known.filter((c) => !owned[c.key]).map((c) => ({ key: c.key, kind: c.kind })),
    ].sort((a, b) => byKind(a, b) || Number(!a.card) - Number(!b.card) || (a.card?.name || "").localeCompare(b.card?.name || ""))
      .filter((slot) => (filter === "owned" ? slot.card : filter === "missing" ? !slot.card : filter === "shiny" ? slot.card?.s : true));
  }
  const stars = island ? pool.filter((c) => c.fromSlot === island.slot && c.kind === "progression") : [];
  const pending = island ? Math.max(0, island.total - island.known) : 0;
  return html`
    <p class="fishing-meter-line"><strong>${have} / ${pool.length}</strong> cartes des checks faits${" "}
      <span class="hint">· ${plural(islands.reduce((n, i) => n + i.total, 0), "check")} dans toute la partie</span></p>
    ${demo && html`<p class="hint">Démonstration, avec des cartes fictives. Ouvrez la page d'une room dont la partie est en cours :
      ses vrais checks deviennent les cartes que portent les poissons.</p>`}
    <div class="chips-row fishing-tabs" role="tablist" aria-label="Catalogues">
      ${islands.map((i) => html`<button type="button" role="tab" aria-selected=${tab === i.slot} class=${`chip-btn ${tab === i.slot ? "active" : ""}`}
        onClick=${() => setTab(i.slot)}>${i.name} <span class="hint">${i.have}/${i.known}</span>${i.starSet ? " ★" : ""}</button>`)}
    </div>
    ${island && html`<section class="stack">
      <h3>Catalogue ${ofName(island.name)} <span class="hint" lang="en">${island.game}</span></h3>
      <${Meter} value=${island.have} max=${island.known} label=${`Catalogue ${ofName(island.name)}`} />
      <p class="hint">${island.have} / ${plural(island.known, "carte connue", "cartes connues")}${" "}
        · ★ ${stars.filter((c) => owned[c.key]).length} / ${stars.length}${island.starSet ? " (complet !)" : ""}${" "}
        · ${plural(pending, "check encore à faire", "checks encore à faire")} dans ce monde.</p>
      <div class="chips-row" role="group" aria-label="Filtre">${CATALOGUE_FILTERS.map(([id, label]) => html`<button type="button"
        class=${`chip-btn ${filter === id ? "active" : ""}`} aria-pressed=${filter === id} onClick=${() => setFilter(id)}>${label}</button>`)}</div>
      <div class="tcard-grid">
        ${slots.map((slot) => (slot.card ? html`<${TradingCard} key=${slot.key} card=${slot.card} onOpen=${() => onOpen(slot.card)} />`
          : html`<${CardBack} key=${slot.key} kind=${slot.kind} />`))}
        ${filter === "all" && pending > 0 && html`<div class="tcard pending" role="img" aria-label=${`${pending} checks pas encore faits`}>
          <span class="tcard-back-mark" aria-hidden="true">${pending}</span><span class="tcard-meta">checks pas encore faits</span></div>`}
      </div>
      ${!slots.length && html`<p class="hint">Aucune carte ici pour l'instant.</p>`}
    </section>`}
`;
}

function Meter({ value, max, label }) {
  const pct = max ? Math.round((100 * value) / max) : 0;
  return html`<div class="fishing-meter-row">
    <div class="fishing-meter" role="meter" aria-label=${label} aria-valuemin="0" aria-valuemax=${max} aria-valuenow=${value}>
      <span style=${{ width: `${pct}%` }}></span></div>
    <span class="fishing-meter-value" aria-hidden="true">${pct} %</span>
  </div>`;
}

// Cartes au trésor : le prochain poisson portera une carte manquante de l'île choisie.
function Treasure({ doublons, islands, onBuy }) {
  const [target, setTarget] = useState("");
  const aimed = islands.filter((i) => i.missing > 0);
  const chosen = aimed.find((i) => String(i.slot) === target) || aimed[0];
  return html`<section class="stack">
    <p>Le prochain poisson portera une carte que vous n'avez pas encore, de l'île choisie (il brille d'un halo doré ; s'il
      repart, il reviendra).</p>
    ${aimed.length ? html`<div class="row">
      <select value=${chosen ? String(chosen.slot) : ""} onChange=${(e) => setTarget(e.target.value)} aria-label="Île visée">
        ${aimed.map((i) => html`<option value=${String(i.slot)}>Île ${ofName(i.name)} (${plural(i.missing, "carte manquante", "cartes manquantes")})</option>`)}
      </select>
      <button type="button" disabled=${doublons < TREASURE_PRICE} onClick=${() => onBuy(chosen.slot)}>
        Acheter · ${plural(TREASURE_PRICE, "doublon")}</button>
    </div>` : html`<p>Toutes les cartes connues sont au catalogue : il faut attendre de nouveaux checks.</p>`}
    <${Meter} value=${Math.min(doublons, TREASURE_PRICE)} max=${TREASURE_PRICE} label="Doublons pour la prochaine carte au trésor" />
    <p class="hint">${doublons >= TREASURE_PRICE ? `Vous avez ${plural(doublons, "doublon")} : de quoi en acheter une.`
      : `${doublons} / ${TREASURE_PRICE} doublons. Chaque double pêché en donne (plus pour une carte rare ou brillante).`}</p>
  </section>`;
}

// Mode pêche : la mer, le tableau de bord en haut, les boutons en bas (au clavier comme au doigt).
export function FishingMode({ onClose }) {
  const current = useFeed();
  const reduced = useReducedMotion();
  const [save, setSave] = useStored("fishing", { doublons: 0 });
  const [albums, setAlbums] = useStored("fishingAlbums", { rooms: {} });
  const [lineState, setLineState] = useState("none");
  const [night, setNight] = useState(false);
  const [reelLeft, setReelLeft] = useState(0); // clics restants pour remonter le poisson ferré
  const [combo, setCombo] = useState({ n: 0, until: 0, start: 0 }); // prises d'affilée
  const [bancUntil, setBancUntil] = useState(0);
  const [toast, setToast] = useState(null); // grande annonce : banc, carte rare
  const [catchCard, setCatchCard] = useState(null); // dernière carte pêchée, montrée un moment sans interrompre
  const [panel, setPanel] = useState(null); // "catalogue" | "tresor"
  const [detail, setDetail] = useState(null); // carte du catalogue ouverte en grand
  const [message, setMessage] = useState("");
  const [alert, setAlert] = useState(null); // clé de la carte arrivée pour l'un de vos joueurs
  const [spot, setSpot] = useState(""); // île où l'on pêche (numéro du joueur), ou toute la partie
  const [place, setPlace] = useState(null); // annonce d'arrivée sur une île { id, title, sub }
  const [sailing, setSailing] = useState(false); // traversée en cours
  // Fermer une carte ouverte rend la main à ce qui l'avait ouverte.
  const opener = useRef(null);
  const openDetail = (card) => { if (!card) return; opener.current = document.activeElement; setDetail(card); };
  const closeDetail = () => { setDetail(null); setTimeout(() => (opener.current?.isConnected ? opener.current : action.current)?.focus(), 0); };
  const canvas = useRef(null);
  const pond = useRef(null);
  const action = useRef(null);
  const seen = useRef(null);
  const treasure = useRef(null); // île visée par une carte au trésor
  const fresh = useRef([]); // checks tout juste faits : les prochains poissons les portent

  const demo = !current;
  const feedNow = current || DEMO_FEED;
  const code = feedNow.code;
  photos.code = demo ? null : code;
  photos.set = new Set(current?.shots || []);
  const games = useMemo(() => [...new Set((current?.status.slots || []).map((s) => s.game))].sort(), [current?.status]);
  const { loaded } = usePackages(current?.status.origin, current?.data.fixed, games);
  const cards = useMemo(() => (current ? roomCards(current, loaded) : DEMO_CARDS), [current, loaded]);
  const pool = useMemo(() => cards.filter((c) => c.name), [cards]);
  const room = roomOf(albums, code);
  const islands = useMemo(() => islandsOf(feedNow, pool, room.cards), [feedNow, pool, room]);
  const owned = pool.filter((c) => room.cards[c.key]).length;
  const stars = pool.filter((c) => c.kind === "progression");
  const starsOwned = stars.filter((c) => room.cards[c.key]).length;
  const comboNow = combo.until > Date.now() ? combo.n : 0;
  const luck = luckOf(comboNow);

  // Nouveaux checks dans la partie : un banc les amène (ils sont portés par les prochains poissons) ; un objet de
  // progression ou de wishlist pour l'un de vos joueurs vous renvoie jouer.
  useEffect(() => { seen.current = null; treasure.current = null; fresh.current = []; setSpot(""); setSailing(false); pond.current?.place(null); }, [code]);
  const spotIsland = islands.find((i) => String(i.slot) === spot);
  const spotPool = spotIsland ? pool.filter((c) => c.fromSlot === spotIsland.slot) : pool;

  // Collection envoyée à la room (visible par tous les inscrits), après un moment sans prise : jamais pour la démo,
  // ni sans accès à la room (ni joueur inscrit, ni hôte).
  useEffect(() => {
    if (demo || !current) return undefined;
    const access = savedAccess(code);
    if (!access.player && !access.admin) return undefined;
    const keys = Object.keys(room.cards);
    if (!keys.length) return undefined;
    const id = setTimeout(() => {
      const list = Object.values(room.cards);
      Promise.resolve()
        .then(() => api.saveFishing(code, { cards: keys, shiny: list.filter((c) => c.s > 0).length, gold: list.filter((c) => c.n >= 6).length }))
        .catch(() => { /* nouvel essai à la prochaine prise */ });
    }, SYNC_MS);
    return () => clearTimeout(id);
  }, [room, code, demo]);
  useEffect(() => {
    if (!current) return;
    if (!seen.current) { seen.current = new Set(cards.map((c) => c.key)); return; }
    const added = cards.filter((c) => !seen.current.has(c.key));
    if (!added.length) return;
    for (const c of added) seen.current.add(c.key);
    fresh.current.push(...added.map((c) => c.key));
    const hit = added.find((c) => current.mine.includes(c.to.toLowerCase()) && (c.kind === "progression" || c.wish));
    if (hit) setAlert(hit.key);
    const who = [...new Set(added.map((c) => c.from))];
    setToast({ id: performance.now(), text: `${who.length === 1 ? who[0] : "La partie"} : ${plural(added.length, "nouveau check", "nouveaux checks")} !` });
    setBancUntil(Date.now() + BANC_MS);
    pond.current?.banc(BANC_MS);
  }, [cards]);

  // Une carte pêchée : nouvelle au catalogue, ou double (doublons).
  const obtain = ({ card, shiny }) => {
    const had = room.cards[card.key];
    const now = { ...room.cards };
    let dry = room.dry || 0, result;
    if (had) {
      const gain = KINDS[card.kind].dup * (card.wish ? 2 : 1) + (shiny ? 5 : 0);
      now[card.key] = { ...had, n: had.n + 1, s: had.s + (shiny ? 1 : 0) };
      dry += 1;
      setSave((s) => ({ ...s, doublons: (s.doublons || 0) + gain }));
      const tierUp = tierOf(had.n + 1) !== tierOf(had.n) ? tierOf(had.n + 1) : "";
      result = { card, shiny, fresh: false, doublons: gain, n: had.n + 1, tierUp };
    } else {
      const { name, game, to, from, fromSlot, place, kind } = card;
      now[card.key] = { n: 1, s: shiny ? 1 : 0, name, game, to, from, fromSlot, place, kind, wish: card.wish, shot: card.shot };
      dry = 0;
      result = { card, shiny, fresh: true, n: 1 };
    }
    setAlbums((a) => withRoom(a, code, { at: Date.now(), dry, cards: now }));
    // Île complète : toutes ses cartes connues sont au catalogue.
    if (result.fresh) {
      const isle = islands.find((i) => i.slot === card.fromSlot);
      if (isle && pool.filter((c) => c.fromSlot === isle.slot).every((c) => now[c.key])) result.island = isle.name;
    }
    return result;
  };

  // Un poisson arrive au compteur du catalogue (après son saut) : sa carte s'affiche un moment, en grand si elle est rare.
  const catchFish = (fish) => {
    const card = pool.find((c) => c.key === fish.card.key) || fish.card; // noms relus (datapackages chargés depuis)
    const result = obtain({ card, shiny: fish.shiny });
    const special = result.island ? `Île ${ofName(result.island)} complète !` : result.tierUp === "gold" ? "Carte dorée !"
      : result.tierUp === "silver" ? "Carte argentée !" : result.shiny ? "✦ Carte brillante !"
      : result.fresh && card.wish ? "♥ Carte de wishlist !" : result.fresh && card.kind === "progression" ? "★ Carte rare !" : "";
    const level = special ? 2 : result.fresh ? 1 : 0;
    setCatchCard({ id: performance.now(), result, level });
    if (special) setToast({ id: performance.now(), text: special, level });
    pond.current?.celebrate(level, card, result.shiny);
    if (card.kind === "trap") pond.current?.scare(SCARE_MS);
    setMessage(`${result.fresh ? `Nouvelle carte : ${card.name}.` : `Double : ${card.name}, +${plural(result.doublons, "doublon")}.`}`
      + `${card.kind === "trap" ? " Carte maudite : les poissons fuient un moment." : ""}`);
  };
  // Ferré : le combo monte (un « Parfait ! » compte double), et avec lui la chance des prochains poissons.
  const onHooked = (fish, perfect) => {
    const now = Date.now();
    const n = comboNow + (perfect ? 2 : 1);
    setCombo({ n, until: now + COMBO_MS, start: now });
  };
  const breakCombo = (why) => {
    setMessage(comboNow > 1 ? `${why} Combo perdu.` : why);
    setCombo({ n: 0, until: 0, start: 0 });
  };

  // Le geste : lancer, puis ferrer (ou ramener la ligne) ; au clic là où l'on clique, au clavier là où l'on vise.
  const act = (x, y) => {
    const p = pond.current;
    if (!p || panel || detail) return;
    if (p.isTraveling()) { setMessage("En mer : le bateau arrive bientôt."); return; }
    const result = p.strike();
    if (result.type === "none") { if (p.cast(x, y)) setMessage(""); return; }
    if (result.type === "hooked") {
      onHooked(result.fish, result.perfect);
      const what = result.fish.card.wish ? "♥ " : result.fish.card.kind === "progression" ? "★ " : "";
      setMessage(`${result.perfect ? "Parfait ! " : ""}${result.taps ? `${what}Ça tire ! Cliquez pour remonter ${result.fish.data.the}.` : ""}`);
    } else if (result.type === "yank") { if (!result.left) setMessage(""); }
    else if (result.type === "early") breakCombo("Trop tôt : il ne faisait que grignoter, et il a fui.");
    else setMessage("Ligne ramenée.");
  };

  // Changer de lieu de pêche : on met le cap sur l'île (traversée), ou sur le large.
  const goTo = (value) => {
    setSpot(value);
    const isle = islands.find((i) => String(i.slot) === value);
    if (pond.current?.travel(isle ? { slot: isle.slot, name: isle.name, game: isle.game } : null)) {
      setSailing(true);
      setMessage(isle ? `Cap sur l'île ${ofName(isle.name)}…` : "Cap sur le large…");
    }
  };

  const buyTreasure = (slot) => {
    if ((save.doublons || 0) < TREASURE_PRICE) return;
    setSave((s) => ({ ...s, doublons: s.doublons - TREASURE_PRICE }));
    treasure.current = slot;
    pond.current?.spawnSoon();
    setPanel(null);
    const island = islands.find((i) => i.slot === slot);
    setMessage(`Carte au trésor : le prochain poisson porte une carte de l'île ${ofName(island?.name || "")}. Il brille d'un halo doré.`);
    action.current?.focus();
  };

  // Le canvas appelle toujours les gestionnaires du dernier rendu.
  const handlers = useRef({});
  handlers.current = {
    // Carte d'un nouveau poisson : les checks tout juste faits d'abord, puis celle d'une carte au trésor, sinon un tirage.
    nextCard: () => {
      if (!pool.length) return null;
      while (fresh.current.length) {
        const card = pool.find((c) => c.key === fresh.current[0]);
        if (!card && cards.some((c) => c.key === fresh.current[0])) break; // nom pas encore chargé : on attend
        fresh.current.shift();
        if (card) return { card, shiny: Math.random() < SHINY * luck };
      }
      const target = treasure.current;
      treasure.current = null;
      const draw = drawCard(target != null ? pool : spotPool, room.cards, room.dry || 0, target != null ? { target, luck } : { luck });
      return draw && { ...draw, treasure: target != null && !room.cards[draw.card.key] && draw.card.fromSlot === target };
    },
    caught: (fish) => catchFish(fish),
    arrived: (island) => {
      setSailing(false);
      const isle = island && islands.find((i) => i.slot === island.slot);
      setPlace({ id: performance.now(), title: isle ? `Île ${ofName(isle.name)}` : "Le large",
        sub: isle ? `${isle.game} · ${BIOMES[biomeOf(isle)].label} · ${isle.have}/${plural(isle.known, "carte")}` : "Toute la partie" });
      setMessage(isle ? `Vous voici sur l'île ${ofName(isle.name)} : ses poissons portent ses cartes.` : "Vous voici au large : toutes les cartes de la partie.");
    },
    lost: (fish) => { treasure.current = fish.card.fromSlot; },
    event: (type, species) => {
      if (type === "bite") setMessage("Ça mord ! Ferrez maintenant.");
      else if (type === "late") breakCombo(`Trop tard : ${species?.the || "le poisson"} a mangé l'appât.`);
      else if (type === "fled") setMessage("Plouf ! Un poisson méfiant a fui le bouchon.");
    },
  };
  useEffect(() => {
    const p = createPond(canvas.current, {
      area: playArea,
      nextCard: () => handlers.current.nextCard(),
      line: setLineState,
      lost: (fish) => handlers.current.lost(fish),
      event: (type, species) => handlers.current.event(type, species),
      night: setNight,
      reel: setReelLeft,
      caught: (fish) => handlers.current.caught(fish),
      arrived: (island) => handlers.current.arrived(island),
      // Le poisson saute vers le compteur du catalogue (juste sous le tableau de bord, qui passe par-dessus la mer).
      scoreAt: () => {
        const count = document.querySelector(".fishing-owned")?.getBoundingClientRect();
        const hud = document.querySelector(".fishing-hud")?.getBoundingClientRect();
        return count && hud ? { x: count.left + count.width / 2, y: hud.bottom - 8 } : null;
      },
    });
    pond.current = p;
    p.setReduced(reduced);
    p.layout();
    p.start();
    action.current?.focus();
    let pending = 0;
    const relayout = () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(p.layout); };
    const observer = new ResizeObserver(relayout);
    observer.observe(document.body);
    for (const node of document.querySelectorAll(".fishing-hud, .fishing-actions, .site-side")) observer.observe(node);
    addEventListener("resize", relayout);
    return () => {
      p.stop(); observer.disconnect(); removeEventListener("resize", relayout);
      document.querySelector(".side-fishing")?.focus();
    };
  }, []);
  useEffect(() => { pond.current?.setReduced(reduced); }, [reduced]);
  useEffect(() => { pond.current?.setLuck(luck); }, [luck]);
  useEffect(() => { pond.current?.setAlert(!!alert); }, [alert]);

  // Clavier : flèches pour viser (Maj : plus fin), Échap pour fermer la fenêtre ouverte ou dérouler la carte.
  const onKey = useRef(null);
  onKey.current = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (detail) closeDetail();
      else if (panel) { setPanel(null); action.current?.focus(); }
      else onClose();
      return;
    }
    if (panel || detail || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) return;
    // Espace ou Entrée sans bouton sous le focus (après un clic sur la mer) : lancer ou ferrer.
    if ((e.key === " " || e.key === "Enter") && (!document.activeElement || document.activeElement === document.body)) {
      e.preventDefault();
      pond.current?.showAim();
      act();
      return;
    }
    const step = e.shiftKey ? 8 : 28;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[e.key]) { e.preventDefault(); pond.current?.moveAim(...moves[e.key]); }
  };
  useEffect(() => {
    const listener = (e) => onKey.current(e);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  // Fin du combo, du banc, des annonces, à l'heure.
  const later = (when, fn, deps) => useEffect(() => {
    if (!when) return undefined;
    const id = setTimeout(fn, Math.max(0, when - Date.now()) + 30);
    return () => clearTimeout(id);
  }, deps);
  later(combo.until, () => setCombo((c) => (c.until <= Date.now() ? { n: 0, until: 0, start: 0 } : c)), [combo.until]);
  later(bancUntil, () => setBancUntil(0), [bancUntil]);
  later(toast && Date.now() + 2300, () => setToast(null), [toast]);
  later(catchCard && Date.now() + 4000, () => setCatchCard(null), [catchCard]);

  const bancOn = bancUntil > Date.now();
  const alertCard = alert && cards.find((c) => c.key === alert);
  const actionLabel = sailing ? "En mer…" : { none: "Lancer la ligne", flying: "…", waiting: "Ramener la ligne", nibble: "Ça touche… (attendez)", bite: "Ferrer !",
    reel: reelLeft ? `Remonter ! (${reelLeft})` : "Ça remonte…" }[lineState];
  const help = lineState === "none" && !Object.keys(room.cards).length
    ? `Chaque poisson porte une carte : un check ${demo ? "(fictif, ici)" : "de la partie"}. Sa rareté se lit à l'étiquette (★ rare, ◆ utile,
      ⚠ piège, ♥ wishlist) : plus elle est précieuse, plus il est rusé et résiste. Cliquez sur l'eau près de celui que vous voulez,
      ferrez quand ça mord. Au clavier : flèches pour viser, Espace pour lancer et ferrer.`
    : "";
  const shown = catchCard?.result;

  return html`
    <canvas class="fishing-pond" ref=${canvas} aria-hidden="true"
      onPointerDown=${(e) => { if (e.button === 0) act(e.clientX, e.clientY); }}></canvas>
    <div class="fishing-ui">
      <section class="fishing-hud" aria-label="Pêche au large">
        <p class="fishing-score"><strong key=${owned} class="fishing-owned">${owned}</strong> / ${plural(pool.length, "carte")}
          ${demo && html` <span class="badge">Démo</span>`}
          ${stars.length > 0 && html` <span class="fishing-stars">· ★ ${starsOwned} / ${stars.length}</span>`}
          ${(save.doublons || 0) > 0 && html` · <strong class="fishing-doublons">${save.doublons}</strong> doublon${save.doublons > 1 ? "s" : ""}`}</p>
        <p class="fishing-time">${night ? "☾ Nuit" : "☀ Jour"}</p>
        <p class="fishing-rank"><label class="fishing-spot"><span class="sr-only">Lieu de pêche</span>
            <select value=${spot} onChange=${(e) => goTo(e.target.value)}>
              <option value="">${demo ? "Partie de démonstration" : `Toute la partie (room ${code})`}</option>
              ${islands.map((i) => html`<option value=${String(i.slot)}>Île ${ofName(i.name)} · ${i.have}/${i.known}${i.known && i.have === i.known ? " ✓" : ""}</option>`)}
            </select></label>
          ${(() => {
            const have = spotIsland ? spotIsland.have : owned, total = spotIsland ? spotIsland.known : pool.length;
            const pct = total ? Math.round((100 * have) / total) : 0;
            return html`<span class="fishing-xp" role="meter" aria-label="Cartes de ce lieu au catalogue" aria-valuemin="0" aria-valuemax=${total}
              aria-valuenow=${have}><span style=${{ width: `${pct}%` }}></span></span><span class="hint">${have}/${total} · ${pct} %</span>`;
          })()}</p>
        <div class="fishing-buttons">
          <button type="button" class="ghost" onClick=${() => setPanel("catalogue")}>Catalogue</button>
          ${(save.doublons || 0) > 0 && html`<button type="button" class="ghost" onClick=${() => setPanel("tresor")}>Cartes au trésor</button>`}
          <button type="button" onClick=${onClose}>Dérouler la carte</button>
        </div>
        ${alertCard && html`<div class="fishing-alert" role="status">
          <span><span aria-hidden="true">${alertCard.wish && alertCard.kind !== "progression" ? "♥" : "★"}</span>
            ${" "}<strong lang="en">${alertCard.name || "Un objet important"}</strong> vient d'arriver pour ${alertCard.to} !</span>
          <button type="button" onClick=${onClose}>Retourner jouer</button>
          <button type="button" class="link" onClick=${() => setAlert(null)}>Plus tard</button>
        </div>`}
        <p class="fishing-message" aria-live="polite">${message || help}</p>
      </section>
    </div>
    ${toast && html`<p class="fishing-toast" key=${toast.id} role="status">${toast.text}</p>`}
    ${place && html`<div class="fishing-place" key=${place.id} aria-hidden="true"><strong>${place.title}</strong><span>${place.sub}</span></div>`}
    ${shown && html`<div class=${`fishing-catch level-${catchCard.level || 0}${shown.shiny ? " is-shiny" : ""}`} key=${catchCard.id}>
      <p class="fishing-catch-state">${shown.fresh ? "Nouvelle carte !" : `Double · +${plural(shown.doublons, "doublon")}`}</p>
      <${TradingCard} card=${{ ...shown.card, n: shown.n, s: shown.shiny ? 1 : 0 }}
        onOpen=${() => openDetail(room.cards[shown.card.key] && { ...room.cards[shown.card.key], key: shown.card.key, shot: shown.card.shot })} />
    </div>`}
    <div class="fishing-actions">
      ${bancOn && html`<p class="fishing-frenzy" key=${bancUntil}>Banc ! <span class="hint">ils mordent tout de suite</span>
        <span class="combo-timer" style=${{ animationDuration: `${Math.max(0, bancUntil - Date.now())}ms` }}></span></p>`}
      ${comboNow > 1 && html`<p class="fishing-combo" key=${combo.start}>Chance ×${luck.toFixed(2).replace(/0$/, "")}
        <span class="hint">combo ${comboNow}</span>
        <span class="combo-timer" style=${{ animationDuration: `${COMBO_MS}ms` }}></span></p>`}
      <button type="button" ref=${action} class=${`fishing-action ${lineState === "bite" || (lineState === "reel" && reelLeft) ? "bite" : ""}`}
        onClick=${() => { pond.current?.showAim(); act(); }}>${actionLabel}</button>
    </div>
    ${panel === "catalogue" && html`<${Dialog} wide xl title="Catalogue" onClose=${() => { setPanel(null); action.current?.focus(); }}>
      <${Catalogue} demo=${demo} pool=${pool} room=${room} islands=${islands} onOpen=${openDetail} /></${Dialog}>`}
    ${panel === "tresor" && html`<${Dialog} wide title="Cartes au trésor" onClose=${() => { setPanel(null); action.current?.focus(); }}>
      <${Treasure} doublons=${save.doublons || 0} islands=${islands} onBuy=${buyTreasure} /></${Dialog}>`}
    ${detail && html`<${Dialog} title=${detail.name} action="Retour" onClose=${closeDetail}>
      <${CardDetail} card=${detail} /></${Dialog}>`}`;
}

// --- Dans la room : la pêche de chacun et l'objectif commun -----------------------------------
// Onglet « Progression » d'une room (rooms.js) : cartes pêchées par chaque inscrit (envoyées par leur navigateur), et
// la collection commune, toutes les cartes pêchées par quelqu'un, rapportée aux checks faits dans la partie (objets
// envoyés par un joueur : l'inventaire de départ n'en est pas). Le bouton ouvre la pêche (main.js écoute l'événement).
const ROOM_GOALS = [25, 50, 75, 100];
export const openFishing = () => window.dispatchEvent(new Event("fishing:open"));
export function FishingRoomCard({ fishing, tracker }) {
  const done = (tracker?.data?.live?.player_items_received || []).filter((e) => e.team === 0)
    .reduce((n, e) => n + e.items.filter((i) => (Array.isArray(i) ? i[2] : i.player)).length, 0);
  const union = Math.min(done || Infinity, fishing?.union?.length || 0);
  const pct = done ? Math.round((100 * union) / done) : 0;
  const reached = ROOM_GOALS.filter((g) => pct >= g);
  return html`<section class="card stack fishing-room">
    <div class="toolbar-row"><h3>Pêche au large</h3><span class="spacer"></span>
      <button type="button" class="ghost" onClick=${openFishing}>Aller pêcher</button></div>
    <p class="hint">Un petit jeu pour patienter : chaque poisson porte une carte, un check de la partie. La collection de chacun
      est visible ici, et la room en remplit une ensemble.</p>
    ${done > 0 && html`<div>
      <p><strong>Collection de la room : ${union} / ${plural(done, "check")}</strong></p>
      <${Meter} value=${union} max=${done} label="Checks de la partie pêchés par la room" />
      <p class="fishing-goals">${ROOM_GOALS.map((g) => html`<span class=${`badge ${reached.includes(g) ? "accent" : ""}`}>
        ${reached.includes(g) ? "✓ " : ""}${g === 100 ? "Toute la partie" : `${g} %`}</span>`)}</p>
    </div>`}
    ${fishing?.players?.length ? html`<ol class="fishing-board">${fishing.players.map((p) => html`<li>
        <strong>${p.pseudo}</strong> <span>${plural(p.cards, "carte")}</span>
        ${p.gold > 0 && html`<span class="hint">· ${plural(p.gold, "dorée")}</span>`}
        ${p.shiny > 0 && html`<span class="hint">· ✦ ${plural(p.shiny, "brillante")}</span>`}</li>`)}</ol>`
      : html`<p class="hint">Personne n'a encore pêché dans cette room.</p>`}
  </section>`;
}
