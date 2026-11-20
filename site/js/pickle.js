// Lecture des données d'une partie générée (fichier .archipelago : un octet de version, puis un pickle Python compressé
// par zlib). Seules les données sont lues : un objet Python (classe nommée par le pickle) devient un `PyObject` inerte,
// aucune fonction n'est jamais appelée, quoi que contienne le fichier.

export class PyObject {
  constructor(cls, args = []) {
    this.cls = cls; // « module.Nom »
    this.args = args;
    this.state = undefined;
    this.items = null; // SETITEMS sur un objet (OrderedDict…)
    this.list = null; // APPENDS sur un objet
  }
}

// Types simples reconstruits à partir de leur classe.
function construct(cls, args) {
  switch (cls) {
    case "builtins.set": return new Set(args[0] || []);
    case "builtins.frozenset": return new Set(args[0] || []);
    case "builtins.list": return [...(args[0] || [])];
    case "builtins.tuple": return [...(args[0] || [])];
    case "builtins.dict": case "collections.OrderedDict": case "collections.defaultdict":
      return new Map(args[0] instanceof Map ? args[0] : []);
    default: return new PyObject(cls, args);
  }
}

const decoder = new TextDecoder();
const MARK = Symbol("mark");

export function unpickle(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stack = [];
  const memo = new Map();
  let pos = 0;
  const need = (n) => { if (pos + n > bytes.length) throw new Error("Données de la partie tronquées."); };
  const u8 = () => { need(1); return bytes[pos++]; };
  const u16 = () => { need(2); const v = view.getUint16(pos, true); pos += 2; return v; };
  const u32 = () => { need(4); const v = view.getUint32(pos, true); pos += 4; return v; };
  const u64 = () => {
    need(8);
    const v = view.getBigUint64(pos, true);
    pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Données de la partie trop grandes.");
    return Number(v);
  };
  const raw = (n) => { need(n); const b = bytes.subarray(pos, pos + n); pos += n; return b; };
  const text = (n) => decoder.decode(raw(n));
  const line = () => {
    const end = bytes.indexOf(10, pos);
    if (end < 0) throw new Error("Données de la partie illisibles.");
    const s = decoder.decode(bytes.subarray(pos, end));
    pos = end + 1;
    return s;
  };
  const long = (n) => {
    if (!n) return 0;
    need(n);
    let v = 0n;
    for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[pos + i]);
    if (bytes[pos + n - 1] & 0x80) v -= 1n << BigInt(8 * n);
    pos += n;
    return Number.isSafeInteger(Number(v)) ? Number(v) : v;
  };
  const markAt = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i] === MARK) return i;
    throw new Error("Données de la partie illisibles (marque absente).");
  };
  const popMark = () => {
    const i = markAt();
    const items = stack.splice(i + 1);
    stack.pop();
    return items;
  };
  const top = () => stack[stack.length - 1];
  const setItems = (target, pairs) => {
    const map = target instanceof Map ? target : target instanceof PyObject ? (target.items ??= new Map()) : null;
    if (!map) throw new Error("Données de la partie illisibles (dictionnaire attendu).");
    for (let i = 0; i + 1 < pairs.length; i += 2) map.set(key(pairs[i]), pairs[i + 1]);
  };
  const appendAll = (target, values) => {
    if (Array.isArray(target)) target.push(...values);
    else if (target instanceof PyObject) (target.list ??= []).push(...values);
    else throw new Error("Données de la partie illisibles (liste attendue).");
  };
  // Clé de dictionnaire ou d'ensemble : un tuple devient un texte, pour que deux tuples égaux soient une même clé.
  const key = (k) => (Array.isArray(k) ? JSON.stringify(k) : k);

  for (;;) {
    const op = u8();
    switch (op) {
      case 0x80: u8(); break; // PROTO
      case 0x95: u64(); break; // FRAME
      case 0x2e: return stack.pop(); // STOP
      case 0x28: stack.push(MARK); break;
      case 0x7d: stack.push(new Map()); break; // EMPTY_DICT
      case 0x5d: stack.push([]); break; // EMPTY_LIST
      case 0x29: stack.push([]); break; // EMPTY_TUPLE
      case 0x8f: stack.push(new Set()); break; // EMPTY_SET
      case 0x90: { const items = popMark(); const set = top(); for (const v of items) set.add(key(v)); break; } // ADDITEMS
      case 0x91: stack.push(new Set(popMark().map(key))); break; // FROZENSET
      case 0x75: { const items = popMark(); setItems(top(), items); break; } // SETITEMS
      case 0x73: { const v = stack.pop(); const k = stack.pop(); setItems(top(), [k, v]); break; } // SETITEM
      case 0x65: { const items = popMark(); appendAll(top(), items); break; } // APPENDS
      case 0x61: { const v = stack.pop(); appendAll(top(), [v]); break; } // APPEND
      case 0x6c: stack.push(popMark()); break; // LIST
      case 0x64: { const items = popMark(); const m = new Map(); setItems(m, items); stack.push(m); break; } // DICT
      case 0x74: stack.push(popMark()); break; // TUPLE
      case 0x85: stack.push([stack.pop()]); break; // TUPLE1
      case 0x86: { const b = stack.pop(); const a = stack.pop(); stack.push([a, b]); break; } // TUPLE2
      case 0x87: { const c = stack.pop(); const b = stack.pop(); const a = stack.pop(); stack.push([a, b, c]); break; } // TUPLE3
      case 0x4a: need(4); stack.push(view.getInt32(pos, true)); pos += 4; break; // BININT
      case 0x4b: stack.push(u8()); break; // BININT1
      case 0x4d: stack.push(u16()); break; // BININT2
      case 0x8a: stack.push(long(u8())); break; // LONG1
      case 0x8b: stack.push(long(u32())); break; // LONG4
      case 0x47: need(8); stack.push(view.getFloat64(pos, false)); pos += 8; break; // BINFLOAT
      case 0x4e: stack.push(null); break; // NONE
      case 0x88: stack.push(true); break; // NEWTRUE
      case 0x89: stack.push(false); break; // NEWFALSE
      case 0x58: stack.push(text(u32())); break; // BINUNICODE
      case 0x8c: stack.push(text(u8())); break; // SHORT_BINUNICODE
      case 0x8d: stack.push(text(u64())); break; // BINUNICODE8
      case 0x55: stack.push(text(u8())); break; // SHORT_BINSTRING
      case 0x54: stack.push(text(u32())); break; // BINSTRING
      case 0x43: stack.push(raw(u8()).slice()); break; // SHORT_BINBYTES
      case 0x42: stack.push(raw(u32()).slice()); break; // BINBYTES
      case 0x8e: stack.push(raw(u64()).slice()); break; // BINBYTES8
      case 0x96: stack.push(raw(u64()).slice()); break; // BYTEARRAY8
      case 0x94: memo.set(memo.size, top()); break; // MEMOIZE
      case 0x71: memo.set(u8(), top()); break; // BINPUT
      case 0x72: memo.set(u32(), top()); break; // LONG_BINPUT
      case 0x68: stack.push(memo.get(u8())); break; // BINGET
      case 0x6a: stack.push(memo.get(u32())); break; // LONG_BINGET
      case 0x63: { const module = line(); const name = line(); stack.push({ global: `${module}.${name}` }); break; } // GLOBAL
      case 0x93: { const name = stack.pop(); const module = stack.pop(); stack.push({ global: `${module}.${name}` }); break; } // STACK_GLOBAL
      case 0x52: case 0x81: { // REDUCE, NEWOBJ : classe et arguments, jamais appelés
        const args = stack.pop();
        const cls = stack.pop();
        stack.push(construct(cls?.global ?? "?", Array.isArray(args) ? args : [args]));
        break;
      }
      case 0x92: { stack.pop(); const args = stack.pop(); const cls = stack.pop(); stack.push(construct(cls?.global ?? "?", args)); break; } // NEWOBJ_EX
      case 0x62: { const state = stack.pop(); const obj = top(); if (obj instanceof PyObject) obj.state = state; break; } // BUILD
      case 0x30: stack.pop(); break; // POP
      case 0x31: popMark(); break; // POP_MARK
      case 0x32: stack.push(top()); break; // DUP
      default: throw new Error(`Données de la partie illisibles (code ${op.toString(16)} à l'octet ${pos - 1}).`);
    }
  }
}

// Fichier .archipelago → données de la partie (Map, comme le dictionnaire Python).
export async function readMultidata(bytes) {
  if (bytes[0] !== 3) throw new Error(`Format de partie inconnu (version ${bytes[0]}) : ce site lit les parties d'Archipelago 0.4 et plus récentes.`);
  const stream = new Blob([bytes.subarray(1)]).stream().pipeThrough(new DecompressionStream("deflate"));
  const data = unpickle(new Uint8Array(await new Response(stream).arrayBuffer()));
  if (!(data instanceof Map)) throw new Error("Ce fichier n'est pas une partie d'Archipelago.");
  return data;
}
