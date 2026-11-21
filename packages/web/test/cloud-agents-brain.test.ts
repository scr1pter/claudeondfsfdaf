import { afterAll, beforeAll, expect, test } from "bun:test"
import { RedisClient } from "bun"
import { createCipheriv, createHash, randomBytes, randomInt, randomUUID } from "node:crypto"
import { BRAIN_UPLOAD_TTL, bindBrainUpload, commitBrainUpload, eraseBrainUploads, prepareBrainUpload, readBrainUpload } from "../../../api/_lib/cloud-agents-brain"
import type { persistentStore } from "../../../api/_lib/persistent-store"

const env = { VECTOR_RUN_ARTIFACT_SECRET: "brain-upload-fixture-secret-at-least-32-characters" }
const bytes = (privateEntry = false, skills = false) => Buffer.from(JSON.stringify({
  format: "vector-brain-run", version: 1,
  memory: { format: "vector-memory", version: 1, scope: "repository", exportedAt: Date.now(), documents: [],
    entries: [{ id: "mem_fixture", scope: "repository", kind: "lesson", status: "active", private: privateEntry,
      text: "private approved repository knowledge", paths: [], pinned: false, evidence: [], createdAt: Date.now() }],
    skills: skills ? [{ id: "mem_skill", scope: "repository", kind: "skill", status: "active",
      text: "A checked procedure", skill: { name: "check", procedure: "Run the focused check" } }] : [],
  }, insights: { format: "vector-workflow-insights", version: 1, rows: [] },
}))
function envelope(prepared: { key: string; aad: string }, content: Uint8Array) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(prepared.key, "base64url"), nonce)
  cipher.setAAD(Buffer.from(prepared.aad))
  return { nonce: nonce.toString("base64url"), ciphertext: Buffer.concat([cipher.update(content), cipher.final(), cipher.getAuthTag()]).toString("base64url") }
}

// A source check, so it runs without Redis: Upstash, Valkey and Redis Cluster all need every key a script touches to
// arrive in KEYS. A key built from ARGV or a string, or read through an index the call site did not declare, is refused.
test("every Redis key a Brain upload script touches is a declared KEYS entry, never an ARGV or built name", async () => {
  const source = await Bun.file(new URL("../../../api/_lib/cloud-agents-brain.ts", import.meta.url)).text()
  const raw = Object.fromEntries([...source.matchAll(/^const ([A-Z_]+) = `([\s\S]*?)`$/gm)].map((match) => [match[1]!, match[2]!]))
  expect(Object.keys(raw).sort()).toEqual(["ERASE", "GUARD", "PREPARE", "UPDATE"])
  for (const body of Object.values(raw)) for (const [, inner] of body.matchAll(/\$\{([^}]*)\}/g)) expect(Object.keys(raw)).toContain(inner!)
  const scripts = Object.fromEntries(Object.entries(raw).map(([name, body]) => [name, body.replace(/\$\{([A-Z_]+)\}/g, (_, inner: string) => raw[inner]!)]))
  // The fixed count is the number of named keys; `members` adds the account index snapshot after them.
  const sites = [...source.matchAll(/"EVAL",\s*([A-Z_]+),\s*(\d+)(\s*\+\s*members\.length)?,/g)]
    .map((match) => ({ name: match[1]!, fixed: Number(match[2]), members: match[3] !== undefined }))
    .sort((a, b) => a.name.localeCompare(b.name))
  expect(sites).toEqual([{ name: "ERASE", fixed: 2, members: true }, { name: "PREPARE", fixed: 5, members: true }, { name: "UPDATE", fixed: 4, members: false }])
  for (const [name, body] of Object.entries(raw).filter(([, body]) => /redis\.p?call\(/.test(body)))
    expect(sites.some((site) => site.name === name || raw[site.name]!.includes(`\${${name}}`))).toBe(true)
  for (const site of sites) {
    const script = scripts[site.name]!
    const calls = [...script.matchAll(/redis\.p?call\(([^()]*)\)/g)].map((match) => match[1]!.split(",").map((part) => part.trim()))
    // A call whose arguments hold parentheses (a built key) escapes the parser, so the counts must agree.
    expect(calls.length).toBe(script.match(/redis\.p?call\(/g)!.length)
    const headers = /\bfor\s+([a-z_]+(?:\s*,\s*[a-z_]+)?)\s*(=|in)\s*(.*?)\s+do\b/g
    const loops = [...script.matchAll(headers)]
      .map((match) => ({ names: match[1]!.split(",").map((name) => name.trim()), op: match[2]!, header: match[3]!.trim() }))
    const unlooped = script.replace(headers, "")
    const declared = (index: string) => {
      if (/^\d+$/.test(index)) return Number(index) >= 1 && Number(index) <= site.fixed
      if (!/^[a-z_]+$/.test(index)) return false
      // Only a loop header may bind an index: `local i = tonumber(ARGV[1])` before a `KEYS[i]` outside any loop would let
      // an argument pick the key, even while another loop binds `i` too.
      if (new RegExp(`\\blocal\\s+(?:[a-z_]+\\s*,\\s*)*${index}\\b|\\b${index}\\s*(?:,\\s*[a-z_]+\\s*)*=(?!=)|\\bfunction\\b[^)]*\\b${index}\\b`).test(unlooped))
        return false
      const bound = loops.filter((loop) => loop.names.includes(index))
      return bound.length > 0 && bound.every((loop) => loop.names[0] === index && (loop.op === "="
        ? site.members && loop.header === `${site.fixed + 1}, #KEYS`
        : /^ipairs\(\{[^}]*\}\)$/.test(loop.header) && loop.header.slice(8, -2).split(",").length <= site.fixed))
    }
    for (const [command, ...args] of calls) {
      expect({ script: site.name, command }).toEqual({ script: site.name, command: expect.stringMatching(/^'[A-Z]+'$/) })
      const keys = command === "'DEL'" || command === "'EXISTS'" ? args : args.slice(0, 1)
      expect(keys.length).toBeGreaterThan(0)
      for (const key of keys) {
        const index = /^KEYS\[([^\]]+)\]$/.exec(key)?.[1]
        expect({ script: site.name, command, key, declared: index !== undefined && declared(index) }).toEqual({ script: site.name, command, key, declared: true })
      }
    }
    for (const [, index] of script.matchAll(/KEYS\[([^\]]*)\]/g))
      expect({ script: site.name, index, declared: declared(index!) }).toEqual({ script: site.name, index, declared: true })
  }
})

