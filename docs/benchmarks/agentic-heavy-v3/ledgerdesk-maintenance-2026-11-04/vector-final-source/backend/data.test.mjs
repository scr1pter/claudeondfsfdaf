import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import { join, dirname, resolve, relative, isAbsolute } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { openStore, canonicalJSON, checksum } from "./store.mjs"
import { amount, fail, isObject, monthBounds, periodValid, planValid, text, timestampValid, validatePayload } from "./validation.mjs"

const moduleURL = new URL("./store.mjs", import.meta.url).href
const sourceDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dataDirectory = resolve(process.env.DATA_DIR || join(tmpdir(), "ledgerdesk-synthetic-tests"))
const fromSource = relative(sourceDirectory, dataDirectory)
if (!fromSource || (!fromSource.startsWith("..") && !isAbsolute(fromSource))) throw new Error("Test DATA_DIR must be outside authored source")
fs.mkdirSync(dataDirectory, { recursive: true })

function temporary(t) {
  const directory = fs.mkdtempSync(join(dataDirectory, "backend-data-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

const account = (id = "account-a", workspaceId = "acme") => ({ id, workspaceId, name: "Synthetic Café 🧪", plan: { baseCents: 100, includedUnits: 2, unitCents: 10 } })
const usage = () => ({ id: "usage-a", workspaceId: "acme", accountId: "account-a", eventId: "event-a", units: 5, occurredAt: "2024-02-29T23:00:00-01:00" })
const legacy = () => ({ version: 1, accounts: [account()], usage: [usage()] })
const payload = () => ({ accounts: [account()], usage: [usage()], invoices: [], credits: [], keys: [], idempotency: [] })

function issued() {
  const data = payload()
  data.invoices.push({
    id: "invoice-a", workspaceId: "acme", accountId: "account-a", period: "2024-03", status: "issued",
    totalUnits: 5, baseCents: 100, includedUnits: 2, unitCents: 10, overageUnits: 3,
    totalCents: 130, creditedCents: 0, balanceCents: 130,
    lines: [
      { kind: "base", quantity: 1, unitCents: 100, amountCents: 100 },
      { kind: "overage", quantity: 3, unitCents: 10, amountCents: 30 },
    ],
  })
  data.idempotency.push({ actorId: "owner-acme", workspaceId: "acme", operation: "invoice", resourceId: "account-a", requestId: "request-invoice", input: { period: "2024-03" }, resultId: "invoice-a" })
  return data
}

function credited() {
  const data = issued()
  data.credits.push({ id: "credit-a", workspaceId: "acme", invoiceId: "invoice-a", amountCents: 30, reason: "Synthetic adjustment" })
  data.invoices[0].creditedCents = 30
  data.invoices[0].balanceCents = 100
  data.idempotency.push({ actorId: "billing-acme", workspaceId: "acme", operation: "credit", resourceId: "invoice-a", requestId: "request-credit", input: { amountCents: 30, reason: "Synthetic adjustment" }, resultId: "credit-a" })
  return data
}

function writeV2(directory, data) {
  fs.writeFileSync(join(directory, "ledger.json"), JSON.stringify({ version: 2, payload: data, checksum: checksum(data) }))
}

function startChild(directory, code = "") {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { openStore } from ${JSON.stringify(moduleURL)};
    const store = openStore({directory: ${JSON.stringify(directory)}});
    ${code}
    process.stdout.write('READY\\n');
    process.stdin.resume();
    process.stdin.on('data', () => {store.close(); process.exit(0)});
  `], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  let output = "", errors = ""
  child.stderr.on("data", chunk => { errors += chunk })
  const exited = new Promise((resolveExit, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolveExit({ code, signal }))
  })
  const ready = new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child did not become ready: ${errors}`)), 10_000)
    child.stdout.on("data", chunk => {
      output += chunk
      if (output.includes("READY\n")) { clearTimeout(timer); resolveReady() }
    })
    exited.then(({ code }) => { clearTimeout(timer); if (!output.includes("READY\n")) reject(new Error(`Child exited ${code}: ${errors}`)) }, reject)
  })
  return { child, exited, ready }
}

