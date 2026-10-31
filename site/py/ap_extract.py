"""Description des options d'un monde Archipelago, au format lu par le site.

Partagé entre la mise à jour automatique (tools/extract_options.py) et le navigateur,
qui l'exécute avec Pyodide pour lire un apworld déposé par un joueur (voir browser_entry.py).
"""
from __future__ import annotations

import os
from inspect import cleandoc
from textwrap import dedent
from typing import Any


# Clés acceptées dans la section d'un jeu sans être des options (voir Generate.roll_settings).
EXTRA_SECTION_KEYS = {
    "A Link to the Past": ["sprite_pool", "sprite", "random_sprite_on_event"],
}


def rst_to_html(text: str) -> str | None:
    """Même conversion que le WebHost d'Archipelago (filtre rst_to_html)."""
    try:
        from docutils.core import publish_parts
    except ImportError:
        return None
    if text.startswith((" ", "\t")):
        text = dedent(text)
    elif "\n" in text:
        lines = text.splitlines()
        text = lines[0] + "\n" + dedent("\n".join(lines[1:]))
    try:
        return publish_parts(text, writer="html", settings=None, settings_overrides={
            "raw_enable": False,
            "file_insertion_enabled": False,
            "output_encoding": "unicode",
            "report_level": 5,  # pas d'avertissements docutils dans le HTML
        })["body"]
    except Exception:
        return None


def json_safe(value: Any) -> Any:
    if isinstance(value, (set, frozenset)):
        return sorted((json_safe(v) for v in value), key=str)
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def option_kind(Options, option) -> str:
    """Type d'éditeur à utiliser côté site. L'ordre des tests compte (sous-classes d'abord)."""
    checks = [
        ("removed", "Removed"),
        ("plando", "PlandoConnections"),
        ("plando", "PlandoTexts"),
        ("plando", "PlandoItems"),
        ("plando", "ItemLinks"),
        ("toggle", "Toggle"),
        ("text_choice", "TextChoice"),
        ("choice", "Choice"),
        ("named_range", "NamedRange"),
        ("range", "Range"),
        ("text", "FreeText"),
        ("counter", "OptionCounter"),
        ("dict", "OptionDict"),
        ("set", "OptionSet"),
        ("list", "OptionList"),
    ]
    for kind, class_name in checks:
        cls = getattr(Options, class_name, None)
        if cls is not None and issubclass(option, cls):
            return kind
    return "unknown"


def describe_option(Options, world, key: str, option) -> dict[str, Any]:
    kind = option_kind(Options, option)
    doc = cleandoc(option.__doc__) if option.__doc__ else ""
    rich = option.rich_text_doc if option.rich_text_doc is not None else getattr(world.web, "rich_text_options_doc", False)
    data: dict[str, Any] = {
        "key": key,
        "name": getattr(option, "display_name", key),
        "kind": kind,
        "doc": doc,
        "weighted": bool(option.supports_weighting),
        "visibility": int(option.visibility),
    }
    if rich and option.__doc__:
        html = rst_to_html(option.__doc__)
        if html:
            data["doc_html"] = html

    default = option.default
    if kind == "toggle":
        data["default"] = "true" if default else "false"
    elif kind in ("choice", "text_choice"):
        # Tri par identifiant : certains mondes construisent leurs choix depuis un set (ordre aléatoire).
        data["choices"] = [
            {"value": name, "label": option.get_option_name(value), "id": value}
            for value, name in sorted(option.name_lookup.items(), key=lambda kv: (str(type(kv[0])), kv[0]))
        ]
        canonical = set(option.name_lookup.values())
        data["aliases"] = {name: option.name_lookup.get(value, value)
                           for name, value in sorted(option.options.items()) if name not in canonical}
        if isinstance(default, int) and default in option.name_lookup:
            data["default"] = option.name_lookup[default]
        else:
            data["default"] = json_safe(default)
    elif kind in ("range", "named_range"):
        data["min"] = option.range_start
        data["max"] = option.range_end
        data["default"] = json_safe(default)
        if kind == "named_range":
            data["special"] = json_safe(option.special_range_names)
    else:
        data["default"] = json_safe(default)

    if kind in ("set", "list", "dict", "counter"):
        # Mêmes règles que VerifyKeys.verify : valid_keys d'abord, puis noms d'objets / de lieux.
        data["valid_keys"] = sorted(str(k) for k in getattr(option, "valid_keys", []) or [])
        if getattr(option, "valid_keys_casefold", False):
            data["casefold"] = True
        if getattr(option, "verify_item_name", False):
            data["key_source"] = "items"
        elif getattr(option, "verify_location_name", False):
            data["key_source"] = "locations"
        if data.get("key_source") and getattr(option, "convert_name_groups", False):
            data["name_groups"] = True
    if kind == "counter":
        data["min"] = getattr(option, "min", None)
        data["max"] = getattr(option, "max", None)
    return data


