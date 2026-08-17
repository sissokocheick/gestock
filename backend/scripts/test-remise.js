/* Test du contrôle de remise (remise_max_pct) côté serveur
   Scénario : Fatou (caissière) ouvre sa caisse, essaie des remises, on nettoie tout après. */
const http = require("http");

function req(method, path, body, token) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "localhost", port: 4000, method, path, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) } }, res => {
      let b = ""; res.on("data", d => b += d); res.on("end", () => resolve({ status: res.statusCode, body: safe(b) }));
    });
    r.on("error", e => resolve({ status: 0, body: { err: e.message } }));
    if (data) r.write(data); r.end();
  });
}
function safe(s) { try { return JSON.parse(s); } catch { return { raw: s }; } }
const T = async (label, ok) => console.log((ok ? "  ✅ " : "  ❌ ") + label + (ok ? "" : " ← ÉCHEC"));

(async () => {
  const login = await req("POST", "/api/auth/login", { nom: "Fatou Ndiaye", mdp: "caisse123" });
  const TF = login.body.token;
  const loginA = await req("POST", "/api/auth/login", { nom: "admin", mdp: "admin123" });
  const TA = loginA.body.token;
  if (!TF || !TA) { console.log("Login impossible"); process.exit(1); }

  const c = await req("POST", "/api/caisse/ouvrir", { fonds_initial: 5000 }, TF);
  const caisseId = c.body && c.body.id;
  console.log("Caisse ouverte :", caisseId, "(statut " + c.status + ")");
  if (!caisseId) { console.log("Pas de caisse ouverte — abandon"); process.exit(1); }

  // 1) remise_max_pct = 100 par défaut : remise > total → refus
  let r = await req("POST", "/api/ventes", { items: [{ produitId: 1, qte: 1 }], remise: 999999, mode: "especes", recu: 2000 }, TF);
  await T("remise > total refusée (max 100 %)", r.status === 403 && /maximale/.test(r.body.error || ""));

  // 2) remise = 100 % du total → autorisée (total 750 ? utiliser le prix réel)
  r = await req("GET", "/api/produits", null, TF);
  const p = r.body.find ? r.body.find(x => x.actif && Number(x.stock) > 0) : null;
  if (!p) { console.log("Aucun produit vendable"); process.exit(1); }
  const prix = Number(p.prix_vente);
  r = await req("POST", "/api/ventes", { items: [{ produitId: p.id, qte: 1 }], remise: prix, mode: "especes", recu: prix }, TF);
  await T("remise 100 % du total autorisée", r.status === 200);

  // 3) remise_max_pct = 10 : 50 % refusée, 5 % autorisée
  r = await req("PUT", "/api/parametres", { remise_max_pct: 10 }, TA);
  await T("param remise_max_pct=10 enregistré", r.status === 200);
  r = await req("POST", "/api/ventes", { items: [{ produitId: p.id, qte: 1 }], remise: Math.ceil(prix * 0.5), mode: "especes", recu: prix }, TF);
  await T("remise 50 % refusée quand max=10 %", r.status === 403);
  r = await req("POST", "/api/ventes", { items: [{ produitId: p.id, qte: 1 }], remise: Math.floor(prix * 0.05), mode: "especes", recu: prix }, TF);
  await T("remise 5 % autorisée quand max=10 %", r.status === 200);

  // 4) remise_max_pct = 0 : toute remise refusée
  r = await req("PUT", "/api/parametres", { remise_max_pct: 0 }, TA);
  r = await req("POST", "/api/ventes", { items: [{ produitId: p.id, qte: 1 }], remise: 1, mode: "especes", recu: prix }, TF);
  await T("remise refusée quand max=0", r.status === 403);

  // 5) Restauration + clôture de la caisse de test
  await req("PUT", "/api/parametres", { remise_max_pct: 100 }, TA);
  r = await req("POST", "/api/caisse/" + caisseId + "/cloturer", { compte: 0, notes: "caisse de test remise" }, TF);
  await T("caisse de test clôturée", r.status === 200);
  console.log(r.status === 200 ? "RÉSULTAT : tests remise OK" : "RÉSULTAT : voir échecs ci-dessus");
  process.exit(r.status === 200 ? 0 : 1);
})().catch(e => { console.error("ERREUR:", e.message); process.exit(1); });
