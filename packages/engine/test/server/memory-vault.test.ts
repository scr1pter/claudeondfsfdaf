import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Flag } from "@vectordevai/core/flag/flag"
import { ServerAuth } from "../../src/server/auth"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// Brain Vault's memory over HTTP (WP A45): what the desktop app encrypts for a backup (GET /memory/backup) and how
// it restores a file it opened with the vault's key (POST /memory/restore). Both are the owner's own: an invited
// guest gets 403. A restore brings back as in use and pinned what the backup had in use and pinned.

const keys = [
  "VECTOR_SERVER_USERNAME",
  "VECTOR_SERVER_PASSWORD",
  "VECTOR_SERVER_GUEST_USERNAME",
  "VECTOR_SERVER_GUEST_PASSWORD",
  "VECTOR_SERVER_GUEST_WORKSPACES",
  "VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES",
  "VECTOR_DISABLE_DEFAULT_PLUGINS",
] as const
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
const previousWorkspaceID = Flag.VECTOR_WORKSPACE_ID
const basic = (username: string, password: string) => ServerAuth.header({ username, password }) ?? ""
const owner = { authorization: basic("vector", "owner-secret") }
const guest = { authorization: basic("guest", "guest-secret") }

let listener: Awaited<ReturnType<typeof Server.listen>>
let shared: Awaited<ReturnType<typeof tmpdir>>

beforeAll(async () => {
  shared = await tmpdir({ git: true, trusted: true, config: { formatter: false, lsp: false } })
  Object.assign(process.env, {
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_WORKSPACES: "wrk_allowed",
    VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES: JSON.stringify({ wrk_allowed: shared.path }),
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
  })
  Flag.VECTOR_WORKSPACE_ID = "wrk_allowed"
  listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
})

afterAll(async () => {
  await listener.stop(true)
  Flag.VECTOR_WORKSPACE_ID = previousWorkspaceID
  for (const key of keys) {
    const value = previous[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await shared[Symbol.asyncDispose]()
})

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const call = (method: string, route: string, body?: unknown, headers: Record<string, string> = owner) => {
  const url = new URL(route, listener.url)
  url.searchParams.set("directory", shared.path)
  return fetch(url, {
    method,
    keepalive: false,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const entry = (input: { id: string; text: string; status: string; pinned: boolean; kind?: string }) => ({
  id: input.id,
  scope: "personal",
  kind: input.kind ?? "preference",
  status: input.status,
  text: input.text,
  paths: [],
  pinned: input.pinned,
  evidence: [],
  createdAt: 1_700_000_000_000,
})

describe("Brain Vault memory routes", () => {
  test("an invited guest gets 403 from the backup and the restore", async () => {
    expect((await call("GET", "/memory/backup", undefined, guest)).status).toBe(403)
    expect((await call("POST", "/memory/restore", { text: "{}", repository: "" }, guest)).status).toBe(403)
  }, 30_000)

  test("the backup carries the owner's memory as export JSON, one file per place", async () => {
    const created = await call("POST", "/memory", {
      kind: "preference",
      text: "I prefer tables for comparisons",
      scope: "personal",
    })
    expect(created.status).toBe(200)
    const answer = await call("GET", "/memory/backup")
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as {
      files: { path: string; section: string; text: string; repository: string }[]
    }
    const personal = body.files.find((file) => file.path === "memory/personal.json")
    expect(personal?.section).toBe("memory")
    expect(personal?.repository).toBe("")
    const file = JSON.parse(personal!.text) as { format: string; version: number; entries: { text: string }[] }
    expect(file.format).toBe("vector-memory")
    expect(file.version).toBe(1)
    expect(file.entries.map((item) => item.text)).toContain("I prefer tables for comparisons")
  }, 30_000)

  test("a restore keeps what was in use and pinned, and what waited waits again", async () => {
    const text = JSON.stringify({
      format: "vector-memory",
      version: 1,
      scope: "personal",
      exportedAt: 1_700_000_000_000,
      entries: [
        entry({ id: "m1", text: "I prefer short commit messages", status: "active", pinned: true }),
        entry({
          id: "m2",
          text: "When I say ship it, I mean open a PR",
          status: "proposed",
          pinned: false,
          kind: "term",
        }),
      ],
      documents: [],
    })
    const restored = await call("POST", "/memory/restore", { text, repository: "" })
    expect(restored.status).toBe(200)
    expect(await restored.json()).toEqual({
      restored: 2,
      active: 1,
      pinned: 1,
      waiting: 1,
      known: 0,
      refused: 0,
      documents: 0,
    })
    const listed = (await (await call("GET", "/memory?scope=personal&filter=active")).json()) as {
      entries: { text: string; pinned: boolean }[]
    }
    expect(listed.entries.find((item) => item.text === "I prefer short commit messages")?.pinned).toBe(true)
    const again = await call("POST", "/memory/restore", { text, repository: "" })
    expect(((await again.json()) as { known: number }).known).toBe(2)
  }, 30_000)

  test("a file this version cannot read, and one past 2 MB, are refused", async () => {
    const unreadable = await call("POST", "/memory/restore", {
      text: JSON.stringify({ format: "vector-memory", version: 9 }),
      repository: "",
    })
    expect(unreadable.status).toBe(400)
    const big = await call("POST", "/memory/restore", { text: "x".repeat(2 * 1024 * 1024 + 1), repository: "" })
    expect(big.status).toBe(400)
  }, 30_000)
})
