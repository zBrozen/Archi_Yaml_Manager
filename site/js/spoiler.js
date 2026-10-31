// Avancement de la partie, pour l'hôte : le spoiler de la génération (chemin de victoire en sphères, emplacement des
// objets) croisé avec le tracker d'archipelago.gg, pour voir où en est le chemin de victoire et qui le retient.
import { html, useState, useEffect, useMemo } from "../vendor/preact-htm.js";
import { api } from "./rooms-api.js";
import { readZip, bytesToText } from "./unzip.js";
import { ago, progressRows, receivedItems, usePackages } from "./room-live.js";
import { plural, useAction, useSetting } from "./ui.js";

const IDLE_WARNING = 48 * 3600 * 1000; // en async, comme l'onglet « Progression »

// --- Lecture du spoiler ------------------------------------------------------------------
// Format écrit par Spoiler.to_file d'Archipelago (BaseClasses.py) : en-tête (« Player 2: Nom », « Game: Jeu »),
// « Locations: » (chaque lieu et son objet), « Playthrough: » (chemin de victoire minimal, en sphères : « 3: { … } »,
// la sphère 0 étant l'inventaire de départ), « Unreachable Progression Items: ». Avec plusieurs joueurs, lieux et
// objets sont suivis du nom de leur joueur : « Lieu (Alice): Objet (Bob) ». Les mondes peuvent écrire leurs propres
// sections entre l'en-tête et « Starting Items: », et après le chemin de victoire : elles sont ignorées.

const SECTIONS = ["Entrances:", "Starting Items:", "Locations:", "Playthrough:", "Unreachable Progression Items:", "Paths:"];

// « Nom (Joueur) » → { name, player }. Les noms des joueurs de la partie d'abord (un nom de lieu ou d'objet peut
// contenir des parenthèses), puis les dernières parenthèses : groupes d'item links, absents de l'en-tête.
function owned(text, names) {
  for (const n of names) if (text.endsWith(` (${n})`)) return { name: text.slice(0, -n.length - 3), player: n };
  const m = /^(.*) \(([^()]+)\)$/.exec(text);
  return m ? { name: m[1], player: m[2] } : { name: text, player: null };
}

// « Lieu (Alice): Objet (Bob) » ; sans nom de joueur dans une partie à un seul joueur.
function placement(line, names, single) {
  if (single) {
    const i = line.lastIndexOf(": ");
    return i < 0 ? null : { location: line.slice(0, i), finder: null, item: line.slice(i + 2), receiver: null };
  }
  for (const n of names) {
    const sep = ` (${n}): `;
    for (let i = line.indexOf(sep); i >= 0; i = line.indexOf(sep, i + 1)) {
      const right = owned(line.slice(i + sep.length), names);
      if (right.player) return { location: line.slice(0, i), finder: n, item: right.name, receiver: right.player };
    }
  }
  return null;
}

