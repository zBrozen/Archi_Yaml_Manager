"""Recopie dans apworlds.json la liste des jeux du tableur du Discord d'Archipelago.

Seule la clé "games" est réécrite : un jeu par ligne de la feuille « Playable Worlds », avec sa
stabilité, son statut de PR et l'indication 18+. Sont ignorés les jeux déjà intégrés à Archipelago
(statut « Core ») et ceux sans lien GitHub ou GitLab (apworld publié sur Discord, itch.io…).
Les réglages faits à la main ("options", "exclude", "github", "sheet") sont conservés.

Usage :
    python tools/sync_sheet.py --config apworlds.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from fetch_apworlds import DEFAULT_SHEET, Http, normalize, read_sheet, source_from_links


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

    options = {normalize(name) for name in settings.get("options", {})}
    games = []
    skipped = 0
    for row in sorted(sheet.values(), key=lambda r: normalize(r["name"])):
        if row["pr_status"] == "Core":
            continue
        if source_from_links(row["links"]) is None and normalize(row["name"]) not in options:
            skipped += 1
            continue
        game = {"game": row["name"], "stability": row["stability"]}
        if row["pr_status"] and row["pr_status"] not in ("--", "-"):
            game["pr_status"] = row["pr_status"]
        if row["adult"]:
            game["adult"] = True
        games.append(game)

    settings["games"] = games
    for key, default in (("options", {}), ("exclude", []), ("github", [])):
        settings.setdefault(key, default)
    text = dump(settings)
    changed = not config.exists() or config.read_text(encoding="utf-8") != text
    config.write_text(text, encoding="utf-8")
    print(f"{len(games)} jeux recopiés ({skipped} sans dépôt GitHub/GitLab ignorés)"
          + ("" if changed else ", aucun changement"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
