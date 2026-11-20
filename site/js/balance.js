// Équilibre entre les joueurs d'une room, pour l'hôte : la partie générée (fichier .archipelago) donne, sphère par
// sphère, les lieux que chaque joueur peut atteindre si tout le monde fait ce qui lui est accessible, et l'objet de
// chaque lieu. Dès la génération, on voit donc qui démarre avec peu de checks ; pendant la partie, croisé avec le
// tracker, qui a des checks à faire et qui attend les objets des autres.
//
// Les sphères sont celles qu'Archipelago écrit dans la partie (MultiWorld.get_sendable_spheres) : sphère 1, lieux
// accessibles au départ ; sphère n, lieux accessibles avec tous les objets des sphères d'avant. La logique d'un monde
// ne dépend que des objets de son joueur : quand un joueur a reçu tous ses objets de progression placés avant la
// sphère n, il peut faire tous ses lieux jusqu'à la sphère n. C'est un minimum : un joueur passe souvent ailleurs.
import { html, useState, useEffect, useMemo } from "../vendor/preact-htm.js";
import { api } from "./rooms-api.js";
import { readZip } from "./unzip.js";
import { readMultidata, PyObject } from "./pickle.js";
import { progressRows, receivedItems, slotTracker } from "./room-live.js";
import { plural, useAction, useSetting } from "./ui.js";

// --- Données de la partie -------------------------------------------------------------------

const PROGRESSION = 1; // ItemClassification.progression
const GROUP = 2; // SlotType.group (item links)

// Résumé gardé dans le navigateur : { version, seed, spheres, players: [{ slot, name, game }], groups: { slot: [membres] },
// locations: { slot: [[lieu, sphère (0 : hors des sphères), joueur qui reçoit, progression (0/1), objet]] } }.
export function balanceFrom(multidata) {
  const spheres = multidata.get("spheres");
  if (!Array.isArray(spheres) || !spheres.length) {
    throw new Error("Cette partie n'a pas de sphères : elle a été générée avec une version d'Archipelago trop ancienne (avant 0.5).");
  }
  const players = [];
  const groups = {};
  for (const [slot, info] of multidata.get("slot_info") || []) {
    const [name, game, type, members] = info instanceof PyObject ? info.args : info;
    const kind = type instanceof PyObject ? type.args[0] : type;
    if (kind & GROUP) groups[slot] = [...(members || [])];
    else players.push({ slot, name, game });
  }
  const sphereOf = new Map();
  spheres.forEach((sphere, i) => {
    for (const [slot, addresses] of sphere) for (const address of addresses) sphereOf.set(`${slot}|${address}`, i + 1);
  });
  const locations = {};
  for (const [slot, places] of multidata.get("locations") || []) {
    locations[slot] = [...places].map(([address, [item, receiver, flags]]) => [
      address, sphereOf.get(`${slot}|${address}`) || 0, receiver, flags & PROGRESSION ? 1 : 0, item,
    ]);
  }
  const version = multidata.get("version");
  return {
    version: Array.isArray(version) ? version.join(".") : null,
    seed: String(multidata.get("seed_name") ?? ""),
    spheres: spheres.length, players, groups, locations,
  };
}

// Fichier déposé (.archipelago, ou .zip de la partie, reconnu à son contenu) ou téléchargé → résumé. Null pour un .zip sans partie.
async function balanceOfFile(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // « PK » : un .zip
    const files = readZip(buffer);
    const inner = [...files.keys()].find((n) => n.endsWith(".archipelago"));
    if (!inner) return null;
    return balanceFrom(await readMultidata(await files.get(inner).bytes()));
  }
  return balanceFrom(await readMultidata(bytes));
}

// --- Analyse ---------------------------------------------------------------------------------

