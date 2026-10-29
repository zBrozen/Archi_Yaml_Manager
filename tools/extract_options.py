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
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

# Fonctions partagées avec le site (exécutées aussi dans le navigateur).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "site" / "py"))
from ap_extract import describe_world  # noqa: E402

TRANSLATED_FIELDS = ("doc_fr", "doc_html_fr")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ap", required=True, help="Dossier des sources d'Archipelago")
    parser.add_argument("--out", help="Dossier de sortie des JSON")
    parser.add_argument("--jobs", type=int, default=3, help="Processus de chargement en parallèle")
    parser.add_argument("--batch", type=int, default=40, help="Apworlds chargés par processus")
    # Usage interne : un processus qui charge les apworlds d'un dossier et écrit le résultat.
    parser.add_argument("--worker", nargs=2, metavar=("DOSSIER", "RESULTAT"), help=argparse.SUPPRESS)
    args = parser.parse_args()
    if not args.worker and not args.out:
        parser.error("--out est obligatoire")
    return args


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


# --- Chargement isolé ----------------------------------------------------------
# Des centaines d'apworlds de la communauté : un seul qui plante, boucle ou épuise la mémoire
# ne doit pas emporter les autres. Chaque lot est chargé dans son propre processus (limité en
# temps et en mémoire) ; un lot en échec est coupé en deux jusqu'à isoler le fautif.

WORKER_MEMORY = 6 * 1024 ** 3  # octets d'espace d'adressage par processus


def worker(ap_dir: Path, folder: Path, result: Path) -> int:
    """Charge Archipelago avec les apworlds de `folder` à la place de custom_worlds."""
    os.chdir(ap_dir)
    sys.path.insert(0, str(ap_dir))
    logging.basicConfig(level=logging.WARNING)

    # Certains mondes importent MultiServer, qui lance ModuleUpdate et demande une
    # confirmation clavier si une version de dépendance diffère : on désactive ce contrôle.
    import ModuleUpdate
    ModuleUpdate.update_ran = True

    # worlds/__init__.py lit l'emplacement de custom_worlds à son import.
    import Utils
    user_path = Utils.user_path
    Utils.user_path = lambda *parts: str(folder) if parts == ("custom_worlds",) else user_path(*parts)

    import Options
    import worlds
    from worlds.AutoWorld import AutoWorldRegister

    games, errors = [], {}
    for game, world in AutoWorldRegister.world_types.items():
        if world.hidden:
            continue
        try:
            data = describe_world(Options, worlds, game, world)
            json.dumps(data)
        except Exception as ex:  # un monde cassé ne doit pas bloquer les autres
            errors[game] = f"{type(ex).__name__}: {ex}"
            continue
        games.append({"game": game, "data": data})
    for name, reason in worlds.failed_world_loads.items():
        errors[name] = reason.strip().splitlines()[-1] if reason.strip() else "échec du chargement"
    result.write_text(json.dumps({"ap_version": Utils.__version__, "games": games, "errors": errors},
                                 ensure_ascii=False), encoding="utf-8")
    return 0


def limit_memory() -> None:
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (WORKER_MEMORY, WORKER_MEMORY))


