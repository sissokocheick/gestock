-- Migration v7 : Numero unique pour produits, familles, ventes, mouvements
BEGIN;

-- Produits : reference_unique
ALTER TABLE produits ADD COLUMN IF NOT EXISTS reference TEXT UNIQUE;
-- Generer des references pour les produits existants
UPDATE produits SET reference = 'PRD-' || lpad(id::text, 6, '0') WHERE reference IS NULL;

-- Familles : code_unique
ALTER TABLE familles ADD COLUMN IF NOT EXISTS code TEXT UNIQUE;
UPDATE familles SET code = 'FAM-' || lpad(id::text, 4, '0') WHERE code IS NULL;

-- Ventes : deja un numero unique (numero)
-- Mouvements : reference
ALTER TABLE mouvements ADD COLUMN IF NOT EXISTS reference TEXT;
UPDATE mouvements SET reference = 'MVT-' || lpad(id::text, 8, '0') WHERE reference IS NULL;

COMMIT;
