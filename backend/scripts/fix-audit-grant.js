/* Restaure l'inaltérabilité d'audit_log : REVOKE en superuser postgres */
const { Client } = require("pg");

(async () => {
  const c = new Client({ host: "localhost", port: 5432, user: "postgres", password: "admin", database: "gestion_stock" });
  await c.connect();
  await c.query("REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM gsv_app");
  await c.end();

  // Vérif en se reconnectant comme gsv_app (via .env)
  require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
  const g = new Client({ connectionString: process.env.DATABASE_URL });
  await g.connect();
  let refused = false;
  try { await g.query("UPDATE audit_log SET details = details WHERE id = (SELECT MIN(id) FROM audit_log)"); }
  catch (e) { refused = /permission denied/.test(e.message); }
  const roles = await g.query("SELECT relacl FROM pg_class WHERE relname='audit_log'");
  console.log("relacl:", JSON.stringify(roles.rows[0].relacl));
  console.log("AUDIT_LOGIMMUTABLE_pour_gsv_app:", refused);
  await g.end();
  process.exit(refused ? 0 : 1);
})().catch(e => { console.error("ECHEC:", e.message); process.exit(1); });
