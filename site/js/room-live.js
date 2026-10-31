// Partie en cours sur archipelago.gg : progression de chaque joueur (API publique du tracker) et client texte
// dans le navigateur (archipelago.js), pour le chat et les commandes !hint, !remaining… sans lancer Archipelago.
import { html, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { Client } from "../vendor/archipelago.js";
import { api, apRoomStatus } from "./rooms-api.js";
import { plural } from "./ui.js";
import { useTrackers, packsFor, trackerLink } from "./trackers.js";

const STATUS = {
  0: { label: "Hors ligne", cls: "" },
  5: { label: "Connecté", cls: "accent" },
  10: { label: "Prêt", cls: "accent" },
  20: { label: "En jeu", cls: "accent" },
  30: { label: "Terminé", cls: "ok" },
};
const IDLE_WARNING = 48 * 3600 * 1000; // en async, joueur sans activité depuis 2 jours

export function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

const bySlot = (list, key) => new Map((list || []).filter((e) => e.team === 0).map((e) => [e.player, e[key]]));

// --- Progression -------------------------------------------------------------------

// Une ligne par joueur, à partir des API tracker (`live`) et static_tracker (`fixed`) d'archipelago.gg.
export function progressRows(status, live, fixed) {
  const done = bySlot(live.player_checks_done, "locations");
  const states = bySlot(live.player_status, "status");
  const activity = bySlot(live.activity_timers, "time");
  const connection = bySlot(live.connection_timers, "time");
  const hints = bySlot(live.hints, "hints");
  const received = bySlot(live.player_items_received, "items");
  const totals = bySlot(fixed.player_locations_total, "total_locations");
  return status.slots.filter((s) => totals.has(s.slot)).map((s) => {
    const last = activity.get(s.slot) || connection.get(s.slot);
    return {
      ...s,
      checks: done.get(s.slot)?.length || 0,
      total: totals.get(s.slot) || 0,
      state: STATUS[states.get(s.slot)] || STATUS[0],
      finished: states.get(s.slot) === 30,
      last: last ? Date.parse(last) : null,
      hints: hints.get(s.slot)?.length || 0,
      items: received.get(s.slot)?.length || 0,
    };
  });
}

// Tracker de la partie (API publique d'archipelago.gg), relu chaque minute tant que la page est visible.
export function useTracker(status) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const trackerId = status?.trackerId;
  const origin = status?.origin;

  useEffect(() => {
    if (!trackerId) return;
    let alive = true;
    const get = (path) => fetch(`${origin}/api/${path}/${trackerId}`).then((r) => {
      if (!r.ok) throw new Error(`Tracker indisponible (${r.status}).`);
      return r.json();
    });
    const totals = get("static_tracker");
    const load = () => Promise.all([get("tracker"), totals])
      .then(([live, fixed]) => alive && (setData({ live, fixed }), setError(null)))
      .catch((e) => alive && setError(e.message));
    load();
    // Le tracker d'archipelago.gg est mis en cache une minute : inutile de demander plus souvent.
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 60000);
    return () => { alive = false; clearInterval(timer); };
  }, [trackerId, origin]);

  return { trackerId, data, error };
}

