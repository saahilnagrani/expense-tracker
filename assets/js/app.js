// Main UI controller: routing, views, and wiring for the Expense Tracker.
import {
  allExpenses, putExpense, putMany, deleteExpense, clearAll,
  existingDedupeKeys, loadSettings, saveSettings, uid, recordDeletion, getTombstones,
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
import { initSelectEnhancer } from "./selects.js";
import { icon, hydrateIcons } from "./icons.js";

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

// Human date/month formatting.
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso) { // "2026-01-23" -> "23 Jan 2026"
  const p = String(iso || "").split("-").map(Number);
  return (p.length === 3 && p[0] && p[1] && p[2]) ? `${p[2]} ${MON[p[1] - 1]} ${p[0]}` : (iso || "");
}
function fmtMonth(ym) { // "2026-01" -> "Jan 2026"
  const p = String(ym || "").split("-").map(Number);
  return (p.length >= 2 && p[0] && p[1]) ? `${MON[p[1] - 1]} ${p[0]}` : (ym || "");
}
function fmtPeriod(pk, gran) { return gran === "month" ? fmtMonth(pk) : pk; }

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
  await recoverRecurringTemplates();
  await materializeRecurring();
  await migrateRefundCategory();
  migrateCategoryList();
  updateBasePill();
  hydrateIcons();
  initSelectEnhancer();
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

// Re-check every saved transaction's category against the CURRENT rules (plus
// forex-fee attribution), and show a preview of what would change before
// touching anything. A rule only overrides where it actually matches, so a
// manual category on a merchant no rule covers is left alone.
function recheckCategories() {
  const clones = expenses.map((e) => ({ ...e, category: guessCategory(e.description) || e.category }));
  linkFeesToPurchases(clones, settings.attributeFees !== false, { flag: false });
  const changes = [];
  for (let i = 0; i < clones.length; i++) {
    const before = expenses[i], after = clones[i];
    if ((after.category || "") !== (before.category || "")) {
      changes.push({ id: before.id, desc: before.description, card: before.card,
        from: before.category || "—", to: after.category || "—", newCat: after.category || "" });
    }
  }
  if (!changes.length) { toast("All categories already match the rules ✓", "ok"); return; }
  const rowsHtml = changes.map((c, i) =>
    `<tr><td><input type="checkbox" class="chgChk" data-i="${i}" checked></td><td>${esc(c.desc)}</td><td class="hint" style="white-space:nowrap">${esc(c.card || "")}</td><td class="hint">${esc(c.from)}</td><td>→</td><td><b>${esc(c.to)}</b></td></tr>`).join("");
  openModal(`Re-check categories — ${changes.length} proposed`, `
    <p class="hint">Tick only the changes you want. A rule can misread a noisy description, so review before applying. Amounts never change; merchants no rule matches are left alone.</p>
    <div class="flex" style="gap:8px"><button class="btn sm secondary" id="chgAll">Select all</button><button class="btn sm secondary" id="chgNone">Deselect all</button><span class="spacer"></span><span class="hint" id="chgCount"></span></div>
    <div class="table-wrap mt" style="max-height:50vh;overflow:auto"><table class="data"><thead><tr><th style="width:26px"></th><th>Description</th><th>Card</th><th>From</th><th></th><th>To</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <div class="flex mt" style="justify-content:flex-end;gap:8px"><button class="btn secondary" id="rcCancel">Cancel</button><button class="btn" id="rcApply">Apply selected</button></div>`);
  const updateCount = () => { const n = $$(".chgChk").filter((x) => x.checked).length; const el = $("#chgCount"); if (el) el.textContent = `${n} of ${changes.length} selected`; };
  $$(".chgChk").forEach((c) => c.addEventListener("change", updateCount));
  $("#chgAll").addEventListener("click", () => { $$(".chgChk").forEach((x) => (x.checked = true)); updateCount(); });
  $("#chgNone").addEventListener("click", () => { $$(".chgChk").forEach((x) => (x.checked = false)); updateCount(); });
  updateCount();
  $("#rcCancel").addEventListener("click", closeModal);
  $("#rcApply").addEventListener("click", async () => {
    const pick = new Set($$(".chgChk").filter((x) => x.checked).map((x) => +x.dataset.i));
    const byId = new Map(changes.filter((_, i) => pick.has(i)).map((c) => [c.id, c.newCat]));
    if (!byId.size) { toast("Nothing selected", "err"); return; }
    const updated = expenses.filter((e) => byId.has(e.id))
      .map((e) => ({ ...e, category: byId.get(e.id), updatedAt: Date.now() }));
    await putMany(updated);
    expenses = await allExpenses();
    scheduleSync();
    closeModal();
    toast(`Re-categorized ${updated.length} transaction(s) ✓`, "ok");
    renderSettings();
  });
}

