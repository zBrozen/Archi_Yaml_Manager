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
- Dans le navigateur, un apworld déposé (`data.js`, `local`) passe avant le jeu de la base : `gameEntry` renvoie
  d'abord l'entrée de la room (`source: "room"`, page d'une room), puis l'entrée locale (`source: "apworld"`), dont
  `server` décrit le jeu de la base remplacé (sa source, `core` ou non, est là).
- Ne pas recommiter de `.apworld` tiers dans `apworlds/` si l'auteur publie des releases : le dépôt ne
  doit pas redistribuer ce qu'il peut télécharger. Mentions légales : `LICENSE`, `THIRD_PARTY_LICENSES.md`,
  pied de page du site (`Footer` dans `site/js/main.js`).
- Tester les scripts en local sous Windows : `py -3`, et si erreur SSL, `SSL_CERT_FILE` vers le
  `ca-bundle.crt` de Git. Sans jeton GitHub, l'API limite à 60 requêtes par heure : tester sur un
  extrait de `apworlds.json`.
- `extract_options.py` charge les apworlds par lots, chacun dans son propre processus (temps et
  mémoire limités) ; un lot qui plante est coupé en deux jusqu'à isoler le fautif, signalé dans
  `index.json` (`errors`). `fetch_apworlds.py` écarte en amont les apworlds dont le manifeste ferait
  planter Archipelago pour tous les mondes (version mal formée, zip invalide).
- Rooms : le site appelle le service `worker/` (Cloudflare Worker + D1, publié par `deploy-worker.yml`),
  dont l'adresse est dans `site/js/config.js` (en local : `http://localhost:8787`, `npx wrangler dev`).
  L'hébergement passe par archipelago.gg (envoi par l'hôte). La génération se fait chez l'hôte ou en ligne :
  le service lance `generate-room.yml` (`tools/room_generate.py`), qui lit les YAML et renvoie la partie avec le
  secret partagé `GENERATOR_SECRET` ; fichiers dans le KV `FILES`. Le spoiler est toujours séparé de la partie.
  Apworlds de la room (table `room_apworlds`, KV `CODE/apworld/fichier` et ses options `CODE/apworld-data/fichier`) :
  envoyés par les joueurs avec leurs YAML (`shareApworlds`, fichier gardé en IndexedDB par `data.js`) ou par l'hôte ;
  ils passent avant ceux du site, pour la vérification (`setRoomGames`, page de la room seulement) et la génération. Comme n'importe quel hôte peut ainsi faire exécuter du code, Archipelago ne tourne que dans un conteneur
  Docker sans réseau (`--image`) : ne jamais lui passer le secret ni monter autre chose que AP, YAML et sortie.
  Toute nouvelle table ou colonne passe par une migration dans `worker/migrations/`.
  Écrans des joueurs (overlay OBS, page `#/overlay/CODE/CLÉ`) : WebRTC entre navigateurs, mise en relation par le
  Durable Object `ScreenRoom` du Worker (une instance par room). `screens.js` : partage du joueur et lien de l'hôte ;
  `overlay.js` : la page de l'overlay ; `overlay-layout.js` : modèle des dispositions (mêmes limites que le Worker) ;
  `overlay-editor.js` : éditeur ; `screens-net.js` : WebSocket commun. Liens de l'overlay : table `overlay_links`
  (clé gardée en clair, montrée à l'hôte seul) ; `rooms.overlay_hash` n'est plus que l'ancienne clé unique, reprise
  dans la liste à la réouverture par l'hôte.
  Wishlists (`wishlist.js`, table `wishlists`, par nom de joueur dans la partie) : objets reçus d'après le tracker
  d'archipelago.gg, noms lus dans les datapackages ; le tracker est lu une fois par `RoomPage` pour tous les onglets.
- Lisibilité, y compris en stream : le site (pages des rooms surtout) doit rester lisible quand il est filmé
  ou intégré comme overlay dans un stream (source navigateur OBS) : textes assez grands et aérés, contrastes
  élevés en clair comme en sombre (pas de noir pur sous du blanc pur), information jamais portée par la
  seule couleur, mise en page qui tient dans une fenêtre étroite. À vérifier à chaque changement d'interface.
