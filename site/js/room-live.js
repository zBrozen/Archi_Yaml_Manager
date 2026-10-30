// Partie en cours sur archipelago.gg : progression de chaque joueur (API publique du tracker) et client texte
// dans le navigateur (archipelago.js), pour le chat et les commandes !hint, !remaining… sans lancer Archipelago.
import { html, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { Client } from "../vendor/archipelago.js";
import { api, apRoomStatus } from "./rooms-api.js";

const STATUS = {
  0: { label: "Hors ligne", cls: "" },
  5: { label: "Connecté", cls: "accent" },
  10: { label: "Prêt", cls: "accent" },
  20: { label: "En jeu", cls: "accent" },
  30: { label: "Terminé", cls: "ok" },
};
const IDLE_WARNING = 48 * 3600 * 1000; // en async, joueur sans activité depuis 2 jours

function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

const bySlot = (list, key) => new Map((list || []).filter((e) => e.team === 0).map((e) => [e.player, e[key]]));

// --- Progression -------------------------------------------------------------------

export function ProgressPanel({ status, mode, mine }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const trackerId = status.trackerId;

  useEffect(() => {
    if (!trackerId) return;
    let alive = true;
    const base = `${status.origin}/api`;
    const get = (path) => fetch(`${base}/${path}/${trackerId}`).then((r) => {
      if (!r.ok) throw new Error(`Tracker indisponible (${r.status}).`);
      return r.json();
    });
    const totals = get("static_tracker");
    const load = () => Promise.all([get("tracker"), totals])
      .then(([live, fixed]) => alive && (setData({ live, fixed }), setError(null)))
      .catch((e) => alive && setError(e.message));
    load();
    // Le tracker d'archipelago.gg est mis en cache une minute : inutile de demander plus souvent.
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 60000);
    return () => { alive = false; clearInterval(timer); };
  }, [trackerId]);

  if (!trackerId) return null;
  if (error && !data) return html`<p class="hint">${error}</p>`;
  if (!data) return html`<p class="hint">Chargement de la progression…</p>`;

  const done = bySlot(data.live.player_checks_done, "locations");
  const states = bySlot(data.live.player_status, "status");
  const activity = bySlot(data.live.activity_timers, "time");
  const connection = bySlot(data.live.connection_timers, "time");
  const hints = bySlot(data.live.hints, "hints");
  const totals = bySlot(data.fixed.player_locations_total, "total_locations");
  const names = new Set(mine.map((s) => s.name.toLowerCase()));
  const rows = status.slots.filter((s) => totals.has(s.slot)).map((s) => {
    const last = activity.get(s.slot) || connection.get(s.slot);
    return {
      ...s,
      checks: done.get(s.slot)?.length || 0,
      total: totals.get(s.slot) || 0,
      state: STATUS[states.get(s.slot)] || STATUS[0],
      finished: states.get(s.slot) === 30,
      last: last ? Date.parse(last) : null,
      hints: hints.get(s.slot)?.length || 0,
      mine: names.has(s.name.toLowerCase()),
    };
  });
  const sum = rows.reduce((n, r) => n + r.checks, 0);
  const all = rows.reduce((n, r) => n + r.total, 0);
  const finished = rows.filter((r) => r.finished).length;
  const pct = (a, b) => (b ? Math.floor((a / b) * 100) : 0);

  return html`<div class="stack full">
    <div class="row full">
      <h3 class="grow">Progression</h3>
      <span class="hint">${sum} / ${all} checks (${pct(sum, all)} %) · ${finished} / ${rows.length} terminé${finished > 1 ? "s" : ""}</span>
    </div>
    <div class="progress full" title=${`${pct(sum, all)} %`}><span style=${`width: ${pct(sum, all)}%`}></span></div>
    <div class="table-wrap full"><table class="room-table progress-table">
      <thead><tr><th>Joueur</th><th>Jeu</th><th>Checks</th><th>État</th><th>Dernière activité</th></tr></thead>
      <tbody>${rows.map((r) => {
        const idle = mode === "async" && !r.finished && r.last && Date.now() - r.last > IDLE_WARNING;
        return html`<tr class=${r.mine ? "mine" : ""}>
          <td><strong>${r.name}</strong>${r.tracker && html` <a href=${r.tracker} target="_blank" rel="noopener" class="small">tracker</a>`}</td>
          <td>${r.game}</td>
          <td class="checks">
            <div class="progress small" title=${`${pct(r.checks, r.total)} %`}><span class=${r.finished ? "ok" : ""} style=${`width: ${pct(r.checks, r.total)}%`}></span></div>
            <span class="hint">${r.checks} / ${r.total}${r.hints ? ` · ${r.hints} indice${r.hints > 1 ? "s" : ""}` : ""}</span>
          </td>
          <td><span class=${`badge ${r.state.cls}`}>${r.state.label}</span></td>
          <td>${r.last ? html`<span class=${idle ? "badge warn" : "hint"}>${ago(r.last)}</span>` : html`<span class="hint">jamais</span>`}</td>
        </tr>`;
      })}</tbody>
    </table></div>
    ${error && html`<p class="hint">${error} Dernières données affichées.</p>`}
  </div>`;
}

// --- Client texte ------------------------------------------------------------------

const QUICK = [
  { text: "!hint ", label: "!hint", title: "Demander un indice : complétez avec le nom d'un objet", fill: true },
  { text: "!remaining", label: "!remaining", title: "Objets qu'il vous reste à recevoir" },
  { text: "!release", label: "!release", title: "Envoyer vos objets restants aux autres (selon les réglages de la partie)",
    confirm: "Envoyer à tous les autres joueurs les objets qui restent dans votre monde ? C'est définitif." },
  { text: "!collect", label: "!collect", title: "Récupérer vos objets chez les autres (selon les réglages de la partie)" },
  { text: "!help", label: "!help", title: "Liste des commandes" },
];

