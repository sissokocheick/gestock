"use strict";
/* ============================================================
   Gestion Stock & Vente - PWA connectée au backend PostgreSQL
   Toutes les données passent par l'API (http://localhost:4000)
   ============================================================ */

const API_BASE = localStorage.getItem("gs_api") || location.origin; // same-origin (proxy du serveur d'app) ou backend direct via gs_api
const API = API_BASE + "/api";
const WS_URL = API_BASE.replace(/^http/, "ws") + "/ws";

const $ = s => document.querySelector(s);
const $$ = s => { try { return [...document.querySelectorAll(s)]; } catch(e) { return []; } };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = n => Number(n || 0).toLocaleString("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " " + ((DB.boutique && DB.boutique.devise) || "F");
const fmtDate = iso => new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const fmtDateOnly = iso => { if (!iso) return "-"; const s = String(iso).slice(0, 10); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + "/" + m[2] + "/" + m[1] : s; };
const todayKey = (d) => { const x = d || new Date(); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function readImage(file, maxDim) {
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = reject;
      img.src = rd.result;
    };
    rd.onerror = reject;
    rd.readAsDataURL(file);
  });
}

const droitLabel = code => { const d = (DB.droits || []).find(x => x.code === code); return d ? d.label : code; };

/* ---------- couche API + mode hors-ligne ---------- */
let token = localStorage.getItem("gs_token") || null;
// Auto-restore session on page load
if (token) {
  // Will be validated in init()
}
async function restoreSession() {
  if (!token) { showLogin(); return; }
  try {
    const me = await api("/auth/me");
    cur = me;
    await showApp();
  } catch (e) {
    // Token expired — clear and show login
    localStorage.removeItem("gs_token");
    token = null;
    showLogin();
  }
}
let cur = null;
let DB = { boutique: { devise: "F" }, produits: [], familles: [], roles: [], recap: [], modes: [], caisses: [], droits: [], params: [], typesMv: [], lots: [], fournisseurs: [], commandes: [] };
let cart = [], camStream = null, scanTimer = null, curView = "accueil", ws = null, usbPrinter = null;

const QUEUE_KEY = "gs_queue";
function queueLoad() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch (e) { return []; } }
function queueSave(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
async function replayQueue() {
  const q = queueLoad();
  if (!q.length) return;
  const rest = [];
  let envoyees = 0;
  for (const item of q) {
    try {
      const r = await fetch(API + item.path, {
        method: item.method,
        headers: { "Content-Type": "application/json", ...(item.auth && token ? { Authorization: "Bearer " + token } : {}) },
        body: item.body,
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) { rest.push(item); continue; }
      envoyees++;
    } catch (e) { rest.push(item); }
  }
  queueSave(rest);
  if (envoyees) toast(envoyees + " action(s) en attente envoyée(s) ✅");
  if (rest.length === 0 && renderers[curView]) renderers[curView]().catch(() => { });
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers.Authorization = "Bearer " + token;
  let res;
  try { res = await fetch(API + path, { ...opts, headers }); }
  catch (e) {
    if (opts.method && opts.method !== "GET") {
      const q = queueLoad();
      q.push({ path, method: opts.method, body: opts.body, auth: !!token, label: opts._label || path });
      queueSave(q);
      throw new Error("📡 Hors ligne : l'action a été mise en attente et sera envoyée à la reconnexion (" + q.length + " en attente)");
    }
    const cache = sessionStorage.getItem("gs_cache_" + path);
    if (cache) return JSON.parse(cache);
    throw new Error("Serveur injoignable (" + API_BASE + ") - démarrez le backend");
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && (!opts.method || opts.method === "GET")) sessionStorage.setItem("gs_cache_" + path, JSON.stringify(data));
  if (res.status === 401) { doLogout(); throw new Error("Session expirée, reconnectez-vous"); }
  if (!res.ok) throw new Error(data.error || "Erreur serveur");
  replayQueue().catch(() => { });
  return data;
}
window.addEventListener("online", () => replayQueue().catch(() => { }));
function hasRight(r) { if (!cur) return false; if (cur.role === "admin") return true; return (cur.droits || []).includes(r); }
const modeInfo = code => (DB.modes || []).find(m => m.code === code);
const modeLabel = code => { const m = modeInfo(code); return m ? m.nom : code; };
const modeEspeces = code => { const m = modeInfo(code); return !!(m && m.especes); };
const getParam = k => { const p = (DB.params || []).find(x => x.cle === k); return p ? p.valeur : null; };
const remiseMaxPct = () => { const raw = getParam("remise_max_pct"); return (raw === null || raw === undefined || raw === "") ? 100 : Math.max(0, Number(raw) || 0); };
const clampRemise = (total, rem) => {
  const pct = remiseMaxPct();
  if (pct <= 0) return 0;
  return Math.min(rem, Math.floor(total * pct / 100));
};
/* Info-bulle automatique sur les cellules de tableau tronquées (ellipsis) */
document.addEventListener("mouseover", e => {
  const td = e.target.closest && e.target.closest("td");
  if (td && td.scrollWidth > td.clientWidth + 2 && !td.dataset.tt) { td.dataset.tt = "1"; td.title = td.textContent.trim(); }
});
const reglePoint = () => ((DB.boutique || {}).point_regle || "La caissière clôture elle-même sa caisse le soir ; la caissière principale valide ensuite chaque clôture. Montant à verser = total des espèces attendues au tiroir.");
function produitById(id) { return DB.produits.find(p => String(p.id) === String(id)); }

/* ---------- pagination générique (10 / 50 / 100 lignes) ---------- */
const PG_SIZES = [10, 50, 100];
const pgState = {};
function pgGet(key) { return pgState[key] || (pgState[key] = { page: 0, size: 10 }); }
function pgReset(key) { const s = pgGet(key); s.page = 0; return s; }
function pgSlice(key, arr) {
  const s = pgGet(key);
  const total = arr.length;
  const pages = Math.max(1, Math.ceil(total / s.size));
  if (s.page >= pages) s.page = pages - 1;
  const start = s.page * s.size;
  return { part: arr.slice(start, start + s.size), total, pages, page: s.page, start, size: s.size };
}
function pgBar(key, total, label) {
  const s = pgGet(key);
  const pages = Math.max(1, Math.ceil(total / s.size));
  if (s.page >= pages) s.page = pages - 1;
  return `<div class="pg-bar" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:8px 0">
    <span class="muted">${total} ${label || "ligne(s)"} · page ${s.page + 1}/${pages}</span>
    <select class="pg-size" data-pg="${key}" style="width:auto;padding:6px 8px" title="Lignes par page">
      ${PG_SIZES.map(n => `<option value="${n}" ${n === s.size ? "selected" : ""}>${n} lignes</option>`).join("")}
    </select>
    <button class="btn small pg-prev" data-pg="${key}" ${s.page <= 0 ? "disabled" : ""}>⬅️ Précédent</button>
    <button class="btn small pg-next" data-pg="${key}" ${s.page + 1 >= pages ? "disabled" : ""}>Suivant ➡️</button>
  </div>`;
}
function pgRefresh(key) {
  if (key === "mouvements") { renderMouvements(); return; }
  if (key === "rapport") { genRapport().catch(e => toast(e.message)); return; }
  if (key === "cVentes") { if (typeof renderCaisseVentes === "function") renderCaisseVentes(); return; }
  if (renderers[curView]) renderers[curView]().catch(e => toast(e.message));
}
document.addEventListener("change", e => {
  const sel = e.target.closest(".pg-size");
  if (!sel) return;
  const k = sel.dataset.pg; const s = pgState[k]; if (!s) return;
  s.size = Number(sel.value); s.page = 0;
  pgRefresh(k);
});
document.addEventListener("click", e => {
  const b = e.target.closest(".pg-prev, .pg-next");
  if (!b) return;
  const k = b.dataset.pg; const s = pgState[k]; if (!s) return;
  s.page += b.classList.contains("pg-prev") ? -1 : 1;
  pgRefresh(k);
});

/* ---------- temps réel ---------- */
function connectWS() {
  if (!token) return;
  try { ws = new WebSocket(WS_URL); } catch (e) { return; }
  ws.onmessage = e => {
    try {
      const m = JSON.parse(e.data);
      if (m && m.type) {
    if (m.type === "versement_demande" || m.type === "versement_valide" || m.type === "versement_refuse" || m.type === "caisse") checkNotifVersements();
    if (renderers[curView]) renderers[curView]().catch(() => { });
  }
    } catch (err) { }
  };
  ws.onclose = () => { ws = null; setTimeout(connectWS, 3000); };
}

/* ---------- connexion ---------- */
async function doLogin() {
  const nom = $("#loginUser").value.trim();
  const mdp = $("#loginPass").value;
  if (!nom || !mdp) { showLoginErr("Nom et mot de passe obligatoires"); return; }
  try {
    const r = await api("/auth/login", { method: "POST", body: JSON.stringify({ nom, mdp }) });
    token = r.token; localStorage.setItem("gs_token", token);
    cur = r.user;
    $("#loginPass").value = "";
    await showApp();
  } catch (e) { showLoginErr(e.message); }
}
function showLoginErr(msg) { $("#loginErr").textContent = msg; $("#loginErr").classList.remove("hidden"); }
function doLogout() {
  token = null; localStorage.removeItem("gs_token");
  if (ws) { try { ws.close(); } catch (e) { } ws = null; }
  cur = null; cart = [];
  $("#app").classList.add("hidden"); $("#login").classList.remove("hidden");
}
async function showApp() {
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#curUser").textContent = `${cur.nom} - ${roleLabel(cur.role)}`;
  try {
    DB.boutique = await api("/boutique");
    DB.roles = await api("/roles");
    DB.modes = await api("/modes-paiement");
    DB.droits = await api("/droits");
    DB.params = await api("/parametres");
  } catch (e) { toast(e.message); }
  // Re-affiche le nom avec le libellé du rôle (chargé juste au-dessus)
  $("#curUser").textContent = `${cur.nom} - ${roleLabel(cur.role)}`;
  applyBrand(); buildNav(); go(hasRight("R_RAPPORTS") ? "accueil" : "vente"); connectWS();
}
function roleLabel(code) {
  const r = DB.roles.find(x => x.code === code);
  return r ? r.label : code;
}
function applyBrand() {
  const b = DB.boutique || {};
  $("#brandName").textContent = b.nom || "Boutique";
  const lg = $("#brandLogo");
  if (b.logo) { lg.src = b.logo; lg.classList.remove("hidden"); } else { lg.classList.add("hidden"); }
  const lk = $("#loginLogo");
  if (b.logo) lk.innerHTML = `<img src="${b.logo}" style="width:56px;height:56px;object-fit:contain;border-radius:12px">`;
  else lk.textContent = "🏪";
}
function buildNav() {
  $$("#sideNav .nav-link").forEach(a => {
    const r = a.dataset.right;
    a.classList.toggle("hidden", r && !hasRight(r));
  });
  // L'accueil (Tableau de bord) reste toujours visible dans le menu
  const acc = document.querySelector('#sideNav a[data-view="accueil"]');
  if (acc) acc.classList.remove("hidden");
  const nav = $("#sideNav");
  if (nav) nav.scrollLeft = 0;
}
function go(view) {
  curView = view;
  try { localStorage.setItem("gs_curView", view); } catch(e) {}
  curView = view;
  $$(".view").forEach(v => v.classList.remove("active"));
  const el = $("#view-" + view);
  if (!el) return;
  el.classList.add("active");
  $$("#sideNav .nav-link").forEach(a => a.classList.toggle("active", a.dataset.view === view));
  // Le menu revient au début : le lien « Tableau de bord » reste visible
  const nav = $("#sideNav");
  if (nav) nav.scrollLeft = 0;
  viewLoading(view);
  if (renderers[view]) renderers[view]().catch(e => {
    const msg = String((e && e.message) || e);
    if (/injoignable|hors ligne|Failed to fetch|network/i.test(msg)) viewErreurReseau(view);
    else toast(e.message || "Erreur");
  });
}

/* ---------- chargement & erreur réseau ---------- */
const VIEW_BOX = { accueil: "#dashCards", vente: "#venteGrid", releve: "#releveBox", produits: "#prodWrap", stock: "#stockWrap", point: "#pointBox", users: "#usersWrap", rapports: "#rapportBox", journal: "#journalWrap", params: "#paramsBox", stockmod: "#stockmodBox" };
function viewLoading(view) {
  const sel = VIEW_BOX[view];
  if (sel) { const el = $(sel); if (el) el.innerHTML = `<div class="empty">⏳ Chargement…</div>`; }
}
function viewErreurReseau(view) {
  const sel = VIEW_BOX[view];
  if (sel) { const el = $(sel); if (el) el.innerHTML = `<div class="empty" style="padding:36px 16px">
    <div style="font-size:36px">📡</div>
    <b>Connexion au serveur perdue</b><br>
    <span class="muted">Vérifiez que le serveur fonctionne, puis réessayez.</span><br><br>
    <button class="btn primary" onclick="go('${view}')">🔄 Réessayer</button>
  </div>`; }
}
const renderers = {};

/* ---------- accueil ---------- */
renderers.accueil = async function () {
  const k = todayKey();
  const [vts, prods] = await Promise.all([api("/ventes?date=" + k), api("/produits")]);
  DB.produits = prods;
  // Les caissières ne voient aucune information de gestion
  if (!hasRight("R_RAPPORTS")) {
    const mine = vts.filter(v => String(v.user_id) === String(cur.id));
    $("#dashCards").innerHTML = `
      <div class="card"><div class="k">Bienvenue</div><div class="v" style="font-size:17px">${esc(cur.nom)}</div></div>
      <div class="card"><div class="k">Mes ventes aujourd'hui</div><div class="v">${mine.length} ticket(s)</div></div>`;
    $("#dashAlerts").innerHTML = `<div class="empty">🛒 Ouvrez l'onglet <b>Caisse</b> pour encaisser.<br>Les informations de gestion (bénéfices, stock, rapports) sont réservées à la gérante.</div>`;
    $("#dashTop").innerHTML = "";
    return;
  }
  const ca = vts.reduce((s, v) => s + Number(v.net), 0);
  const ben = vts.reduce((s, v) => s + Number(v.benefice || 0), 0);
  const valStock = prods.reduce((s, p) => s + Number(p.prix_achat) * Number(p.stock), 0);
  $("#dashCards").innerHTML = `
    <div class="card"><div class="k">Chiffre d'affaires</div><div class="v">${money(ca)}</div></div>
    <div class="card"><div class="k">Bénéfice du jour</div><div class="v ok">${money(ben)}</div></div>
    <div class="card"><div class="k">Tickets</div><div class="v">${vts.length}</div></div>
    <div class="card"><div class="k">Valeur du stock</div><div class="v">${money(valStock)}</div></div>
    <div class="card"><div class="k">Produits</div><div class="v">${prods.filter(p => p.actif).length}</div></div>`;
  const alerts = prods.filter(p => p.actif && Number(p.stock) <= Number(p.stock_min));
  $("#dashAlerts").innerHTML = alerts.length === 0
    ? `<div class="empty">✅ Aucune alerte stock aujourd'hui</div>`
    : `<div class="table-wrap"><table><tr><th>Produit</th><th>Stock</th><th>Seuil mini</th><th>Statut</th></tr>` +
      alerts.map(p => `<tr><td>${esc(p.nom)}</td><td class="num">${p.stock}</td><td class="num">${p.stock_min}</td><td><span class="badge ${Number(p.stock) <= 0 ? "bad" : "warn"}">${Number(p.stock) <= 0 ? "Rupture" : "Stock bas"}</span></td></tr>`).join("") + `</table></div>`;
  const q = {};
  vts.forEach(v => (v.items || []).forEach(i => { q[i.nom] = (q[i.nom] || 0) + Number(i.qte); }));
  const top = Object.entries(q).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $("#dashTop").innerHTML = top.length === 0
    ? `<div class="empty">Aucune vente aujourd'hui - faites une vente dans l'onglet Caisse</div>`
    : `<div class="table-wrap"><table><tr><th>Produit</th><th>Quantité vendue</th></tr>` + top.map(t => `<tr><td>${esc(t[0])}</td><td class="num">${t[1]}</td></tr>`).join("") + `</table></div>`;
  let j7 = [];
  try { j7 = await api("/rapports/7jours"); } catch (e) { }
  const max = Math.max(...j7.map(j => Number(j.ca)), 1);
  const jourCourt = j => new Date(String(j.jour).slice(0, 10) + "T00:00:00").toLocaleDateString("fr-FR", { weekday: "short" });
  $("#dashChart").innerHTML = j7.length === 0
    ? `<div class="empty">Aucune vente sur les 7 derniers jours</div>`
    : `<div class="bars">${j7.map(j => `
      <div class="bar-col" title="${String(j.jour).slice(0, 10)} - ${money(j.ca)} · ${j.tickets} ticket(s) · bénéfice ${money(j.ben)}">
        <div class="bar" style="height:${Math.max(4, Math.round(Number(j.ca) / max * 100))}%"></div>
        <span class="bar-lbl">${jourCourt(j)}</span>
      </div>`).join("")}</div>`;
};

/* ---------- vente ---------- */
let venteFilter = "";
renderers.vente = async function () {
  try { DB.produits = await api("/produits"); } catch (e) { toast(e.message); return; }
  try { DB.caisse = await api("/caisse/moi"); } catch (e) { DB.caisse = null; }
  fillModeSelect();
  const selF = $("#venteFamille");
  const curF = selF.value;
  selF.innerHTML = `<option value="">Toutes les familles</option>` + [...new Set(DB.produits.map(p => p.famille).filter(Boolean))].map(fm => `<option ${curF === fm ? "selected" : ""}>${esc(fm)}</option>`).join("");
  renderCaisseBar();
  if (DB.caisse) { renderVenteGrid(); renderCart(); setTimeout(function() { var vs = document.getElementById("venteSearch"); if (vs) { vs.focus(); vs.select(); } }, 100); }
};
function fillModeSelect() {
  const sel = $("#cartMode");
  const cur = sel.value;
  sel.innerHTML = (DB.modes || []).filter(m => m.actif).map(m => `<option value="${esc(m.code)}">${esc(m.nom)}</option>`).join("");
  if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
}
function renderCaisseBar() {
  const bar = $("#caisseBar");
  const layout = document.querySelector(".vente-layout");
  if (!DB.caisse) {
    bar.innerHTML = `<div class="panel" style="max-width:480px;margin:6px auto">
      <h3>🟢 Ouvrir votre caisse</h3>
      <p class="muted">Pour encaisser, ouvrez d'abord votre caisse du jour. Une seule caisse ouverte à la fois.</p>
      <label class="field">Fonds de départ dans le tiroir (F, facultatif) <input id="caisseFonds" type="number" min="0" value="0" placeholder="ex. 25000"></label>
      <button class="btn primary block" id="caisseOuvrirBtn">🟢 Ouvrir ma caisse</button>
    </div>`;
    layout.classList.add("hidden");
    $("#caisseOuvrirBtn").addEventListener("click", async () => {
      try {
        await api("/caisse/ouvrir", { method: "POST", body: JSON.stringify({ fonds_initial: Number($("#caisseFonds").value) || 0 }) });
        toast("Caisse ouverte ✅");
        renderers.vente().catch(() => { });
      } catch (e) { toast(e.message); }
    });
    return;
  }
  const c = DB.caisse;
  bar.innerHTML = `
    <div class="panel" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between">
      <div>
        <b style="color:var(--ok)">🟢 Caisse ouverte</b> depuis ${new Date(c.ouverte_le).toLocaleTimeString("fr-FR")}
        · Fonds : ${money(c.fonds_initial)}
        · Ventes : ${money(c.total)} (${c.tickets} ticket${c.tickets > 1 ? "s" : ""})
        · 
      </div>
      <div class="row">
        <button class="btn small" id="caisseVersBtn">➕ Versement</button>
        <button class="btn small danger" id="caisseClotBtn">🔴 Clôturer ma caisse</button>
      </div>
    </div>`;
  layout.classList.remove("hidden");
  $("#caisseVersBtn").addEventListener("click", () => versementForm(c));
  $("#caisseClotBtn").addEventListener("click", () => clotureForm(c));
}
function versementForm(c) {
  openModal(`<h3>➕ Versement de caisse</h3>
    <p class="muted">Remise d'argent en cours de journée (au gérant, dépôt...) - déduite de votre caisse.</p>
    <label class="field">Montant (F) <input id="vsMontant" type="number" min="1"></label>
    <label class="field">Mode
      <select id="vsMode">${(DB.modes || []).filter(m => m.actif).map(m => `<option value="${esc(m.code)}">${esc(m.nom)}</option>`).join("")}</select>
    </label>
    <label class="field">Motif (facultatif) <input id="vsMotif" placeholder="ex. remise au gérant à 15h"></label>
    <div class="row"><button class="btn success grow" id="vsSave">💰 Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  $("#vsSave").addEventListener("click", async () => {
    const m = Number($("#vsMontant").value) || 0;
    if (m <= 0) { toast("Montant invalide"); return; }
    askConfirm("Confirmation", `Confirmer le versement de <b>${money(m)}</b> (${modeLabel($("#vsMode").value)}) sur la caisse ?`, async () => {
      try {
        await api(`/caisse/${c.id}/versement`, { method: "POST", body: JSON.stringify({ montant: m, mode: $("#vsMode").value, motif: $("#vsMotif").value }) });
        toast("Versement enregistré ✅"); closeModal();
        renderers.vente().catch(() => { });
      } catch (e) { toast(e.message); }
    }, { okLabel: "Enregistrer" });
  });
}
function clotureForm(c) {
  const rows = (c.versements || []).map(v => `<tr><td>${fmtDate(v.date)}</td><td class="num">${money(v.montant)}</td><td>${esc(modeLabel(v.mode))}</td><td>${esc(v.motif || "-")}</td></tr>`).join("");
  openModal(`<h3>Cloturer votre caisse</h3>
    <div class="cards" style="margin:8px 0">
      <div class="card"><div class="k">Fonds de depart</div><div class="v">${money(c.fonds_initial)}</div></div>
      <div class="card"><div class="k">Ventes especes</div><div class="v">${money(c.especes)}</div></div>
      <div class="card"><div class="k">Verse (especes)</div><div class="v">${money(c.verse_especes)}</div></div>
      <div class="card"><div class="k">Total ventes</div><div class="v">${money(c.total)}</div></div>
    </div>
    <div class="table-wrap"><table><tr><th>Date</th><th class="num">Montant</th><th>Mode</th><th>Motif</th></tr>${rows || `<tr><td colspan="4" class="empty">Aucun versement</td></tr>`}</table></div>
    <p class="muted" style="margin-top:8px">Comptez votre tiroir (especes) et saisissez le montant trouve.</p>
    <label class="field">Argent compte dans le tiroir (F) <input id="ctCompte" type="number" min="0" value="${c.attendu_especes}"></label>
    <label class="field">Notes <input id="ctNotes" placeholder="ex. ecart explique..."></label>
    <p id="ctWarn" class="error hidden"></p>
    <div class="row"><button class="btn danger grow" id="ctSave">Cloturer la caisse</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  const syncClot = () => {
    const ecart = (Number(document.getElementById("ctCompte").value) || 0) - c.attendu_especes;
    const note = document.getElementById("ctNotes").value.trim();
    const w = document.getElementById("ctWarn");
    if (ecart !== 0) {
      w.classList.remove("hidden");
      w.textContent = "Ecart de " + (ecart > 0 ? "+" : "") + money(ecart) + " - explication obligatoire."; document.getElementById("ctSave").disabled = !note;
    } else { w.classList.add("hidden"); document.getElementById("ctSave").disabled = false; }
  };
  document.getElementById("ctCompte").addEventListener("input", syncClot);
  document.getElementById("ctNotes").addEventListener("input", syncClot);
  syncClot();
  document.getElementById("ctSave").addEventListener("click", async () => {
    const btn = document.getElementById("ctSave"); btn.disabled = true;
    try {
      const r = await api(`/caisse/${c.id}/cloturer`, { method: "POST", body: JSON.stringify({ compte: Number(document.getElementById("ctCompte").value) || 0, notes: document.getElementById("ctNotes").value }) });
      cart = []; closeModal();
      openModal(`<h3>Caisse cloturee</h3>
        <div class="ticket-preview"><pre style="font-family:'Courier New',monospace">CLOTURE DE CAISSE
${new Date().toLocaleString("fr-FR")}
Caissiere : ${esc(cur.nom)}
Fonds : ${money(c.fonds_initial)}
Ventes : ${money(c.total)} (${c.tickets} tickets)
Especes attendues : ${money(r.total_attendu)}
Montant compte : ${money(r.total_compte)}
Ecart : ${r.ecart >= 0 ? "+" : ""}${money(r.ecart)}
${r.ecart !== 0 ? "ECART A VERIFIER" : "Aucun ecart"}</pre></div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary grow" id="ctPrintBtn">Imprimer le recu</button>
          <button class="btn ghost grow" onclick="closeModal()">Fermer</button>
        </div>`);
      document.getElementById("ctPrintBtn").addEventListener("click", () => imprimer("Recu de cloture", `<pre style="font-family:'Courier New',monospace">CLOTURE DE CAISSE\n${new Date().toLocaleString("fr-FR")}\nCaissiere : ${esc(cur.nom)}\nFonds : ${money(c.fonds_initial)}\nVentes : ${money(c.total)} (${c.tickets} tickets)\nEspeces attendues : ${money(r.total_attendu)}\nMontant compte : ${money(r.total_compte)}\nEcart : ${r.ecart >= 0 ? "+" : ""}${money(r.ecart)}</pre>`, "80mm"));
      renderers.vente().catch(() => {});
    } catch (e) { toast(e.message); }
    btn.disabled = false;
  });
}

function renderVenteGrid() {
  const f = venteFilter.toLowerCase();
  const fam = $("#venteFamille") ? $("#venteFamille").value : "";
  const sort = $("#venteSort") ? $("#venteSort").value : "nom";
  let list = DB.produits.filter(p => p.actif && (!f || p.nom.toLowerCase().includes(f) || (p.code || "").includes(f)) && (!fam || p.famille === fam));
  if (sort === "prix") list = [...list].sort((a, b) => Number(a.prix_vente) - Number(b.prix_vente));
  else if (sort === "prixDesc") list = [...list].sort((a, b) => Number(b.prix_vente) - Number(a.prix_vente));
  else list = [...list].sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
  $("#venteGrid").innerHTML = (list.length > 0 ? `<div style="grid-column:1/-1">${pgBar("vente", list.length, "produit(s)")}</div>` : "") +
    (list.length === 0
    ? `<div class="empty">Aucun produit trouvé</div>`
    : pgSlice("vente", list).part.map(p => `
      <div class="prod-card ${Number(p.stock) <= 0 ? "off" : ""}" data-pid="${p.id}">
        ${p.photo ? `<img src="${p.photo}" style="width:100%;height:64px;object-fit:cover;border-radius:8px;margin-bottom:6px">` : ""}
        <div class="pn">${esc(p.nom)}</div>
        <div class="pp">${money(p.prix_vente)}</div>
        <div class="ps">${hasRight("R_RAPPORTS") ? `Stock : ${p.stock}${p.stock_min ? " • min " + p.stock_min : ""}` : (Number(p.stock) <= 0 ? "⚠️ Rupture" : Number(p.stock) <= Number(p.stock_min) ? "⚠️ Stock faible" : "✅ En stock")}</div>
      </div>`).join(""));
  $$("#venteGrid .prod-card").forEach(c => c.addEventListener("click", () => {
    const p = produitById(c.dataset.pid);
    if (p && Number(p.stock) > 0) addToCart(p.id, 1); else toast("Stock insuffisant");
  }));
}
function addToCart(pid, qte) {
  const p = produitById(pid); if (!p) return;
  const line = cart.find(l => String(l.produitId) === String(pid));
  const now = line ? line.qte : 0;
  if (now + qte > Number(p.stock)) { toast("Stock insuffisant"); return; }
  if (line) line.qte += qte; else cart.push({ produitId: p.id, nom: p.nom, prix: Number(p.prix_vente), prixAchat: Number(p.prix_achat), qte });
  renderCart();
}
function renderCart() {
  const wrap = $("#cartLines");
  if (cart.length === 0) { wrap.innerHTML = `<div class="empty">Panier vide - cliquez sur un produit ou scannez un code-barres</div>`; }
  else {
    wrap.innerHTML = cart.map(l => `
      <div class="cart-line">
        <div>${esc(l.nom)}<br><span class="muted">${money(l.prix)} × ${l.qte}</span></div>
        <div class="qty">
          <button data-op="minus" data-pid="${l.produitId}">-</button>
          <b>${l.qte}</b>
          <button data-op="plus" data-pid="${l.produitId}">+</button>
          <button data-op="del" data-pid="${l.produitId}" style="color:var(--danger)">✕</button>
        </div>
      </div>`).join("");
    $$("#cartLines button").forEach(b => b.addEventListener("click", () => {
      const l = cart.find(x => String(x.produitId) === String(b.dataset.pid)); if (!l) return;
      const p = produitById(l.produitId);
      if (b.dataset.op === "plus" && l.qte < Number(p.stock)) l.qte++;
      if (b.dataset.op === "minus") { l.qte--; if (l.qte <= 0) cart = cart.filter(x => x !== l); }
      if (b.dataset.op === "del") cart = cart.filter(x => x !== l);
      renderCart();
    }));
  }
  const total = cart.reduce((s, l) => s + l.prix * l.qte, 0);
  const pct = remiseMaxPct();
  const remiseField = $("#cartRemise");
  const hint = $("#cartRemiseHint");
  if (pct <= 0) {
    remiseField.disabled = true; remiseField.value = 0;
    if (hint) hint.textContent = "Remise désactivée par la direction (0 %)";
  } else {
    remiseField.disabled = false;
    const maxRem = Math.floor(total * pct / 100);
    if (hint) hint.textContent = total > 0 ? `Remise max : ${money(maxRem)} (${pct} %)` : "";
    if (Number(remiseField.value) > maxRem) remiseField.value = maxRem;
  }
  const remise = Math.max(0, Number(remiseField.value) || 0);
  const net = Math.max(0, total - remise);
  $("#cartTotal").textContent = money(net);
  // Le bénéfice n'est visible que pour la gérance (pas les caissières)
  const showBen = hasRight("R_RAPPORTS");
  $("#cartBenefLabel").style.display = showBen ? "" : "none";
  $("#cartBenef").style.display = showBen ? "" : "none";
  if (showBen) $("#cartBenef").textContent = money(cart.reduce((s, l) => s + (l.prix - l.prixAchat) * l.qte, 0) - remise);
  const mode = $("#cartMode").value;
  const esp = modeEspeces(mode);
  $("#recuWrap").classList.toggle("hidden", !esp);
  if (esp) {
    const recu = Number($("#cartRecu").value) || 0;
    $("#cartRendu").textContent = recu >= net ? `Rendu : ${money(recu - net)}` : "Montant reçu insuffisant";
  } else $("#cartRendu").textContent = "";
}
async function encaisser() {
  if (cart.length === 0) { toast("Panier vide"); return; }
  if (!DB.caisse) { toast("Ouvrez votre caisse d'abord"); return; }
  const total = cart.reduce((s, l) => s + l.prix * l.qte, 0);
  const remise = clampRemise(total, Math.max(0, Number($("#cartRemise").value) || 0));
  const net = total - remise;
  if (net <= 0) { toast("Montant invalide"); return; }
  const mode = $("#cartMode").value;
  let recu = net;
  if (modeEspeces(mode)) {
    recu = Number($("#cartRecu").value) || 0;
    if (recu < net) { toast("Montant reçu insuffisant"); return; }
  }
  const nbArt = cart.reduce((s, l) => s + l.qte, 0);
  askConfirm("Confirmer la vente", `Vente de <b>${nbArt} article(s)</b> — total <b>${money(net)}</b>${remise > 0 ? `<br>Remise : <b>${money(remise)}</b>` : ""}<br>Paiement : <b>${esc(modeLabel(mode))}</b>${recu > net ? ` — reçu <b>${money(recu)}</b>, rendu <b>${money(recu - net)}</b>` : ""}<br><span class="muted">Le stock sera réduit automatiquement après confirmation.</span>`, async () => {
    const btn = $("#encaisserBtn"); btn.disabled = true; btn.textContent = "Encaissement...";
    try {
      const v = await api("/ventes", {
        method: "POST",
        body: JSON.stringify({ items: cart.map(l => ({ produitId: l.produitId, qte: l.qte })), remise, mode, recu, ref: "T" + uid().toUpperCase() })
      });
      cart = []; $("#cartRemise").value = 0; $("#cartRecu").value = 0;
      renderCart();
      showTicket(v);
      try { localStorage.setItem("gs_last_ticket", JSON.stringify(v)); } catch(e) {}
      renderers.vente().catch(() => { });
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = "💵 Encaisser";
  }, { icone: "💵", okLabel: "Encaisser" });
}

/* ---------- ticket ---------- */
function ticketHTML(v) {
  const b = DB.boutique || {};
  const head = b.logo
    ? `${b.logo ? `<img src="${b.logo}" style="height:48px">` : ""}<b style="font-size:15px">${esc(b.nom)}</b>\n${esc(b.adresse)} - ${esc(b.tel)}\n`
    : `<b style="font-size:15px">${esc(b.nom || "Boutique")}</b>\n${esc(b.adresse || "")} - ${esc(b.tel || "")}\n`;
  const lines = (v.items || []).map(i => `${esc(i.nom)}\n   ${i.qte} × ${money(i.prix)} = ${money(Number(i.qte) * Number(i.prix))}`).join("\n");
  const modeLabelT = modeLabel(v.mode);
  return `${head}═══════════════════════
TICKET DE CAISSE
${fmtDate(v.date)}
Caissière : ${esc(v.user_nom || "")}
Ticket : ${v.numero}
═══════════════════════
${lines}
${Number(v.remise) ? `Remise : -${money(v.remise)}\n` : ""}
TOTAL : ${money(v.net)}
Paiement : ${modeLabelT}
Reçu : ${money(v.recu)}
${Number(v.rendu) ? `Rendu : ${money(v.rendu)}` : ""}
═══════════════════════
${esc(b.pied)}
${esc(b.email)} - ${esc(b.horaires)}`;
}
function showTicket(v) {
  openModal(`<h3>✅ Vente enregistrée - ${v.numero}</h3>
    <div class="ticket-preview">${esc(ticketHTML(v))}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary grow" id="printTicketBtn">🖨️ Imprimer le ticket</button>
      <button class="btn ghost grow" onclick="closeModal()">Fermer</button>
    </div>`);
  $("#printTicketBtn").addEventListener("click", () => printTicket(v));
  if (usbPrinter) {
    const tb = document.createElement("button");
    tb.className = "btn success grow"; tb.textContent = "🧾 Imprimante thermique";
    tb.addEventListener("click", () => printThermal(v));
    $("#printTicketBtn").parentElement.appendChild(tb);
  }
}

/* ---------- scan ---------- */
let scanQr = null; /* instance Html5Qrcode pour le secours (Safari/Firefox) */
function openScan() {
  openModal(`<h3>📷 Scanner un code-barres</h3>
    <video id="scanVideo" autoplay playsinline></video>
    <p class="muted" id="scanStatus">Initialisation de la caméra...</p>
    <label class="btn ghost" style="justify-content:center;cursor:pointer">📸 Prendre une photo du code
      <input type="file" id="scanFileInput" accept="image/*" capture="environment" class="hidden">
    </label>
    <p class="muted" style="font-size:12px;text-align:center">La photo ouvre directement l'appareil photo — idéal si la vidéo ne démarre pas</p>
    <label class="field">Ou saisir le code manuellement
      <input id="scanManual" placeholder="ex. 6181490000011" inputmode="numeric">
    </label>
    <div class="row">
      <button class="btn primary grow" id="scanAddBtn">Ajouter</button>
      <button class="btn ghost grow" onclick="closeScan()">Fermer</button>
    </div>`);
  const manual = $("#scanManual");
  $("#scanAddBtn").addEventListener("click", () => { addByCode(manual.value); manual.value = ""; });
  manual.addEventListener("keydown", e => { if (e.key === "Enter") { addByCode(manual.value); manual.value = ""; } });
  $("#scanFileInput").addEventListener("change", e => { const f = e.target.files[0]; if (f) scanPhoto(f); });
  startScanVideo();
}
function startScanVideo() {
  const st = $("#scanStatus");
  /* 1er choix : BarcodeDetector natif (Chrome/Edge/Android) */
  if ("BarcodeDetector" in window) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { st.textContent = "📷 Caméra non accessible ici — utilisez la photo 📸 ou la saisie manuelle."; return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).then(stream => {
      camStream = stream; const vid = $("#scanVideo");
      vid.srcObject = stream; st.textContent = "Cherchez le code-barres dans le cadre...";
      const det = new BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e", "qr_code"] });
      scanTimer = setInterval(async () => {
        try {
          const codes = await det.detect(vid);
          if (codes.length) { const c = codes[0].rawValue; if (addByCode(c)) closeScan(); }
        } catch (e) { }
      }, 400);
    }).catch(() => { st.textContent = "📷 Caméra bloquée (autorisation refusée ou page en http). Utilisez la photo 📸 ou la saisie manuelle."; });
    return;
  }
  /* 2e choix : bibliothèque locale html5-qrcode (Safari/Firefox) */
  if (window.Html5Qrcode) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { st.textContent = "📷 Caméra non accessible ici — utilisez la photo 📸 ou la saisie manuelle."; return; }
    try {
      const hq = new Html5Qrcode("scanVideo");
      scanQr = hq;
      st.textContent = "Démarrage de la caméra...";
      hq.start({ facingMode: "environment" }, { fps: 10, qrbox: { width: 220, height: 150 } },
        code => { if (addByCode(code.decodedText)) closeScan(); },
        () => { }
      ).catch(() => { st.textContent = "📷 Caméra bloquée (autorisation refusée ou page en http). Utilisez la photo 📸 ou la saisie manuelle."; });
    } catch (e) { st.textContent = "📷 Caméra non disponible — utilisez la photo 📸 ou la saisie manuelle."; }
    return;
  }
  st.textContent = "📷 Ce navigateur ne lit pas la caméra — utilisez la photo 📸 ou la saisie manuelle.";
}
async function scanPhoto(file) {
  const st = $("#scanStatus");
  st.textContent = "Lecture de la photo...";
  try {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    let code = null;
    if ("BarcodeDetector" in window) {
      try {
        const det = new BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e", "qr_code"] });
        const codes = await det.detect(img);
        if (codes.length) code = codes[0].rawValue;
      } catch (e) { }
    }
    if (!code && window.Html5Qrcode) {
      try {
        const hq = new Html5Qrcode("scanVideo");
        const res = await hq.scanFile(file, false);
        if (res && res.decodedText) code = res.decodedText;
      } catch (e) { }
    }
    URL.revokeObjectURL(img.src);
    if (code && addByCode(code)) { closeScan(); return; }
    st.textContent = "Code non trouvé sur la photo — réessayez ou saisissez le code manuellement.";
  } catch (e) { st.textContent = "Impossible de lire la photo — saisissez le code manuellement."; }
}
function addByCode(code) {
  const c = String(code || "").trim();
  if (!c) return false;
  const p = DB.produits.find(x => x.actif && (x.code || "").trim() === c);
  if (!p) { toast("Produit introuvable : " + c); return false; }
  addToCart(p.id, 1); toast(`Ajouté : ${p.nom}`);
  return true;
}
function closeScan() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  if (scanQr) { try { scanQr.stop().then(() => {}).catch(() => {}); } catch (e) { } scanQr = null; }
  closeModal();
}

/* ---------- mon relevé ---------- */
renderers.releve = async function () {
  let vts = [], caisse = null;
  try { const r = await Promise.all([api("/releve"), api("/caisse/moi")]); vts = r[0]; caisse = r[1]; } catch (e) { toast(e.message); }
  const byMode = {};
  vts.forEach(v => byMode[v.mode] = (byMode[v.mode] || 0) + Number(v.net));
  const ca = vts.reduce((s, v) => s + Number(v.net), 0);
  const modeCards = Object.keys(byMode).map(code => `<div class="card"><div class="k">${esc(modeLabel(code))}</div><div class="v">${money(byMode[code])}</div></div>`).join("");
  $("#releveBox").innerHTML = `
    <p class="muted">Lecture seule - votre relevé du ${new Date().toLocaleDateString("fr-FR")}</p>
    <div class="cards">
      <div class="card"><div class="k">Mes ventes</div><div class="v">${money(ca)}</div></div>
      ${modeCards}
      <div class="card"><div class="k">Tickets</div><div class="v">${vts.length}</div></div>
      ${caisse ? `<div class="card"><div class="k">Ma caisse - ouverte depuis ${new Date(caisse.ouverte_le).toLocaleTimeString("fr-FR")}</div><div class="v" style="font-size:14px">Fonds ${money(caisse.fonds_initial)} · Versé ${money(caisse.verse_total)} · </b></div></div>` : `<div class="card"><div class="k">Ma caisse</div><div class="v" style="font-size:14px">Aucune caisse ouverte - ouvrez-la dans l'onglet Caisse</div></div>`}
    </div>
    ${vts.length > 0 ? pgBar("releve", vts.length, "ticket(s)") : ""}
    <div class="table-wrap"><table><tr><th>Ticket</th><th>Heure</th><th>Articles</th><th>Total</th><th>Paiement</th></tr>` +
    (vts.length === 0 ? `<tr><td colspan="5" class="empty">Aucune vente aujourd'hui</td></tr>` :
      pgSlice("releve", vts).part.map(v => `<tr><td>${v.numero}</td><td>${fmtDate(v.date)}</td><td class="num">${(v.items || []).reduce((s, i) => s + Number(i.qte), 0)}</td><td class="num">${money(v.net)}</td><td>${esc(modeLabel(v.mode))}</td></tr>`).join("")) +
    `</table></div>`;
};

