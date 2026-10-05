require("dotenv").config();
const { Pool } = require("pg");

const dbUrl = process.env.DATABASE_URL || "";

// Déterminer SSL intelligemment :
// - Sur le réseau interne Render (*.render.internal ou dpg-xxxx sans .render.com), SSL n'est pas supporté / nécessaire.
// - Sur les connexions externes (ex: dpg-xxxx.oregon-postgres.render.com, Supabase, Neon), SSL est obligatoire.
let sslConfig = undefined;
const isInternalRender = (dbUrl.includes("render.internal") || dbUrl.includes("dpg-")) && !dbUrl.includes(".render.com");

if (!isInternalRender) {
  if (
    process.env.PGSSL === "1" ||
    dbUrl.includes("sslmode=require") ||
    dbUrl.includes(".render.com") ||
    dbUrl.includes("neon.tech") ||
    dbUrl.includes("supabase.co")
  ) {
    sslConfig = { rejectUnauthorized: false };
  }
}

const pool = new Pool({
  connectionString: dbUrl,
  max: Number(process.env.PG_POOL_MAX) || 10,
  connectionTimeoutMillis: 10000, // Évite de bloquer indéfiniment si PostgreSQL est inaccessible
  idleTimeoutMillis: 30000,
  ssl: sslConfig
});

pool.on("error", (err) => {
  console.error("⚠️ Erreur inattendue sur le pool PostgreSQL :", err.message);
});

// Exécute une transaction avec l'utilisateur courant renseigné pour le journal d'audit
async function tx(userId, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.user_id', $1, true)", [String(userId || "")]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { pool, tx };
