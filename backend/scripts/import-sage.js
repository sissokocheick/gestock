#!/usr/bin/env node
/* ============================================================
   Import Sage 100 → Gestion Stock & Vente (Module Stock v1)
   ------------------------------------------------------------
   Usage :
     node import-sage.js --dir C:\chemin\exports-sage [--encoding latin1|utf8] [--dry-run]

   Fichiers attendus (ligne d'en-tête, séparateur ; ou ,) :
     familles.csv      : nom
     fournisseurs.csv  : nom,tel,email,adresse
     services.csv      : nom
     articles.csv      : reference,nom,famille,unite,prix_achat,prix_vente,stock,stock_min,date_peremption

   Idempotent : rejouable sans doublons (upsert par référence / nom).
   Les stocks importés sont rattachés au magasin "Principal".
   ============================================================ */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { pool } = require("../src/db");

const num = v => { const n = parseFloat(String(v).replace(",", ".")); return isNaN(n) ? 0 : n; };
const clean = v => String(v == null ? "" : v).trim().replace(/^"|"$/g, "");

function args() {
  const a = { dir: null, encoding: "utf8", dryRun: false };
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--dir") a.dir = process.argv[++i];
    else if (process.argv[i] === "--encoding") a.encoding = process.argv[++i];
    else if (process.argv[i] === "--dry-run") a.dryRun = true;
  }
  return a;
}

function readCsv(file, enc) {
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  let txt;
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) txt = buf.slice(3).toString("utf8");
  else if (enc === "latin1") txt = buf.toString("latin1");
  else txt = buf.toString("utf8");
  const lines = txt.split(/\r?\n/).filter(l => l.trim() !== "");
  if (!lines.length) return [];
  const sep = (lines[0].split(";").length >= lines[0].split(",").length) ? ";" : ",";
  const split = l => l.split(sep).map(clean);
  const header = split(lines[0]).map(h => h.toLowerCase());
  return lines.slice(1).map(l => {
    const cells = split(l);
    const o = {};
    header.forEach((h, i) => { o[h] = cells[i] != null ? cells[i] : ""; });
    return o;
  });
}

async function main() {
  const a = args();
  if (!a.dir) { console.error("Usage : node import-sage.js --dir <dossier> [--encoding utf8|latin1] [--dry-run]"); process.exit(1); }

  const familles = readCsv(path.join(a.dir, "familles.csv"), a.encoding) || [];
  const fournisseurs = readCsv(path.join(a.dir, "fournisseurs.csv"), a.encoding) || [];
  const services = readCsv(path.join(a.dir, "services.csv"), a.encoding) || [];
  const articles = readCsv(path.join(a.dir, "articles.csv"), a.encoding) || [];

  console.log(`Fichiers lus : ${familles.length} familles, ${fournisseurs.length} fournisseurs, ${services.length} services, ${articles.length} articles`);
  if (a.dryRun) { console.log("[dry-run] Aucune écriture en base."); return; }

  // Magasin par défaut
  const { rows: [mag] } = await pool.query("SELECT id FROM magasins WHERE nom='Principal'");
  const magId = mag ? mag.id : (await pool.query("INSERT INTO magasins(nom) VALUES('Principal') RETURNING id")).rows[0].id;

  const stats = { familles: 0, fournisseurs: 0, services: 0, articles: 0, lots: 0 };

  for (const f of familles) {
    if (!f.nom) continue;
    await pool.query("INSERT INTO familles(nom) VALUES($1) ON CONFLICT (nom) DO UPDATE SET nom=EXCLUDED.nom", [f.nom]);
    stats.familles++;
  }
  for (const s of services) {
    if (!s.nom) continue;
    await pool.query("INSERT INTO services(nom) VALUES($1) ON CONFLICT (nom) DO UPDATE SET nom=EXCLUDED.nom", [s.nom]);
    stats.services++;
  }
  const famCache = {};
  for (const f of await (await pool.query("SELECT id, nom FROM familles")).rows) famCache[f.nom] = f.id;

  for (const f of fournisseurs) {
    if (!f.nom) continue;
    await pool.query(`INSERT INTO fournisseurs(nom, tel, email, adresse, notes)
      VALUES($1,$2,$3,$4,'Import Sage 100') ON CONFLICT (nom) DO UPDATE SET tel=EXCLUDED.tel, email=EXCLUDED.email, adresse=EXCLUDED.adresse`,
      [f.nom, f.tel || null, f.email || null, f.adresse || null]);
    stats.fournisseurs++;
  }

  const svcCache = {};
  for (const s of await (await pool.query("SELECT id, nom FROM services")).rows) svcCache[s.nom] = s.id;

  for (const art of articles) {
    const ref = art.reference || art.code || art.ref;
    if (!ref || !art.nom) continue;
    const familleId = art.famille ? (famCache[art.famille] || null) : null;
    const { rows: [p] } = await pool.query(`INSERT INTO produits(nom, famille_id, code, prix_achat, prix_vente, stock_min)
      VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (code) DO UPDATE SET nom=EXCLUDED.nom, famille_id=EXCLUDED.famille_id,
        prix_achat=EXCLUDED.prix_achat, prix_vente=EXCLUDED.prix_vente, stock_min=EXCLUDED.stock_min
      RETURNING id`,
      [art.nom, familleId, ref, num(art.prix_achat), num(art.prix_vente), num(art.stock_min)]);
    stats.articles++;
    const stock = num(art.stock);
    if (stock !== 0) {
      await pool.query(`INSERT INTO stocks_magasin(magasin_id, produit_id, qte) VALUES($1,$2,$3)
        ON CONFLICT (magasin_id, produit_id) DO UPDATE SET qte = stocks_magasin.qte + EXCLUDED.qte`, [magId, p.id, stock]);
      await pool.query(`INSERT INTO mouvements(type, produit_id, qte, motif, user_id)
        VALUES('Entrée (stock initial)',$1,$2,'Import Sage 100',NULL)`, [p.id, stock]);
    }
    if (art.date_peremption) {
      await pool.query(`INSERT INTO lots(produit_id, magasin_id, qte_restante, date_peremption)
        VALUES($1,$2,$3,$4)`, [p.id, magId, stock !== 0 ? stock : 1, art.date_peremption]);
      stats.lots++;
    }
  }

  console.log(`✔ Import terminé : ${stats.familles} familles, ${stats.fournisseurs} fournisseurs, ${stats.services} services, ${stats.articles} articles, ${stats.lots} lots`);
  await pool.end();
}

main().catch(e => { console.error("✖", e.message); process.exit(1); });
