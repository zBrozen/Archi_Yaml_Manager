// Pages des rooms : créer ou rejoindre une room, déposer ses YAML, vérifier et préparer la génération (hôte),
// puis retrouver la partie hébergée sur archipelago.gg (adresse, tracker, fichiers de chaque joueur).
import { html, useState, useEffect } from "../vendor/preact-htm.js";
import { apVersion, gameEntry, localGames } from "./data.js";
import { splitFile } from "./yaml-model.js";
import { checkText, nameProblem, MAX_NAME } from "./check.js";
import { GamePicker, SheetBadges, download, loadCredits, plural } from "./ui.js";
import { makeZip } from "./zip.js";
import {
  api, apRoomStatus, forgetAccess, hostLink, inviteLink, knownRooms, normalizeCode, playerLink,
  roomsEnabled, saveAccess, savedAccess,
} from "./rooms-api.js";

const MODES = {
  sync: { label: "Sync", text: "Tout le monde joue en même temps, en une session." },
  async: { label: "Async", text: "Chacun joue à son rythme, sur plusieurs jours ou semaines." },
};

const pad = (n) => String(n).padStart(2, "0");
const toInput = (ms) => {
  if (ms == null) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromInput = (text) => (text ? new Date(text).getTime() : null);
const formatWhen = (ms) => new Date(ms).toLocaleString("fr-FR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

function timeLeft(ms) {
  const minutes = Math.round((ms - Date.now()) / 60000);
  if (minutes < 60) return `dans ${Math.max(minutes, 1)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `dans ${hours} h${minutes % 60 ? ` ${pad(minutes % 60)}` : ""}`;
  return `dans ${Math.floor(hours / 24)} j ${hours % 24} h`;
}

function CopyButton({ text, label = "Copier", className = "ghost small" }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); } catch { prompt("Copiez ce texte :", text); return; }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return html`<button type="button" class=${className} onClick=${copy}>${done ? "Copié ✓" : label}</button>`;
}

// Badges d'un jeu dans les listes de la room.
function GameBadges({ game }) {
  const entry = gameEntry(game);
  if (!entry) return game.startsWith("Au hasard") ? null : html`<span class="badge warn" title="Jeu absent de la base du site">Hors base</span>`;
  return html`${entry.source !== "core" && html`<span class="badge accent">Non officiel</span>`}<${SheetBadges} sheet=${entry.sheet} />`;
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try { return await fn(); } catch (e) { setError(e.message); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, setError, run };
}

// --- Accueil des rooms -------------------------------------------------------------

export function RoomsHome() {
  const [code, setCode] = useState("");
  const create = useAction();
  const [form, setForm] = useState({ title: "", mode: "async", closes: "", max_slots: 3 });
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });
  const rooms = knownRooms();

  if (!roomsEnabled()) {
    return html`<main class="home"><div class="notice warn">Les rooms ne sont pas encore activées sur ce site
      (adresse du service à indiquer dans <code>js/config.js</code>, voir le README).</div></main>`;
  }

  const submit = (e) => {
    e.preventDefault();
    create.run(async () => {
      const result = await api.create({ title: form.title, mode: form.mode, closes_at: fromInput(form.closes), max_slots: Number(form.max_slots) });
      saveAccess(result.code, { admin: result.admin_token, title: form.title });
      location.hash = `#/room/${result.code}`;
    });
  };
  const join = (e) => {
    e.preventDefault();
    const clean = normalizeCode(code);
    if (clean) location.hash = `#/room/${clean}`;
  };

  return html`<main class="home">
    <div class="intro">
      <h1>Rooms</h1>
      <p>Rassemblez les YAML de tous les joueurs d'une partie : chacun rejoint la room avec son code et y dépose ses fichiers.</p>
    </div>

    <form class="card stack" onSubmit=${join}>
      <h2>Rejoindre une room</h2>
      <div class="row full">
        <input type="text" class="code-input grow" placeholder="Code de la room (ex. K7F2QX)" value=${code}
          maxLength="12" autocomplete="off" onInput=${(e) => setCode(e.target.value.toUpperCase())} />
        <button type="submit" disabled=${!normalizeCode(code)}>Rejoindre</button>
      </div>
    </form>

    <form class="card stack" onSubmit=${submit}>
      <h2>Créer une room</h2>
      <div class="fields full">
        <label class="span-all"><span>Nom de la room</span>
          <input type="text" required maxLength="80" value=${form.title} onInput=${set("title")} placeholder="Async du vendredi" /></label>
        <label><span>Type de partie</span>
          <select value=${form.mode} onChange=${set("mode")}>
            ${Object.entries(MODES).map(([k, m]) => html`<option value=${k}>${m.label} — ${m.text}</option>`)}
          </select></label>
        <label><span>YAML par joueur (maximum)</span>
          <input type="number" min="1" max="20" value=${form.max_slots} onInput=${set("max_slots")} /></label>
        <label class="span-all"><span>Fin des dépôts <span class="hint">(facultatif, modifiable ensuite)</span></span>
          <input type="datetime-local" value=${form.closes} onInput=${set("closes")} /></label>
      </div>
      ${create.error && html`<div class="notice error full">${create.error}</div>`}
      <button type="submit" disabled=${create.busy || !form.title.trim()}>${create.busy ? "Création…" : "Créer la room"}</button>
    </form>

    ${rooms.length > 0 && html`<section class="card stack">
      <h2>Vos rooms dans ce navigateur</h2>
      <ul class="room-list full">${rooms.map((r) => html`<li>
        <a href=${`#/room/${r.code}`}><strong>${r.title || r.code}</strong></a>
        <code>${r.code}</code>
        ${r.admin && html`<span class="badge accent">Hôte</span>`}
        ${r.pseudo && html`<span class="hint">${r.pseudo}</span>`}
      </li>`)}</ul>
    </section>`}
  </main>`;
}

// --- Page d'une room ---------------------------------------------------------------

export function RoomPage({ index, code, onCreate, onEdit }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((n) => n + 1);

  useEffect(() => {
    let alive = true;
    api.get(code)
      .then((result) => {
        if (!alive) return;
        setData(result);
        setError(null);
        const access = savedAccess(code);
        // Un jeton qui n'est plus reconnu (joueur retiré, lien d'hôte faux) est oublié.
        saveAccess(code, {
          title: result.room.title,
          admin: result.admin ? access.admin : null,
          player: result.me ? access.player : null,
          pseudo: result.me?.pseudo ?? null,
        });
      })
      .catch((e) => alive && setError(e));
    return () => { alive = false; };
  }, [code, tick]);

  // Rafraîchissement régulier tant que la page est visible : nouveaux joueurs, fermeture…
  useEffect(() => {
    const timer = setInterval(() => document.visibilityState === "visible" && refresh(), 30000);
    return () => clearInterval(timer);
  }, []);

  if (error && !data) {
    return html`<main class="home">
      <div class="notice error">${error.message}</div>
      ${error.status === 404 && savedAccess(code).title && html`<button type="button" class="ghost"
        onClick=${() => { forgetAccess(code); location.hash = "#/rooms"; }}>Oublier cette room</button>`}
      <a href="#/rooms">← Rooms</a>
    </main>`;
  }
  if (!data) return html`<main class="home"><p class="hint center">Chargement de la room…</p></main>`;

  const { room, me, admin, players } = data;
  const mine = me ? players.find((p) => p.id === me.id)?.slots || [] : [];
  const allSlots = players.flatMap((p) => p.slots);

  return html`<main class="room">
    <${RoomHeader} room=${room} players=${players} />
    ${room.ap_room_url && html`<${PlayPanel} room=${room} mine=${mine} />`}
    ${me
      ? html`<${MySlots} index=${index} room=${room} me=${me} slots=${mine} allSlots=${allSlots} refresh=${refresh} onCreate=${onCreate} onEdit=${onEdit} />`
      : html`<${JoinForm} room=${room} admin=${admin} refresh=${refresh} />`}
    <${PlayersList} room=${room} players=${players} me=${me} admin=${admin} refresh=${refresh} />
    ${admin && html`<${HostPanel} room=${room} setData=${setData} data=${data} />`}
  </main>`;
}

function RoomHeader({ room, players }) {
  const slots = players.reduce((n, p) => n + p.slots.length, 0);
  const closing = room.locked ? " · dépôts fermés par l'hôte"
    : room.closes_at == null ? ""
    : room.open ? ` · fermeture des dépôts le ${formatWhen(room.closes_at)} (${timeLeft(room.closes_at)})`
    : ` · dépôts fermés depuis le ${formatWhen(room.closes_at)}`;
  return html`<section class="card room-head">
    <div class="row">
      <h1 class="grow">${room.title}</h1>
      <span class="badge accent" title=${MODES[room.mode].text}>${MODES[room.mode].label}</span>
      ${room.open ? html`<span class="badge ok">Dépôts ouverts</span>` : html`<span class="badge danger">Dépôts fermés</span>`}
    </div>
    <div class="row">
      <span>Code : <strong class="room-code">${room.code}</strong></span>
      <${CopyButton} text=${inviteLink(room.code)} label="Copier le lien d'invitation" />
    </div>
    <p class="hint">
      ${plural(players.length, "joueur")} · ${slots} YAML · ${room.max_slots} YAML maximum par joueur${closing}
    </p>
    ${room.notes && html`<p class="room-notes">${room.notes}</p>`}
  </section>`;
}

function JoinForm({ room, admin, refresh }) {
  const [pseudo, setPseudo] = useState("");
  const join = useAction();
  const submit = (e) => {
    e.preventDefault();
    join.run(async () => {
      const result = await api.join(room.code, pseudo);
      saveAccess(room.code, { player: result.token, pseudo: result.player.pseudo });
      refresh();
    });
  };
  if (!room.open && !admin) {
    return html`<section class="card"><p>Les dépôts sont fermés : cette room n'accepte plus de nouveaux joueurs.</p></section>`;
  }
  return html`<form class="card stack" onSubmit=${submit}>
    <h2>${admin ? "Jouer aussi dans cette room" : "Rejoindre la room"}</h2>
    <div class="row full">
      <input type="text" class="grow" required maxLength="32" placeholder="Votre pseudo" value=${pseudo} onInput=${(e) => setPseudo(e.target.value)} />
      <button type="submit" disabled=${join.busy || !pseudo.trim()}>Rejoindre</button>
    </div>
    ${join.error && html`<div class="notice error full">${join.error}</div>`}
    <p class="hint">Déjà inscrit sur un autre appareil ? Ouvrez plutôt votre lien personnel.</p>
  </form>`;
}

