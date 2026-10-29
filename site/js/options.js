// Règles des types d'options d'Archipelago (voir Options.py) : valeurs acceptées,
// vérifications et comparaison avec la valeur par défaut.
import { isPlainObject } from "./yaml-model.js";

const TOGGLE_TRUE = new Set(["true", "on", "1", "yes", "enabled"]);
const TOGGLE_FALSE = new Set(["false", "off", "0", "no", "none", "null", "disabled"]);
const RANDOM_WORDS = ["random", "random-low", "random-middle", "random-high"];
const RANDOM_RANGE = /^random-range(?:-(low|middle|high))?-(-?\d+)-(-?\d+)$/;

export const RANDOM_LABELS = {
  random: "Aléatoire",
  "random-low": "Aléatoire (plutôt bas)",
  "random-middle": "Aléatoire (plutôt au milieu)",
  "random-high": "Aléatoire (plutôt haut)",
};

export function parseRandomRange(value) {
  const match = RANDOM_RANGE.exec(String(value));
  if (!match) return null;
  const a = Number(match[2]);
  const b = Number(match[3]);
  return { bias: match[1] || null, min: Math.min(a, b), max: Math.max(a, b) };
}

export function isWeightedValue(option, value) {
  return option.weighted && isPlainObject(value);
}

// Clés autorisées pour les listes / dictionnaires, comme VerifyKeys.verify :
// si l'option a des valid_keys, seules celles-ci passent ; sinon les noms d'objets ou de lieux
// (et leurs groupes quand l'option les accepte).
export function keyUniverse(option, game) {
  if (option.valid_keys && option.valid_keys.length) return option.valid_keys;
  if (!game) return [];
  if (option.key_source === "items") return [...(option.name_groups ? game.item_groups : []), ...game.items];
  if (option.key_source === "locations") return [...(option.name_groups ? game.location_groups : []), ...game.locations];
  return [];
}

export function toggleState(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).toLowerCase();
  if (TOGGLE_TRUE.has(text)) return true;
  if (TOGGLE_FALSE.has(text)) return false;
  return null;
}

// Nom canonique d'un choix (gère les alias et les identifiants numériques).
export function resolveChoice(option, value) {
  if (typeof value === "number") {
    const byId = option.choices.find((c) => c.id === value);
    if (byId) return byId.value;
  }
  if (typeof value === "boolean") value = String(value);
  const text = String(value).toLowerCase();
  const direct = option.choices.find((c) => c.value.toLowerCase() === text);
  if (direct) return direct.value;
  if (option.aliases && text in option.aliases) return option.aliases[text];
  return null;
}

function checkScalar(option, value) {
  const text = String(value).toLowerCase();
  switch (option.kind) {
    case "toggle":
      if (text === "random" || toggleState(value) !== null) return null;
      return `« ${value} » n'est pas une valeur oui/non valide.`;
    case "choice":
      if (text === "random" || resolveChoice(option, value) !== null) return null;
      return `« ${value} » ne fait pas partie des choix possibles.`;
    case "range":
    case "named_range": {
      if (RANDOM_WORDS.includes(text)) return null;
      const range = parseRandomRange(text);
      if (range) {
        if (range.min < option.min || range.max > option.max) {
          return `L'intervalle aléatoire ${range.min}-${range.max} dépasse les limites ${option.min}-${option.max}.`;
        }
        return null;
      }
      const special = option.special || {};
      if (text in special) return null;
      const number = Number(value);
      if (value === "" || !Number.isInteger(number)) return `« ${value} » n'est pas un nombre entier.`;
      if (Object.values(special).includes(number)) return null;
      if (number < option.min || number > option.max) return `${number} est hors des limites (${option.min} à ${option.max}).`;
      return null;
    }
    default:
      return null;
  }
}

