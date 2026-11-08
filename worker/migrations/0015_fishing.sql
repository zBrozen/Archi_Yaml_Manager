-- Pêche au large : la collection de cartes de chaque inscrit (checks de la partie pêchés), visible par toute la room.
-- `who` : identifiant du joueur (players.id), ou « host » pour l'hôte. `cards` : clés des cartes pêchées
-- (« joueur qui reçoit:rang », séparées par des virgules) ; `shiny` et `gold` : nombre de cartes brillantes et dorées.
CREATE TABLE fishing (
  room_code TEXT NOT NULL,
  who TEXT NOT NULL,
  cards TEXT NOT NULL DEFAULT '',
  shiny INTEGER NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_code, who)
);