// Début de partie : les trois premières sphères (moins pour une partie très courte).
const EARLY = 3;
// Écart notable : un joueur qui a moins de la moitié (en part de son monde) de ce qu'a le mieux loti.
const UNEVEN = 0.5;
// Joueur à court de checks : au plus 3 lieux sûrs, ou au plus 10 et moins de 15 % de ce qu'a celui qui en a le plus
// (avec un très grand monde dans la partie, 30 checks à faire restent de quoi jouer). Rien à signaler si personne n'en
// a au moins 10.
const STARVED = { count: 3, share: 0.15, most: 10, min: 10 };
// Peu à faire : moins de 15 checks estimés (sans être à court).
const LOW = 15;
// Front d'avancée d'un joueur : les sphères, depuis la première, dont il a fait au moins la moitié des checks.
const FRONT = 0.5;

// `status` : joueurs de la partie en ligne (ou null avant), `live` / `fixed` : tracker d'archipelago.gg (ou null),
// `balancing` : Map(slot → progression_balancing), lue dans l'en-tête du spoiler s'il est chargé.
export function analyzeBalance(data, { status = null, live = null, fixed = null, balancing = new Map() } = {}) {
  if (status) {
    const bySlot = new Map(data.players.map((p) => [p.slot, p]));
    const same = status.slots.length === data.players.length
      && status.slots.every((s) => bySlot.get(s.slot)?.name === s.name && bySlot.get(s.slot)?.game === s.game);
    if (!same) return { wrong: "players" };
  }
  const members = (receiver) => data.groups[receiver] || [receiver];
  const n = data.spheres;
  const early = Math.min(EARLY, n);

  // Objets reçus comparés aux lieux de la partie : une autre génération (mêmes joueurs) ne correspond pas.
  if (live) {
    let same = 0, other = 0;
    const placed = new Map();
    for (const [slot, list] of Object.entries(data.locations)) for (const [address, , , , item] of list) placed.set(`${slot}|${address}`, item);
    for (const p of data.players) {
      for (const i of receivedItems(live, p.slot)) {
        if (i.player <= 0) continue;
        if (placed.get(`${i.player}|${i.location}`) === i.item) same++; else other++;
      }
    }
    if (other >= 3 && other > same / 4) return { wrong: "seed", other };
  }

  const checked = new Map((live?.player_checks_done || []).filter((e) => e.team === 0).map((e) => [e.player, new Set(e.locations)]));
  const rows = live && status && fixed ? new Map(progressRows(status, live, fixed).map((r) => [r.slot, r])) : new Map();
  const done = (slot, address) => !!checked.get(slot)?.has(address);

  // Objets de progression de chaque joueur : { finder, address, sphere }.
  const incoming = new Map(data.players.map((p) => [p.slot, []]));
  for (const [slot, list] of Object.entries(data.locations)) {
    for (const [address, sphere, receiver, progression] of list) {
      if (!progression) continue;
      for (const r of members(receiver)) incoming.get(r)?.push({ finder: Number(slot), address, sphere });
    }
  }

  const players = data.players.map((p) => {
    const list = data.locations[p.slot] || [];
    const total = list.length;
    const counts = Array(n + 1).fill(0); // counts[s] : lieux de la sphère s (0 : hors des sphères)
    for (const [, sphere] of list) counts[sphere]++;
    const curve = [];
    for (let s = 1, sum = 0; s <= n; s++) { sum += counts[s]; curve.push(sum); }
    const share = (count) => (total ? count / total : 0);
    const half = curve.findIndex((c) => share(c) >= 0.5) + 1 || null;
    const items = incoming.get(p.slot);
    const abroad = items.filter((i) => i.finder !== p.slot).length;
    return {
      ...p, total, counts, curve, half, unreachable: counts[0], balancing: balancing.get(p.slot) ?? null,
      start: curve[0] || 0, early: curve[early - 1] || 0, earlyShare: share(curve[early - 1] || 0),
      progression: items.length, abroad,
      row: rows.get(p.slot) || null,
    };
  });

  // Au départ : qui a bien moins de checks que les autres (en part de son monde) sur les premières sphères.
  const bestEarly = Math.max(...players.map((p) => p.earlyShare));
  const slowStart = players.length > 1 ? players.filter((p) => p.earlyShare < bestEarly * UNEVEN) : [];

  // En cours de partie. Deux mesures par joueur :
  // - sûre (`limit`, `open`) : jusqu'à la première sphère où il lui manque un de ses objets clés, tout son monde lui est
  //   accessible. C'est un minimum, qui s'effondre quand la partie ne suit pas l'ordre des sphères (une async) : un seul
  //   objet clé manquant tôt le borne, même si la plupart de son monde n'en a pas besoin.
  // - estimée (`reach`, `likely`) : les sphères de son front d'avancée (au moins la moitié faite, depuis la première) et
  //   celles où tout lui est sûr comptent en entier ; au-delà, seule la part de ce qui y reste égale à la part qu'il y a
  //   déjà faite (il a commencé des sphères plus loin par d'autres chemins, sans y avoir tout accès). Sur une async de
  //   14 joueurs : 173 pour un joueur que la logique de son jeu (tracker du site) donnait à 180.
  if (live) {
    for (const p of players) {
      const missing = incoming.get(p.slot).filter((i) => i.sphere > 0 && !done(i.finder, i.address));
      const list = data.locations[p.slot] || [];
      p.limit = missing.length ? Math.min(...missing.map((i) => i.sphere)) : Infinity;
      p.done = checked.get(p.slot)?.size || 0;
      p.open = list.filter(([address, sphere]) => sphere > 0 && sphere <= p.limit && !done(p.slot, address)).length;
      const checkedIn = Array(n + 1).fill(0);
      for (const [address, sphere] of list) if (done(p.slot, address)) checkedIn[sphere]++;
      let front = 0;
      for (let s = 1; s <= n; s++) {
        if (p.counts[s] && checkedIn[s] < p.counts[s] * FRONT) break;
        front = s;
      }
      p.reach = Math.max(Math.min(p.limit, n), front);
      p.further = checkedIn.some((c, s) => s > p.reach && c > 0); // a commencé des sphères plus loin
      let likely = 0;
      for (let s = 1; s <= n; s++) {
        const left = p.counts[s] - checkedIn[s];
        likely += s <= p.reach ? left : p.counts[s] ? (left * checkedIn[s]) / p.counts[s] : 0;
      }
      p.likely = Math.round(likely);
      p.missing = missing;
      p.finished = !!p.row?.finished;
    }
    for (const p of players) {
      // Ses objets clés qui manquent le plus tôt, par joueur qui les trouvera (à sa portée : d'après l'estimation).
      const next = p.missing.filter((i) => i.sphere === p.limit);
      const by = new Map();
      for (const i of next) by.set(i.finder, (by.get(i.finder) || 0) + 1);
      p.waitsOn = [...by].map(([slot, count]) => {
        const finder = players.find((o) => o.slot === slot);
        return { slot, name: finder?.name || `Joueur ${slot}`, count, self: slot === p.slot, ready: !!finder && p.limit <= finder.reach };
      }).sort((a, b) => Number(a.self) - Number(b.self) || b.count - a.count);
      // Objets clés des autres qu'il a à sa portée.
      p.gives = players.filter((o) => o.slot !== p.slot && !o.finished).map((o) => ({
        slot: o.slot, name: o.name,
        count: o.missing.filter((i) => i.finder === p.slot && i.sphere <= p.reach).length,
      })).filter((g) => g.count).sort((a, b) => b.count - a.count);
    }
    for (const p of players) {
      // Qui a ses objets clés manquants à sa portée (lui-même compris) : ceux qui peuvent le faire avancer maintenant.
      p.helpers = players.filter((o) => !o.finished).map((o) => ({
        slot: o.slot, name: o.name, self: o.slot === p.slot,
        count: p.missing.filter((i) => i.finder === o.slot && i.sphere <= o.reach).length,
      })).filter((h) => h.count).sort((a, b) => Number(a.self) - Number(b.self) || b.count - a.count);
    }
    const playing = players.filter((p) => !p.finished);
    const most = Math.max(0, ...playing.map((p) => p.likely));
    for (const p of players) {
      p.kind = p.finished ? "finished"
        : most >= STARVED.min && (p.likely <= STARVED.count || (p.likely <= STARVED.most && p.likely < most * STARVED.share)) ? "starved"
        : p.likely < LOW ? "low"
        : "ok";
    }
  }
  return { players, spheres: n, early, slowStart, live: !!live, version: data.version };
}