// `compact` : total et lignes de vos joueurs seulement, avec un lien vers la vue détaillée (`onDetails`).
// `onItems(slot)` : ouvre les objets reçus d'un joueur.
export function ProgressPanel({ status, tracker, mode, mine, code, compact = false, onDetails, onItems }) {
  const { trackerId, data, error } = tracker;
  const packs = useTrackers();
  if (!trackerId) return null;
  if (error && !data) return html`<p class="hint">${error}</p>`;
  if (!data) return html`<p class="hint">Chargement de la progression…</p>`;

  const names = new Set(mine.map((s) => s.name.toLowerCase()));
  const rows = progressRows(status, data.live, data.fixed).map((r) => ({ ...r, mine: names.has(r.name.toLowerCase()) }));
  const sum = rows.reduce((n, r) => n + r.checks, 0);
  const all = rows.reduce((n, r) => n + r.total, 0);
  const finished = rows.filter((r) => r.finished).length;
  const pct = (a, b) => (b ? Math.floor((a / b) * 100) : 0);
  const shown = compact ? rows.filter((r) => r.mine) : rows;

  return html`<div class="stack full">
    <div class="row full">
      <h3 class="grow">Progression</h3>
      <span class="hint">${sum} / ${all} checks (${pct(sum, all)} %) · ${finished} / ${rows.length} terminé${finished > 1 ? "s" : ""}</span>
    </div>
    <div class="progress full" title=${`${pct(sum, all)} %`}><span style=${`width: ${pct(sum, all)}%`}></span></div>
    ${shown.length > 0 && html`<div class="table-wrap full"><table class="room-table progress-table">
      <thead><tr><th>Joueur</th><th>Jeu</th><th>Checks</th><th>Objets reçus</th><th>État</th><th>Dernière activité</th></tr></thead>
      <tbody>${shown.map((r) => {
        const idle = mode === "async" && !r.finished && r.last && Date.now() - r.last > IDLE_WARNING;
        return html`<tr class=${r.mine ? "mine" : ""}>
          <td><strong>${r.name}</strong>${r.tracker && html` <a href=${r.tracker} target="_blank" rel="noopener" class="small">tracker</a>`}
            ${packsFor(packs, r.game).some((p) => p.url) && html` <a href=${trackerLink({ game: r.game, server: status.port ? `${status.host}:${status.port}` : "", slot: r.name, room: code })}
              class="small" title="Objets, cartes et lieux accessibles, d'après le pack PopTracker du jeu">tracker du pack</a>`}</td>
          <td>${r.game}</td>
          <td class="checks">
            <div class="progress small" title=${`${pct(r.checks, r.total)} %`}><span class=${r.finished ? "ok" : ""} style=${`width: ${pct(r.checks, r.total)}%`}></span></div>
            <span class="hint">${r.checks} / ${r.total}${r.hints ? ` · ${r.hints} indice${r.hints > 1 ? "s" : ""}` : ""}</span>
          </td>
          <td>${onItems && r.items
            ? html`<button type="button" class="link" onClick=${() => onItems(r.slot)} title="Voir les objets reçus">${plural(r.items, "objet")}</button>`
            : html`<span class="hint">${plural(r.items, "objet")}</span>`}</td>
          <td><span class=${`badge ${r.state.cls}`}>${r.state.label}</span></td>
          <td>${r.last ? html`<span class=${idle ? "badge warn" : "hint"}>${ago(r.last)}</span>` : html`<span class="hint">jamais</span>`}</td>
        </tr>`;
      })}</tbody>
    </table></div>`}
    <p class="hint">Mise à jour toutes les 1 à 3 minutes : archipelago.gg n'enregistre la progression qu'une fois par minute,
      et son tracker la garde en cache une minute de plus.</p>
    ${compact && onDetails && html`<button type="button" class="link" onClick=${onDetails}>Voir la progression de tous les joueurs →</button>`}
    ${error && html`<p class="hint">${error} Dernières données affichées.</p>`}
  </div>`;
}

// --- Objets reçus ------------------------------------------------------------------

// Le tracker donne les objets en identifiants : [objet, lieu, joueur qui l'a envoyé, drapeaux]. Les noms
// viennent du « datapackage » de chaque jeu (objets : jeu du joueur qui reçoit ; lieux : jeu de celui qui envoie).
const packages = new Map();
const invert = (names) => new Map(Object.entries(names || {}).map(([name, id]) => [id, name]));
function loadPackage(origin, checksum) {
  const key = `${origin}/${checksum}`;
  if (!packages.has(key)) {
    packages.set(key, fetch(`${origin}/api/datapackage/${checksum}`)
      .then((r) => { if (!r.ok) throw new Error(`Noms des objets indisponibles (${r.status}).`); return r.json(); })
      .then((p) => ({
        items: invert(p.item_name_to_id),
        locations: invert(p.location_name_to_id),
        locationIds: new Map(Object.entries(p.location_name_to_id || {})),
      }))
      .catch((e) => { packages.delete(key); throw e; }));
  }
  return packages.get(key);
}

