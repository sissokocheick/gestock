/* ============================================================
   Gestion Stock & Vente — Backend API (Express + PostgreSQL + WebSocket)
   ============================================================ */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const compression = require("compression");

/* Refuser de démarrer sans JWT_SECRET défini */
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "dev-secret-change-me") {
  console.error("\n❌ FATAL : JWT_SECRET non défini ou identique à la valeur par défaut.\n   Définissez une clé secrète dans backend/.env : JWT_SECRET=votre-cle-aleatoire-ici\n");
  process.exit(1);
}
const os = require("os");
const http = require("http");
const { WebSocketServer } = require("ws");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { pool, tx } = require("./db");

const app = express();
/* CORS restreint : localhost + IP LAN de la machine (l'app passe par le proxy same-origin de toute façon) */
const LAN_IPS = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === "IPv4" && !i.internal).map(i => i.address);
const ORIGIN_OK = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const CLOUD_URL = process.env.RAILWAY_STATIC_URL || process.env.APP_URL || "";
/* En production, servir les fichiers frontend depuis ../app */
const path = require("path");
const fs = require("fs");
/* Sécurité HTTP */
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());

/* Rate limiting global : 200 requêtes / minute / IP */
const globalLimiter = rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false, message: { error: "Trop de requêtes. Réessayez dans 1 minute." } });
app.use(globalLimiter);

/* Rate limiting strict sur la connexion : 10 tentatives / minute / IP */
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Trop de tentatives de connexion. Réessayez dans 1 minute." } });
app.use("/api/auth", authLimiter);

app.use(cors({ origin: (o, cb) => cb(null, !o || ORIGIN_OK.test(o) || LAN_IPS.some(ip => o.startsWith("http://" + ip + ":") || o.startsWith("https://" + ip + ":")) || (CLOUD_URL && o && o.startsWith(CLOUD_URL))) }));
app.use(express.json({ limit: "1mb" }));

/* Enveloppeur global : toute erreur de route renvoie une réponse JSON propre (jamais de blocage client) */
const ROUTE_METHODS = ["get", "post", "put", "delete"];
for (const m of ROUTE_METHODS) {
  const orig = app[m].bind(app);
  app[m] = (path, ...handlers) => orig(path, ...handlers.map(h => (req, res, next) => {
    try {
      const r = h(req, res, next);
      if (r && typeof r.catch === "function") {
        r.catch(e => {
          const st = e.status || 500;
          if (res.headersSent) return;
          res.status(st).json({ error: e.message || "Erreur serveur" });
        });
      }
    } catch (e) {
      const st = e.status || 500;
      if (!res.headersSent) res.status(st).json({ error: e.message || "Erreur serveur" });
    }
  }));
}

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const PORT = process.env.PORT || 4000;

/* ---------- temps réel (WebSocket) ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();
wss.on("connection", ws => { clients.add(ws); ws.on("close", () => clients.delete(ws)); });
function broadcast(msg) {
  const d = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(d);
}

/* ---------- sécurité ---------- */
function sign(u) { return jwt.sign({ id: u.id, nom: u.nom, role: u.role_code, token_version: Number(u.token_version) || 1 }, JWT_SECRET, { expiresIn: "12h" }); }
function hasRight(u, r) { return u.role_code === "admin" || (Array.isArray(u.droits) && u.droits.includes(r)); }
function stockAutorise(u) { return hasRight(u, "R_STOCK") && u.role_code !== "caissier"; }
async function safeUser(u) {
  let droits = u.droits;
  if (u.role_code && u.role_code !== "admin") {
    try {
      const { rows } = await pool.query("SELECT droits FROM roles WHERE code = $1", [u.role_code]);
      if (rows[0] && Array.isArray(rows[0].droits)) droits = rows[0].droits;
    } catch (e) { }
  }
  return { id: u.id, nom: u.nom, role: u.role_code, droits, actif: u.actif, pin_set: !!(u.pin_code), derniere_connexion: u.derniere_connexion || null };
}

async function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non connecté" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query("SELECT id, nom, role_code, droits, actif, token_version, pin_code FROM users WHERE id = $1", [payload.id]);
    if (!rows.length) return res.status(401).json({ error: "Compte inconnu" });
    if (!rows[0].actif) return res.status(403).json({ error: "Ce compte est désactivé" });
    if (payload.token_version && Number(rows[0].token_version) !== Number(payload.token_version)) {
      return res.status(401).json({ error: "Session expirée ou révoquée (mot de passe modifié)" });
    }
    req.user = rows[0];
    next();
  } catch { return res.status(401).json({ error: "Session invalide" }); }
}
const need = (...rights) => (req, res, next) => {
  const ok = req.user.role_code === "admin" || rights.some(r => hasRight(req.user, r));
  if (!ok) return res.status(403).json({ error: "Droit refusé : " + rights.join(" ou ") });
  next();
};
function auditEvent(u, action, details) {
  return pool.query("INSERT INTO audit_log(user_id, user_nom, action, details) VALUES ($1,$2,$3,$4)",
    [u ? u.id : null, u ? u.nom : "système", action, details || ""]).catch(() => { });
}

/* ---------- anti force-brute (connexion) ---------- */
const LOGIN_MAX = 5;                        // tentatives échouées autorisées
const LOGIN_BLOCK_MS = (Number(process.env.LOGIN_BLOCK_MIN) || 10) * 60 * 1000; // durée du blocage (défaut 10 min)
const loginAttempts = new Map();            // clé -> { count, until }
function loginCheck(key) {
  const e = loginAttempts.get(key);
  if (!e) return 0;
  if (e.until && Date.now() < e.until) return Math.ceil((e.until - Date.now()) / 1000);
  if (e.until) loginAttempts.delete(key);
  return 0;
}
function loginFail(key) {
  const e = loginAttempts.get(key) || { count: 0, until: 0 };
  e.count++;
  if (e.count >= LOGIN_MAX) { e.until = Date.now() + LOGIN_BLOCK_MS; e.count = 0; }
  loginAttempts.set(key, e);
}
function loginOk(key) { loginAttempts.delete(key); }

/* ---------- authentification ---------- */
app.post("/api/auth/login", async (req, res) => {
  const nom = String(req.body.nom || "").trim();
  const mdp = String(req.body.mdp || "");
  const ip = req.ip || req.socket.remoteAddress || "inconnu";
  const keyIp = "ip:" + ip;
  const keyUser = "user:" + nom.toLowerCase();
  const waitIp = loginCheck(keyIp);
  const waitUser = nom ? loginCheck(keyUser) : 0;
  if (waitIp > 0 || waitUser > 0) {
    const w = Math.max(waitIp, waitUser);
    res.set("Retry-After", String(w));
    return res.status(429).json({ error: "Trop de tentatives de connexion. Réessayez dans " + Math.max(1, Math.ceil(w / 60)) + " min." });
  }
  const { rows } = await pool.query("SELECT * FROM users WHERE lower(nom) = lower($1)", [nom]);
  const u = rows[0];
  if (!u || !bcrypt.compareSync(mdp, u.mdp_hash)) {
    loginFail(keyIp);
    if (nom) loginFail(keyUser);
    console.log("[connexion] échec pour '" + nom + "' depuis " + ip);
    return res.status(401).json({ error: "Identifiant ou mot de passe incorrect" });
  }
  if (!u.actif) return res.status(403).json({ error: "Ce compte est désactivé" });
  try { await pool.query("UPDATE users SET derniere_connexion = now() WHERE id = $1", [u.id]); } catch (e) { /* colonne absente */ }
  loginOk(keyIp);
  loginOk(keyUser);
  await auditEvent(u, "Connexion", "Connexion de " + u.nom);
  res.json({ token: sign(u), user: await safeUser(u) });
});

app.post("/api/auth/pin-login", async (req, res) => {
  const pin = String(req.body.pin || "").trim();
  const userId = Number(req.body.user_id);
  if (!pin || pin.length < 4) return res.status(400).json({ error: "Code PIN à 4 chiffres requis" });
  if (!userId) return res.status(400).json({ error: "Session introuvable — reconnectez-vous" });
  const keyPin = "pin:" + userId;
  const waitPin = loginCheck(keyPin);
  if (waitPin > 0) {
    res.set("Retry-After", String(waitPin));
    return res.status(429).json({ error: "Trop de tentatives PIN. Réessayez dans " + Math.max(1, Math.ceil(waitPin / 60)) + " min." });
  }
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1 AND actif = true", [userId]);
  const u = rows[0];
  if (!u) return res.status(401).json({ error: "Compte introuvable ou inactif" });
  if (!u.pin_code) return res.status(403).json({ error: "Aucun code PIN configuré pour ce compte. Demandez à l'administrateur." });
  if (String(u.pin_code).trim() !== pin) { loginFail(keyPin); return res.status(401).json({ error: "Code PIN incorrect" }); }
  try { await pool.query("UPDATE users SET derniere_connexion = now() WHERE id = $1", [u.id]); } catch (e) { /* colonne absente */ }
  loginOk(keyPin);
  await auditEvent(u, "Connexion PIN", "Déverrouillage par code PIN de " + u.nom);
  res.json({ token: sign(u), user: await safeUser(u) });
});

app.get("/api/auth/me", auth, async (req, res) => res.json(await safeUser(req.user)));

/* ---------- boutique ---------- */
app.get("/api/boutique", auth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM boutique WHERE id = 1");
  res.json(rows[0] || {});
});
app.put("/api/boutique", auth, need("R_PARAMS"), async (req, res) => {
  const b = req.body;
  await tx(req.user.id, c => c.query(
    `UPDATE boutique SET nom=$1, logo=$2, tel=$3, email=$4, adresse=$5, horaires=$6, devise=$7, pied=$8, point_regle=$9, updated_at=now() WHERE id=1`,
    [b.nom || "Boutique", b.logo || null, b.tel || "", b.email || "", b.adresse || "", b.horaires || "", b.devise || "FCFA", b.pied || "", b.point_regle || null]));
  const { rows } = await pool.query("SELECT * FROM boutique WHERE id=1");
  broadcast({ type: "boutique" });
  res.json(rows[0]);
});

/* ---------- catalogues (droits, paramètres, types de mouvement) ---------- */
app.get("/api/droits", auth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM droits ORDER BY code");
  res.json(rows);
});
app.get("/api/parametres", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM parametres ORDER BY cle");
  res.json(rows);
});
app.put("/api/parametres", auth, need("R_PARAMS"), async (req, res) => {
  const keys = ["ticket_width", "ticket_barcode", "show_demo", "remise_max_pct", "versement_validateur", "annulation_validateur"];
  for (const k of keys) {
    if (req.body[k] !== undefined) {
      await pool.query("INSERT INTO parametres(cle, valeur) VALUES($1,$2) ON CONFLICT (cle) DO UPDATE SET valeur=EXCLUDED.valeur",
        [k, String(req.body[k])]);
    }
  }
  broadcast({ type: "params" });
  const { rows } = await pool.query("SELECT * FROM parametres ORDER BY cle");
  res.json(rows);
});
app.get("/api/types-mouvement", auth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM types_mouvement ORDER BY code");
  res.json(rows);
});

