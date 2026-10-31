// Page « Installer un jeu » (#/installer?game=…) : étapes communes à tous les jeux, puis pour le jeu choisi
// l'apworld à télécharger (jeux non officiels), les liens de son auteur et ses guides d'installation : ceux du
// dossier docs/ de son monde (les mêmes que sur archipelago.gg), le README de son dépôt et les notes de sa release
// (souvent là que l'auteur explique comment modder le jeu), relevés par tools/extract_options.py.
import { html, useState, useEffect } from "../vendor/preact-htm.js";
import { SheetBadges, GamePicker, loadCredits } from "./ui.js";
import { Markdown } from "./markdown.js";
import { useTrackers, packsFor, trackerLink } from "./trackers.js";

const AP_SITE = "https://archipelago.gg";
const AP_RELEASES = "https://github.com/ArchipelagoMW/Archipelago/releases";

// Dossier des fichiers des guides d'un jeu officiel sur archipelago.gg (nom de dossier à la façon de
// secure_filename de Werkzeug, qu'utilise le site : « A Link to the Past » → « A_Link_to_the_Past »).
const docsFolder = (game) => `${AP_SITE}/static/generated/docs/${encodeURIComponent(String(game).normalize("NFKD")
  .replace(/[^\x00-\x7f]/g, "").trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.-]/g, "").replace(/^[._]+|[._]+$/g, ""))}/`;

export const guideLink = (game) => `#/installer?game=${encodeURIComponent(game)}`;