// Un nom libre dans la room, à partir du pseudo (Archipelago limite les noms à 16 caractères).
function freeName(pseudo, slots) {
  const taken = new Set(slots.map((s) => s.name.toLowerCase()));
  const base = pseudo.replace(/[{}]/g, "").trim().slice(0, MAX_NAME).trim() || "Joueur";
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base.slice(0, MAX_NAME - String(n).length)}${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

function MySlots({ index, room, me, slots, allSlots, refresh, onCreate, onEdit }) {
  const action = useAction();
  const [hover, setHover] = useState(false);
  const [picking, setPicking] = useState(false);
  const [game, setGame] = useState("");
  const access = savedAccess(room.code);
  const full = slots.length >= room.max_slots;
  const canEdit = room.open || !!access.admin;

  // Chaque document du fichier devient un slot à part (un YAML par jeu, comme le veut Archipelago).
  const upload = (files) => action.run(async () => {
    const list = [...files].filter((f) => !/\.apworld$/i.test(f.name));
    const messages = [];
    let added = 0;
    for (const file of list) {
      const parts = splitFile(await file.text());
      for (const text of parts) {
        const check = await checkText(text);
        if (check.errors.length) { messages.push(`${file.name} : ${check.errors[0]}`); continue; }
        const doc = check.docs[0];
        const naming = nameProblem(doc.name);
        if (naming) { messages.push(`${file.name} : ${naming}`); continue; }
        try {
          await api.addSlot(room.code, {
            name: doc.name.trim(),
            game: doc.game,
            filename: parts.length > 1 ? `${doc.name.trim()}.yaml` : file.name,
            content: text,
            issues: [...doc.problems, ...doc.warnings],
          });
          added++;
        } catch (e) { messages.push(`${file.name} : ${e.message}`); }
      }
    }
    refresh();
    if (messages.length) throw new Error(`${added ? `${added} ajouté${added > 1 ? "s" : ""}, ` : ""}${plural(messages.length, "refusé")} : ${messages.join(" — ")}`);
  });

  const remove = (slot) => confirm(`Retirer le YAML « ${slot.name} » de la room ?`)
    && action.run(async () => { await api.deleteSlot(room.code, slot.id); refresh(); });
  const edit = (slot) => action.run(async () => onEdit(await api.getSlot(room.code, slot.id)));
  const save = (slot) => action.run(async () => {
    const yaml = await api.getSlot(room.code, slot.id);
    download(yaml.filename, yaml.content);
  });
  const leave = () => confirm("Quitter la room ? Vos YAML en seront retirés.")
    && action.run(async () => {
      await api.removePlayer(room.code, me.id);
      saveAccess(room.code, { player: null, pseudo: null });
      refresh();
    });

  return html`<section class="card stack">
    <div class="row full">
      <h2 class="grow">Vos YAML <span class="hint">(${me.pseudo} · ${slots.length}/${room.max_slots})</span></h2>
      <${CopyButton} text=${playerLink(room.code, access.player)} label="Lien personnel"
        className="ghost small" />
    </div>
    <p class="hint">Un fichier par jeu : chaque YAML est un joueur de la partie, avec son propre nom.
      Le lien personnel permet de reprendre depuis un autre appareil ; ne le partagez pas.</p>
    ${slots.length > 0 && html`<ul class="slot-list full">${slots.map((slot) => html`<li>
      <div class="grow"><strong>${slot.name}</strong> <span class="hint">${slot.game}</span> <${GameBadges} game=${slot.game} />
        <${IssueList} issues=${slot.issues} /></div>
      <button type="button" class="ghost small" disabled=${action.busy || !canEdit} onClick=${() => edit(slot)}>Modifier</button>
      <button type="button" class="ghost small" disabled=${action.busy} onClick=${() => save(slot)}>Télécharger</button>
      <button type="button" class="ghost small" disabled=${action.busy || !canEdit} onClick=${() => remove(slot)}>Retirer</button>
    </li>`)}</ul>`}
    ${canEdit && !full && html`<label class=${`drop compact full ${hover ? "hover" : ""} ${action.busy ? "busy" : ""}`}
      onDragOver=${(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave=${() => setHover(false)}
      onDrop=${(e) => { e.preventDefault(); setHover(false); upload(e.dataTransfer.files); }}>
      <input type="file" accept=".yaml,.yml,.txt" multiple hidden onChange=${(e) => { upload(e.target.files); e.target.value = ""; }} />
      <strong>${action.busy ? "Envoi…" : "Déposez un ou plusieurs YAML"}</strong>
      <span>ou cliquez pour les choisir</span>
    </label>`}
    ${canEdit && !full && html`<button type="button" class="ghost" onClick=${() => setPicking(true)}>Créer un YAML pour cette room</button>`}
    ${full && canEdit && html`<p class="hint">Limite atteinte : retirez un YAML pour en ajouter un autre.</p>`}
    ${!canEdit && html`<p class="hint">Les dépôts sont fermés : vos YAML ne peuvent plus être modifiés.</p>`}
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
    <button type="button" class="link" onClick=${leave}>Quitter la room</button>

    ${picking && html`<${PickerModal} index=${index} value=${game} onChange=${setGame} onClose=${() => setPicking(false)}
      onCreate=${(g) => onCreate(g, freeName(me.pseudo, allSlots))} />`}
  </section>`;
}

function PickerModal({ index, value, onChange, onClose, onCreate }) {
  const all = index.games;
  return html`<div class="modal" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal-box">
      <div class="toolbar-row"><strong>Choisir un jeu</strong><span class="spacer"></span>
        <button type="button" class="ghost" onClick=${onClose}>Fermer</button></div>
      <${GamePicker} core=${all.filter((g) => g.source === "core")} custom=${all.filter((g) => g.source !== "core")}
        imported=${localGames()} value=${value} onChange=${onChange} onCreate=${onCreate} />
    </div>
  </div>`;
}

function IssueList({ issues }) {
  if (!issues?.length) return null;
  return html`<details class="issues"><summary class="hint">${plural(issues.length, "remarque")}</summary>
    <ul>${issues.map((i) => html`<li>${i}</li>`)}</ul></details>`;
}

function PlayersList({ room, players, me, admin, refresh }) {
  const action = useAction();
  const kick = (player) => confirm(`Retirer ${player.pseudo} et ses YAML de la room ?`)
    && action.run(async () => { await api.removePlayer(room.code, player.id); refresh(); });
  const removeSlot = (slot) => confirm(`Retirer le YAML « ${slot.name} » ?`)
    && action.run(async () => { await api.deleteSlot(room.code, slot.id); refresh(); });

  return html`<section class="card stack">
    <h2>Joueurs et jeux</h2>
    ${players.length === 0 && html`<p class="hint">Personne n'a encore rejoint la room. Partagez le code !</p>`}
    ${players.length > 0 && html`<div class="table-wrap full"><table class="room-table">
      <thead><tr><th>Joueur</th><th>Nom dans la partie</th><th>Jeu</th>${admin && html`<th></th>`}</tr></thead>
      <tbody>${players.map((p) => (p.slots.length ? p.slots : [null]).map((slot, i) => html`<tr class=${i === 0 ? "first" : ""}>
        <td>${i === 0 && html`<strong>${p.pseudo}</strong>${me?.id === p.id && html` <span class="hint">(vous)</span>`}`}</td>
        <td>${slot ? slot.name : html`<span class="hint">aucun YAML</span>`}</td>
        <td>${slot && html`${slot.game} <${GameBadges} game=${slot.game} />`}</td>
        ${admin && html`<td class="actions">
          ${slot && html`<button type="button" class="icon" title="Retirer ce YAML" onClick=${() => removeSlot(slot)}>✕</button>`}
          ${i === 0 && html`<button type="button" class="link" onClick=${() => kick(p)}>Retirer le joueur</button>`}
        </td>`}
      </tr>`))}</tbody>
    </table></div>`}
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
  </section>`;
}

// --- Hôte --------------------------------------------------------------------------

function HostPanel({ room, setData, data }) {
  const save = useAction();
  const [form, setForm] = useState(null);
  const current = form || {
    title: room.title, mode: room.mode, closes: toInput(room.closes_at), max_slots: room.max_slots,
    notes: room.notes, locked: room.locked,
  };
  const set = (key, value) => setForm({ ...current, [key]: value });
  const changed = form !== null;

  const submit = (e) => {
    e.preventDefault();
    save.run(async () => {
      const result = await api.update(room.code, {
        title: current.title, mode: current.mode, closes_at: fromInput(current.closes),
        max_slots: Number(current.max_slots), notes: current.notes, locked: current.locked,
      });
      setData({ ...data, room: result.room });
      setForm(null);
    });
  };
  const close = (locked) => save.run(async () => {
    const result = await api.update(room.code, { locked });
    setData({ ...data, room: result.room });
    setForm(null);
  });
  const destroy = () => confirm("Supprimer définitivement la room et tous ses YAML ?")
    && save.run(async () => { await api.remove(room.code); forgetAccess(room.code); location.hash = "#/rooms"; });

  return html`<section class="card stack host">
    <div class="row full">
      <h2 class="grow">Espace de l'hôte</h2>
      <${CopyButton} text=${hostLink(room.code, savedAccess(room.code).admin)} label="Lien d'hôte" />
    </div>
    <p class="hint">Le lien d'hôte donne accès à cet espace depuis un autre appareil : gardez-le pour vous.</p>

    <details class="group full" open=${changed}>
      <summary>Réglages de la room</summary>
      <form class="group-body stack" onSubmit=${submit}>
        <div class="fields full">
          <label class="span-all"><span>Nom</span>
            <input type="text" maxLength="80" value=${current.title} onInput=${(e) => set("title", e.target.value)} /></label>
          <label><span>Type de partie</span>
            <select value=${current.mode} onChange=${(e) => set("mode", e.target.value)}>
              ${Object.entries(MODES).map(([k, m]) => html`<option value=${k}>${m.label}</option>`)}
            </select></label>
          <label><span>YAML par joueur (maximum)</span>
            <input type="number" min="1" max="20" value=${current.max_slots} onInput=${(e) => set("max_slots", e.target.value)} /></label>
          <label class="span-all"><span>Fin des dépôts</span>
            <input type="datetime-local" value=${current.closes} onInput=${(e) => set("closes", e.target.value)} /></label>
          <label class="span-all"><span>Message aux joueurs <span class="hint">(facultatif)</span></span>
            <textarea rows="3" maxLength="2000" value=${current.notes} onInput=${(e) => set("notes", e.target.value)}></textarea></label>
        </div>
        <div class="row">
          <button type="submit" disabled=${save.busy || !changed}>Enregistrer</button>
          ${changed && html`<button type="button" class="ghost" onClick=${() => setForm(null)}>Annuler</button>`}
        </div>
      </form>
    </details>

    <div class="row">
      ${room.locked
        ? html`<button type="button" class="ghost" disabled=${save.busy} onClick=${() => close(false)}>Rouvrir les dépôts</button>`
        : html`<button type="button" class="ghost" disabled=${save.busy} onClick=${() => close(true)}>Fermer les dépôts maintenant</button>`}
      <span class="hint">${room.locked ? "Fermée par vous." : room.closes_at ? `Fermeture automatique le ${formatWhen(room.closes_at)}.` : "Pas de date de fermeture."}</span>
    </div>
    ${save.error && html`<div class="notice error full">${save.error}</div>`}

    <${RoomCheck} room=${room} />
    <${Generation} room=${room} />
    <${HostedRoom} room=${room} setData=${setData} data=${data} />

    <button type="button" class="link danger-link" onClick=${destroy}>Supprimer la room</button>
  </section>`;
}

// Vérification de toute la room : chaque YAML (dans le navigateur de l'hôte) et les règles du type de partie.
async function checkRoom(room, players, slots) {
  const results = await Promise.all(slots.map(async (slot) => {
    const check = await checkText(slot.content);
    if (check.errors.length) return { slot, problems: check.errors, warnings: [], deathLink: false };
    const problems = [];
    if (check.docs.length > 1) problems.push("Plusieurs joueurs dans un même fichier : il faut un fichier par joueur.");
    const [doc] = check.docs;
    return { slot, problems: [...problems, ...doc.problems], warnings: doc.warnings, deathLink: doc.deathLink, games: doc.games };
  }));

  const notes = []; // { level: "error" | "warn" | "info", text }
  if (!slots.length) notes.push({ level: "error", text: "Aucun YAML dans la room." });
  if (room.open) notes.push({ level: "warn", text: "Les dépôts sont encore ouverts : fermez-les avant de générer, pour que plus rien ne change." });
  const empty = players.filter((p) => !p.slots.length).map((p) => p.pseudo);
  if (empty.length) {
    notes.push({
      level: room.mode === "sync" ? "warn" : "info",
      text: `Sans YAML : ${empty.join(", ")}.${room.mode === "sync" ? " En sync, tout le monde doit être prêt au lancement." : ""}`,
    });
  }
  const deathLink = results.filter((r) => r.deathLink).map((r) => r.slot.name);
  if (deathLink.length) {
    notes.push(room.mode === "async"
      ? { level: "warn", text: `DeathLink activé pour ${deathLink.join(", ")} : en async, chaque mort frappe les joueurs connectés à ce moment-là. À éviter, sauf accord de tous.` }
      : { level: "info", text: `DeathLink activé pour ${deathLink.join(", ")} : prévenez les autres joueurs.` });
  }
  const games = new Set(results.flatMap((r) => r.games || []));
  const unstable = [...games].filter((g) => gameEntry(g)?.sheet?.stability === "Unstable");
  if (unstable.length && room.mode === "async") {
    notes.push({ level: "warn", text: `Jeux instables : ${unstable.join(", ")}. Une partie async dure longtemps : un bug bloquant pèse sur tout le monde.` });
  }
  const adult = [...games].filter((g) => gameEntry(g)?.sheet?.adult);
  if (adult.length) notes.push({ level: "info", text: `Jeux 18+ : ${adult.join(", ")}.` });

  // Apworlds à installer chez l'hôte avant de générer.
  const credits = await loadCredits();
  const apworlds = [...games].filter((g) => gameEntry(g)?.source !== "core").sort().map((g) => ({
    game: g,
    source: credits.find((c) => c.game === g)?.source || null,
    known: !!gameEntry(g),
  }));
  return { results, notes, apworlds };
}

function RoomCheck({ room }) {
  const action = useAction();
  const [report, setReport] = useState(null);
  // Liste des joueurs relue au moment de vérifier : la page peut dater de quelques secondes.
  const run = () => action.run(async () => {
    const [{ slots }, fresh] = await Promise.all([api.exportSlots(room.code), api.get(room.code)]);
    setReport({ ...(await checkRoom(fresh.room, fresh.players, slots)), at: Date.now() });
  });
  const blocking = report ? report.results.filter((r) => r.problems.length).length + report.notes.filter((n) => n.level === "error").length : 0;
  const warnings = report ? report.results.filter((r) => r.warnings.length).length + report.notes.filter((n) => n.level === "warn").length : 0;

  return html`<div class="stack full">
    <div class="row">
      <h3 class="grow">1. Vérifier</h3>
      <button type="button" disabled=${action.busy} onClick=${run}>${action.busy ? "Vérification…" : report ? "Vérifier à nouveau" : "Vérifier la room"}</button>
    </div>
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
    ${report && html`
      <div class=${`notice full ${blocking ? "error" : warnings ? "warn" : "ok"}`}>
        ${blocking ? `${plural(blocking, "problème")} à régler avant de générer.`
          : warnings ? `Rien de bloquant, ${plural(warnings, "point")} à regarder.` : "Tout est en ordre."}
        <span class="hint"> Vérifié avec Archipelago ${apVersion()} ; générez avec la même version.</span>
      </div>
      ${report.notes.length > 0 && html`<ul class="check-notes full">${report.notes.map((n) => html`<li class=${n.level}>${n.text}</li>`)}</ul>`}
      <div class="table-wrap full"><table class="room-table">
        <thead><tr><th>Nom</th><th>Joueur</th><th>Jeu</th><th>État</th></tr></thead>
        <tbody>${report.results.map((r) => html`<tr>
          <td><strong>${r.slot.name}</strong></td>
          <td>${r.slot.pseudo}</td>
          <td>${r.slot.game}</td>
          <td>${!r.problems.length && !r.warnings.length
            ? html`<span class="badge ok">OK</span>`
            : html`<details class="issues"><summary>
                ${r.problems.length > 0 && html`<span class="badge danger">${plural(r.problems.length, "problème")}</span>`}
                ${r.warnings.length > 0 && html` <span class="badge warn">${plural(r.warnings.length, "remarque")}</span>`}
              </summary><ul>${[...r.problems, ...r.warnings].map((t) => html`<li>${t}</li>`)}</ul></details>`}</td>
        </tr>`)}</tbody>
      </table></div>
      ${report.apworlds.length > 0 && html`<div class="stack full">
        <p><strong>Apworlds à installer dans votre Archipelago</strong> (dossier <code>custom_worlds</code>) :</p>
        <ul class="small">${report.apworlds.map((a) => html`<li>${a.game}${" — "}${a.source ? html`<a href=${a.source} target="_blank" rel="noopener">${a.source.replace(/^https:\/\//, "")}</a>`
            : a.known ? "source inconnue" : "absent de la base du site, à demander au joueur"}</li>`)}</ul>
      </div>`}`}
  </div>`;
}

// Un nom de fichier par YAML, sans doublon, pour le dossier Players d'Archipelago.
function zipNames(slots) {
  const used = new Set();
  return slots.map((slot) => {
    const base = slot.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "joueur";
    let name = `${base}.yaml`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}.yaml`;
    used.add(name.toLowerCase());
    return { name, text: slot.content };
  });
}

function Generation({ room }) {
  const action = useAction();
  const downloadAll = () => action.run(async () => {
    const { slots } = await api.exportSlots(room.code);
    if (!slots.length) throw new Error("Aucun YAML à télécharger.");
    download(`room-${room.code}-yaml.zip`, makeZip(zipNames(slots)));
  });
  return html`<div class="stack full">
    <div class="row">
      <h3 class="grow">2. Générer</h3>
      <button type="button" disabled=${action.busy} onClick=${downloadAll}>Télécharger les YAML (.zip)</button>
    </div>
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
    <ol class="steps">
      <li>Dans votre dossier Archipelago, videz le dossier <code>Players</code> et décompressez-y le zip (un fichier par joueur).</li>
      <li>Installez les apworlds non officiels listés par la vérification (dossier <code>custom_worlds</code>).</li>
      <li>Lancez <strong>Generate</strong> depuis l'Archipelago Launcher. Le résultat est un fichier <code>.zip</code> dans le dossier <code>output</code>.</li>
      <li>${room.mode === "async"
        ? html`En async, vérifiez la section <code>server_options</code> de <code>host.yaml</code> avant de générer :
          <code>release_mode</code> et <code>collect_mode</code> à <code>auto</code> libèrent les objets d'un joueur qui a fini,
          pour ne bloquer personne. Ces réglages sont enregistrés dans la partie générée.`
        : html`Les réglages du serveur (indices, release, collect) sont ceux de la section <code>server_options</code> de <code>host.yaml</code> au moment de la génération.`}</li>
    </ol>
  </div>`;
}

function HostedRoom({ room, setData, data }) {
  const action = useAction();
  const [url, setUrl] = useState(room.ap_room_url || "");
  const save = (value) => action.run(async () => {
    const result = await api.update(room.code, { ap_room_url: value || null });
    setData({ ...data, room: result.room });
    setUrl(result.room.ap_room_url || "");
  });
  return html`<div class="stack full">
    <h3>3. Héberger</h3>
    <ol class="steps">
      <li>Envoyez le <code>.zip</code> généré sur <a href="https://archipelago.gg/uploads" target="_blank" rel="noopener">archipelago.gg/uploads</a>,
        puis cliquez sur <strong>Create New Room</strong>. Faites-le vous-même, dans ce navigateur : la console de la room
        (commandes <code>/release</code>, <code>/send</code>…) n'est disponible que pour celui qui a envoyé la partie.</li>
      <li>Collez ici le lien de la room : tous les joueurs verront l'adresse, le tracker et leurs fichiers.</li>
    </ol>
    <div class="row full">
      <input type="url" class="grow" placeholder="https://archipelago.gg/room/…" value=${url} onInput=${(e) => setUrl(e.target.value)} />
      <button type="button" disabled=${action.busy || url.trim() === (room.ap_room_url || "")} onClick=${() => save(url.trim())}>Enregistrer</button>
      ${room.ap_room_url && html`<button type="button" class="ghost" disabled=${action.busy} onClick=${() => save("")}>Retirer</button>`}
    </div>
    ${action.error && html`<div class="notice error full">${action.error}</div>`}
  </div>`;
}

// --- Partie en ligne -------------------------------------------------------------------

function PlayPanel({ room, mine }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [credits, setCredits] = useState([]);
  useEffect(() => {
    let alive = true;
    setError(null);
    apRoomStatus(room.ap_room_url).then((s) => alive && setStatus(s)).catch((e) => alive && setError(e.message));
    loadCredits().then((c) => alive && setCredits(c));
    return () => { alive = false; };
  }, [room.ap_room_url]);

  const names = new Set(mine.map((s) => s.name.toLowerCase()));
  const own = status ? status.slots.filter((s) => names.has(s.name.toLowerCase())) : [];
  const help = (game) => {
    if (gameEntry(game)?.source === "core") return { href: `${status.origin}/games/${encodeURIComponent(game)}/info/en`, label: "Page du jeu (installation)" };
    const source = credits.find((c) => c.game === game)?.source;
    return source ? { href: source, label: "Mod et client du jeu" } : null;
  };
  const address = status?.port ? `${status.host}:${status.port}` : null;

  return html`<section class="card stack play">
    <h2>La partie est en ligne</h2>
    <div class="row">
      <a class="button" href=${room.ap_room_url} target="_blank" rel="noopener">Page de la room</a>
      ${status?.tracker && html`<a class="button ghost" href=${status.tracker} target="_blank" rel="noopener">Tracker</a>`}
    </div>
    ${address
      ? html`<div class="row"><span>Adresse du serveur : <strong class="room-code">${address}</strong></span><${CopyButton} text=${address} /></div>`
      : status && html`<p class="hint">Le serveur est en veille : ouvrez la page de la room pour le réveiller, l'adresse s'affichera ensuite.</p>`}
    ${error && html`<div class="notice warn full">${error} Les liens ci-dessus restent valables.</div>`}
    ${own.length > 0 && html`<div class="stack full">
      <h3>Vos fichiers</h3>
      <ul class="slot-list full">${own.map((s) => {
        const link = help(s.game);
        return html`<li>
          <div class="grow"><strong>${s.name}</strong> <span class="hint">${s.game}</span></div>
          ${link && html`<a href=${link.href} target="_blank" rel="noopener" class="small">${link.label}</a>`}
          ${s.download
            ? html`<a class="button small" href=${s.download}>Télécharger le patch</a>`
            : html`<span class="hint small">Pas de fichier : connectez-vous avec le client du jeu.</span>`}
        </li>`;
      })}</ul>
    </div>`}
    ${status && html`<details class="group full">
      <summary>Tous les joueurs (${status.slots.length})</summary>
      <div class="group-body"><table class="room-table"><tbody>${status.slots.map((s) => html`<tr>
        <td>${s.slot}</td><td><strong>${s.name}</strong></td><td>${s.game}</td>
        <td>${s.download && html`<a href=${s.download}>Fichier</a>`}</td>
      </tr>`)}</tbody></table></div>
    </details>`}
  </section>`;
}