/* ---------- produits ---------- */
let prodMasqInactifs = true;
renderers.produits = async function () {
  let list = [];
  try {
    const [prods, fams] = await Promise.all([api("/produits"), api("/familles")]);
    DB.produits = prods; DB.familles = fams;
    list = prods;
  } catch (e) { toast(e.message); return; }
  const sel = $("#prodFamilleFilter");
  const fams = DB.familles;
  sel.innerHTML = `<option value="">Toutes les familles</option>` + fams.map(f => `<option ${sel.value === f.nom ? "selected" : ""}>${esc(f.nom)}</option>`).join("");
  const f = $("#prodSearch").value.toLowerCase();
  const shown = list.filter(p => (!prodMasqInactifs || p.actif) && (!sel.value || p.famille === sel.value) && (!f || p.nom.toLowerCase().includes(f) || (p.code || "").includes(f)));
  $("#prodWrap").innerHTML = shown.length === 0 ? `<div class="empty">${prodMasqInactifs ? "Aucun produit actif - décochez \"Masquer inactifs\" pour tout voir" : "Aucun produit"}</div>` : `
    <p class="muted" style="margin:0 0 8px">${shown.length} produit(s)${prodMasqInactifs ? " - produits inactifs masqués" : ""}</p>
    ${shown.length > 0 ? pgBar("produits", shown.length, "produit(s)") : ""}
    <div class="table-wrap prod-table-d"><table>
      <tr><th>Photo</th><th>Produit</th><th>Famille</th><th>Code-barres</th><th class="num">Prix achat</th><th class="num">Prix vente</th><th class="num">Bénéfice</th><th class="num">Stock</th><th class="sticky-r">Actions</th></tr>
      ${pgSlice("produits", shown).part.map(p => `<tr>
        <td>${p.photo ? `<img src="${p.photo}" style="width:36px;height:36px;object-fit:cover;border-radius:6px">` : "-"}</td>
        <td>${esc(p.nom)} ${p.reference ? `<span class="muted" style="font-size:11px;font-family:monospace">${esc(p.reference)}</span>` : ""} ${p.gere_par_lot ? `<span class="badge info" style="font-size:10px">📦 Lot</span>` : ""} ${p.actif ? "" : `<span class="badge off">inactif</span>`}</td>
        <td>${esc(p.famille || "")}</td>
        <td>${esc(p.code || "-")}</td>
        <td class="num">${money(p.prix_achat)}</td>
        <td class="num">${money(p.prix_vente)}</td>
        <td class="num">${money(Number(p.prix_vente) - Number(p.prix_achat))}</td>
        <td class="num"><span class="badge ${Number(p.stock) <= 0 ? "bad" : Number(p.stock) <= Number(p.stock_min) ? "warn" : "ok"}">${p.stock}</span></td>
        <td class="sticky-r"><div class="actions">
          <button class="btn small" data-edit="${p.id}">✏️ Modifier</button>
          <button class="btn small" data-label="${p.id}">🏷️ Étiquette</button>
        </div></td>
      </tr>`).join("")}
    </table></div>
    <div class="prod-list-m">
      ${pgSlice("produits", shown).part.map(p => `
      <div class="prod-card-m">
        <div class="pcm-head">
          <div class="pcm-name">${esc(p.nom)}${p.gere_par_lot ? ` <span class="badge info" style="font-size:10px">📦</span>` : ""}${p.actif ? "" : ` <span class="badge off">inactif</span>`}</div>
          <span class="badge ${Number(p.stock) <= 0 ? "bad" : Number(p.stock) <= Number(p.stock_min) ? "warn" : "ok"}">${Number(p.stock) <= 0 ? "Rupture" : Number(p.stock) <= Number(p.stock_min) ? "Stock bas" : "En stock"} · ${p.stock}</span>
        </div>
        <div class="pcm-meta">${esc(p.famille || "Sans famille")}${p.code ? ` · <span class="mono">${esc(p.code)}</span>` : ""}</div>
        <div class="pcm-prices">
          <span>Achat <b>${money(p.prix_achat)}</b></span>
          <span>Vente <b>${money(p.prix_vente)}</b></span>
          <span>Marge <b class="ok">${money(Number(p.prix_vente) - Number(p.prix_achat))}</b></span>
        </div>
        <div class="pcm-actions">
          <button class="btn small" data-edit="${p.id}">✏️ Modifier</button>
          <button class="btn small ghost" data-label="${p.id}">🏷️ Étiquette</button>
        </div>
      </div>`).join("")}
    </div>`;
  $$("#prodWrap [data-edit]").forEach(b => b.addEventListener("click", () => prodForm(produitById(b.dataset.edit))));
  $$("#prodWrap [data-label]").forEach(b => b.addEventListener("click", () => {
    const p = produitById(b.dataset.label);
    const svg = barcodeSVG(p.code);
    imprimer("Étiquette " + p.nom, `<div style="font-family:'Courier New',monospace;text-align:center;padding:8px">
      <b>${esc((DB.boutique || {}).nom || "")}</b><br><span style="font-size:18px">${esc(p.nom)}</span><br>
      <span style="font-size:24px;font-weight:800">${money(p.prix_vente)}</span><br>
      ${svg ? `<div style="margin:8px auto;width:fit-content">${svg}</div>` : `<span style="letter-spacing:3px;font-size:14px">${esc(p.code || "")}</span>`}
    </div>`, "80mm");
  }));
};
function prodForm(p) {
  const isNew = !p;
  p = p || { famille: "", code: "", prix_achat: 0, prix_vente: 0, stock: 0, stock_min: 0, actif: true };
  openModal(`<h3>${isNew ? "Nouveau produit" : "Modifier : " + esc(p.nom)}</h3>
    <label class="field">Nom <input id="pfNom" value="${esc(p.nom || "")}"></label>
    <div class="row"><label class="field grow">Famille <input id="pfFamille" list="famList" value="${esc(p.famille || "")}"></label>
      <datalist id="famList">${(DB.familles || []).map(f => `<option value="${esc(f.nom)}">`).join("")}</datalist>
      <label class="field grow">Code-barres <input id="pfCode" value="${esc(p.code || "")}" placeholder="6181490000011"></label></div>
    <div class="panel" style="margin-top:4px">
      <b style="font-size:13px">📷 Photo du produit</b>
      <div id="pfPhotoPrev" style="margin-top:6px">${p.photo ? `<img src="${p.photo}" style="max-height:110px;border-radius:8px">` : `<span class="muted">Aucune photo</span>`}</div>
      <div class="row" style="margin-top:6px">
        <button class="btn small primary" id="pfPhotoCam" type="button">📷 Prendre une photo</button>
        <button class="btn small" id="pfPhotoLoad" type="button">📁 Charger une photo</button>
        <button class="btn small" id="pfPhotoDel" type="button">🗑️ Retirer</button>
      </div>
      <input type="file" id="pfPhotoCamInput" accept="image/*" capture="environment" class="hidden">
      <input type="file" id="pfPhotoLoadInput" accept="image/*" class="hidden">
    </div>
    <div class="row">
      <label class="field grow">Prix achat unité (F) <input id="pfPA" type="number" min="0" value="${p.prix_achat || ""}"></label>
      <label class="field grow">Prix vente unité (F) <input id="pfPV" type="number" min="0" value="${p.prix_vente || ""}"></label>
    </div>
    <div class="panel" style="margin-top:4px">
      <b style="font-size:13px">🧮 OU calcul automatique : prix d'un carton / paquet</b>
      <div class="row">
        <label class="field grow">Prix du carton (F) <input id="pfCarton" type="number" min="0" placeholder="ex. 12000"></label>
        <label class="field grow">Quantité dans le carton <input id="pfCartonQte" type="number" min="1" placeholder="ex. 24"></label>
      </div>
      <p class="muted" id="pfCalc">Le prix à l'unité sera calculé automatiquement (carton ÷ quantité).</p>
    </div>
    <div class="row">
      <label class="field grow">Stock ${isNew ? "initial" : "actuel"} <input id="pfStock" type="number" min="0" value="${p.stock || 0}" ${isNew ? "" : "disabled"}></label>
      <label class="field grow">Seuil minimum <input id="pfMin" type="number" min="0" value="${p.stock_min || 0}"></label>
    </div>
    <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="pfActif" style="width:auto" ${p.actif ? "checked" : ""}> Produit actif (visible à la vente)</label>
    <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="pfLot" style="width:auto" ${p.gere_par_lot ? "checked" : ""}> Géré par lot <span class="muted" style="font-weight:400;font-size:12px">(lot et date de péremption obligatoires à la réception)</span></label>
    <div class="row"><button class="btn success grow" id="pfSave">💾 Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  const calc = () => {
    const c = Number($("#pfCarton").value) || 0, q = Number($("#pfCartonQte").value) || 0;
    if (c > 0 && q > 0) { const u = Math.round(c / q); $("#pfPA").value = u; $("#pfCalc").textContent = `Prix à l'unité calculé : ${money(u)} (${money(c)} ÷ ${q})`; }
  };
  $("#pfCarton").addEventListener("input", calc); $("#pfCartonQte").addEventListener("input", calc);
  let prodPhoto = p.photo || null;
  const showPhoto = () => { $("#pfPhotoPrev").innerHTML = prodPhoto ? `<img src="${prodPhoto}" style="max-height:110px;border-radius:8px">` : `<span class="muted">Aucune photo</span>`; };
  const onPhoto = async e => {
    const f = e.target.files && e.target.files[0];
    if (f) { try { prodPhoto = await readImage(f, 400); showPhoto(); } catch (err) { toast("Photo illisible"); } }
    e.target.value = "";
  };
  $("#pfPhotoCam").addEventListener("click", () => $("#pfPhotoCamInput").click());
  $("#pfPhotoLoad").addEventListener("click", () => $("#pfPhotoLoadInput").click());
  $("#pfPhotoDel").addEventListener("click", () => { prodPhoto = null; showPhoto(); });
  $("#pfPhotoCamInput").addEventListener("change", onPhoto);
  $("#pfPhotoLoadInput").addEventListener("change", onPhoto);
  $("#pfSave").addEventListener("click", async () => {
    const nom = $("#pfNom").value.trim();
    const pa = Number($("#pfPA").value) || 0, pv = Number($("#pfPV").value) || 0;
    if (!nom) { toast("Le nom est obligatoire"); return; }
    if (pv <= 0) { toast("Le prix de vente est obligatoire"); return; }
    const body = { nom, famille: $("#pfFamille").value.trim(), code: $("#pfCode").value.trim(), prix_achat: pa, prix_vente: pv, stock_min: Number($("#pfMin").value) || 0, actif: $("#pfActif").checked, photo: prodPhoto, gere_par_lot: $("#pfLot").checked };
    try {
      if (isNew) {
        body.stock = Number($("#pfStock").value) || 0;
        await api("/produits", { method: "POST", body: JSON.stringify(body) });
        toast("Produit enregistré");
      } else {
        await api("/produits/" + p.id, { method: "PUT", body: JSON.stringify(body) });
        toast("Produit modifié");
      }
      closeModal(); renderers.produits().catch(() => { });
    } catch (e) { toast(e.message); }
  });
}

