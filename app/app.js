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

/* ---------- formatage automatique des champs de saisie ----------
   data-fmt="money" → milliers (12 500)  ·  "phone" → 10 chiffres groupés 2 par 2 (77 12 34 56 7→…)  ·  "name" → MAJUSCULES */
const groupThousands = d => String(d).replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
function fmtMoneyInput(raw) {
  const s = String(raw).replace(/[\s\u202f\u00a0]/g, "").replace(/[^\d.,]/g, "");
  const m = s.match(/^(\d*)([.,]\d{0,2})?/);
  const int = (m && m[1]) || "";
  const dec = (m && m[2]) || "";
  if (int === "" && dec === "") return "";
  return groupThousands(int === "" ? "0" : String(Number(int))) + dec.replace(".", ",");
}
function fmtPhoneInput(raw) {
  return String(raw).replace(/\D/g, "").slice(0, 10).replace(/(\d{2})(?=\d)/g, "$1 ");
}
document.addEventListener("input", e => {
  const el = e.target;
  if (!el || !el.dataset || !el.dataset.fmt) return;
  let v = null;
  if (el.dataset.fmt === "money") v = fmtMoneyInput(el.value);
  else if (el.dataset.fmt === "phone") v = fmtPhoneInput(el.value);
  else if (el.dataset.fmt === "name") v = el.value.toLocaleUpperCase ? el.value.toLocaleUpperCase("fr-FR") : el.value.toUpperCase();
  if (v !== null && v !== el.value) el.value = v;
});
/* Lecture tolérante au formatage : "12\u202f500,5" → 12500.5 */
const numV = el => { const s = String((el && el.value) || "").replace(/[\s\u202f\u00a0]/g, "").replace(",", "."); return Number(s) || 0; };
const telV = el => String((el && el.value) || "").replace(/\D/g, "");

/* Anti-rebond générique pour les recherches (300 ms) */
const debounce = (fn, ms) => { let t = null; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms || 300); }; };
/* Chargement à la demande des librairies lourdes (scanner 368 Ko, barcode 60 Ko) */
const _loadedScripts = {};
function ensureScript(src) {
  if (!_loadedScripts[src]) _loadedScripts[src] = new Promise((ok, ko) => {
    if (document.querySelector('script[data-src="' + src + '"]')) return ok();
    const el = document.createElement("script");
    el.src = src; el.dataset.src = src; el.onload = ok; el.onerror = () => { _loadedScripts[src] = null; ko(new Error("Chargement impossible : " + src)); };
    document.head.appendChild(el);
  });
  return _loadedScripts[src];
}
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
    if (sessionStorage.getItem("gs_locked") === "1" && cur && cur.pin_set) pinLockModal();
    await showApp();
  } catch (e) {
    // Token expired — clear and show login
    localStorage.removeItem("gs_token");
    token = null;
    showLogin();
  }
}
let cur = null;
let DB = { boutique: { devise: "F" }, produits: [], familles: [], roles: [], recap: [], modes: [], caisses: [], droits: [], params: [], typesMv: [], lots: [], fournisseurs: [], commandes: [], clients: [] };
let cart = [], camStream = null, scanTimer = null, curView = "accueil", ws = null, usbPrinter = null, cartUsePoints = false;

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
  if (res.ok && (!opts.method || opts.method === "GET") && !path.includes("backup") && !path.includes("restore")) sessionStorage.setItem("gs_cache_" + path, JSON.stringify(data));
  if (res.status === 401) {
    if (!path.startsWith("/auth/login")) doLogout();
    throw new Error(data.error || "Session expirée, reconnectez-vous");
  }
  if (!res.ok) throw new Error(data.error || "Erreur serveur");
  replayQueue().catch(() => { });
  return data;
}
window.addEventListener("online", () => replayQueue().catch(() => { }));
window.addEventListener("online", () => setConn(true));
window.addEventListener("offline", () => setConn(false));
function hasRight(r) { if (!cur) return false; if (cur.role === "admin") return true; return (cur.droits || []).includes(r); }
const modeInfo = code => (DB.modes || []).find(m => m.code === code);
const modeLabel = code => { if (code === "credit") return "Crédit (ardoise)"; const m = modeInfo(code); return m ? m.nom : code; };
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
function setConn(ok) {
  const d = document.getElementById("connDot");
  if (d) { d.classList.toggle("off", !ok); d.title = ok ? "Connecté" : "Hors ligne"; }
}
let wsReconnectTimer = null, wsRenderTimer = null;
function connectWS() {
  if (!token) return;
  /* Éviter les sockets cumulés (login / déverrouillage PIN répétés) */
  if (ws) { try { ws.onclose = null; ws.close(); } catch (e) { } ws = null; }
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  try { ws = new WebSocket(WS_URL + "?token=" + encodeURIComponent(token)); } catch (e) { return; }
  ws.onmessage = e => {
    try {
      const m = JSON.parse(e.data);
      if (m && m.type) {
        if (m.type === "versement_demande" || m.type === "versement_valide" || m.type === "versement_refuse" || m.type === "caisse" || m.type === "demande_annulation") {
          checkNotifValidations();
          if (m.type === "demande_annulation" && cur && (cur.role === "admin" || hasRight("R_POINT") || hasRight("R_PARAMS"))) {
            toast("🔔 Nouvelle demande d'annulation de vente reçue !");
          }
        }
        /* Invalidation ciblée + débounce : la vue courante n'est re-rendue que
           si l'événement la concerne, au maximum toutes les 2 secondes */
        const CONCERNE = {
          vente: ["vente", "stock", "caisse", "releve", "rapports"], stock: ["stock", "produits", "vente", "accueil"],
          produits: ["produits", "stock", "vente", "accueil"], clients: ["clients", "vente"],
          caisse: ["caisse", "point", "vente", "releve", "versements"], roles: ["params", "users"],
          users: ["users", "params"], depenses: ["depenses", "rapports"], point: ["point"],
          demande_annulation: ["versements"], versement_demande: ["versements"],
          versement_valide: ["versements", "point"], versement_refuse: ["versements", "point"],
          params: ["params"], modes: ["vente", "params"], boutique: ["vente", "params"]
        };
        const vues = CONCERNE[m.type];
        if (vues && vues.includes(curView)) {
          clearTimeout(wsRenderTimer);
          wsRenderTimer = setTimeout(() => { if (renderers[curView]) renderers[curView]().catch(() => { }); }, 2000);
        }
      }
    } catch (err) { }
  };
  ws.onopen = () => setConn(true);
  ws.onclose = () => { ws = null; setConn(false); wsReconnectTimer = setTimeout(connectWS, 3000); };
}

/* ---------- connexion ---------- */
async function doLogin() {
  const nom = $("#loginUser").value.trim();
  const mdp = $("#loginPass").value;
  if (!nom || !mdp) { showLoginErr("Nom et mot de passe obligatoires"); return; }
  const btn = $("#loginBtn");
  btn.classList.add("loading"); btn.disabled = true; btn.textContent = "Connexion…";
  $("#loginErr").classList.add("hidden");
  try {
    const r = await api("/auth/login", { method: "POST", body: JSON.stringify({ nom, mdp }) });
    token = r.token; localStorage.setItem("gs_token", token);
    cur = r.user;
    $("#loginPass").value = "";
    await showApp();
  } catch (e) { showLoginErr(e.message); }
  btn.classList.remove("loading"); btn.disabled = false; btn.textContent = "Se connecter";
}
function showLogin() {
  const app = document.getElementById("app");
  const login = document.getElementById("login");
  if (app) app.classList.add("hidden");
  if (login) login.classList.remove("hidden");
  const lu = document.getElementById("loginUser");
  if (lu) { lu.value = ""; lu.focus(); }
  const lp = document.getElementById("loginPass");
  if (lp) lp.value = "";
}
function showLoginErr(msg) { $("#loginErr").textContent = msg; $("#loginErr").classList.remove("hidden"); }
function doLogout() {
  token = null; localStorage.removeItem("gs_token");
  sessionStorage.removeItem("gs_locked");
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) { try { ws.onclose = null; ws.close(); } catch (e) { } ws = null; }
  /* Purger les données mises en cache (sessionStorage + Cache Storage du SW) */
  try { Object.keys(sessionStorage).filter(k => k.startsWith("gs_cache_")).forEach(k => sessionStorage.removeItem(k)); } catch (e) { }
  if (window.caches) { caches.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(() => { }); }
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
    try { const clData = await api("/clients?limit=200"); DB.clients = Array.isArray(clData) ? clData : (clData.rows || []); } catch (e) {}
  } catch (e) { toast(e.message); }
  // Re-affiche le nom avec le libellé du rôle (chargé juste au-dessus)
  $("#curUser").textContent = `${cur.nom} - ${roleLabel(cur.role)}`;
  applyBrand(); buildNav();
  let target = null;
  try { target = localStorage.getItem("gs_curView"); } catch (e) {}
  if (!target || !renderers[target]) target = hasRight("R_RAPPORTS") ? "accueil" : "vente";
  go(target); connectWS(); checkNotifValidations();
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
    a.classList.toggle("hidden", !!(r && !hasRight(r)));
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
const VIEW_BOX = { accueil: "#dashCards", vente: "#venteGrid", releve: "#releveBox", produits: "#prodWrap", stock: "#stockWrap", point: "#pointBox", users: "#usersWrap", rapports: "#rapportBox", journal: "#journalWrap", params: "#paramsBox", depenses: "#depensesBox", versements: "#versementBox", credits: "#creditsBox", clients: "#clientsBox" };
function viewLoading(view) {
  const sel = VIEW_BOX[view];
  if (!sel) return;
  const el = $(sel);
  if (!el) return;
  /* Skeleton cards pour l'accueil, skeleton lignes pour les tableaux */
  if (view === "accueil") {
    el.innerHTML = `<div class="cards">${Array(5).fill(0).map(() => `<div class="card"><div class="skeleton skeleton-line w60"></div><div class="skeleton skeleton-card" style="height:32px;margin-top:6px"></div></div>`).join("")}</div>`;
    $("#dashAlerts").innerHTML = `<div class="skeleton skeleton-line w80"></div><div class="skeleton skeleton-line w60"></div>`;
    $("#dashTop").innerHTML = `<div class="skeleton skeleton-line w80"></div><div class="skeleton skeleton-line w60"></div>`;
    $("#dashChart").innerHTML = `<div class="skeleton" style="height:150px"></div>`;
  } else if (view === "vente") {
    /* pas de skeleton pour la caisse, on garde le panier actuel */
  } else {
    el.innerHTML = `<div class="skeleton skeleton-line w80"></div><div class="skeleton skeleton-line w60"></div><div class="skeleton skeleton-line w80"></div><div class="skeleton skeleton-line w40"></div>`;
  }
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
  const [vts, prodsPage] = await Promise.all([api("/ventes?date=" + k), api("/produits?page=0&limit=100")]);
  const prods = Array.isArray(prodsPage) ? prodsPage : (prodsPage.rows || []);
  DB.produits = prods;
  let caY = 0, benY = 0, ticketsY = 0;
  try { const yk = todayKey(new Date(Date.now() - 86400000)); const vy = await api("/ventes?date=" + yk); caY = vy.reduce((s, v) => s + Number(v.net), 0); benY = vy.reduce((s, v) => s + Number(v.benefice || 0), 0); ticketsY = vy.length; } catch (e) { }
  const dh = (t, y) => { if (y <= 0) return t > 0 ? '<div class="delta up">Nouveau</div>' : ""; const p = Math.round((t - y) / y * 100); if (p === 0) return '<div class="delta">= hier</div>'; return p > 0 ? '<div class="delta up">▲ +' + p + ' % vs hier</div>' : '<div class="delta down">▼ ' + p + ' % vs hier</div>'; };
  const da = $("#dashActions");
  if (da) {
    const acts = [];
    acts.push('<button class="btn primary" data-go="vente">🛒 Caisse</button>');
    if (hasRight("R_PRODUITS")) acts.push('<button class="btn" data-np>➕ Nouveau produit</button>');
    if (hasRight("R_STOCK")) acts.push('<button class="btn" data-go="stock">📦 Stock</button>');
    if (hasRight("R_RAPPORTS") || hasRight("R_POINT")) acts.push('<button class="btn" data-go="versements">💰 Versements</button>');
    da.innerHTML = acts.join("");
    da.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => {
      go(b.dataset.go);
    }));
    const npb = da.querySelector("[data-np]");
    if (npb) npb.addEventListener("click", () => prodForm(null));
  }
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
    <div class="card"><div class="k">Chiffre d'affaires</div><div class="v">${money(ca)}</div>${dh(ca, caY)}</div>
    <div class="card"><div class="k">Bénéfice du jour</div><div class="v ok">${money(ben)}</div>${dh(ben, benY)}</div>
    <div class="card"><div class="k">Tickets</div><div class="v">${vts.length}</div>${dh(vts.length, ticketsY)}</div>
    <div class="card"><div class="k">Valeur du stock</div><div class="v">${money(valStock)}</div></div>
    <div class="card"><div class="k">Produits</div><div class="v">${prods.filter(p => p.actif).length}</div></div>`;
  const alerts = prods.filter(p => p.actif && Number(p.stock) <= Number(p.stock_min));
  $("#dashAlerts").innerHTML = alerts.length === 0
    ? `<div class="empty">✅ Aucune alerte stock aujourd'hui</div>`
    : `<div class="table-wrap"><table><tr><th>Produit</th><th>Stock</th><th>Seuil mini</th><th>Statut</th></tr>` +
      alerts.map(p => `<tr data-prodid="${p.id}" style="cursor:pointer" title="Cliquer pour modifier"><td>${esc(p.nom)}</td><td class="num">${p.stock}</td><td class="num">${p.stock_min}</td><td><span class="badge ${Number(p.stock) <= 0 ? "bad" : "warn"}">${Number(p.stock) <= 0 ? "Rupture" : "Stock bas"}</span></td></tr>`).join("") + `</table></div>`;
  $$("#dashAlerts tr[data-prodid]").forEach(r => r.addEventListener("click", () => { const p = prods.find(x => String(x.id) === String(r.dataset.prodid)); if (p) prodForm(p); }));
  const dpBox = $("#dashPeremptions");
  if (dpBox) {
    if (hasRight("R_STOCK")) {
      try {
        const per = await api("/peremptions/proches?jours=30");
        dpBox.innerHTML = per.length === 0
          ? `<div class="empty">✅ Aucun produit n'expire dans les 30 prochains jours</div>`
          : `<div class="table-wrap"><table><tr><th>Produit</th><th>Lot</th><th>Reste</th><th>Expire le</th><th>Jours</th></tr>` +
            per.slice(0, 12).map(x => {
              const e = new Date(x.date_peremption);
              const jours = Math.round((new Date(e.getFullYear(), e.getMonth(), e.getDate()) - new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate())) / 86400000);
              const dstr = isNaN(e) ? String(x.date_peremption).slice(0, 10) : (e.getFullYear() + "-" + String(e.getMonth() + 1).padStart(2, "0") + "-" + String(e.getDate()).padStart(2, "0"));
              return `<tr style="cursor:pointer" data-prodid="${x.produit_id}" title="Ouvrir le produit"><td>${esc(x.nom)}</td><td>${esc(x.numero || "—")}</td><td class="num">${x.qte_restante}</td><td>${fmtDateOnly(dstr)}</td><td><span class="badge ${jours <= 7 ? "bad" : "warn"}">${jours} j</span></td></tr>`;
            }).join("") + `</table></div>`;
        $$("#dashPeremptions tr[data-prodid]").forEach(r => r.addEventListener("click", () => { const p = prods.find(y => String(y.id) === String(r.dataset.prodid)); if (p) prodForm(p); }));
      } catch (e) { dpBox.innerHTML = ""; }
    } else { dpBox.innerHTML = ""; }
  }
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

  // ===== ALERTES OPÉRATIONNELLES (Ruptures, Crédits, Annulations) =====
  try {
    const alertes = await api("/dashboard/alertes");
    const alertesBox = $("#dashAlertes");
    if (alertesBox) {
      const items = [];
      if (alertes.ruptures > 0) {
        items.push(`<div class="alerte-item bad" data-goto="produits" style="cursor:pointer">🔴 <b>${alertes.ruptures}</b> produit(s) en <b>rupture de stock</b> — Cliquer pour voir</div>`);
      }
      if (alertes.faibles > 0) {
        items.push(`<div class="alerte-item warn" data-goto="produits" style="cursor:pointer">🟠 <b>${alertes.faibles}</b> produit(s) en <b>stock faible</b> (sous le seuil minimum)</div>`);
      }
      if (alertes.credits_ouverts > 0) {
        items.push(`<div class="alerte-item info" data-goto="credits" style="cursor:pointer">💳 <b>${alertes.credits_ouverts}</b> crédit(s) client(s) <b>non soldé(s)</b> — Cliquer pour recouvrer</div>`);
      }
      if (alertes.annulations_en_attente > 0) {
        items.push(`<div class="alerte-item warn" data-goto="versements" style="cursor:pointer">❌ <b>${alertes.annulations_en_attente}</b> demande(s) d'annulation <b>en attente de validation</b></div>`);
      }
      if (items.length === 0) {
        alertesBox.innerHTML = `<div class="alerte-item ok">✅ Aucune alerte opérationnelle — Tout est sous contrôle</div>`;
      } else {
        alertesBox.innerHTML = items.join("");
        alertesBox.querySelectorAll("[data-goto]").forEach(el => {
          el.addEventListener("click", () => go(el.dataset.goto));
        });
      }
    }
  } catch (e) { /* alertes non critiques */ }
};

