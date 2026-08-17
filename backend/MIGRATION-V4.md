# Migration v4 — Gestion par lot au niveau produit et famille

## Ce qui change

Cette migration ajoute un champ `gere_par_lot` (BOOLEAN) sur les tables **familles** et **produits**.

### Règle métier

- Si une **famille** a `gere_par_lot = true`, tous les produits créés dans cette famille héritent automatiquement de `gere_par_lot = true`.
- Si un **produit** a `gere_par_lot = true`, les champs **numéro de lot** et **date de péremption** deviennent **obligatoires** lors des réceptions (entrée stock, bon d'entrée, réception de commande).
- Si `gere_par_lot = false`, ces champs sont **optionnels** (masqués dans l'interface).

## Application

### 1. Migration base de données

```bash
psql -h localhost -p 5432 -U postgres -d gestion_stock -f backend/scripts/migration-v4.sql
```

### 2. Redémarrer le backend

```bash
cd backend && npm start
```

### 3. C'est tout — l'application se met à jour automatiquement

Aucune action côté frontend : la PWA se recharge avec les nouveaux formulaires.

## Fichiers modifiés

| Fichier | Modification |
|---|---|
| `backend/scripts/migration-v4.sql` | **Nouveau** — migration SQL (ALTER TABLE + UPDATE) |
| `backend/schema.sql` | Ajout de `gere_par_lot` dans les tables `familles` et `produits` |
| `backend/src/server.js` | 7 points modifiés (routes familles, produits, stock, bon, commande) |
| `app/app.js` | 8 points modifiés (formulaires produit, famille, mv, bon, réception, tableaux) |

## Détail des modifications backend

1. **POST /api/familles** — accepte `gere_par_lot` dans le body
2. **PUT /api/familles/:id** — met à jour `gere_par_lot`
3. **POST /api/produits** — accepte `gere_par_lot`, hérite de la famille si non spécifié
4. **PUT /api/produits/:id** — met à jour `gere_par_lot`
5. **POST /api/produits/:id/stock** — rend lot/peremption conditionnels selon `gere_par_lot`
6. **POST /api/mouvements/bon** — vérifie `gere_par_lot` par article dans le bon
7. **POST /api/commandes/:id/receptionner** — vérifie `gere_par_lot` par ligne reçue

## Détail des modifications frontend

1. **prodForm** — checkbox "Géré par lot" + envoi dans le body
2. **famManager** — checkbox "Par lot" à la création, badge et bouton toggle par famille
3. **mvForm** — champs lot/peremption masqués si non géré par lot, validation conditionnelle
4. **bonForm** — champs lot/peremption masqués si non géré par lot, validation conditionnelle
5. **commandeReception** — champs lot/peremption avec label "(opt.)" si non géré, validation conditionnelle
6. **Tableau stock** — colonne "Lot" avec badge 📦
7. **Catalogue produits** — badge 📦 à côté du nom (desktop + mobile)