/* ---------- stock ---------- */
let stockFaible = false, stockInactifs = false, mvtF = { type: "", produit: "", from: "", to: "" }, stTab = "produits";
renderers.stock = async function () {
  let prods = [];
  try { [prods, DB.typesMv] = await Promise.all([api("/produits"), api("/types-mouvement")]); DB.produits = prods; } catch (e) { toast(e.message); return; }
  let lots = [], four = [], cmds = [];
  if (hasRight("R_STOCK")) {
    try { [lots, four, cmds] = await Promise.all([api("/lots"), api("/fournisseurs"), api("/commandes")]); } catch (e) { }
  }
  DB.lots = lots; DB.fournisseurs = four; DB.commandes = cmds;
  const tabs = [["produits", "📦 Produits"], ["mouvements", "🔁 Entrées & sorties"], ["peremptions", "⏰ Péremptions"], ["fournisseurs", "👥 Fournisseurs"], ["commandes", "📋 Commandes"]];
  $("#stockWrap").innerHTML = `
    <div class="tabs" style="margin-bottom:10px">${tabs.map(t => `<button class="tab ${stTab === t[0] ? "on" : ""}" data-stab="${t[0]}">${t[1]}</button>`).join("")}</div>
    <div id="stBody"></div>`;
  $$("#stockWrap [data-stab]").forEach(b => b.addEventListener("click", () => { stTab = b.dataset.stab; renderers.stock().catch(() => { }); }));
  const box = $("#stBody");
  if (stTab === "produits") renderStProduits(box, prods);
  else if (stTab === "mouvements") renderStMouvements(box, prods);
  else if (stTab === "peremptions") renderStPeremptions(box, lots);
  else if (stTab === "fournisseurs") renderStFournisseurs(box, four);
  else renderStCommandes(box, cmds);
};

function renderStProduits(box, prods) {
  const shown = prods.filter(p => (stockInactifs || p.actif) && (!stockFaible || Number(p.stock) <= Number(p.stock_min)));
  box.innerHTML = `
    <div class="row wrap" style="margin-bottom:8px">
      <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="stFaible" style="width:auto" ${stockFaible ? "checked" : ""}> Stock faible uniquement</label>
      <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="stInactifs" style="width:auto" ${stockInactifs ? "checked" : ""}> Inclure les produits inactifs</label>
      
      <button class="btn small" id="stCsv">⬇️ CSV produits</button>
    </div>
    ${shown.length > 0 ? pgBar("stProduits", shown.length, "produit(s)") : ""}
    <div class="table-wrap"><table>
      <tr><th>Produit</th><th>Lot</th><th class="num">Stock</th><th class="num">Seuil</th><th>Statut</th><th class="sticky-r">Actions</th></tr>
      ${shown.length === 0 ? `<tr><td colspan="6" class="empty">Aucun produit${stockFaible ? " sous le seuil" : ""}</td></tr>` :
        pgSlice("stProduits", shown).part.map(p => `<tr>
        <td>${p.photo ? `<img src="${p.photo}" style="width:30px;height:30px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:6px">` : ""}${esc(p.nom)}</td>
        <td><span class="badge ${p.gere_par_lot ? "info" : "off"}" style="font-size:10px;padding:1px 6px">${p.gere_par_lot ? "📦 Lot" : "—"}</span></td>
        <td class="num">${p.stock}</td>
        <td class="num">${p.stock_min}</td>
        <td><span class="badge ${Number(p.stock) <= 0 ? "bad" : Number(p.stock) <= Number(p.stock_min) ? "warn" : "ok"}">${Number(p.stock) <= 0 ? "Rupture" : Number(p.stock) <= Number(p.stock_min) ? "Stock bas" : "OK"}</span></td>
        <td class="sticky-r"><div class="actions actions-grid">
          <button class="btn small" data-mv="entree" data-pid="${p.id}">⬆️ Entrée</button>
          <button class="btn small" data-mv="ajust" data-pid="${p.id}">🔧 Ajuster</button>
          <button class="btn small" data-mv="inv" data-pid="${p.id}">🔢 Inventaire</button>
          <button class="btn small" data-mv="lot" data-pid="${p.id}">🧊 Lot</button>
          <button class="btn small" data-hist="${p.id}">👁️ Historique</button>
        </div></td></tr>`).join("")}
    </table></div>`;
  $("#stFaible").addEventListener("change", e => { stockFaible = e.target.checked; renderers.stock().catch(() => { }); });
  $("#stInactifs").addEventListener("change", e => { stockInactifs = e.target.checked; renderers.stock().catch(() => { }); });
  
  $("#stCsv").addEventListener("click", () => {
    const lines = [["Nom", "Famille", "Code-barres", "Prix achat", "Prix vente", "Stock", "Seuil min"]].concat(prods.map(p => [p.nom, p.famille || "", p.code || "", p.prix_achat, p.prix_vente, p.stock, p.stock_min]));
    downloadCsv("produits.csv", lines);
  });
  $$("#stBody [data-mv]").forEach(b => b.addEventListener("click", () => {
    const p = produitById(b.dataset.pid);
    if (b.dataset.mv === "entree") mvForm(p, "Entrée", Math.max(Number(p.stock_min) - Number(p.stock), 1));
    else if (b.dataset.mv === "ajust") mvForm(p, "Ajustement");
    else if (b.dataset.mv === "lot") lotForm(p);
    else invForm(p);
  }));
  $$("#stBody [data-hist]").forEach(b => b.addEventListener("click", () => produitHistorique(produitById(b.dataset.hist))));
}

