// Demo mode (?demo=1): a shareable sandbox seeded with invented data.
//
// Storage isolation lives in config.js / db.js — demo mode uses its own
// IndexedDB database and settings key, so this data can never mix with real
// data in either direction (including when the owner opens their own demo
// link). Gmail and Drive are disabled in demo mode by app.js.
//
// The dataset is generated from a fixed seed, so everyone who opens the link
// sees exactly the same numbers.

import { allExpenses, putMany, clearAll, saveSettings, uid } from "./db.js";
import { defaultSettings } from "./config.js";
import { guessCategory, dedupeKey } from "./parsers.js";

const SEEDED_KEY = "et.demo.seeded";

// Deterministic PRNG (mulberry32) so the demo is identical for every visitor.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CARDS = [
  { card: "ADCB Credit Card", weight: 5 },
  { card: "Wio Credit Card", weight: 3 },
  { card: "FAB Account", weight: 2 },
];

// Merchant, currency, and a plausible amount range. Weight biases frequency.
const MERCHANTS = [
  ["Carrefour Hypermarket", "AED", 60, 420, 9],
  ["Spinneys Dubai Marina", "AED", 45, 300, 5],
  ["Talabat", "AED", 28, 130, 8],
  ["Careem Food", "AED", 30, 110, 4],
  ["Starbucks DIFC", "AED", 18, 55, 6],
  ["Five Guys Mall of Emirates", "AED", 60, 170, 3],
  ["Caribou Coffee", "AED", 15, 48, 4],
  ["Careem Ride", "AED", 18, 95, 7],
  ["Salik Toll Gate", "AED", 4, 4, 6],
  ["ADNOC Petrol Station", "AED", 90, 260, 4],
  ["Amazon.ae", "AED", 45, 640, 5],
  ["Noon.com", "AED", 35, 480, 4],
  ["IKEA Dubai Festival City", "AED", 120, 900, 2],
  ["Netflix.com", "AED", 39, 39, 1],
  ["Spotify AB", "AED", 22, 22, 1],
  ["Apple.com/Bill", "AED", 12, 130, 3],
  ["DEWA Utility Bill", "AED", 310, 620, 1],
  ["Etisalat Home Internet", "AED", 389, 389, 1],
  ["Fitness First Gym", "AED", 250, 250, 1],
  ["Aster Pharmacy", "AED", 35, 190, 3],
  ["VOX Cinemas", "AED", 55, 160, 2],
  ["Bookstore WH Smith", "AED", 30, 95, 2],
  // A UK trip and GBP-billed services — shows multi-currency conversion.
  ["Tesco Express London", "GBP", 8, 46, 3],
  ["Transport for London", "GBP", 3, 18, 4],
  ["Pret A Manger", "GBP", 5, 15, 3],
  ["The Wellington Pub", "GBP", 22, 68, 2],
  ["Booking.com London", "GBP", 120, 340, 1],
  ["ASOS.com", "GBP", 25, 120, 2],
];

function pick(r, list) {
  const total = list.reduce((a, m) => a + m[4], 0);
  let n = r() * total;
  for (const m of list) { n -= m[4]; if (n <= 0) return m; }
  return list[list.length - 1];
}
function pickCard(r) {
  const total = CARDS.reduce((a, c) => a + c.weight, 0);
  let n = r() * total;
  for (const c of CARDS) { n -= c.weight; if (n <= 0) return c.card; }
  return CARDS[0].card;
}
const money = (r, lo, hi) => Math.round((lo + r() * (hi - lo)) * 100) / 100;

