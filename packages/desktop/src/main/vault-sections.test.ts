import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { VaultCrypto } from "@vectordevai/core/vault/crypto"
import { VaultBackup } from "@vectordevai/core/vault/vault"
import { Vault } from "@vectordevai/schema/vault"

// Track B B10 acceptance, native: Brain Vault's learned sections as the running app makes and restores them. Two
// computers, each the desktop's real Brain Vault (vault-runtime.ts startVault, its sealed key, its settings store and
// its engine adapters) beside a real engine server in a process of its own with its own HOME and XDG folders
// (packages/engine/test/fixture/vault-profile.ts). The GitHub backend is the desktop's own (vault-github.ts, its git),
// pointed at a bare repository on this computer, with GitHub's privacy check answered here; nothing reaches GitHub,
// and the engines get a proxy that answers nothing. What computer B gets back is read from its engine's own routes.
// e2e/fixtures/vault-sections.jsx answers the Backup page with the totals asserted here.

const root = mkdtempSync(join(tmpdir(), "vector-vault-sections-"))
const remote = join(root, "remote.git")
const repo = join(root, "repo")
const FIXTURE = resolve(import.meta.dir, "../../../engine/test/fixture/vault-profile.ts")
const MODELS = resolve(import.meta.dir, "../../../engine/test/tool/fixtures/models-api.json")
// As vault-github.test.ts isolates git; Git for Windows reads /dev/null as an empty file too.
const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
// The engines' environment, from this process's: the search path, Windows' system folders and the temp folders.
const INHERITED = new Set([
  "PATH",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
])
const previous = Object.fromEntries(Object.keys(ISOLATED).map((key) => [key, process.env[key]]))
const privacy: string[] = []
const computer = { userData: join(root, "computer-a") }

const electronMock = {
  app: { getPath: () => computer.userData, isPackaged: false },
  shell: { openExternal: async () => {} },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}
mock.module("electron", () => ({ default: electronMock, ...electronMock }))
// The billing window pulls in logging and Chromium sessions; Brain Vault never reaches it.
mock.module("./billing-window", () => ({
  focusBillingWindow: () => {},
  isBillingWindow: () => false,
  openBillingWindow: async () => ({ outcome: "closed" }),
}))
// The app's GitHub backend, with the remote, GitHub's API and the privacy check its options keep for tests.
const github = { ...(await import("./vault-github")) }
const testStore = (options: { readonly repo: string; readonly cache: string }) =>
  github.githubVaultStore({
    ...options,
    remote,
    api: "https://api.github.test",
    send: async (url) => {
      privacy.push(url)
      return new Response(null, { status: 404 })
    },
  })
mock.module("./vault-github", () => ({ ...github, githubVaultStore: testStore }))

const { startVault, stopVault, vaultKeys } = await import("./vault-runtime")
const { vaultSecrets } = await import("./vault-secrets")
const { removeStoreFile } = await import("./store")

type Engine = Awaited<ReturnType<typeof engine>>
const engines: { a?: Engine; b?: Engine } = {}

beforeAll(async () => {
  Object.assign(process.env, ISOLATED)
  git(root, "init", "--bare", "-q", "-b", "main", remote)
  git(root, "init", "-q", "-b", "main", repo)
  git(repo, "-c", "user.email=test@vector.test", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "root")
  // Each engine is kept as it starts, so afterAll stops one that started even when the other did not.
  const started = await Promise.allSettled([
    engine("a").then((ready) => (engines.a = ready)),
    engine("b").then((ready) => (engines.b = ready)),
  ])
  const failed = started.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failed) throw failed.reason
}, 120_000)

