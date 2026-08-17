/* ============================================================
   Module Stock — actions rapides intégrées à la page Stock
     1) À commander : produits sous le seuil → commande fournisseur
     2) Sortie rapide : sortir des quantités (don, usage interne…)
   Chargé après app.js ; aucune collision de noms (IIFE).
   ============================================================ */
window.AppStock = (function () {
  "use strict";
  const API = location.origin + "/api";
  const token = () => localStorage.getItem("gs_token") || null;
  let styleInjected = false;
  let cmdBox = null;

  if (!styleInjected && typeof document !== "undefined") {
    const st = document.createElement("style");
    st.textContent = `
      .stk-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px}
      .stk-card h3{margin:0 0 10px;font-size:15px}
      .stk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:12px}
      .stk-card label{display:block;font-size:12px;color:var(--muted);margin:8px 0 3px}
      .stk-card input,.stk-card select{width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--input-bg);color:var(--ink);box-sizing:border-box}
      .stk-btn{background:var(--success);color:#fff;border:0;padding:8px 13px;border-radius:8px;cursor:pointer;font-size:13px;margin-top:10px}
      .stk-btn.danger{background:var(--danger);color:#fff}
      .stk-table{width:100%;border-collapse:collapse;font-size:13px}
      .stk-table th,.stk-table td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--border);vertical-align:top}
      .stk-table th{color:var(--muted);font-weight:600;font-size:12px}
      .stk-pill{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
      .stk-ok{background:rgba(21,128,61,.15);color:var(--success)}.stk-bad{background:rgba(185,28,28,.15);color:var(--danger)}.stk-warn{background:rgba(180,83,9,.15);color:var(--amber)}
      .stk-mut{color:var(--muted);font-size:12px}
      .stk-empty{color:var(--muted);padding:10px 0}
    `;
    document.head.appendChild(st);
    styleInjected = true;
  }

  async function api(path, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    const t = token();
    if (t) headers.Authorization = "Bearer " + t;
    const res = await fetch(API + path, { ...opts, headers });
    const txt = await res.text();
    let data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
    if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
    return data;
  }
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => Number(n || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
  const fmtDate = d => d ? new Date(d).toLocaleDateString("fr-FR") : "";

  async function renderCommander(box) {
    if (!box) return;
    cmdBox = box;
    box.innerHTML = `<div class="stk-mut">Chargement…</div>`;
    try {
      const [suggestions, fournisseurs] = await Promise.all([
        api("/reappro/suggestions"), api("/fournisseurs")
      ]);
      box.innerHTML = `
        <div class="stk-card"><h3>📦 À commander (sous le seuil)</h3>
          ${suggestions.length
            ? `<div style="overflow-x:auto"><table class="stk-table"><tr><th>Produit</th><th>En stock</th><th>Seuil</th><th>À commander</th></tr>
              ${suggestions.map(s => `<tr><td>${esc(s.nom)}</td><td>${fmt(s.qte)}</td><td>${fmt(s.stock_min)}</td><td><b>${fmt(s.qte_suggeree)}</b></td></tr>`).join("")}
              </table></div>
              <div class="stk-grid">
                <div><label>Fournisseur</label>
                  <select id="stkFourSel"><option value="">— Choisir un fournisseur —</option>${fournisseurs.map(f => `<option value="${esc(f.nom)}">${esc(f.nom)}</option>`).join("")}<option value="__new__">✚ Nouveau fournisseur...</option></select>
                  <input id="stkFourNew" style="display:none;margin-top:6px" placeholder="Nom du nouveau fournisseur"></div>
                <div style="align-self:end"><button class="stk-btn" onclick="AppStock.commanderTout()">Créer la commande</button></div>
              </div>`
            : `<div class="stk-empty">✅ Tout est au-dessus du seuil</div>`}
        </div>`;
      const stkFourSel = box.querySelector("#stkFourSel");
      if (stkFourSel) stkFourSel.addEventListener("change", () => {
        const nv = box.querySelector("#stkFourNew");
        if (nv) nv.style.display = stkFourSel.value === "__new__" ? "" : "none";
      });
    } catch (e) {
      box.innerHTML = `<div class="stk-bad" style="padding:8px 10px;border-radius:8px">${esc(e.message)}</div>`;
    }
  }

  async function renderSortie(box) {
    if (!box) return;
    box.innerHTML = `<div class="stk-mut">Chargement…</div>`;
    try {
      const [magasins, produits] = await Promise.all([api("/magasins"), api("/produits")]);
      const magId = (magasins && magasins[0]) ? magasins[0].id : null;
      box.innerHTML = `
        <div class="stk-card"><h3>🚚 Sortie rapide (don, usage interne…)</h3>
          <div class="stk-grid">
            <div><label>Produit</label><select id="stkProd">${produits.filter(p => p.actif !== false).map(p => `<option value="${p.id}">${esc(p.nom)}${p.code ? " (" + esc(p.code) + ")" : ""}</option>`).join("")}</select></div>
            <div><label>Quantité</label><input id="stkQte" type="number" value="1" min="0" step="0.01"></div>
            <div><label>Destinataire / motif</label><input id="stkMotif" placeholder="ex. Don à l'école, usage cuisine…"></div>
            <div style="align-self:end"><button class="stk-btn" onclick="AppStock.sortieRapide(${magId || "null"})">Enregistrer la sortie</button></div>
          </div>
        </div>`;
    } catch (e) {
      box.innerHTML = `<div class="stk-bad" style="padding:8px 10px;border-radius:8px">${esc(e.message)}</div>`;
    }
  }

  async function commanderTout() {
    const sel = document.getElementById("stkFourSel");
    const nv = document.getElementById("stkFourNew");
    let nom = (sel && sel.value) || "";
    if (nom === "__new__") nom = (nv && nv.value || "").trim();
    if (!nom) return toast("Indiquez le nom du fournisseur");
    try {
      const sugg = await api("/reappro/suggestions");
      let fait = 0;
      for (const s of sugg) {
        await api(`/reappro/suggestions/${s.suggestion_id}/commander`, { method: "POST", body: JSON.stringify({ fournisseur_nom: nom }) });
        fait++;
      }
      toast(fait + " commande(s) créée(s) pour " + nom);
      if (cmdBox) renderCommander(cmdBox);
    } catch (e) { toast("Erreur : " + e.message); }
  }

  async function sortieRapide(magId) {
    const produit_id = Number(document.getElementById("stkProd").value);
    const qte = Number(document.getElementById("stkQte").value);
    const motif = (document.getElementById("stkMotif").value || "").trim();
    if (!qte || qte <= 0) return toast("Quantité invalide");
    if (!magId) return toast("Aucun magasin disponible");
    try {
      const b = await api("/bons", { method: "POST", body: JSON.stringify({
        type: "SORTIE", magasin_id: magId, motif: motif || "Sortie interne",
        items: [{ produit_id, qte }]
      })});
      await api("/bons/" + b.id + "/valider", { method: "POST" });
      toast("Sortie enregistrée (" + qte + ")" + (motif ? " — " + motif : ""));
    } catch (e) { toast("Erreur : " + e.message); }
  }

  return { renderCommander, renderSortie, commanderTout, sortieRapide };
})();
