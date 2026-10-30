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
- **Apworld plus récent que celui du serveur** : un apworld déposé passe toujours avant celui de la base du site
  (souvent en retard sur le tableur ou sur la dernière release), y compris pour un jeu officiel. La page du jeu le
  signale et propose de revenir à celui du serveur ; un YAML qui demande une version plus récente que celle du
  serveur propose de déposer l'apworld. L'apworld mémorisé est oublié de lui-même quand le serveur passe à une
  version au moins aussi récente. Le fichier lui-même est gardé dans le navigateur (IndexedDB) pour partir dans
  les rooms avec les YAML de son jeu (voir « Génération en ligne »).

- **Rooms** : un hôte crée une room, les joueurs la rejoignent avec un code court et leur pseudo, et y déposent
  leurs YAML (un fichier par jeu). L'hôte vérifie la room, télécharge tous les YAML pour générer la partie avec
  son Archipelago, puis l'héberge sur archipelago.gg : chaque joueur retrouve l'adresse, le tracker et ses fichiers
  sur la page de la room. Voir la section « Rooms ».
- **Trackers** : les packs [PopTracker](https://github.com/black-sliver/PopTracker) des jeux s'ouvrent
  directement dans le site (objets, cartes, lieux accessibles), et suivent la partie en direct. Voir la section
  « Trackers (packs PopTracker) ».

Hors rooms, tout se passe dans le navigateur : les fichiers des joueurs ne sont envoyés nulle part.

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

## Rooms

Une room rassemble les YAML de tous les joueurs d'une partie, en ligne. Le site reste statique : les rooms
sont gardées par un petit service gratuit sur Cloudflare (dossier [`worker/`](worker/) : un Worker et une
base D1), toujours disponible sans laisser de PC allumé.

À la création, l'hôte choisit entre **rassembler les YAML** (déroulement ci-dessous) et suivre une **partie
déjà hébergée** : il colle alors le lien de la room archipelago.gg, et la room passe directement à l'étape 5
(adresse, fichiers, progression, client texte, écrans), sans dépôt ni génération. Les joueurs la rejoignent avec
leur nom dans la partie, qui sert à retrouver leurs fichiers.

**Déroulement**

1. L'hôte crée la room (onglet « Rooms ») : nom, type de partie (sync ou async), nombre de YAML par joueur,
   date de fin des dépôts. Il reçoit un code de 6 caractères et un lien d'hôte, à garder pour lui.
2. Les joueurs entrent le code et leur pseudo, puis déposent leurs YAML ou les créent avec l'éditeur. Chaque
   YAML est un joueur de la partie, avec un nom fixe (sans `{number}`), unique dans la room et d'au plus
   16 caractères. Un fichier à plusieurs documents (`---`) est découpé en un YAML par document.
   Un lien personnel permet de reprendre depuis un autre appareil.
   L'hôte peut aussi ajouter des joueurs lui-même (onglet « Joueurs ») et déposer des YAML pour n'importe quel
   joueur de la room (« Déposer pour » dans « Mes YAML », ou « Déposer un YAML » sur la ligne du joueur) ; il
   obtient le lien personnel du joueur à lui transmettre (un nouveau lien remplace l'ancien).
3. L'hôte ferme les dépôts (à la date prévue ou à la main) et clique sur « Vérifier la room ». Chaque YAML est
   contrôlé dans son navigateur avec les règles de l'éditeur. Sont aussi signalés : les joueurs sans YAML, le
   DeathLink en async, les jeux instables ou cassés, et les apworlds non officiels à installer (avec leur dépôt).
4. L'hôte clique sur **Générer en ligne** (voir « Génération en ligne » ci-dessous), ou télécharge le zip des
   YAML, le décompresse dans le dossier `Players` de son Archipelago et lance **Generate**. Il envoie la partie
   générée sur [archipelago.gg/uploads](https://archipelago.gg/uploads) lui-même : seul celui qui envoie la
   partie a accès à la console de la room.
5. L'hôte colle le lien de la room archipelago.gg sur la page de la room. Tout le monde y voit alors l'adresse
   du serveur, le tracker et ses propres fichiers (patchs), lus avec l'API publique `room_status` d'archipelago.gg
   et sur la page de la room (lue par le service : les liens de l'API ne marchent pas pour les jeux non officiels).
6. Pendant la partie, la page de la room montre la progression de chaque joueur (checks, état, dernière
   activité, signalée en async au-delà de 2 jours ; API publique du tracker d'archipelago.gg) et les **objets
   reçus** par les joueurs cochés, avec une recherche commune (regroupés par importance, puis les derniers
   arrivés avec qui les a envoyés et d'où ; noms
   lus dans le « datapackage » de chaque jeu, `/api/datapackage/<checksum>`), et propose un
   **client texte** : chat et commandes (`!hint`, `!remaining`…) depuis le navigateur, avec
   [archipelago.js](https://github.com/ThePhar/archipelago.js) (`site/vendor/archipelago.js`).
   Chaque joueur remplit aussi sa **wishlist** (onglet « Wishlist ») parmi les objets de son jeu : en rouge tant
   qu'ils manquent, en vert une fois reçus (un bouton retire les objets reçus). Un objet déjà reçu (progressif,
   cumulable…) peut être attendu une fois de plus : il passe au vert quand son nombre augmente. Quand l'un
   d'eux arrive, la room le prévient par un bandeau, et le client texte comme l'overlay mettent la ligne en avant
   (♥ Wishlist). Les wishlists sont gardées par le service (table `wishlists`), par nom de joueur dans la partie.
7. Pour un stream, les joueurs peuvent partager la fenêtre de leur jeu, et l'hôte l'afficher dans OBS
   (voir « Écrans des joueurs » ci-dessous).

Les YAML déposés dans une room sont visibles par leur auteur et par l'hôte. Une room sans activité depuis
90 jours est supprimée automatiquement.

**Mise en place (une seule fois)**

1. Créer un compte gratuit sur [Cloudflare](https://dash.cloudflare.com). Ouvrir une fois **Workers & Pages**
   pour choisir le sous-domaine `workers.dev` du compte.
2. **Storage & Databases → D1 → Create** : base nommée `archi-rooms`. Noter son identifiant (Database ID).
3. **My Profile → API Tokens → Create Token**, modèle « Edit Cloudflare Workers », en ajoutant la permission
   *Account → D1 → Edit*. Noter le jeton, ainsi que l'identifiant du compte (Account ID, visible sur la page
   d'accueil de Workers & Pages).
4. Dans le dépôt GitHub, **Settings → Secrets and variables → Actions** :
   secrets `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID`, variable `D1_DATABASE_ID`.
5. Lancer le workflow « Publier le service des rooms » (onglet **Actions**). Il crée les tables et publie le
   service ; son adresse (`https://archi-rooms.<sous-domaine>.workers.dev`) apparaît dans le journal.
   Il se relance seul à chaque modification de `worker/`.
6. Indiquer cette adresse dans `DEPLOYED` de [`site/js/config.js`](site/js/config.js) et pousser sur `main`.
   Tant qu'elle est vide, l'onglet « Rooms » n'apparaît pas sur le site en ligne.

### Écrans des joueurs (overlay OBS)

Onglet « Écrans » de la room :

- **Joueurs** : « Partager la fenêtre de mon jeu » ouvre le choix de fenêtre du navigateur (Chrome, Edge ou
  Firefox sur ordinateur, rien à installer). L'image part directement vers l'overlay, sans son, et n'est
  enregistrée nulle part. Un jeu en plein écran exclusif donne une image noire ou figée, car le navigateur ne le
  voit pas : le passer en fenêtré (certains, comme Jak avec OpenGOAL, restent figés même sans bordure), ou
  partager la **caméra virtuelle d'OBS** à la place de la fenêtre. Dans OBS, une source « Capture de jeu » voit
  aussi les jeux en plein écran ; « Démarrer la caméra virtuelle » la rend disponible comme une webcam, que le
  site choisit d'office parmi les caméras (avec la définition et les images par seconde de la qualité choisie).

  Chaque joueur règle sa **qualité**, y compris pendant le partage : légère (720p, 30 images/s, 1,5 Mb/s),
  normale (720p, 3 Mb/s, par défaut), haute (1080p, 6 Mb/s) ou maximale (1080p, 60 images/s, 12 Mb/s), et ce
  qu'il faut garder si le débit manque (netteté, fluidité ou un équilibre des deux). Le débit est envoyé à
  chaque overlay qui affiche le jeu, et le streamer reçoit celui de tous les écrans affichés. Le 1080p ne sert
  que si l'overlay affiche peu d'écrans.

  Le navigateur estime lui-même le débit qu'il peut envoyer vers l'overlay : sans aide, Chrome part de
  0,3 Mb/s et met des dizaines de secondes à monter. Le site lui impose donc un débit de départ (et, en qualité
  haute ou maximale, un minimum), avec les paramètres `x-google-*` ajoutés à la réponse de l'overlay. Il
  propose aussi en premier le codec que la carte graphique sait encoder (AV1, VP9 ou H.264, détecté avec
  `navigator.mediaCapabilities`), plutôt que le VP8 encodé par le processeur. La page montre ce qui part
  réellement (définition, images par seconde, débit, codec et encodeur), le débit que le navigateur
  s'autorise, la latence et les pertes, et explique ce qui réduit l'image : débit de la qualité choisie,
  estimation encore en train de monter, réseau qui perd des paquets ou encodage trop lourd.
- **Hôte** : « Créer un lien » donne une adresse secrète (`#/overlay/CODE/CLÉ`) à mettre dans OBS en source
  **Navigateur** (1920 × 1080, fond transparent). L'hôte peut en créer plusieurs (10 au maximum), nommés, par
  exemple un par streamer ou par ordinateur : ils restent dans la liste de l'onglet « Écrans », à recopier depuis
  tout appareil où il est hôte, sans en recréer (table `overlay_links`, migration 0007). Supprimer un lien ne coupe
  que les overlays ouverts avec lui. Un lien créé avant cette liste (une seule clé par room) la rejoint quand
  l'hôte rouvre la room dans le navigateur qui l'avait créé. Un lien coché « Visible par les joueurs de la room »
  (migration 0010) apparaît dans l'onglet « Écrans » de chaque joueur inscrit, sous « Overlays de l'hôte » : un
  co-streamer copie lui-même l'adresse pour son OBS, en grille automatique ou avec une disposition de l'hôte, sans
  que l'hôte ait à la lui envoyer. Les autres liens restent réservés à l'hôte. Les écrans partagés s'y placent seuls en grille,
  aussi grands que possible, et les **messages de la partie** (objets envoyés, objectifs atteints, release et
  collect) défilent à côté. Les réglages choisis sur la page sont ajoutés au lien copié : nombre d'écrans
  (`max`, 4 par défaut, de 0 = messages seuls à 6), place des messages (`console=droite|bas|non`) et objets
  montrés (`objets=tous|importants` : progression, utiles et pièges). Les objets de progression et les pièges
  sont marqués ★ et ⚠, en plus de leur couleur. 3 overlays affichant des écrans au maximum par room, car chaque joueur envoie son image à chacun.

Les messages viennent du serveur de la partie sur archipelago.gg, une fois son lien collé dans la room : l'overlay
s'y connecte comme client texte du premier joueur (comme le client texte de la room, avec
[archipelago.js](https://github.com/ThePhar/archipelago.js)), qui apparaît donc connecté une fois de plus.

**Dispositions.** Pour placer chaque élément soi-même, l'hôte crée des dispositions dans l'éditeur de l'onglet
« Écrans » (jusqu'à 12 par room, 40 éléments chacune), en partant d'un modèle (grille, écrans avec messages et
progression, un grand écran et trois petits, deux équipes). Sur une page 16/9 qui représente la source OBS, il
ajoute, déplace et redimensionne à la souris ou au clavier :

- des **écrans** : automatiques (remplis dans l'ordre des partages, par numéro) ou réservés à un joueur, avec ou
  sans son nom et son jeu ; un écran sans joueur qui partage reste transparent ;
- les **messages de la partie** (tous les objets ou les importants) ;
- la **progression** des joueurs (checks faits et totaux, joueurs qui ont fini ; API du tracker d'archipelago.gg) ;
- des **textes** (noms d'équipes, titre…).

Taille du texte, fond sombre ou texte ombré directement sur la scène, et ordre de superposition se règlent pour
chaque élément. Chaque disposition a son propre lien (`?disposition=ID`, avec l'un des liens de la liste) ;
l'enregistrer met à jour tout de suite les overlays ouverts, sans toucher à OBS. Les dispositions sont gardées
par le service (colonne `overlay_layouts`, validée par `overlayLayouts` dans [`worker/src/index.js`](worker/src/index.js)).

Fonctionnement : les navigateurs se transmettent l'image en pair à pair (WebRTC). Le service ne fait que les
mettre en relation, par WebSocket, avec un Durable Object par room (`ScreenRoom` dans
[`worker/src/index.js`](worker/src/index.js)), inclus dans l'offre gratuite de Cloudflare et publié par le même
workflow, sans réglage de plus. Les connexions passent par des serveurs STUN publics, sans relais TURN :
certains réseaux (NAT strict, 4G, réseaux d'entreprise) peuvent ne pas passer, et l'overlay l'indique sur
l'écran du joueur concerné.

### Génération en ligne

L'hôte choisit les réglages du serveur (release, collect, `!remaining`, coût des indices) et s'il veut un
spoiler, puis clique sur **Générer en ligne**. Le service lance le workflow
[`generate-room.yml`](.github/workflows/generate-room.yml) ([`tools/room_generate.py`](tools/room_generate.py)) :

1. il lit les YAML de la room ;
2. il installe la version d'Archipelago des données du site, et seulement les apworlds des jeux de la room,
   pris dans le cache de la mise à jour quotidienne (les mêmes versions que celles vérifiées par le site), sauf
   ceux que l'hôte a déposés (voir ci-dessous) ;
3. il génère la partie en quelques minutes, avec les réglages de l'hôte, dans un conteneur Docker sans réseau ;
4. il renvoie la partie au service, et le spoiler à part. La page de la room propose alors à l'hôte (et à lui
   seul) de télécharger la partie, à envoyer sur archipelago.gg, et le spoiler.

**Apworlds de la room.** Un joueur qui a un apworld à lui (plus récent que celui du site, ou jeu absent du site)
l'envoie à la room avec ses YAML : le site le fait de lui-même pour un apworld mémorisé dans son navigateur, y compris
pour des YAML déjà déposés, et il peut aussi déposer le fichier `.apworld` avec ses YAML (un apworld mémorisé avant
l'ajout de cette fonction n'a gardé que ses options : la room demande alors le fichier). L'hôte peut en ajouter ou en
retirer sous « Générer en ligne ». Un par jeu, 20 au plus, 25 Mo chacun ; un joueur ne remplace ni ne retire que les
siens, tant que les dépôts sont ouverts. Le site lit le fichier avec Archipelago pour connaître son jeu et ses
options, envoyés avec lui (table `room_apworlds`, fichier et options dans le KV, supprimés avec la room ou le joueur).
Sur la page de la room, ces options passent avant celles du site et de l'apworld du navigateur : l'hôte vérifie la
room avec, sans avoir l'apworld lui-même, et peut le télécharger pour générer chez lui. Le générateur l'installe à
la place de celui du site ; pour un jeu officiel, il retire le monde intégré, sans quoi Archipelago ignorerait l'apworld.

**Isolement.** N'importe quel hôte peut ainsi faire exécuter du code par le workflow. Archipelago et tous les
apworlds tournent donc dans un conteneur Docker sans réseau, qui ne voit que le dossier d'Archipelago, les YAML
et le dossier de sortie : ni le secret `ROOMS_GENERATOR_SECRET`, ni le jeton du workflow, ni le cache des
apworlds. Les dépendances sont installées dans l'image du conteneur avant l'ajout du moindre apworld.

**Spoilers.** Le zip à héberger ne contient jamais de spoiler : il ne peut donc pas apparaître sur
archipelago.gg. Le journal du workflow est public (dépôt public) : il montre les noms des joueurs et leurs
jeux, mais ni le contenu des YAML ni l'emplacement des objets. Les fichiers générés sont gardés 30 jours.

**Limites.** Les jeux qui ont besoin de leur ROM pour générer (A Link to the Past, Ocarina of Time…), les jeux
absents de la base du site dont l'hôte n'a pas déposé l'apworld, ceux dont la génération a besoin du réseau, et les parties de plus de 25 minutes de génération se génèrent sur l'ordinateur
de l'hôte ; la page de la room l'indique en cas d'échec.

**Coût.** Rien : les GitHub Actions sont gratuites et sans limite de minutes pour un dépôt public, et une
génération n'utilise que quelques requêtes et une ou deux écritures du stockage KV de Cloudflare (limite
gratuite : 1 000 écritures par jour).

**Mise en place (une seule fois)**

1. Cloudflare, **Storage & Databases → KV → Create** : espace nommé `archi-rooms-files`. Noter son identifiant.
   Le jeton d'API Cloudflare doit avoir la permission *Account → Workers KV Storage → Edit* (incluse dans le
   modèle « Edit Cloudflare Workers »).
2. GitHub, **photo de profil → Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token** : accès au seul dépôt `Archi_Yaml_Manager`, permission *Repository permissions →
   Actions → Read and write*. Ce jeton permet au service de lancer le workflow.
3. Dans le dépôt, **Settings → Secrets and variables → Actions** :
   - secret `ROOMS_DISPATCH_TOKEN` : le jeton GitHub de l'étape 2 ;
   - secret `ROOMS_GENERATOR_SECRET` : une longue suite de caractères au hasard, inventée pour l'occasion
     (elle protège les échanges entre le workflow et le service) ;
   - variable `KV_NAMESPACE_ID` : l'identifiant de l'étape 1.
4. Relancer le workflow « Publier le service des rooms ». Le bouton **Générer en ligne** apparaît alors dans
   l'espace de l'hôte.

Le jeton GitHub expire à la date choisie à sa création : il suffit alors d'en créer un nouveau et de remplacer
le secret, puis de relancer « Publier le service des rooms ».

## Trackers (packs PopTracker)

Page `#/tracker` : un pack PopTracker lu par le navigateur, sans installer PopTracker. On y arrive par le lien
« tracker du pack » de chaque joueur dans la progression d'une room (jeu, serveur et nom du joueur déjà remplis),
ou directement en choisissant le jeu ou en déposant le `.zip` d'un pack.

- **Packs.** `tools/fetch_trackers.py` (job `sync` de `update-data.yml`) relève les liens « Poptracker » du
  tableur des jeux. Il lit la page HTML du tableur : l'export xlsx ne garde que le premier lien de chaque
  cellule. Pour chaque pack GitHub, la release visée (sinon la dernière) donne l'archive `.zip`, notée dans
  `site/data/trackers.json`. Le navigateur la télécharge par le relais `/api/packs` du service des rooms
  (GitHub n'autorise pas sa lecture directe depuis une autre adresse) ; rien n'est stocké, la réponse reste
  une journée dans le cache de Cloudflare.
- **Moteur** (`site/js/tracker-engine.js`) : objets, lieux, cartes et dispositions du pack, règles d'accès
  (`[facultatif]`, `{visible}`, `$fonction`, `^$niveau`, `@lieu`, `code:nombre`), comme décrit dans
  la documentation des packs de PopTracker (`doc/PACKS.md`). Aucun code de PopTracker n'est repris (GPL-3.0).
- **Lua** : les scripts des packs tournent dans Lua 5.4 compilé en WebAssembly (`site/vendor/wasmoon.*`).
  L'interface PopTracker (`Tracker`, `ScriptHost`, `Archipelago`…) est écrite en Lua dans
  `site/js/tracker-lua.js`. Les scripts ne reçoivent aucun objet JavaScript : un objet exposé à Lua laisserait
  remonter jusqu'au constructeur `Function` de la page, et donc à ses jetons. Pas de fichiers, de processus
  ni de bytecode non plus.
- **Suivi de la partie** (`site/js/tracker-ap.js`) : connexion au serveur comme simple tracker (tag
  `Tracker`) sur le slot du joueur. Le pack reçoit ce que PopTracker lui transmettrait : slot_data, lieux
  faits, objets reçus, stockage. Rien n'est envoyé au serveur.
- **Limites.** Lecture de la mémoire d'un émulateur (packs sans suivi Archipelago), `recentpins` et une partie
  des options de mise en page ne sont pas gérés ; l'état coché à la main n'est pas gardé d'une visite à l'autre.

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

Pour les rooms, le site ouvert sur `localhost` utilise le service lancé en local sur le port 8787
(avec [Node.js](https://nodejs.org), sans compte Cloudflare, base D1 simulée sur le disque) :

```bash
cd worker
npx wrangler d1 migrations apply archi-rooms --local
npx wrangler dev
```

## Organisation

| Chemin | Rôle |
| --- | --- |
| `site/` | Le site (HTML, CSS, JavaScript) |
| `site/js/yaml-model.js` | Lecture et export des YAML (comme PyYAML, en YAML 1.1) |
| `site/js/options.js` | Règles de chaque type d'option Archipelago |
| `site/js/apworld.js`, `site/js/apworld-worker.js` | Lecture d'un apworld déposé, avec Pyodide |
| `site/py/` | Code Python exécuté dans le navigateur (`ap_extract.py` est aussi utilisé par la mise à jour) |
| `site/js/editors.js` | Champs d'édition de chaque type d'option |
| `site/js/rooms.js`, `site/js/rooms-api.js` | Pages des rooms et appels au service des rooms |
| `site/js/room-live.js` | Partie en cours : progression des joueurs et client texte |
| `site/js/wishlist.js` | Wishlists des joueurs et bandeau des objets attendus reçus |
| `site/js/tracker-*.js`, `site/js/trackers.js`, `site/js/unzip.js` | Trackers des packs PopTracker (voir « Trackers ») |
| `site/js/check.js` | Vérification d'un YAML hors de l'éditeur (dépôt dans une room, contrôle par l'hôte) |
| `site/js/config.js` | Adresse du service des rooms |
| `worker/` | Service des rooms (Cloudflare Worker, base D1 : `migrations/`) |
| `tools/room_generate.py` | Génération en ligne d'une room (workflow `generate-room.yml`) |
| `site/data/` | Options des jeux, générées automatiquement |
| `site/vendor/` | Bibliothèques [Preact/htm](https://github.com/developit/htm), [yaml](https://github.com/eemeli/yaml), [archipelago.js](https://github.com/ThePhar/archipelago.js) et [wasmoon](https://github.com/ceifa/wasmoon) (Lua) |
| `tools/` | Scripts d'extraction et de traduction des options, et de récupération des apworlds |
| `translations/fr.json` | Traductions des descriptions (modifiables à la main) |
| `apworlds.json`, `apworlds/` | Jeux non officiels de la base (voir « Jeux non officiels ») |

## Licence et mentions

Outil non officiel, non affilié à Archipelago ni aux éditeurs des jeux cités. Le code du projet est sous
licence MIT ([`LICENSE`](LICENSE)). Archipelago (MIT), les bibliothèques intégrées et les apworlds non
officiels, avec leurs auteurs et leurs sources, sont crédités dans [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
