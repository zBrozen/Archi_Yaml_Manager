// Page « Tracker » : suivi en direct de la partie Archipelago d'un joueur, avec le pack PopTracker du jeu
// (objets, cartes, lieux ; moteur dans tracker-engine.js) et la logique du jeu à la manière d'Universal
// Tracker (lieux en logique calculés par Archipelago, voir ut.js).
import { html, useState, useEffect, useRef, useMemo } from "../vendor/preact-htm.js";
import { openPack, Tracker, Access } from "./tracker-engine.js";
import { openSession, attachPack } from "./tracker-ap.js";
import { useLogic, roomYaml } from "./ut.js";
import { useSetting } from "./ui.js";
import { loadTrackers, packsFor, fetchRelease } from "./trackers.js";

// États des lieux : couleur de PopTracker, mais toujours avec un symbole et un texte.
export const STATES = {
  [Access.NORMAL]: { key: "normal", glyph: "!", label: "Accessible" },
  [Access.PARTIAL]: { key: "partial", glyph: "◐", label: "En partie accessible" },
  [Access.SEQUENCE_BREAK]: { key: "glitch", glyph: "?", label: "Hors logique" },
  [Access.INSPECT]: { key: "inspect", glyph: "i", label: "Visible seulement" },
  [Access.NONE]: { key: "none", glyph: "✕", label: "Inaccessible" },
  [Access.CLEARED]: { key: "cleared", glyph: "✓", label: "Fait" },
};
const STATE_ORDER = [Access.NORMAL, Access.PARTIAL, Access.SEQUENCE_BREAK, Access.INSPECT, Access.NONE, Access.CLEARED];

function useVersion(tracker) {
  const [, setVersion] = useState(0);
  useEffect(() => tracker?.subscribe(setVersion), [tracker]);
}

// --- Images du pack ---------------------------------------------------------------------

// Filtres d'image de PopTracker (img_mods) en filtres CSS.
function cssFilter(mods) {
  const parts = [];
  for (const mod of mods) {
    const [name, value] = mod.split("|");
    const key = name.trim().toLowerCase();
    if (["@disabled", "grey", "gray", "disable"].includes(key)) parts.push("grayscale(1) brightness(.67)");
    else if (key === "dim") parts.push("brightness(.5)");
    else if (key === "brightness") parts.push(`brightness(${Number(value) || 1})`);
    else if (key === "saturation") parts.push(`saturate(${Number(value) || 0})`);
    else if (key === "greyscale" || key === "grayscale") parts.push("grayscale(1)");
  }
  return parts.join(" ") || undefined;
}

function PackImage({ tracker, path, mods = [], alt = "" }) {
  const image = path ? tracker.pack.image(path, tracker.variant) : null;
  const overlays = mods.filter((mod) => mod.startsWith("overlay|")).map((mod) => mod.split("|"));
  if (!image) return html`<span class="pt-img-missing" aria-hidden="true"></span>`;
  return html`<span class="pt-img">
    <img src=${image.url} alt=${alt} draggable="false" style=${{ filter: cssFilter(mods) }} />
    ${overlays.map(([, overlay, ...filters]) => {
      const over = tracker.pack.image(overlay, tracker.variant);
      return over && html`<img src=${over.url} alt="" draggable="false" style=${{ filter: cssFilter(filters) }} />`;
    })}
  </span>`;
}

// --- Objets ---------------------------------------------------------------------------------

function itemSize(value, fallback = 32) {
  const sizes = { 0: 16, 1: 24, 2: 28, 3: 32, 4: 48, 5: 64 };
  const parse = (v) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return n < 10 ? sizes[n] ?? fallback : n;
  };
  if (typeof value === "number") return [parse(value), parse(value)];
  const [w, h = w] = String(value ?? "").split(",");
  return value === undefined ? [fallback, fallback] : [parse(w), parse(h)];
}

// Taille d'un objet, agrandie par le réglage « Taille » de la page (--pt-zoom).
const box = ([w, h]) => ({ width: `calc(${w}px * var(--pt-zoom, 1))`, height: `calc(${h}px * var(--pt-zoom, 1))` });

