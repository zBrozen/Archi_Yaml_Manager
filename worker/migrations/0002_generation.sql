-- Génération en ligne (workflow GitHub generate-room.yml). Les fichiers produits (partie, spoiler)
-- sont gardés dans le stockage KV (binding FILES), pas dans la base.

ALTER TABLE rooms ADD COLUMN gen_status TEXT;          -- NULL, 'queued', 'running', 'done', 'failed'
ALTER TABLE rooms ADD COLUMN gen_message TEXT;
ALTER TABLE rooms ADD COLUMN gen_run_url TEXT;         -- journal du workflow (public)
ALTER TABLE rooms ADD COLUMN gen_at INTEGER;           -- dernière demande ou mise à jour
ALTER TABLE rooms ADD COLUMN gen_options TEXT NOT NULL DEFAULT '{}';
ALTER TABLE rooms ADD COLUMN gen_files TEXT NOT NULL DEFAULT '{}'; -- { output: "AP_….zip", spoiler: "AP_…_Spoiler.txt" }
