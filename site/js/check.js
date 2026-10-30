// Vérification d'un YAML de joueur hors de l'éditeur : au dépôt dans une room et pour l'hôte,
// avec les mêmes règles que l'éditeur (options inconnues, valeurs invalides, versions).
import { parseFile, gamesOf, getIn, isPlainObject } from "./yaml-model.js";
import { apVersion, cachedGame, compareVersions, gameEntry, knownGames, loadGame } from "./data.js";
import { checkValue } from "./options.js";

export const MAX_NAME = 16;

// Version du jeu demandée par le fichier (`requires.game` : version minimale, ou { min, max }),
// vérifiée comme le fait Archipelago avant de générer.
export function versionProblem(js, game) {
  const version = cachedGame(game)?.world_version;
  const required = getIn(js, ["requires", "game", game]);
  if (!version || required == null) return null;
  const { min, max } = isPlainObject(required) ? required : { min: required };
  if (min && compareVersions(min, version) > 0) return { need: `${min} ou plus récente`, have: version };
  if (max && compareVersions(max, version) < 0) return { need: `${max} ou plus ancienne`, have: version };
  return null;
}

// Problème de nom pour une room : un nom fixe d'au plus 16 caractères (unique, vérifié par le serveur).
export function nameProblem(name) {
  if (typeof name !== "string" || !name.trim()) return "Le YAML n'a pas de nom de joueur (name).";
  if (/[{}]/.test(name)) return `Le nom « ${name} » contient un motif ({number}, {player}…) : dans une room, donnez un nom fixe.`;
  if (name.trim().length > MAX_NAME) return `Le nom « ${name} » dépasse ${MAX_NAME} caractères.`;
  return null;
}

// Texte du champ `game` : un jeu, ou plusieurs tirés au sort.
export function gameLabel(js) {
  if (typeof js.game === "string") return js.game;
  if (isPlainObject(js.game)) {
    const names = Object.entries(js.game).filter(([, w]) => Number(w) > 0).map(([g]) => g);
    return names.length === 1 ? names[0] : `Au hasard : ${names.join(", ")}`;
  }
  return "";
}

// Une valeur d'option activée, même dans une table de poids (`death_link: {true: 10, false: 0}`).
function enabled(value) {
  if (isPlainObject(value)) return Object.entries(value).some(([k, w]) => Number(w) > 0 && enabled(k));
  return value === true || value === 1 || ["true", "on", "yes", "1"].includes(String(value).toLowerCase());
}

// Résultat : { name, game, games, problems, warnings, deathLink }.
// `problems` empêchent la génération, `warnings` sont à lire par l'hôte.
export async function checkDoc(js) {
  const problems = [];
  const warnings = [];
  const known = knownGames();
  const games = gamesOf(js, known);
  const naming = nameProblem(js.name);
  if (naming) problems.push(naming);
  if (!games.length) problems.push("Aucun jeu n'est indiqué dans le champ « game ».");
  const required = getIn(js, ["requires", "version"]);
  if (required && apVersion() && compareVersions(required, apVersion()) > 0) {
    problems.push(`Ce YAML demande Archipelago ${required}, plus récent que la version du site (${apVersion()}).`);
  }

  let deathLink = false;
  for (const game of games) {
    const section = isPlainObject(js[game]) ? js[game] : {};
    if (enabled(section.death_link)) deathLink = true;
    const entry = gameEntry(game);
    if (!entry) {
      warnings.push(`${game} : jeu absent de la base du site, options non vérifiées (l'hôte doit avoir son apworld).`);
      continue;
    }
    let data;
    try { data = await loadGame(game); } catch (e) { warnings.push(`${game} : ${e.message}`); continue; }
    if (!data) continue;
    const mismatch = versionProblem(js, game);
    if (mismatch) problems.push(`${game} : le YAML demande la version ${mismatch.need}, celle du site est ${mismatch.have}.`);
    const stability = entry.sheet?.stability;
    if (stability === "Broken on Main") problems.push(`${game} : jeu signalé cassé sur la version actuelle d'Archipelago.`);
    else if (stability === "Unstable") warnings.push(`${game} : jeu signalé instable.`);
    const extra = new Set(["triggers", ...(data.extra_keys || [])]);
    for (const [key, value] of Object.entries(section)) {
      const option = data.options.get(key);
      if (!option) {
        if (!extra.has(key)) problems.push(`${game} : option inconnue « ${key} ».`);
        continue;
      }
      if (option.kind === "removed") { warnings.push(`${game} : l'option « ${key} » n'existe plus, elle sera ignorée.`); continue; }
      for (const problem of checkValue(option, value, data)) problems.push(`${game} › ${option.name || key} : ${problem}`);
    }
  }
  return { name: typeof js.name === "string" ? js.name.trim() : "", game: gameLabel(js), games, problems, warnings, deathLink };
}

// Vérifie un fichier entier (un résultat par document) ; `errors` si le YAML est illisible.
export async function checkText(text) {
  let parsed;
  try { parsed = parseFile(text); } catch (e) { return { docs: [], errors: [e.message] }; }
  if (parsed.errors.length) return { docs: [], errors: parsed.errors };
  if (!parsed.docs.length) return { docs: [], errors: ["Le fichier est vide."] };
  return { docs: await Promise.all(parsed.docs.map((d) => checkDoc(d.js))), errors: [] };
}
