-- ============================================================
-- CORRECTIF PRODUCTION — à exécuter UNE FOIS en tant que propriétaire
-- (rôle « postgres ») car l'utilisateur applicatif gsv_app n'est pas
-- propriétaire des tables et ne peut ni ajouter de colonnes ni créer d'index.
--
-- Exécution locale (Windows) :
--   psql -U postgres -d gestion_stock -f scripts/prod-fixes.sql
-- (mot de passe postgres, puis Ctrl+F5 sur les postes de caisse)
-- ============================================================

-- Colonne utilisée par l'encaissement fidélité (SANS elle, LA VENTE PLANTE)
ALTER TABLE ventes ADD COLUMN IF NOT EXISTS points_utilises INT DEFAULT 0;

-- Colonne utilisée par les réceptions partielles de commandes
ALTER TABLE commande_items ADD COLUMN IF NOT EXISTS qte_recue NUMERIC(12,2) DEFAULT 0;

-- Index de performance (recherche catalogue, historiques, lots)
CREATE INDEX IF NOT EXISTS idx_produits_nom ON produits(nom);
CREATE INDEX IF NOT EXISTS idx_items_produit ON vente_items(produit_id);
CREATE INDEX IF NOT EXISTS idx_mouvements_produit ON mouvements(produit_id);
CREATE INDEX IF NOT EXISTS idx_lots_prod_num ON lots(produit_id, numero);

-- Droits de lecture/écriture pour l'utilisateur applicatif sur les nouveaux objets
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gsv_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gsv_app;
