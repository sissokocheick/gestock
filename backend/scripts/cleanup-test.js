/* Ferme la caisse Fatou ouverte + nettoie les tests du run précédent */
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
  let r = await req("POST", "/api/auth/login", { nom: "Fatou Ndiaye", mdp: "caisse123" });
  const TF = r.data.token;
  r = await req("GET", "/api/caisse/moi", null, TF);
  if (r.data) {
    console.log("caisse Fatou ouverte id=" + r.data.id + " attendu=" + r.data.attendu_especes);
    r = await req("POST", "/api/caisse/" + r.data.id + "/cloturer", { compte: Number(r.data.attendu_especes), notes: "" }, TF);
    console.log("clôture:", r.status, JSON.stringify(r.data));
    const cid = r.data.id || (await req("GET", "/api/caisse/moi", null, TF)).data?.id;
  }
  // validation par Awa
  r = await req("POST", "/api/auth/login", { nom: "Awa Diop", mdp: "pc123" });
  const TA = r.data.token;
  const today = new Date().toISOString().slice(0, 10);
  r = await req("GET", "/api/caisse?from=" + today + "&to=" + today, null, TA);
  for (const c of r.data) {
    if (c.user_nom === "Fatou Ndiaye" && c.statut === "fermee") {
      const v = await req("PUT", "/api/caisse/" + c.id + "/valider", {}, TA);
      console.log("validation caisse", c.id, "→", v.status);
    }
  }
  // désactiver produits de test
  r = await req("POST", "/api/auth/login", { nom: "admin", mdp: "admin123" });
  const T = r.data.token;
  r = await req("GET", "/api/produits", null, T);
  for (const p of r.data) {
    if ((p.nom || "").startsWith("TEST-") && p.actif) {
      await req("PUT", "/api/produits/" + p.id, { nom: p.nom, prix_achat: p.prix_achat, prix_vente: p.prix_vente, stock_min: p.stock_min, actif: false }, T);
    }
  }
  r = await req("GET", "/api/familles", null, T);
  for (const f of r.data) if ((f.nom || "").startsWith("TEST-")) await req("DELETE", "/api/familles/" + f.id, {}, T);
  r = await req("GET", "/api/fournisseurs", null, T);
  for (const f of r.data) if ((f.nom || "").startsWith("TEST-")) await req("DELETE", "/api/fournisseurs/" + f.id, {}, T);
  console.log("cleanup done");
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
