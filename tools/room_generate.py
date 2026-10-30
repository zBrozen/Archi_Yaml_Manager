"""Génération en ligne d'une room (workflow .github/workflows/generate-room.yml).

Le service des rooms (worker/) lance le workflow avec le code de la room. Ce script :
  1. lit les YAML de la room et les réglages choisis par l'hôte (secret GENERATOR_SECRET) ;
  2. installe dans Archipelago les apworlds non officiels des jeux de la room, pris dans le cache
     des apworlds de la mise à jour quotidienne (même version que celle vérifiée par le site), sauf ceux
     que l'hôte a déposés dans la room : ils passent avant ceux du site, même pour un jeu officiel ;
  3. lance la génération, avec les réglages du serveur de l'hôte (release, collect, indices), dans un
     conteneur Docker sans réseau (--image) : le code des apworlds n'atteint ni le secret ni le réseau ;
  4. envoie la partie au service, et le spoiler à part : il n'est donné qu'à l'hôte, la partie envoyée
     sur archipelago.gg n'en contient pas.

Le journal du workflow est public : il montre les noms et les jeux des joueurs, jamais le contenu des YAML
ni l'emplacement des objets.

Usage :
    python tools/room_generate.py start --room CODE
    python tools/room_generate.py run --room CODE --ap ../Archipelago --cache ../apworld-cache [--image IMAGE]
    python tools/room_generate.py fail --room CODE --message "…"
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from fetch_apworlds import apworld_problem

ROOT = Path(__file__).resolve().parent.parent
GENERATION_TIMEOUT = 25 * 60
SPOILER_LEVEL = 2  # objets et chemin de victoire, sans le détail des trajets (plus rapide)

# Lancé dans le dossier d'Archipelago : applique les réglages du serveur choisis par l'hôte
# (ils sont enregistrés dans la partie générée), puis génère comme Generate.py.
WRAPPER = """
import json, sys
sys.path.insert(0, ".")
options = json.loads(sys.argv[1])
# Sans clavier, la vérification des dépendances bloquerait sur sa question « press enter to install » ;
# elles sont installées par le workflow, et un jeu dont une dépendance manque ne se charge simplement pas.
import ModuleUpdate
ModuleUpdate.update = lambda *args, **kwargs: None
import settings
settings.no_gui = True  # une ROM manquante est une erreur, pas une fenêtre « choisir un fichier »
server = settings.get_settings().server_options
for key in ("release_mode", "collect_mode", "remaining_mode", "hint_cost"):
    setattr(server, key, type(getattr(server, key))(options[key]))
sys.argv = ["Generate.py", *sys.argv[2:]]
import Generate, Main
erargs, seed = Generate.main()
Main.main(erargs, seed)
"""


class Failure(Exception):
    """Erreur à montrer à l'hôte sur la page de la room."""


# --- Service des rooms --------------------------------------------------------------

def api_url() -> str:
    text = (ROOT / "site" / "js" / "config.js").read_text(encoding="utf-8")
    match = re.search(r'const DEPLOYED = "([^"]*)"', text)
    if not match or not match.group(1):
        raise SystemExit("Adresse du service des rooms absente de site/js/config.js")
    return match.group(1).rstrip("/")


def call(method: str, path: str, room: str, body=None, data: bytes | None = None, content_type="application/json",
         raw: bool = False):
    secret = os.environ.get("GENERATOR_SECRET")
    if not secret:
        raise SystemExit("Secret GENERATOR_SECRET manquant")
    payload = data if data is not None else (json.dumps(body).encode() if body is not None else None)
    request = urllib.request.Request(f"{api_url()}/api/rooms/{room}/generator{path}", data=payload, method=method, headers={
        "X-Generator-Secret": secret,
        "User-Agent": "archi-rooms-generator",
        **({"Content-Type": content_type} if payload is not None else {}),
    })
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return response.read() if raw else json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as ex:
        detail = ex.read().decode("utf-8", "replace")
        raise SystemExit(f"Service des rooms : {method} {path or '/'} → {ex.code} {detail}")


