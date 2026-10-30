-- Écrans des joueurs : clé du lien de l'overlay OBS, créée par l'hôte (seulement son empreinte SHA-256).
ALTER TABLE rooms ADD COLUMN overlay_hash TEXT;
