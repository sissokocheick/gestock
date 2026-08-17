/* État des caisses — vérifie que caisse admin n°6 a été fermée par l'utilisateur */
const BASE = "http://localhost:4000";
(async () => {
  const lr = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nom: "admin", mdp: "admin123" }) });
  const j = await lr.json();
  const r = await fetch(BASE + "/api/caisse?from=2026-08-15&to=2026-08-15", { headers: { Authorization: "Bearer " + j.token } });
  const cs = await r.json();
  for (const c of cs) {
    console.log(`caisse ${c.id} | ${c.user_nom} | ${c.statut} | ouverte ${new Date(c.ouverte_le).toLocaleString("fr-FR")} | fermée ${c.fermee_le ? new Date(c.fermee_le).toLocaleString("fr-FR") : "-"} | validée par ${c.validee_par_nom || "-"} | attendu ${c.total_attendu} | compté ${c.total_compte} | écart ${c.ecart}`);
  }
  process.exit(0);
})().catch(e => { console.error("FATAL", e); process.exit(2); });