export function checkValue(option, value, game) {
  if (value === undefined) return [];
  if (option.kind === "removed") return ["Cette option n'existe plus dans la version actuelle du jeu : elle sera ignorée."];
  if (sameAsDefault(option, value)) return [];
  const problems = [];
  if (option.weighted) {
    if (isPlainObject(value)) {
      const entries = Object.entries(value);
      if (!entries.some(([, w]) => Number(w) > 0)) problems.push("Aucune valeur n'a un poids supérieur à 0.");
      for (const [key, weight] of entries) {
        if (typeof weight !== "number" || weight < 0) problems.push(`Le poids de « ${key} » doit être un nombre positif.`);
        const problem = checkScalar(option, key);
        if (problem) problems.push(problem);
      }
    } else if (Array.isArray(value)) {
      problems.push("Une liste n'est pas attendue ici.");
    } else {
      const problem = checkScalar(option, value);
      if (problem) problems.push(problem);
    }
    return problems;
  }

  const fold = (k) => (option.casefold ? String(k).toLowerCase() : String(k));
  const known = new Set(keyUniverse(option, game).map(fold));
  const unknownKeys = (keys) => (known.size ? keys.filter((k) => !known.has(fold(k))) : []);
  if (option.kind === "set" || option.kind === "list") {
    if (typeof value === "string" && value.toLowerCase().startsWith("random")) return [];
    if (!Array.isArray(value)) return ["Une liste de valeurs est attendue."];
    const unknown = unknownKeys(value);
    if (unknown.length) problems.push(`Valeurs inconnues : ${unknown.join(", ")}`);
  } else if (option.kind === "counter" || option.kind === "dict") {
    if (!isPlainObject(value)) return ["Un dictionnaire (clé : valeur) est attendu."];
    const unknown = unknownKeys(Object.keys(value));
    if (unknown.length) problems.push(`Clés inconnues : ${unknown.join(", ")}`);
    if (option.kind === "counter") {
      for (const [key, count] of Object.entries(value)) {
        if (!Number.isInteger(count)) problems.push(`« ${key} » doit avoir un nombre entier.`);
        else if (option.min != null && count < option.min) problems.push(`« ${key} » : minimum ${option.min}.`);
        else if (option.max != null && count > option.max) problems.push(`« ${key} » : maximum ${option.max}.`);
      }
    }
  }
  return problems;
}

function normalize(option, value) {
  if (option.kind === "toggle" && !isPlainObject(value)) return toggleState(value) ?? value;
  if (option.kind === "choice" && !isPlainObject(value)) return resolveChoice(option, value) ?? value;
  if (["range", "named_range"].includes(option.kind) && !isPlainObject(value)) {
    const special = option.special || {};
    if (typeof value === "string" && value.toLowerCase() in special) return special[value.toLowerCase()];
    return /^-?\d+$/.test(String(value)) ? Number(value) : value;
  }
  if (option.kind === "set" && Array.isArray(value)) return [...value].map(String).sort();
  return value;
}

export function sameAsDefault(option, value) {
  if (value === undefined) return true;
  if (option.default === null || option.default === undefined) return false;
  // Une table de poids avec une seule valeur active vaut cette valeur.
  const single = singleValue(option, value);
  if (single.single && single.value !== undefined && isPlainObject(value)) value = single.value;
  return JSON.stringify(normalize(option, value)) === JSON.stringify(normalize(option, option.default));
}

// Valeur affichée quand l'option est absente du fichier.
export function defaultValue(option) {
  const value = option.default;
  if (Array.isArray(value)) return [...value];
  if (isPlainObject(value)) return { ...value };
  return value;
}

// Valeur par défaut telle qu'elle s'écrit dans le YAML (oui/non en booléen).
export function yamlDefault(option) {
  if (option.kind === "toggle") return option.default === "true";
  return defaultValue(option);
}

// Commentaire placé au-dessus d'une option ajoutée au fichier : son nom et le début de sa description.
export function yamlComment(option) {
  const paragraph = (option.doc || "").split(/\n\s*\n/)[0].replace(/\*\*|``?/g, "").trim();
  return paragraph ? `${option.name}\n${paragraph}` : option.name;
}

export function describeScalar(option, value) {
  if (value === undefined || value === null) return "—";
  const text = String(value).toLowerCase();
  if (RANDOM_LABELS[text]) return RANDOM_LABELS[text];
  const range = parseRandomRange(text);
  if (range) return `Aléatoire entre ${range.min} et ${range.max}`;
  if (option.kind === "toggle") {
    const state = toggleState(value);
    return state === null ? String(value) : state ? "Oui" : "Non";
  }
  if (option.kind === "choice" || option.kind === "text_choice") {
    const name = resolveChoice(option, value);
    const choice = option.choices.find((c) => c.value === name);
    return choice ? choice.label : String(value);
  }
  if (option.kind === "named_range" && option.special) {
    const entry = Object.entries(option.special).find(([name, number]) => name === text || number === Number(value));
    if (entry) return `${value} (${entry[0]})`;
  }
  return String(value);
}

// --- Valeur unique / table de poids --------------------------------------------
//
// Les modèles d'Archipelago écrivent chaque option comme une table de poids où une seule
// valeur a un poids (`ganon: 50`, `crystals: 0`, `random: 0`…). Pour l'utilisateur c'est
// une valeur unique : on l'affiche comme telle et on réécrit la table en gardant sa forme.

// Clé de table de poids correspondant à une valeur simple.
export function keyForValue(option, value) {
  if (option.kind === "toggle") {
    const state = toggleState(value);
    return state === null ? String(value) : String(state);
  }
  if (option.kind === "choice") return resolveChoice(option, value) ?? String(value);
  return String(value);
}

// Valeur simple représentée par une clé de table de poids.
export function valueForKey(option, key) {
  if (option.kind === "toggle" && toggleState(key) !== null && key !== "random") return toggleState(key);
  if (["range", "named_range"].includes(option.kind) && /^-?\d+$/.test(key)) return Number(key);
  return key;
}

