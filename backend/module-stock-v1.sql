-- ============================================================
-- Module Stock avancé (Phase 1+2) - Gestion Stock & Vente
-- Magasins, services, bons (FEFO), demandes, inventaires,
-- suggestions de réappro, import Sage 100.
--
-- Additif : ne modifie aucune table existante (seulement
-- ALTER ... ADD COLUMN IF NOT EXISTS sur lots et mouvements).
--
-- À exécuter avec un compte superutilisateur (postgres) :
--   psql -h localhost -p 5433 -U postgres -d gestion_stock -f module-stock-v1.sql
-- ============================================================

BEGIN;

-- 1) Magasins / dépôts -----------------------------------------
CREATE TABLE IF NOT EXISTS magasins (
  id         BIGSERIAL PRIMARY KEY,
  nom        TEXT NOT NULL UNIQUE,
  adresse    TEXT,
  actif      BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO magasins(nom) VALUES ('Principal') ON CONFLICT (nom) DO NOTHING;

-- 2) Services / bénéficiaires (destinataires des sorties) ------
CREATE TABLE IF NOT EXISTS services (
  id         BIGSERIAL PRIMARY KEY,
  nom        TEXT NOT NULL UNIQUE,
  actif      BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO services(nom) VALUES ('REBUTS') ON CONFLICT (nom) DO NOTHING;

-- 3) Stock par magasin -----------------------------------------
CREATE TABLE IF NOT EXISTS stocks_magasin (
  id         BIGSERIAL PRIMARY KEY,
  magasin_id BIGINT NOT NULL REFERENCES magasins(id) ON DELETE CASCADE,
  produit_id BIGINT NOT NULL REFERENCES produits(id) ON DELETE CASCADE,
  qte        NUMERIC(12,2) NOT NULL DEFAULT 0,
  UNIQUE (magasin_id, produit_id)
);
CREATE INDEX IF NOT EXISTS idx_stocks_magasin_produit ON stocks_magasin(produit_id);

-- 4) Lots : rattachement au magasin (lots existants = "centraux", NULL)
ALTER TABLE lots ADD COLUMN IF NOT EXISTS magasin_id BIGINT REFERENCES magasins(id) ON DELETE SET NULL;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS numero TEXT;
CREATE INDEX IF NOT EXISTS idx_lots_magasin ON lots(magasin_id);
CREATE INDEX IF NOT EXISTS idx_lots_fefo ON lots(produit_id, date_peremption);

-- 5) Mouvements : enrichissement (magasin, bon, lot) -----------
ALTER TABLE mouvements ADD COLUMN IF NOT EXISTS magasin_id BIGINT REFERENCES magasins(id) ON DELETE SET NULL;
ALTER TABLE mouvements ADD COLUMN IF NOT EXISTS bon_id BIGINT;
ALTER TABLE mouvements ADD COLUMN IF NOT EXISTS lot_id BIGINT REFERENCES lots(id) ON DELETE SET NULL;
ALTER TABLE mouvements ADD COLUMN IF NOT EXISTS fournisseur_id BIGINT REFERENCES fournisseurs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_mouvements_magasin ON mouvements(magasin_id);

-- 6) Bons (entrée / sortie / retour / transfert / hors-stock /
--    ajustement / destruction) ---------------------------------
CREATE TABLE IF NOT EXISTS bons (
  id              BIGSERIAL PRIMARY KEY,
  reference       TEXT UNIQUE,
  type            TEXT NOT NULL CHECK (type IN ('ENTREE','SORTIE','RETOUR','TRANSFERT_EXP','TRANSFERT_REC','HORS_STOCK','AJUSTEMENT','DESTRUCTION')),
  magasin_id      BIGINT REFERENCES magasins(id) ON DELETE SET NULL,
  magasin_dest_id BIGINT REFERENCES magasins(id) ON DELETE SET NULL,
  service_id      BIGINT REFERENCES services(id) ON DELETE SET NULL,
  fournisseur_id  BIGINT REFERENCES fournisseurs(id) ON DELETE SET NULL,
  statut          TEXT NOT NULL DEFAULT 'saisi' CHECK (statut IN ('saisi','valide','annule')),
  date            TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id         BIGINT REFERENCES users(id),
  motif           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bon_items (
  id             BIGSERIAL PRIMARY KEY,
  bon_id         BIGINT NOT NULL REFERENCES bons(id) ON DELETE CASCADE,
  produit_id     BIGINT NOT NULL REFERENCES produits(id),
  lot_id         BIGINT REFERENCES lots(id) ON DELETE SET NULL,
  qte            NUMERIC(12,2) NOT NULL CHECK (qte <> 0),
  prix_unitaire  NUMERIC(12,2) NOT NULL DEFAULT 0,
  date_peremption DATE
);
CREATE INDEX IF NOT EXISTS idx_bons_date ON bons(date);
CREATE INDEX IF NOT EXISTS idx_bon_items_bon ON bon_items(bon_id);

-- 7) Demandes des services (création → validation → livraison → accusé)
CREATE TABLE IF NOT EXISTS demandes (
  id         BIGSERIAL PRIMARY KEY,
  reference  TEXT UNIQUE,
  service_id BIGINT NOT NULL REFERENCES services(id),
  statut     TEXT NOT NULL DEFAULT 'creee' CHECK (statut IN ('creee','validee','livree','accusee')),
  date       TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id    BIGINT REFERENCES users(id),
  motif      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS demande_items (
  id          BIGSERIAL PRIMARY KEY,
  demande_id  BIGINT NOT NULL REFERENCES demandes(id) ON DELETE CASCADE,
  produit_id  BIGINT NOT NULL REFERENCES produits(id),
  qte         NUMERIC(12,2) NOT NULL CHECK (qte > 0)
);

-- 8) Inventaires (complets + tournants) ------------------------
CREATE TABLE IF NOT EXISTS inventaires (
  id          BIGSERIAL PRIMARY KEY,
  magasin_id  BIGINT NOT NULL REFERENCES magasins(id),
  type        TEXT NOT NULL DEFAULT 'complet' CHECK (type IN ('complet','tournant')),
  statut      TEXT NOT NULL DEFAULT 'ouvert' CHECK (statut IN ('ouvert','saisi','valide')),
  famille_id  BIGINT REFERENCES familles(id) ON DELETE SET NULL,
  date_debut  TIMESTAMPTZ NOT NULL DEFAULT now(),
  date_fin    TIMESTAMPTZ,
  user_id     BIGINT REFERENCES users(id),
  notes       TEXT
);
CREATE TABLE IF NOT EXISTS inventaire_items (
  id             BIGSERIAL PRIMARY KEY,
  inventaire_id  BIGINT NOT NULL REFERENCES inventaires(id) ON DELETE CASCADE,
  produit_id     BIGINT NOT NULL REFERENCES produits(id),
  qte_theorique  NUMERIC(12,2) NOT NULL DEFAULT 0,
  qte_comptee    NUMERIC(12,2),
  ecart          NUMERIC(12,2),
  saisie_par     BIGINT REFERENCES users(id)
);

