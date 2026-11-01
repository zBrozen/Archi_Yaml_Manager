// Worker qui lit un apworld avec Pyodide (Python dans le navigateur), sans bloquer la page.
// Messages reçus : { id, bytes } ; envoyés : { id, status } puis { id, result } ou { id, error }.
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
  const [core, entry, extract] = await Promise.all([get("../data/ap-core.zip"), get("../py/browser_entry.py"), get("../py/ap_extract.py")]);
  py.unpackArchive(await core.arrayBuffer(), "zip", { extractDir: "/ap" });
  py.FS.writeFile("/ap/browser_entry.py", await entry.text());
  py.FS.writeFile("/ap/ap_extract.py", await extract.text());
  py.runPython("import sys\nsys.path.insert(0, '/ap')\nimport browser_entry\nbrowser_entry.setup()");
  return py;
}

let queue = Promise.resolve();

self.onmessage = ({ data }) => {
  const { id, bytes } = data;
  queue = queue.then(async () => {
    try {
      if (!python) python = start(id);
      const py = await python.catch((error) => { python = null; throw error; });
      postMessage({ id, status: "Lecture de l'apworld…" });
      py.FS.writeFile("/tmp/upload.apworld", new Uint8Array(bytes));
      const result = py.runPython("import browser_entry\nbrowser_entry.extract('/tmp/upload.apworld')");
      postMessage({ id, result: JSON.parse(result) });
    } catch (error) {
      // Les erreurs Python arrivent avec toute la trace : on garde la dernière ligne, la plus parlante.
      const lines = String(error?.message || error).trim().split("\n");
      postMessage({ id, error: lines[lines.length - 1] });
    }
  });
};
