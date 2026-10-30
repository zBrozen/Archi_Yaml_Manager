import { html, render, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { loadIndex, loadGame, cachedGame, gameEntry, compareVersions, localGames, forgetLocalGame } from "./data.js";
import { parseFile, exportFile, gamesOf, setIn, getIn, markDirty, isPlainObject, RESERVED_KEYS } from "./yaml-model.js";
import { checkValue, sameAsDefault, yamlDefault, yamlComment, setDocLanguage, GROUP_NAMES } from "./options.js";
import { useApworldLoader } from "./apworld.js";
import { OptionRow, RawEditor } from "./editors.js";
import { useSetting, download, plural, SheetBadges, GamePicker, loadCredits } from "./ui.js";
import { versionProblem, checkText, nameProblem } from "./check.js";
import { RoomsHome, RoomPage } from "./rooms.js";
import { ScreensOverlay } from "./overlay.js";
import { api as roomsApi, normalizeCode, roomsEnabled, saveAccess } from "./rooms-api.js";

const formatDate = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

function useGame(name) {
  const [state, setState] = useState(() => ({ data: cachedGame(name), loading: !cachedGame(name) && !!gameEntry(name) }));
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    if (cachedGame(name)) { setState({ data: cachedGame(name), loading: false }); return; }
    if (!gameEntry(name)) { setState({ data: null, loading: false }); return; }
    setState({ data: null, loading: true });
    loadGame(name)
      .then((data) => alive && setState({ data, loading: false }))
      .catch((error) => alive && setState({ data: null, loading: false, error: error.message }));
    return () => { alive = false; };
  }, [name, version]);
  // À appeler après l'ajout d'un apworld pour relire les données du jeu.
  return { ...state, refresh: () => setVersion((v) => v + 1) };
}

function isWeightPath(path) {
  if (path.length !== 2) return false;
  return !!cachedGame(path[0])?.options.get(path[1])?.weighted;
}

function commentFor(path) {
  const option = path.length === 2 ? cachedGame(path[0])?.options.get(path[1]) : null;
  return option ? yamlComment(option) : null;
}

// Le fichier exporté contient toutes les options du jeu, comme les modèles d'Archipelago :
// celles qui manquent sont ajoutées à leur valeur par défaut. Les options gardent l'ordre
// du jeu, même celles modifiées avant les autres (sinon elles sortiraient en tête de section).
function completeDocs(docs, knownGames) {
  return docs.map((entry) => {
    let { js, dirty } = entry;
    const rank = new Map();
    for (const game of gamesOf(js, knownGames)) {
      const data = cachedGame(game);
      if (!data) continue;
      const section = isPlainObject(js[game]) ? js[game] : {};
      const ordered = {};
      for (const group of data.groups) {
        for (const option of group.options) {
          const path = [game, option.key];
          const id = JSON.stringify(path);
          rank.set(id, rank.size);
          if (section[option.key] !== undefined) ordered[option.key] = section[option.key];
          else if (option.kind !== "removed" && (option.visibility & 1) === 1) {
            ordered[option.key] = yamlDefault(option);
            if (!dirty.includes(id)) dirty = [...dirty, id];
          }
        }
      }
      for (const [key, value] of Object.entries(section)) if (!(key in ordered)) ordered[key] = value;
      js = setIn(js, [game], ordered);
    }
    // Les options ajoutées à un fichier existant y sont écrites dans l'ordre du jeu.
    const order = (id) => rank.get(id) ?? -1;
    dirty = [...dirty].sort((a, b) => order(a) - order(b));
    return { ...entry, js, dirty };
  });
}

// Zone de dépôt d'un apworld, obligatoire pour un jeu absent de la base du site.
function ApworldDrop({ game, onLoaded }) {
  const { status, error, load } = useApworldLoader();
  const [hover, setHover] = useState(false);
  const handle = async (file) => {
    if (!file) return;
    const names = await load(file, game);
    if (names.length && (!game || names.includes(game))) onLoaded(names);
  };
  return html`<div class="stack full">
    <label class=${`drop compact ${hover ? "hover" : ""} ${status ? "busy" : ""}`}
      onDragOver=${(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave=${() => setHover(false)}
      onDrop=${(e) => { e.preventDefault(); setHover(false); handle(e.dataTransfer.files[0]); }}>
      <input type="file" accept=".apworld" hidden disabled=${!!status} onChange=${(e) => { handle(e.target.files[0]); e.target.value = ""; }} />
      ${status
        ? html`<strong>${status}</strong><span class="hint">La première lecture prend quelques secondes.</span>`
        : html`<strong>Déposez le fichier .apworld${game ? ` de « ${game} »` : ""}</strong>
          <span>ou cliquez pour le choisir</span>`}
    </label>
    ${error && html`<div class="notice error">${error}</div>`}
  </div>`;
}

