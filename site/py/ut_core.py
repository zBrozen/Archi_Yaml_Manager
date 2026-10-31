"""Lieux en logique d'un joueur, à la manière d'Universal Tracker, dans le navigateur (js/ut-worker.js).

Comme Universal Tracker (https://github.com/FarisTheAncient/Archipelago, apworld « tracker »), on refait
la génération du jeu du joueur sans remplir les objets : options de son YAML (ou des données de la partie
pour les jeux qui le permettent), données de la partie (slot_data) passées au monde, puis, à chaque
mise à jour, objets reçus collectés et lieux atteignables calculés par Archipelago lui-même.

On respecte l'interface que les apworlds exposent à Universal Tracker : `disable_ut`,
`ut_can_gen_without_yaml`, `interpret_slot_data` (et la regénération par `re_gen_passthrough`),
`multiworld.generation_is_fake`, `glitches_item_name`, `location_id_to_alias`. Le code est propre au site.
"""
from __future__ import annotations

import argparse
import inspect
import json

import yaml

_state: dict = {}

STEPS = ("generate_early", "create_regions", "create_items", "set_rules", "connect_entrances", "generate_basic")


class UTError(Exception):
    """Erreur expliquée au joueur (message en français)."""


def _weights(game: str, slot_name: str, yaml_text: str | None) -> dict:
    if not yaml_text:
        return {"name": slot_name, "game": game, game: {}}
    docs = [d for d in yaml.safe_load_all(yaml_text) if isinstance(d, dict)]
    for doc in docs:
        if str(doc.get("name", "")).strip() == slot_name and doc.get("game") == game:
            return doc
    for doc in docs:
        game_choice = doc.get("game")
        if game_choice == game or (isinstance(game_choice, dict) and game in game_choice):
            return {**doc, "game": game}
    raise UTError(f"Ce YAML ne contient pas de réglages pour {game}.")


def _build(game: str, slot_name: str, weights: dict, passthrough: dict | None):
    import Generate
    from BaseClasses import CollectionState, MultiWorld, PlandoOptions
    from worlds import AutoWorld
    from worlds.generic.Rules import exclusion_rules

    plando = PlandoOptions.from_option_string("bosses, connections, texts")
    rolled = Generate.roll_settings(weights, plando)
    world_cls = AutoWorld.AutoWorldRegister.world_types[game]

    multiworld = MultiWorld(1)
    multiworld.generation_is_fake = True
    if passthrough is not None:
        multiworld.re_gen_passthrough = passthrough
    multiworld.enforce_deferred_connections = "default"
    multiworld.set_seed(None, False, None)
    multiworld.game = {1: game}
    multiworld.player_name = {1: slot_name}
    args = argparse.Namespace()
    for key in world_cls.options_dataclass.type_hints:
        setattr(args, key, {1: getattr(rolled, key)})
    multiworld.set_options(args)
    multiworld.state = CollectionState(multiworld)
    for step in STEPS:
        if not hasattr(AutoWorld.World, step):
            continue
        AutoWorld.call_all(multiworld, step)
        if step == "set_rules":
            exclusion_rules(multiworld, 1, multiworld.worlds[1].options.exclude_locations.value)
    # L'inventaire de départ arrive du serveur avec les objets reçus : on ne garde que les événements.
    multiworld.precollected_items = {
        player: [item for item in items if item.code is None]
        for player, items in multiworld.precollected_items.items()
    }
    return multiworld


