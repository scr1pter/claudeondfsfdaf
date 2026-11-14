export * as VaultRemote from "./remote"

import { Option, Schema } from "effect"
import { Vault } from "@vectordevai/schema/vault"
import { VaultError } from "./error"
import { VaultFormat } from "./format"
import type { VaultStore } from "./store"

// Brain Vault on Vector's servers (A44's API, shapes in @vectordevai/schema/vault): a paid perk, whose quota and plan
// states the server enforces before it signs any upload (S1). The account token goes only to the API; objects travel
// to and from storage through the short-lived links it signs, which carry no token. The server prunes versions by the
// plan's version days and collects the objects no version names, so this store never prunes.

export type Send = (url: string, init: RequestInit) => Promise<Response>

const PLAN_CODES = new Set([
  "MODEL_PLAN_REQUIRED",
  "MODEL_PLAN_PAYMENT_REQUIRED",
  "CODIUM_PERK_REQUIRED",
  "MODEL_PLAN_BLOCKED",
  "MODEL_PLANS_DISABLED",
])

async function failure(response: Response | undefined) {
  if (!response) return new VaultError("unavailable", "Vector could not reach Brain Vault. Try again shortly.")
  const body = (await response.json().catch(() => undefined)) as { error?: { code?: unknown } } | undefined
  const code = typeof body?.error?.code === "string" ? body.error.code : undefined
  if (response.status === 401) return new VaultError("unavailable", "Your Vector sign-in expired. Run vector login, then try again.")
  if (code === "VAULT_QUOTA")
    return new VaultError("quota", "Your Brain Vault is full. Forget an older version, or back up to your own GitHub repository.")
  if (code === "VAULT_READ_ONLY")
    return new VaultError("read-only", "Your Brain Vault takes no new backups while your plan is paused or has ended. Restoring still works.")
  if (code === "VAULT_SIZE_MISMATCH")
    return new VaultError("size-mismatch", "A piece of this backup did not arrive whole. Run the backup again.")
  if (code === "VAULT_NOT_FOUND") return new VaultError("not-found", "Your Brain Vault holds nothing yet.")
  if (code === "VAULT_EXISTS") return new VaultError("exists", "Your account already holds another vault.")
  if (code && PLAN_CODES.has(code))
    return new VaultError("unavailable", "Brain Vault on Vector needs a Vector Codium plan that includes it.")
  return new VaultError("unavailable", `Brain Vault did not answer (${response.status}). Try again shortly.`)
}

export function store(options: {
  /** The Vault API's base, `<site>/api/vault`. */
  readonly base: string
  readonly token: string
  readonly send: Send
  /** Client headers (version, platform) the API reads. */
  readonly headers?: Readonly<Record<string, string>>
}): VaultStore.Store {
  const base = options.base.replace(/\/+$/, "")
  const uploads = new Map<string, Map<string, string>>()

  const api = async <A>(
    method: string,
    route: string,
    schema: Schema.Decoder<A> | undefined,
    body?: unknown,
    allow404 = false,
  ): Promise<A | undefined> => {
    const response = await options
      .send(`${base}${route}`, {
        method,
        headers: {
          ...options.headers,
          authorization: `Bearer ${options.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      })
      .catch(() => undefined)
    if (allow404 && response?.status === 404) return undefined
    if (!response?.ok) throw await failure(response)
    if (!schema) return undefined
    const decoded = Schema.decodeUnknownOption(schema)(await response.json().catch(() => undefined))
    if (Option.isNone(decoded)) throw new VaultError("unavailable", "Brain Vault answered something Vector cannot read. Update Vector.")
    return decoded.value
  }

  // A signed link: no token, no redirect, and no more bytes than an object of the format may take.
  const download = async (url: string, limit: number) => {
    const response = await options
      .send(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(60_000) })
      .catch(() => undefined)
    if (!response?.ok) throw new VaultError("unavailable", "Vector could not download a piece of the backup. Try again shortly.")
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > limit) throw new VaultError("damaged", "A piece of the backup is larger than any piece Vector writes.")
    return bytes
  }

  const upload = async (url: string, bytes: Uint8Array) => {
    const response = await options
      .send(url, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength) },
        body: new Uint8Array(bytes),
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      })
      .catch(() => undefined)
    if (!response?.ok) throw new VaultError("unavailable", "Vector could not upload a piece of the backup. Try again shortly.")
  }

  const version = (id: string) => `/snapshots/${encodeURIComponent(id)}`

  return {
    label: "Brain Vault on Vector",
    readKey: async () => (await api("GET", "/setup", Vault.Setup, undefined, true))?.key,
    writeKey: async (key) => {
      await api("POST", "/setup", Vault.Setup, { vault: key.vault, key } satisfies Vault.SetupRequest)
    },
    prepare: async (id, objects) => {
      const signed = new Map<string, string>()
      for (let start = 0; start < objects.length; start += Vault.LIMIT.batch) {
        const answer = await api("POST", "/uploads", Vault.Uploads, {
          version: id,
          objects: objects.slice(start, start + Vault.LIMIT.batch),
        } satisfies Vault.UploadsRequest)
        for (const item of answer!.uploads) signed.set(item.id, item.url)
      }
      uploads.set(id, signed)
      return new Set(signed.keys())
    },
    putObject: async (id, object, bytes) => {
      const url = uploads.get(id)?.get(object)
      if (!url) throw new VaultError("unavailable", "Brain Vault did not sign that piece.")
      await upload(url, bytes)
    },
    commit: async (id, manifest, objects) => {
      const answer = await api("POST", "/uploads", Vault.Uploads, {
        version: id,
        objects: [],
        manifest: { size: manifest.byteLength },
      } satisfies Vault.UploadsRequest)
      if (!answer!.manifest) throw new VaultError("unavailable", "Brain Vault did not sign the backup's manifest.")
      await upload(answer!.manifest.url, manifest)
      const committed = await api("POST", "/commit", Vault.Commit, {
        version: id,
        objects: objects.length,
      } satisfies Vault.CommitRequest)
      uploads.delete(id)
      return committed!.snapshot
    },
    list: async () => {
      const answer = (await api("GET", "/snapshots", Vault.Snapshots))!
      return {
        snapshots: answer.snapshots,
        usage: answer.usage,
        readOnly: answer.readOnly,
        ...(answer.deleteAt ? { deleteAt: answer.deleteAt } : {}),
      }
    },
    readManifest: async (id) => {
      const answer = (await api("GET", version(id), Vault.SnapshotRead))!
      return download(answer.manifest.url, Vault.LIMIT.manifest + VaultFormat.OVERHEAD)
    },
    readObjects: async (id, ids) => {
      const found = new Map<string, Uint8Array>()
      for (let start = 0; start < ids.length; start += Vault.LIMIT.batch) {
        const answer = (await api("POST", version(id), Vault.Downloads, {
          objects: ids.slice(start, start + Vault.LIMIT.batch),
        } satisfies Vault.DownloadsRequest))!
        const links = answer.downloads.filter((item) => ids.includes(item.id))
        // A few at once: the links expire, and a restore should not open hundreds of connections.
        for (let at = 0; at < links.length; at += 8)
          await Promise.all(
            links.slice(at, at + 8).map(async (item) =>
              found.set(item.id, await download(item.url, Vault.LIMIT.chunk + VaultFormat.OVERHEAD)),
            ),
          )
      }
      return found
    },
    forget: async (id) => {
      await api("DELETE", version(id), undefined)
    },
    destroy: async () => {
      await api("DELETE", "", undefined)
    },
  }
}
