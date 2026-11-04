// The keys that open desktop alerts on this phone (WP A38), kept in this origin's IndexedDB so the service worker can
// read them when a push arrives with no page open. Pairing (A41/A42) stores a computer's alert key here; each key is
// imported as a non-extractable AES-GCM key that can only decrypt, so nothing on the page can read its bytes back.
// Signing out and "Disconnect all phones" forget every key.

const DATABASE = "vector-phone"
const STORE = "alert-keys"

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(database.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    database.close()
  }
}

/** Stores a computer's 32-byte alert key under its id. */
export async function saveAlertKey(id: string, raw: Uint8Array) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || raw.length !== 32) throw new Error("That alert key is not valid.")
  const key = await crypto.subtle.importKey("raw", raw.slice(), { name: "AES-GCM" }, false, ["decrypt"])
  await run("readwrite", (store) => store.put(key, id))
}

export async function readAlertKey(id: string): Promise<CryptoKey | undefined> {
  if (!globalThis.indexedDB) return undefined
  const key = await run<unknown>("readonly", (store) => store.get(id))
  return key instanceof CryptoKey ? key : undefined
}

export async function forgetAlertKeys() {
  if (!globalThis.indexedDB) return
  await run("readwrite", (store) => store.clear())
}