function renderStMouvements(box, prods) {
  box.innerHTML = `
    <div class="row wrap" style="margin-bottom:8px">
      <button class="btn primary" id="bonEntreeBtn">➕ Bon d'entrée (plusieurs produits)</button>
      <button class="btn" id="bonSortieBtn">➖ Bon de sortie (plusieurs produits)</button>
    </div>
    <h3>📜 Mouvements de stock (historique)</h3>
    <div class="row wrap">
      <select id="mvtType"><option value="">Tous les types</option>${DB.typesMv.map(t => `<option ${mvtF.type === t.label ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select>
      <select id="mvtProd"><option value="">Tous les produits</option>${prods.map(p => `<option value="${p.id}" ${String(mvtF.produit) === String(p.id) ? "selected" : ""}>${esc(p.nom)}</option>`).join("")}</select>
      <label class="field">Du <input id="mvtFrom" type="date" value="${mvtF.from}"></label>
      <label class="field">Au <input id="mvtTo" type="date" value="${mvtF.to}"></label>
      <button class="btn primary" id="mvtFilterBtn">🔎 Filtrer</button>
      <button class="btn ghost" id="mvtResetBtn">Réinitialiser</button>
      <button class="btn ghost" id="mvtCsv">⬇️ CSV</button>
    </div>
    <div id="mvtTable"></div>
    <div class="row" id="mvtNav" style="margin-top:8px"></div>`;
  $("#bonEntreeBtn").addEventListener("click", () => bonForm("entree"));
  $("#bonSortieBtn").addEventListener("click", () => bonForm("sortie"));
  $("#mvtType").addEventListener("change", e => { mvtF.type = e.target.value; pgReset("mouvements"); renderMouvements(); });
  $("#mvtProd").addEventListener("change", e => { mvtF.produit = e.target.value; pgReset("mouvements"); renderMouvements(); });
  $("#mvtFrom").addEventListener("change", e => { mvtF.from = e.target.value; pgReset("mouvements"); renderMouvements(); });
  $("#mvtTo").addEventListener("change", e => { mvtF.to = e.target.value; pgReset("mouvements"); renderMouvements(); });
  $("#mvtFilterBtn").addEventListener("click", () => { pgReset("mouvements"); renderMouvements(); });
  $("#mvtResetBtn").addEventListener("click", () => { mvtF = { type: "", produit: "", from: "", to: "" }; pgReset("mouvements"); renderers.stock().catch(() => { }); });
  $("#mvtCsv").addEventListener("click", () => renderMouvements(true));
  renderMouvements();
}

function renderStPeremptions(box, lots) {
  const lotBadge = l => {
    if (!l.date_peremption) return `<span class="badge off">Sans date</span>`;
    const d = fmtDateOnly(l.date_peremption);
    const diff = Math.ceil((new Date(l.date_peremption.slice(0, 10) + "T00:00:00") - new Date()) / 86400000);
    return diff < 0 ? `<span class="badge bad">Expiré (${d})</span>` : diff <= 30 ? `<span class="badge warn">Péremption ${d} (${diff} j)</span>` : `<span class="badge ok">${d}</span>`;
  };
  box.innerHTML = `
    <div class="row wrap" style="margin-bottom:8px">
      <button class="btn danger" id="rebutSelBtn" disabled>🗑️ Rebuter la sélection</button>
      <p class="muted" style="margin:6px 0 0">Cochez plusieurs lots périmés puis « Rebuter la sélection », ou rebutez lot par lot.</p>
    </div>
    ${lots.length > 0 ? pgBar("stPeremptions", lots.length, "lot(s)") : ""}
    <div class="table-wrap"><table><tr><th></th><th>Produit</th><th class="num">Restant</th><th>Péremption</th><th>Statut</th><th class="sticky-r">Actions</th></tr>
      ${lots.length === 0 ? `<tr><td colspan="6" class="empty">Aucun lot - ajoutez un lot à un produit (🧊 Lot dans l'onglet Produits) pour suivre les péremptions (à la vente, le plus ancien part en premier)</td></tr>` :
        pgSlice("stPeremptions", lots).part.map(l => `<tr><td><input type="checkbox" class="lotSel" data-lid="${l.id}" style="width:auto"></td><td>${esc(l.produit_nom)}${l.numero ? ' <span class="muted">[' + esc(l.numero) + ']</span>' : ""}</td><td class="num">${l.qte_restante}</td><td>${fmtDateOnly(l.date_peremption)}</td><td>${lotBadge(l)}</td><td class="sticky-r"><button class="btn small danger" data-rebut="${l.id}">🗑️ Rebuter</button></td></tr>`).join("")}
    </table></div>`;
  const syncBtn = () => { const el = $("#rebutSelBtn"); if (el) el.disabled = $$("#stBody .lotSel:checked").length === 0; };
  $$("#stBody .lotSel").forEach(cb => cb.addEventListener("change", syncBtn));
  $("#rebutSelBtn").addEventListener("click", async () => {
    const ids = [...$$("#stBody .lotSel:checked")].map(cb => Number(cb.dataset.lid));
    if (!ids.length) return;
    askConfirm("Rebuter les lots", `Rebuter <b>${ids.length} lot(s)</b> ? Le stock sera réduit automatiquement.`, async () => {
      try { await api("/lots/rebut-multiple", { method: "POST", body: JSON.stringify({ ids }) }); toast(`${ids.length} lot(s) rebuté(s) ✅`); renderers.stock().catch(() => { }); } catch (e) { toast(e.message); }
    }, { danger: true, okLabel: "Rebuter" });
  });
  $$("#stBody [data-rebut]").forEach(b => b.addEventListener("click", async () => {
    const l = lots.find(x => String(x.id) === String(b.dataset.rebut));
    if (!l) return;
    askConfirm("Rebuter le lot", `Rebuter le lot de <b>${l.produit_nom}</b> (${l.qte_restante}) ? Le stock sera réduit.`, async () => {
      try { await api(`/lots/${l.id}/rebut`, { method: "POST" }); toast("Lot rebuté ✅"); renderers.stock().catch(() => { }); } catch (e) { toast(e.message); }
    }, { danger: true, okLabel: "Rebuter" });
  }));
}

function renderStFournisseurs(box, four) {
  box.innerHTML = `
    <div class="point-card">
      <h3>👥 Fournisseurs</h3>
      ${four.length > 0 ? pgBar("stFour", four.length, "fournisseur(s)") : ""}
      <div class="table-wrap"><table><tr><th>Nom</th><th>Tél</th><th class="sticky-r">Actions</th></tr>
        ${four.length === 0 ? `<tr><td colspan="3" class="empty">Aucun fournisseur</td></tr>` :
          pgSlice("stFour", four).part.map(f => `<tr><td>${esc(f.nom)}</td><td>${esc(f.tel || "-")}</td><td class="sticky-r"><div class="actions"><button class="btn small" data-fedit="${f.id}">✏️</button><button class="btn small" data-fdel="${f.id}">🗑</button></div></td></tr>`).join("")}
      </table></div>
      <button class="btn small primary" id="fourBtn" style="margin-top:6px">+ Fournisseur</button>
    </div>`;
  $$("#stBody [data-fedit]").forEach(b => b.addEventListener("click", () => fournisseurForm(four.find(f => String(f.id) === String(b.dataset.fedit)))));
  $$("#stBody [data-fdel]").forEach(b => b.addEventListener("click", async () => {
    const f = four.find(x => String(x.id) === String(b.dataset.fdel));
    if (!f) return;
    askConfirm("Supprimer le fournisseur", `Supprimer le fournisseur <b>${f.nom}</b> ?`, async () => {
      try { await api("/fournisseurs/" + f.id, { method: "DELETE" }); toast("Fournisseur supprimé"); renderers.stock().catch(() => { }); } catch (e) { toast(e.message); }
    }, { danger: true, okLabel: "Supprimer" });
  }));
  $("#fourBtn").addEventListener("click", () => fournisseurForm(null));
}

function renderStCommandes(box, cmds) {
  box.innerHTML = `
    <div class="point-card">
      <h3>📋 Commandes fournisseurs</h3>
      ${cmds.length > 0 ? pgBar("stCmds", cmds.length, "commande(s)") : ""}
      <div class="table-wrap"><table><tr><th>N°</th><th>Fournisseur</th><th>Date</th><th>Statut</th><th class="sticky-r">Actions</th></tr>
        ${cmds.length === 0 ? `<tr><td colspan="5" class="empty">Aucune commande</td></tr>` :
          pgSlice("stCmds", cmds).part.map(c => `<tr><td>#${c.id}</td><td>${esc(c.fournisseur_nom || "-")}</td><td>${fmtDate(c.date)}</td><td>${c.statut === "recue" ? `<span class="badge ok">Reçue</span>` : `<span class="badge warn">En cours</span>`}</td>
          <td class="sticky-r"><div class="actions">${c.statut === "en_cours" ? `<button class="btn small success" data-cmdrec="${c.id}">📥 Réceptionner</button>` : ""}<button class="btn small" data-cmddet="${c.id}">👁️</button></div></td></tr>`).join("")}
      </table></div>
      <button class="btn small primary" id="cmdBtn" style="margin-top:6px">+ Commande</button>
    </div>`;
  $$("#stBody [data-cmdrec]").forEach(b => b.addEventListener("click", () => commandeReception(cmds.find(x => String(x.id) === String(b.dataset.cmdrec)))));
  $$("#stBody [data-cmddet]").forEach(b => b.addEventListener("click", () => cmdDetail(cmds.find(c => String(c.id) === String(b.dataset.cmddet)))));
  $("#cmdBtn").addEventListener("click", commandeForm);
}
async function renderMouvements(csvOnly) {
  const s = pgGet("mouvements");
  const lim = s.size;
  let res = { rows: [], total: 0 };
  try {
    const q = new URLSearchParams({ limit: String(lim), offset: String(s.page * lim) });
    if (mvtF.type) q.set("type", mvtF.type);
    if (mvtF.produit) q.set("produit", mvtF.produit);
    if (mvtF.from) q.set("from", mvtF.from);
    if (mvtF.to) q.set("to", mvtF.to);
    res = await api("/mouvements?" + q.toString());
  } catch (e) { toast(e.message); return; }
  if (csvOnly) {
    const lines = [["Date", "Type", "Produit", "Quantité", "Motif", "Réf", "Par", "Fournisseur", "Lot"]].concat(res.rows.map(m => [m.date, m.type, m.produit_nom || "", m.qte, m.motif || "", m.ref || "", m.user_nom || "", m.fournisseur_nom || "", m.lot_numero || ""]));
    downloadCsv("mouvements.csv", lines);
    return;
  }
  const pages = Math.max(1, Math.ceil(res.total / lim));
  if (s.page >= pages) { s.page = Math.max(0, pages - 1); return renderMouvements(csvOnly); }
  $("#mvtTable").innerHTML = `<div class="table-wrap"><table><tr><th>Date</th><th>Type</th><th>Produit</th><th class="num">Quantité</th><th>Motif</th><th>Réf</th><th>Par</th><th>Fournisseur</th><th>Lot</th></tr>
    ${res.rows.length === 0 ? `<tr><td colspan="9" class="empty">Aucun mouvement</td></tr>` :
      res.rows.map(m => `<tr><td>${fmtDate(m.date)}</td><td>${esc(m.type)}</td><td>${esc(m.produit_nom || "?")}</td><td class="num">${Number(m.qte) > 0 ? "+" : ""}${m.qte}</td><td>${esc(m.motif || "")}</td><td>${esc(m.ref || "-")}</td><td>${esc(m.user_nom || "")}</td><td>${esc(m.fournisseur_nom || "-")}</td><td>${esc(m.lot_numero || "-")}</td></tr>`).join("")}
  </table></div>`;
  $("#mvtNav").innerHTML = `
    <div class="pg-bar" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">
      <span class="muted">${res.total} mouvement(s) · page ${s.page + 1}/${pages}</span>
      <select class="pg-size" data-pg="mouvements" style="width:auto;padding:6px 8px" title="Lignes par page">
        ${PG_SIZES.map(n => `<option value="${n}" ${n === s.size ? "selected" : ""}>${n} lignes</option>`).join("")}
      </select>
      <button class="btn small" id="mvtPrev" ${s.page <= 0 ? "disabled" : ""}>⬅️ Précédent</button>
      <button class="btn small" id="mvtNext" ${s.page + 1 >= pages ? "disabled" : ""}>Suivant ➡️</button>
    </div>`;
  $("#mvtPrev").addEventListener("click", () => { s.page = Math.max(0, s.page - 1); renderMouvements(); });
  $("#mvtNext").addEventListener("click", () => { s.page += 1; renderMouvements(); });
}

/* ---------- bons d'entrée / sortie (plusieurs produits en une opération) ---------- */
function bonForm(type) {
  const entree = type === "entree";
  openModal(`<h3>${entree ? "📥 Bon d'entrée (plusieurs produits)" : "📤 Bon de sortie (plusieurs produits)"}</h3>
    <p class="muted">${entree ? "Ajoutez les produits reçus du fournisseur, avec leur lot et leur date de péremption." : "Ajoutez les produits à sortir. Tout est enregistré en une seule opération, avec une référence de bon retrouvable dans l'historique."}</p>
    <div class="bf-top">
      ${entree ? `<label class="field bf-field">Fournisseur <select id="bfFour"><option value="">- Choisir le fournisseur -</option>${(DB.fournisseurs || []).map(f => `<option value="${f.id}">${esc(f.nom)}</option>`).join("")}</select></label>` : ""}
      <label class="field bf-field">Motif <input id="bfMotif" placeholder="${entree ? "ex. réception de la livraison du jour" : "ex. remise au service, sortie pour un client..."}"></label>
    </div>
    <div class="bf-search">
      <span class="bf-search-ico">🔎</span>
      <input id="bfSearch" placeholder="Rechercher un article à ajouter…" autocomplete="off">
    </div>
    <div id="bfResults" class="bf-results hidden"></div>
    <div class="bf-list-title">Articles du bon <span id="bfCount" class="bf-count">0</span></div>
    <div id="bfList" class="bf-list"><p class="bf-empty">Aucun article ajouté — cherchez un produit ci-dessus et cliquez dessus pour l'ajouter.</p></div>
    <div class="row" style="margin-top:14px"><button class="btn success grow" id="bfSave">✅ Enregistrer le bon</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  const $ = id => document.getElementById(id);
  const input = $("bfSearch"), results = $("bfResults"), list = $("bfList");
  const prodOpts = (DB.produits || []).filter(p => p.actif);
  const majCompteur = () => { $("bfCount").textContent = list.querySelectorAll(".bfItem").length; };
  const afficherResultats = () => {
    const t = input.value.trim().toLowerCase();
    results.innerHTML = "";
    if (!t) { results.classList.add("hidden"); return; }
    const deja = new Set(Array.from(list.querySelectorAll(".bfItem")).map(el => el.dataset.pid));
    const trouves = prodOpts.filter(p => p.nom.toLowerCase().includes(t) && !deja.has(String(p.id))).slice(0, 8);
    if (!trouves.length) {
      results.innerHTML = `<div class="bf-result bf-none">Aucun article trouvé pour « ${esc(input.value.trim())} »</div>`;
    } else {
      trouves.forEach(p => {
        const r = document.createElement("div");
        r.className = "bf-result";
        r.innerHTML = `<div class="bf-r-name">${esc(p.nom)}</div><div class="bf-r-meta">${money(p.prix_vente)} · Stock : ${p.stock}</div><span class="bf-r-add">+ Ajouter</span>`;
        r.addEventListener("click", () => ajouterLigne(p));
        results.appendChild(r);
      });
    }
    results.classList.remove("hidden");
  };
  const ajouterLigne = p => {
    const row = document.createElement("div");
    row.className = "bfItem";
    row.dataset.pid = String(p.id);
    row.innerHTML = `<div class="bf-i-head"><div class="bf-i-nom">${esc(p.nom)}</div><span class="bf-i-stock">Stock : ${p.stock}</span><button class="btn small danger bf-del" title="Retirer cet article">✕</button></div>
      <div class="bf-i-body">
        <label class="bf-i-q">Quantité <input type="number" min="1"${entree ? "" : ` max="${p.stock}"`} value="1" class="bfq"></label>
        ${entree ? `<label class="bf-i-l">N° de lot * <input type="text" class="bflot" placeholder="ex. L2024-001"></label>
        <label class="bf-i-p">Péremption * <input type="date" class="bfper"></label>` : `<label class="bf-i-l">Lot à sortir
          <select class="bflotsel"><option value="">🔄 Auto (plus ancien)</option>${(DB.lots || []).filter(l => Number(l.produit_id) === Number(p.id) && Number(l.qte_restante) > 0).map(l => `<option value="${l.id}">${esc(l.numero || "Lot #" + l.id)} — ${fmtDateOnly(l.date_peremption)} (${fmt(l.qte_restante)})</option>`).join("")}</select>
        </label>`}
      </div>`;
    row.querySelector(".bf-del").addEventListener("click", e => { e.stopPropagation(); row.remove(); majCompteur(); });
    const vide = list.querySelector(".bf-empty");
    if (vide) vide.remove();
    list.appendChild(row);
    majCompteur();
    input.value = "";
    afficherResultats();
    if (entree) { const fl = row.querySelector(".bflot"); if (fl) fl.focus(); } else input.focus();
  };
  input.addEventListener("input", afficherResultats);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const r = results.querySelector(".bf-result:not(.bf-none)");
      if (r) r.click();
    }
  });
  list.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.classList && e.target.classList.contains("bflot")) { e.preventDefault(); const per = e.target.closest(".bfItem").querySelector(".bfper"); if (per) per.focus(); }
  });
  $("bfSave").addEventListener("click", async () => {
    const items = Array.from(list.querySelectorAll(".bfItem")).map(el => {
      const it = { produitId: Number(el.dataset.pid), qte: Number(el.querySelector(".bfq").value) || 0 };
      if (entree) { it.numeroLot = el.querySelector(".bflot").value.trim(); it.datePeremption = el.querySelector(".bfper").value; }
      else { const ls = el.querySelector(".bflotsel"); if (ls && ls.value) it.lotId = Number(ls.value); }
      return it;
    });
    if (!items.length) { toast("Ajoutez au moins un article"); return; }
    if (items.some(it => !it.produitId || it.qte <= 0)) { toast("Vérifiez les quantités des lignes"); return; }
    if (!entree && items.some(it => it.qte > (produitById(it.produitId) ? Number(produitById(it.produitId).stock) : 0))) { toast("Quantité supérieure au stock disponible"); return; }
    if (entree && !$("bfFour").value) { toast("Sélectionnez le fournisseur"); return; }
    if (entree && items.some(it => !it.numeroLot)) { toast("Indiquez le numéro de lot sur chaque ligne"); return; }
    if (entree && items.some(it => !it.datePeremption)) { toast("Indiquez la date de péremption sur chaque ligne"); return; }
    const motif = $("bfMotif").value.trim();
    if (!motif) { toast("Le motif est obligatoire"); return; }
    const body = { type, lignes: items, motif };
    if (entree && $("bfFour").value) body.fournisseur_id = Number($("bfFour").value);
    const totQte = items.reduce((s, it) => s + it.qte, 0);
    const fourNom = entree ? (($("bfFour").selectedOptions[0] || {}).textContent || "").trim() : "";
    askConfirm(entree ? "Confirmer le bon d'entrée" : "Confirmer le bon de sortie", `${entree ? "Entrée" : "Sortie"} de <b>${items.length} article(s)</b> — <b>${totQte} unité(s)</b> au total${entree ? `<br>Fournisseur : <b>${esc(fourNom)}</b>` : ""}<br>Motif : <b>${esc(motif)}</b><br><span class="muted">${entree ? "Le stock sera augmenté et les lots seront créés." : "Le stock sera réduit automatiquement."}</span>`, async () => {
      try {
        const bon = await api("/mouvements/bon", { method: "POST", body: JSON.stringify(body) });
        toast(`${entree ? "Entrée" : "Sortie"} enregistrée — bon ${bon.reference} ✅`);
        closeModal();
        pgReset("mouvements");
        renderers.stock().catch(() => { });
      } catch (e) { toast(e.message); }
    }, { icone: entree ? "📥" : "📤", okLabel: "Enregistrer le bon" });
  });
  setTimeout(() => input.focus(), 80);
}
function downloadCsv(nom, lines) {
  const csv = lines.map(r => r.map(c => `"${String(c ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
  a.download = nom; a.click();
}
function lotForm(p) {
  if (!p.gere_par_lot) { toast("Ce produit n'est pas gere par lot"); return; }
  openModal(`<h3>🧊 Ajouter un lot - ${esc(p.nom)}</h3>
    <label class="field">N° de lot * <input id="ltNum" placeholder="ex. L2024-001"></label>
    <label class="field">Quantité <input id="ltQte" type="number" min="1" value="1"></label>
    <label class="field">Date de péremption * <input id="ltPer" type="date"></label>
    <p class="muted">Le stock augmente de la quantité. À la vente, le lot le plus ancien part en premier (FIFO).</p>
    <div class="row"><button class="btn success grow" id="ltSave">💾 Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  $("#ltSave").addEventListener("click", async () => {
    const q = Number($("#ltQte").value) || 0;
    const num = $("#ltNum").value.trim();
    if (q <= 0) { toast("Quantité invalide"); return; }
    if (!num) { toast("Indiquez le numéro de lot"); return; }
    if (!$("#ltPer").value) { toast("Indiquez la date de péremption"); return; }
    const per = $("#ltPer").value;
    askConfirm("Ajouter un lot", `Ajouter <b>${q} unité(s)</b> au stock de <b>${esc(p.nom)}</b><br>Lot : <b>${esc(num)}</b> · Péremption : <b>${fmtDateOnly(per)}</b><br><span class="muted">Le stock augmentera automatiquement (FIFO).</span>`, async () => {
      try {
        await api(`/produits/${p.id}/lots`, { method: "POST", body: JSON.stringify({ qte: q, date_peremption: per, numero: num }) });
        toast("Lot enregistré ✅"); closeModal(); renderers.stock().catch(() => { });
      } catch (e) { toast(e.message); }
    }, { icone: "🧊", okLabel: "Ajouter" });
  });
}
function fournisseurForm(f) {
  const isNew = !f; f = f || { nom: "", tel: "", email: "", adresse: "", notes: "" };
  openModal(`<h3>${isNew ? "Nouveau fournisseur" : "Modifier : " + esc(f.nom)}</h3>
    <label class="field">Nom <input id="ffNom" value="${esc(f.nom)}"></label>
    <div class="row"><label class="field grow">Téléphone <input id="ffTel" value="${esc(f.tel || "")}"></label>
      <label class="field grow">E-mail <input id="ffEmail" value="${esc(f.email || "")}"></label></div>
    <label class="field">Adresse <input id="ffAdr" value="${esc(f.adresse || "")}"></label>
    <label class="field">Notes <input id="ffNotes" value="${esc(f.notes || "")}"></label>
    <div class="row"><button class="btn success grow" id="ffSave">💾 Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  $("#ffSave").addEventListener("click", async () => {
    const nom = $("#ffNom").value.trim();
    if (!nom) { toast("Le nom est obligatoire"); return; }
    const body = { nom, tel: $("#ffTel").value.trim(), email: $("#ffEmail").value.trim(), adresse: $("#ffAdr").value.trim(), notes: $("#ffNotes").value.trim() };
    try {
      if (isNew) await api("/fournisseurs", { method: "POST", body: JSON.stringify(body) });
      else await api("/fournisseurs/" + f.id, { method: "PUT", body: JSON.stringify(body) });
      toast("Fournisseur enregistré"); closeModal(); renderers.stock().catch(() => { });
    } catch (e) { toast(e.message); }
  });
}
function commandeForm() {
  const fours = DB.fournisseurs || [];
  const prods = DB.produits || [];
  const lignes = [];
  openModal(`<h3>📋 Nouvelle commande fournisseur</h3>
    <p class="muted">Recherchez les articles à commander et ajoutez-les à la liste. La commande est enregistrée en une seule fois.</p>
    <div class="bf-top">
      <label class="field bf-field">Fournisseur <select id="cmFour"><option value="">- Choisir le fournisseur -</option>${fours.map(f => `<option value="${f.id}">${esc(f.nom)}</option>`).join("")}</select></label>
      <label class="field bf-field">Coût de livraison (F) <input id="cmLiv" type="number" min="0" value="0"></label>
    </div>
    <div class="bf-search"><input id="cmSearch" placeholder="Rechercher un article à commander..." autocomplete="off"></div>
    <div id="cmResults" class="bf-results"></div>
    <div class="bf-list">
      <div class="bf-list-head">📦 Lignes de la commande <span class="bf-count" id="cmCount">0</span></div>
      <div id="cmLines"></div>
    </div>
    <label class="field">Notes <input id="cmNotes" placeholder="ex. livraison prévue jeudi..."></label>
    <div class="row"><button class="btn success grow" id="cmSave">✅ Créer la commande</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  const renderLignes = () => {
    $("#cmCount").textContent = lignes.length;
    $("#cmLines").innerHTML = lignes.length === 0 ? `<p class="muted">Aucun article ajouté</p>` :
      lignes.map((l, i) => `<div class="bfItem">
        <div class="bfItem-main"><b>${esc(l.nom)}</b><span class="bfItem-sub">${money(l.pa)} / unité</span></div>
        <button class="bfItem-x" data-lindel="${i}">✕</button>
        <div class="bfItem-fields">
          <label class="field bf-field">Quantité <input type="number" min="1" value="${l.qte}" data-linqte="${i}"></label>
          <label class="field bf-field">Prix achat (F) <input type="number" min="0" value="${l.pa}" data-linpa="${i}"></label>
        </div>
      </div>`).join("");
    $$("#cmLines [data-lindel]").forEach(b => b.addEventListener("click", () => { lignes.splice(Number(b.dataset.lindel), 1); renderLignes(); }));
    $$("#cmLines [data-linqte]").forEach(inp => inp.addEventListener("change", () => { const i = Number(inp.dataset.linqte); lignes[i].qte = Math.max(1, Number(inp.value) || 1); }));
    $$("#cmLines [data-linpa]").forEach(inp => inp.addEventListener("change", () => { const i = Number(inp.dataset.linpa); lignes[i].pa = Math.max(0, Number(inp.value) || 0); }));
  };
  renderLignes();
  const renderResults = () => {
    const q = $("#cmSearch").value.toLowerCase().trim();
    if (!q) { $("#cmResults").innerHTML = ""; return; }
    const excl = lignes.map(l => String(l.produitId));
    const hits = prods.filter(p => p.actif && !excl.includes(String(p.id)) && p.nom.toLowerCase().includes(q)).slice(0, 8);
    $("#cmResults").innerHTML = hits.length === 0 ? `<div class="bf-empty">Aucun article trouvé</div>` :
      hits.map(h => `<div class="bf-hit" data-hit="${h.id}">${esc(h.nom)}<span class="muted"> · ${money(h.prix_achat)} · Stock : ${h.stock}</span><b>+ Ajouter</b></div>`).join("");
    $$("#cmResults [data-hit]").forEach(b => b.addEventListener("click", () => {
      const p = prods.find(x => String(x.id) === String(b.dataset.hit));
      if (!p) return;
      const ex = lignes.find(l => String(l.produitId) === String(p.id));
      if (ex) ex.qte += 1; else lignes.push({ produitId: p.id, nom: p.nom, qte: 1, pa: Number(p.prix_achat) || 0 });
      $("#cmSearch").value = ""; renderResults(); renderLignes();
    }));
  };
  $("#cmSearch").addEventListener("input", renderResults);
  $("#cmSearch").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); const first = $("#cmResults [data-hit]"); if (first) first.click(); }
  });
  $("#cmSave").addEventListener("click", async () => {
    if (!lignes.length) { toast("Ajoutez au moins un article"); return; }
    if (!Number($("#cmFour").value)) { toast("Sélectionnez le fournisseur"); return; }
    try {
      await api("/commandes", { method: "POST", body: JSON.stringify({ fournisseur_id: Number($("#cmFour").value), livraison: Number($("#cmLiv").value) || 0, notes: $("#cmNotes").value, items: lignes.map(l => ({ produitId: l.produitId, qte: l.qte, prix_achat: l.pa })) }) });
      toast("Commande créée ✅"); closeModal(); renderers.stock().catch(() => { });
    } catch (e) { toast(e.message); }
  });
}

