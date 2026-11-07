// Composants et petits outils partagés par l'éditeur et les rooms.
import { html, useEffect, useState } from "../vendor/preact-htm.js";

// `many` : forme du pluriel quand elle ne prend pas de « s » (jeu → jeux).
export const plural = (n, word, many = `${word}s`) => `${n} ${n > 1 ? many : word}`;

// Préférence mémorisée dans le navigateur (si le stockage est disponible).
export function useSetting(name, initial) {
  const [value, setValue] = useState(() => {
    try { return JSON.parse(localStorage.getItem(name)) ?? initial; } catch { return initial; }
  });
  const update = (next) => {
    setValue(next);
    try { localStorage.setItem(name, JSON.stringify(next)); } catch { /* stockage indisponible */ }
  };
  return [value, update];
}

// Action asynchrone d'un bouton : état « en cours » et message d'erreur.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try { return await fn(); } catch (e) { setError(e.message); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

export function CopyButton({ text, label = "Copier", className = "ghost small" }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); } catch { prompt("Copiez ce texte :", text); return; }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return html`<button type="button" class=${className} onClick=${copy}>${done ? "Copié ✓" : label}</button>`;
}

export function download(name, content, type = "text/yaml;charset=utf-8") {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Infos du tableur des jeux du Discord d'Archipelago, pour les jeux non officiels.
export const STABILITY = {
  Stable: { label: "Stable", group: "stables", cls: "" },
  Unstable: { label: "Instable", group: "instables", cls: "warn" },
  "Broken on Main": { label: "Cassé sur la version actuelle", group: "cassés sur la version actuelle", cls: "danger" },
};

export function SheetBadges({ sheet }) {
  if (!sheet) return null;
  const stability = STABILITY[sheet.stability];
  return html`${stability && html`<span class=${`badge ${stability.cls}`} title="Stabilité indiquée dans la liste des jeux du Discord d'Archipelago">${stability.label}</span>`}
    ${sheet.pr_status === "In Review" && html`<span class="badge" title="En cours d'intégration aux jeux officiels">Bientôt officiel</span>`}
    ${sheet.adult && html`<span class="badge danger" title="Contenu pour adultes ou non classé">18+</span>`}`;
}

// Liste des jeux avec recherche et filtres : le tableur en compte des centaines, trop pour un menu déroulant.
// Favoris (étoile) gardés dans le navigateur, genres relevés sur Wikidata (tools/fetch_genres.py).
export function GamePicker({ core, custom, imported, value, onChange, onCreate }) {
  const [search, setSearch] = useState("");
  const [savedKind, setKind] = useSetting("pickerKind", "all");
  const [genre, setGenre] = useSetting("pickerGenre", "");
  const [showAdult, setShowAdult] = useSetting("pickerAdult", false);
  const [showBroken, setShowBroken] = useSetting("pickerBroken", false);
  const [favorites, setFavorites] = useFavorites();
  const genres = useGenres();
  const genresOf = (g) => genres?.games[g.game]?.genres ?? [];
  const needle = search.trim().toLowerCase();
  const visible = (g) => (!needle || g.game.toLowerCase().includes(needle))
    && (showAdult || !g.sheet?.adult)
    && (showBroken || g.sheet?.stability !== "Broken on Main");
  const keep = (g) => visible(g) && (!genre || (genre === "none" ? !genresOf(g).length : genresOf(g).includes(genre)));
  const everything = [...imported, ...core, ...custom];
  const starred = everything.filter((g, i) => favorites.includes(g.game) && everything.findIndex((o) => o.game === g.game) === i);
  const kind = (savedKind === "favorites" && !starred.length) || (savedKind === "imported" && !imported.length) ? "all" : savedKind;
  const sections = [
    ["favorites", "★ Favoris", starred],
    ["imported", "Ajoutés avec un apworld", imported],
    ["core", "Jeux officiels", core],
    ...customGroups(custom).map(([label, games]) => ["custom", label, games]),
  ].filter(([k]) => kind === "all" || kind === k)
    .map(([k, label, games]) => [label, games.filter(keep)])
    .filter(([, games]) => games.length);
  const total = sections.reduce((n, [, games]) => n + games.length, 0);
  const kinds = [["all", "Tous"], ...(starred.length ? [["favorites", `★ Favoris (${starred.length})`]] : []),
    ["core", `Officiels (${core.length})`], ["custom", `Non officiels (${custom.length})`],
    ...(imported.length ? [["imported", `Ajoutés (${imported.length})`]] : [])];
  // Nombre de jeux par genre parmi ceux qu'affichent les autres filtres.
  const pool = (kind === "all" ? everything : kind === "favorites" ? starred
    : kind === "core" ? core : kind === "custom" ? custom : imported).filter(visible);
  const count = (key) => pool.filter((g) => (key === "none" ? !genresOf(g).length : genresOf(g).includes(key))).length;
  const toggleFavorite = (game) => setFavorites(favorites.includes(game) ? favorites.filter((f) => f !== game) : [...favorites, game]);

  return html`<div class="picker">
    <div class="row full">
      <input type="search" class="search" placeholder="Rechercher un jeu…" value=${search} onInput=${(e) => setSearch(e.target.value)} />
      <button type="button" disabled=${!value} onClick=${() => onCreate(value)}>${value ? `Créer un YAML pour ${value}` : "Créer un YAML"}</button>
    </div>
    <div class="row picker-filters">
      <div class="chips-row">${kinds.map(([k, label]) => html`<button type="button" class=${`chip-btn ${kind === k ? "active" : ""}`} onClick=${() => setKind(k)}>${label}</button>`)}</div>
      ${genres && html`<label class="picker-genre">Genre
        <select value=${genre} onChange=${(e) => setGenre(e.target.value)}>
          <option value="">Tous les genres</option>
          ${Object.entries(genres.genres).map(([key, label]) => html`<option value=${key}>${label} (${count(key)})</option>`)}
          <option value="none">Genre inconnu (${count("none")})</option>
        </select></label>`}
      <label class="check"><input type="checkbox" checked=${showBroken} onChange=${(e) => setShowBroken(e.target.checked)} /> Jeux cassés</label>
      <label class="check"><input type="checkbox" checked=${showAdult} onChange=${(e) => setShowAdult(e.target.checked)} /> Jeux 18+</label>
    </div>
    <div class="game-list" role="listbox" aria-label="Jeux">
      ${total === 0 && html`<p class="hint">Aucun jeu ne correspond.</p>`}
      ${sections.map(([label, games]) => html`<div class="game-section">
        <h3>${label} <span class="hint">${games.length}</span></h3>
        <div class="game-grid">${games.map((g) => {
          const starredGame = favorites.includes(g.game);
          const labels = genresOf(g).map((k) => genres.genres[k]).filter(Boolean);
          return html`<div class="game-cell">
            <button type="button" role="option" aria-selected=${value === g.game}
              class=${`game-tile ${value === g.game ? "selected" : ""}`} title=${labels.length ? `${g.game} · ${labels.join(", ")}` : g.game}
              onClick=${() => onChange(g.game)} onDblClick=${() => onCreate(g.game)}>
              <span class="game-name" lang="en">${g.game}</span>
              ${labels.length > 0 && html`<span class="game-genres">${labels.join(" · ")}</span>`}
              ${g.sheet && html`<span class="game-badges"><${SheetBadges} sheet=${g.sheet} /></span>`}
            </button>
            <button type="button" class=${`icon game-star ${starredGame ? "on" : ""}`} aria-pressed=${starredGame}
              aria-label=${starredGame ? `Retirer ${g.game} des favoris` : `Ajouter ${g.game} aux favoris`}
              title=${starredGame ? "Retirer des favoris" : "Ajouter aux favoris"}
              onClick=${() => toggleFavorite(g.game)}>${starredGame ? "★" : "☆"}</button>
          </div>`;
        })}</div>
      </div>`)}
    </div>
  </div>`;
}

// Jeux favoris, partagés par tous les choix de jeu ouverts (accueil, room, guides).
const favoriteListeners = new Set();
function useFavorites() {
  const [favorites, setFavorites] = useState(readFavorites);
  useEffect(() => {
    favoriteListeners.add(setFavorites);
    return () => favoriteListeners.delete(setFavorites);
  }, []);
  const update = (next) => {
    try { localStorage.setItem("favoriteGames", JSON.stringify(next)); } catch { /* stockage indisponible */ }
    for (const listener of favoriteListeners) listener(next);
  };
  return [favorites, update];
}

function readFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem("favoriteGames"));
    return Array.isArray(saved) ? saved : [];
  } catch { return []; }
}

// Genres des jeux (site/data/genres.json), chargés une seule fois.
let genresData = null;
function useGenres() {
  const [genres, setGenres] = useState(null);
  useEffect(() => {
    genresData ??= fetch("data/genres.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    genresData.then(setGenres);
  }, []);
  return genres;
}

function customGroups(custom) {
  const groups = new Map();
  for (const g of custom) {
    const stability = STABILITY[g.sheet?.stability];
    const label = stability ? `Jeux non officiels ${stability.group}` : "Jeux du serveur";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(g);
  }
  const order = ["Jeux du serveur", ...Object.values(STABILITY).map((s) => `Jeux non officiels ${s.group}`)];
  return [...groups].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}

// Crédits des apworlds non officiels (auteurs, dépôt, licence), chargés une seule fois.
let credits = null;
export function loadCredits() {
  credits ??= fetch("data/apworld-credits.json", { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  return credits;
}