-- 9) Suggestions de réappro ------------------------------------
CREATE TABLE IF NOT EXISTS suggestions (
  id          BIGSERIAL PRIMARY KEY,
  produit_id  BIGINT NOT NULL REFERENCES produits(id),
  magasin_id  BIGINT NOT NULL REFERENCES magasins(id),
  qte         NUMERIC(12,2) NOT NULL,
  motif       TEXT NOT NULL DEFAULT 'seuil',
  statut      TEXT NOT NULL DEFAULT 'ouverte' CHECK (statut IN ('ouverte','commandee','ignoree')),
  commande_id BIGINT REFERENCES commandes(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10) FEFO : lots par péremption la plus proche, périmés exclus,
--     lots "centraux" (magasin NULL) inclus en secours.
CREATE OR REPLACE FUNCTION fefo_lots(p_produit_id BIGINT, p_qte NUMERIC, p_magasin_id BIGINT DEFAULT NULL)
RETURNS TABLE(lot_id BIGINT, qte NUMERIC) LANGUAGE plpgsql AS $$
DECLARE
  reste NUMERIC := p_qte;
  r RECORD;
BEGIN
  FOR r IN
    SELECT id, qte_restante FROM lots
    WHERE produit_id = p_produit_id
      AND qte_restante > 0
      AND (p_magasin_id IS NULL OR magasin_id = p_magasin_id OR magasin_id IS NULL)
      AND (date_peremption IS NULL OR date_peremption >= CURRENT_DATE)
    ORDER BY date_peremption ASC NULLS LAST, id ASC
  LOOP
    IF reste <= 0 THEN EXIT; END IF;
    IF r.qte_restante >= reste THEN
      RETURN QUERY SELECT r.id, reste;
      reste := 0;
    ELSE
      RETURN QUERY SELECT r.id, r.qte_restante;
      reste := reste - r.qte_restante;
    END IF;
  END LOOP;
  IF reste > 0 THEN
    RAISE EXCEPTION 'Stock insuffisant en lots valides pour le produit % (manque %)', p_produit_id, reste;
  END IF;
END $$;

-- 11) Types de mouvement supplémentaires (compatibles écrans existants)
INSERT INTO types_mouvement(code, label, signe) VALUES
  ('sortie_service','Sortie (service / bénéficiaire)','-'),
  ('transfert','Transfert inter-magasins','±'),
  ('hors_stock','Hors stock (traçage)','±'),
  ('destruction','Destruction / rebut','-')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, signe = EXCLUDED.signe;

-- 12) Audit inaltérable sur les nouvelles tables (fonction générique existante)
CREATE TRIGGER trg_audit_magasins         AFTER INSERT OR UPDATE OR DELETE ON magasins         FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_services         AFTER INSERT OR UPDATE OR DELETE ON services         FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_stocks_magasin   AFTER INSERT OR UPDATE OR DELETE ON stocks_magasin   FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_bons             AFTER INSERT OR UPDATE ON bons                       FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_bon_items        AFTER INSERT OR UPDATE OR DELETE ON bon_items        FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_demandes         AFTER INSERT OR UPDATE ON demandes                   FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_demande_items    AFTER INSERT OR UPDATE OR DELETE ON demande_items    FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_inventaires      AFTER INSERT OR UPDATE ON inventaires                FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_inventaire_items AFTER INSERT OR UPDATE OR DELETE ON inventaire_items FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_suggestions      AFTER INSERT OR UPDATE ON suggestions                FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

-- 13) Droits de l'application (gsv_app) sur les nouvelles tables
GRANT SELECT, INSERT, UPDATE, DELETE ON magasins, services, stocks_magasin, bons, bon_items,
      demandes, demande_items, inventaires, inventaire_items, suggestions TO gsv_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gsv_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gsv_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gsv_app;

COMMIT;