// --- Partie gardée dans le navigateur ------------------------------------------------------------
// Celle de la génération en ligne (téléchargée par l'hôte) ou un fichier déposé (partie générée chez lui) : seul son
// résumé est gardé (IndexedDB « room-balance »). Il dit où sont tous les objets : comme le spoiler, réservé à l'hôte.

function store(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("room-balance", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("balance");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = action(db.transaction("balance", mode).objectStore("balance"));
      request.onsuccess = () => { resolve(request.result); db.close(); };
      request.onerror = () => { reject(request.error); db.close(); };
    };
  });
}

// { saved: { data, name, source: "room" | "file", at } | null | undefined (lecture en cours), load(fichier, quiet), forget(), action }
// `download` : partie de la génération en ligne téléchargée d'elle-même (hôte seulement : le service la refuse aux joueurs).
export function useBalance(room, { download = true } = {}) {
  const gen = room.generation;
  const generated = download && gen?.status === "done" && gen.files?.output ? gen.at : null;
  const [saved, setSaved] = useState(undefined);
  const [reload, setReload] = useState(0);
  const action = useAction();
  useEffect(() => {
    let alive = true;
    setSaved(undefined);
    (async () => {
      const kept = await store("readonly", (s) => s.get(room.code)).catch(() => null);
      if (kept && (kept.source === "file" || kept.at === generated)) return kept;
      if (!generated) return kept || null;
      try {
        const { blob, name } = await api.file(room.code, "output");
        const data = await balanceOfFile(await blob.arrayBuffer());
        if (!data) throw new Error("La partie générée ne contient pas de fichier .archipelago.");
        const next = { data, name, source: "room", at: generated };
        await store("readwrite", (s) => s.put(next, room.code)).catch(() => {});
        return next;
      } catch (e) {
        if (kept) return kept;
        throw e;
      }
    })().then((f) => alive && setSaved(f), (e) => { if (alive) { setSaved(null); action.setError(e.message); } });
    return () => { alive = false; };
  }, [room.code, generated, reload]);

  // `quiet` : .zip déposé pour le spoiler, sans erreur s'il ne contient pas la partie.
  const load = (file, quiet = false) => file && action.run(async () => {
    const data = await balanceOfFile(await file.arrayBuffer());
    if (!data) {
      if (quiet) return;
      throw new Error("Ce .zip ne contient pas de partie (fichier .archipelago).");
    }
    const next = { data, name: file.name, source: "file", at: Date.now() };
    await store("readwrite", (s) => s.put(next, room.code)).catch(() => {});
    setSaved(next);
  });
  const forget = () => action.run(async () => {
    await store("readwrite", (s) => s.delete(room.code)).catch(() => {});
    setReload((k) => k + 1);
  });
  return { saved, generated, load, forget, action };
}

