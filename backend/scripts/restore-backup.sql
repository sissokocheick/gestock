-- ====================================================
-- Restauration de la base gestion_stock du 18-08-2026
-- ====================================================

BEGIN;

-- Désactiver temporairement les contraintes et triggers
SET session_replication_role = replica;

-- Table: roles (8 lignes)
TRUNCATE TABLE roles CASCADE;
INSERT INTO roles (code, label, droits) VALUES ('admin', 'Administrateur', '["R_VENTE","R_PRODUITS","R_STOCK","R_USERS","R_RAPPORTS","R_JOURNAL","R_POINT","R_PARAMS"]'::jsonb) ON CONFLICT DO NOTHING;
INSERT INTO roles (code, label, droits) VALUES ('gerant', 'Gérant', '["R_VENTE","R_PRODUITS","R_STOCK","R_RAPPORTS","R_JOURNAL","R_POINT","R_PARAMS"]'::jsonb) ON CONFLICT DO NOTHING;
INSERT INTO roles (code, label, droits) VALUES ('caissier', 'Caissier / Vendeur', '["R_VENTE"]'::jsonb) ON CONFLICT DO NOTHING;
INSERT INTO roles (code, label, droits) VALUES ('stockiste', 'Stockiste', '["R_STOCK"]'::jsonb) ON CONFLICT DO NOTHING;
INSERT INTO roles (code, label, droits) VALUES ('lecteur', 'Lecteur', '["R_RAPPORTS"]'::jsonb) ON CONFLICT DO NOTHING;
INSERT INTO roles (code, label, droits) VALUES ('caissier-principal', 'Caissier principal(e)', '["R_VENTE","R_PRODUITS","R_STOCK","R_JOURNAL","R_POINT"]'::jsonb) ON CONFLICT DO NOTHING;
INSERT INTO roles (code, label, droits) VALUES ('comptable', 'Comptable', '["R_RAPPORTS","R_JOURNAL"]'::jsonb) ON CONFLICT DO NOTHING;
INSERT INTO roles (code, label, droits) VALUES ('caisier-jour', 'caisier jour', '["R_VENTE"]'::jsonb) ON CONFLICT DO NOTHING;

-- Table: droits (8 lignes)
TRUNCATE TABLE droits CASCADE;
INSERT INTO droits (code, label) VALUES ('R_VENTE', 'Vendre / encaisser') ON CONFLICT DO NOTHING;
INSERT INTO droits (code, label) VALUES ('R_PRODUITS', 'Gérer les produits') ON CONFLICT DO NOTHING;
INSERT INTO droits (code, label) VALUES ('R_STOCK', 'Gérer le stock') ON CONFLICT DO NOTHING;
INSERT INTO droits (code, label) VALUES ('R_USERS', 'Gérer les utilisateurs') ON CONFLICT DO NOTHING;
INSERT INTO droits (code, label) VALUES ('R_RAPPORTS', 'Voir les rapports') ON CONFLICT DO NOTHING;
INSERT INTO droits (code, label) VALUES ('R_JOURNAL', 'Voir le journal d''audit') ON CONFLICT DO NOTHING;
INSERT INTO droits (code, label) VALUES ('R_POINT', 'Clôture de caisse (caissière principale)') ON CONFLICT DO NOTHING;
INSERT INTO droits (code, label) VALUES ('R_PARAMS', 'Paramètres de la boutique') ON CONFLICT DO NOTHING;

-- Table: familles (5 lignes)
TRUNCATE TABLE familles CASCADE;
INSERT INTO familles (id, nom, gere_par_lot, code) VALUES ('3', 'Hygiène', true, 'FAM-0003') ON CONFLICT DO NOTHING;
INSERT INTO familles (id, nom, gere_par_lot, code) VALUES ('31', 'sis', true, 'FAM-0030') ON CONFLICT DO NOTHING;
INSERT INTO familles (id, nom, gere_par_lot, code) VALUES ('5', 'Test', true, 'FAM-0005') ON CONFLICT DO NOTHING;
INSERT INTO familles (id, nom, gere_par_lot, code) VALUES ('1', 'Boissons', true, 'FAM-0001') ON CONFLICT DO NOTHING;
INSERT INTO familles (id, nom, gere_par_lot, code) VALUES ('2', 'Alimentation', true, 'FAM-0002') ON CONFLICT DO NOTHING;

-- Table: parametres (5 lignes)
TRUNCATE TABLE parametres CASCADE;
INSERT INTO parametres (cle, valeur) VALUES ('ticket_barcode', '1') ON CONFLICT DO NOTHING;
INSERT INTO parametres (cle, valeur) VALUES ('ticket_width', '80') ON CONFLICT DO NOTHING;
INSERT INTO parametres (cle, valeur) VALUES ('show_demo', '0') ON CONFLICT DO NOTHING;
INSERT INTO parametres (cle, valeur) VALUES ('remise_max_pct', '0') ON CONFLICT DO NOTHING;
INSERT INTO parametres (cle, valeur) VALUES ('versement_validateur', 'admin') ON CONFLICT DO NOTHING;