afterAll(async () => {
  stopVault()
  await Promise.all([engines.a?.stop(), engines.b?.stop()])
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

test("a memory-only backup asks for reader one and a learned one for reader two; another computer gets the learned skills and workflow insights back as proposals to review, private where they were, with no learner stats", async () => {
  const a = engines.a!
  const b = engines.b!

  // Computer A: one preference, backed up to the person's repository. The first backup makes the vault and its code.
  vaultSecrets.setKey(randomBytes(32))
  expect(
    (
      await a.call("POST", "/memory", {
        kind: "preference",
        text: "I prefer tables for comparisons",
        scope: "personal",
      })
    ).status,
  ).toBe(200)
  const first = startVault({ engine: { url: a.url, password: a.password }, log: () => {} })
  expect(first.configure({ backend: "github", githubRepo: "octo/brain-vault" }).ok).toBe(true)
  const memoryOnly = await first.backup()
  // Read before any matcher: Bun's toMatchObject puts an asymmetric matcher in place of the property it matched.
  const code = memoryOnly.code!
  expect(memoryOnly.ok).toBe(true)
  expect(typeof code).toBe("string")
  const record = await vaultKeys.read()
  expect(record).toBeDefined()
  const opened = { vault: record!.vault, vaultKey: VaultCrypto.fromBase64Url(record!.key) }
  const v1 = await reader("reader-1", opened, memoryOnly.status.last!.version)
  expect(v1.manifest.minReader).toBe(Vault.MIN_READER)
  expect(v1.files.map(({ file }) => file.section)).toEqual(["memory"])

  // Then it learns: two skills the person approved, one of them private, and eight checked runs of thorough work.
  expect(await a.seed(repo)).toBe("recorded")
  const imported = await a.call("POST", "/memory/import", { text: skillsFile() })
  expect(((await imported.json()) as { entries: unknown[] }).entries).toHaveLength(2)
  const drafts = (await json(await a.call("GET", "/memory/skills?filter=review"))).skills as { id: string }[]
  for (const draft of drafts)
    expect((await a.call("PATCH", `/memory/skills/${draft.id}`, { action: "approve" })).status).toBe(200)
  const live = (await json(await a.call("GET", "/memory/skills"))).skills as { status: string; private?: boolean }[]
  expect(live.map((item) => [item.status, item.private === true]).toSorted()).toEqual([
    ["active", false],
    ["active", true],
  ])
  const insightsA = (await json(await a.call("GET", "/memory/workflow"))) as {
    tiers: { tier: string; arms: unknown[] }[]
  }
  expect(insightsA.tiers.find((tier) => tier.tier === "thorough")?.arms.length).toBeGreaterThan(0)

  const learned = await first.backup()
  expect(learned).toMatchObject({ ok: true })
  expect(learned.code).toBeUndefined()
  const v2 = learned.status.last!.version
  const read2 = await reader("reader-2", opened, v2)
  expect(read2.manifest.minReader).toBe(Vault.LEARNED_READER)
  expect(read2.files.map(({ file }) => file.section).toSorted()).toEqual(["insights", "memory", "skills"])
  const skillsText = read2.files.find(({ file }) => file.section === "skills")!.bytes.toString("utf8")
  const backedUp = (JSON.parse(skillsText) as { skills: { private?: boolean; skill: { name: string } }[] }).skills
  expect(backedUp.map((item) => [item.skill.name, item.private === true]).toSorted()).toEqual([
    ["learned-bun-test-src", false],
    ["learned-bun-typecheck-src", true],
  ])
  stopVault()

  // Computer B: a fresh profile and a fresh desktop, with no key, so the recovery code opens the vault.
  computer.userData = join(root, "computer-b")
  removeStoreFile("vector-vault")
  vaultSecrets.setKey(randomBytes(32))
  expect(await vaultKeys.read()).toBeUndefined()
  const second = startVault({ engine: { url: b.url, password: b.password }, log: () => {} })
  expect(second.configure({ backend: "github", githubRepo: "octo/brain-vault" }).ok).toBe(true)
  const versions = await second.versions()
  expect(versions).toMatchObject({ ok: true, mine: false })
  expect(await second.restore({ version: v2 })).toMatchObject({ ok: false, needsCode: true })
  const restored = await second.restore({ version: v2, code })
  expect(restored).toMatchObject({ ok: true })
  // The Backup page's fixture (e2e/fixtures/vault-sections.jsx) answers with these totals.
  expect(restored.totals).toEqual({
    restored: 4,
    active: 1,
    pinned: 0,
    waiting: 0,
    skills: 2,
    insights: 1,
    known: 0,
    refused: 0,
    documents: 0,
    unreadable: 0,
    version: v2,
    newer: false,
  })

  // What B's engine holds: the same repository, its skills waiting for review and none in use, the private one still
  // private, no credit, uses or approval, no workflow statistics, the history as a lesson to review, and the memory.
  const [projectA, projectB] = [
    await json(await a.call("GET", "/project/current")),
    await json(await b.call("GET", "/project/current")),
  ]
  expect(projectB.id).toBe(projectA.id)
  expect((await json(await b.call("GET", "/memory/skills"))).skills).toEqual([])
  const waiting = (await json(await b.call("GET", "/memory/skills?filter=review"))).skills as {
    id: string
    status: string
    private?: boolean
    skill: { name: string }
  }[]
  expect(waiting.map((item) => [item.skill.name, item.status, item.private === true]).toSorted()).toEqual([
    ["learned-bun-test-src", "proposed", false],
    ["learned-bun-typecheck-src", "proposed", true],
  ])
  for (const item of waiting) {
    const detail = (await json(await b.call("GET", `/memory/skills/${item.id}`))) as {
      uses: unknown
      entry: { skill: { approvedBy?: string } }
    }
    expect(detail.uses).toEqual({ loads: 0, passes: 0, fails: 0, ignored: 0, reverts: 0 })
    expect(detail.entry.skill).toMatchObject({ helpful: 0, harmful: 0 })
    expect(detail.entry.skill.approvedBy).toBeUndefined()
  }
  const insightsB = (await json(await b.call("GET", "/memory/workflow"))) as { tiers: { arms: unknown[] }[] }
  expect(insightsB.tiers.flatMap((tier) => tier.arms)).toEqual([])
  const lessons = (await json(await b.call("GET", "/memory?filter=review"))).entries as { text: string }[]
  expect(lessons.some((item) => item.text.startsWith("Imported workflow observation for thorough work"))).toBe(true)
  const personal = (await json(await b.call("GET", "/memory?scope=personal&filter=active"))).entries as {
    text: string
  }[]
  expect(personal.map((item) => item.text)).toContain("I prefer tables for comparisons")

  // A section this Vector does not know is skipped and said so, and the memory beside it still restores. Computer B
  // keeps the vault's key since its restore, so no code is asked.
  const journal = await VaultBackup.backup({
    store: testStore({ repo: "octo/brain-vault", cache: join(root, "writer-3") }),
    opened,
    files: [
      { path: "memory/personal.json", section: "memory", bytes: v1.files[0]!.bytes, repository: "" },
      {
        path: "journal/notes.json",
        section: "journal" as Vault.Section,
        bytes: new TextEncoder().encode("{}"),
        repository: "",
      },
    ],
  })
  const skipped = await second.restore({ version: journal.snapshot.id })
  expect(skipped).toMatchObject({ ok: true })
  // The Backup page's fixture answers its "newer" version with these totals too.
  expect(skipped.totals).toEqual({
    restored: 0,
    active: 0,
    pinned: 0,
    waiting: 0,
    skills: 0,
    insights: 0,
    known: 1,
    refused: 0,
    documents: 0,
    unreadable: 0,
    version: journal.snapshot.id,
    newer: true,
  })
  // Every privacy check went to the test's API, never GitHub's.
  expect(privacy.length).toBeGreaterThan(0)
  expect(privacy.every((url) => url === "https://api.github.test/repos/octo/brain-vault")).toBe(true)
}, 240_000)

/** A version as another reader opens it, through a store of its own (a store reads the remote once). */
function reader(name: string, opened: VaultBackup.Opened, version: string) {
  return VaultBackup.read({ store: testStore({ repo: "octo/brain-vault", cache: join(root, name) }), opened, version })
}

function skillsFile() {
  const skill = (name: string, options: { private?: boolean } = {}) => ({
    id: `s_${name}`,
    scope: "repository",
    kind: "skill",
    status: "active",
    text: name,
    paths: ["src/a.ts"],
    pinned: false,
    ...(options.private ? { private: true } : {}),
    evidence: [],
    createdAt: 1_700_000_000_000,
    skill: {
      name,
      description: "When bun typecheck fails in src: run it, then read the first error.",
      procedure: "## Steps\n1. Run bun typecheck.\n2. Read the first error and fix it.",
      checks: ["bun typecheck"],
      commands: ["git diff src"],
      version: 1,
    },
  })
  return JSON.stringify({
    format: "vector-memory",
    version: 1,
    scope: "repository",
    exportedAt: Date.now(),
    entries: [],
    documents: [],
    skills: [skill("learned-bun-typecheck-src", { private: true }), skill("learned-bun-test-src")],
  })
}

async function json(response: Response) {
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, env: { ...process.env, ...ISOLATED } })
  if (result.status !== 0) throw new Error(result.stderr.toString())
}