/* ---------- vente ---------- */
let venteFilter = "";
let venteSearchTimer = null;
async function loadVenteProducts(search, famille) {
  /* 20 produits par defaut (grid rapide), 50 si recherche/filtre */
  const limit = (search || famille) ? 50 : 20;
  let url = "/produits?limit=" + limit;
  if (search) url += "&search=" + encodeURIComponent(search);
  if (famille) url += "&famille=" + encodeURIComponent(famille);
  const data = await api(url);
  DB.produits = Array.isArray(data) ? data : (data.rows || data);
  return DB.produits;
}
renderers.vente = async function () {
  try {
    const [prods, clts, caisse] = await Promise.all([
      loadVenteProducts("", ""),
      api("/clients?limit=200").then(d => Array.isArray(d) ? d : (d.rows || d)).catch(() => []),
      api("/caisse/moi").catch(() => null)
    ]);
    DB.clients = clts;
    DB.caisse = caisse;
  } catch (e) { toast(e.message); return; }
  fillModeSelect();
  populateCartClients();
  const selF = $("#venteFamille");
  const curF = selF.value;
  selF.innerHTML = `<option value="">Toutes les familles</option>` + [...new Set(DB.produits.map(p => p.famille).filter(Boolean))].map(fm => `<option ${curF === fm ? "selected" : ""}>${esc(fm)}</option>`).join("");
  renderCaisseBar();
  if (DB.caisse) { renderVenteGrid(); renderCart(); setTimeout(function() { var vs = document.getElementById("venteSearch"); if (vs) { vs.focus(); vs.select(); } }, 100); }
};
function fillModeSelect() {
  const sel = $("#cartMode");
  const cur = sel.value;
  sel.innerHTML = (DB.modes || []).filter(m => m.actif).map(m => `<option value="${esc(m.code)}">${esc(m.nom)}</option>`).join("")
    + `<option value="credit">🤝 Crédit (ardoise)</option>`;
  if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
}
function renderCaisseBar() {
  const bar = $("#caisseBar");
  const layout = document.querySelector(".vente-layout");
  if (!DB.caisse) {
    bar.innerHTML = `<div class="panel" style="max-width:480px;margin:6px auto">
      <h3>🟢 Ouvrir votre caisse</h3>
      <p class="muted">Pour encaisser, ouvrez d'abord votre caisse du jour. Une seule caisse ouverte à la fois.</p>
      <label class="field">Fonds de départ dans le tiroir (F, facultatif) <input id="caisseFonds" type="text" data-fmt="money" inputmode="decimal" min="0" value="0" placeholder="ex. 25000"></label>
      <button class="btn primary block" id="caisseOuvrirBtn">🟢 Ouvrir ma caisse</button>
    </div>`;
    layout.classList.add("hidden");
    $("#caisseOuvrirBtn").addEventListener("click", async () => {
      try {
        await api("/caisse/ouvrir", { method: "POST", body: JSON.stringify({ fonds_initial: numV($("#caisseFonds")) || 0 }) });
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
    <label class="field">Montant (F) <input id="vsMontant" type="text" data-fmt="money" inputmode="decimal" min="1"></label>
    <label class="field">Mode
      <select id="vsMode">${(DB.modes || []).filter(m => m.actif).map(m => `<option value="${esc(m.code)}">${esc(m.nom)}</option>`).join("")}</select>
    </label>
    <label class="field">Motif (facultatif) <input id="vsMotif" placeholder="ex. remise au gérant à 15h"></label>
    <div class="row"><button class="btn success grow" id="vsSave">💰 Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  $("#vsSave").addEventListener("click", async () => {
    const m = numV($("#vsMontant")) || 0;
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
  const vStat = s => s === "valide" ? '<span class="badge ok">Validé</span>' : s === "refuse" ? '<span class="badge bad">Refusé</span>' : '<span class="badge warn">En attente</span>';
  const rows = (c.versements || []).map(v => `<tr><td>${fmtDate(v.date)}</td><td class="num">${money(v.montant)}</td><td>${esc(modeLabel(v.mode))}</td><td>${esc(v.motif || "-")}</td><td>${vStat(v.statut)}</td></tr>`).join("");
  openModal(`<h3>Cloturer votre caisse</h3>
    <div class="cards" style="margin:8px 0">
      <div class="card"><div class="k">Fonds de depart</div><div class="v">${money(c.fonds_initial)}</div></div>
      <div class="card"><div class="k">Ventes especes</div><div class="v">${money(c.especes)}</div></div>
      <div class="card"><div class="k">Verse (especes)</div><div class="v">${money(c.verse_especes)}</div></div>
      <div class="card"><div class="k">Total ventes</div><div class="v">${money(c.total)}</div></div>
    </div>
    <div class="table-wrap"><table><tr><th>Date</th><th class="num">Montant</th><th>Mode</th><th>Motif</th><th>Statut</th></tr>${rows || `<tr><td colspan="5" class="empty">Aucun versement</td></tr>`}</table></div>
    ${Number(c.verse_en_attente) > 0 ? `<p class="error" style="margin-top:8px">⚠️ ${money(c.verse_en_attente)} de versement(s) en attente de validation - cet argent est encore dans le tiroir.</p>` : ""}
    <p class="muted" style="margin-top:8px">Comptez votre tiroir (especes) et saisissez le montant trouve.</p>
    <label class="field">Argent compte dans le tiroir (F) <input id="ctCompte" type="text" data-fmt="money" inputmode="decimal" min="0" value="${c.attendu_especes}"></label>
    <label class="field">Notes <input id="ctNotes" placeholder="ex. ecart explique..."></label>
    <p id="ctWarn" class="error hidden"></p>
    <div class="row"><button class="btn danger grow" id="ctSave">Cloturer la caisse</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  const syncClot = () => {
    const ecart = (numV(document.getElementById("ctCompte")) || 0) - c.attendu_especes;
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
      const r = await api(`/caisse/${c.id}/cloturer`, { method: "POST", body: JSON.stringify({ compte: numV(document.getElementById("ctCompte")) || 0, notes: document.getElementById("ctNotes").value }) });
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

function renderSuggest() {
  const box = $("#venteSuggest");
  if (!box) return;
  const f = (venteFilter || "").toLowerCase().trim();
  if (!f) { hideSuggest(); return; }
  const matches = DB.produits.filter(p => p.actif && Number(p.stock) > 0 && (p.nom.toLowerCase().includes(f) || (p.code || "").includes(f))).slice(0, 8);
  if (!matches.length) { hideSuggest(); return; }
  box.innerHTML = matches.map((p, i) => '<div class="sug-item ' + (i === 0 ? "on" : "") + '" data-pid="' + p.id + '"><span class="sug-name">' + esc(p.nom) + '</span><span class="sug-price">' + money(p.prix_vente) + '</span><span class="sug-stock">✓</span></div>').join("");
  box.classList.remove("hidden");
  box.querySelectorAll(".sug-item").forEach(it => it.addEventListener("mousedown", e => { e.preventDefault(); addSuggestion(it.dataset.pid); }));
}
function moveSuggest(items, dir) {
  const cur = items.findIndex(it => it.classList.contains("on"));
  let next = cur + dir;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  items.forEach((it, i) => it.classList.toggle("on", i === next));
}
function hideSuggest() { const b = $("#venteSuggest"); if (b) b.classList.add("hidden"); }
function addSuggestion(pid) {
  addToCart(pid, 1);
  const vs = $("#venteSearch"); if (vs) vs.value = "";
  venteFilter = "";
  hideSuggest();
  renderVenteGrid();
}
function addLastMatch() {
  const f = (venteFilter || "").toLowerCase();
  const matches = DB.produits.filter(p => p.actif && Number(p.stock) > 0 && (!f || p.nom.toLowerCase().includes(f) || (p.code || "").includes(f)));
  if (matches.length) {
    const best = matches[0];
    addToCart(best.id, 1);
    toast("Ajouté : " + best.nom);
    const vs = $("#venteSearch"); if (vs) vs.value = "";
    venteFilter = "";
    hideSuggest();
    renderVenteGrid();
  } else if (!addByCode(venteFilter)) {
    toast("Produit introuvable : " + venteFilter);
  }
}
function getRecents() {
  try { return JSON.parse(localStorage.getItem("gs_recent_prods") || "[]"); } catch (e) { return []; }
}
function pushRecents(ids) {
  try {
    let r = getRecents();
    (ids || []).forEach(id => { r = r.filter(x => String(x) !== String(id)); r.unshift(id); });
    localStorage.setItem("gs_recent_prods", JSON.stringify(r.slice(0, 12)));
  } catch (e) {}
}
function recentsHTML() {
  const r = getRecents();
  const prods = r.map(id => produitById(id)).filter(p => p && p.actif && Number(p.stock) > 0).slice(0, 12);
  if (!prods.length) return "";
  return `<div class="recents" style="grid-column:1/-1"><span class="recents-title">🕘 Récents</span>` + prods.map(p => `<button type="button" class="recent-chip" data-pid="${p.id}">${esc(p.nom)}<span>${money(p.prix_vente)}</span></button>`).join("") + `</div>`;
}

function renderVenteGrid() {
  const f = venteFilter.toLowerCase();
  const fam = $("#venteFamille") ? $("#venteFamille").value : "";
  const sort = $("#venteSort") ? $("#venteSort").value : "nom";
  let list = DB.produits.filter(p => p.actif && (!f || p.nom.toLowerCase().includes(f) || (p.code || "").includes(f)) && (!fam || p.famille === fam));
  if (sort === "prix") list = [...list].sort((a, b) => Number(a.prix_vente) - Number(b.prix_vente));
  else if (sort === "prixDesc") list = [...list].sort((a, b) => Number(b.prix_vente) - Number(a.prix_vente));
  else list = [...list].sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
  const hint = (!f && DB.produits.length >= 20) ? `<div class="empty" style="padding:8px;font-size:12px;color:var(--muted)">🔍 Tapez le nom ou code-barres pour chercher dans les 100 000+ produits</div>` : "";
  $("#venteGrid").innerHTML = (!f ? recentsHTML() : "") + hint + (list.length === 0
    ? `<div class="empty">Aucun produit trouvé</div>`
    : list.map(p => `
      <div class="prod-card ${Number(p.stock) <= 0 ? "off" : ""}" data-pid="${p.id}">
        ${p.has_photo ? `<img src="/api/produits/${p.id}/photo" loading="lazy" style="width:100%;height:64px;object-fit:cover;border-radius:8px;margin-bottom:6px">` : ""}
        <div class="pn">${esc(p.nom)}</div>
        <div class="pp">${money(p.prix_vente)}</div>
        <div class="ps"><span class="stock-badge ${Number(p.stock) <= 0 ? "out" : Number(p.stock) <= Number(p.stock_min) ? "low" : "ok"}"><span class="dot"></span>Stock : ${p.stock}${p.stock_min ? " · min " + p.stock_min : ""}</span></div>
      </div>`).join(""));
  $$("#venteGrid .prod-card").forEach(c => c.addEventListener("click", () => {
    const p = produitById(c.dataset.pid);
    if (p && Number(p.stock) > 0) { addToCart(p.id, 1); animateFlyToCart(c); c.classList.add("flash"); setTimeout(() => c.classList.remove("flash"), 350); } else toast("Stock insuffisant");
  }));
  $$("#venteGrid .recent-chip").forEach(b => b.addEventListener("click", () => {
    const p = produitById(b.dataset.pid);
    if (p && Number(p.stock) > 0) { addToCart(p.id, 1); } else toast("Stock insuffisant");
  }));
}
/* Recherche serveur pour la caisse (debounce) */
function venteServerSearch(query) {
  clearTimeout(venteSearchTimer);
  venteSearchTimer = setTimeout(async () => {
    const fam = $("#venteFamille") ? $("#venteFamille").value : "";
    try {
      await loadVenteProducts(query, fam);
      renderVenteGrid();
    } catch (e) { }
  }, 300);
}
/* --- Assistant audio & monnaie --- */
function playBeep(success = true) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(success ? 880 : 220, ctx.currentTime);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
    if (navigator.vibrate) navigator.vibrate(success ? 40 : [80, 50, 80]);
  } catch (e) { }
}

function breakdownMonnaie(rendu) {
  if (!rendu || rendu <= 0) return "";
  const denoms = [10000, 5000, 2000, 1000, 500, 200, 100, 50, 25];
  let rest = Math.round(rendu);
  const parts = [];
  for (const d of denoms) {
    if (rest >= d) {
      const count = Math.floor(rest / d);
      rest %= d;
      parts.push(count + " × " + (d >= 1000 ? (d / 1000) + "k" : d));
    }
  }
  return parts.length ? parts.join(", ") : "";
}

/* --- Tickets en attente (multi-paniers) --- */
let heldCarts = [];
try { heldCarts = JSON.parse(localStorage.getItem("gs_held_carts") || "[]"); } catch (e) { heldCarts = []; }
function saveHeldCarts() {
  localStorage.setItem("gs_held_carts", JSON.stringify(heldCarts));
  renderHeldCarts();
}

function holdCart() {
  if (cart.length === 0) { toast("Panier vide"); return; }
  const defaultLabel = "Ticket #" + (heldCarts.length + 1) + " (" + cart.reduce((s, l) => s + l.qte, 0) + " art.)";
  askPrompt("⏸️ Mettre le ticket en attente", defaultLabel, val => {
    const nom = String(val || defaultLabel).trim();
    heldCarts.push({
      id: uid(),
      nom,
      items: [...cart],
      remise: $("#cartRemise") ? $("#cartRemise").value : 0,
      mode: $("#cartMode") ? $("#cartMode").value : "especes",
      recu: $("#cartRecu") ? $("#cartRecu").value : 0,
      date: new Date().toISOString()
    });
    cart = [];
    if ($("#cartRemise")) $("#cartRemise").value = 0;
    if ($("#cartRecu")) $("#cartRecu").value = 0;
    saveHeldCarts();
    renderCart();
    toast("Ticket mis en attente ⏸️");
  });
}

function resumeCart(id) {
  const idx = heldCarts.findIndex(h => h.id === id);
  if (idx === -1) return;
  const held = heldCarts[idx];
  if (cart.length > 0) {
    askConfirm("Remplacer le panier actif ?", "Un panier est déjà en cours. Voulez-vous le remplacer par le ticket « " + esc(held.nom) + " » ?", () => {
      cart = held.items || [];
      if ($("#cartRemise")) $("#cartRemise").value = held.remise || 0;
      if ($("#cartMode")) $("#cartMode").value = held.mode || "especes";
      if ($("#cartRecu")) $("#cartRecu").value = held.recu || 0;
      heldCarts.splice(idx, 1);
      saveHeldCarts();
      renderCart();
      toast("Ticket repris ▶️");
    });
    return;
  }
  cart = held.items || [];
  if ($("#cartRemise")) $("#cartRemise").value = held.remise || 0;
  if ($("#cartMode")) $("#cartMode").value = held.mode || "especes";
  if ($("#cartRecu")) $("#cartRecu").value = held.recu || 0;
  heldCarts.splice(idx, 1);
  saveHeldCarts();
  renderCart();
  toast("Ticket repris ▶️");
}

function removeHeldCart(id) {
  heldCarts = heldCarts.filter(h => h.id !== id);
  saveHeldCarts();
  toast("Ticket en attente supprimé");
}

function renderHeldCarts() {
  const box = $("#heldCartsWrap");
  if (!box) return;
  if (!heldCarts.length) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = `<div class="held-bar"><span class="held-title">⏸️ En attente (${heldCarts.length}) :</span>`
    + heldCarts.map(h => {
      const tot = (h.items || []).reduce((s, l) => s + l.prix * l.qte, 0);
      return `<button type="button" class="held-chip" data-held="${h.id}"><b>${esc(h.nom)}</b> <span>${money(tot)}</span><span class="held-del" data-helddel="${h.id}">✕</span></button>`;
    }).join("")
    + `</div>`;
  box.querySelectorAll("[data-held]").forEach(b => {
    b.addEventListener("click", e => {
      if (e.target.classList.contains("held-del")) return;
      resumeCart(b.dataset.held);
    });
  });
  box.querySelectorAll("[data-helddel]").forEach(b => {
    b.addEventListener("click", e => {
      e.stopPropagation();
      removeHeldCart(b.dataset.helddel);
    });
  });
}

function addToCart(pid, qte) {
  const p = produitById(pid);
  if (!p) { playBeep(false); return; }
  const line = cart.find(l => String(l.produitId) === String(pid));
  const now = line ? line.qte : 0;
  if (now + qte > Number(p.stock)) {
    playBeep(false);
    toast("Stock insuffisant (" + p.nom + " : " + p.stock + " dispo)");
    return;
  }
  if (line) line.qte += qte;
  else cart.push({ produitId: p.id, nom: p.nom, prix: Number(p.prix_vente), prixAchat: Number(p.prix_achat), qte });
  playBeep(true);
  renderCart();
  const ct = $("#cartTotal");
  if (ct) { ct.classList.add("pop"); setTimeout(() => ct.classList.remove("pop"), 300); }
}

function populateCartClients() {
  const clientSel = $("#cartClientSel");
  if (!clientSel) return;
  const curCid = clientSel.value;
  const clients = (DB.clients || []).filter(c => c.actif).slice(0, 200);
  clientSel.innerHTML = '<option value="">👤 Client passager (Comptoir)</option>' +
    clients.map(c => `
      <option value="${c.id}" ${String(c.id) === String(curCid) ? "selected" : ""}>
        ${esc(c.nom)} (⭐ ${c.points || 0} pts)
      </option>
    `).join('');
  updateCartClientInfo();
}

function updateCartClientInfo() {
  const sel = $("#cartClientSel");
  const info = $("#cartClientInfo");
  if (!sel || !info) return;
  const cid = sel.value;
  if (!cid) {
    info.classList.add("hidden");
    info.innerHTML = "";
    return;
  }
  const cl = (DB.clients || []).find(c => String(c.id) === String(cid));
  if (!cl) {
    info.classList.add("hidden");
    return;
  }
  info.classList.remove("hidden");
  const solde = Number(cl.solde_credit || 0);
  const valPt = Math.max(0, Number(getParam("valeur_point")) || 25);
  const pts = Number(cl.points || 0);
  info.innerHTML = `⭐ Points : <b>${pts} pts</b>${valPt > 0 ? ` (=${money(pts * valPt)})` : ""} · Plafond : <b>${money(cl.plafond_credit)}</b>` +
    (solde > 0 ? ` · <span style="color:var(--danger)">Dette : ${money(solde)}</span>` : "") +
    (valPt > 0 && pts > 0 ? ` <button type="button" class="btn small ${cartUsePoints ? "success" : "ghost"}" id="cartPtsBtn">🎯 ${cartUsePoints ? "Points activés ✓" : "Utiliser mes points"}</button>` : "");
  const pb = $("#cartPtsBtn");
  if (pb) pb.addEventListener("click", () => { cartUsePoints = !cartUsePoints; updateCartClientInfo(); });
}

function renderCart() {
  renderHeldCarts();
  populateCartClients();
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
    const recu = numV($("#cartRecu")) || 0;
    const rendu = $("#cartRendu");
    if (net > 0 && recu >= net) {
      const diff = recu - net;
      const bkd = breakdownMonnaie(diff);
      rendu.innerHTML = "Rendu : <b>" + money(diff) + "</b>" + (bkd ? `<div class="monnaie-hint">💡 Rendu conseillé : ${esc(bkd)}</div>` : "");
      rendu.className = "ok";
    } else if (net > 0 && recu > 0 && recu < net) {
      rendu.textContent = "Manque : " + money(net - recu);
      rendu.className = "ko";
    } else {
      rendu.textContent = "";
      rendu.className = "";
    }
    const q = $("#cartRecuQuick");
    if (q) {
      if (net > 0) {
        const denoms = [500, 1000, 2000, 5000, 10000];
        q.innerHTML = denoms.map(d => '<button type="button" data-amt="' + d + '">' + (d >= 1000 ? (d / 1000) + " 000" : d) + '</button>').join("") + '<button type="button" data-amt="exact" class="exact">Exact</button>';
        q.classList.remove("hidden");
        q.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
          const amt = b.dataset.amt;
          const cur = numV($("#cartRecu")) || 0;
          $("#cartRecu").value = amt === "exact" ? net : cur + Number(amt);
          renderCart();
        }));
      } else {
        q.classList.add("hidden");
      }
    }
  } else {
    const rendu = $("#cartRendu");
    if (rendu) { rendu.textContent = ""; rendu.className = ""; }
    const q = $("#cartRecuQuick");
    if (q) q.classList.add("hidden");
  }
}
async function encaisser() {
  if (cart.length === 0) { toast("Panier vide"); return; }
  if (!DB.caisse) { toast("Ouvrez votre caisse d'abord"); return; }
  /* Montants arrondis à l'unité dès le calcul (évite les écarts flottants type 999,6) */
  const total = Math.round(cart.reduce((s, l) => s + l.prix * l.qte, 0));
  const remise = clampRemise(total, Math.round(Math.max(0, numV($("#cartRemise")) || 0)));
  const net = Math.max(0, total - remise);
  if (net < 0 || (net === 0 && remise === 0)) { toast("Montant invalide"); return; }
  const mode = $("#cartMode").value;
  let recu = net;
  if (mode === "credit") {
    recu = 0;
  } else if (modeEspeces(mode)) {
    recu = net === 0 ? 0 : (Math.round(numV($("#cartRecu")) || 0));
    if (recu < net) { toast("Montant reçu insuffisant"); return; }
  }
  const nbArt = cart.reduce((s, l) => s + l.qte, 0);
  /* Points fidélité : utilisation seulement si client sélectionné et activé */
  const cidPts = $("#cartClientSel") ? $("#cartClientSel").value : null;
  const clPts = cidPts ? (DB.clients || []).find(c => String(c.id) === String(cidPts)) : null;
  const valPt = Math.max(0, Number(getParam("valeur_point")) || 25);
  let pointsUtilises = 0;
  if (cartUsePoints && clPts && valPt > 0 && net > 0) {
    pointsUtilises = Math.min(Number(clPts.points || 0), Math.floor(net / valPt));
  }
  const doVente = async clientNom => {
    const btn = $("#encaisserBtn"); btn.disabled = true; btn.textContent = "Encaissement...";
    const clientId = $("#cartClientSel") ? $("#cartClientSel").value || null : null;
    try {
      const v = await api("/ventes", {
        method: "POST",
        body: JSON.stringify({ items: cart.map(l => ({ produitId: l.produitId, qte: l.qte })), remise, mode, recu, client_id: clientId, client_nom: clientNom, points_utilises: pointsUtilises, ref: "T" + uid().toUpperCase() })
      });
      pushRecents(cart.map(l => l.produitId));
      cart = []; $("#cartRemise").value = 0; $("#cartRecu").value = 0;
      renderCart();
      venteAfterClose = true; cartUsePoints = false;
      showTicket(v);
      try { localStorage.setItem("gs_last_ticket", JSON.stringify(v)); } catch(e) {}
      renderers.vente().catch(() => { });
    } catch (e) { toast(e.message); }
    btn.disabled = false; btn.textContent = "💵 Encaisser";
  };
  if (mode === "credit") {
    const sel = $("#cartClientSel");
    const cl = sel && sel.value ? (DB.clients || []).find(c => String(c.id) === String(sel.value)) : null;
    if (cl) {
      askConfirm("Confirmer le crédit", `Accorder un crédit de <b>${money(net)}</b> au client <b>${esc(cl.nom)}</b> ?<br><span class="muted">Plafond autorisé : <b>${money(cl.plafond_credit)}</b> · Encours actuel : <b>${money(cl.solde_credit || 0)}</b></span>`, () => doVente(cl.nom), { okLabel: "Valider le crédit" });
      return;
    }
    askPrompt("🤝 Vente à crédit", "", val => {
      const nom = String(val || "").trim();
      if (!nom) { toast("Nom du client obligatoire — vente annulée"); return; }
      doVente(nom);
    });
    return;
  }
  askConfirm("Confirmer la vente", `Vente de <b>${nbArt} article(s)</b> — total <b>${money(net)}</b>${remise > 0 ? `<br>Remise : <b>${money(remise)}</b>` : ""}<br>Paiement : <b>${esc(modeLabel(mode))}</b>${recu > net ? ` — reçu <b>${money(recu)}</b>, rendu <b>${money(recu - net)}</b>` : ""}<br><span class="muted">Le stock sera réduit automatiquement après confirmation.</span>`, () => doVente(null), { icone: "💵", okLabel: "Encaisser" });
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
${Number(getParam("tva_pct")) > 0 ? `dont TVA ${getParam("tva_pct")}% : ${money(Math.round(Number(v.net) * Number(getParam("tva_pct")) / (100 + Number(getParam("tva_pct")))))}
` : ""}${Number(v.points_utilises) ? `Points utilisés : -${v.points_utilises} pts (${money(v.points_valeur || 0)})
` : ""}
Paiement : ${modeLabelT}
Reçu : ${money(v.recu)}
${Number(v.rendu) ? `Rendu : ${money(v.rendu)}` : ""}
═══════════════════════
${esc(b.pied)}
${esc(b.email)} - ${esc(b.horaires)}`;
}

function promptAnnulerVente(v, onDone) {
  const validateurNom = getParam("annulation_validateur") || "admin";
  const isAuthorized = cur && (cur.role === "admin" || hasRight("R_POINT") || hasRight("R_PARAMS"));

  const modalHTML = `
    <h3>↩️ Annulation du ticket ${esc(v.numero)}</h3>
    <p class="muted">Montant du ticket : <b>${money(v.net)}</b> (${(v.items || []).length} article(s))</p>
    <div class="field">
      <label>Motif d'annulation *</label>
      <select id="annulMotifSel">
        <option value="Erreur de saisie / quantité">Erreur de saisie / quantité</option>
        <option value="Erreur de moyen de paiement">Erreur de moyen de paiement</option>
        <option value="Client parti sans payer">Client parti sans payer</option>
        <option value="Produit défectueux / refusé">Produit défectueux / refusé</option>
        <option value="autre">Autre motif...</option>
      </select>
      <input type="text" id="annulMotifTxt" class="hidden" placeholder="Précisez le motif..." style="margin-top:6px">
    </div>

    ${!isAuthorized ? `
      <!-- OPTION 1 : À DISTANCE -->
      <div style="background:rgba(14,116,144,.08);padding:12px;border-radius:8px;margin:12px 0 8px;border:1px solid rgba(14,116,144,.3)">
        <p style="margin:0 0 4px;font-weight:700;color:var(--primary)">📲 Option 1 : Demande à distance (Recommandé)</p>
        <p style="margin:0 0 10px;font-size:12px" class="muted">Envoie une notification immédiate à <b>${esc(validateurNom)}</b> pour validation sur son écran / téléphone.</p>
        <button class="btn primary small block" id="annulSendRemoteBtn" style="font-size:13px;padding:9px">📲 Envoyer la demande à ${esc(validateurNom)}</button>
      </div>

      <!-- OPTION 2 : SUR PLACE -->
      <details style="margin-top:10px;border-top:1px dashed var(--border);padding-top:8px">
        <summary style="font-size:12px;color:var(--muted);cursor:pointer;user-select:none">⚡ Option 2 : Superviseur présent sur place (Validation immédiate) ▾</summary>
        <div style="background:rgba(239,68,68,.08);padding:10px;border-radius:8px;margin:8px 0;border:1px dashed var(--danger)">
          <p style="margin:0 0 4px;font-weight:700;color:var(--danger)">🔒 Mot de passe de « ${esc(validateurNom)} » ou Admin</p>
          <label class="field" style="margin-bottom:8px">
            <input type="password" id="annulMgrMdp" placeholder="Mot de passe" autocomplete="current-password">
          </label>
          <button class="btn danger small block" id="annulLocalBtn">⚡ Valider sur place immédiatement</button>
        </div>
      </details>
    ` : `
      <div class="row" style="margin-top:14px">
        <button class="btn danger grow" id="annulDirectBtn">🗑️ Confirmer l'annulation immédiate</button>
        <button class="btn ghost grow" onclick="closeModal()">Abandonner</button>
      </div>
    `}
    <div class="row" style="margin-top:10px">
      <button class="btn ghost grow" onclick="closeModal()">Fermer</button>
    </div>
  `;

  openModal(modalHTML);

  const sel = $("#annulMotifSel");
  const txt = $("#annulMotifTxt");
  if (sel && txt) {
    sel.addEventListener("change", () => {
      txt.classList.toggle("hidden", sel.value !== "autre");
      if (sel.value === "autre") txt.focus();
    });
  }

  const getMotif = () => {
    let m = sel.value === "autre" ? txt.value.trim() : sel.value;
    if (!m) { toast("Précisez le motif d'annulation"); return null; }
    return m;
  };

  // Option 1 : Envoi à distance
  const remoteBtn = $("#annulSendRemoteBtn");
  if (remoteBtn) {
    remoteBtn.addEventListener("click", async () => {
      const motif = getMotif();
      if (!motif) return;
      remoteBtn.disabled = true; remoteBtn.textContent = "Transmission en cours...";
      try {
        await api("/ventes/" + v.id + "/demander-annulation", { method: "POST", body: JSON.stringify({ motif }) });
        closeModal();
        toast("Demande d'annulation transmise à " + validateurNom + " 📲");
        if (onDone) onDone();
        if (curView === "releve") renderers.releve().catch(() => {});
      } catch (e) {
        remoteBtn.disabled = false; remoteBtn.textContent = "📲 Envoyer la demande à " + validateurNom;
        toast(e.message);
      }
    });
  }

  // Option 2 : Sur place avec mot de passe
  const localBtn = $("#annulLocalBtn");
  if (localBtn) {
    localBtn.addEventListener("click", async () => {
      const motif = getMotif();
      if (!motif) return;
      const mgrMdp = $("#annulMgrMdp") ? $("#annulMgrMdp").value : "";
      if (!mgrMdp) { toast("Mot de passe du validateur (« " + validateurNom + " ») obligatoire"); return; }
      localBtn.disabled = true; localBtn.textContent = "Annulation en cours...";
      try {
        const res = await api("/ventes/" + v.id + "/annuler", { method: "POST", body: JSON.stringify({ motif, manager_nom: validateurNom, manager_mdp: mgrMdp }) });
        closeModal();
        toast("Vente annulée avec succès (Validé par " + (res.autorise_par || "Gérance") + ") ↩️");
        if (onDone) onDone();
        renderers.vente().catch(() => {});
        if (curView === "releve") renderers.releve().catch(() => {});
      } catch (e) {
        localBtn.disabled = false; localBtn.textContent = "⚡ Valider sur place immédiatement";
        toast(e.message);
      }
    });
  }

  // Option 3 : Responsable / Admin direct
  const directBtn = $("#annulDirectBtn");
  if (directBtn) {
    directBtn.addEventListener("click", async () => {
      const motif = getMotif();
      if (!motif) return;
      directBtn.disabled = true; directBtn.textContent = "Annulation en cours...";
      try {
        const res = await api("/ventes/" + v.id + "/annuler", { method: "POST", body: JSON.stringify({ motif }) });
        closeModal();
        toast("Vente annulée avec succès ↩️");
        if (onDone) onDone();
        renderers.vente().catch(() => {});
        if (curView === "releve") renderers.releve().catch(() => {});
      } catch (e) {
        directBtn.disabled = false; directBtn.textContent = "🗑️ Confirmer l'annulation immédiate";
        toast(e.message);
      }
    });
  }
}

function showTicket(v) {
  openModal(`
    <div class="success-animation">
      <svg class="checkmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 52">
        <circle class="checkmark__circle" cx="26" cy="26" r="25" fill="none"/>
        <path class="checkmark__check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
      </svg>
    </div>
    <h3 style="text-align:center;margin:4px 0 8px">Vente enregistrée — ${esc(v.numero)}</h3>
    <div class="ticket-preview">${esc(ticketHTML(v))}</div>
    <div class="row wrap" style="margin-top:12px;gap:8px">
      <button class="btn primary grow" id="printTicketBtn">🖨️ Imprimer</button>
      <button class="btn btn-whatsapp grow" id="whatsappTicketBtn">📲 WhatsApp</button>
      <button class="btn ghost grow" onclick="closeModal()">Fermer</button>
    </div>
    <details style="margin-top:14px;border-top:1px solid var(--border);padding-top:8px">
      <summary style="font-size:12px;color:var(--muted);cursor:pointer;user-select:none;text-align:right">⚙️ Options avancées / Litige ▾</summary>
      <div style="margin-top:8px;padding:10px;background:rgba(239,68,68,0.05);border-radius:8px;border:1px dashed rgba(239,68,68,0.3);text-align:left">
        <p style="font-size:11px;margin:0 0 8px;color:var(--muted)">⚠️ L'annulation supprime la vente et réintègre les articles en stock sous la validation du responsable désigné.</p>
        <button class="btn danger small block" id="annulerVenteBtn" style="font-size:12px;padding:8px">⚠️ Demander l'annulation exceptionnelle</button>
      </div>
    </details>
  `);
  $("#whatsappTicketBtn").addEventListener("click", function() { sendTicketWhatsApp(v); });
  $("#printTicketBtn").addEventListener("click", () => printTicket(v));
  $("#annulerVenteBtn").addEventListener("click", () => promptAnnulerVente(v));
  if (usbPrinter) {
    const tb = document.createElement("button");
    tb.className = "btn success grow"; tb.textContent = "🧾 Imprimante thermique";
    tb.addEventListener("click", () => printThermal(v));
    $("#printTicketBtn").parentElement.appendChild(tb);
  }
}


/* ---------- WhatsApp & Animations ---------- */
function formatWhatsAppTicket(v) {
  const b = DB.boutique || {};
  let msg = "*🏪 " + (b.nom || "Boutique") + "*\n";
  if (b.tel) msg += "📞 Tél : " + b.tel + "\n";
  if (b.adresse) msg += "📍 " + b.adresse + "\n";
  msg += "--------------------------------\n";
  msg += "*🧾 TICKET N° : " + v.numero + "*\n";
  msg += "📅 Date : " + fmtDate(v.date || new Date()) + "\n";
  if (v.client_nom) msg += "👤 Client : *" + v.client_nom + "*\n";
  msg += "--------------------------------\n";
  (v.items || []).forEach(function(it) {
    msg += "• " + it.nom + " : " + it.qte + " × " + money(it.prix) + " = *" + money(Number(it.qte) * Number(it.prix)) + "*\n";
  });
  msg += "--------------------------------\n";
  msg += "*TOTAL : " + money(v.total) + "*\n";
  if (Number(v.remise) > 0) msg += "Remise : -" + money(v.remise) + "\n";
  msg += "*NET PAYÉ : " + money(v.net) + "*\n";
  msg += "Mode de règlement : " + (modeLabel(v.mode) || v.mode) + "\n";
  if (Number(v.recu) > 0) msg += "Reçu : " + money(v.recu) + " | Rendu : " + money(v.rendu) + "\n";
  if (v.points_gagnes) msg += "⭐ Points gagnés : +" + v.points_gagnes + " pts\n";
  msg += "--------------------------------\n";
  msg += (b.pied || "Merci de votre visite et à bientôt !");
  return msg;
}

function sendTicketWhatsApp(v) {
  const msg = formatWhatsAppTicket(v);
  let defTel = "";
  if (v.client_id) {
    const cl = (DB.clients || []).find(function(c) { return String(c.id) === String(v.client_id); });
    if (cl && cl.tel) defTel = String(cl.tel).replace(/[^0-9]/g, "");
  }
  askPrompt("📲 Numéro WhatsApp du client (avec indicatif ex: 221...)", defTel || "221", function(num) {
    if (!num) return;
    const clean = num.replace(/[^0-9]/g, "");
    if (clean.length < 8) { toast("Numéro de téléphone incomplet"); return; }
    const url = "https://wa.me/" + clean + "?text=" + encodeURIComponent(msg);
    window.open(url, "_blank");
    toast("Ouverture de WhatsApp 📲");
  });
}

function animateFlyToCart(card) {
  if (!card) return;
  const rect = card.getBoundingClientRect();
  const cartEl = document.querySelector(".cart") || document.getElementById("cartTotal");
  if (!cartEl) return;
  const cartRect = cartEl.getBoundingClientRect();

  const particle = document.createElement("div");
  particle.className = "flying-particle";
  particle.textContent = "+1";
  particle.style.left = (rect.left + rect.width / 2 - 12) + "px";
  particle.style.top = (rect.top + rect.height / 2 - 12) + "px";
  document.body.appendChild(particle);

  requestAnimationFrame(function() {
    particle.style.left = (cartRect.left + 24) + "px";
    particle.style.top = (cartRect.top + 24) + "px";
    particle.style.opacity = "0.2";
    particle.style.transform = "scale(0.5)";
  });

  setTimeout(function() {
    particle.remove();
    const cPanel = document.querySelector(".cart");
    if (cPanel) {
      cPanel.classList.add("cart-bounce");
      setTimeout(function() { cPanel.classList.remove("cart-bounce"); }, 350);
    }
  }, 450);
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
  /* 2e choix : bibliothèque locale html5-qrcode (Safari/Firefox) — chargée à la demande */
  if (!window.Html5Qrcode) {
    ensureScript("/js/html5-qrcode.min.js?v=16").then(() => startScanVideo()).catch(() => { });
    return;
  }
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
    <div class="row wrap" style="margin-bottom:8px"><p class="muted grow" style="margin:0">Lecture seule - votre relevé du ${new Date().toLocaleDateString("fr-FR")}</p><button class="btn small" id="releveZBtn" title="Rapport Z imprimable de la caisse du jour">🧾 Rapport Z</button><button class="btn small" id="releveExport" title="Exporter en CSV">⬇️ CSV</button></div>
    <div class="cards">
      <div class="card"><div class="k">Mes ventes</div><div class="v">${money(ca)}</div></div>
      ${modeCards}
      <div class="card"><div class="k">Tickets</div><div class="v">${vts.length}</div></div>
      ${caisse ? `<div class="card"><div class="k">Ma caisse - ouverte depuis ${new Date(caisse.ouverte_le).toLocaleTimeString("fr-FR")}</div><div class="v" style="font-size:14px">Fonds ${money(caisse.fonds_initial)} · Versé ${money(caisse.verse_total)} · </b></div></div>` : `<div class="card"><div class="k">Ma caisse</div><div class="v" style="font-size:14px">Aucune caisse ouverte - ouvrez-la dans l'onglet Caisse</div></div>`}
    </div>
    ${vts.length > 0 ? pgBar("releve", vts.length, "ticket(s)") : ""}
    <div class="table-wrap"><table><tr><th>Ticket</th><th>Heure</th><th>Articles</th><th>Total</th><th>Paiement</th><th></th></tr>` +
    (vts.length === 0 ? `<tr><td colspan="6" class="empty">Aucune vente aujourd'hui</td></tr>` :
      pgSlice("releve", vts).part.map(v => `<tr><td><b>${esc(v.numero)}</b></td><td>${fmtDate(v.date)}</td><td class="num">${(v.items || []).reduce((s, i) => s + Number(i.qte), 0)}</td><td class="num">${money(v.net)}</td><td>${esc(modeLabel(v.mode))}</td><td><button class="btn small" data-releveticket="${v.id}">🧾 Ticket</button></td></tr>`).join("")) +
    `</table></div>`;
  const zBtn = $("#releveZBtn");
  if (zBtn) zBtn.addEventListener("click", () => {
    const lignes = vts.map(v => `<tr><td>${esc(v.numero)}</td><td>${fmtDate(v.date)}</td><td>${esc(modeLabel(v.mode))}</td><td style="text-align:right">${money(v.net)}</td></tr>`).join("");
    imprimer("Rapport Z", `<div style="font-family:monospace">
      <h2 style="text-align:center;margin:2px">RAPPORT Z</h2>
      <p style="text-align:center">${esc((DB.boutique || {}).nom || "")} — ${new Date().toLocaleDateString("fr-FR")}<br>${esc(cur ? cur.nom : "")}</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">${lignes}</table>
      <h3 style="text-align:right">Total : ${money(ca)} (${vts.length} tickets)</h3>
      ${caisse ? `<h3 style="text-align:right">Fonds : ${money(caisse.fonds_initial)} · Attendu espèces : ${money(caisse.attendu_especes)} · Versé : ${money(caisse.verse_total)}</h3>` : ""}
    </div>`, "80mm");
  });
  const expBtn = $("#releveExport");
  if (expBtn) expBtn.addEventListener("click", () => {
    downloadCSV("releve-" + todayKey() + ".csv", [["Ticket","Heure","Articles","Total","Paiement"]].concat(vts.map(v => [v.numero, fmtDate(v.date), String((v.items || []).reduce((s, i) => s + Number(i.qte), 0)), String(v.net), modeLabel(v.mode)])));
  });
  $$("#releveBox [data-releveticket]").forEach(b => b.addEventListener("click", () => {
    const target = vts.find(x => String(x.id) === String(b.dataset.releveticket));
    if (target) showTicket(target);
  }));
};

/* ---------- produits ---------- */
let prodMasqInactifs = true;
/* --- helpers pour le rendu catalogue (liste / grille) --- */
function _prodStockBadge(p) {
  const n = Number(p.stock), mn = Number(p.stock_min);
  const cls = n <= 0 ? "bad" : n <= mn ? "warn" : "ok";
  return '<span class="badge ' + cls + '">' + n + '</span>';
}
function _prodStockMobile(p) {
  const n = Number(p.stock), mn = Number(p.stock_min);
  const cls = n <= 0 ? "bad" : n <= mn ? "warn" : "ok";
  const label = n <= 0 ? "Rupture" : n <= mn ? "Stock bas" : "En stock";
  return '<span class="badge ' + cls + '">' + label + ' \u00b7 ' + n + '</span>';
}
function _prodFlags(p) {
  let h = '';
  if (p.reference) h += ' <span class="muted" style="font-size:11px;font-family:monospace">' + esc(p.reference) + '</span>';
  if (p.gere_par_lot) h += ' <span class="badge info" style="font-size:10px">\ud83d\udce6 Lot</span>';
  if (!p.actif) h += ' <span class="badge off">inactif</span>';
  return h;
}
function _prodActions(p) {
  return '<div class="actions"><button class="btn small" data-edit="' + p.id + '">\u270f\ufe0f Modifier</button><button class="btn small" data-label="' + p.id + '">\ud83c\udff7\ufe0f \u00c9tiquette</button></div>';
}
function _prodMeta(p) {
  let h = esc(p.famille || 'Sans famille');
  if (p.code) h += ' &middot; <span style="font-family:monospace;font-size:11px">' + esc(p.code) + '</span>';
  return h;
}
function _prodPrices(p) {
  return '<span>Achat <b style="color:var(--ink)">' + money(p.prix_achat) + '</b></span>'
    + '<span>Vente <b style="color:var(--primary)">' + money(p.prix_vente) + '</b></span>'
    + '<span>Marge <b style="color:var(--success)">' + money(Number(p.prix_vente) - Number(p.prix_achat)) + '</b></span>';
}
function renderProdGrid(shown) {
  const pg = pgSlice('produits', shown);
  return '<p class="muted" style="margin:0 0 8px">' + shown.length + ' produit(s)</p>'
    + pgBar('produits', shown.length, 'produit(s)')
    + '<div class="prod-grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">'
    + pg.part.map(function(p) {
      return '<div class="card" style="cursor:pointer;position:relative">'
        + '<div style="display:flex;gap:8px;align-items:start">'
        + (p.has_photo ? '<img src="/api/produits/' + p.id + '/photo" loading="lazy" style="width:48px;height:48px;object-fit:cover;border-radius:8px;flex:none">' : '')
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-weight:700;font-size:14px;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.nom) + ' ' + _prodFlags(p) + '</div>'
        + '<div style="font-size:12px;color:var(--muted);margin-top:2px">' + _prodMeta(p) + '</div>'
        + '</div>'
        + _prodStockBadge(p).replace('badge', 'badge').replace('">', '" style="font-size:11px;flex:none">')
        + '</div>'
        + '<div style="display:flex;gap:12px;margin-top:8px;font-size:13px;color:var(--muted)">' + _prodPrices(p) + '</div>'
        + '<div style="display:flex;gap:6px;margin-top:8px;border-top:1px dashed var(--border);padding-top:8px">' + _prodActions(p) + '</div>'
        + '</div>';
    }).join('')
    + '</div>';
}
function renderProdTable(shown) {
  var pg = pgSlice('produits', shown);
  var h = '<p class="muted" style="margin:0 0 8px">' + shown.length + ' produit(s)' + (prodMasqInactifs ? ' - produits inactifs masqués' : '') + '</p>'
    + pgBar('produits', shown.length, 'produit(s)')
    + '<div class="table-wrap prod-table-d"><table>'
    + '<tr><th>Photo</th><th>Produit</th><th>Famille</th><th>Code-barres</th><th class="num">Prix achat</th><th class="num">Prix vente</th><th class="num">Bénéfice</th><th class="num">Stock</th><th class="sticky-r">Actions</th></tr>';
  pg.part.forEach(function(p) {
    h += '<tr>'
      + '<td>' + (p.has_photo ? '<img src="/api/produits/' + p.id + '/photo" loading="lazy" style="width:36px;height:36px;object-fit:cover;border-radius:6px">' : '-') + '</td>'
      + '<td>' + esc(p.nom) + ' ' + _prodFlags(p) + '</td>'
      + '<td>' + esc(p.famille || '') + '</td>'
      + '<td>' + esc(p.code || '-') + '</td>'
      + '<td class="num">' + money(p.prix_achat) + '</td>'
      + '<td class="num">' + money(p.prix_vente) + '</td>'
      + '<td class="num">' + money(Number(p.prix_vente) - Number(p.prix_achat)) + '</td>'
      + '<td class="num">' + _prodStockBadge(p) + '</td>'
      + '<td class="sticky-r">' + _prodActions(p) + '</td>'
      + '</tr>';
  });
  h += '</table></div>';
  h += '<div class="prod-list-m">';
  pg.part.forEach(function(p) {
    h += '<div class="prod-card-m">'
      + '<div class="pcm-head">'
      + '<div class="pcm-name">' + esc(p.nom) + ' ' + _prodFlags(p) + '</div>'
      + _prodStockMobile(p)
      + '</div>'
      + '<div class="pcm-meta">' + _prodMeta(p) + '</div>'
      + '<div class="pcm-prices">' + _prodPrices(p) + '</div>'
      + '<div class="pcm-actions">' + _prodActions(p) + '</div>'
      + '</div>';
  });
  h += '</div>';
  return h;
}
renderers.produits = async function () {
  const sel = $("#prodFamilleFilter");
  const fSearch = $("#prodSearch").value || "";
  const fam = sel ? sel.value : "";
  const pg = pgGet("produits");
  let list = [], totalCount = 0;
  try {
    const [prodsData, fams] = await Promise.all([
      api(`/produits?page=${pg.page}&limit=${pg.size}` + (fSearch ? `&search=${encodeURIComponent(fSearch)}` : "") + (fam ? `&famille=${encodeURIComponent(fam)}` : "")),
      api("/familles")
    ]);
    if (Array.isArray(prodsData)) { list = prodsData; totalCount = prodsData.length; }
    else { list = prodsData.rows || []; totalCount = prodsData.total || list.length; }
    DB.produits = list; DB.familles = fams;
  } catch (e) { toast(e.message); return; }
  if (sel && !sel.options.length) {
    sel.innerHTML = `<option value="">Toutes les familles</option>` + (DB.familles||[]).map(f => `<option ${sel.value === f.nom ? "selected" : ""}>${esc(f.nom)}</option>`).join("");
  }
  const viewMode = localStorage.getItem("gs_prodView") || "list";
  const isGrid = viewMode === "grid";
  if (list.length === 0) {
    $("#prodWrap").innerHTML = '<div class="empty">' + (prodMasqInactifs ? 'Aucun produit actif' : 'Aucun produit trouvé') + '</div>';
  } else if (isGrid) {
    $("#prodWrap").innerHTML = renderProdGrid(list);
  } else {
    $("#prodWrap").innerHTML = renderProdTable(list);
  }
  // Pagination bar
  const pgBox = $("#prodPg");
  if (pgBox) pgBox.innerHTML = pgBar("produits", totalCount, "produit(s)");
  $$("#prodWrap [data-edit]").forEach(b => b.addEventListener("click", () => prodForm(produitById(b.dataset.edit))));
  $$("#prodWrap [data-label]").forEach(b => b.addEventListener("click", async () => {
    const p = produitById(b.dataset.label);
    if (!p) return;
    /* Charger JsBarcode si nécessaire */
    if (typeof JsBarcode === "undefined") {
      try { await ensureScript("/js/JsBarcode.min.js?v=16"); } catch(e) { toast("Impossible de charger JsBarcode"); return; }
    }
    const code = p.code || p.reference || String(p.id);
    const fam = p.famille || "";
    const boutNom = esc((DB.boutique || {}).nom || "");
    const boutTel = esc((DB.boutique || {}).tel || "");
    /* Générer le SVG du code-barres AVANT l'impression */
    let barcodeHtml = "";
    try {
      const tmpDiv = document.createElement("div");
      tmpDiv.style.position = "absolute"; tmpDiv.style.left = "-9999px";
      document.body.appendChild(tmpDiv);
      JsBarcode(tmpDiv, String(code), { format: "CODE128", width: 2, height: 50, displayValue: true, fontSize: 12, margin: 2, textMargin: 2 });
      barcodeHtml = tmpDiv.innerHTML;
      tmpDiv.remove();
    } catch(e) { barcodeHtml = `<span style="letter-spacing:3px;font-size:14px">${esc(code)}</span>`; }
    const corps = `
      <div style="font-family:Arial,sans-serif;text-align:center;padding:6px;max-width:70mm">
        <div style="font-size:10px;color:#555;margin-bottom:2px">${boutNom}</div>
        <div style="font-size:14px;font-weight:700;margin:4px 0">${esc(p.nom)}</div>
        ${fam ? `<div style="font-size:9px;color:#777;margin-bottom:4px">${esc(fam)}</div>` : ""}
        <div style="font-size:22px;font-weight:900;color:#111;margin:6px 0">${money(p.prix_vente)}</div>
        <div style="margin:6px auto;width:fit-content">${barcodeHtml}</div>
        <div style="font-size:8px;color:#999;margin-top:2px">Réf: ${esc(code)}</div>
        ${boutTel ? `<div style="font-size:8px;color:#999;margin-top:1px">${boutTel}</div>` : ""}
      </div>`;
    imprimer("Étiquette " + p.nom, corps, "A6");
  }));
};
function prodForm(p) {
  const isNew = !p;
  p = p || { famille: "", code: "", prix_achat: 0, prix_vente: 0, stock: 0, stock_min: 0, actif: true };
  const famillesActives = (DB.familles || []).filter(f => f.actif !== false);
  const famActuelleConnue = famillesActives.some(f => String(f.id) === String(p.famille_id || "") || (!p.famille_id && f.nom === p.famille));
  const famOpts = famillesActives.map(f => `<option value="${f.id}" ${String(f.id) === String(p.famille_id || "") || (!p.famille_id && f.nom === p.famille) ? "selected" : ""}>${esc(f.nom)}</option>`).join("")
    + (!famActuelleConnue && p.famille ? `<option value="__arch__" selected>${esc(p.famille)} (archivée)</option>` : "");
  openModal(`<h3>${isNew ? "Nouveau produit" : "Modifier : " + esc(p.nom)}</h3>
    <label class="field">Famille <span class="muted">*</span>
      <select id="pfFamille">
        <option value="">— Sélectionnez la famille —</option>${famOpts}
      </select>
    </label>
    <label class="field">Nom <input id="pfNom" data-fmt="name" value="${esc(p.nom || "")}"></label>
    <div class="row">
      <label class="field grow">Code-barres <input id="pfCode" value="${esc(p.code || "")}" placeholder="6181490000011"></label>
    </div>
    <div class="row">
      <label class="field grow">Unité de mesure
        <select id="pfUnite">
          <option value="pcs" ${(p.unite || "pcs") === "pcs" ? "selected" : ""}>Pièce (pcs)</option>
          <option value="carton" ${p.unite === "carton" ? "selected" : ""}>Carton</option>
          <option value="paquet" ${p.unite === "paquet" ? "selected" : ""}>Paquet</option>
          <option value="boite" ${p.unite === "boite" ? "selected" : ""}>Boîte</option>
          <option value="kg" ${p.unite === "kg" ? "selected" : ""}>Kilogramme (kg)</option>
          <option value="L" ${p.unite === "L" ? "selected" : ""}>Litre (L)</option>
          <option value="m" ${p.unite === "m" ? "selected" : ""}>Mètre (m)</option>
        </select>
      </label>
      <label class="field grow">Emplacement / Rayon
        <input id="pfEmplacement" value="${esc(p.emplacement || "")}" placeholder="ex: Rayon A, Étagère 3">
      </label>
    </div>
    <details style="margin:4px 0 8px;border:1px solid var(--border);border-radius:8px;padding:8px">
      <summary style="font-size:12px;font-weight:700;color:var(--primary);cursor:pointer">📦 Déconditionnement (Lier à un Carton parent) ▾</summary>
      <div class="row" style="margin-top:6px">
        <label class="field grow">Produit parent (Carton source)
          <select id="pfParent">
            <option value="">-- Aucun (produit standard) --</option>
            ${(DB.produits || []).filter(x => String(x.id) !== String(p.id)).map(x => '<option value="' + x.id + '"' + (String(x.id) === String(p.parent_produit_id) ? ' selected' : '') + '>' + esc(x.nom) + ' (' + (x.unite || 'carton') + ')</option>').join('')}
          </select>
        </label>
        <label class="field grow">Unités par carton
          <input id="pfQteParent" type="number" min="1" value="${p.qte_par_parent || 1}">
        </label>
      </div>
    </details>
    <div class="panel" style="margin-top:4px">
      <b style="font-size:13px">📷 Photo du produit</b>
      <div id="pfPhotoPrev" style="margin-top:6px">${p.has_photo ? `<img src="/api/produits/${p.id}/photo" style="max-height:110px;border-radius:8px">` : `<span class="muted">Aucune photo</span>`}</div>
      <div class="row" style="margin-top:6px">
        <button class="btn small primary" id="pfPhotoCam" type="button">📷 Prendre une photo</button>
        <button class="btn small" id="pfPhotoLoad" type="button">📁 Charger une photo</button>
        <button class="btn small" id="pfPhotoDel" type="button">🗑️ Retirer</button>
      </div>
      <input type="file" id="pfPhotoCamInput" accept="image/*" capture="environment" class="hidden">
      <input type="file" id="pfPhotoLoadInput" accept="image/*" class="hidden">
    </div>
    <div class="row">
      <label class="field grow">Prix achat unité (F) <input id="pfPA" type="text" data-fmt="money" inputmode="decimal" min="0" value="${p.prix_achat || ""}"></label>
      <label class="field grow">Prix vente unité (F) <input id="pfPV" type="text" data-fmt="money" inputmode="decimal" min="0" value="${p.prix_vente || ""}"></label>
    </div>
    <div class="panel" style="margin-top:4px">
      <b style="font-size:13px">🧮 OU calcul automatique : prix d'un carton / paquet</b>
      <div class="row">
        <label class="field grow">Prix du carton (F) <input id="pfCarton" type="text" data-fmt="money" inputmode="decimal" min="0" placeholder="ex. 12000"></label>
        <label class="field grow">Quantité dans le carton <input id="pfCartonQte" type="number" inputmode="decimal" min="1" placeholder="ex. 24"></label>
      </div>
      <p class="muted" id="pfCalc">Le prix à l'unité sera calculé automatiquement (carton ÷ quantité).</p>
    </div>
    <div class="row">
      <label class="field grow">Stock ${isNew ? "initial" : "actuel"} <input id="pfStock" type="text" data-fmt="money" inputmode="decimal" min="0" value="${p.stock || 0}" ${isNew ? "" : "disabled"}></label>
      <label class="field grow">Seuil minimum <input id="pfMin" type="text" data-fmt="money" inputmode="decimal" min="0" value="${p.stock_min || 0}"></label>
    </div>
    <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="pfActif" style="width:auto" ${p.actif ? "checked" : ""}> Produit actif (visible à la vente)</label>
    <label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="pfLot" style="width:auto" ${p.gere_par_lot ? "checked" : ""}> Géré par lot <span class="muted" style="font-weight:400;font-size:12px">(lot et date de péremption obligatoires à la réception)</span></label>
    <div class="row"><button class="btn success grow" id="pfSave">💾 Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  const calc = () => {
    const c = numV($("#pfCarton")) || 0, q = numV($("#pfCartonQte")) || 0;
    if (c > 0 && q > 0) { const u = Math.round(c / q); $("#pfPA").value = u; $("#pfCalc").textContent = `Prix à l'unité calculé : ${money(u)} (${money(c)} ÷ ${q})`; }
  };
  $("#pfCarton").addEventListener("input", calc); $("#pfCartonQte").addEventListener("input", calc);
  /* photo non chargée dans les listes : envoi seulement si l'utilisateur la modifie ou la supprime */
  let prodPhoto = null, photoDirty = false;
  const showPhoto = () => { $("#pfPhotoPrev").innerHTML = (prodPhoto || (p.has_photo && !photoDirty)) ? `<img src="${prodPhoto || "/api/produits/" + p.id + "/photo"}" style="max-height:110px;border-radius:8px">` : `<span class="muted">Aucune photo</span>`; };
  const onPhoto = async e => {
    const f = e.target.files && e.target.files[0];
    if (f) { try { prodPhoto = await readImage(f, 400); photoDirty = true; showPhoto(); } catch (err) { toast("Photo illisible"); } }
    e.target.value = "";
  };
  $("#pfPhotoCam").addEventListener("click", () => $("#pfPhotoCamInput").click());
  $("#pfPhotoLoad").addEventListener("click", () => $("#pfPhotoLoadInput").click());
  $("#pfPhotoDel").addEventListener("click", () => { prodPhoto = null; photoDirty = true; showPhoto(); });
  $("#pfPhotoCamInput").addEventListener("change", onPhoto);
  $("#pfPhotoLoadInput").addEventListener("change", onPhoto);
  $("#pfSave").addEventListener("click", async () => {
    const nom = $("#pfNom").value.trim();
    const pa = numV($("#pfPA")) || 0, pv = numV($("#pfPV")) || 0;
    if (!nom) { toast("Le nom est obligatoire"); return; }
    const famVal = $("#pfFamille").value;
    if (!famVal || famVal === "__arch__") { toast("Sélectionnez d'abord la famille de l'article"); return; }
    if (pv <= 0) { toast("Le prix de vente est obligatoire"); return; }
    const body = {
      nom,
      famille_id: Number(famVal),
      code: $("#pfCode").value.trim(),
      prix_achat: pa,
      prix_vente: pv,
      stock_min: numV($("#pfMin")) || 0,
      actif: $("#pfActif").checked,
      ...(photoDirty ? { photo: prodPhoto } : {}),
      gere_par_lot: $("#pfLot").checked,
      unite: $("#pfUnite") ? $("#pfUnite").value : 'pcs',
      emplacement: $("#pfEmplacement") ? $("#pfEmplacement").value.trim() : null,
      parent_produit_id: $("#pfParent") && $("#pfParent").value ? numV($("#pfParent")) : null,
      qte_par_parent: $("#pfQteParent") ? numV($("#pfQteParent")) || 1 : 1
    };
    try {
      if (isNew) {
        body.stock = numV($("#pfStock")) || 0;
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
  const pg = pgGet("stock_prods");
  let prodsData = [], totalCount = 0;
  try {
    const r = await api(`/produits?page=${pg.page}&limit=${pg.size}`);
    if (Array.isArray(r)) { prodsData = r; totalCount = r.length; }
    else { prodsData = r.rows || []; totalCount = r.total || prodsData.length; }
    DB.produits = prodsData;
    DB.typesMv = await api("/types-mouvement");
  } catch (e) { toast(e.message); return; }
  let lots = [], four = [], cmds = [];
  if (hasRight("R_STOCK")) {
    try {
      const fourData = await api("/fournisseurs?limit=200").catch(()=>[]);
      four = Array.isArray(fourData) ? fourData : (fourData.rows || []);
      const lotsData = await api("/lots?limit=100").catch(()=>({rows:[]}))
      lots = Array.isArray(lotsData) ? lotsData : (lotsData.rows || []);
      cmds = await api("/commandes").catch(()=>[]);
    } catch (e) { }
  }
  DB.lots = lots; DB.fournisseurs = four; DB.commandes = cmds;
  const tabs = [["produits", "📦 Produits"], ["mouvements", "🔁 Entrées & sorties"], ["peremptions", "⏰ Péremptions"], ["acommander", "🛒 À commander"], ["fournisseurs", "👥 Fournisseurs"], ["commandes", "📋 Commandes"], ["dormant", "💤 Stock dormant"]];
  $("#stockWrap").innerHTML = `
    <div class="tabs" style="margin-bottom:10px">${tabs.map(t => `<button class="tab ${stTab === t[0] ? "on" : ""}" data-stab="${t[0]}">${t[1]}</button>`).join("")}</div>
    <div id="stBody"></div>`;
  $$("#stockWrap [data-stab]").forEach(b => b.addEventListener("click", () => { stTab = b.dataset.stab; renderers.stock().catch(() => { }); }));
  const box = $("#stBody");
  if (stTab === "produits") renderStProduits(box, prodsData);
  else if (stTab === "mouvements") renderStMouvements(box, prodsData);
  else if (stTab === "peremptions") renderStPeremptions(box, lots);
  else if (stTab === "acommander") AppStock.renderCommander(box);
  else if (stTab === "fournisseurs") renderStFournisseurs(box, four);
  else if (stTab === "commandes") renderStCommandes(box, cmds);
  else if (stTab === "dormant") renderers.dormant(box).catch(() => {});
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
        <td>${p.has_photo ? `<img src="/api/produits/${p.id}/photo" loading="lazy" style="width:30px;height:30px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:6px">` : ""}${esc(p.nom)}</td>
        <td><span class="badge ${p.gere_par_lot ? "info" : "off"}" style="font-size:10px;padding:1px 6px">${p.gere_par_lot ? "📦 Lot" : "—"}</span></td>
        <td class="num">${p.stock}</td>
        <td class="num">${p.stock_min}</td>
        <td><span class="badge ${Number(p.stock) <= 0 ? "bad" : Number(p.stock) <= Number(p.stock_min) ? "warn" : "ok"}">${Number(p.stock) <= 0 ? "Rupture" : Number(p.stock) <= Number(p.stock_min) ? "Stock bas" : "OK"}</span></td>
        <td class="sticky-r"><div class="actions actions-grid">
          ${p.parent_produit_id ? `<button class="btn small primary" data-mv="decond" data-pid="${p.id}" title="Déconditionner depuis le carton">📦 Déconditionner</button>` : ""}
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
    if (b.dataset.mv === "decond") promptDeconditionner(p);
    else if (b.dataset.mv === "entree") mvForm(p, "Entrée", Math.max(Number(p.stock_min) - Number(p.stock), 1));
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
    <details class="stk-details">
      <summary>🚚 Sortie rapide <span class="muted">— don, usage interne…</span></summary>
      <div id="stkSortieBox"></div>
    </details>
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
  const stkSortie = $("#stkSortieBox");
  if (stkSortie && typeof AppStock !== "undefined") AppStock.renderSortie(stkSortie);
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
    askConfirm("Rebuter le lot", `Rebuter le lot de <b>${esc(l.produit_nom)}</b> (${l.qte_restante}) ? Le stock sera réduit.`, async () => {
      try { await api(`/lots/${l.id}/rebut`, { method: "POST" }); toast("Lot rebuté ✅"); renderers.stock().catch(() => { }); } catch (e) { toast(e.message); }
    }, { danger: true, okLabel: "Rebuter" });
  }));
}

function renderStFournisseurs(box, four) {
  box.innerHTML = `
    <div class="point-card">
      <div class="row" style="align-items:center;margin-bottom:8px"><h3 class="grow" style="margin:0">👥 Fournisseurs</h3><button class="btn small primary" id="fourBtn">+ Fournisseur</button></div>
      ${four.length > 0 ? pgBar("stFour", four.length, "fournisseur(s)") : ""}
      <div class="table-wrap"><table><tr><th>Nom</th><th>Tél</th><th class="sticky-r">Actions</th></tr>
        ${four.length === 0 ? `<tr><td colspan="3" class="empty">Aucun fournisseur</td></tr>` :
          pgSlice("stFour", four).part.map(f => `<tr><td>${esc(f.nom)}</td><td>${esc(f.tel || "-")}</td><td class="sticky-r"><div class="actions"><button class="btn small" data-fedit="${f.id}">✏️</button><button class="btn small" data-fdel="${f.id}">🗑</button></div></td></tr>`).join("")}
      </table></div>
    </div>`;
  $$("#stBody [data-fedit]").forEach(b => b.addEventListener("click", () => fournisseurForm(four.find(f => String(f.id) === String(b.dataset.fedit)))));
  $$("#stBody [data-fdel]").forEach(b => b.addEventListener("click", async () => {
    const f = four.find(x => String(x.id) === String(b.dataset.fdel));
    if (!f) return;
    askConfirm("Archiver le fournisseur", `Archiver le fournisseur <b>${esc(f.nom)}</b> ?<br><span class="muted">Le fournisseur sera archivé mais restera dans l'historique des commandes et mouvements de stock.</span>`, async () => {
      try { await api("/fournisseurs/" + f.id, { method: "DELETE" }); toast("Fournisseur archivé — historique conservé ✅"); renderers.stock().catch(() => { }); } catch (e) { toast(e.message); }
    }, { okLabel: "📦 Archiver" });
  }));
  $("#fourBtn").addEventListener("click", () => fournisseurForm(null));
}

function renderStCommandes(box, cmds) {
  box.innerHTML = `
    <div class="point-card">
      <div class="row" style="align-items:center;margin-bottom:8px"><h3 class="grow" style="margin:0">📋 Commandes fournisseurs</h3><button class="btn small primary" id="cmdBtn">+ Commande</button></div>
      ${cmds.length > 0 ? pgBar("stCmds", cmds.length, "commande(s)") : ""}
      <div class="table-wrap"><table><tr><th>N°</th><th>Fournisseur</th><th>Date</th><th>Statut</th><th class="sticky-r">Actions</th></tr>
        ${cmds.length === 0 ? `<tr><td colspan="5" class="empty">Aucune commande</td></tr>` :
          pgSlice("stCmds", cmds).part.map(c => `<tr><td>#${c.id}</td><td>${esc(c.fournisseur_nom || "-")}</td><td>${fmtDate(c.date)}</td><td>${c.statut === "recue" ? `<span class="badge ok">Reçue</span>` : `<span class="badge warn">En cours</span>`}</td>
          <td class="sticky-r"><div class="actions">${c.statut === "en_cours" ? `<button class="btn small success" data-cmdrec="${c.id}">📥 Réceptionner</button>` : ""}<button class="btn small" data-cmddet="${c.id}">👁️</button></div></td></tr>`).join("")}
      </table></div>
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
        <label class="bf-i-q">Quantité <input type="number" inputmode="decimal" min="1"${entree ? "" : ` max="${p.stock}"`} value="1" class="bfq"></label>
        ${entree ? `<label class="bf-i-l">N° de lot * <input type="text" class="bflot" placeholder="ex. L2024-001"></label>
        <label class="bf-i-p">Péremption * <input type="date" class="bfper"></label>` : `<label class="bf-i-l">Lot à sortir
          <select class="bflotsel"><option value="">🔄 Auto (plus ancien)</option>${(DB.lots || []).filter(l => Number(l.produit_id) === Number(p.id) && Number(l.qte_restante) > 0).map(l => `<option value="${l.id}">${esc(l.numero || "Lot #" + l.id)} — ${fmtDateOnly(l.date_peremption)} (${l.qte_restante})</option>`).join("")}</select>
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
    <label class="field">Quantité <input id="ltQte" type="number" inputmode="decimal" min="1" value="1"></label>
    <label class="field">Date de péremption * <input id="ltPer" type="date"></label>
    <p class="muted">Le stock augmente de la quantité. À la vente, le lot le plus ancien part en premier (FIFO).</p>
    <div class="row"><button class="btn success grow" id="ltSave">💾 Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  $("#ltSave").addEventListener("click", async () => {
    const q = numV($("#ltQte")) || 0;
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
    <label class="field">Nom <input id="ffNom" data-fmt="name" value="${esc(f.nom)}"></label>
    <div class="row"><label class="field grow">Téléphone <input id="ffTel" data-fmt="phone" value="${esc(f.tel || "")}"></label>
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
      <label class="field bf-field">Coût de livraison (F) <input id="cmLiv" type="text" data-fmt="money" inputmode="decimal" min="0" value="0"></label>
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
          <label class="field bf-field">Quantité <input type="number" inputmode="decimal" min="1" value="${l.qte}" data-linqte="${i}"></label>
          <label class="field bf-field">Prix achat (F) <input type="text" inputmode="decimal" data-fmt="money" value="${l.pa}" data-linpa="${i}"></label>
        </div>
      </div>`).join("");
    $$("#cmLines [data-lindel]").forEach(b => b.addEventListener("click", () => { lignes.splice(Number(b.dataset.lindel), 1); renderLignes(); }));
    $$("#cmLines [data-linqte]").forEach(inp => inp.addEventListener("change", () => { const i = Number(inp.dataset.linqte); lignes[i].qte = Math.max(1, Number(inp.value) || 1); }));
    $$("#cmLines [data-linpa]").forEach(inp => inp.addEventListener("change", () => { const i = Number(inp.dataset.linpa); lignes[i].pa = Math.max(0, numV(inp) || 0); }));
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
    if (!numV($("#cmFour"))) { toast("Sélectionnez le fournisseur"); return; }
    try {
      await api("/commandes", { method: "POST", body: JSON.stringify({ fournisseur_id: numV($("#cmFour")), livraison: numV($("#cmLiv")) || 0, notes: $("#cmNotes").value, items: lignes.map(l => ({ produitId: l.produitId, qte: l.qte, prix_achat: l.pa })) }) });
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
            <label class="field bf-field">Reçu <input type="number" inputmode="decimal" min="0" value="${l.qte}" data-crqte="${i}"></label>
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
        await api(`/commandes/${c.id}/receptionner`, {
          method: "POST",
          body: JSON.stringify({
            lignes: actives.map(l => ({
              produitId: l.produitId,
              qte: l.qte,
              numeroLot: (l.numeroLot && String(l.numeroLot).trim()) || null,
              datePeremption: (l.datePeremption && String(l.datePeremption).trim()) || null
            }))
          })
        });
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
    <div class="row"><input id="famNew" class="grow" data-fmt="name" placeholder="Nouvelle famille..."><label class="field" style="display:flex;gap:6px;align-items:center;flex:0 0 auto"><input type="checkbox" id="famNewLot" style="width:auto"> Par lot</label><button class="btn primary" id="famAdd">+ Ajouter</button></div>
    <div class="table-wrap" style="margin-top:8px"><table><tr><th>Famille</th><th>Géré par lot</th><th>Statut</th><th>Actions</th></tr>
      ${fams.length === 0 ? `<tr><td colspan="4" class="empty">Aucune famille</td></tr>` :
        fams.map(f => `<tr><td>${esc(f.nom)}</td><td><span class="badge ${f.gere_par_lot ? "info" : "off"}">${f.gere_par_lot ? "Oui" : "Non"}</span></td><td>${f.actif !== false ? '<span class="badge ok">Active</span>' : '<span class="badge off">Archivée</span>'}</td><td><div class="actions"><button class="btn small" data-fren="${f.id}">✎</button><button class="btn small" data-frlot="${f.id}" title="Activer/désactiver la gestion par lot">📦</button><button class="btn small ${f.actif !== false ? 'ghost' : 'success'}" data-frmod="${f.id}">${f.actif !== false ? '🚫 Désactiver' : '✅ Réactiver'}</button></div></td></tr>`).join("")}
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
    if (f.actif !== false) {
      // Désactiver (soft delete)
      askConfirm("Désactiver la famille", `Désactiver la famille <b>« ${esc(f.nom)} »</b> ?<br><span class="muted">La famille sera archivée mais conservée dans l'historique. Les produits existants ne seront pas supprimés.</span>`, async () => {
        try { await api("/familles/" + f.id, { method: "DELETE" }); toast("Famille désactivée — elle reste dans l'historique"); DB.familles = await api("/familles?all=1"); renderers.produits().catch(() => { }); renderers.vente().catch(() => { }); famManager(host); } catch (e) { toast(e.message); }
      }, { danger: true, okLabel: "🚫 Désactiver" });
    } else {
      // Réactiver
      try { await api("/familles/" + f.id, { method: "PUT", body: JSON.stringify({ nom: f.nom, gere_par_lot: f.gere_par_lot, actif: true }) }); toast("Famille réactivée ✅"); DB.familles = await api("/familles?all=1"); famManager(host); } catch (e) { toast(e.message); }
    }
  }));
}
/* ---------- renderer familles (onglet Paramètres > Familles) ---------- */
renderers.familles = async function () {
  let fams = [];
  try { fams = await api("/familles?all=1"); DB.familles = fams; } catch (e) { toast(e.message); return; }
  const box = $("#famillesBox");
  if (!box) return;
  const active = fams.filter(f => f.actif !== false);
  const archived = fams.filter(f => f.actif === false);
  /* Construction HTML sans template literals imbriqués pour éviter les erreurs de syntaxe */
  var h = '<div class="row" style="margin-bottom:12px;gap:8px">'
    + '<input id="famNewInput" class="grow" data-fmt="name" placeholder="Nom de la nouvelle famille..." style="max-width:300px">'
    + '<label class="field" style="display:flex;gap:6px;align-items:center;margin:0;white-space:nowrap"><input type="checkbox" id="famNewLot" style="width:auto"> 📦 Gérée par lot</label>'
    + '<button class="btn primary" id="famAddBtn">+ Ajouter</button>'
    + '</div>'
    + '<p class="muted" style="margin:0 0 8px">' + active.length + ' famille(s) active(s)</p>';
  if (active.length === 0) {
    h += '<div class="empty">Aucune famille — créez-en une ci-dessus</div>';
  } else {
    h += '<div class="table-wrap"><table>'
      + '<tr><th>Famille</th><th>Code</th><th>Géré par lot</th><th>Statut</th><th>Actions</th></tr>';
    active.forEach(function(f) {
      h += '<tr>'
        + '<td style="font-weight:600">' + esc(f.nom) + '</td>'
        + '<td><span style="font-family:monospace;font-size:12px;color:var(--muted)">' + esc(f.code || '-') + '</span></td>'
        + '<td><span class="badge ' + (f.gere_par_lot ? 'info' : 'off') + '">' + (f.gere_par_lot ? 'Oui 📦' : 'Non') + '</span></td>'
        + '<td><span class="badge ok">Active</span></td>'
        + '<td><div class="actions">'
        + '<button class="btn small" data-fren="' + f.id + '">✏️ Renommer</button>'
        + '<button class="btn small" data-frlot="' + f.id + '" title="Activer/désactiver gestion par lot">📦 Lot</button>'
        + '<button class="btn small ghost" data-frdis="' + f.id + '">🚫 Désactiver</button>'
        + '</div></td></tr>';
    });
    h += '</table></div>';
  }
  if (archived.length > 0) {
    h += '<h3 style="margin-top:18px">📦 Familles archivées (' + archived.length + ')</h3>'
      + '<div class="table-wrap"><table>'
      + '<tr><th>Famille</th><th>Statut</th><th>Action</th></tr>';
    archived.forEach(function(f) {
      h += '<tr>'
        + '<td style="opacity:.6">' + esc(f.nom) + '</td>'
        + '<td><span class="badge off">Archivée</span></td>'
        + '<td><button class="btn small success" data-frreact="' + f.id + '">✅ Réactiver</button></td>'
        + '</tr>';
    });
    h += '</table></div>';
  }
  box.innerHTML = h;
  /* Event listeners */
  const refresh = () => renderers.familles().catch(() => {});
  box.querySelector("#famAddBtn").addEventListener("click", async () => {
    const nom = box.querySelector("#famNewInput").value.trim();
    if (!nom) { toast("Nom obligatoire"); return; }
    try {
      await api("/familles", { method: "POST", body: JSON.stringify({ nom, gere_par_lot: box.querySelector("#famNewLot").checked }) });
      toast("Famille créée ✅");
      box.querySelector("#famNewInput").value = "";
      DB.familles = await api("/familles?all=1");
      refresh();
    } catch (e) { toast(e.message); }
  });
  box.querySelectorAll("[data-fren]").forEach(b => b.addEventListener("click", () => {
    const f = active.find(x => String(x.id) === String(b.dataset.fren));
    if (!f) return;
    askPrompt("Renommer la famille", f.nom, async nv => {
      if (!nv || !nv.trim()) return;
      try { await api("/familles/" + f.id, { method: "PUT", body: JSON.stringify({ nom: nv.trim() }) }); toast("Famille renommée"); DB.familles = await api("/familles?all=1"); refresh(); } catch (e) { toast(e.message); }
    });
  }));
  box.querySelectorAll("[data-frlot]").forEach(b => b.addEventListener("click", async () => {
    const f = active.find(x => String(x.id) === String(b.dataset.frlot));
    if (!f) return;
    try {
      await api("/familles/" + f.id, { method: "PUT", body: JSON.stringify({ nom: f.nom, gere_par_lot: !f.gere_par_lot }) });
      toast(f.gere_par_lot ? "Gestion par lot désactivée" : "Gestion par lot activée");
      DB.familles = await api("/familles?all=1"); refresh();
    } catch (e) { toast(e.message); }
  }));
  box.querySelectorAll("[data-frdis]").forEach(b => b.addEventListener("click", () => {
    const f = active.find(x => String(x.id) === String(b.dataset.frdis));
    if (!f) return;
    askConfirm("Désactiver la famille", `Désactiver <b>« ${esc(f.nom)} »</b> ? Les produits existants ne seront pas supprimés.`, async () => {
      try { await api("/familles/" + f.id, { method: "DELETE" }); toast("Famille désactivée"); DB.familles = await api("/familles?all=1"); refresh(); } catch (e) { toast(e.message); }
    }, { danger: true, okLabel: "🚫 Désactiver" });
  }));
  box.querySelectorAll("[data-frreact]").forEach(b => b.addEventListener("click", async () => {
    const f = archived.find(x => String(x.id) === String(b.dataset.frreact));
    if (!f) return;
    try { await api("/familles/" + f.id, { method: "PUT", body: JSON.stringify({ nom: f.nom, gere_par_lot: f.gere_par_lot, actif: true }) }); toast("Famille réactivée ✅"); DB.familles = await api("/familles?all=1"); refresh(); } catch (e) { toast(e.message); }
  }));
};
function mvForm(p, type, qteDefaut) {
  openModal(`<h3>${type} - ${esc(p.nom)}</h3>
    <label class="field">Quantité
      <input id="mvQte" type="number" inputmode="decimal" value="${qteDefaut != null ? qteDefaut : 1}" min="1">
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
      const s = $("#mvSens").value, qt = numV($("#mvQte")) || 0;
      const ap = Number(p.stock) + (s === "retirer" ? -qt : qt);
      $("#mvApres").textContent = "Stock actuel : " + p.stock + " → après : " + Math.max(ap, 0);
    };
    $("#mvSens").addEventListener("change", updApres);
    $("#mvQte").addEventListener("input", updApres);
  }
  $("#mvSave").addEventListener("click", async () => {
    const q = numV($("#mvQte")) || 0, motif = $("#mvMotif").value.trim();
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
        const fourId = $("#mvFour") ? numV($("#mvFour")) || null : null;
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
      <input id="invQte" type="number" inputmode="decimal" min="0" value="${p.stock}">
    </label>
    <p class="muted" id="invEcart">Écart : 0</p>
    <div class="row"><button class="btn success grow" id="invSave">Valider l'inventaire</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>`);
  const upd = () => { const q = numV($("#invQte")) || 0; $("#invEcart").textContent = `Écart : ${q - Number(p.stock) > 0 ? "+" : ""}${q - Number(p.stock)} unité(s)`; };
  $("#invQte").addEventListener("input", upd);
  $("#invSave").addEventListener("click", async () => {
    const q = numV($("#invQte")) || 0;
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

function sharePointWhatsApp(caisses, from, to) {
  const bq = DB.boutique || {};
  const tEsp = caisses.reduce((s, c) => s + Number(c.especes || 0), 0);
  const tAutres = caisses.reduce((s, c) => s + Number(c.autres || 0), 0);
  const tVerse = caisses.reduce((s, c) => s + Number(c.verse_total || 0), 0);
  const tEcart = caisses.reduce((s, c) => s + Number(c.ecart || 0), 0);
  const tTickets = caisses.reduce((s, c) => s + Number(c.tickets || 0), 0);
  const totalCA = tEsp + tAutres;

  const txt = `📊 *BILAN DE CAISSE - ${esc(bq.nom || "GSV")}*
🗓️ Période : du ${from} au ${to}
══════════════════════
💵 *Chiffre d'Affaires :* ${money(totalCA)} (${tTickets} tickets)
  • Espèces : ${money(tEsp)}
  • Autres modes (Mobile/Carte) : ${money(tAutres)}
🏦 *Versements effectués :* ${money(tVerse)}
⚖️ *Écart global constaté :* ${money(tEcart)}
══════════════════════
${caisses.map(c => `👤 ${c.user_nom} : ${money(Number(c.especes)+Number(c.autres||0))} (${c.tickets||0} tks, statut: ${c.statut})`).join("\n")}
══════════════════════
Généré le ${new Date().toLocaleDateString("fr-FR")} à ${new Date().toLocaleTimeString("fr-FR")}`;

  openModal(`<h3>📲 Partager le bilan de caisse</h3>
    <div class="ticket-preview" style="font-family:sans-serif;white-space:pre-wrap;font-size:13px">${esc(txt)}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn success grow" id="openWaBtn">📲 Ouvrir WhatsApp</button>
      <button class="btn primary grow" id="copyWaBtn">📋 Copier le texte</button>
      <button class="btn ghost grow" onclick="closeModal()">Fermer</button>
    </div>`);

  $("#openWaBtn").addEventListener("click", () => {
    window.open("https://wa.me/?text=" + encodeURIComponent(txt), "_blank");
  });
  $("#copyWaBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(txt).then(() => toast("Bilan copié dans le presse-papier ✅")).catch(() => toast("Erreur de copie"));
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
  const nA = attente.length, nV = validees.length, nTot = caisses.length;
  const hasEcart = tEcart !== 0;
  $("#pointBox").innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px">
      <label class="field" style="margin:0">Du <input id="ptFrom" type="date" value="${pointFrom}" style="width:140px"></label>
      <label class="field" style="margin:0">Au <input id="ptTo" type="date" value="${pointTo}" style="width:140px"></label>
      <label class="field" style="margin:0">Caissière
        <select id="ptCaiss" style="width:130px"><option value="">Toutes</option>${cashiers.map(x => `<option ${String(pointCaiss) === String(x.id) ? "selected" : ""} value="${x.id}">${esc(x.nom)}</option>`).join("")}</select>
      </label>
      <button class="btn primary" id="ptFilter">🔎</button>
    </div>
    <div class="cards" style="margin-bottom:10px">
      <div class="card" style="border-left:3px solid var(--primary)"><div class="k">Caisses</div><div class="v">${nTot}</div></div>
      <div class="card" style="border-left:3px solid var(--warn)"><div class="k">⏳ En attente</div><div class="v">${nA}</div></div>
      <div class="card" style="border-left:3px solid var(--ok)"><div class="k">✅ Validées</div><div class="v">${nV}</div></div>
      <div class="card" style="border-left:3px solid var(--primary)"><div class="k">💵 Attendu</div><div class="v">${money(tAttendu)}</div></div>
      <div class="card" style="border-left:3px solid ${hasEcart ? "var(--bad)" : "var(--ok)"}"><div class="k">⚠️ Écart</div><div class="v ${hasEcart ? "bad" : "ok"}">${tEcart >= 0 ? "+" : ""}${money(tEcart)}</div></div>
    </div>
    <div class="chips" style="margin-bottom:8px">
      <button class="chip-btn ${pointTab === "attente" ? "active" : ""}" data-tab="attente">⏳ En attente (${nA})</button>
      <button class="chip-btn ${pointTab === "validees" ? "active" : ""}" data-tab="validees">✅ Validées (${nV})</button>
      <button class="chip-btn ${pointTab === "classement" ? "active" : ""}" data-tab="classement">🏆 Classement</button>
    </div>
    ${pointTab === "classement" ? `
    <div class="point-card">
      <h3>🏆 Classement (${pointFrom} → ${pointTo})</h3>
      <div class="chips">
        <button class="chip-btn ${pointClass === "caissiere" ? "active" : ""}" data-cl="caissiere">Par caissière</button>
        <button class="chip-btn ${pointClass === "famille" ? "active" : ""}" data-cl="famille">Par famille</button>
        <button class="chip-btn ${pointClass === "article" ? "active" : ""}" data-cl="article">Par article</button>
      </div>
      <div id="pointClassBox"></div>
    </div>` : `
    <div class="point-card">
      <div class="row wrap" style="margin-bottom:8px;gap:8px;justify-content:flex-end">
        <button class="btn primary" id="pointPrint">🖨️ Imprimer</button>
        <button class="btn success" id="pointWhatsapp">📲 WhatsApp</button>
        <button class="btn ghost" id="pointCsv">⬇️ CSV</button>
      </div>
      ${tab.length > 0 ? pgBar("point", tab.length, "caisse(s)") : ""}
      <div class="table-wrap"><table>
        <tr><th class="sticky-l">Caissière</th><th>Ouverture</th><th class="num">Ventes</th><th class="num">Espèces attendu</th><th class="num">Compté</th><th class="num">Écart</th><th class="sticky-r">Actions</th></tr>
        ${tab.length === 0 ? `<tr><td colspan="7" class="empty">Aucune caisse dans cet onglet pour la période</td></tr>` : pgSlice("point", tab).part.map(c => `<tr>
          <td class="sticky-l"><b>${esc(c.user_nom)}</b><br>${caisseBadge(c.statut)}${c.statut === "validee" ? ` <span class="muted">par ${esc(c.validee_par_nom || "")}</span>` : ""}</td>
          <td>${new Date(c.ouverte_le).toLocaleDateString("fr-FR")} ${new Date(c.ouverte_le).toLocaleTimeString("fr-FR")}${c.fermee_le ? `<br><span class="muted">fermée ${new Date(c.fermee_le).toLocaleTimeString("fr-FR")}</span>` : ""}</td>
          <td class="num">${money(c.total)}</td>
          <td class="num">${money(c.statut === "ouverte" ? c.attendu_especes : c.total_attendu || 0)}</td>
          <td class="num">${c.total_compte != null ? money(c.total_compte) : "-"}</td>
          <td class="num">${c.ecart != null ? `<span class="${Number(c.ecart) === 0 ? "ok" : "bad"}">${Number(c.ecart) > 0 ? "+" : ""}${money(c.ecart)}</span>` : "-"}</td>
          <td class="sticky-r"><div class="actions">
            <button class="btn small" data-detail="${c.id}">👁️</button>
            ${c.statut === "ouverte" ? `<button class="btn small" data-vers="${c.id}">➕</button>` : ""}
            ${c.statut === "fermee" ? `<button class="btn small success" data-val="${c.id}">✅</button><button class="btn small danger" data-rejet="${c.id}">🚫</button>` : ""}
            <button class="btn small" data-print-c="${c.id}" title="Imprimer">🖨️</button>
            <button class="btn small" data-wa-c="${c.id}" title="WhatsApp">📲</button>
            <button class="btn small" data-csv-c="${c.id}" title="CSV">⬇️</button>
          </div></td>
        </tr>`).join("")}
        <tr style="font-weight:800;background:var(--bg2)"><td class="sticky-l">Total (${tab.length})</td><td></td><td class="num">${money(tab.reduce((s,c)=>s+Number(c.total),0))}</td><td class="num">${money(tAttendu)}</td><td class="num">${money(tCompte)}</td><td class="num ${hasEcart ? "bad" : "ok"}">${tEcart >= 0 ? "+" : ""}${money(tEcart)}</td><td class="sticky-r"></td></tr>
      </table></div>
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
  const waBtn = $("#pointWhatsapp");
  if (waBtn) waBtn.addEventListener("click", () => sharePointWhatsApp(caisses, pointFrom, pointTo));
  $("#pointCsv").addEventListener("click", () => {
    const lines = [["Caissière", "Ouverture", "Statut", "Ventes", "Espèces attendu", "Compté", "Écart"]].concat(tab.map(c => [c.user_nom, new Date(c.ouverte_le).toLocaleString("fr-FR"), c.statut, c.total, c.statut === "ouverte" ? c.attendu_especes : c.total_attendu || 0, c.total_compte != null ? c.total_compte : "", c.ecart != null ? c.ecart : ""]));
    downloadCsv("caisses-" + pointFrom + "-" + pointTo + ".csv", lines);
  });
  $$("#pointBox [data-detail]").forEach(b => b.addEventListener("click", () => caisseDetail(caisses.find(c => String(c.id) === String(b.dataset.detail)))));
  $$("#pointBox [data-vers]").forEach(b => b.addEventListener("click", () => versementForm(caisses.find(c => String(c.id) === String(b.dataset.vers)))));
  $$("#pointBox [data-val]").forEach(b => b.addEventListener("click", async () => {
    const c = caisses.find(x => String(x.id) === String(b.dataset.val));
    if (!c) return;
    askConfirm("Valider la clôture", `Valider la clôture de <b>${esc(c.user_nom)}</b> ?<br>Attendu : <b>${money(c.total_attendu)}</b><br>Compté : <b>${money(c.total_compte)}</b><br>Écart : <b>${Number(c.ecart) > 0 ? "+" : ""}${money(c.ecart)}</b>`, async () => {
      try { await api(`/caisse/${c.id}/valider`, { method: "PUT" }); toast("Clôture validée ✅"); renderers.point().catch(() => { }); } catch (e) { toast(e.message); }
    }, { okLabel: "Valider" });
  }));
  $$("#pointBox [data-rejet]").forEach(b => b.addEventListener("click", async () => {
    const c = caisses.find(x => String(x.id) === String(b.dataset.rejet));
    if (!c) return;
    askConfirm("Rejeter le point", `Rejeter le point de <b>${esc(c.user_nom)}</b> ?<br><span class="muted">La caissière pourra aller voir sa caisse du jour (Ma journée) pour vérifier. Ses nouvelles ventes s'y ajouteront.</span>`, async () => {
      try { await api(`/caisse/${c.id}/rouvrir`, { method: "PUT" }); toast("Point rejeté - la caissière peut vérifier dans Ma journée"); renderers.point().catch(() => { }); } catch (e) { toast(e.message); }
    }, { okLabel: "Rejeter le point", danger: true });
  }));
  /* --- Actions individuelles par caisse --- */
  $$("#pointBox [data-print-c]").forEach(b => b.addEventListener("click", async () => {
    const c = caisses.find(x => String(x.id) === String(b.dataset.printC));
    if (!c) return;
    let info = null;
    try { info = await api("/caisse/" + c.id); } catch (e) { toast(e.message); return; }
    const nT = (info.ventes || []).length;
    const h = c.fermee_le ? new Date(c.fermee_le).toLocaleString("fr-FR") : new Date(c.ouverte_le).toLocaleString("fr-FR");
    const o = new Date(c.ouverte_le).toLocaleString("fr-FR");
    const att = c.statut === "ouverte" ? c.attendu_especes : c.total_attendu || 0;
    let txt = "CLÔTURE DE CAISSE\n" + h + "\n";
    txt += "Caissiere : " + c.user_nom + "\n";
    txt += "Ouverte : " + o;
    if (c.fermee_le) txt += "\nFermee : " + h;
    txt += "\nFonds : " + money(c.fonds_initial);
    txt += "\nVentes : " + money(c.total) + " - " + nT + " tickets";
    txt += "\nEspieces attendues : " + money(att);
    if (c.total_compte != null) txt += "\nMontant compte : " + money(c.total_compte) + "\nEcart : " + (Number(c.ecart) > 0 ? "+" : "") + money(c.ecart);
    if (c.notes) txt += "\n" + c.notes;
    imprimer("Recu caisse - " + c.user_nom, `<pre style="font-family:'Courier New',monospace">` + txt.replace(/\n/g, "<br>") + `</pre>`, "80mm");
  }));
  $$("#pointBox [data-wa-c]").forEach(b => b.addEventListener("click", async () => {
    const c = caisses.find(x => String(x.id) === String(b.dataset.waC));
    if (!c) return;
    let info = null;
    try { info = await api("/caisse/" + c.id); } catch (e) { toast(e.message); return; }
    const nT = (info.ventes || []).length;
    const ecartStr = c.ecart != null ? (Number(c.ecart) > 0 ? "+" : "") + money(c.ecart) : "-";
    const txt = `_*Clôture de caisse*_\n` +
      `Caissière : ${esc(c.user_nom)}\n` +
      `Ouverte : ${new Date(c.ouverte_le).toLocaleString("fr-FR")}\n` +
      (c.fermee_le ? `Fermée : ${new Date(c.fermee_le).toLocaleString("fr-FR")}\n` : "") +
      `Fonds : ${money(c.fonds_initial)}\n` +
      `Ventes : ${money(c.total)} (${nT} tickets)\n` +
      `Espèces attendues : ${money(c.statut === "ouverte" ? c.attendu_especes : c.total_attendu || 0)}\n` +
      (c.total_compte != null ? `Compté : ${money(c.total_compte)}\nÉcart : ${ecartStr}\n` : "") +
      (c.notes ? `Notes : ${esc(c.notes)}\n` : "");
    window.open(`https://wa.me/?text=${encodeURIComponent(txt)}`, "_blank");
  }));
  $$("#pointBox [data-csv-c]").forEach(b => b.addEventListener("click", () => {
    const c = caisses.find(x => String(x.id) === String(b.dataset.csvC));
    if (!c) return;
    const lines = [["Caissière", "Ouverture", "Statut", "Ventes", "Espèces attendu", "Compté", "Écart"]];
    lines.push([c.user_nom, new Date(c.ouverte_le).toLocaleString("fr-FR"), c.statut, c.total, c.statut === "ouverte" ? c.attendu_especes : c.total_attendu || 0, c.total_compte != null ? c.total_compte : "", c.ecart != null ? c.ecart : ""]);
    downloadCsv("caisse-" + c.user_nom.replace(/\s+/g, "-") + "-" + pointFrom + ".csv", lines);
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
  try { users = await api("/users"); DB.users = users; } catch (e) { toast(e.message); return; }
  renderUsers();
};
function renderUsers() {
  const users = DB.users || [];
  const f = String($("#usersSearch") ? $("#usersSearch").value : "").toLowerCase().trim();
  const list = f ? users.filter(u => (u.nom || "").toLowerCase().indexOf(f) >= 0 || (roleLabel(u.role_code) || "").toLowerCase().indexOf(f) >= 0) : users;
  $("#usersWrap").innerHTML = `<div class="row wrap" style="margin-bottom:8px"><input id="usersSearch" class="grow" placeholder="🔎 Rechercher un membre du personnel…" value="${esc(f)}"></div>`
    + (list.length > 0 ? pgBar("users", list.length, "utilisateur(s)") : "") + `
    <div class="table-wrap"><table>
    <tr><th>Nom</th><th>Rôle</th><th>Droits</th><th>Statut</th><th>Dernière connexion</th><th>Actions</th></tr>
    ${list.map(u => `<tr>
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
  const sBtn = $("#usersSearch");
  if (sBtn) sBtn.addEventListener("input", () => renderUsers());
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
}

function userForm(u) {
  const isNew = !u;
  u = u || { nom: "", mdp: "", role_code: "caissier", droits: [], actif: true };
  const roles = DB.roles || [];
  openModal(`<h3>${isNew ? "Nouvel utilisateur" : "Modifier : " + esc(u.nom)}</h3>
    <label class="field">Nom d'utilisateur <input id="ufNom" data-fmt="name" value="${esc(u.nom || "")}"></label>
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
    <label class="field">Code PIN (verrouillage rapide)
      <input id="ufPin" inputmode="numeric" maxlength="6" value="" placeholder="${isNew ? "4 chiffres, ex. 1234" : (u.pin_set ? "défini — laisser vide pour conserver" : "non défini")}">
      <span class="hint" style="margin-top:4px">Facultatif — sert à déverrouiller la caisse d'un appui sur 🔒. ${!isNew && u.pin_set ? 'Cochez <label style="display:inline"><input type="checkbox" id="ufPinDel" style="width:auto"> supprimer le PIN</label>.' : ""}</span>
    </label>
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
    const pinVal = $("#ufPin").value.trim();
    const pinDel = $("#ufPinDel") && $("#ufPinDel").checked;
    /* PIN : envoyé seulement s'il est saisi (ou explicitement supprimé en édition) */
    const body = { nom, role_code: $("#ufRole").value, droits: (roleSel && roleSel.droits) || [], actif: $("#ufActif").checked };
    if (pinVal) body.pin_code = pinVal;
    else if (pinDel) body.pin_code = null;
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


/* ============================================================
   MODULE CLIENTS & FIDÉLITÉ
   ============================================================ */
renderers.clients = async function () {
  const box = $("#clientsBox");
  if (!box) return;
  box.innerHTML = '<div class="skeleton" style="height:120px;margin-bottom:8px"></div>';
  let list = [], totalCount = 0;
  try {
    const q = ($("#clientSearch") && $("#clientSearch").value) || "";
    const pg = pgGet("clients");
    let url = "/clients?page=" + pg.page + "&limit=" + pg.size;
    if (q) url += "&q=" + encodeURIComponent(q);
    const data = await api(url);
    if (Array.isArray(data)) { list = data; totalCount = data.length; }
    else { list = data.rows || []; totalCount = data.total || list.length; }
    DB.clients = list;
  } catch (e) { box.innerHTML = '<div class="empty">Erreur : ' + esc(e.message) + '</div>'; return; }

  if (!list.length) {
    box.innerHTML = '<div class="empty">Aucun client enregistré<br><br><button class="btn primary" id="emptyNewClientBtn" type="button">+ Créer un client</button></div>';
    const eb = $("#emptyNewClientBtn");
    if (eb) eb.addEventListener("click", () => clientForm(null));
    return;
  }

  box.innerHTML = '<p class="muted" style="margin:0 0 8px">' + totalCount + ' client(s) répertorié(s)</p>'
    + pgBar("clients", totalCount, "client(s)")
    + '<div class="table-wrap"><table>'
    + '<tr><th>Nom</th><th>Téléphone</th><th>Adresse</th><th class="num">Points fidélité</th><th class="num">Crédit en cours</th><th class="num">Plafond crédit</th><th>Statut</th><th>Actions</th></tr>'
    + list.map(function(c) {
      const solde = Number(c.solde_credit || 0);
      return '<tr>'
        + '<td><b>' + esc(c.nom) + '</b>' + (c.notes ? ' <span class="muted" title="' + esc(c.notes) + '">📝</span>' : '') + '</td>'
        + '<td>' + (c.tel ? '<a href="tel:' + esc(c.tel) + '">' + esc(c.tel) + '</a>' : '—') + '</td>'
        + '<td>' + esc(c.adresse || '—') + '</td>'
        + '<td class="num"><span class="badge" style="background:#fef3c7;color:#b45309;font-weight:700">⭐ ' + c.points + ' pts</span></td>'
        + '<td class="num">' + (solde > 0 ? '<span class="badge err">' + money(solde) + '</span>' : '<span class="badge ok">0 F</span>') + '</td>'
        + '<td class="num"><b>' + money(c.plafond_credit) + '</b></td>'
        + '<td>' + (c.actif ? '<span class="badge ok">Actif</span>' : '<span class="badge off">Inactif</span>') + '</td>'
        + '<td><div class="actions">'
        + '<button class="btn small" data-cl-hist="' + c.id + '">📜 Historique</button>'
        + '<button class="btn small" data-cl-edit="' + c.id + '">✏️ Modifier</button>'
        + '</div></td>'
        + '</tr>';
    }).join('') + '</table></div>';

  box.querySelectorAll("[data-cl-edit]").forEach(function(b) {
    b.addEventListener("click", function() {
      const cl = (DB.clients || []).find(c => String(c.id) === String(b.dataset.clEdit));
      if (cl) clientForm(cl);
    });
  });

  box.querySelectorAll("[data-cl-hist]").forEach(function(b) {
    b.addEventListener("click", function() {
      clientHistoryModal(b.dataset.clHist);
    });
  });
};

function clientForm(c) {
  const isNew = !c;
  c = c || { nom: "", tel: "", email: "", adresse: "", plafond_credit: 50000, notes: "", actif: true };
  openModal(`
    <h3>${isNew ? "➕ Nouveau client" : "✏️ Modifier : " + esc(c.nom)}</h3>
    <label class="field">Nom complet du client *
      <input id="clfNom" data-fmt="name" value="${esc(c.nom || "")}" placeholder="ex: Moussa Diallo">
    </label>
    <div class="row">
      <label class="field grow">Téléphone (WhatsApp)
        <input id="clfTel" data-fmt="phone" value="${esc(c.tel || "")}" placeholder="ex: 771234567" inputmode="tel">
      </label>
      <label class="field grow">Email
        <input id="clfEmail" value="${esc(c.email || "")}" placeholder="ex: client@email.com" inputmode="email">
      </label>
    </div>
    <label class="field">Adresse / Quartier
      <input id="clfAdresse" value="${esc(c.adresse || "")}" placeholder="ex: Dakar Plateau, Rue 12">
    </label>
    <label class="field">Plafond maximal de crédit autorisé (F)
      <input id="clfPlafond" type="text" data-fmt="money" inputmode="decimal" min="0" value="${c.plafond_credit || 50000}">
      <p class="muted" style="margin:2px 0 0;font-size:11px">Le système bloquera automatiquement toute vente à crédit si le cumul dépasse ce montant.</p>
    </label>
    <label class="field">Notes / Remarques
      <textarea id="clfNotes" rows="2" placeholder="Préférences, conventions particulières...">${esc(c.notes || "")}</textarea>
    </label>
    ${!isNew ? `<label class="field" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="clfActif" style="width:auto" ${c.actif ? "checked" : ""}> Client actif</label>` : ""}
    <div class="row" style="margin-top:14px">
      <button class="btn success grow" id="clfSave" type="button">💾 Enregistrer</button>
      <button class="btn ghost grow" onclick="closeModal()" type="button">Annuler</button>
    </div>
  `);

  $("#clfSave").addEventListener("click", async function() {
    const nom = $("#clfNom").value.trim();
    if (!nom) { toast("Le nom est obligatoire"); return; }
    const body = {
      nom,
      tel: $("#clfTel").value.trim(),
      email: $("#clfEmail").value.trim(),
      adresse: $("#clfAdresse").value.trim(),
      plafond_credit: numV($("#clfPlafond")) || 0,
      notes: $("#clfNotes").value.trim(),
      actif: $("#clfActif") ? $("#clfActif").checked : true
    };
    try {
      let created = null;
      if (isNew) {
        created = await api("/clients", { method: "POST", body: JSON.stringify(body) });
        toast("Client créé avec succès ✅");
      } else {
        await api("/clients/" + c.id, { method: "PUT", body: JSON.stringify(body) });
        toast("Fiche client mise à jour ✅");
      }
      closeModal();
      try { const clData2 = await api("/clients?limit=200"); DB.clients = Array.isArray(clData2) ? clData2 : (clData2.rows || []); } catch (e) {}
      if (curView === "clients") renderers.clients();
      if (curView === "vente") {
        renderCart();
        if (created && created.id) {
          const sel = $("#cartClientSel");
          if (sel) { sel.value = String(created.id); updateCartClientInfo(); }
        }
      }
    } catch (e) { toast(e.message); }
  });
}
window.clientForm = clientForm;

async function clientHistoryModal(cid) {
  openModal('<div class="skeleton" style="height:140px"></div>');
  try {
    const res = await api("/clients/" + cid + "/historique");
    const cl = res.client;
    const vts = res.ventes || [];
    const totalAchats = vts.reduce((s, v) => s + Number(v.net), 0);

    openModal(`
      <h3>👤 Fiche & Historique : ${esc(cl.nom)}</h3>
      <div class="cards" style="margin-bottom:12px">
        <div class="card"><div class="k">Points fidélité</div><div class="v" style="color:#ca8a04">⭐ ${cl.points} pts</div></div>
        <div class="card"><div class="k">Cumul achats</div><div class="v">${money(totalAchats)}</div></div>
        <div class="card"><div class="k">Plafond crédit</div><div class="v">${money(cl.plafond_credit)}</div></div>
      </div>
      <div class="table-wrap" style="max-height:300px;overflow-y:auto">
        <table>
          <tr><th>Date</th><th>Ticket</th><th>Articles</th><th class="num">Net</th><th>Mode</th></tr>
          ${vts.length === 0 ? '<tr><td colspan="5" class="empty">Aucun achat enregistré pour le moment</td></tr>' :
            vts.map(v => '<tr><td>' + fmtDate(v.date) + '</td><td><b>' + esc(v.numero) + '</b></td><td>' + ((v.items || []).map(i => esc(i.nom) + ' (x' + i.qte + ')').join(', ')) + '</td><td class="num"><b>' + money(v.net) + '</b></td><td>' + esc(modeLabel(v.mode) || v.mode) + '</td></tr>').join('')}
        </table>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="btn ghost grow" onclick="closeModal()">Fermer</button>
      </div>
    `);
  } catch (e) { toast(e.message); closeModal(); }
}

/* ============================================================
   MODULE DÉCONDITIONNEMENT GROS -> DÉTAIL
   ============================================================ */
function promptDeconditionner(childProd) {
  const parentId = childProd.parent_produit_id;
  const parent = produitById(parentId);
  if (!parent) { toast("Carton parent introuvable"); return; }
  const ratio = Number(childProd.qte_par_parent) || 1;

  openModal(`
    <h3>📦 Déconditionner : ${esc(parent.nom)} ➔ ${esc(childProd.nom)}</h3>
    <div style="background:rgba(14,116,144,.08);padding:10px;border-radius:8px;margin:8px 0;border:1px solid rgba(14,116,144,.3)">
      <p style="margin:0">📦 <b>1 ${esc(parent.unite || "carton")}</b> de « ${esc(parent.nom)} » contient <b>${ratio} ${esc(childProd.unite || "unités")}</b> de « ${esc(childProd.nom)} ».</p>
      <p style="margin:4px 0 0;font-size:12px" class="muted">Stock actuel : <b>${parent.stock} ${esc(parent.unite || "carton(s)")}</b> disponibles.</p>
    </div>
    <label class="field" style="margin-top:10px">Nombre de ${esc(parent.unite || "cartons")} à ouvrir / déconditionner *
      <input type="number" id="decondQte" min="1" max="${parent.stock}" value="1" inputmode="numeric">
    </label>
    <p id="decondPreview" style="font-weight:700;color:var(--primary);margin:4px 0 10px">Résultat : -${1} ${esc(parent.unite || "carton")} | +${ratio} ${esc(childProd.unite || "unités")}</p>
    <div class="row">
      <button class="btn primary grow" id="decondConfirmBtn">📦 Confirmer le déconditionnement</button>
      <button class="btn ghost grow" onclick="closeModal()">Annuler</button>
    </div>
  `);

  const inp = $("#decondQte");
  const prev = $("#decondPreview");
  inp.addEventListener("input", function() {
    const q = Number(inp.value) || 0;
    prev.textContent = "Résultat : -" + q + " " + (parent.unite || "carton(s)") + " | +" + (q * ratio) + " " + (childProd.unite || "unités");
  });

  $("#decondConfirmBtn").addEventListener("click", async function() {
    const q = Number(inp.value) || 0;
    if (q <= 0) { toast("Quantité invalide"); return; }
    try {
      const res = await api("/produits/" + childProd.id + "/deconditionner", { method: "POST", body: JSON.stringify({ qte_parent: q }) });
      closeModal();
      toast("Déconditionnement réussi : +" + res.ajout_child + " " + (childProd.unite || "unités") + " ajoutées ✅");
      renderers.stock().catch(() => {});
    } catch (e) { toast(e.message); }
  });
}

/* ============================================================
   VERROUILLAGE RAPIDE CODE PIN (CAISSIÈRES)
   ============================================================ */
function pinLockModal() {
  if (!cur || !cur.pin_set) { toast("Aucun code PIN configuré pour ce compte. Ajoutez-le dans Paramètres → Personnel."); return; }
  let pinVal = "";
  const box = $("#lockScreen");
  if (!box) { toast("Écran de verrouillage indisponible"); return; }
  box.innerHTML = `<div class="lock-box">
      <div style="font-size:42px">🔒</div>
      <h3 style="margin:4px 0">Caisse verrouillée</h3>
      <p class="muted" style="margin:2px 0 12px;font-size:13px">${esc(cur.nom)} — tapez votre code PIN à 4 chiffres</p>
      <div id="pinDisplay" class="pin-display">••••</div>
      <div class="pin-pad">
        <button class="pin-btn" data-n="1">1</button>
        <button class="pin-btn" data-n="2">2</button>
        <button class="pin-btn" data-n="3">3</button>
        <button class="pin-btn" data-n="4">4</button>
        <button class="pin-btn" data-n="5">5</button>
        <button class="pin-btn" data-n="6">6</button>
        <button class="pin-btn" data-n="7">7</button>
        <button class="pin-btn" data-n="8">8</button>
        <button class="pin-btn" data-n="9">9</button>
        <button class="pin-btn" data-n="C" style="color:var(--danger)">⌫</button>
        <button class="pin-btn" data-n="0">0</button>
        <button class="pin-btn" data-n="OK" style="color:var(--success);font-size:16px">✓</button>
      </div>
      <button class="btn ghost small" id="lockLogoutBtn" style="margin-top:12px">↪️ Se déconnecter</button>
    </div>`;
  box.classList.remove("hidden");
  sessionStorage.setItem("gs_locked", "1");
  const disp = $("#pinDisplay");
  const updateDisp = () => { disp.textContent = pinVal ? "•".repeat(pinVal.length).padEnd(4, "–") : "••••"; };
  const unlock = async () => {
    if (pinVal.length < 4) { toast("Code PIN à 4 chiffres requis"); return; }
    try {
      const res = await api("/auth/pin-login", { method: "POST", body: JSON.stringify({ pin: pinVal, user_id: cur.id }) });
      token = res.token;
      localStorage.setItem("gs_token", token);
      cur = res.user;
      box.classList.add("hidden");
      sessionStorage.removeItem("gs_locked");
      toast("Caisse déverrouillée : " + cur.nom + " ✅");
      await showApp();
    } catch (e) {
      pinVal = ""; updateDisp();
      disp.classList.add("shake");
      setTimeout(() => disp.classList.remove("shake"), 400);
      toast(e.message || "Code PIN incorrect");
    }
  };
  const onKey = e => {
    if (box.classList.contains("hidden")) { document.removeEventListener("keydown", onKey, true); return; }
    e.stopPropagation();
    if (e.key >= "0" && e.key <= "9") {
      e.preventDefault();
      if (pinVal.length < 4) { pinVal += e.key; updateDisp(); if (pinVal.length === 4) unlock(); }
    } else if (e.key === "Backspace") { e.preventDefault(); pinVal = pinVal.slice(0, -1); updateDisp(); }
    else if (e.key === "Enter") { e.preventDefault(); unlock(); }
    else if (e.key === "Escape") { e.preventDefault(); }
  };
  document.addEventListener("keydown", onKey, true);
  box.querySelectorAll(".pin-btn").forEach(b => {
    b.addEventListener("click", () => {
      const n = b.dataset.n;
      if (n === "C") { pinVal = pinVal.slice(0, -1); updateDisp(); }
      else if (n === "OK") { unlock(); }
      else if (pinVal.length < 4) { pinVal += n; updateDisp(); if (pinVal.length === 4) unlock(); }
    });
  });
  const lo = $("#lockLogoutBtn");
  if (lo) lo.addEventListener("click", () => { box.classList.add("hidden"); doLogout(); });
}

/* ---------- STOCK DORMANT ---------- */
let dormantJours = 30;
renderers.dormant = async function (box) {
  box = box || $("#dormantBox") || $("#stockWrap");
  if (!box) return;
  try {
    const rows = await api("/stock/dormant?jours=" + dormantJours);
    const totalVal = rows.reduce((s, r) => s + Number(r.valeur_immobilisee), 0);
    box.innerHTML = rows.length === 0
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
    var sel = $("#dormantSel"); if (sel) { sel.value = String(dormantJours); sel.addEventListener("change", function(e) { dormantJours = Number(e.target.value); renderers.dormant(box).catch(function(){}); }); }
    var csvBtn = $("#dormantCsv"); if (csvBtn) csvBtn.addEventListener("click", function() {
      var lines = [["Produit","Famille","Stock","Valeur","Jours sans vente","Derniere vente"]].concat(rows.map(function(r) { return [r.nom, r.famille_nom||"", r.stock, r.valeur_immobilisee, r.jours_sans_vente, r.derniere_vente||"Jamais"]; }));
      downloadCsv("stock-dormant.csv", lines);
    });
  } catch (e) { toast(e.message); }
};

/* ---------- DEPENSES ---------- */
function downloadCSV(filename, rows) {
  const csv = rows.map(function(r) { return r.map(function(c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(";"); }).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}
renderers.depenses = async function () {
  var pg = pgGet("depenses");
  var searchVal = $("#depSearch") ? $("#depSearch").value : "";
  try {
    var data = await api(`/depenses?page=${pg.page}&limit=${pg.size}&all=1` + (searchVal ? `&search=${encodeURIComponent(searchVal)}` : ""));
    if (Array.isArray(data)) { DB.depenses = data; DB.depensesTotal = data.length; }
    else { DB.depenses = data.rows || []; DB.depensesTotal = data.total || DB.depenses.length; }
  } catch (e) { toast(e.message); return; }
  renderDepenses();
};
function renderDepenses() {
  var rows = DB.depenses || [];
  var catsFull = ["Loyer","Electricite","Eau","Transport","Salaires","Courses boutique","Materiel","Maintenance","Communication","Autre"];
  var f = String($("#depSearch") ? $("#depSearch").value : "").toLowerCase().trim();
  var actives = rows.filter(function(r) { return !r.annule; });
  var annulees = rows.filter(function(r) { return r.annule; });
  var filtered = f ? actives.filter(function(r) {
    return (r.motif || "").toLowerCase().indexOf(f) >= 0 || (r.categorie || "").toLowerCase().indexOf(f) >= 0
      || (r.mode || "").toLowerCase().indexOf(f) >= 0 || (r.user_nom || "").toLowerCase().indexOf(f) >= 0;
  }) : actives;
  var total = filtered.reduce(function(s, r) { return s + Number(r.montant); }, 0);
  var byCat = {};
  actives.forEach(function(r) { byCat[r.categorie] = (byCat[r.categorie] || 0) + Number(r.montant); });
  var catsHTML = Object.keys(byCat).sort(function(a, b) { return byCat[b] - byCat[a]; }).map(function(c) { return '<span class="badge info">' + esc(c) + ' : ' + money(byCat[c]) + '</span>'; }).join(" ");
  var annuleesHTML = annulees.length === 0 ? '<div class="empty">Aucune dépense annulée</div>'
    : '<div class="table-wrap"><table><tr><th>Date</th><th>Catégorie</th><th>Motif</th><th class="num">Montant</th><th>Annulé par</th><th>Motif annulation</th><th>Le</th></tr>'
      + annulees.map(function(r) { return '<tr style="opacity:0.6;text-decoration:line-through"><td>' + fmtDate(r.date) + '</td><td><span class="badge off">' + esc(r.categorie) + '</span></td>'
        + '<td>' + esc(r.motif || '') + '</td><td class="num">' + money(r.montant) + '</td>'
        + '<td>' + esc(r.annule_par || '') + '</td><td><i>' + esc(r.annule_motif || '') + '</i></td>'
        + '<td>' + (r.annule_le ? fmtDate(r.annule_le) : '') + '</td></tr>'; }).join('')
      + '</table></div>';

  $("#depensesBox").innerHTML = '<div class="row wrap" style="margin-bottom:10px"><h2 class="grow" style="margin:0">Dépenses</h2>'
    + '<button class="btn small" id="depExport" title="Exporter en CSV">⬇️ CSV</button>'
    + '<button class="btn primary" id="depAdd">+ Nouvelle dépense</button></div>'
    + '<input id="depSearch" class="grow" placeholder="🔎 Rechercher (motif, catégorie, mode…)" value="' + esc(f) + '" style="margin-bottom:8px">'
    + (actives.length === 0 ? '<div class="empty">Aucune dépense enregistrée</div>'
    : '<div class="row wrap" style="margin-bottom:6px;gap:4px">' + catsHTML + '</div>'
    + '<p class="muted" style="margin:0 0 8px">Total' + (f ? ' (filtré)' : '') + ' : <b>' + money(total) + '</b> — ' + (DB.depensesTotal || filtered.length) + ' dépense(s)</p>'
    + pgBar('depenses', DB.depensesTotal || filtered.length, 'dépense(s)')
    + '<div class="table-wrap"><table><tr><th>Date</th><th>Catégorie</th><th>Motif</th><th>Mode</th><th class="num">Montant</th><th>Par</th><th></th></tr>'
    + filtered.map(function(r) { return '<tr><td>' + fmtDate(r.date) + '</td><td><span class="badge info">' + esc(r.categorie) + '</span></td>'
      + '<td>' + esc(r.motif || '') + '</td><td>' + esc(r.mode || '') + '</td>'
      + '<td class="num"><b>' + money(r.montant) + '</b></td><td>' + esc(r.user_nom || '') + '</td>'
      + '<td><button class="btn small ghost" data-deldep="' + r.id + '" title="Annuler cette dépense">🚫 Annuler</button></td></tr>'; }).join('')
    + '</table></div>')
    + (annulees.length > 0 ? '<details style="margin-top:16px"><summary style="cursor:pointer;color:var(--muted);font-size:13px">🗑️ Dépenses annulées (' + annulees.length + ')</summary>' + annuleesHTML + '</details>' : '');

  var addBtn = $("#depAdd");
  if (addBtn) addBtn.addEventListener("click", function() {
    openModal('<h3>Nouvelle dépense</h3>'
      + '<label class="field">Montant (F) <input id="depMontant" type="text" data-fmt="money" inputmode="decimal" min="1" placeholder="ex. 5000"></label>'
      + '<label class="field">Catégorie <select id="depCat">' + catsFull.map(function(c) { return '<option>' + c + '</option>'; }).join('') + '</select></label>'
      + '<label class="field">Motif <input id="depMotif" placeholder="ex. Facture électricité juillet"></label>'
      + '<label class="field">Mode de paiement <select id="depMode"><option value="especes">Espèces</option><option value="mobile">Mobile money</option><option value="carte">Carte</option></select></label>'
      + '<label class="field">Date <input id="depDate" type="date" value="' + todayKey() + '"></label>'
      + '<div class="row"><button class="btn success grow" id="depSave">Enregistrer</button><button class="btn ghost grow" onclick="closeModal()">Annuler</button></div>');
    $("#depSave").addEventListener("click", async function() {
      var montant = numV($("#depMontant")) || 0;
      if (montant <= 0) { toast("Montant invalide"); return; }
      try {
        await api("/depenses", { method: "POST", body: JSON.stringify({
          montant: montant, categorie: $("#depCat").value, motif: $("#depMotif").value.trim(),
          mode: $("#depMode").value, date: $("#depDate").value
        })});
        toast("Dépense enregistrée"); closeModal(); renderers.depenses().catch(function(){});
      } catch (e) { toast(e.message); }
    });
  });
  var sBtn = $("#depSearch");
  if (sBtn) sBtn.addEventListener("input", debounce(function() { pgReset("depenses"); renderers.depenses().catch(()=>{}); }, 350));
  var eBtn = $("#depExport");
  if (eBtn) eBtn.addEventListener("click", function() {
    downloadCSV("depenses.csv", [["Date","Catégorie","Motif","Mode","Montant","Par"]].concat(filtered.map(function(r) {
      return [fmtDate(r.date), r.categorie, r.motif || "", r.mode || "", String(r.montant), r.user_nom || ""];
    })));
  });
  document.querySelectorAll("#depensesBox [data-deldep]").forEach(function(b) { b.addEventListener("click", function() {
    askPrompt("Motif d'annulation", "Pourquoi annulez-vous cette dépense ?", async function(motif) {
      if (!motif || !motif.trim()) { toast("Motif obligatoire pour l'annulation"); return; }
      try {
        await api("/depenses/" + b.dataset.deldep, { method: "DELETE", body: JSON.stringify({ motif: motif.trim() }) });
        toast("Dépense annulée — trace conservée ✅");
        renderers.depenses().catch(function(){});
      } catch (e) { toast(e.message); }
    });
  }); });
}

/* ---------- ANALYSE ABC ---------- */
renderers.abc = async function (box) {
  box = box || $("#abcBox");
  if (!box) return;
  var from = todayKey(), to = todayKey();
  var exFrom = box.querySelector("#abcFrom");
  if (exFrom) { from = exFrom.value; to = box.querySelector("#abcTo").value; }
  else {
    box.innerHTML = `
      <div class="row wrap" style="margin-bottom:10px">
        <label class="field">Du <input id="abcFrom" type="date" value="${from}"></label>
        <label class="field">Au <input id="abcTo" type="date" value="${to}"></label>
        <button class="btn primary" id="abcGen">Générer</button>
      </div>
      <div class="chips" style="margin-top:6px">
        <button class="chip-btn" data-abc="today">Aujourd'hui</button>
        <button class="chip-btn" data-abc="7j">7 jours</button>
        <button class="chip-btn" data-abc="month">Ce mois</button>
      </div>
      <div id="abcResult"></div>`;
    box.querySelector("#abcGen").addEventListener("click", () => renderers.abc(box).catch(e => toast(e.message)));
    box.querySelectorAll("[data-abc]").forEach(b => b.addEventListener("click", () => {
      const k = b.dataset.abc, d = new Date();
      box.querySelector("#abcTo").value = todayKey();
      if (k === "today") box.querySelector("#abcFrom").value = todayKey();
      else if (k === "7j") { d.setDate(d.getDate() - 6); box.querySelector("#abcFrom").value = todayKey(d); }
      else if (k === "month") { d.setDate(1); box.querySelector("#abcFrom").value = todayKey(d); }
      renderers.abc(box).catch(e => toast(e.message));
    }));
  }
  var resBox = box.querySelector("#abcResult");
  if (resBox) resBox.innerHTML = '<div class="empty">⏳ Chargement…</div>';
  try {
    var r = await api("/rapports/abc?from=" + from + "&to=" + to);
    var rows = r.rows || [];
    var classA = rows.filter(function(x) { return x.classe === "A"; });
    var classB = rows.filter(function(x) { return x.classe === "B"; });
    var classC = rows.filter(function(x) { return x.classe === "C"; });
    var html = '<div class="cards" style="margin-bottom:14px">'
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
    if (resBox) resBox.innerHTML = html;
  } catch (e) { if (resBox) resBox.innerHTML = '<div class="empty">' + esc(e.message) + '</div>'; }
};

/* ---------- rapports ---------- */
renderers.rapports = async function () {
  if (!$("#rapFrom").value) { $("#rapFrom").value = todayKey(); $("#rapTo").value = todayKey(); }
  document.querySelectorAll("#view-rapports [data-rtab]").forEach(x => x.classList.toggle("on", x.dataset.rtab === "benefices"));
  const ben = $("#rapBenPane"), abc = $("#rapAbcPane");
  if (ben) ben.classList.remove("hidden");
  if (abc) abc.classList.add("hidden");
  genRapport().catch(e => toast(e.message));
};
async function genRapport() {
  const from = $("#rapFrom").value, to = $("#rapTo").value;
  const group = $("#rapGroup").value;
  const r = await api(`/rapports?from=${from}&to=${to}&groupe=${group}`);
  const rows = r.groups || [];
  const tot = r.tot || { qte: 0, ca: 0, ben: 0, depenses: 0, ben_net: 0 };
  const benNet = tot.ben_net != null ? tot.ben_net : tot.ben - (tot.depenses || 0);
  const rentabilite = Number(tot.ca) > 0 ? Math.round(Number(benNet) / Number(tot.ca) * 100) : 0;
  $("#rapportBox").innerHTML = `
    <div class="cards">
      <div class="card"><div class="k">Chiffre d'affaires</div><div class="v">${money(tot.ca)}</div></div>
      <div class="card"><div class="k">Marge brute</div><div class="v">${money(tot.ben)}</div></div>
      <div class="card"><div class="k">Dépenses période</div><div class="v" style="color:var(--amber)">${money(tot.depenses || 0)}</div></div>
      <div class="card"><div class="k">Bénéfice net réel</div><div class="v ${benNet >= 0 ? "ok" : "ko"}">${money(benNet)}</div></div>
      <div class="card"><div class="k">Rentabilité nette</div><div class="v">${rentabilite} %</div></div>
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
    (top.length === 0 ? `<div class="empty">-</div>` : `<div class="table-wrap"><table><tr><th>${group === "article" ? "Article" : "Groupe"}</th><th class="num">Bénéfice</th></tr>` + top.map(x => `<tr><td>${esc(x.key)}</td><td class="num">${money(x.ben)}</td></tr>`).join("") + `</table></div>`));
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
      <button class="tab" data-ptab="backups">💾 Sauvegardes</button>
    </div>
    <div id="ptPaneId">
      <div class="panel" style="margin-bottom:10px">
        <h3>🏪 Identité de la boutique (apparaît sur les tickets et documents)</h3>
        <div class="row"><label class="field grow">Nom de la boutique <input id="bpNom" data-fmt="name" value="${esc(b.nom || "")}"></label>
          <label class="field grow">Devise <input id="bpDevise" value="${esc(b.devise || "FCFA")}"></label></div>
        <div class="row"><label class="field grow">Téléphone <input id="bpTel" data-fmt="phone" value="${esc(b.tel || "")}"></label>
          <label class="field grow">E-mail <input id="bpEmail" value="${esc(b.email || "")}"></label></div>
        <div class="row"><label class="field grow">Adresse <input id="bpAdresse" value="${esc(b.adresse || "")}"></label>
          <label class="field grow">Horaires <input id="bpHoraires" value="${esc(b.horaires || "")}"></label></div>
        <label class="field">Pied de page des documents <input id="bpPied" value="${esc(b.pied || "")}"></label>
        <label class="field">Règle du point du soir (affichée sur la page Clôture de caisse) <input id="bpRegle" value="${esc(b.point_regle || "")}"></label>
        <label class="field">Logo <input id="bpLogo" type="file" accept="image/*"></label>
        <div id="bpLogoPrev">${b.logo ? `<img src="${b.logo}" class="mini-logo">` : ""}</div>
        <div class="row"><button class="btn primary grow" id="bpSave">💾 Enregistrer</button></div>
        <label class="field">Remise maximale autorisée à la caisse (%) - 0 = aucune remise
          <input id="bpRemiseMax" type="number" data-fmt="money" inputmode="decimal" min="0" max="100" value="${getParam("remise_max_pct") ?? 100}">
          <span class="muted" style="font-size:12px">Partagé sur tous les appareils ; la limite est aussi vérifiée côté serveur.</span></label>
      </div>
    </div>
    <div id="ptPaneModes" style="display:none">
      <div class="panel">
        <div class="row" style="align-items:center;margin-bottom:6px"><h3 class="grow" style="margin:0">💳 Modes de paiement</h3><button class="btn small primary" id="newModeBtn">+ Nouveau mode de paiement</button></div>
        <p class="muted">Créez vos propres modes (Wave, Orange Money, Chèque, Crédit...). « Espèces » = l'argent compté dans le tiroir.</p>
        <div id="modesBox"></div>
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
    <div id="ptPaneBackups" style="display:none">
      <div class="panel">
        <div class="row" style="align-items:center;margin-bottom:6px">
          <h3 class="grow" style="margin:0">💾 Sauvegardes automatiques</h3>
          <button class="btn small primary" id="backupCreateBtn">📦 Créer un backup maintenant</button>
          <button class="btn small" id="backupImportBtn">📥 Importer un backup</button>
          <input type="file" id="backupImportFile" accept=".json" style="display:none">
        </div>
        <p class="muted">Un backup est créé automatiquement à chaque démarrage du serveur. Vous pouvez aussi en créer un manuellement. Les 5 derniers backups sont conservés.</p>
        <div id="backupListBox"></div>
      </div>
    </div>
    <p class="muted">💾 Les données sont stockées dans PostgreSQL - synchronisées entre tous les appareils en temps réel.</p>`;
  const ptTabs = { id: $("#ptPaneId"), modes: $("#ptPaneModes"), ticket: $("#ptPaneTicket"), backups: $("#ptPaneBackups") };
  $$("#paramsBox [data-ptab]").forEach(btn => btn.addEventListener("click", () => {
    $$("#paramsBox [data-ptab]").forEach(x => x.classList.toggle("on", x === btn));
    Object.entries(ptTabs).forEach(([k, pane]) => { pane.style.display = k === btn.dataset.ptab ? "" : "none"; });
  }));
  /* --- Sauvegardes --- */
  async function loadBackups() {
    try {
      const backups = await api("/backups");
      if (!backups.length) {
        $("#backupListBox").innerHTML = `<p class="muted">Aucune sauvegarde disponible.</p>`;
        return;
      }
      $("#backupListBox").innerHTML = `<div class="table-wrap"><table>
        <tr><th>Date</th><th>Taille</th><th>Actions</th></tr>
        ${backups.map(b => {
          const d = new Date(b.date);
          const dateStr = d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR');
          const sizeStr = b.size > 1024*1024 ? (b.size/1024/1024).toFixed(1)+' Mo' : (b.size/1024).toFixed(1)+' Ko';
          return `<tr>
            <td>${esc(dateStr)}</td>
            <td>${sizeStr}</td>
            <td>
              <button class="btn small" data-dl="${esc(b.name)}">📥</button>
              <button class="btn small success" data-restore="${esc(b.name)}">🔄</button>
            </td>
          </tr>`;
        }).join('')}
      </table></div>`;
      $$('#backupListBox [data-restore]').forEach(btn => btn.addEventListener('click', async () => {
        const name = btn.dataset.restore;
        askConfirm(
          'Restaurer ce backup ?',
          `⚠️ Ceci <b>VIDERA</b> les tables existantes et les remplacera par les données du backup <b>${esc(name)}</b>. Cette action est <b>IRRÉVERSIBLE</b>.`,
          async () => {
            try {
              toast('⏳ Restauration en cours...');
              const r = await api('/backups/' + encodeURIComponent(name) + '/restore', { method: 'POST' });
              toast('✅ Restauration terminée ! ' + (r.log || []).length + ' tables traitées');
            } catch (err) { toast('❌ Erreur restauration: ' + err.message); }
          },
          { danger: true, okLabel: 'Restaurer' }
        );
      }));
      $$('#backupListBox [data-dl]').forEach(btn => btn.addEventListener('click', async () => {
        try {
          const resp = await fetch(API_BASE + '/backups/' + encodeURIComponent(btn.dataset.dl) + '/download', {
            headers: { 'Authorization': 'Bearer ' + token }
          });
          if (!resp.ok) throw new Error('Erreur ' + resp.status);
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = btn.dataset.dl;
          document.body.appendChild(a); a.click(); a.remove();
          URL.revokeObjectURL(url);
        } catch (e) { toast('❌ Erreur téléchargement: ' + e.message); }
      }));
    } catch (e) {
      $("#backupListBox").innerHTML = `<p class="muted">Erreur de chargement des sauvegardes.</p>`;
    }
  }
  $("#backupCreateBtn").addEventListener("click", async () => {
    try {
      toast('📦 Création du backup en cours...');
      await api("/backups/create", { method: 'POST' });
      toast('✅ Backup créé avec succès');
      loadBackups();
    } catch (e) {
      toast('❌ Erreur: ' + e.message);
    }
  });
  loadBackups();
  /* Import backup */
  $("#backupImportBtn").addEventListener("click", () => $("#backupImportFile").click());
  $("#backupImportFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      if (!backup.tables) { toast('❌ Fichier de backup invalide'); return; }
      const total = Object.values(backup.tables).reduce((s, t) => s + (Array.isArray(t) ? t.length : 0), 0);
      askConfirm(
        'Restaurer ce backup ?',
        `⚠️ Ceci <b>VIDERA</b> les tables existantes et les remplacera par les données du backup (${Object.keys(backup.tables).length} tables, ${total} lignes). Cette action est <b>IRRÉVERSIBLE</b>.`,
        async () => {
          try {
            toast('⏳ Restauration en cours...');
            const r = await api('/backups/restore', { method: 'POST', body: JSON.stringify({ backup }) });
            toast('✅ Restauration terminée ! ' + (r.log || []).length + ' tables traitées');
            loadBackups();
          } catch (err) { toast('❌ Erreur restauration: ' + err.message); }
        },
        { danger: true, okLabel: 'Restaurer' }
      );
    } catch (err) { toast('❌ Fichier JSON invalide: ' + err.message); }
    e.target.value = '';
  });
  /* --- Fin Sauvegardes --- */
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
    askConfirm(m.actif ? "Désactiver le mode" : "Activer le mode", `${m.actif ? "Désactiver" : "Activer"} le mode <b>« ${esc(m.nom)} »</b> ?`, async () => {
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
  if (typeof JsBarcode === "undefined" || !code) {
    if (code) ensureScript("/js/JsBarcode.min.js?v=16").catch(() => { }); /* dispo au prochain affichage */
    return "";
  }
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
function openModal(html) {
  $("#modalCard").innerHTML = html;
  $("#modal").classList.remove("hidden");
  const f = $("#modalCard").querySelector("input, select, textarea");
  if (f) { try { f.focus(); } catch (e) {} }
}
let venteAfterClose = false;
function closeModal() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  if (scanQr) { try { scanQr.stop().then(() => {}).catch(() => {}); } catch (e) { } scanQr = null; }
  $("#modal").classList.add("hidden");
  if (venteAfterClose) { venteAfterClose = false; if (curView === "vente") { const vs = $("#venteSearch"); if (vs) { vs.focus(); vs.select(); } } }
}
let toastTimer = null;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}
/* ---------- fonctions globales utilisées par les attributs onclick inline ----------
   Le fichier est en "use strict" : selon le contexte d'exécution (service worker,
   cache ancien, moteur), les déclarations de fonctions ne sont pas toujours
   visibles depuis les gestionnaires inline HTML, qui cherchent sur window.
   Sans cette exposition, les 28 boutons « Annuler/Fermer » des modales meurent
   silencieusement (rien dans la console). */
window.closeModal = closeModal;
window.closeScan = closeScan;
window.go = go;
window.roleManager = roleManager;
/* Fonctions de modales appelées par d'autres modules / tests */
window.openModal = openModal;
window.clotureForm = clotureForm;
let confirmCb = null;
function askConfirm(titre, message, onOk, opts) {
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
  let done = false;
  const finish = ok => {
    if (done) return; done = true;
    document.removeEventListener("keydown", cfKey);
    closeModal(); const cb = confirmCb; confirmCb = null;
    if (ok && cb) cb();
  };
  function cfKey(e) {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); finish(false); }
  }
  $("#cfNo").addEventListener("click", () => finish(false));
  $("#cfOk").addEventListener("click", () => finish(true));
  document.addEventListener("keydown", cfKey);
}function askPrompt(titre, valeurDefaut, onOk) {
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
    let done = false;
  const fin = ok => { if (done) return; done = true; closeModal(); if (ok && onOk) onOk(inp.value); };
  $("#apNo").addEventListener("click", () => fin(false));
  $("#apOk").addEventListener("click", () => fin(true));
  inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); fin(true); } });
  inp.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); fin(false); } });
}

/* ---------- événements ---------- */

/* ---------- NOTIFICATIONS VALIDATIONS (VERSEMENTS & ANNULATIONS) ---------- */
let notifCount = 0;
async function checkNotifValidations() {
  try {
    const [vRes, aRes] = await Promise.all([
      api("/versements/en-attente").catch(() => ({ rows: [] })),
      api("/annulations/en-attente").catch(() => ({ rows: [] }))
    ]);
    const vRows = (vRes.rows || []).length;
    const aRows = (aRes.rows || []).length;
    notifCount = vRows + aRows;

    const badge = document.getElementById("notifBadge");
    if (badge) { badge.textContent = notifCount; badge.classList.toggle("hidden", notifCount === 0); }

    const vb = document.getElementById("vBadgeAttente");
    if (vb) { vb.textContent = vRows; vb.classList.toggle("hidden", vRows === 0); }

    const ab = document.getElementById("vBadgeAnnul");
    if (ab) { ab.textContent = aRows; ab.classList.toggle("hidden", aRows === 0); }
  } catch (e) { /* silent */ }
}
const checkNotifVersements = checkNotifValidations;

function renderVersementsAttente() {
  api("/versements/en-attente").then(r => {
    const box = document.getElementById("versementBox");
    if (!box) return;
    const rows = r.rows || [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty">Aucune demande de versement en attente</div>';
      return;
    }
    box.innerHTML = '<p class="muted" style="margin:0 0 8px">' + rows.length + ' demande(s) de versement en attente</p>'
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
        try { await api("/versements/" + b.dataset.vval + "/valider", { method: "POST" }); toast("Versement validé ✅"); checkNotifValidations(); renderVersementsAttente(); }
        catch (e) { toast(e.message); }
      });
    });
    document.querySelectorAll("[data-vref]").forEach(function(b) {
      b.addEventListener("click", function() {
        askPrompt("Refuser le versement", "", async function(motif) {
          if (!motif || !motif.trim()) { toast("Motif obligatoire"); return; }
          try { await api("/versements/" + b.dataset.vref + "/refuser", { method: "POST", body: JSON.stringify({ motif: motif.trim() }) }); toast("Versement refusé"); checkNotifValidations(); renderVersementsAttente(); }
          catch (e) { toast(e.message); }
        });
      });
    });
  }).catch(function(e) { toast(e.message); });
}

function renderAnnulationsAttente() {
  api("/annulations/en-attente").then(r => {
    const box = document.getElementById("annulationsBox");
    if (!box) return;
    const rows = r.rows || [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty">Aucune demande d\'annulation de vente en attente</div>';
      return;
    }
    box.innerHTML = '<p class="muted" style="margin:0 0 8px">' + rows.length + ' demande(s) d\'annulation de vente en attente</p>'
      + '<div class="table-wrap"><table><tr><th>Ticket</th><th>Caissière</th><th class="num">Montant</th><th>Motif d\'annulation</th><th>Demandé le</th><th>Actions</th></tr>'
      + rows.map(function(a) {
        return '<tr>'
          + '<td><b>' + esc(a.vente_numero) + '</b></td>'
          + '<td>' + esc(a.user_nom) + '</td>'
          + '<td class="num"><b>' + money(a.vente_net) + '</b></td>'
          + '<td><span style="color:var(--danger);font-weight:600">' + esc(a.motif) + '</span></td>'
          + '<td>' + fmtDate(a.date_demande) + '</td>'
          + '<td><div class="actions">'
          + (r.canValidate
              ? '<button class="btn small success" data-aval="' + a.id + '" data-num="' + esc(a.vente_numero) + '">✓ Accepter</button>'
                + '<button class="btn small danger" data-aref="' + a.id + '" data-num="' + esc(a.vente_numero) + '">✗ Refuser</button>'
              : '<span class="muted" style="font-size:12px">Réservé à ' + esc(r.validateur) + '</span>')
          + '</div></td></tr>';
      }).join('') + '</table></div>';

    document.querySelectorAll("[data-aval]").forEach(function(b) {
      b.addEventListener("click", function() {
        const num = b.dataset.num;
        askConfirm("Confirmer l'annulation", `Voulez-vous accepter l'annulation du ticket <b>${esc(num)}</b> ?<br><span class="muted">La vente sera supprimée et les articles réintégrés en stock.</span>`, async function() {
          try {
            await api("/annulations/" + b.dataset.aval + "/valider", { method: "POST" });
            toast("Annulation validée — Vente supprimée & stock restauré ↩️");
            checkNotifValidations();
            renderAnnulationsAttente();
          } catch (e) { toast(e.message); }
        }, { danger: true, okLabel: "Valider l'annulation" });
      });
    });

    document.querySelectorAll("[data-aref]").forEach(function(b) {
      b.addEventListener("click", function() {
        const num = b.dataset.num;
        askPrompt("Motif de refus pour l'annulation de " + num, "Demande non justifiée", async function(motif) {
          if (!motif || !motif.trim()) { toast("Motif de refus obligatoire"); return; }
          try {
            await api("/annulations/" + b.dataset.aref + "/refuser", { method: "POST", body: JSON.stringify({ motif: motif.trim() }) });
            toast("Demande d'annulation refusée");
            checkNotifValidations();
            renderAnnulationsAttente();
          } catch (e) { toast(e.message); }
        });
      });
    });
  }).catch(function(e) { toast(e.message); });
}

