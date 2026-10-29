# Archipelago YAML Manager

Un site pour ouvrir, lire et modifier les fichiers YAML de joueur d'[Archipelago](https://archipelago.gg)
sans éditer le code à la main.

- **Déposer un YAML** : chaque option s'affiche avec son explication et un réglage adapté
  (oui/non, liste de choix, curseur, liste d'objets…). Les options communes à tous les jeux sont expliquées en français.
- **Descriptions en français (facultatif)** : les descriptions des options sont affichées en anglais, comme dans
  Archipelago. Le menu « Descriptions FR » en haut de page affiche à la place une traduction automatique
  (voir ci-dessous), approximative. Un jeu lu depuis un apworld déposé par le joueur n'a que l'original anglais.
- **Mode simple (par défaut)** : une valeur par option, uniquement des valeurs valides. Les lignes à poids 0
  des modèles (`random: 0`, `random-low: 0`…) sont masquées : l'option apparaît avec sa seule valeur active.
- **Mode avancé** (interrupteur en haut de page) : tirages au sort, tables de poids avec le pourcentage de chance
  de chaque valeur, options de plando et YAML brut.
- **Repérer les problèmes** : option inconnue ou supprimée, valeur hors limites, nom d'objet invalide,
  YAML écrit pour une ancienne version d'Archipelago.
- **Exporter** : le fichier contient toutes les options du jeu, comme les modèles d'Archipelago ; celles qui
  manquaient sont ajoutées à leur valeur par défaut, avec leur description en commentaire. Le reste du fichier
  (commentaires, mise en forme) est conservé, et une table de poids garde sa forme (la valeur choisie prend
  le poids, les autres passent à 0).
- **Partir de zéro** : créer un YAML vide pour n'importe quel jeu de la base.
- **Jeux non officiels** : le fichier `.apworld` du jeu est obligatoire. Le joueur le dépose avec son YAML
  (ou dans l'encadré qui le demande) et le site le lit avec Archipelago lui-même, exécuté dans le navigateur
  par [Pyodide](https://pyodide.org) : options, descriptions, noms d'objets et règles sont alors exactement
  ceux du jeu. Tant que l'apworld manque, le téléchargement est bloqué. L'apworld est ensuite mémorisé
  dans le navigateur du joueur (on peut l'oublier depuis l'accueil).

Tout se passe dans le navigateur : les fichiers des joueurs ne sont envoyés nulle part.

## Comment le site reste à jour

Les options ne sont pas recopiées à la main. Le workflow GitHub
[`update-data.yml`](.github/workflows/update-data.yml) tourne chaque jour :

1. il recopie dans `apworlds.json` la liste des jeux du tableur du Discord d'Archipelago
   ([`tools/sync_sheet.py`](tools/sync_sheet.py)) ;
2. il télécharge la dernière release d'Archipelago et y ajoute les apworlds de ces jeux (voir ci-dessous) ;
3. il charge tous les jeux avec Archipelago et exporte leurs options en JSON dans `site/data/`
   ([`tools/extract_options.py`](tools/extract_options.py)) ;
4. il traduit en français les descriptions nouvelles ou modifiées
   ([`tools/translate_docs.py`](tools/translate_docs.py)) ;
5. il construit `site/data/ap-core.zip`, la copie d'Archipelago utilisée par le navigateur pour lire
   les apworlds des joueurs ([`tools/build_ap_core.py`](tools/build_ap_core.py)) ;
6. si quelque chose a changé, il enregistre les données et republie le site.

On peut aussi le lancer à la main depuis l'onglet **Actions** de GitHub (« Mettre à jour les options »),
éventuellement en indiquant une version précise d'Archipelago.

## Traduction des descriptions

Les descriptions sont traduites par [Argos Translate](https://github.com/argosopentech/argos-translate),
un traducteur libre qui fonctionne hors ligne : pas de compte, pas de clé, pas de quota.
Les traductions sont gardées dans [`translations/fr.json`](translations/fr.json) (texte anglais → texte français) :
une description déjà traduite ne l'est plus jamais, seules les nouvelles passent par Argos.

Le code entre backticks (` ``!hint`` `), les liens et les étiquettes en début de ligne (`None:`, `**Fast:**`, souvent des
valeurs d'option) ne sont pas traduits.

**Corriger une traduction** : modifier le texte français dans `translations/fr.json` puis pousser sur `main`.
La mise à jour reprend la correction dans les données du site.

## Jeux non officiels

Tous les jeux de la [liste des jeux du Discord d'Archipelago](https://docs.google.com/spreadsheets/d/1iuzDTOAvdoNe8Ne8i461qGNucg5OuEoF-Ikqs8aUQZw)
(feuille « Playable Worlds ») sont ajoutés à la base du site, sans rien faire à la main :

1. [`tools/sync_sheet.py`](tools/sync_sheet.py) réécrit la clé `"games"` de [`apworlds.json`](apworlds.json) :
   un jeu par ligne du tableur, avec sa stabilité (`Stable`, `Unstable`, `Broken on Main`), son statut
   d'intégration (`In Review`, `Not PRing`) et l'indication 18+. Les jeux déjà officiels (`Core`) et ceux
   sans lien GitHub ou GitLab (apworld publié sur Discord, itch.io…) sont laissés de côté.
2. [`tools/fetch_apworlds.py`](tools/fetch_apworlds.py) trouve le dépôt de chaque jeu dans la colonne
   « Links & Downloads » et télécharge l'apworld de sa dernière release. Si le dépôt publie plusieurs jeux,
   il prend le fichier qui porte le nom du jeu, et refuse un apworld d'un autre jeu.
3. Sur le site, ces jeux apparaissent dans la liste de choix, rangés par stabilité, avec une mention 18+,
   et leur page affiche les mêmes badges.

Un jeu sans release avec un `.apworld` est simplement ignoré (résumé à la fin du journal du workflow).
Les apworlds téléchargés et les réponses de l'API GitHub sont gardés en cache d'une exécution à l'autre :
un téléchargement qui échoue reprend la dernière version connue, et la limite de requêtes de GitHub
n'est pas dépassée.

**Réglages à la main** dans `apworlds.json` (conservés par la synchronisation) :

```json
{
  "options": {
    "Shadow the Hedgehog": { "prereleases": true },
    "Un jeu": { "asset": "^monjeu.*\.apworld$" },
    "Autre jeu": { "repo": "auteur/AutreDepot", "tag": "v1.2.0" }
  },
  "exclude": ["Jeu à ne pas proposer"],
  "github": [
    { "repo": "auteur/JeuAbsentDuTableur" }
  ],
  "games": ["… réécrit automatiquement, ne pas modifier …"]
}
```

- `options` règle un jeu par son nom dans le tableur : `prereleases: true` accepte les préversions (utile
  quand l'auteur ne publie que des préversions récentes), `asset` est une expression régulière du nom du
  fichier, `tag` fixe une version, `repo` (GitHub) ou `gitlab` remplace le dépôt du tableur.
- `exclude` écarte des jeux du tableur.
- `github` ajoute un dépôt GitHub pour un jeu absent du tableur (mêmes réglages possibles).
- En dernier recours, un `.apworld` peut être déposé dans [`apworlds/`](apworlds/), seulement si sa licence
  en autorise la redistribution.

**Crédits et licences.** Pour chaque apworld, `site/data/apworld-credits.json` relève le jeu, sa version et
ses auteurs (`archipelago.json` de l'apworld), son dépôt, sa licence (celle incluse dans l'apworld, sinon
celle du dépôt, avec les lignes de copyright) et ses infos du tableur. Le site les affiche via le lien
« Jeux non officiels : auteurs et licences » du pied de page.

Un apworld qui ne se charge pas (par exemple incompatible avec la version d'Archipelago) n'empêche pas
la mise à jour des autres jeux. Il apparaît sur la page d'accueil du site et dans les avertissements du workflow.

> Le code de chaque apworld (plusieurs centaines, écrits par la communauté) est exécuté pendant
> l'extraction. Ce job n'a qu'un accès en lecture au dépôt et ne reçoit pas de jeton d'écriture ;
> `exclude` permet d'écarter un jeu douteux.

## Mise en ligne (GitHub Pages)

1. Dans le dépôt GitHub : **Settings → Pages → Build and deployment → Source : GitHub Actions**.
2. Poussez sur `main` : le workflow « Publier le site » met en ligne le dossier `site/`.

L'adresse est `https://<utilisateur>.github.io/<dépôt>/`.

## Travailler en local

Le site est fait de fichiers statiques, sans étape de compilation :

```bash
py -3 -m http.server 8765 --directory site
```

puis ouvrir <http://localhost:8765>.

Pour régénérer les données à partir d'un clone d'Archipelago (avec ses dépendances Python installées) :

```bash
python tools/extract_options.py --ap ../Archipelago --out site/data
```

puis traduire les descriptions (avec `pip install argostranslate docutils`) :

```bash
python tools/translate_docs.py --data site/data --cache translations/fr.json
```

et l'archive utilisée pour lire les apworlds dans le navigateur :

```bash
python tools/build_ap_core.py --ap ../Archipelago --out site/data/ap-core.zip
```

Les apworlds à tester localement se copient dans `../Archipelago/custom_worlds/`, ou avec
`python tools/fetch_apworlds.py --dest ../Archipelago/custom_worlds`.

## Organisation

| Chemin | Rôle |
| --- | --- |
| `site/` | Le site (HTML, CSS, JavaScript) |
| `site/js/yaml-model.js` | Lecture et export des YAML (comme PyYAML, en YAML 1.1) |
| `site/js/options.js` | Règles de chaque type d'option Archipelago |
| `site/js/apworld.js`, `site/js/apworld-worker.js` | Lecture d'un apworld déposé, avec Pyodide |
| `site/py/` | Code Python exécuté dans le navigateur (`ap_extract.py` est aussi utilisé par la mise à jour) |
| `site/js/editors.js` | Champs d'édition de chaque type d'option |
| `site/data/` | Options des jeux, générées automatiquement |
| `site/vendor/` | Bibliothèques [Preact/htm](https://github.com/developit/htm) et [yaml](https://github.com/eemeli/yaml) |
| `tools/` | Scripts d'extraction et de traduction des options, et de récupération des apworlds |
| `translations/fr.json` | Traductions des descriptions (modifiables à la main) |
| `apworlds.json`, `apworlds/` | Jeux non officiels de la base (voir « Jeux non officiels ») |

## Licence et mentions

Outil non officiel, non affilié à Archipelago ni aux éditeurs des jeux cités. Le code du projet est sous
licence MIT ([`LICENSE`](LICENSE)). Archipelago (MIT), les bibliothèques intégrées et les apworlds non
officiels, avec leurs auteurs et leurs sources, sont crédités dans [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
