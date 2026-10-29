// Éditeurs d'options : un composant par type d'option Archipelago.
//
// Mode simple (par défaut) : une valeur par option, uniquement des valeurs valides.
// Mode avancé : en plus, les tirages au sort (« random »), les tables de poids et le YAML brut.
import { html, useState, useMemo, useEffect } from "../vendor/preact-htm.js";
import { isPlainObject, toYamlSnippet, parseSnippet } from "./yaml-model.js";
import {
  RANDOM_LABELS, COMMON_TEXT, parseRandomRange, keyUniverse, toggleState, resolveChoice,
  checkValue, sameAsDefault, defaultValue, describeDefault, describeScalar,
  keyForValue, valueForKey, singleValue, writeSingle,
} from "./options.js";

let idCounter = 0;
const useId = () => useMemo(() => `id-${++idCounter}`, []);
const RANDOM_WORDS = Object.keys(RANDOM_LABELS);
const isRandom = (value) => typeof value === "string" && (RANDOM_WORDS.includes(value.toLowerCase()) || !!parseRandomRange(value));
const clamp = (n, min, max) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
const prettify = (text) => String(text).replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// --- Composants communs ----------------------------------------------------------

export function Suggest({ items, onPick, placeholder, exclude }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => {
    const needle = text.trim().toLowerCase();
    const result = [];
    for (const item of items) {
      if (exclude && exclude.has(item)) continue;
      if (!needle || item.toLowerCase().includes(needle)) result.push(item);
      if (result.length >= 40) break;
    }
    return result;
  }, [text, items, exclude]);

  const pick = (value) => {
    onPick(value);
    setText("");
  };
  const onKeyDown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const typed = text.trim();
    const exact = matches.find((m) => m.toLowerCase() === typed.toLowerCase());
    // Avec une liste de valeurs connues, on n'ajoute que des valeurs de cette liste.
    const value = exact || (items.length ? (typed ? matches[0] : null) : typed);
    if (value) pick(value);
  };
  return html`<div class="suggest">
    <input type="text" value=${text} placeholder=${placeholder}
      onInput=${(e) => { setText(e.target.value); setOpen(true); }}
      onFocus=${() => setOpen(true)} onBlur=${() => setTimeout(() => setOpen(false), 150)}
      onKeyDown=${onKeyDown} />
    ${open && matches.length > 0 && html`<ul class="suggest-list">
      ${matches.map((m) => html`<li onMouseDown=${(e) => { e.preventDefault(); pick(m); }}>${m}</li>`)}
    </ul>`}
  </div>`;
}