-- Table: boutique (1 lignes)
TRUNCATE TABLE boutique CASCADE;
INSERT INTO boutique (id, nom, logo, tel, email, adresse, horaires, devise, pied, updated_at, point_regle) VALUES ('1', 'Ma Boutique', NULL, '', '', '', '', 'FCFA', 'Merci de votre visite !', '2026-08-15 14:57:21.980823+02', NULL) ON CONFLICT DO NOTHING;

-- Table: magasins (1 lignes)
TRUNCATE TABLE magasins CASCADE;
INSERT INTO magasins (id, nom, adresse, actif, created_at) VALUES ('1', 'Principal', NULL, true, '2026-08-15 20:45:28.03689+02') ON CONFLICT DO NOTHING;

-- Table: services (1 lignes)
TRUNCATE TABLE services CASCADE;
INSERT INTO services (id, nom, actif, created_at) VALUES ('1', 'REBUTS', true, '2026-08-15 20:45:28.03689+02') ON CONFLICT DO NOTHING;

-- Table: modes_paiement (4 lignes)
TRUNCATE TABLE modes_paiement CASCADE;
INSERT INTO modes_paiement (id, code, nom, especes, actif, ordre) VALUES ('2', 'mobile', 'Mobile money', false, true, '2') ON CONFLICT DO NOTHING;
INSERT INTO modes_paiement (id, code, nom, especes, actif, ordre) VALUES ('3', 'carte', 'Carte', false, true, '3') ON CONFLICT DO NOTHING;
INSERT INTO modes_paiement (id, code, nom, especes, actif, ordre) VALUES ('5', 'wave', 'Wave', false, true, '4') ON CONFLICT DO NOTHING;
INSERT INTO modes_paiement (id, code, nom, especes, actif, ordre) VALUES ('1', 'especes', 'Espèces', true, true, '1') ON CONFLICT DO NOTHING;

-- Table: types_mouvement (10 lignes)
TRUNCATE TABLE types_mouvement CASCADE;
INSERT INTO types_mouvement (code, label, signe) VALUES ('entree', 'Entrée (réception fournisseur)', '+') ON CONFLICT DO NOTHING;
INSERT INTO types_mouvement (code, label, signe) VALUES ('retour', 'Retour client', '+') ON CONFLICT DO NOTHING;
INSERT INTO types_mouvement (code, label, signe) VALUES ('ajustement', 'Ajustement (+/-)', '±') ON CONFLICT DO NOTHING;
INSERT INTO types_mouvement (code, label, signe) VALUES ('sortie_vente', 'Sortie vente', '−') ON CONFLICT DO NOTHING;
INSERT INTO types_mouvement (code, label, signe) VALUES ('inventaire', 'Inventaire', '±') ON CONFLICT DO NOTHING;
INSERT INTO types_mouvement (code, label, signe) VALUES ('stock_initial', 'Entrée (stock initial)', '+') ON CONFLICT DO NOTHING;
INSERT INTO types_mouvement (code, label, signe) VALUES ('sortie_service', 'Sortie (service / bénéficiaire)', '-') ON CONFLICT DO NOTHING;
INSERT INTO types_mouvement (code, label, signe) VALUES ('transfert', 'Transfert inter-magasins', '±') ON CONFLICT DO NOTHING;
INSERT INTO types_mouvement (code, label, signe) VALUES ('hors_stock', 'Hors stock (traçage)', '±') ON CONFLICT DO NOTHING;
INSERT INTO types_mouvement (code, label, signe) VALUES ('destruction', 'Destruction / rebut', '-') ON CONFLICT DO NOTHING;

-- Table: users (3 lignes)
TRUNCATE TABLE users CASCADE;
INSERT INTO users (id, nom, mdp_hash, role_code, droits, actif, created_at, derniere_connexion) VALUES ('3', 'Fatou Ndiaye', '$2a$10$2VOZV6h3VaP4U3JHS7miA.R6GAKsIhcZvaivIXZRtbENZyGdX4yNq', 'caissier', '["R_VENTE"]'::jsonb, true, '2026-08-15 00:57:51.510398+02', NULL) ON CONFLICT DO NOTHING;
INSERT INTO users (id, nom, mdp_hash, role_code, droits, actif, created_at, derniere_connexion) VALUES ('2', 'Awa Diop', '$2a$10$unW2Jh5pPm6eJmtxI8A5wu2uPQolr5RNk6shGrSWv1Z1y0cLoP1gy', 'caissier-principal', '["R_VENTE","R_PRODUITS","R_STOCK","R_JOURNAL","R_POINT"]'::jsonb, true, '2026-08-15 00:57:51.510398+02', NULL) ON CONFLICT DO NOTHING;
INSERT INTO users (id, nom, mdp_hash, role_code, droits, actif, created_at, derniere_connexion) VALUES ('1', 'admin', '$2a$10$HGos35Tk96VM0HoROlP62eBNIKhPFuGQ/HjiZ07tdeJk8K0240uAe', 'admin', '["R_VENTE","R_PRODUITS","R_STOCK","R_USERS","R_RAPPORTS","R_JOURNAL","R_POINT","R_PARAMS"]'::jsonb, true, '2026-08-15 00:57:51.510398+02', '2026-08-18 03:31:17.108786+02') ON CONFLICT DO NOTHING;

-- Table: fournisseurs (1 lignes)
TRUNCATE TABLE fournisseurs CASCADE;
INSERT INTO fournisseurs (id, nom, tel, email, adresse, notes) VALUES ('12', 'sissoko', '', '', '', '') ON CONFLICT DO NOTHING;

