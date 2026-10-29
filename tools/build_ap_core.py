"""Construit l'archive d'Archipelago chargée par le navigateur pour lire un apworld.

Usage :
    python tools/build_ap_core.py --ap chemin/vers/Archipelago --out site/data/ap-core.zip

L'archive contient le cœur d'Archipelago (sans les jeux officiels, déjà dans la base du site)
et les dépendances Python pures dont il a besoin. Le navigateur l'exécute avec Pyodide
(voir site/py/browser_entry.py). Le contenu est trié et daté de façon fixe : une même version
d'Archipelago donne toujours exactement le même fichier, donc pas de commit inutile.
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
import zipfile
from pathlib import Path

# Dossiers d'Archipelago nécessaires pour charger un monde (en plus des .py de la racine et de worlds/).
AP_FOLDERS = ["rule_builder", "worlds/generic", "worlds/_bizhawk", "worlds/_sc2common"]

# Dépendances en Python pur, copiées depuis l'environnement qui lance ce script.
# (PyYAML est fourni par Pyodide lui-même.)
PURE_DEPENDENCIES = ["schema", "typing_extensions", "colorama", "platformdirs", "pathspec", "docutils"]

FIXED_DATE = (1980, 1, 1, 0, 0, 0)


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
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    entries = ap_files(Path(args.ap).resolve())
    for name in PURE_DEPENDENCIES:
        entries += package_files(name)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for source, name in sorted(entries, key=lambda e: e[1]):
            info = zipfile.ZipInfo(name, FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, source.read_bytes())
    print(f"{out} : {len(entries)} fichiers, {out.stat().st_size // 1024} Ko")
    return 0


if __name__ == "__main__":
    sys.exit(main())
