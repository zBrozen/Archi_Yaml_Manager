-- Wishlists : objets qu'un joueur attend dans la partie hébergée, par nom de joueur dans la partie (slot).
CREATE TABLE wishlists (
  room_code TEXT NOT NULL,
  slot TEXT NOT NULL COLLATE NOCASE,
  items TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_code, slot)
);