export function usePackages(origin, fixed, games) {
  const [loaded, setLoaded] = useState({});
  const [error, setError] = useState(null);
  const key = games.join("\n");
  useEffect(() => {
    let alive = true;
    for (const game of games) {
      const checksum = fixed?.datapackage?.[game]?.checksum;
      if (!checksum || loaded[game]) continue;
      loadPackage(origin, checksum).then(
        (p) => alive && setLoaded((all) => ({ ...all, [game]: p })),
        (e) => alive && setError(e.message),
      );
    }
    return () => { alive = false; };
  }, [origin, key, fixed]);
  return { loaded, error };
}

const asItem = (i) => (Array.isArray(i) ? { item: i[0], location: i[1], player: i[2], flags: i[3] } : i);
// Objets reçus par un joueur (numéro de slot), d'après le tracker.
export const receivedItems = (live, slot) => (live?.player_items_received || [])
  .find((e) => e.team === 0 && e.player === slot)?.items.map(asItem) || [];
const kindOf = (flags) => (flags & 1 ? "progression" : flags & 4 ? "trap" : flags & 2 ? "useful" : "filler");
const GROUPS = [
  ["progression", "Progression", "de progression"],
  ["useful", "Utiles", "utile"],
  ["trap", "Pièges", "piège"],
  ["filler", "Autres objets", null],
];
const RECENT = 12;

// --- Inventaire de départ ----------------------------------------------------------
// Sphère 0 : objets avec lesquels un joueur commence (start_inventory de son YAML, ou donnés par son monde). L'API du
// tracker ne les donne pas : le service lit l'inventaire du tracker générique du joueur, qui les compte avec les objets
// reçus ; la différence avec les objets reçus de l'API donne ceux de départ. Le résultat n'est gardé que si les deux
// lectures sont du même moment : le dernier objet reçu selon l'API est aussi le dernier arrivé sur la page.
// `rows` : [{ name, amount, order }] (order : rang de la dernière arrivée, l'inventaire de départ d'abord).
// Renvoie Map(nom → nombre), ou null si les deux lectures ne concordent pas.
export function startingFrom(rows, received, itemName) {
  const total = rows.reduce((n, r) => n + r.amount, 0);
  if (total < received.length) return null;
  if (received.length) {
    const last = itemName(received.at(-1).item);
    if (!rows.some((r) => r.order === total - 1 && r.name === last)) return null;
  }
  const counts = new Map();
  for (const i of received) counts.set(itemName(i.item), (counts.get(itemName(i.item)) || 0) + 1);
  const start = new Map();
  for (const r of rows) if (r.amount > (counts.get(r.name) || 0)) start.set(r.name, r.amount - (counts.get(r.name) || 0));
  return start;
}

// Inventaire de départ d'un joueur, calculé une fois par visite (il ne change pas pendant la partie). Tant que le
// tracker générique et l'API ne concordent pas, nouvel essai à chaque rafraîchissement du tracker.
// `itemName` : null tant que les noms des objets du jeu ne sont pas chargés. Renvoie undefined tant qu'il n'est pas connu.
const startingItems = new Map(); // `code|slot` → Map(nom → nombre), ou null (room hors d'archipelago.gg)
function useStartingItems(code, slot, received, itemName) {
  const key = `${code}|${slot}`;
  const [, setFound] = useState(0);
  useEffect(() => {
    if (!code || !itemName || startingItems.has(key)) return undefined;
    let alive = true;
    api.apInventory(code, slot).then(({ items }) => {
      const start = items ? startingFrom(items, received, itemName) : null;
      if (start || !items) startingItems.set(key, start);
      if (alive && startingItems.has(key)) setFound((n) => n + 1);
    }).catch(() => { /* tracker indisponible : nouvel essai au prochain rafraîchissement */ });
    return () => { alive = false; };
  }, [key, !!itemName, received.length]);
  return startingItems.get(key);
}

// Joueurs affichés par défaut : les vôtres, sinon le premier de la partie.
export function defaultItemSlots(status, mine) {
  const own = status.slots.filter((s) => mine.some((m) => m.name.toLowerCase() === s.name.toLowerCase())).map((s) => s.slot);
  return own.length ? own : status.slots.slice(0, 1).map((s) => s.slot);
}