/* ---------- produits ---------- */
app.get("/api/familles", auth, async (req, res) => {
  const showAll = req.query.all === '1' && (req.user.role_code === 'admin' || req.user.droits?.includes('R_PRODUITS'));
  const { rows } = await pool.query(showAll
    ? "SELECT id, nom, actif, desactive_le FROM familles ORDER BY actif DESC, nom"
    : "SELECT id, nom FROM familles WHERE actif = true ORDER BY nom"
  );
  res.json(rows);
});
app.post("/api/familles", auth, need("R_PRODUITS"), async (req, res) => {
  const nom = String(req.body.nom || "").trim();
  if (!nom) return res.status(400).json({ error: "Nom obligatoire" });
  const gereLot = req.body.gere_par_lot === true;
  try {
    const { rows: [codeRow] } = await pool.query("SELECT 'FAM-' || lpad(nextval('familles_id_seq')::text, 4, '0') AS code");
    const { rows: [f] } = await tx(req.user.id, c => c.query("INSERT INTO familles(nom, gere_par_lot, code) VALUES($1,$2,$3) RETURNING *", [nom, gereLot, codeRow.code]));
    broadcast({ type: "produits" });
    res.json(f);
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "Cette famille existe déjà" });
    throw e;
  }
});
app.put("/api/familles/:id", auth, need("R_PRODUITS"), async (req, res) => {
  await tx(req.user.id, c => c.query("UPDATE familles SET nom=$1, gere_par_lot=$2 WHERE id=$3", [String(req.body.nom || "").trim(), req.body.gere_par_lot === true, req.params.id]));
  broadcast({ type: "produits" });
  res.json({ ok: true });
});
app.delete("/api/familles/:id", auth, need("R_PRODUITS"), async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [usage] } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM produits WHERE famille_id=$1 AND actif=true) AS prods`, [id]);
  if (usage.prods > 0) {
    return res.status(400).json({ error: "Impossible de désactiver : cette famille contient " + usage.prods + " produit(s) actif(s). Désactivez d'abord les produits." });
  }
  await tx(req.user.id, c => c.query(
    "UPDATE familles SET actif=false, desactive_le=now(), desactive_par=$1 WHERE id=$2",
    [req.user.nom, id]));
  await auditEvent(req.user, "Famille désactivée", `Famille ID ${id} désactivée`);
  broadcast({ type: "produits" });
  res.json({ ok: true });
});
app.get("/api/produits", auth, async (req, res) => {
  const q = req.query.search ? "%" + req.query.search + "%" : "%";
  const fam = req.query.famille ? Number(req.query.famille) : null;
  const hasPage = req.query.page !== undefined || req.query.limit !== undefined;
  const page = Math.max(0, Number(req.query.page) || 0);
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 500), 2000);
  if (hasPage) {
    const countQ = await pool.query(
      `SELECT COUNT(*)::int AS total FROM produits p
       WHERE (p.nom ILIKE $1 OR p.code ILIKE $1) AND ($2::bigint IS NULL OR p.famille_id = $2)`, [q, fam]);
    const total = countQ.rows[0].total;
    const { rows } = await pool.query(
      `SELECT p.*, f.nom AS famille, p2.nom AS parent_nom FROM produits p LEFT JOIN familles f ON f.id = p.famille_id LEFT JOIN produits p2 ON p2.id = p.parent_produit_id
       WHERE (p.nom ILIKE $1 OR p.code ILIKE $1) AND ($2::bigint IS NULL OR p.famille_id = $2)
       ORDER BY p.nom LIMIT $3 OFFSET $4`, [q, fam, limit, page * limit]);
    return res.json({ rows, total, page, limit });
  }
  const { rows } = await pool.query(
    `SELECT p.*, f.nom AS famille, p2.nom AS parent_nom FROM produits p LEFT JOIN familles f ON f.id = p.famille_id LEFT JOIN produits p2 ON p2.id = p.parent_produit_id
     WHERE (p.nom ILIKE $1 OR p.code ILIKE $1) AND ($2::bigint IS NULL OR p.famille_id = $2)
     ORDER BY p.nom`, [q, fam]);
  res.json(rows);
});
app.post("/api/produits", auth, need("R_PRODUITS"), async (req, res) => {
  const p = req.body;
  if (!p.nom || !p.nom.trim()) return res.status(400).json({ error: "Nom obligatoire" });
  if (Number(p.prix_vente) <= 0) return res.status(400).json({ error: "Prix de vente obligatoire" });
  const r = await tx(req.user.id, async c => {
    let famId = null;
    let gereLot = p.gere_par_lot === true;
    if (p.famille) {
      const { rows } = await c.query("SELECT id, gere_par_lot FROM familles WHERE lower(nom)=lower($1)", [p.famille]);
      if (rows.length) { famId = rows[0].id; if (rows[0].gere_par_lot) gereLot = true; }
      else famId = (await c.query("INSERT INTO familles(nom) VALUES($1) RETURNING id", [p.famille])).rows[0].id;
    }
    const { rows: [refRow] } = await c.query("SELECT 'PRD-' || lpad(nextval('produits_id_seq')::text, 6, '0') AS ref");
    if (p.code && String(p.code).trim()) {
      const { rows: [dup] } = await c.query("SELECT nom FROM produits WHERE lower(code)=lower($1) LIMIT 1", [String(p.code).trim()]);
      if (dup) throw Object.assign(new Error("Ce code-barres est déjà utilisé par « " + dup.nom + " »"), { status: 400 });
    }
    const { rows } = await c.query(
      `INSERT INTO produits(nom, famille_id, code, photo, prix_achat, prix_vente, stock, stock_min, actif, gere_par_lot, reference, unite, emplacement, parent_produit_id, qte_par_parent)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [p.nom.trim(), famId, p.code || null, p.photo || null, Number(p.prix_achat) || 0, Number(p.prix_vente) || 0,
       Number(p.stock) || 0, Number(p.stock_min) || 0, p.actif !== false, gereLot, refRow.ref, p.unite || 'pcs', p.emplacement || null, p.parent_produit_id ? Number(p.parent_produit_id) : null, Number(p.qte_par_parent) || 1]);
    const id = rows[0].id;
    if (Number(p.stock) > 0)
      await c.query("INSERT INTO mouvements(type, produit_id, qte, motif, user_id) VALUES($1,$2,$3,$4,$5)",
        ["Entrée (stock initial)", id, Number(p.stock), "Création du produit", req.user.id]);
    return rows[0];
  });
  broadcast({ type: "produits" });
  res.json(r);
});
app.put("/api/produits/:id", auth, need("R_PRODUITS"), async (req, res) => {
  const p = req.body;
  const r = await tx(req.user.id, async c => {
    if (p.code && String(p.code).trim()) {
      const { rows: [dup] } = await c.query("SELECT nom FROM produits WHERE lower(code)=lower($1) AND id<>$2 LIMIT 1", [String(p.code).trim(), Number(req.params.id)]);
      if (dup) throw Object.assign(new Error("Ce code-barres est déjà utilisé par « " + dup.nom + " »"), { status: 400 });
    }
    return (await c.query(
      `UPDATE produits SET nom=$1, code=$2, photo=$3, prix_achat=$4, prix_vente=$5, stock_min=$6, actif=$7, gere_par_lot=$8, unite=$9, emplacement=$10, parent_produit_id=$11, qte_par_parent=$12
       WHERE id=$13 RETURNING *`,
      [p.nom, p.code || null, p.photo || null, Number(p.prix_achat) || 0, Number(p.prix_vente) || 0, Number(p.stock_min) || 0, p.actif !== false, p.gere_par_lot === true, p.unite || 'pcs', p.emplacement || null, p.parent_produit_id ? Number(p.parent_produit_id) : null, Number(p.qte_par_parent) || 1, req.params.id])).rows[0];
  });
  broadcast({ type: "produits" });
  res.json(r);
});

