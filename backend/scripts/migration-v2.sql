-- Migration v2 : modes de paiement paramétrables + sécurisation
CREATE TABLE IF NOT EXISTS modes_paiement (
  id      BIGSERIAL PRIMARY KEY,
  code    TEXT NOT NULL UNIQUE,
  nom     TEXT NOT NULL,
  especes BOOLEAN NOT NULL DEFAULT false,
  actif   BOOLEAN NOT NULL DEFAULT true,
  ordre   INT NOT NULL DEFAULT 0
);
INSERT INTO modes_paiement(code, nom, especes, ordre) VALUES
  ('especes', 'Espèces', true, 1),
  ('mobile', 'Mobile money', false, 2),
  ('carte', 'Carte', false, 3)
ON CONFLICT (code) DO UPDATE SET nom = EXCLUDED.nom, especes = EXCLUDED.especes;

-- Les ventes acceptent désormais n'importe quel mode (validé côté serveur via modes_paiement)
ALTER TABLE ventes DROP CONSTRAINT IF EXISTS ventes_mode_check;

CREATE TRIGGER trg_audit_modes_paiement AFTER INSERT OR UPDATE OR DELETE ON modes_paiement FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