/** One person's engine: the real server in its own process, with this profile's HOME and XDG folders. */
async function engine(name: string) {
  const home = join(root, `profile-${name}`)
  mkdirSync(home, { recursive: true })
  const password = randomBytes(16).toString("hex")
  // Only what a process needs to run is inherited: no credential, proxy or Vector setting of this computer reaches it.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => INHERITED.has(key.toUpperCase())))
  const env = {
    ...inherited,
    ...ISOLATED,
    HOME: home,
    USERPROFILE: home,
    VECTOR_TEST_HOME: home,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: password,
    VECTOR_CREDENTIAL_KEY: randomBytes(32).toString("base64"),
    VECTOR_REQUIRE_SECURE_CREDENTIAL_STORE: "1",
    VECTOR_DISABLE_AUTOUPDATE: "1",
    VECTOR_DISABLE_MODELS_FETCH: "1",
    VECTOR_MODELS_PATH: MODELS,
    VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
    VECTOR_DISABLE_CHANNEL_DB: "1",
    VECTOR_DISABLE_PROJECT_CONFIG: "1",
    VECTOR_BRAIN_EMBED: "off",
    VECTOR_PURE: "1",
    // A request that is not to this computer fails at once instead of reaching a host.
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost",
  }
  const child = Bun.spawn([process.execPath, "--no-env-file", "run", "--conditions=browser", FIXTURE], {
    cwd: home,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(child.stderr).text()
  const lines = (async function* () {
    const decoder = new TextDecoder()
    const state = { buffer: "" }
    for await (const chunk of child.stdout) {
      state.buffer += decoder.decode(chunk, { stream: true })
      const parts = state.buffer.split("\n")
      state.buffer = parts.pop() ?? ""
      yield* parts
    }
  })()
  const next = async (pattern: RegExp, ms: number) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), ms)
    // Read by hand: leaving a for-await loop early would close the stream of lines for the next wait.
    const found = await (async () => {
      while (true) {
        const line = await lines.next()
        if (line.done) return undefined
        const match = pattern.exec(line.value)
        if (match) return match
      }
    })().finally(() => clearTimeout(timer))
    if (!found) throw new Error(`The ${name} engine stopped (${await child.exited}): ${await stderr}`)
    return found
  }
  const url = (await next(/listening on (http:\/\/\S+)/, 60_000))[1]!
  const authorization = `Basic ${btoa(`vector:${password}`)}`
  return {
    url,
    password,
    call: (method: string, route: string, body?: unknown) => {
      const target = new URL(route, url)
      target.searchParams.set("directory", repo)
      return fetch(target, {
        method,
        keepalive: false,
        headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    },
    /** Records eight checked runs of thorough work in `directory`, as the engine does at the end of a run. */
    seed: async (directory: string) => {
      child.stdin.write(`workflow ${directory}\n`)
      child.stdin.flush()
      return (await next(/^(recorded)$/, 60_000))[1]
    },
    stop: async () => {
      child.kill()
      await child.exited
    },
  }
}
