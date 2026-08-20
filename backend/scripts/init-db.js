/* Initialise la base de données : crée la base si absente, puis applique schema.sql */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const url = new URL(process.env.DATABASE_URL);
  const dbName = url.pathname.slice(1);

  // 1) tenter de créer la base (Render la crée déjà via le blueprint)
  try {
    const admin = new Pool({ connectionString: process.env.DATABASE_URL.replace("/" + dbName, "/postgres") });
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
      console.log("✅ Base créée :", dbName);
    } catch (e) {
      if (e.code === "42P04") console.log("ℹ️  Base déjà existante :", dbName);
      else console.log("⚠️  Impossible de créer la base (normal sur Render) :", e.message);
    } finally { await admin.end(); }
  } catch (e) {
    console.log("ℹ️  Skip création base (URL pointe déjà vers la bonne base)");
  }

  // 2) application du schéma
  const sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await db.query(sql);
    console.log("✅ Schéma appliqué (tables, audit, index)");
  } finally {
    await db.end();
  }
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
