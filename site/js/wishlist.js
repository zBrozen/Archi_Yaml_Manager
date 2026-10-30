// Wishlists des joueurs : objets qu'ils attendent dans la partie hébergée. Chacun remplit la sienne (onglet
// « Wishlist ») parmi les objets de son jeu pas encore reçus ; un objet attendu est en rouge, puis passe au vert
// quand il arrive (d'après le tracker d'archipelago.gg), et la room prévient le joueur par un bandeau.
// Le client texte et l'overlay mettent aussi en avant ces objets quand ils sont envoyés (voir wishHit).
import { html, useState, useEffect } from "../vendor/preact-htm.js";
import { api } from "./rooms-api.js";
import { receivedItems, usePackages } from "./room-live.js";
import { plural, useAction } from "./ui.js";

const RESULTS = 40; // objets proposés à la fois dans la recherche
const MAX_ITEMS = 100; // comme le service
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
export const wishesOf = (wishlists, name) => Object.entries(wishlists || {}).find(([slot]) => same(slot, name))?.[1] || [];

// Noms des objets reçus par un joueur de la partie (null tant que le tracker ou les noms ne sont pas chargés).
function receivedNames(live, slot, pkg) {
  if (!live || !pkg) return null;
  return new Set(receivedItems(live, slot.slot).map((i) => pkg.items.get(i.item)).filter(Boolean));
}

// Wishlists de la partie : pour chaque joueur qui en a une, ses objets, reçus ou non.
export function useWishState(status, tracker, wishlists) {
  const slots = status ? status.slots.filter((s) => wishesOf(wishlists, s.name).length) : [];
  const { loaded } = usePackages(status?.origin, tracker.data?.fixed, [...new Set(slots.map((s) => s.game))].sort());
  return slots.map((s) => {
    const got = receivedNames(tracker.data?.live, s, loaded[s.game]);
    return { ...s, known: !!got, items: wishesOf(wishlists, s.name).map((name) => ({ name, received: !!got?.has(name) })) };
  });
}

// Objets de vos wishlists reçus depuis votre dernière visite (mémorisés dans ce navigateur).
export function useWishNotices(code, lists, mine) {
  const key = `wishSeen:${code}`;
  const read = () => { try { return new Set(JSON.parse(localStorage.getItem(key)) || []); } catch { return new Set(); } };
  const [seen, setSeen] = useState(read);
  useEffect(() => setSeen(read()), [code]);
  const id = (slot, item) => `${slot.toLowerCase()}\n${item}`;
  const own = lists.filter((l) => l.known && mine.some((m) => same(m.name, l.name)));
  const fresh = own.flatMap((l) => l.items.filter((i) => i.received && !seen.has(id(l.name, i.name))).map((i) => ({ slot: l.name, item: i.name })));
  const dismiss = () => {
    // Seuls les objets encore dans une wishlist sont gardés : la liste ne grossit pas indéfiniment.
    const next = new Set(own.flatMap((l) => l.items.filter((i) => i.received).map((i) => id(l.name, i.name))));
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
  return html`<li class=${`wish ${state}`}>
    <span class="wish-state">${state === "got" ? "✓ Reçu" : state === "missing" ? "✗ Pas encore reçu" : "…"}</span>
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
  const save = useAction();
  const current = choices.find((s) => s.name === selected) || choices[0];
  const { loaded, error } = usePackages(status.origin, tracker.data?.fixed, current ? [current.game] : []);
  const pkg = current && loaded[current.game];
  const got = current && receivedNames(tracker.data?.live, current, pkg);

  // Ouvrir la wishlist vaut lecture des nouveaux objets reçus.
  useEffect(() => { if (notices.fresh.length) notices.dismiss(); }, [notices.fresh.length]);

  const names = current ? wishesOf(wishlists, current.name) : [];
  const items = names.map((name) => ({ name, received: !!got?.has(name) }));
  const done = items.filter((i) => i.received);
  const update = (next) => save.run(async () => {
    const result = await api.saveWishlist(room.code, current.name, next);
    onSaved(current.name, result.items);
  });

  const needle = search.trim().toLowerCase();
  const wanted = new Set(names);
  const matches = pkg ? [...new Set(pkg.items.values())]
    .filter((n) => !wanted.has(n) && !got?.has(n) && (!needle || n.toLowerCase().includes(needle)))
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
              onClick=${() => update(names.filter((n) => !got.has(n)))}>Retirer les objets reçus (${done.length})</button>`}
          </div>
          ${items.length
            ? html`<ul class="wish-list full">${ordered(items).map((item) => html`<${WishItem} key=${item.name} item=${item} known=${!!got}
                busy=${save.busy} onRemove=${(name) => update(names.filter((n) => n !== name))} />`)}</ul>`
            : html`<p class="hint">Votre wishlist est vide : ajoutez-y les objets que vous attendez.</p>`}
        </div>
        <div class="stack full">
          <h3>Ajouter un objet</h3>
          ${!pkg ? html`<p class="hint">Chargement des objets du jeu…</p>`
            : names.length >= MAX_ITEMS ? html`<p class="hint">${MAX_ITEMS} objets au plus : retirez-en avant d'en ajouter.</p>`
            : html`
              <input type="search" class="full" placeholder=${`Rechercher parmi les objets de ${current.game}…`} value=${search}
                onInput=${(e) => setSearch(e.target.value)} />
              <p class="hint">${browse ? `${plural(matches.length, "objet")} pas encore reçus : tapez une partie du nom pour les trouver.`
                : matches.length
                  ? `${plural(matches.length, "objet")}${matches.length > RESULTS ? ` : les ${RESULTS} premiers, précisez la recherche pour les autres` : ""}.`
                  : "Aucun objet ne correspond (les objets déjà reçus ne sont pas proposés)."}</p>
              <ul class="wish-choices full">${(browse ? [] : matches.slice(0, RESULTS)).map((name) => html`<li>
                <button type="button" class="ghost" disabled=${save.busy} onClick=${() => update([...names, name])}>+ ${name}</button>
              </li>`)}</ul>`}
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