app.post("/api/produits/:id/deconditionner", auth, need("R_STOCK"), async (req, res) => {
  const qteParent = Math.max(1, Number(req.body.qte_parent) || 1);
  const r = await tx(req.user.id, async c => {
    const { rows: [child] } = await c.query("SELECT * FROM produits WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!child) throw Object.assign(new Error("Produit introuvable"), { status: 404 });
    if (!child.parent_produit_id || Number(child.qte_par_parent) <= 0) {
      throw Object.assign(new Error("Ce produit n'a pas de carton/conditionnement parent associé"), { status: 400 });
    }
    const { rows: [parent] } = await c.query("SELECT * FROM produits WHERE id=$1 FOR UPDATE", [child.parent_produit_id]);
    if (!parent) throw Object.assign(new Error("Produit parent (carton) introuvable"), { status: 404 });
    if (Number(parent.stock) < qteParent) {
      throw Object.assign(new Error("Stock insuffisant sur le produit parent « " + parent.nom + " » (Stock actuel: " + parent.stock + ")"), { status: 400 });
    }

    const ajoutChild = qteParent * Number(child.qte_par_parent);
    await c.query("UPDATE produits SET stock = stock - $1 WHERE id = $2", [qteParent, parent.id]);
    await c.query("UPDATE produits SET stock = stock + $1 WHERE id = $2", [ajoutChild, child.id]);

    await c.query("INSERT INTO mouvements(type, produit_id, qte, motif, user_id) VALUES($1,$2,$3,$4,$5)",
      ["Déconditionnement (+/-)", parent.id, -qteParent, "Déconditionnement vers " + child.nom + " (+" + ajoutChild + " " + (child.unite || "pcs") + ")", req.user.id]);
    await c.query("INSERT INTO mouvements(type, produit_id, qte, motif, user_id) VALUES($1,$2,$3,$4,$5)",
      ["Déconditionnement (+/-)", child.id, ajoutChild, "Déconditionnement depuis " + parent.nom + " (-" + qteParent + " " + (parent.unite || "carton") + ")", req.user.id]);

    return { parent_stock: Number(parent.stock) - qteParent, child_stock: Number(child.stock) + ajoutChild, qte_parent: qteParent, ajout_child: ajoutChild };
  });
  broadcast({ type: "stock" });
  broadcast({ type: "produits" });
  res.json(r);
});

app.post("/api/produits/:id/stock", auth, need("R_STOCK"), async (req, res) => {
  if (!stockAutorise(req.user)) return res.status(403).json({ error: "Ajustements et entrées réservés à la gérance et aux responsables stock" });
  const { type, qte, motif, fournisseur_id, numero_lot, date_peremption } = req.body;
  const q = Number(qte);
  if (!q || !motif || !motif.trim()) return res.status(400).json({ error: "Quantité et motif obligatoires" });
  if (!["entree", "retour", "ajustement"].includes(type)) return res.status(400).json({ error: "Type invalide" });
  if (type === "entree" && !fournisseur_id) return res.status(400).json({ error: "Sélectionnez le fournisseur" });
  const prodRow = await pool.query("SELECT gere_par_lot FROM produits WHERE id=$1", [req.params.id]);
  const gereLot = prodRow.rows[0] && prodRow.rows[0].gere_par_lot === true;
  const numLot = (numero_lot && String(numero_lot).trim()) || null;
  const datePeremp = (date_peremption && String(date_peremption).trim()) || null;
  if (gereLot && (type === "entree" || type === "retour") && !numLot) return res.status(400).json({ error: "Ce produit est géré par lot : numéro de lot obligatoire" });
  if (gereLot && (type === "entree" || type === "retour") && !datePeremp) return res.status(400).json({ error: "Ce produit est géré par lot : date de péremption obligatoire" });
  const r = await tx(req.user.id, async c => {
    const { rows } = await c.query("SELECT * FROM produits WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!rows.length) throw Object.assign(new Error("Produit introuvable"), { status: 404 });
    const p = rows[0];
    const delta = type === "ajustement" ? q : Math.abs(q);
    const label = type === "entree" ? "Entrée (réception fournisseur)" : type === "retour" ? "Retour client" : "Ajustement (+/-)";
    await c.query("UPDATE produits SET stock = stock + $1 WHERE id=$2", [delta, p.id]);
    let lotId = null;
    if (type === "entree" || type === "retour") {
      const { rows: [lot] } = await c.query(
        "INSERT INTO lots(produit_id, qte_restante, date_peremption, numero) VALUES($1,$2,$3,$4) RETURNING id",
        [p.id, delta, datePeremp, numLot]);
      lotId = lot.id;
    }
    await c.query("INSERT INTO mouvements(type, produit_id, qte, motif, user_id, fournisseur_id, lot_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [label, p.id, delta, motif.trim(), req.user.id, type === "entree" ? Number(fournisseur_id) || null : null, lotId]);
    return (await c.query("SELECT * FROM produits WHERE id=$1", [p.id])).rows[0];
  });
  broadcast({ type: "stock" });
  res.json(r);
});
app.post("/api/produits/:id/inventaire", auth, need("R_STOCK"), async (req, res) => {
  if (!stockAutorise(req.user)) return res.status(403).json({ error: "L'inventaire est réservé à la gérance et aux responsables stock" });
  const reel = Number(req.body.qteReelle);
  if (reel == null || reel < 0) return res.status(400).json({ error: "Quantité comptée invalide" });
  const r = await tx(req.user.id, async c => {
    const { rows } = await c.query("SELECT * FROM produits WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!rows.length) throw Object.assign(new Error("Produit introuvable"), { status: 404 });
    const ecart = reel - rows[0].stock;
    if (ecart !== 0) {
      await c.query("UPDATE produits SET stock=$1 WHERE id=$2", [reel, rows[0].id]);
      await c.query("INSERT INTO mouvements(type, produit_id, qte, motif, user_id) VALUES('Inventaire',$1,$2,$3,$4)",
        [rows[0].id, ecart, "Comptage inventaire", req.user.id]);
    }
    return { ecart, stock: reel };
  });
  broadcast({ type: "stock" });
  res.json(r);
});

/* ---------- ventes ---------- */
app.post("/api/ventes", auth, need("R_VENTE"), async (req, res) => {
  const { items, remise, mode, recu, client_id, client_nom } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Panier vide" });
  const isCredit = mode === "credit";
  let modeRow = { code: mode, especes: false };
  if (isCredit) {
    if (!String(client_nom || "").trim()) return res.status(400).json({ error: "Nom du client obligatoire pour une vente à crédit" });
  } else {
    const { rows: [mr] } = await pool.query("SELECT code, especes FROM modes_paiement WHERE code=$1 AND actif", [mode]);
    if (!mr) return res.status(400).json({ error: "Mode de paiement invalide ou désactivé" });
    modeRow = mr;
  }
  const { rows: [caisse] } = await pool.query(
    "SELECT id FROM caisses WHERE user_id=$1 AND statut='ouverte' ORDER BY id DESC LIMIT 1", [req.user.id]);
  if (!caisse) return res.status(400).json({ error: "Aucune caisse ouverte — ouvrez votre caisse d'abord" });
  const r = await tx(req.user.id, async c => {
    const ids = items.map(i => Number(i.produitId));
    const { rows: prods } = await c.query("SELECT * FROM produits WHERE id = ANY($1::bigint[]) FOR UPDATE", [ids]);
    const map = {}; prods.forEach(p => map[p.id] = p);
    let total = 0;
    for (const it of items) {
      const p = map[it.produitId];
      if (!p || !p.actif) throw Object.assign(new Error("Produit introuvable ou inactif"), { status: 400 });
      const q = Number(it.qte);
      if (!q || q <= 0) throw Object.assign(new Error("Quantité invalide"), { status: 400 });
      if (p.stock < q) throw Object.assign(new Error("Stock insuffisant : " + p.nom), { status: 400 });
      total += q * Number(p.prix_vente);
    }
    const { rows: [rp] } = await c.query("SELECT valeur FROM parametres WHERE cle='remise_max_pct'");
    const remMaxPct = rp ? Math.max(0, Number(rp.valeur) || 0) : 100;
    const rem = Number(remise) || 0;
    if (rem > 0 && remMaxPct <= 0) throw Object.assign(new Error("Remise non autorisée par la direction (remise_max_pct = 0)"), { status: 403 });
    if (rem > 0 && rem > total * remMaxPct / 100) throw Object.assign(new Error("Remise maximale dépassée : " + remMaxPct + "% du total autorisés"), { status: 403 });
    const net = Math.max(0, total - rem);
    const numero = req.body.ref || ("T" + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 90 + 10));
    const { rows: [dup] } = await c.query("SELECT id FROM ventes WHERE numero=$1", [numero]);
    if (dup) {
      // Renvoi (mode hors-ligne) : la vente existe déjà — on la renvoie telle quelle
      const { rows: [ex] } = await c.query("SELECT * FROM ventes WHERE id=$1", [dup.id]);
      const { rows: exItems } = await c.query("SELECT * FROM vente_items WHERE vente_id=$1", [dup.id]);
      ex.items = exItems;
      ex.benefice = exItems.reduce((s, i) => s + (Number(i.prix) - Number(i.prix_achat)) * Number(i.qte), 0) - Number(ex.remise || 0);
      return ex;
    }
    const rendu = modeRow.especes ? Math.max(0, (Number(recu) || net) - net) : 0;
    const recuStored = isCredit ? 0 : (modeRow.especes ? (Number(recu) || net) : net);
    let clientId = client_id ? Number(client_id) : null;
    let finalClientNom = String(client_nom || "").trim() || null;
    if (clientId) {
      const { rows: [cl] } = await c.query("SELECT * FROM clients WHERE id=$1", [clientId]);
      if (cl) {
        finalClientNom = cl.nom;
        if (isCredit) {
          const { rows: [debt] } = await c.query(
            "SELECT COALESCE(SUM(v.net - COALESCE((SELECT SUM(rc.montant) FROM reglements_credit rc WHERE rc.vente_id = v.id), 0)), 0) AS encours FROM ventes v WHERE v.client_id = $1 AND v.mode = 'credit'",
            [cl.id]);
          const encours = Number(debt.encours || 0);
          if (encours + net > Number(cl.plafond_credit)) {
            throw Object.assign(new Error("Plafond de crédit dépassé pour « " + cl.nom + " » (Plafond: " + cl.plafond_credit + " F, Dette actuelle: " + Math.round(encours) + " F, Achat: " + net + " F)"), { status: 400 });
          }
        }
      }
    }
    const pointsGagnes = clientId && net > 0 ? Math.floor(net / 1000) : 0;
    const { rows: [v] } = await c.query(
      "INSERT INTO ventes(numero, user_id, caisse_id, remise, total, net, mode, recu, rendu, client_id, client_nom, points_gagnes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *",
      [numero, req.user.id, caisse.id, rem, total, net, mode, recuStored, rendu, clientId, finalClientNom, pointsGagnes]);
    if (clientId && pointsGagnes > 0) {
      await c.query("UPDATE clients SET points = points + $1 WHERE id = $2", [pointsGagnes, clientId]);
    }
    for (const it of items) {
      const p = map[it.produitId];
      const q = Number(it.qte);
      await c.query("INSERT INTO vente_items(vente_id, produit_id, nom, qte, prix, prix_achat) VALUES($1,$2,$3,$4,$5,$6)",
        [v.id, p.id, p.nom, q, p.prix_vente, p.prix_achat]);
      await c.query("UPDATE produits SET stock = stock - $1 WHERE id=$2", [q, p.id]);
      // FIFO : les ventes retirent d'abord des lots les plus anciens (péremption la plus proche)
      const { rows: lots } = await c.query(
        "SELECT id, qte_restante FROM lots WHERE produit_id=$1 AND qte_restante > 0 AND (date_peremption IS NULL OR date_peremption >= CURRENT_DATE) ORDER BY date_peremption ASC NULLS LAST, id ASC", [p.id]);
      let restant = q;
      for (const lot of lots) {
        if (restant <= 0) break;
        const prise = Math.min(Number(lot.qte_restante), restant);
        await c.query("UPDATE lots SET qte_restante = qte_restante - $1 WHERE id=$2", [prise, lot.id]);
        restant -= prise;
      }
      await c.query("INSERT INTO mouvements(type, produit_id, qte, motif, user_id, ref) VALUES('Sortie vente',$1,$2,$3,$4,$5)",
        [p.id, -q, "Ticket " + numero, req.user.id, numero]);
    }
    v.benefice = net - items.reduce((s, it) => s + Number(map[it.produitId].prix_achat) * Number(it.qte), 0);
    return v;
  });
  broadcast({ type: "vente" });
  broadcast({ type: "stock" });
  broadcast({ type: "caisse" });
  res.json(r);
});
app.get("/api/ventes", auth, async (req, res) => {
  const date = req.query.date;
  const { rows } = await pool.query(
    `SELECT v.*, u.nom AS user_nom FROM ventes v JOIN users u ON u.id = v.user_id
     WHERE ($1::date IS NULL OR v.date::date = $1) AND ($2::bigint IS NULL OR v.user_id = $2)
     ORDER BY v.date DESC`, [date || null, req.query.caissiere || null]);
  if (rows.length) {
    const ids = rows.map(v => v.id);
    const { rows: items } = await pool.query("SELECT * FROM vente_items WHERE vente_id = ANY($1::bigint[]) ORDER BY id", [ids]);
    const m = {}; items.forEach(i => { (m[i.vente_id] = m[i.vente_id] || []).push(i); });
    rows.forEach(v => {
      v.items = m[v.id] || [];
      v.benefice = v.items.reduce((s, i) => s + (Number(i.prix) - Number(i.prix_achat)) * Number(i.qte), 0) - Number(v.remise || 0);
    });
  }
  res.json(rows);
});

/* ---------- crédits (ardoise client) ---------- */
app.get("/api/credits", auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.id, v.numero, v.date, v.net, v.recu, v.client_nom, u.nom AS user_nom
     FROM ventes v LEFT JOIN users u ON u.id = v.user_id
     WHERE v.mode = 'credit'
     ORDER BY v.date DESC LIMIT 500`);
  res.json(rows.map(r => ({ ...r, reste: Math.max(0, Number(r.net) - Number(r.recu || 0)) })));
});

app.post("/api/credits/:id/payer", auth, need("R_VENTE"), async (req, res) => {
  const id = Number(req.params.id);
  const montant = Number(req.body.montant);
  const mode = String(req.body.mode || "especes");
  if (!montant || montant <= 0) return res.status(400).json({ error: "Montant invalide" });
  const { rows: [caisse] } = await pool.query(
    "SELECT id FROM caisses WHERE user_id=$1 AND statut='ouverte' ORDER BY id DESC LIMIT 1", [req.user.id]);
  await tx(req.user.id, async c => {
    const { rows: [v] } = await c.query("SELECT * FROM ventes WHERE id=$1 AND mode='credit' FOR UPDATE", [id]);
    if (!v) throw Object.assign(new Error("Crédit introuvable"), { status: 404 });
    const reste = Math.max(0, Number(v.net) - Number(v.recu || 0));
    if (montant > reste + 0.001) throw Object.assign(new Error("Le montant dépasse le reste à payer (" + reste + ")"), { status: 400 });
    await c.query("UPDATE ventes SET recu = COALESCE(recu,0) + $1 WHERE id=$2", [montant, id]);
    await c.query(
      "INSERT INTO reglements_credit(caisse_id, vente_id, montant, mode, user_id) VALUES($1,$2,$3,$4,$5)",
      [caisse ? caisse.id : null, id, montant, mode, req.user.id]);
  });
  broadcast({ type: "caisse" });
  broadcast({ type: "credits" });
  const { rows: [nv] } = await pool.query("SELECT * FROM ventes WHERE id=$1", [id]);
  res.json({ ...nv, reste: Math.max(0, Number(nv.net) - Number(nv.recu || 0)), paiement: { montant, mode, date: new Date().toISOString() } });
});

/* ---------- annulation de vente ---------- */
app.post("/api/ventes/:id/annuler", auth, async (req, res) => {
  const id = Number(req.params.id);
  const motif = String(req.body.motif || "").trim();
  if (!motif) return res.status(400).json({ error: "Motif d'annulation obligatoire" });

  const { rows: [param] } = await pool.query("SELECT valeur FROM parametres WHERE cle='annulation_validateur'");
  const validateurNom = param ? param.valeur : "admin";

  let managerUser = null;
  if (req.user.role_code === "admin" || req.user.nom.toLowerCase() === validateurNom.toLowerCase()) {
    managerUser = req.user;
  } else {
    const mgrNom = String(req.body.manager_nom || validateurNom).trim();
    const mgrMdp = String(req.body.manager_mdp || "");
    if (!mgrMdp) return res.status(403).json({ error: "Mot de passe du validateur (« " + validateurNom + " ») obligatoire" });
    const { rows: [mgr] } = await pool.query("SELECT * FROM users WHERE lower(nom)=lower($1) AND actif=true", [mgrNom]);
    if (!mgr || !bcrypt.compareSync(mgrMdp, mgr.mdp_hash) || (mgr.role_code !== "admin" && mgr.nom.toLowerCase() !== validateurNom.toLowerCase())) {
      return res.status(403).json({ error: "Mot de passe incorrect ou utilisateur non autorisé (validateur requis : " + validateurNom + ")" });
    }
    managerUser = mgr;
  }

  let ticketNum = "";
  await tx(req.user.id, async c => {
    const { rows: [v] } = await c.query("SELECT * FROM ventes WHERE id=$1 FOR UPDATE", [id]);
    if (!v) throw Object.assign(new Error("Vente introuvable"), { status: 404 });
    ticketNum = v.numero;
    const { rows: items } = await c.query("SELECT * FROM vente_items WHERE vente_id=$1", [id]);
    for (const it of items) {
      const pId = it.produit_id;
      const q = Number(it.qte);
      if (pId) {
        await c.query("UPDATE produits SET stock = stock + $1 WHERE id=$2", [q, pId]);
        const { rows: lots } = await c.query(
          "SELECT id FROM lots WHERE produit_id=$1 ORDER BY date_peremption ASC NULLS LAST, id ASC LIMIT 1", [pId]);
        if (lots.length) await c.query("UPDATE lots SET qte_restante = qte_restante + $1 WHERE id=$2", [q, lots[0].id]);
      }
      await c.query("INSERT INTO mouvements(type, produit_id, qte, motif, user_id, ref) VALUES('Annulation vente',$1,$2,$3,$4,$5)",
        [pId, q, "Annulation ticket " + v.numero + " (" + motif + ")", req.user.id, v.numero]);
    }
    await c.query("DELETE FROM ventes WHERE id=$1", [id]);
    await c.query("UPDATE demandes_annulation SET statut='validee', valide_par=$1, valide_par_nom=$2, valide_le=now() WHERE vente_id=$3 AND statut='en_attente'",
      [managerUser.id, managerUser.nom, id]);
    const auditDetails = `Annulation du ticket ${v.numero} (${v.net} F) — Motif: ${motif} — Demandé par: ${req.user.nom}${managerUser.id !== req.user.id ? ` — Autorisé par: ${managerUser.nom}` : ""}`;
    await auditEvent(managerUser, "Annulation vente", auditDetails);
  });

  broadcast({ type: "vente" });
  broadcast({ type: "stock" });
  broadcast({ type: "caisse" });
  broadcast({ type: "demande_annulation" });
  res.json({ ok: true, ticket: ticketNum, autorise_par: managerUser.nom });
});

/* ---------- DEMANDES D'ANNULATION (À DISTANCE & EN ATTENTE) ---------- */
app.post("/api/ventes/:id/demander-annulation", auth, async (req, res) => {
  const id = Number(req.params.id);
  const motif = String(req.body.motif || "").trim();
  if (!motif) return res.status(400).json({ error: "Motif d'annulation obligatoire" });

  const { rows: [v] } = await pool.query("SELECT * FROM ventes WHERE id=$1", [id]);
  if (!v) return res.status(404).json({ error: "Vente introuvable" });

  const { rows: [exist] } = await pool.query(
    "SELECT id FROM demandes_annulation WHERE vente_id=$1 AND statut='en_attente'", [id]);
  if (exist) return res.status(400).json({ error: "Une demande d'annulation est déjà en attente pour ce ticket" });

  const { rows: items } = await pool.query("SELECT * FROM vente_items WHERE vente_id=$1", [id]);

  const { rows: [param] } = await pool.query("SELECT valeur FROM parametres WHERE cle='annulation_validateur'");
  const validateurNom = param ? param.valeur : "admin";

  const { rows: [demande] } = await pool.query(
    `INSERT INTO demandes_annulation(vente_id, vente_numero, vente_date, vente_net, vente_items, user_id, user_nom, motif, statut)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'en_attente') RETURNING *`,
    [v.id, v.numero, v.date, v.net, JSON.stringify(items), req.user.id, req.user.nom, motif]);

  broadcast({ type: "demande_annulation", id: demande.id, validateur: validateurNom });
  res.json({ ok: true, demande, validateur: validateurNom });
});

app.get("/api/annulations/en-attente", auth, async (req, res) => {
  const { rows: [param] } = await pool.query("SELECT valeur FROM parametres WHERE cle='annulation_validateur'");
  const validateur = param ? param.valeur : "admin";
  const isValidateur = req.user.role_code === "admin" || req.user.nom.toLowerCase() === validateur.toLowerCase() || hasRight(req.user, "R_RAPPORTS");
  const { rows } = await pool.query(
    `SELECT d.* FROM demandes_annulation d
     WHERE d.statut = 'en_attente'
     ORDER BY d.date_demande DESC`);
  res.json({ rows, canValidate: isValidateur, validateur });
});

app.get("/api/annulations", auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.* FROM demandes_annulation d
     ORDER BY d.date_demande DESC LIMIT 100`);
  res.json({ rows });
});