function renderAnnulationsHist() {
  api("/annulations").then(function(r) {
    const box = document.getElementById("annulationsHistBox");
    if (!box) return;
    const rows = r.rows || [];
    if (!rows.length) {
      box.innerHTML = '<div class="empty">Aucun historique de demande d\'annulation</div>';
      return;
    }
    box.innerHTML = '<p class="muted" style="margin:0 0 8px">' + rows.length + ' demande(s) au total</p>'
      + '<div class="table-wrap"><table><tr><th>Ticket</th><th>Statut</th><th>Caissière</th><th class="num">Montant</th><th>Motif</th><th>Demandé le</th><th>Traité par</th><th>Détail / Motif refus</th></tr>'
      + rows.map(function(a) {
        const badge = a.statut === "validee"
          ? '<span class="badge ok">✓ Acceptée</span>'
          : a.statut === "refusee"
          ? '<span class="badge err">✗ Refusée</span>'
          : '<span class="badge" style="background:#eab308;color:#000">⏳ En attente</span>';
        return '<tr>'
          + '<td><b>' + esc(a.vente_numero) + '</b></td>'
          + '<td>' + badge + '</td>'
          + '<td>' + esc(a.user_nom) + '</td>'
          + '<td class="num"><b>' + money(a.vente_net) + '</b></td>'
          + '<td>' + esc(a.motif) + '</td>'
          + '<td>' + fmtDate(a.date_demande) + '</td>'
          + '<td>' + esc(a.valide_par_nom || "—") + '</td>'
          + '<td>' + (a.motif_refus ? '<span style="color:var(--danger)">Refus: ' + esc(a.motif_refus) + '</span>' : '—') + '</td>'
          + '</tr>';
      }).join('') + '</table></div>';
  }).catch(function(e) { toast(e.message); });
}

