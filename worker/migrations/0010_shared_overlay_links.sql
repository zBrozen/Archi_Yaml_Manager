-- Liens de l'overlay que l'hôte rend visibles aux joueurs de la room (co-streamers d'une équipe…) : ils les
-- copient eux-mêmes dans l'onglet « Écrans », sans que l'hôte ait à les leur envoyer.
ALTER TABLE overlay_links ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