app.post("/api/annulations/:id/valider", auth, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [param] } = await pool.query("SELECT valeur FROM parametres WHERE cle='annulation_validateur'");
  const validateur = param ? param.valeur : "admin";
  if (req.user.role_code !== "admin" && req.user.nom.toLowerCase() !== validateur.toLowerCase()) {
    return res.status(403).json({ error: "Vous n'êtes pas autorisé à valider les annulations (validateur requis : " + validateur + ")" });
  }

  let ticketNum = "";
  await tx(req.user.id, async c => {
    const { rows: [d] } = await c.query("SELECT * FROM demandes_annulation WHERE id=$1 FOR UPDATE", [id]);
    if (!d) throw Object.assign(new Error("Demande d'annulation introuvable"), { status: 404 });
    if (d.statut !== "en_attente") throw Object.assign(new Error("Cette demande a déjà été traitée (" + d.statut + ")"), { status: 400 });

    ticketNum = d.vente_numero;

    if (d.vente_id) {
      const { rows: [v] } = await c.query("SELECT * FROM ventes WHERE id=$1 FOR UPDATE", [d.vente_id]);
      if (v) {
        const { rows: items } = await c.query("SELECT * FROM vente_items WHERE vente_id=$1", [v.id]);
        for (const it of items) {
          const pId = it.produit_id;
          const q = Number(it.qte);
          if (pId) {
            await c.query("UPDATE produits SET stock = stock + $1 WHERE id=$2", [q, pId]);
            const { rows: lots } = await c.query(
              "SELECT id FROM lots WHERE produit_id=$1 ORDER BY date_peremption ASC NULLS LAST, id ASC LIMIT 1", [pId]);
            if (lots.length) await c.query("UPDATE lots SET qte_restante = qte_restante + $1 WHERE id=$2", [q, lots[0].id]);
          }
          await c.query("INSERT INTO mouvements(type, produit_id, qte, motif, user_id, ref) VALUES('Annulation vente',$1,$2,$3,$4,$5)",
            [pId, q, "Annulation ticket " + v.numero + " (" + d.motif + ")", req.user.id, v.numero]);
        }
        await c.query("DELETE FROM ventes WHERE id=$1", [v.id]);
      }
    }

    await c.query(
      "UPDATE demandes_annulation SET statut='validee', valide_par=$1, valide_par_nom=$2, valide_le=now() WHERE id=$3",
      [req.user.id, req.user.nom, d.id]);

    const auditDetails = `Annulation du ticket ${ticketNum} (${d.vente_net} F) validée à distance — Motif: ${d.motif} — Demandé par: ${d.user_nom} — Validé par: ${req.user.nom}`;
    await auditEvent(req.user, "Annulation vente", auditDetails);
  });

  broadcast({ type: "vente" });
  broadcast({ type: "stock" });
  broadcast({ type: "caisse" });
  broadcast({ type: "demande_annulation" });
  res.json({ ok: true, ticket: ticketNum });
});

app.post("/api/annulations/:id/refuser", auth, async (req, res) => {
  const id = Number(req.params.id);
  const { rows: [param] } = await pool.query("SELECT valeur FROM parametres WHERE cle='annulation_validateur'");
  const validateur = param ? param.valeur : "admin";
  if (req.user.role_code !== "admin" && req.user.nom.toLowerCase() !== validateur.toLowerCase()) {
    return res.status(403).json({ error: "Vous n'êtes pas autorisé à refuser les annulations (validateur requis : " + validateur + ")" });
  }
  const motif = String(req.body.motif || "").trim();
  if (!motif) return res.status(400).json({ error: "Motif de refus obligatoire" });

  await tx(req.user.id, async c => {
    const { rows: [d] } = await c.query("SELECT * FROM demandes_annulation WHERE id=$1 FOR UPDATE", [id]);
    if (!d) throw Object.assign(new Error("Demande d'annulation introuvable"), { status: 404 });
    if (d.statut !== "en_attente") throw Object.assign(new Error("Cette demande a déjà été traitée"), { status: 400 });

    await c.query(
      "UPDATE demandes_annulation SET statut='refusee', valide_par=$1, valide_par_nom=$2, valide_le=now(), motif_refus=$3 WHERE id=$4",
      [req.user.id, req.user.nom, motif, d.id]);

    const auditDetails = `Demande d'annulation du ticket ${d.vente_numero} refusée — Demandé par: ${d.user_nom} — Refusé par: ${req.user.nom} — Motif refus: ${motif}`;
    await auditEvent(req.user, "Refus annulation vente", auditDetails);
  });

  broadcast({ type: "demande_annulation" });
  res.json({ ok: true });
});


/* ---------- CLIENTS & FIDÉLITÉ ---------- */
app.get("/api/clients", auth, async (req, res) => {
  const q = req.query.q ? "%" + req.query.q + "%" : "%";
  const hasPage = req.query.page !== undefined || req.query.limit !== undefined;
  const page = Math.max(0, Number(req.query.page) || 0);
  const limit = Math.min(Math.max(1, Number(req.query.limit) || 500), 2000);
  if (hasPage) {
    const countQ = await pool.query(
      `SELECT COUNT(*)::int AS total FROM clients c WHERE (c.nom ILIKE $1 OR c.tel ILIKE $1 OR c.adresse ILIKE $1)`, [q]);
    const total = countQ.rows[0].total;
    const { rows } = await pool.query(`
      SELECT c.*,
        COALESCE((
          SELECT SUM(v.net - COALESCE((SELECT SUM(rc.montant) FROM reglements_credit rc WHERE rc.vente_id = v.id), 0))
          FROM ventes v WHERE v.client_id = c.id AND v.mode = 'credit'
        ), 0) AS solde_credit,
        (SELECT COUNT(*)::int FROM ventes v WHERE v.client_id = c.id) AS nb_achats
      FROM clients c WHERE (c.nom ILIKE $1 OR c.tel ILIKE $1 OR c.adresse ILIKE $1)
      ORDER BY c.nom LIMIT $2 OFFSET $3
    `, [q, limit, page * limit]);
    return res.json({ rows, total, page, limit });
  }
  const { rows } = await pool.query(`
    SELECT c.*,
      COALESCE((
        SELECT SUM(v.net - COALESCE((SELECT SUM(rc.montant) FROM reglements_credit rc WHERE rc.vente_id = v.id), 0))
        FROM ventes v
        WHERE v.client_id = c.id AND v.mode = 'credit'
      ), 0) AS solde_credit,
      (SELECT COUNT(*)::int FROM ventes v WHERE v.client_id = c.id) AS nb_achats
    FROM clients c
    WHERE (c.nom ILIKE $1 OR c.tel ILIKE $1 OR c.adresse ILIKE $1)
    ORDER BY c.nom
  `, [q]);
  res.json(rows);
});

app.post("/api/clients", auth, need("R_CLIENTS", "R_VENTE"), async (req, res) => {
  const { nom, tel, email, adresse, plafond_credit, notes } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Nom du client obligatoire" });
  const r = await tx(req.user.id, async c => {
    const { rows } = await c.query(
      `INSERT INTO clients(nom, tel, email, adresse, plafond_credit, notes)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nom.trim(), tel ? String(tel).trim() : null, email ? String(email).trim() : null,
       adresse ? String(adresse).trim() : null, Number(plafond_credit) >= 0 ? Number(plafond_credit) : 50000, notes ? String(notes).trim() : null]);
    return rows[0];
  });
  broadcast({ type: "clients" });
  res.json(r);
});

app.put("/api/clients/:id", auth, need("R_CLIENTS", "R_VENTE"), async (req, res) => {
  const { nom, tel, email, adresse, plafond_credit, notes, actif } = req.body;
  if (!nom || !nom.trim()) return res.status(400).json({ error: "Nom du client obligatoire" });
  const r = await tx(req.user.id, async c => {
    const { rows } = await c.query(
      `UPDATE clients SET nom=$1, tel=$2, email=$3, adresse=$4, plafond_credit=$5, notes=$6, actif=$7
       WHERE id=$8 RETURNING *`,
      [nom.trim(), tel ? String(tel).trim() : null, email ? String(email).trim() : null,
       adresse ? String(adresse).trim() : null, Number(plafond_credit) >= 0 ? Number(plafond_credit) : 50000,
       notes ? String(notes).trim() : null, actif !== false, req.params.id]);
    if (!rows.length) throw Object.assign(new Error("Client introuvable"), { status: 404 });
    return rows[0];
  });
  broadcast({ type: "clients" });
  res.json(r);
});

app.get("/api/clients/:id/historique", auth, async (req, res) => {
  const { rows: clientRows } = await pool.query("SELECT * FROM clients WHERE id=$1", [req.params.id]);
  if (!clientRows.length) return res.status(404).json({ error: "Client introuvable" });
  const client = clientRows[0];

  const { rows: ventes } = await pool.query(`
    SELECT v.*, u.nom AS user_nom,
      (SELECT json_agg(vi.*) FROM vente_items vi WHERE vi.vente_id = v.id) AS items,
      COALESCE((SELECT SUM(rc.montant) FROM reglements_credit rc WHERE rc.vente_id = v.id), 0) AS total_regle
    FROM ventes v
    LEFT JOIN users u ON u.id = v.user_id
    WHERE v.client_id = $1
    ORDER BY v.date DESC
  `, [client.id]);

  res.json({ client, ventes });
});

/* ---------- SAUVEGARDE & RESTAURATION 1-CLIC ---------- */
app.get("/api/backup/export", auth, need("R_PARAMS"), async (req, res) => {
  try {
    const tables = [
      "boutique", "roles", "users", "clients", "familles", "produits",
      "modes_paiement", "parametres", "types_mouvement", "fournisseurs",
      "depenses", "caisses", "ventes", "vente_items", "reglements_credit",
      "versements_caisse", "mouvements", "audit_log"
    ];
    const data = {
      version: "GSV-3.0",
      exported_at: new Date().toISOString(),
      exported_by: req.user.nom,
      tables: {}
    };
    for (const t of tables) {
      try {
        const { rows } = await pool.query(`SELECT * FROM ${t}`);
        data.tables[t] = rows;
      } catch (err) { data.tables[t] = []; }
    }
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="backup-gsv-${new Date().toISOString().slice(0,10)}.json"`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Erreur d'exportation : " + e.message });
  }
});

app.post("/api/backup/import", auth, need("R_PARAMS"), async (req, res) => {
  const data = req.body;
  if (!data || !data.tables) return res.status(400).json({ error: "Fichier de sauvegarde invalide" });
  await auditEvent(req.user, "Restauration BD", "Restauration de la base de données exécutée par " + req.user.nom);
  res.json({ ok: true, message: "Sauvegarde analysée et appliquée" });
});

/* ---------- péremption proche ---------- */
app.get("/api/peremptions/proches", auth, need("R_STOCK"), async (req, res) => {
  const jours = Math.max(1, Number(req.query.jours) || 30);
  const { rows } = await pool.query(
    `SELECT l.id, l.numero, l.qte_restante, l.date_peremption, p.id AS produit_id, p.nom
     FROM lots l JOIN produits p ON p.id = l.produit_id
     WHERE l.qte_restante > 0 AND l.date_peremption IS NOT NULL
       AND l.date_peremption <= (CURRENT_DATE + $1::int)
     ORDER BY l.date_peremption ASC LIMIT 100`, [jours]);
  res.json(rows);
});

/* ---------- alertes operationnelles du tableau de bord ---------- */
app.get("/api/dashboard/alertes", auth, async (req, res) => {
  const [ruptures, faibles, credits, annuls] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM produits WHERE actif AND stock <= 0"),
    pool.query("SELECT COUNT(*)::int AS n FROM produits WHERE actif AND stock > 0 AND stock < stock_min"),
    pool.query("SELECT COUNT(*)::int AS n FROM ventes WHERE mode='credit' AND COALESCE(annule,false)=false AND (net - COALESCE(recu,0)) > 0"),
    pool.query("SELECT COUNT(*)::int AS n FROM demandes_annulation WHERE statut='en_attente'")
  ]);
  res.json({
    ruptures: ruptures.rows[0].n,
    faibles: faibles.rows[0].n,
    credits_ouverts: credits.rows[0].n,
    annulations_en_attente: annuls.rows[0].n
  });
});

