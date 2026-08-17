-- ============================================================
-- Migration v5 : Dépenses + catégories
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS depenses (
  id         BIGSERIAL PRIMARY KEY,
  date       TIMESTAMPTZ NOT NULL DEFAULT now(),
  montant    NUMERIC(12,2) NOT NULL CHECK (montant > 0),
  categorie  TEXT NOT NULL,
  motif      TEXT,
  mode       TEXT NOT NULL DEFAULT 'especes',
  user_id    BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_depenses_date ON depenses(date);
CREATE INDEX IF NOT EXISTS idx_depenses_categorie ON depenses(categorie);

-- Trigger audit
CREATE TRIGGER trg_audit_depenses AFTER INSERT OR UPDATE OR DELETE ON depenses
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

-- Droits
GRANT SELECT, INSERT, UPDATE, DELETE ON depenses TO gsv_app;
GRANT USAGE, SELECT ON depenses_id_seq TO gsv_app;

COMMIT;