// If a recurring template went missing from settings (e.g. an old sync wiped
// it) but its generated expenses are still in the store, rebuild the template
// from them so it reappears in the Fixed tab. Skips templates the user
// actually deleted (their id is tombstoned).
async function recoverRecurringTemplates() {
  const have = new Set((settings.recurring || []).map((t) => t.id));
  const deleted = await getTombstones().catch(() => ({}));
  const byRid = new Map();
  for (const e of expenses) {
    if (!e.recurringId || have.has(e.recurringId) || deleted[e.recurringId]) continue;
    if (!byRid.has(e.recurringId)) byRid.set(e.recurringId, []);
    byRid.get(e.recurringId).push(e);
  }
  if (!byRid.size) return;
  const recovered = [];
  for (const [rid, list] of byRid) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const rep = list[list.length - 1]; // latest = most current description/amount
    recovered.push({
      id: rid, description: rep.description, amount: Math.abs(Number(rep.amount) || 0),
      currency: rep.currency || settings.baseCurrency, category: rep.category || "",
      paidVia: rep.card || "Recurring", dayOfMonth: Number(rep.date.slice(8, 10)) || 1,
      startMonth: list[0].date.slice(0, 7), active: true,
    });
  }
  settings.recurring = [...(settings.recurring || []), ...recovered];
  saveSettings(settings);
  await markPrefsChanged();
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

