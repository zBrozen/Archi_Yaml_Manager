// Packs PopTracker dans le navigateur : lecture du pack, objets, lieux et règles d'accès, scripts Lua
// (wasmoon). Le format suit la documentation des packs de PopTracker (doc/PACKS.md, doc/AUTOTRACKING.md) ;
// aucun code de PopTracker n'est repris. L'affichage est dans tracker-view.js, la connexion à la partie
// dans tracker-ap.js.
import "../vendor/wasmoon.js";
import { readZip, bytesToText } from "./unzip.js";
import { PRELUDE, toLua } from "./tracker-lua.js";

export const Access = { NONE: 0, PARTIAL: 1, INSPECT: 3, SEQUENCE_BREAK: 5, NORMAL: 6, CLEARED: 7 };
const SEP = "\x1f";
const LOG_LINES = 300;

// --- JSON des packs : commentaires et virgules finales tolérés ---------------------------

function scan(text, onChar) {
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      const skip = onChar(text, i, out);
      if (typeof skip === "number") i = skip;
      else { out += c; i++; }
    }
  }
  return out;
}

export function parseJsonc(text) {
  const noComments = scan(text.replace(/^﻿/, ""), (t, i) => {
    if (t[i] === "/" && t[i + 1] === "/") { const end = t.indexOf("\n", i); return end < 0 ? t.length : end; }
    if (t[i] === "/" && t[i + 1] === "*") { const end = t.indexOf("*/", i + 2); return end < 0 ? t.length : end + 2; }
    return null;
  });
  const clean = scan(noComments, (t, i) => (t[i] === "," && /^\s*[\]}]/.test(t.slice(i + 1, i + 200)) ? i + 1 : null));
  return JSON.parse(clean);
}

const codesOf = (value) => (typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);
const int = (value, fallback) => {
  const n = typeof value === "number" ? Math.trunc(value) : parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
};
const cleanPath = (path) => String(path ?? "").replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "");

// "chemin.png:mod1,mod2" (format des icônes de PopTracker) → { path, mods }.
export function splitIcon(value) {
  const text = String(value ?? "");
  const colon = text.lastIndexOf(":");
  if (colon <= 0 || /[\\/]/.test(text.slice(colon))) return { path: text, mods: [] };
  return { path: text.slice(0, colon), mods: codesOf(text.slice(colon + 1)) };
}

// --- Pack ---------------------------------------------------------------------------------

const IMAGE_TYPES = { png: "image/png", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };

export class Pack {
  constructor(files, texts, manifest) {
    this.files = files;
    this.texts = texts;
    this.manifest = manifest;
    this.lower = new Map([...files.keys()].map((name) => [name.toLowerCase(), name]));
    this.images = new Map();
    this.onImage = null;
  }

  get uid() { return this.manifest.package_uid || this.manifest.name || "pack"; }
  get name() { return this.manifest.name || this.manifest.package_uid || "Pack PopTracker"; }
  get game() { return this.manifest.game_name || ""; }
  get variants() {
    const variants = this.manifest.variants && typeof this.manifest.variants === "object" ? this.manifest.variants : {};
    return Object.keys(variants).length ? variants : { standard: { display_name: "Standard", flags: [] } };
  }

  // Les fichiers d'une variante (dossier du même nom) passent avant ceux du pack.
  resolve(path, variant) {
    const clean = cleanPath(path);
    for (const candidate of [variant && `${variant}/${clean}`, clean]) {
      if (!candidate) continue;
      if (this.files.has(candidate)) return candidate;
      const found = this.lower.get(candidate.toLowerCase());
      if (found) return found;
    }
    return null;
  }

  text(path, variant) {
    const name = this.resolve(path, variant);
    return name === null ? undefined : this.texts.get(name);
  }

