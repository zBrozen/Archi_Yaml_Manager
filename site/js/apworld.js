// Lecture d'un apworld : Archipelago s'exécute dans un worker (voir apworld-worker.js).
import { useState } from "../vendor/preact-htm.js";
import { registerLocalGame } from "./data.js";

let worker = null;
let nextId = 0;

function getWorker() {
  if (!worker) worker = new Worker(new URL("./apworld-worker.js", import.meta.url));
  return worker;
}

export function readApworld(file, onStatus) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const w = getWorker();
    const cleanup = () => {
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
    };
    const onMessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.status) { onStatus?.(data.status); return; }
      cleanup();
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    };
    const onError = () => {
      cleanup();
      worker = null;
      reject(new Error("Python n'a pas pu démarrer dans le navigateur (connexion internet nécessaire la première fois)."));
    };
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    file.arrayBuffer().then((bytes) => w.postMessage({ id, bytes }, [bytes]), reject);
  });
}

// État d'un chargement d'apworld pour l'interface : { status, error, load(file) }.
// `load` renvoie la liste des jeux ajoutés (vide en cas d'échec).
export function useApworldLoader() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const load = async (file, expected) => {
    if (!/\.apworld$/i.test(file.name)) {
      setError("Il faut un fichier .apworld.");
      return [];
    }
    setError(null);
    setStatus("Préparation…");
    try {
      const result = await readApworld(file, setStatus);
      result.games.forEach(registerLocalGame);
      const names = result.games.map((g) => g.game);
      const failures = Object.values(result.errors);
      if (!names.length) {
        setError(failures.length ? `Cet apworld n'a pas pu être chargé : ${failures.join(" ; ")}` : "Aucun jeu trouvé dans cet apworld.");
      } else if (expected && !names.includes(expected)) {
        setError(`Cet apworld est celui de « ${names.join(", ")} », pas de « ${expected} ».`);
      }
      return names;
    } catch (e) {
      setError(e.message);
      return [];
    } finally {
      setStatus(null);
    }
  };
  return { status, error, load };
}
