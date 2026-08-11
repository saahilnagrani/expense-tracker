// Main UI controller: routing, views, and wiring for the Expense Tracker.
import {
  allExpenses, putExpense, putMany, deleteExpense, clearAll,
  existingDedupeKeys, loadSettings, saveSettings, uid,
} from "./db.js";
import { SOURCES } from "./config.js";
import { toBase, fmt, fmtBase } from "./currency.js";
import * as GM from "./gmail.js";
import { extractText, PdfPasswordError } from "./pdf.js";
import {
  parseStatementByBank, guessCategory, dedupeKey,
} from "./parsers.js";
import {
  summarize, barRows, monthTrend, currencyLegend, esc,
} from "./dashboard.js";

let settings = loadSettings();
let expenses = [];

const views = document.getElementById("views");
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---------- boot ----------
async function boot() {
  expenses = await allExpenses();
  updateBasePill();
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => go(t.dataset.view)));
  $("#modalClose").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  go(location.hash.replace("#", "") || "dashboard");
}

function go(view) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  location.hash = view;
  const fn = ({ dashboard: renderDashboard, expenses: renderExpenses,
    add: renderAdd, import: renderImport, settings: renderSettings })[view] || renderDashboard;
  fn();
  window.scrollTo(0, 0);
}

function updateBasePill() {
  $("#basePill").textContent = "Base: " + settings.baseCurrency;
}

// ---------- Dashboard ----------
function renderDashboard() {
  const s = summarize(expenses, settings);
  if (!expenses.length) {
    views.innerHTML = emptyState();
    $("#emptyImport")?.addEventListener("click", () => go("import"));
    $("#emptyAdd")?.addEventListener("click", () => go("add"));
    return;
  }
  const delta = s.lastBase ? ((s.monthBase - s.lastBase) / s.lastBase) * 100 : null;
  views.innerHTML = `
    <div class="grid cols-3">
      <div class="card stat">
        <span class="label">This month (${s.thisMonth})</span>
        <span class="value">${fmtBase(s.monthBase, settings)}</span>
        <span class="sub">${delta == null ? "no prior month" :
          (delta >= 0 ? "▲" : "▼") + " " + Math.abs(delta).toFixed(0) + "% vs last month"}</span>
      </div>
      <div class="card stat">
        <span class="label">Last month (${s.lastMonth})</span>
        <span class="value">${fmtBase(s.lastBase, settings)}</span>
        <span class="sub">${s.count} transactions tracked</span>
      </div>
      <div class="card stat">
        <span class="label">Total tracked spend</span>
        <span class="value">${fmtBase(s.totalBase, settings)}</span>
        <span class="sub">${s.unconverted ? s.unconverted + " item(s) missing an FX rate" : "all converted to " + settings.baseCurrency}</span>
      </div>
    </div>

    <div class="grid cols-2 mt">
      <div class="card">
        <div class="section-title">Spend by month</div>
        <div style="display:flex;gap:8px;align-items:flex-end;height:170px">${monthTrend(s.byMonth, settings, { months: 6 })}</div>
      </div>
      <div class="card">
        <div class="section-title">By category</div>
        <div class="bars">${barRows(s.byCategory, settings)}</div>
      </div>
    </div>

    <div class="grid cols-2 mt">
      <div class="card">
        <div class="section-title">By card / source</div>
        <div class="bars">${barRows(s.byCard, settings)}</div>
      </div>
      <div class="card">
        <div class="section-title">By original currency</div>
        ${currencyLegend(s.byCurrency) || '<div class="hint">No data.</div>'}
        <div class="hint mt">Totals above are converted to ${settings.baseCurrency} using the rates in Settings.</div>
      </div>
    </div>`;
}

function emptyState() {
  return `<div class="card empty">
    <div class="big">💸</div>
    <h2>Let's track some expenses</h2>
    <p class="muted">Import credit-card statements from Gmail, or add an expense by hand.</p>
    <div class="flex" style="justify-content:center;margin-top:14px">
      <button class="btn" id="emptyImport">Import from Gmail</button>
      <button class="btn secondary" id="emptyAdd">Add expense</button>
    </div>
  </div>`;
}