const configured = process.env.VECTOR_TEST_REDIS_URL
if (!configured) test.skip("Brain upload integration requires disposable loopback VECTOR_TEST_REDIS_URL", () => {})
else {
  const url = new URL(configured)
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Brain upload tests require loopback Redis")
  const redis = new RedisClient(url.href, { connectionTimeout: 1000, enableOfflineQueue: false })
  const keys = new Set<string>()
  // A test may hold a command before it reaches Redis, or replace it; reads through `redis` itself are untracked.
  const gate: { before?: (command: readonly (string | number)[]) => Promise<readonly (string | number)[] | void> } = {}
  const store: typeof persistentStore = async (command) => {
    const offset = command[0] === "EVAL" ? 3 : 1
    const count = command[0] === "EVAL" ? Number(command[2]) : 1
    command.slice(offset, offset + count).forEach((key) => keys.add(String(key)))
    const sent = (await gate.before?.(command)) ?? command
    return redis.send(String(sent[0]), sent.slice(1).map(String))
  }
  beforeAll(async () => { await redis.connect() })
  afterAll(async () => { if (keys.size) await redis.send("DEL", [...keys]); redis.close() })
  const uploadKey = (uploadId: string) => `vector:cloud-agents:brain:${uploadId}`
  const indexKey = (account: string) => `vector:cloud-agents:brain:account:${account}`
  const revokedKey = (account: string) => `vector:cli-revoked:${account}`
  async function bound(account = randomUUID()) {
    const identity = { account, repositoryId: String(randomInt(100_000_000, 900_000_000)), generation: 1 }
    await store(["HSET", `vector:cloud-agents:binding:${identity.repositoryId}`, "account", identity.account, "generation", "1"])
    await store(["SET", `vector:cloud-agents:gen:${identity.repositoryId}`, "1"])
    return identity
  }
  const select = (identity: Awaited<ReturnType<typeof bound>>, content = bytes(), publicRepository = false) => ({ ...identity, publicRepository,
    source: "desktop" as const, includeBrain: true as const, sha256: createHash("sha256").update(content).digest("hex"), bytes: content.length })
  async function fixture(publicRepository = false) {
    const identity = await bound()
    const content = bytes()
    const selection = select(identity, content, publicRepository)
    const prepared = await prepareBrainUpload(selection, { store, env })
    return { identity, selection, prepared, content, encrypted: envelope(prepared, content) }
  }
  // Holds matching commands; `reached` settles once `count` have arrived and every one waits for release().
  function hold(match: (command: readonly (string | number)[]) => boolean, count = 1) {
    const open = Promise.withResolvers<void>()
    const reached = Promise.withResolvers<void>()
    const arrived = { count: 0 }
    gate.before = async (command) => {
      if (!match(command)) return
      if (++arrived.count === count) reached.resolve()
      await open.promise
    }
    return { reached: reached.promise, release: () => open.resolve() }
  }
  const isUpdate = (uploadId: string, account: string) => (command: readonly (string | number)[]) =>
    command[0] === "EVAL" && command[3] === uploadKey(uploadId) && command[4] === revokedKey(account)
  const isPrepare = (account: string) => (command: readonly (string | number)[]) => command[0] === "EVAL" && command[4] === indexKey(account)
  const isErase = (account: string) => (command: readonly (string | number)[]) =>
    command[0] === "EVAL" && command[3] === indexKey(account) && command[4] === revokedKey(account)
  async function expire(key: string) {
    await redis.send("PEXPIRE", [key, "1"])
    const until = Date.now() + 2_000
    while ((await redis.send("PTTL", [key])) !== -2) {
      if (Date.now() > until) throw new Error(`${key} did not expire`)
      await Bun.sleep(5)
    }
  }
  // The shared lane Valkey holds other files' uploads too, so only this account's keys count.
  async function leftovers(account: string) {
    const found: string[] = []
    const scan = { cursor: "0" }
    do {
      const [cursor, batch] = (await redis.send("SCAN", [scan.cursor, "MATCH", "vector:cloud-agents:brain:*", "COUNT", "1000"])) as [string, string[]]
      scan.cursor = cursor
      for (const key of batch) {
        if (key.startsWith("vector:cloud-agents:brain:account:")) { if (key === indexKey(account)) found.push(key); continue }
        const value = await redis.send("GET", [key])
        if (typeof value === "string" && JSON.parse(value).account === account) found.push(key)
      }
    } while (scan.cursor !== "0")
    return found.sort()
  }

  test("only ciphertext and wrapped key persist; one exact ticket can read the approved bytes", async () => {
    const f = await fixture()
    // Commit needs no unwrapping secret: it must never decrypt either the key or repository payload.
    const approval = await commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted }, { store, env: {} })
    const raw = String(await store(["GET", `vector:cloud-agents:brain:${f.prepared.uploadId}`]))
    expect(raw).not.toContain("private approved repository knowledge")
    expect(raw).not.toContain(f.prepared.key)
    expect(Number(await store(["PTTL", `vector:cloud-agents:brain:${f.prepared.uploadId}`]))).toBeLessThanOrEqual(BRAIN_UPLOAD_TTL)
    const binding = { ...f.identity, uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash: "a".repeat(64) }
    expect(await bindBrainUpload(binding, { store, env })).toEqual(approval)
    expect(await bindBrainUpload(binding, { store, env })).toEqual(approval)
    await expect(bindBrainUpload({ ...binding, ticketHash: "b".repeat(64) }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    const reader = { ...binding, originalSource: "desktop" as const, deadline: Date.now() + 60_000 }
    expect(await readBrainUpload(reader, { store, env })).toMatchObject({ ...approval, ...f.encrypted, key: f.prepared.key, aad: f.prepared.aad })
    await expect(readBrainUpload({ ...reader, ticketHash: "c".repeat(64) }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await expect(readBrainUpload({ ...reader, account: randomUUID() }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await expect(readBrainUpload({ ...reader, deadline: Date.now() - 1 }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
  })

  test("a generation change, revocation, or expiry refuses even an already bound upload", async () => {
    const f = await fixture()
    await commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted }, { store, env })
    const reader = { ...f.identity, uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash: "a".repeat(64),
      originalSource: "desktop" as const, deadline: Date.now() + BRAIN_UPLOAD_TTL * 2 }
    await bindBrainUpload(reader, { store, env })
    await store(["SET", `vector:cloud-agents:gen:${f.identity.repositoryId}`, "2"])
    await expect(readBrainUpload(reader, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await store(["SET", `vector:cloud-agents:gen:${f.identity.repositoryId}`, "1"])
    await expect(readBrainUpload(reader, { store, env, now: () => f.prepared.expiresAt + 1 })).rejects.toMatchObject({ statusCode: 400 })
    await store(["SET", `vector:cli-revoked:${f.identity.account}`, "1"])
    await expect(readBrainUpload(reader, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await eraseBrainUploads(f.identity.account, store)
    expect(await store(["GET", `vector:cloud-agents:brain:${f.prepared.uploadId}`])).toBeNull()
    expect(await store(["EXISTS", `vector:cloud-agents:brain:account:${f.identity.account}`])).toBe(0)
  })

  test("the server stores opaque ciphertext without inspecting even deliberately invalid plaintext; malformed framing refuses", async () => {
    const f = await fixture(true)
    for (const content of [bytes(true), bytes(false, true)]) {
      const prepared = await prepareBrainUpload({ ...f.selection, bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex") }, { store, env })
      // An adversarial owner can encrypt arbitrary bytes. The shipping client and authenticated run reader, rather
      // than a Vector server, enforce the repository/public plaintext schema after local decryption.
      await expect(commitBrainUpload({ account: f.identity.account, uploadId: prepared.uploadId, ...envelope(prepared, content) }, { store, env })).resolves.toMatchObject({ sha256: createHash("sha256").update(content).digest("hex") })
    }
    await expect(commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted, nonce: "AA" }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await expect(commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted, ciphertext: "AA" }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await expect(bindBrainUpload({ ...f.identity, uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash: "a".repeat(64) }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
  })

  test("two concurrent ticket claims admit exactly one and persistent storage failure grants nothing", async () => {
    const f = await fixture()
    await commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted }, { store, env })
    const outcomes = await Promise.allSettled(["a", "b"].map((letter) => bindBrainUpload({ ...f.identity,
      uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash: letter.repeat(64) }, { store, env })))
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    await expect(prepareBrainUpload(f.selection, { env, store: async () => { throw new Error("offline") } })).rejects.toMatchObject({ statusCode: 503 })
  })

  test("two concurrent commits of one upload store exactly one envelope, and a bound upload refuses another commit", async () => {
    const f = await fixture()
    const commit = (encrypted: { nonce: string; ciphertext: string }) => commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...encrypted }, { store, env })
    const envelopes = [f.encrypted, envelope(f.prepared, f.content)]
    // Both reads finish before either atomic write: the second write must see the first and refuse.
    const barrier = hold(isUpdate(f.prepared.uploadId, f.identity.account), 2)
    void barrier.reached.then(barrier.release)
    const outcomes = await Promise.allSettled(envelopes.map(commit)).finally(() => { gate.before = undefined })
    expect(outcomes.map((item) => item.status).sort()).toEqual(["fulfilled", "rejected"])
    expect(outcomes.find((item) => item.status === "rejected")).toMatchObject({ reason: { statusCode: 400 } })
    const winner = envelopes[outcomes.findIndex((item) => item.status === "fulfilled")]
    const stored = async () => JSON.parse(String(await redis.send("GET", [uploadKey(f.prepared.uploadId)]))).envelope
    expect(await stored()).toEqual(winner)
    await bindBrainUpload({ ...f.identity, uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash: "a".repeat(64) }, { store, env })
    await expect(commit(envelopes[0] === winner ? envelopes[1]! : envelopes[0]!)).rejects.toMatchObject({ statusCode: 400 })
    expect(await stored()).toEqual(winner)
  })

  test("commit and read refuse an expired upload, including one that expires between the read and the atomic write", async () => {
    const f = await fixture()
    const commit = (now?: () => number) => commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted }, { store, env, now })
    const stored = async (uploadId: string) => JSON.parse(String(await redis.send("GET", [uploadKey(uploadId)])))
    // At the stored expiry the read refuses before any write.
    await expect(commit(() => f.prepared.expiresAt)).rejects.toMatchObject({ statusCode: 400 })
    expect((await stored(f.prepared.uploadId)).envelope).toBeUndefined()
    // A slow write: the read accepted one millisecond before expiry, and the script's time argument then reaches it.
    // The argument is rewritten in flight because update() takes the clock before it calls the store.
    gate.before = async (command) => {
      if (!isUpdate(f.prepared.uploadId, f.identity.account)(command)) return
      expect(command.at(-1)).toBe(f.prepared.expiresAt - 1)
      return [...command.slice(0, -1), f.prepared.expiresAt]
    }
    await expect(commit(() => f.prepared.expiresAt - 1).finally(() => { gate.before = undefined })).rejects.toMatchObject({ statusCode: 400 })
    expect((await stored(f.prepared.uploadId)).envelope).toBeUndefined()
    // Redis expiry: a bound upload can no longer be read and a prepared one can no longer be committed.
    await commit()
    const binding = { ...f.identity, uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash: "a".repeat(64) }
    await bindBrainUpload(binding, { store, env })
    const pending = await prepareBrainUpload(f.selection, { store, env })
    await Promise.all([expire(uploadKey(f.prepared.uploadId)), expire(uploadKey(pending.uploadId))])
    await expect(readBrainUpload({ ...binding, originalSource: "desktop", deadline: Date.now() + 60_000 }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    await expect(commitBrainUpload({ account: f.identity.account, uploadId: pending.uploadId, ...envelope(pending, f.content) }, { store, env })).rejects.toMatchObject({ statusCode: 400 })
  })

  test("the ciphertext and key wrap share one key whose expiry never grows past the upload TTL or the account index", async () => {
    const f = await fixture()
    // A writer whose clock runs a minute behind the one that prepared the upload.
    const behind = { store, env, now: () => Date.now() - 60_000 }
    const seen: number[] = []
    async function check() {
      // One script, so both remaining times are read at the same instant.
      const [upload, index] = (await redis.send("EVAL", ["return {redis.call('PTTL', KEYS[1]), redis.call('PTTL', KEYS[2])}", "2",
        uploadKey(f.prepared.uploadId), indexKey(f.identity.account)])) as [number, number]
      expect(upload).toBeGreaterThan(0)
      expect(upload).toBeLessThanOrEqual(Math.min(BRAIN_UPLOAD_TTL, seen.at(-1) ?? BRAIN_UPLOAD_TTL))
      expect(index).toBeGreaterThanOrEqual(upload)
      seen.push(upload)
    }
    await check()
    await commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted }, behind)
    await check()
    const binding = { ...f.identity, uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash: "a".repeat(64) }
    await bindBrainUpload(binding, behind)
    await check()
    await readBrainUpload({ ...binding, originalSource: "desktop", deadline: Date.now() + 60_000 }, behind)
    await check()
    const raw = JSON.parse(String(await redis.send("GET", [uploadKey(f.prepared.uploadId)])))
    expect(Object.keys(raw.wrapped).sort()).toEqual(["ciphertext", "nonce"])
    expect(raw.envelope).toEqual(f.encrypted)
    expect(await leftovers(f.identity.account)).toEqual([indexKey(f.identity.account), uploadKey(f.prepared.uploadId)].sort())
    // A key that has lost its expiry is corrupt (503): the write neither gives it one nor answers "prepare again".
    await redis.send("PERSIST", [uploadKey(f.prepared.uploadId)])
    await expect(readBrainUpload({ ...binding, originalSource: "desktop", deadline: Date.now() + 60_000 }, { store, env }))
      .rejects.toMatchObject({ statusCode: 503, code: "BRAIN_UPLOAD_UNAVAILABLE" })
    expect(await redis.send("PTTL", [uploadKey(f.prepared.uploadId)])).toBe(-1)
  })

  test("concurrent prepares never push an account past eight outstanding uploads", async () => {
    const f = await fixture()
    const prepare = () => prepareBrainUpload(f.selection, { store, env })
    const prepared = [f.prepared.uploadId]
    for (const _ of Array.from({ length: 6 })) prepared.push((await prepare()).uploadId)
    // All four snapshot the same seven members before any script runs; only the first script may add the eighth.
    const barrier = hold(isPrepare(f.identity.account), 4)
    void barrier.reached.then(barrier.release)
    const outcomes = await Promise.allSettled(Array.from({ length: 4 }, prepare)).finally(() => { gate.before = undefined })
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter((item) => item.status === "rejected")).toEqual(Array.from({ length: 3 }, () =>
      expect.objectContaining({ reason: expect.objectContaining({ statusCode: 503, code: "BRAIN_UPLOAD_UNAVAILABLE" }) })))
    const members = (await redis.send("SMEMBERS", [indexKey(f.identity.account)])) as string[]
    expect(members).toHaveLength(8)
    expect(await redis.send("EXISTS", members)).toBe(8)
    await expect(prepare()).rejects.toMatchObject({ statusCode: 400, code: "BRAIN_UPLOAD_INVALID" })
    // An expired member no longer counts: the next prepare removes it and takes its place.
    await expire(uploadKey(prepared[0]!))
    const replacement = await prepare()
    const after = (await redis.send("SMEMBERS", [indexKey(f.identity.account)])) as string[]
    expect(after).toHaveLength(8)
    expect(after).not.toContain(uploadKey(prepared[0]!))
    expect(after).toContain(uploadKey(replacement.uploadId))
  })

  test("account erasure racing a prepare or a commit leaves no upload, key wrap or index behind", async () => {
    const revoke = (account: string) => store(["SET", revokedKey(account), "1"])
    async function clean(account: string) {
      expect(await leftovers(account)).toEqual([])
      expect(await redis.send("EXISTS", [indexKey(account)])).toBe(0)
    }
    // (a) Erasure runs while a first prepare waits to write: the script sees the revocation and writes nothing.
    const a = await bound()
    const writing = hold(isPrepare(a.account))
    const prepare = prepareBrainUpload(select(a), { store, env })
    await writing.reached
    await revoke(a.account)
    await eraseBrainUploads(a.account, store)
    writing.release()
    await expect(prepare.finally(() => { gate.before = undefined })).rejects.toMatchObject({ statusCode: 400 })
    await clean(a.account)
    // (b) A prepare while the erasure waits to write is refused by the revocation mark that erasure needs first. It
    // leaves the index the erasure read unchanged, so the held erasure still answers OK and removes every member.
    const b = await fixture()
    await revoke(b.identity.account)
    const erasing = hold(isErase(b.identity.account))
    const erase = eraseBrainUploads(b.identity.account, store)
    await erasing.reached
    const indexed = async () => ((await redis.send("SMEMBERS", [indexKey(b.identity.account)])) as string[]).sort()
    expect(await indexed()).toEqual([uploadKey(b.prepared.uploadId)])
    await expect(prepareBrainUpload(b.selection, { store, env })).rejects.toMatchObject({ statusCode: 400 })
    expect(await indexed()).toEqual([uploadKey(b.prepared.uploadId)])
    erasing.release()
    // eraseBrainUploads resolves only on the script's OK.
    await erase.finally(() => { gate.before = undefined })
    await clean(b.identity.account)
    // (c) A completed prepare, then revocation and erasure.
    const c = await fixture()
    await prepareBrainUpload(c.selection, { store, env })
    await revoke(c.identity.account)
    await eraseBrainUploads(c.identity.account, store)
    await clean(c.identity.account)
    // (d) Erasure runs while a commit waits to write: the commit cannot recreate the erased upload.
    const d = await fixture()
    const committing = hold(isUpdate(d.prepared.uploadId, d.identity.account))
    const commit = commitBrainUpload({ account: d.identity.account, uploadId: d.prepared.uploadId, ...d.encrypted }, { store, env })
    await committing.reached
    await revoke(d.identity.account)
    await eraseBrainUploads(d.identity.account, store)
    committing.release()
    await expect(commit.finally(() => { gate.before = undefined })).rejects.toMatchObject({ statusCode: 400 })
    await clean(d.identity.account)
  })

  test("a read needs a committed, bound upload of the exact repository, generation and desktop source", async () => {
    const f = await fixture()
    const ticketHash = "a".repeat(64)
    const reader = { ...f.identity, uploadId: f.prepared.uploadId, ticketHash, originalSource: "desktop" as const, deadline: Date.now() + 60_000 }
    const read = (change: Partial<typeof reader> = {}) => readBrainUpload({ ...reader, ...change }, { store, env })
    await expect(read()).rejects.toMatchObject({ statusCode: 400 })
    await commitBrainUpload({ account: f.identity.account, uploadId: f.prepared.uploadId, ...f.encrypted }, { store, env })
    await expect(read()).rejects.toMatchObject({ statusCode: 400 })
    await bindBrainUpload({ ...f.identity, uploadId: f.prepared.uploadId, sha256: f.selection.sha256, ticketHash }, { store, env })
    expect(await read()).toMatchObject({ uploadId: f.prepared.uploadId, key: f.prepared.key, ...f.encrypted })
    // Another repository of the same account, bound and current, is still not this upload's repository.
    const other = await bound(f.identity.account)
    await expect(read({ repositoryId: other.repositoryId })).rejects.toMatchObject({ statusCode: 400 })
    await expect(read({ originalSource: "github-comment" as unknown as "desktop" })).rejects.toMatchObject({ statusCode: 400 })
    // A rebind moves the binding and the counter on together; the upload stays at the generation it was prepared for.
    await store(["HSET", `vector:cloud-agents:binding:${f.identity.repositoryId}`, "generation", "2"])
    await store(["SET", `vector:cloud-agents:gen:${f.identity.repositoryId}`, "2"])
    await expect(read({ generation: 2 })).rejects.toMatchObject({ statusCode: 400 })
  })
}