async function stopChild(childState, graceful = false) {
  if (childState.child.exitCode === null && childState.child.signalCode === null) {
    if (graceful) childState.child.stdin.write("close\n")
    else childState.child.kill("SIGKILL")
  }
  await childState.exited
}

test("shared validators reject impossible dates, unsafe amounts and invalid periods", () => {
  assert.equal(isObject({}), true)
  for (const value of [null, [], "x", 1]) assert.equal(isObject(value), false)
  for (const value of ["", "  ", "x".repeat(201), 1]) assert.equal(text(value), false)
  assert.equal(text(" valid "), true)
  assert.equal(text(" ".repeat(200) + "x"), false)
  assert.equal(amount(0), true)
  assert.equal(amount(0, true), false)
  for (const value of [-1, 1.1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "1"]) assert.equal(amount(value), false)
  assert.equal(planValid(account().plan), true)
  assert.equal(planValid({ baseCents: 0, includedUnits: 0, unitCents: -1 }), false)
  for (const value of ["2024-02-29T23:59:59.123456Z", "2000-02-29t00:00:00z", "2024-02-01T00:30:00+01:00", "0000-02-29T00:00:00Z"]) assert.equal(timestampValid(value), true, value)
  for (const value of ["2023-02-29T00:00:00Z", "1900-02-29T00:00:00Z", "2024-04-31T00:00:00Z", "2024-01-01", "2024-01-01T00:00:00", "2024-01-01T24:00:00Z", "2024-01-01T00:60:00Z", "2024-01-01T00:00:00+24:00", "2024-00-01T00:00:00Z"]) assert.equal(timestampValid(value), false, value)
  for (const value of ["2024-00", "2024-13", "2024-1", "24-01", 202401]) {
    assert.equal(periodValid(value), false)
    assert.throws(() => monthBounds(value), { status: 400, code: "invalid_period" })
  }
  assert.deepEqual(monthBounds("2024-02"), [Date.parse("2024-02-01T00:00:00Z"), Date.parse("2024-03-01T00:00:00Z")])
  assert.equal(new Date(monthBounds("0001-01")[0]).getUTCFullYear(), 1)
  assert.throws(() => fail(409, "business_conflict", "Synthetic conflict"), { status: 409, code: "business_conflict", message: "Synthetic conflict" })
})

test("canonical checksum recursively sorts keys, including numeric-looking keys, and retains Unicode/array order", () => {
  const value = { z: ["🧪", { é: "café", a: 1 }], "2": true, "10": false, a: { b: 2, a: null } }
  const expected = '{"10":false,"2":true,"a":{"a":null,"b":2},"z":["🧪",{"a":1,"é":"café"}]}'
  assert.equal(canonicalJSON(value), expected)
  assert.equal(checksum(value), createHash("sha256").update(expected, "utf8").digest("hex"))
})

test("fresh v2 persists correct checksum and snapshots are isolated", t => {
  const directory = temporary(t)
  const store = openStore({ directory })
  try {
    assert.deepEqual(store.snapshot(), { accounts: [], usage: [], invoices: [], credits: [], keys: [], idempotency: [] })
    const envelope = JSON.parse(fs.readFileSync(join(directory, "ledger.json")))
    assert.equal(envelope.version, 2)
    assert.equal(envelope.checksum, checksum(envelope.payload))
    store.snapshot().accounts.push(account())
    assert.equal(store.snapshot().accounts.length, 0)
    assert.equal(fs.existsSync(join(directory, "ledger.v1.backup.json")), false)
  } finally { store.close() }
  store.close()
  assert.throws(() => store.snapshot(), { code: "store_closed" })
})

test("migration retains every value and an exact immutable original-byte backup across restarts and commits", t => {
  const directory = temporary(t)
  const original = Buffer.from(" \r\n" + JSON.stringify(legacy(), null, 3) + "\r\n\t", "utf8")
  fs.writeFileSync(join(directory, "ledger.json"), original)
  let store = openStore({ directory })
  try {
    assert.deepEqual(store.snapshot(), payload())
    assert.deepEqual(fs.readFileSync(join(directory, "ledger.v1.backup.json")), original)
    store.transaction(draft => { draft.accounts.push(account("account-b")) })
  } finally { store.close() }
  const backup = join(directory, "ledger.v1.backup.json")
  const modified = fs.statSync(backup).mtimeMs
  store = openStore({ directory })
  try { assert.equal(store.snapshot().accounts.length, 2) } finally { store.close() }
  assert.deepEqual(fs.readFileSync(backup), original)
  assert.equal(fs.statSync(backup).mtimeMs, modified)
})