-- Table: produits (4 lignes)
TRUNCATE TABLE produits CASCADE;
INSERT INTO produits (id, nom, famille_id, code, prix_achat, prix_vente, stock, stock_min, actif, created_at, photo, gere_par_lot, reference) VALUES ('3', 'Savon de toilette', '3', '6181490000035', '350.00', '500.00', '70.00', '20.00', true, '2026-08-15 00:57:51.510398+02', NULL, false, 'PRD-000003') ON CONFLICT DO NOTHING;
INSERT INTO produits (id, nom, famille_id, code, prix_achat, prix_vente, stock, stock_min, actif, created_at, photo, gere_par_lot, reference) VALUES ('4', 'Huile végétale 1L', '2', '6181490000042', '1100.00', '1400.00', '4.00', '12.00', true, '2026-08-15 00:57:51.510398+02', NULL, false, 'PRD-000004') ON CONFLICT DO NOTHING;
INSERT INTO produits (id, nom, famille_id, code, prix_achat, prix_vente, stock, stock_min, actif, created_at, photo, gere_par_lot, reference) VALUES ('2', 'Riz parfumé 5kg', '2', '6181490000028', '2600.00', '3200.00', '8.00', '10.00', true, '2026-08-15 00:57:51.510398+02', NULL, false, 'PRD-000002') ON CONFLICT DO NOTHING;
INSERT INTO produits (id, nom, famille_id, code, prix_achat, prix_vente, stock, stock_min, actif, created_at, photo, gere_par_lot, reference) VALUES ('1', 'Eau minérale 1,5L', NULL, '6181490000011', '500.00', '750.00', '104.00', '24.00', true, '2026-08-15 00:57:51.510398+02', NULL, true, 'PRD-000001') ON CONFLICT DO NOTHING;

-- Table: commandes (1 lignes)
TRUNCATE TABLE commandes CASCADE;
INSERT INTO commandes (id, fournisseur_id, date, statut, livraison, notes, user_id) VALUES ('12', '12', '2026-08-15 23:07:33.209161+02', 'recue', '0.00', NULL, '1') ON CONFLICT DO NOTHING;

-- Table: commande_items (3 lignes)
TRUNCATE TABLE commande_items CASCADE;
INSERT INTO commande_items (id, commande_id, produit_id, nom, qte, prix_achat) VALUES ('12', '12', '1', 'Eau minérale 1,5L', '1.00', '0.00') ON CONFLICT DO NOTHING;
INSERT INTO commande_items (id, commande_id, produit_id, nom, qte, prix_achat) VALUES ('13', '12', '4', 'Huile végétale 1L', '1.00', '0.00') ON CONFLICT DO NOTHING;
INSERT INTO commande_items (id, commande_id, produit_id, nom, qte, prix_achat) VALUES ('14', '12', '2', 'Riz parfumé 5kg', '1.00', '0.00') ON CONFLICT DO NOTHING;

