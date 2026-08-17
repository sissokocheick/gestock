/* Repro réception + FIFO avec comparaisons String() */
const BASE = "http://localhost:4000";
async function req(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
(async () => {
  let r = await req("POST", "/api/auth/login", { nom: "admin", mdp: "admin123" });
  const T = r.data.token;
  // créer produit + 2 lots
  r = await req("POST", "/api/produits", { nom: "TEST-REPRO-FIFO", prix_achat: 500, prix_vente: 750, stock: 0 }, T);
  const pId = r.data.id;
  console.log("produit", pId, JSON.stringify(r.data));
  r = await req("POST", "/api/produits/" + pId + "/lots", { qte: 5, date_peremption: "2026-09-01" }, T);
  r = await req("POST", "/api/produits/" + pId + "/lots", { qte: 5, date_peremption: "2026-10-01" }, T);
  r = await req("GET", "/api/lots", null, T);
  console.log("lots:", r.data.filter(l => String(l.produit_id) === String(pId)).map(l => ({ id: l.id, rest: l.qte_restante, per: l.date_peremption })));
  // fournisseur + commande
  r = await req("POST", "/api/fournisseurs", { nom: "TEST-REPRO-FOURN" }, T);
  const fId = r.data.id;
  r = await req("POST", "/api/commandes", { fournisseur_id: fId, livraison: 500, items: [{ produitId: pId, qte: 4, prix_achat: 400 }] }, T);
  console.log("commande", r.status, JSON.stringify(r.data));
  const cmdId = r.data.id;
  try {
    r = await req("POST", "/api/commandes/" + cmdId + "/receptionner", {}, T);
    console.log("reception:", r.status, JSON.stringify(r.data));
  } catch (e) { console.log("reception THREW:", e.message); }
  try {
    r = await req("POST", "/api/commandes/" + cmdId + "/receptionner", {}, T);
    console.log("double reception:", r.status, JSON.stringify(r.data));
  } catch (e) { console.log("double reception THREW:", e.message); }
  // check backend still alive
  try { await req("GET", "/api/familles", null, T); console.log("backend alive ✅"); } catch (e) { console.log("backend DEAD ❌:", e.message); }
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