// ---------- Expenses list ----------
let expFilter = { q: "", month: "", card: "", cat: "" };
function renderExpenses() {
  const cards = [...new Set(expenses.map((e) => e.card).filter(Boolean))].sort();
  const cats = settings.categories;
  const months = [...new Set(expenses.map((e) => e.date.slice(0, 7)))].sort().reverse();

  const filtered = expenses.filter((e) => {
    if (expFilter.q && !(`${e.description} ${e.card}`.toLowerCase().includes(expFilter.q.toLowerCase()))) return false;
    if (expFilter.month && e.date.slice(0, 7) !== expFilter.month) return false;
    if (expFilter.card && e.card !== expFilter.card) return false;
    if (expFilter.cat && (e.category || "") !== expFilter.cat) return false;
    return true;
  });
  const totalBase = filtered.reduce((a, e) =>
    a + (e.kind === "credit" ? 0 : (toBase(e.amount, e.currency, settings) || 0)), 0);

  views.innerHTML = `
    <div class="card">
      <div class="flex">
        <input id="fq" placeholder="Search merchant / card…" value="${esc(expFilter.q)}" style="flex:1;min-width:180px;padding:9px 12px;border:1px solid var(--border);border-radius:10px;background:var(--panel-2)">
        <select id="fmonth" class="fsel"><option value="">All months</option>${months.map((m) => `<option ${expFilter.month === m ? "selected" : ""}>${m}</option>`).join("")}</select>
        <select id="fcard" class="fsel"><option value="">All cards</option>${cards.map((c) => `<option ${expFilter.card === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <select id="fcat" class="fsel"><option value="">All categories</option>${cats.map((c) => `<option ${expFilter.cat === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <button class="btn sm secondary" id="fclear">Clear</button>
        <span class="spacer"></span>
        <button class="btn sm" id="expCsv">Export CSV</button>
      </div>
      <div class="hint mt">${filtered.length} transaction(s) · spend total ${fmtBase(totalBase, settings)}</div>
      <div class="table-wrap mt">
        <table class="data">
          <thead><tr>
            <th>Date</th><th>Description</th><th>Category</th><th>Card / Source</th>
            <th class="amount">Amount</th><th class="amount">In ${settings.baseCurrency}</th><th></th>
          </tr></thead>
          <tbody>${filtered.map(rowHtml).join("") || `<tr><td colspan="7" class="hint" style="padding:24px">No matching transactions.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  $("#fq").addEventListener("input", (e) => { expFilter.q = e.target.value; debouncedExp(); });
  ["fmonth", "fcard", "fcat"].forEach((id) => $("#" + id).addEventListener("change", (e) => {
    expFilter[id.slice(1)] = e.target.value; renderExpenses();
  }));
  $("#fclear").addEventListener("click", () => { expFilter = { q: "", month: "", card: "", cat: "" }; renderExpenses(); });
  $("#expCsv").addEventListener("click", () => exportCsv(filtered));
  $$(".catsel").forEach((sel) => sel.addEventListener("change", async (e) => {
    const exp = expenses.find((x) => x.id === e.target.dataset.id);
    if (exp) { exp.category = e.target.value; await putExpense(exp); toast("Category updated", "ok"); }
  }));
  $$(".del").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this transaction?")) return;
    await deleteExpense(b.dataset.id);
    expenses = expenses.filter((x) => x.id !== b.dataset.id);
    renderExpenses();
  }));
  $$(".fsel").forEach((s) => s.style.cssText = "padding:9px 10px;border:1px solid var(--border);border-radius:10px;background:var(--panel-2)");
}
let _t;
function debouncedExp() { clearTimeout(_t); _t = setTimeout(renderExpenses, 250); }

