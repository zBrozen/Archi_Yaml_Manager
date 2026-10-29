# Archipelago YAML Manager

Un site pour ouvrir, lire et modifier les fichiers YAML de joueur d'[Archipelago](https://archipelago.gg)
sans éditer le code à la main.

- **Déposer un YAML** : chaque option s'affiche avec son explication et un réglage adapté
  (oui/non, liste de choix, curseur, liste d'objets…). Les options communes à tous les jeux sont expliquées en français.
- **Descriptions en français** : les descriptions des options des jeux de la base sont traduites automatiquement
  (voir ci-dessous). Le menu en haut de page permet de revenir à l'original anglais. Un jeu lu depuis un apworld
  déposé par le joueur garde ses descriptions en anglais.
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

1. il télécharge la dernière release d'Archipelago ;
2. il y ajoute les apworlds du serveur (voir ci-dessous) ;
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

## Ajouter un apworld à la base du site

Un jeu ajouté à la base n'a plus besoin de son apworld côté joueur. Deux possibilités, cumulables :

- **Fichier** : déposer le `.apworld` dans le dossier [`apworlds/`](apworlds/) puis pousser sur `main`.
- **Release GitHub** : ajouter le dépôt dans [`apworlds.json`](apworlds.json). Le dernier `.apworld` publié
  est retéléchargé à chaque mise à jour.

  ```json
  {
    "github": [
      { "repo": "auteur/MonJeu-AP" },
      { "repo": "auteur/AutreJeu", "tag": "v1.2.0" },
      { "repo": "auteur/PlusieursJeux", "asset": "^monjeu.*\\.apworld$" }
    ]
  }
  ```

  `tag` (facultatif) fixe une version ; `asset` (facultatif) est une expression régulière pour choisir
  le bon fichier quand une release en contient plusieurs.

Un apworld qui ne se charge pas (par exemple incompatible avec la version d'Archipelago) n'empêche pas
la mise à jour des autres jeux. Il apparaît sur la page d'accueil du site et dans les avertissements du workflow.

> Le code d'un apworld est exécuté pendant l'extraction. Ce job n'a qu'un accès en lecture au dépôt,
> mais n'ajoutez que des apworlds de sources de confiance.

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
| `apworlds/`, `apworlds.json` | Apworlds du serveur |
