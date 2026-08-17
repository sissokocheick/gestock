/* Nettoyage final : commandes de test jamais réceptionnées (#1, #2) */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Client } = require("pg");
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const del = await c.query("DELETE FROM commandes WHERE statut='en_cours' AND id <= 2");
  console.log("commandes de test supprimées :", del.rowCount);
  await c.end();
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
