-- Rooms créées directement avec le lien d'une partie déjà hébergée sur archipelago.gg : pas de dépôt de YAML
-- ni de génération, seulement le suivi de la partie (progression, client texte, écrans).
ALTER TABLE rooms ADD COLUMN direct INTEGER NOT NULL DEFAULT 0;
