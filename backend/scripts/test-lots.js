/* Test complet Lot 1 + Lot 2 + Lot 3 — API de Gestion Stock & Vente */
const BASE = "http://localhost:4000";
let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name + (extra !== undefined ? " — " + JSON.stringify(extra).slice(0, 200) : "")); } }
async function req(method, path, body, token) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000)
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
async function login(nom, mdp) {
  const r = await req("POST", "/api/auth/login", { nom, mdp });
  return r;
}
(async () => {
  console.log("== LOT 1 : paramètres partagés ==");
  let r = await login("admin", "admin123");
  ok("login admin", r.status === 200 && r.data.token, r.data);
  const T = r.data.token;
  r = await req("PUT", "/api/parametres", { show_demo: "0" }, T);
  ok("masquer comptes démo (show_demo=0)", r.status === 200, r.data);
  r = await req("GET", "/api/parametres", null, T);
  ok("paramètre lu : show_demo=0", r.data.find(p => p.cle === "show_demo").valeur === "0");
  r = await req("PUT", "/api/parametres", { show_demo: "1" }, T);
  ok("réactiver comptes démo", r.status === 200);

  console.log("== LOT 2 : familles, historique, rapports, mouvements ==");
  r = await req("POST", "/api/familles", { nom: "TEST-FAMILLE-LOT2" }, T);
  ok("créer famille", r.status === 200 && r.data.id, r.data);
  const famId = r.data.id;
  r = await req("PUT", "/api/familles/" + famId, { nom: "TEST-FAMILLE-RENOMMEE" }, T);
  ok("renommer famille", r.status === 200, r.data);
  r = await req("GET", "/api/familles", null, T);
  ok("famille dans la liste", r.data.some(f => f.id === famId && f.nom === "TEST-FAMILLE-RENOMMEE"));
  r = await req("POST", "/api/familles", { nom: "TEST-FAMILLE-RENOMMEE" }, T);
  ok("doublon famille refusé", r.status === 400, r.data);

  r = await req("POST", "/api/produits", { nom: "TEST-PRODUIT-LOT3", famille: "TEST-FAMILLE-RENOMMEE", prix_achat: 500, prix_vente: 750, stock: 0, stock_min: 2 }, T);
  ok("créer produit test", r.status === 200 && r.data.id, r.data);
  const pId = r.data.id;
  r = await req("GET", "/api/produits", null, T);
  const prod = r.data.find(p => p.id === pId);
  ok("produit visible avec famille", prod && prod.famille === "TEST-FAMILLE-RENOMMEE", prod);

  r = await req("POST", "/api/produits/" + pId + "/lots", { qte: 5, date_peremption: "2026-09-01" }, T);
  ok("lot A (5, péremption 09/2026)", r.status === 200, r.data);
  r = await req("POST", "/api/produits/" + pId + "/lots", { qte: 5, date_peremption: "2026-10-01" }, T);
  ok("lot B (5, péremption 10/2026)", r.status === 200, r.data);
  r = await req("GET", "/api/produits", null, T);
  ok("stock = 10 après les 2 lots", r.data.find(p => p.id === pId).stock == 10, r.data.find(p => p.id === pId));

  console.log("== LOT 3 : FIFO + vente idempotente (Fatou ouvre sa caisse) ==");
  const REF = "TFIFO" + Date.now().toString(36).toUpperCase();
  r = await login("Fatou Ndiaye", "caisse123");
  ok("login Fatou", r.status === 200 && r.data.token);
  const TF = r.data.token;
  r = await req("POST", "/api/caisse/ouvrir", { fonds_initial: 1000 }, TF);
  ok("Fatou ouvre sa caisse (fonds 1000)", r.status === 200 && r.data.id, r.data);
  const caisseF = r.data.id;
  r = await req("POST", "/api/ventes", { items: [{ produitId: pId, qte: 3 }], remise: 0, mode: "especes", recu: 3000, ref: REF }, TF);
  ok("vente FIFO 3× (ref " + REF + ")", r.status === 200 && r.data.id, r.data);
  const venteId = r.data.id;
  r = await req("POST", "/api/ventes", { items: [{ produitId: pId, qte: 3 }], remise: 0, mode: "especes", recu: 3000, ref: REF }, TF);
  ok("renvoi même ref → même vente (idempotent)", r.status === 200 && r.data.id === venteId, r.data);
  r = await req("GET", "/api/lots", null, T);
  const lA = r.data.find(l => String(l.produit_id) === String(pId) && String(l.date_peremption).startsWith("2026-09-01"));
  const lB = r.data.find(l => String(l.produit_id) === String(pId) && String(l.date_peremption).startsWith("2026-10-01"));
  ok("FIFO : lot A (ancien) débité en premier → 2 restants", lA && Number(lA.qte_restante) === 2, lA);
  ok("lot B intact → 5 restants", lB && Number(lB.qte_restante) === 5, lB);
  r = await req("GET", "/api/produits", null, T);
  ok("stock produit = 7 après vente", r.data.find(p => p.id === pId).stock == 7, r.data.find(p => p.id === pId));

  console.log("== Clôture + validation (Awa) ==");
  r = await req("GET", "/api/caisse/moi", null, TF);
  ok("attendu espèces Fatou = 1000 + 2250 = 3250", Number(r.data.attendu_especes) === 3250, r.data);
  r = await req("POST", "/api/caisse/" + caisseF + "/cloturer", { compte: 3250, notes: "" }, TF);
  ok("clôture écart 0 acceptée", r.status === 200 && Number(r.data.ecart) === 0, r.data);
  r = await req("POST", "/api/caisse/" + caisseF + "/cloturer", { compte: 3250, notes: "" }, TF);
  ok("double clôture refusée", r.status === 400, r.data);
  r = await login("Awa Diop", "pc123");
  ok("login Awa", r.status === 200 && r.data.token);
  const TA = r.data.token;
  r = await req("PUT", "/api/caisse/" + caisseF + "/valider", {}, TA);
  ok("Awa valide la caisse de Fatou", r.status === 200, r.data);
  r = await req("GET", "/api/caisse?from=" + new Date().toISOString().slice(0, 10) + "&to=" + new Date().toISOString().slice(0, 10), null, TA);
  const cF = r.data.find(c => String(c.id) === String(caisseF));
  ok("caisse validée visible dans la liste", cF && cF.statut === "validee" && cF.validee_par_nom === "Awa Diop", cF);

  console.log("== Lot 3 : fournisseurs & commandes ==");
  r = await req("POST", "/api/fournisseurs", { nom: "TEST-FOURNISSEUR", tel: "771234567", email: "test@test.sn" }, T);
  ok("créer fournisseur", r.status === 200 && r.data.id, r.data);
  const fId = r.data.id;
  r = await req("PUT", "/api/fournisseurs/" + fId, { nom: "TEST-FOURNISSEUR-2", tel: "771234567" }, T);
  ok("modifier fournisseur", r.status === 200, r.data);
  r = await req("GET", "/api/fournisseurs", null, T);
  ok("fournisseur dans la liste", r.data.some(f => f.id === fId && f.nom === "TEST-FOURNISSEUR-2"));
  r = await req("POST", "/api/commandes", { fournisseur_id: fId, livraison: 500, notes: "Commande test", items: [{ produitId: pId, qte: 4, prix_achat: 400 }] }, T);
  ok("créer commande (4×400 + livraison 500)", r.status === 200 && r.data.id, r.data);
  const cmdId = r.data.id;
  r = await req("GET", "/api/commandes", null, T);
  const cmd = r.data.find(c => c.id === cmdId);
  ok("commande listée avec fournisseur + items", cmd && cmd.fournisseur_nom === "TEST-FOURNISSEUR-2" && cmd.items.length === 1, cmd);
  r = await req("POST", "/api/commandes/" + cmdId + "/receptionner", {}, T);
  ok("réceptionner : statut recue", r.status === 200 && r.data.statut === "recue", r.data);
  r = await req("GET", "/api/produits", null, T);
  ok("stock = 11 après réception (+4)", r.data.find(p => p.id === pId).stock == 11, r.data.find(p => p.id === pId));
  r = await req("POST", "/api/commandes/" + cmdId + "/receptionner", {}, T);
  ok("double réception refusée", r.status === 400, r.data);
  r = await req("DELETE", "/api/fournisseurs/" + fId, {}, T);
  ok("supprimer fournisseur (commande → SET NULL)", r.status === 200, r.data);

  console.log("== Lot 2 : mouvements filtrables, 7 jours, historique prix ==");
  r = await req("GET", "/api/mouvements?produit=" + pId + "&limit=5&offset=0", null, T);
  ok("mouvements filtrés par produit (total 4 : 2 lots + sortie + réception)", r.data.total === 4 && r.data.rows.length === 4, { total: r.data.total, rows: r.data.rows.length });
  r = await req("GET", "/api/mouvements?type=" + encodeURIComponent("Sortie vente"), null, T);
  ok("filtre par type", r.data.total >= 1 && r.data.rows.every(m => m.type === "Sortie vente"), r.data.total);
  r = await req("GET", "/api/mouvements?from=2026-01-01&to=2026-12-31", null, T);
  ok("filtre période", r.data.total >= 4, r.data.total);
  r = await req("GET", "/api/rapports/7jours", null, T);
  ok("rapport 7 jours : 7 entrées", Array.isArray(r.data) && r.data.length === 7 && r.data[0].jour, r.data.length);
  ok("7 jours : champs CA/tickets/bénéfice", r.data.every(j => "ca" in j && "tickets" in j && "ben" in j));
  r = await req("PUT", "/api/produits/" + pId, { nom: "TEST-PRODUIT-LOT3", prix_achat: 500, prix_vente: 800, stock_min: 2, actif: true }, T);
  ok("modifier prix vente → 800", r.status === 200, r.data);
  r = await req("GET", "/api/produits/" + pId + "/historique", null, T);
  ok("historique : mouvements", r.data.mouvements.length >= 4, r.data.mouvements.length);
  ok("historique : ventes", r.data.ventes.length >= 1, r.data.ventes.length);
  ok("historique : changement de prix tracé (750→800)", r.data.prix.length >= 1 && Number(r.data.prix[0].pv_avant) === 750 && Number(r.data.prix[0].pv_apres) === 800, r.data.prix[0]);

  r = await req("GET", "/api/caisse?caissiere=1", null, T);
  const maxIdAdminAvant = Math.max(...r.data.map(c => Number(c.id)), 0);
  console.log("  (caisse admin max id au départ : " + maxIdAdminAvant + ")");
  r = await req("PUT", "/api/produits/" + pId, { nom: "TEST-PRODUIT-LOT3", prix_achat: 500, prix_vente: 800, stock_min: 2, actif: false }, T);
  ok("produit test désactivé", r.status === 200);
  r = await req("DELETE", "/api/familles/" + famId, {}, T);
  ok("supprimer famille (produit → sans famille)", r.status === 200, r.data);
  console.log("== Nettoyage + vérifications finales ==");
  r = await req("GET", "/api/caisse?caissiere=1", null, T);
  const maxIdAdminApres = Math.max(...r.data.map(c => Number(c.id)), 0);
  ok("aucune caisse admin créée par les tests (max id inchangé)", maxIdAdminApres === maxIdAdminAvant, { avant: maxIdAdminAvant, apres: maxIdAdminApres });

  console.log("\n==============================");
  console.log("RÉSULTAT : " + pass + " ✅ / " + fail + " ❌");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("ERREUR FATALE:", e); process.exit(2); });