// --- Vue -----------------------------------------------------------------------------------------
// Deux vues, une ligne par joueur : « En ce moment » (avec le tracker) et « Au lancement » (dès la génération). Chaque
// barre a son nombre écrit à côté, et chaque état son badge en toutes lettres : la couleur ne porte rien seule.

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const names = (list) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} et ${list.at(-1)}`);
const STATES = {
  finished: { label: "But atteint", cls: "ok" },
  starved: { label: "Bloqué ou presque", cls: "warn" },
  low: { label: "Peu à faire", cls: "" },
  ok: { label: "De quoi jouer", cls: "accent" },
};

function Meter({ value, max }) {
  return html`<div class="progress balance-meter" aria-hidden="true"><span style=${`width: ${pct(value, max)}%`}></span></div>`;
}

function Row({ p, badge, children }) {
  return html`<li class=${`balance-row ${badge?.cls === "warn" ? "uneven" : ""}`}>
    <div class="balance-who">
      <strong>${p.name}</strong>
      <span class="hint">${p.game}</span>
      ${badge && html`<span class=${`badge ${badge.cls}`}>${badge.label}</span>`}
    </div>
    <div class="balance-main">${children}</div>
  </li>`;
}

function StartView({ report }) {
  const { players, spheres, early, slowStart } = report;
  const slow = slowStart.map((p) => p.name);
  return html`
    <p class="balance-basis">D'après la génération, avant que quiconque joue : la part du monde de chacun qu'il peut faire
      sur ${early === 1 ? "la première sphère" : `les ${early} premières sphères`} (les premières étapes de la partie).</p>
    <p class=${`notice full ${slow.length ? "warn" : "ok"}`}>${slow.length
      ? `${names(slow)} ${slow.length > 1 ? "démarrent" : "démarre"} lentement : bien moins de checks à faire au début que les autres, donc de l'attente probable.`
      : "Démarrage équilibré : chacun a une part comparable de son monde à faire au début."}</p>
    <ul class="balance-rows full">${players.map((p) => html`<${Row} p=${p}
      badge=${slowStart.includes(p) ? { label: "Démarre lentement", cls: "warn" } : null}>
      <p class="balance-figure"><strong>${pct(p.early, p.total)} %</strong> de son monde ouvert au début${" "}
        <span class="hint">(${plural(p.early, "lieu")} sur ${p.total})</span></p>
      <${Meter} value=${p.earlyShare} max=${1} />
      <p class="hint">Moitié de son monde : ${p.half ? `sphère ${p.half} sur ${spheres}` : "jamais"} · ${p.abroad} objets clés
        sur ${p.progression} chez les autres${p.balancing != null ? ` · équilibrage ${p.balancing}` : ""}</p>
    </${Row}>`)}</ul>
    ${slowStart.length === 1 && html`<${Advice} who=${slowStart[0]} others=${players.filter((p) => p !== slowStart[0])} />`}
    <details class="group full">
      <summary>Comment c'est calculé</summary>
      <p class="group-body hint balance-note">Archipelago découpe la partie en sphères, des étapes : sphère 1, ce qui est
        accessible dès le départ ; sphère 2, ce qui s'ouvre avec les objets trouvés en sphère 1, et ainsi de suite (${spheres}
        sphères ici). « Au lancement » compte, pour chaque joueur, les lieux de son monde dans ${early === 1 ? "la première sphère"
        : `les ${early} premières sphères`}, si tout le monde fait ce qui lui est accessible. La barre montre cette part, de 0 à
        100 % de son monde. Un joueur bien en dessous des autres dépend tôt de leurs objets : il risque d'attendre.</p>
    </details>`;
}

// « En ce moment », ce que seule la room sait : qui attend qui, et qui peut aider (l'emplacement des objets clés de
// chacun, exact) ; le niveau de chacun en toutes lettres (estimé). Le détail exact d'un joueur est dans le tracker.
// `logicLink(p)` : adresse du tracker du site connecté en tant que ce joueur (logique du jeu), ou null.
const keys = (n) => plural(n, "objet clé", "objets clés");
function NowView({ report, logicLink }) {
  const { players } = report;
  const playing = players.filter((p) => !p.finished);
  const order = { starved: 0, low: 1 };
  const waiting = playing.filter((p) => p.kind in order).sort((a, b) => order[a.kind] - order[b.kind] || a.likely - b.likely);
  const stuck = new Set(waiting.map((p) => p.slot));
  const starved = waiting.filter((p) => p.kind === "starved");
  // Qui peut aider : objets clés des autres à sa portée, d'abord ceux qui débloquent des joueurs qui attendent.
  const helping = playing.map((p) => ({ p, forWaiting: p.gives.filter((g) => stuck.has(g.slot)), total: p.gives.reduce((n, g) => n + g.count, 0) }))
    .filter((h) => h.total).sort((a, b) => b.forWaiting.length - a.forWaiting.length || b.total - a.total).slice(0, 5);
  const verdict = !playing.length ? { cls: "ok", text: "Tous les joueurs ont atteint leur but." }
    : starved.length ? { cls: "warn", text: `${names(starved.map((p) => p.name))} ${starved.length > 1 ? "n'ont" : "n'a"} presque plus rien
        à faire : ${starved.length > 1 ? "ils attendent" : "il attend"} des objets des autres.` }
    : waiting.length ? { cls: "ok", text: `Personne n'est bloqué. ${names(waiting.map((p) => p.name))} ${waiting.length > 1 ? "ont" : "a"} peu à faire.` }
    : { cls: "ok", text: "Chacun a de quoi jouer avec les objets déjà reçus." };
  const tracker = (p) => logicLink && html`<a href=${logicLink(p)}>Détail dans le tracker →</a>`;
  return html`
    <p class="balance-basis">D'après les objets que chacun a déjà reçus, les checks qu'il a déjà faits (tracker d'archipelago.gg,
      relu chaque minute) et l'emplacement des objets clés de chacun.</p>
    <p class=${`notice full ${verdict.cls}`}>${verdict.text}</p>
    ${waiting.length > 0 && html`<h3 class="balance-sub">Qui attend qui</h3>
      <ul class="balance-rows full">${waiting.map((p) => html`<${Row} p=${p} badge=${STATES[p.kind]}>
        <p>${p.helpers.length
          ? html`Ses objets clés à portée : ${p.helpers.map((h, i) => html`${i ? ", " : ""}${h.count} ${h.self ? "dans son propre monde"
              : html`chez <strong>${h.name}</strong>`}`)}.`
          : "Aucun de ses objets clés n'est encore à la portée de quelqu'un : d'autres doivent d'abord avancer."}</p>
        <p class="hint">${tracker(p)}</p>
      </${Row}>`)}</ul>`}
    ${helping.length > 0 && html`<h3 class="balance-sub">Qui peut aider</h3>
      <ul class="balance-help full">${helping.map(({ p, forWaiting, total }) => html`<li>
        <strong>${p.name}</strong> : ${keys(total)} à sa portée pour ${plural(p.gives.length, "joueur")}${forWaiting.length
          ? html`, dont <strong>${names(forWaiting.map((g) => g.name))}</strong> qui ${forWaiting.length > 1 ? "attendent" : "attend"}` : ""}.
      </li>`)}</ul>`}
    <details class="group full">
      <summary>Tous les joueurs (${players.length})</summary>
      <ul class="group-body balance-all">${players.map((p) => html`<li>
        <span class=${`badge ${STATES[p.kind].cls}`}>${STATES[p.kind].label}</span>
        <strong>${p.name}</strong> <span class="hint">${p.game}</span>
        ${!p.finished && logicLink && html`<a href=${logicLink(p)}>Tracker →</a>`}
      </li>`)}</ul>
    </details>
    ${starved.length === 1 && !report.slowStart.length && html`<${Advice} who=${starved[0]} others=${players.filter((p) => p !== starved[0])} />`}
    <details class="group full">
      <summary>Comment c'est calculé</summary>
      <p class="group-body hint balance-note">Objets clés : les objets de progression de chaque joueur, à leur place réelle dans
        la partie (aucun n'est nommé). Archipelago découpe la partie en sphères, des étapes : sphère 1, ce qui est accessible
        dès le départ ; sphère 2, ce qui s'ouvre avec les objets de la sphère 1, et ainsi de suite. Un joueur atteint les
        sphères dont il a déjà fait au moins la moitié des checks (et un peu de celles qu'il a commencées) : un objet clé
        rangé là est « à sa portée ». Le niveau de chacun (de quoi jouer, peu à faire, bloqué ou presque) est estimé de la
        même façon, à partir de ce qu'il lui reste dans ces sphères. Pour la liste exacte de ce qu'un joueur peut faire, le
        tracker du site fait tourner la logique de son jeu (lien sous chaque joueur).</p>
    </details>`;
}

