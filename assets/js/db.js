// IndexedDB storage for expenses + small helpers for settings/meta.
// Expenses live in IndexedDB; settings & sync cursors live in localStorage.

import { SETTINGS_KEY, defaultSettings } from "./config.js";

const DB_NAME = "expense-tracker";
const DB_VERSION = 1;
const STORE = "expenses";
const META = "meta"; // imported message ids, sync info

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("date", "date");
        os.createIndex("dedupeKey", "dedupeKey", { unique: false });
        os.createIndex("gmailMessageId", "gmailMessageId", { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode = "readonly") {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

export async function allExpenses() {
  const os = await tx(STORE);
  return new Promise((resolve, reject) => {
    const req = os.getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => (a.date < b.date ? 1 : -1)));
    req.onerror = () => reject(req.error);
  });
}

export async function putExpense(exp) {
  const os = await tx(STORE, "readwrite");
  return new Promise((resolve, reject) => {
    const req = os.put(exp);
    req.onsuccess = () => resolve(exp);
    req.onerror = () => reject(req.error);
  });
}

export async function putMany(list) {
  const os = await tx(STORE, "readwrite");
  return new Promise((resolve, reject) => {
    let n = 0;
    for (const e of list) os.put(e);
    os.transaction.oncomplete = () => resolve(list.length);
    os.transaction.onerror = () => reject(os.transaction.error);
  });
}

export async function deleteExpense(id) {
  const os = await tx(STORE, "readwrite");
  return new Promise((resolve, reject) => {
    const req = os.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function clearAll() {
  const os = await tx(STORE, "readwrite");
  return new Promise((resolve, reject) => {
    const req = os.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Return a Set of dedupe keys already stored, so imports skip duplicates.
export async function existingDedupeKeys() {
  const list = await allExpenses();
  return new Set(list.map((e) => e.dedupeKey).filter(Boolean));
}

// ---- Settings (localStorage) ----
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const parsed = JSON.parse(raw);
    return { ...defaultSettings(), ...parsed,
      rates: { ...defaultSettings().rates, ...(parsed.rates || {}) },
      passwords: { ...(parsed.passwords || {}) } };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ---- Meta store (import cursors etc.) ----
export async function getMeta(key, fallback = null) {
  const os = await tx(META);
  return new Promise((resolve) => {
    const req = os.get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : fallback);
    req.onerror = () => resolve(fallback);
  });
}

export async function setMeta(key, value) {
  const os = await tx(META, "readwrite");
  return new Promise((resolve, reject) => {
    const req = os.put({ key, value });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ---- Deletion tombstones (so deletes propagate across devices via sync) ----
export async function getTombstones() {
  return getMeta("tombstones", {});
}
export async function setTombstones(t) {
  return setMeta("tombstones", t);
}
export async function recordDeletion(id) {
  const t = await getMeta("tombstones", {});
  t[id] = Date.now();
  await setMeta("tombstones", t);
}

export function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