// ---------- Dashboard: period × category spend ----------
let dashGran = "month"; // "week" | "month" | "year"
let dashView = "table"; // "table" | "chart"
let dashCats = null;     // null = all categories; else a Set of chosen ones
// Categorical palette for the stacked bar chart (distinct, dark-friendly).
const DASH_PALETTE = ["#4f8cff", "#37c98b", "#f6b73c", "#ef6f6c", "#a985f6", "#22b8cf",
  "#f78fb3", "#8bc34a", "#ff9f5a", "#6ea8fe", "#c4a35a", "#e05fa8", "#5ad1c8", "#d6d64f",
  "#9aa7b2", "#7bd88f", "#ff7a7a", "#b088ff", "#54c0e8", "#e6a24b"];

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

  // Stable colour per category (assigned A–Z so it doesn't shift on toggles).
  const colorMap = {};
  [...cats].sort().forEach((c, i) => (colorMap[c] = DASH_PALETTE[i % DASH_PALETTE.length]));
  const dashColor = (c) => colorMap[c] || "#8aa0b2";
  const selected = dashCats === null ? new Set(cats) : dashCats;

  // Segmented controls: one connected track per choice, far more compact than
  // a row of standalone pill buttons (and reads as a single either/or control).
  const granTabs = ["week", "month", "year"].map((g) => `<button type="button" class="${dashGran === g ? "on" : ""}" data-gran="${g}">${g[0].toUpperCase() + g.slice(1)}</button>`).join("");
  const viewTabs = ["table", "chart"].map((v) => `<button type="button" class="${dashView === v ? "on" : ""}" data-view2="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("");
  const header = `<div class="flex dash-head" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
    <div class="section-title" style="margin:0">Spend by category · ${settings.baseCurrency}</div>
    <div class="flex" style="gap:8px"><div class="seg" role="group" aria-label="Period">${granTabs}</div><div class="seg" role="group" aria-label="View">${viewTabs}</div></div>
  </div>`;

  const tableMarkup = () => `
      <div class="table-wrap dash-scroll mt">
        <table class="data pivot">
          <thead><tr>
            <th>${colLabel}</th><th class="amount">Total</th>
            ${cats.map((c) => `<th class="amount">${esc(c)}</th>`).join("")}
          </tr></thead>
          <tbody>
            ${periods.map((pk) => `<tr>
              <td><b>${esc(fmtPeriod(pk, dashGran))}</b></td>
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
      </div>`;

  const niceMax = (v) => { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); const n = v / p; const s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10; return s * p; };
  const fmtShort = (v) => Math.abs(v) >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1) + "k" : String(Math.round(v));

  const barSvg = (pers, showCats, yMax) => {
    const left = 52, right = 16, top = 14, bottom = 60, bandW = 46, barW = 28;
    const plotW = pers.length * bandW, svgW = left + plotW + right, svgH = 340;
    const plotBottom = svgH - bottom, plotTop = top, plotH = plotBottom - plotTop;
    const y = (v) => plotBottom - (v / yMax) * plotH;
    let g = "";
    for (let k = 0; k <= 4; k++) {
      const val = yMax * k / 4, gy = y(val);
      g += `<line x1="${left}" y1="${gy}" x2="${svgW - right}" y2="${gy}" stroke="var(--border)" stroke-width="1"/>`;
      g += `<text x="${left - 6}" y="${gy + 3}" text-anchor="end" font-size="10" fill="var(--muted)">${fmtShort(val)}</text>`;
    }
    pers.forEach((pk, i) => {
      const bx = left + i * bandW + (bandW - barW) / 2;
      let y0 = plotBottom;
      for (const c of showCats) {
        const val = Math.max(0, byPeriodCat[pk]?.[c] || 0);
        if (val <= 0) continue;
        const h = (val / yMax) * plotH, ry = y0 - h;
        g += `<rect x="${bx}" y="${ry.toFixed(1)}" width="${barW}" height="${Math.max(0.5, h).toFixed(1)}" fill="${dashColor(c)}"><title>${esc(c)} · ${esc(fmtPeriod(pk, dashGran))}: ${settings.baseCurrency} ${num(val)}</title></rect>`;
        y0 = ry;
      }
      const lx = bx + barW / 2, ly = plotBottom + 12;
      g += `<text x="${lx}" y="${ly}" transform="rotate(-40 ${lx} ${ly})" text-anchor="end" font-size="10" fill="var(--muted)">${esc(fmtPeriod(pk, dashGran))}</text>`;
    });
    // Mean & median reference lines across the per-period totals of the shown
    // categories (i.e. the height of each stacked bar).
    const totals = pers.map((pk) => showCats.reduce((s, c) => s + Math.max(0, byPeriodCat[pk]?.[c] || 0), 0));
    if (totals.length) {
      const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
      const sorted = [...totals].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const refLine = (val, color, label, side) => {
        const yy = y(val);
        const tx = side === "right" ? svgW - right : left + 4;
        const anchor = side === "right" ? "end" : "start";
        return `<line x1="${left}" y1="${yy.toFixed(1)}" x2="${svgW - right}" y2="${yy.toFixed(1)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="6 4"><title>${label}: ${settings.baseCurrency} ${num(val)}</title></line>`
          + `<text x="${tx}" y="${(yy - 4).toFixed(1)}" text-anchor="${anchor}" font-size="10" font-weight="700" fill="${color}">${label} ${fmtShort(val)}</text>`;
      };
      g += refLine(mean, "var(--text)", "Mean", "left");
      g += refLine(median, "var(--warn)", "Median", "right");
    }
    g += `<line x1="${left}" y1="${plotBottom}" x2="${svgW - right}" y2="${plotBottom}" stroke="var(--border)" stroke-width="1.5"/>`;
    return `<svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" style="max-width:none;display:block">${g}</svg>`;
  };

  const chartMarkup = () => {
    const cap = { week: 26, month: 24, year: 100 }[dashGran];
    const pers = periods.slice().sort().slice(-cap); // ascending (oldest→newest), recent N
    const showCats = cats.filter((c) => selected.has(c));
    let maxStack = 0;
    for (const pk of pers) { let s = 0; for (const c of showCats) s += Math.max(0, byPeriodCat[pk]?.[c] || 0); if (s > maxStack) maxStack = s; }
    const yMax = niceMax(maxStack);
    // The checkbox is visually hidden (the chip's own dimmed/lit state shows
    // selection) but kept in the DOM so clicking the label still fires the
    // native change event the handler below listens for.
    const chips = cats.map((c) => `<label class="dcat-chip"><input type="checkbox" class="dcat" value="${esc(c)}" ${selected.has(c) ? "checked" : ""}><span class="dot" style="background:${dashColor(c)}"></span>${esc(c)}</label>`).join("");
    const chart = (showCats.length && pers.length)
      ? `<div class="table-wrap mt">${barSvg(pers, showCats, yMax)}</div>`
      : `<div class="empty" style="padding:30px"><p class="muted">Pick at least one category to chart.</p></div>`;
    return `<div class="dash-cats mt">
        <button type="button" class="mini" id="catsAll">All</button>
        <button type="button" class="mini" id="catsNone">None</button>
        ${chips}
      </div>${chart}`;
  };

  views.innerHTML = `
    <div class="card">
      ${header}
      ${dashView === "chart" ? chartMarkup() : tableMarkup()}
      <div class="hint mt">Net spend in ${settings.baseCurrency}: refunds and other credits reduce the total (kept in the merchant's category); only card-bill payments are excluded.</div>
    </div>`;

  $$("[data-gran]").forEach((b) => b.addEventListener("click", () => { dashGran = b.dataset.gran; renderDashboard(); }));
  $$("[data-view2]").forEach((b) => b.addEventListener("click", () => { dashView = b.dataset.view2; renderDashboard(); }));
  if (dashView === "chart") {
    $("#catsAll")?.addEventListener("click", () => { dashCats = null; renderDashboard(); });
    $("#catsNone")?.addEventListener("click", () => { dashCats = new Set(); renderDashboard(); });
    $$(".dcat").forEach((chk) => chk.addEventListener("change", () => {
      const cur = dashCats === null ? new Set(cats) : new Set(dashCats);
      chk.checked ? cur.add(chk.value) : cur.delete(chk.value);
      dashCats = cur; renderDashboard();
    }));
  }
}

