import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ascending } from "@vectordevai/schema/identifier"
import { MessageIdentities } from "../src/message-identities.js"

const WORKSPACE = "79b8ab70-d17d-449c-8d73-67ff7d00b362"
const OTHER = "cb95d173-b802-4510-8a82-819b5920ffcc"
const REQUEST = "d2ed95ab-109b-47b9-bcc5-bc14b9d4d098"
const SESSION = "ses_fixture1234567890"

test("host allocations use the engine's canonical ascending IDs and replay one client request idempotently", () => {
  const identities = new MessageIdentities({ path: ":memory:" })
  try {
    const before = `msg_${ascending()}`
    const messageID = identities.allocate(WORKSPACE, SESSION, REQUEST)
    const after = `msg_${ascending()}`
    expect(messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(messageID > before).toBe(true)
    expect(messageID < after).toBe(true)
    expect(identities.allocate(WORKSPACE, SESSION, REQUEST)).toBe(messageID)
    expect(identities.lookup(WORKSPACE, SESSION, messageID)).toBe(true)
  } finally {
    identities.close()
  }
})

test("allocations and lookups bind workspace, session and request instead of trusting a client-generated message", () => {
  const identities = new MessageIdentities({ path: ":memory:" })
  try {
    const messageID = identities.allocate(WORKSPACE, SESSION, REQUEST)
    expect(identities.lookup(OTHER, SESSION, messageID)).toBe(false)
    expect(identities.lookup(WORKSPACE, "ses_other", messageID)).toBe(false)
    expect(identities.lookup(WORKSPACE, SESSION, `msg_${ascending()}`)).toBe(false)
    expect(identities.lookup(WORKSPACE, SESSION, `msg_${randomUUID()}`)).toBe(false)
    expect(identities.allocate(OTHER, SESSION, REQUEST)).not.toBe(messageID)
    expect(identities.allocate(WORKSPACE, "ses_other", REQUEST)).not.toBe(messageID)
    expect(identities.allocate(WORKSPACE, SESSION, randomUUID())).not.toBe(messageID)
  } finally {
    identities.close()
  }
})

test("the 500 allocation limit covers every session but preserves retries and leaves other workspaces independent", () => {
  const identities = new MessageIdentities({ path: ":memory:" })
  try {
    const first = identities.allocate(WORKSPACE, SESSION, REQUEST)
    for (let index = 1; index < 500; index++)
      identities.allocate(WORKSPACE, index % 2 ? SESSION : "ses_other", randomUUID())
    expect(() => identities.allocate(WORKSPACE, "ses_another", randomUUID())).toThrow(
      expect.objectContaining({ code: "WORKSPACE_MESSAGE_LIMIT", status: 429 }),
    )
    expect(identities.allocate(WORKSPACE, SESSION, REQUEST)).toBe(first)
    expect(identities.lookup(WORKSPACE, SESSION, first)).toBe(true)
    expect(identities.allocate(OTHER, SESSION, randomUUID())).toMatch(/^msg_/)
  } finally {
    identities.close()
  }
})

test("a response lost before delivery can be recovered after restarting the allocator", () => {
  const directory = mkdtempSync(join(tmpdir(), "vector-message-identities-"))
  const path = join(directory, "messages.sqlite")
  let identities = new MessageIdentities({ path })
  try {
    const messageID = identities.allocate(WORKSPACE, SESSION, REQUEST)
    identities.close()
    identities = new MessageIdentities({ path })
    expect(identities.allocate(WORKSPACE, SESSION, REQUEST)).toBe(messageID)
    expect(identities.lookup(WORKSPACE, SESSION, messageID)).toBe(true)
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600)
  } finally {
    identities.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("two database handles agree on the persistent idempotency mapping", () => {
  const directory = mkdtempSync(join(tmpdir(), "vector-message-identities-handles-"))
  const path = join(directory, "messages.sqlite")
  const first = new MessageIdentities({ path })
  const second = new MessageIdentities({ path })
  try {
    const messageID = first.allocate(WORKSPACE, SESSION, REQUEST)
    expect(second.allocate(WORKSPACE, SESSION, REQUEST)).toBe(messageID)
    expect(second.lookup(WORKSPACE, SESSION, messageID)).toBe(true)
  } finally {
    first.close()
    second.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("workspace removal erases only its mappings and makes old IDs inadmissible", () => {
  const identities = new MessageIdentities({ path: ":memory:" })
  try {
    const removed = identities.allocate(WORKSPACE, SESSION, REQUEST)
    const retained = identities.allocate(OTHER, SESSION, REQUEST)
    identities.removeWorkspace(WORKSPACE)
    identities.removeWorkspace(WORKSPACE)
    expect(identities.lookup(WORKSPACE, SESSION, removed)).toBe(false)
    expect(identities.lookup(OTHER, SESSION, retained)).toBe(true)
    expect(identities.allocate(WORKSPACE, SESSION, REQUEST)).not.toBe(removed)
  } finally {
    identities.close()
  }
})

test("malformed allocation selectors and client timestamps cannot select a message ID", () => {
  const identities = new MessageIdentities({ path: ":memory:" })
  try {
    for (const [workspace, session, request] of [
      ["not-a-workspace", SESSION, REQUEST],
      [WORKSPACE, "ses_../other", REQUEST],
      [WORKSPACE, SESSION, String(Date.now() + 86_400_000)],
      [WORKSPACE, SESSION, `msg_${ascending()}`],
      [WORKSPACE, SESSION, "invalid-request"],
    ])
      expect(() => identities.allocate(workspace!, session!, request!)).toThrow(
        expect.objectContaining({ code: "INVALID_MESSAGE_REQUEST" }),
      )
    expect(identities.lookup("invalid", SESSION, `msg_${ascending()}`)).toBe(false)
    expect(identities.lookup(WORKSPACE, "ses_../other", `msg_${ascending()}`)).toBe(false)
  } finally {
    identities.close()
  }
})

test("an unsupported database version is refused without changing its data", () => {
  const directory = mkdtempSync(join(tmpdir(), "vector-message-identities-schema-"))
  const path = join(directory, "messages.sqlite")
  const original = new Database(path)
  original.exec(
    "CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('preserved'); PRAGMA user_version = 99",
  )
  original.close()
  try {
    expect(() => new MessageIdentities({ path })).toThrow(
      expect.objectContaining({ code: "WORKSPACE_MESSAGE_STORAGE_UNSUPPORTED", status: 503 }),
    )
    const retained = new Database(path)
    try {
      expect(retained.query<{ value: string }, []>("SELECT value FROM sentinel").get()?.value).toBe("preserved")
      expect(retained.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(99)
    } finally {
      retained.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