// Nine months of history ending with the current month.
export function buildDemoExpenses(now = new Date()) {
  const r = rng(20260819);
  const rows = [];
  const push = (o) => {
    const e = {
      id: uid(), currency: "AED", kind: "expense", source: "statement",
      createdAt: new Date().toISOString(), updatedAt: Date.now(), ...o,
    };
    e.category = e.category || guessCategory(e.description) || "Other";
    e.dedupeKey = dedupeKey(e);
    rows.push(e);
    return e;
  };

  for (let back = 8; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const y = d.getFullYear(), mo = d.getMonth();
    const daysInMonth = new Date(y, mo + 1, 0).getDate();
    // Fewer entries for the current (partial) month.
    const count = back === 0 ? 12 + Math.floor(r() * 8) : 26 + Math.floor(r() * 12);

    for (let i = 0; i < count; i++) {
      const [name, cur, lo, hi] = pick(r, MERCHANTS);
      const day = 1 + Math.floor(r() * (back === 0 ? Math.min(now.getDate(), daysInMonth) : daysInMonth));
      const date = `${y}-${String(mo + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const card = pickCard(r);
      const amount = money(r, lo, hi);
      const t = push({ date, description: name, amount, currency: cur, card });
      // A foreign-currency purchase attracts a markup fee (and its VAT), which
      // is what the fee-attribution feature files under the purchase's category.
      if (cur !== "AED") {
        push({ date, description: "Foreign Currency Transaction Fee", card,
          amount: Math.round(amount * 4.7 * 0.02 * 100) / 100, category: t.category });
      }
    }

    // Monthly card bill payment — a credit that's excluded from spend.
    push({ date: `${y}-${String(mo + 1).padStart(2, "0")}-${String(Math.min(26, daysInMonth)).padStart(2, "0")}`,
      description: "Payment Received - Thank You", amount: money(r, 2200, 6400),
      kind: "credit", card: "ADCB Credit Card", category: "Card Payment" });

    // An occasional refund and some cashback, so credits aren't all bill payments.
    if (r() < 0.4) {
      push({ date: `${y}-${String(mo + 1).padStart(2, "0")}-${String(1 + Math.floor(r() * 20)).padStart(2, "0")}`,
        description: "Amazon.ae Refund", amount: money(r, 40, 260), kind: "credit", card: "ADCB Credit Card" });
    }
    if (r() < 0.5) {
      push({ date: `${y}-${String(mo + 1).padStart(2, "0")}-${String(20 + Math.floor(r() * 8)).padStart(2, "0")}`,
        description: "Cashback Reward", amount: money(r, 12, 70), kind: "credit", card: "Wio Credit Card" });
    }
  }
  return rows;
}

// Fixed monthly expenses paid outside a card, back-filled from the start month.
function demoRecurring(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth() - 8, 1);
  const ym = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`;
  return [
    { id: "demo-rent", description: "Apartment rent", amount: 5500, currency: "AED",
      category: "Housing", paidVia: "Bank transfer", dayOfMonth: 1, startMonth: ym, active: true },
    { id: "demo-help", description: "House help", amount: 800, currency: "AED",
      category: "Housing", paidVia: "Cash", dayOfMonth: 5, startMonth: ym, active: true },
    { id: "demo-school", description: "Swimming lessons", amount: 450, currency: "AED",
      category: "Sports", paidVia: "Bank transfer", dayOfMonth: 8, startMonth: ym, active: true },
  ];
}

export function demoSettings() {
  const s = defaultSettings();
  s.baseCurrency = "AED";
  s.recurring = demoRecurring();
  s.autoSync = false;          // nothing to sync — Drive is off in demo mode
  s.googleClientId = "";
  return s;
}

// Seed once, on first visit. Their edits then persist across refreshes until
// they press Reset — a sandbox that forgets everything on reload reads as
// broken rather than as a demo.
export async function seedDemoIfNeeded() {
  let already = false;
  try { already = !!localStorage.getItem(SEEDED_KEY); } catch {}
  if (already) return false;
  const existing = await allExpenses();
  if (existing.length) { try { localStorage.setItem(SEEDED_KEY, "1"); } catch {} return false; }
  await seedDemo();
  return true;
}

export async function seedDemo() {
  await clearAll();
  saveSettings(demoSettings());
  await putMany(buildDemoExpenses());
  try { localStorage.setItem(SEEDED_KEY, "1"); } catch {}
}
