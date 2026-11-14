// What this phone keeps for Vector Remote (WP A42): its relay device id, its static X25519 key pair (the private half
// a non-extractable CryptoKey, so no script on the page can read it back) and the computers it paired with, each with
// its static public key and the id of its passkey. It lives in this origin's IndexedDB; on iPhone that is the
// installed Home Screen app's own storage. Signing out, and pairing again after this phone was removed, forget it.

export type PhoneIdentity = { v: 1; device: string; privateKey: CryptoKey; publicKey: Uint8Array; createdAt: number }

export type PairedComputer = {
  /** The computer's relay device id. */
  device: string
  /** Its static X25519 public key, base64url, from the QR code. */
  key: string
  /** The name it showed when pairing (sent end-to-end encrypted, or in its QR code). */
  name: string
  /** The passkey this phone made for that computer, base64url. */
  credential: string
  /** Where its alert key is kept (alert-keys.ts), when it sent one. */
  alertKeyId?: string
  pairedAt: number
}

export type RemoteRecord = { identity?: PhoneIdentity; computers: PairedComputer[] }

export type RemoteStore = {
  read(): Promise<RemoteRecord>
  write(record: RemoteRecord): Promise<void>
  clear(): Promise<void>
}

const DATABASE = "vector-phone-remote"
const STORE = "remote"
const KEY = "record"
const DEVICE = /^[A-Za-z0-9_-]{21}[AQgw]$/

/** Reads a stored record leniently: anything malformed is left out, so a bad entry never locks the phone out. */
export function decodeRecord(value: unknown): RemoteRecord {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const identity = input.identity as Record<string, unknown> | undefined
  const usable =
    identity &&
    identity.v === 1 &&
    typeof identity.device === "string" &&
    DEVICE.test(identity.device) &&
    typeof CryptoKey !== "undefined" &&
    identity.privateKey instanceof CryptoKey &&
    identity.publicKey instanceof Uint8Array &&
    identity.publicKey.byteLength === 32 &&
    typeof identity.createdAt === "number"
  const computers = Array.isArray(input.computers)
    ? input.computers.flatMap((item): PairedComputer[] => {
        if (!item || typeof item !== "object") return []
        const computer = item as Record<string, unknown>
        if (typeof computer.device !== "string" || !DEVICE.test(computer.device)) return []
        if (typeof computer.key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(computer.key)) return []
        if (typeof computer.credential !== "string" || !/^[A-Za-z0-9_-]{16,1400}$/.test(computer.credential)) return []
        if (typeof computer.name !== "string" || typeof computer.pairedAt !== "number") return []
        const alertKeyId =
          typeof computer.alertKeyId === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(computer.alertKeyId)
            ? computer.alertKeyId
            : undefined
        return [
          {
            device: computer.device,
            key: computer.key,
            name: computer.name.slice(0, 64),
            credential: computer.credential,
            ...(alertKeyId ? { alertKeyId } : {}),
            pairedAt: computer.pairedAt,
          },
        ]
      })
    : []
  return { ...(usable ? { identity: identity as unknown as PhoneIdentity } : {}), computers: computers.slice(0, 16) }
}

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

/** The phone's store in IndexedDB. A browser without it can still pair for this page's life, in memory. */
export function browserRemoteStore(): RemoteStore {
  if (!globalThis.indexedDB) return memoryRemoteStore()
  return {
    read: async () => decodeRecord(await run<unknown>("readonly", (store) => store.get(KEY))),
    write: async (record) => {
      await run("readwrite", (store) => store.put(record, KEY))
    },
    clear: async () => {
      await run("readwrite", (store) => store.delete(KEY))
    },
  }
}

export function memoryRemoteStore(initial: RemoteRecord = { computers: [] }): RemoteStore {
  let record = initial
  return {
    read: async () => decodeRecord(record),
    write: async (next) => {
      record = { ...next, computers: next.computers.slice() }
    },
    clear: async () => {
      record = { computers: [] }
    },
  }
}
