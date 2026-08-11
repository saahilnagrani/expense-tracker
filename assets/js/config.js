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

// Known senders that email credit-card statements as PDF attachments.
// `kind` is always "statement" (a PDF to open and parse). `bank` is a stable
// id used for saved PDF passwords and card labels.
export const SOURCES = [
  { bank: "adcb", label: "ADCB Credit Card", kind: "statement",
    from: "estatement@adcb.com", currency: "AED",
    passwordHint: "Your ADCB Customer ID (SMS 'CID' to 2626 to retrieve)." },
  { bank: "axis-stmt", label: "Axis Bank Statement", kind: "statement",
    from: "statements@axis.bank.in", currency: "INR",
    passwordHint: "4 letters of your name (CAPS) + 9-digit Customer ID, or + 4-digit DOB (DDMM)." },
  { bank: "hdfc-stmt", label: "HDFC SmartStatement", kind: "statement",
    from: "hdfcbanksmartstatement@hdfcbank.bank.in", currency: "INR",
    passwordHint: "Check the HDFC email for the exact password format." },
  { bank: "boi-stmt", label: "Bank of India Statement", kind: "statement",
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
    // Which sources are enabled for import.
    enabledSources: SOURCES.map((s) => s.bank),
    lookbackMonths: 12,
  };
}
