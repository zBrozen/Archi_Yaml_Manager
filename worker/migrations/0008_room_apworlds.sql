-- Apworlds déposés par l'hôte pour la génération en ligne : ils remplacent ceux du site (souvent plus anciens)
-- ou ajoutent un jeu absent de la base. Un par jeu ; le fichier est gardé dans le stockage KV (binding FILES),
-- sous la clé « CODE/apworld/fichier ».
CREATE TABLE room_apworlds (
  room_code TEXT NOT NULL,
  game TEXT NOT NULL,
  file TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (room_code, game)
);
CREATE UNIQUE INDEX room_apworlds_file ON room_apworlds(room_code, file);
