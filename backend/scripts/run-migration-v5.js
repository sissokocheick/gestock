// Execute migration v5 using the existing db.js connection
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { pool } = require(path.join(__dirname, '..', 'src', 'db'));

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS depenses (
        id         BIGSERIAL PRIMARY KEY,
        date       TIMESTAMPTZ NOT NULL DEFAULT now(),
        montant    NUMERIC(12,2) NOT NULL CHECK (montant > 0),
        categorie  TEXT NOT NULL,
        motif      TEXT,
        mode       TEXT NOT NULL DEFAULT 'especes',
        user_id    BIGINT REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    console.log('Table depenses creee');

    await client.query('CREATE INDEX IF NOT EXISTS idx_depenses_date ON depenses(date)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_depenses_categorie ON depenses(categorie)');
    console.log('Index crees');

    await client.query(`
      CREATE TRIGGER IF NOT EXISTS trg_audit_depenses
      AFTER INSERT OR UPDATE OR DELETE ON depenses
      FOR EACH ROW EXECUTE FUNCTION audit_trigger_fn()
    `);
    console.log('Trigger audit cree');

    try {
      await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON depenses TO gsv_app');
      await client.query('GRANT USAGE, SELECT ON depenses_id_seq TO gsv_app');
      console.log('Droits accordes a gsv_app');
    } catch (e) {
      console.log('Grants (non critique):', e.message);
    }

    await client.query('COMMIT');
    console.log('Migration v5 appliquee avec succes !');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Erreur:', e.message);
  } finally {
    client.release();
    pool.end();
  }
}
migrate();
