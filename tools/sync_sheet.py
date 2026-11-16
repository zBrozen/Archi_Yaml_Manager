"""Recopie dans apworlds.json la liste des jeux du tableur du Discord d'Archipelago.

Seule la clé "games" est réécrite : un jeu par ligne de la feuille « Playable Worlds », avec sa
stabilité, son statut de PR et l'indication 18+. Sont ignorés les jeux déjà intégrés à Archipelago
(statut « Core ») et ceux sans lien GitHub ou GitLab (apworld publié sur Discord, itch.io…).

La liste de johatrot (feuille « APWorlds », qui rassemble plusieurs listes dont ce tableur) complète :
  - les jeux du tableur, avec l'endroit où ils se jouent quand ce n'est pas le serveur principal
    ("playable" : after_dark, unofficial), leur plateforme et sa remarque ("note") ;
  - la liste, avec ses jeux absents du tableur qui ont un dépôt GitHub ou GitLab ("list": "index", dépôt
    et lien recopiés, stabilité de cette liste). Un jeu dont le dépôt ne publie qu'un jeu, déjà dans le
    tableur sous un autre nom, n'est pas ajouté deux fois.
Si elle est illisible, ce qu'elle avait apporté à la dernière synchronisation est gardé.

Les réglages faits à la main ("options", "exclude", "github", "sheet", "index_sheet", "genres") sont conservés.

Usage :
    python tools/sync_sheet.py --config apworlds.json
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

from fetch_apworlds import (DEFAULT_SHEET, INDEX_SHEET, Http, normalize, read_index, read_sheet,
                            source_from_links)

# Clés apportées par la liste de johatrot à un jeu du tableur.
INDEX_KEYS = ("playable", "platform", "note")


def index_info(row: dict | None) -> dict:
    """Infos de la liste de johatrot gardées pour un jeu : où il se joue (sauf serveur principal),
    plateforme, remarque."""
    if not row:
        return {}
    info = {"playable": row["playable"]} if row["playable"] in ("after_dark", "unofficial") else {}
    return info | {k: row[k] for k in ("platform", "note") if row[k]}


def index_only(sheet: dict[str, dict], index: dict[str, dict]) -> list[dict]:
    """Jeux de la seule liste de johatrot, avec un dépôt GitHub ou GitLab, hors jeux inclus à Archipelago."""
    def repo(source: dict | None) -> str | None:
        return source and (source.get("repo") or source.get("gitlab")).lower()

    # Un dépôt qui ne publie qu'un jeu dans chacune des deux listes : le même jeu, nommé autrement.
    in_sheet = collections.Counter(repo(source_from_links(r["links"])) for r in sheet.values())
    in_index = collections.Counter(repo(source_from_links([r["link"]])) for r in index.values() if r["link"])
    games = []
    for key, row in index.items():
        # « (Alternate - …) » : autre version d'un jeu de la liste, qui se déclare souvent sous le même nom.
        if key in sheet or row["bundled"] or not row["link"] or "(alternate" in row["name"].lower():
            continue
        source = source_from_links([row["link"]])
        if source is None:
            continue
        if in_sheet[repo(source)] == 1 and in_index[repo(source)] == 1:
            continue
        game = {"game": row["name"], "list": "index", **source, "links": [row["link"]]}
        if row["stability"]:
            game["stability"] = row["stability"]
        if row["playable"] == "after_dark":
            game["adult"] = True
        games.append(game | index_info(row))
    return games


def dump(settings: dict) -> str:
    """JSON lisible, un jeu par ligne pour des diffs courts."""
    lines = ["{"]
    keys = [k for k in settings if k != "games"] + ["games"]
    for i, key in enumerate(keys):
        end = "," if i < len(keys) - 1 else ""
        if key == "games":
            games = settings["games"]
            lines.append('  "games": [')
            lines += [f"    {json.dumps(g, ensure_ascii=False)}{',' if j < len(games) - 1 else ''}"
                      for j, g in enumerate(games)]
            lines.append(f"  ]{end}")
        else:
            value = json.dumps(settings[key], ensure_ascii=False, indent=2).replace("\n", "\n  ")
            lines.append(f"  {json.dumps(key)}: {value}{end}")
    return "\n".join(lines + ["}"]) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default="apworlds.json")
    args = parser.parse_args()

    config = Path(args.config)
    settings = json.loads(config.read_text(encoding="utf-8")) if config.exists() else {}
    sheet = read_sheet(Http(None), settings.get("sheet", DEFAULT_SHEET))
    if len(sheet) < 100:
        # Tableur vide ou mal lu : on ne vide pas la liste.
        print(f"Seulement {len(sheet)} jeux lus dans le tableur : apworlds.json n'est pas modifié.")
        return 1

    old = {normalize(g["game"]): g for g in settings.get("games", []) if isinstance(g, dict)}
    try:
        index = read_index(Http(None), settings.get("index_sheet", INDEX_SHEET))
    except Exception as ex:
        index = {}
        print(f"::warning::Liste de johatrot illisible ({ex})")
    if len(index) < 100:
        # Liste vide ou mal lue : on garde ce qu'elle avait apporté à la dernière synchronisation.
        print(f"::warning::Seulement {len(index)} jeux lus dans la liste de johatrot : ses infos précédentes sont gardées.")
        index = None

    options = {normalize(name) for name in settings.get("options", {})}
    games = []
    skipped = 0
    for row in sheet.values():
        key = normalize(row["name"])
        if row["pr_status"] == "Core":
            continue
        if source_from_links(row["links"]) is None and key not in options:
            skipped += 1
            continue
        game = {"game": row["name"], "stability": row["stability"]}
        if row["pr_status"] and row["pr_status"] not in ("--", "-"):
            game["pr_status"] = row["pr_status"]
        if row["adult"]:
            game["adult"] = True
        game.update(index_info(index.get(key)) if index is not None
                    else {k: v for k, v in old.get(key, {}).items() if k in INDEX_KEYS})
        games.append(game)

    if index is None:
        extra = [g for k, g in old.items() if g.get("list") == "index" and k not in sheet]
    else:
        extra = index_only(sheet, index)
    games = sorted(games + extra, key=lambda g: normalize(g["game"]))

    settings["games"] = games
    for key, default in (("options", {}), ("exclude", []), ("github", [])):
        settings.setdefault(key, default)
    text = dump(settings)
    changed = not config.exists() or config.read_text(encoding="utf-8") != text
    config.write_text(text, encoding="utf-8")
    print(f"{len(games)} jeux recopiés, dont {len(extra)} de la seule liste de johatrot"
          f" ({skipped} sans dépôt GitHub/GitLab ignorés)" + ("" if changed else ", aucun changement"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
