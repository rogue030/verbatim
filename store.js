// Sessions live in IndexedDB on the device. Nothing is uploaded.

const DB_NAME = 'verbatim';
const STORE = 'sessions';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const all = () => run('readonly', (s) => s.getAll());
export const put = (session) => run('readwrite', (s) => s.put(session));
export const remove = (id) => run('readwrite', (s) => s.delete(id));

// Ask Safari not to evict our data under storage pressure.
export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}

export async function usage() {
  try { return await navigator.storage?.estimate?.(); } catch { return null; }
}
