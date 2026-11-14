import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { Vault } from "@vectordevai/schema/vault"
import { VaultError } from "@vectordevai/core/vault/error"
import { VaultRemote } from "@vectordevai/core/vault/remote"
import { VaultBackup } from "@vectordevai/core/vault/vault"

// The Vault API client (A44's routes, shapes in @vectordevai/schema/vault) against a fake of the API and its signed
// storage links, held in memory. The account token goes only to the API, never to a storage link.

const BASE = "https://vectordev.test/api/vault"
const STORAGE = "https://storage.vectordev.test"
const encoder = new TextEncoder()

type Request = { url: string; method: string; authorization?: string }

function fakeApi(options: { quota?: number } = {}) {
  let setup: Vault.Setup | undefined
  const objects = new Map<string, Uint8Array>()
  const declared = new Map<string, Map<string, number>>()
  const manifests = new Map<string, { size: number; bytes?: Uint8Array }>()
  const snapshots: Vault.Snapshot[] = []
  const requests: Request[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
  const error = (status: number, code: string) => json(status, { error: { code, message: code } })
  const used = () => [...objects.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0)
  const send: VaultRemote.Send = async (url, init) => {
    const method = init.method ?? "GET"
    const headers = new Headers(init.headers)
    requests.push({ url, method, ...(headers.get("authorization") ? { authorization: headers.get("authorization")! } : {}) })
    if (url.startsWith(STORAGE)) {
      const [, kind, version, id] = new URL(url).pathname.split("/")
      if (method === "PUT") {
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer())
        if (kind === "objects") objects.set(id!, bytes)
        else manifests.get(version!)!.bytes = bytes
        return new Response(null, { status: 200 })
      }
      const bytes = kind === "objects" ? objects.get(id!) : manifests.get(version!)?.bytes
      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 })
    }
    if (headers.get("authorization") !== "Bearer vct_test") return error(401, "CODIUM_SIGN_IN_REQUIRED")
    const route = url.slice(BASE.length)
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    if (route === "/setup" && method === "GET") return setup ? json(200, setup) : error(404, "VAULT_NOT_FOUND")
    if (route === "/setup" && method === "POST") {
      if (setup && setup.vault !== body.vault) return error(409, "VAULT_EXISTS")
      setup = { vault: body.vault, key: body.key, createdAt: Date.now() }
      return json(200, setup)
    }
    if (route === "/uploads") {
      const request = body as Vault.UploadsRequest
      const version = declared.get(request.version) ?? new Map<string, number>()
      declared.set(request.version, version)
      const missing = request.objects.filter((ref) => !objects.has(ref.id))
      if (options.quota !== undefined && used() + missing.reduce((sum, ref) => sum + ref.size, 0) > options.quota)
        return error(402, "VAULT_QUOTA")
      for (const ref of request.objects) version.set(ref.id, ref.size)
      if (request.manifest) manifests.set(request.version, { size: request.manifest.size })
      return json(200, {
        uploads: missing.map((ref) => ({ id: ref.id, url: `${STORAGE}/objects/${request.version}/${ref.id}?sig=1` })),
        present: request.objects.filter((ref) => objects.has(ref.id)).map((ref) => ref.id),
        ...(request.manifest ? { manifest: { url: `${STORAGE}/versions/${request.version}?sig=1` } } : {}),
        expiresAt: Date.now() + 900_000,
      } satisfies Vault.Uploads)
    }
    if (route === "/commit") {
      const request = body as Vault.CommitRequest
      const refs = declared.get(request.version)!
      for (const [id, size] of refs)
        if (objects.get(id)?.byteLength !== size) {
          objects.delete(id)
          return error(409, "VAULT_SIZE_MISMATCH")
        }
      const manifest = manifests.get(request.version)
      if (!manifest?.bytes || manifest.bytes.byteLength !== manifest.size) return error(409, "VAULT_SIZE_MISMATCH")
      const snapshot: Vault.Snapshot = {
        id: request.version,
        createdAt: Number(request.version.slice(1, 14)),
        bytes: manifest.size + [...refs.values()].reduce((sum, size) => sum + size, 0),
        objects: refs.size,
      }
      snapshots.unshift(snapshot)
      return json(200, { snapshot })
    }
    if (route === "/snapshots")
      return json(200, { snapshots, usage: { usedBytes: used(), quotaBytes: options.quota ?? 10e9 }, readOnly: false })
    const match = /^\/snapshots\/([^/]+)$/.exec(route)
    if (match) {
      const id = decodeURIComponent(match[1]!)
      const snapshot = snapshots.find((item) => item.id === id)
      if (!snapshot) return error(404, "VAULT_NOT_FOUND")
      if (method === "GET") return json(200, { snapshot, manifest: { url: `${STORAGE}/versions/${id}?sig=1` } })
      if (method === "POST")
        return json(200, {
          downloads: (body as Vault.DownloadsRequest).objects.map((object) => ({ id: object, url: `${STORAGE}/objects/${id}/${object}?sig=1` })),
        })
      if (method === "DELETE") {
        snapshots.splice(snapshots.indexOf(snapshot), 1)
        return json(200, { deleted: true })
      }
    }
    return error(404, "NOT_FOUND")
  }
  return { send, requests, objects }
}

