// Exemple animé de l'accueil : quatre joueurs, quatre jeux. « Ouvrir un coffre » (ou toutes les quelques secondes,
// tant que l'exemple est à l'écran) fait un check chez un joueur : la pièce vole jusqu'au joueur dont c'est l'objet,
// une croix se tamponne sur son île, la ligne s'écrit dans le journal de bord et la notification des rooms
// (item-toasts.js) s'affiche. Tout est inventé et reste dans la page.
import { html, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { ItemToasts, KINDS } from "./item-toasts.js";
import { Chest, Cross, Flag, Ship } from "./art.js";

const PLAYERS = [
  { name: "Alex", game: "Hollow Knight", color: "#e0a526", items: ["Mantis Claw", "Monarch Wings", "Crystal Heart"], got: 92, all: 181 },
  { name: "Sam", game: "A Link to the Past", color: "#2f8f9d", items: ["Hookshot", "Pegasus Boots", "Moon Pearl"], got: 168, all: 216 },
  { name: "Lou", game: "Stardew Valley", color: "#5f9e4a", items: ["Progressive Hoe", "Greenhouse", "Golden Scythe"], got: 140, all: 240 },
  { name: "Max", game: "Ocarina of Time", color: "#c8553d", items: ["Megaton Hammer", "Fairy Ocarina", "Iron Boots"], got: 41, all: 196 },
];
const WEIGHTS = [["progression", 5], ["useful", 3], ["filler", 2]];
const FIRST_LOG = [
  { id: -1, from: 0, to: 1, item: "Hookshot", kind: "progression" },
  { id: -2, from: 2, to: 3, item: "Iron Boots", kind: "useful" },
  { id: -3, from: 1, to: 0, item: "Mantis Claw", kind: "progression" },
];
const AUTO = 6000;
const FLIGHT = { duration: 760, easing: "cubic-bezier(0.77, 0, 0.175, 1)" };
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function pickKind() {
  let r = Math.random() * WEIGHTS.reduce((n, [, w]) => n + w, 0);
  for (const [kind, w] of WEIGHTS) if ((r -= w) < 0) return kind;
  return "progression";
}

export function ChestDemo() {
  const [got, setGot] = useState(() => PLAYERS.map((p) => p.got));
  const [log, setLog] = useState(FIRST_LOG);
  const [toasts, setToasts] = useState([]);
  const section = useRef(null);
  const tiles = useRef(null);
  const flight = useRef(null);
  const lastFrom = useRef(-1);
  const nextId = useRef(0);
  const auto = useRef(0);
  const visible = useRef(false);

  // Centre d'un élément dans la zone des îles (où volent les pièces).
  const center = (node) => {
    const a = node.getBoundingClientRect(), b = tiles.current.getBoundingClientRect();
    return [a.left - b.left + a.width / 2, a.top - b.top + a.height / 2];
  };

  function stamp(to) {
    const tile = tiles.current.children[to];
    const cross = tile.querySelector(".demo-stamp");
    const still = { transform: "scale(1) rotate(-8deg)", opacity: 1 };
    if (reduced()) {
      cross.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1400 });
      return;
    }
    cross.animate([{ transform: "scale(1.8) rotate(-18deg)", opacity: 0 }, { ...still, offset: 0.16 }, { ...still, offset: 0.8 }, { ...still, opacity: 0 }],
      { duration: 1400, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
    tile.animate([{ transform: "translateY(0)" }, { transform: "translateY(2px)", offset: 0.12 }, { transform: "translateY(0)" }],
      { duration: 360, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
  }

  function send() {
    let from;
    do from = Math.floor(Math.random() * PLAYERS.length); while (from === lastFrom.current);
    let to;
    do to = Math.floor(Math.random() * PLAYERS.length); while (to === from);
    lastFrom.current = from;
    const id = nextId.current++;
    const entry = { id, from, to, item: pick(PLAYERS[to].items), kind: pickKind() };
    setGot((all) => all.map((n, i) => (i === from ? Math.min(PLAYERS[i].all, n + 1) : n)));
    const arrive = () => {
      stamp(to);
      setLog((all) => [entry, ...all].slice(0, 4));
      setToasts((all) => [...all, { id, receiver: PLAYERS[to].name, sender: PLAYERS[from].name, item: entry.item, kind: entry.kind }].slice(-3));
    };
    if (reduced()) { arrive(); return; }

    // La pièce part du drapeau de celui qui ouvre le coffre et monte en arc jusqu'au drapeau de celui qui reçoit,
    // suivie de quelques points d'or.
    const flags = tiles.current.querySelectorAll(".demo-flag");
    const [x1, y1] = center(flags[from]), [x2, y2] = center(flags[to]);
    const mx = (x1 + x2) / 2, my = Math.min(y1, y2) - Math.max(46, Math.abs(x2 - x1) * 0.35);
    const path = [
      { transform: `translate(${x1}px, ${y1}px) scale(.6)` },
      { transform: `translate(${mx}px, ${my}px) scale(1.15)`, offset: 0.5 },
      { transform: `translate(${x2}px, ${y2}px) scale(.85)` },
    ];
    for (let k = 1; k <= 4; k++) {
      const dot = document.createElement("div");
      dot.className = "demo-coin trail";
      flight.current.append(dot);
      dot.animate(path, { ...FLIGHT, delay: k * 45, fill: "both" }).onfinish = () => dot.remove();
    }
    const coin = document.createElement("div");
    coin.className = "demo-coin";
    coin.textContent = KINDS[entry.kind].mark;
    flight.current.append(coin);
    coin.animate(path, { ...FLIGHT, fill: "forwards" }).onfinish = () => { coin.remove(); arrive(); };
  }

  // Envoi automatique toutes les quelques secondes, seulement quand l'exemple est visible (et sans mouvement réduit).
  const restart = () => {
    clearInterval(auto.current);
    if (reduced()) return;
    auto.current = setInterval(() => visible.current && !document.hidden && send(), AUTO);
  };
  useEffect(() => {
    const watch = new IntersectionObserver(([e]) => { visible.current = e.isIntersecting; });
    watch.observe(section.current);
    restart();
    return () => { watch.disconnect(); clearInterval(auto.current); };
  }, []);

  return html`<section class="demo" ref=${section} aria-labelledby="exemple">
    <div class="demo-head">
      <div class="demo-intro">
        <h2 id="exemple">Un exemple, en direct</h2>
        <p>Quatre amis, quatre jeux. Ouvrez un coffre : l'objet qui en sort appartient souvent au jeu d'un autre joueur,
          qui le reçoit aussitôt.</p>
      </div>
      <button type="button" class="demo-open" onClick=${() => { send(); restart(); }}><${Chest} class="demo-chest" /> Ouvrir un coffre</button>
    </div>
    <div class="demo-grid">
      <div class="card demo-isles">
        <h3 class="demo-title">Les îles de la partie</h3>
        <div class="demo-tiles" ref=${tiles}>
          ${PLAYERS.map((p, i) => {
            const f = got[i] / p.all;
            return html`<div class="demo-tile" style=${`--pc: ${p.color}`}>
              <div class="demo-tile-head">
                <${Flag} class="demo-flag" />
                <span class="demo-name"><strong>${p.name}</strong><span>${p.game}</span></span>
              </div>
              <div class="demo-voyage">
                <span class="demo-count"><span>Checks</span><b>${got[i]} / ${p.all}</b></span>
                <span class="demo-route" role="img" aria-label=${`${Math.round(f * 100)} % des checks`}>
                  <span class="demo-route-done" style=${`transform: scaleX(${f})`}></span>
                  <span class="demo-route-ship" style=${`transform: translateX(${(f * 100).toFixed(2)}%)`}><${Ship} /></span>
                  <${Cross} class="demo-route-x" />
                </span>
              </div>
              <${Cross} class="demo-stamp" />
            </div>`;
          })}
          <div class="demo-flight" ref=${flight}></div>
        </div>
      </div>
      <div class="card demo-log">
        <h3 class="demo-title">Journal de bord</h3>
        <ol>${log.map((e) => html`<li key=${e.id}>
          <span class=${`item-kind ${e.kind}`}>${KINDS[e.kind].mark} ${KINDS[e.kind].label}</span>
          <span class="demo-who"><strong>${PLAYERS[e.from].name}</strong> → <strong>${PLAYERS[e.to].name}</strong> : <strong class="demo-item">${e.item}</strong></span>
        </li>`)}</ol>
      </div>
    </div>
    <p class="hint">Exemple fictif. Dans une vraie partie, le serveur d'Archipelago fait ce travail de facteur, et la page de
      votre room affiche les mêmes notifications quand vos joueurs reçoivent un objet.</p>
    <${ItemToasts} toasts=${toasts} dismiss=${(id) => setToasts((all) => all.filter((t) => t.id !== id))} />
  </section>`;
}
