// Cross-device sync via the Drive appDataFolder file. Merge strategy:
//   - Expenses are unioned by id; on conflict the record with the newer
//     `updatedAt` wins (last-write-wins per record).
//   - Deletions are tracked as tombstones { id: deletedAt }. A tombstone wins
//     over a record only if it's newer than that record's updatedAt, so an
//     edit on device B after a delete on device A is preserved.
//   - Prefs (base currency, FX rates, categories, recurring, the non-secret
//     household name/label/toggle, and the PDF passwords) sync as one blob
//     with its own last-write-wins timestamp. The Google Client ID stays local
//     to each device and is never uploaded.
//   - Password maps are unioned rather than replaced, and what gets pushed
//     back up is the merged result, not whichever raw blob won the timestamp
//     comparison. See buildOutPrefs below.

import {
  allExpenses, putMany, clearAll, getTombstones, setTombstones,
  loadSettings, saveSettings, getMeta, setMeta,
  loadPrefsUpdatedAt, savePrefsUpdatedAt,
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

  // --- merge recurring templates by id (union), never let an empty list on
  // one device wipe the templates on another. Deleted templates are tombstoned
  // (by their id) so a real delete still propagates. ---
  const remoteRec = (remote.prefs && remote.prefs.recurring) || [];
  const localRec = settings.recurring || [];
  const recMap = new Map();
  for (const t of [...remoteRec, ...localRec]) {
    if (!t || !t.id || deleted[t.id]) continue; // local listed last → wins on ties
    recMap.set(t.id, t);
  }
  const mergedRecurring = [...recMap.values()];

  // Trips union by id too. There are only ever a handful, but naming one on
  // your phone and another on the laptop must not lose either.
  const tripMap = new Map();
  for (const t of [...((remote.prefs && remote.prefs.trips) || []), ...(settings.trips || [])]) {
    if (t && t.id) tripMap.set(t.id, t);
  }
  const mergedTrips = [...tripMap.values()];

  // --- prefs last-write-wins ---
  // Take the max so the value written by older builds (IndexedDB meta) isn't
  // lost the first time this runs after the move to localStorage.
  const localPrefsAt = Math.max(loadPrefsUpdatedAt(), await getMeta("prefsUpdatedAt", 0));
  const localPrefs = {
    baseCurrency: settings.baseCurrency, rates: settings.rates, categories: settings.categories,
    recurring: settings.recurring || [], trips: settings.trips || [],
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
  let outPrefs = prefs ? { ...prefs, recurring: mergedRecurring, trips: mergedTrips } : null;
  if (prefs) {
    const s = loadSettings();
    s.baseCurrency = prefs.baseCurrency || s.baseCurrency;
    s.rates = { ...s.rates, ...(prefs.rates || {}) };
    s.categories = prefs.categories && prefs.categories.length ? prefs.categories : s.categories;
    s.recurring = mergedRecurring; // union by id, not last-write-wins
    s.trips = mergedTrips;
    if (prefs.spouseEnabled !== undefined) s.spouseEnabled = prefs.spouseEnabled;
    if (prefs.spouseName !== undefined) s.spouseName = prefs.spouseName;
    if (prefs.spouseLabel !== undefined) s.spouseLabel = prefs.spouseLabel;
    if (prefs.attributeFees !== undefined) s.attributeFees = prefs.attributeFees;
    // Union password maps so a password entered on either device survives; the
    // newer prefs blob wins for any bank present on both. Blank entries are
    // dropped first: a device that once saved empty boxes would otherwise
    // propagate those blanks and wipe the real passwords everywhere else.
    if (prefs.passwords) s.passwords = { ...s.passwords, ...nonEmpty(prefs.passwords) };
    if (prefs.spousePasswords) s.spousePasswords = { ...(s.spousePasswords || {}), ...nonEmpty(prefs.spousePasswords) };
    saveSettings(s);

    // Push what we actually ended up with, NOT the raw blob that won the
    // timestamp comparison. The merge above unions both sides — passwords
    // especially — so uploading the winner instead drops every value that
    // existed on only one device, and keeps dropping it on every later sync:
    // the losing device's passwords could never reach Drive at all.
    outPrefs = buildOutPrefs(s, mergedRecurring, mergedTrips);
    // The merge produced something neither side had, so it is genuinely newer.
    // Without this the enriched blob carries the old timestamp and other
    // devices, already at or past it, never pull the values back down.
    if (normPrefs(outPrefs) !== normPrefs(prefs)) prefsUpdatedAt = Date.now();
  }
  savePrefsUpdatedAt(prefsUpdatedAt);
  await setMeta("prefsUpdatedAt", prefsUpdatedAt); // keep older builds in step

  // --- push merged result up to Drive (with the unioned recurring list) ---
  const payload = { version: 1, updatedAt: Date.now(), expenses: merged, deleted,
    prefs: outPrefs, prefsUpdatedAt };
  await Drive.writeFile(payload, file && file.id);

  const at = Date.now();
  await setMeta("lastSyncedAt", at);
  return { count: merged.length, at };
}

// Drop blank entries from a password map. A stored "" carries no information
// and is indistinguishable from "never set", but unioning it over a real
// password destroys one — so blanks are never stored, uploaded, or applied.
function nonEmpty(map) {
  return Object.fromEntries(Object.entries(map || {}).filter(([, v]) => v));
}

// The synced slice of settings, in a fixed key order.
function buildOutPrefs(s, recurring, trips) {
  return {
    baseCurrency: s.baseCurrency, rates: s.rates, categories: s.categories, recurring, trips,
    spouseEnabled: s.spouseEnabled, spouseName: s.spouseName, spouseLabel: s.spouseLabel,
    attributeFees: s.attributeFees,
    passwords: nonEmpty(s.passwords), spousePasswords: nonEmpty(s.spousePasswords),
  };
}

// Compare two prefs blobs by value. Map key order differs between a merged
// object and the blob it came from, so sort those; `recurring` is skipped
// because both sides are handed the same merged list.
function normPrefs(p) {
  const sorted = (o) => Object.fromEntries(Object.entries(o || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  return JSON.stringify({
    baseCurrency: p.baseCurrency ?? null, rates: sorted(p.rates), categories: p.categories ?? [],
    trips: (p.trips ?? []).map((t) => `${t.id}|${t.name}|${t.from || ""}|${t.to || ""}`).sort(),
    spouseEnabled: p.spouseEnabled ?? null, spouseName: p.spouseName ?? null,
    spouseLabel: p.spouseLabel ?? null, attributeFees: p.attributeFees ?? null,
    passwords: sorted(p.passwords), spousePasswords: sorted(p.spousePasswords),
  });
}

// Call this whenever local prefs change so the next sync uploads them.
export async function markPrefsChanged() {
  const at = Date.now();
  savePrefsUpdatedAt(at);
  await setMeta("prefsUpdatedAt", at);
}

export async function lastSyncedAt() {
  return getMeta("lastSyncedAt", 0);
}
