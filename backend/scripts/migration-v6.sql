-- Migration v6 : Statut des versements (validation)
BEGIN;
ALTER TABLE versements_caisse ADD COLUMN IF NOT EXISTS statut TEXT NOT NULL DEFAULT 'valide' CHECK (statut IN ('en_attente','valide','refuse'));
ALTER TABLE versements_caisse ADD COLUMN IF NOT EXISTS valide_par BIGINT REFERENCES users(id);
ALTER TABLE versements_caisse ADD COLUMN IF NOT EXISTS valide_le TIMESTAMPTZ;
ALTER TABLE versements_caisse ADD COLUMN IF NOT EXISTS motif_refus TEXT;
CREATE INDEX IF NOT EXISTS idx_versements_caisse_statut ON versements_caisse(statut);
INSERT INTO parametres(cle, valeur) VALUES ('versement_validateur','admin')
ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur;
COMMIT;
