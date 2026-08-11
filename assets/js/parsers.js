// Turn statement PDF text into normalized transaction objects the app can
// review and store.
//
// A parsed transaction looks like:
//   { date: "YYYY-MM-DD", description, amount (>0), currency,
//     kind: "expense" | "credit", card, confidence: 0..1 }
//
// Parsing bank statements from text is inherently fuzzy — layouts change and
// PDFs vary. So every parser is best-effort and the UI always shows results
// in an editable review table before anything is saved. Add or tune a bank
// by editing the matching function below.

import { CATEGORY_RULES } from "./config.js";

const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

function iso(y, m, d) {
  if (y < 100) y += 2000;
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

// Parse many common date shapes → ISO. Returns null if not a date.
export function parseDate(s) {
  if (!s) return null;
  s = s.trim();
  let m;
  // 10-08-2026 or 10/08/26 (assume DD-MM-YYYY, common for IN/AE banks)
  if ((m = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/))) {
    return iso(+m[3], +m[2], +m[1]);
  }
  // 10-Aug-2026 / 10 Aug 26 / 10-AUG-26
  if ((m = s.match(/\b(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-](\d{2,4})\b/))) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo) return iso(+m[3], mo, +m[1]);
  }
  // Aug 10, 2026
  if ((m = s.match(/\b([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})\b/))) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo) return iso(+m[3], mo, +m[2]);
  }
  return null;
}

export function guessCategory(desc) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(desc)) return cat;
  return "";
}

// ---------------------------------------------------------------------------
// Generic statement-table parser. Scans reconstructed lines for rows that
// begin with a date and end with a money amount. Works as a baseline for
// ADCB / Axis / HDFC / BoI statements and any similar layout. Bank-specific
// tweaks live in the wrappers below.
// ---------------------------------------------------------------------------
export function parseStatementLines(lines, opts = {}) {
  const currency = opts.currency || null;
  const card = opts.card || opts.label || "Statement";
  const out = [];
  const moneyRe = /(-?\d[\d,]*\.\d{2})(\s*(CR|DR|Cr|Dr))?\s*$/;
  const dateHead = /^\s*(\d{1,2}[\/\-.][A-Za-z0-9]{2,3}[\/\-.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3}\s+\d{2,4}|[A-Za-z]{3}\s+\d{1,2},?\s+\d{4})/;

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const dm = line.match(dateHead);
    const mm = line.match(moneyRe);
    if (!dm || !mm) continue;
    const date = parseDate(dm[1]);
    if (!date) continue;

    // Description = everything between the (last) date token and the amount.
    let mid = line.slice(dm.index + dm[0].length, mm.index).trim();
    // Drop a second leading date (post date / txn date columns).
    mid = mid.replace(dateHead, "").trim();
    mid = mid.replace(/^[|\-–—:]+/, "").trim();
    const desc = cleanMerchant(mid);
    if (!desc || desc.length < 2) continue;

    const amount = parseFloat(mm[1].replace(/,/g, ""));
    if (!isFinite(amount) || amount === 0) continue;
    const isCredit = /CR/i.test(mm[3] || "") || amount < 0 ||
      /payment received|thank you|refund|reversal|cashback/i.test(desc);

    out.push({
      date,
      description: desc,
      amount: Math.abs(amount),
      currency: currency,
      kind: isCredit ? "credit" : "expense",
      card,
      confidence: 0.6,
    });
  }
  return dedupeInternal(out);
}

// Bank-specific wrappers (currently thin — the generic parser handles the
// heavy lifting; override here when a bank needs special handling).
export function parseAdcbStatement(lines) {
  return parseStatementLines(lines, { currency: "AED", card: "ADCB Credit Card" });
}
export function parseAxisStatement(lines) {
  return parseStatementLines(lines, { currency: "INR", card: "Axis Statement" });
}
export function parseHdfcStatement(lines) {
  return parseStatementLines(lines, { currency: "INR", card: "HDFC Statement" });
}
export function parseBoiStatement(lines) {
  return parseStatementLines(lines, { currency: "INR", card: "BoI Statement" });
}

// Dispatch by bank id (see SOURCES in config.js).
export function parseStatementByBank(bank, lines) {
  switch (bank) {
    case "adcb": return parseAdcbStatement(lines);
    case "axis-stmt": return parseAxisStatement(lines);
    case "hdfc-stmt": return parseHdfcStatement(lines);
    case "boi-stmt": return parseBoiStatement(lines);
    default: return parseStatementLines(lines, {});
  }
}

export function cleanMerchant(s) {
  if (!s) return "";
  return s
    .replace(/\b(RAZ\*|PAYU\*|BILLDESK\*|CCAVENUE\*)/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[*#]+$/g, "")
    .replace(/\s*\b\d{6,}\b\s*/g, " ") // long reference numbers
    .trim()
    .replace(/\b\w/g, (c) => c) // keep case
    .slice(0, 80)
    .trim();
}

function dedupeInternal(list) {
  const seen = new Set();
  return list.filter((t) => {
    const k = `${t.date}|${t.amount}|${(t.description || "").slice(0, 20)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// A stable key used to avoid importing the same transaction twice across runs.
export function dedupeKey(t) {
  return [t.source || "", t.card || "", t.date, t.amount.toFixed(2),
    (t.description || "").toLowerCase().replace(/\s+/g, "").slice(0, 24)].join("|");
}
