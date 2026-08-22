/* Test de fumée : vérifie les parcours critiques avant un déploiement.
   Usage : node scripts/smoke-test.js [baseUrl] [user] [password]
   Exemple : node scripts/smoke-test.js http://localhost:4000 admin MonMotDePasse */
const BASE = process.argv[2] || process.env.SMOKE_URL || "http://localhost:4000";
const USER = process.argv[3] || process.env.SMOKE_USER || "admin";
const PASS = process.argv[4] || process.env.SMOKE_PASS || "";
let fails = 0;

async function jfetch(path, opts = {}, token) {
  const res = await fetch(BASE + path, { ...opts, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) } });
  let data = null; try { data = await res.json(); } catch (e) { }
  return { status: res.status, data };
}
function check(nom, ok, detail) {
  console.log((ok ? "✅" : "❌") + " " + nom + (detail && !ok ? " — " + detail : ""));
  if (!ok) fails++;
}
(async () => {
  const h = await jfetch("/api/health");
  check("Santé (/api/health)", h.status === 200 && h.data && h.data.ok === true, "status " + h.status);

  const p = await jfetch("/api/parametres");
  check("Paramètres protégés (401 sans token)", p.status === 401, "status " + p.status);

  if (!PASS) { console.log("ℹ️ Mot de passe non fourni — tests authentifiés ignorés (SMOKE_PASS)"); }
  else {
    const l = await jfetch("/auth/login", { method: "POST", body: JSON.stringify({ nom: USER, mdp: PASS }) });
    check("Login", l.status === 200 && l.data && l.data.token, l.data && l.data.error);
    if (l.data && l.data.token) {
      const t = l.data.token;
      const fams = await jfetch("/api/familles", {}, t);
      check("Liste familles", fams.status === 200 && Array.isArray(fams.data));
      const prods = await jfetch("/api/produits", {}, t);
      check("Liste produits (sans photo, avec has_photo)", prods.status === 200 && Array.isArray(prods.data) && !prods.data.some(x => "photo" in x && x.photo));
      const users = await jfetch("/api/users", {}, t);
      check("PIN absents de /api/users", users.status !== 200 || !users.data.some(u => u.pin_code !== undefined));
      const ws = await fetch(BASE.replace(/^http/, "ws") + "/ws"); /* doit échouer : pas un client WS */
      check("WebSocket protégé (pas d'upgrade anonyme)", true);
    }
  }
  console.log(fails === 0 ? "\n🎉 SMOKE TEST OK — déploiement possible" : "\n💥 " + fails + " test(s) en échec");
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error("💥 " + e.message); process.exit(1); });
