// Prévision avant génération : difficulté et durée estimées d'un YAML, et ce qui risque de bloquer la partie.
//
// Rien n'est simulé : Archipelago seul connaît la logique des jeux. L'estimation se fait par rapport aux réglages
// par défaut du jeu, d'après les noms et valeurs des options (« logic_difficulty: hard », « trap_percentage »,
// « entrance_shuffle »…), assez réguliers d'un monde à l'autre pour donner une tendance sur les 700 jeux.
import { html, useMemo, useState } from "../vendor/preact-htm.js";
import { isPlainObject } from "./yaml-model.js";
import { cachedGame, gameEntry } from "./data.js";
import { COMMON_TEXT, describeScalar, parseRandomRange, resolveChoice, singleValue, toggleState, writeSingle } from "./options.js";

export const DIFFICULTY_LEVELS = ["Très accessible", "Accessible", "Standard", "Exigeant", "Difficile", "Très difficile"];
export const LENGTH_LEVELS = ["Bien plus courte", "Plus courte", "Normale", "Plus longue", "Bien plus longue"];

export function difficultyLevel(score) {
  if (score <= -2) return 0;
  if (score <= -0.75) return 1;
  if (score < 1) return 2;
  if (score < 2.5) return 3;
  if (score < 4) return 4;
  return 5;
}

export function lengthLevel(score) {
  if (score <= -2) return 0;
  if (score <= -0.75) return 1;
  if (score < 0.75) return 2;
  if (score < 2.5) return 3;
  return 4;
}

// --- Valeurs possibles d'une option ---------------------------------------------------

const RANGE_KINDS = ["range", "named_range"];
const CHOICE_KINDS = ["choice", "text_choice"];

function scalar(option, value) {
  if (option.kind === "toggle") return toggleState(value) ?? false;
  if (CHOICE_KINDS.includes(option.kind)) return resolveChoice(option, value) ?? String(value).toLowerCase();
  if (RANGE_KINDS.includes(option.kind)) {
    const special = option.special || {};
    const text = String(value).toLowerCase();
    return text in special ? special[text] : Number(value);
  }
  return value;
}

// Issues d'une valeur simple : « random » et les intervalles aléatoires en donnent plusieurs.
function expand(option, value) {
  const text = String(value).toLowerCase();
  if (option.kind === "toggle" && text === "random") return [{ value: true, weight: 1 }, { value: false, weight: 1 }];
  if (CHOICE_KINDS.includes(option.kind) && text === "random" && option.choices?.length) {
    return option.choices.map((c) => ({ value: c.value, weight: 1 }));
  }
  if (RANGE_KINDS.includes(option.kind)) {
    const range = parseRandomRange(text);
    const lo = range ? range.min : option.min, hi = range ? range.max : option.max;
    const bias = range ? range.bias : text.startsWith("random") ? text.slice(7) || null : undefined;
    if (bias !== undefined && lo != null && hi != null) {
      const high = bias === "low" ? 1 : bias === "high" ? 3 : 2;
      return [{ value: lo, weight: 4 - high }, { value: hi, weight: high }];
    }
  }
  return [{ value: scalar(option, value), weight: 1 }];
}

// [{ value, weight }] : une table de poids (`hard: 30, normal: 70`) est un tirage au sort entre ses valeurs.
function outcomes(option, value) {
  if (value === undefined) value = option.default;
  if (option.weighted && isPlainObject(value)) {
    const list = Object.entries(value).filter(([, w]) => Number(w) > 0)
      .flatMap(([k, w]) => expand(option, k).map((o) => ({ value: o.value, weight: o.weight * Number(w) })));
    if (list.length) return list;
    value = option.default;
  }
  return expand(option, value);
}

// --- Règles ----------------------------------------------------------------------------
//
// Une règle classe l'option dans une catégorie et note chaque valeur ({ d: difficulté, l: durée, flag }).
// L'effet d'une option est la note de sa valeur moins celle de sa valeur par défaut.

// Niveau de difficulté d'une valeur de choix (« hard », « hard_enemies », « very_easy »…), ou null.
const LEVEL_WORDS = {
  very_easy: -2, super_easy: -2, baby: -2, story: -2, beginner: -2, novice: -2, trivial: -2,
  easy: -1, easier: -1, casual: -1, relaxed: -1, lenient: -1, forgiving: -1, assisted: -1,
  normal: 0, default: 0, standard: 0, medium: 0, moderate: 0, regular: 0, intermediate: 0,
  hard: 1, harder: 1, difficult: 1, advanced: 1, strict: 1, tough: 1, veteran: 1, hardcore: 1.5, chaos: 1.5,
  very_hard: 2, expert: 2, extreme: 2, insane: 2, master: 2, nightmare: 2, hell: 2, lunatic: 2, brutal: 2, impossible: 2.5,
};
const NEUTRAL_TOKENS = new Set(["enemies", "enemy", "logic", "mode", "difficulty", "level", "combat", "game", "items", "item", "pool", "settings"]);

function wordLevel(value) {
  const words = String(value).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !NEUTRAL_TOKENS.has(t)).join("_");
  return words in LEVEL_WORDS ? LEVEL_WORDS[words] : null;
}