function Segmented({ options, value, onChange }) {
  return html`<div class="segmented" role="radiogroup">
    ${options.map((o) => html`<button type="button" role="radio" aria-checked=${o.value === value}
      class=${o.value === value ? "active" : ""} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
  </div>`;
}

export function RawEditor({ value, onChange, rows }) {
  const [text, setText] = useState(() => toYamlSnippet(value));
  const [error, setError] = useState(null);
  const serialized = JSON.stringify(value);
  useEffect(() => { setText(toYamlSnippet(value)); setError(null); }, [serialized]);
  const commit = () => {
    try {
      const parsed = text.trim() === "" ? undefined : parseSnippet(text);
      setError(null);
      if (JSON.stringify(parsed) !== serialized) onChange(parsed);
    } catch (e) {
      setError(e.message);
    }
  };
  const lines = text.split("\n").length;
  return html`<div class="raw">
    <textarea spellcheck="false" rows=${rows || Math.min(16, Math.max(2, lines + 1))} value=${text}
      onInput=${(e) => setText(e.target.value)} onBlur=${commit}></textarea>
    ${error && html`<p class="error small">YAML invalide : ${error}</p>`}
  </div>`;
}

function summaryOf(doc) {
  const paragraph = (doc || "").split(/\n\s*\n/)[0];
  // Description en forme de liste (« Ganon: … / Crystals: … ») : illisible sur une ligne, on la laisse dans « Détails ».
  const lines = paragraph.split("\n").filter((l) => l.trim());
  if (lines.length > 1 && lines.every((l) => /^\s*[-*]?\s*\**[\w'’ .()/-]{1,40}\**\s*:/.test(l))) return "";
  const first = paragraph.replace(/\s*\n\s*/g, " ").replace(/\*\*|``?/g, "").trim();
  return first.length > 240 ? `${first.slice(0, 230).replace(/\s+\S*$/, "")}…` : first;
}

function Description({ option }) {
  const [open, setOpen] = useState(false);
  const fr = COMMON_TEXT[option.key];
  const summary = fr ? fr[1] : summaryOf(option.doc);
  const full = (option.doc || "").trim();
  const more = full && (fr || full.replace(/\s+/g, " ") !== summary.replace(/\s+/g, " "));
  if (!summary && !full) return null;
  return html`<div class="opt-desc">
    <p>${summary}${more && html` <button type="button" class="link" onClick=${() => setOpen(!open)}>${open ? "Masquer" : summary ? "Détails" : "Voir l'explication"}</button>`}</p>
    ${open && (option.doc_html
      ? html`<div class="doc rich" dangerouslySetInnerHTML=${{ __html: option.doc_html }}></div>`
      : html`<div class="doc">${full}</div>`)}
  </div>`;
}

// --- Valeurs simples -------------------------------------------------------------

function ToggleControl({ value, advanced, onChange }) {
  const random = String(value).toLowerCase() === "random";
  const state = random ? "random" : String(toggleState(value) ?? false);
  const options = [{ value: "false", label: "Non" }, { value: "true", label: "Oui" }];
  if (advanced || random) options.push({ value: "random", label: "Aléatoire" });
  return html`<${Segmented} value=${state} options=${options}
    onChange=${(v) => onChange(v === "random" ? "random" : v === "true")} />`;
}

function ChoiceControl({ option, value, advanced, onChange }) {
  const isText = option.kind === "text_choice";
  const random = String(value).toLowerCase() === "random";
  const resolved = random ? "random" : resolveChoice(option, value);
  const [custom, setCustom] = useState(isText && resolved === null && value != null);
  const current = custom ? "__custom" : resolved ?? "__invalid";
  return html`<div class="stack">
    <select value=${current} onChange=${(e) => {
      const v = e.target.value;
      if (v === "__custom") { setCustom(true); return; }
      setCustom(false);
      if (v !== "__invalid") onChange(v);
    }}>
      ${option.choices.map((c) => html`<option value=${c.value}>${c.label}</option>`)}
      ${(advanced || random) && html`<option value="random">Aléatoire</option>`}
      ${isText && advanced && html`<option value="__custom">Autre valeur…</option>`}
      ${current === "__invalid" && html`<option value="__invalid">${value == null ? "— à choisir —" : `${value} (invalide)`}</option>`}
    </select>
    ${custom && html`<input type="text" value=${resolved === null ? String(value ?? "") : ""} placeholder="Valeur libre"
      onChange=${(e) => e.target.value.trim() && onChange(e.target.value.trim())} />`}
  </div>`;
}

function RangeControl({ option, value, advanced, onChange }) {
  const bounded = option.min !== undefined && option.max !== undefined;
  const special = option.special || {};
  const text = String(value ?? "").toLowerCase();
  const randomRange = parseRandomRange(text);
  const mode = RANDOM_WORDS.includes(text) ? text : randomRange ? "random-range" : "value";
  const fallback = Number.isInteger(Number(option.default)) ? Number(option.default) : bounded ? option.min : 0;
  const number = text in special ? special[text] : Number.isInteger(Number(value)) && value !== null && value !== "" ? Number(value) : fallback;
  const setNumber = (n) => Number.isFinite(n) && onChange(bounded ? clamp(Math.round(n), option.min, option.max) : Math.round(n));

  const modeSelect = html`<select value=${mode} onChange=${(e) => {
    const m = e.target.value;
    if (m === "value") onChange(number);
    else if (m === "random-range") onChange(`random-range-${option.min}-${option.max}`);
    else onChange(m);
  }}>
    <option value="value">Valeur précise</option>
    ${RANDOM_WORDS.map((w) => html`<option value=${w}>${RANDOM_LABELS[w]}</option>`)}
    ${bounded && html`<option value="random-range">Aléatoire entre deux valeurs…</option>`}
  </select>`;

  if (mode !== "value" && !advanced) {
    return html`<div class="stack">
      <span class="value-text">${describeScalar(option, value)}</span>
      <button type="button" class="small ghost" onClick=${() => onChange(fallback)}>Choisir une valeur précise</button>
    </div>`;
  }
  return html`<div class="stack">
    ${advanced && modeSelect}
    ${mode === "value" && html`<div class="range-row">
      ${bounded && html`<input type="range" min=${option.min} max=${option.max} value=${clamp(number, option.min, option.max)}
        onInput=${(e) => setNumber(Number(e.target.value))} />`}
      <input type="number" class="num" min=${option.min} max=${option.max} value=${number}
        onChange=${(e) => e.target.value !== "" && setNumber(Number(e.target.value))} />
    </div>`}
    ${mode === "value" && Object.keys(special).length > 0 && html`<div class="chips-row">
      ${Object.entries(special).map(([name, n]) => html`<button type="button"
        class=${`chip-btn ${number === n ? "active" : ""}`} onClick=${() => onChange(name)}>${prettify(name)} (${n})</button>`)}
    </div>`}
    ${mode === "random-range" && html`<div class="range-row">
      <span>de</span>
      <input type="number" class="num" value=${randomRange.min} min=${option.min} max=${option.max}
        onChange=${(e) => onChange(`random-range-${clamp(Number(e.target.value), option.min, randomRange.max)}-${randomRange.max}`)} />
      <span>à</span>
      <input type="number" class="num" value=${randomRange.max} min=${option.min} max=${option.max}
        onChange=${(e) => onChange(`random-range-${randomRange.min}-${clamp(Number(e.target.value), randomRange.min, option.max)}`)} />
    </div>`}
    ${bounded && html`<span class="hint">Entre ${option.min} et ${option.max}</span>`}
  </div>`;
}

function ScalarControl(props) {
  switch (props.option.kind) {
    case "toggle": return html`<${ToggleControl} ...${props} />`;
    case "choice":
    case "text_choice": return html`<${ChoiceControl} ...${props} />`;
    case "range":
    case "named_range": return html`<${RangeControl} ...${props} />`;
    default:
      return html`<input type="text" value=${props.value ?? ""} onChange=${(e) => props.onChange(e.target.value)} />`;
  }
}

// --- Tables de poids (mode avancé) ---------------------------------------------------

function renameKey(obj, from, to) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k === from ? to : k] = v;
  return out;
}

function choiceItems(option) {
  if (option.kind === "toggle") return [{ value: "false", label: "Non" }, { value: "true", label: "Oui" }];
  return option.choices.map((c) => ({ value: c.value, label: c.label }));
}

function WeightKeyInput({ option, value, used, onChange }) {
  const listId = useId();
  if (option.kind === "toggle" || option.kind === "choice") {
    const items = [...choiceItems(option), { value: "random", label: "Aléatoire" }];
    const known = items.some((i) => i.value === value);
    return html`<select value=${value} onChange=${(e) => onChange(e.target.value)}>
      ${items.map((i) => html`<option value=${i.value} disabled=${i.value !== value && used.has(i.value)}>${i.label}</option>`)}
      ${!known && html`<option value=${value}>${value}</option>`}
    </select>`;
  }
  const hints = option.kind === "text_choice"
    ? option.choices.map((c) => c.value)
    : [...Object.keys(option.special || {}), ...RANDOM_WORDS];
  return html`<span>
    <input type="text" list=${listId} value=${value} onChange=${(e) => e.target.value.trim() && onChange(e.target.value.trim())} />
    <datalist id=${listId}>${hints.map((h) => html`<option value=${h} />`)}</datalist>
  </span>`;
}

function WeightsEditor({ option, value, onChange, onClose }) {
  const entries = Object.entries(value);
  const total = entries.reduce((sum, [, w]) => sum + (Number(w) > 0 ? Number(w) : 0), 0);
  const used = new Set(entries.map(([k]) => k));
  const addRow = () => {
    const candidates = option.kind === "toggle" || option.kind === "choice"
      ? [...choiceItems(option).map((i) => i.value), "random"]
      : option.kind === "text_choice" ? option.choices.map((c) => c.value) : [String(option.min ?? 0), "random"];
    const next = candidates.find((c) => !used.has(c));
    if (next !== undefined) onChange({ ...value, [next]: 0 });
  };
  return html`<div class="weights">
    <p class="hint">Archipelago tire une valeur au sort selon les poids. Une valeur à 0 n'est jamais tirée.</p>
    <table>
      <thead><tr><th>Valeur</th><th>Poids</th><th>Chance</th><th></th></tr></thead>
      <tbody>${entries.map(([key, weight]) => html`<tr class=${Number(weight) > 0 ? "" : "zero"}>
        <td><${WeightKeyInput} option=${option} value=${key} used=${used}
          onChange=${(k) => k !== key && !used.has(k) && onChange(renameKey(value, key, k))} /></td>
        <td><input type="number" class="num" min="0" value=${weight}
          onChange=${(e) => onChange({ ...value, [key]: Math.max(0, Math.round(Number(e.target.value)) || 0) })} /></td>
        <td class="pct">${total > 0 && Number(weight) > 0 ? `${Math.round((Number(weight) / total) * 100)} %` : "—"}</td>
        <td><button type="button" class="icon" title="Retirer cette valeur" disabled=${entries.length <= 1}
          onClick=${() => { const copy = { ...value }; delete copy[key]; onChange(copy); }}>✕</button></td>
      </tr>`)}</tbody>
    </table>
    <div class="row">
      <button type="button" class="small ghost" onClick=${addRow}>+ Ajouter une valeur</button>
      ${onClose && html`<button type="button" class="small ghost" onClick=${onClose}>Fermer les poids</button>`}
    </div>
  </div>`;
}

// --- Listes et dictionnaires ---------------------------------------------------------

function SetEditor({ option, value, game, onChange }) {
  const universe = useMemo(() => keyUniverse(option, game), [option, game]);
  const known = useMemo(() => new Set(universe), [universe]);
  const list = value.map(String);
  const selected = new Set(list);
  const isSet = option.kind === "set";

  if (isSet && universe.length > 0 && universe.length <= 40) {
    const extra = list.filter((v) => !known.has(v));
    return html`<div class="checks">
      ${[...universe, ...extra].map((key) => html`<label class=${known.has(key) ? "" : "unknown"}>
        <input type="checkbox" checked=${selected.has(key)}
          onChange=${(e) => onChange(e.target.checked ? [...list, key] : list.filter((v) => v !== key))} />
        ${key}
      </label>`)}
    </div>`;
  }
  return html`<div class="set-editor">
    ${list.length > 0 && html`<div class="chips">
      ${list.map((v, i) => html`<span class=${`chip ${known.size && !known.has(v) ? "unknown" : ""}`}>
        ${v}<button type="button" title="Retirer" onClick=${() => onChange(list.filter((_, j) => j !== i))}>✕</button>
      </span>`)}
    </div>`}
    <${Suggest} items=${universe} exclude=${isSet ? selected : null}
      placeholder=${universe.length ? "Ajouter… (tapez pour chercher)" : "Ajouter une valeur puis Entrée"}
      onPick=${(v) => (!isSet || !selected.has(v)) && onChange([...list, v])} />
  </div>`;
}

function DictEditor({ option, value, game, onChange }) {
  const universe = useMemo(() => keyUniverse(option, game), [option, game]);
  const known = useMemo(() => new Set(universe), [universe]);
  const numeric = option.kind === "counter";
  const entries = Object.entries(value);
  const used = new Set(entries.map(([k]) => k));
  const setEntry = (key, v) => onChange({ ...value, [key]: v });
  return html`<div class="dict-editor">
    ${entries.length > 0 && html`<table><tbody>
      ${entries.map(([key, v]) => html`<tr>
        <td class=${known.size && !known.has(key) ? "unknown" : ""}>${key}</td>
        <td>${numeric
          ? html`<input type="number" class="num" min=${option.min ?? undefined} max=${option.max ?? undefined} value=${v}
              onChange=${(e) => setEntry(key, clamp(Math.round(Number(e.target.value)) || 0, option.min, option.max))} />`
          : html`<input type="text" value=${v ?? ""} onChange=${(e) => setEntry(key, e.target.value)} />`}</td>
        <td><button type="button" class="icon" title="Retirer"
          onClick=${() => { const copy = { ...value }; delete copy[key]; onChange(copy); }}>✕</button></td>
      </tr>`)}
    </tbody></table>`}
    <${Suggest} items=${universe} exclude=${used}
      placeholder=${universe.length ? "Ajouter… (tapez pour chercher)" : "Nouvelle clé puis Entrée"}
      onPick=${(k) => !used.has(k) && setEntry(k, numeric ? Math.max(1, option.min ?? 1) : "")} />
  </div>`;
}

// --- Ligne d'option ------------------------------------------------------------------

const scalarOnly = (v) => v === null || typeof v !== "object";

// Valeur qui remet l'option à son défaut en gardant la forme du fichier.
function resetValue(option, value) {
  if (option.weighted && isPlainObject(value)) return writeSingle(option, value, option.default);
  return defaultValue(option);
}

export function summarize(option, value) {
  if (option.weighted && isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, w]) => Number(w) > 0);
    const total = entries.reduce((s, [, w]) => s + Number(w), 0);
    return entries.map(([k, w]) => `${describeScalar(option, valueForKey(option, k))} ${Math.round((Number(w) / total) * 100)} %`).join(" · ");
  }
  if (option.weighted) return describeScalar(option, value);
  if (Array.isArray(value)) return value.length ? value.join(", ") : "vide";
  if (isPlainObject(value)) return Object.keys(value).length ? `${Object.keys(value).length} entrée(s)` : "vide";
  return String(value);
}

export function OptionRow({ option, value, original, game, advanced, onChange }) {
  const [showWeights, setShowWeights] = useState(false);
  const present = value !== undefined;
  const shown = present ? value : defaultValue(option);
  const obsolete = option.kind === "unknown" || option.kind === "removed";
  const problems = present && !obsolete ? checkValue(option, value, game) : [];
  const changed = present && !obsolete && !sameAsDefault(option, value);
  const fr = COMMON_TEXT[option.key];
  const reset = () => onChange(original !== undefined ? resetValue(option, value) : undefined);

  let control = null;
  let wide = false;
  const locked = (text) => html`<div class="locked">
    <span>${text}</span>
    ${!advanced && html`<span class="hint">Réglage avancé : activez le mode avancé pour le modifier.</span>`}
  </div>`;

  if (obsolete) {
    wide = true;
    control = advanced
      ? html`<${RawEditor} value=${shown} onChange=${onChange} />`
      : html`<div class="locked"><span>${option.kind === "removed"
          ? "Cette option n'existe plus dans la version actuelle du jeu."
          : "Cette option n'existe pas pour ce jeu (faute de frappe ou option renommée)."}</span>
          <button type="button" class="small ghost" onClick=${() => onChange(undefined)}>Retirer du fichier</button></div>`;
  } else if (option.weighted && (isPlainObject(shown) || Array.isArray(shown))) {
    const single = Array.isArray(shown) ? { single: false } : singleValue(option, shown);
    if (Array.isArray(shown)) {
      wide = true;
      control = advanced ? html`<${RawEditor} value=${shown} onChange=${onChange} />` : locked(String(shown));
    } else if (!single.single || (advanced && showWeights)) {
      wide = true;
      control = advanced
        ? html`<${WeightsEditor} option=${option} value=${shown} onChange=${onChange}
            onClose=${single.single ? () => setShowWeights(false) : null} />`
        : html`<div class="locked">
            <span><strong>Tirage au sort :</strong> ${summarize(option, shown)}</span>
            <button type="button" class="small ghost" title="Garde la valeur qui a le plus de chances"
              onClick=${() => {
                const [best] = Object.entries(shown).reduce((a, b) => (Number(b[1]) > Number(a[1]) ? b : a));
                onChange(writeSingle(option, shown, valueForKey(option, best)));
              }}>Choisir une seule valeur</button>
          </div>`;
    } else {
      control = html`<${ScalarControl} option=${option} value=${single.value ?? option.default} advanced=${advanced}
        onChange=${(v) => onChange(writeSingle(option, shown, v))} />`;
    }
  } else if (option.weighted) {
    control = html`<${ScalarControl} option=${option} value=${shown} advanced=${advanced} onChange=${onChange} />`;
  } else if ((option.kind === "set" || option.kind === "list") && Array.isArray(shown) && shown.every(scalarOnly)) {
    wide = true;
    control = html`<${SetEditor} option=${option} value=${shown} game=${game} onChange=${onChange} />`;
  } else if ((option.kind === "counter" && isPlainObject(shown) && Object.values(shown).every(Number.isInteger))
      || (option.kind === "dict" && isPlainObject(shown) && Object.values(shown).every(scalarOnly))) {
    wide = true;
    control = html`<${DictEditor} option=${option} value=${shown} game=${game} onChange=${onChange} />`;
  } else {
    wide = true;
    control = advanced ? html`<${RawEditor} value=${shown} onChange=${onChange} />` : locked(summarize(option, shown));
  }

  const canWeight = advanced && option.weighted && !obsolete && !showWeights && !Array.isArray(shown)
    && singleValue(option, shown).single && ["toggle", "choice", "text_choice", "range", "named_range"].includes(option.kind);

  return html`<div class=${`opt ${wide ? "wide" : ""} ${changed ? "changed" : ""} ${problems.length || obsolete ? "has-problem" : ""}`}>
    <div class="opt-info">
      <div class="opt-name">
        ${fr ? fr[0] : option.name}
        ${advanced && html`<code>${option.key}</code>`}
      </div>
      <${Description} option=${option} />
    </div>
    <div class="opt-control">${control}</div>
    ${(changed || canWeight) && html`<div class="opt-meta">
      ${changed && html`<span>Modifié · par défaut : ${describeDefault(option)}</span>
        <button type="button" class="link" onClick=${reset}>Rétablir</button>`}
      ${canWeight && html`<button type="button" class="link" onClick=${() => {
        setShowWeights(true);
        if (!isPlainObject(shown)) onChange({ [keyForValue(option, shown)]: 50 });
      }}>Pondérer plusieurs valeurs</button>`}
    </div>`}
    ${problems.length > 0 && html`<ul class="problems">${problems.map((p) => html`<li>${p}</li>`)}</ul>`}
  </div>`;
}