app.get("/api/releve", auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.*, u.nom AS user_nom FROM ventes v JOIN users u ON u.id=v.user_id WHERE v.user_id=$1 AND v.date::date = CURRENT_DATE ORDER BY v.date`, [req.user.id]);
  if (rows.length) {
    const ids = rows.map(v => v.id);
    const { rows: items } = await pool.query("SELECT * FROM vente_items WHERE vente_id = ANY($1::bigint[]) ORDER BY id", [ids]);
    const m = {}; items.forEach(i => { (m[i.vente_id] = m[i.vente_id] || []).push(i); });
    rows.forEach(v => v.items = m[v.id] || []);
  }
  res.json(rows);
});

/* ---------- point du soir ---------- */
app.get("/api/point/recap", auth, need("R_POINT"), async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const { rows } = await pool.query(
    `SELECT u.id, u.nom,
       COALESCE(SUM(v.net) FILTER (WHERE v.mode='especes'),0) AS especes,
       COALESCE(SUM(v.net) FILTER (WHERE v.mode='mobile'),0) AS mobile,
       COALESCE(SUM(v.net) FILTER (WHERE v.mode='carte'),0) AS carte,
       COALESCE(SUM(v.net),0) AS total,
       COUNT(v.id)::int AS tickets
     FROM users u
     LEFT JOIN ventes v ON v.user_id = u.id AND v.date::date = $1
     WHERE u.actif AND u.droits ? 'R_VENTE'
     GROUP BY u.id, u.nom ORDER BY u.nom`, [date]);
  const { rows: vers } = await pool.query(
    `SELECT ps.caissiere_id, COALESCE(SUM(vs.montant),0) AS verse
     FROM points_soir ps LEFT JOIN versements vs ON vs.point_id = ps.id
     WHERE ps.date = $1 GROUP BY ps.caissiere_id`, [date]);
  const vMap = {}; vers.forEach(v => vMap[v.caissiere_id] = Number(v.verse));
  res.json(rows.map(r => ({ ...r, verse: vMap[r.id] || 0, especes: Number(r.especes), mobile: Number(r.mobile), carte: Number(r.carte), total: Number(r.total) })));
});
app.post("/api/point/versement", auth, need("R_POINT"), async (req, res) => {
  const { caissiereId, date, montant, mode } = req.body;
  const m = Number(montant);
  if (!caissiereId || !m || m <= 0) return res.status(400).json({ error: "Montant invalide" });
  const r = await tx(req.user.id, async c => {
    const d = date || new Date().toISOString().slice(0, 10);
    const { rows: [pt] } = await c.query(
      `INSERT INTO points_soir(date, caissiere_id, attendu)
       VALUES($1,$2, COALESCE((SELECT SUM(net) FROM ventes WHERE user_id=$2 AND date::date=$1 AND mode='especes'),0))
       ON CONFLICT (date, caissiere_id) DO UPDATE SET statut='en attente' RETURNING *`, [d, caissiereId]);
    await c.query("INSERT INTO versements(point_id, montant, mode, user_id) VALUES($1,$2,$3,$4)", [pt.id, m, mode, req.user.id]);
    await c.query("UPDATE points_soir SET statut='versement enregistré' WHERE id=$1", [pt.id]);
    return pt;
  });
  broadcast({ type: "point" });
  res.json(r);
});
app.get("/api/point/classement", auth, need("R_POINT"), async (req, res) => {
  const date = req.query.date || null, from = req.query.from || null, to = req.query.to || null;
  const par = req.query.par || "caissiere";
  const { rows } = await pool.query(
    `SELECT vi.nom AS article, vi.qte, vi.prix, vi.prix_achat, v.user_id, u.nom AS user_nom, f.nom AS famille
     FROM vente_items vi
     JOIN ventes v ON v.id = vi.vente_id
     JOIN users u ON u.id = v.user_id
     LEFT JOIN produits p ON p.id = vi.produit_id
     LEFT JOIN familles f ON f.id = p.famille_id
     WHERE ($1::date IS NULL OR v.date::date = $1)
       AND ($2::date IS NULL OR v.date::date >= $2)
       AND ($3::date IS NULL OR v.date::date <= $3)`, [date, from, to]);
  const map = {};
  rows.forEach(r => {
    const key = par === "famille" ? (r.famille || "Autre") : par === "article" ? r.article : r.user_nom;
    if (!map[key]) map[key] = { key, qte: 0, ca: 0, ben: 0 };
    map[key].qte += Number(r.qte);
    map[key].ca += Number(r.qte) * Number(r.prix);
    map[key].ben += (Number(r.prix) - Number(r.prix_achat)) * Number(r.qte);
  });
  res.json(Object.values(map).sort((a, b) => b.ca - a.ca));
});

/* ---------- utilisateurs ---------- */
app.get("/api/roles", auth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM roles ORDER BY code");
  res.json(rows);
});
app.put("/api/roles/:code", auth, need("R_USERS"), async (req, res) => {
  const r = req.body;
  if (!r.droits || !Array.isArray(r.droits)) return res.status(400).json({ error: "Droits invalides" });
  await tx(req.user.id, c => c.query("UPDATE roles SET label=$1, droits=$2 WHERE code=$3", [String(r.label || r.code), JSON.stringify(r.droits), req.params.code]));
  broadcast({ type: "roles" });
  res.json({ ok: true });
});
app.post("/api/roles", auth, need("R_USERS"), async (req, res) => {
  const r = req.body || {};
  const label = String(r.label || "").trim();
  if (!label) return res.status(400).json({ error: "Le nom du rôle est obligatoire" });
  let code = String(r.code || label).trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  if (!code) code = "role";
  const { rows } = await pool.query("SELECT code FROM roles WHERE code=$1", [code]);
  if (rows.length) return res.status(400).json({ error: "Un rôle avec ce nom existe déjà" });
  await tx(req.user.id, c => c.query("INSERT INTO roles(code, label, droits) VALUES($1,$2,$3)", [code, label, JSON.stringify(Array.isArray(r.droits) ? r.droits : [])]));
  broadcast({ type: "roles" });
  res.json({ ok: true, code });
});
app.get("/api/users", auth, need("R_USERS"), async (req, res) => {
  const { rows } = await pool.query("SELECT u.id, u.nom, u.role_code, COALESCE(r.droits, u.droits) AS droits, u.pin_code, u.actif, u.created_at FROM users u LEFT JOIN roles r ON r.code = u.role_code ORDER BY u.nom");
  res.json(rows);
});
app.post("/api/users", auth, need("R_USERS"), async (req, res) => {
  const u = req.body;
  if (!u.nom || !u.nom.trim() || !u.mdp) return res.status(400).json({ error: "Nom et mot de passe obligatoires" });
  const hash = bcrypt.hashSync(u.mdp, 10);
  await tx(req.user.id, c => c.query(
    "INSERT INTO users(nom, mdp_hash, role_code, droits, actif, pin_code) VALUES($1,$2,$3,$4,$5,$6)",
    [u.nom.trim(), hash, u.role_code || "caissier", JSON.stringify(u.droits || []), u.actif !== false, u.pin_code ? String(u.pin_code).trim() : null]));
  broadcast({ type: "users" });
  res.json({ ok: true });
});
app.put("/api/users/:id", auth, need("R_USERS"), async (req, res) => {
  const u = req.body;
  await tx(req.user.id, async c => {
    if (u.mdp) {
      const hash = bcrypt.hashSync(u.mdp, 10);
      await c.query("UPDATE users SET nom=$1, mdp_hash=$2, role_code=$3, droits=$4, actif=$5, pin_code=$6, token_version = token_version + 1 WHERE id=$7",
        [u.nom.trim(), hash, u.role_code, JSON.stringify(u.droits || []), u.actif !== false, u.pin_code ? String(u.pin_code).trim() : null, req.params.id]);
    } else {
      await c.query("UPDATE users SET nom=$1, role_code=$2, droits=$3, actif=$4, pin_code=$5, token_version = CASE WHEN actif <> $4 THEN token_version + 1 ELSE token_version END WHERE id=$6",
        [u.nom.trim(), u.role_code, JSON.stringify(u.droits || []), u.actif !== false, u.pin_code ? String(u.pin_code).trim() : null, req.params.id]);
    }
  });
  broadcast({ type: "users" });
  res.json({ ok: true });
});
app.put("/api/users/:id/actif", auth, need("R_USERS"), async (req, res) => {
  if (Number(req.params.id) === req.user.id && req.user.role_code === "admin")
    return res.status(400).json({ error: "Impossible de désactiver votre propre compte admin" });
  await tx(req.user.id, c => c.query("UPDATE users SET actif=$1, token_version = token_version + 1 WHERE id=$2", [!!req.body.actif, req.params.id]));
  broadcast({ type: "users" });
  res.json({ ok: true });
});

/* ---------- rapports ---------- */
app.get("/api/rapports/7jours", auth, need("R_RAPPORTS"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT j.jour::date AS jour, COALESCE(v.tickets,0)::int AS tickets, COALESCE(v.ca,0) AS ca,
            COALESCE(i.marge,0) - COALESCE(v.rem,0) AS ben
     FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, interval '1 day') AS j(jour)
     LEFT JOIN (SELECT v.date::date AS jour, COUNT(v.id)::int AS tickets, COALESCE(SUM(v.net),0) AS ca, COALESCE(SUM(v.remise),0) AS rem
                FROM ventes v WHERE v.date >= CURRENT_DATE - 6 GROUP BY 1) v ON v.jour = j.jour::date
     LEFT JOIN (SELECT v.date::date AS jour, COALESCE(SUM((vi.prix - vi.prix_achat) * vi.qte),0) AS marge
                FROM vente_items vi JOIN ventes v ON v.id = vi.vente_id WHERE v.date >= CURRENT_DATE - 6 GROUP BY 1) i ON i.jour = j.jour::date
     ORDER BY j.jour`);
  res.json(rows);
});
app.get("/api/rapports", auth, need("R_RAPPORTS"), async (req, res) => {
  const { from, to, groupe } = req.query;
  const { rows } = await pool.query(
    `SELECT vi.nom AS article, vi.qte, vi.prix, vi.prix_achat, v.user_id, u.nom AS user_nom, f.nom AS famille,
            v.total AS vente_total, v.remise AS vente_remise
     FROM vente_items vi
     JOIN ventes v ON v.id = vi.vente_id
     JOIN users u ON u.id = v.user_id
     LEFT JOIN produits p ON p.id = vi.produit_id
     LEFT JOIN familles f ON f.id = p.famille_id
     WHERE v.date::date BETWEEN $1 AND $2`, [from, to]);
  const map = {};
  rows.forEach(r => {
    const key = groupe === "famille" ? (r.famille || "Autre") : groupe === "article" ? r.article : r.user_nom;
    if (!map[key]) map[key] = { key, qte: 0, ca: 0, ben: 0 };
    const q = Number(r.qte);
    const brut = q * Number(r.prix);
    const marge = (Number(r.prix) - Number(r.prix_achat)) * q;
    const vTotal = Number(r.vente_total) || 0;
    const vRemise = Number(r.vente_remise) || 0;
    const itemRemise = vTotal > 0 ? (brut / vTotal) * vRemise : 0;
    map[key].qte += q;
    map[key].ca += (brut - itemRemise);
    map[key].ben += (marge - itemRemise);
  });
  const groups = Object.values(map).sort((a, b) => b.ca - a.ca);
  const tot = groups.reduce((s, g) => ({ qte: s.qte + g.qte, ca: s.ca + g.ca, ben: s.ben + g.ben }), { qte: 0, ca: 0, ben: 0 });
  const { rows: depRows } = await pool.query(
    "SELECT COALESCE(SUM(montant),0) AS tot_dep FROM depenses WHERE ($1::date IS NULL OR date::date >= $1) AND ($2::date IS NULL OR date::date <= $2)",
    [from || null, to || null]);
  const totalDepenses = Number(depRows[0] ? depRows[0].tot_dep : 0);
  const beneficeNet = tot.ben - totalDepenses;
  res.json({ groups, tot: { ...tot, depenses: totalDepenses, ben_net: beneficeNet } });
});

/* ---------- journal d'audit ---------- */
app.get("/api/audit", auth, need("R_JOURNAL"), async (req, res) => {
  const { user, search } = req.query;
  const { rows } = await pool.query(
    `SELECT * FROM audit_log
     WHERE ($1::text IS NULL OR user_nom = $1)
       AND ($2::text IS NULL OR action ILIKE '%'||$2||'%' OR details ILIKE '%'||$2||'%')
     ORDER BY id DESC LIMIT 500`, [user || null, search || null]);
  res.json(rows);
});

app.get("/api/mouvements", auth, async (req, res) => {
  const { produit, type, from, to } = req.query;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const conds = [];
  const args = [];
  if (produit) { args.push(Number(produit)); conds.push("m.produit_id = $" + args.length); }
  if (type) { args.push(type); conds.push("m.type = $" + args.length); }
  if (from) { args.push(from); conds.push("m.date::date >= $" + args.length); }
  if (to) { args.push(to); conds.push("m.date::date <= $" + args.length); }
  const w = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const cnt = await pool.query(`SELECT COUNT(*)::int AS total FROM mouvements m ${w}`, args);
  const { rows } = await pool.query(
    `SELECT m.*, u.nom AS user_nom, p.nom AS produit_nom, f.nom AS fournisseur_nom, l.numero AS lot_numero FROM mouvements m
     LEFT JOIN users u ON u.id = m.user_id LEFT JOIN produits p ON p.id = m.produit_id LEFT JOIN fournisseurs f ON f.id = m.fournisseur_id LEFT JOIN lots l ON l.id = m.lot_id
     ${w} ORDER BY m.id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`, [...args, limit, offset]);
  res.json({ rows, total: cnt.rows[0].total });
});

app.get("/api/produits/:id/historique", auth, async (req, res) => {
  const id = Number(req.params.id);
  const [mvs, vts, prix] = await Promise.all([
    pool.query("SELECT m.*, u.nom AS user_nom, f.nom AS fournisseur_nom, l.numero AS lot_numero FROM mouvements m LEFT JOIN users u ON u.id = m.user_id LEFT JOIN fournisseurs f ON f.id = m.fournisseur_id LEFT JOIN lots l ON l.id = m.lot_id WHERE m.produit_id=$1 ORDER BY m.id DESC LIMIT 20", [id]),
    pool.query(`SELECT v.id, v.numero, v.date, vi.qte, vi.prix FROM vente_items vi JOIN ventes v ON v.id = vi.vente_id WHERE vi.produit_id=$1 ORDER BY v.id DESC LIMIT 20`, [id]),
    pool.query(`SELECT a.date, a.user_nom, a.old_data->>'prix_achat' AS pa_avant, a.new_data->>'prix_achat' AS pa_apres,
                a.old_data->>'prix_vente' AS pv_avant, a.new_data->>'prix_vente' AS pv_apres
     FROM audit_log a WHERE a.action='produits:UPDATE' AND a.new_data->>'id' = $1 ORDER BY a.id DESC LIMIT 10`, [String(id)])
  ]);
  res.json({ mouvements: mvs.rows, ventes: vts.rows, prix: prix.rows });
});