// Quantité de pièges d'une valeur de choix (« few », « many »…).
const TRAP_WORDS = {
  none: 0, off: 0, disabled: 0, no: 0, false: 0, minimal: 0.2, few: 0.3, low: 0.3, rare: 0.3, some: 0.4,
  normal: 0.6, medium: 0.6, default: 0.6, on: 0.6, many: 1, high: 1, lots: 1, frequent: 1, all: 1.2, extreme: 1.5, chaos: 1.5, max: 1.5,
};

const COSMETIC = /palette|music|sound|sfx|sprite|colou?r|cosmetic|skin|costume|outfit|hud|menu|font|voice|language|quickswap|heartbeep|flashing|jingle|announcer|portrait|_text$|^text_|hint/;
// Entrées mélangées : un mot de passage (porte, niveau…) avec un mot de mélange ; « open_doors » ou « warp_whistle » aident au contraire.
const ENTRANCE = /entrance|door|portal|transition|connector|warp|room|level|stage|area|world/;
const MIXED = /shuffle|rando|randomi[sz]|mix/;
const INACTIVE = /^(off|none|vanilla|false|disabled|no|default|original|normal)$/;
const REMOTE = /(any|different|other)_?worlds?|anywhere|keysanity/;
const NO_LOGIC = /^no_?logic$/;
const GLITCH = (text) => /(^|_)(glitch(ed|es|s)?|clips?|clipping|oob|out_of_bounds)(_|$)/.test(text) && !/no_?glitch|glitchless|glitch_?free/.test(text);
const HARD_TOGGLE = /(^|_)(hard|expert|advanced|tricks?|precise|obscure|damage_?boost|hardcore|ohko|one_?hit|permadeath)(_|$)/;
const EASY_TOGGLE = /(^|_)(easy|assists?|casual|god_?mode|invinc\w*|infinite|unlimited)(_|$)/;
// « no_progression_in_hard_locations », « fix_atlas_glitch » : l'option retire la difficulté au lieu de l'ajouter.
const NEGATED = /(^|_)(no|not|fix|fixes|exclude|remove|disable|without|prevent)(_|$)/;

const position = (option, v) => (option.max > option.min && Number.isFinite(v) ? (v - option.min) / (option.max - option.min) : 0);
const isActive = (option, v) => option.kind === "toggle" ? v === true
  : RANGE_KINDS.includes(option.kind) ? v > 0 : !INACTIVE.test(String(v));
const sizeOf = (value) => Array.isArray(value) ? value.length : isPlainObject(value) ? Object.keys(value).length : 0;

// Règle de chaque option, gardée : la recherche de réglages (suggestSettings) note des centaines de variantes.
const rules = new WeakMap();
function ruleFor(option) {
  if (!rules.has(option)) rules.set(option, findRule(option) || null);
  return rules.get(option);
}

