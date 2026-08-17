-- Migration : caisses virtuelles
CREATE TABLE IF NOT EXISTS caisses (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  ouverte_le    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fonds_initial NUMERIC(12,2) NOT NULL DEFAULT 0,
  fermee_le     TIMESTAMPTZ,
  total_attendu NUMERIC(12,2),
  total_compte  NUMERIC(12,2),
  ecart         NUMERIC(12,2),
  notes         TEXT,
  statut        TEXT NOT NULL DEFAULT 'ouverte' CHECK (statut IN ('ouverte','fermee','validee')),
  validee_le    TIMESTAMPTZ,
  validee_par   BIGINT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_caisses_user   ON caisses(user_id);
CREATE INDEX IF NOT EXISTS idx_caisses_statut ON caisses(statut);

ALTER TABLE ventes ADD COLUMN IF NOT EXISTS caisse_id BIGINT REFERENCES caisses(id);
CREATE INDEX IF NOT EXISTS idx_ventes_caisse ON ventes(caisse_id);

CREATE TABLE IF NOT EXISTS versements_caisse (
  id        BIGSERIAL PRIMARY KEY,
  caisse_id BIGINT NOT NULL REFERENCES caisses(id) ON DELETE CASCADE,
  date      TIMESTAMPTZ NOT NULL DEFAULT now(),
  montant   NUMERIC(12,2) NOT NULL,
  mode      TEXT NOT NULL DEFAULT 'especes',
  motif     TEXT,
  user_id   BIGINT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_versements_caisse ON versements_caisse(caisse_id);

CREATE TRIGGER trg_audit_caisses AFTER INSERT OR UPDATE ON caisses FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_versements_caisse AFTER INSERT ON versements_caisse FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
