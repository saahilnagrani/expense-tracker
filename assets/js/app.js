// Main UI controller: routing, views, and wiring for the Expense Tracker.
import {
  allExpenses, putExpense, putMany, deleteExpense, clearAll,
  existingDedupeKeys, loadSettings, saveSettings, uid, recordDeletion,
} from "./db.js";
import { syncNow, markPrefsChanged, lastSyncedAt } from "./sync.js";
import { SOURCES, DEFAULT_CATEGORIES } from "./config.js";
import { toBase, fmt, fmtBase } from "./currency.js";
import * as GM from "./gmail.js";
import { extractText, PdfPasswordError } from "./pdf.js";
import {
  parseStatementByBank, guessCategory, dedupeKey, linkFeesToPurchases,
} from "./parsers.js";
import { esc } from "./dashboard.js";

let settings = loadSettings();
let expenses = [];

const views = document.getElementById("views");
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Signed spend contribution (in base currency):
//  - expenses add to spend
//  - card payments (bill payments) count as 0 — they just settle the card
//  - every other credit (refunds, cashback, reversals, …) reduces spend
// Refunds keep their merchant's category; only the sign differs.
// Returns null when the currency has no FX rate.
// Categories sorted A–Z for the assignment dropdowns and the Settings list.
// (The Expenses/Import filter dropdowns stay ordered by frequency on purpose.)
function sortedCats() {
  return [...(settings.categories || [])].sort((a, b) => a.localeCompare(b));
}

// Add a category to the single shared list (settings.categories) so it shows
// up everywhere — Expenses, Import review and Settings all read this list, and
// it syncs across devices. Returns the (possibly existing) category name.
function addCategory(name) {
  const c = (name || "").trim();
  if (!c) return null;
  if (!settings.categories.includes(c)) {
    settings.categories = [...settings.categories, c];
    saveSettings(settings);
    markPrefsChanged();
    scheduleSync();
  }
  return c;
}

// <option>s for a category-assignment dropdown, plus a "+ New category…" entry.
function catOptionsHtml(selected) {
  const opts = ["", ...sortedCats()].map((c) =>
    `<option value="${esc(c)}" ${selected === c ? "selected" : ""}>${c || "—"}</option>`).join("");
  return opts + `<option value="__new__">+ New category…</option>`;
}

// One unified password table: each card/account is a row, with a column for
// your password and one for the household member's. A dash marks a cell that
// doesn't apply (their-only card in your column, or an account in theirs). The
// "theirs" column and their-only rows hide when Household mode is off (CSS).
function pwTable() {
  const on = settings.spouseEnabled;
  const spName = settings.spouseName || "Their";
  const mineCell = (s) => s.spouseOnly
    ? `<span class="pw-na">—</span>`
    : `<input type="password" class="pwIn" data-bank="${s.bank}" value="${esc(settings.passwords[s.bank] || "")}" placeholder="${esc(s.passwordHint || "PDF password")}">`;
  const hersCell = (s) => (s.shared || s.spouseOnly)
    ? `<input type="password" class="spPw" data-bank="${s.bank}" value="${esc((settings.spousePasswords || {})[s.bank] || "")}" placeholder="${esc(s.passwordHint || "PDF password")}">`
    : `<span class="pw-na">—</span>`;
  const row = (s) => `<tr class="${s.spouseOnly ? "sponly-row" : ""}">
    <td>${esc(s.label)}</td>
    <td>${mineCell(s)}</td>
    <td class="spcol">${hersCell(s)}</td>
  </tr>`;
  const cc = SOURCES.filter((s) => s.kind === "statement" && !s.acct);
  const acct = SOURCES.filter((s) => s.kind === "statement" && s.acct);
  return `<table class="pw-table ${on ? "" : "hide-spouse"}">
    <thead><tr><th>Card / account</th><th>Your password</th><th class="spcol">${esc(spName)}'s password</th></tr></thead>
    <tbody>
      <tr class="grouprow"><td colspan="3">Credit cards</td></tr>
      ${cc.map(row).join("")}
      <tr class="grouprow"><td colspan="3">Bank-account statements</td></tr>
      ${acct.map(row).join("")}
    </tbody>
  </table>`;
}

function spendBase(e) {
  const b = toBase(e.amount, e.currency, settings);
  if (b == null) return null;
  // Card bill payments / repayments never count as spend, in either direction
  // (e.g. paying another card via Wio just settles a bill already counted).
  if (e.category === "Card Payment") return 0;
  if (e.kind === "credit") return -b;
  return b;
}

// ---------- boot ----------
async function boot() {
  expenses = await allExpenses();
  await materializeRecurring();
  await migrateRefundCategory();
  migrateCategoryList();
  updateBasePill();
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => go(t.dataset.view)));
  $("#modalClose").addEventListener("click", closeModal);
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
  go(location.hash.replace("#", "") || "dashboard");
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  // Restore the Google connection silently after a refresh (no popup), then
  // pull any changes synced from other devices.
  if (settings.googleClientId) {
    GM.silentConnect(settings.googleClientId, settings.googleEmail).then((ok) => {
      if (!ok) return;
      const cur = location.hash.replace("#", "") || "dashboard";
      if (cur === "settings" || cur === "import") go(cur);
      runSync(true);
    }).catch(() => {});
  }
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

// One-time cleanup: the short-lived "Refund" category is gone — re-categorize
// any refunds by their merchant and drop the stray category.
async function migrateRefundCategory() {
  const refs = expenses.filter((e) => e.category === "Refund");
  if (!refs.length && !(settings.categories || []).includes("Refund")) return;
  for (const e of refs) { e.category = guessCategory(e.description) || ""; e.updatedAt = Date.now(); }
  if (refs.length) { await putMany(refs); expenses = await allExpenses(); }
  if ((settings.categories || []).includes("Refund")) {
    settings.categories = settings.categories.filter((c) => c !== "Refund");
    saveSettings(settings); await markPrefsChanged();
  }
  if (refs.length) scheduleSync();
}

// Ensure any newly-shipped default categories (e.g. "Sports") show up in the
// dropdowns for users whose saved category list predates them. Adds missing
// defaults just before "Other" and keeps the user's own custom categories.
function migrateCategoryList() {
  const cur = settings.categories || [];
  const missing = DEFAULT_CATEGORIES.filter((c) => !cur.includes(c));
  if (!missing.length) return;
  const at = cur.indexOf("Other");
  if (at === -1) settings.categories = [...cur, ...missing];
  else settings.categories = [...cur.slice(0, at), ...missing, ...cur.slice(at)];
  saveSettings(settings);
  markPrefsChanged();
}

