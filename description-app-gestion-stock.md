# Application de Gestion de Stock & Vente — Description Fonctionnelle Complète

## 1. Vue d'ensemble

**Objectif :** une application unique qui permet à un commerce / une boutique de :

- gérer ses produits et son stock en temps réel ;
- vendre directement aux clients (point de vente / caisse) ;
- scanner ou imprimer des codes-barres ;
- gérer plusieurs utilisateurs avec des droits différents, **entièrement modifiables** (donner ou retirer chaque droit à chaque utilisateur, désactiver les comptes inactifs) ;
- savoir exactement **qui a fait quoi et à quelle heure** (journal d'audit) ;
- permettre à plusieurs utilisateurs de travailler **en même temps** avec des données **synchronisées en continu** ;
- permettre à chaque caissière de faire son **point de caisse le soir** en se présentant à la **caissière principale**, qui consulte l'application (la machine) et lui indique le **montant à verser** ;
- afficher le **nom et le logo de la boutique** sur tous les documents (tickets, reçus, rapports) avec un **pied de page** (contact, adresse, horaires) ;

**Utilisateurs visés :** caissiers, vendeurs, gérants, stockistes, administrateurs, comptables.
**Plateformes :** web (PC) + mobile (téléphone), caméra du téléphone ou lecteur de codes-barres pour scanner.

---

## 2. Modules fonctionnels

### 2.1 Tableau de bord
- Ventes du jour : chiffre d'affaires, **bénéfice du jour**, nombre de tickets, panier moyen
- Alertes : stock faible, produits en rupture, péremptions proches
- Top produits, activité des vendeurs, graphiques de tendance

### 2.2 Gestion des produits
- Fiche produit : nom, référence, code-barres, catégorie, unité, prix d'achat, prix de vente, prix promotionnel, TVA, stock min/max, emplacement, image
- **Calcul automatique du prix de l'unité** : à l'enregistrement, on peut saisir le **prix d'achat d'un carton / paquet / lot** et la **quantité qu'il contient** (ex. carton de 24) → le système calcule tout seul le **prix d'achat à l'unité** ; on peut aussi saisir directement le prix unitaire
- **Bénéfice automatique** : avec le prix d'achat unitaire et le prix de vente, le système calcule le **bénéfice unitaire** et la **marge (%)** de chaque produit
- Variantes (taille, couleur) avec stock séparé
- Code-barres : saisie manuelle, génération automatique, modification
- Recherche par nom, référence, catégorie ou **scan du code-barres**
- **Impression d'étiquettes** de codes-barres (imprimante thermique d'étiquettes)
- Historique complet par produit (mouvements, ventes, ajustements)
- Désactivation au lieu de suppression définitive

