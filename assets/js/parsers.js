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

import { CATEGORY_RULES, AXIS_CARD_PRODUCTS } from "./config.js";

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

// Indian UPI narrations bury the real payee inside a slash- or dash-separated
// string of reference numbers, bank codes and VPAs:
//   UPI/DR/412345678901/SWIGGY/UTIB/swiggy@axis/Payment
//   UPI-ZOMATO LTD-zomato@ybl-YESB0000123-4128...
// Matching rules against the raw text just hits the generic "upi" rule and
// files everything under Cash & Transfers — which, for someone who pays by UPI
// for everything, is most of their spending. Pull the payee out instead.
const UPI_NOISE = /^(upi|dr|cr|mob|p2m|p2a|p2p|pay|payment|from|to|ref|txn|no|na|null|inb|imps|neft|rtgs|collect|mandate|sent|received|by|transfer|trf|rev)$/i;
// UPI handles and short bank codes that are never the payee.
const UPI_BANK = /^(utib|hdfc|icic|sbin|yesb|kkbk|punb|barb|idib|cnrb|ubin|bkid|indb|fdrl|ratn|idfb|ioba|ybl|ibl|axl|apl|okaxis|okhdfcbank|okicici|oksbi|paytm|pytm|ptys|ptsbi|ptaxis|abfspay|waaxis|wahdfcbank|freecharge|ikwik|timecosmos|jupiteraxis|naviaxis|superyes|yapl|fam|rmhdfc)$/i;
const IFSC = /^[a-z]{4}0[a-z0-9]{6}$/i;