test("matching preexisting v1 backup is reused without rewriting; a conflicting backup rejects conservatively", t => {
  for (const matching of [true, false]) {
    const directory = temporary(t)
    const original = Buffer.from(JSON.stringify(legacy()))
    const backupBytes = matching ? original : Buffer.from("Unrelated synthetic evidence")
    fs.writeFileSync(join(directory, "ledger.json"), original)
    const backup = join(directory, "ledger.v1.backup.json")
    fs.writeFileSync(backup, backupBytes)
    const modified = fs.statSync(backup).mtimeMs
    if (matching) openStore({ directory }).close()
    else {
      assert.throws(() => openStore({ directory }), { code: "backup_conflict" })
      assert.deepEqual(fs.readFileSync(join(directory, "ledger.json")), original)
      assert.equal(fs.existsSync(join(directory, "ledger.lock")), false)
    }
    assert.deepEqual(fs.readFileSync(backup), backupBytes)
    assert.equal(fs.statSync(backup).mtimeMs, modified)
  }
})

const badLegacy = [
  ["account duplicate ID", value => value.accounts.push(structuredClone(value.accounts[0]))],
  ["usage duplicate ID", value => value.usage.push({ ...value.usage[0], eventId: "different" })],
  ["cross-collection duplicate ID", value => { value.usage[0].id = value.accounts[0].id }],
  ["duplicate business event", value => value.usage.push({ ...value.usage[0], id: "another-id" })],
  ["missing account", value => { value.usage[0].accountId = "missing" }],
  ["workspace mismatch", value => { value.usage[0].workspaceId = "beta" }],
  ["impossible date", value => { value.usage[0].occurredAt = "2023-02-29T00:00:00Z" }],
  ["missing timezone", value => { value.usage[0].occurredAt = "2024-02-01T00:00:00" }],
  ["unsafe plan", value => { value.accounts[0].plan.baseCents = Number.MAX_SAFE_INTEGER + 1 }],
  ["unsafe quotation", value => { value.accounts[0].plan.unitCents = Number.MAX_SAFE_INTEGER }],
  ["unsafe summed usage", value => { value.accounts[0].plan.unitCents = 0; value.usage[0].units = Number.MAX_SAFE_INTEGER; value.usage.push({ ...value.usage[0], id: "more", eventId: "more" }) }],
  ["unknown record field", value => { value.accounts[0].rawKey = "not-allowed" }],
  ["missing record field", value => { delete value.usage[0].eventId }],
  ["invalid body", value => { value.accounts = {} }],
  ["invalid units", value => { value.usage[0].units = 0 }],
  ["unknown version", value => { value.version = 3 }],
  ["unknown envelope field", value => { value.extra = [] }],
]

for (const [name, mutate] of badLegacy) test(`legacy rejection leaves original untouched and releases own lock: ${name}`, t => {
  const directory = temporary(t), value = legacy()
  mutate(value)
  const original = Buffer.from(JSON.stringify(value, null, 2))
  fs.writeFileSync(join(directory, "ledger.json"), original)
  assert.throws(() => openStore({ directory }))
  assert.deepEqual(fs.readFileSync(join(directory, "ledger.json")), original)
  assert.equal(fs.existsSync(join(directory, "ledger.v1.backup.json")), false)
  assert.equal(fs.existsSync(join(directory, "ledger.lock")), false)
  fs.writeFileSync(join(directory, "ledger.json"), JSON.stringify(legacy()))
  openStore({ directory }).close()
})