function Advice({ who, others }) {
  const known = who.balancing != null && others.every((o) => o.balancing != null);
  return html`<details class="group full">
    <summary>Pour la prochaine partie : aider ${who.name}</summary>
    <ul class="group-body balance-advice">
      <li><code>progression_balancing</code> plus haut${known ? ` (${who.balancing} ici, ${others.map((o) => `${o.balancing} pour ${o.name}`).join(", ")})` : ""} :
        Archipelago avance ses objets clés quand il est en retard.</li>
      <li><code>early_items</code> ou <code>local_early_items</code> : ses objets qui ouvrent le jeu en tout début de partie.</li>
      <li><code>start_inventory</code> : il commence avec ces objets.</li>
      <li><code>local_items</code> : ses objets restent dans son monde, il dépend moins des autres.</li>
    </ul>
  </details>`;
}

// `report` : analyzeBalance (sans tracker : seulement « Au lancement »).
export function BalanceReport({ report, logicLink = null }) {
  const [view, setView] = useState("now");
  if (report.wrong) {
    return html`<div class="notice error full">${report.wrong === "players"
      ? "Cette partie ne correspond pas à la partie en ligne : ses joueurs ou leurs jeux sont différents."
      : `Cette partie vient d'une autre génération : ${plural(report.other, "objet")} déjà reçu${report.other > 1 ? "s" : ""} n'y
        ${report.other > 1 ? "sont" : "est"} pas à cette place.`} Déposez la partie hébergée.</div>`;
  }
  const solo = report.players.length === 1;
  if (solo && !report.live) return html`<p class="hint">Un seul joueur : pas d'équilibre à comparer.</p>`;
  const tabs = [
    ...(report.live ? [["now", "En ce moment", report.players.some((p) => p.kind === "starved")]] : []),
    ...(solo ? [] : [["start", "Au lancement", report.slowStart.length > 0]]),
  ];
  const shown = tabs.some(([id]) => id === view) ? view : tabs[0][0];
  return html`
    ${tabs.length > 1 && html`<div class="segmented balance-tabs" role="group" aria-label="Vue">${tabs.map(([id, label, alert]) => html`
      <button type="button" class=${shown === id ? "active" : ""} aria-pressed=${shown === id} onClick=${() => setView(id)}>
        ${label}${alert && html` <span aria-label="(déséquilibre)" title="Déséquilibre">⚠</span>`}</button>`)}</div>`}
    ${shown === "now" ? html`<${NowView} report=${report} logicLink=${logicLink} />` : html`<${StartView} report=${report} />`}`;
}