  // Image du pack : { url, width, height } une fois chargée, null en attendant (onImage prévient).
  image(path, variant) {
    const name = this.resolve(path, variant);
    if (name === null) return null;
    let entry = this.images.get(name);
    if (!entry) {
      entry = { ready: null };
      this.images.set(name, entry);
      const type = IMAGE_TYPES[name.split(".").pop().toLowerCase()] || "application/octet-stream";
      this.files.get(name).bytes().then((bytes) => new Promise((resolve) => {
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        const img = new Image();
        img.onload = () => resolve({ url, width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => resolve({ url, width: 0, height: 0 });
        img.src = url;
      })).then((ready) => {
        entry.ready = ready;
        this.onImage?.();
      }).catch(() => {});
    }
    return entry.ready;
  }

  dispose() {
    for (const entry of this.images.values()) if (entry.ready) URL.revokeObjectURL(entry.ready.url);
    this.images.clear();
  }
}

export async function openPack(buffer) {
  const zip = readZip(buffer);
  // Racine : dossier du manifest.json le moins profond (souvent un dossier unique dans l'archive).
  let root = null;
  for (const name of zip.keys()) {
    const m = name.match(/^(.*?)manifest\.json$/i);
    if (m && (m[1] === "" || m[1].endsWith("/")) && !m[1].startsWith("__MACOSX") && (root === null || m[1].length < root.length)) root = m[1];
  }
  if (root === null) throw new Error("Pas de manifest.json : ce n'est pas un pack PopTracker.");
  const files = new Map();
  for (const [name, entry] of zip) if (name.startsWith(root)) files.set(name.slice(root.length), entry);
  // Scripts et JSON lus d'avance : Lua les demande sans pouvoir attendre.
  const texts = new Map();
  await Promise.all([...files].filter(([name]) => /\.(lua|jsonc?|txt)$/i.test(name))
    .map(async ([name, entry]) => texts.set(name, bytesToText(await entry.bytes()))));
  const manifestName = [...files.keys()].find((name) => name.toLowerCase() === "manifest.json");
  let manifest;
  try {
    manifest = parseJsonc(texts.get(manifestName));
  } catch (e) {
    throw new Error(`manifest.json illisible : ${e.message}`);
  }
  return new Pack(files, texts, manifest);
}

// --- Objets (items.json) --------------------------------------------------------------------

function stageOf(j) {
  const imgMods = codesOf(j.img_mods);
  return {
    name: j.name,
    img: j.img || "",
    disabledImg: j.disabled_img ?? j.img ?? "",
    codes: codesOf(j.codes),
    inherit: bool(j.inherit_codes, true),
    imgMods,
    disabledImgMods: codesOf(j.disabled_img_mods ?? (imgMods.length ? `${j.img_mods},@disabled` : "@disabled")),
  };
}

class JsonItem {
  constructor(tracker, index, j) {
    this.tracker = tracker;
    this.index = index;
    this.name = String(j.name ?? "");
    this.type = String(j.type ?? "").toLowerCase();
    this.codes = codesOf(j.codes);
    this.loop = bool(j.loop, false);
    this.allowDisabled = bool(j.allow_disabled, true);
    this.img = j.img || "";
    this.disabledImg = j.disabled_img ?? this.img;
    this.imgMods = codesOf(j.img_mods);
    this.disabledImgMods = codesOf(j.disabled_img_mods ?? (this.imgMods.length ? `${j.img_mods},@disabled` : "@disabled"));
    this.minCount = int(j.min_quantity, 0);
    this.maxCount = int(j.max_quantity, Math.min(-1, this.minCount - 1));
    this.increment = int(j.increment, 1);
    this.decrement = int(j.decrement, this.increment);
    this.overlayBackground = j.overlay_background || "";
    this.badgeText = "";
    this.badgeColor = "";
    this.iconOverride = null;
    this.ignoreInput = false;
    this.stage1 = 0;
    this.stages = Array.isArray(j.stages) ? j.stages.map(stageOf) : [];

    if (this.type === "toggle" || this.type === "toggle_badged") this.allowDisabled = true;
    else if (this.type === "progressive_toggle") { this.loop = true; this.allowDisabled = true; }
    else if (this.type === "static") { this.allowDisabled = false; this.stage1 = 1; }

    if (this.type === "composite_toggle" && Array.isArray(j.images)) {
      // Quatre états (gauche, droite) liés à deux autres objets.
      this.left = j.item_left || "";
      this.right = j.item_right || "";
      this.stages = [];
      for (let n = 0; n < 4; n++) {
        const image = j.images.find((v) => bool(v.left, false) === !!(n & 1) && bool(v.right, false) === !!(n & 2));
        if (image) this.stages.push(stageOf({ ...image, codes: n === 3 ? `${this.left},${this.right}` : n === 2 ? this.right : this.left, inherit_codes: false }));
      }
      this.stage1 = 1;
    }
    if (this.type === "toggle_badged") this.baseItem = j.base_item || "";
    if (["toggle", "toggle_badged", "progressive_toggle"].includes(this.type) && bool(j.initial_active_state, false)) this.stage1 = 1;
    this.stage2 = Math.max(0, Math.min(int(j.initial_stage_idx, 0), this.stages.length - 1));
    this.count = Math.max(this.minCount, int(j.initial_quantity, 0));
    if (this.maxCount >= this.minCount && this.count > this.maxCount) this.count = this.maxCount;
    if (this.type === "consumable" && this.count > 0) this.stage1 = 1;
  }

  canProvide(code) {
    if (this.codes.includes(code)) return true;
    if (this.type === "composite_toggle") return false;
    return this.stages.some((stage) => stage.codes.includes(code));
  }

  allCodes() {
    return [...new Set([...this.codes, ...this.stages.flatMap((stage) => stage.codes)])];
  }

  provides(code) {
    if (this.type === "composite_toggle") {
      return this.codes.includes(code) ? (this.stage2 & 1 ? 1 : 0) + (this.stage2 & 2 ? 1 : 0) : 0;
    }
    if (this.stages.length > this.stage2) {
      if (this.allowDisabled && !this.stage1) return 0;
      for (let i = this.stage2; i >= 0; i--) {
        if (this.stages[i].codes.includes(code)) return 1;
        if (!this.stages[i].inherit) break;
      }
      return 0;
    }
    if (!this.canProvide(code)) return 0;
    if (this.count) return this.count;
    return this.stage1 ? 1 : 0;
  }

  // Clic : 0 = gauche (suivant), 1 = milieu, 2 = droit (précédent). Renvoie true si l'état a changé.
  click(button) {
    if (this.ignoreInput) return false;
    const before = [this.stage1, this.stage2, this.count].join();
    const primary = button === 0;
    const secondary = button === 2;
    const stages = this.stages.length;
    if (this.type === "toggle") {
      // Clic gauche : bascule (un seul bouton suffit au doigt) ; clic droit : retire.
      this.stage1 = secondary ? 0 : this.stage1 ? 0 : 1;
    } else if (this.type === "progressive" && !this.allowDisabled) {
      let n = this.stage2 + (secondary ? -1 : 1);
      if (n >= stages) n = this.loop || !secondary && !primary ? 0 : stages - 1;
      if (n < 0) n = this.loop ? stages - 1 : 0;
      this.stage2 = n;
    } else if (this.type === "progressive") {
      let a = this.stage1;
      let n = this.stage2;
      if (secondary) {
        if (a && n === 0) a = 0;
        else if (n > 0) n--;
        else if (this.loop && stages) { n = stages - 1; a = 1; }
      } else if (!a) a = 1;
      else if (n + 1 < stages) n++;
      else if (this.loop || !primary) { n = 0; a = 0; }
      this.stage1 = a;
      this.stage2 = n;
    } else if (this.type === "progressive_toggle") {
      if (primary) this.stage1 = this.stage1 ? 0 : 1;
      else if (secondary) this.stage2 = (this.stage2 + 1) % Math.max(1, stages);
    } else if (this.type === "consumable") {
      let n = this.count + (secondary ? -this.decrement : this.increment);
      if (this.maxCount >= this.minCount && n > this.maxCount) n = this.maxCount;
      if (n < this.minCount) n = this.minCount;
      this.count = n;
      this.stage1 = n > 0 ? 1 : 0;
    } else if (this.type === "composite_toggle") {
      const linked = this.tracker.itemForCode(secondary ? this.right : this.left);
      if (linked) return linked.click(1);
      return false;
    } else if (this.type === "toggle_badged") {
      if (secondary) this.stage1 = this.stage1 ? 0 : 1;
      else {
        const base = this.tracker.itemForCode(this.baseItem);
        return base ? base.click(button) : false;
      }
    } else {
      return false;
    }
    const changed = before !== [this.stage1, this.stage2, this.count].join();
    if (changed) {
      this.iconOverride = null;
      this.tracker.itemChanged(this);
    }
    return changed;
  }

  image() {
    if (this.iconOverride !== null) return splitIcon(this.iconOverride);
    const on = !this.allowDisabled || !!this.stage1;
    const stage = this.stages[this.stage2];
    if (stage) return { path: on ? stage.img : stage.disabledImg, mods: on ? stage.imgMods : stage.disabledImgMods };
    return { path: on ? this.img : this.disabledImg, mods: on ? this.imgMods : this.disabledImgMods };
  }

  // Affichage : nom (de l'étape si elle en a un), image, texte en surimpression, état.
  view() {
    const stage = this.stages[this.stage2];
    const on = !this.allowDisabled || !!this.stage1;
    const { path, mods } = this.image();
    let badge = this.badgeText;
    if (!badge && this.type === "consumable" && (this.count > 0 || this.maxCount > 0)) badge = String(this.count);
    const view = {
      name: (on && stage?.name) || this.name,
      path, mods, badge, badgeColor: this.badgeColor,
      active: on,
      // Objet à étapes toujours actif : son nom d'étape dit son état (« Heat Man Locked »).
      staged: !this.allowDisabled && this.stages.length > 1,
    };
    if (this.type === "toggle_badged") {
      const base = this.tracker.itemForCode(this.baseItem);
      if (base) return { ...base.view(), name: this.name, overlay: this.stage1 ? this.img : null };
    }
    return view;
  }

  get(key) {
    switch (key) {
      case "AcquiredCount": return this.count;
      case "Active": return this.allowDisabled ? !!this.stage1 : true;
      case "CurrentStage": return this.type === "progressive" && this.allowDisabled ? (this.stage1 ? this.stage2 + 1 : 0) : this.stage2;
      case "MinCount": return this.minCount;
      case "MaxCount": return this.maxCount;
      case "Increment": return this.increment;
      case "Decrement": return this.decrement;
      case "Type": return this.type;
      case "Name": return this.name;
      case "Icon": {
        if (this.iconOverride !== null) return this.iconOverride;
        const { path, mods } = this.image();
        return mods.length ? `${path}:${mods.join(",")}` : path;
      }
      case "IgnoreUserInput": return this.ignoreInput;
      case "BadgeText": return this.badgeText;
      case "BadgeTextColor": return this.badgeColor;
      default: return undefined;
    }
  }

  // Écriture depuis Lua ; renvoie true si l'état (et donc la logique) a changé.
  set(key, value) {
    const number = (v) => Math.trunc(Number(v) || 0);
    const before = [this.stage1, this.stage2, this.count].join();
    switch (key) {
      case "AcquiredCount": {
        let n = number(value);
        if (this.maxCount >= this.minCount && n > this.maxCount) n = this.maxCount;
        if (n < this.minCount) n = this.minCount;
        this.count = n;
        if (this.type === "consumable") this.stage1 = n > 0 ? 1 : 0;
        break;
      }
      case "Active": {
        let on = typeof value === "number" ? value > 0 : !!value;
        if (this.type === "progressive" && this.allowDisabled && !on) this.stage2 = 0;
        else if (!this.allowDisabled) on = true;
        this.stage1 = on ? 1 : 0;
        break;
      }
      case "CurrentStage": {
        let n = Math.max(0, number(value));
        let on = this.stage1;
        if (this.type === "progressive" && this.allowDisabled) {
          if (n === 0) on = 0;
          else { on = 1; n--; }
        }
        if (this.stages.length && n >= this.stages.length) n = this.stages.length - 1;
        this.stage1 = on;
        this.stage2 = n;
        break;
      }
      case "MinCount": this.minCount = number(value); if (this.count < this.minCount) this.count = this.minCount; break;
      case "MaxCount": this.maxCount = number(value); if (this.maxCount >= this.minCount && this.count > this.maxCount) this.count = this.maxCount; break;
      case "Increment": this.increment = number(value); return false;
      case "Decrement": this.decrement = number(value); return false;
      case "Icon": this.iconOverride = value ? String(value) : null; this.tracker.touch(); return false;
      case "IgnoreUserInput": this.ignoreInput = !!value; return false;
      case "BadgeText": this.badgeText = value == null ? "" : String(value); this.tracker.touch(); return false;
      case "BadgeTextColor": this.badgeColor = value == null ? "" : String(value); this.tracker.touch(); return false;
      default: return false;
    }
    const changed = before !== [this.stage1, this.stage2, this.count].join();
    if (changed) this.iconOverride = null;
    return changed;
  }
}

// --- Lieux (locations.json) -------------------------------------------------------------------

function ruleEntry(value) {
  if (typeof value === "string") return value.split(",").map((s) => s.trim());
  if (Array.isArray(value)) return value.map((s) => String(s).trim());
  return null;
}

// Règles d'un lieu ajoutées à celles de son parent : (parent ET règle) pour chaque alternative.
function mergeRules(parent, value) {
  let added;
  if (Array.isArray(value) && value.length) added = value.map(ruleEntry).filter(Boolean);
  else if (typeof value === "string" && value) added = [[value.trim()]];
  else return parent;
  if (!parent.length) return added;
  const out = [];
  for (const rule of added) for (const old of parent) out.push([...old, ...rule]);
  return out;
}

class Section {
  constructor(location, j, defaults) {
    this.location = location;
    this.name = String(j.name ?? "");
    this.id = `${location.id}/${this.name}`;
    this.ref = typeof j.ref === "string" ? j.ref.replace(/^@/, "") : "";
    this.hosted = codesOf(j.hosted_item);
    this.itemCount = int(j.item_count, this.hosted.length || this.ref ? 0 : 1);
    this.cleared = 0;
    this.clearAsGroup = bool(j.clear_as_group, true);
    this.unopenedImg = j.chest_unopened_img ?? defaults.unopened;
    this.openedImg = j.chest_opened_img ?? defaults.opened;
    this.accessRules = mergeRules(location.accessRules, j.access_rules);
    this.visibilityRules = mergeRules(location.visibilityRules, j.visibility_rules);
    this.glitchedAsGlitched = bool(j.inspectable_sequence_break, location.glitchedAsGlitched);
    this.highlight = 0;
  }
}

// --- Tracker --------------------------------------------------------------------------------

export class Tracker {
  static async create(pack, variant) {
    const tracker = new Tracker(pack, variant);
    await tracker.init();
    return tracker;
  }

  constructor(pack, variant) {
    this.pack = pack;
    this.variant = variant;
    this.items = [];
    this.composites = [];
    this.luaItems = [];
    this.locations = [];
    this.locationById = new Map();
    this.sections = new Map();
    this.maps = new Map();
    this.layouts = new Map();
    this.classes = new Map();
    this.tabs = new WeakMap();
    this.listeners = new Set();
    this.version = 0;
    this.logLines = [];
    this.errors = [];
    this.bulk = false;
    this.watching = false;
    this.ap = null;
    this.cache = { json: new Map(), total: new Map(), access: null, visible: null };
    this.uncacheable = new Set();
    this.ruleStack = [];
    this.sectionDepth = 0;
    this.objectCache = new Map();
    this.emitQueued = false;
    pack.onImage = () => this.emit();
  }

  async init() {
    const factory = new globalThis.wasmoon.LuaFactory(new URL("../vendor/wasmoon.wasm", import.meta.url).href);
    // Sans proxy ni injection d'objets : Lua ne reçoit jamais d'objet JavaScript.
    this.lua = await factory.createEngine({ enableProxy: false, injectObjects: false, functionTimeout: 20000 });
    this.lua.global.set("__js", (op, a, b, c, d) => this.bridge(op, a, b, c, d) ?? undefined);
    await this.lua.doString(PRELUDE);
    const fn = (name) => this.lua.global.get(name);
    this.luaFn = {
      find: fn("__pt_lua_find"), provides: fn("__pt_lua_provides"), view: fn("__pt_lua_item_view"),
      click: fn("__pt_lua_item_click"), changed: fn("__pt_item_changed"), rule: fn("__pt_rule"),
      section: fn("__pt_section_changed"), apState: fn("__pt_ap_state"), apChecked: fn("__pt_ap_checked"),
      ap: fn("__pt_ap"), run: fn("__pt_run"),
    };
    if (this.pack.text("scripts/init.lua", this.variant) === undefined) throw new Error("Pas de scripts/init.lua dans ce pack.");
    this.callLua("run", "scripts/init.lua");
    if (!this.rootLayout()) {
      throw new Error(this.errors[0] ? `Le pack n'a pas pu se charger : ${this.errors[0]}` : "Ce pack ne définit aucune disposition (layout).");
    }
    // Images des objets et des cartes chargées d'avance : une icône ne clignote pas en changeant d'état.
    for (const item of this.items) {
      for (const path of [item.img, item.disabledImg, ...item.stages.flatMap((s) => [s.img, s.disabledImg])]) if (path) this.pack.image(path, this.variant);
    }
    for (const map of this.maps.values()) if (map.img) this.pack.image(map.img, this.variant);
    this.touch();
  }

  dispose() {
    this.listeners.clear();
    this.pack.onImage = null;
    try { this.lua?.global.close(); } catch { /* déjà fermé */ }
  }

  // --- Abonnement de l'affichage ---

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    if (this.emitQueued) return;
    this.emitQueued = true;
    requestAnimationFrame(() => {
      this.emitQueued = false;
      // Un numéro à chaque fois : une image chargée doit aussi redessiner, sans changer la logique.
      this.renders = (this.renders || 0) + 1;
      for (const listener of this.listeners) listener(this.renders);
    });
  }

  // Tout changement d'état : la logique est recalculée à la prochaine lecture.
  touch() {
    this.version++;
    this.cache = { json: new Map(), total: new Map(), access: null, visible: null };
    this.emit();
  }

  log(line) {
    this.logLines.push(line);
    if (this.logLines.length > LOG_LINES) this.logLines.splice(0, this.logLines.length - LOG_LINES);
  }

  error(message) {
    const text = String(message);
    this.log(`[erreur] ${text}`);
    if (this.errors.length < 20 && !this.errors.includes(text)) this.errors.push(text);
    console.warn("Pack PopTracker :", text);
  }

  callLua(name, ...args) {
    try {
      return this.luaFn[name](...args);
    } catch (e) {
      this.error(e?.message || e);
      return undefined;
    }
  }

  // --- Passerelle appelée par le Lua (valeurs simples uniquement) ---

  bridge(op, a, b, c, d) {
    switch (op) {
      case "print": this.log(String(a ?? "")); return undefined;
      case "error": this.error(a); return undefined;
      case "read": return this.pack.text(a, this.variant);
      case "exists": return this.pack.resolve(a, this.variant) !== null;
      case "AddItems": return this.addItems(a);
      case "AddMaps": return this.addMaps(a);
      case "AddLocations": return this.addLocations(a);
      case "AddLayouts": return this.addLayouts(a);
      case "AddClasses": return this.addClasses(a);
      case "count": return this.countJson(String(a));
      case "find": return this.findObject(String(a));
      case "get": return this.getProperty(a, String(b), String(c));
      case "set": this.setProperty(a, String(b), String(c), d); return undefined;
      case "tracker_get":
        if (a === "ActiveVariantUID") return this.variant;
        if (a === "BulkUpdate") return this.bulk;
        if (a === "AllowDeferredLogicUpdate") return false;
        return undefined;
      case "tracker_set":
        if (a === "BulkUpdate") { this.bulk = !!b; if (!this.bulk) this.touch(); }
        return undefined;
      case "uihint": this.uiHint(String(a), String(b)); return undefined;
      case "luaitem_created": this.luaItems.push(Number(a)); this.objectCache.clear(); this.touch(); return undefined;
      case "luaitem_changed": this.touch(); return undefined;
      case "watching": this.watching = true; return undefined;
      case "ap_state": return this.ap?.connected ? 3 : 1;
      case "ap_get": this.ap?.get(String(a ?? "").split(SEP).filter(Boolean)); return true;
      case "ap_notify": this.ap?.notify(String(a ?? "").split(SEP).filter(Boolean)); return true;
      case "ap_player": return this.ap?.player(Number(a), String(b));
      case "ap_name": return this.ap?.name(String(a), Number(b), String(c ?? ""));
      default: return undefined;
    }
  }

  readJson(path, what) {
    const text = this.pack.text(path, this.variant);
    if (text === undefined) {
      this.error(`${what} : fichier introuvable (${path})`);
      return null;
    }
    try {
      return parseJsonc(text);
    } catch (e) {
      this.error(`${what} : ${path} illisible (${e.message})`);
      return null;
    }
  }

  addItems(path) {
    const list = this.readJson(path, "Objets");
    if (!Array.isArray(list)) return false;
    for (const j of list) if (j && typeof j === "object") this.items.push(new JsonItem(this, this.items.length, j));
    this.composites = this.items.filter((item) => item.type === "composite_toggle");
    this.objectCache.clear();
    this.touch();
    return true;
  }

  addMaps(path) {
    const list = this.readJson(path, "Cartes");
    if (!Array.isArray(list)) return false;
    for (const j of list) {
      if (!j?.name) continue;
      this.maps.set(j.name, {
        name: j.name,
        img: j.img || "",
        size: int(j.location_size, 16),
        border: int(j.location_border_thickness, 1),
        shape: j.location_shape || "rect",
      });
    }
    return true;
  }

  addLocations(path) {
    const list = this.readJson(path, "Lieux");
    if (!Array.isArray(list)) return false;
    this.parseLocations(list, "", [], [], { unopened: null, opened: null }, false);
    this.objectCache.clear();
    this.touch();
    return true;
  }

  parseLocations(list, parentId, parentAccess, parentVisibility, images, glitched) {
    for (const j of list) {
      if (!j || typeof j !== "object") continue;
      let access = parentAccess;
      let visibility = parentVisibility;
      if (typeof j.parent === "string" && j.parent) {
        const parent = this.location(j.parent.replace(/^@/, ""), true);
        if (parent) { access = parent.accessRules; visibility = parent.visibilityRules; }
      }
      const name = String(j.name ?? "");
      const location = {
        id: parentId ? `${parentId}/${name}` : name,
        name,
        accessRules: mergeRules(access, j.access_rules),
        visibilityRules: mergeRules(visibility, j.visibility_rules),
        glitchedAsGlitched: bool(j.inspectable_sequence_break, glitched),
        overlayBackground: j.overlay_background || "",
        mapLocations: [],
        sections: [],
      };
      const defaults = { unopened: j.chest_unopened_img ?? images.unopened, opened: j.chest_opened_img ?? images.opened };
      for (const m of Array.isArray(j.map_locations) ? j.map_locations : []) {
        if (!m?.map) continue;
        location.mapLocations.push({
          map: m.map, x: Number(m.x) || 0, y: Number(m.y) || 0,
          size: m.size === undefined ? null : int(m.size, null),
          border: m.border_thickness === undefined ? null : int(m.border_thickness, null),
          shape: m.shape || null,
          visibilityRules: mergeRules([], m.restrict_visibility_rules),
          invisibilityRules: mergeRules([], m.force_invisibility_rules),
        });
      }
      for (const s of Array.isArray(j.sections) ? j.sections : []) {
        if (!s || typeof s !== "object") continue;
        const section = new Section(location, s, defaults);
        location.sections.push(section);
        if (!this.sections.has(section.id)) this.sections.set(section.id, section);
      }
      this.locations.push(location);
      if (!this.locationById.has(location.id)) this.locationById.set(location.id, location);
      if (Array.isArray(j.children)) {
        this.parseLocations(j.children, location.id, location.accessRules, location.visibilityRules, defaults, location.glitchedAsGlitched);
      }
    }
  }

  addLayouts(path) {
    const data = this.readJson(path, "Dispositions");
    if (!data || typeof data !== "object") return false;
    for (const [key, node] of Object.entries(data)) this.layouts.set(key, node);
    this.touch();
    return true;
  }

  addClasses(path) {
    const data = this.readJson(path, "Classes");
    if (!data || typeof data !== "object") return false;
    for (const [key, value] of Object.entries(data)) this.classes.set(key, value);
    return true;
  }

  rootLayout(kind = "tracker") {
    if (kind === "broadcast") return this.layouts.get("tracker_broadcast") || null;
    if (kind === "settings") return this.layouts.get("settings_popup") || null;
    return this.layouts.get("tracker_default") || this.layouts.get("tracker_horizontal") || this.layouts.get("tracker_vertical") || null;
  }

  // --- Recherche par code ---

  // Un lieu par identifiant complet, ou par la fin de son identifiant (comme PopTracker).
  location(id, partial = false) {
    const exact = this.locationById.get(id);
    if (exact || !partial) return exact || null;
    return this.locations.find((loc) => loc.id.endsWith(`/${id}`)) || null;
  }

  section(id) {
    const exact = this.sections.get(id);
    if (exact) return exact;
    const slash = id.lastIndexOf("/");
    if (slash < 0) return null;
    const location = this.location(id.slice(0, slash), true);
    return location?.sections.find((s) => s.name === id.slice(slash + 1)) || null;
  }

  realSection(section) {
    return section.ref ? this.section(section.ref) || section : section;
  }

  // Objet du pack pour un code : { kind: "item", item } ou { kind: "lua", id }.
  objectForCode(code) {
    if (this.objectCache.has(code)) return this.objectCache.get(code);
    let found = null;
    const item = this.items.find((i) => i.canProvide(code));
    if (item) found = { kind: "item", item };
    else if (this.luaItems.length) {
      const id = this.callLua("find", code);
      if (id) found = { kind: "lua", id: Number(id) };
    }
    this.objectCache.set(code, found);
    return found;
  }

  itemForCode(code) {
    const found = this.objectForCode(code);
    return found?.kind === "item" ? found.item : null;
  }

  findObject(code) {
    if (code.startsWith("@")) {
      this.markIndirect();
      const path = code.slice(1);
      const section = path.includes("/") ? this.section(path) : null;
      if (section) return `section:${section.id}`;
      const location = this.location(path, true);
      if (location) return `location:${location.id}`;
      return undefined;
    }
    const item = this.items.find((i) => i.canProvide(code));
    return item ? `item:${item.index}` : undefined;
  }

  getProperty(kind, id, key) {
    if (kind === "item") return this.items[Number(id)]?.get(key);
    if (kind === "section") {
      const section = this.section(id);
      if (!section) return undefined;
      const real = this.realSection(section);
      if (key === "AvailableChestCount") return real.itemCount - real.cleared;
      if (key === "ChestCount") return real.itemCount;
      if (key === "AccessibilityLevel") { this.markIndirect(); return this.sectionState(section) ?? Access.NONE; }
      if (key === "FullID") return real.id;
      if (key === "Name") return real.name;
      if (key === "Highlight") return real.highlight;
      return undefined;
    }
    if (kind === "location") {
      const location = this.location(id);
      if (!location) return undefined;
      if (key === "AccessibilityLevel") { this.markIndirect(); return this.locationAccess(location); }
      if (key === "Name") return location.name;
      return undefined;
    }
    return undefined;
  }

  setProperty(kind, id, key, value) {
    if (kind === "item") {
      const item = this.items[Number(id)];
      if (item?.set(key, value)) this.itemChanged(item);
      return;
    }
    if (kind === "section") {
      const section = this.section(id);
      if (!section) return;
      const real = this.realSection(section);
      if (key === "AvailableChestCount") {
        const cleared = Math.max(0, Math.min(real.itemCount, real.itemCount - Math.trunc(Number(value) || 0)));
        if (cleared !== real.cleared) { real.cleared = cleared; this.sectionChanged(real); }
      } else if (key === "Highlight") {
        real.highlight = Math.trunc(Number(value) || 0);
        this.touch();
      }
    }
  }

  itemChanged(item) {
    for (const other of this.composites) {
      const left = this.itemForCode(other.left);
      const right = this.itemForCode(other.right);
      other.stage2 = (left?.stage1 ? 1 : 0) | (right?.stage1 ? 2 : 0);
    }
    this.touch();
    if (this.watching) this.callLua("changed", item.allCodes().join(SEP));
  }

  sectionChanged(section) {
    this.touch();
    if (this.sectionDepth > 8) return;
    this.sectionDepth++;
    try { this.callLua("section", section.id); } finally { this.sectionDepth--; }
  }

  uiHint(name, value) {
    if (name !== "ActivateTab") return;
    const visit = (node, seen) => {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);
      if (node.type === "tabbed" && Array.isArray(node.tabs) && node.tabs.some((tab) => tab.title === value)) this.tabs.set(node, value);
      if (node.type === "layout" && node.key) visit(this.layouts.get(node.key), seen);
      for (const child of [].concat(node.content || [], (node.tabs || []).map((tab) => tab.content))) visit(child, seen);
    };
    const seen = new Set();
    for (const node of this.layouts.values()) visit(node, seen);
    this.emit();
  }