export function parseSpoiler(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const head = /^Archipelago Version (\S+)\s+-\s+Seed: (\S+)/.exec(lines[0] || "");
  if (!head) throw new Error("Ce fichier n'est pas un spoiler d'Archipelago (fichier AP_…_Spoiler.txt).");
  const players = []; // { slot, name, game } ; name null pour une partie à un seul joueur
  const result = {
    version: head[1], seed: head[2], players, playthrough: false,
    spheres: [], // [{ n, entries: [{ location, finder, item, receiver, receiverName }] }], finder et receiver : numéros de slot
    start: [], // objets de progression de départ : [{ item, receiver, receiverName }]
    placements: new Map(), // `slot|lieu` → { item, receiver, receiverName }
    unreachable: [],
  };
  let section = null;
  let names = [];
  let slots = new Map();
  let sphere = null;
  const single = () => players.length === 1;
  const slotOf = (name) => (single() ? 1 : slots.get(name) ?? null);
  const read = (line) => {
    const p = placement(line, names, single());
    return p && { location: p.location, finder: slotOf(p.finder), item: p.item, receiver: slotOf(p.receiver), receiverName: p.receiver };
  };

  for (const line of lines.slice(1)) {
    if (SECTIONS.includes(line)) {
      if (!section) {
        names = players.map((p) => p.name).filter(Boolean).sort((a, b) => b.length - a.length);
        slots = new Map(players.map((p) => [p.name, p.slot]));
      }
      section = line;
      sphere = null;
      continue;
    }
    let m;
    if (!section) {
      if ((m = /^Player (\d+): (.+)$/.exec(line)) && Number(m[1]) === players.length + 1) {
        players.push({ slot: Number(m[1]), name: m[2], game: null });
      } else if ((m = /^Game:\s+(.+)$/.exec(line))) {
        if (players.length && !players.at(-1).game) players.at(-1).game = m[1];
        else if (!players.length) players.push({ slot: 1, name: null, game: m[1] });
      }
    } else if (section === "Locations:" && line) {
      const p = read(line);
      if (p && p.finder) result.placements.set(`${p.finder}|${p.location}`, { item: p.item, receiver: p.receiver, receiverName: p.receiverName });
    } else if (section === "Playthrough:") {
      if ((m = /^(\d+): \{$/.exec(line))) {
        sphere = { n: Number(m[1]), entries: [] };
        result.playthrough = true;
        if (sphere.n > 0) result.spheres.push(sphere);
      } else if (line === "}") {
        sphere = null;
      } else if (sphere && line.startsWith("  ")) {
        const body = line.slice(2);
        if (sphere.n === 0) {
          const o = single() ? { name: body, player: null } : owned(body, names);
          result.start.push({ item: o.name, receiver: slotOf(o.player), receiverName: o.player });
        } else {
          const p = read(body);
          if (p && p.finder) sphere.entries.push(p);
        }
      }
    } else if (section === "Unreachable Progression Items:" && line) {
      // « Objet (Bob): Lieu (Alice) » : l'objet d'abord.
      const p = read(line);
      if (p) result.unreachable.push({ item: p.location, receiver: p.finder, location: p.item, finder: p.receiver });
    }
  }
  if (!players.length) throw new Error("Spoiler illisible : aucun joueur trouvé dans son en-tête.");
  return result;
}

// Texte du spoiler d'un fichier déposé : le .txt, ou le .zip de la partie générée (qui le contient, généré chez soi).
async function spoilerText(file) {
  if (!/\.zip$/i.test(file.name)) return file.text();
  const files = readZip(await file.arrayBuffer());
  const name = [...files.keys()].find((n) => n.endsWith("_Spoiler.txt"));
  if (!name) throw new Error("Cette partie ne contient pas de spoiler : générez-la avec un spoiler (réglage par défaut d'Archipelago).");
  return bytesToText(await files.get(name).bytes());
}

// --- Analyse -------------------------------------------------------------------------------
// Sphère n du chemin de victoire : lieux accessibles avec les objets des sphères précédentes (et l'inventaire de
// départ). Une fois toutes les sphères avant n faites, chaque lieu de la sphère n est donc accessible à coup sûr :
// la première sphère pas finie (« sphère en cours ») dit qui peut faire avancer la partie. Les événements (lieux sans
// numéro, comme un boss vaincu ou le but d'un joueur) ne passent pas par le serveur : ils ne sont pas suivis.
// La logique d'un monde ne dépend que des objets de son joueur : un joueur qui a reçu tous les objets du chemin qui
// lui reviennent peut atteindre son but.

export function analyze(spoiler, status, live, fixed, packages) {
  const slots = new Map(status.slots.map((s) => [s.slot, s]));
  const nameOf = (slot) => slots.get(slot)?.name || `Joueur ${slot}`;
  const sameGame = spoiler.players.length === status.slots.length && spoiler.players.every((p) => {
    const s = slots.get(p.slot);
    return s && s.game === p.game && (p.name == null || p.name === s.name);
  });
  if (!sameGame) return { wrong: "players" };

  const checked = new Map((live.player_checks_done || []).filter((e) => e.team === 0).map((e) => [e.player, new Set(e.locations)]));
  const rows = new Map(progressRows(status, live, fixed).map((r) => [r.slot, r]));

  // Objets déjà reçus comparés au spoiler : un autre spoiler (même joueurs, autre génération) ne correspond pas.
  let same = 0;
  let other = 0;
  for (const s of status.slots) {
    const items = packages[s.game]?.items;
    if (!items) continue;
    for (const i of receivedItems(live, s.slot)) {
      const place = i.player > 0 && packages[slots.get(i.player)?.game]?.locations.get(i.location);
      if (!place) continue;
      if (spoiler.placements.get(`${i.player}|${place}`)?.item === items.get(i.item)) same++;
      else other++;
    }
  }
  if (other >= 3 && other > same / 4) return { wrong: "seed", same, other };

  const spheres = spoiler.spheres.map((sp) => {
    const entries = sp.entries.map((e) => {
      const pkg = packages[slots.get(e.finder)?.game];
      const id = pkg?.locationIds.get(e.location);
      return { ...e, sphere: sp.n, unknown: !pkg, event: !!pkg && id == null, done: id != null && !!checked.get(e.finder)?.has(id) };
    });
    const tracked = entries.filter((e) => !e.event && !e.unknown);
    return { n: sp.n, entries, total: tracked.length, done: tracked.filter((e) => e.done).length };
  });
  const pending = spheres.flatMap((s) => s.entries.filter((e) => !e.event && !e.unknown && !e.done));
  const frontier = spheres.find((s) => s.done < s.total) || null;
  const now = frontier ? pending.filter((e) => e.sphere === frontier.n) : [];

  const players = status.slots.map((s) => {
    const row = rows.get(s.slot);
    const own = pending.filter((e) => e.finder === s.slot);
    const incoming = pending.filter((e) => e.receiver === s.slot);
    const ready = now.filter((e) => e.finder === s.slot);
    const first = incoming[0];
    const waitingOn = first ? [...new Set(incoming.filter((e) => e.sphere === first.sphere).map((e) => e.finder))] : [];
    const idle = !row?.finished && (row?.last ? Date.now() - row.last > IDLE_WARNING : true);
    const kind = row?.finished ? (own.length ? "release" : "goal")
      : ready.length ? "play"
      : !incoming.length ? "ready"
      : "wait";
    return { ...s, row, own, incoming, ready, waitingOn, idle, kind };
  });
  const byFinder = new Map();
  for (const e of now) {
    if (!byFinder.has(e.finder)) byFinder.set(e.finder, []);
    byFinder.get(e.finder).push(e);
  }
  const blockers = [...byFinder].map(([slot, entries]) => ({
    player: players.find((p) => p.slot === slot),
    entries,
    // Joueurs (numéros de slot) ou groupes d'item links (noms) qui recevront ses objets.
    unlocks: [...new Set(entries.map((e) => e.receiver ?? e.receiverName).filter((r) => r !== slot))],
    waiting: players.filter((p) => p.kind === "wait" && p.waitingOn.includes(slot) && p.slot !== slot),
  })).sort((a, b) => b.waiting.length - a.waiting.length || b.entries.length - a.entries.length);

  return {
    spheres, frontier, players, blockers, nameOf,
    total: spheres.reduce((n, s) => n + s.total, 0),
    done: spheres.reduce((n, s) => n + s.done, 0),
    events: spheres.reduce((n, s) => n + s.entries.filter((e) => e.event).length, 0),
  };
}

// --- Spoiler gardé dans le navigateur -------------------------------------------------------
// Celui de la génération en ligne (gardé 30 jours par le service) ou un fichier déposé par l'hôte (partie générée
// chez lui) : copie dans IndexedDB, pour qu'une partie async plus longue que 30 jours garde son avancement.

function spoilerStore(mode, action) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("room-spoilers", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("spoilers");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = action(db.transaction("spoilers", mode).objectStore("spoilers"));
      request.onsuccess = () => { resolve(request.result); db.close(); };
      request.onerror = () => { reject(request.error); db.close(); };
    };
  });
}