function MessagePart({ node, self }) {
  if (node.type === "player") {
    return html`<span class=${`msg-player ${node.text === self ? "self" : ""}`}>${node.text}</span>`;
  }
  if (node.type === "item") {
    const item = node.item;
    const cls = item.progression ? "progression" : item.useful ? "useful" : item.trap ? "trap" : "filler";
    return html`<span class=${`msg-item ${cls}`}>${node.text}</span>`;
  }
  if (node.type === "location") return html`<span class="msg-location">${node.text}</span>`;
  if (node.type === "color" && /red/.test(node.color)) return html`<span class="error">${node.text}</span>`;
  if (node.type === "color" && /green/.test(node.color)) return html`<span class="msg-ok">${node.text}</span>`;
  return node.text;
}

export function TextClient({ room, status, mine }) {
  const own = status.slots.filter((s) => mine.some((m) => m.name.toLowerCase() === s.name.toLowerCase()));
  const [slot, setSlot] = useState((own[0] || status.slots[0])?.name || "");
  const [password, setPassword] = useState("");
  const [state, setState] = useState("idle"); // idle, connecting, connected, closed
  const [error, setError] = useState(null);
  const [lines, setLines] = useState([]);
  const [input, setInput] = useState("");
  const client = useRef(null);
  const log = useRef(null);
  const nextId = useRef(0);

  const push = (line) => setLines((all) => [...all.slice(-499), { id: nextId.current++, ...line }]);
  useEffect(() => () => client.current?.socket.disconnect(), []);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [lines]);

  const connect = async () => {
    setState("connecting");
    setError(null);
    try {
      // Lire la page de la room (par le service) réveille le serveur s'il est en veille ; le port peut alors changer.
      await api.apLinks(room.code).catch(() => {});
      const fresh = await apRoomStatus(room.code, room.ap_room_url);
      if (!fresh.port) throw new Error("Le serveur de la partie ne répond pas encore : réessayez dans quelques secondes.");
      const next = new Client();
      next.messages.on("message", (text, nodes) => push({ nodes }));
      next.socket.on("disconnected", () => { if (client.current === next) setState("closed"); });
      client.current = next;
      push({ info: `Connexion à ${fresh.host}:${fresh.port} en tant que ${slot}…` });
      await next.login(`wss://${fresh.host}:${fresh.port}`, slot, undefined, { password, slotData: false, tags: ["TextOnly"] });
      setState("connected");
    } catch (e) {
      client.current?.socket.disconnect();
      client.current = null;
      setState("idle");
      setError(e?.message || String(e));
    }
  };
  const disconnect = () => {
    const current = client.current;
    client.current = null;
    current?.socket.disconnect();
    setState("closed");
    push({ info: "Déconnecté." });
  };
  const send = async (text) => {
    const message = text.trim();
    if (!message || state !== "connected") return;
    setInput("");
    try { await client.current.messages.say(message); } catch (e) { setError(e?.message || String(e)); }
  };

  const connected = state === "connected";
  return html`<div class="stack full text-client">
    <p class="hint">Chat et commandes de la partie (<code>!hint</code>, <code>!remaining</code>…), sans lancer Archipelago.
      Vous apparaissez dans la partie comme un client texte de ce joueur : les autres voient « a rejoint » et « est parti ».</p>
    ${!connected && html`<div class="row full">
      <select class="grow" value=${slot} disabled=${state === "connecting"} onChange=${(e) => setSlot(e.target.value)}>
        ${own.length > 0 && html`<optgroup label="Vos joueurs">${own.map((s) => html`<option value=${s.name}>${s.name} (${s.game})</option>`)}</optgroup>`}
        <optgroup label=${own.length ? "Autres joueurs" : "Joueurs"}>${status.slots.filter((s) => !own.includes(s))
          .map((s) => html`<option value=${s.name}>${s.name} (${s.game})</option>`)}</optgroup>
      </select>
      <input type="text" class="grow" placeholder="Mot de passe (si la partie en a un)" value=${password}
        onInput=${(e) => setPassword(e.target.value)} autocomplete="off" />
      <button type="button" disabled=${state === "connecting" || !slot} onClick=${connect}>
        ${state === "connecting" ? "Connexion…" : state === "closed" ? "Se reconnecter" : "Se connecter"}</button>
    </div>`}
    ${error && html`<div class="notice error full">${error}</div>`}
    ${lines.length > 0 && html`<div class="client-log full" ref=${log} role="log" aria-live="polite">
      ${lines.map((line) => html`<div key=${line.id} class=${line.info ? "hint" : ""}>
        ${line.info || line.nodes.map((node) => html`<${MessagePart} node=${node} self=${slot} />`)}</div>`)}
    </div>`}
    ${connected && html`<form class="row full" onSubmit=${(e) => { e.preventDefault(); send(input); }}>
      <input type="text" class="grow" placeholder="Message ou commande (!hint objet…)" value=${input}
        onInput=${(e) => setInput(e.target.value)} />
      <button type="submit" disabled=${!input.trim()}>Envoyer</button>
      <button type="button" class="ghost" onClick=${disconnect}>Se déconnecter</button>
    </form>
    <div class="chips-row">${QUICK.map((q) => html`<button type="button" class="chip-btn" title=${q.title}
      onClick=${() => (q.fill ? setInput(q.text) : (!q.confirm || confirm(q.confirm)) && send(q.text))}>${q.label}</button>`)}</div>`}
  </div>`;
}