// Objets reçus par les joueurs cochés (`selected` : numéros de slot), avec une recherche commune à tous.
export function ItemsPanel({ status, tracker, mine, selected, onSelected, code }) {
  const [search, setSearch] = useState("");
  const names = new Set(mine.map((s) => s.name.toLowerCase()));
  const own = status.slots.filter((s) => names.has(s.name.toLowerCase()));
  const slots = [...own, ...status.slots.filter((s) => !names.has(s.name.toLowerCase()))];
  const live = tracker.data?.live;
  const shown = slots.filter((s) => selected.includes(s.slot));
  const needle = search.trim().toLowerCase();
  const toggle = (slot, on) => onSelected(on ? [...selected, slot] : selected.filter((n) => n !== slot));

  return html`<div class="row full">
      <h2 class="grow">Objets reçus</h2>
      <input type="search" class="items-search" placeholder="Rechercher un objet reçu…" value=${search}
        onInput=${(e) => setSearch(e.target.value)} aria-label="Rechercher un objet reçu" />
    </div>
    <fieldset class="items-players full">
      <legend>Joueurs affichés</legend>
      <div class="items-players-list">${slots.map((s) => {
        const n = receivedItems(live, s.slot).length;
        return html`<label class=${`player-check ${selected.includes(s.slot) ? "on" : ""}`}>
          <input type="checkbox" checked=${selected.includes(s.slot)} onChange=${(e) => toggle(s.slot, e.target.checked)} />
          <span><strong>${s.name}</strong> <span class="hint">${s.game}${live ? ` · ${plural(n, "objet")}` : ""}</span></span>
        </label>`;
      })}</div>
      <div class="row">
        <button type="button" class="link" onClick=${() => onSelected(slots.map((s) => s.slot))}>Tout cocher</button>
        ${own.length > 0 && html`<button type="button" class="link" onClick=${() => onSelected(own.map((s) => s.slot))}>Mes joueurs</button>`}
        <button type="button" class="link" onClick=${() => onSelected([])}>Tout décocher</button>
      </div>
    </fieldset>
    ${!live ? html`<p class="hint">${tracker.error || "Chargement des objets…"}</p>`
      : !shown.length ? html`<p class="hint">Cochez un ou plusieurs joueurs pour voir leurs objets.</p>`
      : html`<div class="items-players-view full">${shown.map((s) => html`<${PlayerItems} key=${s.slot} slot=${s} status=${status} code=${code}
          tracker=${tracker} needle=${needle} search=${search.trim()} titled=${shown.length > 1} />`)}</div>`}`;
}

