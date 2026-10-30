-- Liens de l'overlay OBS : plusieurs par room (un par streamer ou par source OBS), gardés pour être recopiés
-- depuis n'importe quel appareil de l'hôte, et supprimables un à un. La clé est gardée telle quelle (pas en
-- empreinte) pour pouvoir redonner le lien ; seul l'hôte la reçoit. L'ancienne clé unique (rooms.overlay_hash)
-- rejoint la liste quand l'hôte rouvre la room dans le navigateur qui l'avait créée.
CREATE TABLE overlay_links (
  id TEXT PRIMARY KEY,
  room_code TEXT NOT NULL,
  name TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX overlay_links_key ON overlay_links(room_code, key);
