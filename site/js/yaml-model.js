// Lecture / écriture des fichiers YAML de joueurs.
//
// On parse en YAML 1.1 comme PyYAML (utilisé par Archipelago) : `on`, `off`, `yes`…
// deviennent des booléens, exactement comme lors de la génération.
// À l'export on repart du document d'origine et on n'y réécrit que les chemins
// modifiés : les commentaires et la mise en forme du reste du fichier sont conservés.
import * as YAML from "../vendor/yaml.js";

const PARSE_OPTIONS = { version: "1.1", merge: true, uniqueKeys: false };
const STRINGIFY_OPTIONS = { lineWidth: 0, flowCollectionPadding: false };

// Clés de premier niveau qui ne sont pas des sections de jeu.
export const RESERVED_KEYS = new Set(["name", "description", "game", "requires", "triggers", "linked_options"]);

// BOM des modèles Archipelago (utf-8-sig) et fins de ligne Windows.
const cleanText = (text) => text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseFile(text) {
  text = cleanText(text);
  const docs = [];
  const errors = [];
  YAML.parseAllDocuments(text, PARSE_OPTIONS).forEach((doc, index) => {
    for (const error of doc.errors) errors.push(`Document ${index + 1} : ${error.message}`);
    if (doc.errors.length) return;
    const js = doc.toJS({ maxAliasCount: -1 });
    if (js == null) return;
    if (!isPlainObject(js)) {
      errors.push(`Document ${index + 1} : ce n'est pas un YAML de joueur (pas de clés).`);
      return;
    }
    // `original` sert à savoir si une option était déjà écrite dans le fichier.
    docs.push({ source: index, js, original: js, dirty: [] });
  });
  return { docs, errors };
}

// Liste des jeux du document : ceux du champ `game` puis les sections qui portent le nom d'un jeu connu.
export function gamesOf(js, knownGames) {
  const games = [];
  const game = js.game;
  if (typeof game === "string") games.push(game);
  else if (isPlainObject(game)) {
    for (const [name, weight] of Object.entries(game)) if (Number(weight) > 0 || Object.keys(game).length === 1) games.push(name);
  }
  for (const [key, value] of Object.entries(js)) {
    if (!RESERVED_KEYS.has(key) && !games.includes(key) && knownGames.has(key) && (isPlainObject(value) || value == null)) {
      games.push(key);
    }
  }
  return games;
}