function renderVersementsTraites(statut, boxId) {
  api("/versements").then(function(r) {
    const box = document.getElementById(boxId);
    if (!box) return;
    const rows = (r.rows || []).filter(function(v) { return v.statut === statut; });
    const estValide = statut === "valide";
    if (!rows.length) {
      box.innerHTML = '<div class="empty">Aucun versement ' + (estValide ? "accepté" : "refusé") + '</div>';
      return;
    }
    box.innerHTML = '<p class="muted" style="margin:0 0 8px">' + rows.length + ' versement(s) ' + (estValide ? "accepté(s)" : "refusé(s)") + '</p>'
      + '<div class="table-wrap"><table><tr><th>Caissière</th><th class="num">Montant</th><th>Mode</th><th>Motif</th><th>Date</th>'
      + (estValide ? '' : '<th>Motif de refus</th>') + '<th>Par</th></tr>'
      + rows.map(function(v) {
        return '<tr><td>' + esc(v.caissiere_nom) + '</td><td class="num"><b>' + money(v.montant) + '</b></td>'
          + '<td>' + esc(v.mode) + '</td><td>' + esc(v.motif || '') + '</td>'
          + '<td>' + fmtDate(v.date) + '</td>'
          + (estValide ? '' : '<td>' + esc(v.motif_refus || '') + '</td>')
          + '<td>' + esc(v.valide_par_nom || '') + '</td></tr>';
      }).join('') + '</table></div>';
  }).catch(function(e) { toast(e.message); });
}