-- Table: caisses (20 lignes)
TRUNCATE TABLE caisses CASCADE;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('24', '1', '2026-08-16 00:46:55.869924+02', '0.00', '2026-08-17 23:21:07.906669+02', '33000.00', '33000.00', '0.00', NULL, 'fermee', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('25', '1', '2026-08-17 23:24:10.763058+02', '0.00', '2026-08-17 23:25:45.770618+02', '2150.00', '2150.00', '0.00', NULL, 'validee', '2026-08-17 23:25:57.62834+02', '1') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('26', '1', '2026-08-18 01:09:10.315969+02', '0.00', NULL, NULL, NULL, NULL, NULL, 'ouverte', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('3', '1', '2026-08-15 14:25:25.655089+02', '0.00', '2026-08-15 14:51:23.408331+02', '0.00', '0.00', '0.00', NULL, 'validee', '2026-08-15 14:52:03.448151+02', '1') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('7', '3', '2026-08-15 15:16:14.294505+02', '1000.00', '2026-08-15 15:16:14.456164+02', '3250.00', '3250.00', '0.00', NULL, 'validee', '2026-08-15 15:16:14.683627+02', '2') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('8', '3', '2026-08-15 15:18:50.672356+02', '1000.00', '2026-08-15 15:20:00.558742+02', '1000.00', '1000.00', '0.00', NULL, 'validee', '2026-08-15 15:20:00.902229+02', '2') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('9', '3', '2026-08-15 15:20:06.833643+02', '1000.00', '2026-08-15 15:20:07.036301+02', '3250.00', '3250.00', '0.00', NULL, 'validee', '2026-08-15 15:20:07.244063+02', '2') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('10', '3', '2026-08-15 15:23:38.106701+02', '1000.00', '2026-08-15 15:23:38.243085+02', '3250.00', '3250.00', '0.00', NULL, 'validee', '2026-08-15 15:23:38.404738+02', '2') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('11', '3', '2026-08-15 15:23:55.381825+02', '1000.00', '2026-08-15 15:23:55.533572+02', '3250.00', '3250.00', '0.00', NULL, 'validee', '2026-08-15 15:23:55.742936+02', '2') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('12', '3', '2026-08-15 16:06:15.314483+02', '1000.00', '2026-08-15 16:06:15.423553+02', '3250.00', '3250.00', '0.00', NULL, 'validee', '2026-08-15 16:06:15.537203+02', '2') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('13', '3', '2026-08-15 16:40:24.923924+02', '1000.00', '2026-08-15 16:40:25.081134+02', '3250.00', '3250.00', '0.00', NULL, 'validee', '2026-08-15 16:40:25.263599+02', '2') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('14', '3', '2026-08-15 16:41:30.555034+02', '1000.00', '2026-08-15 16:41:30.641716+02', '3250.00', '3250.00', '0.00', NULL, 'validee', '2026-08-15 16:41:30.754197+02', '2') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('6', '1', '2026-08-15 15:14:55.339853+02', '0.00', '2026-08-15 16:40:14.128493+02', '0.00', '0.00', '0.00', NULL, 'validee', '2026-08-15 16:42:13.509167+02', '1') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('15', '1', '2026-08-15 16:48:13.989115+02', '0.00', '2026-08-15 16:49:46.859911+02', '0.00', '0.00', '0.00', NULL, 'validee', '2026-08-15 16:49:46.924803+02', '1') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('16', '3', '2026-08-15 17:16:56.210082+02', '1000.00', '2026-08-15 17:16:56.315774+02', '3250.00', '3250.00', '0.00', NULL, 'validee', '2026-08-15 17:16:56.444243+02', '2') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('18', '3', '2026-08-15 17:36:18.364543+02', '1000.00', '2026-08-15 17:36:18.698362+02', '3250.00', '3250.00', '0.00', NULL, 'validee', '2026-08-15 17:36:19.02637+02', '2') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('21', '3', '2026-08-15 22:33:53.324887+02', '0.00', '2026-08-15 22:35:08.612973+02', '9800.00', '9800.00', '0.00', NULL, 'validee', '2026-08-16 00:02:36.459116+02', '1') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('20', '1', '2026-08-15 22:10:08.219152+02', '0.00', '2026-08-16 02:33:45.68256+02', '0.00', '0.00', '0.00', NULL, 'fermee', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('22', '1', '2026-08-16 00:09:07.608994+02', '0.00', '2026-08-16 00:10:06.693992+02', '5850.00', '5850.00', '0.00', NULL, 'validee', '2026-08-16 09:31:24.447978+02', '1') ON CONFLICT DO NOTHING;
INSERT INTO caisses (id, user_id, ouverte_le, fonds_initial, fermee_le, total_attendu, total_compte, ecart, notes, statut, validee_le, validee_par) VALUES ('23', '1', '2026-08-16 00:10:13.075159+02', '0.00', '2026-08-16 00:41:31.552965+02', '1500.00', '1500.00', '0.00', NULL, 'validee', '2026-08-16 09:31:29.944543+02', '1') ON CONFLICT DO NOTHING;

-- Table: ventes (24 lignes)
TRUNCATE TABLE ventes CASCADE;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('1', 'TMSTJT12N73', '1', '2026-08-15 00:58:21.738077+02', '0.00', '2000.00', '2000.00', 'especes', '2000.00', '0.00', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('2', 'TMSUBGBJH56', '1', '2026-08-15 13:52:18.024741+02', '0.00', '750.00', '750.00', 'especes', '10000.00', '9250.00', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('3', 'TMSUBGKXD38', '1', '2026-08-15 13:52:30.18649+02', '0.00', '1400.00', '1400.00', 'especes', '10000.00', '8600.00', NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('20', 'TMSUU3GZL6BJF8', '3', '2026-08-15 22:34:11.589747+02', '0.00', '750.00', '750.00', 'especes', '1000.00', '250.00', '21', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('21', 'TMSUU3RPAECQ4F', '3', '2026-08-15 22:34:25.315437+02', '0.00', '5350.00', '5350.00', 'especes', '10000.00', '4650.00', '21', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('22', 'TMSUU3Z6NCWSS7', '3', '2026-08-15 22:34:34.868911+02', '0.00', '3700.00', '3700.00', 'especes', '100000.00', '96300.00', '21', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('24', 'TMSUXHT617K83K', '1', '2026-08-16 00:09:19.101413+02', '0.00', '750.00', '750.00', 'especes', '1000.00', '250.00', '22', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('25', 'TMSUXIA4G3MQE7', '1', '2026-08-16 00:09:41.498927+02', '0.00', '5100.00', '5100.00', 'especes', '10000.00', '4900.00', '22', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('26', 'TMSUXJ5DZLM3YA', '1', '2026-08-16 00:10:21.585868+02', '0.00', '750.00', '750.00', 'especes', '1000.00', '250.00', '23', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('27', 'TMSUXJD1C4IIX0', '1', '2026-08-16 00:10:31.832239+02', '0.00', '750.00', '750.00', 'especes', '1000.00', '250.00', '23', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('29', 'TMSXH8E3RKMHPO', '1', '2026-08-17 18:57:24.842431+02', '0.00', '5850.00', '5850.00', 'especes', '10000.00', '4150.00', '24', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('30', 'TMSXP7VYB82523', '1', '2026-08-17 22:40:58.526708+02', '0.00', '5850.00', '5850.00', 'especes', '10000.00', '4150.00', '24', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('31', 'TMSXP85PO4OMA2', '1', '2026-08-17 22:41:10.703778+02', '0.00', '3200.00', '3200.00', 'especes', '7000.00', '3800.00', '24', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('32', 'TMSXQI54PZIJ4Z', '1', '2026-08-17 23:16:56.362043+02', '0.00', '5850.00', '5850.00', 'especes', '10000.00', '4150.00', '24', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('33', 'TMSXQI5JDU5O5J', '1', '2026-08-17 23:16:56.53693+02', '0.00', '5850.00', '5850.00', 'especes', '10000.00', '4150.00', '24', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('34', 'TMSXQIEKJFCP5D', '1', '2026-08-17 23:17:08.4313+02', '0.00', '3200.00', '3200.00', 'especes', '10000.00', '6800.00', '24', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('35', 'TMSXQJ0ASIU466', '1', '2026-08-17 23:17:36.562187+02', '0.00', '3200.00', '3200.00', 'especes', '5000.00', '1800.00', '24', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('36', 'TMSXQRM3MDZTEZ', '1', '2026-08-17 23:24:18.037231+02', '0.00', '750.00', '750.00', 'especes', '1000.00', '250.00', '25', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('37', 'TMSXQRXSFBY99K', '1', '2026-08-17 23:24:33.136696+02', '0.00', '1400.00', '1400.00', 'especes', '10000.00', '8600.00', '25', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('38', 'TMSXUIUZRND4D5', '1', '2026-08-18 01:09:28.277075+02', '0.00', '18200.00', '18200.00', 'especes', '100000.00', '81800.00', '26', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('39', 'TMSXUJC3T7NCRZ', '1', '2026-08-18 01:09:50.3515+02', '0.00', '22400.00', '22400.00', 'especes', '150000.00', '127600.00', '26', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('40', 'TMSXXWIZXZ3WMX', '1', '2026-08-18 02:44:04.368109+02', '0.00', '6500.00', '6500.00', 'especes', '10000.00', '3500.00', '26', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('41', 'TMSXYL7BUMIBS1', '1', '2026-08-18 03:03:15.733052+02', '0.00', '5100.00', '5100.00', 'especes', '5100.00', '0.00', '26', NULL) ON CONFLICT DO NOTHING;
INSERT INTO ventes (id, numero, user_id, date, remise, total, net, mode, recu, rendu, caisse_id, client_nom) VALUES ('42', 'TMSXYM71E52Q40', '1', '2026-08-18 03:04:01.902681+02', '0.00', '4700.00', '4700.00', 'especes', '10000.00', '5300.00', '26', NULL) ON CONFLICT DO NOTHING;

-- Table: vente_items (47 lignes)
TRUNCATE TABLE vente_items CASCADE;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('1', '1', '1', 'Eau minérale 1,5L', '2.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('2', '1', '3', 'Savon de toilette', '1.00', '500.00', '350.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('3', '2', '1', 'Eau minérale 1,5L', '1.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('4', '3', '4', 'Huile végétale 1L', '1.00', '1400.00', '1100.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('24', '20', '1', 'Eau minérale 1,5L', '1.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('25', '21', '4', 'Huile végétale 1L', '1.00', '1400.00', '1100.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('26', '21', '1', 'Eau minérale 1,5L', '1.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('27', '21', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('28', '22', '3', 'Savon de toilette', '1.00', '500.00', '350.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('29', '22', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('31', '24', '1', 'Eau minérale 1,5L', '1.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('32', '25', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('33', '25', '4', 'Huile végétale 1L', '1.00', '1400.00', '1100.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('34', '25', '3', 'Savon de toilette', '1.00', '500.00', '350.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('35', '26', '1', 'Eau minérale 1,5L', '1.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('36', '27', '1', 'Eau minérale 1,5L', '1.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('38', '29', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('39', '29', '3', 'Savon de toilette', '1.00', '500.00', '350.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('40', '29', '4', 'Huile végétale 1L', '1.00', '1400.00', '1100.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('41', '29', '1', 'Eau minérale 1,5L', '1.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('42', '30', '1', 'Eau minérale 1,5L', '1.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('43', '30', '4', 'Huile végétale 1L', '1.00', '1400.00', '1100.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('44', '30', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('45', '30', '3', 'Savon de toilette', '1.00', '500.00', '350.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('46', '31', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('47', '32', '1', 'Eau minérale 1,5L', '1.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('48', '32', '4', 'Huile végétale 1L', '1.00', '1400.00', '1100.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('49', '32', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('50', '32', '3', 'Savon de toilette', '1.00', '500.00', '350.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('51', '33', '1', 'Eau minérale 1,5L', '1.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('52', '33', '4', 'Huile végétale 1L', '1.00', '1400.00', '1100.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('53', '33', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('54', '33', '3', 'Savon de toilette', '1.00', '500.00', '350.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('55', '34', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('56', '35', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('57', '36', '1', 'Eau minérale 1,5L', '1.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('58', '37', '4', 'Huile végétale 1L', '1.00', '1400.00', '1100.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('59', '38', '4', 'Huile végétale 1L', '13.00', '1400.00', '1100.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('60', '39', '2', 'Riz parfumé 5kg', '7.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('61', '40', '3', 'Savon de toilette', '1.00', '500.00', '350.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('62', '40', '4', 'Huile végétale 1L', '2.00', '1400.00', '1100.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('63', '40', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('64', '41', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('65', '41', '3', 'Savon de toilette', '1.00', '500.00', '350.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('66', '41', '4', 'Huile végétale 1L', '1.00', '1400.00', '1100.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('67', '42', '1', 'Eau minérale 1,5L', '2.00', '750.00', '500.00') ON CONFLICT DO NOTHING;
INSERT INTO vente_items (id, vente_id, produit_id, nom, qte, prix, prix_achat) VALUES ('68', '42', '2', 'Riz parfumé 5kg', '1.00', '3200.00', '2600.00') ON CONFLICT DO NOTHING;

-- Table: mouvements (65 lignes)
TRUNCATE TABLE mouvements CASCADE;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('1', '2026-08-15 00:57:51.510398+02', 'Entrée (stock initial)', '1', '120.00', 'Stock initial', '1', NULL, NULL, NULL, NULL, NULL, 'MVT-00000001') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('2', '2026-08-15 00:57:51.510398+02', 'Entrée (stock initial)', '2', '40.00', 'Stock initial', '1', NULL, NULL, NULL, NULL, NULL, 'MVT-00000002') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('3', '2026-08-15 00:57:51.510398+02', 'Entrée (stock initial)', '3', '80.00', 'Stock initial', '1', NULL, NULL, NULL, NULL, NULL, 'MVT-00000003') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('4', '2026-08-15 00:57:51.510398+02', 'Entrée (stock initial)', '4', '30.00', 'Stock initial', '1', NULL, NULL, NULL, NULL, NULL, 'MVT-00000004') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('5', '2026-08-15 00:58:21.738077+02', 'Sortie vente', '1', '-2.00', 'Ticket TMSTJT12N73', '1', 'TMSTJT12N73', NULL, NULL, NULL, NULL, 'MVT-00000005') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('6', '2026-08-15 00:58:21.738077+02', 'Sortie vente', '3', '-1.00', 'Ticket TMSTJT12N73', '1', 'TMSTJT12N73', NULL, NULL, NULL, NULL, 'MVT-00000006') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('7', '2026-08-15 13:48:02.767447+02', 'Entrée (stock initial)', NULL, '5.00', 'Création du produit', '1', NULL, NULL, NULL, NULL, NULL, 'MVT-00000007') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('8', '2026-08-15 13:48:38.887438+02', 'Entrée (stock initial)', NULL, '5.00', 'Création du produit', '1', NULL, NULL, NULL, NULL, NULL, 'MVT-00000008') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('9', '2026-08-15 13:52:18.024741+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSUBGBJH56', '1', 'TMSUBGBJH56', NULL, NULL, NULL, NULL, 'MVT-00000009') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('10', '2026-08-15 13:52:30.18649+02', 'Sortie vente', '4', '-1.00', 'Ticket TMSUBGKXD38', '1', 'TMSUBGKXD38', NULL, NULL, NULL, NULL, 'MVT-00000010') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('85', '2026-08-16 00:02:09.40769+02', 'Entrée (réception fournisseur)', '1', '1.00', 'Réception commande #12 — sissoko', '1', 'CMD12', NULL, NULL, NULL, NULL, 'MVT-00000085') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('12', '2026-08-15 14:10:56.783978+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSUC4AS565', '1', 'TMSUC4AS565', NULL, NULL, NULL, NULL, 'MVT-00000012') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('13', '2026-08-15 14:10:56.783978+02', 'Sortie vente', '4', '-1.00', 'Ticket TMSUC4AS565', '1', 'TMSUC4AS565', NULL, NULL, NULL, NULL, 'MVT-00000013') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('14', '2026-08-15 14:10:56.783978+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSUC4AS565', '1', 'TMSUC4AS565', NULL, NULL, NULL, NULL, 'MVT-00000014') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('15', '2026-08-15 14:10:56.783978+02', 'Sortie vente', '3', '-1.00', 'Ticket TMSUC4AS565', '1', 'TMSUC4AS565', NULL, NULL, NULL, NULL, 'MVT-00000015') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('16', '2026-08-15 14:25:53.661958+02', 'Inventaire', '4', '-3.00', 'Comptage inventaire', '1', NULL, NULL, NULL, NULL, NULL, 'MVT-00000016') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('86', '2026-08-16 00:02:09.40769+02', 'Entrée (réception fournisseur)', '4', '1.00', 'Réception commande #12 — sissoko', '1', 'CMD12', NULL, NULL, NULL, NULL, 'MVT-00000086') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('87', '2026-08-16 00:02:09.40769+02', 'Entrée (réception fournisseur)', '2', '1.00', 'Réception commande #12 — sissoko', '1', 'CMD12', NULL, NULL, NULL, NULL, 'MVT-00000087') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('89', '2026-08-16 00:09:41.498927+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSUXIA4G3MQE7', '1', 'TMSUXIA4G3MQE7', NULL, NULL, NULL, NULL, 'MVT-00000089') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('20', '2026-08-15 14:51:53.696633+02', 'Inventaire', '1', '-1.00', 'Comptage inventaire', '1', NULL, NULL, NULL, NULL, NULL, 'MVT-00000020') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('90', '2026-08-16 00:09:41.498927+02', 'Sortie vente', '4', '-1.00', 'Ticket TMSUXIA4G3MQE7', '1', 'TMSUXIA4G3MQE7', NULL, NULL, NULL, NULL, 'MVT-00000090') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('91', '2026-08-16 00:09:41.498927+02', 'Sortie vente', '3', '-1.00', 'Ticket TMSUXIA4G3MQE7', '1', 'TMSUXIA4G3MQE7', NULL, NULL, NULL, NULL, 'MVT-00000091') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('93', '2026-08-16 00:10:31.832239+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSUXJD1C4IIX0', '1', 'TMSUXJD1C4IIX0', NULL, NULL, NULL, NULL, 'MVT-00000093') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('103', '2026-08-17 18:57:24.842431+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSXH8E3RKMHPO', '1', 'TMSXH8E3RKMHPO', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('104', '2026-08-17 18:57:24.842431+02', 'Sortie vente', '3', '-1.00', 'Ticket TMSXH8E3RKMHPO', '1', 'TMSXH8E3RKMHPO', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('105', '2026-08-17 18:57:24.842431+02', 'Sortie vente', '4', '-1.00', 'Ticket TMSXH8E3RKMHPO', '1', 'TMSXH8E3RKMHPO', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('106', '2026-08-17 18:57:24.842431+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSXH8E3RKMHPO', '1', 'TMSXH8E3RKMHPO', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('111', '2026-08-17 22:41:10.703778+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSXP85PO4OMA2', '1', 'TMSXP85PO4OMA2', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('116', '2026-08-17 23:16:56.53693+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSXQI5JDU5O5J', '1', 'TMSXQI5JDU5O5J', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('117', '2026-08-17 23:16:56.53693+02', 'Sortie vente', '4', '-1.00', 'Ticket TMSXQI5JDU5O5J', '1', 'TMSXQI5JDU5O5J', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('118', '2026-08-17 23:16:56.53693+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSXQI5JDU5O5J', '1', 'TMSXQI5JDU5O5J', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('119', '2026-08-17 23:16:56.53693+02', 'Sortie vente', '3', '-1.00', 'Ticket TMSXQI5JDU5O5J', '1', 'TMSXQI5JDU5O5J', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('121', '2026-08-17 23:17:36.562187+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSXQJ0ASIU466', '1', 'TMSXQJ0ASIU466', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('88', '2026-08-16 00:09:19.101413+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSUXHT617K83K', '1', 'TMSUXHT617K83K', NULL, NULL, NULL, NULL, 'MVT-00000088') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('66', '2026-08-15 22:34:11.589747+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSUU3GZL6BJF8', '3', 'TMSUU3GZL6BJF8', NULL, NULL, NULL, NULL, 'MVT-00000066') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('67', '2026-08-15 22:34:25.315437+02', 'Sortie vente', '4', '-1.00', 'Ticket TMSUU3RPAECQ4F', '3', 'TMSUU3RPAECQ4F', NULL, NULL, NULL, NULL, 'MVT-00000067') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('68', '2026-08-15 22:34:25.315437+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSUU3RPAECQ4F', '3', 'TMSUU3RPAECQ4F', NULL, NULL, NULL, NULL, 'MVT-00000068') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('69', '2026-08-15 22:34:25.315437+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSUU3RPAECQ4F', '3', 'TMSUU3RPAECQ4F', NULL, NULL, NULL, NULL, 'MVT-00000069') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('70', '2026-08-15 22:34:34.868911+02', 'Sortie vente', '3', '-1.00', 'Ticket TMSUU3Z6NCWSS7', '3', 'TMSUU3Z6NCWSS7', NULL, NULL, NULL, NULL, 'MVT-00000070') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('71', '2026-08-15 22:34:34.868911+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSUU3Z6NCWSS7', '3', 'TMSUU3Z6NCWSS7', NULL, NULL, NULL, NULL, 'MVT-00000071') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('92', '2026-08-16 00:10:21.585868+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSUXJ5DZLM3YA', '1', 'TMSUXJ5DZLM3YA', NULL, NULL, NULL, NULL, 'MVT-00000092') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('100', '2026-08-16 11:13:37.918363+02', 'Entrée (réception fournisseur)', '1', '2.00', 'Lot L-TEST-25E ajouté — péremption 2026-12-31', '1', NULL, NULL, NULL, NULL, NULL, 'MVT-00000100') ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('107', '2026-08-17 22:40:58.526708+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSXP7VYB82523', '1', 'TMSXP7VYB82523', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('108', '2026-08-17 22:40:58.526708+02', 'Sortie vente', '4', '-1.00', 'Ticket TMSXP7VYB82523', '1', 'TMSXP7VYB82523', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('109', '2026-08-17 22:40:58.526708+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSXP7VYB82523', '1', 'TMSXP7VYB82523', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('110', '2026-08-17 22:40:58.526708+02', 'Sortie vente', '3', '-1.00', 'Ticket TMSXP7VYB82523', '1', 'TMSXP7VYB82523', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('112', '2026-08-17 23:16:56.362043+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSXQI54PZIJ4Z', '1', 'TMSXQI54PZIJ4Z', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('113', '2026-08-17 23:16:56.362043+02', 'Sortie vente', '4', '-1.00', 'Ticket TMSXQI54PZIJ4Z', '1', 'TMSXQI54PZIJ4Z', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('114', '2026-08-17 23:16:56.362043+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSXQI54PZIJ4Z', '1', 'TMSXQI54PZIJ4Z', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('115', '2026-08-17 23:16:56.362043+02', 'Sortie vente', '3', '-1.00', 'Ticket TMSXQI54PZIJ4Z', '1', 'TMSXQI54PZIJ4Z', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('120', '2026-08-17 23:17:08.4313+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSXQIEKJFCP5D', '1', 'TMSXQIEKJFCP5D', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('122', '2026-08-17 23:24:18.037231+02', 'Sortie vente', '1', '-1.00', 'Ticket TMSXQRM3MDZTEZ', '1', 'TMSXQRM3MDZTEZ', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('123', '2026-08-17 23:24:33.136696+02', 'Sortie vente', '4', '-1.00', 'Ticket TMSXQRXSFBY99K', '1', 'TMSXQRXSFBY99K', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('124', '2026-08-18 01:09:28.277075+02', 'Sortie vente', '4', '-13.00', 'Ticket TMSXUIUZRND4D5', '1', 'TMSXUIUZRND4D5', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('125', '2026-08-18 01:09:50.3515+02', 'Sortie vente', '2', '-7.00', 'Ticket TMSXUJC3T7NCRZ', '1', 'TMSXUJC3T7NCRZ', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('126', '2026-08-18 02:44:04.368109+02', 'Sortie vente', '3', '-1.00', 'Ticket TMSXXWIZXZ3WMX', '1', 'TMSXXWIZXZ3WMX', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('127', '2026-08-18 02:44:04.368109+02', 'Sortie vente', '4', '-2.00', 'Ticket TMSXXWIZXZ3WMX', '1', 'TMSXXWIZXZ3WMX', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('128', '2026-08-18 02:44:04.368109+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSXXWIZXZ3WMX', '1', 'TMSXXWIZXZ3WMX', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('129', '2026-08-18 03:03:15.733052+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSXYL7BUMIBS1', '1', 'TMSXYL7BUMIBS1', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('130', '2026-08-18 03:03:15.733052+02', 'Sortie vente', '3', '-1.00', 'Ticket TMSXYL7BUMIBS1', '1', 'TMSXYL7BUMIBS1', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('131', '2026-08-18 03:03:15.733052+02', 'Sortie vente', '4', '-1.00', 'Ticket TMSXYL7BUMIBS1', '1', 'TMSXYL7BUMIBS1', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('132', '2026-08-18 03:04:01.902681+02', 'Sortie vente', '1', '-2.00', 'Ticket TMSXYM71E52Q40', '1', 'TMSXYM71E52Q40', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('133', '2026-08-18 03:04:01.902681+02', 'Sortie vente', '2', '-1.00', 'Ticket TMSXYM71E52Q40', '1', 'TMSXYM71E52Q40', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('134', '2026-08-18 03:31:17.154284+02', 'Sortie vente', '1', '-1.00', 'Ticket TCREDITTEST', '1', 'TCREDITTEST', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;
INSERT INTO mouvements (id, date, type, produit_id, qte, motif, user_id, ref, magasin_id, bon_id, lot_id, fournisseur_id, reference) VALUES ('135', '2026-08-18 03:31:17.209826+02', 'Annulation vente', '1', '1.00', 'Annulation ticket TCREDITTEST', '1', 'TCREDITTEST', NULL, NULL, NULL, NULL, NULL) ON CONFLICT DO NOTHING;

-- Table: points_soir (1 lignes)
TRUNCATE TABLE points_soir CASCADE;
INSERT INTO points_soir (id, date, caissiere_id, attendu, statut) VALUES ('1', '2026-08-15', '1', '2000.00', 'versement enregistré') ON CONFLICT DO NOTHING;

-- Table: depenses (1 lignes)
TRUNCATE TABLE depenses CASCADE;
INSERT INTO depenses (id, date, montant, categorie, motif, mode, user_id, created_at) VALUES ('1', '2026-08-17 00:00:00+02', '50000.00', 'Loyer', 'k', 'especes', '1', '2026-08-17 17:36:13.971923+02') ON CONFLICT DO NOTHING;

-- Table: versements (2 lignes)
TRUNCATE TABLE versements CASCADE;
INSERT INTO versements (id, point_id, date, montant, mode, user_id) VALUES ('1', '1', '2026-08-15 13:39:41.502993+02', '2000.00', 'especes', '1') ON CONFLICT DO NOTHING;
INSERT INTO versements (id, point_id, date, montant, mode, user_id) VALUES ('2', '1', '2026-08-15 13:53:19.439353+02', '2150.00', 'especes', '1') ON CONFLICT DO NOTHING;

-- Réinitialiser les séquences pour les clés primaires auto-incrémentées
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (SELECT table_name, column_name, column_default FROM information_schema.columns
            WHERE column_default LIKE 'nextval%' AND table_schema = 'public') LOOP
    BEGIN
      EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, %L), GREATEST(COALESCE(MAX(%I), 1), 1)) FROM %I',
                     r.table_name, r.column_name, r.column_name, r.table_name);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;
END $$;

SET session_replication_role = DEFAULT;
COMMIT;