function commandeReception(c) {
  const items = c.items || [];
  const lignes = items.filter(i => i.produit_id).map(i => ({ produitId: Number(i.produit_id), nom: i.nom, qteCmd: Number(i.qte), qte: Number(i.qte), numeroLot: "", datePeremption: "" }));
  if (!lignes.length) { toast("Cette commande n'a pas d'article"); return; }
  openModal(`<h3>📥 Réceptionner la commande #${c.id}</h3>
    <p class="muted">Fournisseur : <b>${esc(c.fournisseur_nom || "")}</b> — Indiquez la quantité réellement reçue, le numéro de lot et la date de péremption de chaque article.</p>
    <div class="bf-list">
      <div class="bf-list-head">📦 Articles reçus <span class="bf-count" id="crCount">${lignes.length}</span></div>
      <div id="crLines">
        ${lignes.map((l, i) => `<div class="bfItem">
          <div class="bfItem-main"><b>${esc(l.nom)}</b><span class="bfItem-sub">commandé : ${l.qteCmd}</span></div>
          <div class="bfItem-fields">
            <label class="field bf-field">Reçu <input type="number" min="0" value="${l.qte}" data-crqte="${i}"></label>
            <label class="field bf-field" style="${produitById(l.produitId) && produitById(l.produitId).gere_par_lot ? "" : "opacity:.55"}">N° de lot ${produitById(l.produitId) && produitById(l.produitId).gere_par_lot ? "*" : "(opt.)"} <input type="text" placeholder="ex. LOT-001" data-crlot="${i}"></label>
            <label class="field bf-field" style="${produitById(l.produitId) && produitById(l.produitId).gere_par_lot ? "" : "opacity:.55"}">Péremption ${produitById(l.produitId) && produitById(l.produitId).gere_par_lot ? "*" : "(opt.)"} <input type="date" data-crper="${i}"></label>
          </div>
        </div>`).join("")}
      </div>
    </div>
    <div class="row"><button class="btn success grow" id="crSave">✅ Réceptionner</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  $$("#crLines [data-crqte]").forEach(inp => inp.addEventListener("change", () => { const i = Number(inp.dataset.crqte); lignes[i].qte = Math.max(0, Number(inp.value) || 0); }));
  $$("#crLines [data-crlot]").forEach(inp => inp.addEventListener("change", () => { const i = Number(inp.dataset.crlot); lignes[i].numeroLot = inp.value.trim(); }));
  $$("#crLines [data-crper]").forEach(inp => inp.addEventListener("change", () => { const i = Number(inp.dataset.crper); lignes[i].datePeremption = inp.value; }));
  $("#crSave").addEventListener("click", async () => {
    const actives = lignes.filter(l => l.qte > 0);
    if (!actives.length) { toast("Indiquez au moins une quantité reçue"); return; }
    const manque = actives.find(l => { const p = produitById(l.produitId); return p && p.gere_par_lot && (!l.numeroLot || !l.datePeremption); });
    if (manque) { toast("N° de lot et date de péremption obligatoires pour « " + manque.nom + " »"); return; }
    const totQ = actives.reduce((s, l) => s + l.qte, 0);
    askConfirm("Réceptionner la commande", `Réceptionner la commande <b>#${c.id}</b> (${esc(c.fournisseur_nom || "")}) ?<br>${actives.length} article(s) reçu(s) — <b>${totQ} unité(s)</b> au total.<br><span class="muted">Le stock sera augmenté et les lots créés automatiquement.</span>`, async () => {
      try {
        await api(`/commandes/${c.id}/receptionner`, { method: "POST", body: JSON.stringify({ lignes: actives.map(l => ({ produitId: l.produitId, qte: l.qte, numeroLot: l.numeroLot, datePeremption: l.datePeremption })) }) });
        toast("Commande réceptionnée - stock mis à jour ✅"); closeModal(); renderers.stock().catch(() => { });
      } catch (e) { toast(e.message); }
    }, { okLabel: "Réceptionner" });
  });
}
function cmdDetail(c) {
  const items = (c.items || []).map(i => `<tr><td>${esc(i.nom)}</td><td class="num">${i.qte}</td><td class="num">${money(i.prix_achat)}</td><td class="num">${money(Number(i.qte) * Number(i.prix_achat))}</td></tr>`).join("");
  const tot = (c.items || []).reduce((s, i) => s + Number(i.qte) * Number(i.prix_achat), 0);
  openModal(`<h3>📦 Commande #${c.id} - ${esc(c.fournisseur_nom || "")}</h3>
    <p class="muted">${fmtDate(c.date)} · ${c.statut === "recue" ? "Reçue" : "En cours"}</p>
    <div class="table-wrap"><table><tr><th>Produit</th><th class="num">Qté</th><th class="num">Prix achat</th><th class="num">Total</th></tr>${items || `<tr><td colspan="4" class="empty">Vide</td></tr>`}</table></div>
    <p style="margin-top:8px">Livraison : ${money(c.livraison)} · <b>Total : ${money(tot + Number(c.livraison || 0))}</b></p>
    ${c.notes ? `<p class="muted">Notes : ${esc(c.notes)}</p>` : ""}
    <div class="row" style="margin-top:10px"><button class="btn ghost grow" onclick="closeModal()">Fermer</button></div>`);
}
async function produitHistorique(p) {
  if (!p) return;
  let h = { mouvements: [], ventes: [], prix: [] };
  try { h = await api("/produits/" + p.id + "/historique"); } catch (e) { toast(e.message); }
  const mvs = h.mouvements.map(m => `<tr><td>${fmtDate(m.date)}</td><td>${esc(m.type)}</td><td class="num">${Number(m.qte) > 0 ? "+" : ""}${m.qte}</td><td>${esc(m.motif || "")}</td><td>${esc(m.user_nom || "")}</td><td>${esc(m.fournisseur_nom || "-")}</td><td>${esc(m.lot_numero || "-")}</td></tr>`).join("");
  const vts = h.ventes.map(v => `<tr><td>${v.numero}</td><td>${fmtDate(v.date)}</td><td class="num">${v.qte} × ${money(v.prix)}</td></tr>`).join("");
  const prix = h.prix.map(a => `<tr><td>${fmtDate(a.date)}</td><td>${esc(a.user_nom || "")}</td><td class="num">${money(a.pv_avant)} → ${money(a.pv_apres)}</td></tr>`).join("");
  openModal(`<h3>👁️ Historique - ${esc(p.nom)}</h3>
    <div class="cards" style="margin:8px 0">
      <div class="card"><div class="k">Stock actuel</div><div class="v">${p.stock}</div></div>
      <div class="card"><div class="k">Prix vente</div><div class="v">${money(p.prix_vente)}</div></div>
      <div class="card"><div class="k">Prix achat</div><div class="v">${money(p.prix_achat)}</div></div>
    </div>
    <h4>Mouvements (20 derniers)</h4>
    <div class="table-wrap" style="max-height:200px;overflow:auto"><table><tr><th>Date</th><th>Type</th><th class="num">Qté</th><th>Motif</th><th>Par</th><th>Fournisseur</th><th>Lot</th></tr>${mvs || `<tr><td colspan="7" class="empty">Aucun mouvement</td></tr>`}</table></div>
    <h4 style="margin-top:10px">Ventes (20 dernières)</h4>
    <div class="table-wrap" style="max-height:200px;overflow:auto"><table><tr><th>Ticket</th><th>Date</th><th class="num">Vendu</th></tr>${vts || `<tr><td colspan="3" class="empty">Aucune vente</td></tr>`}</table></div>
    <h4 style="margin-top:10px">Changements de prix</h4>
    <div class="table-wrap" style="max-height:200px;overflow:auto"><table><tr><th>Date</th><th>Par</th><th class="num">Prix vente</th></tr>${prix || `<tr><td colspan="3" class="empty">Aucun changement</td></tr>`}</table></div>
    <div class="row" style="margin-top:12px"><button class="btn ghost grow" onclick="closeModal()">Fermer</button></div>`);
}
function famManager(host) {
  host = host || "#modalCard";
  const inline = host !== "#modalCard";
  const fams = DB.familles || [];
  const html = `<h3>🏷️ Gérer les familles</h3>
    <div class="row"><input id="famNew" class="grow" placeholder="Nouvelle famille..."><label class="field" style="display:flex;gap:6px;align-items:center;flex:0 0 auto"><input type="checkbox" id="famNewLot" style="width:auto"> Par lot</label><button class="btn primary" id="famAdd">+ Ajouter</button></div>
    <div class="table-wrap" style="margin-top:8px"><table><tr><th>Famille</th><th>Géré par lot</th><th>Actions</th></tr>
      ${fams.length === 0 ? `<tr><td colspan="3" class="empty">Aucune famille</td></tr>` :
        fams.map(f => `<tr><td>${esc(f.nom)}</td><td><span class="badge ${f.gere_par_lot ? "info" : "off"}">${f.gere_par_lot ? "Oui" : "Non"}</span></td><td><div class="actions"><button class="btn small" data-fren="${f.id}">✎</button><button class="btn small" data-frlot="${f.id}" title="Activer/désactiver la gestion par lot">📦</button><button class="btn small" data-frmod="${f.id}">🗑</button></div></td></tr>`).join("")}
    </table></div>`;
  if (inline) $(host).innerHTML = html; else openModal(html);
  const el = $(host);
  el.querySelector("#famAdd").addEventListener("click", async () => {
    const nom = el.querySelector("#famNew").value.trim();
    if (!nom) { toast("Nom obligatoire"); return; }
    try { await api("/familles", { method: "POST", body: JSON.stringify({ nom, gere_par_lot: el.querySelector("#famNewLot").checked }) }); DB.familles = await api("/familles"); famManager(host); } catch (e) { toast(e.message); }
  });
  el.querySelectorAll("[data-fren]").forEach(b => b.addEventListener("click", () => {
    const f = fams.find(x => String(x.id) === String(b.dataset.fren));
    if (!f) return;
    askPrompt("Renommer la famille", f.nom, nv => {
      if (!nv || !nv.trim()) return;
      api("/familles/" + f.id, { method: "PUT", body: JSON.stringify({ nom: nv.trim() }) }).then(async () => { toast("Famille renommée"); DB.familles = await api("/familles"); famManager(host); }).catch(e => toast(e.message));
    });
  }));
  el.querySelectorAll("[data-frlot]").forEach(b => b.addEventListener("click", async () => {
    const f = fams.find(x => String(x.id) === String(b.dataset.frlot));
    if (!f) return;
    try { await api("/familles/" + f.id, { method: "PUT", body: JSON.stringify({ nom: f.nom, gere_par_lot: !f.gere_par_lot }) }); toast(f.gere_par_lot ? "Gestion par lot désactivée" : "Gestion par lot activée"); DB.familles = await api("/familles"); famManager(host); } catch (e) { toast(e.message); }
  }));
  el.querySelectorAll("[data-frmod]").forEach(b => b.addEventListener("click", async () => {
    const f = fams.find(x => String(x.id) === String(b.dataset.frmod));
    if (!f) return;
    askConfirm("Supprimer la famille", `Supprimer la famille <b>« ${f.nom} »</b> ?<br><span class="muted">Refusée si des produits ou inventaires l'utilisent encore.</span>`, async () => {
      try { await api("/familles/" + f.id, { method: "DELETE" }); toast("Famille supprimée"); DB.familles = await api("/familles"); renderers.produits().catch(() => { }); renderers.vente().catch(() => { }); famManager(host); } catch (e) { toast(e.message); }
    }, { danger: true, okLabel: "Supprimer" });
  }));
}
function mvForm(p, type, qteDefaut) {
  openModal(`<h3>${type} - ${esc(p.nom)}</h3>
    <label class="field">Quantité
      <input id="mvQte" type="number" value="${qteDefaut != null ? qteDefaut : 1}" min="1">
    </label>
    ${type === "Ajustement" ? `<label class="field">Sens :
      <select id="mvSens">
        <option value="ajouter">➕ Ajouter au stock (+)</option>
        <option value="retirer">➖ Retirer du stock (−)</option>
      </select>
      <span class="muted" id="mvApres" style="display:block;margin-top:6px">Stock actuel : ${Number(p.stock)} → après : ${Number(p.stock) + 1}</span>
    </label>` : ""}
    ${type === "Entrée" ? `<label class="field">Type d'entrée<select id="mvType">${(DB.typesMv || []).filter(t => t.signe === "+" && t.code !== "stock_initial").map(t => `<option value="${esc(t.code)}">${esc(t.label)}</option>`).join("")}</select></label>` : ""}

    ${type === "Entrée" ? `<label class="field">Fournisseur (obligatoire) <select id="mvFour"><option value="">- Sélectionner -</option>${(DB.fournisseurs || []).map(f => `<option value="${f.id}">${esc(f.nom)}</option>`).join("")}</select></label>` : ""}
    ${type === "Entrée" ? `<label class="field" id="mvLotWrap" style="${p.gere_par_lot ? "" : "display:none"}">N° de lot ${p.gere_par_lot ? "*" : "(optionnel)"} <input id="mvLot" placeholder="ex. L2024-001"></label>
    <label class="field" id="mvPerWrap" style="${p.gere_par_lot ? "" : "display:none"}">Date de péremption ${p.gere_par_lot ? "*" : "(optionnelle)"} <input id="mvPer" type="date"></label>` : ""}
    <label class="field">Motif (obligatoire)
      <input id="mvMotif" placeholder="ex. réception de commande, casse, perte...">
    </label>
    <div class="row"><button class="btn success grow" id="mvSave">Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  if (type === "Ajustement") {
    const updApres = () => {
      const s = $("#mvSens").value, qt = Number($("#mvQte").value) || 0;
      const ap = Number(p.stock) + (s === "retirer" ? -qt : qt);
      $("#mvApres").textContent = "Stock actuel : " + p.stock + " → après : " + Math.max(ap, 0);
    };
    $("#mvSens").addEventListener("change", updApres);
    $("#mvQte").addEventListener("input", updApres);
  }
  $("#mvSave").addEventListener("click", async () => {
    const q = Number($("#mvQte").value) || 0, motif = $("#mvMotif").value.trim();
    if (q <= 0 || !motif) { toast("Quantité et motif obligatoires"); return; }
    if (type === "Entrée") {
      const fSel = $("#mvFour").value;
      const mvTypeSel = $("#mvType") ? $("#mvType").value : "entree";
      if (mvTypeSel !== "retour" && !fSel) { toast("Sélectionnez le fournisseur"); return; }
      if (p.gere_par_lot) {
        if (!$("#mvLot").value.trim()) { toast("Numéro de lot obligatoire (produit géré par lot)"); return; }
        if (!$("#mvPer").value) { toast("Date de péremption obligatoire (produit géré par lot)"); return; }
      }
    }
    let typeReq = "entree";
    const enr = async (t, qte) => {
      try {
        const fourId = $("#mvFour") ? Number($("#mvFour").value) || null : null;
        const mvBody = { type: t, qte, motif, fournisseur_id: fourId };
        if (t === "entree" || t === "retour") { mvBody.numero_lot = $("#mvLot").value.trim(); mvBody.date_peremption = $("#mvPer").value; }
        await api("/produits/" + p.id + "/stock", { method: "POST", body: JSON.stringify(mvBody) });
        closeModal(); renderers.stock().catch(() => { });
        toast("Mouvement enregistré");
      } catch (e) { toast(e.message); }
    };
    if (type === "Ajustement") {
      typeReq = "ajustement";
      const sens = $("#mvSens") ? $("#mvSens").value : "ajouter";
      const qs = sens === "retirer" ? -q : q;
      const apres = Number(p.stock) + qs;
      if (apres < 0) { toast("Pas assez de stock pour retirer " + q); return; }
      askConfirm("Ajustement de stock", `${sens === "retirer" ? "➖ Retirer" : "➕ Ajouter"} <b>${q}</b> unité(s) → <b>${esc(p.nom)}</b> ?<br><span class="muted">Stock actuel : <b>${p.stock}</b> → après : <b>${apres}</b></span>`, () => enr("ajustement", qs), { okLabel: "Confirmer" });
      return;
    }
    const mvSel = $("#mvType") ? $("#mvType").value : "entree";
    typeReq = mvSel === "retour" ? "retour" : "entree";
    askConfirm(type === "Entrée" ? "Entrée de stock" : "Retour de stock", `Confirmer ${type === "Entrée" ? "l'entrée" : "le retour"} de <b>${q} à ${esc(p.nom)}</b> ?`, () => enr(typeReq, q), { okLabel: "Confirmer" });
  });
}
function invForm(p) {
  openModal(`<h3>Inventaire - ${esc(p.nom)}</h3>
    <p class="muted">Stock actuel : <b>${p.stock}</b></p>
    <label class="field">Quantité réellement comptée
      <input id="invQte" type="number" min="0" value="${p.stock}">
    </label>
    <p class="muted" id="invEcart">Écart : 0</p>
    <div class="row"><button class="btn success grow" id="invSave">Valider l'inventaire</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  const upd = () => { const q = Number($("#invQte").value) || 0; $("#invEcart").textContent = `Écart : ${q - Number(p.stock) > 0 ? "+" : ""}${q - Number(p.stock)} unité(s)`; };
  $("#invQte").addEventListener("input", upd);
  $("#invSave").addEventListener("click", async () => {
    const q = Number($("#invQte").value) || 0;
    const validerInv = async () => {
      try {
        const r = await api("/produits/" + p.id + "/inventaire", { method: "POST", body: JSON.stringify({ qteReelle: q }) });
        closeModal(); renderers.stock().catch(() => { });
        toast(r.ecart === 0 ? "Aucun écart" : `Inventaire validé (écart ${r.ecart > 0 ? "+" : ""}${r.ecart})`);
      } catch (e) { toast(e.message); }
    };
    if (q === Number(p.stock)) { validerInv(); }
    else {
      askConfirm("Valider l'inventaire", `Valider l'inventaire de <b>${esc(p.nom)}</b> : ${p.stock} → <b>${q}</b> ?<br><span class="muted">Écart : ${q - Number(p.stock) > 0 ? "+" : ""}${q - Number(p.stock)} unité(s)</span>`, validerInv, { okLabel: "Valider" });
    }
  });
}

/* ---------- clôture de caisse (caissière principale) ---------- */
let pointClass = "caissiere";
let pointTab = "attente", pointFrom = todayKey(), pointTo = todayKey(), pointCaiss = "";
const caisseBadge = s => s === "ouverte" ? `<span class="badge ok">Ouverte</span>` : s === "fermee" ? `<span class="badge warn">Fermée</span>` : `<span class="badge off">Validée</span>`;
renderers.point = async function () {
  let caisses = [];
  try {
    caisses = await api(`/caisse?from=${pointFrom}&to=${pointTo}${pointCaiss ? "&caissiere=" + pointCaiss : ""}`);
  } catch (e) { toast(e.message); return; }
  DB.caisses = caisses;
  const attente = caisses.filter(c => c.statut !== "validee");
  const validees = caisses.filter(c => c.statut === "validee");
  const tab = pointTab === "attente" ? attente : validees;
  const cashiers = [...new Map(caisses.map(c => [String(c.user_id), c.user_nom])).entries()].map(([id, nom]) => ({ id, nom }));
  const tFonds = caisses.reduce((s, c) => s + Number(c.fonds_initial), 0);
  const tEsp = caisses.reduce((s, c) => s + Number(c.especes), 0);
  const tAutres = caisses.reduce((s, c) => s + Number(c.autres || 0), 0);
  const tAttendu = caisses.reduce((s, c) => s + Number(c.statut === "ouverte" ? c.attendu_especes : c.total_attendu || 0), 0);
  const tCompte = caisses.reduce((s, c) => s + Number(c.total_compte || 0), 0);
  const tEcart = caisses.reduce((s, c) => s + Number(c.ecart || 0), 0);
  const tVerse = caisses.reduce((s, c) => s + Number(c.verse_total), 0);
  const row = c => `<tr>
    <td class="sticky-l">${esc(c.user_nom)}</td>
    <td>${new Date(c.ouverte_le).toLocaleDateString("fr-FR")} ${new Date(c.ouverte_le).toLocaleTimeString("fr-FR")}${c.fermee_le ? `<br><span class="muted">fermée ${new Date(c.fermee_le).toLocaleTimeString("fr-FR")}</span>` : ""}</td>
    <td>${caisseBadge(c.statut)}${c.statut === "validee" ? `<br><span class="muted">par ${esc(c.validee_par_nom || "")}</span>` : ""}</td>
    <td class="num">${money(c.fonds_initial)}</td>
    <td class="num">${money(c.especes)}</td>
    <td class="num">${money(c.autres || 0)}</td>
    <td class="num"><b>${money(c.statut === "ouverte" ? c.attendu_especes : c.total_attendu || 0)}</b></td>
    <td class="num">${c.total_compte != null ? money(c.total_compte) : "-"}</td>
    <td class="num">${c.ecart != null ? `<span class="${Number(c.ecart) === 0 ? "ok" : "bad"}">${Number(c.ecart) > 0 ? "+" : ""}${money(c.ecart)}</span>` : "-"}</td>
    <td class="num">${money(c.verse_total)}</td>
    <td class="sticky-r"><div class="actions">
      <button class="btn small" data-detail="${c.id}">👁️ Détail</button>
      ${c.statut === "ouverte" ? `<button class="btn small" data-vers="${c.id}">➕ Versement</button>` : ""}
      ${c.statut === "fermee" ? `<button class="btn small success" data-val="${c.id}">✅ Valider</button><button class="btn small" data-rejet="${c.id}">🚫 Rejeter</button>` : ""}

    </div></td>
  </tr>`;
  $("#pointBox").innerHTML = `
    <div class="panel" style="margin-bottom:8px">
      <div class="row wrap" style="align-items:flex-end">
        <label class="field">Du <input id="ptFrom" type="date" value="${pointFrom}"></label>
        <label class="field">Au <input id="ptTo" type="date" value="${pointTo}"></label>
        <label class="field">Caissière
          <select id="ptCaiss"><option value="">Toutes</option>${cashiers.map(x => `<option ${String(pointCaiss) === String(x.id) ? "selected" : ""} value="${x.id}">${esc(x.nom)}</option>`).join("")}</select>
        </label>
        <button class="btn primary" id="ptFilter">🔎 Filtrer</button>
      </div>
    </div>
    <div class="chips">
      <button class="chip-btn ${pointTab === "attente" ? "active" : ""}" data-tab="attente">⏳ En attente (${attente.length})</button>
      <button class="chip-btn ${pointTab === "validees" ? "active" : ""}" data-tab="validees">✅ Validées (${validees.length})</button>
      <button class="chip-btn ${pointTab === "classement" ? "active" : ""}" data-tab="classement">🏆 Classement</button>
    </div>
    ${pointTab === "classement" ? `
    <div class="point-card">
      <h3>🏆 Classement du point (${pointFrom} → ${pointTo})</h3>
      <div class="chips">
        <button class="chip-btn ${pointClass === "caissiere" ? "active" : ""}" data-cl="caissiere">Par caissière</button>
        <button class="chip-btn ${pointClass === "famille" ? "active" : ""}" data-cl="famille">Par famille</button>
        <button class="chip-btn ${pointClass === "article" ? "active" : ""}" data-cl="article">Par article</button>
      </div>
      <div id="pointClassBox"></div>
    </div>` : `
    <div class="point-card">
      <h3>${pointTab === "attente" ? "⏳ Caisses en attente (ouvertes ou fermées à valider)" : "✅ Caisses validées"} - ${pointFrom} → ${pointTo}</h3>
      ${tab.length > 0 ? pgBar("point", tab.length, "caisse(s)") : ""}
      <div class="table-wrap"><table>
        <tr><th class="sticky-l">Caissière</th><th>Ouverture / fermeture</th><th>Statut</th><th class="num">Fonds</th><th class="num">Espèces</th><th class="num">Autres modes</th><th class="num">Attendu tiroir</th><th class="num">Compté</th><th class="num">Écart</th><th class="num">Versé</th><th class="sticky-r">Actions</th></tr>
        ${tab.length === 0 ? `<tr><td colspan="11" class="empty">Aucune caisse dans cet onglet pour la période</td></tr>` : pgSlice("point", tab).part.map(row).join("")}
        <tr style="font-weight:800"><td class="sticky-l">Total période (${tab.length})</td><td colspan="2"></td><td class="num">${money(tFonds)}</td><td class="num">${money(tEsp)}</td><td class="num">${money(tAutres)}</td><td class="num">${money(tAttendu)}</td><td class="num">${money(tCompte)}</td><td class="num">${money(tEcart)}</td><td class="num">${money(tVerse)}</td><td class="sticky-r"></td></tr>
      </table></div>
      <div class="row" style="margin-top:10px">
        <button class="btn primary" id="pointPrint">🖨️ Imprimer ce tableau</button>
        <button class="btn ghost" id="pointCsv">⬇️ CSV</button>
      </div>
      <p class="muted" style="margin-top:8px">💡 ${esc(reglePoint())}</p>
    </div>`}`;
  $("#ptFilter").addEventListener("click", () => {
    pointFrom = $("#ptFrom").value || todayKey();
    pointTo = $("#ptTo").value || todayKey();
    pointCaiss = $("#ptCaiss").value;
    renderers.point().catch(() => { });
  });
  $$("#pointBox .chip-btn").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.tab) { pointTab = b.dataset.tab; renderers.point().catch(() => { }); return; }
    pointClass = b.dataset.cl; renderers.point().catch(() => { });
  }));
  if (pointTab !== "classement") {
  $("#pointPrint").addEventListener("click", () => {
    const corps = `<h2>${pointTab === "attente" ? "Caisses en attente" : "Caisses validées"} - ${pointFrom} → ${pointTo}</h2>` + $("#pointBox .table-wrap").outerHTML;
    imprimer("Récapitulatif des caisses", corps, "A4");
  });
  $("#pointCsv").addEventListener("click", () => {
    const lines = [["Caissière", "Ouverture", "Statut", "Fonds", "Espèces", "Autres modes", "Attendu", "Compté", "Écart", "Versé"]].concat(tab.map(c => [c.user_nom, new Date(c.ouverte_le).toLocaleString("fr-FR"), c.statut, c.fonds_initial, c.especes, c.autres || 0, c.statut === "ouverte" ? c.attendu_especes : c.total_attendu || 0, c.total_compte != null ? c.total_compte : "", c.ecart != null ? c.ecart : "", c.verse_total]));
    downloadCsv("caisses-" + pointFrom + "-" + pointTo + ".csv", lines);
  });
  $$("#pointBox [data-detail]").forEach(b => b.addEventListener("click", () => caisseDetail(caisses.find(c => String(c.id) === String(b.dataset.detail)))));
  $$("#pointBox [data-vers]").forEach(b => b.addEventListener("click", () => versementForm(caisses.find(c => String(c.id) === String(b.dataset.vers)))));
  $$("#pointBox [data-val]").forEach(b => b.addEventListener("click", async () => {
    const c = caisses.find(x => String(x.id) === String(b.dataset.val));
    if (!c) return;
    askConfirm("Valider la clôture", `Valider la clôture de <b>${c.user_nom}</b> ?<br>Attendu : <b>${money(c.total_attendu)}</b><br>Compté : <b>${money(c.total_compte)}</b><br>Écart : <b>${Number(c.ecart) > 0 ? "+" : ""}${money(c.ecart)}</b>`, async () => {
      try { await api(`/caisse/${c.id}/valider`, { method: "PUT" }); toast("Clôture validée ✅"); renderers.point().catch(() => { }); } catch (e) { toast(e.message); }
    }, { okLabel: "Valider" });
  }));
  $$("#pointBox [data-rejet]").forEach(b => b.addEventListener("click", async () => {
    const c = caisses.find(x => String(x.id) === String(b.dataset.rejet));
    if (!c) return;
    askConfirm("Rejeter le point", `Rejeter le point de <b>${c.user_nom}</b> ?<br><span class="muted">La caissière pourra aller voir sa caisse du jour (Ma journée) pour vérifier. Ses nouvelles ventes s'y ajouteront.</span>`, async () => {
      try { await api(`/caisse/${c.id}/rouvrir`, { method: "PUT" }); toast("Point rejeté - la caissière peut vérifier dans Ma journée"); renderers.point().catch(() => { }); } catch (e) { toast(e.message); }
    }, { okLabel: "Rejeter le point", danger: true });
  }));
  }
  if (pointTab === "classement") renderPointClass().catch(() => { });
};
async function caisseDetail(c) {
  let info = null;
  try { info = await api("/caisse/" + c.id); } catch (e) { toast(e.message); return; }
  const vs = (info.versements || []).map(v => `<tr><td>${fmtDate(v.date)}</td><td class="num">${money(v.montant)}</td><td>${esc(modeLabel(v.mode))}</td><td>${esc(v.motif || "-")}</td></tr>`).join("");
  openModal(`<h3>👁️ Caisse - ${esc(c.user_nom)}</h3>
    <p class="muted">Statut : ${c.statut} · ouverte ${new Date(c.ouverte_le).toLocaleString("fr-FR")}${c.fermee_le ? " · fermée " + new Date(c.fermee_le).toLocaleString("fr-FR") : ""}</p>
    <div class="cards" style="margin:8px 0">
      <div class="card"><div class="k">Ventes</div><div class="v">${money(c.total)}</div></div>
      <div class="card"><div class="k">Attendu tiroir</div><div class="v">${money(c.total_attendu != null ? c.total_attendu : c.attendu_especes)}</div></div>
      <div class="card"><div class="k">Compté</div><div class="v">${c.total_compte != null ? money(c.total_compte) : "-"}</div></div>
      <div class="card"><div class="k">Écart</div><div class="v ${Number(c.ecart) === 0 ? "ok" : "bad"}">${c.ecart != null ? (Number(c.ecart) > 0 ? "+" : "") + money(c.ecart) : "-"}</div></div>
    </div>
    <h4>Ventes (${(info.ventes || []).length})</h4>
    <div id="cvWrap"></div>
    <h4 style="margin-top:10px">Versements</h4>
    <div class="table-wrap" style="max-height:160px;overflow:auto"><table><tr><th>Date</th><th class="num">Montant</th><th>Mode</th><th>Motif</th></tr>${vs || `<tr><td colspan="4" class="empty">Aucun versement</td></tr>`}</table></div>
    <div class="row" style="margin-top:12px">
      ${c.fermee_le ? `<button class="btn primary grow" id="cdPrint">🖨️ Reçu de clôture</button>` : ""}
      <button class="btn ghost grow" onclick="closeModal()">Fermer</button>
    </div>`);
  caisseVentesCtx = { c, info };
  renderCaisseVentes();
  if (c.fermee_le) {
    $("#cdPrint").addEventListener("click", () => imprimer("Reçu de clôture", `<pre style="font-family:'Courier New',monospace">CLÔTURE DE CAISSE\n${new Date(c.fermee_le).toLocaleString("fr-FR")}\nCaissière : ${esc(c.user_nom)}\nOuverte : ${new Date(c.ouverte_le).toLocaleString("fr-FR")}\nFonds : ${money(c.fonds_initial)}\nVentes : ${money(c.total)} - ${(info.ventes || []).length} tickets\nEspèces attendues : ${money(c.total_attendu)}\nMontant compté : ${money(c.total_compte)}\nÉcart : ${Number(c.ecart) > 0 ? "+" : ""}${money(c.ecart)}\n${esc(c.notes || "")}</pre>`, "80mm"));
    if (usbPrinter) {
      const rec = { user_nom: c.user_nom, ouverte_le: c.ouverte_le, fermee_le: c.fermee_le, fonds_initial: c.fonds_initial, total: c.total, tickets: c.tickets, total_attendu: c.total_attendu, total_compte: c.total_compte, ecart: c.ecart, notes: c.notes };
      const tb = document.createElement("button");
      tb.className = "btn success grow"; tb.textContent = "🧾 Imprimante thermique";
      tb.addEventListener("click", () => printThermalCloture(rec));
      $("#cdPrint").parentElement.appendChild(tb);
    }
  }
}
let caisseVentesCtx = null;
function renderCaisseVentes() {
  const ctx = caisseVentesCtx; if (!ctx) return;
  const ventes = ctx.info.ventes || [];
  const wrap = $("#cvWrap"); if (!wrap) return;
  const pgv = pgSlice("cVentes", ventes);
  wrap.innerHTML = (ventes.length > 0 ? pgBar("cVentes", ventes.length, "vente(s)") : "") +
    `<div class="table-wrap" style="max-height:220px;overflow:auto"><table><tr><th>Ticket</th><th>Date</th><th>Paiement</th><th class="num">Montant</th></tr>` +
    (ventes.length === 0 ? `<tr><td colspan="4" class="empty">Aucune vente</td></tr>` :
      pgv.part.map(v => `<tr><td>${v.numero}</td><td>${fmtDate(v.date)}</td><td>${esc(modeLabel(v.mode))}</td><td class="num">${money(v.net)}</td></tr>`).join("")) +
    `</table></div>`;
}
async function renderPointClass() {
  let rows = [];
  try { rows = await api(`/point/classement?from=${pointFrom}&to=${pointTo}&par=${pointClass}`); } catch (e) { }
  $("#pointClassBox").innerHTML = rows.length === 0 ? `<div class="empty">Aucune vente aujourd'hui</div>` : `
    ${rows.length > 0 ? pgBar("pointClass", rows.length, "ligne(s)") : ""}
    <div class="table-wrap"><table>
      <tr><th>${pointClass === "caissiere" ? "Caissière" : pointClass === "famille" ? "Famille" : "Article"}</th><th class="num">Quantité</th><th class="num">Montant</th><th class="num">Bénéfice</th></tr>
      ${pgSlice("pointClass", rows).part.map(r => `<tr><td>${esc(r.key)}</td><td class="num">${r.qte}</td><td class="num">${money(r.ca)}</td><td class="num">${money(r.ben)}</td></tr>`).join("")}
    </table></div>`;
}