// --- Accueil -------------------------------------------------------------------

function Home({ index, onOpen, onCreate }) {
  const [errors, setErrors] = useState([]);
  const [hover, setHover] = useState(false);
  const [game, setGame] = useState("");
  const [, setLocalVersion] = useState(0);
  const apworld = useApworldLoader();
  const imported = localGames();
  // Un jeu dont l'apworld a été déposé n'apparaît que dans « Ajoutés avec un apworld ».
  const mine = new Set(imported.map((g) => g.game));
  const core = index.games.filter((g) => g.source === "core" && !mine.has(g.game));
  const custom = index.games.filter((g) => g.source !== "core" && !mine.has(g.game));
  const failed = Object.entries(index.errors || {});
  const added = (names) => {
    setLocalVersion((v) => v + 1);
    if (names.length) setGame(names[0]);
  };

  // On peut déposer le YAML et l'apworld de son jeu en même temps.
  const readFiles = async (files) => {
    const list = [...files];
    for (const file of list.filter((f) => /\.apworld$/i.test(f.name))) added(await apworld.load(file));
    const file = list.find((f) => !/\.apworld$/i.test(f.name));
    if (!file) return;
    const text = await file.text();
    let result;
    try {
      result = parseFile(text);
    } catch (e) {
      result = { docs: [], errors: [e.message] };
    }
    if (result.errors.length || !result.docs.length) {
      setErrors(result.errors.length ? result.errors : ["Le fichier est vide."]);
      return;
    }
    setErrors([]);
    onOpen({ name: file.name, original: text, docs: result.docs });
  };

  return html`<main class="home">
    <div class="intro">
      <h1>Modifier un YAML Archipelago</h1>
      <p>Déposez votre fichier : chaque option s'affiche avec son explication et un réglage simple.</p>
    </div>
    <label class=${`drop ${hover ? "hover" : ""}`}
      onDragOver=${(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave=${() => setHover(false)}
      onDrop=${(e) => { e.preventDefault(); setHover(false); readFiles(e.dataTransfer.files); }}>
      <input type="file" accept=".yaml,.yml,.txt,.apworld" multiple hidden onChange=${(e) => { readFiles(e.target.files); e.target.value = ""; }} />
      <strong>Déposez votre fichier YAML ici</strong>
      <span>ou cliquez pour le choisir</span>
      <span class="hint">Jeu non officiel : déposez aussi son fichier .apworld. Les fichiers restent sur votre ordinateur.</span>
    </label>
    ${apworld.status && html`<div class="notice">${apworld.status}</div>`}
    ${apworld.error && html`<div class="notice error">${apworld.error}</div>`}
    ${errors.length > 0 && html`<div class="notice error"><strong>Impossible de lire ce fichier :</strong>
      <ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>`}

    <section class="card stack">
      <h2>Pas encore de YAML ?</h2>
      <${GamePicker} core=${core} custom=${custom} imported=${imported} value=${game} onChange=${setGame} onCreate=${onCreate} />
      <p class="hint">Jeu absent de la liste, ou apworld plus récent que celui du serveur ? Déposez son .apworld ci-dessous :
        il passe avant celui du serveur.</p>
      <${ApworldDrop} onLoaded=${added} />
      ${imported.length > 0 && html`<div class="remembered">
        <span class="hint">Apworlds mémorisés dans ce navigateur :</span>
        ${imported.map((g) => html`<span class="chip">${g.game}${g.world_version ? ` ${g.world_version}` : ""}${g.server
          ? ` (serveur : ${g.server.world_version || "?"})` : ""}
          <button type="button" title="Oublier cet apworld" onClick=${() => { forgetLocalGame(g.game); added([]); if (game === g.game) setGame(""); }}>✕</button></span>`)}
      </div>`}
    </section>

    ${failed.length > 0 && html`<details class="notice warn">
      <summary>${plural(failed.length, "jeu")} du serveur n'ont pas pu être chargés</summary>
      <ul>${failed.map(([name, reason]) => html`<li><strong>${name}</strong> : ${reason}</li>`)}</ul>
    </details>`}

    <p class="hint center">
      Archipelago ${index.ap_version} · ${index.games.length} jeux, dont ${custom.length} du serveur · mis à jour le ${formatDate(index.generated_at)}
    </p>
  </main>`;
}