function Item({ tracker, code, size = [32, 32] }) {
  if (!code) return html`<span class="pt-item empty" style=${box(size)}></span>`;
  const view = tracker.itemView(code);
  if (!view) return html`<span class="pt-item empty" style=${box(size)}></span>`;
  const click = (button) => (e) => {
    e.preventDefault();
    tracker.clickItem(code, button);
  };
  const label = `${view.name}${view.badge ? ` : ${view.badge}` : ""}${view.staged ? "" : view.active ? " — obtenu" : " — pas obtenu"}`;
  return html`<button type="button" class=${`pt-item ${view.active ? "on" : "off"}`} title=${label} aria-label=${label}
    aria-pressed=${view.staged ? undefined : view.active} style=${box(size)}
    onClick=${click(0)} onContextMenu=${click(2)} onAuxClick=${(e) => e.button === 1 && click(1)(e)}>
    <${PackImage} tracker=${tracker} path=${view.path} mods=${view.mods} />
    ${view.overlay && html`<span class="pt-badge-img"><${PackImage} tracker=${tracker} path=${view.overlay} /></span>`}
    ${view.badge && html`<span class="pt-count" style=${{ color: view.badgeColor || undefined }}>${view.badge}</span>`}
  </button>`;
}

// --- Dispositions (layouts) ------------------------------------------------------------------

function withClass(tracker, node) {
  const cls = node?.class && tracker.classes.get(node.class);
  return cls ? { ...cls, ...node } : node;
}

const children = (content) => (Array.isArray(content) ? content : content ? [content] : []);
const gap = (value, fallback = 4) => {
  const [h, v = h] = String(value ?? "").split(",").map((n) => parseInt(n, 10));
  return Number.isFinite(h) ? [Math.max(0, h), Math.max(0, Number.isFinite(v) ? v : h)] : [fallback, fallback];
};

function Node({ tracker, node: raw, depth = 0, onMap }) {
  const node = withClass(tracker, raw);
  if (!node || typeof node !== "object" || depth > 40) return null;
  const type = String(node.type || "").toLowerCase();
  const child = (n, i) => html`<${Node} key=${i} tracker=${tracker} node=${n} depth=${depth + 1} onMap=${onMap} />`;
  switch (type) {
    case "layout": return child(tracker.layouts.get(node.key), 0);
    case "container": return html`<div class="pt-box">${children(node.content).map(child)}</div>`;
    case "group":
      return html`<section class="pt-group">
        ${node.header && html`<h3>${node.header}</h3>`}
        <div class="pt-array vertical">${children(node.content).map(child)}</div>
      </section>`;
    case "array": {
      const vertical = String(node.orientation || "horizontal").toLowerCase() === "vertical";
      return html`<div class=${`pt-array ${vertical ? "vertical" : "horizontal"}`}>${children(node.content).map(child)}</div>`;
    }
    case "dock": return html`<${Dock} tracker=${tracker} items=${children(node.content)} depth=${depth} onMap=${onMap} />`;
    case "tabbed": return html`<${Tabbed} tracker=${tracker} node=${node} depth=${depth} onMap=${onMap} />`;
    case "item": return html`<${Item} tracker=${tracker} code=${node.item} size=${itemSize(node.item_size, 48)} />`;
    case "itemgrid": {
      const size = itemSize(node.item_size);
      const [h, v] = gap(node.item_margin, 4);
      const rows = Array.isArray(node.rows) ? node.rows : [];
      return html`<div class="pt-grid" style=${{ rowGap: `${v}px` }}>
        ${rows.map((row, r) => html`<div key=${r} class="pt-grid-row" style=${{ columnGap: `${h}px` }}>
          ${(Array.isArray(row) ? row : []).map((code, i) => html`<${Item} key=${i} tracker=${tracker} code=${code} size=${size} />`)}
        </div>`)}
      </div>`;
    }
    case "map": {
      const names = Array.isArray(node.maps) && node.maps.length ? node.maps : [...tracker.maps.keys()];
      return html`<div class="pt-maps">${names.map((name) => html`<${MapView} key=${name} tracker=${tracker} name=${name} onOpen=${onMap} zoom=${tracker.zoom || 1} />`)}</div>`;
    }
    case "text": return html`<p class="pt-text">${node.text}</p>`;
    case "canvas": return html`<div class="pt-array vertical">${children(node.content).map(child)}</div>`;
    default: return null;
  }
}

