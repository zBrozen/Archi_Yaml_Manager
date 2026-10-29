"""Exporte les définitions d'options de tous les jeux Archipelago en JSON.

Usage :
    python tools/extract_options.py --ap chemin/vers/Archipelago --out site/data

Le script charge Archipelago depuis ses sources (y compris les .apworld placés
dans <Archipelago>/custom_worlds) et écrit :
    <out>/index.json         liste des jeux + version d'Archipelago
    <out>/games/<slug>.json  options d'un jeu, rangées par groupe
"""
from __future__ import annotations

import argparse
import datetime
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any

# Fonctions partagées avec le site (exécutées aussi dans le navigateur).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "site" / "py"))
from ap_extract import describe_world  # noqa: E402

TRANSLATED_FIELDS = ("doc_fr", "doc_html_fr")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ap", required=True, help="Dossier des sources d'Archipelago")
    parser.add_argument("--out", required=True, help="Dossier de sortie des JSON")
    return parser.parse_args()


def slugify(name: str, taken: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "game"
    slug, i = base, 2
    while slug in taken:
        slug, i = f"{base}-{i}", i + 1
    taken.add(slug)
    return slug



def fingerprint(data: dict[str, Any]) -> str:
    """Contenu comparable d'un jeu, indépendant de l'ordre des choix.

    Quelques mondes numérotent leurs choix en parcourant un set : l'ordre et les
    identifiants changent d'une exécution à l'autre sans que les options changent.
    Les traductions (ajoutées ensuite par translate_docs.py) ne comptent pas.
    """
    copy = json.loads(json.dumps(data))
    for group in copy["groups"]:
        for option in group["options"]:
            for field in TRANSLATED_FIELDS:
                option.pop(field, None)
            if "choices" in option:
                option["choices"] = sorted((c["value"], c["label"]) for c in option["choices"])
    return json.dumps(copy, sort_keys=True, ensure_ascii=False)


def main() -> int:
    args = parse_args()
    ap_dir = Path(args.ap).resolve()
    out_dir = Path(args.out).resolve()
    games_dir = out_dir / "games"

    os.chdir(ap_dir)
    sys.path.insert(0, str(ap_dir))
    logging.basicConfig(level=logging.WARNING)

    # Certains mondes importent MultiServer, qui lance ModuleUpdate et demande une
    # confirmation clavier si une version de dépendance diffère : on désactive ce contrôle.
    import ModuleUpdate
    ModuleUpdate.update_ran = True

    import Options
    import Utils
    import worlds
    from worlds.AutoWorld import AutoWorldRegister

    games_dir.mkdir(parents=True, exist_ok=True)
    previous_files = {old.name: old.read_bytes() for old in games_dir.glob("*.json")}
    for old in games_dir.glob("*.json"):
        old.unlink()
    changed = False

    index_games = []
    errors: dict[str, str] = {}
    taken: set[str] = set()
    for game, world in sorted(AutoWorldRegister.world_types.items(), key=lambda kv: kv[0].casefold()):
        if world.hidden:
            continue
        try:
            data = describe_world(Options, worlds, game, world)
        except Exception as ex:  # un monde cassé ne doit pas bloquer les autres
            errors[game] = f"{type(ex).__name__}: {ex}"
            continue
        slug = slugify(game, taken)
        content = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        previous = previous_files.pop(f"{slug}.json", None)
        if previous is not None and fingerprint(json.loads(previous)) == fingerprint(data):
            content = previous  # même contenu : on garde le fichier tel quel
        (games_dir / f"{slug}.json").write_bytes(content)
        changed |= previous != content
        index_games.append({
            "game": game,
            "file": f"games/{slug}.json",
            "source": data["source"],
            "apworld": data["apworld"],
            "world_version": data["world_version"],
        })

    for name, reason in worlds.failed_world_loads.items():
        errors[name] = reason.strip().splitlines()[-1] if reason.strip() else "échec du chargement"

    # Infos du tableur des jeux (stabilité, 18+…), relevées par fetch_apworlds.py.
    credits_path = out_dir / "apworld-credits.json"
    if credits_path.exists():
        sheet = {c["file"]: c["sheet"] for c in json.loads(credits_path.read_text(encoding="utf-8")) if c.get("sheet")}
        for entry in index_games:
            if entry["apworld"] in sheet:
                entry["sheet"] = sheet[entry["apworld"]]

    index = {
        "ap_version": Utils.__version__,
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "games": index_games,
        "errors": errors,
    }
    # Si rien n'a changé, on garde l'ancienne date pour ne pas créer de commit inutile.
    index_path = out_dir / "index.json"
    if index_path.exists() and not changed and not previous_files:
        old_index = json.loads(index_path.read_text(encoding="utf-8"))
        if {**old_index, "generated_at": None} == {**index, "generated_at": None}:
            index["generated_at"] = old_index["generated_at"]
    with open(index_path, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=1)

    print(f"{len(index_games)} jeux exportés vers {out_dir}, {len(errors)} en erreur.")
    for name, reason in errors.items():
        print(f"  - {name}: {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
