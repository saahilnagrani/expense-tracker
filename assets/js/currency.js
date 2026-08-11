// Currency helpers. Amounts are stored in their original currency;
// baseAmount is derived on the fly from the editable FX table in settings.

export function toBase(amount, currency, settings) {
  const rate = settings.rates[currency];
  if (!rate || !isFinite(rate)) return null; // unknown currency
  return amount * rate;
}

const SYMBOLS = { AED: "AED", INR: "₹", USD: "$", EUR: "€", GBP: "£" };

export function fmt(amount, currency) {
  if (amount == null || !isFinite(amount)) return "—";
  const sym = SYMBOLS[currency] || (currency + " ");
  const n = Math.abs(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const sign = amount < 0 ? "-" : "";
  // Put multi-letter codes before the number with a space; symbols hug it.
  return sym.length > 1 ? `${sign}${sym} ${n}` : `${sign}${sym}${n}`;
}

export function fmtBase(amount, settings) {
  return fmt(amount, settings.baseCurrency);
}

// Parse a currency+amount blob like "INR 12,390.00", "AED 1,234", "USD 20".
// Returns { currency, amount } or null.
export function parseAmount(text, fallbackCurrency = null) {
  if (!text) return null;
  const t = String(text).replace(/ /g, " ").trim();
  const cur = (t.match(/\b(AED|INR|USD|EUR|GBP|SAR|Rs\.?|₹|\$|£|€|Dhs?)\b/i) || [])[1];
  const numMatch = t.match(/(-?[\d][\d,]*\.?\d{0,2})/);
  if (!numMatch) return null;
  const amount = parseFloat(numMatch[1].replace(/,/g, ""));
  if (!isFinite(amount)) return null;
  return { currency: normCurrency(cur) || fallbackCurrency, amount };
}

export function normCurrency(c) {
  if (!c) return null;
  const u = c.toUpperCase();
  if (u === "RS" || u === "RS." || u === "₹") return "INR";
  if (u === "$") return "USD";
  if (u === "£") return "GBP";
  if (u === "€") return "EUR";
  if (u === "DHS" || u === "DH") return "AED";
  return u;
}
