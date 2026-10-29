"""Rassemble les apworlds du serveur dans le dossier custom_worlds d'Archipelago.

Deux sources, utilisables ensemble :
  - les fichiers .apworld déposés dans le dossier `apworlds/` du dépôt ;
  - les releases GitHub listées dans `apworlds.json` (dernière release, ou un tag précis).

Usage :
    python tools/fetch_apworlds.py --config apworlds.json --local apworlds --dest ../Archipelago/custom_worlds

Un apworld introuvable affiche un avertissement mais ne bloque pas la mise à jour des autres jeux.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import urllib.request
from pathlib import Path


def github_request(url: str, accept: str = "application/vnd.github+json"):
    headers = {"Accept": accept, "User-Agent": "archi-yaml-manager"}
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60)


def warn(message: str) -> None:
    # Format reconnu par GitHub Actions pour afficher un avertissement dans le résumé.
    print(f"::warning::{message}")


def fetch_release(entry: dict, dest: Path) -> list[str]:
    repo = entry["repo"]
    tag = entry.get("tag")
    pattern = re.compile(entry.get("asset", r"\.apworld$"))
    url = f"https://api.github.com/repos/{repo}/releases/" + (f"tags/{tag}" if tag else "latest")
    with github_request(url) as response:
        release = json.load(response)
    assets = [a for a in release.get("assets", []) if a["name"].endswith(".apworld") and pattern.search(a["name"])]
    if not assets:
        warn(f"{repo} : aucun fichier .apworld dans la release {release.get('tag_name')}")
        return []
    names = []
    for asset in assets:
        with github_request(asset["url"], accept="application/octet-stream") as response, \
                open(dest / asset["name"], "wb") as f:
            shutil.copyfileobj(response, f)
        names.append(f"{asset['name']} ({repo} {release.get('tag_name')})")
    return names


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default="apworlds.json")
    parser.add_argument("--local", default="apworlds")
    parser.add_argument("--dest", required=True)
    args = parser.parse_args()

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    added: list[str] = []

    local = Path(args.local)
    if local.is_dir():
        for file in sorted(local.glob("*.apworld")):
            shutil.copy2(file, dest / file.name)
            added.append(f"{file.name} (dossier apworlds/)")

    config = Path(args.config)
    if config.exists():
        entries = json.loads(config.read_text(encoding="utf-8")).get("github", [])
        for entry in entries:
            try:
                added += fetch_release(entry, dest)
            except Exception as ex:
                warn(f"{entry.get('repo')} : téléchargement impossible ({ex})")

    print(f"{len(added)} apworld(s) ajouté(s) :")
    for name in added:
        print(f"  - {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
