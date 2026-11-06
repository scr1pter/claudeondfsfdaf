import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import { Vault } from "@vectordevai/schema/vault"
import { BrainExport } from "@vectordevai/core/brain/export"
import { VaultChunker } from "@vectordevai/core/vault/chunker"
import { VaultCrypto } from "@vectordevai/core/vault/crypto"
import { VaultError } from "@vectordevai/core/vault/error"
import { VaultFormat } from "@vectordevai/core/vault/format"
import { VaultRecovery } from "@vectordevai/core/vault/recovery"
import { VaultStore } from "@vectordevai/core/vault/store"
import { VaultBackup } from "@vectordevai/core/vault/vault"
import { withKnowledge } from "../brain/fixture/knowledge"

// Brain Vault's core (contract A43, invariant P3): every byte a store holds was encrypted on this computer, a backup
// round-trips, an unchanged chunk is never sent twice, a wrong recovery code opens nothing, a version that needs a
// newer reader is refused before it is read, and a restore keeps approval and pins through the brain's own writes.

// The smallest scrypt cost the format accepts, so most tests stay quick; one test runs the real 2^17.
const COST = 2 ** 14
const encoder = new TextEncoder()

// Text that compresses but does not repeat, so chunks differ and dedup is a real test.
function prose(seed: string, length: number) {
  const words: string[] = []
  for (let i = 0, total = 0; total < length; i++) {
    const word = createHash("sha256").update(`${seed}:${i}`).digest("hex").slice(0, 3 + (i % 9))
    words.push(word)
    total += word.length + 1
  }
  return words.join(" ").slice(0, length)
}

async function fresh(options: { readonly keep?: number } = {}) {
  const store = VaultStore.memory(options)
  const created = await VaultBackup.create(store, { cost: COST })
  return { store, created, opened: { vault: created.vault, vaultKey: created.vaultKey } }
}

async function refusal(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  )
}

describe("VaultRecovery", () => {
  test("a code is 26 base32 symbols and a checksum in seven groups, read back however it is typed", () => {
    const code = VaultRecovery.generate()
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/)
    const body = VaultRecovery.parse(code)
    expect(body).toHaveLength(26)
    expect(VaultRecovery.parse(code.toLowerCase().replaceAll("-", " "))).toBe(body)
    // O, I and L read as 0, 1 and 1.
    const typed = code.replace(/0/g, "O").replace(/1/g, "l")
    expect(VaultRecovery.parse(typed)).toBe(body)
  })

  test("a typo is caught by the checksum before scrypt runs", () => {
    const code = VaultRecovery.generate()
    const at = code.indexOf("-") - 1
    const swapped = code.slice(0, at) + (code[at] === "A" ? "B" : "A") + code.slice(at + 1)
    expect(() => VaultRecovery.parse(swapped)).toThrow(VaultError)
    expect(() => VaultRecovery.parse("ABCD-EFGH")).toThrow("A recovery code has 28 letters and digits")
    expect(VaultRecovery.valid(swapped)).toBe(false)
    expect(VaultRecovery.valid(code)).toBe(true)
  })

  test("the key is wrapped with scrypt N=2^17 by default, and only its own code opens it", async () => {
    const vaultKey = VaultCrypto.vaultKey()
    const vault = VaultCrypto.vaultId()
    const code = VaultRecovery.generate()
    const wrapped = await VaultRecovery.wrap({ vaultKey, vault, code })
    expect(wrapped.kdf).toMatchObject({ name: "scrypt", N: 2 ** 17, r: 8, p: 1 })
    expect(JSON.stringify(wrapped)).not.toContain(VaultCrypto.toBase64Url(vaultKey))
    const opened = await VaultRecovery.unwrap({ wrapped, code })
    expect(Buffer.compare(opened.vaultKey, vaultKey)).toBe(0)
    const wrong = await refusal(VaultRecovery.unwrap({ wrapped, code: VaultRecovery.generate() }))
    expect(wrong).toBeInstanceOf(VaultError)
    expect((wrong as VaultError).code).toBe("wrong-code")
  })

  test("a wrapped key whose scrypt cost is outside 2^14..2^20 is refused as damaged", () => {
    const wrapped = { format: "vector-vault-key", version: 1, vault: VaultCrypto.vaultId(), kdf: { name: "scrypt", N: 2 ** 24, r: 8, p: 1, salt: "AAAA" }, nonce: "AAAA", ciphertext: "AAAA", createdAt: 1 }
    expect(() => VaultRecovery.decodeWrapped(wrapped)).toThrow(VaultError)
  })
})