  // --- Actions de l'utilisateur ---

  clickItem(code, button) {
    const found = this.objectForCode(code);
    if (found?.kind === "item") found.item.click(button);
    else if (found?.kind === "lua") { this.callLua("click", found.id, button); this.touch(); }
  }

  // Coche (+1) ou décoche (-1) un lieu à la main ; les objets qu'il contient suivent.
  clickSection(section, delta) {
    const real = this.realSection(section);
    const before = real.cleared;
    if (delta > 0) real.cleared = real.clearAsGroup ? real.itemCount : Math.min(real.itemCount, real.cleared + 1);
    else real.cleared = real.clearAsGroup ? 0 : Math.max(0, real.cleared - 1);
    for (const code of real.hosted) {
      const item = this.itemForCode(code);
      const has = this.count(code) > 0;
      if (item && (delta > 0 ? !has : has)) item.click(delta > 0 ? 0 : 2);
    }
    if (real.cleared !== before || real.hosted.length) this.sectionChanged(real);
  }

  // Affichage d'un objet de la disposition (objet JSON ou objet Lua).
  itemView(code) {
    const found = this.objectForCode(code);
    if (!found) return null;
    if (found.kind === "item") return found.item.view();
    const raw = String(this.callLua("view", found.id) ?? "").split(SEP);
    const icon = splitIcon(raw[1]);
    const mods = [...icon.mods, ...codesOf(raw[2])];
    return { name: raw[0], path: icon.path, mods, badge: raw[3] || "", badgeColor: raw[4] || "", active: !mods.includes("@disabled") };
  }

