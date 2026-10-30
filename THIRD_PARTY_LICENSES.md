# Licences tierces

Ce projet est un outil **non officiel**. Il n'est ni affilié à Archipelago ni approuvé par ses
développeurs, ni par les éditeurs des jeux cités. Les noms de jeux, d'objets et de lieux appartiennent
à leurs propriétaires respectifs et ne sont cités que pour décrire les options. Le site ne contient
aucun fichier des jeux (ROM, assets).

Le code propre au projet est sous licence MIT (voir [`LICENSE`](LICENSE)). Il réutilise les éléments suivants.

| Élément | Où | Licence |
|---|---|---|
| [Archipelago](https://github.com/ArchipelagoMW/Archipelago) | `site/data/ap-core.zip`, données extraites dans `site/data/games/` | MIT (texte ci-dessous) |
| [Preact](https://github.com/preactjs/preact) + [htm](https://github.com/developit/htm) | `site/vendor/preact-htm.js` | MIT |
| [yaml](https://github.com/eemeli/yaml) | `site/vendor/yaml.js` | ISC |
| [archipelago.js](https://github.com/ThePhar/archipelago.js) | `site/vendor/archipelago.js` (client texte des rooms) | MIT |
| [Pyodide](https://github.com/pyodide/pyodide) | chargé depuis jsDelivr par `site/js/apworld-worker.js` | MPL-2.0 |
| [schema](https://github.com/keleshev/schema) | `site/data/ap-core.zip` | MIT |
| [typing_extensions](https://github.com/python/typing_extensions) | `site/data/ap-core.zip` | PSF-2.0 |
| [colorama](https://github.com/tartley/colorama) | `site/data/ap-core.zip` | BSD-3-Clause |
| [platformdirs](https://github.com/tox-dev/platformdirs) | `site/data/ap-core.zip` | MIT |
| [pathspec](https://github.com/cpburnz/python-pathspec) | `site/data/ap-core.zip`, sans modification | MPL-2.0 |
| [docutils](https://docutils.sourceforge.io) | `site/data/ap-core.zip` | domaine public / BSD-2-Clause |

## Jeux non officiels (apworlds)

Ce dépôt ne redistribue pas les apworlds non officiels. À chaque mise à jour, ils sont téléchargés depuis
la release officielle de leur auteur (voir [`apworlds.json`](apworlds.json) et la
[liste des jeux en développement](https://docs.google.com/spreadsheets/d/1iuzDTOAvdoNe8Ne8i461qGNucg5OuEoF-Ikqs8aUQZw)
du Discord d'Archipelago), et le site ne publie que les options qui en sont extraites.

Les auteurs, dépôts et licences de chaque jeu sont relevés automatiquement dans
[`site/data/apworld-credits.json`](site/data/apworld-credits.json) et affichés sur le site
(lien « Jeux non officiels : auteurs et licences » en pied de page).

Un apworld déposé par un joueur dans le site reste dans son navigateur : il n'est ni envoyé ni redistribué.

## Licence d'Archipelago

```
MIT License

Copyright (c) 2017 LLCoolDave
Copyright (c) 2025 Berserker66
Copyright (c) 2022 CaitSith2
Copyright (c) 2021 LegendaryLinux

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Subdirectories of this repository may contain their own LICENSE file. Files within
subdirectories containing their own LICENSE file are exempt from the above license
and are subject to the license contained within the LICENSE file in their containing
directory.

```