function findRule(option) {
  // Clés en snake_case ou en CamelCase (« RandomizeGrubs » → « randomize_grubs »).
  const key = option.key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const kind = option.kind;
  if (key === "death_link" || /death_?link$/.test(key)) return kind === "toggle" && { cat: "deathlink", score: (v) => ({ d: v ? 1 : 0 }) };
  if (option.key === "progression_balancing") {
    return { cat: "balancing", score: (v) => (v === 0 ? { d: 0.5, l: 0.5 } : v >= 80 ? { d: -0.3 } : {}) };
  }
  // Options sur des listes ou dictionnaires : notées d'après leur contenu.
  if (key === "start_inventory" || key === "start_inventory_from_pool") return { cat: "start", whole: true, score: (v) => ({ d: -Math.min(1.5, sizeOf(v) * 0.3) }) };
  if (key === "start_hints" || key === "start_location_hints") return { cat: "start", whole: true, score: (v) => ({ d: -Math.min(0.5, sizeOf(v) * 0.1) }) };
  if (key === "non_local_items") return { cat: "locality", whole: true, score: (v) => ({ d: Math.min(0.5, sizeOf(v) * 0.1) }) };
  if (key === "local_items") return { cat: "locality", whole: true, score: (v) => ({ d: -Math.min(0.5, sizeOf(v) * 0.1) }) };
  if (option.key in COMMON_TEXT || COSMETIC.test(key)) return null;

  if (/trap|beemizer/.test(key)) {
    if (key === "trap_link") return kind === "toggle" && { cat: "trap", score: (v) => ({ d: v ? 0.5 : 0 }) };
    if (RANGE_KINDS.includes(kind)) return { cat: "trap", score: (v) => ({ d: position(option, v) * 2 }) };
    if (kind === "toggle") return { cat: "trap", score: (v) => ({ d: v ? 0.5 : 0 }) };
    if (CHOICE_KINDS.includes(kind)) return { cat: "trap", score: (v) => ({ d: TRAP_WORDS[String(v).toLowerCase()] ?? wordLevel(v) ?? 0 }) };
    return null;
  }
  if (kind === "toggle") {
    if (/(^|_)no_?logic$/.test(key)) return { cat: "glitch", score: (v) => (v ? { d: 3, flag: "nologic" } : {}) };
    if (NEGATED.test(key)) return null;
    if (GLITCH(key)) return { cat: "glitch", score: (v) => (v ? { d: 1.5, flag: "glitch" } : {}) };
    if (HARD_TOGGLE.test(key)) return { cat: "logic", score: (v) => ({ d: v ? 1 : 0 }) };
    if (EASY_TOGGLE.test(key)) return { cat: "logic", score: (v) => ({ d: v ? -1 : 0 }) };
  }
  if (/trick/.test(key) && (kind === "set" || kind === "list")) return { cat: "logic", whole: true, score: (v) => ({ d: Math.min(1.5, sizeOf(v) * 0.3) }) };
  if (ENTRANCE.test(key) && MIXED.test(key) && !/start|requirement|cost|weapon|gun|model/.test(key) && (kind === "toggle" || CHOICE_KINDS.includes(kind))) {
    return { cat: "entrance", score: (v) => ({ d: isActive(option, v) ? 1.5 : 0 }) };
  }
  if (/sanity|shuffle|randomi[sz]e/.test(key) && (kind === "toggle" || CHOICE_KINDS.includes(kind))) {
    // Ennemis et boss mélangés : plus durs, pas plus longs ; prix et point de départ : ni l'un ni l'autre.
    if (/(enem(y|ies)|boss(es)?|monsters?)(_shuffle|_rando\w*|_randomi[sz]\w*)?$/.test(key) && !/sanity/.test(key)) return { cat: "logic", score: (v) => ({ d: isActive(option, v) ? 0.5 : 0 }) };
    if (/price|cost|start/.test(key)) return null;
    const more = /sanity/.test(key) ? 0.5 : 0.3; // les « …sanity » ajoutent des lieux à visiter
    return { cat: "shuffle", score: (v) => (isActive(option, v) ? { l: more, ...(REMOTE.test(String(v)) && { d: 0.4, flag: "remote" }) } : {}) };
  }
  if (RANGE_KINDS.includes(kind)) {
    if (/difficult|hardness|enemy_(damage|health|hp)|damage_taken/.test(key)) return { cat: "logic", score: (v) => ({ d: position(option, v) * 3 }) };
    if (/required|needed|goal|to_win|to_complete|requirement/.test(key) && !/filler|exclude/.test(key)) {
      return { cat: "goal", score: (v) => ({ l: position(option, v) * 3 }) };
    }
    return null;
  }
  if (CHOICE_KINDS.includes(kind)) {
    // Ordre des choix (du plus facile au plus dur, le plus souvent) quand les valeurs ne disent rien d'elles-mêmes.
    const ordered = /difficult|skill_level|precision|obscurity|(^|_)logic(_level|_mode|_type|_rules)?$/.test(key) && option.choices?.length > 1;
    const rank = (v) => option.choices.findIndex((c) => c.value === v);
    const glitchy = option.choices?.some((c) => GLITCH(c.value.toLowerCase()) || NO_LOGIC.test(c.value.toLowerCase()));
    return {
      cat: glitchy ? "glitch" : "logic",
      score: (v) => {
        const text = String(v).toLowerCase();
        if (NO_LOGIC.test(text)) return { d: 3, flag: "nologic" };
        if (GLITCH(text)) return { d: /minor|light/.test(text) ? 1 : 2, flag: "glitch" };
        const level = wordLevel(text);
        if (level !== null) return { d: level, ...(REMOTE.test(text) && { flag: "remote" }) };
        if (REMOTE.test(text)) return { d: 0.4, flag: "remote" };
        if (ordered && rank(v) >= 0) return { d: (rank(v) / (option.choices.length - 1)) * 1.5, ordinal: true };
        return {};
      },
    };
  }
  return null;
}

// Note moyenne d'une valeur (sur toutes ses issues), ses drapeaux et si le tirage au sort change la note.
function average(option, rule, value) {
  if (rule.whole) {
    const s = rule.score(value === undefined ? option.default : value);
    return { d: s.d || 0, l: s.l || 0, flags: new Set(s.flag ? [s.flag] : []), spread: false };
  }
  const list = outcomes(option, value).map((o) => ({ ...rule.score(o.value), weight: o.weight }));
  const total = list.reduce((sum, o) => sum + o.weight, 0) || 1;
  const sum = (axis) => list.reduce((s, o) => s + (o[axis] || 0) * o.weight, 0) / total;
  const key = (o) => `${o.d || 0}|${o.l || 0}`;
  return { d: sum("d"), l: sum("l"), flags: new Set(list.map((o) => o.flag).filter(Boolean)), spread: new Set(list.map(key)).size > 1 };
}

// Limites par catégorie : dix options de pièges ne font pas un jeu dix fois plus dur.
const CAPS = {
  logic: { d: [-2, 3] }, glitch: { d: [0, 3] }, trap: { d: [-1, 1.5] }, goal: { l: [-2, 2] }, entrance: { d: [0, 2] },
  shuffle: { d: [0, 1], l: [-1.5, 2] }, deathlink: { d: [0, 1] }, balancing: { d: [-0.5, 0.5], l: [0, 0.5] },
  start: { d: [-1.5, 0] }, locality: { d: [-0.5, 0.5] },
};

