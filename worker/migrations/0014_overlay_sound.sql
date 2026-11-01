-- Son entendu sur l'overlay d'un espace, choisi en direct par son créateur ou l'hôte : l'identifiant d'un joueur,
-- "vedette" (le son suit l'écran en vedette) ou NULL (aucun son).
ALTER TABLE overlay_links ADD COLUMN sound TEXT;
