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
- Page « Installer un jeu » (`#/installer?game=…`, `guides.js`) : liens d'installation des crédits (`download`,
  `release`, `links`, relevés par `fetch_apworlds.py`) et guides du jeu (`site/data/guides/`, relevés par
  `extract_options.py` dans `docs/` du monde, plus README du dépôt et notes de release passés par
  `fetch_apworlds.py --guides`). Les guides sont écrits par les auteurs des apworlds : `markdown.js`
  les rend en nœuds Preact, jamais en HTML brut (ne pas passer à `innerHTML` / `dangerouslySetInnerHTML`).
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
  Jeux qui exigent leur ROM pour générer (champ `rom`, relevé par `ap_extract.py` via `stage_assert_generate`) :
  signalés par la vérification, génération en ligne refusée. Ne pas ajouter de dépôt de ROM (droits d'auteur, et
  le code d'un apworld de l'hôte pourrait la recopier dans la partie).
  Écrans des joueurs (overlay OBS, page `#/overlay/CODE/CLÉ`) : WebRTC entre navigateurs, mise en relation par le
  Durable Object `ScreenRoom` du Worker (une instance par room). `screens.js` : partage du joueur et lien de l'hôte ;
  `overlay.js` : la page de l'overlay ; `overlay-layout.js` : modèle des dispositions (mêmes limites que le Worker) ;
  `overlay-editor.js` : éditeur ; `screens-net.js` : WebSocket commun. Liens de l'overlay : table `overlay_links`
  (clé gardée en clair, montrée à l'hôte, et aux joueurs inscrits pour les liens `shared` via `shared_overlays`) ; `rooms.overlay_hash` n'est plus que l'ancienne clé unique, reprise
  dans la liste à la réouverture par l'hôte.
  Wishlists (`wishlist.js`, table `wishlists`, par nom de joueur dans la partie) : objets reçus d'après le tracker
  d'archipelago.gg, noms lus dans les datapackages ; le tracker est lu une fois par `RoomPage` pour tous les onglets.
  Inventaire de départ (sphère 0) : absent de l'API du tracker (`player_items_received` ne lit que les objets reçus) ;
  `GET /ap-inventory/<slot>` du Worker lit le tableau `received-table` du tracker générique d'archipelago.gg
  (inventaire avec le départ), `startingFrom` (`room-live.js`) en retire les objets reçus si les deux lectures concordent.
  Avancement (`spoiler.js`, onglet de l'hôte) : lecture du spoiler au format de `Spoiler.to_file` (BaseClasses.py,
  niveau 2 au moins pour le « Playthrough »), lieux reliés aux checks du tracker par les datapackages (un lieu sans
  numéro est un événement, non suivi). Le spoiler reste dans le navigateur de l'hôte (IndexedDB `room-spoilers`), sauf
  s'il ouvre l'onglet à des joueurs (`players.spoiler_access`) : copie dans le KV (`CODE/shared-spoiler`,
  `rooms.shared_spoiler`), lue par `GET /spoiler` (hôte ou joueur autorisé), supprimée au dernier joueur décoché.
- Trackers (`#/tracker`, section « Trackers » du README) : packs PopTracker relevés par `tools/fetch_trackers.py`
  (`site/data/trackers.json`, page HTML du tableur car l'export xlsx perd les liens multiples d'une cellule),
  téléchargés par le relais `/api/packs` du Worker. `tracker-engine.js` reproduit le format des packs d'après la
  documentation de PopTracker, sans reprendre son code (GPL-3.0). Lua (wasmoon) n'a accès à aucun objet JS :
  `enableProxy: false`, une seule passerelle `__js(op, …)` qui n'échange que des valeurs simples, l'interface
  PopTracker écrite en Lua (`tracker-lua.js`). Ne jamais exposer un objet JS à Lua (remontée jusqu'à `Function`).
- Prévision avant génération (`forecast.js`, carte de l'éditeur et vérification de la room) : heuristiques sur les
  noms et valeurs des options, notées par rapport à la valeur par défaut (un YAML aux réglages par défaut donne
  toujours « Standard / Normale »). Après un changement des règles, relancer sur tous les jeux de `index.json` :
  aucune erreur, aucun écart aux réglages par défaut, et relire les options classées par catégorie (faux positifs).
  Les curseurs de la carte (`suggestSettings`) changent une option à la fois vers le niveau visé : vérifier aussi que
  le niveau annoncé est celui obtenu et qu'aucune proposition ne crée de risque.
- Lisibilité, y compris en stream : le site (pages des rooms surtout) doit rester lisible quand il est filmé
  ou intégré comme overlay dans un stream (source navigateur OBS) : textes assez grands et aérés, contrastes
  élevés en clair comme en sombre (pas de noir pur sous du blanc pur), information jamais portée par la
  seule couleur, mise en page qui tient dans une fenêtre étroite. À vérifier à chaque changement d'interface.