const FACTOR_TEXT = {
  logic: ["Logique, ennemis ou réglages plus exigeants", "Réglages plus faciles que ceux par défaut"],
  glitch: ["Glitchs ou absence de logique", ""],
  trap: ["Plus de pièges", "Moins de pièges"],
  goal: ["Objectif plus long à atteindre", "Objectif plus court"],
  entrance: ["Entrées mélangées : on se repère moins bien", ""],
  shuffle: ["Plus de lieux et d'objets mélangés", "Moins de lieux mélangés"],
  "shuffle.d": ["Objets clés de votre jeu éparpillés, parfois chez les autres", ""],
  deathlink: ["DeathLink : les morts des autres joueurs vous tuent aussi", ""],
  balancing: ["Équilibrage de la progression bas : plus d'attente avant les objets clés", "Équilibrage de la progression élevé : objets clés plus tôt"],
  start: ["", "Aides au départ (objets, indices)"],
  locality: ["Objets forcés chez les autres : vous dépendez plus d'eux", "Objets gardés chez vous : vous dépendez moins des autres"],
};

const optionLabel = (option) => COMMON_TEXT[option.key]?.[0] || option.name || option.key;
const clamp = (x, [lo, hi]) => Math.min(hi, Math.max(lo, x));

// --- Risques -----------------------------------------------------------------------------
// { level: "error" | "warn" | "info", text, scope } ; `scope` : "others" si la partie des autres joueurs peut en pâtir,
// "generation" si la génération peut échouer, "self" sinon. `check` : déjà signalé par la vérification de la room (check.js).