function rowHtml(e) {
  const base = e.kind === "credit" ? null : toBase(e.amount, e.currency, settings);
  const cls = e.kind === "credit" ? "credit" : "debit";
  const catOpts = ["", ...settings.categories].map((c) =>
    `<option value="${esc(c)}" ${e.category === c ? "selected" : ""}>${c || "—"}</option>`).join("");
  return `<tr>
    <td>${e.date}</td>
    <td>${esc(e.description)}${e.kind === "credit" ? ' <span class="chip src-alert">credit</span>' : ""}</td>
    <td><select class="catsel" data-id="${e.id}" style="border:1px solid var(--border);border-radius:8px;background:var(--panel-2);padding:5px 8px">${catOpts}</select></td>
    <td>${esc(e.card || "—")} <span class="chip src-${e.source === "manual" ? "manual" : e.source === "alert" ? "alert" : "statement"}">${srcLabel(e.source)}</span></td>
    <td class="amount ${cls}">${e.kind === "credit" ? "+" : ""}${fmt(e.amount, e.currency)}</td>
    <td class="amount">${base == null ? '<span class="chip" title="No FX rate for ' + e.currency + '">no rate</span>' : fmtBase(base, settings)}</td>
    <td class="right"><button class="icon-btn del" data-id="${e.id}" title="Delete">🗑</button></td>
  </tr>`;
}
function srcLabel(s) { return s === "manual" ? "manual" : s === "alert" ? "alert" : "statement"; }

// ---------- Add expense ----------
function renderAdd() {
  const today = new Date().toISOString().slice(0, 10);
  views.innerHTML = `
    <div class="card" style="max-width:620px;margin:0 auto">
      <div class="section-title">Add an expense</div>
      <div class="row">
        <div class="field"><label>Date</label><input type="date" id="aDate" value="${today}"></div>
        <div class="field"><label>Amount</label><input type="number" step="0.01" min="0" id="aAmount" placeholder="0.00"></div>
        <div class="field" style="max-width:130px"><label>Currency</label><select id="aCur">${currencyOptions(settings.baseCurrency)}</select></div>
      </div>
      <div class="field"><label>Description / merchant</label><input id="aDesc" placeholder="e.g. Carrefour groceries"></div>
      <div class="row">
        <div class="field"><label>Category</label><select id="aCat"><option value="">— pick —</option>${settings.categories.map((c) => `<option>${c}</option>`).join("")}</select></div>
        <div class="field"><label>Card / source</label><input id="aCard" placeholder="e.g. Cash, ADCB, Axis XX2234"></div>
      </div>
      <div class="row">
        <div class="field"><label>Type</label><select id="aKind"><option value="expense">Expense</option><option value="credit">Credit / refund</option></select></div>
      </div>
      <div class="field"><label>Notes (optional)</label><input id="aNotes" placeholder=""></div>
      <div class="flex"><button class="btn" id="aSave">Save expense</button><span id="aMsg" class="hint"></span></div>
    </div>`;
  $("#aDesc").addEventListener("blur", () => {
    if (!$("#aCat").value) { const g = guessCategory($("#aDesc").value); if (g) $("#aCat").value = g; }
  });
  $("#aSave").addEventListener("click", saveManual);
}

async function saveManual() {
  const amount = parseFloat($("#aAmount").value);
  const desc = $("#aDesc").value.trim();
  if (!isFinite(amount) || amount <= 0) return toast("Enter a valid amount", "err");
  if (!desc) return toast("Add a description", "err");
  const kind = $("#aKind").value;
  const e = {
    id: uid(), date: $("#aDate").value, description: desc,
    amount: Math.abs(amount), currency: $("#aCur").value,
    category: $("#aCat").value || guessCategory(desc), card: $("#aCard").value.trim() || "Manual",
    kind, source: "manual", notes: $("#aNotes").value.trim(),
    createdAt: new Date().toISOString(),
  };
  e.dedupeKey = dedupeKey({ ...e, source: "manual" });
  await putExpense(e);
  expenses.unshift(e);
  toast("Saved ✓", "ok");
  renderAdd();
}