def run_batch(ap_dir: Path, files: list[Path], work: Path) -> dict:
    """Charge un lot d'apworlds ; en cas d'échec, recommence sur chaque moitié."""
    folder = Path(tempfile.mkdtemp(dir=work))
    worlds_dir = folder / "custom_worlds"
    worlds_dir.mkdir()
    for file in files:
        shutil.copy2(file, worlds_dir / file.name)
    result, log = folder / "result.json", folder / "log.txt"
    command = [sys.executable, str(Path(__file__).resolve()), "--ap", str(ap_dir),
               "--worker", str(worlds_dir), str(result)]
    try:
        with open(log, "w", encoding="utf-8") as output:
            code = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                                  timeout=180 + 15 * len(files),
                                  preexec_fn=limit_memory if os.name == "posix" else None).returncode
        reason = None if code == 0 and result.exists() else f"plantage du chargement (code {code})"
    except subprocess.TimeoutExpired:
        reason = "chargement trop long"
    if reason is None:
        data = json.loads(result.read_text(encoding="utf-8"))
        shutil.rmtree(folder, ignore_errors=True)
        return data
    lines = [line for line in log.read_text(encoding="utf-8", errors="replace").splitlines() if line.strip()]
    crash = result.with_suffix(".error")
    error = crash.read_text(encoding="utf-8") if crash.exists() else None
    shutil.rmtree(folder, ignore_errors=True)
    if not files:
        print("\n".join(lines[-30:]))
        raise RuntimeError(f"Archipelago ne se charge pas sans apworld : {reason}")
    if len(files) == 1:
        detail = f"{reason} : {error[:300]}" if error else reason
        print(f"  - {files[0].name} : {detail}", flush=True)
        return {"games": [], "errors": {files[0].name: detail}}
    half = len(files) // 2
    first, second = run_batch(ap_dir, files[:half], work), run_batch(ap_dir, files[half:], work)
    return {"games": first["games"] + second["games"], "errors": {**first["errors"], **second["errors"]}}


def main() -> int:
    args = parse_args()
    ap_dir = Path(args.ap).resolve()
    if args.worker:
        result = Path(args.worker[1]).resolve()
        try:
            return worker(ap_dir, Path(args.worker[0]).resolve(), result)
        except BaseException as ex:
            # Pour le processus principal, qui n'a sinon que le journal (mêlé aux messages d'Archipelago).
            result.with_suffix(".error").write_text(f"{type(ex).__name__}: {ex}", encoding="utf-8")
            raise

    out_dir = Path(args.out).resolve()
    games_dir = out_dir / "games"
    custom_dir = ap_dir / "custom_worlds"
    custom = sorted(custom_dir.glob("*.apworld")) if custom_dir.is_dir() else []

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        core = run_batch(ap_dir, [], work)  # jeux officiels seuls
        batches = [custom[i:i + args.batch] for i in range(0, len(custom), args.batch)]
        print(f"{len(custom)} apworlds en {len(batches)} lots", flush=True)
        with ThreadPoolExecutor(max(1, args.jobs)) as pool:
            results = list(pool.map(lambda files: run_batch(ap_dir, files, work), batches))

    # Un jeu chargé par plusieurs lots (jeu officiel, ou deux apworlds du même jeu) : le premier compte.
    loaded: dict[str, dict] = {}
    errors: dict[str, str] = {}
    for result in [core, *results]:
        for item in result["games"]:
            loaded.setdefault(item["game"], item["data"])
        for name, reason in result["errors"].items():
            errors.setdefault(name, reason)
    for game in loaded:
        errors.pop(game, None)

    games_dir.mkdir(parents=True, exist_ok=True)
    previous_files = {old.name: old.read_bytes() for old in games_dir.glob("*.json")}
    for old in games_dir.glob("*.json"):
        old.unlink()
    changed = False

    index_games = []
    taken: set[str] = set()
    for game, data in sorted(loaded.items(), key=lambda kv: kv[0].casefold()):
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

    # Infos du tableur des jeux (stabilité, 18+…), relevées par fetch_apworlds.py.
    credits_path = out_dir / "apworld-credits.json"
    if credits_path.exists():
        sheet = {c["file"]: c["sheet"] for c in json.loads(credits_path.read_text(encoding="utf-8")) if c.get("sheet")}
        for entry in index_games:
            if entry["apworld"] in sheet:
                entry["sheet"] = sheet[entry["apworld"]]

    index = {
        "ap_version": core["ap_version"],
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "games": index_games,
        "errors": dict(sorted(errors.items(), key=lambda kv: kv[0].casefold())),
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