def run_url() -> str | None:
    if os.environ.get("GITHUB_RUN_ID"):
        return f"{os.environ['GITHUB_SERVER_URL']}/{os.environ['GITHUB_REPOSITORY']}/actions/runs/{os.environ['GITHUB_RUN_ID']}"
    return None


def report(room: str, status: str, message: str | None = None, files: dict | None = None) -> None:
    call("POST", "", room, {"status": status, "message": message, "run_url": run_url(), "files": files or {}})


# --- Apworlds ------------------------------------------------------------------------

def games_of(text: str) -> set[str]:
    """Jeux d'un YAML (champ `game`, éventuellement une table de poids)."""
    import yaml  # installé avec les dépendances d'Archipelago
    games = set()
    try:
        docs = list(yaml.safe_load_all(text))
    except yaml.YAMLError:
        return games  # le générateur expliquera l'erreur
    for doc in docs:
        game = doc.get("game") if isinstance(doc, dict) else None
        if isinstance(game, str):
            games.add(game)
        elif isinstance(game, dict):
            games.update(str(g) for g, weight in game.items() if isinstance(weight, (int, float)) and weight > 0)
    return games


def stored_apworlds(cache: Path) -> dict[str, Path]:
    """Apworlds du cache de la mise à jour quotidienne, par nom de fichier (voir fetch_apworlds.py)."""
    found = {}
    last = cache / "last.json"
    if last.exists():
        for files in json.loads(last.read_text(encoding="utf-8")).values():
            for f in files:
                stored = f.get("stored") or ""
                # Le chemin enregistré est celui d'une autre exécution : on le reprend depuis « files/ ».
                relative = stored.split("/files/", 1)[1] if "/files/" in stored.replace("\\", "/") else None
                path = cache / "files" / relative if relative else None
                if path and path.exists():
                    found[f["name"]] = path
    return found


def package_name(data: bytes) -> str | None:
    """Dossier du monde dans l'apworld : Archipelago veut un fichier qui porte ce nom."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            roots = {n.split("/")[0] for n in archive.namelist() if n.count("/") == 1 and n.endswith("/__init__.py")}
    except zipfile.BadZipFile:
        return None
    return roots.pop() if len(roots) == 1 and re.fullmatch(r"[A-Za-z_][\w]*", next(iter(roots))) else None


def install_own(game: str, path: Path, ap: Path, dest: Path) -> None:
    """Installe l'apworld déposé par l'hôte. Archipelago charge les mondes intégrés avant les apworlds et ignore
    un apworld dont le jeu est déjà chargé : pour un jeu officiel, le dossier intégré est donc retiré."""
    data = path.read_bytes()
    package = package_name(data)
    if not package:
        raise Failure(f"L'apworld déposé pour {game} n'est pas valide (un seul dossier de monde attendu).")
    if problem := apworld_problem(data):
        raise Failure(f"L'apworld déposé pour {game} ferait échouer Archipelago : {problem}.")
    builtin = ap / "worlds" / package
    if builtin.is_dir():
        shutil.rmtree(builtin)
    target = dest / f"{package}.apworld"
    if target.exists():
        raise Failure(f"L'apworld déposé pour {game} porte le même nom ({target.name}) que celui d'un autre jeu de la partie.")
    print(f"Apworld de l'hôte : {game} ({target.name})", flush=True)
    target.write_bytes(data)


def install_apworlds(games: set[str], ap: Path, cache: Path, own: dict[str, Path] | None = None) -> None:
    """`own` : apworlds déposés par l'hôte, par jeu ; ils passent avant ceux du site."""
    own = own or {}
    index = json.loads((ROOT / "site" / "data" / "index.json").read_text(encoding="utf-8"))
    sources = {g["game"]: g.get("source") for g in index["games"]}
    credits = json.loads((ROOT / "site" / "data" / "apworld-credits.json").read_text(encoding="utf-8"))
    files = {c["game"]: c["file"] for c in credits}
    stored = stored_apworlds(cache)
    unknown = sorted(g for g in games if g not in sources and g not in own)
    if unknown:
        raise Failure(f"Jeux absents de la base du site, impossibles à générer en ligne : {', '.join(unknown)}. "
                      "Déposez leur apworld dans la génération en ligne, ou générez la partie sur votre ordinateur.")
    dest = ap / "custom_worlds"
    dest.mkdir(parents=True, exist_ok=True)
    for game in sorted(g for g in games if g not in own and sources[g] != "core"):
        name = files.get(game)
        path = ROOT / "apworlds" / name if name and (ROOT / "apworlds" / name).exists() else stored.get(name)
        if not path:
            raise Failure(f"Apworld de {game} introuvable dans le cache : relancez la mise à jour des données, "
                          "ou générez sur votre ordinateur.")
        print(f"Apworld : {game} ({name})", flush=True)
        shutil.copy2(path, dest / name)
    for game in sorted(g for g in games if g in own):
        install_own(game, own[game], ap, dest)


