/* Données de démonstration : rôles, utilisateurs, familles, produits, boutique */
require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const ROLES = {
  admin: { label: "Administrateur", droits: ["R_VENTE", "R_PRODUITS", "R_STOCK", "R_USERS", "R_RAPPORTS", "R_JOURNAL", "R_POINT", "R_PARAMS"] },
  gerant: { label: "Gérant", droits: ["R_VENTE", "R_PRODUITS", "R_STOCK", "R_RAPPORTS", "R_JOURNAL", "R_POINT", "R_PARAMS"] },
  "caissier-principal": { label: "Caissier principal(e)", droits: ["R_VENTE", "R_PRODUITS", "R_STOCK", "R_RAPPORTS", "R_JOURNAL", "R_POINT"] },
  caissier: { label: "Caissier / Vendeur", droits: ["R_VENTE"] },
  stockiste: { label: "Stockiste", droits: ["R_STOCK"] },
  comptable: { label: "Comptable", droits: ["R_RAPPORTS", "R_JOURNAL"] },
  lecteur: { label: "Lecteur", droits: ["R_RAPPORTS"] }
};

const PRODUITS = [
  ["Eau minérale 1,5L", "Boissons", "6181490000011", 500, 750, 120, 24],
  ["Riz parfumé 5kg", "Alimentation", "6181490000028", 2600, 3200, 40, 10],
  ["Savon de toilette", "Hygiène", "6181490000035", 350, 500, 80, 20],
  ["Huile végétale 1L", "Alimentation", "6181490000042", 1100, 1400, 30, 12]
];

async function main() {
  await pool.query("BEGIN");
  try {
    await pool.query("TRUNCATE versements, points_soir, vente_items, ventes, mouvements, audit_log, produits, familles, users, roles RESTART IDENTITY CASCADE");

    for (const [code, r] of Object.entries(ROLES))
      await pool.query("INSERT INTO roles(code, label, droits) VALUES($1,$2,$3) ON CONFLICT (code) DO NOTHING", [code, r.label, JSON.stringify(r.droits)]);

    const users = [
      ["admin", "admin123", "admin"],
      ["Awa Diop", "pc123", "caissier-principal"],
      ["Fatou Ndiaye", "caisse123", "caissier"]
    ];
    const userIds = {};
    for (const [nom, mdp, role] of users) {
      const { rows } = await pool.query(
        "INSERT INTO users(nom, mdp_hash, role_code, droits) VALUES($1,$2,$3,$4) RETURNING id",
        [nom, bcrypt.hashSync(mdp, 10), role, JSON.stringify(ROLES[role].droits)]);
      userIds[nom] = rows[0].id;
    }

    for (const [nom, fam, code, pa, pv, stock, min] of PRODUITS) {
      const { rows: [f] } = await pool.query("INSERT INTO familles(nom) VALUES($1) ON CONFLICT (nom) DO UPDATE SET nom=EXCLUDED.nom RETURNING id", [fam]);
      const { rows: [p] } = await pool.query(
        "INSERT INTO produits(nom, famille_id, code, prix_achat, prix_vente, stock, stock_min) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        [nom, f.id, code, pa, pv, stock, min]);
      await pool.query("INSERT INTO mouvements(type, produit_id, qte, motif, user_id) VALUES('Entrée (stock initial)',$1,$2,'Stock initial',$3)",
        [p.id, stock, userIds.admin]);
    }

    await pool.query("INSERT INTO boutique(id, nom) VALUES(1, 'Ma Boutique') ON CONFLICT (id) DO NOTHING");
    await pool.query("INSERT INTO audit_log(user_id, user_nom, action, details) VALUES(NULL, 'système', 'Initialisation', 'Données de démonstration créées')");
    await pool.query("COMMIT");
    console.log("✅ Données de démonstration créées");
    console.log("   admin / admin123 · Awa Diop / pc123 · Fatou Ndiaye / caisse123");
  } catch (e) {
    await pool.query("ROLLBACK");
    throw e;
  } finally {
    await pool.end();
  }
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