/* ---------- utilisateurs ---------- */
renderers.users = async function () {
  let users = [];
  try { users = await api("/users"); } catch (e) { toast(e.message); return; }
  $("#usersWrap").innerHTML = (users.length > 0 ? pgBar("users", users.length, "utilisateur(s)") : "") + `
    <div class="table-wrap"><table>
    <tr><th>Nom</th><th>Rôle</th><th>Droits</th><th>Statut</th><th>Dernière connexion</th><th>Actions</th></tr>
    ${pgSlice("users", users).part.map(u => `<tr>
      <td>${esc(u.nom)}</td>
      <td>${roleLabel(u.role_code)}</td>
      <td>${(u.droits || []).length} droit(s)</td>
      <td>${u.actif ? `<span class="badge ok">Actif</span>` : `<span class="badge bad">Désactivé</span>`}</td>
      <td>${u.derniere_connexion ? new Date(u.derniere_connexion).toLocaleString("fr-FR") : `<span class="muted">Jamais</span>`}</td>
      <td><div class="actions">
        <button class="btn small" data-edit="${u.id}">✏️ Modifier</button>
        <button class="btn small ${u.actif ? "danger" : ""}" data-toggle="${u.id}">${u.actif ? "🚫 Désactiver" : "✅ Réactiver"}</button>
      </div></td></tr>`).join("")}
  </table></div>
  <p class="muted" style="margin-top:8px">💡 Les accès de chaque utilisateur suivent automatiquement son rôle. Pour modifier les accès d'un rôle, utilisez « Gérer les rôles ». Un utilisateur désactivé ne peut plus se connecter, mais son historique est conservé.</p>`;
  $$("#usersWrap [data-edit]").forEach(b => b.addEventListener("click", () => userForm(users.find(u => String(u.id) === String(b.dataset.edit)))));
  $$("#usersWrap [data-toggle]").forEach(b => b.addEventListener("click", async () => {
    const u = users.find(x => String(x.id) === String(b.dataset.toggle));
    if (!u) return;
    const msg = !u.actif ? `Réactiver le compte de <b>${u.nom}</b> ?` : `Désactiver le compte de <b>${u.nom}</b> ? Elle ne pourra plus se connecter (historique conservé).`;
    askConfirm(!u.actif ? "Réactiver le compte" : "Désactiver le compte", msg, async () => {
      try {
        await api("/users/" + u.id + "/actif", { method: "PUT", body: JSON.stringify({ actif: !u.actif }) });
        toast(!u.actif ? `${u.nom} réactivé(e)` : `${u.nom} désactivé(e) - ne peut plus se connecter`);
        renderers.users().catch(() => { });
      } catch (e) { toast(e.message); }
    }, { danger: u.actif, okLabel: u.actif ? "Désactiver" : "Réactiver" });
  }));
};
function userForm(u) {
  const isNew = !u;
  u = u || { nom: "", mdp: "", role_code: "caissier", droits: [], actif: true };
  const roles = DB.roles || [];
  openModal(`<h3>${isNew ? "Nouvel utilisateur" : "Modifier : " + esc(u.nom)}</h3>
    <label class="field">Nom d'utilisateur <input id="ufNom" value="${esc(u.nom || "")}"></label>
    <label class="field">Mot de passe
      <span style="display:flex;gap:6px;margin-top:4px"><input id="ufMdp" type="password" value="" placeholder="${isNew ? "obligatoire" : "laisser vide pour ne pas changer"}">
      <button type="button" class="btn ghost small" id="ufEye" style="min-height:42px;flex:0 0 auto" title="Afficher / masquer le mot de passe">👁️</button></span>
    </label>
    <label class="field">Rôle (modèle de départ)
      <select id="ufRole">${roles.map(r => `<option value="${r.code}" ${u.role_code === r.code ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select>
    </label>
    <p class="muted" style="margin-top:6px">Droits de ce rôle (les accès suivent automatiquement le rôle) :</p>
    <div id="ufDroitsBadges" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px"></div>
    <p class="hint" style="margin-top:8px">Les accès de l'utilisateur suivent son rôle. Pour modifier les droits d'un rôle, utilisez « Gérer les rôles ».</p>
    <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="ufActif" style="width:auto" ${u.actif ? "checked" : ""}> Compte actif</label>
    <div class="row"><button class="btn success grow" id="ufSave">💾 Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  const drawDroitsRole = () => {
    const t = roles.find(r => r.code === $("#ufRole").value);
    const codes = (t && t.droits) || [];
    $("#ufDroitsBadges").innerHTML = (DB.droits || []).filter(d => codes.includes(d.code)).map(d => `<span class="badge info">${esc(d.label)}</span>`).join("") || `<span class="muted">Aucun droit</span>`;
  };
  $("#ufRole").addEventListener("change", drawDroitsRole);
  drawDroitsRole();
  $("#ufEye").addEventListener("click", () => { const i = $("#ufMdp"); i.type = i.type === "password" ? "text" : "password"; });
  $("#ufSave").addEventListener("click", async () => {
    const nom = $("#ufNom").value.trim();
    const mdp = $("#ufMdp").value.trim();
    if (!nom) { toast("Le nom est obligatoire"); return; }
    if (isNew && !mdp) { toast("Le mot de passe est obligatoire"); return; }
    const roleSel = roles.find(r => r.code === $("#ufRole").value);
    const body = { nom, role_code: $("#ufRole").value, droits: (roleSel && roleSel.droits) || [], actif: $("#ufActif").checked };
    try {
      if (isNew) { body.mdp = mdp; await api("/users", { method: "POST", body: JSON.stringify(body) }); toast("Utilisateur créé"); }
      else { if (mdp) body.mdp = mdp; await api("/users/" + u.id, { method: "PUT", body: JSON.stringify(body) }); toast("Utilisateur modifié"); }
      closeModal(); renderers.users().catch(() => { });
    } catch (e) { toast(e.message); }
  });
}

async function roleManager() {
  let roles = [];
  try { roles = await api("/roles"); } catch (e) { toast(e.message); return; }
  openModal(`<h3>⚙️ Gérer les rôles</h3>
    <p class="muted">Modifiez les droits d'un rôle : tous les comptes de ce rôle suivront automatiquement.</p>
    <label class="field">Rôle
      <select id="rmRole">${roles.map(r => `<option value="${r.code}">${esc(r.label)}</option>`).join("")}</select>
    </label>
    <div class="droits" id="rmDroits" style="margin-top:8px"></div>
    <div class="row" style="margin-top:10px"><button class="btn success grow" id="rmSave">💾 Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Fermer</button></div>
    <button class="btn ghost" id="rmNew" style="width:100%;margin-top:8px">➕ Créer un nouveau rôle</button>`);
  const draw = () => {
    const r = roles.find(x => x.code === $("#rmRole").value);
    $("#rmDroits").innerHTML = (DB.droits || []).map(d => `<label><input type="checkbox" class="rmDroit" value="${esc(d.code)}" ${((r && r.droits) || []).includes(d.code) ? "checked" : ""}> ${esc(d.label)}</label>`).join("");
  };
  $("#rmRole").addEventListener("change", draw);
  draw();
  $("#rmSave").addEventListener("click", async () => {
    const code = $("#rmRole").value;
    const droits = $$(".rmDroit").filter(c => c.checked).map(c => c.value);
    const r = roles.find(x => x.code === code);
    try {
      await api("/roles/" + code, { method: "PUT", body: JSON.stringify({ label: r ? r.label : code, droits }) });
      toast("Rôle mis à jour - les comptes suivent automatiquement");
      closeModal(); renderers.users().catch(() => { });
    } catch (e) { toast(e.message); }
  });
  $("#rmNew").addEventListener("click", roleForm);
}

async function roleForm() {
  const droits = DB.droits || [];
  openModal(`<h3>➕ Nouveau rôle</h3>
    <label class="field">Nom du rôle <input id="rfNom" placeholder="Ex : Caissière junior"></label>
    <p class="muted" style="margin-top:6px">Droits de ce rôle :</p>
    <div class="droits">${droits.map(d => `<label><input type="checkbox" class="rfDroit" value="${esc(d.code)}"> ${esc(d.label)}</label>`).join("")}</div>
    <div class="row"><button class="btn success grow" id="rfSave">💾 Créer le rôle</button><button class="btn ghost grow" onclick="roleManager()">Annuler</button></div>`);
  $("#rfSave").addEventListener("click", async () => {
    const label = $("#rfNom").value.trim();
    if (!label) { toast("Donnez un nom au rôle"); return; }
    const droitsSel = $$(".rfDroit").filter(c => c.checked).map(c => c.value);
    try {
      await api("/roles", { method: "POST", body: JSON.stringify({ label, droits: droitsSel }) });
      DB.roles = await api("/roles");
      toast(`Rôle « ${label} » créé - disponible dans le formulaire utilisateur`);
      roleManager();
    } catch (e) { toast(e.message); }
  });
}

/* ---------- STOCK DORMANT ---------- */
let dormantJours = 30;
renderers.dormant = async function () {
  try {
    const rows = await api("/stock/dormant?jours=" + dormantJours);
    const totalVal = rows.reduce((s, r) => s + Number(r.valeur_immobilisee), 0);
    $("#dormantBox").innerHTML = rows.length === 0
      ? '<div class="empty">Aucun produit dormant — tout se vend !</div>'
      : '<div class="row wrap" style="margin-bottom:8px"><p class="muted grow" style="margin:0">' + rows.length + ' produit(s) sans vente depuis ' + dormantJours + ' jours — valeur immobilisée : <b>' + money(totalVal) + '</b></p>'
        + '<select id="dormantSel"><option value="15">15 jours</option><option value="30">30 jours</option><option value="60">60 jours</option><option value="90">90 jours</option></select>'
        + '<button class="btn small" id="dormantCsv">CSV</button></div>'
        + '<div class="table-wrap"><table><tr><th>Produit</th><th>Famille</th><th class="num">Stock</th><th class="num">Valeur immobilisée</th><th class="num">Jours sans vente</th><th>Dernière vente</th></tr>'
        + rows.map(r => '<tr><td>' + esc(r.nom) + '</td><td>' + esc(r.famille_nom || '') + '</td>'
          + '<td class="num">' + r.stock + '</td><td class="num">' + money(r.valeur_immobilisee) + '</td>'
          + '<td class="num"><span class="badge ' + (r.jours_sans_vente > 60 ? "bad" : "warn") + '">' + r.jours_sans_vente + ' j</span></td>'
          + '<td>' + (r.derniere_vente ? fmtDate(r.derniere_vente) : 'Jamais') + '</td></tr>').join('')
        + '</table></div>';
    var sel = $("#dormantSel"); if (sel) { sel.value = String(dormantJours); sel.addEventListener("change", function(e) { dormantJours = Number(e.target.value); renderers.dormant().catch(function(){}); }); }
    var csvBtn = $("#dormantCsv"); if (csvBtn) csvBtn.addEventListener("click", function() {
      var lines = [["Produit","Famille","Stock","Valeur","Jours sans vente","Derniere vente"]].concat(rows.map(function(r) { return [r.nom, r.famille_nom||"", r.stock, r.valeur_immobilisee, r.jours_sans_vente, r.derniere_vente||"Jamais"]; }));
      downloadCsv("stock-dormant.csv", lines);
    });
  } catch (e) { toast(e.message); }
};

/* ---------- DEPENSES ---------- */
renderers.depenses = async function () {
  var rows = [];
  try { rows = await api("/depenses"); } catch (e) { toast(e.message); return; }
  var total = rows.reduce(function(s, r) { return s + Number(r.montant); }, 0);
  var cats = ["Loyer","Electricite","Eau","Transport","Salaires","Courses boutique","Materiel","Maintenance","Communication","Autre"];
  $("#depensesBox").innerHTML = '<div class="row wrap" style="margin-bottom:10px"><h2 class="grow" style="margin:0">Depenses</h2>'
    + '<button class="btn primary" id="depAdd">+ Nouvelle depense</button></div>'
    + (rows.length === 0 ? '<div class="empty">Aucune depense enregistree</div>'
    : '<p class="muted" style="margin:0 0 8px">Total : <b>' + money(total) + '</b> — ' + rows.length + ' depense(s)</p>'
    + '<div class="table-wrap"><table><tr><th>Date</th><th>Categorie</th><th>Motif</th><th>Mode</th><th class="num">Montant</th><th>Par</th><th></th></tr>'
    + rows.map(function(r) { return '<tr><td>' + fmtDate(r.date) + '</td><td><span class="badge info">' + esc(r.categorie) + '</span></td>'
      + '<td>' + esc(r.motif || '') + '</td><td>' + esc(r.mode || '') + '</td>'
      + '<td class="num"><b>' + money(r.montant) + '</b></td><td>' + esc(r.user_nom || '') + '</td>'
      + '<td><button class="btn small danger" data-deldep="' + r.id + '">\uD83D\uDDD1</button></td></tr>'; }).join('')
    + '</table></div>');
  var addBtn = $("#depAdd");
  if (addBtn) addBtn.addEventListener("click", function() {
    openModal('<h3>Nouvelle depense</h3>'
      + '<label class="field">Montant (F) <input id="depMontant" type="number" min="1" placeholder="ex. 5000"></label>'
      + '<label class="field">Categorie <select id="depCat">' + cats.map(function(c) { return '<option>' + c + '</option>'; }).join('') + '</select></label>'
      + '<label class="field">Motif <input id="depMotif" placeholder="ex. Facture electricite juillet"></label>'
      + '<label class="field">Mode de paiement <select id="depMode"><option value="especes">Especes</option><option value="mobile">Mobile money</option><option value="carte">Carte</option></select></label>'
      + '<label class="field">Date <input id="depDate" type="date" value="' + todayKey() + '"></label>'
      + '<div class="row"><button class="btn success grow" id="depSave">Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>');
    $("#depSave").addEventListener("click", async function() {
      var montant = Number($("#depMontant").value) || 0;
      if (montant <= 0) { toast("Montant invalide"); return; }
      try {
        await api("/depenses", { method: "POST", body: JSON.stringify({
          montant: montant, categorie: $("#depCat").value, motif: $("#depMotif").value.trim(),
          mode: $("#depMode").value, date: $("#depDate").value
        })});
        toast("Depense enregistree"); closeModal(); renderers.depenses().catch(function(){});
      } catch (e) { toast(e.message); }
    });
  });
  document.querySelectorAll("#depensesBox [data-deldep]").forEach(function(b) { b.addEventListener("click", function() {
    askConfirm("Supprimer la depense", "Confirmer la suppression ?", async function() {
      try { await api("/depenses/" + b.dataset.deldep, { method: "DELETE" }); toast("Depense supprimee"); renderers.depenses().catch(function(){}); }
      catch (e) { toast(e.message); }
    }, { danger: true, okLabel: "Supprimer" });
  }); });
};

/* ---------- ANALYSE ABC ---------- */
renderers.abc = async function () {
  var from = ($("#abcFrom") && $("#abcFrom").value) || todayKey();
  var to = ($("#abcTo") && $("#abcTo").value) || todayKey();
  try {
    var r = await api("/rapports/abc?from=" + from + "&to=" + to);
    var rows = r.rows || [];
    var classA = rows.filter(function(x) { return x.classe === "A"; });
    var classB = rows.filter(function(x) { return x.classe === "B"; });
    var classC = rows.filter(function(x) { return x.classe === "C"; });
    $("#abcBox").innerHTML = '<div class="cards" style="margin-bottom:14px">'
      + '<div class="card"><div class="k">Classe A (80% du CA)</div><div class="v" style="color:var(--success)">' + classA.length + ' produits</div></div>'
      + '<div class="card"><div class="k">Classe B (80-95%)</div><div class="v" style="color:var(--amber)">' + classB.length + ' produits</div></div>'
      + '<div class="card"><div class="k">Classe C (95-100%)</div><div class="v" style="color:var(--danger)">' + classC.length + ' produits</div></div>'
      + '<div class="card"><div class="k">CA total periode</div><div class="v">' + money(r.totalCA) + '</div></div>'
      + '</div>'
      + (rows.length === 0 ? '<div class="empty">Aucune vente sur cette periode</div>'
      : '<div class="table-wrap"><table><tr><th>Classe</th><th>Produit</th><th>Famille</th><th class="num">Qte vendue</th><th class="num">CA</th><th class="num">% CA</th><th class="num">Cumul</th><th class="num">Benefice</th></tr>'
      + rows.map(function(r) { return '<tr style="background:' + (r.classe === "A" ? "rgba(21,128,61,.05)" : r.classe === "C" ? "rgba(185,28,28,.04)" : "") + '">'
        + '<td><span class="badge ' + (r.classe === "A" ? "ok" : r.classe === "B" ? "warn" : "bad") + '">' + r.classe + '</span></td>'
        + '<td>' + esc(r.nom) + '</td><td>' + esc(r.famille || "") + '</td>'
        + '<td class="num">' + r.qte + '</td><td class="num">' + money(r.ca) + '</td>'
        + '<td class="num">' + r.pct.toFixed(1) + '%</td><td class="num">' + r.cumul.toFixed(1) + '%</td>'
        + '<td class="num">' + money(r.benefice) + '</td></tr>'; }).join('')
      + '</table></div>');
  } catch (e) { toast(e.message); }
};

/* ---------- rapports ---------- */
renderers.rapports = async function () {
  if (!$("#rapFrom").value) { $("#rapFrom").value = todayKey(); $("#rapTo").value = todayKey(); }
  genRapport().catch(e => toast(e.message));
};
async function genRapport() {
  const from = $("#rapFrom").value, to = $("#rapTo").value;
  const group = $("#rapGroup").value;
  const r = await api(`/rapports?from=${from}&to=${to}&groupe=${group}`);
  const rows = r.groups || [];
  const tot = r.tot || { qte: 0, ca: 0, ben: 0 };
  $("#rapportBox").innerHTML = `
    <div class="cards">
      <div class="card"><div class="k">Chiffre d'affaires</div><div class="v">${money(tot.ca)}</div></div>
      <div class="card"><div class="k">Bénéfice brut</div><div class="v ok">${money(tot.ben)}</div></div>
      <div class="card"><div class="k">Marge moyenne</div><div class="v">${Number(tot.ca) > 0 ? Math.round(Number(tot.ben) / Number(tot.ca) * 100) : 0} %</div></div>
      <div class="card"><div class="k">Articles vendus</div><div class="v">${tot.qte}</div></div>
    </div>
    ${rows.length > 0 ? pgBar("rapport", rows.length, "ligne(s)") : ""}
    <div class="table-wrap"><table>
      <tr><th>${group === "caissiere" ? "Caissière" : group === "famille" ? "Famille" : "Article"}</th><th class="num">Quantité</th><th class="num">Chiffre d'affaires</th><th class="num">Bénéfice</th><th class="num">Marge</th></tr>
      ${rows.length === 0 ? `<tr><td colspan="5" class="empty">Aucune vente sur cette période</td></tr>` :
        pgSlice("rapport", rows).part.map(x => `<tr><td>${esc(x.key)}</td><td class="num">${x.qte}</td><td class="num">${money(x.ca)}</td><td class="num">${money(x.ben)}</td><td class="num">${Number(x.ca) > 0 ? Math.round(Number(x.ben) / Number(x.ca) * 100) : 0} %</td></tr>`).join("")}
    </table></div>`;
  const top = [...rows].sort((a, b) => Number(b.ben) - Number(a.ben)).slice(0, 5);
  $("#rapportBox").insertAdjacentHTML("beforeend", `<h3>Top produits rentables</h3>` +
    (top.length === 0 ? `<div class="empty">-</div>` : `<div class="table-wrap"><table><tr><th>${group === "article" ? "Article" : "Groupe"}</th><th class="num">Bénéfice</th></tr>` + top.map(x => `<tr><td>${esc(x.key)}</td><td class="num">${money(x.ben)}</td></tr>`).join("") + `</table></div>`, "80mm"));
}

/* ---------- journal ---------- */
function auditDetail(a) {
  if (a.details) return a.details;
  const d = a.new_data || a.old_data;
  if (!d) return "—";
  const act = a.action || "";
  const nom = d.nom || d.numero || "";
  if (act.startsWith("produits:")) return nom || "Produit #" + d.id;
  if (act.startsWith("commandes:")) return "Commande #" + d.id + (d.statut ? " (" + d.statut + ")" : "");
  if (act.startsWith("commande_items:")) return (nom || "Article") + (d.qte != null ? " x " + d.qte : "");
  if (act.startsWith("mouvements:")) return (d.type || "Mouvement") + " " + (d.qte != null ? d.qte : "") + (d.motif ? " (" + d.motif + ")" : "");
  if (act.startsWith("lots:")) return "Lot " + (nom || "#" + d.id);
  if (act.startsWith("ventes:")) return "Vente " + (d.numero || "#" + d.id);
  if (act.startsWith("caisses:")) return "Caisse #" + d.id + (d.statut ? " (" + d.statut + ")" : "");
  if (act.startsWith("users:")) return nom || "Utilisateur #" + d.id;
  if (act.startsWith("fournisseurs:")) return nom || "Fournisseur #" + d.id;
  if (act.startsWith("modes_paiement:")) return nom || "Mode #" + d.id;
  if (act.startsWith("boutique:")) return "Identité de la boutique modifiée";
  if (act.startsWith("bons:")) return "Bon " + (d.type || "") + (d.reference ? " (" + d.reference + ")" : "");
  if (act.startsWith("versements")) return "Versement " + (d.montant != null ? d.montant + " FCFA" : "");
  return nom ? String(nom) : JSON.stringify(d).slice(0, 100);
}
renderers.journal = async function () {
  let rows = [];
  try { rows = await api("/audit?user=" + encodeURIComponent($("#audUserFilter").value || "") + "&search=" + encodeURIComponent($("#audSearch").value || "")); } catch (e) { toast(e.message); return; }
  const sel = $("#audUserFilter");
  const users = [...new Set(rows.map(a => a.user_nom).filter(Boolean))];
  sel.innerHTML = `<option value="">Tous les utilisateurs</option>` + users.map(u => `<option ${sel.value === u ? "selected" : ""}>${esc(u)}</option>`).join("");
  $("#journalWrap").innerHTML = rows.length === 0 ? `<div class="empty">Aucune entrée</div>` : `
    ${rows.length > 0 ? pgBar("journal", rows.length, "entrée(s)") : ""}
    <div class="table-wrap"><table><tr><th>Date / heure</th><th>Utilisateur</th><th>Action</th><th>Détails</th></tr>
    ${pgSlice("journal", rows).part.map(a => `<tr><td>${fmtDate(a.date)}</td><td>${esc(a.user_nom || "système")}</td><td>${esc(a.action)}</td><td>${esc(auditDetail(a))}</td></tr>`).join("")}
    </table></div>
    <p class="muted">${rows.length} entrée(s) - journal inaltérable stocké dans PostgreSQL</p>`;
};

/* ---------- paramètres ---------- */
renderers.params = async function () {
  try { DB.boutique = await api("/boutique"); } catch (e) { toast(e.message); }
  const b = DB.boutique || {};
  $("#paramsBox").innerHTML = `
    <div class="tabs" style="margin-bottom:10px">
      <button class="tab on" data-ptab="id">🏪 Identité de la boutique</button>
      <button class="tab" data-ptab="modes">💳 Modes de paiement</button>
      <button class="tab" data-ptab="ticket">🧾 Aperçu du ticket</button>
    </div>
    <div id="ptPaneId">
      <div class="panel" style="margin-bottom:10px">
        <h3>🏪 Identité de la boutique (apparaît sur les tickets et documents)</h3>
        <div class="row"><label class="field grow">Nom de la boutique <input id="bpNom" value="${esc(b.nom || "")}"></label>
          <label class="field grow">Devise <input id="bpDevise" value="${esc(b.devise || "FCFA")}"></label></div>
        <div class="row"><label class="field grow">Téléphone <input id="bpTel" value="${esc(b.tel || "")}"></label>
          <label class="field grow">E-mail <input id="bpEmail" value="${esc(b.email || "")}"></label></div>
        <div class="row"><label class="field grow">Adresse <input id="bpAdresse" value="${esc(b.adresse || "")}"></label>
          <label class="field grow">Horaires <input id="bpHoraires" value="${esc(b.horaires || "")}"></label></div>
        <label class="field">Pied de page des documents <input id="bpPied" value="${esc(b.pied || "")}"></label>
        <label class="field">Règle du point du soir (affichée sur la page Clôture de caisse) <input id="bpRegle" value="${esc(b.point_regle || "")}"></label>
        <label class="field">Logo <input id="bpLogo" type="file" accept="image/*"></label>
        <div id="bpLogoPrev">${b.logo ? `<img src="${b.logo}" class="mini-logo">` : ""}</div>
        <div class="row"><button class="btn primary grow" id="bpSave">💾 Enregistrer</button></div>
        <label class="field">Remise maximale autorisée à la caisse (%) - 0 = aucune remise
          <input id="bpRemiseMax" type="number" min="0" max="100" value="${getParam("remise_max_pct") ?? 100}">
          <span class="muted" style="font-size:12px">Partagé sur tous les appareils ; la limite est aussi vérifiée côté serveur.</span></label>
      </div>
    </div>
    <div id="ptPaneModes" style="display:none">
      <div class="panel">
        <h3>💳 Modes de paiement</h3>
        <p class="muted">Créez vos propres modes (Wave, Orange Money, Chèque, Crédit...). « Espèces » = l'argent compté dans le tiroir.</p>
        <div id="modesBox"></div>
        <button class="btn small primary" id="newModeBtn" style="margin-top:6px">+ Nouveau mode de paiement</button>
      </div>
    </div>
    <div id="ptPaneTicket" style="display:none">
      <div class="panel" style="margin-bottom:10px">
        <h3>🧾 Aperçu du ticket</h3>
        <div class="ticket-preview">${esc(ticketHTML({ numero: "T0000", date: new Date().toISOString(), user_nom: "Caissière", items: [{ nom: "Eau minérale 1,5L", qte: 2, prix: 750 }, { nom: "Savon de toilette", qte: 1, prix: 500 }], remise: 0, net: 2000, mode: "especes", recu: 2000, rendu: 0 }))}</div>
      </div>
      <div class="panel" style="margin-bottom:10px">
        <h3>🖨️ Impression</h3>
        <div class="row">
          <label class="field grow">Largeur du ticket
            <select id="bpWidth"><option value="80" ${(getParam("ticket_width") || "80") === "80" ? "selected" : ""}>80 mm (standard)</option><option value="58" ${getParam("ticket_width") === "58" ? "selected" : ""}>58 mm (petite imprimante)</option></select></label>
          <label class="field grow" style="display:flex;gap:8px;align-items:center;margin-top:26px"><input type="checkbox" id="bpBarcode" style="width:auto" ${getParam("ticket_barcode") !== "0" ? "checked" : ""}> Code-barres sur le ticket</label>
        </div>
        <div class="panel" style="margin-top:4px">
          <b style="font-size:13px">🖨️ Imprimante thermique USB (WebUSB - Chrome/Edge)</b>
          <p class="muted">Connectez l'imprimante en USB, puis :</p>
          <div class="row">
            <button class="btn primary" id="usbConnect">🔌 Connecter l'imprimante</button>
            <button class="btn ghost" id="usbTest">🧪 Test d'impression</button>
            <button class="btn ghost" id="usbDisconnect">Déconnecter</button>
          </div>
          <p class="muted" id="usbStatus">${usbPrinter ? "✅ Imprimante connectée" : "Aucune imprimante connectée"}</p>
        </div>
      </div>
    </div>
    <p class="muted">💾 Les données sont stockées dans PostgreSQL - synchronisées entre tous les appareils en temps réel.</p>`;
  const ptTabs = { id: $("#ptPaneId"), modes: $("#ptPaneModes"), ticket: $("#ptPaneTicket") };
  $$("#paramsBox [data-ptab]").forEach(btn => btn.addEventListener("click", () => {
    $$("#paramsBox [data-ptab]").forEach(x => x.classList.toggle("on", x === btn));
    Object.entries(ptTabs).forEach(([k, pane]) => { pane.style.display = k === btn.dataset.ptab ? "" : "none"; });
  }));
  $("#bpLogo").addEventListener("change", e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 300 * 1024) { toast("Image trop lourde (max 300 Ko)"); return; }
    const rd = new FileReader();
    rd.onload = () => { $("#bpLogoPrev").innerHTML = `<img src="${rd.result}" class="mini-logo">`; DB.boutique.logo = rd.result; };
    rd.readAsDataURL(f);
  });
  $("#bpSave").addEventListener("click", async () => {
    const b2 = DB.boutique;
    b2.nom = $("#bpNom").value.trim() || "Boutique";
    b2.devise = $("#bpDevise").value.trim() || "F";
    b2.tel = $("#bpTel").value.trim(); b2.email = $("#bpEmail").value.trim();
    b2.adresse = $("#bpAdresse").value.trim(); b2.horaires = $("#bpHoraires").value.trim(); b2.pied = $("#bpPied").value.trim();
    b2.point_regle = $("#bpRegle").value.trim() || null;
    try {
      await api("/boutique", { method: "PUT", body: JSON.stringify(b2) });
      applyBrand(); toast("Paramètres enregistrés");
    } catch (e) { toast(e.message); }
  });
  $("#bpWidth").addEventListener("change", async e => {
    try { DB.params = await api("/parametres", { method: "PUT", body: JSON.stringify({ ticket_width: e.target.value }) }); toast("Largeur du ticket enregistrée (partagée sur tous les appareils)"); } catch (err) { toast(err.message); }
  });
  $("#bpBarcode").addEventListener("change", async e => {
    try { DB.params = await api("/parametres", { method: "PUT", body: JSON.stringify({ ticket_barcode: e.target.checked ? "1" : "0" }) }); toast("Option enregistrée (partagée sur tous les appareils)"); } catch (err) { toast(err.message); }
  });
  $("#bpRemiseMax").addEventListener("change", async e => {
    const v = Math.min(100, Math.max(0, Number(e.target.value) || 0));
    try { DB.params = await api("/parametres", { method: "PUT", body: JSON.stringify({ remise_max_pct: v }) }); toast("Remise max enregistrée : " + v + " % (partagée sur tous les appareils)"); } catch (err) { toast(err.message); }
  });
  $("#usbConnect").addEventListener("click", async () => { await connectUsb(); renderers.params().catch(() => { }); });
  $("#usbTest").addEventListener("click", testUsb);
  $("#usbDisconnect").addEventListener("click", () => { usbPrinter = null; toast("Imprimante déconnectée"); renderers.params().catch(() => { }); });
  let modes = [];
  try { modes = await api("/modes-paiement"); } catch (e) { }
  DB.modes = modes;
  $("#modesBox").innerHTML = `<div class="table-wrap"><table>
    <tr><th>Nom</th><th>Code</th><th>Type</th><th>Statut</th><th>Actions</th></tr>
    ${modes.map(m => `<tr>
      <td>${esc(m.nom)}</td><td>${esc(m.code)}</td>
      <td>${m.especes ? "💰 Espèces (tiroir)" : "Autre mode"}</td>
      <td>${m.actif ? `<span class="badge ok">Actif</span>` : `<span class="badge bad">Inactif</span>`}</td>
      <td><div class="actions">
        <button class="btn small" data-edit="${m.id}">✏️ Modifier</button>
        <button class="btn small" data-tog="${m.id}">${m.actif ? "🚫 Désactiver" : "✅ Activer"}</button>
      </div></td></tr>`).join("")}
  </table></div>`;
  $$("#modesBox [data-edit]").forEach(b => b.addEventListener("click", () => modeForm(modes.find(m => String(m.id) === String(b.dataset.edit)))));
  $$("#modesBox [data-tog]").forEach(b => b.addEventListener("click", async () => {
    const m = modes.find(x => String(x.id) === String(b.dataset.tog));
    if (!m) return;
    askConfirm(m.actif ? "Désactiver le mode" : "Activer le mode", `${m.actif ? "Désactiver" : "Activer"} le mode <b>« ${m.nom} »</b> ?`, async () => {
      try { await api("/modes-paiement/" + m.id, { method: "PUT", body: JSON.stringify({ nom: m.nom, especes: m.especes, actif: !m.actif }) }); toast("Mode mis à jour"); renderers.params().catch(() => { }); } catch (e) { toast(e.message); }
    }, { danger: m.actif, okLabel: m.actif ? "Désactiver" : "Activer" });
  }));
  $("#newModeBtn").addEventListener("click", () => modeForm(null));
};
function modeForm(m) {
  const isNew = !m; m = m || { nom: "", especes: false, actif: true, code: "" };
  openModal(`<h3>${isNew ? "Nouveau mode de paiement" : "Modifier : " + esc(m.nom)}</h3>
    <label class="field">Nom <input id="mdNom" value="${esc(m.nom)}" placeholder="ex. Wave, Orange Money, Chèque..."></label>
    <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="mdEsp" style="width:auto" ${m.especes ? "checked" : ""} ${m.code === "especes" ? "disabled" : ""}> 💰 C'est un paiement en espèces (compté dans le tiroir)</label>
    <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="mdActif" style="width:auto" ${m.actif ? "checked" : ""}> Actif (proposé à la caisse)</label>
    <div class="row"><button class="btn success grow" id="mdSave">💾 Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  $("#mdSave").addEventListener("click", async () => {
    const nom = $("#mdNom").value.trim();
    if (!nom) { toast("Le nom est obligatoire"); return; }
    try {
      if (isNew) await api("/modes-paiement", { method: "POST", body: JSON.stringify({ nom, especes: $("#mdEsp").checked, actif: $("#mdActif").checked }) });
      else await api("/modes-paiement/" + m.id, { method: "PUT", body: JSON.stringify({ nom, especes: m.code === "especes" ? true : $("#mdEsp").checked, actif: $("#mdActif").checked }) });
      toast("Mode de paiement enregistré"); closeModal(); renderers.params().catch(() => { });
    } catch (e) { toast(e.message); }
  });
}

/* ---------- impression ---------- */
function barcodeSVG(code) {
  if (typeof JsBarcode === "undefined" || !code) return "";
  const div = document.createElement("div");
  div.style.position = "absolute"; div.style.left = "-9999px";
  document.body.appendChild(div);
  try {
    JsBarcode(div, String(code), { format: "CODE128", width: 2, height: 60, displayValue: true, fontSize: 14, margin: 0 });
    return div.innerHTML;
  } catch (e) { return ""; } finally { div.remove(); }
}
function printTicket(v) {
  const b = DB.boutique || {};
  const w = (getParam("ticket_width") || "80") === "58" ? "58mm" : "80mm";
  const withBc = getParam("ticket_barcode") !== "0";
  const lines = (v.items || []).map(i => `<tr><td>${esc(i.nom)}</td><td class="n">${i.qte} × ${money(i.prix)}</td><td class="n">${money(Number(i.qte) * Number(i.prix))}</td></tr>`).join("");
  const corps = `<div style="width:${w};margin:0 auto;font-family:'Courier New',monospace;font-size:13px">
    ${withBc ? `<div style="text-align:center;margin-bottom:6px">${barcodeSVG(v.numero)}</div>` : ""}
    <table style="width:100%;border-collapse:collapse">${lines}</table>
    ${Number(v.remise) ? `<p>Remise : -${money(v.remise)}</p>` : ""}
    <p><b>TOTAL : ${money(v.net)}</b></p>
    <p>Paiement : ${({ especes: "Espèces", mobile: "Mobile money", carte: "Carte" }[v.mode] || v.mode)}</p>
    <p>Reçu : ${money(v.recu)}${Number(v.rendu) ? ` - Rendu : ${money(v.rendu)}` : ""}</p>
  </div>`;
  imprimer("Ticket " + v.numero, corps, w);
}
function escposBytes(v) {
  const enc = new TextEncoder();
  const out = [];
  const push = (...arr) => arr.forEach(x => out.push(...x));
  const txt = s => out.push(...enc.encode(String(s ?? "")));
  const feed = n => out.push(...Array(n).fill(0x0A));
  push([0x1B, 0x40]);
  push([0x1B, 0x61, 0x01], [0x1B, 0x45, 0x01]);
  txt((DB.boutique || {}).nom || "Boutique"); feed(1);
  push([0x1B, 0x45, 0x00]);
  txt(((DB.boutique || {}).adresse || "") + "  " + ((DB.boutique || {}).tel || "")); feed(1);
  push([0x1B, 0x61, 0x00]);
  txt("Ticket: " + v.numero + "   " + new Date(v.date).toLocaleString("fr-FR")); feed(1);
  txt("Caissiere: " + (v.user_nom || "")); feed(1);
  txt("--------------------------------"); feed(1);
  (v.items || []).forEach(i => { txt(i.nom); feed(1); txt("  " + i.qte + " x " + money(i.prix) + " = " + money(Number(i.qte) * Number(i.prix))); feed(1); });
  if (Number(v.remise)) { txt("Remise: -" + money(v.remise)); feed(1); }
  push([0x1B, 0x45, 0x01]);
  txt("TOTAL: " + money(v.net)); feed(1);
  push([0x1B, 0x45, 0x00]);
  txt("Paiement: " + modeLabel(v.mode).normalize("NFD").replace(/[\u0300-\u036f]/g, "")); feed(1);
  txt("Recu: " + money(v.recu) + (Number(v.rendu) ? "   Rendu: " + money(v.rendu) : "")); feed(1);
  push([0x1B, 0x61, 0x01]);
  txt((DB.boutique || {}).pied || ""); feed(2);
  push([0x1D, 0x56, 0x42, 0x00]);
  return new Uint8Array(out);
}
async function connectUsb() {
  if (!navigator.usb) { toast("WebUSB non supporté - utilisez Chrome ou Edge"); return; }
  try {
    usbPrinter = await navigator.usb.requestDevice({ filters: [] });
    await usbPrinter.open();
    const conf = usbPrinter.configurations[0];
    await usbPrinter.selectConfiguration(conf.configurationValue);
    let ok = false;
    for (const i of conf.interfaces) {
      try { await usbPrinter.claimInterface(i.interfaceNumber); ok = true; break; } catch (e) { }
    }
    if (!ok) throw new Error("Interface introuvable");
    const eps = conf.interfaces[0].alternate.endpoints.filter(e => e.direction === "out");
    usbPrinter._ep = eps.length ? eps[0].endpointNumber : 2;
    toast("Imprimante USB connectée ✓");
  } catch (e) { usbPrinter = null; toast("Connexion annulée ou échouée"); }
}
async function printThermal(v) {
  if (!usbPrinter) { toast("Connectez d'abord l'imprimante (Paramètres)"); return; }
  try { await usbPrinter.transferOut(usbPrinter._ep, escposBytes(v)); toast("Imprimé ✓"); }
  catch (e) { toast("Erreur d'impression - vérifiez l'imprimante"); }
}
function escposClotureBytes(r) {
  const enc = new TextEncoder();
  const out = [];
  const push = (...arr) => arr.forEach(x => out.push(...x));
  const txt = s => out.push(...enc.encode(String(s ?? "")));
  const feed = n => out.push(...Array(n).fill(0x0A));
  push([0x1B, 0x40]);
  push([0x1B, 0x61, 0x01], [0x1B, 0x45, 0x01]);
  txt((DB.boutique || {}).nom || "Boutique"); feed(1);
  push([0x1B, 0x45, 0x00]);
  txt(((DB.boutique || {}).adresse || "") + "  " + ((DB.boutique || {}).tel || "")); feed(1);
  push([0x1B, 0x61, 0x00]);
  txt("CLOTURE DE CAISSE"); feed(1);
  txt(new Date(r.fermee_le || new Date()).toLocaleString("fr-FR")); feed(1);
  txt("Caissiere: " + (r.user_nom || "")); feed(1);
  txt("Ouverte a: " + new Date(r.ouverte_le).toLocaleTimeString("fr-FR")); feed(1);
  txt("--------------------------------"); feed(1);
  txt("Fonds initial: " + money(r.fonds_initial)); feed(1);
  txt("Ventes: " + money(r.total) + "  (" + r.tickets + " tickets)"); feed(1);
  push([0x1B, 0x45, 0x01]);
  txt("ESPECES ATTENDUES: " + money(r.total_attendu)); feed(1);
  txt("MONTANT COMPTE: " + money(r.total_compte)); feed(1);
  txt("ECART: " + (Number(r.ecart) > 0 ? "+" : "") + money(r.ecart)); feed(1);
  push([0x1B, 0x45, 0x00]);
  txt(Number(r.ecart) !== 0 ? "*** ECART A VERIFIER ***" : "*** AUCUN ECART ***"); feed(1);
  if (r.notes) { txt("Note: " + r.notes); feed(1); }
  push([0x1B, 0x61, 0x01]);
  txt((DB.boutique || {}).pied || ""); feed(2);
  push([0x1D, 0x56, 0x42, 0x00]);
  return new Uint8Array(out);
}
async function printThermalCloture(r) {
  if (!usbPrinter) { toast("Connectez d'abord l'imprimante (Paramètres)"); return; }
  try { await usbPrinter.transferOut(usbPrinter._ep, escposClotureBytes(r)); toast("Imprimé ✓"); }
  catch (e) { toast("Erreur d'impression - vérifiez l'imprimante"); }
}
async function testUsb() {
  if (!usbPrinter) { toast("Connectez d'abord l'imprimante"); return; }
  try {
    const enc = new TextEncoder();
    const bytes = [0x1B, 0x40, 0x1B, 0x61, 0x01, ...enc.encode("GSV - Test d'impression OK"), 0x0A, 0x0A, 0x1D, 0x56, 0x42, 0x00];
    await usbPrinter.transferOut(usbPrinter._ep, new Uint8Array(bytes));
    toast("Test imprimé ✓");
  } catch (e) { toast("Erreur d'impression"); }
}

/* ---------- impression ---------- */
const DOC_FORMATS = {
  "A4":   { w: "210mm", h: "297mm", label: "A4 (feuille standard)" },
  "A5":   { w: "148mm", h: "210mm", label: "A5 (demi-feuille)" },
  "A6":   { w: "105mm", h: "148mm", label: "A6 (petite fiche)" },
  "80mm": { w: "80mm",  h: "", label: "80 mm (ticket thermique)" },
  "58mm": { w: "58mm",  h: "", label: "58 mm (petit ticket)" }
};
function choisirFormat(titre, corps, suggere) {
  const fam = (suggere === "80mm" || suggere === "58mm") ? "ticket" : "papier";
  const mem = sessionStorage.getItem("gs_doc_fmt_" + fam) || suggere || "A4";
  const valide = DOC_FORMATS[mem] ? mem : (fam === "ticket" ? "80mm" : "A4");
  openModal(`<div class="confirm-box">
    <div class="confirm-ic">🖨️</div>
    <h3>Format du document</h3>
    <p class="muted">Choisissez la taille de papier pour « ${esc(titre)} » :</p>
    <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:12px" id="fmtList">
      ${Object.keys(DOC_FORMATS).map(k => `<button type="button" class="btn ${valide === k ? "primary" : "ghost"}" data-fmt="${k}">${DOC_FORMATS[k].label}</button>`).join("")}
    </div>
    <div class="row" style="gap:8px;margin-top:14px"><button type="button" class="btn ghost grow" onclick="closeModal()">Annuler</button></div>
  </div>`);
  $$("#fmtList .btn").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.fmt;
    sessionStorage.setItem("gs_doc_fmt_" + fam, k);
    closeModal();
    imprimerDirect(titre, corps, k);
  }));
}
function imprimer(titre, corps, format) {
  // Toujours demander la taille du papier (format = taille suggérée, pré-sélectionnée)
  choisirFormat(titre, corps, format);
}
function imprimerDirect(titre, corps, format) {
  const b = DB.boutique || {};
  const f = DOC_FORMATS[format] || DOC_FORMATS["A4"];
  const etroit = format === "80mm" || format === "58mm";
  const pageCss = etroit
    ? `@page{size:${f.w} auto;margin:4mm}`
    : `@page{size:${f.w} ${f.h};margin:10mm}`;
  const w = window.open("", "_blank", "width=420,height=600");
  if (!w) { toast("Autorisez les fenêtres pop-up pour imprimer"); return; }
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>${esc(titre)}</title>
    <style>${pageCss}
    body{font-family:Arial,sans-serif;margin:${etroit ? "0" : "20px"};color:#111${etroit ? `;width:${f.w}` : ""}}
    header{text-align:center;margin-bottom:14px}
    header img{height:${etroit ? "32px" : "56px"}}
    ${etroit ? "header h2{font-size:14px;margin:4px 0 2px}header div{font-size:10px}footer{font-size:9px;margin-top:10px}" : ""}
    footer{margin-top:18px;font-size:12px;color:#555;text-align:center;border-top:1px solid #ccc;padding-top:8px}</style></head>
    <body><header>${b.logo ? `<img src="${b.logo}">` : ""}<h2 style="margin:6px 0 2px">${esc(b.nom || "")}</h2>
    <div style="font-size:12px;color:#555">${esc(b.adresse || "")} - ${esc(b.tel || "")}</div></header>
    ${corps}
    <footer>${esc(b.pied || "")}<br>${esc(b.email || "")} - ${esc(b.horaires || "")}</footer>
    <script>window.onload=function(){window.print();}<\/script></body></html>`);
  w.document.close();
}