# --- Génération --------------------------------------------------------------------------

def write_players(slots: list[dict], folder: Path) -> set[str]:
    folder.mkdir(parents=True, exist_ok=True)
    used, games = set(), set()
    for slot in slots:
        base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", slot["name"]).strip() or "joueur"
        name = f"{base}.yaml"
        n = 2
        while name.lower() in used:
            name, n = f"{base}_{n}.yaml", n + 1
        used.add(name.lower())
        (folder / name).write_text(slot["content"], encoding="utf-8")
        games |= games_of(slot["content"])
    return games


def explain(log: str) -> str:
    """Dernière erreur du journal du générateur, pour la page de la room."""
    lines = [l.strip() for l in log.splitlines() if l.strip()]
    error = next((l for l in reversed(lines) if re.match(r"^[\w.]*(Error|Exception|Exit)\b", l)), None) \
        or (lines[-1] if lines else "le générateur s'est arrêté sans message")
    if re.search(r"\brom\b|rom_file|\.(sfc|smc|z64|n64|nes|gba|iso)\b", error, re.I):
        error += " — Ce jeu a besoin de sa ROM pour générer : générez la partie sur votre ordinateur."
    # YAML refusés : « 1. File Bob.yaml document #1 (with name: Bob) is invalid. »
    invalid = [l for l in lines if re.match(r"^\d+\. File .* is invalid", l)]
    if invalid:
        error = f"{' '.join(dict.fromkeys(invalid))} {error}"
    return f"La génération a échoué : {error[:1500]}"


def generate(ap: Path, players: Path, out: Path, options: dict, image: str | None = None) -> Path:
    """Lance Archipelago. Avec `image` (Docker), le code des apworlds tourne dans un conteneur sans réseau, qui ne
    voit que le dossier d'Archipelago, les YAML et le dossier de sortie : ni le secret du service, ni le reste de
    la machine du workflow. Indispensable dès qu'un hôte peut déposer son propre apworld."""
    out.mkdir(parents=True, exist_ok=True)
    spoiler = str(SPOILER_LEVEL if options.get("spoiler") else 0)
    log = []
    if image:
        name = f"room-generation-{os.getpid()}"
        command = ["docker", "run", "--rm", "--name", name, "--network", "none", "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges", "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp",
                   "-v", f"{ap}:/ap", "-v", f"{players}:/players:ro", "-v", f"{out}:/out", "-w", "/ap", image,
                   "python", "-c", WRAPPER, json.dumps(options),
                   "--player_files_path", "/players", "--outputpath", "/out", "--spoiler", spoiler]
        env = None
        stop = lambda: subprocess.run(["docker", "kill", name], capture_output=True)
    else:
        command = [sys.executable, "-c", WRAPPER, json.dumps(options),
                   "--player_files_path", str(players), "--outputpath", str(out), "--spoiler", spoiler]
        # Le code des apworlds ne reçoit pas le secret du service.
        env = {k: v for k, v in os.environ.items() if k != "GENERATOR_SECRET"}
        stop = None
    process = subprocess.Popen(command, cwd=ap, env=env,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, encoding="utf-8", errors="replace")
    watchdog = threading.Timer(GENERATION_TIMEOUT, stop or process.kill)
    watchdog.start()
    try:
        for line in process.stdout:
            print(line, end="", flush=True)
            log.append(line)
        code = process.wait()
    finally:
        expired = not watchdog.is_alive()
        watchdog.cancel()
    if expired:
        raise Failure("La génération a dépassé 25 minutes : partie trop grosse pour la génération en ligne.")
    results = sorted(out.glob("*.zip"), key=lambda p: p.stat().st_mtime)
    if code != 0 or not results:
        raise Failure(explain("".join(log)))
    return results[-1]