// { single: true, value } si une seule valeur a un poids, { single: false } pour un vrai tirage au sort.
export function singleValue(option, value) {
  if (!option.weighted || !isPlainObject(value)) return { single: true, value };
  const positive = Object.entries(value).filter(([, w]) => Number(w) > 0);
  if (positive.length === 1) return { single: true, value: valueForKey(option, positive[0][0]) };
  if (positive.length === 0) return { single: true, value: undefined };
  return { single: false };
}

function sameValue(option, key, value) {
  const text = String(value).toLowerCase();
  const k = String(key).toLowerCase();
  if (k === text) return true;
  if (option.kind === "toggle") return k !== "random" && text !== "random" && toggleState(k) !== null && toggleState(k) === toggleState(value);
  if (option.kind === "choice") return resolveChoice(option, k) !== null && resolveChoice(option, k) === resolveChoice(option, value);
  if (option.kind === "named_range") {
    const special = option.special || {};
    const number = (v) => (v in special ? special[v] : /^-?\d+$/.test(v) ? Number(v) : NaN);
    return number(k) === number(text);
  }
  return false;
}

// Écrit une valeur unique. Une table de poids existante est conservée : la valeur choisie
// reçoit le poids, les autres passent à 0.
export function writeSingle(option, current, value) {
  if (!option.weighted || !isPlainObject(current)) return value;
  const positive = Object.values(current).map(Number).filter((w) => w > 0);
  const weight = positive.length === 1 ? positive[0] : 50;
  const target = Object.keys(current).find((k) => sameValue(option, k, value)) ?? keyForValue(option, value);
  const out = {};
  for (const key of Object.keys(current)) out[key] = key === target ? weight : 0;
  if (!(target in out)) out[target] = weight;
  return out;
}

// --- Libellés en français pour les options communes à tous les jeux --------------

export const GROUP_NAMES = {
  "Game Options": "Options du jeu",
  "Item & Location Options": "Objets et lieux",
};

export const COMMON_TEXT = {
  progression_balancing: ["Équilibrage de la progression",
    "Avance les objets indispensables dans la partie pour limiter les moments où vous êtes bloqué. 0 = désactivé, 50 = normal, 99 = maximum."],
  accessibility: ["Accessibilité",
    "Ce qui doit rester atteignable. Full : tous les objets et lieux. Items : tous les objets (quelques lieux peuvent rester inaccessibles). Minimal : seulement ce qu'il faut pour finir."],
  death_link: ["Death Link", "Quand un joueur qui a activé Death Link meurt, tous les autres joueurs qui l'ont activé meurent aussi."],
  local_items: ["Objets gardés chez vous", "Ces objets seront forcément placés dans votre propre monde."],
  non_local_items: ["Objets envoyés aux autres", "Ces objets seront forcément placés dans le monde d'autres joueurs."],
  start_inventory: ["Inventaire de départ", "Objets reçus dès le début de la partie."],
  start_inventory_from_pool: ["Inventaire de départ (pris dans le pool)",
    "Objets reçus dès le début, retirés des objets à trouver (remplacés par des objets de remplissage)."],
  start_hints: ["Indices de départ (objets)", "Dès le début, vous savez où se trouvent ces objets."],
  start_location_hints: ["Indices de départ (lieux)", "Dès le début, vous savez ce que contiennent ces lieux."],
  exclude_locations: ["Lieux exclus", "Ces lieux ne contiendront jamais d'objet important."],
  priority_locations: ["Lieux prioritaires", "Ces lieux contiendront de préférence des objets importants."],
  item_links: ["Item links", "Mise en commun d'objets entre plusieurs joueurs du même jeu."],
  plando_items: ["Plando d'objets", "Placement manuel d'objets à des endroits précis."],
};

// --- Langue des descriptions -------------------------------------------------------
//
// Les descriptions des jeux de la base sont traduites automatiquement (tools/translate_docs.py) ;
// l'original anglais reste disponible. Un jeu lu depuis un apworld n'a que l'original.

let docLanguage = "fr";

export function setDocLanguage(language) {
  docLanguage = language;
}

// { text, html, translated } : description à afficher selon la langue choisie.
export function optionDoc(option) {
  if (docLanguage === "fr" && option.doc_fr) {
    return { text: option.doc_fr, html: option.doc_html ? option.doc_html_fr : undefined, translated: true };
  }
  return { text: option.doc || "", html: option.doc_html, translated: false };
}

export function describeDefault(option) {
  if (option.default === null || option.default === undefined) return "—";
  const value = option.default;
  if (option.weighted) return describeScalar(option, value);
  if (Array.isArray(value)) return value.length ? value.join(", ") : "vide";
  if (isPlainObject(value)) return Object.keys(value).length ? `${Object.keys(value).length} entrée(s)` : "vide";
  return value === "" ? "vide" : String(value);
}
