"""Lecture d'un apworld dans le navigateur, avec Pyodide (voir js/apworld-worker.js).

Archipelago est décompressé dans /ap (archive data/ap-core.zip). L'apworld déposé est copié
dans /ap/custom_worlds, puis chargé exactement comme le ferait Archipelago : on obtient ainsi
les vraies définitions d'options du jeu, décrites par ap_extract (le même code que la mise à
jour automatique de la base).
"""
from __future__ import annotations

import importlib
import importlib.abc
import importlib.machinery
import json
import logging
import os
import sys
import types
import zipfile
import zipimport

AP_DIR = "/ap"
CUSTOM_DIR = f"{AP_DIR}/custom_worlds"

# Modules natifs ou d'interface (clients de jeu, mémoire, réseau) absents du navigateur.
# Les mondes les importent pour leur client, jamais pour leurs options : on les remplace par
# des modules factices. Les modules optionnels (orjson, _speedups…) restent introuvables pour que
# les `try: import … except ImportError` d'Archipelago prennent leur chemin normal.
STUBBED = {
    "kivy", "kivymd", "websockets", "bsdiff4", "cx_Freeze", "tkinter", "jellyfish", "Pymem", "pymem",
    "PyMemoryEditor", "dolphin_memory_engine", "pyshortcuts", "psutil", "win32api", "win32con", "win32gui",
    "pywintypes", "requests", "aiohttp", "nest_asyncio", "portpicker", "pyautogui", "pygame", "kvui",
}
used_stubs: set[str] = set()


class _Anything:
    """Objet factice : accepte tout appel, attribut, héritage ou décorateur."""

    def __init__(self, *args, **kwargs): pass
    def __call__(self, *args, **kwargs): return _Anything()
    def __getattr__(self, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return _Anything()
    def __iter__(self): return iter(())
    def __bool__(self): return False
    def __mro_entries__(self, bases): return (object,)


class _StubModule(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return _Anything()


class _StubFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] in STUBBED:
            return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
        return None

    def create_module(self, spec):
        used_stubs.add(spec.name.split(".")[0])
        module = _StubModule(spec.name)
        module.__path__ = []
        return module

    def exec_module(self, module):
        pass


def _orjson_module() -> types.ModuleType:
    """orjson (bibliothèque JSON rapide, native) n'existe pas dans Pyodide : même interface sur `json`."""
    module = types.ModuleType("orjson")

    def dumps(obj, default=None, option=None):
        return json.dumps(obj, default=default, separators=(",", ":")).encode("utf-8")

    def __getattr__(name):
        if name.startswith("OPT_"):
            return 0
        raise AttributeError(name)

    module.dumps = dumps
    module.loads = json.loads
    module.JSONDecodeError = json.JSONDecodeError
    module.JSONEncodeError = TypeError
    module.__getattr__ = __getattr__
    return module


def _patch_threads() -> None:
    """Le navigateur ne peut pas lancer de thread. Les tâches confiées à un pool (chargement de
    données de certains mondes) sont exécutées tout de suite ; les threads de fond des clients
    (lecture de journaux, connexions) ne sont simplement pas démarrés."""
    import concurrent.futures
    import concurrent.futures.thread
    import threading

    class ImmediateExecutor(concurrent.futures.Executor):
        def __init__(self, *args, **kwargs):
            pass

        def submit(self, fn, /, *args, **kwargs):
            future = concurrent.futures.Future()
            try:
                future.set_result(fn(*args, **kwargs))
            except BaseException as ex:
                future.set_exception(ex)
            return future

        def shutdown(self, wait=True, *, cancel_futures=False):
            pass

    concurrent.futures.ThreadPoolExecutor = ImmediateExecutor
    concurrent.futures.ProcessPoolExecutor = ImmediateExecutor
    concurrent.futures.thread.ThreadPoolExecutor = ImmediateExecutor
    threading.Thread.start = lambda self: None


def setup() -> None:
    sys.path[:0] = [AP_DIR, f"{AP_DIR}/site-packages"]
    sys.meta_path.append(_StubFinder())
    _patch_threads()
    try:
        import orjson  # noqa: F401
    except ImportError:
        sys.modules["orjson"] = _orjson_module()
    os.makedirs(CUSTOM_DIR, exist_ok=True)
    os.chdir(AP_DIR)
    logging.disable(logging.WARNING)
    import ModuleUpdate
    ModuleUpdate.update_ran = True  # pas d'installation de dépendances ici
    import Options  # noqa: F401  (vérifie dès maintenant que le cœur se charge)


def _package_name(path: str) -> str:
    """Nom du module de l'apworld : Archipelago le déduit du nom de fichier, qui doit être celui
    du dossier contenu dans l'archive. On le relit dans l'archive pour accepter un fichier renommé
    (« monjeu (1).apworld »…)."""
    with zipfile.ZipFile(path) as archive:
        roots = {name.split("/")[0] for name in archive.namelist()
                 if name.count("/") == 1 and name.endswith("/__init__.py")}
    if len(roots) != 1:
        raise ValueError("Ce fichier n'est pas un apworld valide (aucun dossier de jeu à l'intérieur).")
    return roots.pop()


def extract(upload: str) -> str:
    package = _package_name(upload)
    for old in os.listdir(CUSTOM_DIR):
        os.remove(os.path.join(CUSTOM_DIR, old))
    target = os.path.join(CUSTOM_DIR, f"{package}.apworld")
    os.replace(upload, target)

    # Oublie le monde lu précédemment pour qu'Archipelago parcoure de nouveau custom_worlds.
    for name in [n for n in sys.modules if n == "worlds" or n.startswith("worlds.")]:
        del sys.modules[name]
    zipimport._zip_directory_cache.clear()
    used_stubs.clear()

    import Options
    worlds = importlib.import_module("worlds")
    from worlds.AutoWorld import AutoWorldRegister
    from ap_extract import describe_world, world_source

    games, errors = [], {}
    for game, world in AutoWorldRegister.world_types.items():
        if world.hidden or world_source(worlds, world)[0] != "custom":
            continue
        try:
            games.append(describe_world(Options, worlds, game, world))
        except Exception as ex:
            errors[game] = f"{type(ex).__name__}: {ex}"
    for name, reason in worlds.failed_world_loads.items():
        lines = reason.strip().splitlines()
        errors[name] = lines[-1] if lines else "échec du chargement"
    return json.dumps({"games": games, "errors": errors, "stubbed": sorted(used_stubs)}, ensure_ascii=False)
