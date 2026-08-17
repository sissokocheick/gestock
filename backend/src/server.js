/* ============================================================
   Gestion Stock & Vente — Backend API (Express + PostgreSQL + WebSocket)
   ============================================================ */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
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
app.use(cors({ origin: (o, cb) => cb(null, !o || ORIGIN_OK.test(o) || LAN_IPS.some(ip => o.startsWith("http://" + ip + ":") || o.startsWith("https://" + ip + ":"))) }));
app.use(express.json({ limit: "2mb" }));

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
function sign(u) { return jwt.sign({ id: u.id, nom: u.nom, role: u.role_code }, JWT_SECRET, { expiresIn: "12h" }); }
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
  return { id: u.id, nom: u.nom, role: u.role_code, droits, actif: u.actif, derniere_connexion: u.derniere_connexion || null };
}

async function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Non connecté" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query("SELECT id, nom, role_code, droits, actif, derniere_connexion FROM users WHERE id = $1", [payload.id]);
    if (!rows.length) return res.status(401).json({ error: "Compte inconnu" });
    if (!rows[0].actif) return res.status(403).json({ error: "Ce compte est désactivé" });
    req.user = rows[0];
    next();
  } catch { return res.status(401).json({ error: "Session invalide" }); }
}
const need = r => (req, res, next) => {
  if (!hasRight(req.user, r)) return res.status(403).json({ error: "Droit refusé : " + r });
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
  await pool.query("UPDATE users SET derniere_connexion = now() WHERE id = $1", [u.id]);
  u.derniere_connexion = new Date();
  loginOk(keyIp);
  loginOk(keyUser);
  await auditEvent(u, "Connexion", "Connexion de " + u.nom);
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
  const keys = ["ticket_width", "ticket_barcode", "show_demo", "remise_max_pct", "versement_validateur"];
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
  const { rows } = await pool.query("SELECT id, nom FROM familles ORDER BY nom");
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
    `SELECT (SELECT COUNT(*)::int FROM produits WHERE famille_id=$1) AS prods,
            (SELECT COUNT(*)::int FROM inventaires WHERE famille_id=$1) AS invs`, [id]);
  if (usage.prods + usage.invs > 0) {
    const parts = [];
    if (usage.prods) parts.push(usage.prods + " produit(s)");
    if (usage.invs) parts.push(usage.invs + " inventaire(s)");
    return res.status(400).json({ error: "Impossible de supprimer : cette famille est utilisée par " + parts.join(" et ") });
  }
  await tx(req.user.id, c => c.query("DELETE FROM familles WHERE id=$1", [id]));
  broadcast({ type: "produits" });
  res.json({ ok: true });
});
app.get("/api/produits", auth, async (req, res) => {
  const q = req.query.search ? "%" + req.query.search + "%" : "%";
  const fam = req.query.famille ? Number(req.query.famille) : null;
  const { rows } = await pool.query(
    `SELECT p.*, f.nom AS famille FROM produits p LEFT JOIN familles f ON f.id = p.famille_id
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
    const { rows } = await c.query(
      `INSERT INTO produits(nom, famille_id, code, photo, prix_achat, prix_vente, stock, stock_min, actif, gere_par_lot, reference)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [p.nom.trim(), famId, p.code || null, p.photo || null, Number(p.prix_achat) || 0, Number(p.prix_vente) || 0,
       Number(p.stock) || 0, Number(p.stock_min) || 0, p.actif !== false, gereLot, refRow.ref]);
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
  const r = await tx(req.user.id, c => c.query(
    `UPDATE produits SET nom=$1, code=$2, photo=$3, prix_achat=$4, prix_vente=$5, stock_min=$6, actif=$7, gere_par_lot=$8
     WHERE id=$9 RETURNING *`,
    [p.nom, p.code || null, p.photo || null, Number(p.prix_achat) || 0, Number(p.prix_vente) || 0, Number(p.stock_min) || 0, p.actif !== false, p.gere_par_lot === true, req.params.id]));
  broadcast({ type: "produits" });
  res.json(r.rows[0]);
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
  if (gereLot && (type === "entree" || type === "retour") && (!numero_lot || !String(numero_lot).trim())) return res.status(400).json({ error: "Ce produit est géré par lot : numéro de lot obligatoire" });
  if (gereLot && (type === "entree" || type === "retour") && !date_peremption) return res.status(400).json({ error: "Ce produit est géré par lot : date de péremption obligatoire" });
  if (!gereLot && (type === "entree" || type === "retour")) { numero_lot = numero_lot || null; date_peremption = date_peremption || null; }
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
        [p.id, delta, date_peremption, String(numero_lot).trim()]);
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
  const { items, remise, mode, recu } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Panier vide" });
  const { rows: [modeRow] } = await pool.query("SELECT code, especes FROM modes_paiement WHERE code=$1 AND actif", [mode]);
  if (!modeRow) return res.status(400).json({ error: "Mode de paiement invalide ou désactivé" });
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
    const { rows: [v] } = await c.query(
      "INSERT INTO ventes(numero, user_id, caisse_id, remise, total, net, mode, recu, rendu) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
      [numero, req.user.id, caisse.id, rem, total, net, mode, modeRow.especes ? (Number(recu) || net) : net, rendu]);
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
  const { rows } = await pool.query("SELECT u.id, u.nom, u.role_code, COALESCE(r.droits, u.droits) AS droits, u.actif, u.created_at, u.derniere_connexion FROM users u LEFT JOIN roles r ON r.code = u.role_code ORDER BY u.nom");
  res.json(rows);
});
app.post("/api/users", auth, need("R_USERS"), async (req, res) => {
  const u = req.body;
  if (!u.nom || !u.nom.trim() || !u.mdp) return res.status(400).json({ error: "Nom et mot de passe obligatoires" });
  const hash = bcrypt.hashSync(u.mdp, 10);
  await tx(req.user.id, c => c.query(
    "INSERT INTO users(nom, mdp_hash, role_code, droits, actif) VALUES($1,$2,$3,$4,$5)",
    [u.nom.trim(), hash, u.role_code || "caissier", JSON.stringify(u.droits || []), u.actif !== false]));
  broadcast({ type: "users" });
  res.json({ ok: true });
});
app.put("/api/users/:id", auth, need("R_USERS"), async (req, res) => {
  const u = req.body;
  await tx(req.user.id, async c => {
    if (u.mdp) {
      const hash = bcrypt.hashSync(u.mdp, 10);
      await c.query("UPDATE users SET nom=$1, mdp_hash=$2, role_code=$3, droits=$4, actif=$5 WHERE id=$6",
        [u.nom.trim(), hash, u.role_code, JSON.stringify(u.droits || []), u.actif !== false, req.params.id]);
    } else {
      await c.query("UPDATE users SET nom=$1, role_code=$2, droits=$3, actif=$4 WHERE id=$5",
        [u.nom.trim(), u.role_code, JSON.stringify(u.droits || []), u.actif !== false, req.params.id]);
    }
  });
  broadcast({ type: "users" });
  res.json({ ok: true });
});
app.put("/api/users/:id/actif", auth, need("R_USERS"), async (req, res) => {
  if (Number(req.params.id) === req.user.id && req.user.role_code === "admin")
    return res.status(400).json({ error: "Impossible de désactiver votre propre compte admin" });
  await tx(req.user.id, c => c.query("UPDATE users SET actif=$1 WHERE id=$2", [!!req.body.actif, req.params.id]));
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
    `SELECT vi.nom AS article, vi.qte, vi.prix, vi.prix_achat, v.user_id, u.nom AS user_nom, f.nom AS famille
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
    map[key].qte += Number(r.qte);
    map[key].ca += Number(r.qte) * Number(r.prix);
    map[key].ben += (Number(r.prix) - Number(r.prix_achat)) * Number(r.qte);
  });
  const groups = Object.values(map).sort((a, b) => b.ca - a.ca);
  const tot = groups.reduce((s, g) => ({ qte: s.qte + g.qte, ca: s.ca + g.ca, ben: s.ben + g.ben }), { qte: 0, ca: 0, ben: 0 });
  res.json({ groups, tot });
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
      if (type === "entree") {
        if (!it.numeroLot || !String(it.numeroLot).trim()) throw Object.assign(new Error("Indiquez le numéro de lot pour " + p.nom), { status: 400 });
        if (!it.datePeremption) throw Object.assign(new Error("Indiquez la date de péremption pour " + p.nom), { status: 400 });
      }
      await c.query("UPDATE produits SET stock = stock + $1 WHERE id=$2", [t.signe * q, p.id]);
      let lotId = null;
      if (type === "entree") {
        const { rows: [lot] } = await c.query(
          "INSERT INTO lots(produit_id, qte_restante, date_peremption, numero) VALUES($1,$2,$3,$4) RETURNING id",
          [pid, q, it.datePeremption, String(it.numeroLot).trim()]);
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
  const { rows: [usage] } = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM mouvements WHERE fournisseur_id=$1) AS mvts,
            (SELECT COUNT(*)::int FROM commandes WHERE fournisseur_id=$1) AS cmds,
            (SELECT COUNT(*)::int FROM bons WHERE fournisseur_id=$1) AS bons`, [id]);
  if (usage.mvts + usage.cmds + usage.bons > 0) {
    const parts = [];
    if (usage.mvts) parts.push(usage.mvts + " entrée(s)/mouvement(s)");
    if (usage.cmds) parts.push(usage.cmds + " commande(s)");
    if (usage.bons) parts.push(usage.bons + " bon(s)");
    return res.status(400).json({ error: "Impossible de supprimer : ce fournisseur est utilisé dans " + parts.join(", ") });
  }
  await tx(req.user.id, c => c.query("DELETE FROM fournisseurs WHERE id=$1", [id]));
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
      if (gereLot && (!l.numeroLot || !String(l.numeroLot).trim())) throw Object.assign(new Error("Ce produit est géré par lot : numéro de lot obligatoire"), { status: 400 });
      if (gereLot && !l.datePeremption) throw Object.assign(new Error("Ce produit est géré par lot : date de péremption obligatoire"), { status: 400 });
      const { rows: [p] } = await c.query("SELECT * FROM produits WHERE id=$1 FOR UPDATE", [pid]);
      if (!p) throw Object.assign(new Error("Produit introuvable"), { status: 404 });
      await c.query("UPDATE produits SET stock = stock + $1 WHERE id=$2", [q, pid]);
      const { rows: [lot] } = await c.query(
        "INSERT INTO lots(produit_id, qte_restante, date_peremption, numero) VALUES($1,$2,$3,$4) RETURNING id",
        [pid, q, l.datePeremption, String(l.numeroLot).trim()]);
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
  const attendu = Number(c.fonds_initial) + Number(t.especes) - verseEsp;
  return { ...c, especes: Number(t.especes), autres: Number(t.autres), total: Number(t.total), tickets: t.tickets,
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
  const { rows } = await pool.query(
    `SELECT d.*, u.nom AS user_nom FROM depenses d
     LEFT JOIN users u ON u.id = d.user_id
     WHERE ($1::date IS NULL OR d.date::date >= $1)
       AND ($2::date IS NULL OR d.date::date <= $2)
     ORDER BY d.date DESC`, [from || null, to || null]);
  res.json(rows);
});
app.post("/api/depenses", auth, need("R_PARAMS"), async (req, res) => {
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
app.delete("/api/depenses/:id", auth, need("R_PARAMS"), async (req, res) => {
  await tx(req.user.id, c => c.query("DELETE FROM depenses WHERE id=$1", [req.params.id]));
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

/* ---------- démarrage ---------- */
/* ---------- Module Stock avanc� (magasins, services, bons FEFO, inventaires, r�appro) ---------- */
require("./module-stock")({ app, auth, need, broadcast });

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});
server.listen(PORT, () => console.log("✅ Backend Gestion Stock & Vente sur http://localhost:" + PORT + " (WebSocket: /ws)"));