/* ---------- modal / toast ---------- */
function openModal(html) { $("#modalCard").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  $("#modal").classList.add("hidden");
}
let toastTimer = null;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}
let confirmCb = null;
function askConfirm(titre, message, onOk, opts) {
  opts = opts || {};
  opts = opts || {};
  confirmCb = onOk;
  openModal(`<div class="confirm-box">
    <div class="confirm-ic">${opts.icone || (opts.danger ? "⚠️" : "❓")}</div>
    <h3>${esc(titre)}</h3>
    <p>${String(message || "").replace(/\n/g, "<br>")}</p>
    <div class="row" style="gap:8px;margin-top:16px">
      <button class="btn ghost grow" id="cfNo">Annuler</button>
      <button class="btn ${opts.danger ? "danger" : "primary"} grow" id="cfOk">${esc(opts.okLabel || "Confirmer")}</button>
    </div>
  </div>`);
  $("#cfNo").addEventListener("click", () => { closeModal(); confirmCb = null; });
  $("#cfOk").addEventListener("click", () => { closeModal(); const cb = confirmCb; confirmCb = null; if (cb) cb(); });
  // Enter = confirm, Escape = cancel
  document.addEventListener("keydown", function cfKey(e) {
    if (e.key === "Enter" && !document.querySelector("#modal").classList.contains("hidden")) {
      e.preventDefault(); document.removeEventListener("keydown", cfKey);
      closeModal(); const cb = confirmCb; confirmCb = null; if (cb) cb();
    } else if (e.key === "Escape" && !document.querySelector("#modal").classList.contains("hidden")) {
      e.preventDefault(); document.removeEventListener("keydown", cfKey);
      closeModal(); confirmCb = null;
    }
  });
}
function askPrompt(titre, valeurDefaut, onOk) {
  openModal(`<div class="confirm-box">
    <div class="confirm-ic">✏️</div>
    <h3>${esc(titre)}</h3>
    <input id="apInput" value="${esc(valeurDefaut || "")}" style="margin-top:6px">
    <div class="row" style="gap:8px;margin-top:14px">
      <button class="btn ghost grow" id="apNo">Annuler</button>
      <button class="btn primary grow" id="apOk">Enregistrer</button>
    </div>
  </div>`);
  const inp = $("#apInput"); inp.focus(); inp.select();
  const fin = ok => { closeModal(); if (ok && onOk) onOk(inp.value); };
  $("#apNo").addEventListener("click", () => fin(false));
  $("#apOk").addEventListener("click", () => fin(true));
  inp.addEventListener("keydown", function(e) { if (e.key === "Enter") { e.preventDefault(); fin(true); } });
  inp.addEventListener("keydown", e => { if (e.key === "Enter") fin(true); });
}