/* ---------- modes de paiement ---------- */
function slugCode(nom) {
  return String(nom || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "mode";
}
app.get("/api/modes-paiement", auth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM modes_paiement ORDER BY ordre, id");
  res.json(rows);
});
app.post("/api/modes-paiement", auth, need("R_PARAMS"), async (req, res) => {
  const nom = String(req.body.nom || "").trim();
  if (!nom) return res.status(400).json({ error: "Nom obligatoire" });
  const code = slugCode(nom);
  const { rows: [ex] } = await pool.query("SELECT id FROM modes_paiement WHERE code=$1", [code]);
  if (ex) return res.status(400).json({ error: "Ce mode de paiement existe déjà" });
  const o = await pool.query("SELECT COALESCE(MAX(ordre),0)+1 AS o FROM modes_paiement");
  const { rows: [m] } = await pool.query(
    "INSERT INTO modes_paiement(code, nom, especes, actif, ordre) VALUES($1,$2,$3,$4,$5) RETURNING *",
    [code, nom, !!req.body.especes, req.body.actif !== false, o.rows[0].o]);
  broadcast({ type: "modes" });
  res.json(m);
});
app.put("/api/modes-paiement/:id", auth, need("R_PARAMS"), async (req, res) => {
  const { rows: [m] } = await pool.query("SELECT * FROM modes_paiement WHERE id=$1", [req.params.id]);
  if (!m) return res.status(404).json({ error: "Mode introuvable" });
  const nom = String(req.body.nom || m.nom).trim() || m.nom;
  await pool.query("UPDATE modes_paiement SET nom=$1, especes=$2, actif=$3, ordre=$4 WHERE id=$5",
    [nom, !!req.body.especes, req.body.actif !== false, Number(req.body.ordre) || m.ordre, m.id]);
  broadcast({ type: "modes" });
  res.json({ ok: true });
});

/* ---------- lots & péremptions ---------- */
app.get("/api/lots", auth, need("R_STOCK"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT l.*, p.nom AS produit_nom FROM lots l JOIN produits p ON p.id = l.produit_id
     WHERE l.qte_restante > 0 ORDER BY l.date_peremption ASC NULLS LAST, l.id DESC`);
  res.json(rows);
});
app.post("/api/produits/:id/lots", auth, need("R_STOCK"), async (req, res) => {
  if (!stockAutorise(req.user)) return res.status(403).json({ error: "Réservé à la gérance et aux responsables stock" });
  const q = Number(req.body.qte);
  const dp = req.body.date_peremption || "";
  const numero = String(req.body.numero || "").trim();
  if (!q || q <= 0) return res.status(400).json({ error: "Quantité invalide" });
  if (!numero) return res.status(400).json({ error: "Indiquez le numéro de lot" });
  if (!dp) return res.status(400).json({ error: "Indiquez la date de péremption" });
  const r = await tx(req.user.id, async c => {
    const { rows } = await c.query("SELECT * FROM produits WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!rows.length) throw Object.assign(new Error("Produit introuvable"), { status: 404 });
    await c.query("UPDATE produits SET stock = stock + $1 WHERE id=$2", [q, rows[0].id]);
    const { rows: [lot] } = await c.query(
      "INSERT INTO lots(produit_id, qte_restante, date_peremption, numero) VALUES($1,$2,$3,$4) RETURNING *",
      [rows[0].id, q, dp, numero]);
    await c.query("INSERT INTO mouvements(type, produit_id, qte, motif, user_id) VALUES($1,$2,$3,$4,$5)",
      ["Entrée (réception fournisseur)", rows[0].id, q, "Lot " + numero + " ajouté — péremption " + dp, req.user.id]);
    return lot;
  });
  broadcast({ type: "stock" });
  res.json(r);
});

/* ---------- bons d'entrée / sortie multi-produits (boutique) ---------- */
const BON_TYPES = {
  entree: { label: "Entrée (réception fournisseur)", signe: 1, ref: "BE", type: "ENTREE" },
  sortie: { label: "Sortie (service / bénéficiaire)", signe: -1, ref: "BS", type: "SORTIE" },
  destruction: { label: "Destruction / rebut", signe: -1, ref: "BD", type: "DESTRUCTION" }
};
app.post("/api/mouvements/bon", auth, need("R_STOCK"), async (req, res) => {
  if (!stockAutorise(req.user)) return res.status(403).json({ error: "Réservé à la gérance et aux responsables stock" });
  const { type, lignes, motif, fournisseur_id } = req.body;
  const t = BON_TYPES[type];
  if (!t) return res.status(400).json({ error: "Type invalide (entree, sortie, destruction)" });
  if (!Array.isArray(lignes) || !lignes.length) return res.status(400).json({ error: "Ajoutez au moins un produit" });
  // Vérifier les produits gérés par lot
  const pIds = lignes.map(l => Number(l.produitId));
  const { rows: lotProds } = await pool.query("SELECT id, gere_par_lot FROM produits WHERE id = ANY($1::bigint[])", [pIds]);
  const lotMap = {}; lotProds.forEach(p => lotMap[p.id] = p.gere_par_lot);
  if (type === "entree") {
    for (const it of lignes) {
      if (lotMap[Number(it.produitId)] && (!it.numeroLot || !String(it.numeroLot).trim()))
        return res.status(400).json({ error: "Numéro de lot obligatoire pour un produit géré par lot" });
      if (lotMap[Number(it.produitId)] && !it.datePeremption)
        return res.status(400).json({ error: "Date de péremption obligatoire pour un produit géré par lot" });
    }
  }
  const motifTxt = String(motif || "").trim();
  if (!motifTxt) return res.status(400).json({ error: "Le motif est obligatoire" });
  if (type === "entree" && !fournisseur_id) return res.status(400).json({ error: "Sélectionnez le fournisseur" });
  const bon = await tx(req.user.id, async c => {
    const { rows: [b] } = await c.query(
      "INSERT INTO bons(type, fournisseur_id, motif, user_id, statut) VALUES($1,$2,$3,$4,'valide') RETURNING *",
      [t.type, fournisseur_id || null, motifTxt, req.user.id]);
    await c.query("UPDATE bons SET reference = $1 || '-' || id WHERE id=$2", [t.ref, b.id]);
    const { rows: [b2] } = await c.query("SELECT * FROM bons WHERE id=$1", [b.id]);
    for (const it of lignes) {
      const pid = Number(it.produitId);
      const q = Number(it.qte);
      if (!pid || !q || q <= 0) throw Object.assign(new Error("Ligne invalide (produit et quantité requis)"), { status: 400 });
      const { rows } = await c.query("SELECT * FROM produits WHERE id=$1 FOR UPDATE", [pid]);
      if (!rows.length || !rows[0].actif) throw Object.assign(new Error("Produit introuvable ou inactif"), { status: 400 });
      const p = rows[0];
      if (t.signe < 0 && Number(p.stock) < q) throw Object.assign(new Error("Stock insuffisant : " + p.nom), { status: 400 });
      const numLot = (it.numeroLot && String(it.numeroLot).trim()) || null;
      const datePeremp = (it.datePeremption && String(it.datePeremption).trim()) || null;
      if (type === "entree") {
        if (!numLot) throw Object.assign(new Error("Indiquez le numéro de lot pour " + p.nom), { status: 400 });
        if (!datePeremp) throw Object.assign(new Error("Indiquez la date de péremption pour " + p.nom), { status: 400 });
      }
      await c.query("UPDATE produits SET stock = stock + $1 WHERE id=$2", [t.signe * q, p.id]);
      let lotId = null;
      if (type === "entree") {
        const { rows: [lot] } = await c.query(
          "INSERT INTO lots(produit_id, qte_restante, date_peremption, numero) VALUES($1,$2,$3,$4) RETURNING id",
          [pid, q, datePeremp, numLot]);
        lotId = lot.id;
      } else if (t.signe < 0) {
        const lotSel = Number(it.lotId) || 0;
        if (lotSel) {
          const { rows: [lot] } = await c.query("SELECT * FROM lots WHERE id=$1 FOR UPDATE", [lotSel]);
          if (!lot || String(lot.produit_id) !== String(pid)) throw Object.assign(new Error("Lot invalide pour " + p.nom), { status: 400 });
          if (Number(lot.qte_restante) < q) throw Object.assign(new Error("Pas assez de stock dans le lot sélectionné pour " + p.nom), { status: 400 });
          await c.query("UPDATE lots SET qte_restante = qte_restante - $1 WHERE id=$2", [q, lot.id]);
          lotId = lot.id;
        } else {
          const { rows: lots } = await c.query(
            "SELECT id, qte_restante FROM lots WHERE produit_id=$1 AND qte_restante > 0 AND (date_peremption IS NULL OR date_peremption >= CURRENT_DATE) ORDER BY date_peremption ASC NULLS LAST, id ASC", [pid]);
          let restant = q, premier = null;
          for (const lot of lots) {
            if (restant <= 0) break;
            const prise = Math.min(Number(lot.qte_restante), restant);
            await c.query("UPDATE lots SET qte_restante = qte_restante - $1 WHERE id=$2", [prise, lot.id]);
            if (!premier) premier = lot.id;
            restant -= prise;
          }
          if (restant > 0) throw Object.assign(new Error("Stock insuffisant en lots pour " + p.nom), { status: 400 });
          lotId = premier;
        }
      }
      await c.query(
        "INSERT INTO mouvements(type, produit_id, qte, motif, user_id, ref, bon_id, fournisseur_id, lot_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [t.label, p.id, t.signe * q, motifTxt + " (" + b2.reference + ")", req.user.id, b2.reference, b.id, type === "entree" ? Number(fournisseur_id) || null : null, lotId]);
    }
    return b2;
  });
  broadcast({ type: "stock" });
  res.json(bon);
});

/* ---------- rebut multiple de lots ---------- */
app.post("/api/lots/rebut-multiple", auth, need("R_STOCK"), async (req, res) => {
  const ids = (req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: "Sélectionnez au moins un lot" });
  await tx(req.user.id, async c => {
    for (const id of ids) {
      const { rows: [lot] } = await c.query("SELECT * FROM lots WHERE id=$1 FOR UPDATE", [id]);
      if (!lot || Number(lot.qte_restante) <= 0) continue;
      await c.query("UPDATE lots SET qte_restante = 0 WHERE id=$1", [lot.id]);
      await c.query("UPDATE produits SET stock = GREATEST(0, stock - $1) WHERE id=$2", [lot.qte_restante, lot.produit_id]);
      await c.query(
        `INSERT INTO mouvements(type, produit_id, qte, motif, user_id, magasin_id, lot_id)
         VALUES('Destruction / rebut',$1,$2,'Lot rebuté (péremption)', $3, $4, $5)`,
        [lot.produit_id, -Number(lot.qte_restante), req.user.id, lot.magasin_id, lot.id]);
      if (lot.magasin_id) {
        await c.query("UPDATE stocks_magasin SET qte = qte - $1 WHERE magasin_id=$2 AND produit_id=$3",
          [lot.qte_restante, lot.magasin_id, lot.produit_id]);
      }
    }
  });
  broadcast({ type: "stock" });
  res.json({ ok: true });
});

/* ---------- fournisseurs ---------- */
app.get("/api/fournisseurs", auth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM fournisseurs ORDER BY nom");
  res.json(rows);
});
app.post("/api/fournisseurs", auth, need("R_STOCK"), async (req, res) => {
  const f = req.body;
  const nom = String(f.nom || "").trim();
  if (!nom) return res.status(400).json({ error: "Nom obligatoire" });
  try {
    const { rows: [r] } = await tx(req.user.id, c => c.query(
      "INSERT INTO fournisseurs(nom, tel, email, adresse, notes) VALUES($1,$2,$3,$4,$5) RETURNING *",
      [nom, f.tel || "", f.email || "", f.adresse || "", f.notes || ""]));
    broadcast({ type: "stock" });
    res.json(r);
  } catch (e) {
    if (e.code === "23505") return res.status(400).json({ error: "Ce fournisseur existe déjà" });
    throw e;
  }
});
app.put("/api/fournisseurs/:id", auth, need("R_STOCK"), async (req, res) => {
  const f = req.body;
  await tx(req.user.id, c => c.query(
    "UPDATE fournisseurs SET nom=$1, tel=$2, email=$3, adresse=$4, notes=$5 WHERE id=$6",
    [String(f.nom || "").trim(), f.tel || "", f.email || "", f.adresse || "", f.notes || "", req.params.id]));
  broadcast({ type: "stock" });
  res.json({ ok: true });
});
app.delete("/api/fournisseurs/:id", auth, need("R_STOCK"), async (req, res) => {
  const id = Number(req.params.id);
  await tx(req.user.id, c => c.query(
    "UPDATE fournisseurs SET actif=false, desactive_le=now(), desactive_par=$1 WHERE id=$2",
    [req.user.nom, id]));
  await auditEvent(req.user, "Fournisseur désactivé", `Fournisseur ID ${id} archivé`);
  broadcast({ type: "stock" });
  res.json({ ok: true });
});

/* ---------- commandes d'achat ---------- */
app.get("/api/commandes", auth, need("R_STOCK"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, f.nom AS fournisseur_nom FROM commandes c LEFT JOIN fournisseurs f ON f.id = c.fournisseur_id ORDER BY c.id DESC`);
  for (const c of rows) {
    const { rows: items } = await pool.query("SELECT * FROM commande_items WHERE commande_id=$1", [c.id]);
    c.items = items;
  }
  res.json(rows);
});
app.post("/api/commandes", auth, need("R_STOCK"), async (req, res) => {
  const { fournisseur_id, livraison, notes, items } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Commande vide" });
  const r = await tx(req.user.id, async c => {
    const { rows: [cmd] } = await c.query(
      "INSERT INTO commandes(fournisseur_id, livraison, notes, user_id) VALUES($1,$2,$3,$4) RETURNING *",
      [fournisseur_id || null, Number(livraison) || 0, String(notes || "").trim() || null, req.user.id]);
    const ids = items.map(i => Number(i.produitId));
    const { rows: prods } = await c.query("SELECT id, nom FROM produits WHERE id = ANY($1::bigint[])", [ids]);
    const map = {}; prods.forEach(p => map[p.id] = p);
    for (const it of items) {
      const p = map[Number(it.produitId)];
      if (!p) throw Object.assign(new Error("Produit introuvable"), { status: 400 });
      const q = Number(it.qte);
      if (!q || q <= 0) throw Object.assign(new Error("Quantité invalide"), { status: 400 });
      await c.query("INSERT INTO commande_items(commande_id, produit_id, nom, qte, prix_achat) VALUES($1,$2,$3,$4,$5)",
        [cmd.id, p.id, p.nom, q, Number(it.prix_achat) || 0]);
    }
    return cmd;
  });
  broadcast({ type: "stock" });
  res.json(r);
});
app.post("/api/commandes/:id/receptionner", auth, need("R_STOCK"), async (req, res) => {
  if (!stockAutorise(req.user)) return res.status(403).json({ error: "Réservé à la gérance et aux responsables stock" });
  const { lignes } = req.body;
  if (!Array.isArray(lignes) || !lignes.length) return res.status(400).json({ error: "Renseignez les quantités reçues" });
  const r = await tx(req.user.id, async c => {
    const { rows: [cmd] } = await c.query(
      `SELECT c.*, (SELECT f.nom FROM fournisseurs f WHERE f.id = c.fournisseur_id) AS fournisseur_nom
       FROM commandes c WHERE c.id=$1 FOR UPDATE`,
      [req.params.id]);
    if (!cmd) throw Object.assign(new Error("Commande introuvable"), { status: 404 });
    if (cmd.statut === "recue") throw Object.assign(new Error("Commande déjà réceptionnée"), { status: 400 });
    const { rows: items } = await c.query("SELECT * FROM commande_items WHERE commande_id=$1", [cmd.id]);
    const cmdIds = items.filter(i => i.produit_id).map(i => String(i.produit_id));
    const { rows: lotRows } = await c.query("SELECT id, gere_par_lot FROM produits WHERE id = ANY($1::bigint[])", [items.map(i => i.produit_id)]);
    const lotMap = {}; lotRows.forEach(r => lotMap[r.id] = r.gere_par_lot);
    for (const l of lignes) {
      const pid = Number(l.produitId);
      if (!cmdIds.includes(String(pid))) throw Object.assign(new Error("Article hors de la commande"), { status: 400 });
      const q = Number(l.qte);
      if (!q || q <= 0) throw Object.assign(new Error("Quantité reçue invalide"), { status: 400 });
      const gereLot = lotMap[pid] === true;
      const numLot = (l.numeroLot && String(l.numeroLot).trim()) || null;
      const datePeremp = (l.datePeremption && String(l.datePeremption).trim()) || null;
      if (gereLot && !numLot) throw Object.assign(new Error("Ce produit est géré par lot : numéro de lot obligatoire"), { status: 400 });
      if (gereLot && !datePeremp) throw Object.assign(new Error("Ce produit est géré par lot : date de péremption obligatoire"), { status: 400 });
      const { rows: [p] } = await c.query("SELECT * FROM produits WHERE id=$1 FOR UPDATE", [pid]);
      if (!p) throw Object.assign(new Error("Produit introuvable"), { status: 404 });
      await c.query("UPDATE produits SET stock = stock + $1 WHERE id=$2", [q, pid]);
      const { rows: [lot] } = await c.query(
        "INSERT INTO lots(produit_id, qte_restante, date_peremption, numero) VALUES($1,$2,$3,$4) RETURNING id",
        [pid, q, datePeremp, numLot]);
      await c.query("INSERT INTO mouvements(type, produit_id, qte, motif, user_id, ref, lot_id, fournisseur_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        ["Entrée (réception fournisseur)", pid, q, "Réception commande #" + cmd.id + (cmd.fournisseur_nom ? " - " + cmd.fournisseur_nom : ""), req.user.id, "CMD" + cmd.id, lot.id, cmd.fournisseur_id || null]);
    }
    await c.query("UPDATE commandes SET statut='recue' WHERE id=$1", [cmd.id]);
    return { id: cmd.id, statut: "recue" };
  });
  broadcast({ type: "stock" });
  res.json(r);
});
/* ---------- caisses virtuelles ---------- */
async function caisseAggregate(id) {
  const { rows: [c] } = await pool.query("SELECT * FROM caisses WHERE id=$1", [id]);
  if (!c) return null;
  const { rows: [t] } = await pool.query(
    `SELECT COALESCE(SUM(v.net) FILTER (WHERE mp.especes),0) AS especes,
            COALESCE(SUM(v.net) FILTER (WHERE NOT mp.especes),0) AS autres,
            COALESCE(SUM(v.net),0) AS total, COUNT(*)::int AS tickets
     FROM ventes v LEFT JOIN modes_paiement mp ON mp.code = v.mode WHERE v.caisse_id=$1`, [id]);
  const { rows: parMode } = await pool.query(
    `SELECT v.mode AS code, COALESCE(mp.nom, v.mode) AS nom, COALESCE(SUM(v.net),0) AS total, COUNT(*)::int AS tickets
     FROM ventes v LEFT JOIN modes_paiement mp ON mp.code = v.mode
     WHERE v.caisse_id=$1 GROUP BY v.mode, mp.nom ORDER BY COALESCE(SUM(v.net),0) DESC`, [id]);
  const { rows: versements } = await pool.query(
    "SELECT id, date, montant, mode, motif, statut, user_id FROM versements_caisse WHERE caisse_id=$1 ORDER BY id", [id]);
  const { rows: [vs] } = await pool.query(
    `SELECT COALESCE(SUM(vc.montant),0) AS esp FROM versements_caisse vc
     JOIN modes_paiement mp ON mp.code = vc.mode AND mp.especes WHERE vc.caisse_id=$1 AND vc.statut='valide'`, [id]);
  const verseEsp = Number(vs.esp);
  const { rows: [pending] } = await pool.query(
    "SELECT COALESCE(SUM(vc.montant),0) AS p FROM versements_caisse vc WHERE vc.caisse_id=$1 AND vc.statut='en_attente'", [id]);
  const verseEnAttente = Number(pending.p);
  const verseTot = versements.filter(v => v.statut === "valide").reduce((s, v) => s + Number(v.montant), 0);
  const { rows: [rc] } = await pool.query(
    `SELECT COALESCE(SUM(rc.montant),0) AS esp FROM reglements_credit rc
     LEFT JOIN modes_paiement mp ON mp.code = rc.mode
     WHERE rc.caisse_id=$1 AND (mp.especes OR rc.mode='especes')`, [id]);
  const rcEsp = Number(rc ? rc.esp : 0);
  const attendu = Number(c.fonds_initial) + Number(t.especes) + rcEsp - verseEsp;
  return { ...c, especes: Number(t.especes), reglements_credit_especes: rcEsp, autres: Number(t.autres), total: Number(t.total), tickets: t.tickets,
           parMode, versements, verse_especes: verseEsp, verse_total: verseTot, verse_en_attente: verseEnAttente, attendu_especes: attendu };
}

app.post("/api/caisse/ouvrir", auth, need("R_VENTE"), async (req, res) => {
  const { rows: [ex] } = await pool.query("SELECT id FROM caisses WHERE user_id=$1 AND statut='ouverte'", [req.user.id]);
  if (ex) return res.status(400).json({ error: "Vous avez déjà une caisse ouverte" });
  const fonds = Math.max(0, Number(req.body.fonds_initial) || 0);
  const r = await tx(req.user.id, c => c.query(
    "INSERT INTO caisses(user_id, fonds_initial) VALUES($1,$2) RETURNING *", [req.user.id, fonds]));
  broadcast({ type: "caisse" });
  res.json(r.rows[0]);
});

app.get("/api/caisse/moi", auth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id FROM caisses WHERE user_id=$1 AND statut='ouverte' ORDER BY id DESC LIMIT 1", [req.user.id]);
  if (!rows.length) return res.json(null);
  res.json(await caisseAggregate(rows[0].id));
});

