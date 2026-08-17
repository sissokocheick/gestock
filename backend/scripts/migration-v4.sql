-- ============================================================
-- Migration v4 : gestion par lot au niveau produit et famille
-- Ajoute gere_par_lot (BOOLEAN) sur produits et familles.
-- Si un produit a gere_par_lot = true, les champs numero_lot
-- et date_peremption sont obligatoires lors des réceptions.
-- Si la famille a gere_par_lot = true, ses produits héritent
-- automatiquement à la création.
-- ============================================================

BEGIN;

ALTER TABLE familles ADD COLUMN IF NOT EXISTS gere_par_lot BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE produits ADD COLUMN IF NOT EXISTS gere_par_lot BOOLEAN NOT NULL DEFAULT false;

-- Si un produit n'a pas gere_par_lot mais sa famille l'a, on l'active
UPDATE produits SET gere_par_lot = true
WHERE famille_id IS NOT NULL
  AND gere_par_lot = false
  AND EXISTS (SELECT 1 FROM familles f WHERE f.id = produits.famille_id AND f.gere_par_lot = true);

COMMIT;