test("malformed JSON and invalid UTF8 preserve evidence and release lock", t => {
  for (const original of [Buffer.from('{"version":1,'), Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])]) {
    const directory = temporary(t)
    fs.writeFileSync(join(directory, "ledger.json"), original)
    assert.throws(() => openStore({ directory }), { code: "invalid_storage" })
    assert.deepEqual(fs.readFileSync(join(directory, "ledger.json")), original)
    assert.equal(fs.existsSync(join(directory, "ledger.lock")), false)
    assert.equal(fs.existsSync(join(directory, "ledger.v1.backup.json")), false)
  }
})

test("v2 verifies checksum before validating corrupt records, without repairing bytes", t => {
  const directory = temporary(t)
  const data = payload()
  const envelope = { version: 2, payload: data, checksum: checksum(data) }
  envelope.payload.accounts[0].plan.baseCents = -1
  const original = Buffer.from(JSON.stringify(envelope))
  fs.writeFileSync(join(directory, "ledger.json"), original)
  assert.throws(() => openStore({ directory }), { code: "checksum_mismatch" })
  assert.deepEqual(fs.readFileSync(join(directory, "ledger.json")), original)
  envelope.checksum = checksum(envelope.payload)
  fs.writeFileSync(join(directory, "ledger.json"), JSON.stringify(envelope))
  assert.throws(() => openStore({ directory }), { code: "invalid_data" })
  assert.equal(fs.existsSync(join(directory, "ledger.lock")), false)
})

const badV2 = [
  ["payload collection missing", data => { delete data.keys }],
  ["payload collection extra", data => { data.extra = [] }],
  ["invoice missing account", data => { data.invoices[0].accountId = "missing" }],
  ["invoice wrong workspace", data => { data.invoices[0].workspaceId = "beta" }],
  ["invoice wrong status", data => { data.invoices[0].status = "draft" }],
  ["invoice invalid period", data => { data.invoices[0].period = "2024-13" }],
  ["invoice unsafe total", data => { data.invoices[0].totalCents = Number.MAX_SAFE_INTEGER + 1 }],
  ["invoice invalid overage", data => { data.invoices[0].overageUnits = 4 }],
  ["invoice inconsistent total", data => { data.invoices[0].totalCents++ }],
  ["invoice line unsafe product", data => { data.invoices[0].unitCents = Number.MAX_SAFE_INTEGER }],
  ["invoice line missing", data => { data.invoices[0].lines.pop() }],
  ["invoice duplicate base line", data => { data.invoices[0].lines[1] = structuredClone(data.invoices[0].lines[0]) }],
  ["invoice incorrect line", data => { data.invoices[0].lines[1].amountCents++ }],
  ["invoice incorrect balance", data => { data.invoices[0].balanceCents++ }],
  ["invoice repeated period", data => { data.invoices.push({ ...structuredClone(data.invoices[0]), id: "invoice-b" }) }],
  ["credit missing invoice", data => { data.credits[0].invoiceId = "missing" }],
  ["credit workspace mismatch", data => { data.credits[0].workspaceId = "beta" }],
  ["credit zero", data => { data.credits[0].amountCents = 0 }],
  ["credit untrimmed reason", data => { data.credits[0].reason = " spaced " }],
  ["credit sum mismatch", data => { data.credits[0].amountCents++ }],
  ["credit over total", data => { data.credits[0].amountCents = 131; data.invoices[0].creditedCents = 131; data.invoices[0].balanceCents = -1 }],
  ["key raw material field", data => { data.keys[0].apiKey = "not-allowed" }],
  ["key invalid role", data => { data.keys[0].role = "owner" }],
  ["key invalid hash", data => { data.keys[0].hash = "A".repeat(64) }],
  ["key revocation not boolean", data => { data.keys[0].revoked = 1 }],
  ["key missing account", data => { data.keys[0].accountIds = ["missing"] }],
  ["key empty scope", data => { data.keys[0].accountIds = [] }],
  ["key duplicate scope", data => { data.keys[0].accountIds = ["account-a", "account-a"] }],
  ["key scope other workspace", data => { data.keys[0].workspaceId = "beta" }],
  ["key duplicate hash", data => { data.keys.push({ ...data.keys[0], id: "key-b" }) }],
  ["key bootstrap impersonation", data => { data.keys[0].id = "owner-acme" }],
  ["idempotency missing", data => { data.idempotency.pop() }],
  ["idempotency unknown actor", data => { data.idempotency[0].actorId = "unknown" }],
  ["idempotency wrong workspace actor", data => { data.idempotency[0].actorId = "owner-beta" }],
  ["idempotency read actor", data => { data.idempotency[0].actorId = "reader-acme" }],
  ["idempotency wrong operation", data => { data.idempotency[0].operation = "other" }],
  ["idempotency wrong resource", data => { data.idempotency[0].resourceId = "missing" }],
  ["idempotency changed invoice input", data => { data.idempotency[0].input.period = "2024-02" }],
  ["idempotency changed credit input", data => { data.idempotency[1].input.amountCents++ }],
  ["idempotency result missing", data => { data.idempotency[0].resultId = "missing" }],
  ["idempotency duplicate", data => { data.idempotency.push(structuredClone(data.idempotency[0])) }],
  ["idempotency second request same result", data => { data.idempotency.push({ ...structuredClone(data.idempotency[0]), requestId: "different" }) }],
  ["idempotency not normalized", data => { data.idempotency[0].input.requestId = "extra" }],
]

