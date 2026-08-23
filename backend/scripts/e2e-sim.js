/* ============================================================
   TEST E2E sur la base simulée « Render périmé puis réparée »
   Vérifie que TOUTES les données/fonctionnalités marchent après la
   réparation automatique au démarrage :
     login → ouverture caisse → vente → versement (validation) →
     clôture → validation → réception commande (totale + PARTIELLE) →
     crédit client → annulation vente → rapports/dépenses/dashboard.
   Usage : node scripts/e2e-sim.js  (serveur sur localhost:4599)
   ============================================================ */
const BASE = process.argv[2] || "http://localhost:4599";
let fails = 0;
const results = [];

async function jfetch(path, opts = {}, token) {
  const res = await fetch(BASE + path, {
    ...opts,
    signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
  });
  let data = null;
  try { data = await res.json(); } catch (e) { }
  return { status: res.status, data };
}
function check(nom, ok, detail) {
  results.push((ok ? "✅" : "❌") + " " + nom + (!ok && detail !== undefined ? " — " + JSON.stringify(detail).slice(0, 200) : ""));
  if (!ok) fails++;
}

(async () => {
  /* 1. Login */
  const l = await jfetch("/api/auth/login", { method: "POST", body: JSON.stringify({ nom: "admin", mdp: "admin123" }) });
  check("Login admin", l.status === 200 && l.data.token, l.data);
  const t = l.data.token;

  /* 2. Référentiels (données de base) */
  for (const [nom, path] of [
    ["Santé API", "/api/health"],
    ["Boutique", "/api/boutique"],
    ["Paramètres", "/api/parametres"],
    ["Familles", "/api/familles"],
    ["Produits", "/api/produits"],
    ["Modes de paiement", "/api/modes-paiement"],
    ["Droits", "/api/droits"],
  ]) {
    const r = await jfetch(path, {}, t);
    check(nom, r.status === 200, r.data);
  }

  /* 3. Produit de test */
  const pr = await jfetch("/api/produits", {}, t);
  const prod = (pr.data || []).find(p => p.nom === "SIM TEST");
  check("Produit SIM TEST présent", !!prod, pr.data);

  /* 4. Ouverture de caisse */
  const co = await jfetch("/api/caisse/ouvrir", { method: "POST", body: JSON.stringify({ fonds_initial: 5000 }) }, t);
  check("Ouverture caisse", co.status === 200 && co.data.id, co.data);

  /* 5. Vente espèces */
  const v1 = await jfetch("/api/ventes", {
    method: "POST",
    body: JSON.stringify({ items: [{ produitId: prod.id, qte: 2 }], mode: "especes", recu: 1000 }),
  }, t);
  check("Vente espèces (2 × SIM TEST)", v1.status === 200 && v1.data.numero, v1.data);

  /* 6. Vente mobile money */
  const v2 = await jfetch("/api/ventes", {
    method: "POST",
    body: JSON.stringify({ items: [{ produitId: prod.id, qte: 1 }], mode: "mobile", recu: 150 }),
  }, t);
  check("Vente mobile money", v2.status === 200 && v2.data.numero, v2.data);

  /* 7. Versement en caisse + validation (R_POINT) */
  const ve = await jfetch("/api/caisse/" + co.data.id + "/versement", {
    method: "POST", body: JSON.stringify({ montant: 100, mode: "especes", motif: "Test" }),
  }, t);
  check("Versement créé (en attente)", ve.status === 200, ve.data);
  const vl = await jfetch("/api/versements", {}, t);
  const attente = (vl.data.rows || []).find(x => x.statut === "en_attente");
  check("Liste versements accessible", vl.status === 200 && !!attente, vl.data);
  if (attente) {
    const vv = await jfetch("/api/versements/" + attente.id + "/valider", { method: "POST", body: "{}" }, t);
    check("Validation du versement", vv.status === 200, vv.data);
  }

  /* 8. Clôture (écart → notes obligatoires), réouverture, crédit, puis clôture finale validée */
  const cl = await jfetch("/api/caisse/" + co.data.id + "/cloturer", {
    method: "POST", body: JSON.stringify({ compte: 4800 }),
  }, t);
  check("Clôture refusée sans explication d'écart", cl.status === 400 && /explication/i.test(cl.data.error || ""), cl.data);
  const cl2 = await jfetch("/api/caisse/" + co.data.id + "/cloturer", {
    method: "POST", body: JSON.stringify({ compte: 4800, notes: "écart de test" }),
  }, t);
  check("Clôture avec notes d'écart", cl2.status === 200, cl2.data);
  const ro = await jfetch("/api/caisse/" + co.data.id + "/rouvrir", { method: "PUT", body: "{}" }, t);
  check("Réouverture de la caisse fermée (non validée)", ro.status === 200, ro.data);

  /* 9. Client + vente à crédit */
  const cli = await jfetch("/api/clients", { method: "POST", body: JSON.stringify({ nom: "CLIENT SIM" }) }, t);
  check("Création client", cli.status === 200 && cli.data.id, cli.data);
  const vc = await jfetch("/api/ventes", {
    method: "POST",
    body: JSON.stringify({ items: [{ produitId: prod.id, qte: 1 }], mode: "credit", client_id: cli.data.id, client_nom: "CLIENT SIM" }),
  }, t);
  check("Vente à crédit", vc.status === 200, vc.data);
  const cr = await jfetch("/api/credits", {}, t);
  check("Liste crédits", cr.status === 200, Array.isArray(cr.data) ? cr.data[0] : cr.data);

  /* 9bis. Clôture finale EXACTE (attendu = 5000 fonds + 300 espèces − 100 versé = 5200) + validation */
  const cf = await jfetch("/api/caisse/" + co.data.id + "/cloturer", {
    method: "POST", body: JSON.stringify({ compte: 5200 }),
  }, t);
  check("Clôture finale sans écart (attendu 5200)", cf.status === 200 && Number(cf.data.ecart) === 0, cf.data);
  const cv = await jfetch("/api/caisse/" + co.data.id + "/valider", { method: "PUT", body: "{}" }, t);
  check("Validation de la caisse fermée", cv.status === 200, cv.data);

  /* 10. Fournisseur + commande + réception TOTALE puis PARTIELLE */
  const fo = await jfetch("/api/fournisseurs", { method: "POST", body: JSON.stringify({ nom: "FOURN SIM" }) }, t);
  check("Création fournisseur", fo.status === 200, fo.data);
  const cmd = await jfetch("/api/commandes", {
    method: "POST", body: JSON.stringify({ items: [{ produitId: prod.id, qte: 10, prix_achat: 100 }] }),
  }, t);
  check("Création commande", cmd.status === 200, cmd.data);
  if (cmd.data && cmd.data.id) {
    const recP = await jfetch("/api/commandes/" + cmd.data.id + "/receptionner", {
      method: "POST", body: JSON.stringify({ lignes: [{ produitId: prod.id, qte: 4 }] }),
    }, t);
    check("Réception PARTIELLE (statut 'partielle') — bug CHECK connu si échec", recP.status === 200, recP.data);
    const recT = await jfetch("/api/commandes/" + cmd.data.id + "/receptionner", {
      method: "POST", body: JSON.stringify({ lignes: [{ produitId: prod.id, qte: 6 }] }),
    }, t);
    check("Réception finale (solde)", recT.status === 200, recT.data);
  }

  /* 11. Annulation de la vente à crédit (motif obligatoire) */
  if (vc.data && vc.data.id) {
    const an = await jfetch("/api/ventes/" + vc.data.id + "/annuler", {
      method: "POST", body: JSON.stringify({ motif: "test e2e" }),
    }, t);
    check("Annulation vente (par admin)", an.status === 200, an.data);
  }

  /* 12. Rapports & tableaux de bord (jointures lourdes sur les nouvelles tables) */
  for (const [nom, path] of [
    ["Relevé du jour", "/api/releve"],
    ["Alertes dashboard", "/api/dashboard/alertes"],
    ["Rapport 7 jours", "/api/rapports/7jours"],
    ["Rapport ventes", "/api/rapports?type=ventes"],
    ["Dépenses", "/api/depenses"],
    ["Mouvements", "/api/mouvements"],
    ["Audit", "/api/audit"],
    ["Stock dormant", "/api/stock/dormant"],
    ["Péremptions proches", "/api/peremptions/proches"],
    ["Lots", "/api/lots"],
    ["Caisses (R_POINT)", "/api/caisse"],
    ["Classement point", "/api/point/classement"],
    ["Export comptable", "/api/export/comptable"],
    ["ABC", "/api/rapports/abc"],
    ["Suggestions réappro", "/api/reappro/suggestions"],
  ]) {
    const r = await jfetch(path, {}, t);
    check(nom, r.status === 200, r.data);
  }

  console.log(results.join("\n"));
  console.log(fails === 0 ? "\n🎉 E2E SIM OK — toutes les données fonctionnent après réparation"
    : "\n💥 " + fails + " test(s) en échec");
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error("💥", e.message); process.exit(1); });
