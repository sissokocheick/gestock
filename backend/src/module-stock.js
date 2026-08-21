/* ============================================================
   Module Stock avancé — magasins, services, bons (FEFO),
   demandes services, inventaires, suggestions de réappro.
   ------------------------------------------------------------
   Enregistré depuis server.js :
     require("./module-stock")({ app, auth, need, broadcast });

   Conventions :
   - Un bon est créé en statut 'saisi', puis validé (effets stock).
   - Sorties = allocation FEFO (péremption la plus proche d'abord,
     lots périmés exclus, lots "centraux" en secours).
   - Toute mutation diffuse { type: "stock" } (rafraîchissement temps réel).
   ============================================================ */
const { pool, tx } = require("./db");

const MVT_LABEL = {
  ENTREE: "Entrée (réception fournisseur)",
  SORTIE: "Sortie (service / bénéficiaire)",
  RETOUR: "Retour client",
  TRANSFERT_EXP: "Transfert sortie",
  TRANSFERT_REC: "Transfert entrée",
  HORS_STOCK: "Hors stock (traçage)",
  AJUSTEMENT: "Ajustement (+/-)",
  DESTRUCTION: "Destruction / rebut",
};

/* ---------- effets stock d'un bon (à l'intérieur d'une transaction) ---------- */
async function executerBon(c, bon, userId) {
  const { rows: items } = await c.query("SELECT * FROM bon_items WHERE bon_id=$1", [bon.id]);
  if (!items.length) throw Object.assign(new Error("Bon sans lignes"), { status: 400 });

  for (const it of items) {
    const pid = it.produit_id;
    const qte = Number(it.qte);
    /* Le stock catalogue (produits.stock) doit rester synchronisé avec stocks_magasin :
       sinon la caisse, le catalogue et les alertes divergent du stock réel des bons. */
    const syncCatalogue = delta => delta >= 0
      ? c.query("UPDATE produits SET stock = stock + $1 WHERE id = $2", [delta, pid])
      : c.query("UPDATE produits SET stock = GREATEST(0, stock + $1) WHERE id = $2", [delta, pid]);
    const mvt = (type, lotId) => c.query(
      `INSERT INTO mouvements(type, produit_id, qte, motif, user_id, magasin_id, bon_id, lot_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [MVT_LABEL[bon.type] || type, pid, qte, bon.motif || null, userId, bon.magasin_id, bon.id, lotId || null]);

    if (["ENTREE", "RETOUR", "TRANSFERT_REC"].includes(bon.type)) {
      const mg = bon.type === "TRANSFERT_REC" ? bon.magasin_dest_id : bon.magasin_id;
      if (!mg) throw Object.assign(new Error("Magasin obligatoire pour ce type de bon"), { status: 400 });
      await c.query(
        `INSERT INTO stocks_magasin(magasin_id, produit_id, qte) VALUES($1,$2,$3)
         ON CONFLICT (magasin_id, produit_id) DO UPDATE SET qte = stocks_magasin.qte + EXCLUDED.qte`,
        [mg, pid, qte]);
      await syncCatalogue(qte);
      const dp = (it.date_peremption && String(it.date_peremption).trim()) || null;
      if (dp) {
        await c.query(
          "INSERT INTO lots(produit_id, magasin_id, qte_restante, date_peremption) VALUES($1,$2,$3,$4)",
          [pid, mg, qte, dp]);
      }
      await mvt();
    } else if (["SORTIE", "DESTRUCTION", "TRANSFERT_EXP"].includes(bon.type)) {
      if (!bon.magasin_id) throw Object.assign(new Error("Magasin source obligatoire"), { status: 400 });
      const { rows: [sm] } = await c.query(
        "SELECT * FROM stocks_magasin WHERE magasin_id=$1 AND produit_id=$2 FOR UPDATE",
        [bon.magasin_id, pid]);
      const dispo = sm ? Number(sm.qte) : 0;
      if (dispo < qte) {
        throw Object.assign(new Error(`Stock insuffisant au magasin (dispo ${dispo}, requis ${qte}) pour le produit #${pid}`), { status: 400 });
      }
      // Allocation FEFO : péremption la plus proche d'abord, périmés exclus
      const { rows: allocs } = await c.query("SELECT * FROM fefo_lots($1,$2,$3)", [pid, qte, bon.magasin_id]);
      for (const al of allocs) {
        await c.query("UPDATE lots SET qte_restante = qte_restante - $1 WHERE id=$2", [al.qte, al.lot_id]);
        await c.query(
          `INSERT INTO mouvements(type, produit_id, qte, motif, user_id, magasin_id, bon_id, lot_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [MVT_LABEL[bon.type], pid, -Number(al.qte), bon.motif || null, userId, bon.magasin_id, bon.id, al.lot_id]);
      }
      await c.query("UPDATE stocks_magasin SET qte = qte - $1 WHERE magasin_id=$2 AND produit_id=$3", [qte, bon.magasin_id, pid]);
      await syncCatalogue(-qte);
    } else if (bon.type === "HORS_STOCK") {
      // Traçage sans impact stock
      await c.query(
        `INSERT INTO mouvements(type, produit_id, qte, motif, user_id, magasin_id, bon_id)
         VALUES($1,$2,0,$3,$4,$5,$6)`,
        [MVT_LABEL.HORS_STOCK, pid, bon.motif || null, userId, bon.magasin_id, bon.id]);
    } else if (bon.type === "AJUSTEMENT") {
      if (!bon.magasin_id) throw Object.assign(new Error("Magasin obligatoire"), { status: 400 });
      const { rows: [sm] } = await c.query(
        "SELECT * FROM stocks_magasin WHERE magasin_id=$1 AND produit_id=$2 FOR UPDATE",
        [bon.magasin_id, pid]);
      const dispo = sm ? Number(sm.qte) : 0;
      if (dispo + qte < 0) throw Object.assign(new Error("Ajustement impossible : stock négatif"), { status: 400 });
      await c.query(
        `INSERT INTO stocks_magasin(magasin_id, produit_id, qte) VALUES($1,$2,$3)
         ON CONFLICT (magasin_id, produit_id) DO UPDATE SET qte = stocks_magasin.qte + EXCLUDED.qte`,
        [bon.magasin_id, pid, qte]);
      await syncCatalogue(qte);
      await mvt();
    }
  }
}

/* ---------- enregistrement des routes ---------- */
module.exports = function register({ app, auth, need, broadcast }) {

  /* ===== Magasins ===== */
  app.get("/api/magasins", auth, async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM magasins ORDER BY nom");
    res.json(rows);
  });
  app.post("/api/magasins", auth, need("R_STOCK"), async (req, res) => {
    const { nom, adresse } = req.body;
    if (!nom || !String(nom).trim()) return res.status(400).json({ error: "Nom du magasin obligatoire" });
    const { rows: [r] } = await pool.query(
      "INSERT INTO magasins(nom, adresse) VALUES($1,$2) RETURNING *", [String(nom).trim(), adresse || null]);
    broadcast({ type: "stock" });
    res.json(r);
  });
  app.put("/api/magasins/:id", auth, need("R_STOCK"), async (req, res) => {
    const { nom, adresse, actif } = req.body;
    await pool.query("UPDATE magasins SET nom=COALESCE($1,nom), adresse=COALESCE($2,adresse), actif=COALESCE($3,actif) WHERE id=$4",
      [nom ? String(nom).trim() : null, adresse ?? null, typeof actif === "boolean" ? actif : null, req.params.id]);
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });

  /* ===== Services / bénéficiaires ===== */
  app.get("/api/services", auth, async (req, res) => {
    const { rows } = await pool.query("SELECT * FROM services ORDER BY nom");
    res.json(rows);
  });
  app.post("/api/services", auth, need("R_STOCK"), async (req, res) => {
    const { nom } = req.body;
    if (!nom || !String(nom).trim()) return res.status(400).json({ error: "Nom du service obligatoire" });
    const { rows: [r] } = await pool.query("INSERT INTO services(nom) VALUES($1) RETURNING *", [String(nom).trim()]);
    broadcast({ type: "stock" });
    res.json(r);
  });

  /* ===== État du stock par magasin (avec alertes de seuil) ===== */
  app.get("/api/stock/etat", auth, async (req, res) => {
    const magId = req.query.magasin_id ? Number(req.query.magasin_id) : null;
    const { rows } = await pool.query(
      `SELECT p.id, p.nom, p.code, p.famille_id, f.nom AS famille, p.prix_achat, p.prix_vente,
              p.stock_min, COALESCE(sm.qte,0) AS qte,
              CASE WHEN COALESCE(sm.qte,0) <= 0 THEN 'rupture'
                   WHEN COALESCE(sm.qte,0) <= p.stock_min THEN 'faible'
                   ELSE 'ok' END AS alerte,
              COALESCE(sm.qte,0) * p.prix_achat AS valeur
       FROM produits p
       LEFT JOIN familles f ON f.id = p.famille_id
       LEFT JOIN stocks_magasin sm ON sm.produit_id = p.id AND sm.magasin_id = COALESCE($1, (SELECT id FROM magasins ORDER BY id LIMIT 1))
       WHERE p.actif
       ORDER BY alerte DESC, p.nom`,
      [magId]);
    res.json(rows);
  });

  /* ===== Péremptions ===== */
  app.get("/api/stock/peremptions", auth, async (req, res) => {
    const jours = Math.max(1, Number(req.query.jours || 30));
    const { rows } = await pool.query(
      `SELECT l.id AS lot_id, l.produit_id, p.nom AS produit_nom, p.code, l.qte_restante, l.date_peremption,
              (l.date_peremption - CURRENT_DATE) AS jours_restants
       FROM lots l
       LEFT JOIN produits p ON p.id = l.produit_id
       WHERE l.date_peremption IS NOT NULL AND l.qte_restante > 0
         AND l.date_peremption <= CURRENT_DATE + $1::int
       ORDER BY l.date_peremption ASC`,
      [jours]);
    res.json(rows);
  });

  /* Rebut d'un lot précis en 1 clic (périmé ou à détruire) */
  app.post("/api/lots/:id/rebut", auth, need("R_STOCK"), async (req, res) => {
    const { rows: [lot] } = await pool.query("SELECT * FROM lots WHERE id=$1", [req.params.id]);
    if (!lot) return res.status(404).json({ error: "Lot introuvable" });
    if (Number(lot.qte_restante) <= 0) return res.status(400).json({ error: "Lot déjà vide" });
    await tx(req.user.id, async c => {
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
    });
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });

  /* ===== Bons ===== */
  app.post("/api/bons", auth, need("R_STOCK"), async (req, res) => {
    const { type, magasin_id, magasin_dest_id, service_id, fournisseur_id, motif, items } = req.body;
    if (!type || !Array.isArray(items) || !items.length) return res.status(400).json({ error: "Type et lignes obligatoires" });
    const bon = await tx(req.user.id, async c => {
      const { rows: [b] } = await c.query(
        `INSERT INTO bons(type, magasin_id, magasin_dest_id, service_id, fournisseur_id, motif, user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [type, magasin_id || null, magasin_dest_id || null, service_id || null, fournisseur_id || null, motif || null, req.user.id]);
      await c.query("UPDATE bons SET reference = 'BON-' || type || '-' || id WHERE id=$1", [b.id]);
      for (const it of items) {
        if (!it.produit_id || !it.qte) throw Object.assign(new Error("Ligne invalide (produit_id et qte requis)"), { status: 400 });
        const dp = (it.date_peremption && String(it.date_peremption).trim()) || null;
        await c.query(
          "INSERT INTO bon_items(bon_id, produit_id, qte, prix_unitaire, date_peremption) VALUES($1,$2,$3,$4,$5)",
          [b.id, it.produit_id, it.qte, it.prix_unitaire || 0, dp]);
      }
      const { rows: [b2] } = await c.query("SELECT * FROM bons WHERE id=$1", [b.id]);
      return b2;
    });
    broadcast({ type: "stock" });
    res.json(bon);
  });

  app.get("/api/bons", auth, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT b.*, u.nom AS user_nom, m.nom AS magasin_nom, md.nom AS magasin_dest_nom, s.nom AS service_nom, f.nom AS fournisseur_nom
       FROM bons b
       LEFT JOIN users u ON u.id = b.user_id
       LEFT JOIN magasins m ON m.id = b.magasin_id
       LEFT JOIN magasins md ON md.id = b.magasin_dest_id
       LEFT JOIN services s ON s.id = b.service_id
       LEFT JOIN fournisseurs f ON f.id = b.fournisseur_id
       WHERE ($1::text IS NULL OR b.type = $1) AND ($2::text IS NULL OR b.statut = $2) AND ($3::bigint IS NULL OR b.magasin_id = $3)
       ORDER BY b.id DESC LIMIT 500`,
      [req.query.type || null, req.query.statut || null, req.query.magasin_id ? Number(req.query.magasin_id) : null]);
    res.json(rows);
  });

  app.get("/api/bons/:id", auth, async (req, res) => {
    const { rows: [bon] } = await pool.query(
      `SELECT b.*, u.nom AS user_nom, m.nom AS magasin_nom, md.nom AS magasin_dest_nom, s.nom AS service_nom, f.nom AS fournisseur_nom
       FROM bons b
       LEFT JOIN users u ON u.id = b.user_id
       LEFT JOIN magasins m ON m.id = b.magasin_id
       LEFT JOIN magasins md ON md.id = b.magasin_dest_id
       LEFT JOIN services s ON s.id = b.service_id
       LEFT JOIN fournisseurs f ON f.id = b.fournisseur_id
       WHERE b.id=$1`, [req.params.id]);
    if (!bon) return res.status(404).json({ error: "Bon introuvable" });
    const { rows: items } = await pool.query(
      `SELECT bi.*, p.nom AS produit_nom, p.code, l.date_peremption
       FROM bon_items bi
       LEFT JOIN produits p ON p.id = bi.produit_id
       LEFT JOIN lots l ON l.id = bi.lot_id
       WHERE bi.bon_id=$1`, [bon.id]);
    res.json({ ...bon, items });
  });

  app.post("/api/bons/:id/valider", auth, need("R_STOCK"), async (req, res) => {
    const { rows: [bon] } = await pool.query("SELECT * FROM bons WHERE id=$1", [req.params.id]);
    if (!bon) return res.status(404).json({ error: "Bon introuvable" });
    if (bon.statut !== "saisi") return res.status(400).json({ error: "Seul un bon saisi peut être validé" });
    await tx(req.user.id, c => c.query("UPDATE bons SET statut='valide' WHERE id=$1", [bon.id]).then(() => executerBon(c, bon, req.user.id)));
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });

  app.post("/api/bons/:id/annuler", auth, need("R_STOCK"), async (req, res) => {
    const { rows: [bon] } = await pool.query("SELECT * FROM bons WHERE id=$1", [req.params.id]);
    if (!bon) return res.status(404).json({ error: "Bon introuvable" });
    if (bon.statut !== "saisi") return res.status(400).json({ error: "Seul un bon non validé peut être annulé" });
    await pool.query("UPDATE bons SET statut='annule' WHERE id=$1", [bon.id]);
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });

  /* ===== Demandes des services ===== */
  app.post("/api/demandes", auth, need("R_STOCK"), async (req, res) => {
    const { service_id, motif, items } = req.body;
    if (!service_id || !Array.isArray(items) || !items.length) return res.status(400).json({ error: "Service et lignes obligatoires" });
    const d = await tx(req.user.id, async c => {
      const { rows: [r] } = await c.query(
        "INSERT INTO demandes(service_id, motif, user_id) VALUES($1,$2,$3) RETURNING *",
        [service_id, motif || null, req.user.id]);
      await c.query("UPDATE demandes SET reference = 'DEM-' || id WHERE id=$1", [r.id]);
      for (const it of items) {
        await c.query("INSERT INTO demande_items(demande_id, produit_id, qte) VALUES($1,$2,$3)",
          [r.id, it.produit_id, it.qte]);
      }
      const { rows: [r2] } = await c.query("SELECT * FROM demandes WHERE id=$1", [r.id]);
      return r2;
    });
    broadcast({ type: "stock" });
    res.json(d);
  });

  app.get("/api/demandes", auth, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT d.*, s.nom AS service_nom, u.nom AS user_nom
       FROM demandes d
       LEFT JOIN services s ON s.id = d.service_id
       LEFT JOIN users u ON u.id = d.user_id
       WHERE ($1::text IS NULL OR d.statut = $1)
       ORDER BY d.id DESC LIMIT 500`,
      [req.query.statut || null]);
    res.json(rows);
  });

  app.get("/api/demandes/:id", auth, async (req, res) => {
    const { rows: [d] } = await pool.query(
      `SELECT d.*, s.nom AS service_nom FROM demandes d LEFT JOIN services s ON s.id=d.service_id WHERE d.id=$1`, [req.params.id]);
    if (!d) return res.status(404).json({ error: "Demande introuvable" });
    const { rows: items } = await pool.query(
      `SELECT di.*, p.nom AS produit_nom, p.code FROM demande_items di LEFT JOIN produits p ON p.id=di.produit_id WHERE di.demande_id=$1`, [d.id]);
    res.json({ ...d, items });
  });

  async function changerStatutDemande(id, de, vers, needCheck) {
    const { rows: [d] } = await pool.query("SELECT * FROM demandes WHERE id=$1", [id]);
    if (!d) throw Object.assign(new Error("Demande introuvable"), { status: 404 });
    if (d.statut !== de) throw Object.assign(new Error(`Transition impossible (${d.statut} → ${vers})`), { status: 400 });
    if (needCheck) await needCheck(d);
    await pool.query("UPDATE demandes SET statut=$1 WHERE id=$2", [vers, id]);
    return d;
  }

  app.post("/api/demandes/:id/valider", auth, need("R_STOCK"), async (req, res) => {
    await changerStatutDemande(req.params.id, "creee", "validee");
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });

  app.post("/api/demandes/:id/livrer", auth, need("R_STOCK"), async (req, res) => {
    const { magasin_id } = req.body;
    if (!magasin_id) return res.status(400).json({ error: "magasin_id obligatoire pour la livraison" });
    const d = await changerStatutDemande(req.params.id, "validee", "livree", async dmd => {
      // crée + valide un bon de sortie pour le service demandeur
      const bon = await tx(req.user.id, async c => {
        const { rows: [b] } = await c.query(
          "INSERT INTO bons(type, magasin_id, service_id, motif, user_id) VALUES('SORTIE',$1,$2,$3,$4) RETURNING *",
          [magasin_id, dmd.service_id, "Livraison demande " + (dmd.reference || dmd.id), req.user.id]);
        await c.query("UPDATE bons SET reference = 'BON-' || type || '-' || id WHERE id=$1", [b.id]);
        const { rows: items } = await c.query("SELECT * FROM demande_items WHERE demande_id=$1", [dmd.id]);
        for (const it of items) {
          await c.query("INSERT INTO bon_items(bon_id, produit_id, qte) VALUES($1,$2,$3)", [b.id, it.produit_id, it.qte]);
        }
        const { rows: [b2] } = await c.query("SELECT * FROM bons WHERE id=$1", [b.id]);
        return b2;
      });
      await tx(req.user.id, c => c.query("UPDATE bons SET statut='valide' WHERE id=$1", [bon.id]).then(() => executerBon(c, bon, req.user.id)));
    });
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });

  app.post("/api/demandes/:id/accuser", auth, need("R_STOCK"), async (req, res) => {
    await changerStatutDemande(req.params.id, "livree", "accusee");
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });

  /* ===== Inventaires ===== */
  app.post("/api/inventaires", auth, need("R_STOCK"), async (req, res) => {
    const { magasin_id, type, famille_id, notes } = req.body;
    if (!magasin_id) return res.status(400).json({ error: "magasin_id obligatoire" });
    const { rows: [inv] } = await tx(req.user.id, async c => {
      const { rows: [r] } = await c.query(
        "INSERT INTO inventaires(magasin_id, type, famille_id, notes, user_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [magasin_id, type === "tournant" ? "tournant" : "complet", famille_id || null, notes || null, req.user.id]);
      const { rows: stocks } = await c.query(
        `SELECT p.id AS produit_id, COALESCE(sm.qte,0) AS qte
         FROM produits p
         LEFT JOIN stocks_magasin sm ON sm.produit_id = p.id AND sm.magasin_id = $1
         WHERE p.actif AND ($2::bigint IS NULL OR p.famille_id = $2)`,
        [magasin_id, famille_id || null]);
      for (const s of stocks) {
        await c.query("INSERT INTO inventaire_items(inventaire_id, produit_id, qte_theorique) VALUES($1,$2,$3)",
          [r.id, s.produit_id, s.qte]);
      }
      const { rows: [r2] } = await c.query("SELECT * FROM inventaires WHERE id=$1", [r.id]);
      return r2;
    });
    broadcast({ type: "stock" });
    res.json(inv);
  });

  app.get("/api/inventaires", auth, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT i.*, m.nom AS magasin_nom, u.nom AS user_nom,
              (SELECT COUNT(*) FROM inventaire_items ii WHERE ii.inventaire_id = i.id) AS nb_lignes
       FROM inventaires i
       LEFT JOIN magasins m ON m.id = i.magasin_id
       LEFT JOIN users u ON u.id = i.user_id
       WHERE ($1::text IS NULL OR i.statut = $1)
       ORDER BY i.id DESC LIMIT 200`,
      [req.query.statut || null]);
    res.json(rows);
  });

  app.get("/api/inventaires/:id", auth, async (req, res) => {
    const { rows: [inv] } = await pool.query("SELECT * FROM inventaires WHERE id=$1", [req.params.id]);
    if (!inv) return res.status(404).json({ error: "Inventaire introuvable" });
    const { rows: items } = await pool.query(
      `SELECT ii.*, p.nom AS produit_nom, p.code FROM inventaire_items ii
       LEFT JOIN produits p ON p.id = ii.produit_id WHERE ii.inventaire_id=$1 ORDER BY p.nom`, [inv.id]);
    res.json({ ...inv, items });
  });

  app.post("/api/inventaires/:id/comptage", auth, need("R_STOCK"), async (req, res) => {
    const { rows: [inv] } = await pool.query("SELECT * FROM inventaires WHERE id=$1", [req.params.id]);
    if (!inv) return res.status(404).json({ error: "Inventaire introuvable" });
    if (inv.statut === "valide") return res.status(400).json({ error: "Inventaire déjà validé" });
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "items requis" });
    await tx(req.user.id, async c => {
      for (const it of items) {
        if (it.qte_comptee == null) continue;
        await c.query(
          "UPDATE inventaire_items SET qte_comptee=$1, ecart=$1 - qte_theorique, saisie_par=$2 WHERE inventaire_id=$3 AND produit_id=$4",
          [it.qte_comptee, req.user.id, inv.id, it.produit_id]);
      }
      await c.query("UPDATE inventaires SET statut='saisi' WHERE id=$1", [inv.id]);
    });
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });

  app.post("/api/inventaires/:id/valider", auth, need("R_STOCK"), async (req, res) => {
    const { rows: [inv] } = await pool.query("SELECT * FROM inventaires WHERE id=$1", [req.params.id]);
    if (!inv) return res.status(404).json({ error: "Inventaire introuvable" });
    if (inv.statut !== "saisi") return res.status(400).json({ error: "Le comptage doit être saisi avant validation" });
    await tx(req.user.id, async c => {
      const { rows: items } = await c.query("SELECT * FROM inventaire_items WHERE inventaire_id=$1 AND ecart IS NOT NULL AND ecart <> 0", [inv.id]);
      for (const it of items) {
        await c.query(
          `INSERT INTO stocks_magasin(magasin_id, produit_id, qte) VALUES($1,$2,$3)
           ON CONFLICT (magasin_id, produit_id) DO UPDATE SET qte = stocks_magasin.qte + EXCLUDED.qte`,
          [inv.magasin_id, it.produit_id, it.ecart]);
        await c.query(
          `INSERT INTO mouvements(type, produit_id, qte, motif, user_id, magasin_id)
           VALUES('Inventaire',$1,$2,'Inventaire ' || $3::text || ' (écart)', $4, $5)`,
          [it.produit_id, it.ecart, inv.id, req.user.id, inv.magasin_id]);
      }
      await c.query("UPDATE inventaires SET statut='valide', date_fin=now() WHERE id=$1", [inv.id]);
    });
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });

  /* ===== Suggestions de réappro ===== */
  app.get("/api/reappro/suggestions", auth, async (req, res) => {
    const magId = req.query.magasin_id ? Number(req.query.magasin_id) : null;
    const { rows } = await pool.query(
      `WITH s AS (
         SELECT p.id AS produit_id, p.nom, p.code, f.nom AS famille, p.prix_achat,
                COALESCE(sm.qte,0) AS qte, p.stock_min,
                GREATEST(CEIL(p.stock_min * 2 - COALESCE(sm.qte,0)), 1) AS qte_suggeree
         FROM produits p
         LEFT JOIN familles f ON f.id = p.famille_id
         LEFT JOIN stocks_magasin sm ON sm.produit_id = p.id AND sm.magasin_id = COALESCE($1, (SELECT id FROM magasins ORDER BY id LIMIT 1))
         WHERE p.actif AND p.stock_min > 0 AND COALESCE(sm.qte,0) <= p.stock_min
       )
       SELECT s.*, sg.id AS suggestion_id, sg.statut AS suggestion_statut, sg.commande_id
       FROM s
       LEFT JOIN suggestions sg ON sg.produit_id = s.produit_id AND sg.magasin_id = COALESCE($1, (SELECT id FROM magasins ORDER BY id LIMIT 1)) AND sg.statut = 'ouverte'
       ORDER BY s.qte / NULLIF(s.stock_min,0) ASC`,
      [magId]);
    res.json(rows);
  });

  app.post("/api/reappro/suggestions/:id/commander", auth, need("R_STOCK"), async (req, res) => {
    const { rows: [sug] } = await pool.query(
      `SELECT s.*, p.nom, p.prix_achat FROM suggestions s LEFT JOIN produits p ON p.id = s.produit_id WHERE s.id=$1`, [req.params.id]);
    if (!sug) return res.status(404).json({ error: "Suggestion introuvable" });
    if (sug.statut !== "ouverte") return res.status(400).json({ error: "Suggestion déjà traitée" });
    let fournisseurId = req.body.fournisseur_id;
    if (!fournisseurId && req.body.fournisseur_nom) {
      const nom = String(req.body.fournisseur_nom).trim();
      const { rows: [f] } = await pool.query(
        "INSERT INTO fournisseurs(nom) VALUES($1) ON CONFLICT (nom) DO UPDATE SET nom=EXCLUDED.nom RETURNING id", [nom]);
      fournisseurId = f.id;
    }
    if (!fournisseurId) fournisseurId = (await pool.query("SELECT id FROM fournisseurs ORDER BY id LIMIT 1")).rows[0]?.id;
    if (!fournisseurId) return res.status(400).json({ error: "Indiquez un fournisseur (nom ou existant)" });
    await tx(req.user.id, async c => {
      const { rows: [cmd] } = await c.query(
        "INSERT INTO commandes(fournisseur_id, statut, user_id, notes) VALUES($1,'en_cours',$2,'Réappro auto (suggestion)') RETURNING *",
        [fournisseurId, req.user.id]);
      await c.query("INSERT INTO commande_items(commande_id, produit_id, nom, qte, prix_achat) VALUES($1,$2,$3,$4,$5)",
        [cmd.id, sug.produit_id, sug.nom, sug.qte, sug.prix_achat]);
      await c.query("UPDATE suggestions SET statut='commandee', commande_id=$1 WHERE id=$2", [cmd.id, sug.id]);
    });
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });

  app.post("/api/reappro/suggestions/:id/ignorer", auth, need("R_STOCK"), async (req, res) => {
    await pool.query("UPDATE suggestions SET statut='ignoree' WHERE id=$1 AND statut='ouverte'", [req.params.id]);
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });
};
