-- Apworlds déposés par les joueurs avec leurs YAML (en plus de ceux de l'hôte), et options lues par le navigateur
-- de celui qui l'a déposé : l'hôte vérifie la room avec elles sans relire le fichier. Les options sont gardées dans
-- le stockage KV (clé « CODE/apworld-data/fichier »).
ALTER TABLE room_apworlds ADD COLUMN player_id TEXT; -- NULL : déposé par l'hôte
ALTER TABLE room_apworlds ADD COLUMN has_data INTEGER NOT NULL DEFAULT 0;
