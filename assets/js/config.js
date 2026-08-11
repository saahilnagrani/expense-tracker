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
  "Food Delivery",
  "Food & Dining",
  "Shopping",
  "Transport",
  "Travel",
  "Bills & Utilities",
  "Subscriptions",
  "Housing",
  "Health",
  "Beauty",
  "Sports",
  "Entertainment",
  "Cash & Transfers",
  "Card Payment",
  "Cashback",
  "Fees & Interest",
  "Income / Credit",
  "Other",
];

// Keyword → category guesses used when importing. FIRST MATCH WINS, so order
// matters: put specific merchants above the generic fallbacks (e.g. "Careem
// Food" → Food Delivery must come before the generic "careem" → Transport).
export const CATEGORY_RULES = [
  // Card bill payments & cashback (also treated as credits, kept out of spend)
  [/payment received|thank ?you|credit repayment|\brepayment\b|credit card payment/i, "Card Payment"],
  [/cash\s?-?back|reward\s?redemption/i, "Cashback"],

  // Sports & fitness (padel/tennis courts, gyms, booking apps)
  [/matchi|padel|\bpadel\b|tennis|squash|\bgym\b|fitness ?first|climbing|crossfit/i, "Sports"],

  // Food delivery (before Groceries / generic Careem, Noon)
  [/careem food|talabat|noon food|keeta|deliveroo|hardees?|uber ?eats/i, "Food Delivery"],

  // Groceries (specific merchants before generic Amazon/Noon → Shopping)
  [/amazon ?now|amazonufg|maf hyper|waitrose|sainsbury|tesco|asda|\bm&s\b|marks ?& ?spencer|careem deliveries|careem quik|al ain food|noon minutes|%\s?arabica|lulu|carrefour|spinneys|grocer|bigbasket|blinkit|zepto|instashop|supermarket/i, "Groceries"],

  // Restaurants / bars / pubs / dining (bars & pubs → Food & Dining too)
  [/mcdonald|five guys|quick snack selling|royal catering|caribou coffee|kfc|starbucks|restauran|\bcafe\b|dining|\bpub\b|\bbar\b|tavern|brasserie|bistro|gastropub/i, "Food & Dining"],

  // Transport (TfL, e-bikes like Forest, ride-hail, fuel, tolls)
  [/yango|parkonic|zofeur|dubai smart government|\brta\b|\btfl\b|\bforest\b|uber|\bcareem\b|\bola\b|metro|taxi|fuel|petrol|adnoc|enoc|salik/i, "Transport"],

  // Travel
  [/\bvfs\b|emirates|etihad|air ?india|indigo|flight|hotel|booking\.com|airbnb|makemytrip|kiwi/i, "Travel"],

  // Bills & utilities
  [/e&\s?digital|etisalat|tasleem|addc|auh gas|\bdu bill\b|\bdewa\b|electricity|water|internet|mobile|recharge/i, "Bills & Utilities"],

  // Subscriptions
  [/linkedin|apple\.com\/bill|itunes|netflix|spotify|prime|youtube|hotstar|disney|icloud|google one|openai|anthropic|claude|chatgpt|adobe|notion|canva/i, "Subscriptions"],

  // Beauty
  [/urbanclap|urban company|\bsalon\b|\bspa\b|beauty/i, "Beauty"],

  // Housing / rent
  [/asteco|property mgt|property management|\brent\b|ejari/i, "Housing"],

  // Health
  [/mede?ror|medeor|pharmacy|hospital|clinic|aster|medcare|apollo|\bhealth\b|dr\.?\s/i, "Health"],

  // Shopping (generic, after specific Amazon/Noon groceries)
  [/amazon|noon|flipkart|myntra|ikea|namshi|ajio|wh ?smith|store|shop/i, "Shopping"],

  // Entertainment
  [/vox|cinema|pvr|bookmyshow|game|steam|playstation/i, "Entertainment"],

  // Fees (precise — avoid bare "fee" which would catch "coffee")
  [/interest|finance charge|late fee|annual fee|foreign transaction fee|foreign exchange|service fee|markup|\bvat\b/i, "Fees & Interest"],

  // Cash / transfers
  [/\batm\b|cash withdrawal|neft|imps|\bupi\b|transfer/i, "Cash & Transfers"],
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
  { bank: "adcb", label: "ADCB Credit Card", kind: "statement", default: true, shared: true,
    from: "estatement@adcb.com", currency: "AED",
    passwordHint: "Your ADCB Customer ID (SMS 'CID' to 2626 to retrieve)." },
  { bank: "axis-cc", label: "Axis Credit Card", kind: "statement", default: true,
    from: "cc.statements@axis.bank.in", currency: "INR",
    passwordHint: "First 4 letters of name (CAPS) + DOB as DDMM, e.g. CKAJ1102 — or + last 4 digits of the card." },
  { bank: "fab", label: "FAB Credit Card", kind: "statement", default: true,
    from: "estatement@bankfab.com", currency: "AED",
    // FAB emails card, account AND loan statements from the same address —
    // restrict to the credit-card ones ("Statement of FAB Card ending ...").
    query: "subject:card",
    passwordHint: "8 digits: your year of birth + last 4 digits of your registered mobile, e.g. 19804567." },
  { bank: "wio", label: "Wio Credit Card", kind: "statement", default: true, shared: true,
    from: "wio.io", currency: "AED",
    // Wio also emails transfer receipts & invoices as PDFs — restrict to the
    // monthly "Credit Statement" emails (subject) and, as a safety net, only
    // parse attachments whose filename contains "statement" (fileMatch).
    query: "subject:statement", fileMatch: "statement",
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
  // Spouse-only: her ENBD credit cards come from the same sender as the account
  // statement, separated by the household Gmail label. They're two different
  // cards emailed with distinct subjects, so split them by `subject:` so each
  // shows up as its own card.
  { bank: "enbd-noon", label: "ENBD Noon Visa", kind: "statement", default: true, spouseOnly: true,
    from: "statement@emiratesnbd.com", currency: "AED", query: 'subject:noon',
    passwordHint: "Check the Emirates NBD email for the password format." },
  { bank: "enbd-etihad", label: "ENBD Etihad Guest Visa", kind: "statement", default: true, spouseOnly: true,
    from: "statement@emiratesnbd.com", currency: "AED", query: 'subject:"etihad guest"',
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
    // Remembered connected account email, used as a sign-in hint so
    // multi-account users aren't shown the account chooser every refresh.
    googleEmail: "",
    // Per-bank saved PDF passwords (stored locally in this browser only).
    passwords: {},
    // Which sources are enabled for import (credit cards on by default).
    enabledSources: SOURCES.filter((s) => s.default).map((s) => s.bank),
    lookbackMonths: 12,
    // Cross-device sync via the user's private Google Drive app-data folder.
    autoSync: true,
    // Household: import a second person's cards, separated by a Gmail label
    // (their forwarded statements carry it; yours don't). Passwords are local.
    spouseEnabled: false,
    spouseName: "",
    spouseLabel: "",
    spousePasswords: {},
    // Fixed monthly expenses not paid by card (rent, house help, cook, …).
    // Each: { id, description, amount, currency, category, paidVia,
    //         dayOfMonth, startMonth "YYYY-MM", endMonth?, active }
    recurring: [],
  };
}