describe("VaultRemote", () => {
  test("backs up and restores through the API, sending only missing pieces, and the token only to the API", async () => {
    const api = fakeApi()
    const store = VaultRemote.store({ base: BASE, token: "vct_test", send: api.send })
    expect(await store.readKey()).toBeUndefined()
    const created = await VaultBackup.create(store, { cost: 2 ** 14 })
    expect((await store.readKey())?.vault).toBe(created.vault)
    const files = [{ path: "memory/personal.json", section: "memory" as const, bytes: encoder.encode("I prefer tables ".repeat(9000)), repository: "" }]
    const first = await VaultBackup.backup({ store, opened: created, files })
    const second = await VaultBackup.backup({ store, opened: created, files })
    expect(first.uploaded).toBeGreaterThan(0)
    expect(second.uploaded).toBe(0)
    const listing = await store.list()
    expect(listing.snapshots.map((snapshot) => snapshot.id)).toEqual([second.snapshot.id, first.snapshot.id])
    expect(listing.usage?.usedBytes).toBeGreaterThan(0)
    const read = await VaultBackup.read({ store, opened: created })
    expect(read.files[0]!.bytes.toString("utf8")).toBe("I prefer tables ".repeat(9000))
    for (const request of api.requests) {
      if (request.url.startsWith(STORAGE)) expect(request.authorization).toBeUndefined()
      else expect(request.authorization).toBe("Bearer vct_test")
    }
    await VaultBackup.forget({ store, opened: created, version: first.snapshot.id })
    expect((await store.list()).snapshots.map((snapshot) => snapshot.id)).toEqual([second.snapshot.id])
  })

  test("the API's codes become plain refusals: quota, another vault, sign-in", async () => {
    const api = fakeApi({ quota: 100 })
    const store = VaultRemote.store({ base: BASE, token: "vct_test", send: api.send })
    const created = await VaultBackup.create(store, { cost: 2 ** 14 })
    const full = await VaultBackup.backup({
      store,
      opened: created,
      files: [{ path: "memory/personal.json", section: "memory", bytes: encoder.encode(randomBytes(3000).toString("hex")), repository: "" }],
    }).catch((error: unknown) => error)
    expect((full as VaultError).code).toBe("quota")
    expect((full as Error).message).toContain("Your Brain Vault is full")
    expect(api.objects.size).toBe(0)
    const other = await VaultBackup.create(store, { cost: 2 ** 14 }).catch((error: unknown) => error)
    expect((other as VaultError).code).toBe("exists")
    const signedOut = VaultRemote.store({ base: BASE, token: "vct_other", send: api.send })
    const refused = await signedOut.list().catch((error: unknown) => error)
    expect((refused as VaultError).code).toBe("unavailable")
    expect((refused as Error).message).toContain("vector login")
  })
})
