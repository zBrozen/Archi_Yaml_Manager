// Éditeur des dispositions d'un espace de partage (onglet « Écrans », vue « Overlay ») : son créateur ou l'hôte
// place librement des écrans de joueurs, l'écran en vedette, les messages de la partie, la progression et des
// textes sur une page 16/9, à la souris ou au clavier, avec une disposition par nombre d'écrans affichés.
import { html, useState, useRef } from "../vendor/preact-htm.js";
import {
  ALIGNS, ITEM_FILTERS, ITEM_TYPES, LAYOUT_LIMITS, PRESETS, SCREEN_TYPES, TEXT_SIZES, coversScreen, newId, newItem, nextSlot,
  presetItems, variantFor,
} from "./overlay-layout.js";

const STEP = 0.5; // pas de déplacement et d'aimantation, en % de la page
const MIN_SIZE = 2;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const snap = (v) => Math.round(v / STEP) * STEP;
const round = (v) => Math.round(v * 100) / 100;

function describe(item, players) {
  if (item.type === "screens") {
    const names = item.players.map((id) => players.find((p) => p.id === id)?.pseudo || "joueur retiré");
    return names.length ? `Zone d'écrans : ${names.join(", ")}` : `Zone d'écrans (jusqu'à ${item.max})`;
  }
  if (item.type === "screen") {
    if (item.source === "vedette") return "Écran en vedette";
    return item.source === "auto"
      ? `Écran auto ${item.slot}`
      : `Écran : ${players.find((p) => p.id === item.source)?.pseudo || "joueur retiré"}`;
  }
  if (item.type === "feed") return item.objets === "importants" ? "Messages (objets importants)" : "Messages de la partie";
  if (item.type === "progress") return item.goal ? "Progression (avec les goals)" : "Progression";
  return `Texte : « ${item.text || "…"} »`;
}

// --- Page 16/9 : déplacer et redimensionner -----------------------------------------------

function Canvas({ layout, players, selected, onSelect, onChange, onRemove }) {
  const ref = useRef(null);
  const drag = useRef(null);

  const start = (event, item, mode) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(item.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: item.id, mode, x: event.clientX, y: event.clientY, item: { ...item }, rect: ref.current.getBoundingClientRect() };
  };
  const move = (event) => {
    const d = drag.current;
    if (!d) return;
    const dx = ((event.clientX - d.x) / d.rect.width) * 100;
    const dy = ((event.clientY - d.y) / d.rect.height) * 100;
    if (d.mode === "move") {
      onChange(d.id, { x: clamp(snap(d.item.x + dx), 0, 100 - d.item.w), y: clamp(snap(d.item.y + dy), 0, 100 - d.item.h) });
      return;
    }
    let w = clamp(snap(d.item.w + dx), MIN_SIZE, 100 - d.item.x);
    let h = clamp(snap(d.item.h + dy), MIN_SIZE, 100 - d.item.y);
    // Maj : mêmes w et h, soit du 16/9 sur une page 16/9 (la forme d'un écran de jeu).
    if (event.shiftKey) w = h = Math.min(Math.max(w, h), 100 - d.item.x, 100 - d.item.y);
    onChange(d.id, { w, h });
  };
  const end = () => { drag.current = null; };

  // Flèches : déplacer (Maj : plus vite) ; Alt + flèches : redimensionner ; Suppr : retirer.
  const key = (event, item) => {
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onRemove(item.id); return; }
    const arrow = arrows[event.key];
    if (!arrow) return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : STEP;
    const [dx, dy] = arrow.map((v) => v * step);
    if (event.altKey) onChange(item.id, { w: clamp(item.w + dx, MIN_SIZE, 100 - item.x), h: clamp(item.h + dy, MIN_SIZE, 100 - item.y) });
    else onChange(item.id, { x: clamp(item.x + dx, 0, 100 - item.w), y: clamp(item.y + dy, 0, 100 - item.h) });
  };

  return html`<div class="layout-canvas full" ref=${ref} onPointerDown=${() => onSelect(null)}>
    ${layout.items.map((item) => {
      const label = describe(item, players);
      return html`<div key=${item.id} tabIndex="0" role="button" aria-pressed=${selected === item.id}
        aria-label=${`${label} : ${round(item.x)} %, ${round(item.y)} %, ${round(item.w)} × ${round(item.h)} %`}
        class=${`layout-item type-${item.type} ${selected === item.id ? "selected" : ""}`}
        style=${{ left: `${item.x}%`, top: `${item.y}%`, width: `${item.w}%`, height: `${item.h}%` }}
        onPointerDown=${(e) => start(e, item, "move")} onPointerMove=${move} onPointerUp=${end} onPointerCancel=${end}
        onFocus=${() => onSelect(item.id)} onKeyDown=${(e) => key(e, item)}>
        <span class="layout-item-label">${label}</span>
        <span class="layout-resize" title="Redimensionner (Maj : proportions d'un écran)"
          onPointerDown=${(e) => start(e, item, "resize")} onPointerMove=${move} onPointerUp=${end} onPointerCancel=${end}></span>
      </div>`;
    })}
  </div>`;
}

