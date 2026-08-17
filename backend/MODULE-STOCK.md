# Module Stock avancé — Gestion Stock & Vente

Extension du backend (Express + PostgreSQL) : magasins, services/bénéficiaires,
bons avec **FEFO**, demandes des services, inventaires (complets + tournants),
suggestions de réappro, import **Sage 100**.

## Fichiers

| Fichier | Rôle |
|---|---|
| `backend/module-stock-v1.sql` | Migration (tables + FEFO + audit + droits) — à exécuter en postgres |
| `backend/src/module-stock.js` | Routes API du module (monté depuis `server.js`) |
| `backend/scripts/import-sage.js` | Import CSV Sage 100 (idempotent) |

## Installation (2 étapes)

1. **Migration base** (compte superutilisateur, une seule fois) :
   ```bash
   psql -h localhost -p 5433 -U postgres -d gestion_stock -f module-stock-v1.sql
   ```
2. **Redémarrage du backend** (le fichier `server.js` monte déjà le module) :
   ```bash
   cd backend && npm start
   ```

## Règles métier

- **FEFO** : à la sortie (vente service, destruction, transfert), les lots sont
  consommés par **date de péremption la plus proche** ; les lots périmés sont
  **exclus** ; les lots « centraux » (sans magasin) servent de secours ;
  stock insuffisant = bon refusé (transaction, verrous `FOR UPDATE`).
- **Bons** : créés en `saisi` (aucun effet), puis `valider` applique les effets
  stock ; `annuler` n'est possible qu'avant validation.
- **Demandes** : `creee → validee → livree → accusee`. La livraison crée et
  valide automatiquement un bon de sortie pour le service demandeur.
- **Inventaires** : création = instantané du stock théorique ; comptage =
  saisie des quantités + écart calculé ; validation = ajustement du stock +
  mouvements « Inventaire ».
- **Réappro** : suggestions calculées depuis `stock_min` (cible 2× min) ;
  « commander » crée la commande fournisseur en 1 clic et marque la suggestion.

## API (routes ajoutées)

| Méthode | Route | Description |
|---|---|---|
| GET/POST/PUT | `/api/magasins` | Magasins / dépôts |
| GET/POST | `/api/services` | Services / bénéficiaires (REBUTS pré-créé) |
| GET | `/api/stock/etat?magasin_id=` | État du stock + alertes (rupture/faible/ok) + valeur |
| POST | `/api/bons` | Créer un bon (`ENTREE`,`SORTIE`,`RETOUR`,`TRANSFERT_EXP`,`TRANSFERT_REC`,`HORS_STOCK`,`AJUSTEMENT`,`DESTRUCTION`) |
| GET | `/api/bons?type=&statut=&magasin_id=` | Liste des bons |
| GET | `/api/bons/:id` | Détail + lignes |
| POST | `/api/bons/:id/valider` | Appliquer les effets stock (FEFO) |
| POST | `/api/bons/:id/annuler` | Annuler un bon saisi |
| POST | `/api/demandes` | Créer une demande service |
| GET | `/api/demandes?statut=` | Liste des demandes |
| POST | `/api/demandes/:id/valider` `/livrer` `/accuser` | Workflow (livrer = bon de sortie auto) |
| POST | `/api/inventaires` | Ouvrir un inventaire (complet/tournant, filtre famille) |
| GET | `/api/inventaires?statut=` · `/api/inventaires/:id` | Suivi |
| POST | `/api/inventaires/:id/comptage` | Saisie des comptages |
| POST | `/api/inventaires/:id/valider` | Valider + ajuster le stock |
| GET | `/api/reappro/suggestions?magasin_id=` | Suggestions depuis les seuils |
| POST | `/api/reappro/suggestions/:id/commander` | Convertir en commande fournisseur |
| POST | `/api/reappro/suggestions/:id/ignorer` | Ignorer |

## Import Sage 100

```bash
node import-sage.js --dir C:\exports-sage --encoding utf8   # ou latin1 si export ANSI
node import-sage.js --dir C:\exports-sage --dry-run         # simulation
```

Fichiers attendus (séparateur `;` ou `,`, ligne d'en-tête) :

- `familles.csv` : `nom`
- `fournisseurs.csv` : `nom,tel,email,adresse`
- `services.csv` : `nom`
- `articles.csv` : `reference,nom,famille,unite,prix_achat,prix_vente,stock,stock_min,date_peremption`

Rejouable sans doublons (upsert par référence / nom) ; les stocks vont au
magasin « Principal » ; une `date_peremption` crée un lot.

## Prochaines étapes

1. Écrans frontend (bon de sortie par service, inventaire avec scan, suggestions).
2. Cron des inventaires tournants (planification par famille/zone).
3. Documents PDF A4 (bons, états) avec logo/entête.
4. Export CSV/Excel des rapports de consommation par service.
