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
  // Some statements (e.g. Axis) split transactions into per-card sections with
  // a header like "Card No.: 451460******2242  Name  HARSHITA KAKWANI". Track
  // the current cardholder so each transaction knows which card it's on.
  const cardHeadRe = /card\s*no[.:\s]+([\dXx*]+)\s+name\s+([A-Za-z][A-Za-z .'-]+)/i;
  let holder = null, card4 = null;

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const hh = line.match(cardHeadRe);
    if (hh) {
      card4 = (hh[1].match(/(\d{4})\s*$/) || [])[1] || null;
      holder = hh[2].trim().replace(/\s+/g, " ").slice(0, 40);
      continue;
    }
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
    // Wio: sign alone decides — negative = purchase (expense), positive =
    // payment/credit. Other banks: CR marker, negative amount, or credit-like
    // wording (payment/refund/reversal/cashback) all mean a credit.
    const isCredit = opts.negIsExpense
      ? amount > 0
      : (/CR/i.test(mm[3] || "") || amount < 0 ||
         /payment received|thank ?you|refund|reversal|cash\s?-?back|reward\s?redemption/i.test(desc));

    // Lines that are more likely statement summaries than real transactions.
    const looksNonTxn = /\b(balance|opening|closing|total|sub-?total|available|credit limit|minimum (amount )?due|amount due|payment due|previous|carried forward|brought forward|finance charge)\b/i.test(desc);

    // A rough, honest confidence from concrete signals (not a fixed number).
    let confidence = 0.5;
    if (date) confidence += 0.15;
    if (/[a-z]/i.test(desc) && desc.length >= 4) confidence += 0.2;
    if (currency) confidence += 0.05;
    if (/\.\d{2}$/.test(mm[1])) confidence += 0.1;
    if (looksNonTxn) confidence -= 0.35;
    confidence = Math.max(0.1, Math.min(0.97, confidence));

    const reasons = [];
    if (looksNonTxn) reasons.push("May be a summary/total line, not a purchase");
    if (desc.length < 4 || !/[a-z]/i.test(desc)) reasons.push("Weak/short description");
    if (isCredit) reasons.push("Looks like a credit/refund");

    out.push({
      date,
      description: desc,
      amount: Math.abs(amount),
      currency: currency,
      kind: isCredit ? "credit" : "expense",
      card,
      cardHolder: holder,
      card4,
      confidence,
      needsReview: confidence < 0.6 || looksNonTxn,
      reviewReason: reasons.join("; "),
    });
  }
  // NOTE: we deliberately do NOT collapse identical lines here. A statement is
  // authoritative — two same-day, same-amount, same-merchant charges (e.g. two
  // coffees) are two real transactions and must both survive to review.
  // Re-import protection lives in app.js via dedupeKey against already-saved
  // rows, not by dropping duplicates within one statement.
  return out;
}

// Dispatch by bank id. `opts.currency` and `opts.card` come from the source's
// config entry so every bank tags its transactions correctly. The generic
// table parser handles all layouts today; add a `case` here when a specific
// bank needs custom handling.
export function parseStatementByBank(bank, lines, opts = {}) {
  const base = { currency: opts.currency || null, card: opts.card || "Statement" };
  // Wio's transaction column signs purchases as NEGATIVE and payments/credits
  // (repayments, reversals) as POSITIVE — the opposite of most statements — so
  // tell the parser to read the sign that way.
  if (bank === "wio") base.negIsExpense = true;
  let rows = parseStatementLines(lines, base);
  if (bank === "wio") rows = rows.map(cleanWioRow);
  // If the statement is split into per-card sections (primary + add-on cards),
  // flag transactions belonging to a cardholder other than the primary (first)
  // one so the app can tag them to that person.
  const primary = (rows.find((r) => r.cardHolder) || {}).cardHolder || null;
  if (primary) {
    for (const r of rows) {
      if (r.cardHolder && r.cardHolder !== primary) r.secondaryHolder = r.cardHolder;
    }
  }
  return rows;
}

// Wio statement lines are prefixed with a "P<reference>" id and include card
// repayments / transfers to pay other cards. Strip the reference so merchant
// rules can match, and pre-tag card payments and FX-fee lines.
const WIO_CARD_PAYMENT = /\brepayment\b|credit card payment|\benbd\b|\badcb\b|\bfab\b|\baxis\b|noon credit|etihad guest/i;
function cleanWioRow(t) {
  const description = (t.description || "")
    .replace(/^P\d{6,}\s*/i, "")   // leading reference id
    .replace(/[+\-]\s*$/, "")       // trailing +/- left by the signed amount
    .trim();
  const out = { ...t, description };
  if (WIO_CARD_PAYMENT.test(description)) out.category = "Card Payment";
  else if (/foreign exchange/i.test(description)) out.category = "Fees & Interest";
  return out;
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

// A stable key used to avoid importing the same transaction twice across runs.
export function dedupeKey(t) {
  return [t.source || "", t.card || "", t.date, t.amount.toFixed(2),
    (t.description || "").toLowerCase().replace(/\s+/g, "").slice(0, 24)].join("|");
}
