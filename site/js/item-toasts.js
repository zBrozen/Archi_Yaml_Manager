// Notifications « bouteille à la mer » de la page d'une room : un objet reçu par l'un de vos joueurs (ou par n'importe
// quel joueur, selon le réglage) s'affiche en bas à droite. Source : le tracker d'archipelago.gg, déjà lu par la page
// toutes les minutes (useTracker) ; rien ne se connecte à la partie. À l'ouverture de la page, les objets déjà reçus
// servent de point de départ et ne sont pas annoncés.
import { html, useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { receivedItems, usePackages, wishIndex } from "./room-live.js";
import { Bottle } from "./art.js";

// Réglage mémorisé dans ce navigateur : qui suivre, et les objets sans importance ou non.
export const TOAST_DEFAULTS = { who: "mine", filler: false };
const SHOWN = 3; // au-delà, les objets arrivés ensemble tiennent dans une dernière notification
const LIFE = 8000; // durée d'affichage, en pause tant que la souris ou le clavier est dessus

// Drapeaux d'un objet (NetworkItem) : progression 1, utile 2, piège 4. Le symbole double la couleur.
const KINDS = {
  progression: { label: "Progression", mark: "★" },
  useful: { label: "Utile", mark: "◆" },
  trap: { label: "Piège", mark: "⚠" },
  filler: { label: "Sans importance", mark: "●" },
};
const kindOf = (flags) => (flags & 1 ? "progression" : flags & 4 ? "trap" : flags & 2 ? "useful" : "filler");

let nextId = 0;

export function useItemToasts(status, tracker, mine, wishlists, prefs) {
  const [toasts, setToasts] = useState([]);
  const seen = useRef(new Map()); // numéro de slot → objets déjà vus
  const names = new Set(mine.map((m) => m.name.toLowerCase()));
  const watched = !status || prefs.who === "off" ? []
    : status.slots.filter((s) => prefs.who === "all" || names.has(s.name.toLowerCase()));
  const games = [...new Set(watched.map((s) => s.game))].sort();
  const { loaded } = usePackages(status?.origin, tracker.data?.fixed, games);
  const live = tracker.data?.live;

  useEffect(() => {
    if (!live) return;
    const wishes = wishIndex(wishlists);
    const fresh = [];
    for (const slot of watched) {
      const items = receivedItems(live, slot.slot);
      const before = seen.current.get(slot.slot);
      if (before === undefined || items.length < before) { seen.current.set(slot.slot, items.length); continue; }
      if (items.length === before) continue;
      const pkg = loaded[slot.game];
      if (!pkg) continue; // noms pas encore chargés : annoncés au prochain passage
      seen.current.set(slot.slot, items.length);
      for (const i of items.slice(before)) {
        const name = pkg.items.get(i.item) || `Objet n° ${i.item}`;
        const wished = !!wishes.get(slot.name.toLowerCase())?.has(name);
        const kind = kindOf(i.flags);
        if (kind === "filler" && !prefs.filler && !wished) continue;
        const sender = i.player === slot.slot ? null : status.slots.find((s) => s.slot === i.player)?.name || `Joueur ${i.player}`;
        fresh.push({ id: nextId++, receiver: slot.name, item: name, sender, kind, wished });
      }
    }
    if (!fresh.length) return;
    // Beaucoup d'objets d'un coup (retour sur la page, release…) : les premiers, puis un résumé.
    // (le résumé compte toujours au moins deux objets)
    const shown = fresh.length > SHOWN ? [...fresh.slice(0, SHOWN - 1), { id: nextId++, more: fresh.length - SHOWN + 1 }] : fresh;
    setToasts((all) => [...all, ...shown].slice(-SHOWN));
  }, [live, loaded, prefs.who, prefs.filler, watched.length]);

  const dismiss = (id) => setToasts((all) => all.filter((t) => t.id !== id));
  return { toasts, dismiss };
}

function Toast({ toast, onDone }) {
  const [leaving, setLeaving] = useState(false);
  const left = useRef(LIFE);
  const timer = useRef(0);
  const started = useRef(0);
  const leave = () => { clearTimeout(timer.current); timer.current = -1; setLeaving(true); setTimeout(onDone, 200); };
  // Souris et clavier peuvent tous deux mettre en pause : un seul minuteur à la fois.
  const resume = () => { if (timer.current) return; started.current = Date.now(); timer.current = setTimeout(leave, Math.max(1500, left.current)); };
  const pause = () => {
    if (timer.current <= 0) return; // pas de minuteur, ou notification déjà en train de partir
    clearTimeout(timer.current); timer.current = 0; left.current -= Date.now() - started.current;
  };
  const ref = useRef(null);
  useEffect(() => {
    resume();
    // focusin / focusout remontent depuis le bouton Fermer (Preact ne les relie pas sous ces noms).
    const node = ref.current;
    node.addEventListener("focusin", pause);
    node.addEventListener("focusout", resume);
    return () => { clearTimeout(timer.current); node.removeEventListener("focusin", pause); node.removeEventListener("focusout", resume); };
  }, []);

  const kind = toast.kind && KINDS[toast.kind];
  return html`<div class=${`item-toast ${leaving ? "out" : ""}`} ref=${ref}
    onMouseEnter=${pause} onMouseLeave=${resume}>
    <${Bottle} class="item-toast-icon" />
    ${toast.more
      ? html`<p class="item-toast-text"><strong>Et ${toast.more} autres objets reçus</strong>
          <span class="hint">Détail dans l'onglet Progression.</span></p>`
      : html`<p class="item-toast-text">
          <strong>${toast.receiver} reçoit ${toast.item}</strong>
          <span class="item-toast-meta">
            <span class=${`item-kind ${toast.kind}`}>${kind.mark} ${kind.label}</span>
            ${toast.wished && html`<span class="item-kind wished">♥ Wishlist</span>`}
            <span class="hint">${toast.sender ? `de ${toast.sender}` : "trouvé dans son propre jeu"}</span>
          </span>
        </p>`}
    <button type="button" class="icon item-toast-close" aria-label="Fermer la notification" onClick=${leave}>✕</button>
  </div>`;
}

export function ItemToasts({ toasts, dismiss }) {
  return html`<div class="item-toasts" role="status" aria-live="polite">
    ${toasts.map((t) => html`<${Toast} key=${t.id} toast=${t} onDone=${() => dismiss(t.id)} />`)}
  </div>`;
}

// Réglage, dans l'onglet Progression de la room.
export function ToastSettings({ prefs, setPrefs, mine }) {
  const choices = [["mine", "Vos joueurs"], ["all", "Tous les joueurs"], ["off", "Aucune"]];
  return html`<div class="toast-settings stack full">
    <div class="row">
      <span id="toast-who"><strong>Notifications d'objets reçus</strong></span>
      <div class="segmented" role="group" aria-labelledby="toast-who">${choices.map(([id, label]) => html`<button type="button"
        class=${prefs.who === id ? "active" : ""} aria-pressed=${prefs.who === id} onClick=${() => setPrefs({ ...prefs, who: id })}>${label}</button>`)}
      </div>
      ${prefs.who !== "off" && html`<label class="check"><input type="checkbox" checked=${prefs.filler}
        onChange=${(e) => setPrefs({ ...prefs, filler: e.target.checked })} /> Objets sans importance</label>`}
    </div>
    <p class="hint">En bas à droite de la page, d'après le tracker d'archipelago.gg, relu chaque minute : un objet peut s'afficher
      jusqu'à une minute après son arrivée.${prefs.who === "mine" && !mine.length ? " Vous n'avez pas de joueur dans cette partie : choisissez « Tous les joueurs » pour en recevoir." : ""}</p>
  </div>`;
}
