-- Photos des cartes de la pêche : image de l'écran partagé d'un joueur, prise par son navigateur au moment où il trouve
-- un objet important (progression, utile ou piège). Le fichier est dans le KV FILES (`CODE/shot/CLÉ`).
-- `shot` : « numéro du joueur dans la partie - numéro du lieu » (le check) ; `slot_name` : son nom dans la partie ;
-- `player_id` : l'inscrit qui l'a envoyée (NULL : l'hôte).
CREATE TABLE card_shots (
  room_code TEXT NOT NULL,
  shot TEXT NOT NULL,
  slot_name TEXT NOT NULL,
  player_id TEXT,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_code, shot)
);
