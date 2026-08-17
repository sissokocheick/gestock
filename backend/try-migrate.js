// Grant CREATE on schema public to gsv_app, then create the table
// This script tries to connect as postgres first (various methods), then falls back
require('dotenv').config();
const { Client } = require('pg');

const envUrl = process.env.DATABASE_URL;
console.log('DATABASE_URL user:', new URL(envUrl).username);

// Try connecting as gsv_app and create table - maybe ALTER DEFAULT PRIVILEGES already covers it
async function tryCreate() {
  const client = new Client({ connectionString: envUrl });
  try {
    await client.connect();
    // First try to grant CREATE on schema to ourselves (won't work but let's see)
    try {
      await client.query('GRANT CREATE ON SCHEMA public TO gsv_app');
      console.log('CREATE privilege granted');
    } catch (e) {
      console.log('Cannot self-grant CREATE:', e.message);
    }
    // Try creating the table directly
    await client.query(`
      CREATE TABLE IF NOT EXISTS depenses (
        id BIGSERIAL PRIMARY KEY,
        date TIMESTAMPTZ NOT NULL DEFAULT now(),
        montant NUMERIC(12,2) NOT NULL CHECK (montant > 0),
        categorie TEXT NOT NULL,
        motif TEXT,
        mode TEXT NOT NULL DEFAULT 'especes',
        user_id BIGINT REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('SUCCESS: Table depenses created');
    await client.query('CREATE INDEX IF NOT EXISTS idx_depenses_date ON depenses(date)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_depenses_categorie ON depenses(categorie)');
    try {
      await client.query(`CREATE TRIGGER IF NOT EXISTS trg_audit_depenses AFTER INSERT OR UPDATE OR DELETE ON depenses FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn()`);
      console.log('Trigger created');
    } catch(e) { console.log('Trigger:', e.message); }
    console.log('Migration v5 OK');
  } catch (e) {
    console.error('FAILED:', e.message);
    console.log('\nThe gsv_app user needs CREATE privilege. Run this as postgres:');
    console.log('  GRANT CREATE ON SCHEMA public TO gsv_app;');
  } finally {
    await client.end();
  }
}
tryCreate();