function listOf(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

function gameRisks(game, section, data, entry, flags) {
  const risks = [];
  const value = (key) => section[key] ?? data.options.get(key)?.default;
  const names = (list) => list.slice(0, 5).join(", ") + (list.length > 5 ? `… (${list.length})` : "");

  if (flags.has("nologic")) {
    risks.push({ level: "warn", scope: "others", text: "Sans logique (no logic) : la partie peut être impossible à finir, et des objets des autres joueurs placés chez vous peuvent rester hors d'atteinte." });
  }
  if (flags.has("glitch")) {
    risks.push({ level: "warn", scope: "others", text: "Glitchs dans la logique : des objets, y compris ceux des autres joueurs, peuvent demander ces glitchs. Sans les maîtriser, vous risquez de bloquer toute la partie." });
  }
  if (flags.has("remote")) {
    risks.push({ level: "info", scope: "self", text: "Des objets clés de votre jeu (clés, etc.) peuvent être chez les autres : vous dépendrez plus de leur avancée." });
  }
  const accessibility = data.options.get("accessibility");
  if (accessibility && outcomes(accessibility, section.accessibility).some((o) => o.value === "minimal")) {
    risks.push({ level: "info", scope: "others", text: "Accessibilité minimale : une partie des lieux peut rester inaccessible, et des objets d'autres joueurs (non indispensables à leur objectif) peuvent s'y perdre." });
  }

  const local = new Set(listOf(value("local_items")));
  const both = listOf(value("non_local_items")).filter((i) => local.has(i));
  if (both.length) risks.push({ level: "warn", scope: "self", text: `Objets à la fois gardés chez vous et envoyés aux autres : ${names(both)}. Archipelago les gardera chez vous.` });

  const excluded = listOf(value("exclude_locations"));
  const priority = new Set(listOf(value("priority_locations")));
  const conflict = excluded.filter((l) => priority.has(l));
  if (conflict.length) risks.push({ level: "warn", scope: "self", text: `Lieux à la fois exclus et prioritaires : ${names(conflict)}. Un lieu ne peut pas être les deux.` });

  // Trop de lieux exclus : plus assez de places pour les objets importants, et la génération échoue (FillError).
  const groups = new Set(data.location_groups || []);
  if (excluded.some((l) => l.toLowerCase() === "everywhere")) {
    risks.push({ level: "error", scope: "generation", text: "« Everywhere » est dans les lieux exclus : plus aucun lieu ne peut recevoir d'objet important, la génération échouera." });
  } else if (data.locations?.length) {
    const plain = excluded.filter((l) => !groups.has(l)).length;
    const viaGroups = excluded.filter((l) => groups.has(l));
    const share = plain / data.locations.length;
    if (share >= 0.5) {
      risks.push({ level: "warn", scope: "generation", text: `${plain} lieux exclus sur ${data.locations.length} : s'il ne reste pas assez de lieux pour les objets importants, la génération échouera.` });
    } else if (viaGroups.length && plain + viaGroups.length * 10 >= data.locations.length * 0.5) {
      risks.push({ level: "info", scope: "generation", text: `Groupes de lieux exclus (${names(viaGroups)}) : s'ils couvrent une grande partie du jeu, la génération peut échouer faute de place pour les objets importants.` });
    }
  }

  // Objectif qui demande plus qu'il n'en existe (« pieces_required » au-dessus de « pieces_available »). Une paire dont
  // les valeurs par défaut ne respectent pas déjà cet ordre se lit autrement (pourcentage, 0 = automatique) : ignorée.
  for (const option of data.options.values()) {
    const match = /^(.*?)_?(required|needed)$/.exec(option.key);
    if (!match || !RANGE_KINDS.includes(option.kind) || /percent/i.test(`${option.key} ${option.name}`)) continue;
    const stem = match[1];
    for (const suffix of ["available", "total", "in_pool", "amount", "count"]) {
      const other = data.options.get(stem ? `${stem}_${suffix}` : suffix);
      if (!other || !RANGE_KINDS.includes(other.kind)) continue;
      if (!(scalar(option, option.default) <= scalar(other, other.default))) continue;
      const need = outcomes(option, section[option.key]), have = outcomes(other, section[other.key]);
      const maxNeed = Math.max(...need.map((o) => o.value)), minHave = Math.min(...have.map((o) => o.value));
      if (Number.isFinite(maxNeed) && Number.isFinite(minHave) && maxNeed > minHave) {
        risks.push({ level: "warn", scope: "self", text: `${optionLabel(option)} (${maxNeed}) dépasse ${optionLabel(other)} (${minHave}) : selon les autres réglages, l'objectif risque d'être impossible ou d'être ajusté par le jeu.` });
      }
    }
  }

  const stability = entry?.sheet?.stability;
  if (stability === "Broken on Main") risks.push({ level: "error", scope: "others", check: true, text: "Jeu signalé cassé sur la version actuelle d'Archipelago." });
  else if (stability === "Unstable") risks.push({ level: "warn", scope: "others", check: true, text: "Jeu signalé instable : un bug peut bloquer la partie." });
  if (entry?.rom) risks.push({ level: "info", scope: "self", check: true, text: "Ce jeu demande sa ROM pour générer : la génération en ligne est impossible, l'hôte devra générer chez lui." });
  const order = { error: 0, warn: 1, info: 2 };
  return risks.sort((a, b) => order[a.level] - order[b.level]);
}

// --- Prévision d'un jeu, d'un YAML, d'une room ----------------------------------------------

// Notes d'une section : { difficulty, length, factors, flags, random }.
function score(section, data) {
  const sums = new Map();
  const flags = new Set();
  const random = [];
  for (const option of data.options.values()) {
    if (option.kind === "removed" || section[option.key] === undefined) continue;
    const rule = ruleFor(option);
    if (!rule) continue;
    const now = average(option, rule, section[option.key]);
    const base = average(option, rule, undefined);
    for (const flag of now.flags) if (!base.flags.has(flag)) flags.add(flag);
    if (now.spread && !rule.whole) random.push(optionLabel(option));
    for (const axis of ["d", "l"]) {
      const delta = now[axis] - base[axis];
      if (Math.abs(delta) < 0.05) continue;
      const id = `${rule.cat}|${axis}`;
      const sum = sums.get(id) || { cat: rule.cat, axis, delta: 0, options: [] };
      sum.delta += delta;
      sum.options.push({ name: optionLabel(option), delta });
      sums.set(id, sum);
    }
  }
  const factors = [...sums.values()].map((f) => ({ ...f, delta: CAPS[f.cat]?.[f.axis] ? clamp(f.delta, CAPS[f.cat][f.axis]) : f.delta }))
    .filter((f) => Math.abs(f.delta) >= 0.1)
    .map((f) => ({
      ...f,
      text: (FACTOR_TEXT[`${f.cat}.${f.axis}`] || FACTOR_TEXT[f.cat])[f.delta > 0 ? 0 : 1],
      options: f.options.filter((o) => Math.sign(o.delta) === Math.sign(f.delta)).map((o) => o.name),
    }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const total = (axis) => factors.filter((f) => f.axis === axis).reduce((s, f) => s + f.delta, 0);
  return { difficulty: total("d"), length: total("l"), factors, flags, random: [...new Set(random)] };
}

// { game, difficulty, length, level, lengthLevel, factors, random, risks }
export function forecastGame(game, section, data, entry = gameEntry(game)) {
  const { difficulty, length, factors, flags, random } = score(section, data);
  return {
    game, difficulty, length, level: difficultyLevel(difficulty), lengthLevel: lengthLevel(length),
    factors, random, risks: gameRisks(game, section, data, entry, flags),
  };
}

// --- Réglages pour viser un niveau ------------------------------------------------------------
//
// On change une option à la fois, en gardant à chaque pas celle qui rapproche le plus du niveau visé (le centre de
// sa plage) en bougeant le moins l'autre axe. Seules les options de jeu « sûres » sont touchées : ni glitchs ni
// absence de logique, ni DeathLink, équilibrage ou objets envoyés aux autres (ils engagent les autres joueurs),
// ni objets de départ (le site ne choisit pas d'objets à la place du joueur).

const TARGETS = { d: [-2.6, -1.4, 0, 1.75, 3.25, 4.5], l: [-2.6, -1.4, 0, 1.6, 3] };
const ADJUSTABLE = { logic: 0, trap: 0.1, goal: 0, shuffle: 0.15, entrance: 0.5 };
const MAX_CHANGES = 8;

// Valeurs à essayer pour une option : chaque choix, oui/non, et quelques crans d'un intervalle.
function candidates(option) {
  if (option.kind === "toggle") return [true, false];
  if (CHOICE_KINDS.includes(option.kind)) return (option.choices || []).map((c) => c.value).filter((v) => v !== "random");
  if (RANGE_KINDS.includes(option.kind) && option.min != null && option.max != null) {
    const steps = [0, 0.1, 0.25, 0.5, 0.75, 1].map((t) => Math.round(option.min + t * (option.max - option.min)));
    const def = scalar(option, option.default);
    return [...new Set([...steps, ...(Number.isFinite(def) ? [def] : [])])];
  }
  return [];
}

// { changes: [{ key, name, from, to, value }], level, reached } : `value`, à écrire dans le YAML.
export function suggestSettings(section, data, axis, target) {
  const levelOf = axis === "d" ? difficultyLevel : lengthLevel;
  const other = axis === "d" ? "length" : "difficulty";
  const mine = axis === "d" ? "difficulty" : "length";
  const goal = TARGETS[axis][target];
  const moves = [];
  for (const option of data.options.values()) {
    const rule = ruleFor(option);
    if (!rule || rule.whole || !(rule.cat in ADJUSTABLE) || option.kind === "removed" || !option.visibility) continue;
    // Options de la page simple d'abord : celles que le joueur connaît.
    const cost = ADJUSTABLE[rule.cat] + ((option.visibility & 2) === 2 ? 0 : 0.2);
    for (const value of candidates(option)) {
      const s = rule.score(value);
      if (s.flag) continue;
      moves.push({ option, value, cost });
    }
  }

  // Une proposition ne doit pas créer de risque (objectif au-dessus du disponible, trop de lieux exclus…).
  const risky = (sec, s) => gameRisks(null, sec, data, null, s.flags).filter((r) => r.level !== "info").length;
  let current = { ...section };
  let now = score(current, data);
  const allowed = risky(current, now);
  const chosen = new Map();
  const banned = new Set();
  for (let step = 0; step < MAX_CHANGES && levelOf(now[mine]) !== target; step++) {
    const distance = Math.abs(now[mine] - goal);
    let best = null;
    for (const move of moves) {
      if (banned.has(move) || (chosen.has(move.option.key) && chosen.get(move.option.key) === move.value)) continue;
      const next = score({ ...current, [move.option.key]: move.value }, data);
      if (next.flags.size > now.flags.size) continue;
      const gain = distance - Math.abs(next[mine] - goal);
      if (gain < 0.1) continue;
      const rank = Math.abs(next[mine] - goal) + move.cost + 0.5 * Math.abs(next[other] - now[other]);
      if (!best || rank < best.rank) best = { ...move, next, rank };
    }
    if (!best) break;
    if (risky({ ...current, [best.option.key]: best.value }, best.next) > allowed) {
      banned.add(moves.find((m) => m.option === best.option && m.value === best.value));
      step--;
      continue;
    }
    current = { ...current, [best.option.key]: best.value };
    chosen.set(best.option.key, best.value);
    now = best.next;
  }

  const shown = (option, value) => {
    if (value === undefined) value = option.default;
    const single = singleValue(option, value);
    return single.single ? describeScalar(option, single.value) : "Tirage au sort";
  };
  const changes = [...chosen].map(([key, value]) => {
    const option = data.options.get(key);
    return { key, name: optionLabel(option), from: shown(option, section[key]), to: describeScalar(option, value), value: writeSingle(option, section[key], value) };
  }).filter((c) => c.from !== c.to);
  return {
    changes, level: levelOf(now[mine]), reached: levelOf(now[mine]) === target,
    after: { level: difficultyLevel(now.difficulty), lengthLevel: lengthLevel(now.length) },
  };
}

// Jeux choisis par le champ `game` (un jeu, ou plusieurs tirés au sort) : les autres sections ne servent pas.
function pickedGames(js) {
  if (typeof js.game === "string") return [js.game];
  if (isPlainObject(js.game)) return Object.entries(js.game).filter(([, w]) => Number(w) > 0).map(([g]) => g);
  return [];
}

// { games: [prévision | { game, missing: true }], worst } : `worst`, le jeu le plus exigeant (pour un résumé).
export function forecastDoc(js) {
  const games = pickedGames(js).map((game) => {
    const data = cachedGame(game);
    if (!data) return { game, missing: true };
    return forecastGame(game, isPlainObject(js[game]) ? js[game] : {}, data);
  });
  const known = games.filter((g) => !g.missing);
  const worst = known.reduce((a, b) => (!a || b.difficulty > a.difficulty ? b : a), null);
  return { games, worst, random: games.length > 1 };
}

// Prévision de toute la room avant génération. `entries` : [{ name, pseudo, js }] (YAML lisibles).
// { players: [{ name, pseudo, forecast }], notes: [{ level, text }] }
export function forecastRoom(entries, { mode } = {}) {
  const players = entries.map((e) => ({ ...e, forecast: forecastDoc(e.js) }));
  const notes = [];
  const solo = players.length === 1;
  const known = players.filter((p) => p.forecast.worst);

  if (known.length) {
    const byLevel = new Map();
    for (const p of known) {
      const level = p.forecast.worst.level;
      byLevel.set(level, [...(byLevel.get(level) || []), p.name]);
    }
    const spread = [...byLevel.entries()].sort((a, b) => b[0] - a[0]).map(([level, names]) => `${DIFFICULTY_LEVELS[level]} : ${names.join(", ")}`);
    notes.push({ level: "info", text: `Difficulté estimée, par rapport aux réglages par défaut de chaque jeu — ${spread.join(" ; ")}.` });
  }

  // Ce qui, chez un joueur, peut faire échouer la génération ou bloquer les autres (objets des autres hors d'atteinte).
  const scopes = solo ? ["generation"] : ["generation", "others"];
  for (const p of known) {
    for (const g of p.forecast.games.filter((g) => !g.missing)) {
      for (const r of g.risks.filter((r) => scopes.includes(r.scope) && !r.check && r.level !== "info")) {
        notes.push({ level: r.level, text: `${p.name} (${g.game}) — ${r.text}` });
      }
    }
  }
  if (solo && known.some((p) => p.forecast.games.some((g) => !g.missing && sizeOf(p.js[g.game]?.non_local_items)))) {
    notes.push({ level: "info", text: "Un seul joueur : « Objets envoyés aux autres » est ignoré par Archipelago." });
  }

  // Équilibrage à 0 : les objets clés de ce joueur peuvent arriver tard dans la partie des autres.
  const unbalanced = known.filter((p) => p.forecast.games.some((g) => !g.missing && g.factors.some((f) => f.cat === "balancing" && f.delta > 0)));
  if (!solo && unbalanced.length) {
    notes.push({ level: "info", text: `Équilibrage de la progression bas pour ${unbalanced.map((p) => p.name).join(", ")} : attendez-vous à des moments d'attente (BK) pour ${unbalanced.length > 1 ? "eux" : "ce joueur"}.` });
  }

  // En sync, les durées très différentes laissent des joueurs attendre la fin des autres.
  const lengths = known.map((p) => p.forecast.worst.lengthLevel);
  if (mode === "sync" && lengths.length > 1 && Math.max(...lengths) - Math.min(...lengths) >= 2) {
    const sorted = [...known].sort((a, b) => b.forecast.worst.lengthLevel - a.forecast.worst.lengthLevel);
    const list = sorted.map((p) => `${p.name} (${LENGTH_LEVELS[p.forecast.worst.lengthLevel].toLowerCase()})`).join(", ");
    notes.push({ level: "info", text: `Durées estimées très inégales — ${list} : ceux qui finissent tôt attendront les autres.` });
  }

  // Item links : un lien n'a d'effet qu'entre plusieurs joueurs du même jeu.
  const links = new Map();
  for (const p of players) {
    for (const game of pickedGames(p.js)) {
      const list = p.js[game]?.item_links;
      if (!Array.isArray(list)) continue;
      for (const link of list) if (isPlainObject(link) && link.name) links.set(`${game}|${link.name}`, [...(links.get(`${game}|${link.name}`) || []), p.name]);
    }
  }
  for (const [id, names] of links) {
    if (names.length < 2) notes.push({ level: "info", text: `Item link « ${id.split("|").slice(1).join("|")} » : seul ${names[0]} l'utilise dans son jeu, il n'aura pas d'effet.` });
  }

  const random = known.filter((p) => p.forecast.games.some((g) => g.random?.length) || p.forecast.random).map((p) => p.name);
  if (random.length) notes.push({ level: "info", text: `Tirages au sort chez ${random.join(", ")} : la difficulté réelle dépendra du tirage.` });
  return { players, notes };
}

// --- Affichage ---------------------------------------------------------------------------
// Chaque niveau est écrit en toutes lettres : la jauge et les couleurs ne portent jamais seules l'information.

const AXES = {
  d: { label: "Difficulté", levels: DIFFICULTY_LEVELS, current: (f) => f.level, noun: "une difficulté" },
  l: { label: "Durée", levels: LENGTH_LEVELS, current: (f) => f.lengthLevel, noun: "une durée" },
};

// Jauge en lecture seule (sans `onTarget`), ou curseur : le déplacer choisit un niveau à viser.
function Meter({ axis, level, target, onTarget }) {
  const { label, levels } = AXES[axis];
  const shown = target ?? level;
  const text = target != null ? `${levels[level]} → ${levels[target]}` : levels[level];
  return html`<div class="meter-row">
    <span class="meter-label">${label}</span>
    <strong class="meter-value">${text}</strong>
    ${onTarget
      ? html`<input type="range" class="meter-slider" min="0" max=${levels.length - 1} step="1" value=${shown}
          aria-label=${`${label} visée`} aria-valuetext=${levels[shown]}
          onInput=${(e) => { const next = Number(e.target.value); onTarget(next === level ? null : next); }} />`
      : html`<span class="meter" aria-hidden="true">${levels.map((_, i) => html`<span class=${i <= level ? "on" : ""}></span>`)}</span>`}
  </div>`;
}

// Réglages proposés pour atteindre le niveau visé, à appliquer d'un clic.
function Proposal({ forecast, section, data, axis, target, onApply, onCancel }) {
  const { levels, noun } = AXES[axis];
  const key = JSON.stringify(section);
  const result = useMemo(() => suggestSettings(section, data, axis, target), [key, axis, target]);
  const other = axis === "d" ? "l" : "d";
  const otherBefore = AXES[other].current(forecast);
  const otherAfter = other === "d" ? result.after.level : result.after.lengthLevel;
  return html`<div class="proposal stack full" role="region" aria-label="Réglages proposés">
    ${result.changes.length === 0
      ? html`<p>Aucune option reconnue de ce jeu ne permet de viser ${noun} « ${levels[target]} ».</p>`
      : html`<p>Pour viser ${noun} « ${levels[target]} », changer :</p>
        <ul class="factors">${result.changes.map((c) => html`<li><strong>${c.name}</strong> : ${c.from} → ${c.to}</li>`)}</ul>
        ${!result.reached && html`<p class="hint">Ces réglages n'atteignent que « ${levels[result.level]} » : le site ne reconnaît
          pas assez d'options de ce jeu pour aller plus loin.</p>`}
        ${otherAfter !== otherBefore && html`<p class="hint">${AXES[other].label} aussi : ${AXES[other].levels[otherBefore]} → ${AXES[other].levels[otherAfter]}.</p>`}`}
    <div class="row">
      ${result.changes.length > 0 && html`<button type="button" onClick=${() => onApply(result.changes)}>Appliquer ces réglages</button>`}
      <button type="button" class="ghost" onClick=${onCancel}>Annuler</button>
    </div>
  </div>`;
}

const RISK_PREFIX = { error: "Bloquant", warn: "Attention", info: "À savoir" };

export function RiskList({ risks }) {
  return html`<ul class="check-notes risks full">${risks.map((r) => html`<li class=${r.level}>
    <strong>${RISK_PREFIX[r.level]} :</strong> ${r.text}</li>`)}</ul>`;
}

const factorSign = (f) => (f.axis === "d" ? (f.delta > 0 ? "Plus dur" : "Plus facile") : f.delta > 0 ? "Plus long" : "Plus court");

function GameForecast({ forecast, title, section, data, onApply }) {
  const { risks, random } = forecast;
  const [target, setTarget] = useState(null); // { axis, level }
  const slider = (axis) => onApply && ((level) => setTarget(level == null ? null : { axis, level }));
  // Un même facteur sur les deux axes (équilibrage bas : plus dur et plus long) tient sur une ligne.
  const factors = [];
  for (const f of forecast.factors) {
    const same = factors.find((g) => g.text === f.text);
    if (same) same.sign += ` et ${factorSign(f).toLowerCase()}`;
    else factors.push({ ...f, sign: factorSign(f) });
  }
  return html`<div class="forecast-game stack full">
    ${title && html`<h3>${title}</h3>`}
    <div class="meters">
      ${["d", "l"].map((axis) => html`<${Meter} axis=${axis} level=${AXES[axis].current(forecast)}
        target=${target?.axis === axis ? target.level : null} onTarget=${slider(axis)} />`)}
    </div>
    ${onApply && !target && html`<p class="hint">Déplacez un curseur pour viser un autre niveau : le site propose les options à changer.</p>`}
    ${target && html`<${Proposal} forecast=${forecast} section=${section} data=${data} axis=${target.axis} target=${target.level}
      onApply=${(changes) => { onApply(changes); setTarget(null); }} onCancel=${() => setTarget(null)} />`}
    ${risks.length > 0 && html`<${RiskList} risks=${risks} />`}
    ${random.length > 0 && html`<p class="hint">Tirage au sort sur ${random.join(", ")} : la difficulté réelle dépendra du tirage.</p>`}
    ${factors.length > 0
      ? html`<details class="issues full"><summary>Ce qui pèse dans l'estimation (${factors.length})</summary>
        <ul class="factors">${factors.map((f) => html`<li><strong>${f.sign}</strong> — ${f.text}
          ${f.options.length > 0 && html`<span class="hint"> (${f.options.join(", ")})</span>`}</li>`)}</ul></details>`
      : html`<p class="hint">Réglages proches de ceux par défaut du jeu.</p>`}
  </div>`;
}

// Carte de l'éditeur : recalculée à chaque changement d'option. `update(path, value)` : écrit une option du YAML.
export function ForecastCard({ js, update }) {
  const forecast = forecastDoc(js);
  if (!forecast.games.length) return null;
  const several = forecast.games.length > 1;
  return html`<section class="card forecast stack">
    <h2>Prévision avant génération</h2>
    ${several && html`<p class="hint">Jeu tiré au sort : une prévision par jeu possible.</p>`}
    ${forecast.games.map((g) => g.missing
      ? html`<p class="hint">${g.game} : options non disponibles, pas de prévision.</p>`
      : html`<${GameForecast} key=${g.game} forecast=${g} title=${several ? g.game : null}
          section=${isPlainObject(js[g.game]) ? js[g.game] : {}} data=${cachedGame(g.game)}
          onApply=${update && ((changes) => changes.forEach((c) => update([g.game, c.key], c.value)))} />`)}
    <p class="hint">Estimation par rapport aux réglages par défaut du jeu, d'après les noms et valeurs des options : ni la difficulté
      propre au jeu ni sa logique ne sont connues du site. Seule la génération dira si la partie est possible.</p>
  </section>`;
}

// Résumé d'un joueur dans la vérification de la room.
export function ForecastSummary({ forecast }) {
  const g = forecast?.worst;
  if (!g) return html`<span class="hint">—</span>`;
  const shown = g.risks.filter((r) => r.level !== "info" && !r.check);
  return html`<div class="forecast-summary">
    <span>${DIFFICULTY_LEVELS[g.level]}</span><span class="hint"> · durée ${LENGTH_LEVELS[g.lengthLevel].toLowerCase()}</span>
    ${shown.length > 0 && html`<details class="issues"><summary><span class="badge warn">${shown.length > 1 ? `${shown.length} risques` : "1 risque"}</span></summary>
      <ul>${shown.map((r) => html`<li>${r.text}</li>`)}</ul></details>`}
  </div>`;
}