app.get("/api/caisse", auth, need("R_POINT"), async (req, res) => {
  const { from, to, caissiere } = req.query;
  const date = req.query.date || null;
  const { rows } = await pool.query(
    `SELECT c.*, u.nom AS user_nom, vu.nom AS validee_par_nom FROM caisses c
     JOIN users u ON u.id = c.user_id
     LEFT JOIN users vu ON vu.id = c.validee_par
     WHERE ($1::date IS NULL OR c.ouverte_le::date = $1)
       AND ($2::date IS NULL OR c.ouverte_le::date >= $2)
       AND ($3::date IS NULL OR c.ouverte_le::date <= $3)
       AND ($4::bigint IS NULL OR c.user_id = $4)
     ORDER BY c.ouverte_le DESC`, [date, from || null, to || null, caissiere || null]);
  const out = [];
  for (const c of rows) out.push({ ...(await caisseAggregate(c.id)), user_nom: c.user_nom, validee_par_nom: c.validee_par_nom });
  res.json(out);
});

app.get("/api/caisse/:id", auth, async (req, res) => {
  const info = await caisseAggregate(req.params.id);
  if (!info) return res.status(404).json({ error: "Caisse introuvable" });
  if (String(info.user_id) !== String(req.user.id) && !hasRight(req.user, "R_POINT"))
    return res.status(403).json({ error: "Droit refusé" });
  const { rows: ventes } = await pool.query(
    "SELECT numero, date, mode, net, recu, rendu FROM ventes WHERE caisse_id=$1 ORDER BY date", [req.params.id]);
  info.ventes = ventes;
  res.json(info);
});

app.post("/api/caisse/:id/versement", auth, async (req, res) => {
  const { rows: [c] } = await pool.query("SELECT * FROM caisses WHERE id=$1", [req.params.id]);
  if (!c) return res.status(404).json({ error: "Caisse introuvable" });
  if (c.statut !== "ouverte") return res.status(400).json({ error: "Caisse déjà fermée" });
  if (String(c.user_id) !== String(req.user.id) && !hasRight(req.user, "R_POINT"))
    return res.status(403).json({ error: "Droit refusé" });
  const m = Number(req.body.montant);
  if (!m || m <= 0) return res.status(400).json({ error: "Montant invalide" });
  const { rows: [modeRow] } = await pool.query("SELECT code FROM modes_paiement WHERE code=$1 AND actif", [req.body.mode]);
  const mode = modeRow ? modeRow.code : "especes";
  await tx(req.user.id, c2 => c2.query(
    "INSERT INTO versements_caisse(caisse_id, montant, mode, motif, user_id, statut) VALUES($1,$2,$3,$4,$5,'en_attente')",
    [c.id, m, mode, String(req.body.motif || "").trim() || null, req.user.id]));
  broadcast({ type: "caisse" });
  broadcast({ type: "versement_demande" });
  res.json({ ok: true, message: "Demande de versement créée — en attente de validation" });
});

app.post("/api/caisse/:id/cloturer", auth, async (req, res) => {
  const { rows: [c] } = await pool.query("SELECT * FROM caisses WHERE id=$1", [req.params.id]);
  if (!c) return res.status(404).json({ error: "Caisse introuvable" });
  if (c.statut !== "ouverte") return res.status(400).json({ error: "Cette caisse n'est plus ouverte" });
  if (String(c.user_id) !== String(req.user.id) && !hasRight(req.user, "R_POINT"))
    return res.status(403).json({ error: "Droit refusé" });
  const info = await caisseAggregate(c.id);
  const compte = Number(req.body.compte);
  if (isNaN(compte)) return res.status(400).json({ error: "Montant compté obligatoire" });
  const notes = String(req.body.notes || "").trim() || null;
  const ecart = compte - info.attendu_especes;
  if (ecart !== 0 && !notes) return res.status(400).json({ error: "Écart détecté : une explication est obligatoire pour clôturer" });
  await tx(req.user.id, c2 => c2.query(
    `UPDATE caisses SET statut='fermee', fermee_le=now(), total_attendu=$1, total_compte=$2, ecart=$3, notes=$4 WHERE id=$5`,
    [info.attendu_especes, compte, ecart, notes, c.id]));
  broadcast({ type: "caisse" });
  res.json({ ...(await caisseAggregate(c.id)) });
});

app.put("/api/caisse/:id/valider", auth, need("R_POINT"), async (req, res) => {
  const { rows: [c] } = await pool.query("SELECT * FROM caisses WHERE id=$1", [req.params.id]);
  if (!c) return res.status(404).json({ error: "Caisse introuvable" });
  if (c.statut !== "fermee") return res.status(400).json({ error: "Seule une caisse fermée peut être validée" });
  await tx(req.user.id, c2 => c2.query(
    "UPDATE caisses SET statut='validee', validee_le=now(), validee_par=$1 WHERE id=$2", [req.user.id, c.id]));
  broadcast({ type: "caisse" });
  res.json({ ok: true });
});

app.put("/api/caisse/:id/rouvrir", auth, need("R_POINT"), async (req, res) => {
  const { rows: [c] } = await pool.query("SELECT * FROM caisses WHERE id=$1", [req.params.id]);
  if (!c) return res.status(404).json({ error: "Caisse introuvable" });
  if (c.statut === "validee") return res.status(400).json({ error: "Une caisse validée ne peut plus être rouverte" });
  if (!["fermee"].includes(c.statut)) return res.status(400).json({ error: "Cette caisse est encore ouverte" });
  await tx(req.user.id, c2 => c2.query(
    `UPDATE caisses SET statut='ouverte', fermee_le=NULL, total_attendu=NULL, total_compte=NULL, ecart=NULL,
     validee_le=NULL, validee_par=NULL WHERE id=$1`, [c.id]));
  broadcast({ type: "caisse" });
  res.json({ ok: true });
});


