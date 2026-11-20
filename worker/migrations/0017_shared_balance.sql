-- Équilibre entre les joueurs, pour les joueurs à qui l'hôte a ouvert l'onglet « Avancement » : résumé de la partie
-- générée (sphères et placement des objets, en JSON) envoyé par l'hôte avec le spoiler (KV FILES, clé
-- CODE/shared-balance, supprimée avec la copie du spoiler).
ALTER TABLE rooms ADD COLUMN shared_balance TEXT; -- { name, at, size } de la copie, NULL sans copie