// Retroactively re-file forex fees + GST already saved: run the same linking
// over stored expenses (grouped by card, scoped by the 0–2 day windows), and
// move any fee still sitting in "Fees & Interest" into its purchase's current
// category. Only fee rows are touched; purchases and manual edits are left be.
async function reapplyFeeAttribution() {
  if (!confirm("Re-file foreign-currency fees and GST on your saved transactions under the purchase they belong to?\n\nOnly fees currently in \"Fees & Interest\" are moved; nothing else changes.")) return;
  const clones = expenses.map((e) => ({ ...e }));
  linkFeesToPurchases(clones, true, { flag: false });
  const changed = [];
  for (let i = 0; i < clones.length; i++) {
    const before = expenses[i], after = clones[i];
    if (after.category !== before.category &&
        (before.category === "Fees & Interest" || !before.category) &&
        after.category && after.category !== "Fees & Interest") {
      changed.push({ ...before, category: after.category, updatedAt: Date.now() });
    }
  }
  if (!changed.length) { toast("No fees needed re-filing", "ok"); return; }
  await putMany(changed);
  expenses = await allExpenses();
  scheduleSync();
  renderSettings();
  toast(`Re-filed ${changed.length} fee/GST transaction(s) ✓`, "ok");
}

// ---- Recurring monthly expenses ----
// Materialize a real expense for every month from each template's start month
// up to the current month. IDs are deterministic (recur_<tpl>_<YYYY-MM>) so
// re-running or syncing across devices never creates duplicates.
async function materializeRecurring() {
  const list = settings.recurring || [];
  if (!list.length) return;
  const curMonth = new Date().toISOString().slice(0, 7);
  const existing = new Set(
    expenses.filter((e) => e.recurringId).map((e) => `${e.recurringId}|${e.date.slice(0, 7)}`)
  );
  const toCreate = [];
  for (const t of list) {
    if (t.active === false || !t.startMonth) continue;
    let [y, m] = t.startMonth.split("-").map(Number);
    let guard = 0;
    while (guard++ < 600) {
      const mk = `${y}-${String(m).padStart(2, "0")}`;
      if (mk > curMonth || (t.endMonth && mk > t.endMonth)) break;
      if (!existing.has(`${t.id}|${mk}`)) {
        const dim = new Date(y, m, 0).getDate();
        const day = Math.min(Math.max(1, t.dayOfMonth || 1), dim);
        const e = {
          id: `recur_${t.id}_${mk}`, date: `${mk}-${String(day).padStart(2, "0")}`,
          description: t.description, amount: Math.abs(Number(t.amount) || 0),
          currency: t.currency || settings.baseCurrency,
          category: t.category || guessCategory(t.description) || "Other",
          card: t.paidVia || "Recurring", kind: "expense", source: "recurring",
          recurringId: t.id, createdAt: new Date().toISOString(), updatedAt: Date.now(),
          dedupeKey: `recurring|${t.id}|${mk}`,
        };
        if (e.amount > 0) toCreate.push(e);
      }
      m++; if (m > 12) { m = 1; y++; }
    }
  }
  if (toCreate.length) {
    await putMany(toCreate);
    expenses = await allExpenses();
    scheduleSync();
  }
}

// ---- Google Drive sync helpers ----
let syncTimer;
function scheduleSync() {
  if (!settings.autoSync || !GM.isSignedIn()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(true), 2500);
}

async function rememberGoogleEmail() {
  try {
    const email = await GM.getProfileEmail();
    if (email && email !== settings.googleEmail) { settings.googleEmail = email; saveSettings(settings); }
  } catch {}
}

async function runSync(silent) {
  if (!GM.isSignedIn()) { if (!silent) toast("Connect your Google account first", "err"); return; }
  try {
    if (!silent) toast("Syncing…");
    await syncNow();
    expenses = await allExpenses();
    settings = loadSettings();
    updateBasePill();
    const cur = location.hash.replace("#", "") || "dashboard";
    if (!silent || cur === "dashboard" || cur === "expenses") go(cur);
    if (!silent) toast("Synced ✓", "ok");
  } catch (e) {
    toast("Sync failed: " + e.message, "err");
  }
}

// ---------- Dashboard: period × category spend table ----------
let dashGran = "month"; // "week" | "month" | "year"