### 2.3 Point de vente (vente directe client)
- Panier rapide : ajout par **scan** (lecteur USB/Bluetooth ou **caméra du téléphone**) ou par recherche
- Quantités, remises (% ou montant), prix exceptionnel, notes
- Sélection du client (ou « client divers »)
- Modes de paiement : espèces, carte, **mobile money** (Wave, Orange Money, MTN MoMo, Moov…), mixte
- Calcul automatique du rendu de monnaie
- Ticket de caisse : impression thermique, PDF, envoi par SMS ou e-mail
- Ventes suspendues / reprises, annulation (motif + permission), retours / échanges
- Stock décrémenté **automatiquement** à chaque vente
- **Bénéfice calculé automatiquement** sur chaque vente (prix de vente − prix d'achat) ; il n'apparaît **pas** sur le ticket client, il est visible dans les rapports et le journal

### 2.4 Gestion des clients
- Fiche client : nom, téléphone, e-mail, adresse
- Historique d'achats complet
- Vente à crédit : solde, dettes, encaissements
- Programme de fidélité (points, réductions) — optionnel

### 2.5 Gestion du stock (vraie gestion de stock)

- **Stock par produit et par variante**, et par **dépôt / magasin** (multi-boutiques) si besoin
- **Seuils** : stock initial, stock minimum, stock de sécurité, stock maximum
- **Mouvements de stock** — chaque mouvement enregistre : **date/heure, utilisateur, type, quantité, motif, produit, dépôt, référence du document** :
  - **Entrée** : réception d'achat / bon de livraison fournisseur
  - **Sortie** : vente (automatique), usage interne, don
  - **Ajustement + / −** : correction avec motif obligatoire (casse, perte, erreur)
  - **Transfert** : entre dépôts / magasins (expédition + réception)
  - **Retour fournisseur** et **retour client**
  - **Inventaire** : comptage par scan, écart calculé automatiquement, validation en deux étapes
- **Valorisation du stock** : calcul automatique de la valeur du stock (prix moyen pondéré ou FIFO au choix), marge et bénéfice réels
- **Suivi par lot et date de péremption** (aliments, médicaments, cosmétiques) avec alertes avant expiration
- **Emplacements** : rayon / étagère pour retrouver les produits
- **Alertes automatiques** : stock bas, rupture, péremption proche, produits dormants (qui ne se vendent plus)
- **Historique complet** par produit (tous les mouvements, ventes, ajustements : qui, quand, combien)
- **Rapports de stock** : état du stock, valeur, rotation, écarts d'inventaire, exports Excel / PDF
- Le stock se met à jour **automatiquement** à chaque vente, entrée, transfert ou ajustement — toujours synchronisé entre tous les utilisateurs

### 2.6 Utilisateurs & rôles modifiables
- **Rôles entièrement modifiables** : les rôles prédéfinis (**Administrateur, Gérant, Caissier principal(e), Caissier/Vendeur, Stockiste, Comptable, Lecteur**) servent de modèles de départ, mais l'administrateur peut **créer ses propres rôles** et **donner ou retirer chaque droit individuellement** (droit par droit), aussi bien sur un rôle entier que sur **un utilisateur en particulier**.
- Liste des droits possibles : vendre / encaisser, voir les produits, créer ou modifier des produits, modifier les prix, gérer le stock, faire un inventaire, ajuster le stock, voir les rapports, gérer les clients, gérer les crédits, annuler une vente, faire ou valider les points de caisse, voir le journal d'audit, gérer les utilisateurs, etc.
- **Désactivation des utilisateurs** : tout compte peut être **désactivé** (utilisateur parti, appareil perdu, congé) — la personne ne peut plus se connecter ni vendre, mais son historique (ventes, mouvements, journal d'audit) est **conservé et toujours tracé** ; le compte peut être réactivé ou archivé définitivement.
- Authentification : identifiant + mot de passe, double authentification (option), verrouillage après échecs, expiration de session, liste des sessions actives avec déconnexion à distance
- Réinitialisation de mot de passe, journal des connexions, restriction possible par appareil
- Le **Caissier principal(e)** reçoit chaque caissière en fin de journée : consulte son point sur la machine, lui annonce le montant à verser et enregistre le versement.
- Le **Caissier / Vendeur** ne fait **que vendre** : il n'a aucun accès à la gestion (produits, stock, prix, utilisateurs) ni aux versements ; il peut seulement **consulter son propre relevé** de la journée, en lecture seule, sans pouvoir le modifier.

### 2.7 Journal d'audit (qui a fait quoi, quand)
Enregistre automatiquement et **de façon inaltérable** :
- connexions / déconnexions
- création, modification, suppression de produits, clients, utilisateurs, prix
- ventes, annulations, retours
- tous les mouvements de stock et ajustements
- exports et impressions de rapports

Chaque entrée contient : **utilisateur, date/heure précise, appareil/IP, action, détails avant/après**.
Recherche et filtres (utilisateur, période, type d'action), export CSV/PDF.
**Aucun utilisateur, même l'administrateur, ne peut modifier ou effacer le journal.**

### 2.8 Fournisseurs & achats (recommandé)
- Fiches fournisseurs, bons de commande, réceptions de marchandise → génèrent automatiquement les entrées de stock

### 2.9 Rapports & statistiques
- Ventes : par jour, période, vendeur, **famille**, produit, catégorie, caisse
- **Rentabilité (bénéfice)** : chaque vente enregistre le prix d'achat et le prix de vente → le système calcule le **bénéfice unitaire, par vente, par produit, par caissière, par jour et par période**, ainsi que la **marge en %** ; rapports de bénéfice brut, top produits les plus rentables
- Stock : valeur du stock, rotation, écarts d'inventaire, produits lents
- Export Excel / PDF, graphiques

### 2.10 Paramètres
- Devise, TVA, numérotation des tickets / bons, langue
- Sauvegardes automatiques, import / export de données

### 2.11 Point de caisse du soir — passage chez la caissière principale

Chaque soir, chaque caissière se rend **chez la caissière principale** pour faire son point :

1. La caissière principale **ouvre le point de la caissière sur la machine (l'application)** : le système affiche automatiquement le relevé de la journée de cette caissière — ventes par mode de paiement (espèces, mobile money, carte, mixte), nombre de tickets, remises, annulations, retours.
2. En regardant le montant dans la machine, la caissière principale **annonce à la caissière le montant exact qu'elle doit verser** (par exemple le total des encaissements espèces de la journée, selon la règle du magasin).
3. La caissière **verse le montant** (comptant / mobile money) et la caissière principale **enregistre le versement dans l'application** : caissière concernée, montant, mode de paiement, date/heure, reçu.
4. L'application **compare le versement au montant attendu** et signale tout écart (motif obligatoire en cas de différence).
5. Un **reçu de versement** est imprimé ou envoyé par SMS à la caissière.
6. Chaque passage et chaque versement sont **horodatés et tracés** dans le journal d'audit (qui a versé, combien, à qui, à quelle heure).

**Récapitulatif automatique du soir :** à la clôture, le système génère **automatiquement** le résumé global de la journée (toutes caisses confondues : attendu vs versé) et l'envoie à la caissière principale (notification dans l'app + PDF par e-mail / WhatsApp) — sans qu'elle ait à tout recalculer.

**Classement du point :** le point de chaque caissière et le récapitulatif peuvent être **classés ou filtrés par famille (catégorie) de produits, par article, ou par caissière** :
- par **famille** : ex. total des boissons, des aliments, des cosmétiques ;
- par **article** : détail d'un produit précis (quantités, montants, bénéfice) ;
- par **caissière** : comparer les ventes et versements de chaque caissière.
Le classement choisi est conservé dans l'export PDF / Excel.

Statuts du point : *en attente → versement enregistré → validé / écart signalé*. Export PDF / Excel.

**Rappel du rôle des caissières :** une caissière ne fait **que vendre** — elle n'enregistre jamais elle-même son point ni ses versements. Elle peut seulement **consulter son propre relevé** (lecture seule, ex. sur son téléphone) pour vérifier ses ventes du jour ; tout le reste (annonce du montant, enregistrement, validation) est fait par la caissière principale sur la machine.

### 2.12 Identité de la boutique & documents

- **Paramètres de la boutique** modifiables à tout moment : **nom, logo** (photo), adresse, téléphone, e-mail, site, horaires, devise, numéro fiscal / registre de commerce.
- Le **nom et le logo** apparaissent automatiquement en tête de tous les documents :
  - ticket de caisse ;
  - reçus de versement du point du soir ;
  - factures et bons de livraison ;
  - étiquettes de codes-barres (nom de la boutique en option) ;
  - rapports (PDF / Excel) et récapitulatif des points de caisse ;
  - relevés clients.
- **Pied de page des documents** configurable : contact (téléphone, e-mail), adresse, horaires, mention de remerciement (« Merci de votre visite »), etc.
- **Aperçu avant impression** : on voit le document avec le nom, le logo et le pied de page avant de l'imprimer.
- Chaque document garde aussi la **date/heure, le numéro de document** et l'utilisateur qui l'a généré.

---

## 3. Scénario concret : vente avec scan

1. Le caissier ouvre l'écran **Vente** (téléphone ou PC).
2. Il **scanne le code-barres** du produit (caméra ou lecteur) → le produit apparaît instantanément dans le panier.
3. Il scanne les articles suivants, modifie les quantités, applique une remise.
4. Il sélectionne le client (ou « client divers »), choisit le paiement (espèces / mobile money / carte), encaisse.
5. Le ticket s'imprime ou s'envoie par SMS ; le stock baisse automatiquement ; le mouvement « sortie vente » et le journal d'audit sont enregistrés.

### 3.2 Scénario : le point du soir chez la caissière principale

1. En fin de journée, la caissière A se rend chez la caissière principale avec sa recette.
2. La caissière principale ouvre le point de la caissière A sur l'application : elle voit le relevé du jour (ex. 250 000 F : 200 000 F en espèces, 50 000 F en mobile money).
3. Elle annonce : « Tu dois verser 200 000 F » (le total des espèces).
4. La caissière A remet l'argent ; la caissière principale enregistre le versement de 200 000 F dans l'application.
5. L'application confirme que le versement correspond au montant attendu, génère le reçu, et tout est horodaté dans le journal d'audit.

---

## 4. Multi-utilisateurs & synchronisation

- **Architecture centralisée** : une base de données unique (cloud) + application web → tous les utilisateurs voient les mêmes données.
- **Temps réel** : les mises à jour (stock, ventes, alertes) apparaissent chez tous les utilisateurs connectés quasi instantanément (WebSocket).
- **Mode hors-ligne** (option) : le téléphone continue de vendre sans réseau ; les ventes sont mises en file et synchronisées à la reconnexion, avec gestion des conflits (numéros de ticket, stocks).
- **Concurrence sûre** : le stock est mis à jour de façon atomique → pas de double vente du même article, pas de stock négatif.
- **Sauvegardes automatiques** quotidiennes.

---

## 5. Sécurité

- Mots de passe hachés, sessions protégées, permissions par rôle
- Journal d'audit immuable, pas de suppression définitive (archivage)
- Exports et accès contrôlés, déconnexion à distance des appareils perdus

---

## 6. Architecture technique conseillée

| Couche | Technologies suggérées |
|---|---|
| Frontend web | React ou Vue.js (interface responsive) |
| Mobile | PWA (même app sur téléphone) ou Flutter / React Native |
| Backend / API | Node.js ou Python (FastAPI / Django) |
| Base de données | PostgreSQL ou MySQL |
| Temps réel | WebSocket (Socket.IO) |
| Impression | Imprimante thermique ESC/POS (USB/Bluetooth), étiquettes code-barres |
| Hébergement | Cloud (recommandé) ou serveur local en boutique |

---

## 7. Tableau des rôles et permissions (exemple)

| Action | Admin | Gérant | Caissier princ. | Caissier | Stockiste | Comptable | Lecteur |
|---|---|---|---|---|---|---|---|
| Vendre / encaisser | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Gérer les produits | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Mouvements de stock | ✅ | ✅ | ✅ | sorties auto | ✅ | ❌ | ❌ |
| Inventaire / ajustements | ✅ | ✅ | ✅ | ❌ | ✅* | ❌ | ❌ |
| Annuler une vente | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Gérer clients & crédits | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Gérer utilisateurs & rôles | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Créer des rôles / donner ou retirer des droits | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Voir le journal d'audit | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ |
| Voir les rapports | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ |
| Faire le point / enregistrer les versements | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Consulter son propre relevé du jour (lecture seule) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Recevoir / valider les points des caissiers | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

\* les ajustements du stockiste sont validés par le gérant.

Le tableau montre les droits **par défaut** de chaque rôle : l'administrateur peut **donner ou retirer chaque droit à chaque utilisateur**, ou créer des rôles entièrement sur mesure.

---

## 8. Plan de réalisation conseillé

- **Phase 1 (MVP)** : produits avec **prix d'achat et calcul automatique du prix unitaire**, codes-barres (scan + étiquettes), vente rapide, **bénéfice automatique**, **gestion complète du stock (mouvements, seuils, alertes, inventaire, valorisation)**.
- **Phase 2** : utilisateurs & rôles **entièrement modifiables** (droits donnés / retirés par utilisateur, désactivation de comptes), **identité de la boutique (nom, logo) et pied de page des documents (contact, adresse)**, journal d'audit, **point de caisse du soir (passage chez la caissière principale, montant à verser annoncé via l'application, enregistrement des versements)**, rapports, sauvegardes.
- **Phase 3** : multi-dépôts, crédit & fidélité clients, mode hors-ligne, impression de tickets.
- **Phase 4** : paiements intégrés, comptabilité, analyse avancée, API.