const guideCache = new Map();
function loadGuides(entry) {
  if (!entry?.guides) return Promise.resolve(null);
  if (!guideCache.has(entry.game)) {
    guideCache.set(entry.game, fetch(`data/${entry.guides}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return guideCache.get(entry.game);
}

// Nom lisible d'un lien du tableur des jeux.
function linkLabel(href) {
  let url;
  try { url = new URL(href); } catch { return href; }
  const host = url.hostname.replace(/^www\./, "");
  if (host === "discord.com" || host === "discordapp.com") return "Discussion sur Discord";
  if (host === "github.com" || host === "gitlab.com") {
    const path = url.pathname.split("/").filter(Boolean);
    return `${path.slice(0, 2).join("/")}${path[2] === "releases" ? " (releases)" : path[2] === "wiki" ? " (wiki)" : ""}`;
  }
  return host;
}

const safeUrl = (href) => {
  try { return ["http:", "https:"].includes(new URL(href).protocol) ? href : null; } catch { return null; }
};

export function GuidesPage({ index, game: initial, onCreate }) {
  const [game, setGame] = useState(initial && index.games.some((g) => g.game === initial) ? initial : "");
  const core = index.games.filter((g) => g.source === "core");
  const custom = index.games.filter((g) => g.source !== "core");
  const choose = (name) => {
    setGame(name);
    // Adresse partageable, sans repasser par le routeur (qui remonterait en haut de la page).
    history.replaceState(null, "", name ? guideLink(name) : "#/installer");
  };

  return html`<main class="home guides">
    <div class="intro">
      <h1>Installer un jeu</h1>
      <p>Tout ce qu'il faut pour jouer un jeu dans une partie Archipelago : le programme, l'apworld des jeux non
        officiels et le guide d'installation du jeu, sans chercher sur GitHub.</p>
    </div>

    <section class="card stack">
      <h2>1. Archipelago</h2>
      <p>Installez <strong>Archipelago ${index.ap_version}</strong> (version utilisée par ce site) : sous Windows,
        le fichier <code>Setup.Archipelago.….exe</code> de la release. Son <strong>Launcher</strong> regroupe
        les clients des jeux et les outils.</p>
      <div class="row">
        <a class="button" href=${`${AP_RELEASES}/tag/${encodeURIComponent(index.ap_version)}`} target="_blank" rel="noopener">Télécharger Archipelago ${index.ap_version}</a>
        <a class="button ghost" href=${`${AP_SITE}/tutorial/Archipelago/setup/en`} target="_blank" rel="noopener">Guide officiel (anglais)</a>
      </div>
    </section>

    <section class="card stack">
      <h2>2. Choisir le jeu</h2>
      <${GamePicker} core=${core} custom=${custom} imported=${[]} value=${game} onChange=${choose} onCreate=${onCreate} />
    </section>

    ${game && html`<${GameGuide} key=${game} entry=${index.games.find((g) => g.game === game)} onCreate=${onCreate} />`}
  </main>`;
}

function GameGuide({ entry, onCreate }) {
  const official = entry.source === "core";
  const [guides, setGuides] = useState(entry.guides ? undefined : null);
  const [credit, setCredit] = useState(official ? null : undefined); // undefined : en cours de chargement
  const [tab, setTab] = useState(0);
  const trackers = useTrackers();
  useEffect(() => {
    loadGuides(entry).then(setGuides);
    if (!official) loadCredits().then((list) => setCredit(list.find((c) => c.file === entry.apworld) || null));
  }, [entry.game]);

  const packs = packsFor(trackers, entry.game);
  const download = credit && safeUrl(credit.download);
  const source = credit && safeUrl(credit.source);
  const links = [...new Set([source, ...(credit?.links || []).map(safeUrl)].filter(Boolean))];

  // Onglets : guides d'installation de l'apworld, README du dépôt, notes de la release, puis la page du jeu
  // (ce qui change dans la partie). `base` : dossier des liens relatifs, `imageBase` : celui des images.
  const languages = new Set(guides?.tutorials.map((t) => t.language));
  const apSite = (url) => ({ url, site: "archipelago.gg", base: official ? docsFolder(entry.game) : null });
  const readme = guides?.readme, notes = guides?.notes;
  const pages = guides ? [
    ...guides.tutorials.map((t) => ({ ...t, label: `${t.title || "Guide"}${languages.size > 1 ? ` (${t.language})` : ""}`,
      ...apSite(official && t.link ? `${AP_SITE}/tutorial/${encodeURIComponent(entry.game)}/${t.link}` : null) })),
    ...(readme ? [{ ...readme, label: "README du projet", site: "GitHub", url: safeUrl(readme.url), base: safeUrl(readme.url), imageBase: safeUrl(readme.raw) }] : []),
    ...(notes ? [{ ...notes, label: `Notes de la release${notes.tag ? ` ${notes.tag}` : ""}`, site: "la page de la release", url: safeUrl(notes.url), base: safeUrl(notes.url) }] : []),
    ...guides.info.map((p) => ({ ...p, label: `Présentation du jeu${guides.info.length > 1 ? ` (${p.language})` : ""}`,
      ...apSite(official ? `${AP_SITE}/games/${encodeURIComponent(entry.game)}/info/${p.language}` : null) })),
  ] : [];
  const page = pages[Math.min(tab, pages.length - 1)];

  return html`<section class="card stack guide">
    <div class="game-head full">
      <h2>3. ${entry.game}</h2>
      <span class=${`badge ${official ? "" : "accent"}`}>${official ? "Jeu officiel" : "Jeu non officiel"}</span>
      <${SheetBadges} sheet=${entry.sheet} />
      ${entry.world_version && html`<span class="badge">v${entry.world_version}</span>`}
    </div>

    <ol class="steps full">
      ${official
        ? html`<li>Rien à ajouter à Archipelago : ce jeu y est inclus.</li>`
        : html`<li><div class="stack">
          <span>Téléchargez l'apworld du jeu${credit?.version ? ` (version ${credit.version})` : ""}, celui avec lequel ce site lit les options :</span>
          <div class="row">
            ${download
              ? html`<a class="button" href=${download} rel="noopener">Télécharger ${entry.apworld}</a>`
              : source && html`<a class="button" href=${source} target="_blank" rel="noopener">Page du jeu (apworld dans les releases)</a>`}
            ${credit?.release && safeUrl(credit.release) && html`<a class="button ghost" href=${credit.release} target="_blank" rel="noopener">Notes de la release</a>`}
          </div>
          ${credit === undefined && html`<span class="hint">Chargement des liens…</span>`}
          ${credit === null && html`<span class="hint">Lien de téléchargement inconnu : voyez les liens de l'auteur ci-dessous.</span>`}
        </div></li>
        <li>Installez-le : double-cliquez sur le fichier <code>.apworld</code> (Archipelago le copie
          dans son dossier <code>custom_worlds</code>), ou dans le Launcher, <strong>Install APWorld</strong>. Relancez ensuite le Launcher.</li>`}
      ${entry.rom && html`<li><strong>Ce jeu se joue avec votre propre copie</strong> (ROM ou fichier du jeu) : le site ne la fournit pas.
        ${entry.rom.description && html` <span class="hint">Fichier demandé : ${entry.rom.description}.</span>`}</li>`}
      <li>${pages.length
        ? html`Préparez le jeu pour Archipelago (mod, client, patch… selon le jeu) en suivant le guide ci-dessous.
          ${pages.length > 1 ? " Chaque onglet est une source différente : lisez-les tous." : ""}`
        : guides === undefined ? "Chargement du guide…"
          : html`Préparez le jeu pour Archipelago (mod, client, patch… selon le jeu) : ${official
            ? "voyez sa page sur archipelago.gg" : "son auteur n'a pas publié de guide lisible ici, voyez ses liens ci-dessous"}.`}</li>
      <li><div class="stack">
        <span>Créez votre YAML (vos options pour ce jeu), puis rejoignez la partie.</span>
        <div class="row">
          <button type="button" onClick=${() => onCreate(entry.game)}>Créer un YAML pour ${entry.game}</button>
          ${packs.length > 0 && html`<a class="button ghost" href=${trackerLink({ game: entry.game })}>Tracker de ce jeu</a>`}
        </div>
      </div></li>
    </ol>

    ${(links.length > 0 || official) && html`<div class="guide-links full">
      <span class="hint">Liens :</span>
      ${official && html`<a href=${`${AP_SITE}/games/${encodeURIComponent(entry.game)}/info/en`} target="_blank" rel="noopener">Page du jeu sur archipelago.gg</a>`}
      ${links.map((href) => html`<a href=${href} target="_blank" rel="noopener">${linkLabel(href)}</a>`)}
    </div>`}

    ${pages.length > 0 && html`<div class="guide-doc full">
      ${pages.length > 1 && html`<div class="chips-row" role="tablist">${pages.map((p, i) => html`<button type="button" role="tab"
        aria-selected=${p === page} class=${`chip-btn ${p === page ? "active" : ""}`} onClick=${() => setTab(i)}>${p.label}</button>`)}</div>`}
      <div class="guide-meta hint">
        ${page.description && html`<span>${page.description}</span>`}
        ${page.authors?.length > 0 && html`<span>Par ${page.authors.join(", ")}</span>`}
        ${page.url && html`<a href=${page.url} target="_blank" rel="noopener">Voir sur ${page.site}</a>`}
      </div>
      <${Markdown} key=${tab} text=${page.text} base=${page.base} imageBase=${page.imageBase} />
    </div>`}
  </section>`;
}