function periodKey(dateStr, gran) {
  if (gran === "year") return dateStr.slice(0, 4);
  if (gran === "month") return dateStr.slice(0, 7);
  // ISO week, e.g. 2026-W32
  const d = new Date(dateStr + "T00:00:00Z");
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3); // nearest Thursday
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((d - firstThu) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function renderDashboard() {
  if (!expenses.length) {
    views.innerHTML = emptyState();
    $("#emptyImport")?.addEventListener("click", () => go("import"));
    $("#emptyAdd")?.addEventListener("click", () => go("add"));
    return;
  }
  // Pivot: period -> category -> net spend (base currency).
  const byPeriodCat = {}, catTotals = {}, periodTotals = {};
  for (const e of expenses) {
    const b = spendBase(e);
    if (b == null || b === 0) continue;
    const pk = periodKey(e.date, dashGran);
    const cat = e.category || "Uncategorized";
    (byPeriodCat[pk] ||= {})[cat] = (byPeriodCat[pk][cat] || 0) + b;
    catTotals[cat] = (catTotals[cat] || 0) + b;
    periodTotals[pk] = (periodTotals[pk] || 0) + b;
  }
  const periods = Object.keys(periodTotals).sort().reverse();
  const cats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const grand = Object.values(periodTotals).reduce((a, b) => a + b, 0);
  const num = (v) => (v || v === 0) ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
  const cell = (v) => v ? num(v) : '<span class="muted">—</span>';
  const colLabel = dashGran === "year" ? "Year" : dashGran === "week" ? "Week" : "Month";

  views.innerHTML = `
    <div class="card">
      <div class="flex" style="justify-content:space-between;align-items:center">
        <div class="section-title" style="margin:0">Spend by category · ${settings.baseCurrency}</div>
        <div class="pill-tabs" style="margin:0">
          ${["week", "month", "year"].map((g) => `<button class="btn sm ${dashGran === g ? "" : "secondary"}" data-gran="${g}">${g[0].toUpperCase() + g.slice(1)}</button>`).join("")}
        </div>
      </div>
      <div class="table-wrap mt">
        <table class="data pivot">
          <thead><tr>
            <th>${colLabel}</th><th class="amount">Total</th>
            ${cats.map((c) => `<th class="amount">${esc(c)}</th>`).join("")}
          </tr></thead>
          <tbody>
            ${periods.map((pk) => `<tr>
              <td><b>${pk}</b></td>
              <td class="amount"><b>${num(periodTotals[pk] || 0)}</b></td>
              ${cats.map((c) => `<td class="amount">${cell(byPeriodCat[pk]?.[c])}</td>`).join("")}
            </tr>`).join("")}
          </tbody>
          <tfoot><tr>
            <td><b>All ${colLabel.toLowerCase()}s</b></td>
            <td class="amount"><b>${num(grand)}</b></td>
            ${cats.map((c) => `<td class="amount"><b>${num(catTotals[c])}</b></td>`).join("")}
          </tr></tfoot>
        </table>
      </div>
      <div class="hint mt">Net spend in ${settings.baseCurrency}: refunds and other credits reduce the total (kept in the merchant's category); only card-bill payments are excluded.</div>
    </div>`;

  $$("[data-gran]").forEach((b) => b.addEventListener("click", () => { dashGran = b.dataset.gran; renderDashboard(); }));
}

function emptyState() {
  return `<div class="card empty">
    <div class="big">💸</div>
    <h2>Let's track some expenses</h2>
    <p class="muted">Import credit-card statements from Gmail, or add your fixed monthly expenses (rent, house help, cook).</p>
    <div class="flex" style="justify-content:center;margin-top:14px">
      <button class="btn" id="emptyImport">Import from Gmail</button>
      <button class="btn secondary" id="emptyAdd">Add fixed expense</button>
    </div>
  </div>`;
}

// ---------- Expenses list ----------
let expFilter = { q: "", month: "", card: "", cat: "", merchant: "" };
function renderExpenses() {
  const cards = [...new Set(expenses.map((e) => e.card).filter(Boolean))].sort();
  const months = [...new Set(expenses.map((e) => e.date.slice(0, 7)))].sort().reverse();

  // Category & merchant facets with counts, ordered by frequency (desc).
  const countBy = (fn) => {
    const m = {};
    for (const e of expenses) { const k = fn(e); m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const catCounts = countBy((e) => e.category || "Uncategorized");
  const merchCounts = countBy((e) => e.description || "—");

  const filtered = expenses.filter((e) => {
    if (expFilter.q && !(`${e.description} ${e.card}`.toLowerCase().includes(expFilter.q.toLowerCase()))) return false;
    if (expFilter.month && e.date.slice(0, 7) !== expFilter.month) return false;
    if (expFilter.card && e.card !== expFilter.card) return false;
    if (expFilter.cat && (e.category || "Uncategorized") !== expFilter.cat) return false;
    if (expFilter.merchant && (e.description || "—") !== expFilter.merchant) return false;
    return true;
  });
  const totalBase = filtered.reduce((a, e) => a + (spendBase(e) || 0), 0);

  views.innerHTML = `
    <div class="card">
      <div class="flex">
        <input id="fq" placeholder="Search merchant / card…" value="${esc(expFilter.q)}" style="flex:1;min-width:180px;padding:9px 12px;border:1px solid var(--border);border-radius:10px;background:var(--panel-2)">
        <select id="fmonth" class="fsel"><option value="">All months</option>${months.map((m) => `<option ${expFilter.month === m ? "selected" : ""}>${m}</option>`).join("")}</select>
        <select id="fcard" class="fsel"><option value="">All cards</option>${cards.map((c) => `<option ${expFilter.card === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <select id="fcat" class="fsel"><option value="">All categories</option>${catCounts.map(([c, n]) => `<option value="${esc(c)}" ${expFilter.cat === c ? "selected" : ""}>${esc(c)} (${n})</option>`).join("")}</select>
        <select id="fmerchant" class="fsel" style="max-width:260px"><option value="">All merchants</option>${merchCounts.map(([m, n]) => `<option value="${esc(m)}" ${expFilter.merchant === m ? "selected" : ""}>${esc(m)} (${n})</option>`).join("")}</select>
        <button class="btn sm secondary" id="fclear">Clear</button>
        <span class="spacer"></span>
        <button class="btn sm" id="expCsv">Export CSV</button>
      </div>
      <div class="hint mt">${filtered.length} transaction(s) · spend total ${fmtBase(totalBase, settings)}</div>
      <div class="table-wrap mt">
        <table class="data">
          <thead><tr>
            <th>Date</th><th>Description</th><th>Category</th><th>Card / Source</th>
            <th class="amount">Amount</th><th class="amount">In ${settings.baseCurrency}</th><th>Spend</th><th></th>
          </tr></thead>
          <tbody>${filtered.map(rowHtml).join("") || `<tr><td colspan="8" class="hint" style="padding:24px">No matching transactions.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  $("#fq").addEventListener("input", (e) => { expFilter.q = e.target.value; debouncedExp(); });
  ["fmonth", "fcard", "fcat", "fmerchant"].forEach((id) => $("#" + id).addEventListener("change", (e) => {
    expFilter[id.slice(1)] = e.target.value; renderExpenses();
  }));
  $("#fclear").addEventListener("click", () => { expFilter = { q: "", month: "", card: "", cat: "", merchant: "" }; renderExpenses(); });
  $("#expCsv").addEventListener("click", () => exportCsv(filtered));
  $$(".catsel").forEach((sel) => sel.addEventListener("change", async (e) => {
    const exp = expenses.find((x) => x.id === e.target.dataset.id);
    if (!exp) return;
    let val = e.target.value;
    if (val === "__new__") {
      const added = addCategory(window.prompt("New category name:"));
      if (!added) { renderExpenses(); return; }
      val = added;
    }
    exp.category = val; exp.updatedAt = Date.now(); await putExpense(exp); scheduleSync();
    renderExpenses(); // re-render so the new category shows in every dropdown
    toast("Category updated", "ok");
  }));
  $$(".del").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm("Delete this transaction?")) return;
    await deleteExpense(b.dataset.id);
    await recordDeletion(b.dataset.id);
    expenses = expenses.filter((x) => x.id !== b.dataset.id);
    scheduleSync();
    renderExpenses();
  }));
  // .fsel styled via CSS
}
let _t;
function debouncedExp() { clearTimeout(_t); _t = setTimeout(renderExpenses, 250); }

// How a row affects the spend total, mirroring spendBase() exactly, so the
// user can see at a glance what's counted and what isn't.
function spendStatus(e) {
  const base = toBase(e.amount, e.currency, settings);
  if (e.category === "Card Payment")
    return { txt: "excluded", cls: "muted", title: "Card-bill payment — never counted toward spend" };
  if (base == null)
    return { txt: "skipped", cls: "warn", title: `No FX rate for ${e.currency} — not counted. Add a rate in Settings.` };
  if (e.kind === "credit")
    return { txt: "reduces −", cls: "credit", title: "Credit (refund/cashback) — reduces spend, kept in its category" };
  return { txt: "counts +", cls: "debit", title: "Counted toward spend" };
}

function rowHtml(e) {
  const base = toBase(e.amount, e.currency, settings); // AED value for both debits & credits
  const cls = e.kind === "credit" ? "credit" : "debit";
  const st = spendStatus(e);
  const catOpts = catOptionsHtml(e.category);
  return `<tr>
    <td>${e.date}</td>
    <td>${esc(e.description)}${e.kind === "credit" ? ' <span class="chip src-alert">credit</span>' : ""}</td>
    <td><select class="catsel" data-id="${e.id}">${catOpts}</select></td>
    <td>${esc(e.card || "—")} <span class="chip src-${e.source === "manual" ? "manual" : e.source === "recurring" ? "recurring" : e.source === "alert" ? "alert" : "statement"}">${srcLabel(e.source)}</span></td>
    <td class="amount ${cls}">${e.kind === "credit" ? "+" : ""}${fmt(e.amount, e.currency)}</td>
    <td class="amount ${cls}">${base == null ? '<span class="chip" title="No FX rate for ' + e.currency + '">no rate</span>' : (e.kind === "credit" ? "+" : "") + fmtBase(base, settings)}</td>
    <td><span class="chip spend-${st.cls}" title="${esc(st.title)}">${st.txt}</span></td>
    <td class="right"><button class="icon-btn del" data-id="${e.id}" title="Delete">🗑</button></td>
  </tr>`;
}
function srcLabel(s) { return s === "manual" ? "manual" : s === "recurring" ? "recurring" : s === "alert" ? "alert" : "statement"; }

// ---------- Fixed monthly expenses (tab: "Fixed expenses") ----------
function renderAdd() {
  const cur = new Date().toISOString().slice(0, 7);
  const list = settings.recurring || [];
  views.innerHTML = `
    <div class="card" style="max-width:940px;margin:0 auto">
      <div class="section-title">Fixed monthly expenses (not on a card)</div>
      <p class="hint">Rent, house help, cook, or anything you pay in cash/bank every month — added automatically each month and back-filled from the start month. Set an <b>end month</b> for things that stop or change (e.g. when rent renews at a new amount, end the old one and add a new one).</p>
      <div class="row mt" style="align-items:flex-end">
        <div class="field" style="flex:2;min-width:150px"><label>Description</label><input id="rcDesc" placeholder="e.g. Apartment rent"></div>
        <div class="field" style="max-width:120px"><label>Amount</label><input id="rcAmount" type="number" step="0.01" min="0" placeholder="0.00"></div>
        <div class="field" style="max-width:100px"><label>Currency</label><select id="rcCur">${currencyOptions(settings.baseCurrency)}</select></div>
        <div class="field" style="max-width:80px"><label>Day</label><input id="rcDay" type="number" min="1" max="31" value="1"></div>
      </div>
      <div class="row" style="align-items:flex-end">
        <div class="field"><label>Category</label><select id="rcCat"><option value="">— auto —</option>${sortedCats().map((c) => `<option>${esc(c)}</option>`).join("")}</select></div>
        <div class="field"><label>Paid via</label><input id="rcPaid" placeholder="Cash / Bank transfer"></div>
        <div class="field" style="max-width:150px"><label>Starting</label><input id="rcStart" type="month" value="${cur}"></div>
        <div class="field" style="max-width:150px"><label>Ending (optional)</label><input id="rcEnd" type="month"></div>
        <div class="field" style="max-width:120px"><label>&nbsp;</label><button class="btn" id="rcAdd">Add</button></div>
      </div>
      ${list.length ? `
      <div class="table-wrap mt"><table class="data"><thead><tr>
        <th>Description</th><th class="amount">Amount</th><th>Day</th><th>Category</th><th>Paid via</th><th>Start</th><th>End</th><th></th>
      </tr></thead><tbody>
        ${list.map((t) => `<tr${t.active === false ? ' class="muted"' : ""}>
          <td>${esc(t.description)}</td>
          <td class="amount">${fmt(t.amount, t.currency)}</td>
          <td>${t.dayOfMonth || 1}</td>
          <td>${esc(t.category || "—")}</td>
          <td>${esc(t.paidVia || "—")}</td>
          <td class="hint">${esc(t.startMonth || "")}${t.active === false ? " · paused" : ""}</td>
          <td><input type="month" class="cellin recEnd" data-id="${t.id}" value="${t.endMonth || ""}" style="width:150px"></td>
          <td class="right"><button class="btn sm secondary recToggle" data-id="${t.id}">${t.active === false ? "Resume" : "Pause"}</button> <button class="icon-btn recDel" data-id="${t.id}" title="Delete">🗑</button></td>
        </tr>`).join("")}
      </tbody></table></div>` : `<div class="hint mt">No fixed monthly expenses yet — add one above.</div>`}
    </div>`;

  $("#rcAdd").addEventListener("click", addRecurring);
  $$(".recEnd").forEach((el) => el.addEventListener("change", async () => {
    const t = (settings.recurring || []).find((x) => x.id === el.dataset.id);
    if (!t) return;
    t.endMonth = el.value || undefined;
    saveSettings(settings); await markPrefsChanged();
    // Remove any already-generated entries beyond the new end month.
    if (t.endMonth) {
      const beyond = expenses.filter((e) => e.recurringId === t.id && e.date.slice(0, 7) > t.endMonth);
      for (const e of beyond) { await deleteExpense(e.id); await recordDeletion(e.id); }
    }
    await materializeRecurring();
    expenses = await allExpenses();
    scheduleSync(); renderAdd();
  }));
  $$(".recToggle").forEach((b) => b.addEventListener("click", async () => {
    const t = (settings.recurring || []).find((x) => x.id === b.dataset.id);
    if (!t) return;
    t.active = t.active === false;
    saveSettings(settings); await markPrefsChanged();
    await materializeRecurring(); scheduleSync(); renderAdd();
  }));
  $$(".recDel").forEach((b) => b.addEventListener("click", async () => {
    const t = (settings.recurring || []).find((x) => x.id === b.dataset.id);
    if (!t) return;
    const own = expenses.filter((e) => e.recurringId === t.id);
    if (!confirm(`Delete "${t.description}" and its ${own.length} generated entr${own.length === 1 ? "y" : "ies"}?`)) return;
    settings.recurring = (settings.recurring || []).filter((x) => x.id !== t.id);
    saveSettings(settings); await markPrefsChanged();
    for (const e of own) { await deleteExpense(e.id); await recordDeletion(e.id); }
    expenses = await allExpenses(); scheduleSync(); renderAdd();
  }));
}

async function addRecurring() {
  const desc = $("#rcDesc").value.trim();
  const amount = parseFloat($("#rcAmount").value);
  if (!desc) return toast("Add a description", "err");
  if (!isFinite(amount) || amount <= 0) return toast("Enter a valid amount", "err");
  const start = $("#rcStart").value || new Date().toISOString().slice(0, 7);
  const end = $("#rcEnd").value || undefined;
  if (end && end < start) return toast("End month is before the start month", "err");
  const tpl = {
    id: uid(), description: desc, amount: Math.abs(amount), currency: $("#rcCur").value,
    category: $("#rcCat").value || guessCategory(desc), paidVia: $("#rcPaid").value.trim() || "Cash",
    dayOfMonth: Math.min(31, Math.max(1, parseInt($("#rcDay").value, 10) || 1)),
    startMonth: start, endMonth: end, active: true,
  };
  settings.recurring = [...(settings.recurring || []), tpl];
  saveSettings(settings); await markPrefsChanged();
  await materializeRecurring(); scheduleSync();
  toast("Monthly expense added ✓", "ok");
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
      ${(() => {
        const spName = settings.spouseName || "theirs";
        const chip = (s) => `<label class="chip" style="cursor:pointer;user-select:none"><input type="checkbox" class="srcChk" value="${s.bank}" ${settings.enabledSources.includes(s.bank) ? "checked" : ""} style="margin-right:6px">${esc(s.label)}${s.spouseOnly ? ` <span class="chip-sub">(${esc(spName)})</span>` : ""}</label>`;
        const vis = (s) => s.kind === "statement" && (!s.spouseOnly || settings.spouseEnabled);
        const cc = SOURCES.filter((s) => vis(s) && !s.acct);
        const acct = SOURCES.filter((s) => vis(s) && s.acct);
        return `
        <div class="pill-group-label mt">Credit cards</div>
        <div class="pill-tabs">${cc.map(chip).join("")}</div>
        <div class="pill-group-label mt">Bank-account statements</div>
        <div class="pill-tabs">${acct.map(chip).join("")}</div>`;
      })()}
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
      <label class="flex mt" style="gap:6px;cursor:pointer"><input type="checkbox" id="impReplace"> Re-import &amp; replace already-imported transactions <span class="hint">(re-applies the latest parsing/categories; overwrites those statements, including any manual edits on them)</span></label>
      <label class="flex mt" style="gap:6px;cursor:pointer"><input type="checkbox" id="impDebug"> Show raw statement text (debug — helps me fix parsing, e.g. missing cashback)</label>
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
    try {
      setLog("Opening Google sign-in…");
      await GM.connect(settings.googleClientId, settings.googleEmail);
      await rememberGoogleEmail();
      toast("Connected ✓", "ok");
      renderImport();
      if (settings.autoSync) runSync(false); // pull any data synced from other devices
    } catch (e) { setLog(""); toast(e.message, "err"); }
  });
  $("#disconnectBtn")?.addEventListener("click", () => { GM.disconnect(); renderImport(); });
  $("#fetchBtn")?.addEventListener("click", fetchAndParse);
}

function setLog(html) { const el = $("#importLog"); if (el) el.innerHTML = html; }

// Keep the phone screen awake during an import so locking it doesn't suspend
// the tab (and its in-flight requests). The lock is auto-released when the tab
// is hidden, so re-acquire it whenever we come back while still importing.
let _wakeLock = null;
let _importing = false;
async function keepAwake() {
  try { if ("wakeLock" in navigator) _wakeLock = await navigator.wakeLock.request("screen"); } catch {}
}
async function releaseAwake() {
  try { if (_wakeLock) await _wakeLock.release(); } catch {}
  _wakeLock = null;
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && _importing && !_wakeLock) {
    try { _wakeLock = await navigator.wakeLock.request("screen"); } catch {}
  }
});

async function fetchAndParse() {
  const chosen = SOURCES.filter((s) => settings.enabledSources.includes(s.bank));
  if (!chosen.length) return toast("Pick at least one source", "err");
  const after = new Date();
  after.setMonth(after.getMonth() - settings.lookbackMonths);
  const afterStr = `${after.getFullYear()}/${after.getMonth() + 1}/${after.getDate()}`;

  const existing = await existingDedupeKeys();
  const debug = $("#impDebug")?.checked;
  reviewReplace = !!$("#impReplace")?.checked;
  const debugRaw = [];
  const parsed = [];
  const problems = [];
  $("#reviewArea").innerHTML = "";

  const spLabel = settings.spouseEnabled && settings.spouseLabel ? settings.spouseLabel : "";
  const spName = settings.spouseName || "Spouse";

  // Fetch + parse one owner "spec" for a source.
  async function runSpec(src, spec) {
    const q = `from:${src.from} ${src.query || ""} ${spec.labelQuery || ""} has:attachment filename:pdf after:${afterStr}`.replace(/\s+/g, " ").trim();
    setLog(`Searching ${esc(spec.cardLabel)}…`);
    const ids = await GM.searchMessages(q, 60);
    setLog(`Found ${ids.length} statement email(s) for ${esc(spec.cardLabel)}. Reading…`);
    for (let i = 0; i < ids.length; i++) {
      setLog(`${esc(spec.cardLabel)}: reading statement ${i + 1}/${ids.length}…`);
      const msg = await GM.getMessage(ids[i]);
      const { pdfs } = GM.extractParts(msg);
      if (!pdfs.length) continue;
      const rows = [];
      for (const att of pdfs) {
        if (src.fileMatch && !new RegExp(src.fileMatch, "i").test(att.filename)) continue;
        try {
          const bytes = await GM.getAttachment(ids[i], att.attachmentId);
          const { lines } = await extractText(bytes, spec.password || "");
          if (debug) debugRaw.push({ label: spec.cardLabel, filename: att.filename, lines });
          rows.push(...parseStatementByBank(src.bank, lines, { currency: src.currency, card: spec.cardLabel }));
        } catch (err) {
          if (err instanceof PdfPasswordError) {
            problems.push(`🔒 ${spec.cardLabel}: ${att.filename} needs a password. Add it in Settings (${src.passwordHint || "see the email"}).`);
          } else {
            problems.push(`⚠️ ${spec.cardLabel}: couldn't read ${att.filename} — ${err.message}`);
          }
        }
      }
      for (const r of rows) {
        r.source = src.kind; r.bank = src.bank; r.owner = spec.owner;
        r.card = spec.cardLabel; r.gmailMessageId = ids[i];
        // Add-on / secondary card on the same statement → tag it to that
        // cardholder (first name from the statement's section header).
        if (r.secondaryHolder) {
          const fn = (r.secondaryHolder.split(/\s+/)[0] || "");
          const nice = fn ? fn.charAt(0).toUpperCase() + fn.slice(1).toLowerCase() : "";
          if (nice) { r.card = `${spec.cardLabel} (${nice})`; r.owner = "spouse"; }
        }
        r.category = r.category || guessCategory(r.description);
      }
      // Attribute forex fees + GST to the purchase they were levied on (uses
      // final categories & card labels), unless the user turned this off.
      linkFeesToPurchases(rows, settings.attributeFees !== false);
      for (const r of rows) {
        r.dedupeKey = dedupeKey({ ...r, source: src.kind });
        r._dup = existing.has(r.dedupeKey);
      }
      parsed.push(...rows);
    }
  }

  _importing = true;
  await keepAwake();
  try {
    for (const src of chosen) {
      try {
        const specs = [];
        if (spLabel) {
          if (!src.spouseOnly) specs.push({ labelQuery: `-label:"${spLabel}"`, cardLabel: src.label, password: settings.passwords[src.bank] || "", owner: "me" });
          if (src.shared || src.spouseOnly) specs.push({ labelQuery: `label:"${spLabel}"`, cardLabel: `${src.label} (${spName})`, password: (settings.spousePasswords || {})[src.bank] || "", owner: "spouse" });
        } else if (!src.spouseOnly) {
          specs.push({ labelQuery: "", cardLabel: src.label, password: settings.passwords[src.bank] || "", owner: "me" });
        }
        for (const spec of specs) await runSpec(src, spec);
      } catch (e) {
        problems.push(`⚠️ ${src.label}: ${e.message}`);
      }
    }
  } finally {
    _importing = false;
    await releaseAwake();
  }

  setLog("");
  renderReview(parsed, problems);
  if (debug && debugRaw.length) {
    const block = debugRaw.map((d) =>
      `<details style="margin-top:10px"><summary style="cursor:pointer">${esc(d.label)} — ${esc(d.filename)} (${d.lines.length} lines)</summary>` +
      `<pre style="white-space:pre-wrap;max-height:320px;overflow:auto;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12px;margin-top:8px">${esc(d.lines.join("\n"))}</pre></details>`
    ).join("");
    $("#reviewArea").insertAdjacentHTML("beforeend",
      `<div class="card mt"><div class="section-title">Raw statement text (debug)</div><p class="hint">Expand a statement and copy the line for anything that's parsing wrong (e.g. cashback) — paste it to me and I'll fix the parser.</p>${block}</div>`);
  }
}

