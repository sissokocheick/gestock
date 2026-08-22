/* ============================================================
   Module Stock — réapprovisionnement & rebut de lot
   (Les anciens sous-systèmes magasins/bons/demandes/inventaires
   ont été supprimés : aucun écran ne les utilisait et ils
   divergeaient du stock réel de la boutique.)
   ============================================================ */
const { pool, tx } = require("./db");

module.exports = function register({ app, auth, need, broadcast }) {

  /* ===== Suggestions de réappro : basées sur le VRAI stock (produits.stock) ===== */
  app.get("/api/reappro/suggestions", auth, need("R_STOCK"), async (req, res) => {
    const { rows } = await pool.query(
      `SELECT p.id AS produit_id, p.nom, p.code, f.nom AS famille, p.prix_achat,
              p.stock AS qte, p.stock_min,
              GREATEST(CEIL(p.stock_min * 2 - p.stock), 1) AS qte_suggeree
       FROM produits p
       LEFT JOIN familles f ON f.id = p.famille_id
       WHERE p.actif AND p.stock_min > 0 AND p.stock <= p.stock_min
       ORDER BY (p.stock::float / NULLIF(p.stock_min,0)) ASC NULLS LAST`);
    res.json(rows);
  });

  /* ===== Rebut d'un lot précis en 1 clic (périmé ou à détruire) ===== */
  app.post("/api/lots/:id/rebut", auth, need("R_STOCK"), async (req, res) => {
    if (!stockAutoriseLite(req)) return res.status(403).json({ error: "Réservé à la gérance et aux responsables stock" });
    const { rows: [lot] } = await pool.query("SELECT * FROM lots WHERE id=$1", [req.params.id]);
    if (!lot) return res.status(404).json({ error: "Lot introuvable" });
    if (Number(lot.qte_restante) <= 0) return res.status(400).json({ error: "Lot déjà vide" });
    await tx(req.user.id, async c => {
      await c.query("UPDATE lots SET qte_restante = 0 WHERE id=$1", [lot.id]);
      await c.query("UPDATE produits SET stock = GREATEST(0, stock - $1) WHERE id=$2", [lot.qte_restante, lot.produit_id]);
      await c.query(
        `INSERT INTO mouvements(type, produit_id, qte, motif, user_id, lot_id)
         VALUES('Destruction / rebut',$1,$2,'Lot rebuté (péremption)', $3, $4)`,
        [lot.produit_id, -Number(lot.qte_restante), req.user.id, lot.id]);
    });
    broadcast({ type: "stock" });
    res.json({ ok: true });
  });
};

function stockAutoriseLite(req) {
  return req.user.role_code === "admin" || (Array.isArray(req.user.droits) && req.user.droits.includes("R_STOCK") && req.user.role_code !== "caissier");
}