// --- Éditeur --------------------------------------------------------------------

function PlayerCard({ js, index, games, update }) {
  const name = js.name ?? "";
  const requires = isPlainObject(js.requires) ? js.requires : {};
  // Archipelago refuse un fichier qui demande une version plus récente que la sienne.
  const tooNew = requires.version && compareVersions(requires.version, index.ap_version) > 0;
  const older = requires.version && compareVersions(requires.version, index.ap_version) < 0;
  const tooLong = String(name).length > 16 && !String(name).includes("{");

  // Changer de jeu repart d'un fichier propre pour le nouveau jeu : Archipelago ne lit que la section
  // du jeu choisi, l'ancienne section et sa version requise ne servent plus.
  const changeGame = (next) => {
    const previous = js.game;
    update(["game"], next);
    if (typeof previous !== "string" || previous === next) return;
    update([previous], undefined);
    if (!isPlainObject(js[next])) update([next], {});
    if (js.description === `YAML ${previous}`) update(["description"], `YAML ${next}`);
    const versions = isPlainObject(requires.game) ? { ...requires.game } : {};
    delete versions[previous];
    const version = gameEntry(next)?.world_version;
    if (version) versions[next] = version;
    if (isPlainObject(requires.game) || version) update(["requires", "game"], Object.keys(versions).length ? versions : undefined);
  };

  return html`<section class="card player">
    <div class="fields">
      <label>
        <span>Nom du joueur</span>
        <input type="text" value=${name} onChange=${(e) => update(["name"], e.target.value.trim())} />
        ${tooLong && html`<span class="hint">Archipelago ne garde que les 16 premiers caractères : « ${String(name).trim().slice(0, 16).trim()} ».</span>`}
      </label>
      <${GameField} value=${js.game} index=${index} onChange=${changeGame} />
      <label class="span-all">
        <span>Description <span class="hint">(facultatif)</span></span>
        <input type="text" value=${js.description ?? ""} onChange=${(e) => update(["description"], e.target.value)} />
      </label>
    </div>
    ${tooNew && html`<div class="notice error">
      Ce YAML demande Archipelago ${requires.version}, plus récent que la version du serveur (${index.ap_version}) :
      le générateur le refusera. Il faut un YAML et des apworlds prévus pour Archipelago ${index.ap_version}.
    </div>`}
    ${older && html`<div class="notice">
      Fichier écrit pour Archipelago ${requires.version} (serveur : ${index.ap_version}). Vérifiez les options signalées.
    </div>`}
  </section>`;
}

function GameField({ value, index, onChange }) {
  const names = [...new Set([...localGames(), ...index.games].map((g) => g.game))];
  if (isPlainObject(value)) {
    return html`<div class="label-like">
      <span>Jeux (tirés au sort selon leur poids)</span>
      <table class="compact"><tbody>${Object.entries(value).map(([g, w]) => html`<tr>
        <td>${g}</td>
        <td><input type="number" class="num" min="0" value=${w}
          onChange=${(e) => onChange({ ...value, [g]: Math.max(0, Math.round(Number(e.target.value)) || 0) })} /></td>
      </tr>`)}</tbody></table>
    </div>`;
  }
  return html`<label>
    <span>Jeu</span>
    <select value=${value ?? ""} onChange=${(e) => onChange(e.target.value)}>
      ${!names.includes(value) && html`<option value=${value ?? ""}>${value || "—"}</option>`}
      ${names.map((n) => html`<option value=${n}>${n}</option>`)}
    </select>
  </label>`;
}

function matches(option, search) {
  if (!search) return true;
  const needle = search.toLowerCase();
  return [option.name, option.key, option.doc, option.doc_fr].some((t) => (t || "").toLowerCase().includes(needle));
}

function isVisible(option, value, { filter, search, advanced }) {
  if (!matches(option, search)) return false;
  const present = value !== undefined;
  const changed = present && !sameAsDefault(option, value);
  if (filter === "changed") return changed;
  if (changed) return true;
  // Mode simple : comme la page « Player Options » d'Archipelago (sans les options de plando).
  if (!advanced) return (option.visibility & 2) === 2 && option.kind !== "plando";
  return present || (option.visibility & 1) === 1;
}