def generate(game: str, slot_name: str, yaml_text: str | None, slot_data_json: str) -> str:
    """Prépare le monde du joueur. Renvoie un résumé JSON (nombre de lieux, YAML utilisé ou non)."""
    from worlds import AutoWorld

    _state.clear()
    world_cls = AutoWorld.AutoWorldRegister.world_types.get(game)
    if world_cls is None:
        raise UTError(f"Le jeu {game} n'a pas pu être chargé.")
    if getattr(world_cls, "disable_ut", False):
        raise UTError("L'auteur de ce jeu a demandé que les trackers de logique ne l'utilisent pas.")
    slot_data = json.loads(slot_data_json or "{}")
    yamlless = not yaml_text
    if yamlless and not getattr(world_cls, "ut_can_gen_without_yaml", False):
        raise UTError("Ce jeu a besoin du YAML du joueur pour calculer la logique.")

    weights = _weights(game, slot_name, yaml_text)
    static = isinstance(inspect.getattr_static(world_cls, "interpret_slot_data", None), (staticmethod, classmethod))
    multiworld = None
    world = world_cls
    if not (yamlless and static):
        multiworld = _build(game, slot_name, weights, {game: slot_data} if yamlless else None)
        world = multiworld.worlds[1]
    if callable(getattr(world, "interpret_slot_data", None)):
        passthrough = world.interpret_slot_data(slot_data)
        # Un monde qui renvoie des données demande une nouvelle génération avec elles.
        if passthrough:
            multiworld = _build(game, slot_name, weights, {game: passthrough})
    if multiworld is None:
        raise UTError("Ce jeu n'a pas pu être préparé avec les données de la partie.")

    _state.update(multiworld=multiworld, game=game)
    locations = [loc for loc in multiworld.get_locations(1) if isinstance(loc.address, int)]
    regions = {str(loc.address): loc.parent_region.name for loc in locations if loc.parent_region is not None}
    return json.dumps({"locations": len(locations), "yaml": not yamlless, "regions": regions})


def reload_worlds() -> str:
    """Relit les jeux de /ap/worlds et /ap/custom_worlds après l'ajout de celui du joueur."""
    import importlib
    import sys
    import zipimport

    _state.clear()
    for name in [n for n in sys.modules if n == "worlds" or n.startswith("worlds.")]:
        del sys.modules[name]
    zipimport._zip_directory_cache.clear()
    worlds = importlib.import_module("worlds")
    failed = {name: (reason.strip().splitlines() or ["échec"])[-1] for name, reason in worlds.failed_world_loads.items()}
    return json.dumps({"games": sorted(worlds.AutoWorldRegister.world_types), "failed": failed})


def update(items_json: str, missing_json: str) -> str:
    """Lieux restants en logique avec les objets reçus : {"logic": [...], "glitched": [...], "errors": [...]}.

    `items_json` : [[objet, drapeaux], …] (objets reçus, dans l'ordre) ; `missing_json` : lieux restants."""
    from BaseClasses import CollectionState

    multiworld = _state.get("multiworld")
    if multiworld is None:
        raise UTError("Le tracker de logique n'est pas prêt.")
    world = multiworld.worlds[1]
    missing = set(json.loads(missing_json))
    state = CollectionState(multiworld)
    errors = []
    for item_id, flags in json.loads(items_json):
        name = world.item_id_to_name.get(item_id)
        if name is None:
            if item_id > 0:
                errors.append(f"objet inconnu : {item_id}")
            continue
        try:
            item = multiworld.create_item(name, 1)
            item.classification |= flags
            state.collect(item, True)
        except Exception as ex:  # objet que le monde ne sait pas créer
            errors.append(f"{name} : {ex}")
    events = [loc for loc in multiworld.get_locations(1) if not loc.address]
    state.sweep_for_advancements(locations=events)

    def reachable(current) -> list[int]:
        return [loc.address for loc in multiworld.get_reachable_locations(current, 1)
                if isinstance(loc.address, int) and loc.address in missing]

    logic = reachable(state)
    glitched = []
    glitches_item = getattr(world, "glitches_item_name", "")
    if glitches_item:
        try:
            glitch_state = state.copy()
            glitch_state.collect(multiworld.create_item(glitches_item, 1), True)
            glitch_state.sweep_for_advancements(locations=events)
            known = set(logic)
            glitched = [address for address in reachable(glitch_state) if address not in known]
        except Exception as ex:
            errors.append(f"{glitches_item} : {ex}")
    aliases = getattr(world, "location_id_to_alias", {}) or {}
    return json.dumps({"logic": logic, "glitched": glitched, "errors": errors[:20],
                       "aliases": {str(k): v for k, v in aliases.items() if k in missing}})