function emptyState() {
  return `<div class="card empty">
    <div class="big">${icon("wallet",40)}</div>
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
let expPage = 0;
const EXP_PAGE = 200; // render at most this many expense rows at once (perf)
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

  const computeFiltered = () => expenses.filter((e) => {
    if (expFilter.q && !(`${e.description} ${e.card}`.toLowerCase().includes(expFilter.q.toLowerCase()))) return false;
    if (expFilter.month && e.date.slice(0, 7) !== expFilter.month) return false;
    if (expFilter.card && e.card !== expFilter.card) return false;
    if (expFilter.cat && (e.category || "Uncategorized") !== expFilter.cat) return false;
    if (expFilter.merchant && (e.description || "—") !== expFilter.merchant) return false;
    return true;
  });

  // Shell (filters) is rendered once; only the table body/count/pager repaint
  // on search/filter, so the search input keeps focus while you type.
  views.innerHTML = `
    <div class="card">
      <div class="flex filters">
        <input id="fq" placeholder="Search merchant / card…" value="${esc(expFilter.q)}" style="flex:1;min-width:180px;padding:9px 12px;border:1px solid var(--border);border-radius:10px;background:var(--panel-2)">
        <select id="fmonth" class="fsel"><option value="">All months</option>${months.map((m) => `<option value="${m}" ${expFilter.month === m ? "selected" : ""}>${fmtMonth(m)}</option>`).join("")}</select>
        <select id="fcard" class="fsel"><option value="">All cards</option>${cards.map((c) => `<option ${expFilter.card === c ? "selected" : ""}>${esc(c)}</option>`).join("")}</select>
        <select id="fcat" class="fsel"><option value="">All categories</option>${catCounts.map(([c, n]) => `<option value="${esc(c)}" ${expFilter.cat === c ? "selected" : ""}>${esc(c)} (${n})</option>`).join("")}</select>
        <select id="fmerchant" class="fsel" style="max-width:260px"><option value="">All merchants</option>${merchCounts.map(([m, n]) => `<option value="${esc(m)}" ${expFilter.merchant === m ? "selected" : ""}>${esc(m)} (${n})</option>`).join("")}</select>
        <button class="btn sm secondary" id="fclear">Clear</button>
        <span class="spacer"></span>
        <button class="btn sm secondary" id="expCsv" title="Export CSV" aria-label="Export CSV">${icon("download",15)} CSV</button>
      </div>
      <div class="hint mt" id="expCount"></div>
      <div class="table-wrap mt">
        <table class="data tbl-exp">
          <thead><tr>
            <th>Date</th><th>Description</th><th>Category</th><th>Card / Source</th>
            <th class="amount">Amount</th><th class="amount">In ${settings.baseCurrency}</th><th>Spend</th><th></th>
          </tr></thead>
          <tbody id="expBody"></tbody>
        </table>
      </div>
      <div id="expPager" class="flex mt" style="align-items:center;gap:10px"></div>
    </div>`;

  const paintExp = () => {
    const filtered = computeFiltered();
    const totalBase = filtered.reduce((a, e) => a + (spendBase(e) || 0), 0);
    const pages = Math.max(1, Math.ceil(filtered.length / EXP_PAGE));
    if (expPage >= pages) expPage = pages - 1;
    if (expPage < 0) expPage = 0;
    const pageRows = filtered.slice(expPage * EXP_PAGE, expPage * EXP_PAGE + EXP_PAGE);
    $("#expCount").innerHTML = `${filtered.length} transaction(s) · spend total ${fmtBase(totalBase, settings)}`;
    $("#expBody").innerHTML = pageRows.map(rowHtml).join("") || `<tr><td colspan="8" class="hint" style="padding:24px">No matching transactions.</td></tr>`;
    $("#expPager").innerHTML = pages > 1 ? `
      <button class="btn sm secondary" id="expPrev" ${expPage === 0 ? "disabled" : ""}>‹ Prev</button>
      <span class="hint">Page ${expPage + 1} of ${pages} · rows ${expPage * EXP_PAGE + 1}–${Math.min(filtered.length, (expPage + 1) * EXP_PAGE)} of ${filtered.length}</span>
      <button class="btn sm secondary" id="expNext" ${expPage >= pages - 1 ? "disabled" : ""}>Next ›</button>` : "";
    $("#expPrev")?.addEventListener("click", () => { expPage--; paintExp(); });
    $("#expNext")?.addEventListener("click", () => { expPage++; paintExp(); });
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
      renderExpenses(); // full re-render so the new category shows everywhere
      toast("Category updated", "ok");
    }));
    $$(".del").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm("Delete this transaction?")) return;
      await deleteExpense(b.dataset.id);
      await recordDeletion(b.dataset.id);
      expenses = expenses.filter((x) => x.id !== b.dataset.id);
      scheduleSync();
      paintExp();
    }));
  };

  $("#fq").addEventListener("input", (e) => { expFilter.q = e.target.value; expPage = 0; debouncedExp(paintExp); });
  ["fmonth", "fcard", "fcat", "fmerchant"].forEach((id) => $("#" + id).addEventListener("change", (e) => {
    expFilter[id.slice(1)] = e.target.value; expPage = 0; paintExp();
  }));
  $("#fclear").addEventListener("click", () => { expFilter = { q: "", month: "", card: "", cat: "", merchant: "" }; expPage = 0; renderExpenses(); });
  $("#expCsv").addEventListener("click", () => exportCsv(computeFiltered()));
  paintExp();
}
let _t;
function debouncedExp(fn) { clearTimeout(_t); _t = setTimeout(fn, 200); }

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
    <td data-c="date" style="white-space:nowrap">${fmtDate(e.date)}</td>
    <td data-c="desc">${esc(e.description)}${e.kind === "credit" ? ' <span class="chip src-alert">credit</span>' : ""}</td>
    <td data-c="cat"><select class="catsel" data-id="${e.id}">${catOpts}</select></td>
    <td data-c="src">${esc(e.card || "—")} <span class="chip src-${e.source === "manual" ? "manual" : e.source === "recurring" ? "recurring" : e.source === "alert" ? "alert" : "statement"}">${srcLabel(e.source)}</span></td>
    <td data-c="amt" class="amount ${cls}">${e.kind === "credit" ? "+" : ""}${fmt(e.amount, e.currency)}</td>
    <td data-c="base" class="amount ${cls}">${base == null ? '<span class="chip" title="No FX rate for ' + e.currency + '">no rate</span>' : (e.kind === "credit" ? "+" : "") + fmtBase(base, settings)}</td>
    <td data-c="spend"><span class="chip spend-${st.cls}" title="${esc(st.title)}">${st.txt}</span></td>
    <td data-c="del" class="right"><button class="icon-btn del" data-id="${e.id}" title="Delete">${icon("trash",16)}</button></td>
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
      <div class="table-wrap mt"><table class="data tbl-fixed"><thead><tr>
        <th>Description</th><th class="amount">Amount</th><th>Day</th><th>Category</th><th>Paid via</th><th>Start</th><th>End</th><th></th>
      </tr></thead><tbody>
        ${list.map((t) => `<tr${t.active === false ? ' class="muted"' : ""}>
          <td data-c="desc">${esc(t.description)}</td>
          <td data-c="amt" class="amount" data-label="Amount">${fmt(t.amount, t.currency)}</td>
          <td data-c="day" data-label="Day">${t.dayOfMonth || 1}</td>
          <td data-c="cat" data-label="Category">${esc(t.category || "—")}</td>
          <td data-c="paid" data-label="Paid via">${esc(t.paidVia || "—")}</td>
          <td data-c="start" class="hint" data-label="Start" style="white-space:nowrap">${esc(fmtMonth(t.startMonth))}${t.active === false ? " · paused" : ""}</td>
          <td data-c="end" data-label="End"><input type="month" class="cellin recEnd" data-id="${t.id}" value="${t.endMonth || ""}" style="width:150px"></td>
          <td data-c="act" class="right"><button class="btn sm secondary recToggle" data-id="${t.id}">${t.active === false ? "Resume" : "Pause"}</button> <button class="icon-btn recDel" data-id="${t.id}" title="Delete">${icon("trash",16)}</button></td>
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
    // Tombstone the template id too, so sync doesn't resurrect it and boot
    // recovery doesn't rebuild it from any lingering generated expense.
    await recordDeletion(t.id);
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
        // Axis prints the product name (Magnus/Select) in the statement, so
        // label each as its own card instead of a generic "Axis Credit Card".
        const baseLabel = (src.bank === "axis-cc" && r.cardProduct)
          ? spec.cardLabel.replace(/Axis Credit Card/i, `Axis ${r.cardProduct} Credit Card`)
          : spec.cardLabel;
        r.card = baseLabel; r.gmailMessageId = ids[i];
        // Add-on / secondary card on the same statement → tag it to that
        // cardholder (first name from the statement's section header).
        if (r.secondaryHolder) {
          const fn = (r.secondaryHolder.split(/\s+/)[0] || "");
          const nice = fn ? fn.charAt(0).toUpperCase() + fn.slice(1).toLowerCase() : "";
          if (nice) { r.card = `${baseLabel} (${nice})`; r.owner = "spouse"; }
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
let revPage = 0;
const REV_PAGE = 200; // render at most this many review rows at once (perf)

function renderReview(rows, problems) {
  // Replace mode: show every parsed row (including already-imported ones) so
  // they can overwrite the saved copies. Normal mode: hide already-imported.
  const fresh = reviewReplace ? rows : rows.filter((r) => !r._dup);
  // Default: auto-select clean rows; leave "needs review" rows unticked so
  // you consciously include them after checking.
  fresh.forEach((r) => { if (r._sel === undefined) r._sel = !r.needsReview; });
  reviewRows = fresh;
  revFilter = { q: "", source: "", needsOnly: false, cat: "", merchant: "" };
  revPage = 0;
  const dupCount = rows.length - fresh.length;
  const area = $("#reviewArea");
  if (!rows.length) {
    area.innerHTML = `<div class="card">
      ${problems.map((p) => `<div class="warnbox mt">${esc(p)}</div>`).join("") || ""}
      <div class="empty"><div class="big">${icon("search",40)}</div><p class="muted">No transactions parsed. If you have statements, check that the PDF password is set in Settings.</p></div>
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
    <div class="flex mt filters">
      <input id="revSearch" placeholder="Search description / card…" style="flex:1;min-width:160px;padding:9px 12px;border:1px solid var(--border);border-radius:10px;background:var(--panel-2)">
      <select id="revSource" class="fsel"><option value="">All sources</option>${sources.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
      <select id="revCat" class="fsel"><option value="">All categories</option>${revCats.map(([c, n]) => `<option value="${esc(c)}" ${revFilter.cat === c ? "selected" : ""}>${esc(c)} (${n})</option>`).join("")}</select>
      <select id="revMerchant" class="fsel" style="max-width:240px"><option value="">All merchants</option>${revMerch.map(([m, n]) => `<option value="${esc(m)}" ${revFilter.merchant === m ? "selected" : ""}>${esc(m)} (${n})</option>`).join("")}</select>
      <label class="flex" style="gap:6px;cursor:pointer"><input type="checkbox" id="revNeedsOnly"> Needs review only</label>
      <span class="spacer"></span>
      <span class="hint" id="revCounts"></span>
    </div>
    <div class="table-wrap mt">
      <table class="data tbl-rev">
        <thead><tr>
          <th style="width:26px"></th><th>Date</th><th>Description</th>
          <th class="amount">Amount</th><th>Cur</th><th>Type</th><th>Category</th><th>Source</th><th>Review</th>
        </tr></thead>
        <tbody id="revBody"></tbody>
      </table>
    </div>
    <div id="revPager" class="flex mt" style="align-items:center;gap:10px"></div>
  </div>`;

  const reset = () => { revPage = 0; renderRevBody(); };
  // .fsel styled via CSS
  $("#revSearch").addEventListener("input", (e) => { revFilter.q = e.target.value; reset(); });
  $("#revSource").addEventListener("change", (e) => { revFilter.source = e.target.value; reset(); });
  $("#revCat").addEventListener("change", (e) => { revFilter.cat = e.target.value; reset(); });
  $("#revMerchant").addEventListener("change", (e) => { revFilter.merchant = e.target.value; reset(); });
  $("#revNeedsOnly").addEventListener("change", (e) => { revFilter.needsOnly = e.target.checked; reset(); });
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
  const pages = Math.max(1, Math.ceil(rows.length / REV_PAGE));
  if (revPage >= pages) revPage = pages - 1;
  if (revPage < 0) revPage = 0;
  const slice = rows.slice(revPage * REV_PAGE, revPage * REV_PAGE + REV_PAGE);
  body.innerHTML = slice.map(({ r, i }) => reviewRowHtml(r, i)).join("") ||
    `<tr><td colspan="9" class="hint" style="padding:20px">No rows match this filter.</td></tr>`;
  const pager = $("#revPager");
  if (pager) {
    pager.innerHTML = pages > 1
      ? `<button class="btn sm secondary" id="revPrev" ${revPage === 0 ? "disabled" : ""}>‹ Prev</button>
         <span class="hint">Page ${revPage + 1} of ${pages} · rows ${revPage * REV_PAGE + 1}–${Math.min(rows.length, (revPage + 1) * REV_PAGE)} of ${rows.length}</span>
         <button class="btn sm secondary" id="revNext" ${revPage >= pages - 1 ? "disabled" : ""}>Next ›</button>`
      : "";
    $("#revPrev")?.addEventListener("click", () => { revPage--; renderRevBody(); });
    $("#revNext")?.addEventListener("click", () => { revPage++; renderRevBody(); });
  }
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
  // Formatted date, tap to edit: swap in a date input, commit on change/blur.
  body.querySelectorAll(".revdate").forEach((td) => td.addEventListener("click", () => {
    if (td.querySelector("input")) return;
    const i = +td.dataset.i, r = reviewRows[i];
    if (!r) return;
    td.innerHTML = `<input type="date" class="cellin" value="${r.date}" style="width:150px">`;
    const inp = td.querySelector("input");
    inp.focus();
    const commit = () => { if (inp.value) r.date = inp.value; td.innerHTML = `<span style="border-bottom:1px dotted var(--border)">${fmtDate(r.date)}</span>`; };
    inp.addEventListener("change", commit);
    inp.addEventListener("blur", commit);
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
    <td data-c="sel"><input type="checkbox" class="revChk" data-i="${i}" ${r._sel ? "checked" : ""}></td>
    <td data-c="date" class="revdate" data-i="${i}" data-label="Date" title="Click to edit" style="white-space:nowrap;cursor:pointer"><span style="border-bottom:1px dotted var(--border)">${fmtDate(r.date)}</span></td>
    <td data-c="desc"><input class="cellin" data-i="${i}" data-f="description" value="${esc(r.description)}" style="min-width:200px"></td>
    <td data-c="amt" class="amount" data-label="Amount"><input type="number" step="0.01" class="cellin amt" data-i="${i}" data-f="amount" value="${r.amount}" style="width:96px"></td>
    <td data-c="cur" data-label="Currency">${esc(r.currency || "?")}</td>
    <td data-c="kind" data-label="Type"><select class="cellin" data-i="${i}" data-f="kind" style="min-width:104px"><option value="expense" ${r.kind !== "credit" ? "selected" : ""}>Expense</option><option value="credit" ${r.kind === "credit" ? "selected" : ""}>Credit</option></select></td>
    <td data-c="cat" data-label="Category"><select class="cellin" data-i="${i}" data-f="category">${cats}</select></td>
    <td data-c="src" class="hint" data-label="Source" style="white-space:nowrap">${esc(r.card || "")}</td>
    <td data-c="rev" data-label="Review">${r.needsReview ? `<span class="chip warn" title="${esc(r.reviewReason || "Check this row")}">review</span>` : `<span class="hint">ok</span>`}</td>
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
          <button class="btn sm" id="recheckCats">Re-check all categories against the rules</button>
          <span class="hint">Previews every saved transaction whose category no longer matches the current rules, then fixes them on your OK.</span>
        </div>
        <div class="flex mt">
          <button class="btn sm secondary" id="recat">Re-categorize uncategorized only</button>
          <span class="hint">${expenses.filter((e) => !e.category).length} uncategorized · fills blank categories only, never changes existing ones</span>
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
        <div class="section-title mt" style="border-top:1px solid var(--border);padding-top:14px">Rename a card</div>
        <p class="hint">Relabel every transaction on one card (e.g. "Axis Credit Card" → "Axis Magnus Credit Card").</p>
        <div class="row">
          <div class="field"><label>From</label><select id="cardFrom"><option value="">Pick a card…</option>${[...new Set(expenses.map((e) => e.card).filter(Boolean))].sort().map((c) => `<option>${esc(c)}</option>`).join("")}</select></div>
          <div class="field"><label>To</label><input id="cardTo" placeholder="New card name"></div>
        </div>
        <div class="flex mt"><button class="btn sm secondary" id="cardRename">Rename card</button></div>
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
  $("#recheckCats")?.addEventListener("click", recheckCategories);
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
  $("#cardRename")?.addEventListener("click", async () => {
    const from = $("#cardFrom").value;
    const to = $("#cardTo").value.trim();
    if (!from || !to) return toast("Pick a card and enter a new name", "err");
    if (from === to) return toast("New name is the same", "err");
    const affected = expenses.filter((e) => e.card === from);
    if (!affected.length) return toast("No transactions on that card", "err");
    if (!confirm(`Rename "${from}" → "${to}" on ${affected.length} transaction(s)?`)) return;
    // Update the card label and recompute the dedupe key so future imports of
    // the same statements still de-duplicate against these rows.
    const updated = affected.map((e) => {
      const n = { ...e, card: to, updatedAt: Date.now() };
      n.dedupeKey = dedupeKey(n);
      return n;
    });
    await putMany(updated);
    expenses = await allExpenses();
    scheduleSync();
    toast(`Renamed ${updated.length} transaction(s) ✓`, "ok");
    renderSettings();
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
function openModal(title, html) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = html;
  $("#modal").hidden = false;
}
function closeModal() { $("#modal").hidden = true; }

boot();
