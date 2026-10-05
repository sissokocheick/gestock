const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, '..', '..', 'backups', 'gestion_stock_2026-08-18_restored.json');
const dump = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

// Ordre d'insertion respectant les clés étrangères
const order = [
  'roles', 'droits', 'familles', 'parametres', 'boutique', 'magasins', 'services',
  'modes_paiement', 'types_mouvement', 'users', 'fournisseurs', 'produits',
  'lots', 'stocks_magasin', 'commandes', 'commande_items', 'bons', 'bon_items',
  'demandes', 'demande_items', 'inventaires', 'inventaire_items', 'suggestions',
  'caisses', 'ventes', 'vente_items', 'mouvements', 'points_soir', 'depenses',
  'versements', 'versements_caisse'
];

let sql = '-- ====================================================\n';
sql += '-- Restauration de la base gestion_stock du 18-08-2026\n';
sql += '-- ====================================================\n\n';
sql += 'BEGIN;\n\n';
sql += '-- Désactiver temporairement les contraintes et triggers\n';
sql += 'SET session_replication_role = replica;\n\n';

for (const t of order) {
  const rows = dump.tables[t];
  if (!rows || rows.length === 0) continue;
  sql += '-- Table: ' + t + ' (' + rows.length + ' lignes)\n';
  sql += 'TRUNCATE TABLE ' + t + ' CASCADE;\n';
  
  const cols = Object.keys(rows[0]);
  for (const r of rows) {
    const vals = cols.map(c => {
      const v = r[c];
      if (v === null || v === undefined) return 'NULL';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (typeof v === 'number') return String(v);
      if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
      return "'" + String(v).replace(/'/g, "''") + "'";
    });
    sql += 'INSERT INTO ' + t + ' (' + cols.join(', ') + ') VALUES (' + vals.join(', ') + ') ON CONFLICT DO NOTHING;\n';
  }
  sql += '\n';
}

sql += '-- Réinitialiser les séquences pour les clés primaires auto-incrémentées\n';
sql += 'DO $$\n';
sql += 'DECLARE\n';
sql += '  r RECORD;\n';
sql += 'BEGIN\n';
sql += '  FOR r IN (SELECT table_name, column_name, column_default FROM information_schema.columns\n';
sql += '            WHERE column_default LIKE \'nextval%\' AND table_schema = \'public\') LOOP\n';
sql += '    BEGIN\n';
sql += '      EXECUTE format(\'SELECT setval(pg_get_serial_sequence(%L, %L), GREATEST(COALESCE(MAX(%I), 1), 1)) FROM %I\',\n';
sql += '                     r.table_name, r.column_name, r.column_name, r.table_name);\n';
sql += '    EXCEPTION WHEN OTHERS THEN\n';
sql += '      NULL;\n';
sql += '    END;\n';
sql += '  END LOOP;\n';
sql += 'END $$;\n\n';

sql += 'SET session_replication_role = DEFAULT;\n';
sql += 'COMMIT;\n';

const outPath = path.join(__dirname, 'restore-backup.sql');
fs.writeFileSync(outPath, sql, 'utf8');
console.log('Script SQL généré :', outPath, '(' + sql.length + ' octets)');
