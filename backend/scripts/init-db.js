/* Initialise la base de données : applique schema.sql */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  // Sur Render, la base est déjà créée par le service PostgreSQL.
  // On applique juste le schéma directement.
  const sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await db.query(sql);
    console.log("✅ Schéma appliqué (tables, audit, index)");
  } catch (e) {
    // Si les tables existent déjà, on ignore les erreurs de duplication
    if (e.code === "42710" || e.code === "42P07" || e.code === "42P16") {
      console.log("ℹ️  Schéma déjà appliqué, tables existantes");
    } else {
      console.error("⚠️ Erreur schéma:", e.message);
    }
  } finally {
    await db.end();
  }
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