  // --- Logique ---

  markIndirect() {
    for (const code of this.ruleStack) this.uncacheable.add(code);
  }

  countJson(code) {
    const cached = this.cache.json.get(code);
    if (cached !== undefined) return cached;
    let n = 0;
    if (code.startsWith("$")) {
      const [name, ...args] = code.slice(1).split("|");
      this.ruleStack.push(code);
      try { n = Number(this.callLua("rule", name, args.join(SEP))) || 0; } finally { this.ruleStack.pop(); }
    } else {
      for (const item of this.items) n += item.provides(code);
    }
    if (!this.uncacheable.has(code)) this.cache.json.set(code, n);
    return n;
  }

  count(code) {
    const cached = this.cache.total.get(code);
    if (cached !== undefined) return cached;
    let n = this.countJson(code);
    if (this.luaItems.length && !code.startsWith("$")) n += Number(this.callLua("provides", code)) || 0;
    if (!this.uncacheable.has(code)) this.cache.total.set(code, n);
    return n;
  }

  // Règles : liste d'alternatives (OU), chacune une liste de conditions (ET).
  // [x] : facultatif (hors logique), {x} : lieu visible mais pas ramassable, ^$f : niveau d'accès direct,
  // @lieu/section : accessibilité d'un autre lieu, code:n : au moins n exemplaires.
  resolveRules(rules, visibility, glitchedAsGlitched) {
    if (!rules.length) return Access.NORMAL;
    let glitchedReachable = false;
    let inspectReachable = false;
    for (const ruleset of rules) {
      if (!ruleset.length) return Access.NORMAL;
      let reachable = Access.NORMAL;
      let inspectOnly = false;
      for (const rule of ruleset) {
        if (!rule) continue;
        let s = rule;
        if (s[0] === "{") { inspectOnly = true; s = s.slice(1); }
        if (inspectOnly && s.endsWith("}")) s = s.slice(0, -1);
        let optional = false;
        if (s.length > 1 && s[0] === "[" && s.endsWith("]")) { optional = true; s = s.slice(1, -1); }
        if (inspectOnly && !s) continue;
        const level = s[0] === "^";
        const reference = s[0] === "@";
        let needed = 1;
        const colon = s.indexOf(":");
        if (!level && !reference && colon >= 0) { needed = parseInt(s.slice(colon + 1), 10) || 0; s = s.slice(0, colon); }
        if (level) {
          if (s[1] !== "$") { reachable = Access.NONE; break; }
          s = s.slice(1);
        }
        if (s[0] === "@") {
          const path = s.slice(1);
          let sub = null;
          const location = this.location(path, true);
          if (location) sub = visibility ? (this.locationVisible(location) ? Access.NORMAL : Access.NONE) : this.locationAccess(location);
          else {
            const section = this.section(path);
            if (section) sub = visibility ? (this.sectionVisible(section) ? Access.NORMAL : Access.NONE) : this.sectionAccess(section);
          }
          if (sub !== null) {
            if (!inspectOnly && sub === Access.INSPECT) sub = Access.NONE;
            else if (optional && sub === Access.NONE) sub = Access.SEQUENCE_BREAK;
            else if (sub === Access.NONE) reachable = Access.NONE;
            if (sub === Access.SEQUENCE_BREAK && reachable !== Access.NONE) reachable = Access.SEQUENCE_BREAK;
          }
          if (reachable === Access.NONE) break;
          continue;
        }
        const n = this.count(s);
        if (level) {
          let sub = n;
          if (!inspectOnly && sub === Access.INSPECT) inspectOnly = true;
          else if (optional && sub === Access.NONE) sub = Access.SEQUENCE_BREAK;
          else if (sub === Access.NONE) reachable = Access.NONE;
          if (sub === Access.SEQUENCE_BREAK && reachable !== Access.NONE) reachable = Access.SEQUENCE_BREAK;
          if (reachable === Access.NONE) break;
          continue;
        }
        if (n >= needed) continue;
        if (optional) reachable = Access.SEQUENCE_BREAK;
        else { reachable = Access.NONE; break; }
      }
      if (reachable === Access.NORMAL && !inspectOnly) return Access.NORMAL;
      if (reachable !== Access.NONE && inspectOnly) inspectReachable = true;
      if (reachable === Access.SEQUENCE_BREAK) glitchedReachable = true;
    }
    if (glitchedReachable && inspectReachable && !glitchedAsGlitched) return Access.INSPECT;
    if (glitchedReachable) return Access.SEQUENCE_BREAK;
    return inspectReachable ? Access.INSPECT : Access.NONE;
  }