renderers.versements = async function () {
  renderVersementsAttente();
  renderAnnulationsAttente();
  renderVersementsTraites("valide", "versementValidesBox");
  renderVersementsTraites("refuse", "versementRefusesBox");
  renderAnnulationsHist();
};
renderers.credits = async function () {
  const box = $("#creditsBox");
  if (!box) return;
  box.innerHTML = `<div class="empty">⏳ Chargement…</div>`;
  let list = [];
  try { list = await api("/credits"); } catch (e) { box.innerHTML = `<div class="empty">Erreur : ${esc(e.message)}</div>`; return; }
  const ouverts = list.filter(c => Number(c.reste) > 0.001);
  const soldes = list.filter(c => Number(c.reste) <= 0.001);
  const row = c => `<tr>
    <td><b>${esc(c.client_nom || "—")}</b></td>
    <td>${fmtDate(c.date)}</td>
    <td class="num">${money(c.net)}</td>
    <td class="num">${money(c.recu)}</td>
    <td class="num"><b>${money(c.reste)}</b></td>
    <td>${esc(c.user_nom || "")}</td>
    <td>${Number(c.reste) > 0.001 ? `<button class="btn small primary" data-payer="${c.id}" data-reste="${c.reste}">💰 Rembourser</button>` : `<span class="badge ok">Soldé</span>`}</td>
  </tr>`;
  box.innerHTML = `
    <div class="panel">
      <div class="row" style="align-items:center;margin-bottom:6px"><h3 class="grow" style="margin:0">💳 Crédits clients (ardoises)</h3><button class="btn small" id="credRefresh">🔄 Actualiser</button></div>
      <h4 style="margin:8px 0 4px">🟠 À encaisser (${ouverts.length})</h4>
      ${ouverts.length === 0 ? `<div class="empty">Aucun crédit en cours 🎉</div>` : `<div class="table-wrap"><table><tr><th>Client</th><th>Date</th><th>Total</th><th>Payé</th><th>Reste</th><th>Caissière</th><th></th></tr>${ouverts.map(row).join("")}</table></div>`}
      ${soldes.length ? `<h4 style="margin:12px 0 4px">✅ Soldés (${soldes.length})</h4><div class="table-wrap"><table><tr><th>Client</th><th>Date</th><th>Total</th><th>Payé</th><th>Reste</th><th>Caissière</th><th></th></tr>${soldes.map(row).join("")}</table></div>` : ""}
    </div>`;
  box.querySelectorAll("[data-payer]").forEach(b => b.addEventListener("click", () => {
    const id = b.dataset.payer;
    const targetCredit = list.find(x => String(x.id) === String(id));
    askPrompt("💰 Remboursement crédit (" + esc(targetCredit ? targetCredit.client_nom : "") + ")", b.dataset.reste, val => {
      const montant = Number(String(val || "").replace(",", "."));
      if (!montant || montant <= 0) { toast("Montant invalide"); return; }
      (async () => {
        try {
          const res = await api("/credits/" + id + "/payer", { method: "POST", body: JSON.stringify({ montant, mode: "especes" }) });
          toast("Remboursement enregistré ✅");
          renderers.credits();
          if (res) {
            const bq = DB.boutique || {};
            const txt = `═══════════════════════\nREÇU DE RÈGLEMENT DE CRÉDIT\n${fmtDate(new Date().toISOString())}\nClient : ${esc(res.client_nom || "Client")}\nTicket d'origine : ${esc(res.numero || "—")}\n═══════════════════════\nTotal initial : ${money(res.net)}\nMontant versé : ${money(montant)}\nMode : Espèces\nReste à payer : ${money(res.reste)}\n═══════════════════════\n${esc(bq.pied || "Merci de votre confiance !")}`;
            openModal(`<h3>🧾 Reçu de règlement</h3>
              <div class="ticket-preview">${esc(txt)}</div>
              <div class="row" style="margin-top:12px">
                <button class="btn primary grow" id="printRecuCreditBtn">🖨️ Imprimer</button>
                <button class="btn ghost grow" onclick="closeModal()">Fermer</button>
              </div>`);
            $("#printRecuCreditBtn").addEventListener("click", () => imprimer("Reçu de règlement", `<div class="ticket-preview">${esc(txt)}</div>`));
          }
        } catch (e) { toast(e.message); }
      })();
    });
  }));
  const rf = $("#credRefresh");
  if (rf) rf.addEventListener("click", () => renderers.credits());
};
function showHelp() {
  openModal(`<div class="confirm-box" style="text-align:left">
    <h3 style="text-align:center">⌨️ Raccourcis clavier</h3>
    <table style="width:100%;font-size:13px;border-collapse:collapse">
      <tr><td><b>Entrée</b></td><td>Encaisser (page Caisse, hors champ de saisie)</td></tr>
      <tr><td><b>F2</b></td><td>Focus recherche produit</td></tr>
      <tr><td><b>F3</b></td><td>Focus quantité du dernier article</td></tr>
      <tr><td><b>F4</b></td><td>Focus remise</td></tr>
      <tr><td><b>F5</b></td><td>Changer le mode de paiement</td></tr>
      <tr><td><b>F6</b></td><td>Suspendre / reprendre la vente</td></tr>
      <tr><td><b>F7</b></td><td>Retirer le dernier article</td></tr>
      <tr><td><b>F9</b></td><td>Encaisser</td></tr>
      <tr><td><b>F10</b></td><td>Réimprimer le dernier ticket</td></tr>
      <tr><td><b>Échap</b></td><td>Fermer une fenêtre / vider le panier</td></tr>
    </table>
    <div class="row" style="margin-top:12px"><button class="btn primary grow" onclick="closeModal()">Fermer</button></div>
  </div>`);
}
function renderVersementConfig() {
  const loadUsers = !DB.users || !DB.users.length ? api("/users").then(function(u) { DB.users = u; }).catch(function() {}) : Promise.resolve();
  loadUsers.then(function() {
    api("/parametres").then(function(rows) {
      var p = {};
      rows.forEach(function(r) { p[r.cle] = r.valeur; });
      var validateurVers = p.versement_validateur || "admin";
      var validateurAnnul = p.annulation_validateur || "admin";
      var box = document.getElementById("versementConfigBox");
      if (!box) return;
      box.innerHTML = `
        <div style="margin-bottom:18px">
          <label class="field">Validateur des versements
            <select id="vcSel">
              ${(DB.users || []).map(function(u) { return '<option value="' + esc(u.nom) + '"' + (u.nom === validateurVers ? ' selected' : '') + '>' + esc(u.nom) + ' (' + esc(u.role_code) + ')</option>'; }).join('')}
            </select>
          </label>
          <p class="muted" style="margin:4px 0 0">L'utilisateur sélectionné recevra et validera les demandes de versement de caisse. L'admin conserve toujours ce droit.</p>
        </div>

        <div style="margin-bottom:18px;padding-top:14px;border-top:1px solid var(--border)">
          <label class="field">Validateur des annulations de vente
            <select id="annulValidateurSel">
              ${(DB.users || []).map(function(u) { return '<option value="' + esc(u.nom) + '"' + (u.nom === validateurAnnul ? ' selected' : '') + '>' + esc(u.nom) + ' (' + esc(u.role_code) + ')</option>'; }).join('')}
            </select>
          </label>
          <p class="muted" style="margin:4px 0 0">Seul cet utilisateur (ou un Administrateur) pourra autoriser l'annulation d'un ticket de caisse déjà validé.</p>
        </div>

        <button class="btn primary" id="vcSave">💾 Enregistrer les validateurs</button>
      `;
      document.getElementById("vcSave").addEventListener("click", async function() {
        try {
          const vVers = document.getElementById("vcSel").value;
          const vAnnul = document.getElementById("annulValidateurSel").value;
          await Promise.all([
            api("/parametres", { method: "PUT", body: JSON.stringify({ versement_validateur: vVers }) }),
            api("/parametres", { method: "PUT", body: JSON.stringify({ annulation_validateur: vAnnul }) })
          ]);
          DB.params = await api("/parametres");
          toast("Validateurs enregistrés avec succès ✅");
        } catch (e) { toast(e.message); }
      });
    }).catch(function(e) { toast(e.message); });
  });
}

