"""Rassemble les apworlds du serveur dans le dossier custom_worlds d'Archipelago.

Sources (voir `apworlds.json`) :
  - "games" : jeux de la liste des jeux du Discord d'Archipelago (tableur Google), recopiés
    automatiquement par tools/sync_sheet.py. Le dépôt est trouvé dans la colonne
    « Links & Downloads » du tableur, puis l'apworld est téléchargé depuis sa dernière release
    (GitHub ou GitLab) ;
  - "github" : dépôts GitHub ajoutés à la main (jeu absent du tableur) ;
  - les fichiers .apworld déposés dans le dossier `apworlds/` du dépôt.

"options" règle un jeu du tableur, par son nom :
  "tag"         : une release précise plutôt que la dernière ;
  "asset"       : expression régulière du nom de fichier, si la release contient plusieurs apworlds ;
  "prereleases" : true pour accepter aussi les préversions ;
  "repo" / "gitlab" : dépôt à utiliser à la place de celui du tableur.
"exclude" écarte des jeux du tableur.

Avec --cache, les réponses de l'API GitHub (ETag : une réponse inchangée ne compte pas dans la limite
de requêtes), les apworlds téléchargés et leurs licences sont gardés d'une exécution à l'autre. Si un
téléchargement échoue (limite atteinte, release supprimée…), la dernière version connue est réutilisée.

Avec --credits, écrit pour chaque apworld le jeu, sa version, ses auteurs (archipelago.json), sa source,
sa licence (fichier LICENSE de l'apworld, sinon celui du dépôt) et ses informations du tableur.

Usage :
    python tools/fetch_apworlds.py --config apworlds.json --local apworlds \\
        --dest ../Archipelago/custom_worlds --cache ../apworld-cache --credits site/data/apworld-credits.json
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import io
import json
import os
import re
import sys
import threading
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

DEFAULT_SHEET = "1iuzDTOAvdoNe8Ne8i461qGNucg5OuEoF-Ikqs8aUQZw"
XLSX = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
WORKERS = 8


def warn(message: str) -> None:
    # Format reconnu par GitHub Actions pour afficher un avertissement dans le résumé.
    print(f"::warning::{message}", flush=True)


def normalize(name: str) -> str:
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", name.lower())


# --- HTTP (avec cache ETag pour l'API GitHub) -------------------------------------

class Http:
    def __init__(self, cache: Path | None):
        self.lock = threading.Lock()
        self.rate_limited = False
        self.file = cache / "http.json" if cache else None
        self.entries = json.loads(self.file.read_text(encoding="utf-8")) if self.file and self.file.exists() else {}
        self.used: set[str] = set()

    def open(self, url: str, accept: str = "application/vnd.github+json", etag: str | None = None):
        headers = {"Accept": accept, "User-Agent": "archi-yaml-manager"}
        token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        if token and url.startswith("https://api.github.com/"):
            headers["Authorization"] = f"Bearer {token}"
        if etag:
            headers["If-None-Match"] = etag
        return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60)

    def read(self, url: str, accept: str = "*/*") -> bytes:
        with self.open(url, accept) as response:
            return response.read()

    def json(self, url: str):
        github = url.startswith("https://api.github.com/")
        if github and self.rate_limited:
            raise RuntimeError("limite de l'API GitHub atteinte")
        with self.lock:
            cached = self.entries.get(url)
            self.used.add(url)
        try:
            with self.open(url, etag=cached and cached["etag"]) as response:
                body = json.load(response)
                etag = response.headers.get("ETag")
        except urllib.error.HTTPError as ex:
            if ex.code == 304 and cached:
                return cached["body"]
            if github and ex.code in (403, 429) and ex.headers.get("X-RateLimit-Remaining") == "0":
                self.rate_limited = True
                warn("Limite de l'API GitHub atteinte : les jeux restants gardent leur dernière version connue")
            raise
        if etag:
            with self.lock:
                self.entries[url] = {"etag": etag, "body": body}
        return body

    def save(self) -> None:
        if self.file:
            kept = {url: entry for url, entry in self.entries.items() if url in self.used}
            self.file.write_text(json.dumps(kept, ensure_ascii=False), encoding="utf-8")


# --- Tableur des jeux -----------------------------------------------------------

def read_sheet(http: Http, sheet_id: str) -> dict[str, dict]:
    """Jeux de la feuille « Playable Worlds », par nom normalisé :
    nom affiché, stabilité, statut de PR, 18+, liens (colonne « Links & Downloads » en premier)."""
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=xlsx"
    book = zipfile.ZipFile(io.BytesIO(http.read(url)))

    def xml(path: str):
        return ET.fromstring(book.read(path))

    strings = ["".join(si.itertext()) for si in xml("xl/sharedStrings.xml").findall("m:si", XLSX)]
    targets = {r.get("Id"): r.get("Target") for r in xml("xl/_rels/workbook.xml.rels")}
    games: dict[str, dict] = {}
    for sheet in xml("xl/workbook.xml").find("m:sheets", XLSX):
        path = "xl/" + targets[sheet.get(REL_ID)].lstrip("/").removeprefix("xl/")
        root = xml(path)
        rels_path = path.replace("worksheets/", "worksheets/_rels/") + ".rels"
        rels = {r.get("Id"): r.get("Target") for r in xml(rels_path)} if rels_path in book.namelist() else {}
        links: dict[str, str] = {}
        for link in root.findall(".//m:hyperlink", XLSX):
            if link.get(REL_ID) in rels:
                links[link.get("ref")] = rels[link.get(REL_ID)]

        columns = None
        for row in root.findall(".//m:row", XLSX):
            cells = {}
            for cell in row.findall("m:c", XLSX):
                value = cell.find("m:v", XLSX)
                if value is not None:
                    col = re.match(r"[A-Z]+", cell.get("r")).group()
                    # Un nombre entier est stocké « 2048.0 » (jeu « 2048 »).
                    cells[col] = strings[int(value.text)] if cell.get("t") == "s" \
                        else re.sub(r"^(-?\d+)\.0$", r"\1", value.text)
            if columns is None:
                # Seule la feuille des jeux jouables a ces colonnes (les outils n'ont pas de stabilité).
                names = {text: col for col, text in cells.items()}
                if cells.get("A") == "Game" and {"Links & Downloads", "Stability"} <= names.keys():
                    columns = names
                continue
            name = (cells.get("A") or "").strip()
            if not name:
                continue
            downloads = columns["Links & Downloads"]
            number = row.get("r")
            row_links = sorted(((m.group(1), url) for ref, url in links.items()
                                if (m := re.fullmatch(r"([A-Z]+)" + number, ref)) and m.group(1) != "A"),
                               key=lambda item: (item[0] != downloads, len(item[0]), item[0]))
            games.setdefault(normalize(name), {
                "name": name,
                "stability": cells.get(columns["Stability"]),
                "pr_status": cells.get(columns.get("PR Status", ""), None),
                "adult": cells.get(columns.get("18+ / Unrated", ""), "0") == "1",
                "links": [url for _, url in row_links],
            })
        if columns:
            break
    return games


def source_from_links(links: list[str]) -> dict | None:
    for url in links:
        if m := re.match(r"https?://github\.com/([\w.-]+/[\w.-]+)", url):
            return {"repo": m.group(1).removesuffix(".git")}
        if m := re.match(r"https?://gitlab\.com/([\w.-]+(?:/[\w.-]+)+?)(?:/-/|/?$|\?)", url):
            return {"gitlab": m.group(1)}
    return None


# --- Releases ---------------------------------------------------------------------

def releases_of(http: Http, entry: dict) -> tuple[str, list[dict]]:
    """Page du dépôt, releases [{tag, prerelease, assets: [(nom, url)]}] de la plus récente à la plus ancienne."""
    if "gitlab" in entry:
        project = entry["gitlab"]
        api = f"https://gitlab.com/api/v4/projects/{urllib.parse.quote(project, safe='')}/releases"
        raw = [http.json(f"{api}/{urllib.parse.quote(entry['tag'], safe='')}")] if entry.get("tag") \
            else http.json(f"{api}?per_page=10")
        return f"https://gitlab.com/{project}", [{
            "tag": r.get("tag_name"),
            "prerelease": r.get("upcoming_release", False),
            "assets": [(link["name"], link.get("direct_asset_url") or link["url"])
                       for link in r.get("assets", {}).get("links", [])],
        } for r in raw]
    repo = entry["repo"]
    api = f"https://api.github.com/repos/{repo}/releases"
    raw = [http.json(f"{api}/tags/{entry['tag']}")] if entry.get("tag") else http.json(f"{api}?per_page=10")
    # browser_download_url : téléchargement hors API, donc hors limite de requêtes.
    return f"https://github.com/{repo}", [{
        "tag": r.get("tag_name"),
        "prerelease": r.get("prerelease", False) or r.get("draft", False),
        "assets": [(a["name"], a["browser_download_url"]) for a in r.get("assets", [])],
    } for r in raw]


def similarity(a: str, b: str) -> float:
    a, b = normalize(a), normalize(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def choose(release: dict, entry: dict) -> list[tuple[str, str]]:
    pattern = re.compile(entry.get("asset", r"\.apworld$"))
    assets = [(n, u) for n, u in release["assets"] if n.endswith(".apworld") and pattern.search(n)]
    if len(assets) > 1 and "asset" not in entry and entry.get("game"):
        # Release qui contient plusieurs jeux : on garde le fichier le plus proche du nom du jeu.
        assets = [max(assets, key=lambda a: similarity(a[0][:-8], entry["game"]))]
    return assets


def pick_release(releases: list[dict], entry: dict) -> dict | None:
    allowed = [r for r in releases if (entry.get("prereleases") or entry.get("tag") or not r["prerelease"]) and choose(r, entry)]
    if entry.get("game") and "asset" not in entry:
        # Dépôt qui publie plusieurs jeux (fork d'Archipelago) : la release la plus récente
        # dont un fichier porte le nom du jeu, sinon simplement la plus récente.
        named = next((r for r in allowed if similarity(choose(r, entry)[0][0][:-8], entry["game"]) >= 0.6), None)
        if named:
            return named
    return allowed[0] if allowed else None


def manifest_game(data: bytes) -> str | None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            name = next((n for n in archive.namelist() if n.count("/") == 1 and n.endswith("/archipelago.json")), None)
            return json.loads(archive.read(name)).get("game") if name else None
    except Exception:
        return None


# --- Crédits ----------------------------------------------------------------------

LICENSES = [
    (r"Permission is hereby granted, free of charge", "MIT"),
    (r"GNU LESSER GENERAL PUBLIC LICENSE", "LGPL"),
    (r"GNU AFFERO GENERAL PUBLIC LICENSE", "AGPL-3.0"),
    (r"GNU GENERAL PUBLIC LICENSE\s+Version 3", "GPL-3.0"),
    (r"GNU GENERAL PUBLIC LICENSE\s+Version 2", "GPL-2.0"),
    (r"Mozilla Public License,? (?:Version )?2\.0", "MPL-2.0"),
    (r"Apache License,?\s+Version 2\.0", "Apache-2.0"),
    (r"This is free and unencumbered software released into the public domain", "Unlicense"),
    (r"Redistribution and use in source and binary forms", "BSD"),
    (r"Creative Commons", "Creative Commons"),
]


def describe_license(text: str) -> tuple[str, list[str]]:
    # Le titre suffit, et évite de confondre la GPL avec l'AGPL qu'elle cite plus bas.
    head = text[:1500]
    name = next((label for pattern, label in LICENSES if re.search(pattern, head, re.I)), "Licence spécifique")
    # Les lignes avec « < » sont les modèles d'exemple des licences (« <year> <name of author> »).
    notices = [line.strip() for line in text.splitlines()
               if re.match(r"\s*Copyright\s*(\(c\)|©|\d{4})", line, re.I)
               and "Free Software Foundation" not in line and "<" not in line]
    return name, notices[:6]


def repo_license(http: Http, page: str | None) -> dict:
    """Licence déclarée par le dépôt, si l'apworld n'en contient pas."""
    try:
        if page and page.startswith("https://github.com/"):
            # Fichiers bruts du dépôt : hors API, donc hors limite de requêtes.
            repo = page.removeprefix("https://github.com/")
            for file in ("LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "LICENCE"):
                try:
                    text = http.read(f"https://raw.githubusercontent.com/{repo}/HEAD/{file}").decode("utf-8", "replace")
                except urllib.error.HTTPError as ex:
                    if ex.code == 404:
                        continue
                    raise
                name, notices = describe_license(text)
                return {"license": name, "license_url": f"{page}/blob/HEAD/{file}", "copyright": notices}
        if page and page.startswith("https://gitlab.com/"):
            project = urllib.parse.quote(page.removeprefix("https://gitlab.com/"), safe="")
            data = http.json(f"https://gitlab.com/api/v4/projects/{project}?license=true")
            if data.get("license"):
                return {"license": data["license"].get("name"), "license_url": data.get("license_url"), "copyright": []}
    except Exception:
        pass  # pas de licence (404) ou API indisponible
    return {"license": None, "license_url": None, "copyright": []}


def credits_of(http: Http, path: Path, page: str | None) -> dict:
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        manifest = next((n for n in names if n.count("/") == 1 and n.endswith("/archipelago.json")), None)
        meta = json.loads(archive.read(manifest)) if manifest else {}
        license_file = next((n for n in names if n.count("/") == 1
                             and re.match(r"(LICEN[CS]E|COPYING)(\.\w+)?$", n.split("/")[1], re.I)), None)
        text = archive.read(license_file).decode("utf-8", "replace") if license_file else None
    entry = {
        "game": meta.get("game") or path.stem,
        "version": meta.get("world_version"),
        "authors": meta.get("authors", []),
        "file": path.name,
        "source": page,
    }
    if text:
        name, notices = describe_license(text)
        url = repo_license(http, page)["license_url"] if page and page.startswith("https://gitlab.com/") else None
        entry.update(license=name, license_url=url, copyright=notices, license_file=license_file)
    else:
        entry.update(repo_license(http, page))
    return entry


# --- Programme --------------------------------------------------------------------

def load_entries(http: Http, settings: dict) -> list[dict]:
    """Entrées à télécharger : jeux du tableur (avec leurs réglages), puis dépôts ajoutés à la main."""
    options = {normalize(name): value for name, value in settings.get("options", {}).items()}
    excluded = {normalize(name) for name in settings.get("exclude", [])}
    games = [{"game": g} if isinstance(g, str) else dict(g) for g in settings.get("games", [])]
    games = [{**g, **options.get(normalize(g["game"]), {})} for g in games if normalize(g["game"]) not in excluded]

    if any("repo" not in g and "gitlab" not in g for g in games):
        try:
            sheet = read_sheet(http, settings.get("sheet", DEFAULT_SHEET))
            print(f"Tableur des jeux : {len(sheet)} jeux", flush=True)
        except Exception as ex:
            sheet = {}
            warn(f"Tableur des jeux illisible ({ex}) : les jeux gardent leur dernière version connue")
        for game in games:
            row = sheet.get(normalize(game["game"]))
            if row is None:
                if sheet:
                    close = difflib.get_close_matches(game["game"], [r["name"] for r in sheet.values()], n=3)
                    warn(f"{game['game']} : absent du tableur" + (f" (voulez-vous dire : {', '.join(close)} ?)" if close else ""))
            elif "repo" not in game and "gitlab" not in game:
                game.update(source_from_links(row["links"]) or {})
    return games + [dict(e) for e in settings.get("github", [])]


def entry_key(entry: dict) -> str:
    return entry.get("game") or entry.get("repo") or entry.get("gitlab")


class Skipped(Exception):
    """Jeu sans apworld téléchargeable : cas courant, résumé en fin d'exécution plutôt qu'en avertissement."""


def fetch(http: Http, entry: dict, cache: Path | None, last: dict) -> list[dict]:
    """Télécharge l'apworld d'une entrée ; à défaut, reprend sa dernière version connue."""
    key = entry_key(entry)
    try:
        if "repo" not in entry and "gitlab" not in entry:
            raise Skipped("aucun dépôt GitHub ou GitLab dans le tableur")
        page, releases = releases_of(http, entry)
        release = pick_release(releases, entry)
        if release is None:
            raise Skipped("aucune release avec un fichier .apworld")
        results = []
        for name, url in choose(release, entry):
            stored = (cache / "files" / hashlib.sha1(f"{page}|{release['tag']}|{name}".encode()).hexdigest()[:16] / name) \
                if cache else None
            if stored is None or not stored.exists():
                data = http.read(url, accept="application/octet-stream")
                if stored:
                    stored.parent.mkdir(parents=True, exist_ok=True)
                    stored.write_bytes(data)
            else:
                data = stored.read_bytes()
            game = manifest_game(data)
            if entry.get("game") and game and similarity(game, entry["game"]) < 0.6 \
                    and similarity(name[:-8], entry["game"]) < 0.6:
                raise Skipped(f"la dernière release de {page} est un autre jeu ({game})")
            results.append({"name": name, "page": page, "tag": release["tag"], "data": data,
                            "stored": str(stored) if stored else None})
        return results
    except Exception as ex:
        known = last.get(key)
        if known and all(f.get("stored") and Path(f["stored"]).exists() for f in known):
            warn(f"{key} : {ex} ; dernière version connue réutilisée")
            return [{**f, "data": Path(f["stored"]).read_bytes()} for f in known]
        if isinstance(ex, Skipped):
            entry["_skipped"] = str(ex)
        else:
            warn(f"{key} : téléchargement impossible ({ex})")
        return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default="apworlds.json")
    parser.add_argument("--local", default="apworlds")
    parser.add_argument("--dest", required=True)
    parser.add_argument("--cache", help="dossier gardé d'une exécution à l'autre")
    parser.add_argument("--credits", help="fichier JSON des crédits à écrire")
    args = parser.parse_args()

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    cache = Path(args.cache) if args.cache else None
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
    http = Http(cache)
    last_file = cache / "last.json" if cache else None
    last = json.loads(last_file.read_text(encoding="utf-8")) if last_file and last_file.exists() else {}

    # (fichier, page du dépôt, entrée)
    files: list[tuple[Path, str | None, dict]] = []
    local = Path(args.local)
    if local.is_dir():
        for file in sorted(local.glob("*.apworld")):
            (dest / file.name).write_bytes(file.read_bytes())
            print(f"  - {file.name} (dossier apworlds/)")
            files.append((dest / file.name, None, {}))

    config = Path(args.config)
    settings = json.loads(config.read_text(encoding="utf-8")) if config.exists() else {}
    entries = load_entries(http, settings)

    with ThreadPoolExecutor(WORKERS) as pool:
        results = list(pool.map(lambda e: fetch(http, e, cache, last), entries))

    taken = {path.name for path, _, _ in files}
    new_last = {}
    for entry, downloaded in zip(entries, results):
        if downloaded:
            new_last[entry_key(entry)] = [{k: v for k, v in f.items() if k != "data"} for f in downloaded]
        for f in downloaded:
            if f["name"] in taken:
                warn(f"{entry_key(entry)} : {f['name']} déjà fourni par un autre jeu, ignoré")
                continue
            taken.add(f["name"])
            (dest / f["name"]).write_bytes(f["data"])
            files.append((dest / f["name"], f["page"], {**entry, "tag": f["tag"]}))
    print(f"{len(files)} apworld(s) ajouté(s) sur {len(entries)} jeu(x) listé(s)", flush=True)
    skipped = [e for e in entries if "_skipped" in e]
    if skipped:
        print(f"{len(skipped)} jeu(x) sans apworld téléchargeable :")
        for e in skipped:
            print(f"  - {entry_key(e)} : {e['_skipped']}")

    if args.credits:
        # Licence du dépôt : gardée par version, pour ne pas la redemander à chaque exécution.
        license_file = cache / "licenses.json" if cache else None
        known = json.loads(license_file.read_text(encoding="utf-8")) if license_file and license_file.exists() else {}
        kept = {}

        def credit(item):
            path, page, entry = item
            key = f"{page}|{entry.get('tag')}|{path.name}"
            try:
                info = known.get(key) or credits_of(http, path, page)
            except Exception as ex:
                warn(f"{path.name} : crédits illisibles ({ex})")
                return None
            if info.get("license") is not None or not http.rate_limited:
                kept[key] = info
            if entry.get("game"):
                info = {**info, "sheet": {k: entry[k] for k in ("game", "stability", "pr_status", "adult") if k in entry}}
            return info

        with ThreadPoolExecutor(WORKERS) as pool:
            credits = [c for c in pool.map(credit, files) if c]
        credits.sort(key=lambda c: normalize(c["game"]))
        out = Path(args.credits)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(credits, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        if license_file:
            license_file.write_text(json.dumps(kept, ensure_ascii=False), encoding="utf-8")

    if last_file:
        # Un jeu sans téléchargement ce coup-ci garde sa dernière version connue pour la prochaine fois.
        listed = {entry_key(e) for e in entries}
        final = {**{k: v for k, v in last.items() if k in listed}, **new_last}
        last_file.write_text(json.dumps(final, ensure_ascii=False), encoding="utf-8")
        # Les anciennes versions des apworlds ne servent plus.
        used = {Path(f["stored"]).parent.name for known in final.values() for f in known if f.get("stored")}
        for folder in (cache / "files").glob("*") if (cache / "files").is_dir() else []:
            if folder.name not in used:
                for file in folder.iterdir():
                    file.unlink()
                folder.rmdir()
    http.save()
    return 0


if __name__ == "__main__":
    sys.exit(main())