  // Accessibilité de tous les lieux, recalculée jusqu'à stabilité (les règles @ dépendent les unes des autres).
  computeAccess() {
    if (this.cache.access) return this.cache.access;
    const access = new Map();
    this.cache.access = access;
    for (let pass = 0, done = false; !done && pass < 50; pass++) {
      done = true;
      for (const location of this.locations) {
        const update = (id, rules, glitched) => {
          const current = access.get(id);
          if (current === Access.NORMAL) return;
          const result = this.resolveRules(rules, false, glitched);
          if (current !== result) { access.set(id, result); done = false; }
        };
        update(location.id, location.accessRules, location.glitchedAsGlitched);
        for (const section of location.sections) update(section.id, section.accessRules, section.glitchedAsGlitched);
      }
    }
    return access;
  }

  computeVisibility() {
    if (this.cache.visible) return this.cache.visible;
    const visible = new Map();
    this.cache.visible = visible;
    for (let pass = 0, done = false; !done && pass < 50; pass++) {
      done = true;
      for (const location of this.locations) {
        const update = (id, rules) => {
          if (!rules.length || visible.get(id) === true) return;
          const result = this.resolveRules(rules, true, false) !== Access.NONE;
          if (visible.get(id) !== result) { visible.set(id, result); done = false; }
        };
        update(location.id, location.visibilityRules);
        for (const section of location.sections) update(section.id, section.visibilityRules);
      }
    }
    return visible;
  }