describe("VaultChunker", () => {
  test("cuts by content within the minimum and maximum, the same way every time", () => {
    const data = encoder.encode(prose("chunker", 1_500_000))
    const gear = VaultCrypto.plainGear("test")
    const ends = VaultChunker.cut(data, gear)
    expect(ends.at(-1)).toBe(data.byteLength)
    const sizes = ends.map((end, i) => end - (ends[i - 1] ?? 0))
    expect(sizes.slice(0, -1).every((size) => size >= VaultChunker.SIZES.min && size <= VaultChunker.SIZES.max)).toBe(true)
    expect(sizes.length).toBeGreaterThan(8)
    expect(VaultChunker.cut(data, gear)).toEqual(ends)
    // Another vault's chunker key cuts elsewhere, so sizes say nothing common to every vault.
    expect(VaultChunker.cut(data, VaultCrypto.plainGear("other"))).not.toEqual(ends)
    expect(VaultChunker.cut(new Uint8Array(0), gear)).toEqual([])
  })
})

describe("VaultBackup", () => {
  test("a backup round-trips, and the store holds only sealed pieces named by keyed HMACs (P3)", async () => {
    const { store, opened, created } = await fresh()
    const secret = "When I say ship it, I mean open a PR and wait for CI"
    const files: VaultBackup.Input[] = [
      { path: "memory/personal.json", section: "memory", bytes: encoder.encode(`${secret} ${prose("a", 200_000)}`), repository: "" },
      { path: "memory/repository-1.json", section: "memory", bytes: encoder.encode(prose("b", 40_000)), repository: "repo-1", worktree: "/work/repo" },
      { path: "memory/empty.json", section: "memory", bytes: new Uint8Array(0), repository: "repo-2" },
    ]
    const done = await VaultBackup.backup({ store, opened, files })
    expect(done.uploaded).toBeGreaterThan(1)
    expect(done.reused).toBe(0)
    const read = await VaultBackup.read({ store, opened })
    expect(read.manifest.id).toBe(done.snapshot.id)
    expect(read.manifest.minReader).toBe(Vault.MIN_READER)
    expect(read.files.map((file) => [file.file.path, file.file.repository, Buffer.from(file.bytes).toString("utf8")])).toEqual(
      files.map((file) => [file.path, file.repository, Buffer.from(file.bytes).toString("utf8")]),
    )
    expect(read.files[1]!.file.worktree).toBe("/work/repo")
    // Each object's declared size is what the store holds, so a server's HEAD check at commit agrees with it.
    for (const ref of read.manifest.objects) expect(store.raw.get(ref.id)?.byteLength).toBe(ref.size)
    // Nothing the store holds reads as the content, and no id is a plain hash of a chunk.
    const plainHashes = new Set(
      files.flatMap((file) => VaultChunker.split(file.bytes, VaultCrypto.gear(VaultCrypto.derive(created.vaultKey)))).map((chunk) =>
        createHash("sha256").update(chunk).digest("hex"),
      ),
    )
    for (const [id, bytes] of store.raw) {
      expect(plainHashes.has(id)).toBe(false)
      expect(Buffer.from(bytes).toString("latin1")).not.toContain("ship it")
      expect(Buffer.from(bytes).subarray(0, 4).toString()).toBe("VVLT")
    }
    const manifest = await store.readManifest(done.snapshot.id)
    expect(Buffer.from(manifest).toString("latin1")).not.toContain("memory/personal.json")
    expect(JSON.stringify(await store.readKey())).not.toContain(VaultCrypto.toBase64Url(created.vaultKey))
  })

  test("an unchanged chunk is not sent again, and an edit sends only the chunks around it", async () => {
    const { store, opened } = await fresh()
    const text = prose("dedup", 1_200_000)
    const first = await VaultBackup.backup({ store, opened, files: [{ path: "memory/personal.json", section: "memory", bytes: encoder.encode(text), repository: "" }] })
    expect(first.uploaded).toBeGreaterThan(8)
    const again = await VaultBackup.backup({ store, opened, files: [{ path: "memory/personal.json", section: "memory", bytes: encoder.encode(text), repository: "" }] })
    expect(again.uploaded).toBe(0)
    expect(again.reused).toBe(first.uploaded)
    const edited = text.slice(0, 600_000) + " a new lesson about retries " + text.slice(600_000)
    const before = store.puts.length
    const third = await VaultBackup.backup({ store, opened, files: [{ path: "memory/personal.json", section: "memory", bytes: encoder.encode(edited), repository: "" }] })
    expect(third.uploaded).toBeGreaterThan(0)
    expect(third.uploaded).toBeLessThanOrEqual(3)
    expect(third.reused).toBeGreaterThan(first.uploaded - 4)
    expect(store.puts.length - before).toBe(third.uploaded)
    expect((await store.list()).snapshots.map((snapshot) => snapshot.id)).toEqual([third, again, first].map((item) => item.snapshot.id))
    const read = await VaultBackup.read({ store, opened })
    expect(Buffer.from(read.files[0]!.bytes).toString("utf8")).toBe(edited)
    const old = await VaultBackup.read({ store, opened, version: first.snapshot.id })
    expect(Buffer.from(old.files[0]!.bytes).toString("utf8")).toBe(text)
  })

  test("a wrong recovery code fails cleanly: a typo before anything is read, another code opens nothing", async () => {
    const { store, created } = await fresh()
    await VaultBackup.backup({
      store,
      opened: created,
      files: [{ path: "memory/personal.json", section: "memory", bytes: encoder.encode("I prefer tables"), repository: "" }],
    })
    const wrong = await refusal(VaultBackup.unlock(store, VaultRecovery.generate()))
    expect(wrong).toBeInstanceOf(VaultError)
    expect((wrong as VaultError).code).toBe("wrong-code")
    expect((wrong as Error).message).toBe("That recovery code does not open this vault. Check it and try again.")
    const typo = await refusal(VaultBackup.unlock(store, created.code.slice(0, -1) + (created.code.endsWith("0") ? "1" : "0")))
    expect((typo as VaultError).code).toBe("typo")
    const right = await VaultBackup.unlock(store, created.code.toLowerCase())
    expect(right.vault).toBe(created.vault)
    expect(Buffer.compare(right.vaultKey, created.vaultKey)).toBe(0)
    // Another vault's key reads nothing of this one.
    const other = { vault: created.vault, vaultKey: VaultCrypto.vaultKey() }
    const damaged = await refusal(VaultBackup.read({ store, opened: other }))
    expect((damaged as VaultError).code).toBe("damaged")
  })

  test("a store that holds another vault is never mixed with this one, and a new vault is not made over an old", async () => {
    const { store, created } = await fresh()
    const again = await refusal(VaultBackup.create(store, { cost: COST }))
    expect((again as VaultError).code).toBe("exists")
    const other = await fresh()
    const mixed = await refusal(VaultBackup.attach(store, other.opened, other.created.wrapped))
    expect((mixed as VaultError).code).toBe("exists")
    await VaultBackup.attach(store, created, created.wrapped)
  })

  test("a piece moved to another name or another vault does not open", async () => {
    const { store, opened } = await fresh()
    const done = await VaultBackup.backup({
      store,
      opened,
      files: [{ path: "memory/personal.json", section: "memory", bytes: encoder.encode(prose("move", 70_000)), repository: "" }],
    })
    const keys = VaultCrypto.derive(opened.vaultKey)
    const [first, second] = [...store.raw.keys()]
    const moved = await refusal(Promise.resolve().then(() => VaultFormat.openChunk(keys, opened.vault, second!, store.raw.get(first!)!)))
    expect((moved as VaultError).code).toBe("damaged")
    const elsewhere = await refusal(Promise.resolve().then(() => VaultFormat.openChunk(keys, VaultCrypto.vaultId(), first!, store.raw.get(first!)!)))
    expect((elsewhere as VaultError).code).toBe("damaged")
    const manifest = Buffer.from(await store.readManifest(done.snapshot.id))
    manifest[manifest.byteLength - 1] ^= 1
    const flipped = await refusal(Promise.resolve().then(() => VaultFormat.openManifest(keys, opened.vault, done.snapshot.id, manifest)))
    expect((flipped as VaultError).code).toBe("damaged")
  })

  test("a version that needs a newer reader is refused with update, and its header cannot be lowered", async () => {
    const { store, opened } = await fresh()
    const keys = VaultCrypto.derive(opened.vaultKey)
    const id = VaultCrypto.versionId(Date.now())
    const newer: Vault.Manifest = {
      format: "vector-vault",
      version: 1,
      minReader: Vault.READER + 1,
      vault: opened.vault,
      id,
      createdAt: Date.now(),
      files: [{ path: "skills/all.json", section: "skills", size: 0, chunks: [] }],
      objects: [],
    }
    const sealed = VaultFormat.sealManifest(keys, newer)
    await store.prepare(id, [])
    await store.commit(id, sealed, [])
    const refused = await refusal(VaultBackup.read({ store, opened, version: id }))
    expect(refused).toBeInstanceOf(VaultError)
    expect((refused as VaultError).code).toBe("update")
    expect((refused as Error).message).toContain("Update Vector")
    // Lowering minReader in the header breaks the tag: the store cannot make an old reader misread a newer backup.
    const lowered = Buffer.from(sealed)
    lowered.writeUInt16BE(Vault.READER, 6)
    const tampered = await refusal(Promise.resolve().then(() => VaultFormat.openManifest(keys, opened.vault, id, lowered)))
    expect((tampered as VaultError).code).toBe("damaged")
    // A newer object format is refused the same way.
    const format = Buffer.from(sealed)
    format[4] = VaultFormat.FORMAT + 1
    const later = await refusal(Promise.resolve().then(() => VaultFormat.openManifest(keys, opened.vault, id, format)))
    expect((later as VaultError).code).toBe("update")
  })

  test("a section this reader does not know is skipped when minReader allows it", async () => {
    const { store, opened } = await fresh()
    const keys = VaultCrypto.derive(opened.vaultKey)
    const id = VaultCrypto.versionId(Date.now())
    const bytes = encoder.encode("{}")
    const chunk = VaultCrypto.objectId(keys, bytes)
    const sealedChunk = VaultFormat.sealChunk(keys, opened.vault, chunk, bytes)
    const manifest: Vault.Manifest = {
      format: "vector-vault",
      version: 1,
      minReader: Vault.READER,
      vault: opened.vault,
      id,
      createdAt: Date.now(),
      files: [
        { path: "memory/personal.json", section: "memory", size: 2, chunks: [chunk], repository: "" },
        { path: "later/thing.json", section: "later", size: 2, chunks: [chunk] },
      ],
      objects: [{ id: chunk, size: sealedChunk.byteLength }],
    }
    await store.prepare(id, manifest.objects)
    await store.putObject(id, chunk, sealedChunk)
    await store.commit(id, VaultFormat.sealManifest(keys, manifest), manifest.objects)
    const read = await VaultBackup.read({ store, opened, version: id })
    expect(read.files.map((file) => file.file.path)).toEqual(["memory/personal.json"])
    expect(read.skipped.map((file) => file.path)).toEqual(["later/thing.json"])
  })

  test("a store that prunes keeps its newest versions and the pieces they name, and forget drops only its own", async () => {
    const { store, opened } = await fresh({ keep: 3 })
    const ids: string[] = []
    // Each file is under the chunker's minimum, so it is exactly one piece whatever this vault's random cut points.
    for (let i = 0; i < 5; i++) {
      const done = await VaultBackup.backup({
        store,
        opened,
        files: [
          { path: "memory/personal.json", section: "memory", bytes: encoder.encode(prose("same", 12_000)), repository: "" },
          { path: "memory/repository-1.json", section: "memory", bytes: encoder.encode(prose(`changes ${i}`, 12_000)), repository: "r" },
        ],
        now: Date.now() + i * 1000,
      })
      ids.push(done.snapshot.id)
      if (i >= 3) expect(done.pruned).toHaveLength(1)
    }
    expect((await store.list()).snapshots.map((snapshot) => snapshot.id)).toEqual(ids.slice(2).reverse())
    // The kept versions all read back, so no piece they name was collected.
    for (const id of ids.slice(2)) await VaultBackup.read({ store, opened, version: id })
    expect(store.raw.size).toBe(4)
    await VaultBackup.forget({ store, opened, version: ids[2]! })
    expect(store.raw.size).toBe(3)
    for (const id of ids.slice(3)) await VaultBackup.read({ store, opened, version: id })
    const missing = await refusal(VaultBackup.forget({ store, opened, version: ids[0]! }))
    expect((missing as VaultError).code).toBe("not-found")
  })
})

