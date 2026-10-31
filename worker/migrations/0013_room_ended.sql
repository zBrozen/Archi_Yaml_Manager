-- Room clôturée par l'hôte (partie terminée) : plus de dépôts, de nouveaux joueurs ni de génération ; elle reste
-- lisible et l'hôte peut la rouvrir. NULL = en cours.
ALTER TABLE rooms ADD COLUMN ended_at INTEGER;