  locationAccess(location) { return this.computeAccess().get(location.id) ?? Access.NONE; }
  sectionAccess(section) { return this.computeAccess().get(this.realSection(section).id) ?? Access.NONE; }
  locationVisible(location) { return !location.visibilityRules.length || this.computeVisibility().get(location.id) === true; }
  sectionVisible(section) {
    const real = this.realSection(section);
    return !real.visibilityRules.length || this.computeVisibility().get(real.id) === true;
  }

  // État d'une section : null si cachée, CLEARED si faite (objets hébergés compris), sinon son accessibilité.
  sectionState(section) {
    if (!this.sectionVisible(section)) return null;
    const real = this.realSection(section);
    if (real.cleared >= real.itemCount && real.hosted.every((code) => this.count(code) > 0)) return Access.CLEARED;
    return this.sectionAccess(real);
  }

  mapLocationVisible(location, mapLocation) {
    if (!this.locationVisible(location)) return false;
    if (mapLocation.invisibilityRules.length && this.resolveRules(mapLocation.invisibilityRules, true, false) !== Access.NONE) return false;
    return this.resolveRules(mapLocation.visibilityRules, true, false) !== Access.NONE;
  }

  // État d'un repère de carte : l'ensemble des sections visibles du lieu ; null s'il n'y en a aucune.
  locationState(location) {
    const states = location.sections.map((s) => this.sectionState(s)).filter((s) => s !== null);
    if (!states.length) return null;
    const open = states.filter((s) => s !== Access.CLEARED);
    if (!open.length) return Access.CLEARED;
    if (open.every((s) => s === Access.NORMAL)) return Access.NORMAL;
    if (open.some((s) => s === Access.NORMAL)) return Access.PARTIAL;
    if (open.some((s) => s === Access.SEQUENCE_BREAK)) return Access.SEQUENCE_BREAK;
    if (open.some((s) => s === Access.INSPECT)) return Access.INSPECT;
    return Access.NONE;
  }

  // --- Archipelago (appelé par tracker-ap.js) ---

  // Les données JSON (slot_data, valeurs du stockage…) passent en texte Lua ; les autres arguments sont
  // des nombres ou des chaînes (jamais null : wasmoon ne sait pas le transmettre).
  apEvent(kind, ...args) {
    const data = { clear: [0], bounced: [0], retrieved: [1], setreply: [1, 2] }[kind] || [];
    const converted = args.map((arg, i) => (data.includes(i) ? toLua(arg) : arg ?? ""));
    this.callLua("ap", kind, ...converted);
    this.touch();
  }

  apState({ player, team, seed, checked, missing }) {
    this.callLua("apState", player, team, seed || "", toLua(checked || []), toLua(missing || []));
  }

  apChecked(id) {
    this.callLua("apChecked", id);
  }
}