// Dock : chaque enfant se colle à un bord (« dock »), le dernier prend la place qui reste.
function Dock({ tracker, items, depth, onMap }) {
  if (!items.length) return null;
  const [first, ...rest] = items;
  const render = (n) => html`<${Node} tracker=${tracker} node=${n} depth=${depth + 1} onMap=${onMap} />`;
  if (!rest.length) return html`<div class="pt-fill">${render(first)}</div>`;
  const side = String(withClass(tracker, first)?.dock || "left").toLowerCase();
  const horizontal = side === "left" || side === "right";
  const docked = html`<div class="pt-docked">${render(first)}</div>`;
  const remaining = html`<div class="pt-fill"><${Dock} tracker=${tracker} items=${rest} depth=${depth} onMap=${onMap} /></div>`;
  const reverse = side === "right" || side === "bottom";
  return html`<div class=${`pt-dock ${horizontal ? "row" : "column"}`}>${reverse ? [remaining, docked] : [docked, remaining]}</div>`;
}

function Tabbed({ tracker, node, depth, onMap }) {
  const tabs = Array.isArray(node.tabs) ? node.tabs : [];
  const [, refresh] = useState(0);
  const chosen = tracker.tabs.get(node);
  const active = tabs.find((tab) => tab.title === chosen) || tabs[0];
  if (!active) return null;
  const select = (title) => {
    tracker.tabs.set(node, title);
    refresh((n) => n + 1);
  };
  return html`<div class="pt-tabbed">
    <div class="pt-tabs" role="tablist">
      ${tabs.map((tab, i) => html`<button key=${i} type="button" role="tab" aria-selected=${tab === active}
        class=${tab === active ? "active" : ""} onClick=${() => select(tab.title)}>${tab.title || `Onglet ${i + 1}`}</button>`)}
    </div>
    <div class="pt-tab-content" role="tabpanel">
      <${Node} tracker=${tracker} node=${active.content} depth=${depth + 1} onMap=${onMap} />
    </div>
  </div>`;
}

// --- Cartes ------------------------------------------------------------------------------------

// Largeur affichée d'un élément (la carte est réduite ou agrandie à la largeur disponible).
function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref.current]);
  return [ref, width];
}