function keyed() {
  const data = credited()
  data.keys.push({ id: "key-a", workspaceId: "acme", role: "billing", hash: createHash("sha256").update("synthetic-raw-key").digest("hex"), revoked: false, accountIds: ["account-a"] })
  return data
}

for (const [name, mutate] of badV2) test(`startup and precommit validation: ${name}`, t => {
  const directory = temporary(t)
  const baseline = keyed(), invalid = structuredClone(baseline)
  mutate(invalid)
  writeV2(directory, invalid)
  const original = fs.readFileSync(join(directory, "ledger.json"))
  assert.throws(() => openStore({ directory }), { code: "invalid_data" })
  assert.deepEqual(fs.readFileSync(join(directory, "ledger.json")), original)
  writeV2(directory, baseline)
  const store = openStore({ directory })
  try {
    const before = fs.readFileSync(join(directory, "ledger.json"))
    assert.throws(() => store.transaction(mutate), { code: "invalid_data" })
    assert.deepEqual(store.snapshot(), baseline)
    assert.deepEqual(fs.readFileSync(join(directory, "ledger.json")), before)
  } finally { store.close() }
})

test("transaction clones callback/result references, returns values and publishes only successful synchronous operations", t => {
  const directory = temporary(t), store = openStore({ directory })
  let retained
  try {
    const returned = store.transaction(draft => {
      retained = draft
      draft.accounts.push(account())
      return draft.accounts[0]
    })
    assert.equal(returned, retained.accounts[0])
    retained.accounts.length = 0
    returned.plan.baseCents = 0
    assert.deepEqual(store.snapshot().accounts, [account()])
    const original = fs.readFileSync(join(directory, "ledger.json"))
    const businessError = Object.assign(new Error("Synthetic rejection"), { status: 409, code: "synthetic_conflict" })
    assert.throws(() => store.transaction(draft => { draft.accounts.push(account("discarded")); throw businessError }), error => error === businessError)
    for (const fn of [async draft => { draft.accounts.push(account("async")) }, draft => { draft.accounts.push(account("thenable")); return { then() {} } }]) assert.throws(() => store.transaction(fn), { code: "async_transaction" })
    assert.throws(() => store.transaction(() => store.transaction(() => {})), { code: "nested_transaction" })
    assert.throws(() => store.transaction(() => store.close()), { code: "active_transaction" })
    assert.deepEqual(fs.readFileSync(join(directory, "ledger.json")), original)
    assert.equal(store.transaction(() => 42), 42)
  } finally { store.close() }
  const restarted = openStore({ directory })
  try { assert.deepEqual(restarted.snapshot().accounts, [account()]) } finally { restarted.close() }
})