const unknownOption = (key) => ({ key, name: key, kind: "unknown", weighted: false, doc: "" });

function GameSection({ name, entry, index, update, view, onApworld }) {
  const { data, loading, error, refresh } = useGame(name);
  const schema = data;
  const section = isPlainObject(entry.js[name]) ? entry.js[name] : {};
  const original = (key) => getIn(entry.original, [name, key]);
  const setOption = (key, value) => update([name, key], value);

  if (loading) return html`<section class="game"><h2>${name}</h2><p class="hint">Chargement des options…</p></section>`;

  const head = (badge) => html`<div class="game-head"><h2>${name}</h2>${badge}</div>`;
  if (!schema) {
    // Jeu absent de la base : sans son apworld, impossible de savoir quelles options et valeurs sont valides.
    return html`<section class="game">
      ${head(html`<span class="badge warn">Apworld requis</span>`)}
      <div class="card stack">
        <p>${error || html`<strong>${name}</strong> n'est pas un jeu officiel ni un jeu du serveur. Pour afficher et vérifier
          ses options, ajoutez le fichier <strong>.apworld</strong> de ce jeu (celui que vous avez installé dans Archipelago).`}</p>
        <${ApworldDrop} game=${name} onLoaded=${() => { refresh(); onApworld(); }} />
      </div>
    </section>`;
  }

  // Apworld déposé à la place de celui du serveur : on peut revenir à celui du serveur.
  const replaced = data.source === "apworld" && gameEntry(name)?.server;
  const revert = html`<button type="button" class="ghost" onClick=${() => { forgetLocalGame(name); refresh(); onApworld(); }}>
    Revenir à l'apworld du serveur${replaced?.world_version ? ` (${replaced.world_version})` : ""}</button>`;

  // Version du jeu incompatible avec le fichier : la génération échouerait, on demande la bonne version.
  const mismatch = versionProblem(entry.js, name);
  if (mismatch) {
    return html`<section class="game">
      ${head(html`<span class="badge warn">${data.source === "apworld" ? "Apworld à mettre à jour" : "Version incompatible"}</span>`)}
      <div class="card stack">
        <p>Ce YAML demande la version <strong>${mismatch.need}</strong> de ${name}, ${data.source === "apworld" ? "mais l'apworld fourni" : "mais le serveur"} est en version <strong>${mismatch.have}</strong>. Archipelago refusera de générer la partie.</p>
        <p>${data.source === "apworld"
          ? "Déposez l'apworld de la bonne version (celui avec lequel ce YAML a été fait)."
          : html`Il faut un YAML prévu pour la version ${mismatch.have} de ce jeu, ou l'apworld avec lequel ce YAML a été fait :
            déposé ici, il remplace celui du serveur.`}</p>
        <${ApworldDrop} game=${name} onLoaded=${() => { refresh(); onApworld(); }} />
        ${replaced && revert}
      </div>
    </section>`;
  }

  const extraAllowed = new Set(["triggers", ...(schema.extra_keys || [])]);
  const extraKeys = Object.keys(section).filter((k) => extraAllowed.has(k) && !schema.options.has(k));
  const unknownKeys = Object.keys(section).filter((k) => !schema.options.has(k) && !extraAllowed.has(k));
  let changed = 0, problems = unknownKeys.length;
  for (const [key, value] of Object.entries(section)) {
    const option = schema.options.get(key);
    if (!option) continue;
    if (!sameAsDefault(option, value)) changed++;
    if (option.kind === "removed" || checkValue(option, value, data).length) problems++;
  }

  const groups = schema.groups.map((group) => ({
    ...group,
    shown: group.options.filter((o) => isVisible(o, section[o.key], view)),
  })).filter((g) => g.shown.length);
  const shownUnknown = unknownKeys.filter((k) => !view.search || k.toLowerCase().includes(view.search.toLowerCase()));
  const row = (option) => html`<${OptionRow} key=${option.key} option=${option} value=${section[option.key]}
    original=${original(option.key)} game=${data} advanced=${view.advanced} onChange=${(v) => setOption(option.key, v)} />`;

  return html`<section class="game">
    ${head(html`
      ${data.source === "custom" && html`<span class="badge accent">Jeu non officiel</span>`}
      <${SheetBadges} sheet=${gameEntry(name)?.sheet} />
      ${data.source === "apworld" && html`<span class="badge accent">Apworld ${data.world_version || ""}</span>`}
      <span class="stats">${changed} ${changed > 1 ? "options modifiées" : "option modifiée"}${problems > 0
        ? html` · <span class="error">${plural(problems, "problème")}</span>` : ""}</span>`)}
    ${replaced && html`<div class="notice row">
      <span class="grow">Options lues dans votre apworld${data.world_version ? ` (${data.world_version})` : ""}, à la place de celui du serveur${replaced.world_version ? ` (${replaced.world_version})` : ""}.</span>
      ${revert}
    </div>`}
    ${groups.length === 0 && shownUnknown.length === 0 && html`<p class="hint">Aucune option à afficher.</p>`}
    ${shownUnknown.length > 0 && html`<div class="group">
      <div class="group-title warn">Options non reconnues</div>
      <div class="group-body">${shownUnknown.map((key) => row(unknownOption(key)))}</div>
    </div>`}
    ${groups.map((group) => html`<details class="group" open=${!group.collapsed || !!view.search || view.filter !== "all"}>
      <summary>${GROUP_NAMES[group.name] || group.name}</summary>
      <div class="group-body">${group.shown.map(row)}</div>
    </details>`)}
    ${view.advanced && extraKeys.length > 0 && html`<details class="group">
      <summary>Autres paramètres du jeu</summary>
      <div class="group-body">${extraKeys.map((key) => html`<div class="opt wide">
        <div class="opt-info"><div class="opt-name"><code>${key}</code></div></div>
        <div class="opt-control"><${RawEditor} value=${section[key]} onChange=${(v) => setOption(key, v)} /></div>
      </div>`)}</div>
    </details>`}
  </section>`;
}

