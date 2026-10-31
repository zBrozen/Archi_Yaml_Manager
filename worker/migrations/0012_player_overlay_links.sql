-- Espaces de partage d'écrans (liens de l'overlay) créés par un joueur : player_id est le joueur qui l'a créé,
-- NULL pour l'hôte. Tous les inscrits voient et copient tous les espaces ; seuls le créateur et l'hôte les
-- renomment, les règlent ou les suppriment. Ceux d'un joueur partent avec lui. La colonne `shared` n'est plus utilisée.
ALTER TABLE overlay_links ADD COLUMN player_id TEXT;
-- Réglages de l'overlay de l'espace (JSON : mode automatique ou dispositions par nombre d'écrans), et joueur mis
-- en vedette en direct par le créateur ou l'hôte.
ALTER TABLE overlay_links ADD COLUMN config TEXT;
ALTER TABLE overlay_links ADD COLUMN featured TEXT;
