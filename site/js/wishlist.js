// Wishlists des joueurs : objets qu'ils attendent dans la partie hébergée. Chacun remplit la sienne (onglet
// « Wishlist ») parmi les objets de son jeu ; un objet attendu est en rouge, puis passe au vert quand il arrive
// (d'après le tracker d'archipelago.gg), et la room prévient le joueur par un bandeau. Un objet déjà reçu
// (progressif, cumulable…) peut être attendu une fois de plus : il passe au vert quand son nombre augmente.
// Le client texte et l'overlay mettent aussi en avant ces objets quand ils sont envoyés (voir wishHit).
import { html, useState, useEffect } from "../vendor/preact-htm.js";
import { api } from "./rooms-api.js";
import { receivedItems, usePackages, wishEntry } from "./room-live.js";
import { plural, useAction, useSetting } from "./ui.js";

const RESULTS = 40; // objets proposés à la fois dans la recherche
const MAX_ITEMS = 100; // comme le service
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
export const wishesOf = (wishlists, name) => (Object.entries(wishlists || {}).find(([slot]) => same(slot, name))?.[1] || []).map(wishEntry);
const saved = (w) => (w.after ? { name: w.name, after: w.after } : w.name);

// Nombre d'exemplaires reçus de chaque objet par un joueur (null tant que le tracker ou les noms ne sont pas chargés).
function receivedCounts(live, slot, pkg) {
  if (!live || !pkg) return null;
  const counts = new Map();
  for (const i of receivedItems(live, slot.slot)) {
    const name = pkg.items.get(i.item);
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

// Objets d'une wishlist avec leur état : reçu dès que le nombre d'exemplaires dépasse celui de l'ajout.
const withState = (entries, counts) => entries.map((w) => {
  const count = counts?.get(w.name) || 0;
  return { ...w, count, received: count > w.after };
});

// Wishlists de la partie : pour chaque joueur qui en a une, ses objets, reçus ou non.
export function useWishState(status, tracker, wishlists) {
  const slots = status ? status.slots.filter((s) => wishesOf(wishlists, s.name).length) : [];
  const { loaded } = usePackages(status?.origin, tracker.data?.fixed, [...new Set(slots.map((s) => s.game))].sort());
  return slots.map((s) => {
    const counts = receivedCounts(tracker.data?.live, s, loaded[s.game]);
    return { ...s, known: !!counts, items: withState(wishesOf(wishlists, s.name), counts) };
  });
}

// Objets de vos wishlists reçus depuis votre dernière visite (mémorisés dans ce navigateur).
export function useWishNotices(code, lists, mine) {
  const key = `wishSeen:${code}`;
  const read = () => { try { return new Set(JSON.parse(localStorage.getItem(key)) || []); } catch { return new Set(); } };
  const [seen, setSeen] = useState(read);
  useEffect(() => setSeen(read()), [code]);
  // `after` compte : un objet attendu à nouveau (un exemplaire de plus) est signalé une nouvelle fois.
  const id = (slot, item) => `${slot.toLowerCase()}\n${item.name}\n${item.after}`;
  const own = lists.filter((l) => l.known && mine.some((m) => same(m.name, l.name)));
  const fresh = own.flatMap((l) => l.items.filter((i) => i.received && !seen.has(id(l.name, i))).map((i) => ({ slot: l.name, item: i.name })));
  const dismiss = () => {
    // Seuls les objets encore dans une wishlist sont gardés : la liste ne grossit pas indéfiniment.
    const next = new Set(own.flatMap((l) => l.items.filter((i) => i.received).map((i) => id(l.name, i))));
    setSeen(next);
    try { localStorage.setItem(key, JSON.stringify([...next])); } catch { /* stockage indisponible */ }
  };
  return { fresh, dismiss };
}

export function WishNotice({ notices, onShow }) {
  const { fresh } = notices;
  if (!fresh.length) return null;
  const slots = [...new Set(fresh.map((f) => f.slot))];
  return html`<div class="notice ok wish-notice" role="status">
    <p><strong>♥ Wishlist mise à jour :</strong> ${fresh.slice(0, 3).map((f, i) => html`${i ? ", " : ""}<strong>${f.item}</strong>`)}${
      fresh.length > 3 ? ` et ${plural(fresh.length - 3, "autre")}` : ""} ${fresh.length > 1 ? "reçus" : "reçu"}${slots.length > 1 ? "" : ` par ${slots[0]}`}.</p>
    <div class="row">
      <button type="button" class="small" onClick=${() => { notices.dismiss(); onShow(); }}>Voir la wishlist</button>
      <button type="button" class="ghost small" onClick=${notices.dismiss}>OK</button>
    </div>
  </div>`;
}

function WishItem({ item, known, onRemove, busy }) {
  const state = !known ? "unknown" : item.received ? "got" : "missing";
  const text = state === "unknown" ? "…"
    : !item.after ? (state === "got" ? `✓ Reçu${item.count > 1 ? ` (×${item.count})` : ""}` : "✗ Pas encore reçu")
    : state === "got" ? `✓ Un de plus reçu (×${item.count})` : `✗ Un de plus attendu (déjà ×${item.after})`;
  return html`<li class=${`wish ${state}`}>
    <span class="wish-state">${text}</span>
    <strong class="wish-name">${item.name}</strong>
    ${onRemove && html`<button type="button" class="ghost small" disabled=${busy} onClick=${() => onRemove(item.name)}
      aria-label=${`Retirer ${item.name} de la wishlist`}>Retirer</button>`}
  </li>`;
}

// Missing first, then received; order of addition otherwise.
const ordered = (items) => [...items.filter((i) => !i.received), ...items.filter((i) => i.received)];

export function WishlistView({ room, status, tracker, lists, mine, admin, wishlists, onSaved, notices }) {
  const editable = status.slots.filter((s) => admin || mine.some((m) => same(m.name, s.name)));
  const own = editable.filter((s) => mine.some((m) => same(m.name, s.name)));
  const choices = [...own, ...editable.filter((s) => !own.includes(s))];
  const [selected, setSelected] = useState(null);
  const [search, setSearch] = useState("");
  const [showReceived, setShowReceived] = useSetting("wishShowReceived", false);
  const save = useAction();
  const current = choices.find((s) => s.name === selected) || choices[0];
  const { loaded, error } = usePackages(status.origin, tracker.data?.fixed, current ? [current.game] : []);
  const pkg = current && loaded[current.game];
  const counts = current && receivedCounts(tracker.data?.live, current, pkg);

  // Ouvrir la wishlist vaut lecture des nouveaux objets reçus.
  useEffect(() => { if (notices.fresh.length) notices.dismiss(); }, [notices.fresh.length]);

  const entries = current ? wishesOf(wishlists, current.name) : [];
  const items = withState(entries, counts);
  const done = items.filter((i) => i.received);
  const update = (next) => save.run(async () => {
    const result = await api.saveWishlist(room.code, current.name, next.map(saved));
    onSaved(current.name, result.items);
  });
  // Un objet déjà reçu est attendu « une fois de plus » : on retient combien il y en avait à l'ajout.
  const add = (name) => update([...entries, { name, after: counts?.get(name) || 0 }]);

  const needle = search.trim().toLowerCase();
  const wanted = new Set(entries.map((w) => w.name));
  const matches = pkg ? [...new Set(pkg.items.values())]
    .filter((n) => !wanted.has(n) && (showReceived || !counts?.get(n)) && (!needle || n.toLowerCase().includes(needle)))
    .sort((a, b) => a.localeCompare(b)) : [];
  // Beaucoup d'objets (certains jeux en ont des milliers) : la liste attend une recherche.
  const browse = !needle && matches.length > RESULTS;
  const others = lists.filter((l) => !current || !same(l.name, current.name));

  return html`<section class="card stack">
    <div class="row full">
      <h2 class="grow">Wishlist</h2>
      ${choices.length > 1 && html`<label class="items-player">Joueur
        <select value=${current.name} onChange=${(e) => { setSelected(e.target.value); setSearch(""); }}>
          ${choices.map((s) => html`<option value=${s.name}>${s.name} (${s.game})</option>`)}
        </select></label>`}
    </div>
    <p class="hint">Les objets que vous attendez : en rouge tant qu'ils ne sont pas arrivés, en vert une fois reçus.
      Le client texte et l'overlay les mettent en avant (♥) quand ils sont envoyés, et la room vous prévient.</p>
    ${!current
      ? html`<p>${room.direct
        ? "Rejoignez la room avec votre nom dans la partie pour remplir votre wishlist."
        : "Seuls les joueurs de la partie remplissent une wishlist : rejoignez la room et déposez votre YAML."}</p>`
      : html`
        ${save.error && html`<div class="notice error full">${save.error}</div>`}
        ${error && html`<div class="notice warn full">${error}</div>`}
        <div class="stack full">
          <div class="row full">
            <h3 class="grow">${current.name} <span class="hint">${current.game}</span></h3>
            ${items.length > 0 && html`<span class="hint">${done.length} / ${items.length} reçu${done.length > 1 ? "s" : ""}</span>`}
            ${done.length > 0 && html`<button type="button" class="ghost small" disabled=${save.busy}
              onClick=${() => update(items.filter((i) => !i.received))}>Retirer les objets reçus (${done.length})</button>`}
          </div>
          ${items.length
            ? html`<ul class="wish-list full">${ordered(items).map((item) => html`<${WishItem} key=${item.name} item=${item} known=${!!counts}
                busy=${save.busy} onRemove=${(name) => update(entries.filter((w) => w.name !== name))} />`)}</ul>`
            : html`<p class="hint">Votre wishlist est vide : ajoutez-y les objets que vous attendez.</p>`}
        </div>
        <div class="stack full">
          <h3>Ajouter un objet</h3>
          ${!pkg ? html`<p class="hint">Chargement des objets du jeu…</p>`
            : entries.length >= MAX_ITEMS ? html`<p class="hint">${MAX_ITEMS} objets au plus : retirez-en avant d'en ajouter.</p>`
            : html`
              <input type="search" class="full" placeholder=${`Rechercher parmi les objets de ${current.game}…`} value=${search}
                onInput=${(e) => setSearch(e.target.value)} />
              <label class="wish-show full"><input type="checkbox" checked=${showReceived} onChange=${(e) => setShowReceived(e.target.checked)} />
                Afficher aussi les objets déjà reçus (progressifs, cumulables…) : vous attendrez alors un exemplaire de plus.</label>
              <p class="hint">${browse ? `${plural(matches.length, "objet")}${showReceived ? "" : " pas encore reçus"} : tapez une partie du nom pour les trouver.`
                : matches.length
                  ? `${plural(matches.length, "objet")}${matches.length > RESULTS ? ` : les ${RESULTS} premiers, précisez la recherche pour les autres` : ""}.`
                  : `Aucun objet ne correspond${showReceived ? "" : " (les objets déjà reçus sont masqués)"}.`}</p>
              <ul class="wish-choices full">${(browse ? [] : matches.slice(0, RESULTS)).map((name) => {
                const had = counts?.get(name) || 0;
                return html`<li>
                  <button type="button" class="ghost" disabled=${save.busy} onClick=${() => add(name)}
                    title=${had ? `Déjà reçu ${had} fois : vous attendrez un exemplaire de plus` : ""}>
                    + ${name}${had > 0 && html` <span class="hint wish-had">déjà ×${had}</span>`}</button>
                </li>`;
              })}</ul>`}
        </div>`}
  </section>
  ${others.length > 0 && html`<section class="card stack">
    <h2>Wishlists des autres joueurs</h2>
    <p class="hint">Pour savoir quels objets envoyer en priorité.</p>
    ${others.map((l) => {
      const n = l.items.filter((i) => i.received).length;
      return html`<div class="stack full">
        <div class="row full"><h3 class="grow">${l.name} <span class="hint">${l.game}</span></h3>
          <span class="hint">${n} / ${l.items.length} reçu${n > 1 ? "s" : ""}</span></div>
        <ul class="wish-list compact full">${ordered(l.items).map((item) => html`<${WishItem} key=${item.name} item=${item} known=${l.known} />`)}</ul>
      </div>`;
    })}
  </section>`}`;
}