// Objets d'un joueur : regroupés par importance (avec le nombre d'exemplaires), puis les derniers arrivés.
// Avec une recherche, seuls les objets dont le nom la contient restent, et tous ceux arrivés sont listés.
function PlayerItems({ slot, status, tracker, needle, search, titled, code }) {
  const [all, setAll] = useState(false);
  const received = receivedItems(tracker.data.live, slot.slot);
  const gameOf = (player) => (player === 0 ? "Archipelago" : status.slots.find((s) => s.slot === player)?.game);
  const nameOf = (player) => status.slots.find((s) => s.slot === player)?.name || `Joueur ${player}`;
  const games = [...new Set([slot.game, ...received.map((i) => gameOf(i.player))].filter(Boolean))].sort();
  const { loaded, error } = usePackages(status.origin, tracker.data.fixed, games);

  const pkg = loaded[slot.game];
  const waiting = !pkg && !error && tracker.data.fixed?.datapackage?.[slot.game];
  const itemName = (id) => pkg?.items.get(id) || `Objet n° ${id}`;
  const origin = (i) => {
    if (i.player === 0) return i.location === -2 ? "inventaire de départ" : "donné par le serveur";
    const place = loaded[gameOf(i.player)]?.locations.get(i.location);
    const from = i.player === slot.slot ? "trouvé dans son propre monde" : `envoyé par ${nameOf(i.player)}`;
    return place ? `${from} · ${place}` : from;
  };
  const matching = received.map((i, index) => ({ ...i, index, name: itemName(i.item) }))
    .filter((i) => !needle || i.name.toLowerCase().includes(needle));
  const start = useStartingItems(code, slot.slot, received, pkg ? itemName : null);
  const startShown = [...(start || [])].filter(([name]) => !needle || name.toLowerCase().includes(needle))
    .sort((a, b) => a[0].localeCompare(b[0]));
  const startCount = startShown.reduce((n, [, k]) => n + k, 0);

  const groups = Object.fromEntries(GROUPS.map(([kind]) => [kind, new Map()]));
  for (const i of matching) {
    const group = groups[kindOf(i.flags)];
    group.set(i.name, (group.get(i.name) || 0) + 1);
  }
  const counts = GROUPS.map(([kind, label, word]) => ({ kind, label, word, n: [...groups[kind].values()].reduce((a, b) => a + b, 0) }))
    .filter((g) => g.n);
  const recent = [...matching].reverse().slice(0, all || needle ? undefined : RECENT);

  const tags = (kind) => html`<ul class="item-tags">${[...groups[kind]].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, n]) => html`<li><span class=${ITEM_KINDS[kind].cls}>${name}</span>${n > 1 && html`<span class="item-count">×${n}</span>`}</li>`)}</ul>`;
  const title = ({ kind, label, n }) => html`<h4><span class=${ITEM_KINDS[kind].cls}>${ITEM_KINDS[kind].mark}${label}</span> <span class="hint">${n}</span></h4>`;
  const summary = needle
    ? `${plural(matching.length, "objet")} sur ${received.length} pour « ${search} »${startCount ? ` · ${startCount} au départ` : ""}`
    : `${plural(received.length, "objet")} reçu${received.length > 1 ? "s" : ""}${counts.filter((g) => g.word)
      .map((g) => ` · ${g.n} ${g.kind === "progression" || g.n < 2 ? g.word : `${g.word}s`}`).join("")}${
      startCount ? ` · ${startCount} au départ` : ""}`;

  // Recherche sans résultat chez ce joueur : une seule ligne, pour ne pas encombrer quand plusieurs sont cochés.
  if (needle && pkg && !matching.length && !startCount) {
    return html`<p class="items-player-block items-none hint">${titled && html`<strong>${slot.name}</strong> : `}aucun objet reçu ne contient « ${search} » (${plural(received.length, "objet")} au total).</p>`;
  }
  return html`<section class="items-player-block">
    ${titled && html`<h3>${slot.name} <span class="hint">${slot.game}</span></h3>`}
    <p class="hint">${summary}</p>
    ${error && html`<p class="hint">${error} Les objets sont affichés par numéro.</p>`}
    ${received.length === 0 && !startCount ? html`<p class="hint">Aucun objet reçu pour l'instant.</p>`
      : waiting ? html`<p class="hint">Chargement des noms d'objets…</p>`
      : html`<div class="items-panel">
        ${startCount > 0 && html`<div class="items-group">
          <h4>Inventaire de départ <span class="hint">sphère 0 · ${startCount}</span></h4>
          <ul class="item-tags">${startShown.map(([name, n]) => html`<li><span>${name}</span>${n > 1 && html`<span class="item-count">×${n}</span>`}</li>`)}</ul>
        </div>`}
        ${counts.map((g) => (g.kind === "filler"
          ? html`<details class="items-group" open=${!!needle}><summary>${title(g)}</summary>${tags(g.kind)}</details>`
          : html`<div class="items-group">${title(g)}${tags(g.kind)}</div>`))}
        ${matching.length > 0 && html`<div class="items-group">
          <h4>${needle ? "Arrivées correspondantes" : "Derniers objets reçus"}</h4>
          <ol class="item-feed">${recent.map((i) => {
            const kind = ITEM_KINDS[kindOf(i.flags)];
            return html`<li key=${i.index}>
              <span class="hint item-index">${i.index + 1}</span>
              <span class=${kind.cls} title=${kind.title}>${kind.mark}${i.name}</span>
              <span class="hint item-origin">${origin(i)}</span>
            </li>`;
          })}</ol>
          ${!needle && received.length > RECENT && html`<button type="button" class="link" onClick=${() => setAll(!all)}>
            ${all ? "Afficher seulement les derniers" : `Afficher les ${received.length} objets`}</button>`}
        </div>`}
      </div>`}
  </section>`;
}

// --- Client texte ------------------------------------------------------------------

const QUICK = [
  { text: "!hint ", label: "!hint", title: "Demander un indice : complétez avec le nom d'un objet", fill: true },
  { text: "!remaining", label: "!remaining", title: "Objets qu'il vous reste à recevoir" },
  { text: "!release", label: "!release", title: "Envoyer vos objets restants aux autres (selon les réglages de la partie)",
    confirm: "Envoyer à tous les autres joueurs les objets qui restent dans votre monde ? C'est définitif." },
  { text: "!collect", label: "!collect", title: "Récupérer vos objets chez les autres (selon les réglages de la partie)" },
  { text: "!help", label: "!help", title: "Liste des commandes" },
];

// Couleurs du client texte d'Archipelago : vous en magenta, les autres joueurs en jaune, objets selon leur
// importance (progression, utile, piège, sans importance), lieux en vert, entrées en bleu. Les couleurs et
// mises en forme envoyées par le serveur (hints trouvés, erreurs…) sont reprises telles quelles.
// `mark` : symbole affiché devant l'objet quand il ne faut pas compter sur la couleur seule (overlay de stream).
const ITEM_KINDS = {
  progression: { cls: "ap-progression", title: "Objet de progression", mark: "★ " },
  trap: { cls: "ap-trap", title: "Piège", mark: "⚠ " },
  useful: { cls: "ap-useful", title: "Objet utile", mark: "" },
  filler: { cls: "ap-filler", title: "Objet sans importance", mark: "" },
};
export const itemKind = (item) => ITEM_KINDS[item.progression ? "progression" : item.trap ? "trap" : item.useful ? "useful" : "filler"];

// Wishlists de la room ({ joueur: [objets] }) : un objet de la wishlist de celui qui le reçoit est mis en avant
// (♥, et la ligne entière quand il vient d'être envoyé : pas pour un indice, l'objet n'est alors pas encore reçu).
// Objet de wishlist : un nom, ou { name, after } quand le joueur attend un exemplaire de plus d'un objet déjà reçu
// `after` fois (progressif, cumulable…).
export const wishEntry = (w) => (w && typeof w === "object" ? { name: String(w.name), after: Number(w.after) || 0 } : { name: String(w), after: 0 });
export const wishIndex = (wishlists = {}) => new Map(Object.entries(wishlists)
  .map(([slot, items]) => [slot.toLowerCase(), new Set(items.map((i) => wishEntry(i).name))]));
const isWished = (wishes, node) => node.type === "item" && !!wishes?.get(String(node.item.receiver?.name).toLowerCase())?.has(node.item.name);
export const wishHit = (wishes, nodes) => !!wishes?.size && !String(nodes[0]?.text || "").startsWith("[Hint]")
  && nodes.some((node) => isWished(wishes, node));

export function MessagePart({ node, self, marks = false, wishes }) {
  switch (node.type) {
    case "player":
      return html`<span class=${node.player?.name === self || node.text === self ? "ap-self" : "ap-player"}>${node.text}</span>`;
    case "item": {
      const kind = itemKind(node.item);
      const wished = isWished(wishes, node);
      return html`<span class=${`${kind.cls} ${wished ? "wish-item" : ""}`} title=${wished ? `${kind.title}, dans la wishlist de ${node.item.receiver?.name}` : kind.title}>${
        wished && "♥ "}${marks && kind.mark}${node.text}</span>`;
    }
    case "location":
      return html`<span class="ap-location">${node.text}</span>`;
    case "entrance":
      return html`<span class="ap-entrance">${node.text}</span>`;
    case "color":
      return html`<span class=${`ap-${String(node.color).replace(/_/g, "-")}`}>${node.text}</span>`;
    default:
      return node.text;
  }
}

export function TextClient({ room, status, mine, wishlists }) {
  const own = status.slots.filter((s) => mine.some((m) => m.name.toLowerCase() === s.name.toLowerCase()));
  const [slot, setSlot] = useState((own[0] || status.slots[0])?.name || "");
  const [password, setPassword] = useState("");
  const [state, setState] = useState("idle"); // idle, connecting, connected, closed
  const [error, setError] = useState(null);
  const [lines, setLines] = useState([]);
  const [input, setInput] = useState("");
  const client = useRef(null);
  const log = useRef(null);
  const nextId = useRef(0);

  const wishes = wishIndex(wishlists);
  const push = (line) => setLines((all) => [...all.slice(-499), { id: nextId.current++, ...line }]);
  useEffect(() => () => client.current?.socket.disconnect(), []);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [lines]);

  const connect = async () => {
    setState("connecting");
    setError(null);
    try {
      // Lire la page de la room (par le service) réveille le serveur s'il est en veille ; le port peut alors changer.
      await api.apLinks(room.code).catch(() => {});
      const fresh = await apRoomStatus(room.code, room.ap_room_url);
      if (!fresh.port) throw new Error("Le serveur de la partie ne répond pas encore : réessayez dans quelques secondes.");
      const next = new Client();
      next.messages.on("message", (text, nodes) => push({ nodes }));
      next.socket.on("disconnected", () => { if (client.current === next) setState("closed"); });
      client.current = next;
      push({ info: `Connexion à ${fresh.host}:${fresh.port} en tant que ${slot}…` });
      await next.login(`wss://${fresh.host}:${fresh.port}`, slot, undefined, { password, slotData: false, tags: ["TextOnly"] });
      setState("connected");
    } catch (e) {
      client.current?.socket.disconnect();
      client.current = null;
      setState("idle");
      setError(e?.message || String(e));
    }
  };
  const disconnect = () => {
    const current = client.current;
    client.current = null;
    current?.socket.disconnect();
    setState("closed");
    push({ info: "Déconnecté." });
  };
  const send = async (text) => {
    const message = text.trim();
    if (!message || state !== "connected") return;
    setInput("");
    try { await client.current.messages.say(message); } catch (e) { setError(e?.message || String(e)); }
  };

  const connected = state === "connected";
  return html`<div class="stack full text-client">
    <p class="hint">Chat et commandes de la partie (<code>!hint</code>, <code>!remaining</code>…), sans lancer Archipelago.
      Vous apparaissez dans la partie comme un client texte de ce joueur : les autres voient « a rejoint » et « est parti ».</p>
    ${!connected && html`<div class="row full">
      <select class="grow" value=${slot} disabled=${state === "connecting"} onChange=${(e) => setSlot(e.target.value)}>
        ${own.length > 0 && html`<optgroup label="Vos joueurs">${own.map((s) => html`<option value=${s.name}>${s.name} (${s.game})</option>`)}</optgroup>`}
        <optgroup label=${own.length ? "Autres joueurs" : "Joueurs"}>${status.slots.filter((s) => !own.includes(s))
          .map((s) => html`<option value=${s.name}>${s.name} (${s.game})</option>`)}</optgroup>
      </select>
      <input type="text" class="grow" placeholder="Mot de passe (si la partie en a un)" value=${password}
        onInput=${(e) => setPassword(e.target.value)} autocomplete="off" />
      <button type="button" disabled=${state === "connecting" || !slot} onClick=${connect}>
        ${state === "connecting" ? "Connexion…" : state === "closed" ? "Se reconnecter" : "Se connecter"}</button>
    </div>`}
    ${error && html`<div class="notice error full">${error}</div>`}
    ${lines.length > 0 && html`<div class="client-log full" ref=${log} role="log" aria-live="polite">
      ${lines.map((line) => {
        const hit = !line.info && wishHit(wishes, line.nodes);
        return html`<div key=${line.id} class=${line.info ? "hint" : hit ? "wish-hit" : ""}>
          ${hit && html`<span class="wish-label">♥ Wishlist</span>`}
          ${line.info || line.nodes.map((node) => html`<${MessagePart} node=${node} self=${slot} wishes=${wishes} />`)}</div>`;
      })}
    </div>`}
    ${connected && html`<form class="row full" onSubmit=${(e) => { e.preventDefault(); send(input); }}>
      <input type="text" class="grow" placeholder="Message ou commande (!hint objet…)" value=${input}
        onInput=${(e) => setInput(e.target.value)} />
      <button type="submit" disabled=${!input.trim()}>Envoyer</button>
      <button type="button" class="ghost" onClick=${disconnect}>Se déconnecter</button>
    </form>
    <div class="chips-row">${QUICK.map((q) => html`<button type="button" class="chip-btn" title=${q.title}
      onClick=${() => (q.fill ? setInput(q.text) : (!q.confirm || confirm(q.confirm)) && send(q.text))}>${q.label}</button>`)}</div>`}
  </div>`;
}