describe("restore through the brain (BrainExport.restore)", () => {
  test("memory backed up and restored on another computer keeps what was in use, what waited and pins", async () => {
    const store = VaultStore.memory()
    const created = await VaultBackup.create(store, { cost: COST })
    // This computer: an entry in use and pinned, one in use, one waiting for review, and a document.
    const exported = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const pinned = yield* setup.brain.propose(setup.place, { kind: "preference", text: "I prefer tables for comparisons", scope: "personal", origin: "user", evidence: { type: "user" } })
        if (pinned.type === "refused") throw new Error(pinned.message)
        yield* setup.brain.update(setup.place, pinned.entry.id, { pinned: true }, "user")
        yield* setup.brain.propose(setup.place, { kind: "decision", text: "Keep the billing retries in the worker", scope: "repository", origin: "user", evidence: { type: "user" } })
        yield* setup.brain.propose(setup.place, { kind: "lesson", text: "The flaky upload test needs a longer timeout", scope: "repository", origin: "agent", pending: "review", evidence: { type: "user" } })
        const personal = yield* BrainExport.collect({ brain: setup.brain, knowledge: setup.knowledge, place: setup.place, scope: "personal" })
        const repository = yield* BrainExport.collect({ brain: setup.brain, knowledge: setup.knowledge, place: setup.place, scope: "repository" })
        return { personal, repository }
      }),
    )
    const json = (file: BrainExport.File) => encoder.encode(JSON.stringify(file))
    await VaultBackup.backup({
      store,
      opened: created,
      files: [
        { path: "memory/personal.json", section: "memory", bytes: json(exported.personal), repository: "" },
        { path: "memory/repository-1.json", section: "memory", bytes: json(exported.repository), repository: "repo-1" },
      ],
    })

    // Another computer: only the store and the recovery code.
    const opened = await VaultBackup.unlock(store, created.code)
    const read = await VaultBackup.read({ store, opened })
    const result = await withKnowledge((setup) =>
      Effect.gen(function* () {
        const done = []
        for (const item of read.files) {
          const file = BrainExport.decodeBackup(item.bytes.toString("utf8"))
          if (!file) throw new Error(`${item.file.path} did not decode`)
          done.push(yield* BrainExport.restore({ brain: setup.brain, place: setup.place, file, trust: "vault" }))
        }
        // A second restore of the same version changes nothing.
        const again = []
        for (const item of read.files)
          again.push(yield* BrainExport.restore({ brain: setup.brain, place: setup.place, file: BrainExport.decodeBackup(item.bytes.toString("utf8"))!, trust: "vault" }))
        return { done, again, entries: yield* setup.brain.list(setup.place, { filter: "all" }) }
      }),
    )
    const byText = new Map(result.entries.map((entry) => [entry.text, entry]))
    expect(byText.get("I prefer tables for comparisons")).toMatchObject({ status: "active", pinned: true, scope: "personal" })
    expect(byText.get("Keep the billing retries in the worker")).toMatchObject({ status: "active", pinned: false, scope: "repository" })
    expect(byText.get("The flaky upload test needs a longer timeout")?.status).toBe("proposed")
    expect(result.done.reduce((sum, item) => sum + item.restored, 0)).toBe(3)
    expect(result.done.reduce((sum, item) => sum + item.active, 0)).toBe(2)
    expect(result.done.reduce((sum, item) => sum + item.pinned, 0)).toBe(1)
    expect(result.done.reduce((sum, item) => sum + item.waiting, 0)).toBe(1)
    expect(result.again.reduce((sum, item) => sum + item.restored, 0)).toBe(0)
    expect(result.again.reduce((sum, item) => sum + item.known, 0)).toBe(3)
  })

  test("a file past one import's 500 entries is restored in batches, not cut short", async () => {
    const entries: BrainExport.Item[] = Array.from({ length: 520 }, (_, i) => ({
      id: `m${i}`,
      scope: "repository",
      kind: "fact",
      status: i < 250 ? "active" : "proposed",
      text: `Service ${i} listens on port ${10_000 + i} in staging`,
      paths: [],
      pinned: i === 0,
      evidence: [],
      createdAt: 1,
    }))
    const file: BrainExport.File = { format: "vector-memory", version: 1, scope: "repository", exportedAt: 1, entries, documents: [] }
    expect(BrainExport.batches(entries)).toHaveLength(2)
    // One import (importText) brings in LIMIT.entries of these and leaves the rest.
    expect(BrainExport.parse(JSON.stringify(file)).length).toBeGreaterThan(BrainExport.LIMIT.entries)
    const done = await withKnowledge((setup) => BrainExport.restore({ brain: setup.brain, place: setup.place, file, trust: "vault" }))
    expect(done).toMatchObject({ restored: 520, active: 250, waiting: 270, pinned: 1, refused: 0, batches: 2 })
  })

  test("batches hold at most 500 entries and 2 MB of JSON each", () => {
    expect(BrainExport.batches(Array.from({ length: 1001 }, (_, i) => i), () => 1).map((part) => part.length)).toEqual([500, 500, 1])
    const big = BrainExport.LIMIT.text / 2 + 1
    expect(BrainExport.batches([1, 2, 3], () => big).map((part) => part.length)).toEqual([1, 1, 1])
    expect(BrainExport.batches([], () => 1)).toEqual([])
  })

  test("a backup file of a newer export version, or not an export, is not restored", () => {
    expect(BrainExport.decodeBackup(JSON.stringify({ format: "vector-memory", version: 2, scope: "all", exportedAt: 1, entries: [], documents: [] }))).toBeUndefined()
    expect(BrainExport.decodeBackup("# Vector memory\n\n## Preferences\n\n- I prefer tables")).toBeUndefined()
    expect(BrainExport.decodeBackup(JSON.stringify({ format: "vector-memory", version: 1, scope: "all", exportedAt: 1, entries: [], documents: [] }))).toBeDefined()
  })
})
