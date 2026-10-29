# Notes pour les assistants IA

- Jeux non officiels : la clé `"games"` de `apworlds.json` est **réécrite automatiquement** par
  `tools/sync_sheet.py` (job `sync` du workflow `update-data.yml`) à partir de la feuille
  « Playable Worlds » du tableur des jeux du Discord d'Archipelago. Ne pas la modifier à la main : les
  réglages vont dans `"options"` (par nom de jeu du tableur), `"exclude"` et `"github"`.
- `tools/fetch_apworlds.py` trouve le dépôt de chaque jeu (colonne « Links & Downloads »), télécharge
  l'apworld de la dernière release (avec cache ETag et repli sur la dernière version connue), et écrit
  `site/data/apworld-credits.json` (auteurs, source, licence, infos du tableur). `extract_options.py`
  recopie les infos du tableur (stabilité, PR, 18+) dans `index.json` (`sheet`), que le site affiche.
  Détails dans la section « Jeux non officiels » du README.
- Ne pas recommiter de `.apworld` tiers dans `apworlds/` si l'auteur publie des releases : le dépôt ne
  doit pas redistribuer ce qu'il peut télécharger. Mentions légales : `LICENSE`, `THIRD_PARTY_LICENSES.md`,
  pied de page du site (`Footer` dans `site/js/main.js`).
- Tester les scripts en local sous Windows : `py -3`, et si erreur SSL, `SSL_CERT_FILE` vers le
  `ca-bundle.crt` de Git. Sans jeton GitHub, l'API limite à 60 requêtes par heure : tester sur un
  extrait de `apworlds.json`.
