# 🗄️ Backend PostgreSQL — Gestion Stock & Vente (Phase 2)

Serveur API qui connecte l'application à **PostgreSQL** : authentification (JWT), ventes, stock, point du soir, utilisateurs, rapports, journal d'audit inaltérable et **temps réel** (WebSocket) pour que toutes les caissières voient les mêmes données en direct.

## Prérequis (déjà présents sur votre machine)
- PostgreSQL installé et en cours d'exécution (votre machine a la **13** sur le port **5432** et la **18** sur le port **5433**)
- Node.js (votre machine a la v22)

## 🚀 Installation en 4 étapes

```bash
cd backend
npm install                 # déjà fait ✔️
```

1. **Créer le fichier `.env`** (copie de `.env.example`) :
   ```
   DATABASE_URL=postgres://postgres:VOTRE_MOT_DE_PASSE@localhost:5433/gestion_stock
   JWT_SECRET=une-cle-secrete-longue-et-aleatoire
   PORT=4000
   ```
   (utilisez le port **5433** pour PostgreSQL 18, ou **5432** pour la 13)

2. **Créer la base et appliquer le schéma** :
   ```bash
   npm run db:init
   ```

3. **Charger les données de démonstration** :
   ```bash
   npm run db:seed
   ```

4. **Démarrer le serveur** :
   ```bash
   npm start
   ```
   → API sur `http://localhost:4000`, temps réel sur `ws://localhost:4000/ws`

## 🔑 Comptes de démonstration
`admin` / `admin123` · `Awa Diop` / `pc123` (caissière principale) · `Fatou Ndiaye` / `caisse123` (caissière)

## 📡 API (résumé)

| Méthode | Route | Droit | Description |
|---|---|---|---|
| POST | `/api/auth/login` | — | Connexion → token JWT |
| GET | `/api/auth/me` | — | Utilisateur connecté |
| GET/POST | `/api/produits` | voir / R_PRODUITS | Liste (recherche, famille) / création |
| PUT | `/api/produits/:id` | R_PRODUITS | Modification |
| POST | `/api/produits/:id/stock` | R_STOCK | Entrée / retour / ajustement (motif obligatoire) |
| POST | `/api/produits/:id/inventaire` | R_STOCK | Comptage → écart automatique |
| POST | `/api/ventes` | R_VENTE | Encaisser (transaction : stock, mouvements, bénéfice) |
| GET | `/api/ventes?date=&caissiere=` | — | Historique |
| GET | `/api/releve` | R_VENTE | Mon relevé du jour (lecture seule) |
| GET | `/api/point/recap?date=` | R_POINT | Récapitulatif automatique (toutes caissières) |
| POST | `/api/point/versement` | R_POINT | Enregistrer un versement du point du soir |
| GET | `/api/point/classement?date=&par=` | R_POINT | Classement par caissière / famille / article |
| GET/POST/PUT | `/api/users`, `/api/users/:id` | R_USERS | Utilisateurs, droits modifiables |
| PUT | `/api/users/:id/actif` | R_USERS | Désactiver / réactiver un compte |
| GET | `/api/rapports?from=&to=&groupe=` | R_RAPPORTS | Bénéfices par période (caissière/famille/article) |
| GET | `/api/audit?user=&search=` | R_JOURNAL | Journal d'audit (inaltérable) |
| GET/PUT | `/api/boutique` | — / R_PARAMS | Nom, logo, contact, devise, pied de page |

**Test rapide** :
```bash
curl -X POST http://localhost:4000/api/auth/login -H "Content-Type: application/json" -d "{\"nom\":\"admin\",\"mdp\":\"admin123\"}"
```

## 🛡️ Sécurité intégrée
- Mots de passe **hachés** (bcrypt), sessions JWT (12 h)
- **Journal d'audit inaltérable** : un déclencheur PostgreSQL enregistre automatiquement chaque insertion/modification/suppression (produits, utilisateurs, ventes, mouvements, versements) avec l'utilisateur, la date/heure et les valeurs avant/après ; il est interdit de modifier ou supprimer ces entrées
- Désactivation des comptes : un utilisateur désactivé est rejeté au niveau de l'API
- Droits contrôlés **sur chaque route** (R_VENTE, R_STOCK, R_POINT, R_USERS…)

## 🔄 Temps réel
Chaque vente, mouvement, versement ou modification est diffusé à **tous les appareils connectés** (WebSocket) → toutes les caissières voient le stock et les ventes se mettre à jour en direct.

## ⚙️ Démarrage automatique & sauvegardes (déjà configurés)

Deux tâches planifiées Windows ont été créées et testées :

| Tâche | Quand | Action |
|---|---|---|
| **GSV-Backend** | À chaque ouverture de session | Démarre le serveur (si le port 4000 est libre) |
| **GSV-Sauvegarde** | Tous les jours à **02h00** | Sauvegarde `gestion_stock` dans `..\backups` (format compressé), conserve les **14 dernières** |

- Gestion : `schtasks /Query /TN GSV-Backend` et `schtasks /Query /TN GSV-Sauvegarde` (ou Planificateur de tâches Windows)
- Supprimer : `schtasks /Delete /TN GSV-Sauvegarde /F`
- Sauvegarde manuelle : `powershell -File scripts\backup.ps1`
- Restauration : `pg_restore -h localhost -p 5432 -U postgres -d gestion_stock "fichier.backup"`
- Le mot de passe PostgreSQL figure dans `scripts\backup.ps1` (local) — à sécuriser en production

## 📌 Prochaine étape
Connecter le frontend PWA (`app/`) à cette API (remplacer le mode local par les appels réseau) — puis déployer sur le serveur de la boutique ou le cloud.
