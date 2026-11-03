"""Relève le genre des jeux sur Wikidata, pour le tri par genre du choix du jeu.

Chaque jeu du site (index.json) est cherché par son nom : seul un élément
dont le nom ou un alias est exactement celui du jeu (accents, casse et ponctuation mis à part) et qui est
un jeu vidéo est retenu. Ses genres Wikidata (P136) sont ramenés aux quelques genres du site (GENRES).
Beaucoup de jeux faits pour Archipelago n'y sont pas : ils restent sans genre.

Wikidata limite fort les requêtes : une requête à la fois, en respectant « Retry-After ». Les jeux déjà
relevés sont gardés (un jeu non trouvé est recherché de nouveau après RETRY_DAYS jours), et le relevé
s'arrête après --max-minutes : la suite au prochain passage.

Corrections à la main dans apworlds.json, clé "genres", par nom de jeu : une liste de genres du site
(["puzzle"]) ou un élément Wikidata ("Q28451532").

Écrit site/data/genres.json :
    {"genres": {"<clé>": "<libellé>", …}, "games": {"<jeu>": {"genres": […], "wikidata": "Q…", "checked": "AAAA-MM-JJ"}}}

Usage :
    python tools/fetch_genres.py --index site/data/index.json --config apworlds.json --out site/data/genres.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from fetch_apworlds import normalize, warn

API = "https://www.wikidata.org/w/api.php"
USER_AGENT = "archi-yaml-manager/1.0 (https://github.com/zBrozen/Archi_Yaml_Manager)"
RETRY_DAYS = 30
BATCH = 25  # jeux par lot enregistré
# « Instance de » acceptées : jeu vidéo, épisode, remake, remaster, extension, jeu indépendant…
VIDEO_GAME = {"Q7889", "Q21125433", "Q65963104", "Q1066707", "Q209163", "Q4393107", "Q16070115", "Q111223304",
              "Q61996773", "Q64170203", "Q865493"}

# Genres du site, dans l'ordre d'affichage.
GENRES = {
    "action": "Action",
    "aventure": "Aventure",
    "plateforme": "Plateforme",
    "metroidvania": "Metroidvania",
    "rpg": "RPG",
    "roguelike": "Roguelike",
    "puzzle": "Réflexion",
    "tir": "Tir",
    "combat": "Combat",
    "course": "Course",
    "rythme": "Rythme",
    "strategie": "Stratégie",
    "simulation": "Simulation",
    "survie": "Survie",
    "horreur": "Horreur",
    "sport": "Sport",
    "cartes": "Cartes",
    "bac-a-sable": "Bac à sable",
}

# Mots du libellé anglais d'un genre Wikidata → genres du site (un libellé peut en donner plusieurs).
RULES = [
    ("metroidvania", "metroidvania"), ("soulsvania", "metroidvania"),
    ("action-adventure", "action"), ("action-adventure", "aventure"),
    ("action role-playing", "action"), ("role-playing", "rpg"), ("rpg", "rpg"),
    ("roguelike", "roguelike"), ("roguelite", "roguelike"),
    ("platform", "plateforme"),
    ("puzzle", "puzzle"), ("logic", "puzzle"), ("sokoban", "puzzle"),
    ("shoot", "tir"), ("run and gun", "tir"),
    ("fighting", "combat"), ("beat 'em up", "action"), ("hack and slash", "action"), ("action game", "action"),
    ("racing", "course"), ("kart", "course"),
    ("rhythm", "rythme"), ("music video game", "rythme"),
    ("strategy", "strategie"), ("tower defense", "strategie"), ("4x", "strategie"), ("tactical", "strategie"),
    ("simulation", "simulation"), ("simulator", "simulation"), ("city-building", "simulation"),
    ("management", "simulation"), ("farming", "simulation"), ("life sim", "simulation"),
    ("survival horror", "horreur"), ("horror", "horreur"), ("survival", "survie"),
    ("sports", "sport"), ("golf", "sport"), ("football", "sport"), ("skateboarding", "sport"),
    ("card", "cartes"), ("deck-building", "cartes"),
    ("sandbox", "bac-a-sable"),
    ("adventure", "aventure"), ("point-and-click", "aventure"), ("visual novel", "aventure"),
    ("interactive fiction", "aventure"), ("walking simulator", "aventure"),
]


class Wikidata:
    def __init__(self, deadline: float):
        self.deadline = deadline
        self.last = 0.0

    def get(self, **params) -> dict:
        url = API + "?" + urllib.parse.urlencode({**params, "format": "json"})
        for attempt in range(6):
            if time.monotonic() > self.deadline:
                raise TimeoutError
            time.sleep(max(0.0, self.last + 1.0 - time.monotonic()))
            self.last = time.monotonic()
            try:
                request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(request, timeout=30) as response:
                    return json.load(response)
            except urllib.error.HTTPError as ex:
                if ex.code not in (429, 503) or attempt == 5:
                    raise
                time.sleep(min(60, int(ex.headers.get("Retry-After") or 5) * (attempt + 1)))
        raise RuntimeError("unreachable")

    def entities(self, ids: list[str], props: str) -> dict:
        found = {}
        for i in range(0, len(ids), 50):
            found |= self.get(action="wbgetentities", ids="|".join(ids[i:i + 50]), props=props, languages="en")["entities"]
        return found

    def find(self, name: str) -> tuple[str | None, list[str]]:
        """Élément Wikidata du jeu et identifiants de ses genres."""
        results = self.get(action="wbsearchentities", search=name, language="en", type="item", limit=10)["search"]
        ids = [r["id"] for r in results if normalize(r.get("match", {}).get("text", "")) == normalize(name)]
        if not ids:
            return None, []
        for qid, item in self.entities(ids, "claims").items():
            claims = item.get("claims", {})
            if values(claims, "P31") & VIDEO_GAME:
                return qid, sorted(values(claims, "P136"))
        return None, []


def values(claims: dict, prop: str) -> set[str]:
    return {c["mainsnak"]["datavalue"]["value"]["id"] for c in claims.get(prop, [])
            if c["mainsnak"].get("datavalue", {}).get("type") == "wikibase-entityid"}


def site_genres(labels: list[str]) -> list[str]:
    found = {key for label in labels for word, key in RULES if word in label.lower()}
    return [key for key in GENRES if key in found]


def save(out: Path, games: dict) -> None:
    result = {"genres": GENRES, "games": dict(sorted(games.items(), key=lambda kv: normalize(kv[0])))}
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def progress(done: int, total: int, games: dict, names: set, started: float) -> None:
    """Barre d'avancement : réécrite sur place dans un terminal, une ligne par lot sinon (journal de la CI)."""
    share = done / total if total else 1
    bar = "#" * round(share * 30)
    with_genre = sum(1 for g in games.values() if g["genres"])
    elapsed = time.monotonic() - started
    left = f", encore ~{round(elapsed / done * (total - done) / 60)} min" if done and done < total else ""
    line = f"[{bar:<30}] {done}/{total} jeux cherchés ({share:.0%}), {with_genre}/{len(names)} avec un genre{left}"
    if sys.stdout.isatty():
        print(f"\r{line}   ", end="", flush=True)
    else:
        print(line, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", default="site/data/index.json")
    parser.add_argument("--config", default="apworlds.json")
    parser.add_argument("--out", default="site/data/genres.json")
    parser.add_argument("--max-minutes", type=float, default=15)
    parser.add_argument("--only", action="append", help="Ne chercher que ce jeu (répétable)")
    args = parser.parse_args()

    index = Path(args.index)
    config = Path(args.config)
    out = Path(args.out)
    settings = json.loads(config.read_text(encoding="utf-8")) if config.exists() else {}
    names = {g["game"] for g in json.loads(index.read_text(encoding="utf-8"))["games"]} if index.exists() else set()
    overrides = settings.get("genres", {})
    previous = json.loads(out.read_text(encoding="utf-8")).get("games", {}) if out.exists() else {}

    today = dt.date.today()
    stale = (today - dt.timedelta(days=RETRY_DAYS)).isoformat()
    todo = sorted(n for n in names if isinstance(overrides.get(n), str)
                  or (not isinstance(overrides.get(n), list)
                      and (n not in previous or (not previous[n].get("wikidata") and previous[n].get("checked", "") < stale))))
    if args.only:
        todo = [n for n in todo if n in args.only] + [n for n in args.only if n not in todo]

    wikidata = Wikidata(time.monotonic() + args.max_minutes * 60)
    games = {n: previous[n] for n in names if n in previous}
    for name, genres in overrides.items():
        if isinstance(genres, list) and name in names:
            games[name] = {"genres": [g for g in GENRES if g in genres], "wikidata": None, "checked": today.isoformat()}
            unknown = set(genres) - GENRES.keys()
            if unknown:
                warn(f"Genres de {name} inconnus dans apworlds.json : {', '.join(sorted(unknown))}")

    # Par lots : chaque lot est enregistré, un relevé interrompu ne perd que le lot en cours.
    labels: dict[str, str] = {}
    done = 0
    started = time.monotonic()
    progress(0, len(todo), games, names, started)
    try:
        for i in range(0, len(todo), BATCH):
            found: dict[str, tuple[str | None, list[str]]] = {}
            for name in todo[i:i + BATCH]:
                if isinstance(overrides.get(name), str):
                    qid = overrides[name]
                    claims = wikidata.entities([qid], "claims").get(qid, {}).get("claims", {})
                    found[name] = (qid, sorted(values(claims, "P136")))
                else:
                    found[name] = wikidata.find(name)
            # Libellés des genres Wikidata pas encore lus.
            missing = sorted({g for _, genres in found.values() for g in genres} - labels.keys())
            labels |= {q: e.get("labels", {}).get("en", {}).get("value", "") for q, e in wikidata.entities(missing, "labels").items()}
            for name, (qid, genres) in found.items():
                games[name] = {"genres": site_genres([labels.get(g, "") for g in genres]), "wikidata": qid, "checked": today.isoformat()}
            done += len(found)
            save(out, games)
            progress(done, len(todo), games, names, started)
    except TimeoutError:
        warn(f"Genres : temps écoulé, {len(todo) - done} jeux restent pour le prochain passage")
    except (urllib.error.URLError, OSError) as ex:
        warn(f"Genres : Wikidata injoignable ({ex}), {len(todo) - done} jeux restent pour le prochain passage")

    save(out, games)
    with_genre = sum(1 for g in games.values() if g["genres"])
    print(f"\n{done} jeux cherchés, {with_genre} jeux sur {len(names)} ont un genre")
    return 0


if __name__ == "__main__":
    sys.exit(main())