test("transaction rejects getters, holes, undefined, cycles, symbols and exotic records without writing", t => {
  const directory = temporary(t), store = openStore({ directory })
  const before = fs.readFileSync(join(directory, "ledger.json"))
  const changes = [
    draft => { draft.accounts.push(undefined) },
    draft => { draft.accounts.length = 1 },
    draft => { draft.accounts.push(new Date()) },
    draft => { draft.accounts.push(draft) },
    draft => { draft.accounts[Symbol("hidden")] = 1 },
    draft => { Object.defineProperty(draft.accounts, "0", { enumerable: true, get() { throw new Error("Getter executed") } }) },
  ]
  try {
    for (const mutate of changes) assert.throws(() => store.transaction(mutate), { code: "invalid_data" })
    assert.deepEqual(fs.readFileSync(join(directory, "ledger.json")), before)
  } finally { store.close() }
})

test("historical records and revoked keys are immutable, but credit balances and later usage can change", t => {
  const directory = temporary(t), baseline = keyed()
  baseline.keys[0].revoked = true
  writeV2(directory, baseline)
  const store = openStore({ directory })
  try {
    for (const mutate of [
      draft => { draft.accounts[0].name = "Changed" },
      draft => { draft.usage[0].units = 6 },
      draft => { draft.credits[0].reason = "Changed"; draft.idempotency[1].input.reason = "Changed" },
      draft => { draft.invoices[0].totalUnits = 4; draft.invoices[0].overageUnits = 2; draft.invoices[0].totalCents = 120; draft.invoices[0].balanceCents = 90; draft.invoices[0].lines[1].quantity = 2; draft.invoices[0].lines[1].amountCents = 20 },
      draft => { draft.keys[0].accountIds = undefined },
      draft => { delete draft.keys[0].accountIds },
      draft => { draft.keys[0].revoked = false },
      draft => { draft.idempotency[0].requestId = "replacement" },
      draft => { Object.assign(draft, { accounts: [], usage: [], invoices: [], credits: [], keys: [], idempotency: [] }) },
    ]) assert.throws(() => store.transaction(mutate), { code: "invalid_data" })
    store.transaction(draft => {
      draft.usage.push({ ...usage(), id: "late-usage", eventId: "late-event", units: 100 })
      draft.credits.push({ id: "credit-b", workspaceId: "acme", invoiceId: "invoice-a", amountCents: 100, reason: "Remaining adjustment" })
      draft.invoices[0].creditedCents = 130
      draft.invoices[0].balanceCents = 0
      draft.idempotency.push({ actorId: "owner-acme", workspaceId: "acme", operation: "credit", resourceId: "invoice-a", requestId: "second-credit", input: { amountCents: 100, reason: "Remaining adjustment" }, resultId: "credit-b" })
    })
    assert.equal(store.snapshot().invoices[0].totalUnits, 5)
    assert.equal(store.snapshot().invoices[0].balanceCents, 0)
  } finally { store.close() }
  const restarted = openStore({ directory })
  try { assert.equal(restarted.snapshot().credits.length, 2) } finally { restarted.close() }
})

test("dynamic billing actors validate scopes, and retained historical entries survive revocation", () => {
  const data = keyed()
  data.idempotency[0].actorId = "key-a"
  assert.equal(validatePayload(data), data)
  data.keys[0].revoked = true
  validatePayload(data)
  data.keys[0].role = "reader"
  assert.throws(() => validatePayload(data), { code: "invalid_data" })
  data.keys[0].role = "billing"
  data.accounts.push(account("account-b"))
  data.keys[0].accountIds = ["account-b"]
  assert.throws(() => validatePayload(data), { code: "invalid_data" })
})

test("atomic persistence fsyncs same-directory temporary bytes before replacement and cleans up", t => {
  const directory = temporary(t), store = openStore({ directory })
  const originalSync = fs.fsyncSync, originalRename = fs.renameSync
  const events = []
  fs.fsyncSync = fd => { events.push(fs.fstatSync(fd).isFile() ? "file-sync" : "directory-sync"); return originalSync(fd) }
  fs.renameSync = (source, target) => {
    assert.equal(dirname(source), directory)
    assert.equal(target, join(directory, "ledger.json"))
    assert.equal(events.includes("file-sync"), true)
    events.push("rename")
    return originalRename(source, target)
  }
  try { store.transaction(draft => draft.accounts.push(account())) } finally {
    fs.fsyncSync = originalSync
    fs.renameSync = originalRename
    store.close()
  }
  assert.deepEqual(events.slice(0, 2), ["file-sync", "rename"])
  if (process.platform !== "win32") assert.equal(events[2], "directory-sync")
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith(".tmp")), false)
})

