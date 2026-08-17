# Plan de mise en production — Gestion Stock & Vente

Audit complet du code (backend Express/PostgreSQL, PWA, tâches Windows, sauvegardes) — 15/08/2026.
État : application **fonctionnelle et testée** (47/47 tests API, navigateur réel).
Ce document liste ce qui reste à faire pour un usage production serein, par priorité.

**Mise à jour 15/08/2026 après-midi : les points 🔴 et une partie des 🟠 sont traités ✅**

---

## ✅ FAIT (15/08/2026)
## ✅ FAIT (15/08/2026 après-midi, 2e passe : métier + UX)

### Métier
- **Vente sécurisée contre la survente** : verrou `FOR UPDATE` sur les produits à l'encaissement
  (deux caissières ne peuvent plus vendre en même temps plus que le stock).
- **Remise contrôlée** : nouveau paramètre en base `remise_max_pct` (0 = aucune remise,
  sinon % du total autorisé). Vérifié côté serveur (403 si dépassé) ET côté interface
  (champ grisé si 0 %, indication « Remise max : X (Y %) », limitation automatique).
  Réglable dans Paramètres → « Remise maximale autorisée à la caisse (%) ».
  Tests dédiés 7/7 ✅.
- **Inaltérabilité de l'audit rétablie** : la création du compte BDD dédié avait donné
  par erreur tous les droits (dont UPDATE/DELETE) sur audit_log au compte applicatif ;
  droits retirés, vérifié (modification refusée) ✅.

### UX — taille des données dans les tableaux
- Cellules tronquées proprement (**…** avec info-bulle complète au survol) au lieu de
  déborder ; montants alignés à droite avec chiffres tabulaires (colonnes nettes) ;
  texte compact sur mobile (padding/font réduits, largeur max 170 px) ;
  défilement horizontal fluide sur les petits écrans.
- **Dates de péremption lisibles** : 01/09/2026 au lieu de 2026-09-01T00:00:00.000Z
  (colonne + badges Expiré / Péremption).
- Hint de remise dans le panier, confirmations inchangées.
- Vérifié en navigateur réel (562 px) : Catalogue, Stocks, panier, hint remise ✅.

