// Logique du jeu à la manière d'Universal Tracker : la génération du jeu du joueur est refaite dans le
// navigateur (Archipelago dans Pyodide, voir ut-worker.js et py/ut_core.py) pour savoir quels lieux
// restants sont en logique avec les objets reçus. Données de la partie : la session de tracker-ap.js.
import { useState, useEffect, useRef } from "../vendor/preact-htm.js";
import { gameEntry, apworldFileOf } from "./data.js";
import { loadCredits } from "./ui.js";
import { fetchRelease } from "./trackers.js";
import { api, savedAccess } from "./rooms-api.js";

let worker = null;
let nextId = 0;

function ask(message, transfer = [], onStatus) {
  worker ??= new Worker(new URL("./ut-worker.js", import.meta.url));
  const w = worker;
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.status) { onStatus?.(data.status); return; }
      w.removeEventListener("message", onMessage);
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", () => {
      w.removeEventListener("message", onMessage);
      if (worker === w) worker = null;
      reject(new Error("Python n'a pas pu démarrer dans le navigateur (connexion internet nécessaire la première fois)."));
    }, { once: true });
    w.postMessage({ id, ...message }, transfer);
  });
}

// Code du jeu : apworld déposé dans ce navigateur, sinon jeu officiel publié avec le site (data/worlds/),
// sinon release de l'auteur (adresse relevée dans les crédits), téléchargée par le relais des packs.
async function worldSource(game) {
  const local = await apworldFileOf(game);
  if (local) return { kind: "apworld", name: local.name, bytes: await local.blob.arrayBuffer() };
  if (gameEntry(game)?.source === "core") {
    const index = await fetch("data/worlds/index.json").then((r) => (r.ok ? r.json() : {}), () => ({}));
    if (index[game]) {
      const response = await fetch(`data/worlds/${index[game]}`);
      if (response.ok) return { kind: "core", bytes: await response.arrayBuffer() };
    }
    throw new Error(`Le code de ${game} n'est pas publié avec ce site.`);
  }
  const credit = (await loadCredits()).find((c) => c.game === game);
  if (credit?.download && /\.apworld$/i.test(credit.download)) {
    const bytes = await fetchRelease(credit.download, "l'apworld");
    return { kind: "apworld", name: credit.file || credit.download.split("/").pop(), bytes };
  }
  throw new Error(`Apworld de ${game} introuvable : déposez-le sur la page d'accueil, puis revenez ici.`);
}

// YAML du joueur dans sa room (lisible par son propriétaire et par l'hôte), ou null.
export async function roomYaml(code, slotName, game) {
  if (!code || !savedAccess(code)) return null;
  try {
    const room = await api.get(code);
    const slots = (room.players || []).flatMap((p) => p.slots || []);
    const wanted = slotName.toLowerCase();
    const slot = slots.find((s) => s.name.toLowerCase() === wanted && s.game === game);
    if (!slot) return null;
    return (await api.getSlot(code, slot.id)).content || null;
  } catch {
    return null;
  }
}

// État de la logique pour une session connectée : { status, error, result: { logic, glitched, regions, errors } }.
// `yaml` : texte du YAML du joueur (null : sans YAML, pour les jeux qui le permettent).
export function useLogic(session, yaml, enabled) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const regions = useRef({});
  useEffect(() => {
    if (!enabled || !session?.connected) return undefined;
    let alive = true;
    let timer = null;
    let ready = false;
    setError(null);
    setResult(null);
    const update = () => {
      if (!ready) return;
      clearTimeout(timer);
      // Plusieurs objets arrivent souvent d'un coup : un seul calcul.
      timer = setTimeout(() => {
        const items = session.items.filter(Boolean).map((it) => [it.item, it.flags || 0]);
        ask({ cmd: "update", items, missing: [...session.missing] })
          .then((r) => alive && setResult({ ...r, regions: regions.current }))
          .catch((e) => alive && setError(e.message));
      }, 150);
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "items" || event.type === "checked") update();
    });
    (async () => {
      try {
        setStatus("Téléchargement du code du jeu…");
        const world = await worldSource(session.game);
        const generated = await ask(
          { cmd: "load", world, game: session.game, slot: session.slotName, yaml, slotData: session.slotData },
          [world.bytes], (text) => alive && setStatus(text),
        );
        regions.current = generated.regions;
        ready = true;
        update();
      } catch (e) {
        if (alive) setError(e.message);
      } finally {
        if (alive) setStatus(null);
      }
    })();
    return () => { alive = false; clearTimeout(timer); unsubscribe(); };
  }, [session, yaml, enabled]);
  return { status, error, result };
}
