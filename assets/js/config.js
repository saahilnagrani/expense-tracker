// Static configuration and defaults for the Expense Tracker.
// Everything here can be overridden by the user in the Settings tab
// (persisted in the browser). Nothing secret should be hard-coded.

export const APP = {
  name: "Expense Tracker",
  version: "1.0.0",
};

// Currencies the app understands out of the box. Rate = value of ONE unit
// of this currency expressed in the base currency. These are editable
// defaults, not live rates — update them in Settings.
export const DEFAULT_CURRENCIES = ["AED", "INR", "USD", "EUR", "GBP"];

// Default FX table expressed relative to AED (the default base).
// e.g. 1 INR ≈ 0.044 AED, 1 USD ≈ 3.6725 AED.
export const DEFAULT_RATES_IN_AED = {
  AED: 1,
  INR: 0.044,
  USD: 3.6725,
  EUR: 4.0,
  GBP: 4.7,
};

export const DEFAULT_CATEGORIES = [
  "Groceries",
  "Food & Dining",
  "Shopping",
  "Transport",
  "Bills & Utilities",
  "Subscriptions",
  "Travel",
  "Health",
  "Entertainment",
  "Cash & Transfers",
  "Fees & Interest",
  "Income / Credit",
  "Other",
];

// Simple keyword → category guesses used when importing. First match wins.
export const CATEGORY_RULES = [
  [/netflix|spotify|prime|youtube|hotstar|disney|icloud|google one|openai|anthropic|claude|chatgpt|adobe|notion|canva/i, "Subscriptions"],
  [/uber|careem|ola|lyft|rta|metro|taxi|fuel|petrol|adnoc|enoc|shell/i, "Transport"],
  [/emirates|etihad|air ?india|indigo|flight|hotel|booking\.com|airbnb|makemytrip|kiwi/i, "Travel"],
  [/lulu|carrefour|spinneys|grocer|bigbasket|blinkit|zepto|instashop|supermarket|mart/i, "Groceries"],
  [/talabat|zomato|swiggy|deliveroo|mcdonald|kfc|starbucks|restaurant|cafe|district|dining/i, "Food & Dining"],
  [/amazon|noon|flipkart|myntra|ikea|namshi|ajio|store|shop/i, "Shopping"],
  [/du |etisalat| dewa|jio|airtel|vodafone|electricity|water|internet|mobile|recharge|myjio/i, "Bills & Utilities"],
  [/pharmacy|hospital|clinic|aster|medcare|apollo|health|dr\.?\s/i, "Health"],
  [/vox|cinema|pvr|bookmyshow|game|steam|playstation|entertainment/i, "Entertainment"],
  [/atm|cash|neft|imps|upi|transfer|withdrawal/i, "Cash & Transfers"],
  [/interest|finance charge|late fee|annual fee|vat|markup|fee/i, "Fees & Interest"],
];

// Known senders that email statements as PDF attachments. `kind` is always
// "statement" (a PDF to open and parse). `bank` is a stable id used for saved
// PDF passwords and card labels. `default` = whether it's enabled for import
// out of the box (credit cards on; bank-account statements off, so account
// debits don't double-count spend you already see on a card). The Gmail
// search matches by `from:` and covers archived/labelled mail, so statements
// that skip the inbox (e.g. auto-labelled by a filter) are still imported.
export const SOURCES = [
  // --- Credit cards (on by default) ---
  { bank: "adcb", label: "ADCB Credit Card", kind: "statement", default: true,
    from: "estatement@adcb.com", currency: "AED",
    passwordHint: "Your ADCB Customer ID (SMS 'CID' to 2626 to retrieve)." },
  { bank: "axis-cc", label: "Axis Credit Card", kind: "statement", default: true,
    from: "cc.statements@axis.bank.in", currency: "INR",
    passwordHint: "First 4 letters of name (CAPS) + DOB as DDMM, e.g. CKAJ1102 — or + last 4 digits of the card." },
  { bank: "fab", label: "FAB Credit Card", kind: "statement", default: true,
    from: "estatement@bankfab.com", currency: "AED",
    passwordHint: "8 digits: your year of birth + last 4 digits of your registered mobile, e.g. 19804567." },
  { bank: "wio", label: "Wio Credit Card", kind: "statement", default: true,
    from: "wio.io", currency: "AED",
    passwordHint: "Usually not password-protected — leave blank. If prompted, check the Wio app." },
  // --- Bank-account statements (off by default; enable if you want them) ---
  { bank: "axis-acct", label: "Axis Bank A/c Statement", kind: "statement", default: false,
    from: "statements@axis.bank.in", currency: "INR",
    passwordHint: "4 letters of name (CAPS) + 9-digit Customer ID, or + 4-digit DOB (DDMM)." },
  { bank: "hdfc-stmt", label: "HDFC SmartStatement", kind: "statement", default: false,
    from: "hdfcbanksmartstatement@hdfcbank.bank.in", currency: "INR",
    passwordHint: "Check the HDFC email for the exact password format." },
  { bank: "enbd", label: "Emirates NBD A/c", kind: "statement", default: false,
    from: "statement@emiratesnbd.com", currency: "AED",
    passwordHint: "Check the Emirates NBD email for the password format." },
  { bank: "boi-stmt", label: "Bank of India Statement", kind: "statement", default: false,
    from: "noreply-estatement@alerts.bankofindia.bank.in", currency: "INR",
    passwordHint: "Check the Bank of India email for the password format." },
];

export const SETTINGS_KEY = "et.settings.v1";

export function defaultSettings() {
  return {
    baseCurrency: "AED",
    rates: { ...DEFAULT_RATES_IN_AED },
    categories: [...DEFAULT_CATEGORIES],
    googleClientId: "",
    // Per-bank saved PDF passwords (stored locally in this browser only).
    passwords: {},
    // Which sources are enabled for import (credit cards on by default).
    enabledSources: SOURCES.filter((s) => s.default).map((s) => s.bank),
    lookbackMonths: 12,
    // Cross-device sync via the user's private Google Drive app-data folder.
    autoSync: true,
  };
}