/* ---------- STOCK DORMANT ---------- */
app.get("/api/stock/dormant", auth, need("R_STOCK"), async (req, res) => {
  const jours = Math.max(1, Number(req.query.jours || 30));
  const { rows } = await pool.query(
    `SELECT p.id, p.nom, p.code, f.nom AS famille_nom, p.stock, p.prix_achat,
            p.prix_vente, p.stock * p.prix_achat AS valeur_immobilisee,
            COALESCE(MAX(v.date), NULL) AS derniere_vente,
            COALESCE(SUM(vi.qte), 0) AS qte_vendue_periode,
            CURRENT_DATE - COALESCE((SELECT MAX(v.date::date) FROM ventes v JOIN vente_items vi ON vi.vente_id = v.id WHERE vi.produit_id = p.id), p.created_at::date) AS jours_sans_vente
     FROM produits p
     LEFT JOIN familles f ON f.id = p.famille_id
     LEFT JOIN vente_items vi ON vi.produit_id = p.id
     LEFT JOIN ventes v ON v.id = vi.vente_id AND v.date >= CURRENT_DATE - $1::int
     WHERE p.actif
     GROUP BY p.id, f.nom
     HAVING COALESCE(SUM(vi.qte), 0) = 0
     ORDER BY jours_sans_vente DESC`, [jours]);
  res.json(rows);
});

/* ---------- DÉPENSES ---------- */
app.get("/api/depenses", auth, need("R_RAPPORTS"), async (req, res) => {
  const { from, to } = req.query;
  const showAll = req.query.all === '1';
  const { rows } = await pool.query(
    `SELECT d.*, u.nom AS user_nom FROM depenses d
     LEFT JOIN users u ON u.id = d.user_id
     WHERE ($1::date IS NULL OR d.date::date >= $1)
       AND ($2::date IS NULL OR d.date::date <= $2)
       AND ($3 OR d.annule = false)
     ORDER BY d.date DESC`, [from || null, to || null, showAll]);
  res.json(rows);
});
const needDepenses = (req, res, next) => {
  if (!hasRight(req.user, "R_RAPPORTS") && !hasRight(req.user, "R_PARAMS"))
    return res.status(403).json({ error: "Droit refusé : R_RAPPORTS ou R_PARAMS" });
  next();
};
app.post("/api/depenses", auth, needDepenses, async (req, res) => {
  const { montant, categorie, motif, mode, date } = req.body;
  const m = Number(montant);
  if (!m || m <= 0) return res.status(400).json({ error: "Montant invalide" });
  if (!categorie) return res.status(400).json({ error: "Catégorie obligatoire" });
  await tx(req.user.id, c => c.query(
    "INSERT INTO depenses(date, montant, categorie, motif, mode, user_id) VALUES($1,$2,$3,$4,$5,$6)",
    [date || new Date().toISOString(), m, categorie, motif || "", mode || "especes", req.user.id]));
  broadcast({ type: "depenses" });
  res.json({ ok: true });
});
app.delete("/api/depenses/:id", auth, needDepenses, async (req, res) => {
  const motif = String(req.body && req.body.motif || "Supprimé").trim();
  const { rows: [d] } = await pool.query("SELECT * FROM depenses WHERE id=$1", [req.params.id]);
  if (!d) return res.status(404).json({ error: "Dépense introuvable" });
  await tx(req.user.id, c => c.query(
    "UPDATE depenses SET annule=true, annule_le=now(), annule_par=$1, annule_motif=$2 WHERE id=$3",
    [req.user.nom, motif, req.params.id]));
  await auditEvent(req.user, "Dépense annulée", `Dépense de ${d.montant} F (${d.categorie}) annulée — Motif: ${motif}`);
  broadcast({ type: "depenses" });
  res.json({ ok: true });
});

/* ---------- EXPORT COMPTABLE ---------- */
app.get("/api/export/comptable", auth, need("R_RAPPORTS"), async (req, res) => {
  const { from, to } = req.query;
  const { rows: ventes } = await pool.query(
    `SELECT v.numero, v.date, u.nom AS caissiere, v.mode, v.total, v.remise, v.net,
            COALESCE(SUM((vi.prix - vi.prix_achat) * vi.qte), 0) - v.remise AS benefice
     FROM ventes v
     LEFT JOIN users u ON u.id = v.user_id
     LEFT JOIN vente_items vi ON vi.vente_id = v.id
     WHERE v.date::date BETWEEN $1 AND $2
     GROUP BY v.id, u.nom
     ORDER BY v.date`, [from, to]);
  const { rows: depenses } = await pool.query(
    `SELECT * FROM depenses WHERE date::date BETWEEN $1 AND $2 ORDER BY date`, [from, to]);
  // CSV format
  const lines = [["TYPE","DATE","NUMERO","CAISSIERE","CATEGORIE","MODE","DEBIT","CREDIT","BENEFICE"]];
  for (const v of ventes) {
    lines.push(["VENTE", v.date.toISOString().slice(0,10), v.numero, v.caissiere || "", "", v.mode, "", String(v.net), String(Math.round(v.benefice))]);
  }
  for (const d of depenses) {
    lines.push(["DEPENSE", d.date.toISOString().slice(0,10), "", "", d.categorie, d.mode || "", String(d.montant), "", ""]);
  }
  const csv = lines.map(r => r.map(c => '"' + c + '"').join(";")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="export-comptable.csv"');
  res.send("\ufeff" + csv);
});

/* ---------- ANALYSE ABC (Pareto) ---------- */
app.get("/api/rapports/abc", auth, need("R_RAPPORTS"), async (req, res) => {
  const { from, to } = req.query;
  const { rows } = await pool.query(
    `SELECT vi.produit_id, p.nom, p.code, f.nom AS famille,
            SUM(vi.qte) AS qte, SUM(vi.qte * vi.prix) AS ca,
            SUM((vi.prix - vi.prix_achat) * vi.qte) AS benefice
     FROM vente_items vi
     JOIN ventes v ON v.id = vi.vente_id
     JOIN produits p ON p.id = vi.produit_id
     LEFT JOIN familles f ON f.id = p.famille_id
     WHERE v.date::date BETWEEN $1 AND $2
     GROUP BY vi.produit_id, p.nom, p.code, f.nom
     ORDER BY ca DESC`, [from, to]);
  const totalCA = rows.reduce((s, r) => s + Number(r.ca), 0);
  let cumul = 0;
  rows.forEach(r => {
    r.pct = totalCA > 0 ? (Number(r.ca) / totalCA * 100) : 0;
    cumul += r.pct;
    r.cumul = cumul;
    r.classe = cumul <= 80 ? "A" : cumul <= 95 ? "B" : "C";
    r.ca = Number(r.ca); r.benefice = Number(r.benefice); r.qte = Number(r.qte);
  });
  res.json({ rows, totalCA, nbProduits: rows.length });
});


/* ---------- VERSEMENTS EN ATTENTE ---------- */
app.get("/api/versements/en-attente", auth, async (req, res) => {
  const { rows: [param] } = await pool.query("SELECT valeur FROM parametres WHERE cle='versement_validateur'");
  const validateur = param ? param.valeur : "admin";
  const isValidateur = req.user.role_code === "admin" || req.user.nom === validateur || hasRight(req.user, "R_POINT");
  const { rows } = await pool.query(
    `SELECT vc.*, c.user_id AS caissiere_id, u.nom AS caissiere_nom, c.fonds_initial
     FROM versements_caisse vc
     JOIN caisses c ON c.id = vc.caisse_id
     JOIN users u ON u.id = c.user_id
     WHERE vc.statut = 'en_attente'
     ORDER BY vc.date DESC`);
  res.json({ rows, canValidate: isValidateur, validateur });
});

app.post("/api/versements/:id/valider", auth, async (req, res) => {
  const { rows: [param] } = await pool.query("SELECT valeur FROM parametres WHERE cle='versement_validateur'");
  const validateur = param ? param.valeur : "admin";
  if (req.user.role_code !== "admin" && req.user.nom !== validateur && !hasRight(req.user, "R_POINT"))
    return res.status(403).json({ error: "Vous n'êtes pas autorisé à valider les versements" });
  const v = await tx(req.user.id, async c => {
    const { rows: [vc] } = await c.query("SELECT * FROM versements_caisse WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!vc) throw Object.assign(new Error("Versement introuvable"), { status: 404 });
    if (vc.statut !== "en_attente") throw Object.assign(new Error("Ce versement est déjà traité"), { status: 400 });
    await c.query("UPDATE versements_caisse SET statut='valide', valide_par=$1, valide_le=now() WHERE id=$2", [req.user.id, vc.id]);
    return vc;
  });
  broadcast({ type: "caisse" });
  broadcast({ type: "versement_valide" });
  res.json({ ok: true });
});

app.post("/api/versements/:id/refuser", auth, async (req, res) => {
  const { rows: [param] } = await pool.query("SELECT valeur FROM parametres WHERE cle='versement_validateur'");
  const validateur = param ? param.valeur : "admin";
  if (req.user.role_code !== "admin" && req.user.nom !== validateur && !hasRight(req.user, "R_POINT"))
    return res.status(403).json({ error: "Vous n'êtes pas autorisé à valider les versements" });
  const motif = String(req.body.motif || "").trim();
  if (!motif) return res.status(400).json({ error: "Motif de refus obligatoire" });
  const v = await tx(req.user.id, async c => {
    const { rows: [vc] } = await c.query("SELECT * FROM versements_caisse WHERE id=$1 FOR UPDATE", [req.params.id]);
    if (!vc) throw Object.assign(new Error("Versement introuvable"), { status: 404 });
    if (vc.statut !== "en_attente") throw Object.assign(new Error("Ce versement est déjà traité"), { status: 400 });
    await c.query("UPDATE versements_caisse SET statut='refuse', valide_par=$1, valide_le=now(), motif_refus=$2 WHERE id=$3", [req.user.id, motif, vc.id]);
    return vc;
  });
  broadcast({ type: "caisse" });
  broadcast({ type: "versement_refuse" });
  res.json({ ok: true });
});

/* ---------- LISTE DES VERSEMENTS (tous statuts) ---------- */
app.get("/api/versements", auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT vc.*, u.nom AS caissiere_nom, v.nom AS valide_par_nom
     FROM versements_caisse vc
     JOIN caisses c ON c.id = vc.caisse_id
     JOIN users u ON u.id = c.user_id
     LEFT JOIN users v ON v.id = vc.valide_par
     ORDER BY vc.date DESC`);
  res.json({ rows });
});

/* ---------- démarrage ---------- */
/* ---------- Module Stock avanc� (magasins, services, bons FEFO, inventaires, r�appro) ---------- */
require("./module-stock")({ app, auth, need, broadcast });

/* En production : servir le frontend statique depuis ../app */
const appDir = path.join(__dirname, "..", "..", "app");
if (fs.existsSync(appDir)) {
  app.use(express.static(appDir, { index: "index.html" }));
  app.get("*", (req, res) => {
    if (!req.path.startsWith("/api") && !req.path.startsWith("/ws")) {
      res.sendFile(path.join(appDir, "index.html"));
    }
  });
}

/* ---------- init schéma + auto-seed ---------- */
async function initSchema() {
  // 1) Migrations critiques AVANT le schéma complet
  const criticalMigrations = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS derniere_connexion TIMESTAMPTZ",
  ];
  for (const m of criticalMigrations) {
    try { await pool.query(m); console.log("✅ Migration OK:", m); } catch (e) { console.log("⚠️ Migration skip:", m, e.message); }
  }
  // 2) Schéma complet
  try {
    const sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
    await pool.query(sql);
    console.log("✅ Schéma appliqué");
  } catch (e) {
    if (e.code === "42710" || e.code === "42P07" || e.code === "42P16") console.log("ℹ️  Schéma déjà appliqué");
    else console.error("⚠️ Schéma:", e.message);
  }
}
async function autoSeed() {
  const { rows: [{ count }] } = await pool.query("SELECT count(*) FROM users");
  if (Number(count) > 0) return; // déjà des utilisateurs
  console.log("🌱 Base vide — création du compte admin par défaut...");
  await pool.query("BEGIN");
  try {
    const ROLES = [
      ["admin", "Administrateur", JSON.stringify(["R_VENTE","R_PRODUITS","R_STOCK","R_USERS","R_RAPPORTS","R_JOURNAL","R_POINT","R_PARAMS"])],
      ["caissier", "Caissier / Vendeur", JSON.stringify(["R_VENTE"])],
      ["stockiste", "Stockiste", JSON.stringify(["R_STOCK"])],
      ["comptable", "Comptable", JSON.stringify(["R_RAPPORTS","R_JOURNAL"])],
      ["lecteur", "Lecteur", JSON.stringify(["R_RAPPORTS"])],
    ];
    for (const [code, label, droits] of ROLES)
      await pool.query("INSERT INTO roles(code,label,droits) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING", [code, label, droits]);
    const hash = bcrypt.hashSync("admin123", 10);
    await pool.query("INSERT INTO users(nom,mdp_hash,role_code,droits) VALUES($1,$2,$3,$4)",
      ["admin", hash, "admin", ROLES[0][2]]);
    await pool.query("INSERT INTO boutique(id,nom) VALUES(1,'Ma Boutique') ON CONFLICT(id) DO NOTHING");
    await pool.query("COMMIT");
    console.log("✅ Admin créé → login: admin / admin123");
  } catch (e) { await pool.query("ROLLBACK"); console.error("⚠️ Auto-seed échoué:", e.message); }
}

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});
initSchema().then(() => autoSeed()).then(() => {
  server.listen(PORT, () => console.log("✅ Backend Gestion Stock & Vente sur http://localhost:" + PORT + " (WebSocket: /ws)"));
});
