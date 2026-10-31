// Éditeur des dispositions de l'overlay OBS (onglet « Écrans », espace de l'hôte) : l'hôte place librement
// des écrans de joueurs, les messages de la partie, la progression et des textes sur une page 16/9, à la souris
// ou au clavier. Chaque disposition a son propre lien ; l'enregistrer met à jour les overlays déjà ouverts.
import { html, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { CopyButton, useAction } from "./ui.js";
import { api, overlayLink } from "./rooms-api.js";
import {
  ALIGNS, ITEM_FILTERS, ITEM_TYPES, LAYOUT_LIMITS, PRESETS, TEXT_SIZES, newId, newItem, nextSlot, presetItems,
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
    return item.source === "auto"
      ? `Écran auto ${item.slot}`
      : `Écran : ${players.find((p) => p.id === item.source)?.pseudo || "joueur retiré"}`;
  }
  if (item.type === "feed") return item.objets === "importants" ? "Messages (objets importants)" : "Messages de la partie";
  if (item.type === "progress") return "Progression";
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
            <option value="auto">Automatique (dans l'ordre des partages)</option>
            ${players.map((p) => html`<option value=${p.id}>${p.pseudo}</option>`)}
            ${item.source !== "auto" && !players.some((p) => p.id === item.source) && html`<option value=${item.source}>Joueur retiré de la room</option>`}
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
        onClick=${() => { const s = Math.min(item.w, 100 - item.y); onChange(item.id, { w: s, h: s }); }}>Format 16/9</button>`}
      <button type="button" class="ghost small" disabled=${full} onClick=${() => onDuplicate(item.id)}>Dupliquer</button>
      <button type="button" class="ghost small" onClick=${() => onOrder(item.id, 1)}>Mettre devant</button>
      <button type="button" class="ghost small" onClick=${() => onOrder(item.id, -1)}>Mettre derrière</button>
      <button type="button" class="ghost small" onClick=${() => onRemove(item.id)}>Retirer</button>
    </div>
  </div>`;
}

// --- Éditeur ------------------------------------------------------------------------------------

export function LayoutEditor({ room, data, setData }) {
  const saved = data.overlay_layouts || [];
  const savedText = JSON.stringify(saved);
  const [draft, setDraft] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const [currentId, setCurrentId] = useState(saved[0]?.id || null);
  const [selected, setSelected] = useState(null);
  const [preset, setPreset] = useState("complet");
  const [linkId, setLinkId] = useState(null);
  const action = useAction();
  const players = data.players || [];

  // Relecture régulière de la room : les dispositions enregistrées ailleurs remplacent le brouillon s'il est intact.
  useEffect(() => { if (!dirty) setDraft(JSON.parse(savedText)); }, [savedText]);

  const layout = draft.find((l) => l.id === currentId) || draft[0] || null;
  const item = layout?.items.find((i) => i.id === selected) || null;
  const full = !!layout && layout.items.length >= LAYOUT_LIMITS.items;
  const edit = (fn) => {
    setDraft((all) => all.map((l) => (l.id === layout.id ? fn({ ...l, items: [...l.items] }) : l)));
    setDirty(true);
  };
  const change = (id, patch) => edit((l) => ({ ...l, items: l.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) }));
  const remove = (id) => { edit((l) => ({ ...l, items: l.items.filter((i) => i.id !== id) })); setSelected(null); };
  const add = (type) => {
    const next = newItem(type, layout.items);
    edit((l) => ({ ...l, items: [...l.items, next] }));
    setSelected(next.id);
  };
  const duplicate = (id) => {
    const source = layout.items.find((i) => i.id === id);
    const copy = { ...source, id: newId(), x: clamp(source.x + 2, 0, 100 - source.w), y: clamp(source.y + 2, 0, 100 - source.h) };
    if (copy.type === "screen" && copy.source === "auto") copy.slot = nextSlot(layout.items);
    edit((l) => ({ ...l, items: [...l.items, copy] }));
    setSelected(copy.id);
  };
  // Les éléments sont dessinés dans l'ordre de la liste : le dernier est devant.
  const order = (id, direction) => edit((l) => {
    const moved = l.items.find((i) => i.id === id);
    const rest = l.items.filter((i) => i.id !== id);
    return { ...l, items: direction > 0 ? [...rest, moved] : [moved, ...rest] };
  });
  const create = () => {
    const next = { id: newId(), name: `Disposition ${draft.length + 1}`, items: presetItems(preset) };
    setDraft([...draft, next]);
    setCurrentId(next.id);
    setSelected(null);
    setDirty(true);
  };
  const applyPreset = () => {
    if (layout.items.length && !confirm(`Remplacer les éléments de « ${layout.name} » par le modèle « ${PRESETS[preset].label} » ?`)) return;
    edit((l) => ({ ...l, items: presetItems(preset) }));
    setSelected(null);
  };
  const removeLayout = () => {
    if (!confirm(`Supprimer la disposition « ${layout.name} » ? Son lien ne marchera plus.`)) return;
    const rest = draft.filter((l) => l.id !== layout.id);
    setDraft(rest);
    setCurrentId(rest[0]?.id || null);
    setSelected(null);
    setDirty(true);
  };
  const cancel = () => { setDraft(JSON.parse(savedText)); setDirty(false); setSelected(null); };
  const save = () => action.run(async () => {
    const result = await api.saveLayouts(room.code, draft);
    setData({ ...data, overlay_layouts: result.layouts });
    setDraft(result.layouts);
    setDirty(false);
  });

  // Lien d'accès utilisé pour copier l'adresse de la disposition (le premier de la liste, sauf choix).
  const links = data.overlay_links || [];
  const access = links.find((l) => l.id === linkId) || links[0] || null;
  const isSaved = layout && saved.some((l) => l.id === layout.id);
  const link = access && isSaved ? `${overlayLink(room.code, access.key)}?disposition=${layout.id}` : null;

  return html`<section class="card stack">
    <div class="row full">
      <h2 class="grow">Dispositions de l'overlay</h2>
      ${dirty && html`<span class="badge warn">Modifications non enregistrées</span>`}
    </div>
    <p>Placez vous-même les écrans des joueurs, les messages de la partie, la progression et des textes
      (titre…). Chaque disposition a son propre lien, à mettre dans OBS à la place du lien en grille ; les overlays
      ouverts changent dès l'enregistrement.</p>

    <div class="fields full">
      ${draft.length > 0 && html`<${Field} label="Disposition">
        <select value=${layout.id} onChange=${(e) => { setCurrentId(e.target.value); setSelected(null); }}>
          ${draft.map((l) => html`<option value=${l.id}>${l.name}</option>`)}
        </select></${Field}>`}
      <${Field} label="Modèle de départ">
        <${Choice} value=${preset} choices=${PRESETS} onChange=${setPreset} /></${Field}>
    </div>
    <div class="row">
      <button type="button" class=${draft.length ? "ghost" : ""} disabled=${draft.length >= LAYOUT_LIMITS.layouts} onClick=${create}>
        Nouvelle disposition</button>
      ${layout && html`<button type="button" class="ghost" onClick=${applyPreset}>Appliquer le modèle à celle-ci</button>`}
    </div>

    ${layout && html`
      <div class="fields full">
        <${Field} label="Nom de la disposition">
          <input type="text" maxLength=${LAYOUT_LIMITS.name} value=${layout.name}
            onInput=${(e) => edit((l) => ({ ...l, name: e.target.value }))} /></${Field}>
      </div>
      <div class="row">
        <span class="hint">Ajouter :</span>
        ${Object.entries(ITEM_TYPES).map(([type, t]) => html`<button type="button" class="ghost small" disabled=${full}
          onClick=${() => add(type)}>+ ${t.label}</button>`)}
      </div>
      <${Canvas} layout=${layout} players=${players} selected=${selected} onSelect=${setSelected} onChange=${change} onRemove=${remove} />
      <p class="hint">Glissez un élément pour le déplacer, son coin bas droit pour le redimensionner (Maj : format d'un écran).
        Au clavier : Tab pour choisir, flèches pour déplacer (Maj : plus vite), Alt + flèches pour redimensionner, Suppr pour retirer.
        Un écran sans joueur qui partage reste vide (transparent) dans l'overlay.</p>
      ${item
        ? html`<${ItemSettings} item=${item} layout=${layout} players=${players} onChange=${change} onRemove=${remove}
            onDuplicate=${duplicate} onOrder=${order} full=${full} />`
        : html`<p class="hint">Choisissez un élément pour le régler.</p>`}`}

    ${action.error && html`<div class="notice error full">${action.error}</div>`}
    <div class="row">
      <button type="button" disabled=${!dirty || action.busy} onClick=${save}>${action.busy ? "Enregistrement…" : "Enregistrer"}</button>
      ${dirty && html`<button type="button" class="ghost" disabled=${action.busy} onClick=${cancel}>Annuler les modifications</button>`}
      ${layout && html`<button type="button" class="link danger-link" onClick=${removeLayout}>Supprimer cette disposition</button>`}
    </div>
    ${layout && (link
      ? html`<div class="row">
          ${links.length > 1 && html`<label class="inline-field"><span>Avec le lien</span>
            <select value=${access.id} onChange=${(e) => setLinkId(e.target.value)}>
              ${links.map((l) => html`<option value=${l.id}>${l.name}</option>`)}
            </select></label>`}
          <${CopyButton} text=${link} label="Copier le lien de cette disposition" className="small" />
          <a class="button ghost small" href=${link} target="_blank" rel="noopener">Ouvrir</a>
        </div>`
      : html`<p class="hint">${!access
        ? "Créez d'abord un lien d'overlay (ci-dessus) pour obtenir le lien de cette disposition."
        : "Enregistrez la disposition pour obtenir son lien."}</p>`)}
  </section>`;
}