export function getIn(obj, path) {
  let current = obj;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

// Copie immuable le long du chemin. `value === undefined` supprime la clé.
export function setIn(obj, path, value) {
  const [key, ...rest] = path;
  const base = isPlainObject(obj) ? obj : {};
  const copy = { ...base };
  if (rest.length === 0) {
    if (value === undefined) delete copy[key];
    else copy[key] = value;
  } else {
    copy[key] = setIn(base[key], rest, value);
  }
  return copy;
}

export function markDirty(doc, path) {
  const id = JSON.stringify(path);
  return doc.dirty.includes(id) ? doc.dirty : [...doc.dirty, id];
}

// Dans une table de poids (`goal: {ganon: 50, 25: 0, true: 10}`), les clés numériques
// et booléennes doivent sortir sans guillemets pour être relues comme le ferait Archipelago.
function unquoteWeightKeys(doc, path) {
  const node = doc.getIn(path, true);
  if (!YAML.isMap(node)) return;
  for (const pair of node.items) {
    if (!YAML.isScalar(pair.key) || typeof pair.key.value !== "string") continue;
    const text = pair.key.value;
    if (/^-?\d+$/.test(text)) pair.key.value = Number(text);
    else if (text === "true" || text === "false") pair.key.value = text === "true";
  }
}

// PyYAML (YAML 1.1) ne lit `9e-7` comme un nombre que s'il y a un point et un signe : `9.0e-7`.
// On corrige les nombres en notation exponentielle placés comme valeurs simples.
const EXP_NUMBER = /(^\s*-\s+|:\s+|[[,]\s*)(-?\d+)(\.\d+)?[eE]([+-]?)(\d+)(?=\s*(?:#.*)?$|\s*[,\]}])/gm;
function fixFloats(text) {
  return text.replace(EXP_NUMBER, (_, before, int, frac, sign, exp) => `${before}${int}${frac || ".0"}e${sign || "+"}${exp}`);
}

function ensureParentMap(doc, path) {
  for (let i = 1; i < path.length; i++) {
    const parentPath = path.slice(0, i);
    const node = doc.getIn(parentPath, true);
    if (!YAML.isMap(node)) doc.setIn(parentPath, doc.createNode({}));
  }
}

const keyText = (node) => String(YAML.isScalar(node) ? node.value : node);

function weightKey(key) {
  if (/^-?\d+$/.test(key)) return Number(key);
  if (key === "true" || key === "false") return key === "true";
  return key;
}

function setScalar(scalar, value) {
  if (scalar.value === value) return;
  if (typeof scalar.value !== typeof value) scalar.type = undefined; // ancien style de guillemets inadapté
  scalar.value = value;
}

function replacementNode(doc, previous, value) {
  const node = doc.createNode(value);
  if (YAML.isCollection(previous) && YAML.isCollection(node)) node.flow = previous.flow;
  return node;
}

// Met à jour une table existante clé par clé : les commentaires du modèle
// (« # equivalent to 50 », descriptions…) restent en place.
function mergeMap(doc, map, value, weights) {
  const remaining = new Map(Object.entries(value));
  map.items = map.items.filter((pair) => {
    const key = keyText(pair.key);
    if (!remaining.has(key)) return false;
    const next = remaining.get(key);
    remaining.delete(key);
    if (YAML.isScalar(pair.value) && (next === null || typeof next !== "object")) setScalar(pair.value, next);
    else if (YAML.isMap(pair.value) && isPlainObject(next)) mergeMap(doc, pair.value, next, false);
    else pair.value = replacementNode(doc, pair.value, next);
    return true;
  });
  for (const [key, next] of remaining) map.items.push(doc.createPair(weights ? weightKey(key) : key, next));
}

function applyPath(doc, path, value, weights) {
  if (value === undefined) {
    if (doc.hasIn(path)) doc.deleteIn(path);
    return;
  }
  ensureParentMap(doc, path);
  const existing = doc.getIn(path, true);
  if (YAML.isMap(existing) && isPlainObject(value)) {
    mergeMap(doc, existing, value, weights);
  } else if (YAML.isScalar(existing) && (value === null || typeof value !== "object")) {
    setScalar(existing, value);
  } else {
    const node = replacementNode(doc, existing, value);
    if (existing && existing.commentBefore) node.commentBefore = existing.commentBefore;
    doc.setIn(path, node);
    if (weights) unquoteWeightKeys(doc, path);
  }
}

// `isWeightPath(path)` indique si la valeur à ce chemin est une option pondérable.
export function exportFile(originalText, docs, isWeightPath) {
  const sources = originalText != null
    ? YAML.parseAllDocuments(cleanText(originalText), PARSE_OPTIONS)
    : [];
  const parts = docs.map((entry) => {
    let doc = sources[entry.source];
    if (!doc) {
      doc = new YAML.Document(entry.js, { version: "1.1" });
      for (const [key, value] of Object.entries(entry.js)) {
        if (isPlainObject(value)) for (const optionKey of Object.keys(value)) {
          if (isWeightPath([key, optionKey])) unquoteWeightKeys(doc, [key, optionKey]);
        }
      }
    } else {
      for (const id of entry.dirty) {
        const path = JSON.parse(id);
        applyPath(doc, path, getIn(entry.js, path), isWeightPath(path));
      }
    }
    return fixFloats(doc.toString(STRINGIFY_OPTIONS));
  });
  return parts
    .map((text, i) => (i > 0 && !text.startsWith("---") ? `---\n${text}` : text))
    .join("");
}

export function toYamlSnippet(value) {
  if (value === undefined) return "";
  return fixFloats(YAML.stringify(value, { ...STRINGIFY_OPTIONS, version: "1.1" })).replace(/\n$/, "");
}

export function parseSnippet(text) {
  const doc = YAML.parseDocument(text, PARSE_OPTIONS);
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  return doc.toJS({ maxAliasCount: -1 });
}
