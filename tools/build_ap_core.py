"""Construit l'archive d'Archipelago chargée par le navigateur pour lire un apworld.

Usage :
    python tools/build_ap_core.py --ap chemin/vers/Archipelago --out site/data/ap-core.zip
    python tools/build_ap_core.py --ap chemin/vers/Archipelago --worlds site/data/worlds

Avec --worlds, écrit aussi une archive par jeu officiel (dossier worlds/<jeu>/, sans tests, guides ni
images ou sons) et `index.json` (nom du jeu → archive), pour la logique des trackers du site (js/ut.js).
Ces archives ne sont pas commitées : le workflow de publication du site les fabrique à partir de la
version d'Archipelago de la base (site/data/index.json).

L'archive contient le cœur d'Archipelago (sans les jeux officiels, déjà dans la base du site)
et les dépendances Python pures dont il a besoin. Le navigateur l'exécute avec Pyodide
(voir site/py/browser_entry.py). Le contenu est trié et daté de façon fixe : une même version
d'Archipelago donne toujours exactement le même fichier, donc pas de commit inutile.
"""
from __future__ import annotations

import argparse
import ast
import importlib.util
import json
import sys
import zipfile
from pathlib import Path

# Dossiers d'Archipelago nécessaires pour charger un monde (en plus des .py de la racine et de worlds/).
AP_FOLDERS = ["rule_builder", "worlds/generic", "worlds/_bizhawk", "worlds/_sc2common"]

# Dépendances en Python pur, copiées depuis l'environnement qui lance ce script.
# (PyYAML est fourni par Pyodide lui-même.)
PURE_DEPENDENCIES = ["schema", "typing_extensions", "colorama", "platformdirs", "pathspec", "docutils"]

FIXED_DATE = (1980, 1, 1, 0, 0, 0)

# Jeux officiels : dossiers déjà dans l'archive du cœur, et fichiers inutiles à la logique.
CORE_WORLD_FOLDERS = {"generic", "_bizhawk", "_sc2common"}
SKIPPED_PARTS = {"test", "tests", "docs", "__pycache__"}
SKIPPED_SUFFIXES = {".pyc", ".pyd", ".so", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".ogg", ".wav",
                    ".mp3", ".flac", ".ttf", ".otf", ".md", ".pdf", ".psd"}


def package_files(name: str) -> list[tuple[Path, str]]:
    spec = importlib.util.find_spec(name)
    if spec is None or spec.origin is None:
        raise SystemExit(f"Dépendance introuvable : {name} (pip install {name})")
    origin = Path(spec.origin)
    if origin.name != "__init__.py":
        return [(origin, f"site-packages/{origin.name}")]
    root = origin.parent
    return [(f, f"site-packages/{name}/{f.relative_to(root).as_posix()}")
            for f in root.rglob("*") if f.is_file() and "__pycache__" not in f.parts and f.suffix != ".pyc"]


def ap_files(ap: Path) -> list[tuple[Path, str]]:
    # LICENSE : la licence MIT d'Archipelago impose de joindre sa notice à toute copie.
    files = [f for f in ap.glob("*.py")] + [f for f in (ap / "worlds").glob("*.py")] + [ap / "LICENSE"]
    for folder in AP_FOLDERS:
        files += [f for f in (ap / folder).rglob("*") if f.is_file()]
    return [(f, f.relative_to(ap).as_posix()) for f in files
            if "__pycache__" not in f.parts and f.suffix not in (".pyc", ".pyd", ".so")]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ap", required=True)
    parser.add_argument("--out", help="archive du cœur d'Archipelago")
    parser.add_argument("--worlds", help="dossier des archives des jeux officiels")
    args = parser.parse_args()
    if not args.out and not args.worlds:
        parser.error("--out ou --worlds est nécessaire")
    if args.worlds:
        build_worlds(Path(args.ap).resolve(), Path(args.worlds))
    if not args.out:
        return 0

    entries = ap_files(Path(args.ap).resolve())
    for name in PURE_DEPENDENCIES:
        entries += package_files(name)

    out = Path(args.out)
    write_zip(out, entries)
    print(f"{out} : {len(entries)} fichiers, {out.stat().st_size // 1024} Ko")
    return 0


def write_zip(out: Path, entries: list[tuple[Path, str]]) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source, name in sorted(entries, key=lambda e: e[1]):
            info = zipfile.ZipInfo(name, FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, source.read_bytes())


def world_games(folder: Path) -> list[str]:
    """Noms des jeux d'un dossier de monde, lus dans le code sans l'exécuter : attribut `game` d'une
    classe dérivée de World, en chaîne ou par une constante du même dossier."""
    trees = []
    for file in sorted(folder.rglob("*.py")):
        if SKIPPED_PARTS & set(file.relative_to(folder).parts):
            continue
        try:
            trees.append(ast.parse(file.read_text(encoding="utf-8-sig", errors="replace")))
        except SyntaxError:
            continue
    constants = {}
    for tree in trees:
        for node in ast.walk(tree):
            if isinstance(node, (ast.Assign, ast.AnnAssign)) and isinstance(node.value, ast.Constant) \
                    and isinstance(node.value.value, str):
                for target in node.targets if isinstance(node, ast.Assign) else [node.target]:
                    if isinstance(target, ast.Name):
                        constants[target.id] = node.value.value
    games = []
    for tree in trees:
        for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
            if not any((getattr(b, "id", None) or getattr(b, "attr", None) or "").endswith("World") for b in cls.bases):
                continue
            for statement in cls.body:
                target = statement.targets[0] if isinstance(statement, ast.Assign) else getattr(statement, "target", None)
                value = getattr(statement, "value", None)
                if getattr(target, "id", None) != "game" or value is None:
                    continue
                if isinstance(value, ast.Constant) and isinstance(value.value, str):
                    games.append(value.value)
                elif isinstance(value, (ast.Name, ast.Attribute)):
                    name = getattr(value, "id", None) or value.attr
                    if name in constants:
                        games.append(constants[name])
    return list(dict.fromkeys(games))


def build_worlds(ap: Path, out: Path) -> int:
    index = {}
    for folder in sorted((ap / "worlds").iterdir()):
        if not (folder / "__init__.py").is_file() or folder.name in CORE_WORLD_FOLDERS:
            continue
        files = [(f, f.relative_to(ap / "worlds").as_posix()) for f in folder.rglob("*")
                 if f.is_file() and not SKIPPED_PARTS & set(f.relative_to(folder).parts)
                 and f.suffix.lower() not in SKIPPED_SUFFIXES]
        write_zip(out / f"{folder.name}.zip", files)
        for game in world_games(folder):
            index.setdefault(game, f"{folder.name}.zip")
    (out / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    size = sum(f.stat().st_size for f in out.glob("*.zip")) // 1024
    print(f"{out} : {len(index)} jeux officiels, {size} Ko")
    return 0


if __name__ == "__main__":
    sys.exit(main())