// ---------- Import from Gmail ----------
function renderImport() {
  const connected = GM.isSignedIn();
  const hasClientId = !!settings.googleClientId;
  views.innerHTML = `
    <div class="card">
      <div class="section-title">Import credit-card transactions from Gmail</div>
      ${!hasClientId ? `<div class="warnbox">No Google Client ID set yet. Add one in <a href="#settings" id="toSettings">Settings → Gmail connection</a> to enable importing. (One-time setup — the README has step-by-step instructions.)</div>` : ""}
      <p class="hint">Reads matching bank emails in your account, parses the transactions, and shows them for your review before anything is saved. Read-only access; nothing is sent anywhere except Google.</p>
      <div class="pill-tabs mt">
        ${SOURCES.map((s) => `<label class="chip" style="cursor:pointer;user-select:none"><input type="checkbox" class="srcChk" value="${s.bank}" ${settings.enabledSources.includes(s.bank) ? "checked" : ""} style="margin-right:6px">${esc(s.label)}</label>`).join("")}
      </div>
      <div class="row mt">
        <div class="field" style="max-width:200px"><label>Look back</label>
          <select id="lookback">
            ${[3, 6, 12, 24].map((m) => `<option value="${m}" ${settings.lookbackMonths === m ? "selected" : ""}>${m} months</option>`).join("")}
          </select>
        </div>
        <div class="field" style="align-self:flex-end">
          ${connected
            ? `<button class="btn" id="fetchBtn">Fetch & parse</button>`
            : `<button class="btn" id="connectBtn" ${hasClientId ? "" : "disabled"}>Connect Gmail</button>`}
        </div>
        ${connected ? `<div class="field" style="align-self:flex-end"><button class="btn secondary" id="disconnectBtn">Disconnect</button></div>` : ""}
      </div>
      <div id="importLog" class="mt"></div>
    </div>
    <div id="reviewArea" class="mt"></div>`;

  $("#toSettings")?.addEventListener("click", (e) => { e.preventDefault(); go("settings"); });
  $$(".srcChk").forEach((c) => c.addEventListener("change", () => {
    settings.enabledSources = $$(".srcChk").filter((x) => x.checked).map((x) => x.value);
    saveSettings(settings);
  }));
  $("#lookback")?.addEventListener("change", (e) => { settings.lookbackMonths = +e.target.value; saveSettings(settings); });
  $("#connectBtn")?.addEventListener("click", async () => {
    try { setLog("Opening Google sign-in…"); await GM.connect(settings.googleClientId); toast("Connected to Gmail ✓", "ok"); renderImport(); }
    catch (e) { setLog(""); toast(e.message, "err"); }
  });
  $("#disconnectBtn")?.addEventListener("click", () => { GM.disconnect(); renderImport(); });
  $("#fetchBtn")?.addEventListener("click", fetchAndParse);
}

function setLog(html) { const el = $("#importLog"); if (el) el.innerHTML = html; }

