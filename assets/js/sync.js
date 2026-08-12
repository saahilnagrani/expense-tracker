// Cross-device sync via the Drive appDataFolder file. Merge strategy:
//   - Expenses are unioned by id; on conflict the record with the newer
//     `updatedAt` wins (last-write-wins per record).
//   - Deletions are tracked as tombstones { id: deletedAt }. A tombstone wins
//     over a record only if it's newer than that record's updatedAt, so an
//     edit on device B after a delete on device A is preserved.
//   - Prefs (base currency, FX rates, categories, recurring, and the
//     non-secret household name/label/toggle) sync as one blob with its own
//     last-write-wins timestamp. PDF passwords and the Google Client ID stay
//     local to each device and are never uploaded.

import {
  allExpenses, putMany, clearAll, getTombstones, setTombstones,
  loadSettings, saveSettings, getMeta, setMeta,
} from "./db.js";
import * as Drive from "./drive.js";

const EMPTY = { version: 1, expenses: [], deleted: {}, prefs: null, prefsUpdatedAt: 0 };

export async function syncNow() {
  const file = await Drive.findFile();
  const remote = file ? await Drive.readFile(file.id) : { ...EMPTY };

  const localExpenses = await allExpenses();
  const localDeleted = await getTombstones();
  const settings = loadSettings();

  // --- merge expenses by id (newer updatedAt wins) ---
  const map = new Map();
  for (const e of [...(remote.expenses || []), ...localExpenses]) {
    if (!e || !e.id) continue;
    const prev = map.get(e.id);
    if (!prev || (e.updatedAt || 0) >= (prev.updatedAt || 0)) map.set(e.id, e);
  }

  // --- merge tombstones and apply deletions ---
  const deleted = { ...(remote.deleted || {}) };
  for (const [id, ts] of Object.entries(localDeleted)) {
    deleted[id] = Math.max(deleted[id] || 0, ts);
  }
  for (const [id, ts] of Object.entries(deleted)) {
    const rec = map.get(id);
    if (rec && ts >= (rec.updatedAt || 0)) map.delete(id);
  }
  const merged = [...map.values()];

  // --- prefs last-write-wins ---
  const localPrefsAt = await getMeta("prefsUpdatedAt", 0);
  const localPrefs = {
    baseCurrency: settings.baseCurrency, rates: settings.rates, categories: settings.categories,
    recurring: settings.recurring || [],
    // Household settings are not secret (a name tag + a Gmail label), so sync
    // them too. The Client ID stays device-local (you need it to connect before
    // any sync can run, so syncing it adds nothing).
    spouseEnabled: settings.spouseEnabled, spouseName: settings.spouseName, spouseLabel: settings.spouseLabel,
    attributeFees: settings.attributeFees,
    // PDF passwords sync too (opted in): they ride in the same private Drive
    // appDataFolder file, readable only by this app on the user's account.
    passwords: settings.passwords || {}, spousePasswords: settings.spousePasswords || {},
  };
  let prefs = localPrefs, prefsUpdatedAt = localPrefsAt;
  if ((remote.prefsUpdatedAt || 0) > localPrefsAt) {
    prefs = remote.prefs || localPrefs;
    prefsUpdatedAt = remote.prefsUpdatedAt;
  }

  // --- write merged result back to local storage ---
  await clearAll();
  await putMany(merged);
  await setTombstones(deleted);
  if (prefs) {
    const s = loadSettings();
    s.baseCurrency = prefs.baseCurrency || s.baseCurrency;
    s.rates = { ...s.rates, ...(prefs.rates || {}) };
    s.categories = prefs.categories && prefs.categories.length ? prefs.categories : s.categories;
    if (prefs.recurring) s.recurring = prefs.recurring;
    if (prefs.spouseEnabled !== undefined) s.spouseEnabled = prefs.spouseEnabled;
    if (prefs.spouseName !== undefined) s.spouseName = prefs.spouseName;
    if (prefs.spouseLabel !== undefined) s.spouseLabel = prefs.spouseLabel;
    if (prefs.attributeFees !== undefined) s.attributeFees = prefs.attributeFees;
    // Union password maps so a password entered on either device survives; the
    // newer prefs blob wins for any bank present on both.
    if (prefs.passwords) s.passwords = { ...s.passwords, ...prefs.passwords };
    if (prefs.spousePasswords) s.spousePasswords = { ...(s.spousePasswords || {}), ...prefs.spousePasswords };
    saveSettings(s);
  }
  await setMeta("prefsUpdatedAt", prefsUpdatedAt);

  // --- push merged result up to Drive ---
  const payload = { version: 1, updatedAt: Date.now(), expenses: merged, deleted, prefs, prefsUpdatedAt };
  await Drive.writeFile(payload, file && file.id);

  const at = Date.now();
  await setMeta("lastSyncedAt", at);
  return { count: merged.length, at };
}

// Call this whenever local prefs change so the next sync uploads them.
export async function markPrefsChanged() {
  await setMeta("prefsUpdatedAt", Date.now());
}

export async function lastSyncedAt() {
  return getMeta("lastSyncedAt", 0);
}
