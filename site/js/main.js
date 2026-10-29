import { html, render, useState, useEffect } from "../vendor/preact-htm.js";
import { loadIndex, loadGame, cachedGame, gameEntry, compareVersions, localGames, forgetLocalGame } from "./data.js";
import { parseFile, exportFile, gamesOf, setIn, getIn, markDirty, isPlainObject, RESERVED_KEYS } from "./yaml-model.js";
import { checkValue, sameAsDefault, GROUP_NAMES } from "./options.js";
import { useApworldLoader } from "./apworld.js";
import { OptionRow, RawEditor } from "./editors.js";

const formatDate = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

// Préférence mémorisée dans le navigateur (si le stockage est disponible).
function useSetting(name, initial) {
  const [value, setValue] = useState(() => {
    try { return JSON.parse(localStorage.getItem(name)) ?? initial; } catch { return initial; }
  });
  const update = (next) => {
    setValue(next);
    try { localStorage.setItem(name, JSON.stringify(next)); } catch { /* stockage indisponible */ }
  };
  return [value, update];
}

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

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/yaml;charset=utf-8" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- Accueil -------------------------------------------------------------------

function Home({ index, onOpen, onCreate }) {
  const [errors, setErrors] = useState([]);
  const [hover, setHover] = useState(false);
  const [game, setGame] = useState("");
  const [, setLocalVersion] = useState(0);
  const apworld = useApworldLoader();
  const core = index.games.filter((g) => g.source === "core");
  const custom = index.games.filter((g) => g.source !== "core");
  const imported = localGames();
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
      <div class="row full">
        <select class="grow" value=${game} onChange=${(e) => setGame(e.target.value)}>
          <option value="">Choisir un jeu…</option>
          ${imported.length > 0 && html`<optgroup label="Ajoutés avec un apworld">${imported.map((g) => html`<option value=${g.game}>${g.game}</option>`)}</optgroup>`}
          ${custom.length > 0 && html`<optgroup label="Jeux du serveur">${custom.map((g) => html`<option value=${g.game}>${g.game}</option>`)}</optgroup>`}
          <optgroup label="Jeux officiels">${core.map((g) => html`<option value=${g.game}>${g.game}</option>`)}</optgroup>
        </select>
        <button type="button" disabled=${!game} onClick=${() => onCreate(game)}>Créer un YAML</button>
      </div>
      <p class="hint">Jeu absent de la liste ? Déposez son .apworld ci-dessous pour l'ajouter.</p>
      <${ApworldDrop} onLoaded=${added} />
      ${imported.length > 0 && html`<div class="remembered">
        <span class="hint">Apworlds mémorisés dans ce navigateur :</span>
        ${imported.map((g) => html`<span class="chip">${g.game}${g.world_version ? ` ${g.world_version}` : ""}
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
  const outdated = requires.version && compareVersions(requires.version, index.ap_version) < 0;
  const updateRequires = () => {
    const next = { ...requires, version: index.ap_version };
    const gameVersions = isPlainObject(requires.game) ? { ...requires.game } : {};
    for (const g of games) {
      const version = gameEntry(g)?.world_version;
      if (version) gameVersions[g] = version;
    }
    if (Object.keys(gameVersions).length) next.game = gameVersions;
    update(["requires"], next);
  };
  const tooLong = String(name).length > 16 && !String(name).includes("{");

  return html`<section class="card player">
    <div class="fields">
      <label>
        <span>Nom du joueur</span>
        <input type="text" value=${name} maxlength=${String(name).includes("{") ? undefined : 16}
          onChange=${(e) => update(["name"], e.target.value.trim())} />
        ${tooLong && html`<span class="error small">16 caractères maximum.</span>`}
      </label>
      <${GameField} value=${js.game} index=${index} onChange=${(v) => update(["game"], v)} />
      <label class="span-all">
        <span>Description <span class="hint">(facultatif)</span></span>
        <input type="text" value=${js.description ?? ""} onChange=${(e) => update(["description"], e.target.value)} />
      </label>
    </div>
    ${outdated && html`<div class="notice warn">
      Fichier prévu pour Archipelago ${requires.version} (actuel : ${index.ap_version}). Vérifiez les options signalées.
      <button type="button" class="small" onClick=${updateRequires}>Indiquer la version actuelle</button>
    </div>`}
  </section>`;
}

function GameField({ value, index, onChange }) {
  const names = index.games.map((g) => g.game);
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
  return [option.name, option.key, option.doc].some((t) => (t || "").toLowerCase().includes(needle));
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

  // Version du jeu demandée par le fichier (`requires.game`), vérifiée comme le fait Archipelago.
  const required = getIn(entry.js, ["requires", "game", name]);
  const minimum = isPlainObject(required) ? required.min : required;
  const tooOld = minimum && data.world_version && compareVersions(minimum, data.world_version) > 0;

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
      ${data.source === "custom" && html`<span class="badge accent">Jeu du serveur</span>`}
      ${data.source === "apworld" && html`<span class="badge accent">Apworld ${data.world_version || ""}</span>`}
      <span class="stats">${changed} ${changed > 1 ? "options modifiées" : "option modifiée"}${problems > 0
        ? html` · <span class="error">${plural(problems, "problème")}</span>` : ""}</span>`)}
    ${tooOld && html`<div class="notice warn">Ce YAML demande la version ${minimum} du jeu, l'apworld fourni est en
      version ${data.world_version} : Archipelago refusera de générer la partie.</div>`}
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

function Editor({ index, file, setFile, onClose, advanced }) {
  const [active, setActive] = useState(0);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState(null);
  const [copied, setCopied] = useState(false);
  const entry = file.docs[Math.min(active, file.docs.length - 1)];
  const [, setApworlds] = useState(0);
  const knownGames = new Set([...index.games, ...localGames()].map((g) => g.game));
  const games = gamesOf(entry.js, knownGames);
  const missing = games.filter((g) => !gameEntry(g));
  const dirty = file.docs.some((d) => d.dirty.length);
  const blocked = missing.length
    ? `Ajoutez d'abord l'apworld de ${missing.map((g) => `« ${g} »`).join(", ")}.`
    : null;

  useEffect(() => { games.forEach((g) => gameEntry(g) && loadGame(g).catch(() => {})); }, [games.join("|")]);

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

  const exported = () => exportFile(file.original, file.docs, isWeightPath);
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

  return html`<div class="editor">
    <div class="toolbar">
      <div class="toolbar-row">
        <button type="button" class="ghost" title="Ouvrir un autre fichier"
          onClick=${() => (!dirty || confirm("Fermer ce fichier ? Les modifications non téléchargées seront perdues.")) && onClose()}>←</button>
        <strong class="file-name">${file.name || "Nouveau YAML"}</strong>
        <span class="spacer"></span>
        ${advanced && html`<button type="button" class="ghost" onClick=${() => setPreview(exported())}>Aperçu</button>`}
        <button type="button" class="ghost" disabled=${!!blocked} title=${blocked || ""} onClick=${copy}>${copied ? "Copié ✓" : "Copier"}</button>
        <button type="button" disabled=${!!blocked} title=${blocked || ""} onClick=${() => download(fileName(), exported())}>Télécharger</button>
      </div>
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

function newDocument(index, game) {
  const version = gameEntry(game)?.world_version;
  return {
    name: "Joueur{number}",
    description: `YAML ${game}`,
    game,
    requires: { version: index.ap_version, ...(version ? { game: { [game]: version } } : {}) },
    [game]: {},
  };
}

function Header({ index, advanced, setAdvanced, theme, setTheme }) {
  return html`<header class="site-header">
    <div class="brand"><span class="logo" aria-hidden="true">◆</span> Archipelago YAML Manager</div>
    <div class="header-tools">
      <label class="switch" title="Affiche les tirages au sort, les poids et le YAML brut">
        <input type="checkbox" checked=${advanced} onChange=${(e) => setAdvanced(e.target.checked)} />
        <span class="track"></span> Mode avancé
      </label>
      <select class="theme" value=${theme} onChange=${(e) => setTheme(e.target.value)} aria-label="Thème">
        <option value="auto">Thème auto</option>
        <option value="light">Clair</option>
        <option value="dark">Sombre</option>
      </select>
    </div>
  </header>`;
}

function App() {
  const [index, setIndex] = useState(null);
  const [error, setError] = useState(null);
  const [file, setFile] = useState(null);
  const [advanced, setAdvanced] = useSetting("advanced", false);
  const [theme, setTheme] = useSetting("theme", "auto");

  useEffect(() => { loadIndex().then(setIndex).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  let body;
  if (error) body = html`<main class="home"><div class="notice error">Impossible de charger la liste des jeux : ${error}</div></main>`;
  else if (!index) body = html`<main class="home"><p class="hint center">Chargement…</p></main>`;
  else if (!file) {
    body = html`<${Home} index=${index} onOpen=${setFile}
      onCreate=${(game) => setFile({ name: null, original: null, docs: [{ source: 0, js: newDocument(index, game), original: {}, dirty: [] }] })} />`;
  } else {
    body = html`<${Editor} index=${index} file=${file} setFile=${setFile} advanced=${advanced} onClose=${() => setFile(null)} />`;
  }

  return html`<${Header} index=${index} advanced=${advanced} setAdvanced=${setAdvanced} theme=${theme} setTheme=${setTheme} />${body}`;
}

render(html`<${App} />`, document.getElementById("app"));
