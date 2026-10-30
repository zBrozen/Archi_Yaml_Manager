"""Relève les packs PopTracker des jeux dans le tableur du Discord d'Archipelago.

Les liens « Poptracker » de la colonne « Links & Downloads » (feuille « Playable Worlds ») mènent au
dépôt du pack. L'export xlsx du tableur ne garde que le premier lien de chaque cellule : on lit donc
sa page HTML, qui les garde tous avec leur libellé. Pour chaque pack GitHub, la release visée par le
lien (sinon la dernière) donne l'archive .zip que le site charge, via le relais du service des rooms.

Écrit site/data/trackers.json :
    {"games": {"<jeu du tableur>": [{"repo", "page", "tag", "asset", "url"}, …]}}
Un pack sans release .zip garde seulement son lien ("page") : le site renvoie alors vers le dépôt.

Usage :
    python tools/fetch_trackers.py --out site/data/trackers.json [--cache ../apworld-cache] [--only "Mega Man 2"]
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
from pathlib import Path

from fetch_apworlds import DEFAULT_SHEET, WORKERS, Http, normalize, warn

PLAYABLE_GID = "58422002"  # feuille « Playable Worlds »
LABEL = re.compile(r"^\s*pop\s*tracker\b", re.I)


class SheetPage(HTMLParser):
    """Lignes du tableau : [[(texte de la cellule, [(libellé, lien), …]), …], …]."""

    def __init__(self):
        super().__init__()
        self.rows: list[list[tuple[str, list[tuple[str, str]]]]] = []
        self.row = self.cell = self.link = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.row = []
        elif tag == "td" and self.row is not None:
            self.cell = ["", []]
        elif tag == "a" and self.cell is not None:
            self.link = ["", dict(attrs).get("href", "")]

    def handle_endtag(self, tag):
        if tag == "a" and self.link is not None and self.cell is not None:
            self.cell[1].append((self.link[0].strip(), self.link[1]))
            self.link = None
        elif tag == "td" and self.cell is not None and self.row is not None:
            self.row.append((self.cell[0].strip(), self.cell[1]))
            self.cell = None
        elif tag == "tr" and self.row is not None:
            self.rows.append(self.row)
            self.row = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell[0] += data
        if self.link is not None:
            self.link[0] += data


def real_url(href: str) -> str:
    """Les liens de la page passent par https://www.google.com/url?q=…"""
    href = html.unescape(href)
    parsed = urllib.parse.urlparse(href)
    if parsed.netloc.endswith("google.com") and parsed.path == "/url":
        return urllib.parse.parse_qs(parsed.query).get("q", [href])[0]
    return href


def read_packs(http: Http, sheet_id: str) -> dict[str, list[str]]:
    """Liens des packs PopTracker par jeu, dans l'ordre du tableur."""
    url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/htmlview/sheet?headers=false&gid={PLAYABLE_GID}"
    page = SheetPage()
    page.feed(http.read(url).decode("utf-8"))
    packs: dict[str, list[str]] = {}
    columns = None
    for row in page.rows:
        texts = [text for text, _ in row]
        if columns is None:
            if "Game" in texts and "Links & Downloads" in texts:
                columns = {name: i for i, name in enumerate(texts)}
            continue
        name = texts[columns["Game"]] if len(texts) > columns["Game"] else ""
        if not name:
            continue
        links = [real_url(href) for cell in row for label, href in cell[1] if LABEL.match(label)]
        if links:
            packs.setdefault(name, [])
            packs[name] += [link for link in links if link not in packs[name]]
    if columns is None:
        raise RuntimeError("colonnes « Game » et « Links & Downloads » introuvables")
    return packs


def resolve(http: Http, link: str) -> dict:
    """Release .zip du pack d'un lien GitHub ; sinon le lien seul."""
    entry = {"page": link}
    m = re.match(r"https?://github\.com/([\w.-]+)/([\w.-]+)(/.*)?$", link)
    if not m:
        return entry
    repo = f"{m.group(1)}/{m.group(2).removesuffix('.git')}"
    entry["repo"] = repo
    tag = re.match(r"/releases/tag/([^/?#]+)", m.group(3) or "")
    api = f"https://api.github.com/repos/{repo}/releases"
    try:
        releases = [http.json(f"{api}/tags/{tag.group(1)}")] if tag else http.json(f"{api}?per_page=10")
    except Exception as ex:  # dépôt supprimé, limite de l'API…
        warn(f"Pack PopTracker {repo} : {ex}")
        return entry
    for release in releases:
        if release.get("draft"):
            continue
        assets = [a for a in release.get("assets", []) if a["name"].lower().endswith(".zip")]
        if assets:
            asset = assets[0]
            entry.update(tag=release["tag_name"], asset=asset["name"], url=asset["browser_download_url"])
            break
    return entry


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="site/data/trackers.json")
    parser.add_argument("--sheet", default=DEFAULT_SHEET)
    parser.add_argument("--cache", type=Path, help="dossier du cache des réponses de l'API GitHub")
    parser.add_argument("--only", action="append", help="ne traiter que ce jeu (test sans jeton GitHub)")
    args = parser.parse_args()

    if args.cache:
        args.cache.mkdir(parents=True, exist_ok=True)
    http = Http(args.cache)
    packs = read_packs(http, args.sheet)
    if args.only:
        wanted = {normalize(name) for name in args.only}
        packs = {name: links for name, links in packs.items() if normalize(name) in wanted}
    elif len(packs) < 50:
        print(f"Seulement {len(packs)} packs lus dans le tableur : {args.out} n'est pas modifié.")
        return 1

    jobs = [(name, link) for name, links in packs.items() for link in links]
    with ThreadPoolExecutor(WORKERS) as pool:
        entries = list(pool.map(lambda job: resolve(http, job[1]), jobs))
    http.save()

    games: dict[str, list[dict]] = {}
    for (name, _), entry in zip(jobs, entries):
        games.setdefault(name, []).append(entry)
    out = Path(args.out)
    out.write_text(json.dumps({"games": dict(sorted(games.items(), key=lambda g: normalize(g[0])))},
                              ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    ready = sum(1 for entries in games.values() if any("url" in e for e in entries))
    print(f"{len(games)} jeux avec un pack PopTracker, dont {ready} avec une release .zip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
