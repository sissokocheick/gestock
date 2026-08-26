# Gestion Stock & Vente — Application connectee a PostgreSQL

Application PWA de gestion de stock avec vente directe, connectee au backend PostgreSQL : toutes les caissieres partagent les memes donnees en temps reel.

## Comment lancer (2 serveurs)

**1. Le backend (base de donnees + API)** — dans `backend/` :
```bash
cd backend
npm start
# -> API sur http://localhost:4000 (WebSocket temps reel sur /ws)
```

**2. L'application** — dans `app/` :
```bash
cd app
node serve-app.js
# -> ouvrez http://localhost:8080
```
Puis connectez-vous avec vos identifiants.

## Fonctionnement (mode en ligne)

| Ecran | Source des donnees |
|---|---|
| Tableau de bord, Caisse, Ma journee, Catalogue, Stocks, Cloture de caisse, Personnel, Benefices, Journal d'activite, Parametres | PostgreSQL via l'API |
| Temps reel | WebSocket : une vente ou un mouvement fait par une caissiere rafraichit automatiquement les autres appareils |
| Ticket / recus / etiquettes | Impression avec nom, logo, contact et pied de page de la boutique |

## Guide de modification
- **Adresse du serveur** : constante `API_BASE` en haut de `app.js` (ou `localStorage.gs_api`).
- **Nom/logo/contact** : dans l'app -> Parametres (stockes dans PostgreSQL, visibles partout).
- **Roles et droits** : table `roles` dans PostgreSQL ; droits par utilisateur modifiables dans l'app (onglet Utilisateurs).
- **Couleurs / style** : variables CSS en haut de `style.css`.
- **Requetes SQL** : routes dans `backend/src/server.js`.

## Qualite couverte
- Desktop + mobile, navigation en bas d'ecran sur telephone
- Etats : panier vide, produit introuvable, stock insuffisant, serveur injoignable (message clair), listes vides
- Validations cote serveur : motif obligatoire, stock, montants, droits par route
- Securite : mots de passes haches (bcrypt), sessions JWT, comptes desactives bloques, journal d'audit inalterable (declencheur PostgreSQL)
- Impression : tickets, recus, etiquettes, rapports, recapitulatif du soir

## Limites actuelles
- **Camera de scan** : necessite de servir l'app en `http://localhost:8080` et un navigateur recent (Chrome/Edge Android).
- **Impression thermique USB** : fonctionne avec Chrome/Edge (WebUSB) — dans Parametres, Connecter l'imprimante puis un bouton Imprimante thermique apparait sur le ticket.
- **Etiquettes code-barres** : vraies images de codes-barres (JsBarcode) sur les etiquettes imprimees ; option code-barres sur le ticket dans Parametres.
- **Deploiement** : pour la boutique, on mettra le backend en service automatique (au demarrage du PC) et on securisera l'acces (https, secret JWT).