function bind() {
  $("#loginBtn").addEventListener("click", doLogin);
  $("#loginPass").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  $("#loginUser").addEventListener("keydown", e => { if (e.key === "Enter") doLogin(); });
  $("#logoutBtn").addEventListener("click", doLogout);
  const gs = $("#globalSearch");
  if (gs) {
    gs.addEventListener("input", e => globalSearch(e.target.value));
    gs.addEventListener("keydown", e => { if (e.key === "Escape") { hideGlobal(true); gs.blur(); } });
  }
  document.addEventListener("click", e => { if (!e.target.closest("#globalSearch") && !e.target.closest("#globalResults")) hideGlobal(false); });
  const themeBtn = $("#themeBtn");
  if (themeBtn) themeBtn.addEventListener("click", toggleTheme);
  const helpBtn = $("#helpBtn");
  if (helpBtn) helpBtn.addEventListener("click", showHelp);
  const refreshBtn = $("#refreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", () => { if (curView && renderers[curView]) { viewLoading(curView); renderers[curView]().catch(e => { const msg = String((e && e.message) || e); if (/injoignable|hors ligne|Failed to fetch|network/i.test(msg)) viewErreurReseau(curView); else toast(e.message || "Erreur"); }); } });
  $$("#sideNav .nav-link").forEach(a => {
    a.tabIndex = 0;
    a.addEventListener("click", () => go(a.dataset.view));
    a.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(a.dataset.view); } });
  });
  $("#scanBtn").addEventListener("click", openScan);
  $("#encaisserBtn").addEventListener("click", encaisser);
  if ($("#holdCartBtn")) $("#holdCartBtn").addEventListener("click", holdCart);
  if ($("#clearCartBtn")) $("#clearCartBtn").addEventListener("click", () => {
    if (cart.length) askConfirm("Vider le panier ?", "Retirer tous les articles du panier en cours ?", () => { cart = []; renderCart(); toast("Panier vidé"); }, { danger: true, okLabel: "Vider" });
  });
  $("#cartRemise").addEventListener("input", renderCart);
  $("#cartMode").addEventListener("change", renderCart);
  $("#cartRecu").addEventListener("input", renderCart);
  if (document.getElementById("cartRecu")) document.getElementById("cartRecu").addEventListener("focus", function() { if (Number(this.value) === 0) this.value = ""; });
  if (document.getElementById("cartRecu")) document.getElementById("cartRecu").addEventListener("blur", function() { if (!this.value) { this.value = 0; } });
  if ($("#cartRecu")) $("#cartRecu").addEventListener("keydown", function(e) { if (e.key === "Enter") { e.preventDefault(); encaisser(); } });
  $("#venteSearch").addEventListener("input", e => { venteFilter = e.target.value; renderVenteGrid(); renderSuggest(); venteServerSearch(e.target.value); });
  $("#venteSearch").addEventListener("keydown", e => {
    const items = $("#venteSuggest .sug-item");
    if (e.key === "ArrowDown") { e.preventDefault(); moveSuggest(items, 1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); moveSuggest(items, -1); return; }
    if (e.key === "Escape") { hideSuggest(); return; }
    if (e.key === "Enter" && venteFilter) { e.preventDefault(); const hl = $("#venteSuggest .sug-item.on"); if (hl && hl.dataset.pid) addSuggestion(hl.dataset.pid); else addLastMatch(); }
  });
  document.addEventListener("click", e => { if (!e.target.closest("#venteSearch") && !e.target.closest("#venteSuggest")) hideSuggest(); });
  $("#venteFamille").addEventListener("change", async () => { const fam = $("#venteFamille").value; try { await loadVenteProducts(venteFilter, fam); renderVenteGrid(); } catch(e){} });
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
        if (cart.length > 0) holdCart();
        else if (heldCarts.length > 0) resumeCart(heldCarts[heldCarts.length - 1].id);
        else toast("Aucun ticket en attente");
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
    if (e.key === "Enter") {
      var m2 = $("#modal");
      if (m2 && !m2.classList.contains("hidden")) return;
      var t2 = (e.target && e.target.tagName || "").toLowerCase();
      if (t2 === "input" || t2 === "select" || t2 === "textarea") return;
      if ($("#view-vente").classList.contains("active") && cart.length > 0 && $("#encaisserBtn") && !$("#encaisserBtn").disabled) { e.preventDefault(); encaisser(); }
    }
  });
  $("#newProdBtn").addEventListener("click", () => prodForm(null));
  $("#prodFamilleFilter").addEventListener("change", () => { pgReset("produits"); renderers.produits().catch(()=>{}); });
  $("#prodSearch").addEventListener("input", debounce(() => { pgReset("produits"); renderers.produits().catch(()=>{}); }, 350));
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
  /* Toggle vue grille/liste pour le catalogue */
  const viewToggle = $("#prodViewToggle");
  if (viewToggle) {
    const saved = localStorage.getItem("gs_prodView") || "list";
    viewToggle.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.viewmode === saved));
    viewToggle.addEventListener("click", e => {
      const btn = e.target.closest("[data-viewmode]");
      if (!btn) return;
      viewToggle.querySelectorAll("button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      localStorage.setItem("gs_prodView", btn.dataset.viewmode);
      renderers.produits().catch(() => {});
    });
  }
  $("#newUserBtn").addEventListener("click", () => userForm(null));
  $("#roleManagerBtn").addEventListener("click", roleManager);
  $("#rapGenBtn").addEventListener("click", () => genRapport().catch(e => toast(e.message)));
  // Param sub-tabs
  document.querySelectorAll("[data-vtab]").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("[data-vtab]").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    document.querySelectorAll("#view-versements .ptab").forEach(p => p.classList.add("hidden"));
    const target = document.getElementById("vtab-" + b.dataset.vtab);
    if (target) target.classList.remove("hidden");
    if (b.dataset.vtab === "attente") renderVersementsAttente();
    if (b.dataset.vtab === "annulations") renderAnnulationsAttente();
    if (b.dataset.vtab === "valides") renderVersementsTraites("valide", "versementValidesBox");
    if (b.dataset.vtab === "refuses") renderVersementsTraites("refuse", "versementRefusesBox");
    if (b.dataset.vtab === "annulations-hist") renderAnnulationsHist();
  }));
  document.querySelectorAll("[data-ptab]").forEach(b => b.addEventListener("click", () => {
    document.querySelectorAll("[data-ptab]").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    document.querySelectorAll(".ptab").forEach(p => p.classList.add("hidden"));
    const target = document.getElementById("ptab-" + b.dataset.ptab);
    if (target) target.classList.remove("hidden");
    if (b.dataset.ptab === "versements") { renderVersementConfig(); }
    if (b.dataset.ptab === "journal") renderers.journal().catch(() => {});
    if (b.dataset.ptab === "personnel") renderers.users().catch(() => {});
    if (b.dataset.ptab === "boutique") renderers.params().catch(() => {});
    if (b.dataset.ptab === "familles") renderers.familles().catch(() => {});
    if (b.dataset.ptab === "sauvegarde") { /* ready */ }
  }));
  $("#rapPrintBtn").addEventListener("click", () => {
    imprimer("Rapport", `<h2>Rapport du ${$("#rapFrom").value} au ${$("#rapTo").value} (par ${$("#rapGroup").value})</h2>` + $("#rapportBox").innerHTML, "A4");
  });
  $("#audUserFilter").addEventListener("change", debounce(() => renderers.journal().catch(() => { })));
  $("#audSearch").addEventListener("input", debounce(() => renderers.journal().catch(() => { })));
  document.querySelectorAll("#view-rapports [data-rtab]").forEach(b => b.addEventListener("click", () => {
    const t = b.dataset.rtab;
    document.querySelectorAll("#view-rapports [data-rtab]").forEach(x => x.classList.toggle("on", x === b));
    const ben = $("#rapBenPane"), abc = $("#rapAbcPane");
    if (ben) ben.classList.toggle("hidden", t !== "benefices");
    if (abc) abc.classList.toggle("hidden", t !== "abc");
    if (t === "abc") renderers.abc($("#abcBox")).catch(e => toast(e.message));
    else genRapport().catch(e => toast(e.message));
  }));
  $("#audCsvBtn").addEventListener("click", async () => {
    let rows = [];
    try { rows = await api("/audit"); } catch (e) { toast(e.message); return; }
    const lines = [["Date", "Utilisateur", "Action", "Détails"]].concat(rows.map(a => [a.date, a.user_nom, a.action, a.details || ""]));
    const csv = lines.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\n");
    const a = document.createElement("a");
    const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" }));
    a.href = url;
    a.download = "journal-audit.csv"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  document.addEventListener("click", e => {
    const btn = e.target && e.target.closest ? e.target.closest("#newClientBtn, #cartQuickAddClientBtn, #pinLockBtn") : null;
    if (!btn) return;
    if (btn.id === "newClientBtn" || btn.id === "cartQuickAddClientBtn") {
      e.preventDefault();
      clientForm(null);
    } else if (btn.id === "pinLockBtn") {
      e.preventDefault();
      pinLockModal();
    }
  });

  const clSearch = $("#clientSearch");
  if (clSearch) clSearch.addEventListener("input", debounce(() => { pgReset("clients"); renderers.clients().catch(() => {}); }));

  const cartClSel = $("#cartClientSel");
  if (cartClSel) cartClSel.addEventListener("change", updateCartClientInfo);

  const bkBtn = $("#backupExportBtn");
  if (bkBtn) bkBtn.addEventListener("click", async () => {
    bkBtn.disabled = true; bkBtn.textContent = "Téléchargement...";
    try {
      const data = await api("/backup/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "sauvegarde-gsv-" + todayKey() + ".json";
      a.click();
      toast("Sauvegarde téléchargée avec succès 💾");
    } catch (e) { toast(e.message); }
    bkBtn.disabled = false; bkBtn.textContent = "💾 Télécharger la sauvegarde complète (JSON)";
  });

  $("#modal").addEventListener("click", e => { if (e.target === $("#modal")) closeModal(); });
}
async function init() {
  /* Les paramètres et notifications nécessitent une session : plus d'appel avant login (401 → déconnexion fantôme) */
  if (token) {
    try { DB.params = await api("/parametres"); } catch (e) { }
  }
  $("#loginHint").innerHTML = `Connecté à : <b>${esc(API_BASE)}</b>`;
  bind();
  if (token) {
    // restoreSession valide le token et appelle showApp() si valide
    await restoreSession();
    return;
  }
  $("#login").classList.remove("hidden");
}
function ensureGlobalData() {
  const jobs = [];
  if (!DB.produits || !DB.produits.length) jobs.push(api("/produits?page=0&limit=200").then(p => DB.produits = Array.isArray(p) ? p : (p.rows || [])).catch(() => {}));
  if (!DB.familles || !DB.familles.length) jobs.push(api("/familles").then(f => DB.familles = f).catch(() => {}));
  if (!DB.fournisseurs || !DB.fournisseurs.length) jobs.push(api("/fournisseurs?limit=100").then(f => DB.fournisseurs = Array.isArray(f) ? f : (f.rows || [])).catch(() => {}));
  return Promise.all(jobs);
}
function renderGlobal(q) {
  const box = $("#globalResults");
  if (!box) return;
  const f = (q || "").toLowerCase().trim();
  if (f.length < 2) { box.classList.add("hidden"); return; }
  const prods = (DB.produits || []).filter(p => p.actif && (p.nom.toLowerCase().includes(f) || (p.code || "").includes(f))).slice(0, 6);
  const fams = (DB.familles || []).filter(x => (x.nom || "").toLowerCase().includes(f)).slice(0, 3);
  const fours = (DB.fournisseurs || []).filter(x => (x.nom || "").toLowerCase().includes(f)).slice(0, 3);
  if (!prods.length && !fams.length && !fours.length) {
    box.innerHTML = '<div class="gs-empty">Aucun résultat</div>';
    box.classList.remove("hidden");
    return;
  }
  let html = "";
  if (prods.length) html += '<div class="gs-group">Produits</div>' + prods.map(p => '<div class="gs-item" data-kind="prod" data-id="' + p.id + '"><span class="gs-name">' + esc(p.nom) + '</span><span class="gs-sub">' + money(p.prix_vente) + '</span></div>').join("");
  if (fams.length) html += '<div class="gs-group">Familles</div>' + fams.map(x => '<div class="gs-item" data-kind="fam" data-id="' + x.id + '"><span class="gs-name">' + esc(x.nom) + '</span></div>').join("");
  if (fours.length) html += '<div class="gs-group">Fournisseurs</div>' + fours.map(x => '<div class="gs-item" data-kind="four" data-id="' + x.id + '"><span class="gs-name">' + esc(x.nom) + '</span></div>').join("");
  box.innerHTML = html;
  box.classList.remove("hidden");
  box.querySelectorAll(".gs-item").forEach(it => it.addEventListener("mousedown", e => { e.preventDefault(); pickGlobal(it); }));
}
function pickGlobal(it) {
  const kind = it.dataset.kind, id = it.dataset.id;
  hideGlobal(true);
  if (kind === "prod") {
    const p = produitById(id);
    if (p && hasRight("R_PRODUITS")) prodForm(p);
    else go("produits");
  } else if (kind === "fam") {
    go("produits");
  } else if (kind === "four") {
    go("stock");
  }
}
function hideGlobal(clear) {
  const b = $("#globalResults"); if (b) b.classList.add("hidden");
  if (clear) { const g = $("#globalSearch"); if (g) g.value = ""; }
}
function globalSearch(q) {
  ensureGlobalData().then(() => renderGlobal(q)).catch(() => {});
}

function initTheme() {
  try {
    const t = localStorage.getItem("gs_theme") || "light";
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {}
  const b = document.getElementById("themeBtn");
  if (b) b.textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "☀️" : "🌙";
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", cur);
  try { localStorage.setItem("gs_theme", cur); } catch (e) {}
  const b = document.getElementById("themeBtn");
  if (b) b.textContent = cur === "dark" ? "☀️" : "🌙";
}
initTheme();
init();

/* Module Stock avance */
renderers.stockmod = () => go("stock");