### 1. HTTPS + même origin pour tout — FAIT
- Certificat local via **mkcert** (autorité installée dans le système, valable jusqu'au 15/11/2028),
  couvrant `localhost`, `10.100.40.3` et `DESKTOP-0VD84HF` → `Pictures\gestion de stock\certs\`.
- `serve-app.js` réécrit : sert la PWA **et** proxie `/api/*` + `/ws` vers le backend,
  en HTTP (8080) **et** en HTTPS (**8443**). Zéro dépendance, tunnel WebSocket brut.
- `app.js` : l'API passe en **same-origin** par défaut (`location.origin`) → **plus aucune
  configuration `gs_api` sur les téléphones** ; l'override `gs_api` reste possible.
- Vérifié en navigateur réel sur `https://localhost:8443` : connexion + tableau de bord ✅,
  tests curl 200 sur les 3 chemins, WebSocket OK sur les deux proxys.
- Effet : le **scanner caméra et l'impression WebUSB fonctionneront sur téléphone/tablette**
  (contexte sécurisé), sans avertissement de certificat sur les appareils du même Wi-Fi
  (il faudra juste accepter le certificat une fois sur chaque appareil — autorité non connue
  de leurs navigateurs ; ou installer la CA sur chaque téléphone).

### 2. Mot de passe base de données dédié — FAIT
- Rôle PostgreSQL **`gsv_app`** créé avec mot de passe fort **généré aléatoirement
  (jamais affiché ni stocké en clair hors .env)** ; droits limités au schéma public
  de `gestion_stock` (tables, séquences, défauts).
- `.env` mis à jour (workspace + livraison) ; `backup.ps1` lit désormais les identifiants
  depuis `.env` (plus de mot de passe en clair dans le script).
- Sauvegarde testée avec le nouveau compte : **résultat 0** ✅
- Régression complète : **47/47 tests ✅** avec `gsv_app`.

### 3. CORS restreint — FAIT
- Origines autorisées : localhost/127.0.0.1 + IP LAN détectée automatiquement au démarrage.
- Vérifié : `http://localhost:8080` autorisé, `https://evil.com` rejeté.

### 7. Secrets dans les scripts + doc — FAIT
- `backup.ps1` sans mot de passe en clair ✅ ; `.env.example` corrigé (ports 5432/5433).

---

## 🟠 À FAIRE — Sauvegarde et continuité (nécessite l'utilisateur)

### 4. Sauvegarde 02h00 vraiment autonome
- La tâche GSV-Sauvegarde est en mode **Interactif** (S4U impossible sur compte local) :
  elle ne tourne à 02h00 que si un utilisateur est connecté, sinon rattrapage au logon.
- **Action** : lancer une fois `backend\scripts\register-backup-task.ps1 -Password "…"`
  (mot de passe Windows) → mode « Mot de passe », exécution garantie sans session.

### 5. Sauvegarde hors-site
- Les `.backup` ne vivent que sur le disque du PC (14 dernières). Ajouter une copie
  quotidienne vers une clé USB / disque réseau / cloud (extension de `backup.ps1`).

### 6. Test de restauration
- Une sauvegarde qui n'a jamais été restaurée n'est pas une sauvegarde.
  Prévoir un essai : `pg_restore` vers une base de test, vérifier comptes/caisses/ventes.

---

## 🟡 PRIORITÉ 3 — Robustesse et performances (optionnel)

| Point | Constat | Action |
|---|---|---|
| Compression HTTP | Aucune (gzip) | Ajouter compression sur API + statique (gain notable sur le Wi-Fi) |
| Journal d'audit | LIMIT 500 sans pagination | Pagination si le volume grossit |
| Photos produits | Stockées en base (dataURL) | Acceptable ; migrer en fichiers si la base grossit |
| Catalogue | Chargé intégralement à chaque vue | OK jusqu'à quelques milliers de produits ; pagination au-delà |
| Tâches de démarrage | ONLOGON interactif (serveurs démarrés à la connexion) | OK pour un poste boutique ; services Windows (nssm) si démarrage sans session voulu |
| Versionnage du code | Aucun | Initier un dépôt git local (historique + rollback) |
| Mise à jour du code | Copie manuelle des fichiers | Créer un script de déploiement (robocopy/xcopy) |

---

## 🟢 PRIORITÉ 4 — Tests restants (nécessitent le matériel, maintenant débloqués par le HTTPS)

1. **Multi-téléphones** : ouvrir `https://<IP_DU_PC>:8443` sur 2-3 appareils du Wi-Fi
   (accepter le certificat une fois par appareil), vérifier la synchro temps réel.
   Plus besoin de régler `gs_api`.
2. **Scanner caméra** : test réel d'un code-barres produit sur téléphone (HTTPS ✅).
3. **Imprimante thermique** : clôture de caisse 🧾 via WebUSB (Chrome/Edge, HTTPS ✅).
4. **Clôture réelle du soir** : scénario complet Fatou (ouverture → ventes → versement →
   clôture avec écart) puis validation Awa, avec impression du reçu.
5. **Validation visuelle tablette/ordinateur** : largeurs > 820 px (le panneau de test
   est limité à ~562 px).

---

## Déjà en place (vérifié lors de l'audit)
- Authentification JWT 12 h, vérification du compte actif à chaque requête, mots de passe bcrypt
- Anti force-brute (5 échecs → blocage 10 min, IP + utilisateur)
- Audit inaltérable (REVOKE UPDATE/DELETE sur audit_log, triggers avec user_id)
- Transactions + verrous (ventes, stock, lots FIFO, réceptions)
- Index sur toutes les clés de recherche (ventes date/user, mouvements, audit, lots, caisses)
- Enveloppeur global d'erreurs (plus aucun client bloqué en cas d'erreur)
- Rejeu hors-ligne idempotent (ref unique) + reconnexion WebSocket automatique
- Service worker stale-while-revalidate (mises à jour automatiques)
- Sauvegarde quotidienne testée (résultat 0, rétention 14) + tâches de démarrage réparées
- Responsive mobile/tablette/desktop vérifié en navigateur réel