// En une ligne, pour le titre replié : ce qui mérite d'ouvrir la carte. Écrit en toutes lettres (⚠ en plus).
function headline(saved, report, player) {
  if (saved === undefined) return { text: "lecture…" };
  if (!saved) return { text: player ? "pas encore partagée par l'hôte" : "déposez la partie générée" };
  if (!report || report.wrong) return { text: "partie différente de celle en ligne", alert: true };
  // Au-delà de deux joueurs, leur nombre seulement : le titre doit tenir sur une ligne (le détail est dans la carte).
  const who = (list) => (list.length > 2 ? `${list.length} joueurs` : names(list));
  const starved = report.live ? report.players.filter((p) => p.kind === "starved").map((p) => p.name) : [];
  if (starved.length) return { text: `${who(starved)} ${starved.length > 1 ? "attendent" : "attend"} des objets`, alert: true };
  const slow = report.slowStart.map((p) => p.name);
  if (slow.length) return { text: `${who(slow)} ${slow.length > 1 ? "démarrent" : "démarre"} lentement`, alert: true };
  return { text: "équilibré" };
}

// Carte « Équilibre entre les joueurs » : en tête de l'onglet « Avancement » (hôte, partie en ligne), repliable
// (`fold`, état gardé), et dans l'onglet Hôte avant l'hébergement. `balance` : useBalance ; `status` / `tracker` : partie
// en ligne ; `balancing` : équilibrage de chaque joueur, lu dans le spoiler. `shared` : vue d'un joueur à qui l'hôte a
// ouvert l'onglet (copie envoyée par l'hôte, sans choix de fichier). `player` : un joueur sans copie de l'hôte, qui peut
// déposer la partie s'il l'a (gardée dans son navigateur).
export function BalanceCard({ balance, status, tracker, balancing, code = null, fold = false, shared = false, player = false }) {
  const { saved, action } = balance;
  const [open, setOpen] = useSetting("balanceOpen", false);
  const live = tracker?.data?.live || null;
  const report = useMemo(() => (saved?.data ? analyzeBalance(saved.data, {
    status, live, fixed: tracker?.data?.fixed, balancing,
  }) : null), [saved, status, live, balancing]);
  const actions = !shared && html`<div class="row">
    <label class="button ghost small">
      <input type="file" accept=".archipelago,.zip" hidden disabled=${action.busy}
        onChange=${(e) => { balance.load(e.target.files[0]); e.target.value = ""; }} />${saved ? "Autre partie" : "Choisir la partie"}</label>
    ${saved?.source === "file" && html`<button type="button" class="ghost small" disabled=${action.busy} onClick=${balance.forget}>
      ${balance.generated ? "Revenir à la génération en ligne" : "Oublier"}</button>`}
  </div>`;
  const body = html`
    ${saved === undefined && html`<p class="hint">${balance.generated || shared ? "Lecture de la partie…" : "Chargement…"}</p>`}
    ${saved === null && (player
      ? html`<p class="hint">Qui a des checks à faire et qui attend les autres. L'hôte n'a pas encore partagé la partie générée : elle
          vous arrive avec le spoiler dès qu'il ouvre l'onglet « Avancement » de son côté, s'il y a chargé la partie (génération en
          ligne, ou son <code>.zip</code>). Si vous avez ce <code>.zip</code>, vous pouvez aussi le déposer ici.</p>`
      : html`<p class="hint">Qui a des checks à faire et qui attend les autres. Déposez le <code>.zip</code> de la partie
          (dossier <code>output</code> d'Archipelago) ou son <code>.archipelago</code>. Il reste dans ce navigateur ; seuls les joueurs à
          qui vous ouvrez l'onglet « Avancement » en reçoivent une copie, avec le spoiler.</p>`)}
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
    ${report && html`<${BalanceReport} report=${report}
      logicLink=${status && code ? (p) => slotTracker(status, p, code) : null} />`}
    ${saved && html`<p class="hint">Partie : ${saved.name}${saved.data.version ? ` (Archipelago ${saved.data.version})` : ""} · ${shared
      ? "partagée par l'hôte." : player ? "gardée dans ce navigateur."
      : "gardée dans ce navigateur, et envoyée avec le spoiler aux joueurs à qui vous ouvrez l'onglet."}</p>`}`;

  if (!fold) {
    return html`<section class="card stack">
      <div class="row full"><h2 class="grow">Équilibre entre les joueurs</h2>${actions}</div>
      ${body}
    </section>`;
  }
  const head = headline(saved, report, player && !shared);
  return html`<details class="card balance-fold" open=${open} onToggle=${(e) => setOpen(e.currentTarget.open)}>
    <summary>
      <h2>Équilibre entre les joueurs</h2>
      <span class=${`badge ${head.alert ? "warn" : ""}`}>${head.alert ? "⚠ " : ""}${head.text}</span>
    </summary>
    <div class="stack balance-fold-body">${body}${actions}</div>
  </details>`;
}
