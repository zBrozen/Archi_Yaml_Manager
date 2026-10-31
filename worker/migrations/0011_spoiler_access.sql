-- Onglet « Avancement » ouvert par l'hôte à certains joueurs : ils lisent la copie du spoiler envoyée par l'hôte
-- (KV FILES, clé CODE/shared-spoiler, supprimée quand plus aucun joueur n'y a accès).
ALTER TABLE players ADD COLUMN spoiler_access INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN shared_spoiler TEXT; -- { name, at, size } de la copie, NULL sans copie