function MapView({ tracker, name, onOpen, zoom }) {
  const [ref, shown] = useWidth();
  const map = tracker.maps.get(name);
  const image = map ? tracker.pack.image(map.img, tracker.variant) : null;
  if (!map) return null;
  if (!image) return html`<div class="pt-map loading hint">Chargement de la carte…</div>`;
  const { width, height } = image;
  // Repères d'au moins 14 px à l'écran (plus avec le réglage « Taille »), quelle que soit la réduction de la carte.
  const minimum = shown ? (14 * zoom * width) / shown : 0;
  const marks = [];
  for (const location of tracker.locations) {
    for (const [i, spot] of location.mapLocations.entries()) {
      if (spot.map !== name || !tracker.mapLocationVisible(location, spot)) continue;
      const state = tracker.locationState(location);
      if (state === null) continue;
      const size = Math.max(spot.size ?? map.size, minimum);
      const border = Math.max(1, spot.border ?? map.border);
      const info = STATES[state];
      const label = `${location.name} : ${info.label}`;
      const open = () => onOpen?.(location);
      marks.push(html`<g key=${`${location.id}#${i}`} class=${`pt-mark ${info.key}`} role="button" tabindex="0" aria-label=${label}
        onClick=${open} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open())}>
        <title>${label}</title>
        <rect x=${spot.x - size / 2} y=${spot.y - size / 2} width=${size} height=${size} stroke-width=${border}
          transform=${(spot.shape ?? map.shape) === "diamond" ? `rotate(45 ${spot.x} ${spot.y})` : undefined} />
        <text x=${spot.x} y=${spot.y} font-size=${size * 0.72}>${info.glyph}</text>
      </g>`);
    }
  }
  return html`<figure class="pt-map" ref=${ref}>
    <svg viewBox=${`0 0 ${width} ${height}`} role="group" aria-label=${`Carte ${name}`}>
      <image href=${image.url} width=${width} height=${height} style=${{ imageRendering: shown > width ? "pixelated" : "auto" }} />
      ${marks}
    </svg>
  </figure>`;
}

function Legend() {
  return html`<ul class="pt-legend">
    ${STATE_ORDER.map((state) => html`<li key=${state}><span class=${`pt-swatch ${STATES[state].key}`} aria-hidden="true">${STATES[state].glyph}</span>${STATES[state].label}</li>`)}
  </ul>`;
}

// Détail d'un lieu : ses sections, à cocher à la main si la partie n'est pas suivie.
function LocationDetail({ tracker, location, onClose }) {
  const sections = location.sections.filter((s) => tracker.sectionState(s) !== null);
  return html`<div class="modal" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal-box pt-detail" role="dialog" aria-label=${location.name}>
      <div class="toolbar-row"><strong>${location.name}</strong><span class="spacer"></span>
        <button type="button" class="ghost" onClick=${onClose}>Fermer</button></div>
      <ul class="pt-sections">
        ${sections.map((section) => html`<${SectionRow} key=${section.id} tracker=${tracker} section=${section} />`)}
      </ul>
    </div>
  </div>`;
}

function SectionRow({ tracker, section, showLocation = false }) {
  const real = tracker.realSection(section);
  const state = tracker.sectionState(section);
  const info = STATES[state];
  const left = real.itemCount - real.cleared;
  const name = [showLocation && section.location.name, real.name].filter(Boolean).join(" — ") || section.location.name;
  return html`<li class="pt-section">
    <span class=${`pt-swatch ${info.key}`} aria-hidden="true">${info.glyph}</span>
    <span class="pt-section-name">${name}<span class="hint"> · ${info.label}${real.itemCount > 1 ? ` · ${left} sur ${real.itemCount} restants` : ""}</span></span>
    ${real.hosted.map((code) => html`<${Item} key=${code} tracker=${tracker} code=${code} size=${[32, 32]} />`)}
    ${state === Access.CLEARED
      ? html`<button type="button" class="ghost small" onClick=${() => tracker.clickSection(section, -1)}>Annuler</button>`
      : html`<button type="button" class="small" onClick=${() => tracker.clickSection(section, 1)}>Fait</button>`}
  </li>`;
}

// Tous les lieux en liste, triés par état : lisible sans la carte (et à l'écran d'un stream).
function LocationList({ tracker }) {
  const [all, setAll] = useState(false);
  const rows = [];
  for (const location of tracker.locations) {
    for (const section of location.sections) {
      const state = tracker.sectionState(section);
      if (state === null || (!all && (state === Access.CLEARED || state === Access.NONE))) continue;
      rows.push({ section, state });
    }
  }
  rows.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
  return html`<div class="stack full">
    <label class="row small"><input type="checkbox" checked=${all} onChange=${(e) => setAll(e.target.checked)} />
      Montrer aussi les lieux inaccessibles et ceux déjà faits</label>
    ${rows.length === 0 && html`<p class="hint">${all ? "Ce pack n'a aucun lieu." : "Aucun lieu accessible pour l'instant."}</p>`}
    <ul class="pt-sections">${rows.map(({ section }) => html`<${SectionRow} key=${section.id} tracker=${tracker} section=${section} showLocation=${true} />`)}</ul>
  </div>`;
}

// --- Connexion à la partie -------------------------------------------------------------------

function Connection({ initial, session, onSession }) {
  const [form, setForm] = useState({ address: initial.server || "", slot: initial.slot || "", password: "" });
  const [state, setState] = useState("idle");
  const [error, setError] = useState(null);
  useEffect(() => () => session?.disconnect(), [session]);
  useEffect(() => session?.subscribe((event) => event.type === "closed" && setState("closed")), [session]);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const connect = async (e) => {
    e.preventDefault();
    setError(null);
    setState("connecting");
    try {
      onSession(await openSession(form));
      setState("connected");
    } catch (err) {
      setError(err.message);
      setState("idle");
    }
  };
  const disconnect = () => {
    session?.disconnect();
    onSession(null);
    setState("idle");
  };
  if (state === "connected" && session) {
    return html`<div class="notice ok row">
      <span>Partie suivie en direct : <strong>${session.slotName}</strong> (${session.game}) sur ${form.address}.</span>
      <span class="spacer"></span><button type="button" class="ghost small" onClick=${disconnect}>Arrêter le suivi</button>
    </div>`;
  }
  return html`<form class="card stack full" onSubmit=${connect}>
    <strong>Suivre la partie</strong>
    <p class="hint">Les objets reçus et les lieux faits s'affichent tout seuls, et la logique du jeu dit quels lieux sont accessibles.
      Sans connexion, cliquez sur les objets et les lieux du pack pour les cocher.</p>
    <div class="fields">
      <label><span>Serveur</span><input required aria-label="Serveur" value=${form.address} onInput=${set("address")} placeholder="archipelago.gg:38281" /></label>
      <label><span>Nom du joueur</span><input required aria-label="Nom du joueur" value=${form.slot} onInput=${set("slot")} /></label>
      <label><span>Mot de passe (facultatif)</span><input type="password" aria-label="Mot de passe" value=${form.password} onInput=${set("password")} autocomplete="off" /></label>
    </div>
    ${state === "closed" && html`<div class="notice warn">La connexion au serveur a été coupée.</div>`}
    ${error && html`<div class="notice error">${error}</div>`}
    <div class="row"><button type="submit" disabled=${state === "connecting"}>${state === "connecting" ? "Connexion…" : "Suivre"}</button></div>
  </form>`;
}

// --- Logique du jeu (à la manière d'Universal Tracker) ------------------------------------------

function LogicPanel({ session, room }) {
  const [enabled, setEnabled] = useSetting("trackerLogic", false);
  // YAML de la room : undefined tant qu'il n'a pas été cherché, null s'il n'y en a pas. Un YAML déposé passe avant.
  const [roomText, setRoomText] = useState(undefined);
  const [file, setFile] = useState(null);
  const [filter, setFilter] = useState("");
  const connected = !!session?.connected;
  useEffect(() => {
    setRoomText(undefined);
    if (!connected || !enabled) return undefined;
    let alive = true;
    roomYaml(room, session.slotName, session.game).then((text) => alive && setRoomText(text));
    return () => { alive = false; };
  }, [session, enabled]);
  const yaml = file?.text ?? roomText ?? null;
  const yamlFrom = file ? `« ${file.name} »` : roomText ? "la room" : null;
  const { status, error, result } = useLogic(session, yaml, enabled && connected && (!!file || roomText !== undefined));
  const readYaml = async (picked) => setFile({ name: picked.name, text: await picked.text() });

  if (!enabled) {
    return html`<section class="card stack full">
      <h2 class="ut-title">Logique du jeu</h2>
      <p>Les lieux restants <strong>en logique</strong> avec les objets reçus, calculés par la logique d'Archipelago elle-même,
        comme le fait <a href="https://github.com/FarisTheAncient/Archipelago/releases" target="_blank" rel="noreferrer">Universal Tracker</a>.
        Pour tous les jeux, avec ou sans pack PopTracker.</p>
      <p class="hint">Archipelago tourne dans votre navigateur : environ 15 Mo à télécharger la première fois.</p>
      <div class="row"><button type="button" onClick=${() => setEnabled(true)}>Activer la logique du jeu</button></div>
    </section>`;
  }

  const needle = filter.trim().toLowerCase();
  const groups = new Map();
  const add = (id, glitched) => {
    const region = result.regions[id] || "Autres lieux";
    const label = session.name("location", id);
    if (needle && !label.toLowerCase().includes(needle) && !region.toLowerCase().includes(needle)) return;
    if (!groups.has(region)) groups.set(region, []);
    groups.get(region).push({ id, label, glitched });
  };
  if (result) {
    result.logic.forEach((id) => add(id, false));
    result.glitched.forEach((id) => add(id, true));
  }
  const sorted = [...groups].sort(([a], [b]) => a.localeCompare(b));
  const count = (n, one, many) => `${n} ${n > 1 ? many : one}`;
  return html`<section class="card stack full">
    <div class="row full">
      <h2 class="ut-title grow">Logique du jeu</h2>
      <button type="button" class="ghost small" onClick=${() => setEnabled(false)}>Désactiver</button>
    </div>
    ${!connected && html`<p class="hint">Connectez-vous à la partie (ci-dessus) pour calculer les lieux en logique.</p>`}
    ${connected && html`<p class="hint">${yamlFrom ? `YAML du joueur lu dans ${yamlFrom}.` : "Sans YAML du joueur : seuls les jeux qui le permettent sont calculés."}</p>`}
    <${YamlDrop} onFile=${readYaml} />
    ${status && html`<p class="hint">${status}</p>`}
    ${error && html`<div class="notice error">${error}</div>`}
    ${result && html`<div class="stack full">
      <div class="row full">
        <strong class="grow">${count(result.logic.length, "lieu en logique", "lieux en logique")}${result.glitched.length ? `, ${count(result.glitched.length, "hors logique", "hors logique")}` : ""}</strong>
        <input class="search" type="search" aria-label="Chercher un lieu" placeholder="Chercher un lieu ou une région" value=${filter} onInput=${(e) => setFilter(e.target.value)} />
      </div>
      ${sorted.length === 0 && html`<p class="hint">${needle ? "Aucun lieu ne correspond." : "Aucun lieu en logique pour l'instant."}</p>`}
      ${sorted.map(([region, entries]) => html`<div key=${region} class="ut-region">
        <h3>${region} <span class="hint">(${entries.length})</span></h3>
        <ul class="pt-sections">${entries.sort((a, b) => a.label.localeCompare(b.label)).map((e) => html`<li key=${e.id} class="pt-section">
          <span class=${`pt-swatch ${e.glitched ? "glitch" : "normal"}`} aria-hidden="true">${e.glitched ? "?" : "!"}</span>
          <span class="pt-section-name">${e.label}<span class="hint"> · ${e.glitched ? "hors logique (glitch)" : "en logique"}</span>${result.aliases?.[e.id] ? html`<span class="hint"> · ${result.aliases[e.id]}</span>` : ""}</span>
        </li>`)}</ul>
      </div>`)}
      ${result.errors?.length > 0 && html`<details class="notice warn"><summary>Remarques du calcul (${result.errors.length})</summary>
        <ul>${result.errors.map((e, i) => html`<li key=${i}>${e}</li>`)}</ul></details>`}
    </div>`}
  </section>`;
}

function YamlDrop({ onFile }) {
  return html`<label class="row small ut-yaml">
    <span>Utiliser un autre YAML :</span>
    <input type="file" accept=".yaml,.yml,.txt" onChange=${(e) => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ""; }} />
  </label>`;
}

// --- Vue du tracker ------------------------------------------------------------------------------

function TrackerView({ tracker, session }) {
  useVersion(tracker);
  useEffect(() => (session?.connected ? attachPack(tracker, session) : undefined), [tracker, session]);
  const [view, setView] = useSetting("trackerView", "pack");
  const [zoom, setZoom] = useSetting("trackerZoom", 1.5);
  const [detail, setDetail] = useState(null);
  const [panel, setPanel] = useState(null);
  const root = tracker.rootLayout();
  const settings = tracker.rootLayout("settings");
  tracker.zoom = zoom; // lu par les cartes pour la taille des repères
  return html`<div class="stack full">
    <div class="toolbar-row pt-toolbar">
      <div class="tabs row" role="tablist">
        <button type="button" role="tab" aria-selected=${view === "pack"} class=${view === "pack" ? "active" : ""} onClick=${() => setView("pack")}>Tracker</button>
        <button type="button" role="tab" aria-selected=${view === "list"} class=${view === "list" ? "active" : ""} onClick=${() => setView("list")}>Lieux en liste</button>
      </div>
      <span class="spacer"></span>
      <label class="row small">Taille
        <select value=${zoom} onChange=${(e) => setZoom(Number(e.target.value))}>
          <option value="1">normale</option><option value="1.5">grande</option><option value="2">très grande</option>
        </select>
      </label>
      ${settings && html`<button type="button" class="ghost small" onClick=${() => setPanel("settings")}>Réglages du pack</button>`}
      <button type="button" class="ghost small" onClick=${() => setPanel("log")}>Journal</button>
    </div>
    ${tracker.errors.length > 0 && html`<details class="notice warn"><summary>Le pack a signalé ${tracker.errors.length} problème(s)</summary>
      <ul>${tracker.errors.map((e, i) => html`<li key=${i}>${e}</li>`)}</ul></details>`}
    <div class="pt-root" style=${{ "--pt-zoom": zoom }}>
      ${view === "list"
        ? html`<${LocationList} tracker=${tracker} />`
        : html`<${Node} tracker=${tracker} node=${root} onMap=${setDetail} />`}
    </div>
    ${view === "pack" && tracker.maps.size > 0 && html`<${Legend} />`}
    ${detail && html`<${LocationDetail} tracker=${tracker} location=${detail} onClose=${() => setDetail(null)} />`}
    ${panel && html`<div class="modal" onClick=${(e) => e.target === e.currentTarget && setPanel(null)}>
      <div class="modal-box">
        <div class="toolbar-row"><strong>${panel === "log" ? "Journal du pack" : "Réglages du pack"}</strong><span class="spacer"></span>
          <button type="button" class="ghost" onClick=${() => setPanel(null)}>Fermer</button></div>
        ${panel === "log"
          ? html`<pre>${tracker.logLines.join("\n") || "Rien pour l'instant."}</pre>`
          : html`<div class="pt-root" style=${{ "--pt-zoom": zoom }}><${Node} tracker=${tracker} node=${settings} onMap=${setDetail} /></div>`}
      </div>
    </div>`}
  </div>`;
}

// --- Page -------------------------------------------------------------------------------------------

const fetchPack = (url) => fetchRelease(url, "le pack");

export function TrackerPage({ params }) {
  const [index, setIndex] = useState(null);
  const [game, setGame] = useState(params.game || "");
  const [choice, setChoice] = useState(0);
  const [pack, setPack] = useState(null);
  const [variant, setVariant] = useState(null);
  const [tracker, setTracker] = useState(null);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);

  useEffect(() => { loadTrackers().then(setIndex); }, []);
  // Connecté, le jeu est celui du joueur.
  useEffect(() => { if (session?.game && !pack) setGame(session.game); }, [session]);
  const packs = useMemo(() => packsFor(index, game), [index, game]);
  const games = useMemo(() => Object.entries(index?.games || {}).filter(([, list]) => list.some((p) => p.url)).map(([name]) => name), [index]);

  const open = async (getBuffer) => {
    setError(null);
    setTracker(null);
    setPack(null);
    setStatus("Téléchargement du pack…");
    try {
      const opened = await openPack(await getBuffer());
      setPack(opened);
      setVariant(Object.keys(opened.variants)[0]);
    } catch (e) {
      setError(e.message);
    } finally {
      setStatus(null);
    }
  };

  // Lien direct vers un pack (?pack=…) ; depuis une room (?slot=…), le pack du jeu s'ouvre tout seul.
  useEffect(() => {
    if (params.pack) open(() => fetchPack(params.pack));
  }, [params.pack]);
  useEffect(() => {
    if (!params.pack && params.slot && packs.length === 1 && packs[0].url) open(() => fetchPack(packs[0].url));
  }, [packs]);

  useEffect(() => {
    if (!pack || !variant) return undefined;
    let alive = true;
    let created = null;
    setStatus("Lancement du pack…");
    setError(null);
    Tracker.create(pack, variant)
      .then((t) => { created = t; if (alive) setTracker(t); else t.dispose(); })
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setStatus(null));
    return () => { alive = false; created?.dispose(); setTracker(null); };
  }, [pack, variant]);

  useEffect(() => () => pack?.dispose(), [pack]);

  const chosen = packs[choice];
  const variants = pack ? Object.entries(pack.variants) : [];
  return html`<main class="tracker-page">
    <div class="stack full">
      <div class="row">
        <h1 class="pt-title">Tracker${pack ? html` : ${pack.name}` : ""}</h1>
        <span class="spacer"></span>
        ${params.room && html`<a href=${`#/room/${params.room}`}>Retour à la room</a>`}
      </div>
      <${Connection} initial=${params} session=${session} onSession=${setSession} />
      ${!pack && !status && !(params.pack && !error) && html`<div class="card stack full">
        <h2 class="ut-title">Pack PopTracker</h2>
        <label class="stack full"><strong>Jeu</strong>
          <input list="pt-games" value=${game} onInput=${(e) => { setGame(e.target.value); setChoice(0); }} placeholder="Nom du jeu" />
          <datalist id="pt-games">${games.map((name) => html`<option key=${name} value=${name} />`)}</datalist>
        </label>
        ${game && index && packs.length === 0 && html`<p class="hint">Aucun pack PopTracker connu pour ce jeu dans la liste des jeux du Discord d'Archipelago.</p>`}
        ${packs.length > 1 && html`<label class="stack full"><span>Pack</span>
          <select value=${choice} onChange=${(e) => setChoice(Number(e.target.value))}>
            ${packs.map((p, i) => html`<option key=${i} value=${i}>${p.repo || p.page}${p.tag ? ` (${p.tag})` : ""}</option>`)}
          </select></label>`}
        ${chosen && html`<div class="row">
          ${chosen.url
            ? html`<button type="button" disabled=${!!status} onClick=${() => open(() => fetchPack(chosen.url))}>Ouvrir le tracker</button>`
            : html`<span class="hint">Ce pack n'a pas de release téléchargeable.</span>`}
          <a href=${chosen.page} target="_blank" rel="noreferrer">Page du pack${chosen.repo ? ` (${chosen.repo})` : ""}</a>
        </div>`}
        <${PackDrop} disabled=${!!status} onFile=${(file) => open(() => file.arrayBuffer())} />
      </div>`}
      ${pack && variants.length > 1 && html`<label class="row"><span>Version du tracker</span>
        <select value=${variant} onChange=${(e) => setVariant(e.target.value)}>
          ${variants.map(([uid, v]) => html`<option key=${uid} value=${uid}>${v.display_name || uid}</option>`)}
        </select></label>`}
      ${status && html`<p class="hint">${status}</p>`}
      ${error && html`<div class="notice error">${error}</div>`}
      ${tracker && html`<${TrackerView} key=${`${pack.uid}/${variant}`} tracker=${tracker} session=${session} />`}
      ${pack && html`<p class="hint small">Pack « ${pack.name} »${pack.manifest.author ? ` de ${pack.manifest.author}` : ""}, lu dans le navigateur sans PopTracker.${" "}
        <button type="button" class="link" onClick=${() => { setPack(null); setTracker(null); }}>Changer de pack</button></p>`}
      <${LogicPanel} session=${session} room=${params.room} />
    </div>
  </main>`;
}

function PackDrop({ onFile, disabled }) {
  const [hover, setHover] = useState(false);
  return html`<label class=${`drop compact ${hover ? "hover" : ""}`}
    onDragOver=${(e) => { e.preventDefault(); setHover(true); }}
    onDragLeave=${() => setHover(false)}
    onDrop=${(e) => { e.preventDefault(); setHover(false); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); }}>
    <input type="file" accept=".zip" hidden disabled=${disabled} onChange=${(e) => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ""; }} />
    <strong>Ou déposez le .zip d'un pack PopTracker</strong>
    <span>il reste dans votre navigateur</span>
  </label>`;
}
