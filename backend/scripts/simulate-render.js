/* ============================================================
   SIMULATEUR DE BASE RENDER PÉRIMÉE
   Recrée fidèlement l'état d'une base Render créée avec un VIEUX
   code (avant caisses/versements_caisse/depenses), pour tester la
   réparation au démarrage de server.js.

   Usage :
     node scripts/simulate-render.js reset   # crée/écrase la base de simulation
     node scripts/simulate-render.js drop    # supprime la base de simulation

   La base simulée s'appelle gestion_stock_render_sim (jamais la vraie).
   ============================================================ */
const { Client } = require("../node_modules/pg");
const bcrypt = require("../node_modules/bcryptjs");
const MDP_ADMIN_SIM = "admin123";
const HASH_ADMIN_SIM = bcrypt.hashSync(MDP_ADMIN_SIM, 10);

const ADMIN = {
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "admin",
  database: "postgres",
};
const SIM_DB = "gestion_stock_render_sim";

async function withAdmin(fn) {
  const c = new Client(ADMIN);
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function drop() {
  await withAdmin(async c => {
    await c.query(`DROP DATABASE IF EXISTS ${SIM_DB} WITH (FORCE)`);
    console.log("🗑 Base de simulation supprimée :", SIM_DB);
  });
}

async function reset() {
  await drop();
  await withAdmin(async c => {
    await c.query(`CREATE DATABASE ${SIM_DB}`);
    console.log("📦 Base de simulation créée :", SIM_DB);
  });

  /* État Render périmé : schéma ANCIEN — ventes sans points_utilises,
     PAS de tables caisses / versements_caisse / reglements_credit /
     demandes_annulation / depenses, produits sans reference. */
  const old = new Client({ ...ADMIN, database: SIM_DB });
  await old.connect();
  try {
    await old.query(`
      CREATE TABLE roles(code TEXT PRIMARY KEY, label TEXT NOT NULL, droits JSONB NOT NULL);
      CREATE TABLE users(
        id BIGSERIAL PRIMARY KEY, nom TEXT NOT NULL UNIQUE, mdp_hash TEXT NOT NULL,
        role_code TEXT NOT NULL REFERENCES roles(code), droits JSONB NOT NULL,
        pin_code TEXT, token_version INT NOT NULL DEFAULT 1,
        actif BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE clients(
        id BIGSERIAL PRIMARY KEY, nom TEXT NOT NULL, tel TEXT, email TEXT, adresse TEXT,
        plafond_credit NUMERIC(12,2) NOT NULL DEFAULT 50000, points INT NOT NULL DEFAULT 0,
        notes TEXT, actif BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE familles(id BIGSERIAL PRIMARY KEY, nom TEXT NOT NULL UNIQUE);
      CREATE TABLE produits(
        id BIGSERIAL PRIMARY KEY, nom TEXT NOT NULL, famille_id BIGINT REFERENCES familles(id),
        code TEXT UNIQUE, photo TEXT, prix_achat NUMERIC(12,2) NOT NULL DEFAULT 0,
        prix_vente NUMERIC(12,2) NOT NULL DEFAULT 0, stock NUMERIC(12,2) NOT NULL DEFAULT 0,
        stock_min NUMERIC(12,2) NOT NULL DEFAULT 0, unite TEXT DEFAULT 'pcs',
        emplacement TEXT, parent_produit_id BIGINT REFERENCES produits(id),
        qte_par_parent NUMERIC(12,2) DEFAULT 1, actif BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE TABLE ventes(
        id BIGSERIAL PRIMARY KEY, numero TEXT NOT NULL UNIQUE,
        user_id BIGINT NOT NULL REFERENCES users(id), client_id BIGINT REFERENCES clients(id),
        date TIMESTAMPTZ NOT NULL DEFAULT now(), remise NUMERIC(12,2) NOT NULL DEFAULT 0,
        total NUMERIC(12,2) NOT NULL, net NUMERIC(12,2) NOT NULL, mode TEXT NOT NULL,
        recu NUMERIC(12,2), rendu NUMERIC(12,2), points_gagnes INT DEFAULT 0
      );
      CREATE TABLE vente_items(
        id BIGSERIAL PRIMARY KEY, vente_id BIGINT NOT NULL REFERENCES ventes(id) ON DELETE CASCADE,
        produit_id BIGINT REFERENCES produits(id), nom TEXT NOT NULL, qte NUMERIC(12,2) NOT NULL,
        prix NUMERIC(12,2) NOT NULL, prix_achat NUMERIC(12,2) NOT NULL DEFAULT 0
      );
      CREATE TABLE mouvements(
        id BIGSERIAL PRIMARY KEY, date TIMESTAMPTZ NOT NULL DEFAULT now(), type TEXT NOT NULL,
        produit_id BIGINT REFERENCES produits(id), qte NUMERIC(12,2) NOT NULL,
        motif TEXT, user_id BIGINT REFERENCES users(id), ref TEXT
      );
      CREATE TABLE modes_paiement(
        id BIGSERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, nom TEXT NOT NULL,
        especes BOOLEAN NOT NULL DEFAULT false, actif BOOLEAN NOT NULL DEFAULT true,
        ordre INT NOT NULL DEFAULT 0
      );
      INSERT INTO modes_paiement(code,nom,especes,ordre) VALUES
        ('especes','Espèces',true,1),('mobile','Mobile money',false,2),('carte','Carte',false,3);
      INSERT INTO roles(code,label,droits) VALUES ('admin','Administrateur','["R_VENTE","R_PRODUITS","R_STOCK","R_USERS","R_RAPPORTS","R_JOURNAL","R_POINT","R_PARAMS"]'::jsonb);
      INSERT INTO users(nom,mdp_hash,role_code,droits)
      VALUES ('admin', '${HASH_ADMIN_SIM}', 'admin',
              '["R_VENTE","R_PRODUITS","R_STOCK","R_USERS","R_RAPPORTS","R_JOURNAL","R_POINT","R_PARAMS"]'::jsonb);
      INSERT INTO familles(nom) VALUES ('Divers');
      INSERT INTO produits(nom,famille_id,prix_achat,prix_vente,stock,stock_min) VALUES ('SIM TEST',1,100,150,50,5);
    `);
    console.log("✅ Vieux schéma installé (ventes SANS points_utilises/client_nom/caisse_id ;");
    console.log("   PAS de tables caisses, versements_caisse, reglements_credit, demandes_annulation, depenses)");
  } finally {
    await old.end();
  }
}

const cmd = process.argv[2] || "";
if (cmd === "reset") reset().catch(e => { console.error("❌", e.message); process.exit(1); });
else if (cmd === "drop") drop().catch(e => { console.error("❌", e.message); process.exit(1); });
else { console.log("Usage : node scripts/simulate-render.js reset|drop"); process.exit(2); }
