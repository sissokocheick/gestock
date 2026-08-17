-- Migration v3 : plus aucune donnée en dur dans le code
-- Catalogue des droits (libellés modifiables depuis la base)
CREATE TABLE IF NOT EXISTS droits (
  code  TEXT PRIMARY KEY,
  label TEXT NOT NULL
);
INSERT INTO droits(code, label) VALUES
  ('R_VENTE','Vendre / encaisser'),
  ('R_PRODUITS','Gérer les produits'),
  ('R_STOCK','Gérer le stock'),
  ('R_USERS','Gérer les utilisateurs'),
  ('R_RAPPORTS','Voir les rapports'),
  ('R_JOURNAL','Voir le journal d''audit'),
  ('R_POINT','Clôture de caisse (caissière principale)'),
  ('R_PARAMS','Paramètres de la boutique')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label;

-- Paramètres généraux partagés entre tous les appareils (impression…)
CREATE TABLE IF NOT EXISTS parametres (
  cle    TEXT PRIMARY KEY,
  valeur TEXT
);
INSERT INTO parametres(cle, valeur) VALUES
  ('ticket_width','80'),
  ('ticket_barcode','1')
ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur;

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
  ('stock_initial','Entrée (stock initial)','+')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, signe = EXCLUDED.signe;

-- Règle du point du soir (texte affiché sur la page Clôture de caisse)
ALTER TABLE boutique ADD COLUMN IF NOT EXISTS point_regle TEXT;

CREATE TRIGGER trg_audit_droits AFTER INSERT OR UPDATE OR DELETE ON droits FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_parametres AFTER INSERT OR UPDATE OR DELETE ON parametres FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
CREATE TRIGGER trg_audit_types_mouvement AFTER INSERT OR UPDATE OR DELETE ON types_mouvement FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn();
