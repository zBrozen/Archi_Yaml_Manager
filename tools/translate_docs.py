"""Traduit en français les descriptions des options, avec Argos Translate (hors ligne, gratuit).

Usage :
    python tools/translate_docs.py --data site/data --cache translations/fr.json

Pour chaque option de <data>/games/*.json, ajoute :
    doc_fr        la description traduite
    doc_html_fr   sa version HTML, pour les jeux qui en ont une (doc_html)

Les traductions sont gardées dans le cache ({texte anglais: texte français}) : seuls les
textes nouveaux ou modifiés sont traduits. On peut corriger une traduction à la main dans
ce fichier, elle sera reprise à la mise à jour suivante. Les entrées qui ne servent plus
sont retirées.

Si Argos Translate n'est pas disponible, seul le cache est utilisé.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "site" / "py"))
from ap_extract import rst_to_html  # noqa: E402

# Début de ligne de liste : « - », « * », « 1. », « a) »…
LIST_MARKER = re.compile(r"^(\s*(?:[-*+•]|\d+[.)]|[a-zA-Z][.)]|#\.)\s+)")
# Étiquette en début de ligne (« None: », « **Fast:** »…) : c'est souvent une valeur d'option, on la garde.
LABEL = re.compile(r"^(\**[A-Z0-9][\w'’.()/+-]*(?: [\w'’.()/+-]+){0,3}\**\s*:\**\s+)(?=\S)")
# Code et valeurs YAML (``x``, `x`) et liens : à ne pas traduire.
PROTECTED = re.compile(r"``.+?``|`[^`]+`_*|https?://\S+")
PLACEHOLDER = "XZ{}"
PLACEHOLDER_BACK = re.compile(r"XZ\s?(\d+)")


def load_translator() -> Callable[[str], str] | None:
    try:
        import argostranslate.package
        import argostranslate.translate
    except ImportError:
        return None
    installed = {(p.from_code, p.to_code) for p in argostranslate.package.get_installed_packages()}
    if ("en", "fr") not in installed:
        argostranslate.package.update_package_index()
        package = next(p for p in argostranslate.package.get_available_packages()
                       if p.from_code == "en" and p.to_code == "fr")
        argostranslate.package.install_from_path(package.download())
    return argostranslate.translate.get_translation_from_codes("en", "fr").translate


def translate_text(text: str, translate: Callable[[str], str]) -> str:
    """Traduit un morceau de texte en laissant intacts le code et les liens."""
    if not re.search(r"[A-Za-z]{2}", text):
        return text
    kept: list[str] = []

    def protect(match: re.Match) -> str:
        kept.append(match.group(0))
        return PLACEHOLDER.format(len(kept) - 1)

    result = translate(PROTECTED.sub(protect, text))
    if text[:1].isupper() and result[:1].islower():
        result = result[0].upper() + result[1:]
    result = PLACEHOLDER_BACK.sub(lambda m: kept[int(m.group(1))] if int(m.group(1)) < len(kept) else m.group(0), result)
    # Un morceau protégé perdu par le traducteur : on garde l'original plutôt qu'un texte faux.
    return result if all(k in result for k in kept) else text


def logical_lines(block: str) -> list[str]:
    """Regroupe les lignes coupées au milieu d'une phrase ; garde les vraies lignes (listes, « Valeur: … »)."""
    lines: list[str] = []
    last_raw = ""  # dernière ligne d'origine : sa longueur indique une coupure à la largeur du texte
    for line in block.split("\n"):
        previous = lines[-1] if lines else None
        joined = (previous is not None and not LIST_MARKER.match(line)
                  and not re.search(r"[.!?:;)]\**$", previous.rstrip())
                  and (re.match(r"\s*[a-z(]", line) or previous.rstrip().endswith(",") or len(last_raw.rstrip()) >= 60))
        if joined:
            lines[-1] = previous.rstrip() + " " + line.strip()
        else:
            lines.append(line)
        last_raw = line
    return lines


def translate_line(line: str, translate: Callable[[str], str]) -> str:
    prefix = LIST_MARKER.match(line)
    head = prefix.group(1) if prefix else re.match(r"\s*", line).group(0)
    body = line[len(head):]
    label = LABEL.match(body)
    if label:
        head += label.group(1)
        body = body[len(label.group(1)):]
    return head + translate_text(body, translate) if body.strip() else line


def translate_doc(doc: str, translate: Callable[[str], str]) -> str:
    """Traduit une description en gardant ses paragraphes, ses listes et ses blocs de code."""
    parts = re.split(r"(\n[ \t]*\n)", doc)
    out: list[str] = []
    literal = False  # bloc après « :: » (reStructuredText) : du code, laissé tel quel
    for i, part in enumerate(parts):
        if i % 2 == 1:
            out.append(part)
            continue
        stripped = part.lstrip("\n")
        indented = stripped[:1] in (" ", "\t")
        if (literal and indented) or stripped.startswith((".. ", "+-", "==")):
            out.append(part)
            continue
        literal = part.rstrip().endswith("::")
        out.append("\n".join(translate_line(line, translate) for line in logical_lines(part)))
    return "".join(out)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True, help="Dossier des données du site (contient games/)")
    parser.add_argument("--cache", required=True, help="Fichier JSON des traductions déjà faites")
    args = parser.parse_args()

    cache_path = Path(args.cache)
    cache: dict[str, str] = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    files = sorted((Path(args.data) / "games").glob("*.json"))
    games = {path: json.loads(path.read_text(encoding="utf-8")) for path in files}
    options = [option for data in games.values() for group in data["groups"] for option in group["options"]]

    docs = sorted({option["doc"] for option in options if option.get("doc")})
    missing = [doc for doc in docs if doc not in cache]
    translate = load_translator() if missing else None
    if missing and translate is None:
        print(f"::warning::Argos Translate indisponible : {len(missing)} descriptions restent en anglais.")
    elif missing:
        print(f"{len(missing)} descriptions à traduire ({len(docs) - len(missing)} déjà en cache).", flush=True)
        for n, doc in enumerate(missing, 1):
            cache[doc] = translate_doc(doc, translate)
            if n % 100 == 0:
                print(f"  {n}/{len(missing)}", flush=True)

    for option in options:
        option.pop("doc_fr", None)
        option.pop("doc_html_fr", None)
        french = cache.get(option.get("doc", ""))
        if not french:
            continue
        option["doc_fr"] = french
        if "doc_html" in option:
            html = rst_to_html(french)
            if html:
                option["doc_html_fr"] = html

    changed = 0
    for path, data in games.items():
        content = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if content != path.read_bytes():
            path.write_bytes(content)
            changed += 1

    used = {doc: cache[doc] for doc in docs if doc in cache}
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cache_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(used, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    print(f"{len(used)}/{len(docs)} descriptions traduites, {changed} fichiers de jeu modifiés.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