// --- Réglages de l'élément choisi -------------------------------------------------------------

function Field({ label, children, wide = false }) {
  return html`<label class=${wide ? "span-all" : ""}><span>${label}</span>${children}</label>`;
}

function Choice({ value, choices, onChange }) {
  return html`<select value=${value} onChange=${(e) => onChange(e.target.value)}>
    ${Object.entries(choices).map(([k, v]) => html`<option value=${k}>${typeof v === "string" ? v : v.label}</option>`)}
  </select>`;
}

function ItemSettings({ item, layout, players, onChange, onRemove, onDuplicate, onOrder, full }) {
  const set = (key) => (value) => onChange(item.id, { [key]: value });
  const isScreen = item.type === "screen" || item.type === "screens";
  const position = (key, max) => html`<input type="number" step=${STEP} min="0" max=${max} value=${round(item[key])}
    onChange=${(e) => {
      const n = Number(e.target.value);
      if (!Number.isFinite(n)) return;
      const limit = key === "x" ? 100 - item.w : key === "y" ? 100 - item.h : key === "w" ? 100 - item.x : 100 - item.y;
      onChange(item.id, { [key]: clamp(n, key === "w" || key === "h" ? MIN_SIZE : 0, limit) });
    }} />`;

  return html`<div class="stack full layout-settings">
    <h4>${ITEM_TYPES[item.type].label}</h4>
    <div class="fields full">
      ${item.type === "screen" && html`
        <${Field} label="Joueur montré">
          <select value=${item.source} onChange=${(e) => onChange(item.id, e.target.value === "auto"
            ? { source: "auto", slot: nextSlot(layout.items.filter((i) => i.id !== item.id)) } : { source: e.target.value })}>
            <option value="vedette">En vedette (choisi en direct, ou en roulement)</option>
            <option value="auto">Automatique (dans l'ordre des partages)</option>
            ${players.map((p) => html`<option value=${p.id}>${p.pseudo}</option>`)}
            ${!["auto", "vedette"].includes(item.source) && !players.some((p) => p.id === item.source) && html`<option value=${item.source}>Joueur retiré de la room</option>`}
          </select></${Field}>
        ${item.source === "auto" && html`<${Field} label="Numéro (ordre de remplissage)">
          <input type="number" min="1" max="50" value=${item.slot} onChange=${(e) => set("slot")(clamp(Math.round(Number(e.target.value)) || 1, 1, 50))} /></${Field}>`}
        <label class="check span-all"><input type="checkbox" checked=${item.label} onChange=${(e) => set("label")(e.target.checked)} />
          Afficher le nom du joueur et son jeu</label>`}
      ${item.type === "screens" && html`
        <div class="span-all stack">
          <p class="hint">La zone place en grille les joueurs qui partagent leur écran, aussi grands que possible : un seul
            prend toute la zone, plusieurs se la partagent.</p>
          <label class="check"><input type="radio" name=${`zone-${item.id}`} checked=${!item.players.length}
            onChange=${() => set("players")([])} /> Tous les joueurs qui partagent (sauf ceux montrés ailleurs)</label>
          <label class="check"><input type="radio" name=${`zone-${item.id}`} checked=${item.players.length > 0}
            disabled=${!players.length} onChange=${() => set("players")(players.slice(0, 1).map((p) => p.id))} /> Seulement certains joueurs</label>
          ${item.players.length > 0 && html`<div class="checks">${players.map((p) => html`<label>
            <input type="checkbox" checked=${item.players.includes(p.id)} onChange=${(e) => set("players")(e.target.checked
              ? [...item.players, p.id] : item.players.filter((id) => id !== p.id))} /> ${p.pseudo}</label>`)}</div>`}
        </div>
        <${Field} label="Écrans au plus">
          <select value=${item.max} onChange=${(e) => set("max")(Number(e.target.value))}>
            ${[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => html`<option value=${n}>${n}</option>`)}
          </select></${Field}>
        <label class="check span-all"><input type="checkbox" checked=${item.label} onChange=${(e) => set("label")(e.target.checked)} />
          Afficher le nom des joueurs et leur jeu</label>`}
      ${item.type === "progress" && html`<label class="check span-all"><input type="checkbox" checked=${!!item.goal}
        onChange=${(e) => set("goal")(e.target.checked)} /> Afficher le goal de chaque joueur en petit (lu dans son YAML)</label>`}
      ${item.type === "feed" && html`<${Field} label="Objets montrés"><${Choice} value=${item.objets} choices=${ITEM_FILTERS} onChange=${set("objets")} /></${Field}>`}
      ${item.type === "text" && html`
        <${Field} label="Texte" wide>
          <textarea rows="2" maxLength=${LAYOUT_LIMITS.text} value=${item.text} onInput=${(e) => set("text")(e.target.value)}></textarea></${Field}>
        <${Field} label="Alignement"><${Choice} value=${item.align} choices=${ALIGNS} onChange=${set("align")} /></${Field}>`}
      ${(!isScreen || item.label) && html`<${Field} label=${isScreen ? "Taille des noms" : "Taille du texte"}>
        <${Choice} value=${item.size} choices=${TEXT_SIZES} onChange=${set("size")} /></${Field}>`}
      ${!isScreen && html`<label class="check span-all"><input type="checkbox" checked=${item.background}
        onChange=${(e) => set("background")(e.target.checked)} /> Fond sombre (sinon texte ombré sur la scène)</label>`}
    </div>
    <div class="fields full position-fields">
      <${Field} label="Gauche (%)">${position("x", 100)}</${Field}>
      <${Field} label="Haut (%)">${position("y", 100)}</${Field}>
      <${Field} label="Largeur (%)">${position("w", 100)}</${Field}>
      <${Field} label="Hauteur (%)">${position("h", 100)}</${Field}>
    </div>
    <div class="row">
      ${item.type === "screen" && html`<button type="button" class="ghost small" title="Même largeur et hauteur en % : la forme d'un écran de jeu"
        onClick=${() => { const s = Math.min(item.w, 100 - item.y, 100 - item.x); onChange(item.id, { w: s, h: s }); }}>Format 16/9</button>`}
      <button type="button" class="ghost small" disabled=${full} onClick=${() => onDuplicate(item.id)}>Dupliquer</button>
      <button type="button" class="ghost small" onClick=${() => onOrder(item.id, 1)}>Mettre devant</button>
      <button type="button" class="ghost small" onClick=${() => onOrder(item.id, -1)}>Mettre derrière</button>
      <button type="button" class="ghost small" onClick=${() => onRemove(item.id)}>Retirer</button>
    </div>
  </div>`;
}

// --- Éditeur des dispositions d'un espace ----------------------------------------------------------

const SPACE_COUNTS = [0, 1, 2, 3, 4, 5, 6];
export const countLabel = (n) => (n === 0 ? "Aucun écran" : n === 1 ? "1 écran" : `${n} écrans`);
const withNewIds = (items) => items.map((i) => ({ ...structuredClone(i), id: newId() }));

// Une disposition par nombre d'écrans affichés (`variants` : [{ count, items }], contrôlé par `onChange`) : l'overlay
// change tout seul quand un joueur commence ou arrête de partager. Deux écrans ne se recouvrent jamais : un
// déplacement qui en ferait chevaucher deux est refusé.
export function SpaceLayouts({ variants, players, onChange }) {
  const missing = SPACE_COUNTS.filter((n) => !variants.some((v) => v.count === n));
  const [current, setCurrent] = useState(variants[0]?.count ?? null);
  const [selected, setSelected] = useState(null);
  const [addCount, setAddCount] = useState(missing.includes(1) ? 1 : missing[0]);
  const [preset, setPreset] = useState(variants.length ? "copie" : "complet");
  const [warning, setWarning] = useState(null);
  const variant = variants.find((v) => v.count === current) || variants[0] || null;
  const item = variant?.items.find((i) => i.id === selected) || null;
  const full = !!variant && variant.items.length >= LAYOUT_LIMITS.items;
  const count = missing.includes(addCount) ? addCount : missing[0];

  const setItems = (items) => onChange(variants.map((v) => (v.count === variant.count ? { ...v, items } : v)));
  const change = (id, patch) => {
    const items = variant.items.map((i) => (i.id === id ? { ...i, ...patch } : i));
    if (coversScreen(items.find((i) => i.id === id), items)) { setWarning("Deux écrans ne peuvent pas se recouvrir."); return; }
    setWarning(null);
    setItems(items);
  };
  const remove = (id) => { setItems(variant.items.filter((i) => i.id !== id)); setSelected(null); };
  const add = (type, extra = {}) => {
    const next = newItem(type, variant.items, extra);
    if (!next) { setWarning("Plus de place libre pour un écran : réduisez-en un d'abord."); return; }
    setWarning(null);
    setItems([...variant.items, next]);
    setSelected(next.id);
  };
  const duplicate = (id) => {
    const source = variant.items.find((i) => i.id === id);
    const { id: _, x, y, ...rest } = source;
    if (SCREEN_TYPES.includes(source.type)) return add(source.type, rest);
    const copy = { ...structuredClone(source), id: newId(), x: clamp(x + 2, 0, 100 - source.w), y: clamp(y + 2, 0, 100 - source.h) };
    setItems([...variant.items, copy]);
    setSelected(copy.id);
  };
  // Les éléments sont dessinés dans l'ordre de la liste : le dernier est devant.
  const order = (id, direction) => {
    const moved = variant.items.find((i) => i.id === id);
    const rest = variant.items.filter((i) => i.id !== id);
    setItems(direction > 0 ? [...rest, moved] : [moved, ...rest]);
  };
  const addVariant = () => {
    const nearest = variantFor({ variants }, count);
    const items = preset === "copie" && nearest ? withNewIds(nearest.items) : presetItems(preset === "copie" ? "complet" : preset);
    onChange([...variants, { count, items }].sort((a, b) => a.count - b.count));
    setCurrent(count);
    setSelected(null);
  };
  const removeVariant = () => {
    if (!confirm(`Supprimer la disposition pour ${countLabel(variant.count).toLowerCase()} ?`)) return;
    onChange(variants.filter((v) => v.count !== variant.count));
    setCurrent(null);
    setSelected(null);
  };

  return html`<div class="stack full space-layouts">
    <p class="hint">Une disposition par nombre d'écrans affichés : l'overlay change tout seul quand un joueur commence ou arrête
      de partager. Sans disposition pour ce nombre, il prend celle du nombre inférieur le plus proche.</p>
    ${variants.length > 0 && html`<div class="segmented" role="tablist" aria-label="Disposition pour">${variants.map((v) => html`<button
      type="button" role="tab" aria-selected=${v.count === variant.count} class=${v.count === variant.count ? "active" : ""}
      onClick=${() => { setCurrent(v.count); setSelected(null); setWarning(null); }}>${countLabel(v.count)}</button>`)}</div>`}
    ${missing.length > 0 && html`<div class="row">
      <label class="inline-field"><span>Disposition pour</span>
        <select value=${count} onChange=${(e) => setAddCount(Number(e.target.value))}>
          ${missing.map((n) => html`<option value=${n}>${countLabel(n).toLowerCase()}</option>`)}
        </select></label>
      <label class="inline-field"><span>à partir de</span>
        <select value=${preset} onChange=${(e) => setPreset(e.target.value)}>
          ${variants.length > 0 && html`<option value="copie">la disposition la plus proche</option>`}
          ${Object.entries(PRESETS).map(([k, p]) => html`<option value=${k}>${p.label}</option>`)}
        </select></label>
      <button type="button" class=${variants.length ? "ghost small" : "small"} onClick=${addVariant}>Ajouter</button>
    </div>`}

    ${variant && html`
      <div class="row">
        <span class="hint">Ajouter :</span>
        <button type="button" class="ghost small" disabled=${full} onClick=${() => add("screens")}>+ Zone d'écrans</button>
        <button type="button" class="ghost small" disabled=${full} onClick=${() => add("screen", { source: "vedette" })}>+ Écran en vedette</button>
        <button type="button" class="ghost small" disabled=${full} onClick=${() => add("screen")}>+ Écran</button>
        <button type="button" class="ghost small" disabled=${full} onClick=${() => add("feed")}>+ Messages</button>
        <button type="button" class="ghost small" disabled=${full} onClick=${() => add("progress")}>+ Progression</button>
        <button type="button" class="ghost small" disabled=${full} onClick=${() => add("text")}>+ Texte</button>
      </div>
      <${Canvas} layout=${variant} players=${players} selected=${selected} onSelect=${setSelected} onChange=${change} onRemove=${remove} />
      ${warning && html`<div class="notice warn full" role="status">${warning}</div>`}
      <p class="hint">Glissez un élément pour le déplacer, son coin bas droit pour le redimensionner.</p>
      <details class="more">
        <summary>Raccourcis</summary>
        <p class="hint">Maj en redimensionnant : format d'un écran. Au clavier : Tab pour choisir, flèches pour déplacer
          (Maj : plus vite), Alt + flèches pour redimensionner, Suppr pour retirer. Un écran sans joueur qui partage reste
          transparent dans l'overlay.</p>
      </details>
      ${item
        ? html`<${ItemSettings} item=${item} layout=${variant} players=${players} onChange=${change} onRemove=${remove}
            onDuplicate=${duplicate} onOrder=${order} full=${full} />`
        : html`<p class="hint">Choisissez un élément pour le régler.</p>`}
      <button type="button" class="link danger-link" onClick=${removeVariant}>Supprimer la disposition pour ${countLabel(variant.count).toLowerCase()}</button>`}
  </div>`;
}
