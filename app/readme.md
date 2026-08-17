# 📱 Gestion Stock & Vente — Application connectée à PostgreSQL

Application PWA de gestion de stock avec vente directe, **connectée au backend PostgreSQL** : toutes les caissières partagent les **mêmes données en temps réel**.

## ▶️ Comment lancer (2 serveurs)

**1. Le backend (base de données + API)** — dans `backend/` :
```bash
cd backend
npm start
# → API sur http://localhost:4000 (WebSocket temps réel sur /ws)
```
(La base `gestion_stock` est déjà créée et remplie ; pour recréer : `npm run db:init` puis `npm run db:seed`.)

**2. L'application** — dans `app/` :
```bash
cd app
python -m http.server 8080
# → ouvrez http://localhost:8080
```
Puis connectez-vous avec un compte de démonstration.

> 💡 **Sur téléphone (même réseau Wi-Fi)** : l'application est une PWA — remplacez simplement `http://localhost:4000` par l'adresse du PC (ex. `http://192.168.1.10:4000`). Pour cela, ouvrez la console du navigateur et tapez :
> `localStorage.setItem("gs_api", "http://192.168.1.10:4000"); location.reload();`
> (ou modifiez la constante `API_BASE` en haut de `app.js` avant de déployer).

## 🔑 Comptes de démonstration
`admin` / `admin123` · `Awa Diop` / `pc123` (caissière principale) · `Fatou Ndiaye` / `caisse123` (caissière)

## 🧭 Fonctionnement (mode en ligne)

| Écran | Source des données |
|---|---|
| Tableau de bord, Caisse, Ma journée, Catalogue, Stocks, Clôture de caisse, Personnel, Bénéfices, Journal d'activité, Paramètres | **PostgreSQL via l'API** — plus aucune donnée locale |
| **Temps réel** | WebSocket : une vente ou un mouvement fait par une caissière **rafraîchit automatiquement les autres appareils** |
| Ticket / reçus / étiquettes | Impression avec nom, logo, contact et pied de page de la boutique |

## ✏️ Guide de modification
- **Adresse du serveur** : constante `API_BASE` en haut de `app.js` (ou `localStorage.gs_api`).
- **Nom/logo/contact** : dans l'app → Paramètres (stockés dans PostgreSQL, visibles partout).
- **Rôles et droits** : table `roles` dans PostgreSQL ; droits par utilisateur modifiables dans l'app (onglet Utilisateurs).
- **Couleurs / style** : variables CSS en haut de `style.css`.
- **Requêtes SQL** : routes dans `backend/src/server.js`.

## 📌 Qualité couverte
- ✅ Desktop + mobile, navigation en bas d'écran sur téléphone
- ✅ États : panier vide, produit introuvable, stock insuffisant, serveur injoignable (message clair), listes vides
- ✅ Validations côté serveur : motif obligatoire, stock, montants, droits par route
- ✅ Sécurité : mots de passe hachés (bcrypt), sessions JWT, comptes désactivés bloqués, journal d'audit inaltérable (déclencheur PostgreSQL)
- ✅ Impression : tickets, reçus, étiquettes, rapports, récapitulatif du soir

## ⚠️ Limites actuelles
- **Caméra de scan** : nécessite de servir l'app en `http://localhost:8080` (pas en double-clic) et un navigateur récent (Chrome/Edge Android).
- **Impression thermique USB** : fonctionne avec Chrome/Edge (WebUSB) — dans Paramètres, « Connecter l'imprimante » puis un bouton « Imprimante thermique » apparaît sur le ticket. Toutes les imprimantes ne sont pas compatibles WebUSB (testez avec le bouton « Test d'impression »). L'impression via la boîte du navigateur reste disponible partout.
- **Étiquettes code-barres** : vraies images de codes-barres (JsBarcode) sur les étiquettes imprimées ✅ ; option code-barres sur le ticket dans Paramètres.
- **Déploiement** : pour la boutique, on mettra le backend en service automatique (au démarrage du PC) et on sécurisera l'accès (https, secret JWT).

## 🚀 Prochaines étapes
1. Test réel sur 2-3 téléphones dans le magasin (même Wi-Fi)
2. Impression thermique ESC/POS + JsBarcode
3. Déploiement : service Windows automatique + sauvegardes PostgreSQL quotidiennes

## Nouveaut�s (3 lots d'am�liorations)

**Lot 1 � Confort quotidien**
- La caissi�re arrive directement sur l'�cran de vente apr�s connexion
- Bouton � ?? Changer � pour changer d'utilisateur
- Filtre � Stock faible uniquement � + bouton � ?? R�appro � (quantit� pr�-remplie)
- Carte � Valeur du stock � sur le tableau de bord
- P�riodes rapides dans B�n�fices (aujourd'hui, hier, 7 jours, ce mois)
- Comptes de d�monstration masquables (Param�tres ? show_demo)

**Lot 2 � Gestion approfondie**
- Familles g�rables (cr�er / renommer / supprimer)
- Fiche produit avec historique (mouvements, ventes, changements de prix trac�s)
- Graphique � Activit� des 7 derniers jours � sur le tableau de bord
- Mouvements de stock filtrables (produit, type, p�riode) + pagination
- Filtre famille + tri (nom / prix) dans la recherche de vente

**Lot 3 � Achats & robustesse**
- Lots & p�remptions : � la vente, le lot le plus ancien part en premier (FIFO)
- Fournisseurs (CRUD complet)
- Commandes fournisseurs avec lignes, co�t de livraison et r�ception (le stock augmente automatiquement, double r�ception bloqu�e)
- Mode hors-ligne : les ventes sont mises en file d'attente (r�f�rence unique = rejeu idempotent) et renvoy�es � la reconnexion
- Raccourcis clavier : F2 = recherche produit, F9 = encaisser
- Exports CSV (produits, mouvements, caisses)
