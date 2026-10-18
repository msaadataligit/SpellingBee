// Everything is stored in this browser only (IndexedDB). Nothing is sent anywhere.

const DB_NAME = 'bee-ready';
const DB_VERSION = 1;
let dbPromise;

function open() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('lists', { keyPath: 'id' });
      const words = db.createObjectStore('words', { keyPath: 'id' });
      words.createIndex('listId', 'listId');
      db.createObjectStore('progress', { keyPath: 'key' }); // per word (lower-case spelling)
      db.createObjectStore('kv', { keyPath: 'k' });          // settings, stats
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(store) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await open();
  return result(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return done(tx);
}

export async function putMany(store, values) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const v of values) os.put(v);
  return done(tx);
}

export async function del(store, key) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

export async function clear(store) {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  return done(tx);
}

export async function wordsOfList(listId) {
  const db = await open();
  const words = await result(db.transaction('words').objectStore('words').index('listId').getAll(listId));
  return words.sort((a, b) => a.n - b.n);
}

export async function deleteList(listId) {
  const db = await open();
  const tx = db.transaction(['lists', 'words'], 'readwrite');
  tx.objectStore('lists').delete(listId);
  const idx = tx.objectStore('words').index('listId');
  idx.openKeyCursor(IDBKeyRange.only(listId)).onsuccess = e => {
    const c = e.target.result;
    if (c) { tx.objectStore('words').delete(c.primaryKey); c.continue(); }
  };
  return done(tx);
}

// ---- Settings & stats (key/value) ----

export const DEFAULT_SETTINGS = {
  accent: 'en-GB',      // 'en-GB' or 'en-US'
  voiceName: '',        // chosen voice (blank = best match for accent)
  rate: 0.9,
  order: 'shuffle',     // 'shuffle' or 'sequence'
  sessionSize: 20,      // words per practice round (0 = all)
  skipKnown: true,      // leave out words already spelled right first time
  timerOn: false,
  timerSeconds: 60,
  sounds: true,
  activeListId: '',
};

export async function getSettings() {
  const row = await get('kv', 'settings');
  return { ...DEFAULT_SETTINGS, ...(row?.v || {}) };
}

export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await put('kv', { k: 'settings', v: s });
  return s;
}

export async function getKV(k, fallback) {
  const row = await get('kv', k);
  return row ? row.v : fallback;
}

export async function setKV(k, v) {
  return put('kv', { k, v });
}

// Ask the browser not to clear our data when space is low (best effort).
export async function requestPersistence() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}

// ---- Backup / restore ----

const STORES = ['lists', 'words', 'progress', 'kv'];

export async function exportAll() {
  const data = { app: 'bee-ready', version: 1, exportedAt: new Date().toISOString() };
  for (const s of STORES) data[s] = await getAll(s);
  return data;
}

export async function importAll(data, { includeLists = true } = {}) {
  if (!data || data.app !== 'bee-ready') throw new Error('This is not a Bee Ready backup file.');
  for (const s of STORES) {
    if (!includeLists && (s === 'lists' || s === 'words')) continue;
    if (!Array.isArray(data[s])) continue;
    await clear(s);
    await putMany(s, data[s]);
  }
}