function AdvancedSection({ js, games, update }) {
  const keys = Object.keys(js).filter((k) => !games.includes(k) && !["name", "description", "game"].includes(k));
  if (!keys.length) return null;
  return html`<details class="group">
    <summary>Autres clés du fichier</summary>
    <div class="group-body">${keys.map((key) => html`<div class="opt wide">
      <div class="opt-info">
        <div class="opt-name"><code>${key}</code></div>
        ${!RESERVED_KEYS.has(key) && html`<div class="opt-desc"><p>Section d'un jeu non sélectionné, ou clé inconnue.</p></div>`}
      </div>
      <div class="opt-control"><${RawEditor} value=${js[key]} onChange=${(v) => update([key], v)} /></div>
    </div>`)}</div>
  </details>`;
}

function Editor({ index, file, setFile, onClose, advanced, onSend }) {
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState(null);
  const [copied, setCopied] = useState(false);
  const entry = file.docs[Math.min(active, file.docs.length - 1)];
  const [, setApworlds] = useState(0);
  const knownGames = new Set([...index.games, ...localGames()].map((g) => g.game));
  const games = gamesOf(entry.js, knownGames);
  const missing = games.filter((g) => !gameEntry(g) || versionProblem(entry.js, g));
  const dirty = file.docs.some((d) => d.dirty.length);
  const requiredAp = getIn(entry.js, ["requires", "version"]);
  const blocked = missing.length
    ? `Il faut d'abord un apworld compatible pour ${missing.map((g) => `« ${g} »`).join(", ")}.`
    : requiredAp && compareVersions(requiredAp, index.ap_version) > 0
      ? `Ce YAML demande Archipelago ${requiredAp}, le serveur est en ${index.ap_version}.`
      : null;

  // Une fois les jeux chargés, on recalcule ce qui bloque l'export (apworld manquant, version).
  useEffect(() => {
    Promise.all(games.map((g) => gameEntry(g) && loadGame(g).catch(() => {}))).then(() => setApworlds((n) => n + 1));
  }, [games.join("|")]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = (path, value) => setFile((f) => {
    const docs = [...f.docs];
    const current = docs[active];
    docs[active] = { ...current, js: setIn(current.js, path, value), dirty: markDirty(current, path) };
    return { ...f, docs };
  });

  const exported = () => exportFile(file.original, completeDocs(file.docs, knownGames), isWeightPath, commentFor);
  const fileName = () => {
    if (file.name) return file.name.replace(/\.(ya?ml|txt)$/i, "") + ".yaml";
    const base = String(file.docs[0].js.name || "joueur").replace(/\{[^}]*\}/g, "").replace(/[^\w\- ]+/g, "").trim();
    return `${base || "joueur"}.yaml`;
  };
  const copy = async () => {
    await navigator.clipboard.writeText(exported());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const view = { filter, search, advanced };
  const room = file.room;
  const roomBlocked = room && (file.docs.length > 1
    ? "Dans une room, un fichier = un joueur : envoyez chaque joueur séparément."
    : nameProblem(entry.js.name));
  const send = async () => {
    setSending(true);
    setSendError(null);
    try { await onSend(exported(), fileName()); } catch (e) { setSendError(e.message); } finally { setSending(false); }
  };

  return html`<div class="editor">
    <div class="toolbar">
      <div class="toolbar-row">
        <button type="button" class="ghost" title=${room ? "Retour à la room" : "Ouvrir un autre fichier"}
          onClick=${() => (!dirty || confirm(room ? "Revenir à la room ? Les modifications non envoyées seront perdues."
            : "Fermer ce fichier ? Les modifications non téléchargées seront perdues.")) && onClose()}>←</button>
        <strong class="file-name">${file.name || "Nouveau YAML"}</strong>
        ${room && html`<span class="badge accent">Room ${room.code}</span>`}
        <span class="spacer"></span>
        ${advanced && html`<button type="button" class="ghost" onClick=${() => setPreview(exported())}>Aperçu</button>`}
        <button type="button" class="ghost" disabled=${!!blocked} title=${blocked || ""} onClick=${copy}>${copied ? "Copié ✓" : "Copier"}</button>
        <button type="button" class=${room ? "ghost" : ""} disabled=${!!blocked} title=${blocked || ""} onClick=${() => download(fileName(), exported())}>Télécharger</button>
        ${room && html`<button type="button" disabled=${!!(blocked || roomBlocked) || sending} title=${blocked || roomBlocked || ""}
          onClick=${send}>${sending ? "Envoi…" : room.slotId ? "Mettre à jour dans la room" : "Envoyer dans la room"}</button>`}
      </div>
      ${room && (sendError || roomBlocked) && html`<div class="notice error">${sendError || roomBlocked}</div>`}
      <div class="toolbar-row">
        <input type="search" class="search" placeholder="Rechercher une option…" value=${search} onInput=${(e) => setSearch(e.target.value)} />
        <div class="segmented">
          <button type="button" class=${filter === "all" ? "active" : ""} onClick=${() => setFilter("all")}>Toutes</button>
          <button type="button" class=${filter === "changed" ? "active" : ""} onClick=${() => setFilter("changed")}>Modifiées</button>
        </div>
      </div>
      ${file.docs.length > 1 && html`<div class="toolbar-row tabs">${file.docs.map((d, i) => html`<button type="button"
        class=${i === active ? "active" : ""} onClick=${() => setActive(i)}>${d.js.name || `Joueur ${i + 1}`}</button>`)}</div>`}
    </div>

    <div class="content">
      <${PlayerCard} js=${entry.js} index=${index} games=${games} update=${update} />
      ${games.length === 0 && html`<div class="notice warn">Aucun jeu n'est indiqué dans le champ « game ».</div>`}
      ${games.map((g) => html`<${GameSection} key=${`${active}-${g}`} name=${g} entry=${entry} index=${index} update=${update} view=${view}
        onApworld=${() => setApworlds((n) => n + 1)} />`)}
      ${advanced && html`<${AdvancedSection} js=${entry.js} games=${games} update=${update} />`}
    </div>

    ${preview !== null && html`<div class="modal" onClick=${(e) => e.target === e.currentTarget && setPreview(null)}>
      <div class="modal-box">
        <div class="toolbar-row"><strong>Aperçu du fichier exporté</strong><span class="spacer"></span>
          <button type="button" class="ghost" onClick=${() => setPreview(null)}>Fermer</button></div>
        <pre>${preview}</pre>
      </div>
    </div>`}
  </div>`;
}

// --- Application -------------------------------------------------------------------

function newDocument(index, game, name = "Joueur{number}") {
  const version = gameEntry(game)?.world_version;
  return {
    name,
    description: `YAML ${game}`,
    game,
    requires: { version: index.ap_version, ...(version ? { game: { [game]: version } } : {}) },
    [game]: {},
  };
}

function Header({ page, advanced, setAdvanced, docLanguage, setDocLanguage, theme, setTheme }) {
  // L'en-tête reste visible, et sa hauteur (qui change quand il passe sur plusieurs lignes) place
  // en dessous les barres collantes (--header-h). En fenêtre étroite, les réglages passent au-dessus
  // du titre et défilent avec la page (--header-hidden) : seuls le titre et la navigation restent.
  const ref = useRef(null);
  useEffect(() => {
    const header = ref.current, root = document.documentElement.style;
    const tools = header.querySelector(".header-tools"), brand = header.querySelector(".brand");
    const observer = new ResizeObserver(() => {
      const above = brand.offsetTop >= tools.offsetTop + tools.offsetHeight;
      const hidden = above ? brand.offsetTop - tools.offsetTop : 0;
      root.setProperty("--header-hidden", `${hidden}px`);
      root.setProperty("--header-h", `${header.offsetHeight - hidden}px`);
    });
    observer.observe(header);
    return () => { observer.disconnect(); root.removeProperty("--header-h"); root.removeProperty("--header-hidden"); };
  }, []);
  return html`<header class="site-header" ref=${ref}>
    <a class="brand" href="#/"><span class="logo" aria-hidden="true">◆</span> Archipelago YAML Manager</a>
    ${roomsEnabled() && html`<nav class="site-nav">
      <a href="#/" class=${page === "home" ? "active" : ""}>Éditeur</a>
      <a href="#/rooms" class=${page !== "home" ? "active" : ""}>Rooms</a>
    </nav>`}
    <div class="header-tools">
      <label class="switch" title="Affiche les tirages au sort, les poids et le YAML brut">
        <input type="checkbox" checked=${advanced} onChange=${(e) => setAdvanced(e.target.checked)} />
        <span class="track"></span> Mode avancé
      </label>
      <select class="theme" value=${docLanguage} onChange=${(e) => setDocLanguage(e.target.value)} aria-label="Langue des descriptions"
        title="Les descriptions des options sont traduites automatiquement depuis l'anglais">
        <option value="fr">Descriptions FR</option>
        <option value="en">Descriptions EN</option>
      </select>
      <select class="theme" value=${theme} onChange=${(e) => setTheme(e.target.value)} aria-label="Thème">
        <option value="auto">Thème auto</option>
        <option value="light">Clair</option>
        <option value="dark">Sombre</option>
      </select>
    </div>
  </header>`;
}

// Adresse de la page : #/ (éditeur), #/rooms, #/room/CODE. Les liens personnels
// (#/room/CODE/p/JETON, #/room/CODE/h/JETON) sont mémorisés puis retirés de l'adresse.
// #/overlay/CODE/CLÉ?max=…&console=…&objets=… : écrans des joueurs et messages de la partie pour OBS,
// page à part (ni en-tête ni pied de page).
function readRoute() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "rooms") return { page: "rooms" };
  if (parts[0] === "overlay" && parts[1] && parts[2]) {
    return { page: "overlay", code: normalizeCode(parts[1]), key: parts[2], params: Object.fromEntries(new URLSearchParams(query)) };
  }
  if (parts[0] === "room" && parts[1]) {
    const code = normalizeCode(parts[1]);
    if (parts[3] && (parts[2] === "p" || parts[2] === "h")) {
      saveAccess(code, parts[2] === "h" ? { admin: parts[3] } : { player: parts[3] });
      history.replaceState(null, "", `#/room/${code}`);
    }
    return { page: "room", code };
  }
  return { page: "home" };
}

