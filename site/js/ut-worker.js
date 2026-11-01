// Worker du tracker de logique (à la manière d'Universal Tracker) : Archipelago tourne dans Pyodide et
// refait la génération du jeu du joueur (voir py/ut_core.py), sans bloquer la page.
// Messages reçus : { id, cmd: "load", world, game, slot, yaml, slotData } puis { id, cmd: "update", items, missing } ;
// envoyés : { id, status } puis { id, result } ou { id, error }.
// `world` : { kind: "core", bytes } (dossier du jeu officiel, zippé) ou { kind: "apworld", name, bytes }.
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
importScripts(`${PYODIDE}pyodide.js`);

let python = null;

async function start(id) {
  const status = (text) => postMessage({ id, status: text });
  status("Téléchargement de Python (une seule fois, environ 15 Mo)…");
  const py = await loadPyodide({ indexURL: PYODIDE });
  status("Installation des modules Python…");
  await py.loadPackage(["pyyaml", "jinja2", "ssl", "setuptools"]);
  status("Chargement d'Archipelago…");
  // GitHub Pages répond parfois 503 un court instant (pendant une publication) : on relance deux fois.
  const get = async (path) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(new URL(path, self.location));
      if (response.ok) return response;
      if (response.status < 500 || attempt >= 2) throw new Error(`${path} introuvable (${response.status})`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  };
  const [core, entry, extract, ut] = await Promise.all([
    get("../data/ap-core.zip"), get("../py/browser_entry.py"), get("../py/ap_extract.py"), get("../py/ut_core.py"),
  ]);
  py.unpackArchive(await core.arrayBuffer(), "zip", { extractDir: "/ap" });
  py.FS.writeFile("/ap/browser_entry.py", await entry.text());
  py.FS.writeFile("/ap/ap_extract.py", await extract.text());
  py.FS.writeFile("/ap/ut_core.py", await ut.text());
  py.runPython("import sys\nsys.path.insert(0, '/ap')\nimport browser_entry\nbrowser_entry.setup()");
  return py;
}

function call(py, name, ...args) {
  const module = py.pyimport("ut_core");
  const fn = module[name];
  try {
    return JSON.parse(fn(...args));
  } finally {
    fn.destroy();
    module.destroy();
  }
}

async function load(py, id, { world, game, slot, yaml, slotData }) {
  postMessage({ id, status: `Chargement du jeu ${game}…` });
  if (world.kind === "core") {
    py.unpackArchive(world.bytes, "zip", { extractDir: "/ap/worlds" });
  } else {
    for (const old of py.FS.readdir("/ap/custom_worlds")) if (old.endsWith(".apworld")) py.FS.unlink(`/ap/custom_worlds/${old}`);
    py.FS.writeFile(`/ap/custom_worlds/${world.name}`, new Uint8Array(world.bytes));
  }
  const loaded = call(py, "reload_worlds");
  if (!loaded.games.includes(game)) {
    throw new Error(loaded.failed[game] ? `Le jeu ${game} n'a pas pu être chargé : ${loaded.failed[game]}` : `Le jeu ${game} est introuvable.`);
  }
  postMessage({ id, status: "Préparation de la logique du joueur…" });
  return call(py, "generate", game, slot, yaml || null, JSON.stringify(slotData ?? {}));
}

let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  const { id, cmd } = data;
  queue = queue.then(async () => {
    try {
      if (!python) python = start(id);
      const py = await python.catch((error) => { python = null; throw error; });
      const result = cmd === "load"
        ? await load(py, id, data)
        : call(py, "update", JSON.stringify(data.items), JSON.stringify(data.missing));
      postMessage({ id, result });
    } catch (error) {
      // UTError : message prévu pour le joueur ; sinon la dernière ligne de la trace Python.
      const lines = String(error?.message || error).trim().split("\n");
      const last = lines[lines.length - 1].replace(/^ut_core\.UTError: /, "");
      postMessage({ id, error: last });
    }
  });
};
