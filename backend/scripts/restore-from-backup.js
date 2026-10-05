/**
 * Restauration complète de la base de données depuis gestion_stock_2026-08-18_restored.json
 * Utilise la connexion définie dans DATABASE_URL (ou backend/.env)
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db");

async function restore() {
  console.log("🚀 Début de la restauration de la base de données...");

  // Chercher le fichier de backup
  const candidates = [
    path.join(__dirname, "..", "..", "backups", "gestion_stock_2026-08-18_restored.json"),
    path.join(__dirname, "..", "backups", "gestion_stock_2026-08-18_restored.json"),
    path.join(__dirname, "restore-backup.sql")
  ];

  let jsonFile = candidates.find(f => f.endsWith(".json") && fs.existsSync(f));
  if (!jsonFile) {
    console.error("❌ Fichier de sauvegarde introuvable dans :", candidates);
    process.exit(1);
  }

  console.log("📂 Lecture du fichier :", jsonFile);
  const data = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  if (!data.tables) {
    console.error("❌ Format invalide");
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Désactiver triggers pour insérer sans conflits de contraintes FK / audits
    await client.query("SET session_replication_role = replica").catch(() => {});

    const order = [
      "roles", "droits", "familles", "parametres", "boutique", "magasins", "services",
      "modes_paiement", "types_mouvement", "users", "fournisseurs", "produits",
      "lots", "stocks_magasin", "commandes", "commande_items", "bons", "bon_items",
      "demandes", "demande_items", "inventaires", "inventaire_items", "suggestions",
      "caisses", "ventes", "vente_items", "mouvements", "points_soir", "depenses",
      "versements", "versements_caisse"
    ];

    let totalRestored = 0;
    for (const t of order) {
      const rows = data.tables[t];
      if (!rows || rows.length === 0) continue;

      // Vérifier les colonnes réelles en base
      const { rows: colInfo } = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
        [t]
      );
      if (colInfo.length === 0) {
        console.log(`⚠️ Table ${t} n'existe pas en base, ignorée`);
        continue;
      }

      const availableCols = new Set(colInfo.map(c => c.column_name));
      const backupCols = Object.keys(rows[0]).filter(c => availableCols.has(c));
      if (backupCols.length === 0) continue;

      // Vider la table
      await client.query(`DELETE FROM ${t}`).catch(() => {});

      // Insérer par lots de 100
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        for (const row of batch) {
          const vals = backupCols.map(c => {
            const v = row[c];
            if (v !== null && typeof v === "object") return JSON.stringify(v);
            return v;
          });
          const placeholders = backupCols.map((_, idx) => `$${idx + 1}`).join(", ");
          await client.query(
            `INSERT INTO ${t} (${backupCols.join(", ")}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
            vals
          );
        }
      }
      console.log(`✅ Table ${t} : ${rows.length} lignes restaurées`);
      totalRestored += rows.length;
    }

    // Réinitialiser les séquences auto-increment
    try {
      await client.query(`
        DO $$
        DECLARE r RECORD;
        BEGIN
          FOR r IN (SELECT table_name, column_name, column_default FROM information_schema.columns
                    WHERE column_default LIKE 'nextval%' AND table_schema = 'public') LOOP
            BEGIN
              EXECUTE format('SELECT setval(pg_get_serial_sequence(%L, %L), GREATEST(COALESCE(MAX(%I), 1), 1)) FROM %I',
                             r.table_name, r.column_name, r.column_name, r.table_name);
            EXCEPTION WHEN OTHERS THEN NULL;
            END;
          END LOOP;
        END $$;
      `);
      console.log("✅ Séquences réinitialisées");
    } catch (e) {
      console.log("⚠️ Réinitialisation des séquences :", e.message);
    }

    await client.query("SET session_replication_role = DEFAULT").catch(() => {});
    await client.query("COMMIT");
    console.log(`\n🎉 Restauration terminée avec succès : ${totalRestored} lignes restaurées au total !`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Erreur pendant la restauration :", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  restore();
}

module.exports = { restore };
