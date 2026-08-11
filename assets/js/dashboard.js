// Aggregations + lightweight bar-chart rendering for the dashboard.
import { toBase, fmtBase, fmt } from "./currency.js";

const PALETTE = ["#2f6df6","#12805c","#b25e09","#7a4ff6","#d1493b","#0e8fa8","#9a6b00","#4b5563"];

// Only spend (expenses), not credits/payments, counts toward "spending".
function isSpend(e) { return e.kind !== "credit" && e.kind !== "payment"; }

export function summarize(expenses, settings) {
  const now = new Date();
  const ym = (d) => d.slice(0, 7);
  const thisMonth = now.toISOString().slice(0, 7);
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonth = lastMonthDate.toISOString().slice(0, 7);

  let totalBase = 0, monthBase = 0, lastBase = 0, unconverted = 0;
  const byCategory = {}, byCard = {}, byCurrency = {}, byMonth = {};

  for (const e of expenses) {
    if (!isSpend(e)) continue;
    const b = toBase(e.amount, e.currency, settings);
    if (b == null) { unconverted++; continue; }
    totalBase += b;
    const m = ym(e.date);
    byMonth[m] = (byMonth[m] || 0) + b;
    if (m === thisMonth) monthBase += b;
    if (m === lastMonth) lastBase += b;
    byCategory[e.category || "Uncategorized"] = (byCategory[e.category || "Uncategorized"] || 0) + b;
    byCard[e.card || "—"] = (byCard[e.card || "—"] || 0) + b;
    byCurrency[e.currency] = (byCurrency[e.currency] || 0) + e.amount;
  }
  return { totalBase, monthBase, lastBase, unconverted, byCategory, byCard, byCurrency, byMonth,
    thisMonth, lastMonth, count: expenses.length };
}

export function barRows(obj, settings, { max = 8 } = {}) {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, max);
  const peak = top.length ? top[0][1] : 1;
  return top.map(([label, val], i) => {
    const pct = peak ? Math.max(2, (val / peak) * 100) : 0;
    return `<div class="bar-row">
      <span class="bar-label" title="${esc(label)}">${esc(label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${PALETTE[i % PALETTE.length]}"></span></span>
      <span class="bar-val">${fmtBase(val, settings)}</span>
    </div>`;
  }).join("") || `<div class="hint">No data yet.</div>`;
}

export function monthTrend(byMonth, settings, { months = 6 } = {}) {
  const keys = lastNMonths(months);
  const vals = keys.map((k) => byMonth[k] || 0);
  const peak = Math.max(1, ...vals);
  return keys.map((k, i) => {
    const h = Math.max(3, (vals[i] / peak) * 120);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex:1">
      <div class="bar-val" style="font-size:11px">${vals[i] ? fmtBase(vals[i], settings).replace(/\.\d+$/, "") : ""}</div>
      <div style="width:70%;height:${h}px;background:${'#2f6df6'};border-radius:6px 6px 0 0;opacity:${i === keys.length - 1 ? 1 : 0.55}"></div>
      <div class="hint" style="font-size:11px">${k.slice(2)}</div>
    </div>`;
  }).join("");
}

export function currencyLegend(byCurrency) {
  const items = Object.entries(byCurrency).sort((a, b) => b[1] - a[1]);
  if (!items.length) return "";
  return `<div class="legend">` + items.map(([cur, amt], i) =>
    `<span class="item"><span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span>${fmt(amt, cur)} in ${cur}</span>`
  ).join("") + `</div>`;
}

function lastNMonths(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(x.toISOString().slice(0, 7));
  }
  return out;
}

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
