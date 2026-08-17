/* Ferme proprement la caisse admin de test (ouverte à 15:37, sans ventes) */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { Client } = require("pg");

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(
    "SELECT id FROM caisses WHERE statut='ouverte' ORDER BY id DESC LIMIT 5");
  console.log("Caisses ouvertes :", JSON.stringify(rows));
  for (const r of rows) {
    const v = await c.query("SELECT COUNT(*)::int AS n FROM ventes WHERE caisse_id = $1", [r.id]);
    if (v.rows[0].n === 0) {
      await c.query("DELETE FROM caisses WHERE id = $1", [r.id]);
      console.log("Caisse test sans ventes supprimée :", r.id);
    } else {
      console.log("Caisse avec ventes (à clôturer manuellement) :", r.id);
    }
  }
  await c.end();
})().catch(e => { console.error("ECHEC:", e.message); process.exit(1); });
