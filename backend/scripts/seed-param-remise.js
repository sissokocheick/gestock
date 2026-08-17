/* Ajoute remise_max_pct aux parametres si absent (base existante) */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { Client } = require("pg");

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("INSERT INTO parametres(cle, valeur) VALUES('remise_max_pct','100') ON CONFLICT (cle) DO NOTHING");
  const { rows } = await c.query("SELECT cle, valeur FROM parametres ORDER BY cle");
  console.log("PARAMS:", rows.map(r => r.cle + "=" + r.valeur).join(" | "));
  await c.end();
})().catch(e => { console.error("ECHEC:", e.message); process.exit(1); });