async function fetchAndParse() {
  const chosen = SOURCES.filter((s) => settings.enabledSources.includes(s.bank));
  if (!chosen.length) return toast("Pick at least one source", "err");
  const after = new Date();
  after.setMonth(after.getMonth() - settings.lookbackMonths);
  const afterStr = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;

  const existing = await existingDedupeKeys();
  const parsed = [];
  const problems = [];
  $("#reviewArea").innerHTML = "";

  for (const src of chosen) {
    try {
      setLog(`Searching ${esc(src.label)}…`);
      const q = `from:${src.from} has:attachment filename:pdf after:${afterStr}`;
      const ids = await GM.searchMessages(q, 60);
      setLog(`Found ${ids.length} statement email(s) for ${esc(src.label)}. Reading…`);

      for (let i = 0; i < ids.length; i++) {
        setLog(`${esc(src.label)}: reading statement ${i + 1}/${ids.length}…`);
        const msg = await GM.getMessage(ids[i]);
        const { pdfs } = GM.extractParts(msg);
        if (!pdfs.length) continue;

        const rows = [];
        for (const att of pdfs) {
          try {
            const bytes = await GM.getAttachment(ids[i], att.attachmentId);
            const pw = settings.passwords[src.bank] || "";
            const { lines } = await extractText(bytes, pw);
            rows.push(...parseStatementByBank(src.bank, lines, { currency: src.currency, card: src.label }));
          } catch (err) {
            if (err instanceof PdfPasswordError) {
              problems.push(`🔒 ${src.label}: ${att.filename} needs a password. Add it in Settings (${src.passwordHint || "see the email"}).`);
            } else {
              problems.push(`⚠️ ${src.label}: couldn't read ${att.filename} — ${err.message}`);
            }
          }
        }
        for (const r of rows) {
          r.source = src.kind;
          r.bank = src.bank;
          r.gmailMessageId = ids[i];
          r.category = guessCategory(r.description);
          r.dedupeKey = dedupeKey({ ...r, source: src.kind });
          r._dup = existing.has(r.dedupeKey);
        }
        parsed.push(...rows);
      }
    } catch (e) {
      problems.push(`⚠️ ${src.label}: ${e.message}`);
    }
  }

  setLog("");
  renderReview(parsed, problems);
}

let reviewRows = [];
function renderReview(rows, problems) {
  reviewRows = rows;
  const fresh = rows.filter((r) => !r._dup);
  const dupCount = rows.length - fresh.length;
  const area = $("#reviewArea");
  if (!rows.length) {
    area.innerHTML = `<div class="card">
      ${problems.map((p) => `<div class="warnbox mt">${esc(p)}</div>`).join("") || ""}
      <div class="empty"><div class="big">🔍</div><p class="muted">No transactions parsed. If you have statements, check that the PDF password is set in Settings, or open the debug view below.</p></div>
    </div>`;
    return;
  }
  area.innerHTML = `<div class="card">
    <div class="flex">
      <div class="section-title" style="margin:0">Review ${fresh.length} new transaction(s)</div>
      <span class="spacer"></span>
      <button class="btn sm secondary" id="revAll">Select all</button>
      <button class="btn sm secondary" id="revNone">None</button>
      <button class="btn" id="revSave">Save selected</button>
    </div>
    ${dupCount ? `<div class="hint mt">${dupCount} already-imported transaction(s) hidden.</div>` : ""}
    ${problems.map((p) => `<div class="warnbox mt">${esc(p)}</div>`).join("")}
    <div class="mt">${fresh.map((r, i) => reviewRowHtml(r, i)).join("")}</div>
  </div>`;

  $("#revAll").addEventListener("click", () => $$(".revChk").forEach((c) => c.checked = true));
  $("#revNone").addEventListener("click", () => $$(".revChk").forEach((c) => c.checked = false));
  $("#revSave").addEventListener("click", () => saveReview(fresh));
}