/* ---------- événements ---------- */

/* ---------- NOTIFICATIONS VERSEMENTS ---------- */
let notifCount = 0;
async function checkNotifVersements() {
  try {
    const r = await api("/versements/en-attente");
    notifCount = (r.rows || []).length;
    const badge = document.getElementById("notifBadge");
    const badgeTab = document.getElementById("notifBadgeTab");
    if (badge) { badge.textContent = notifCount; badge.classList.toggle("hidden", notifCount === 0); }
    if (badgeTab) { badgeTab.textContent = notifCount; badgeTab.classList.toggle("hidden", notifCount === 0); }
  } catch (e) { /* silent */ }
}
function renderVersementsAttente() {
  api("/versements/en-attente").then(r => {
    const box = document.getElementById("versementBox");
    if (!box) return;
    const rows = r.rows || [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty">Aucune demande de versement en attente</div>';
      return;
    }
    box.innerHTML = '<p class="muted" style="margin:0 0 8px">' + rows.length + ' demande(s) en attente</p>'
      + '<div class="table-wrap"><table><tr><th>Caissière</th><th class="num">Montant</th><th>Mode</th><th>Motif</th><th>Date</th><th>Actions</th></tr>'
      + rows.map(function(v) {
        return '<tr><td>' + esc(v.caissiere_nom) + '</td><td class="num"><b>' + money(v.montant) + '</b></td>'
          + '<td>' + esc(v.mode) + '</td><td>' + esc(v.motif || '') + '</td>'
          + '<td>' + fmtDate(v.date) + '</td>'
          + '<td><div class="actions">'
          + '<button class="btn small success" data-vval="' + v.id + '">✓ Valider</button>'
          + '<button class="btn small danger" data-vref="' + v.id + '">✗ Refuser</button>'
          + '</div></td></tr>';
      }).join('') + '</table></div>';
    document.querySelectorAll("[data-vval]").forEach(function(b) {
      b.addEventListener("click", async function() {
        try { await api("/versements/" + b.dataset.vval + "/valider", { method: "POST" }); toast("Versement validé"); checkNotifVersements(); renderVersementsAttente(); }
        catch (e) { toast(e.message); }
      });
    });
    document.querySelectorAll("[data-vref]").forEach(function(b) {
      b.addEventListener("click", function() {
        askPrompt("Refuser le versement", "", async function(motif) {
          if (!motif || !motif.trim()) { toast("Motif obligatoire"); return; }
          try { await api("/versements/" + b.dataset.vref + "/refuser", { method: "POST", body: JSON.stringify({ motif: motif.trim() }) }); toast("Versement refusé"); checkNotifVersements(); renderVersementsAttente(); }
          catch (e) { toast(e.message); }
        });
      });
    });
  }).catch(function(e) { toast(e.message); });
}
function renderVersementConfig() {
  api("/parametres").then(function(rows) {
    var p = {};
    rows.forEach(function(r) { p[r.cle] = r.valeur; });
    var validateur = p.versement_validateur || "admin";
    var box = document.getElementById("versementConfigBox");
    if (!box) return;
    box.innerHTML = '<label class="field">Validateur des versements <select id="vcSel">'
      + (DB.users || []).map(function(u) { return '<option value="' + esc(u.nom) + '"' + (u.nom === validateur ? ' selected' : '') + '>' + esc(u.nom) + ' (' + esc(u.role_code) + ')</option>'; }).join('')
      + '</select></label>'
      + '<p class="muted">L\'utilisateur sélectionné recevra les demandes de versement et pourra les valider ou les refuser. L\'admin garde toujours ce droit.</p>'
      + '<button class="btn primary" id="vcSave">Enregistrer</button>';
    document.getElementById("vcSave").addEventListener("click", async function() {
      try { await api("/parametres", { method: "PUT", body: JSON.stringify({ versement_validateur: document.getElementById("vcSel").value }) }); toast("Validateur enregistré"); }
      catch (e) { toast(e.message); }
    });
  }).catch(function(e) { toast(e.message); });
}

function bind() {
  $("#loginBtn").addEventListener("click", doLogin);
  $("#loginPass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  $("#loginUser").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  $("#logoutBtn").addEventListener("click", doLogout);
  const refreshBtn = $("#refreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", () => { if (curView && renderers[curView]) { viewLoading(curView); renderers[curView]().catch(e => { const msg = String((e && e.message) || e); if (/injoignable|hors ligne|Failed to fetch|network/i.test(msg)) viewErreurReseau(curView); else toast(e.message || "Erreur"); }); } });
  $$("#sideNav .nav-link").forEach(a => {
    a.tabIndex = 0;
    a.addEventListener("click", () => go(a.dataset.view));
    a.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(a.dataset.view); } });
  });
  $("#scanBtn").addEventListener("click", openScan);
  $("#encaisserBtn").addEventListener("click", encaisser);
  $("#cartRemise").addEventListener("input", renderCart);
  $("#cartMode").addEventListener("change", renderCart);
  $("#cartRecu").addEventListener("input", renderCart);
  if (document.getElementById("cartRecu")) document.getElementById("cartRecu").addEventListener("focus", function() { if (Number(this.value) === 0) this.value = ""; });
  if (document.getElementById("cartRecu")) document.getElementById("cartRecu").addEventListener("blur", function() { if (!this.value) { this.value = 0; renderCart(); } });
  if ($("#cartRecu")) $("#cartRecu").addEventListener("keydown", function(e) { if (e.key === "Enter") { e.preventDefault(); encaisser(); } });
  $("#venteSearch").addEventListener("input", e => { venteFilter = e.target.value; renderVenteGrid(); });
  $("#venteSearch").addEventListener("keydown", e => { if (e.key === "Enter" && venteFilter) { if (addByCode(venteFilter)) $("#venteSearch").value = ""; } });
  $("#venteFamille").addEventListener("change", renderVenteGrid);
  $("#venteSort").addEventListener("change", renderVenteGrid);
  $$("#view-rapports .chip-btn").forEach(b => b.addEventListener("click", () => {
    const per = b.dataset.per, d = new Date();
    const f = x => x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
    if (per === "today") { $("#rapFrom").value = f(d); $("#rapTo").value = f(d); }
    else if (per === "yesterday") { const y = new Date(d); y.setDate(y.getDate() - 1); $("#rapFrom").value = f(y); $("#rapTo").value = f(y); }
    else if (per === "7j") { const y = new Date(d); y.setDate(y.getDate() - 6); $("#rapFrom").value = f(y); $("#rapTo").value = f(d); }
    else { $("#rapFrom").value = f(new Date(d.getFullYear(), d.getMonth(), 1)); $("#rapTo").value = f(d); }
    genRapport().catch(e => toast(e.message));
  }));
document.addEventListener("keydown", function(e) {
    var tag = (e.target.tagName || "").toLowerCase();
    var typing = tag === "input" || tag === "select" || tag === "textarea";
    if (typing && !e.key.startsWith("F") && e.key !== "Escape") return;
    if (curView === "vente") {
      if (e.key === "F3") { e.preventDefault(); var lq = document.querySelector("#cartLines .qty input:last-child"); if (lq) { lq.focus(); lq.select(); } return; }
      if (e.key === "F4") { e.preventDefault(); var r = document.getElementById("cartRemise"); if (r) { r.focus(); r.select(); } return; }
      if (e.key === "F5") { e.preventDefault(); e.stopImmediatePropagation(); var m = document.getElementById("cartMode"); if (m) { m.selectedIndex = (m.selectedIndex + 1) % m.options.length; renderCart(); } return; }
      if (e.key === "F6") {
        e.preventDefault();
        var suspended = JSON.parse(localStorage.getItem("gs_suspended") || "[]");
        if (cart.length > 0) {
          suspended.push({ items: cart, date: new Date().toISOString(), mode: ($("#cartMode") || {}).value || "especes", remise: ($("#cartRemise") || {}).value || 0 });
          localStorage.setItem("gs_suspended", JSON.stringify(suspended));
          cart = []; renderCart();
          toast("Vente suspendue (" + suspended.length + " en attente)");
        } else if (suspended.length > 0) {
          var last = suspended.pop();
          localStorage.setItem("gs_suspended", JSON.stringify(suspended));
          cart = last.items || [];
          if ($("#cartMode")) $("#cartMode").value = last.mode || "especes";
          if ($("#cartRemise")) $("#cartRemise").value = last.remise || 0;
          renderCart();
          toast("Vente reprise (" + suspended.length + " encore en attente)");
        } else { toast("Aucune vente suspendue"); }
        return;
      }
      if (e.key === "F7") { e.preventDefault(); if (cart.length) { cart.pop(); renderCart(); toast("Dernier article retiré"); } return; }
      if (e.key === "F8") { e.preventDefault(); var vs = document.getElementById("venteSearch"); if (vs) { vs.focus(); vs.select(); } return; }
      if (e.key === "F9") { e.preventDefault(); encaisser(); return; }
      if (e.key === "F10") {
        e.preventDefault();
        var lastTicket = localStorage.getItem("gs_last_ticket");
        if (!lastTicket) { toast("Aucun ticket à réimprimer"); return; }
        try { var v = JSON.parse(lastTicket); showTicket(v); toast("Réimpression du ticket " + v.numero); }
        catch (err) { toast("Erreur de réimpression"); }
        return;
      }
      if (e.key === "Escape" && !document.querySelector("#modal:not(.hidden)")) { if (cart.length) { askConfirm("Vider le panier", "Retirer tous les articles du panier ?", function() { cart = []; renderCart(); }, { danger: true, okLabel: "Vider" }); } return; }
    }
    if (e.key === "F2") { e.preventDefault(); var s = document.getElementById("venteSearch") || document.getElementById("prodSearch"); if (s) { s.focus(); s.select(); } return; }
  });
  
  document.addEventListener("keydown", e => {
    if (e.key === "F2") { e.preventDefault(); if ($("#view-vente").classList.contains("active")) $("#venteSearch").focus(); }
    if (e.key === "F9") { e.preventDefault(); if ($("#view-vente").classList.contains("active") && !$("#encaisserBtn").disabled) encaisser(); }
  });
  $("#newProdBtn").addEventListener("click", () => prodForm(null));
  $("#prodFamilleFilter").addEventListener("change", renderers.produits);
  $("#prodSearch").addEventListener("input", renderers.produits);
  $("#prodMasqInactifs").addEventListener("change", e => { prodMasqInactifs = e.target.checked; renderers.produits().catch(() => { }); });
  const catTabP = $("#catTabP"), catTabF = $("#catTabF");
  const catPaneP = $("#catPaneP"), catPaneF = $("#catPaneF");
  const catShow = k => {
    catTabP.classList.toggle("on", k === "P");
    catTabF.classList.toggle("on", k === "F");
    catPaneP.style.display = k === "P" ? "" : "none";
    catPaneF.style.display = k === "F" ? "" : "none";
    if (k === "F") famManager("#catPaneF");
    else renderers.produits().catch(() => { });
  };
  catTabP.addEventListener("click", () => catShow("P"));
  catTabF.addEventListener("click", () => catShow("F"));
  $("#newUserBtn").addEventListener("click", () => userForm(null));
  $("#roleManagerBtn").addEventListener("click", roleManager);
  $("#rapGenBtn").addEventListener("click", () => genRapport().catch(e => toast(e.message)));
  // Param sub-tabs
  document.querySelectorAll("[data-ptab]").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("[data-ptab]").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    document.querySelectorAll(".ptab").forEach(p => p.classList.add("hidden"));
    const target = document.getElementById("ptab-" + b.dataset.ptab);
    if (target) target.classList.remove("hidden");
    if (b.dataset.ptab === "versements") { renderVersementsAttente(); renderVersementConfig(); }
    if (b.dataset.ptab === "journal") renderers.journal().catch(() => {});
    if (b.dataset.ptab === "personnel") renderers.users().catch(() => {});
    if (b.dataset.ptab === "boutique") renderers.params().catch(() => {});
    if (b.dataset.ptab === "aide") AppStock.render();
  }));
  $("#rapPrintBtn").addEventListener("click", () => {
    imprimer("Rapport", `<h2>Rapport du ${$("#rapFrom").value} au ${$("#rapTo").value} (par ${$("#rapGroup").value})</h2>` + $("#rapportBox").innerHTML, "A4");
  });
  $("#audUserFilter").addEventListener("change", () => renderers.journal().catch(() => { }));
  $("#audSearch").addEventListener("input", () => renderers.journal().catch(() => { }));
  $("#abcGen").addEventListener("click", () => renderers.abc().catch(e => toast(e.message)));
  $("#view-abc [data-abc]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.abc, d = new Date();
    $("#abcTo").value = todayKey();
    if (k === "today") $("#abcFrom").value = todayKey();
    else if (k === "7j") { d.setDate(d.getDate()-6); $("#abcFrom").value = todayKey(d); }
    else if (k === "month") { d.setDate(1); $("#abcFrom").value = todayKey(d); }
    renderers.abc().catch(e => toast(e.message));
  }));
  $("#audCsvBtn").addEventListener("click", async () => {
    let rows = [];
    try { rows = await api("/audit"); } catch (e) { toast(e.message); return; }
    const lines = [["Date", "Utilisateur", "Action", "Détails"]].concat(rows.map(a => [a.date, a.user_nom, a.action, a.details || ""]));
    const csv = lines.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = "journal-audit.csv"; a.click();
  });
  $("#modal").addEventListener("click", e => { if (e.target === $("#modal")) closeModal(); });
}
async function init() {
  checkNotifVersements();
  // Restore session if token exists
  if (token) {
    await restoreSession();
  }
  try { DB.params = await api("/parametres"); } catch (e) { }
  $("#loginHint").innerHTML = `Connecté à : <b>${API_BASE}</b>` + (getParam("show_demo") === "1" ? `<br>Comptes de démonstration : <b>admin</b> / admin123 · <b>Awa Diop</b> / pc123 · <b>Fatou Ndiaye</b> / caisse123` : "");
  bind();
  if (token) {
    try {
      const me = await api("/auth/me");
      cur = me;
      await showApp();
      return;
    } catch (e) { doLogout(); }
  }
  $("#login").classList.remove("hidden");
}
init();

/* Module Stock avance */
renderers.stockmod = () => AppStock.render();