test("failed replacement preserves authoritative bytes, cleans temp, and fails closed until restart", t => {
  const directory = temporary(t), store = openStore({ directory })
  const original = fs.readFileSync(join(directory, "ledger.json"))
  const rename = fs.renameSync
  fs.renameSync = () => { throw Object.assign(new Error("Synthetic disk failure"), { code: "EIO" }) }
  try {
    assert.throws(() => store.transaction(draft => draft.accounts.push(account())), { code: "EIO" })
    assert.throws(() => store.snapshot(), { code: "store_closed" })
  } finally { fs.renameSync = rename; store.close() }
  assert.deepEqual(fs.readFileSync(join(directory, "ledger.json")), original)
  assert.equal(fs.readdirSync(directory).some(name => name.endsWith(".tmp")), false)
  const restarted = openStore({ directory })
  try { assert.equal(restarted.snapshot().accounts.length, 0) } finally { restarted.close() }
})

test("failed backup fsync never replaces v1 and releases its acquired lock", t => {
  const directory = temporary(t), original = Buffer.from(JSON.stringify(legacy()))
  fs.writeFileSync(join(directory, "ledger.json"), original)
  const originalSync = fs.fsyncSync
  fs.fsyncSync = fd => {
    if (fs.fstatSync(fd).isFile() && fs.fstatSync(fd).size === original.length) throw Object.assign(new Error("Synthetic backup fsync failure"), { code: "EIO" })
    return originalSync(fd)
  }
  try { assert.throws(() => openStore({ directory }), { code: "EIO" }) } finally { fs.fsyncSync = originalSync }
  assert.deepEqual(fs.readFileSync(join(directory, "ledger.json")), original)
  assert.equal(fs.existsSync(join(directory, "ledger.lock")), false)
  openStore({ directory }).close()
})

test("same-process and live-process owners exclude contenders without altering ownership", async t => {
  const directory = temporary(t)
  const state = startChild(directory)
  t.after(() => stopChild(state))
  await state.ready
  const lock = fs.readFileSync(join(directory, "ledger.lock"))
  assert.throws(() => openStore({ directory }), { code: "store_locked" })
  assert.deepEqual(fs.readFileSync(join(directory, "ledger.lock")), lock)
  await stopChild(state, true)
  assert.equal(fs.existsSync(join(directory, "ledger.lock")), false)
  const store = openStore({ directory })
  try { assert.throws(() => openStore({ directory }), { code: "store_locked" }) } finally { store.close() }
})

test("forced subprocess exit leaves committed operations/idempotency durable and its PID lock recoverable", async t => {
  const directory = temporary(t)
  const data = keyed()
  const state = startChild(directory, `store.transaction(draft => Object.assign(draft, ${JSON.stringify(data)}));`)
  t.after(() => stopChild(state))
  await state.ready
  await stopChild(state)
  assert.equal(fs.existsSync(join(directory, "ledger.lock")), true)
  const recovered = openStore({ directory })
  try {
    assert.deepEqual(recovered.snapshot(), data)
    assert.throws(() => openStore({ directory }), { code: "store_locked" })
  } finally { recovered.close() }
  assert.equal(fs.existsSync(join(directory, "ledger.lock")), false)
})

test("a malformed lock is retained conservatively, and close never deletes a replaced live lock", t => {
  const directory = temporary(t), path = join(directory, "ledger.lock")
  fs.writeFileSync(path, "unparseable synthetic ownership evidence")
  assert.throws(() => openStore({ directory }), { code: "store_locked" })
  assert.equal(fs.readFileSync(path, "utf8"), "unparseable synthetic ownership evidence")
  fs.unlinkSync(path)
  const store = openStore({ directory })
  const replacement = JSON.stringify({ pid: process.pid, token: randomUUID() })
  fs.writeFileSync(path, replacement)
  store.close()
  assert.equal(fs.readFileSync(path, "utf8"), replacement)
})
