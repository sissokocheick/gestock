-- ============================================================
-- Gestion Stock & Vente — Schéma PostgreSQL Complet
-- ============================================================

-- Boutique (une seule ligne, id = 1)
CREATE TABLE IF NOT EXISTS boutique (
  id          INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  nom         TEXT NOT NULL DEFAULT 'Ma Boutique',
  logo        TEXT,
  tel         TEXT,
  email       TEXT,
  adresse     TEXT,
  horaires    TEXT,
  devise      TEXT DEFAULT 'FCFA',
  pied        TEXT DEFAULT 'Merci de votre visite !',
  point_regle TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Rôles : modèles de départ (les droits restent modifiables par utilisateur)
CREATE TABLE IF NOT EXISTS roles (
  code   TEXT PRIMARY KEY,
  label  TEXT NOT NULL,
  droits JSONB NOT NULL
);

-- Utilisateurs
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  nom           TEXT NOT NULL UNIQUE,
  mdp_hash      TEXT NOT NULL,
  role_code     TEXT NOT NULL REFERENCES roles(code),
  droits        JSONB NOT NULL,
  pin_code      TEXT,
  token_version INT NOT NULL DEFAULT 1,
  actif         BOOLEAN DEFAULT true,
  derniere_connexion TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Clients & Fidélité
CREATE TABLE IF NOT EXISTS clients (
  id             BIGSERIAL PRIMARY KEY,
  nom            TEXT NOT NULL,
  tel            TEXT,
  email          TEXT,
  adresse        TEXT,
  plafond_credit NUMERIC(12,2) NOT NULL DEFAULT 50000,
  points         INT NOT NULL DEFAULT 0,
  notes          TEXT,
  actif          BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clients_nom ON clients(nom);
CREATE INDEX IF NOT EXISTS idx_clients_tel ON clients(tel);

-- Familles de produits
CREATE TABLE IF NOT EXISTS familles (
  id  BIGSERIAL PRIMARY KEY,
  nom TEXT NOT NULL UNIQUE
);

-- Produits
CREATE TABLE IF NOT EXISTS produits (
  id                BIGSERIAL PRIMARY KEY,
  nom               TEXT NOT NULL,
  famille_id        BIGINT REFERENCES familles(id) ON DELETE SET NULL,
  code              TEXT UNIQUE,
  photo             TEXT,
  prix_achat        NUMERIC(12,2) NOT NULL DEFAULT 0,
  prix_vente        NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock             NUMERIC(12,2) NOT NULL DEFAULT 0,
  stock_min         NUMERIC(12,2) NOT NULL DEFAULT 0,
  unite             TEXT DEFAULT 'pcs',
  emplacement       TEXT,
  parent_produit_id BIGINT REFERENCES produits(id) ON DELETE SET NULL,
  qte_par_parent    NUMERIC(12,2) DEFAULT 1,
  actif             BOOLEAN DEFAULT true,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- Ventes (caisse)
CREATE TABLE IF NOT EXISTS ventes (
  id            BIGSERIAL PRIMARY KEY,
  numero        TEXT NOT NULL UNIQUE,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  client_id     BIGINT REFERENCES clients(id) ON DELETE SET NULL,
  client_nom    TEXT,
  date          TIMESTAMPTZ NOT NULL DEFAULT now(),
  remise        NUMERIC(12,2) NOT NULL DEFAULT 0,
  total         NUMERIC(12,2) NOT NULL,
  net           NUMERIC(12,2) NOT NULL,
  mode          TEXT NOT NULL,
  recu          NUMERIC(12,2),
  rendu         NUMERIC(12,2),
  points_gagnes INT DEFAULT 0,
  points_utilises INT DEFAULT 0
);

-- Lignes de vente (avec copie du nom et des prix = historique figé)
CREATE TABLE IF NOT EXISTS vente_items (
  id         BIGSERIAL PRIMARY KEY,
  vente_id   BIGINT NOT NULL REFERENCES ventes(id) ON DELETE CASCADE,
  produit_id BIGINT REFERENCES produits(id) ON DELETE SET NULL,
  nom        TEXT NOT NULL,
  qte        NUMERIC(12,2) NOT NULL,
  prix       NUMERIC(12,2) NOT NULL,
  prix_achat NUMERIC(12,2) NOT NULL DEFAULT 0
);

-- Mouvements de stock (entrée, sortie vente, ajustement, transfert, retour, inventaire)
CREATE TABLE IF NOT EXISTS mouvements (
  id         BIGSERIAL PRIMARY KEY,
  date       TIMESTAMPTZ NOT NULL DEFAULT now(),
  type       TEXT NOT NULL,
  produit_id BIGINT REFERENCES produits(id) ON DELETE SET NULL,
  qte        NUMERIC(12,2) NOT NULL,
  motif      TEXT,
  user_id    BIGINT REFERENCES users(id),
  ref        TEXT
);

-- Points du soir (un par caissière et par jour)
CREATE TABLE IF NOT EXISTS points_soir (
  id           BIGSERIAL PRIMARY KEY,
  date         DATE NOT NULL,
  caissiere_id BIGINT NOT NULL REFERENCES users(id),
  attendu      NUMERIC(12,2) NOT NULL DEFAULT 0,
  statut       TEXT DEFAULT 'en attente',
  UNIQUE (date, caissiere_id)
);

-- Versements enregistrés par la caissière principale
CREATE TABLE IF NOT EXISTS versements (
  id       BIGSERIAL PRIMARY KEY,
  point_id BIGINT NOT NULL REFERENCES points_soir(id) ON DELETE CASCADE,
  date     TIMESTAMPTZ NOT NULL DEFAULT now(),
  montant  NUMERIC(12,2) NOT NULL,
  mode     TEXT NOT NULL,
  user_id  BIGINT REFERENCES users(id)
);

-- Caisses virtuelles : une par caissière, une seule ouverte à la fois
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

-- Chaque vente est rattachée à la caisse ouverte de la caissière
ALTER TABLE ventes ADD COLUMN IF NOT EXISTS caisse_id BIGINT REFERENCES caisses(id);
CREATE INDEX IF NOT EXISTS idx_ventes_caisse ON ventes(caisse_id);

-- Versements faits pendant la journée sur une caisse (remise au gérant, dépôt…)
CREATE TABLE IF NOT EXISTS versements_caisse (
  id        BIGSERIAL PRIMARY KEY,
  caisse_id BIGINT NOT NULL REFERENCES caisses(id) ON DELETE CASCADE,
  date      TIMESTAMPTZ NOT NULL DEFAULT now(),
  montant   NUMERIC(12,2) NOT NULL,
  mode      TEXT NOT NULL DEFAULT 'especes',
  motif     TEXT,
  user_id   BIGINT REFERENCES users(id),
  statut      TEXT NOT NULL DEFAULT 'en_attente',
  valide_par  BIGINT REFERENCES users(id),
  valide_le   TIMESTAMPTZ,
  motif_refus TEXT
);
CREATE INDEX IF NOT EXISTS idx_versements_caisse ON versements_caisse(caisse_id);

-- Règlements de crédits clients perçus sur une caisse
CREATE TABLE IF NOT EXISTS reglements_credit (
  id        BIGSERIAL PRIMARY KEY,
  caisse_id BIGINT REFERENCES caisses(id) ON DELETE SET NULL,
  vente_id  BIGINT NOT NULL REFERENCES ventes(id) ON DELETE CASCADE,
  montant   NUMERIC(12,2) NOT NULL,
  mode      TEXT NOT NULL DEFAULT 'especes',
  date      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id   BIGINT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_reglements_credit_caisse ON reglements_credit(caisse_id);
CREATE INDEX IF NOT EXISTS idx_reglements_credit_vente  ON reglements_credit(vente_id);

-- Modes de paiement paramétrables (Espèces, Mobile money, Carte + modes personnalisés)
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

-- Catalogue des droits
CREATE TABLE IF NOT EXISTS droits (
  code  TEXT PRIMARY KEY,
  label TEXT NOT NULL
);
INSERT INTO droits(code, label) VALUES
  ('R_VENTE','Vendre / encaisser'),
  ('R_PRODUITS','Gérer les produits'),
  ('R_STOCK','Gérer le stock'),
  ('R_CLIENTS','Gérer les clients et la fidélité'),
  ('R_USERS','Gérer les utilisateurs'),
  ('R_RAPPORTS','Voir les rapports'),
  ('R_JOURNAL','Voir le journal d''audit'),
  ('R_POINT','Clôture de caisse (caissière principale)'),
  ('R_PARAMS','Paramètres de la boutique')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;

-- Paramètres généraux partagés entre tous les appareils
CREATE TABLE IF NOT EXISTS parametres (
  cle    TEXT PRIMARY KEY,
  valeur TEXT
);
INSERT INTO parametres(cle, valeur) VALUES
  ('ticket_width','80'),
  ('ticket_barcode','1'),
  ('remise_max_pct','100'),
  ('versement_validateur','admin'),
  ('annulation_validateur','admin'),
  ('show_demo','1')
ON CONFLICT (cle) DO NOTHING;

-- Types de mouvements de stock (catalogue)
CREATE TABLE IF NOT EXISTS types_mouvement (
  code  TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  signe TEXT NOT NULL DEFAULT '±'
);
INSERT INTO types_mouvement(code, label, signe) VALUES
  ('entree','Entrée (réception fournisseur)','+'),
  ('retour','Retour client','+'),
  ('ajustement','Ajustement (+/-)','±'),
  ('sortie_vente','Sortie vente','−'),
  ('inventaire','Inventaire','±'),
  ('deconditionnement','Déconditionnement (+/-)','±'),
  ('stock_initial','Entrée (stock initial)','+')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, signe = EXCLUDED.signe;

-- Lots & péremptions
CREATE TABLE IF NOT EXISTS lots (
  id              BIGSERIAL PRIMARY KEY,
  produit_id      BIGINT NOT NULL REFERENCES produits(id) ON DELETE CASCADE,
  qte_restante    NUMERIC(12,2) NOT NULL DEFAULT 0,
  date_peremption DATE,
  date_entree     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lots_produit ON lots(produit_id);
CREATE INDEX IF NOT EXISTS idx_lots_peremption ON lots(date_peremption);

-- Fournisseurs
CREATE TABLE IF NOT EXISTS fournisseurs (
  id      BIGSERIAL PRIMARY KEY,
  nom     TEXT NOT NULL UNIQUE,
  tel     TEXT,
  email   TEXT,
  adresse TEXT,
  notes   TEXT
);

-- Commandes d'achat aux fournisseurs
CREATE TABLE IF NOT EXISTS commandes (
  id             BIGSERIAL PRIMARY KEY,
  fournisseur_id BIGINT REFERENCES fournisseurs(id) ON DELETE SET NULL,
  date           TIMESTAMPTZ NOT NULL DEFAULT now(),
  statut         TEXT NOT NULL DEFAULT 'en_cours' CHECK (statut IN ('en_cours','recue','partielle')),
  livraison      NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes          TEXT,
  user_id        BIGINT REFERENCES users(id)
);
/* Les bases anciennes ont un CHECK sans 'partielle' : on le remplace (idempotent) */
ALTER TABLE commandes DROP CONSTRAINT IF EXISTS commandes_statut_check;
ALTER TABLE commandes ADD CONSTRAINT commandes_statut_check CHECK (statut IN ('en_cours','recue','partielle'));
CREATE INDEX IF NOT EXISTS idx_commandes_date ON commandes(date);
CREATE TABLE IF NOT EXISTS commande_items (
  id          BIGSERIAL PRIMARY KEY,
  commande_id BIGINT NOT NULL REFERENCES commandes(id) ON DELETE CASCADE,
  produit_id  BIGINT REFERENCES produits(id) ON DELETE SET NULL,
  nom         TEXT NOT NULL,
  qte         NUMERIC(12,2) NOT NULL,
  prix_achat  NUMERIC(12,2) NOT NULL DEFAULT 0,
  qte_recue NUMERIC(12,2) DEFAULT 0
);

-- Dépenses (loyer, électricité, transport, etc.)
CREATE TABLE IF NOT EXISTS depenses (
  id         BIGSERIAL PRIMARY KEY,
  date       TIMESTAMPTZ NOT NULL DEFAULT now(),
  montant    NUMERIC(12,2) NOT NULL CHECK (montant > 0),
  categorie  TEXT NOT NULL,
  motif      TEXT,
  mode       TEXT NOT NULL DEFAULT 'especes',
  user_id    BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  annule       BOOLEAN DEFAULT false,
  annule_le    TIMESTAMPTZ,
  annule_par   TEXT,
  annule_motif TEXT
);
CREATE INDEX IF NOT EXISTS idx_depenses_date ON depenses(date);
CREATE INDEX IF NOT EXISTS idx_depenses_categorie ON depenses(categorie);

-- Demandes d'annulation de vente (validation à distance)
CREATE TABLE IF NOT EXISTS demandes_annulation (
  id             BIGSERIAL PRIMARY KEY,
  vente_id       BIGINT REFERENCES ventes(id) ON DELETE SET NULL,
  vente_numero   TEXT NOT NULL,
  vente_date     TIMESTAMPTZ,
  vente_net      NUMERIC(12,2) NOT NULL,
  vente_items    JSONB,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  user_nom       TEXT NOT NULL,
  motif          TEXT NOT NULL,
  date_demande   TIMESTAMPTZ NOT NULL DEFAULT now(),
  statut         TEXT NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente','validee','refusee')),
  valide_par     BIGINT REFERENCES users(id),
  valide_par_nom TEXT,
  valide_le      TIMESTAMPTZ,
  motif_refus    TEXT
);
CREATE INDEX IF NOT EXISTS idx_demandes_annul_statut ON demandes_annulation(statut);
CREATE INDEX IF NOT EXISTS idx_demandes_annul_vente  ON demandes_annulation(vente_id);

-- Journal d'audit (qui a fait quoi, quand)
CREATE TABLE IF NOT EXISTS audit_log (
  id        BIGSERIAL PRIMARY KEY,
  date      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id   BIGINT,
  user_nom  TEXT,
  action    TEXT NOT NULL,
  details   TEXT,
  old_data  JSONB,
  new_data  JSONB
);

-- Journal inaltérable : interdit de modifier ou supprimer les entrées
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'gsv_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM gsv_app';
  END IF;
END $$;

-- ============================================================
-- Déclencheur d'audit automatique
-- ============================================================
CREATE OR REPLACE FUNCTION audit_trigger_fn() RETURNS TRIGGER AS $$
DECLARE
  uid BIGINT;
  u_nom TEXT;
BEGIN
  uid := NULLIF(current_setting('app.user_id', true), '')::BIGINT;
  SELECT nom INTO u_nom FROM users WHERE id = uid;
  IF u_nom IS NULL THEN u_nom := 'système'; END IF;
  INSERT INTO audit_log(user_id, user_nom, action, old_data, new_data)
  VALUES (uid, u_nom, TG_TABLE_NAME || ':' || TG_OP,
          CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END,
          CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END);
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_produits  AFTER INSERT OR UPDATE OR DELETE ON produits     FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_clients   AFTER INSERT OR UPDATE OR DELETE ON clients      FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_users     AFTER INSERT OR UPDATE OR DELETE ON users        FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_ventes    AFTER INSERT ON ventes                           FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_mouvements AFTER INSERT OR UPDATE OR DELETE ON mouvements  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_versements AFTER INSERT ON versements                      FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_caisses AFTER INSERT OR UPDATE ON caisses                  FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_versements_caisse AFTER INSERT ON versements_caisse         FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_reglements_credit AFTER INSERT OR UPDATE OR DELETE ON reglements_credit FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_depenses AFTER INSERT OR UPDATE OR DELETE ON depenses FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_modes_paiement AFTER INSERT OR UPDATE OR DELETE ON modes_paiement FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_droits AFTER INSERT OR UPDATE OR DELETE ON droits FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_parametres AFTER INSERT OR UPDATE OR DELETE ON parametres FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_types_mouvement AFTER INSERT OR UPDATE OR DELETE ON types_mouvement FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_lots AFTER INSERT OR UPDATE OR DELETE ON lots FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_fournisseurs AFTER INSERT OR UPDATE OR DELETE ON fournisseurs FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_commandes AFTER INSERT OR UPDATE ON commandes FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_commande_items AFTER INSERT ON commande_items FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_boutique  AFTER UPDATE ON boutique                         FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_demandes_annulation AFTER INSERT OR UPDATE ON demandes_annulation FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();

-- ============================================================
-- Index pour la vitesse
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_ventes_date   ON ventes(date);
CREATE INDEX IF NOT EXISTS idx_ventes_user   ON ventes(user_id);
CREATE INDEX IF NOT EXISTS idx_mouvements_date ON mouvements(date);
CREATE INDEX IF NOT EXISTS idx_audit_date    ON audit_log(date);
CREATE INDEX IF NOT EXISTS idx_items_vente   ON vente_items(vente_id);
CREATE INDEX IF NOT EXISTS idx_points_date   ON points_soir(date);

-- ============================================================
-- Migrations colonnes manquantes (idempotent)
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS derniere_connexion TIMESTAMPTZ;