// { file: { text, name, source: "room" | "file", at } | null | undefined (lecture en cours), load(fichier), forget(), action }
function useSpoiler(room) {
  const gen = room.generation;
  const generated = gen?.status === "done" && gen.files?.spoiler ? gen.at : null;
  const [file, setFile] = useState(undefined);
  const [reload, setReload] = useState(0);
  const action = useAction();
  useEffect(() => {
    let alive = true;
    setFile(undefined);
    (async () => {
      const saved = await spoilerStore("readonly", (s) => s.get(room.code)).catch(() => null);
      if (saved && (saved.source === "file" || saved.at === generated)) return saved;
      if (!generated) return saved || null;
      try {
        const { blob, name } = await api.file(room.code, "spoiler");
        const next = { text: await blob.text(), name, source: "room", at: generated };
        await spoilerStore("readwrite", (s) => s.put(next, room.code)).catch(() => {});
        return next;
      } catch (e) {
        if (saved) return saved;
        throw e;
      }
    })().then((f) => alive && setFile(f), (e) => { if (alive) { setFile(null); action.setError(e.message); } });
    return () => { alive = false; };
  }, [room.code, generated, reload]);

  const load = (input) => input && action.run(async () => {
    const text = await spoilerText(input);
    parseSpoiler(text); // refuse tout de suite un fichier qui n'est pas un spoiler
    const next = { text, name: input.name, source: "file", at: Date.now() };
    await spoilerStore("readwrite", (s) => s.put(next, room.code)).catch(() => {});
    setFile(next);
  });
  const forget = () => action.run(async () => {
    await spoilerStore("readwrite", (s) => s.delete(room.code)).catch(() => {});
    setReload((n) => n + 1);
  });
  return { file, generated, load, forget, action };
}

