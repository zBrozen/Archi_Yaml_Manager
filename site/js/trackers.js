// Liste des packs PopTracker connus (site/data/trackers.json, relevés par tools/fetch_trackers.py) et liens
// vers la page du tracker. Module léger : la page elle-même (tracker-view.js, avec Lua) se charge à part.
import { useState, useEffect } from "../vendor/preact-htm.js";
import { ROOMS_API } from "./config.js";

// Même règle que normalize() dans tools/fetch_apworlds.py : le tableur et Archipelago écrivent parfois
// le nom d'un jeu autrement (accents, ponctuation).
export const normalize = (name) => String(name || "").normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

let index = null;
export function loadTrackers() {
  index ??= fetch("data/trackers.json")
    .then((r) => (r.ok ? r.json() : { games: {} }))
    .catch(() => ({ games: {} }));
  return index;
}

export function useTrackers() {
  const [data, setData] = useState(null);
  useEffect(() => { loadTrackers().then(setData); }, []);
  return data;
}

// Packs d'un jeu d'Archipelago : [{ repo, page, tag, asset, url }] (url absente : pas de release .zip).
export function packsFor(data, game) {
  const wanted = normalize(game);
  if (!wanted) return [];
  for (const [name, packs] of Object.entries(data?.games || {})) if (normalize(name) === wanted) return packs;
  return [];
}

export function trackerLink({ game, server, slot, room } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ game, server, slot, room })) if (value) params.set(key, value);
  return `#/tracker?${params}`;
}

// Release GitHub (pack PopTracker, apworld) téléchargée par le relais du service des rooms : GitHub ne permet
// pas au navigateur de la lire depuis une autre adresse. Une autre adresse est lue directement.
export async function fetchRelease(url, what = "le pack") {
  const direct = !/^https:\/\/github\.com\//i.test(url);
  if (!direct && !ROOMS_API) throw new Error("Le relais des téléchargements (service des rooms) n'est pas configuré sur ce site.");
  let response;
  try {
    response = await fetch(direct ? url : `${ROOMS_API}/api/packs?url=${encodeURIComponent(url)}`);
  } catch {
    throw new Error(direct ? `Impossible de télécharger ${what}.` : "Le relais des téléchargements ne répond pas : réessayez dans un moment.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || `Téléchargement de ${what} impossible (${response.status}).`);
  }
  return response.arrayBuffer();
}