let reviewRows = [];
let revFilter = { q: "", source: "", needsOnly: false, cat: "", merchant: "" };
let reviewReplace = false; // "re-import & replace" mode chosen for this run

function renderReview(rows, problems) {
  // Replace mode: show every parsed row (including already-imported ones) so
  // they can overwrite the saved copies. Normal mode: hide already-imported.
  const fresh = reviewReplace ? rows : rows.filter((r) => !r._dup);
  // Default: auto-select clean rows; leave "needs review" rows unticked so
  // you consciously include them after checking.
  fresh.forEach((r) => { if (r._sel === undefined) r._sel = !r.needsReview; });
  reviewRows = fresh;
  revFilter = { q: "", source: "", needsOnly: false, cat: "", merchant: "" };
  const dupCount = rows.length - fresh.length;
  const area = $("#reviewArea");
  if (!rows.length) {
    area.innerHTML = `<div class="card">
      ${problems.map((p) => `<div class="warnbox mt">${esc(p)}</div>`).join("") || ""}
      <div class="empty"><div class="big">🔍</div><p class="muted">No transactions parsed. If you have statements, check that the PDF password is set in Settings.</p></div>
    </div>`;
    return;
  }
  const sources = [...new Set(fresh.map((r) => r.card).filter(Boolean))].sort();
  const facet = (fn) => {
    const m = {};
    for (const r of fresh) { const k = fn(r); m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const revCats = facet((r) => r.category || "Uncategorized");
  const revMerch = facet((r) => r.description || "—");
  area.innerHTML = `<div class="card">
    <div class="flex">
      <div class="section-title" style="margin:0">Review imported transactions</div>
      <span class="spacer"></span>
      <button class="btn sm secondary" id="revAll">Select shown</button>
      <button class="btn sm secondary" id="revNone">Clear shown</button>
      <button class="btn" id="revSave">Save selected</button>
    </div>
    ${reviewReplace ? `<div class="warnbox mt">Replace mode: saving will overwrite existing transactions from these statements with the freshly-parsed versions.</div>` : (dupCount ? `<div class="hint mt">${dupCount} already-imported transaction(s) hidden.</div>` : "")}
    ${problems.map((p) => `<div class="warnbox mt">${esc(p)}</div>`).join("")}
    <div class="flex mt">
      <input id="revSearch" placeholder="Search description / card…" style="flex:1;min-width:160px;padding:9px 12px;border:1px solid var(--border);border-radius:10px;background:var(--panel-2)">
      <select id="revSource" class="fsel"><option value="">All sources</option>${sources.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
      <select id="revCat" class="fsel"><option value="">All categories</option>${revCats.map(([c, n]) => `<option value="${esc(c)}" ${revFilter.cat === c ? "selected" : ""}>${esc(c)} (${n})</option>`).join("")}</select>
      <select id="revMerchant" class="fsel" style="max-width:240px"><option value="">All merchants</option>${revMerch.map(([m, n]) => `<option value="${esc(m)}" ${revFilter.merchant === m ? "selected" : ""}>${esc(m)} (${n})</option>`).join("")}</select>
      <label class="flex" style="gap:6px;cursor:pointer"><input type="checkbox" id="revNeedsOnly"> Needs review only</label>
      <span class="spacer"></span>
      <span class="hint" id="revCounts"></span>
    </div>
    <div class="table-wrap mt">
      <table class="data">
        <thead><tr>
          <th style="width:26px"></th><th>Date</th><th>Description</th>
          <th class="amount">Amount</th><th>Cur</th><th>Type</th><th>Category</th><th>Source</th><th>Review</th>
        </tr></thead>
        <tbody id="revBody"></tbody>
      </table>
    </div>
  </div>`;

  // .fsel styled via CSS
  $("#revSearch").addEventListener("input", (e) => { revFilter.q = e.target.value; renderRevBody(); });
  $("#revSource").addEventListener("change", (e) => { revFilter.source = e.target.value; renderRevBody(); });
  $("#revCat").addEventListener("change", (e) => { revFilter.cat = e.target.value; renderRevBody(); });
  $("#revMerchant").addEventListener("change", (e) => { revFilter.merchant = e.target.value; renderRevBody(); });
  $("#revNeedsOnly").addEventListener("change", (e) => { revFilter.needsOnly = e.target.checked; renderRevBody(); });
  $("#revAll").addEventListener("click", () => { filteredRev().forEach(({ r }) => (r._sel = true)); renderRevBody(); });
  $("#revNone").addEventListener("click", () => { filteredRev().forEach(({ r }) => (r._sel = false)); renderRevBody(); });
  $("#revSave").addEventListener("click", saveReview);
  renderRevBody();
}

function filteredRev() {
  const q = revFilter.q.toLowerCase();
  return reviewRows.map((r, i) => ({ r, i })).filter(({ r }) => {
    if (q && !(`${r.description} ${r.card}`.toLowerCase().includes(q))) return false;
    if (revFilter.source && r.card !== revFilter.source) return false;
    if (revFilter.cat && (r.category || "Uncategorized") !== revFilter.cat) return false;
    if (revFilter.merchant && (r.description || "—") !== revFilter.merchant) return false;
    if (revFilter.needsOnly && !r.needsReview) return false;
    return true;
  });
}

function renderRevBody() {
  const body = $("#revBody");
  if (!body) return;
  const rows = filteredRev();
  body.innerHTML = rows.map(({ r, i }) => reviewRowHtml(r, i)).join("") ||
    `<tr><td colspan="9" class="hint" style="padding:20px">No rows match this filter.</td></tr>`;
  updateRevCounts();
  body.querySelectorAll("[data-f]").forEach((el) => el.addEventListener("input", () => {
    const i = +el.dataset.i, f = el.dataset.f;
    if (!reviewRows[i]) return;
    if (f === "category" && el.value === "__new__") {
      const added = addCategory(window.prompt("New category name:"));
      if (added) reviewRows[i].category = added;
      renderRevBody(); // re-render so the new category shows in every dropdown
      return;
    }
    reviewRows[i][f] = f === "amount" ? parseFloat(el.value) : el.value;
  }));
  body.querySelectorAll(".revChk").forEach((c) => c.addEventListener("change", () => {
    const i = +c.dataset.i;
    if (reviewRows[i]) reviewRows[i]._sel = c.checked;
    updateRevCounts();
  }));
}

function updateRevCounts() {
  const el = $("#revCounts");
  if (!el) return;
  const total = reviewRows.length;
  const shown = filteredRev().length;
  const sel = reviewRows.filter((r) => r._sel).length;
  const need = reviewRows.filter((r) => r.needsReview).length;
  el.innerHTML = `Showing <b>${shown}</b> of ${total} · <b>${sel}</b> selected` +
    (need ? ` · <span style="color:var(--warn)">${need} need review</span>` : "");
}

function reviewRowHtml(r, i) {
  const cats = catOptionsHtml(r.category);
  return `<tr class="${r.needsReview ? "revneeds" : ""}">
    <td><input type="checkbox" class="revChk" data-i="${i}" ${r._sel ? "checked" : ""}></td>
    <td><input type="date" class="cellin" data-i="${i}" data-f="date" value="${r.date}"></td>
    <td><input class="cellin" data-i="${i}" data-f="description" value="${esc(r.description)}" style="min-width:200px"></td>
    <td class="amount"><input type="number" step="0.01" class="cellin amt" data-i="${i}" data-f="amount" value="${r.amount}" style="width:96px"></td>
    <td>${esc(r.currency || "?")}</td>
    <td><select class="cellin" data-i="${i}" data-f="kind" style="min-width:104px"><option value="expense" ${r.kind !== "credit" ? "selected" : ""}>Expense</option><option value="credit" ${r.kind === "credit" ? "selected" : ""}>Credit</option></select></td>
    <td><select class="cellin" data-i="${i}" data-f="category">${cats}</select></td>
    <td class="hint" style="white-space:nowrap">${esc(r.card || "")}</td>
    <td>${r.needsReview ? `<span class="chip warn" title="${esc(r.reviewReason || "Check this row")}">review</span>` : `<span class="hint">ok</span>`}</td>
  </tr>`;
}

async function saveReview() {
  const selected = reviewRows.filter((r) => r._sel);
  if (!selected.length) return toast("Nothing selected", "err");
  const toSave = selected.map((r) => {
    const e = {
      id: uid(), date: r.date, description: r.description,
      amount: Math.abs(parseFloat(r.amount) || 0), currency: r.currency,
      category: r.category || guessCategory(r.description), card: r.card,
      kind: r.kind === "credit" ? "credit" : "expense",
      source: r.source, bank: r.bank, gmailMessageId: r.gmailMessageId,
      createdAt: new Date().toISOString(), updatedAt: Date.now(),
    };
    e.dedupeKey = dedupeKey(e);
    return e;
  }).filter((e) => e.amount > 0);

  // Replace mode: wipe the previously-saved transactions from every statement
  // we're re-importing, then insert the fresh ones. Scoped by Gmail message id
  // so only the re-fetched statements are touched (manual/recurring rows and
  // other statements are left alone).
  let removed = 0;
  if (reviewReplace) {
    const msgIds = new Set(toSave.map((e) => e.gmailMessageId).filter(Boolean));
    const stale = expenses.filter((e) => e.gmailMessageId && msgIds.has(e.gmailMessageId));
    for (const e of stale) { await deleteExpense(e.id); await recordDeletion(e.id); }
    removed = stale.length;
  }

  await putMany(toSave);
  expenses = await allExpenses();
  scheduleSync();
  toast(reviewReplace
    ? `Replaced ${removed} with ${toSave.length} transaction(s) ✓`
    : `Imported ${toSave.length} transaction(s) ✓`, "ok");
  reviewReplace = false;
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
        <p class="hint">Bank statement PDFs are encrypted. Passwords sync across your devices through your private Google Drive app folder (readable only by this app).${settings.spouseEnabled ? " A dash means that card isn't that person's." : ""}</p>
        ${pwTable()}
      </div>
    </div>

    <div class="card mt">
      <div class="section-title">Sync across devices (Google Drive)</div>
      <p class="hint">Syncs your data through a private folder in your own Google Drive that only this app can read — expenses, categories, household settings and PDF passwords appear on every device. Only the Google Client ID stays per-device (you enter it once when connecting).</p>
      <div class="flex">
        ${GM.isSignedIn()
          ? `<span class="okbox" style="padding:6px 10px">Google account connected</span><button class="btn" id="syncNow">Sync now</button>`
          : `<button class="btn" id="syncConnect" ${settings.googleClientId ? "" : "disabled"}>Connect Google account</button>`}
        <label class="flex" style="gap:6px;cursor:pointer"><input type="checkbox" id="autoSync" ${settings.autoSync ? "checked" : ""}> Auto-sync on changes</label>
      </div>
      <div class="hint mt" id="syncStatus"></div>
      ${!settings.googleClientId ? `<div class="hint mt">Add your Google Client ID above and press <b>Save settings</b> to enable syncing.</div>` : ""}
    </div>

    <div class="card mt">
      <div class="section-title">Household — a second person's cards</div>
      <p class="hint">If a family member's statements are forwarded into this Gmail with a label (yours aren't), import theirs too — tagged with their name so you can filter by person, all in one household total.</p>
      <label class="flex" style="gap:8px;cursor:pointer;font-weight:600;color:var(--text)"><input type="checkbox" id="spEnabled" ${settings.spouseEnabled ? "checked" : ""}> Also import a second person's cards</label>
      <div id="spOpts" class="mt" style="${settings.spouseEnabled ? "" : "display:none"}">
        <div class="row">
          <div class="field"><label>Their name (tag)</label><input id="spName" value="${esc(settings.spouseName)}" placeholder="e.g. Harshita"></div>
          <div class="field"><label>Gmail label on their forwarded statements</label><input id="spLabel" value="${esc(settings.spouseLabel)}" placeholder="e.g. Harshi Forward"></div>
        </div>
        <p class="hint">Their PDF passwords appear as a second column in the <b>Statement PDF passwords</b> table above once this is on.</p>
      </div>
    </div>

    <div class="grid cols-2 mt">
      <div class="card">
        <div class="section-title">Categories</div>
        <div id="catList" class="flex">${sortedCats().map((c) => `<span class="chip cat">${esc(c)} <button class="icon-btn catDel" data-c="${esc(c)}" style="padding:0 4px">✕</button></span>`).join("")}</div>
        <div class="flex mt"><input id="newCat" placeholder="New category" style="max-width:200px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel-2)"><button class="btn sm secondary" id="addCat">Add</button></div>
        <div class="flex mt" style="border-top:1px solid var(--border);padding-top:12px">
          <button class="btn sm secondary" id="recat">Re-categorize uncategorized</button>
          <span class="hint">${expenses.filter((e) => !e.category).length} uncategorized · applies the current rules to blank categories only</span>
        </div>
        <label class="flex mt" style="gap:8px;cursor:pointer;border-top:1px solid var(--border);padding-top:12px">
          <input type="checkbox" id="attrFees" ${settings.attributeFees !== false ? "checked" : ""}>
          <span>Attribute forex fees &amp; GST to the original purchase's category<br><span class="hint">A foreign-currency fee (and its GST) is filed under the purchase it was charged on, instead of Fees &amp; Interest. Ambiguous ones are left in Fees &amp; Interest and flagged for review.</span></span>
        </label>
        <div class="flex mt"><button class="btn sm secondary" id="reFees">Re-file saved forex fees now</button>
          <span class="hint">Applies the above to transactions you've already imported.</span></div>
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
  $("#recat")?.addEventListener("click", async () => {
    const updated = [];
    for (const e of expenses) {
      if (!e.category) {
        const g = guessCategory(e.description);
        if (g) { e.category = g; e.updatedAt = Date.now(); updated.push(e); }
      }
    }
    if (updated.length) { await putMany(updated); expenses = await allExpenses(); scheduleSync(); }
    toast(`Re-categorized ${updated.length} transaction(s)`, updated.length ? "ok" : "");
    renderSettings();
  });
  $("#reFees")?.addEventListener("click", reapplyFeeAttribution);
  $$(".catDel").forEach((b) => b.addEventListener("click", () => {
    settings.categories = settings.categories.filter((c) => c !== b.dataset.c); renderSettings();
  }));
  $("#syncConnect")?.addEventListener("click", async () => {
    try { await GM.connect(settings.googleClientId, settings.googleEmail); await rememberGoogleEmail(); await runSync(false); renderSettings(); }
    catch (e) { toast(e.message, "err"); }
  });
  $("#syncNow")?.addEventListener("click", () => runSync(false));
  $("#autoSync")?.addEventListener("change", (e) => {
    settings.autoSync = e.target.checked; saveSettings(settings);
    toast(settings.autoSync ? "Auto-sync on" : "Auto-sync off", "ok");
  });
  lastSyncedAt().then((t) => {
    const el = $("#syncStatus");
    if (el) el.textContent = t ? "Last synced " + new Date(t).toLocaleString() : "Not synced yet on this device.";
  });
  $("#expJson").addEventListener("click", exportJson);
  $("#impJson").addEventListener("change", importJson);
  $("#wipe").addEventListener("click", async () => {
    if (!confirm("Delete ALL transactions? This cannot be undone.")) return;
    await clearAll(); expenses = []; toast("All data deleted", "ok"); go("dashboard");
  });
  $("#spEnabled")?.addEventListener("change", (e) => {
    const on = e.target.checked;
    const el = $("#spOpts"); if (el) el.style.display = on ? "" : "none";
    const tbl = $(".pw-table"); if (tbl) tbl.classList.toggle("hide-spouse", !on);
  });
  $("#saveSet").addEventListener("click", async () => {
    settings.baseCurrency = $("#setBase").value;
    settings.googleClientId = $("#setClient").value.trim();
    $$(".rateIn").forEach((el) => { settings.rates[el.dataset.cur] = parseFloat(el.value) || 0; });
    $$(".pwIn").forEach((el) => { settings.passwords[el.dataset.bank] = el.value; });
    settings.spouseEnabled = $("#spEnabled")?.checked || false;
    settings.spouseName = $("#spName")?.value.trim() || "";
    settings.spouseLabel = $("#spLabel")?.value.trim() || "";
    settings.spousePasswords = settings.spousePasswords || {};
    $$(".spPw").forEach((el) => { settings.spousePasswords[el.dataset.bank] = el.value; });
    settings.attributeFees = $("#attrFees")?.checked !== false;
    saveSettings(settings);
    await markPrefsChanged(); // base currency / rates / categories are synced prefs
    updateBasePill();
    scheduleSync();
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
