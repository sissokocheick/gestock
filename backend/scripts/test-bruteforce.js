/* Test anti force-brute : 5 échecs → blocage temporaire */
const BASE = "http://localhost:4000";
async function login(nom, mdp) {
  const r = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nom, mdp }),
    signal: AbortSignal.timeout(10000)
  });
  return { status: r.status, retryAfter: r.headers.get("Retry-After"), data: await r.json().catch(() => ({})) };
}
(async () => {
  let ok = 0, fail = 0;
  const t = (n, c, x) => { if (c) { ok++; console.log("  ✅ " + n); } else { fail++; console.log("  ❌ " + n + (x !== undefined ? " — " + JSON.stringify(x) : "")); } };
  // 5 tentatives avec un mauvais mot de passe
  for (let i = 1; i <= 5; i++) {
    const r = await login("admin", "mauvais-mdp-" + i);
    t("échec n°" + i + " → 401", r.status === 401, r);
  }
  // 6e tentative avec le BON mot de passe → doit être bloquée
  const r6 = await login("admin", "admin123");
  t("6e tentative (bon mdp) bloquée → 429", r6.status === 429, r6);
  t("message de blocage explicite", /Trop de tentatives/.test(r6.data.error || ""), r6.data.error);
  t("en-tête Retry-After présent", /^\d+$/.test(r6.retryAfter || ""), r6.retryAfter);
  // Un autre utilisateur (non bloqué par nom, mais même IP bloquée) → aussi 429
  const r7 = await login("Fatou Ndiaye", "caisse123");
  t("autre compte depuis la même IP aussi bloqué → 429", r7.status === 429, r7);
  // Le compteur par utilisateur ne bloque pas les AUTRES IP : impossible à simuler ici,
  // mais le blocage par IP est confirmé. Redémarrage du backend requis pour débloquer.
  console.log("\nRÉSULTAT: " + ok + " ✅ / " + fail + " ❌");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
