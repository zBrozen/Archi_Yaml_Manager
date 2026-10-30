// Composants et petits outils partagés par l'éditeur et les rooms.
import { html, useState } from "../vendor/preact-htm.js";

export const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

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
export function GamePicker({ core, custom, imported, value, onChange, onCreate }) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useSetting("pickerKind", "all");
  const [showAdult, setShowAdult] = useSetting("pickerAdult", false);
  const [showBroken, setShowBroken] = useSetting("pickerBroken", false);
  const needle = search.trim().toLowerCase();
  const keep = (g) => (!needle || g.game.toLowerCase().includes(needle))
    && (showAdult || !g.sheet?.adult)
    && (showBroken || g.sheet?.stability !== "Broken on Main");
  const sections = [
    ["imported", "Ajoutés avec un apworld", imported],
    ["core", "Jeux officiels", core],
    ...customGroups(custom).map(([label, games]) => ["custom", label, games]),
  ].filter(([k]) => kind === "all" || kind === k)
    .map(([k, label, games]) => [label, games.filter(keep)])
    .filter(([, games]) => games.length);
  const total = sections.reduce((n, [, games]) => n + games.length, 0);
  const kinds = [["all", "Tous"], ["core", `Officiels (${core.length})`], ["custom", `Non officiels (${custom.length})`],
    ...(imported.length ? [["imported", `Ajoutés (${imported.length})`]] : [])];

  return html`<div class="picker">
    <div class="row full">
      <input type="search" class="search" placeholder="Rechercher un jeu…" value=${search} onInput=${(e) => setSearch(e.target.value)} />
      <button type="button" disabled=${!value} onClick=${() => onCreate(value)}>${value ? `Créer un YAML pour ${value}` : "Créer un YAML"}</button>
    </div>
    <div class="row picker-filters">
      <div class="chips-row">${kinds.map(([k, label]) => html`<button type="button" class=${`chip-btn ${kind === k ? "active" : ""}`} onClick=${() => setKind(k)}>${label}</button>`)}</div>
      <label class="check"><input type="checkbox" checked=${showBroken} onChange=${(e) => setShowBroken(e.target.checked)} /> Jeux cassés</label>
      <label class="check"><input type="checkbox" checked=${showAdult} onChange=${(e) => setShowAdult(e.target.checked)} /> Jeux 18+</label>
    </div>
    <div class="game-list" role="listbox" aria-label="Jeux">
      ${total === 0 && html`<p class="hint">Aucun jeu ne correspond.</p>`}
      ${sections.map(([label, games]) => html`<div class="game-section">
        <h3>${label} <span class="hint">${games.length}</span></h3>
        <div class="game-grid">${games.map((g) => html`<button type="button" role="option" aria-selected=${value === g.game}
          class=${`game-tile ${value === g.game ? "selected" : ""}`} title=${g.game}
          onClick=${() => onChange(g.game)} onDblClick=${() => onCreate(g.game)}>
          <span class="game-name">${g.game}</span>
          ${g.sheet && html`<span class="game-badges"><${SheetBadges} sheet=${g.sheet} /></span>`}
        </button>`)}</div>
      </div>`)}
    </div>
  </div>`;
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
