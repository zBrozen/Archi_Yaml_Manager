-- Rooms : un code court, des joueurs (pseudo) et leurs YAML (un fichier = un slot).
-- Les jetons (hôte, joueurs) ne sont gardés que sous forme d'empreinte SHA-256.

CREATE TABLE rooms (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('sync', 'async')),
  closes_at INTEGER,              -- fin des dépôts (ms depuis 1970), NULL = pas de date
  locked INTEGER NOT NULL DEFAULT 0,
  max_slots INTEGER NOT NULL DEFAULT 3,
  notes TEXT NOT NULL DEFAULT '',
  ap_room_url TEXT,               -- room archipelago.gg une fois la partie hébergée
  admin_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE players (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  pseudo TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX players_pseudo ON players(room_code, pseudo COLLATE NOCASE);

CREATE TABLE slots (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,             -- nom du joueur dans la partie (`name:` du YAML)
  game TEXT NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  issues TEXT NOT NULL DEFAULT '[]', -- problèmes vus par le navigateur du joueur au dépôt (indicatif)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX slots_name ON slots(room_code, name COLLATE NOCASE);
CREATE INDEX slots_player ON slots(player_id);
