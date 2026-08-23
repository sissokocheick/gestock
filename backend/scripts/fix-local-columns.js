/* Répare la vraie base locale gestion_stock (une fois, en tant que postgres) :
   ajoute les colonnes/constraintes que gsv_app ne pouvait pas créer lui-même.
   Usage : node scripts/fix-local-columns.js   (PGPASSWORD si besoin) */
const { Client } = require("../node_modules/pg");

(async () => {
  const c = new Client({
    host: "localhost", port: 5432, user: "postgres",
    password: process.env.PGPASSWORD || "admin",
    database: "gestion_stock",
  });
  await c.connect();
  const fixes = [
    `ALTER TABLE ventes ADD COLUMN IF NOT EXISTS points_utilises INT DEFAULT 0`,
    `ALTER TABLE commande_items ADD COLUMN IF NOT EXISTS qte_recue NUMERIC(12,2) DEFAULT 0`,
    `ALTER TABLE commandes DROP CONSTRAINT IF EXISTS commandes_statut_check`,
    `ALTER TABLE commandes ADD CONSTRAINT commandes_statut_check CHECK (statut IN ('en_cours','recue','partielle'))`,
  ];
  for (const f of fixes) {
    try { await c.query(f); console.log("✅", f.slice(0, 70)); }
    catch (e) { console.log("⚠️ ", f.slice(0, 70), "→", e.message); }
  }
  await c.end();
})().catch(e => { console.error("KO", e.message); process.exit(1); });
