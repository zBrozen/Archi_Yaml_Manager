-- Dispositions de l'overlay OBS créées par l'hôte avec l'éditeur (liste JSON, voir overlayLayouts dans src/index.js).
ALTER TABLE rooms ADD COLUMN overlay_layouts TEXT NOT NULL DEFAULT '[]';