def split_spoiler(archive: Path, folder: Path) -> tuple[Path, Path | None]:
    """Retire le spoiler de la partie : il reste à l'hôte, la partie hébergée n'en contient pas."""
    with zipfile.ZipFile(archive) as source:
        spoilers = [n for n in source.namelist() if n.endswith("_Spoiler.txt")]
        if not spoilers:
            return archive, None
        spoiler = folder / Path(spoilers[0]).name
        spoiler.write_bytes(source.read(spoilers[0]))
        clean = folder / archive.name
        with zipfile.ZipFile(clean, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                if info.filename not in spoilers:
                    target.writestr(info, source.read(info.filename))
    return clean, spoiler


def run(room: str, ap: Path, cache: Path, image: str | None = None) -> None:
    try:
        data = call("GET", "", room)
        print(f"Room {room} : {len(data['slots'])} YAML, réglages {data['options']}", flush=True)
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            tmp = Path(tmp)
            games = write_players(data["slots"], tmp / "Players")
            print(f"Jeux : {', '.join(sorted(games))}", flush=True)
            own = {}
            for item in data.get("apworlds", []):
                if item["game"] in games and re.fullmatch(r"[\w.-]+\.apworld", item["file"]):
                    path = tmp / "own" / item["file"]
                    path.parent.mkdir(exist_ok=True)
                    path.write_bytes(call("GET", f"/apworlds/{item['file']}", room, raw=True))
                    own[item["game"]] = path
            if own and not image:
                print("::warning::Apworlds de l'hôte exécutés sans conteneur (--image absent)", flush=True)
            install_apworlds(games, ap, cache, own)
            archive = generate(ap, tmp / "Players", tmp / "output", data["options"], image)
            (tmp / "final").mkdir()
            archive, spoiler = split_spoiler(archive, tmp / "final")
            call("PUT", "/files/output", room, data=archive.read_bytes(), content_type="application/zip")
            files = {"output": archive.name}
            if spoiler:
                call("PUT", "/files/spoiler", room, data=spoiler.read_bytes(), content_type="text/plain")
                files["spoiler"] = spoiler.name
        report(room, "done", files=files)
        print(f"Partie envoyée : {files}", flush=True)
    except Failure as ex:
        report(room, "failed", str(ex))
        raise SystemExit(str(ex))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["start", "run", "fail"])
    parser.add_argument("--room", required=True)
    parser.add_argument("--ap", help="dossier d'Archipelago")
    parser.add_argument("--cache", help="cache des apworlds (fetch_apworlds.py --cache)")
    parser.add_argument("--image", help="image Docker où lancer Archipelago (conteneur sans réseau)")
    parser.add_argument("--message", default="La génération a échoué.")
    args = parser.parse_args()
    room = re.sub(r"[^A-Z0-9]", "", args.room.upper())
    if args.command == "start":
        report(room, "running")
    elif args.command == "fail":
        report(room, "failed", args.message)
    else:
        if not args.ap or not args.cache:
            parser.error("run demande --ap et --cache")
        run(room, Path(args.ap).resolve(), Path(args.cache), args.image)
    return 0


if __name__ == "__main__":
    sys.exit(main())