def world_source(worlds_module, world) -> tuple[str, str | None]:
    """Renvoie ("core" | "custom", nom du fichier .apworld éventuel)."""
    module = world.__module__.split(".")
    name = module[1] if len(module) > 1 else module[0]
    for source in worlds_module.world_sources:
        if source.name == name:
            file = os.path.basename(source.path) if source.is_zip else None
            return ("core" if source.relative else "custom"), file
    return "core", None


def valid_groups(groups: dict[str, Any], names: Any) -> list[str]:
    """Groupes utilisables dans les options : Archipelago refuse un groupe qui contient un nom inexistant."""
    return sorted(name for name, members in groups.items() if set(members) <= set(names))


def required_file(group, settings) -> dict[str, str] | None:
    """Premier fichier obligatoire d'une section de host.yaml (lu sans déclencher la demande du fichier)."""
    for name in getattr(type(group), "__annotations__", {}):
        try:
            value = object.__getattribute__(group, name)
        except AttributeError:
            continue
        if isinstance(value, settings.FilePath) and value.required:
            return {"setting": name, "file": str(value), "description": value.description or ""}
    return None


def generation_file(world) -> dict[str, str] | None:
    """Fichier que le monde exige pour générer (sa ROM, le plus souvent), ou None.

    Archipelago appelle stage_assert_generate au début de chaque génération : les mondes qui ont besoin de leur
    ROM y vérifient sa présence (les autres ne la lisent qu'au moment où le joueur applique son patch). On
    l'appelle ici sans aucun fichier disponible : dossier utilisateur vide, host.yaml par défaut, pas de fenêtre
    pour choisir le fichier. Un FileNotFoundError signale un fichier exigé, quelle que soit la machine."""
    from worlds.AutoWorld import World
    if getattr(world.stage_assert_generate, "__func__", None) is World.stage_assert_generate.__func__:
        return None
    import tempfile
    import settings
    import Utils
    saved = (settings.no_gui, settings.skip_autosave, Utils.user_path, getattr(settings.get_settings, "_cache", None))
    with tempfile.TemporaryDirectory() as empty:
        settings.no_gui = settings.skip_autosave = True
        Utils.user_path = lambda *parts: os.path.join(empty, *parts)
        fresh = settings.Settings(None)
        settings.get_settings._cache = fresh
        try:
            world.stage_assert_generate(None)
            return None
        except FileNotFoundError:
            try:
                found = required_file(fresh[world.settings_key], settings)
            except Exception:
                found = None
            return {"section": world.settings_key, **(found or {})}
        except Exception:  # autre vérification (options des joueurs…) : rien à voir avec un fichier
            return None
        finally:
            settings.no_gui, settings.skip_autosave, Utils.user_path, settings.get_settings._cache = saved
            if hasattr(world, "_AutoWorldRegister__settings"):
                world._AutoWorldRegister__settings = None  # réglages lus pendant la vérification, à oublier


def describe_world(Options, worlds_module, game: str, world) -> dict[str, Any]:
    collapsed = {"Game Options": False}
    for group in world.web.option_groups:
        collapsed[group.name] = group.start_collapsed

    groups = []
    for group_name, options in Options.get_option_groups(world, visibility_level=Options.Visibility.none).items():
        described = [describe_option(Options, world, key, option) for key, option in options.items()]
        if described:
            groups.append({"name": group_name, "collapsed": collapsed.get(group_name, False), "options": described})

    source, apworld = world_source(worlds_module, world)
    version = getattr(world, "world_version", None)
    try:
        rom = generation_file(world)
    except Exception:  # détection seulement : elle ne doit jamais empêcher de lire les options
        rom = None
    return {
        "game": game,
        "source": source,
        "apworld": apworld,
        "world_version": version.as_simple_string() if version and any(version) else None,
        # Seulement pour les jeux concernés : les autres fichiers restent tels quels.
        **({"rom": rom} if rom is not None else {}),
        "groups": groups,
        "extra_keys": EXTRA_SECTION_KEYS.get(game, []),
        "items": sorted(world.item_names),
        "item_groups": valid_groups(getattr(world, "item_name_groups", {}), world.item_names),
        "locations": sorted(world.location_names),
        "location_groups": valid_groups(getattr(world, "location_name_groups", {}), world.location_names),
    }