function reviewRowHtml(r, i) {
  return `<div class="rev-row">
    <input type="checkbox" class="revChk" data-i="${i}" checked>
    <div style="width:100%">
      <div class="rev-grid">
        <div class="field"><label>Date</label><input type="date" data-i="${i}" data-f="date" value="${r.date}"></div>
        <div class="field"><label>Amount (${esc(r.currency || "?")})</label><input type="number" step="0.01" data-i="${i}" data-f="amount" value="${r.amount}"></div>
        <div class="field"><label>Type</label><select data-i="${i}" data-f="kind"><option value="expense" ${r.kind !== "credit" ? "selected" : ""}>Expense</option><option value="credit" ${r.kind === "credit" ? "selected" : ""}>Credit</option></select></div>
      </div>
      <div class="rev-grid mt">
        <div class="field" style="grid-column:span 2"><label>Description</label><input data-i="${i}" data-f="description" value="${esc(r.description)}"></div>
        <div class="field"><label>Category</label><select data-i="${i}" data-f="category"><option value="">—</option>${settings.categories.map((c) => `<option ${r.category === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
      </div>
      <div class="hint mt">${esc(r.card || "")} · ${srcLabel(r.source)} · confidence ${(r.confidence * 100 | 0)}%</div>
    </div>
  </div>`;
}

async function saveReview(fresh) {
  // Apply any inline edits.
  $$("[data-f]").forEach((el) => {
    const i = +el.dataset.i, f = el.dataset.f;
    if (!fresh[i]) return;
    fresh[i][f] = f === "amount" ? parseFloat(el.value) : el.value;
  });
  const selected = $$(".revChk").filter((c) => c.checked).map((c) => fresh[+c.dataset.i]).filter(Boolean);
  if (!selected.length) return toast("Nothing selected", "err");

  const toSave = selected.map((r) => {
    const e = {
      id: uid(), date: r.date, description: r.description,
      amount: Math.abs(parseFloat(r.amount) || 0), currency: r.currency,
      category: r.category || guessCategory(r.description), card: r.card,
      kind: r.kind === "credit" ? "credit" : "expense",
      source: r.source, bank: r.bank, gmailMessageId: r.gmailMessageId,
      createdAt: new Date().toISOString(),
    };
    e.dedupeKey = dedupeKey(e);
    return e;
  }).filter((e) => e.amount > 0);

  await putMany(toSave);
  expenses = await allExpenses();
  toast(`Imported ${toSave.length} transaction(s) ✓`, "ok");
  go("expenses");
}

// ---------- Settings ----------
function renderSettings() {
  const curList = Object.keys(settings.rates);
  views.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <div class="section-title">Base currency & FX rates</div>
        <div class="field" style="max-width:220px"><label>Base currency</label><select id="setBase">${currencyOptions(settings.baseCurrency)}</select></div>
        <p class="hint">Each rate = value of 1 unit in your base currency. Totals convert using these. Update them whenever you like — they aren't live.</p>
        <div id="rateRows" class="mt">${curList.map(rateRowHtml).join("")}</div>
        <div class="flex mt"><input id="newCur" placeholder="Add code e.g. SAR" style="max-width:140px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-2)"><button class="btn sm secondary" id="addCur">Add currency</button></div>
      </div>
      <div class="card">
        <div class="section-title">Gmail connection</div>
        <div class="field"><label>Google OAuth Client ID</label><input id="setClient" value="${esc(settings.googleClientId)}" placeholder="xxxxx.apps.googleusercontent.com"></div>
        <p class="hint">Needed to read statements from Gmail on a static site. Create a free <b>Web</b> OAuth Client ID in Google Cloud, enable the Gmail API, and add this site's URL as an authorized JavaScript origin. Full walkthrough in the README.</p>
        <div class="section-title mt">Statement PDF passwords</div>
        <p class="hint">Bank statement PDFs are encrypted. Passwords are stored only in this browser.</p>
        ${SOURCES.filter((s) => s.kind === "statement").map((s) => `
          <div class="field"><label>${esc(s.label)}</label>
            <input type="password" class="pwIn" data-bank="${s.bank}" value="${esc(settings.passwords[s.bank] || "")}" placeholder="${esc(s.passwordHint || "PDF password")}">
          </div>`).join("")}
      </div>
    </div>

    <div class="grid cols-2 mt">
      <div class="card">
        <div class="section-title">Categories</div>
        <div id="catList" class="flex">${settings.categories.map((c) => `<span class="chip cat">${esc(c)} <button class="icon-btn catDel" data-c="${esc(c)}" style="padding:0 4px">✕</button></span>`).join("")}</div>
        <div class="flex mt"><input id="newCat" placeholder="New category" style="max-width:200px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-2)"><button class="btn sm secondary" id="addCat">Add</button></div>
      </div>
      <div class="card">
        <div class="section-title">Data</div>
        <p class="hint">Everything is stored locally in this browser (IndexedDB). Back it up or move it between devices here.</p>
        <div class="flex">
          <button class="btn secondary" id="expJson">Export JSON backup</button>
          <label class="btn secondary" style="display:inline-block">Import JSON<input type="file" id="impJson" accept="application/json" hidden></label>
          <button class="btn danger" id="wipe">Delete all data</button>
        </div>
        <div class="hint mt">${expenses.length} transactions stored.</div>
      </div>
    </div>
    <div class="flex mt"><button class="btn" id="saveSet">Save settings</button><span id="setMsg" class="hint"></span></div>`;

  $("#addCur").addEventListener("click", () => {
    const c = $("#newCur").value.trim().toUpperCase();
    if (c && !settings.rates[c]) { settings.rates[c] = 1; renderSettings(); }
  });
  $("#addCat").addEventListener("click", () => {
    const c = $("#newCat").value.trim();
    if (c && !settings.categories.includes(c)) { settings.categories.push(c); renderSettings(); }
  });
  $$(".catDel").forEach((b) => b.addEventListener("click", () => {
    settings.categories = settings.categories.filter((c) => c !== b.dataset.c); renderSettings();
  }));
  $("#expJson").addEventListener("click", exportJson);
  $("#impJson").addEventListener("change", importJson);
  $("#wipe").addEventListener("click", async () => {
    if (!confirm("Delete ALL transactions? This cannot be undone.")) return;
    await clearAll(); expenses = []; toast("All data deleted", "ok"); go("dashboard");
  });
  $("#saveSet").addEventListener("click", () => {
    settings.baseCurrency = $("#setBase").value;
    settings.googleClientId = $("#setClient").value.trim();
    $$(".rateIn").forEach((el) => { settings.rates[el.dataset.cur] = parseFloat(el.value) || 0; });
    $$(".pwIn").forEach((el) => { settings.passwords[el.dataset.bank] = el.value; });
    saveSettings(settings);
    updateBasePill();
    toast("Settings saved ✓", "ok");
  });
}

function rateRowHtml(cur) {
  return `<div class="flex" style="margin-bottom:8px">
    <span class="chip" style="min-width:56px;text-align:center">${cur}</span>
    <span class="hint">1 ${cur} =</span>
    <input class="rateIn" data-cur="${cur}" type="number" step="0.0001" value="${settings.rates[cur]}" style="max-width:130px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-2)">
    <span class="hint">${esc(settings.baseCurrency)}</span>
  </div>`;
}

// ---------- import/export ----------
function exportJson() {
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), settings, expenses }, null, 2)], { type: "application/json" });
  downloadBlob(blob, `expense-tracker-backup-${new Date().toISOString().slice(0, 10)}.json`);
}
async function importJson(e) {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (Array.isArray(data.expenses)) {
      await putMany(data.expenses.map((x) => ({ ...x, id: x.id || uid() })));
      expenses = await allExpenses();
    }
    if (data.settings) { settings = { ...settings, ...data.settings }; saveSettings(settings); }
    toast("Backup imported ✓", "ok"); go("dashboard");
  } catch (err) { toast("Import failed: " + err.message, "err"); }
}
function exportCsv(list) {
  const head = ["date", "description", "category", "card", "amount", "currency", "kind", "base_" + settings.baseCurrency, "source"];
  const rows = list.map((e) => [e.date, e.description, e.category || "", e.card || "", e.amount, e.currency,
    e.kind, (toBase(e.amount, e.currency, settings) || "").toString(), e.source]);
  const csv = [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  downloadBlob(new Blob([csv], { type: "text/csv" }), `expenses-${new Date().toISOString().slice(0, 10)}.csv`);
}
function csvCell(v) { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- helpers ----------
function currencyOptions(sel) {
  return Object.keys(settings.rates).map((c) => `<option ${c === sel ? "selected" : ""}>${c}</option>`).join("");
}
let toastTimer;
function toast(msg, kind = "") {
  const el = $("#toast");
  el.textContent = msg; el.className = "toast " + kind; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 2800);
}
function closeModal() { $("#modal").hidden = true; }

boot();