function App() {
  const [index, setIndex] = useState(null);
  const [error, setError] = useState(null);
  const [file, setFile] = useState(null);
  const [route, setRoute] = useState(readRoute);
  const [advanced, setAdvanced] = useSetting("advanced", false);
  const [theme, setTheme] = useSetting("theme", "auto");
  const [docLanguage, setDocLanguageSetting] = useSetting("docLanguage", "en");
  setDocLanguage(docLanguage); // lu par les éditeurs pendant ce rendu

  useEffect(() => { loadIndex().then(setIndex).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    const change = () => { setRoute(readRoute()); setFile(null); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);

  // YAML ouvert depuis une room : l'éditeur l'y renvoie (un fichier = un joueur, avec un nom fixe).
  const openFromRoom = (code, { content, filename, id }) => {
    const parsed = parseFile(content);
    if (parsed.errors.length || !parsed.docs.length) throw new Error(parsed.errors[0] || "Ce YAML est vide.");
    setFile({ name: filename, original: content, docs: parsed.docs, room: { code, slotId: id } });
  };
  // `playerId` : YAML créé par l'hôte pour un autre joueur de la room.
  const createForRoom = (code, game, name, playerId) => setFile({
    name: null, original: null, room: { code, slotId: null, playerId },
    docs: [{ source: 0, js: newDocument(index, game, name), original: {}, dirty: [] }],
  });
  const sendToRoom = async (text, filename) => {
    const { code, slotId, playerId } = file.room;
    const check = await checkText(text);
    if (check.errors.length) throw new Error(check.errors[0]);
    const [doc] = check.docs;
    const slot = { name: doc.name, game: doc.game, filename, content: text, issues: [...doc.problems, ...doc.warnings] };
    if (slotId) await roomsApi.replaceSlot(code, slotId, slot);
    else await roomsApi.addSlot(code, playerId ? { ...slot, player_id: playerId } : slot);
    setFile(null);
  };
  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  let body;
  if (error) body = html`<main class="home"><div class="notice error">Impossible de charger la liste des jeux : ${error}</div></main>`;
  else if (!index) body = html`<main class="home"><p class="hint center">Chargement…</p></main>`;
  else if (file) {
    body = html`<${Editor} index=${index} file=${file} setFile=${setFile} advanced=${advanced} onClose=${() => setFile(null)} onSend=${sendToRoom} />`;
  } else if (route.page === "rooms") {
    body = html`<${RoomsHome} />`;
  } else if (route.page === "room") {
    body = html`<${RoomPage} key=${route.code} index=${index} code=${route.code}
      onCreate=${(game, name, playerId) => createForRoom(route.code, game, name, playerId)} onEdit=${(slot) => openFromRoom(route.code, slot)} />`;
  } else {
    body = html`<${Home} index=${index} onOpen=${setFile}
      onCreate=${(game) => setFile({ name: null, original: null, docs: [{ source: 0, js: newDocument(index, game), original: {}, dirty: [] }] })} />`;
  }

  return html`<${Header} page=${route.page} advanced=${advanced} setAdvanced=${setAdvanced}
    docLanguage=${docLanguage} setDocLanguage=${setDocLanguageSetting} theme=${theme} setTheme=${setTheme} />${body}<${Footer} />`;
}

function Footer() {
  const repo = "https://github.com/zBrozen/Archi_Yaml_Manager";
  const [credits, setCredits] = useState(null);
  const openCredits = (e) => {
    e.preventDefault();
    loadCredits().then(setCredits);
  };
  return html`<footer class="site-footer hint">
    <p>Outil non officiel, non affilié à <a href="https://archipelago.gg">Archipelago</a> ni aux éditeurs des jeux cités,
    dont les noms appartiennent à leurs propriétaires.
    Options lues depuis Archipelago (licence MIT) et les apworlds de leurs auteurs.</p>
    <p><a href=${repo + "/blob/main/LICENSE"}>Licence</a>${" · "}<a href=${repo + "/blob/main/THIRD_PARTY_LICENSES.md"}>Licences tierces</a>${" · "}<a href="#" onClick=${openCredits}>Jeux non officiels : auteurs et licences</a>${" · "}<a href=${repo}>Code source</a></p>
    ${credits !== null && html`<div class="modal" onClick=${(e) => e.target === e.currentTarget && setCredits(null)}>
      <div class="modal-box">
        <div class="toolbar-row"><strong>Jeux non officiels : auteurs et licences</strong><span class="spacer"></span>
          <button type="button" class="ghost" onClick=${() => setCredits(null)}>Fermer</button></div>
        <div class="credits">
          ${credits.length === 0 && html`<p>Aucun jeu non officiel dans la base.</p>`}
          ${credits.map((c) => html`<div class="credit" key=${c.file}>
            <div><strong>${c.game}</strong>${c.version && html` <span class="hint">v${c.version}</span>`} <${SheetBadges} sheet=${c.sheet} /></div>
            ${c.authors?.length > 0 && html`<div>Auteurs : ${[].concat(c.authors).join(", ")}</div>`}
            ${c.source && html`<div>Source : <a href=${c.source}>${c.source.replace(/^https:\/\//, "")}</a></div>`}
            <div>Licence : ${c.license
              ? (c.license_url ? html`<a href=${c.license_url}>${c.license}</a>` : c.license)
              : "aucune licence indiquée par l'auteur"}</div>
            ${c.copyright.map((line) => html`<div class="hint">${line}</div>`)}
          </div>`)}
        </div>
      </div>
    </div>`}
  </footer>`;
}

// L'overlay n'a pas besoin de la liste des jeux : il ne charge que lui-même.
const start = readRoute();
render(start.page === "overlay"
  ? html`<${ScreensOverlay} code=${start.code} overlayKey=${start.key} params=${start.params} />`
  : html`<${App} />`, document.getElementById("app"));
