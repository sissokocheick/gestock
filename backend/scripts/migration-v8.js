// Migration v8 : colonne client_nom sur ventes (ventes a credit / ardoise client)
// A executer en superutilisateur (postgres) car ALTER TABLE exige d'etre proprietaire de la table.
const { Client } = require('../node_modules/pg');

async function migrate() {
  const c = new Client({
    host: 'localhost', port: 5432,
    user: 'postgres', password: process.env.PG_PASSWORD || 'admin',
    database: 'gestion_stock'
  });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`ALTER TABLE ventes ADD COLUMN IF NOT EXISTS client_nom TEXT`);
    await c.query('COMMIT');
    console.log('Migration v8 appliquee avec succes (colonne client_nom) !');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('Erreur:', e.message);
  } finally {
    await c.end();
  }
}
migrate();
