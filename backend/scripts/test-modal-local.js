/* ============================================================
   TEST MODALES — exécute le VRAI app.js (celui que Render sert)
   dans un DOM simulé, puis vérifie que les boutons de fermeture
   fonctionnent APRÈS une action (ex. clôture de caisse).

   Usage : node scripts/test-modal-local.js [baseUrl]
   ============================================================ */
const BASE = process.argv[2] || "http://localhost:4599";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require(path.join(__dirname, "..", "node_modules", "jsdom"));

let fails = 0;
const check = (nom, ok, detail) => {
  console.log((ok ? "✅" : "❌") + " " + nom + (!ok && detail !== undefined ? " — " + String(detail).slice(0, 300) : ""));
  if (!ok) fails++;
};

(async () => {
  /* 1. Récupérer l'index et le app.js EXACTS servis par le serveur */
  const idxRes = await fetch(BASE + "/");
  const html = await idxRes.text();
  const jsRes = await fetch(BASE + "/app.js");
  const appJs = await jsRes.text();
  check("app.js servi par le serveur récupéré", jsRes.status === 200 && appJs.length > 10000, jsRes.status);

  /* 2. DOM simulé avec exécution des scripts inline */
  const dom = new JSDOM(html.replace(/<script src="[^"]*"><\/script>/g, ""), {
    url: BASE + "/",
    runScripts: "dangerously",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const { document } = window;

  /* Stubs minimaux pour ce qui manque hors navigateur réel */
  if (!window.navigator.serviceWorker) Object.defineProperty(window.navigator, "serviceWorker", { value: { register: () => Promise.resolve() }, configurable: true });
  window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() { }, removeEventListener() { } }));
  window.HTMLCanvasElement.prototype.getContext = () => null;
  /* jsdom n'a pas de fetch : brancher sur le fetch de Node avec URL absolue */
  window.fetch = (url, opts) => fetch(String(url).startsWith("http") ? url : BASE + url, opts);
  /* L'app utilise sessionStorage pour son cache GET — disponible dans jsdom, rien à faire */

  /* 3. Exécuter le app.js réel dans le contexte du DOM */
  try {
    dom.window.eval(appJs);
    check("app.js évalué sans erreur de syntaxe", true);
  } catch (e) {
    check("app.js évalué sans erreur de syntaxe", false, e.message);
    process.exit(1);
  }
  await new Promise(r => setTimeout(r, 300));

  /* 4. Login PAR LE FORMULAIRE de l'app (le token interne `token` doit être positionné,
     car la modale appelle api() qui utilise la variable interne — pas notre fetch Node) */
  document.getElementById("loginUser").value = "admin";
  document.getElementById("loginPass").value = "admin123";
  document.getElementById("loginBtn").click();
  let logge = false;
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (!document.getElementById("login").classList.contains("hidden") === false) { logge = true; break; }
  }
  check("Login par le formulaire", logge && !!window.localStorage.getItem("gs_token"));

  /* 5bis. Preuve du correctif : closeModal exposée sur window ? */
  check("closeModal exposée globalement (window.closeModal)", typeof window.closeModal === "function");
  check("go exposée globalement", typeof window.go === "function");

  /* 6. Simuler l'ACTION complète PAR LE DOM (login → modale clôture → clic) :
     réutilise la logique de debug-modal.js mais intégrée au test officiel */
  const tok = window.localStorage.getItem("gs_token") || "";
  const hh = { "Content-Type": "application/json", Authorization: "Bearer " + tok };
  let moi = await (await fetch(BASE + "/api/caisse/moi", { headers: hh })).json();
  if (!moi || !moi.id) moi = await (await fetch(BASE + "/api/caisse/ouvrir", { method: "POST", headers: hh, body: JSON.stringify({ fonds_initial: 1000 }) })).json();
  const c = { id: moi.id, fonds_initial: Number(moi.fonds_initial) || 1000, especes: 0, total: 0, tickets: 0,
              attendu_especes: Number(moi.fonds_initial) || 1000, verse_especes: 0, verse_en_attente: 0, versements: [] };
  try {
    window.clotureForm(c);   /* la vraie fonction de app.js */
    check("Modale clôture ouverte (fonction réelle clotureForm)", !document.getElementById("modal").classList.contains("hidden"));
  } catch (e) {
    check("Modale clôture ouverte (fonction réelle clotureForm)", false, e.message);
  }

  /* Le champ est pré-rempli avec l'attendu → écart nul → bouton actif */
  const saveBtn = document.getElementById("ctSave");
  check("Bouton 'Cloturer la caisse' présent et actif", !!saveBtn && !saveBtn.disabled);
  if (saveBtn) saveBtn.click();
  let confirmee = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    if ((document.getElementById("modalCard").innerHTML || "").includes("cloturee")) { confirmee = true; break; }
  }
  check("Après action : modale 'Caisse cloturee' affichée", confirmee);

  /* 7. LE BUG SIGNALÉ : le bouton Fermer après l'action */
  const fermerBtn = [...document.querySelectorAll("#modalCard button")].find(b => /fermer/i.test(b.textContent) || (b.getAttribute("onclick") || "").includes("closeModal"));
  check("Bouton Fermer présent après l'action", !!fermerBtn);
  if (fermerBtn) {
    fermerBtn.click();
    await new Promise(r => setTimeout(r, 400));
    const encoreOuverte = !document.getElementById("modal").classList.contains("hidden");
    check("CLIC FERMER → la modale se referme", !encoreOuverte, encoreOuverte ? "modale encore visible après clic" : "");
  }

  /* 8. Rejouer avec onclick inline direct : openModal → bouton onclick="closeModal()" */
  window.openModal("<h3>Test</h3><div class='row'><button class='btn ghost' onclick=\"closeModal()\">Annuler</button></div>");
  const btnInline = [...document.querySelectorAll("#modalCard button")].find(b => (b.getAttribute("onclick") || "").includes("closeModal"));
  check("Modale test ouverte avec bouton onclick=closeModal", !!btnInline);
  if (btnInline) {
    btnInline.click();
    await new Promise(r => setTimeout(r, 200));
    check("onclick inline closeModal fonctionne", document.getElementById("modal").classList.contains("hidden"));
  }

  /* 9. Diagnostic : closeModal est-elle bien globale ? (indispensable aux onclick inline) */
  const globale = typeof window.closeModal === "function";
  check("closeModal exposée globalement (window.closeModal)", globale);

  console.log(fails === 0 ? "\n🎉 MODALES OK en local — le problème vient donc du déploiement Render (cache/ancien JS)"
                          : "\n💥 " + fails + " échec(s) — problème REPRODUIT en local, voir ci-dessus");
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error("💥", e.message); process.exit(1); });