// --- Vue -------------------------------------------------------------------------------------

const KINDS = {
  release: { label: "Au but, checks non libérés", cls: "danger" },
  goal: { label: "But atteint", cls: "ok" },
  play: { label: "À lui de jouer", cls: "accent" },
  ready: { label: "Peut finir", cls: "ok" },
  wait: { label: "En attente", cls: "warn" },
};

const formatDate = (ms) => new Date(ms).toLocaleString("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const pct = (a, b) => (b ? Math.floor((a / b) * 100) : 0);

export function AdvancementView({ room, online, tracker }) {
  const spoiler = useSpoiler(room);
  const [hide, setHide] = useSetting("spoilerHide", false);
  const { status } = online;
  const parsed = useMemo(() => {
    if (!spoiler.file) return null;
    try { return { spoiler: parseSpoiler(spoiler.file.text) }; } catch (e) { return { error: e.message }; }
  }, [spoiler.file]);
  const games = status ? [...new Set(status.slots.map((s) => s.game))].sort() : [];
  const packages = usePackages(status?.origin, tracker.data?.fixed, tracker.data ? games : []);
  const loading = games.some((g) => !packages.loaded[g]) && !packages.error;
  const report = useMemo(() => (status && parsed?.spoiler && tracker.data && !loading
    ? analyze(parsed.spoiler, status, tracker.data.live, tracker.data.fixed, packages.loaded) : null),
  [status, parsed, tracker.data, loading, packages.loaded]);

  const busy = spoiler.action.busy;
  const picker = (label, cls = "button ghost small") => html`<label class=${cls}>
    <input type="file" accept=".txt,.zip" hidden disabled=${busy} onChange=${(e) => { spoiler.load(e.target.files[0]); e.target.value = ""; }} />${label}</label>`;
  const file = spoiler.file;

  return html`<section class="card stack">
    <div class="row full">
      <h2 class="grow">Avancement de la partie</h2>
      <label class="check"><input type="checkbox" checked=${hide} onChange=${(e) => setHide(e.target.checked)} />
        Masquer les objets et les lieux</label>
    </div>
    <p class="hint">Réservé à l'hôte : le spoiler de la génération, croisé avec le tracker d'archipelago.gg, montre où en est
      le chemin de victoire et qui peut le faire avancer. En stream, masquez les objets et les lieux : seuls restent
      les joueurs et les nombres de checks.</p>
    ${file === undefined && html`<p class="hint">Lecture du spoiler…</p>`}
    ${file && html`<div class="row full">
      <span class="grow">Spoiler : <strong>${file.name}</strong> <span class="hint">${file.source === "room"
        ? `(génération en ligne du ${formatDate(file.at)})` : `(déposé le ${formatDate(file.at)})`}
        ${parsed?.spoiler ? ` · Archipelago ${parsed.spoiler.version}` : ""} · gardé dans ce navigateur</span></span>
      ${picker("Utiliser un autre spoiler")}
      ${file.source === "file" && html`<button type="button" class="ghost small" disabled=${busy} onClick=${spoiler.forget}>
        ${spoiler.generated ? "Revenir à celui de la génération" : "Oublier"}</button>`}
    </div>`}
    ${file === null && html`<${SpoilerDrop} spoiler=${spoiler} />`}
    ${spoiler.action.error && html`<div class="notice error full">${spoiler.action.error}</div>`}
    ${parsed?.error && html`<div class="notice error full">${parsed.error}</div>`}
    ${parsed?.spoiler && !parsed.spoiler.playthrough && html`<div class="notice warn full">Ce spoiler n'a pas de chemin de
      victoire (niveau de spoiler 1) : générez la partie avec un spoiler complet (niveau 2, celui par défaut d'Archipelago).</div>`}
  </section>
  ${parsed?.spoiler?.playthrough && html`<${Report} report=${report} spoiler=${parsed.spoiler} status=${status} online=${online}
    tracker=${tracker} loading=${loading} packagesError=${packages.error} hide=${hide} mode=${room.mode} />`}`;
}

function SpoilerDrop({ spoiler }) {
  const [hover, setHover] = useState(false);
  return html`<label class=${`drop compact full ${hover ? "hover" : ""} ${spoiler.action.busy ? "busy" : ""}`}
    onDragOver=${(e) => { e.preventDefault(); setHover(true); }}
    onDragLeave=${() => setHover(false)}
    onDrop=${(e) => { e.preventDefault(); setHover(false); spoiler.load(e.dataTransfer.files[0]); }}>
    <input type="file" accept=".txt,.zip" hidden onChange=${(e) => { spoiler.load(e.target.files[0]); e.target.value = ""; }} />
    <strong>${spoiler.action.busy ? "Lecture du spoiler…" : "Déposez le spoiler de la partie"}</strong>
    <span>ou cliquez pour le choisir</span>
    <span class="hint">Fichier <code>AP_…_Spoiler.txt</code>, ou le <code>.zip</code> de la partie générée sur votre ordinateur
      (dossier <code>output</code>). La génération en ligne le fournit d'elle-même si « Garder un spoiler » était coché.
      Il reste dans ce navigateur : rien n'est envoyé.</span>
  </label>`;
}

function Report({ report, spoiler, status, online, tracker, loading, packagesError, hide, mode }) {
  if (!status) return html`<section class="card"><p class="hint">${online.error || "Chargement de la partie…"}</p></section>`;
  if (!tracker.data) return html`<section class="card"><p class="hint">${tracker.error || "Chargement du tracker…"}</p></section>`;
  if (loading || !report) return html`<section class="card"><p class="hint">Chargement des noms des lieux…</p></section>`;
  if (report.wrong) {
    return html`<section class="card"><div class="notice error">${report.wrong === "players"
      ? "Ce spoiler ne correspond pas à la partie en ligne : ses joueurs ou leurs jeux sont différents."
      : `Ce spoiler vient d'une autre génération : ${plural(report.other, "objet")} déjà reçu${report.other > 1 ? "s" : ""} ne
        ${report.other > 1 ? "sont" : "est"} pas à la place qu'il indique.`} Déposez le spoiler de la partie hébergée.</div></section>`;
  }
  const { spheres, frontier, players, blockers, nameOf } = report;
  const finished = players.filter((p) => p.row?.finished).length;
  const waiting = players.filter((p) => p.kind === "wait").length;
  const receiver = (e) => (e.receiver ? nameOf(e.receiver) : e.receiverName || "?");

  return html`
  <section class="card stack">
    <h2>Chemin de victoire</h2>
    ${packagesError && html`<div class="notice warn full">${packagesError} Les checks de certains jeux ne sont pas suivis.</div>`}
    <div class="adv-stats full">
      <div><strong>${report.done} / ${report.total}</strong><span>checks requis faits (${pct(report.done, report.total)} %)</span></div>
      <div><strong>${frontier ? `${frontier.n} / ${spheres.length}` : "Terminé"}</strong><span>${frontier ? "sphère en cours" : `${plural(spheres.length, "sphère")} faites`}</span></div>
      <div><strong>${finished} / ${players.length}</strong><span>joueurs au but</span></div>
      <div><strong>${waiting}</strong><span>${waiting > 1 ? "joueurs en attente" : "joueur en attente"}</span></div>
    </div>
    <div class="progress full" title=${`${pct(report.done, report.total)} %`}><span style=${`width: ${pct(report.done, report.total)}%`}></span></div>
    <p class="hint">Le chemin de victoire est celui qu'Archipelago a calculé à la génération : le moins d'objets de progression
      possible pour que tout le monde atteigne son but, rangés en sphères (sphère 1 : accessible dès le départ ; sphère n :
      accessible avec les objets des sphères d'avant). Les joueurs peuvent passer par d'autres chemins : un check en attente
      ici retarde la partie sans forcément la bloquer.${report.events ? ` Les ${report.events} événements du chemin (boss, buts…)
      ne passent pas par le serveur et ne sont pas suivis.` : ""}</p>
  </section>

  <section class="card stack">
    <h2>${frontier ? `Ce qui fait avancer la partie (sphère ${frontier.n})` : "Ce qui fait avancer la partie"}</h2>
    ${!frontier
      ? html`<div class="notice ok full">Tous les checks du chemin de victoire sont faits : chaque joueur a reçu de quoi atteindre son but.</div>`
      : html`<p>${frontier.total - frontier.done === 1 ? "1 check requis" : `${frontier.total - frontier.done} checks requis`} de la
          sphère ${frontier.n}, ${frontier.total - frontier.done === 1 ? "accessible" : "tous accessibles"} maintenant (les sphères d'avant sont faites) :</p>
        <ul class="blockers full">${blockers.map((b) => html`<${Blocker} b=${b} hide=${hide} mode=${mode} nameOf=${nameOf} receiver=${receiver} />`)}</ul>`}
  </section>

  <section class="card stack">
    <h2>Par joueur</h2>
    <div class="table-wrap full"><table class="room-table adv-table">
      <thead><tr><th>Joueur</th><th>État</th><th>Ses checks requis</th><th>Objets requis à recevoir</th><th>Dernière activité</th></tr></thead>
      <tbody>${players.map((p) => html`<tr>
        <td><strong>${p.name}</strong><br /><span class="hint">${p.game}</span></td>
        <td><span class=${`badge ${KINDS[p.kind].cls}`}>${KINDS[p.kind].label}</span>
          ${p.kind === "wait" && html`<br /><span class="hint">${p.waitingOn.includes(p.slot) && p.waitingOn.length === 1
            ? `sa suite : sphère ${p.incoming[0].sphere}` : `attend ${p.waitingOn.filter((s) => s !== p.slot).map(nameOf).join(", ")}`}</span>`}</td>
        <td data-label="Ses checks requis">${p.own.length
          ? html`${p.own.length} restant${p.own.length > 1 ? "s" : ""}${p.ready.length ? html`<br /><span class="hint">dont ${p.ready.length} accessible${p.ready.length > 1 ? "s" : ""} maintenant</span>` : ""}`
          : html`<span class="hint">✓ aucun</span>`}</td>
        <td data-label="Objets requis à recevoir">${p.incoming.length
          ? html`${p.incoming.length} restant${p.incoming.length > 1 ? "s" : ""}<br /><span class="hint">prochain : ${hide ? "objet"
              : html`<span class="adv-item">★ ${p.incoming[0].item}</span>`} de ${nameOf(p.incoming[0].finder)} (sphère ${p.incoming[0].sphere})</span>`
          : html`<span class="hint">✓ tout reçu</span>`}</td>
        <td data-label="Dernière activité">${p.row?.finished ? html`<span class="hint">terminé</span>`
          : p.row?.last ? html`<span class=${mode === "async" && p.idle ? "badge warn" : "hint"}>${ago(p.row.last)}</span>`
          : html`<span class="badge warn">jamais connecté</span>`}</td>
      </tr>`)}</tbody>
    </table></div>
    <p class="hint">« Peut finir » : le joueur a reçu tous les objets du chemin qui lui reviennent ; « En attente » : il lui en
      manque un que d'autres doivent encore trouver ; « À lui de jouer » : un de ses checks requis est accessible.</p>
  </section>

  <section class="card stack">
    <h2>Sphères</h2>
    <ol class="sphere-list full">${spheres.map((s) => html`<${Sphere} key=${s.n} s=${s} current=${frontier?.n === s.n}
      future=${frontier && s.n > frontier.n} hide=${hide} nameOf=${nameOf} receiver=${receiver} />`)}</ol>
    ${spoiler.start.length > 0 && html`<p class="hint">Inventaire de départ : ${plural(spoiler.start.length, "objet")} de progression.</p>`}
    ${spoiler.unreachable.length > 0 && html`<p class="hint">${plural(spoiler.unreachable.length, "objet")} de progression
      inaccessible${spoiler.unreachable.length > 1 ? "s" : ""} (joueurs en accessibilité minimale) : inutile${spoiler.unreachable.length > 1 ? "s" : ""} pour finir.</p>`}
  </section>`;
}

function Blocker({ b, hide, mode, nameOf, receiver }) {
  const { player: p, entries } = b;
  const others = b.unlocks.filter((r) => !b.waiting.some((w) => w.slot === r));
  const notes = [];
  if (p.row?.finished) {
    notes.push({ level: "error", text: html`A atteint son but sans libérer ses objets (release désactivé ou à la demande) :
      ${" "}<code>/release ${p.name}</code> dans la console de la room archipelago.gg les envoie à tous.` });
  } else if (!p.row?.last) {
    notes.push({ level: "warn", text: "Ne s'est encore jamais connecté à la partie." });
  } else if (mode === "async" && p.idle) {
    notes.push({ level: "warn", text: html`Sans activité ${ago(p.row.last)}. S'il abandonne, <code>/release ${p.name}</code>${" "}
      dans la console de la room archipelago.gg envoie ses objets aux autres.` });
  }
  return html`<li class="blocker">
    <div class="row full">
      <strong class="grow">${p.name} <span class="hint">${p.game}</span></strong>
      <span class=${`badge ${p.row?.state.cls || ""}`}>${p.row?.state.label || "Hors ligne"}</span>
      <span>${plural(entries.length, "check")}</span>
    </div>
    <p>${b.waiting.length ? html`<strong>Attendu par ${b.waiting.map((w) => w.name).join(", ")}.</strong> ` : ""}${others.length
      ? `${b.waiting.length ? "Donne aussi" : "Donne"} des objets requis à ${others.map((r) => (typeof r === "number" ? nameOf(r) : r)).join(", ")}.`
      : !b.waiting.length ? "Ses objets requis sont pour lui-même." : ""}</p>
    ${notes.length > 0 && html`<ul class="check-notes">${notes.map((n) => html`<li class=${n.level}>${n.text}</li>`)}</ul>`}
    ${!hide && html`<ul class="adv-entries">${entries.map((e) => html`<${Entry} e=${e} nameOf=${nameOf} receiver=${receiver} />`)}</ul>`}
  </li>`;
}

function Sphere({ s, current, future, hide, nameOf, receiver }) {
  // Sphère d'événements seulement : faite quand toutes celles d'avant le sont.
  const full = s.total ? s.done === s.total : !current && !future;
  const state = full ? { label: "Faite", cls: "ok" } : current ? { label: "En cours", cls: "accent" } : { label: "À venir", cls: "" };
  return html`<li class=${`sphere ${current ? "current" : ""}`}>
    <details open=${current}>
      <summary>
        <strong>Sphère ${s.n}</strong>
        <span class=${`badge ${state.cls}`}>${state.label}</span>
        <span class="hint">${s.total ? `${s.done} / ${s.total} checks` : "événements seulement"}${future && s.done ? " (faits en avance)" : ""}</span>
        ${s.total > 0 && html`<span class="progress small"><span class=${full ? "ok" : ""} style=${`width: ${pct(s.done, s.total)}%`}></span></span>`}
      </summary>
      ${hide ? html`<p class="hint">Objets et lieux masqués.</p>`
        : html`<ul class="adv-entries">${s.entries.map((e) => html`<${Entry} e=${e} nameOf=${nameOf} receiver=${receiver} />`)}</ul>`}
    </details>
  </li>`;
}

function Entry({ e, nameOf, receiver }) {
  const mark = e.event ? ["◆", "Événement : pas suivi par le serveur"] : e.unknown ? ["?", "Jeu sans noms de lieux : pas suivi"]
    : e.done ? ["✓", "Fait"] : ["○", "Pas encore fait"];
  return html`<li class=${e.done ? "done" : e.event || e.unknown ? "event" : ""}>
    <span class="adv-mark" title=${mark[1]} aria-label=${mark[1]}>${mark[0]}</span>
    <span><span class="adv-location">${e.location}</span> <span class="hint">(${nameOf(e.finder)})</span> → <span
      class="adv-item">★ ${e.item}</span> <span class="hint">pour ${e.receiver === e.finder ? "lui-même" : receiver(e)}</span></span>
  </li>`;
}