export function upiPayee(desc) {
  const s = String(desc || "");
  if (!/\bupi\b/i.test(s)) return "";
  const out = [];
  for (const raw of s.split(/[\/|\\\-–—]+/)) {
    const p = raw.trim();
    if (!p) continue;
    if (p.includes("@")) {                 // a VPA — its handle is the payee
      const h = p.split("@")[0];
      if (h && /[a-z]/i.test(h) && !UPI_NOISE.test(h)) out.push(h);
      continue;
    }
    if (/^\d+$/.test(p)) continue;         // reference / transaction numbers
    if (IFSC.test(p) || UPI_BANK.test(p) || UPI_NOISE.test(p)) continue;
    if (!/[a-z]/i.test(p)) continue;
    out.push(p);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Per-transaction alert emails. Indian banks send one email per UPI payment,
// transfer or card spend, so unlike a statement each message is a single
// transaction. The wording is formulaic and fairly consistent across banks, so
// one generic parser covers most of them; per-bank quirks can be layered on.
// ---------------------------------------------------------------------------
const AMT_RE = /(?:INR|Rs\.?|₹|AED)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i;
const CREDIT_RE = /\b(credited|received|refund(?:ed)?|reversed|reversal|deposit(?:ed)?|cashback)\b/i;
const DEBIT_RE = /\b(debited|spent|paid|withdrawn|purchase|charged|sent|transferred)\b/i;
const UPI_REF_RE = /\bUPI[\s\/:-]*(?:transaction\s*)?(?:Ref(?:erence)?\.?\s*(?:No\.?|Number|ID)?)[\s:.#\/-]*([0-9]{9,22})\b/i;
// ICICI names it a Transaction ID; Axis embeds it in "UPI/P2A/<ref>/PAYEE".
const TXN_ID_RE = /\b(?:Transaction|Txn)\s*(?:ID|No\.?|Number)[\s:.#-]*([0-9]{9,22})\b/i;
const UPI_PATH_REF_RE = /\bUPI\/(?:P2[AMP]|DR|CR|MOB)\/([0-9]{9,22})\//i;
const LAST4_RE = /(?:x{2,}|\*{2,}|ending(?:\s+(?:with|in))?|no\.?|card|a\/c|account)[\s:#]*(?:x|\*)*([0-9]{4})\b/i;
const VPA_RE = /\b([a-z0-9][a-z0-9._-]{1,40}@[a-z]{2,20})\b/i;
// "Not a transaction" mail that can still slip through a from: filter. Kept
// deliberately narrow: nearly every genuine alert carries a balance line and a
// "never share your password/OTP" footer, and dropping a real transaction on
// those is far worse than letting a stray email reach the review table, where
// it's visible and one tick away from being excluded.
// Note the OTP pattern needs "OTP is/for" rather than a bare "OTP": virtually
// every alert ends with "never share your OTP", which is not an OTP mail.
const NOT_TXN_RE = /\botp\s+(?:is|for)\b|\bis\s+your\s+otp\b|one[- ]time password\s+(?:is|for)\b|statement is ready|your e-?statement|minimum amount due|\bdeclined\b|\bunsuccessful\b/i;

const MON3 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoFrom(d, m, y) {
  let year = +y;
  if (year < 100) year += 2000;
  const mm = String(m).padStart(2, "0"), dd = String(d).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}
// Dates appear as 12-08-25, 12/08/2025, 12-Aug-25, "Aug 12, 2025", 2025-08-12.
function alertDate(text) {
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = text.match(/\b(\d{1,2})[-\/\s]([A-Za-z]{3})[a-z]*[-\/\s,]*(\d{2,4})\b/);
  if (m && MON3[m[2].toLowerCase()]) return isoFrom(m[1], MON3[m[2].toLowerCase()], m[3]);
  m = text.match(/\b([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s*(\d{4})\b/);
  if (m && MON3[m[1].toLowerCase()]) return isoFrom(m[2], MON3[m[1].toLowerCase()], m[3]);
  m = text.match(/\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})\b/); // dd-mm-yy (Indian order)
  if (m) return isoFrom(m[1], m[2], m[3]);
  return "";
}

// A captured candidate still needs cleaning: Axis labels its UPI narration
// "Transaction Info:", so the capture is the whole UPI string; ICICI names no
// merchant at all and the capture runs into the account number.
function cleanPayee(cand) {
  let s = String(cand || "").trim();
  if (!s) return "";
  if (/\bupi\b/i.test(s) && s.includes("/")) s = upiPayee(s) || s;
  s = s.replace(/\b(?:from|to)?\s*your\s+(?:account|a\/c|card)\b.*$/i, "").trim();
  s = s.replace(/\bx{3,}\d+\b/ig, "").replace(/\s+/g, " ").trim();
  // A bare rail name is not a payee — better to flag it for review.
  if (!s || /^(upi|neft|imps|rtgs|payment|txn|transaction|vpa)$/i.test(s)) return "";
  return s;
}

// Pull the merchant/payee out of an alert body, most reliable cue first.
function alertPayee(text) {
  // A readable name in brackets right after the VPA beats the handle itself.
  let m = text.match(/\b(?:to\s+VPA|VPA)\s+[a-z0-9][a-z0-9._-]{1,40}@[a-z]{2,20}\s*\(([^)]{2,60})\)/i);
  if (m) return cleanPayee(m[1]);
  m = text.match(/\b(?:to\s+VPA|VPA)\s+([a-z0-9][a-z0-9._-]{1,40}@[a-z]{2,20})/i);
  if (m) return cleanPayee(m[1].split("@")[0]);
  // ICICI's "Info: MERCHANT" and Axis's "Transaction Info: UPI/P2A/…/PAYEE".
  m = text.match(/\bInfo\s*[:\-]\s*([^\n;.]{2,60})/i);
  if (m) { const c = cleanPayee(m[1]); if (c) return c; }
  m = text.match(/\b(?:towards|at)\s+([A-Za-z0-9][A-Za-z0-9 &.'*_-]{2,50}?)(?:\s+on\b|\s*[.;\n]|$)/i);
  if (m) { const c = cleanPayee(m[1]); if (c) return c; }
  m = text.match(/\b(?:transferred|sent|paid|credited)\s+to\s+([A-Za-z][A-Za-z0-9 &.'-]{2,50}?)(?:\s+on\b|\s*[.;\n]|$)/i);
  if (m) { const c = cleanPayee(m[1]); if (c) return c; }
  m = text.match(VPA_RE);
  if (m) { const c = cleanPayee(m[1].split("@")[0]); if (c) return c; }
  // Last resort: a UPI narration anywhere in the body. Scoped to that
  // substring — running it over the whole email returns the email.
  m = text.match(/\bUPI[\/][A-Za-z0-9@._\/ -]{6,90}/i);
  if (m) { const c = cleanPayee(upiPayee(m[0])); if (c) return c; }
  return "";
}

// Parse one alert email into a transaction, or null if it isn't one.
// `messageDate` (the email's own timestamp) is the fallback date — an alert
// arrives within seconds of the transaction, so it's reliable.
export function parseAlertEmail(text, { subject = "", messageDate = null, currency = "INR" } = {}) {
  const body = `${subject}\n${String(text || "")}`.replace(/ /g, " ");
  if (NOT_TXN_RE.test(body)) return null;
  const am = body.match(AMT_RE);
  if (!am) return null;
  const amount = parseFloat(am[1].replace(/,/g, ""));
  if (!isFinite(amount) || amount <= 0) return null;

  // Credit only when it's clearly a credit and not also a debit sentence.
  const isCredit = CREDIT_RE.test(body) && !DEBIT_RE.test(body);
  const payee = alertPayee(body);
  const ref = body.match(UPI_REF_RE) || body.match(UPI_PATH_REF_RE) || body.match(TXN_ID_RE);
  const l4 = body.match(LAST4_RE);
  const date = alertDate(body) ||
    (messageDate ? new Date(messageDate).toISOString().slice(0, 10) : "");

  const t = {
    date, amount, currency,
    description: payee || (subject || "").trim() || "Bank alert",
    kind: isCredit ? "credit" : "expense",
    upiRef: ref ? ref[1] : "",
    last4: l4 ? l4[1] : "",
  };
  // Categorise on the payee alone; a bare person's name matches no rule, so
  // fall back to Cash & Transfers when the body says it's a transfer. With no
  // payee the description is just the subject line, and guessing from that is
  // actively wrong ("…Mobile Banking" would read as a phone bill) — leave it
  // uncategorised and flagged instead.
  t.category = !payee ? "" : guessCategory(t.description) ||
    (/\bneft\b|\bimps\b|\brtgs\b|transferred\s+to|fund transfer|UPI\/P2[AP]\b/i.test(body) ? "Cash & Transfers" : "");
  // No payee is worth a human look — some UPI collect alerts carry none.
  if (!payee) { t.needsReview = true; t.reviewReason = "No merchant found in the alert — check the description"; }
  if (!date) { t.needsReview = true; t.reviewReason = "No date found in the alert"; }
  return t;
}

export function guessCategory(desc) {
  const s = String(desc || "");
  const payee = upiPayee(s);
  if (payee) {
    for (const [re, cat] of CATEGORY_RULES) if (re.test(payee)) return cat;
    return "Cash & Transfers"; // paid a person, or a payee no rule knows
  }
  for (const [re, cat] of CATEGORY_RULES) if (re.test(s)) return cat;
  return "";
}

// ---------------------------------------------------------------------------
// Generic statement-table parser. Scans reconstructed lines for rows that
// begin with a date and end with a money amount. Works as a baseline for
// ADCB / Axis / HDFC / BoI statements and any similar layout. Bank-specific
// tweaks live in the wrappers below.
// ---------------------------------------------------------------------------
// Statement summary rows that look like transactions (start with a date, end
// with an amount) but are balances/limits/dues — drop them entirely.
const SUMMARY_LINE = /new balance outstanding|balance outstanding|outstanding balance|opening balance|closing balance|previous balance|total amount due|minimum (amount|payment) due|credit limit|available (credit|limit|cash)/i;

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
    const descFull = cleanMerchant(mid);
    if (!descFull || descFull.length < 2) continue;
    const desc = tidyMerchant(descFull);
    // Hard-skip statement summary rows (balances, limits, dues) — these are
    // never real transactions even though they start with a date and amount.
    if (SUMMARY_LINE.test(descFull)) continue;

    const amount = parseFloat(mm[1].replace(/,/g, ""));
    if (!isFinite(amount) || amount === 0) continue;
    // Wio: sign alone decides — negative = purchase (expense), positive =
    // payment/credit. Other banks: CR marker, negative amount, or credit-like
    // wording (payment/refund/reversal/cashback) all mean a credit.
    const isCredit = opts.negIsExpense
      ? amount > 0
      : (/CR/i.test(mm[3] || "") || amount < 0 ||
         /payment received|thank ?you|refund|reversal|cash\s?-?back|reward\s?redemption/i.test(descFull));

    // Lines that are more likely statement summaries than real transactions.
    const looksNonTxn = /\b(balance|opening|closing|total|sub-?total|available|credit limit|minimum (amount )?due|amount due|payment due|previous|carried forward|brought forward|finance charge)\b/i.test(descFull);

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
      // Only when the tidy differs, so most rows carry no extra field.
      ...(descFull === desc ? {} : { rawDescription: descFull }),
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
  // Axis emails several different credit cards (Magnus, Select, …) from one
  // address; the product name is printed in the statement header. Detect it so
  // each card can be tracked separately, like the ENBD Noon/Etihad split.
  if (bank === "axis-cc") {
    const textProduct = detectAxisProduct(lines); // fallback for unmapped cards
    for (const r of rows) {
      const byNumber = r.card4 && AXIS_CARD_PRODUCTS[r.card4];
      const product = byNumber || textProduct;
      if (product) r.cardProduct = product;
    }
  }
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
  const raw = t.description || "";
  // Capture the P<reference> id: a purchase and its Foreign Exchange Fee share
  // the same reference, which lets us link the fee to its purchase exactly.
  const refM = raw.match(/^P(\d{6,})/i);
  const description = raw
    .replace(/^P\d{6,}\s*/i, "")   // leading reference id
    .replace(/[+\-]\s*$/, "")       // trailing +/- left by the signed amount
    .trim();
  const out = { ...t, description, ref: refM ? refM[1] : null };
  // Keep the rule-facing text in step with the display text.
  if (t.rawDescription) out.rawDescription = t.rawDescription.replace(/^P\d{6,}\s*/i, "").replace(/[+\-]\s*$/, "").trim();
  if (WIO_CARD_PAYMENT.test(description)) out.category = "Card Payment";
  else if (/foreign exchange/i.test(description)) out.category = "Fees & Interest";
  return out;
}

// Pull the Axis card product ("Magnus", "Select", …) from the statement's
// TITLE line — which is only "Axis Bank <Product> Credit Card". Anchored to the
// whole line (so it isn't fooled by marketing sentences) and with a denylist
// for promo words like "Recommends". Returns null if none is found.
const AXIS_PROMO = /recommend|reward|offer|upgrade|apply|welcome|benefit|feature|eligible|instant|exclusive|premium|save|new\b/i;
function detectAxisProduct(lines) {
  for (const raw of lines.slice(0, 60)) {
    const line = (raw || "").replace(/\s+/g, " ").trim();
    const m = line.match(/^axis bank\s+([A-Za-z][A-Za-z ]{1,18}?)\s+credit card(?:\s+statement)?$/i);
    if (m) {
      const p = m[1].trim().replace(/\s+/g, " ");
      if (p && !AXIS_PROMO.test(p) && !/^(the|your|a|my)$/i.test(p)) {
        return p.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w/g, (c) => c.toLowerCase());
      }
    }
  }
  return null;
}

export function cleanMerchant(s) {
  if (!s) return "";
  return s
    .replace(/\b(RAZ\*|PAYU\*|BILLDESK\*|CCAVENUE\*)/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[*#]+$/g, "")
    // Long reference numbers, plus a short group hyphenated onto one
    // ("CASHBACK CREDIT-REF 162775-0108") — that tail is part of the same
    // reference, not a date or an amount.
    .replace(/\s*\b\d{6,}(?:-\d{2,6})?\b\s*/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c) // keep case
    .slice(0, 80)
    .trim();
}

// Indian card statements print each row as "<MERCHANT>,<CITY> <MERCHANT
// CATEGORY>" — "MYNTRA DESIGNS PRIVATE L,BANGALORE CLOTH STORES". The tail is
// the acquirer's classification, not part of the name, and it made the merchant
// filter unreadable (every Amazon charge a distinct "merchant"). Strip it for
// display; the full string is kept on the record as `rawDescription` because
// several category rules read that classification text (Swiggy Instamart is
// only distinguishable from Swiggy food by its "DEPT STORES" tail).
//
// Only the distinctive shape is touched: a comma with no space after it,
// followed by two to five ALL-CAPS words. Anything else is left alone.
const MCC_TAIL = /,(?=[A-Z])(?:[A-Z][A-Z&.'-]{2,}\s+){1,4}[A-Z][A-Z&.'-]{2,}\s*$/;
// Payment-gateway and truncated-suffix noise left at the end of the name:
// "AMAZON INDIA CYBS SI", "NETFLIX DI SI", "MYNTRA DESIGNS PRIVATE L".
const GATEWAY_TAIL = /(?:\s+(?:CYBS|[A-Z]{1,2}))+$/;

export function tidyMerchant(s) {
  let out = String(s || "").replace(MCC_TAIL, "").trim();
  // Never strip so much that nothing recognisable is left.
  const stripped = out.replace(GATEWAY_TAIL, "").trim();
  if (stripped.length >= 4) out = stripped;
  return out || String(s || "").trim();
}

// A stable key used to avoid importing the same transaction twice across runs.
export function dedupeKey(t) {
  return [t.source || "", t.card || "", t.date, t.amount.toFixed(2),
    (t.description || "").toLowerCase().replace(/\s+/g, "").slice(0, 24)].join("|");
}

// ---------------------------------------------------------------------------
// Attribute a foreign-currency fee (and its GST) to the purchase it was levied
// on, so the fee lands in that purchase's category instead of a generic
// "Fees & Interest" bucket. Amounts never change — only the fee's category.
//
// Linking signals, in order of reliability:
//   1. Shared reference id (Wio): the fee row carries the same P<ref> as its
//      purchase — an exact link.
//   2. Amount ratio + date (Axis etc.): fee ≈ markup% × purchase within 0–2
//      days. The markup rate is auto-detected per statement from the clear
//      one-to-one matches, then used as a tight band to resolve the rest.
//   3. GST ≈ 18% of a fee, within 0–2 days → inherits that fee's category, but
//      only when the fee itself linked to a purchase (so GST on annual/late
//      fees stays in Fees & Interest).
// Ambiguous cases (2+ plausible parents) are left in Fees & Interest and
// flagged for review rather than guessed.
// ---------------------------------------------------------------------------
const FEE_RE = /foreign currency transaction fee|foreign exchange fee|foreign transaction fee|\bdcc markup\b|\bmarkup\b/i;
const GST_RE = /^gst\b/i;
const DAY = 86400000;

function addReason(existing, reason) {
  return existing ? `${existing}; ${reason}` : reason;
}

export function linkFeesToPurchases(rows, enabled, opts = {}) {
  if (!enabled) return rows;
  const flag = opts.flag !== false; // set needsReview on ambiguous ones (import)
  // Only match within the same card (add-on cards are separate people).
  const groups = new Map();
  for (const r of rows) {
    const k = r.card || "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const g of groups.values()) linkGroup(g, flag);
  return rows;
}

function linkGroup(rows, flag = true) {
  const feeIdx = [], gstIdx = [], purch = [];
  rows.forEach((r, i) => {
    const d = (r.description || "").trim();
    if (GST_RE.test(d) && d.length <= 8) gstIdx.push(i);
    else if (FEE_RE.test(d)) feeIdx.push(i);
    else if (r.kind !== "credit" && r.category !== "Card Payment") purch.push(i);
  });
  if (!feeIdx.length && !gstIdx.length) return;

  const gap = (a, b) => Math.abs(Date.parse(a) - Date.parse(b));
  const within = (a, b, n) => { const x = gap(a, b); return isFinite(x) && x <= n * DAY; };
  const feeParent = {}; // feeIndex -> purchaseIndex

  // 1) Exact reference match (Wio).
  for (const fi of feeIdx) {
    const ref = rows[fi].ref;
    if (!ref) continue;
    const pi = purch.find((j) => rows[j].ref && rows[j].ref === ref);
    if (pi != null) feeParent[fi] = pi;
  }

  // 2) Amount-ratio + date for the rest (Axis etc.).
  const remaining = feeIdx.filter((fi) => feeParent[fi] == null);
  const LO = 0.008, HI = 0.045; // wide band: ~0.8%–4.5% covers 2%–3.5% cards
  const candidates = (fi, lo, hi) => {
    const fee = rows[fi];
    return purch.filter((pi) => {
      const p = rows[pi];
      if (p.amount <= 0) return false;
      if (!within(p.date, fee.date, 2)) return false;
      const ratio = fee.amount / p.amount;
      return ratio >= lo && ratio <= hi;
    });
  };
  // pass A: estimate this statement's markup rate from unambiguous matches
  const ratios = [];
  for (const fi of remaining) {
    const c = candidates(fi, LO, HI);
    if (c.length === 1) ratios.push(rows[fi].amount / rows[c[0]].amount);
  }
  let rate = null;
  if (ratios.length) { ratios.sort((a, b) => a - b); rate = ratios[Math.floor(ratios.length / 2)]; }
  // pass B: assign using a tight band around the detected rate (or wide if none)
  const lo = rate ? rate * 0.75 : LO, hi = rate ? rate * 1.25 : HI;
  for (const fi of remaining) {
    let c = candidates(fi, lo, hi);
    if (c.length === 1) { feeParent[fi] = c[0]; continue; }
    if (c.length > 1 && flag) {
      rows[fi].needsReview = true;
      rows[fi].reviewReason = addReason(rows[fi].reviewReason, "Forex fee: multiple possible purchases — set the category manually");
    }
  }

  // apply fee -> parent category. Only when the purchase actually has one:
  // inheriting unconditionally means a purchase no rule matched (blank
  // category) wipes the fee's own "Fees & Interest", leaving a row that is
  // demonstrably a fee sitting uncategorised. Attribution should improve the
  // fee's category or leave it alone, never take one away.
  for (const fi of Object.keys(feeParent)) {
    const parentCat = rows[feeParent[fi]].category;
    if (parentCat) rows[fi].category = parentCat;
    rows[fi]._feeParent = feeParent[fi];
  }

  // 3) GST -> a linked fee (18%) -> inherit that purchase's category
  for (const gi of gstIdx) {
    const gst = rows[gi];
    const cands = feeIdx.filter((fi) => rows[fi]._feeParent != null &&
      within(rows[fi].date, gst.date, 2) &&
      (gst.amount / rows[fi].amount) >= 0.14 && (gst.amount / rows[fi].amount) <= 0.22);
    if (!cands.length) continue;
    const cats = new Set(cands.map((fi) => rows[fi].category));
    if (cats.size === 1 && rows[cands[0]].category) gst.category = rows[cands[0]].category;
    else if (flag) { gst.needsReview = true; gst.reviewReason = addReason(gst.reviewReason, "GST: multiple possible forex fees — set the category manually"); }
  }
}

// ---------------------------------------------------------------------------
// Statement summary: the header block every credit-card statement carries —
// total due, minimum due, statement and payment-due dates, credit limit and
// the card's last 4. The transaction parser already recognises these lines
// (SUMMARY_LINE) but only in order to skip them, because they aren't
// transactions; this reads the values instead of discarding them.
//
// Every bank prints it differently, so each gets its own reader. Anything a
// bank doesn't state plainly is left undefined rather than guessed — a wrong
// due date is worse than a blank one.
// ---------------------------------------------------------------------------

const num = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ""));
  return isFinite(n) ? n : undefined;
};
// Every date in a line, as YYYY-MM-DD. Handles 05/08/26, 05/08/2026 and
// 26-Jul-26 (Emirates NBD).
function datesIn(line) {
  const out = [];
  for (const m of line.matchAll(/\b(\d{2})[\/-](\d{2})[\/-](\d{2,4})\b/g)) {
    out.push(`${m[3].length === 2 ? "20" + m[3] : m[3]}-${m[2]}-${m[1]}`);
  }
  for (const m of line.matchAll(/\b(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\b/g)) {
    const mo = MONTHS[m[2].toLowerCase()];   // the map declared at the top
    if (mo) out.push(`${m[3].length === 2 ? "20" + m[3] : m[3]}-${String(mo).padStart(2, "0")}-${m[1].padStart(2, "0")}`);
  }
  return out;
}
// Bare numbers on a line, ignoring anything glued to letters.
const numsIn = (line) => (line.match(/(?<![\w.])\d[\d,]*\.\d{2}(?![\w.])|(?<![\w.])\d[\d,]*(?![\w.\d])/g) || []).map(num).filter((n) => n !== undefined);

export function parseStatementSummary(bank, lines) {
  const L = lines.map((l) => String(l).replace(/\s+/g, " ").trim()).filter(Boolean);
  const find = (re) => L.find((l) => re.test(l));
  const findIdx = (re) => L.findIndex((l) => re.test(l));
  const out = { bank };

  if (bank === "adcb") {
    // "Card No : XXXXXXXXXXXX9831 - SAAHIL NAGRANI"
    const card = find(/^Card No\s*:/i);
    if (card) out.card4 = (card.match(/(\d{4})\b/) || [])[1];
    // "05/08/2026 NEW BALANCE OUTSTANDING 4829.36" — the one labelled line
    // carrying both the statement date and the amount owed.
    const nb = find(/NEW BALANCE OUTSTANDING/i);
    if (nb) {
      out.totalDue = numsIn(nb).pop();
      out.statementDate = datesIn(nb)[0];
    }
    const prev = find(/PREVIOUS BALANCE OUTSTANDING/i);
    if (prev) out.previousBalance = numsIn(prev).pop();
    // The due date sits in the address block, sometimes on its own line and
    // sometimes glued to the city, depending how long the address is. Both
    // samples agree on this much: the header holds exactly two short dates,
    // the statement date and the payment due date.
    const header = L.slice(0, 12).flatMap((l) => l.match(/\b\d{2}\/\d{2}\/\d{2}\b/g) || []);
    const asIso = header.map((d) => datesIn(d)[0]);
    out.dueDate = asIso.find((d) => d && d !== out.statementDate);
  }

  if (bank === "wio") {
    // "PAYMENT DUE DATE MIN. PAYMENT DUE TOTAL TO PAY" then a line ending
    // "<due date> <min> <total>".
    const hi = findIdx(/PAYMENT DUE DATE.*MIN\..*TOTAL TO PAY/i);
    for (let i = hi + 1; i >= 0 && i < Math.min(L.length, hi + 5); i++) {
      const d = datesIn(L[i]);
      const n = numsIn(L[i]);
      if (d.length === 1 && n.length >= 2) {
        out.dueDate = d[0];
        out.totalDue = n[n.length - 1];
        out.minDue = n[n.length - 2];
        break;
      }
    }
    const period = find(/^FROM \d.* TO \d/i);
    if (period) out.statementDate = datesIn(period).pop();
    const cl = findIdx(/^CREDIT LIMIT\b/i);
    if (cl >= 0 && L[cl + 1]) out.creditLimit = numsIn(L[cl + 1])[0];
    // Wio bills, then autopays. The header total is what it billed; the
    // closing balance is what was left after the autopay cleared it.
    const close = find(/Closing balance/i);
    if (close) out.closingBalance = numsIn(close).pop();
    // The Card Number column repeats on every transaction line.
    const masks = L.flatMap((l) => l.match(/\*{2,}(\d{4})\b/g) || []).map((m) => m.slice(-4));
    if (masks.length) {
      const tally = {};
      for (const m of masks) tally[m] = (tally[m] || 0) + 1;
      out.card4 = Object.entries(tally).sort((a, b) => b[1] - a[1])[0][0];
    }
  }

  if (bank === "fab") {
    // The header block is interleaved with Arabic glyphs that pdf.js renders as
    // punctuation soup. The remittance slip at the foot of the page repeats
    // everything in clean ASCII on one line, so read that instead:
    //   "4937 50** **** 2885 1017075723 28-10-2024 22-11-2024 0.00 0.00"
    const card = find(/\b\d{4}\s+\d{2}\*+\s+\*+\s+(\d{4})\b/);
    if (card) out.card4 = (card.match(/\b\d{4}\s+\d{2}\*+\s+\*+\s+(\d{4})\b/) || [])[1];
    const ri = findIdx(/Main Card Number.*Statement Date.*Total Payment Due/i);
    const row = ri >= 0 ? L[ri + 1] : undefined;
    if (row) {
      const d = datesIn(row);
      if (d.length >= 2) { out.statementDate = d[0]; out.dueDate = d[1]; }
      // Everything after the last date is the two amounts. Reading the whole
      // line instead would pick up the card digits and the serial number.
      const lastDate = row.match(/\d{2}-\d{2}-\d{4}(?![\s\S]*\d{2}-\d{2}-\d{4})/);
      const tail = lastDate ? row.slice(lastDate.index + lastDate[0].length) : "";
      const n = numsIn(tail);
      if (n.length >= 2) { out.totalDue = n[0]; out.minDue = n[1]; }
    }
    const pb = findIdx(/Previous Balance.*Total Payment Due/i);
    if (pb >= 0 && L[pb + 1]) out.previousBalance = numsIn(L[pb + 1])[0];
  }

  if (bank.startsWith("enbd")) {
    const card = find(/^Card Number:/i);
    if (card) out.card4 = (card.match(/(\d{4})\s*$/) || [])[1];
    // "Credit Limit  Available…  Statement Date  Payment Due Date  Minimum Payment Due"
    const hi = findIdx(/Credit Limit.*Statement Date.*Payment Due Date/i);
    if (hi >= 0 && L[hi + 1]) {
      const n = numsIn(L[hi + 1]), d = datesIn(L[hi + 1]);
      if (n.length) out.creditLimit = n[0];
      if (d.length >= 2) { out.statementDate = d[0]; out.dueDate = d[1]; }
      if (n.length) out.minDue = n[n.length - 1];
    }
    // The summary values line: six figures, the fifth being Total Payment Due.
    const si = findIdx(/Total Payment Due \(AED\)/i);
    for (let i = si + 1; si >= 0 && i < Math.min(L.length, si + 4); i++) {
      const n = numsIn(L[i]);
      if (n.length === 6) { out.previousBalance = n[0]; out.totalDue = n[4]; break; }
    }
  }

  if (bank.startsWith("axis")) {
    // "Total Payment Due  Minimum Payment Due  Statement Period  Payment Due Date  Statement Generation Date"
    const hi = findIdx(/Total Payment Due.*Minimum Payment Due.*Payment Due Date/i);
    if (hi >= 0 && L[hi + 1]) {
      const row = L[hi + 1];
      const n = numsIn(row), d = datesIn(row);
      if (n.length >= 2) { out.totalDue = n[0]; out.minDue = n[1]; }
      // period start, period end, due date, generation date
      if (d.length >= 4) { out.dueDate = d[2]; out.statementDate = d[3]; }
    }
    const ci = findIdx(/^Credit Card Number\b/i);
    if (ci >= 0 && L[ci + 1]) {
      const m = L[ci + 1].match(/(\d{4,6})\*+(\d{4})\b/);
      if (m) out.card4 = m[2];
      // Strip the masked card first: its leading BIN (451460) is bare digits
      // and would otherwise be read as the credit limit.
      const n = numsIn(L[ci + 1].replace(/\d{4,6}\*+\d{4}/, " "));
      if (n.length) out.creditLimit = n[0];
    }
    if (!out.card4) {
      const c = find(/^Card No:/i);
      if (c) out.card4 = (c.match(/\*+(\d{4})\b/) || [])[1];
    }
  }

  if (bank.startsWith("cbd")) {
    // CBD prints an English label and its Arabic twin on the same line with the
    // value wedged between them ("Total Outstanding Balance 0.00 <arabic>"), but
    // for the two headline figures the value drops to the line below, because a
    // parenthetical qualifier follows the label:
    //   Total Amount Due* * <arabic>
    //   0.00
    //   (to avoid Finance Charges) (<arabic>)
    // labelled() reads whichever of the two shapes this statement used.
    const ONLY_NUM = /^(\d[\d,]*\.\d{2})\s*(CR)?$/i;
    const labelled = (re) => {
      const i = findIdx(re);
      if (i < 0) return undefined;
      const same = numsIn(L[i]);
      if (same.length) return { value: same[0], cr: /\bCR\b/i.test(L[i]) };
      for (let j = i + 1; j < Math.min(L.length, i + 4); j++) {
        const m = L[j].match(ONLY_NUM);
        if (m) return { value: num(m[1]), cr: !!m[2] };
      }
      return undefined;
    };
    const card = find(/^Card Number\b/i);
    if (card) out.card4 = (card.match(/\*+(\d{4})\b/) || [])[1];
    const sd = find(/\bStatement Date\b/i);
    if (sd) out.statementDate = datesIn(sd)[0];
    const dd = find(/\bPayment Due Date\b.*\d/i);
    if (dd) out.dueDate = datesIn(dd)[0];
    // A CR balance means the card is in credit — nothing is owed, and the
    // amount is theirs, not the bank's. Carry the sign rather than dropping it.
    const total = labelled(/^Total Amount Due\b/i);
    if (total) out.totalDue = total.cr ? -total.value : total.value;
    const minimum = labelled(/^Minimum Amount Due\b/i);
    if (minimum) out.minDue = minimum.cr ? -minimum.value : minimum.value;
    const limit = labelled(/^Total Credit Limit\b/i);
    if (limit) out.creditLimit = limit.value;
    // Summary table: opening balance, payments in, new spend, closing balance.
    // The header wraps onto a second line of qualifiers, so scan forward.
    const si = findIdx(/^Opening Balance\b.*Total Outstanding Balance/i);
    for (let i = si + 1; si >= 0 && i < Math.min(L.length, si + 4); i++) {
      const n = numsIn(L[i]);
      if (n.length < 4) continue;
      // "198.16 CR 141.00 …" — the CR belongs to the opening balance.
      out.previousBalance = /^\s*[\d,]+\.\d{2}\s+CR\b/i.test(L[i]) ? -n[0] : n[0];
      out.closingBalance = n[3];
      break;
    }
  }

  // Nothing usable? Say so, rather than returning a hollow record.
  if (out.totalDue === undefined && !out.statementDate) return null;
  return out;
}
