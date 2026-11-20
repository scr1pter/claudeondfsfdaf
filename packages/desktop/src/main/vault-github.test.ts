import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { VaultError } from "@vectordevai/core/vault/error"
import { VaultBackup } from "@vectordevai/core/vault/vault"
import { createVaultBackup, localRefusal, type KeyRecord, type VaultSettings } from "./vault-backup"
import { desktopGit, githubVaultStore, remoteRefusal, send, sizeWarning, subcommand } from "./vault-github"

// WP A45: Brain Vault's free GitHub backend in the desktop app. The repository is checked to be private before every
// push, so a public one (or one that cannot be shown private) gets nothing; a private one gets the backup over the
// person's own git, keeps 7 versions, and nothing goes to vectordev.ai. The remote is a bare repository on this
// computer and GitHub's API answers are given here; nothing reaches GitHub.

const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
const previous = Object.fromEntries(Object.keys(ISOLATED).map((key) => [key, process.env[key]]))
const encoder = new TextEncoder()
const API = "https://api.github.test"
let root: string

beforeAll(async () => {
  Object.assign(process.env, ISOLATED)
  root = await mkdtemp(join(tmpdir(), "vector-vault-github-"))
})

afterAll(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

afterEach(() => Egress.configure(LocalPolicy.OFF))

let count = 0
const fresh = () => {
  const dir = join(root, `case-${++count}`)
  const remote = join(dir, "remote.git")
  const made = spawnSync("git", ["init", "--bare", "-q", "-b", "main", remote], {
    env: { ...process.env, ...ISOLATED },
  })
  if (made.status !== 0) throw new Error(made.stderr.toString())
  return { dir, remote }
}

const refs = (remote: string) =>
  spawnSync("git", ["--git-dir", remote, "for-each-ref"], { env: { ...process.env, ...ISOLATED } }).stdout.toString()

const answer = (status: number, body?: unknown) => async (url: string) => {
  seen.push(url)
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
let seen: string[] = []

const COUNTS_UNUSED = { restored: 0, active: 0, pinned: 0, waiting: 0, known: 0, refused: 0, documents: 0 }

const files = (text: string) => [
  { path: "memory/personal.json", section: "memory" as const, bytes: encoder.encode(text), repository: "" },
]

describe("the desktop's GitHub backend", () => {
  test("a public repository is refused before anything is pushed", async () => {
    seen = []
    const { dir, remote } = fresh()
    const store = githubVaultStore({
      repo: "octo/brain-vault",
      cache: dir,
      remote,
      api: API,
      send: answer(200, { private: false }),
    })
    const created = await VaultBackup.create(store, { cost: 2 ** 14 })
    const refused = await VaultBackup.backup({ store, opened: created, files: files("I prefer tables") }).catch(
      (error) => error,
    )
    expect(refused).toBeInstanceOf(VaultError)
    expect((refused as VaultError).code).toBe("public-repo")
    expect((refused as Error).message).toContain("octo/brain-vault is public")
    expect(seen).toEqual([`${API}/repos/octo/brain-vault`])
    expect(refs(remote)).toBe("")
  })

  test("an answer that does not prove the repository private refuses the push too", async () => {
    for (const reply of [answer(403, { message: "rate limited" }), answer(301), answer(200, {})]) {
      const { dir, remote } = fresh()
      const store = githubVaultStore({ repo: "octo/brain-vault", cache: dir, remote, api: API, send: reply })
      const created = await VaultBackup.create(store, { cost: 2 ** 14 })
      const refused = await VaultBackup.backup({ store, opened: created, files: files("x") }).catch((error) => error)
      expect((refused as VaultError).code).toBe("public-repo")
      expect(refs(remote)).toBe("")
    }
  })

  test("a private repository gets the backup over git, and nothing is sent to vectordev.ai", async () => {
    seen = []
    const { dir, remote } = fresh()
    const fetched: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        fetched.push(String(input instanceof Request ? input.url : input))
        return new Response(null, { status: 599 })
      },
      { preconnect: () => undefined },
    ) as typeof fetch
    try {
      let settings: Partial<VaultSettings> = { backend: "github", githubRepo: "octo/brain-vault" }
      let record: KeyRecord | undefined
      const asked: string[] = []
      const backup = createVaultBackup({
        cost: 2 ** 14,
        settings: { read: () => settings, write: (next) => void (settings = next) },
        keys: {
          secure: () => true,
          read: async () => record,
          write: async (next) => void (record = next),
          clear: async () => void (record = undefined),
        },
        memory: async () => [{ path: "memory/personal.json", text: '{"format":"vector-memory"}', repository: "" }],
        restore: async () => {
          throw new Error("not used")
        },
        githubStore: (repo) => githubVaultStore({ repo, cache: dir, remote, api: API, send: answer(404) }),
        vectorStore: () => {
          asked.push("vector store")
          throw new Error("not used")
        },
        token: async () => {
          asked.push("token")
          return "vct_never"
        },
        codium: async () => {
          asked.push("codium status")
          throw new Error("not used")
        },
      })
      const done = await backup.backup()
      expect(done.ok).toBe(true)
      expect(done.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/)
      expect(record?.backend).toEqual({ type: "github", repo: "octo/brain-vault" })
      expect(settings.last?.files).toBe(1)
      expect(refs(remote)).toContain("refs/heads/main")
      // Only GitHub's API was asked, for the privacy check before the push; no sign-in, status or Vault API.
      expect(seen.every((url) => url === `${API}/repos/octo/brain-vault`)).toBe(true)
      expect(seen.length).toBeGreaterThan(0)
      expect(asked).toEqual([])
      expect(fetched).toEqual([])
      expect([...seen, ...fetched].some((url) => url.includes("vectordev.ai"))).toBe(false)
      // A second backup is checked again before its push.
      const before = seen.length
      expect((await backup.backup()).ok).toBe(true)
      expect(seen.length).toBeGreaterThan(before)
      expect((await backup.backup()).code).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })

  test("keeps the 7 newest versions", async () => {
    const { dir, remote } = fresh()
    const store = githubVaultStore({ repo: "octo/brain-vault", cache: dir, remote, api: API, send: answer(404) })
    const created = await VaultBackup.create(store, { cost: 2 ** 14 })
    for (let index = 0; index < 9; index++)
      await VaultBackup.backup({
        store,
        opened: created,
        files: files(`version ${index}`),
        now: 1_800_000_000_000 + index * 1000,
      })
    const listing = await githubVaultStore({
      repo: "octo/brain-vault",
      cache: join(dir, "other"),
      remote,
      api: API,
      send: answer(404),
    }).list()
    expect(listing.snapshots).toHaveLength(7)
    expect(listing.storedBytes).toBeGreaterThan(0)
  })

  test("warns once the vault takes more than 1 GB of the repository", () => {
    expect(sizeWarning(undefined, "octo/brain-vault")).toBeUndefined()
    expect(sizeWarning(1_000_000_000, "octo/brain-vault")).toBeUndefined()
    const warning = sizeWarning(1_250_000_000, "octo/brain-vault")
    expect(warning).toContain("1.3 GB in octo/brain-vault")
    expect(warning).toContain("1 GB")
  })

  test("with Vector Local on, git's requests to github.com and the privacy check are blocked before they start", async () => {
    Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
    expect(remoteRefusal("https://github.com/octo/brain-vault.git")).toStartWith(
      "Vector Local blocked a git request to github.com.",
    )
    expect(remoteRefusal("/a/path/on/this/computer.git")).toBeUndefined()
    const { dir } = fresh()
    const git = desktopGit({ remote: "https://github.com/octo/brain-vault.git", cwd: dir })
    const listed = await git([
      "--git-dir=/nowhere",
      "ls-remote",
      "https://github.com/octo/brain-vault.git",
      "refs/heads/main",
    ])
    expect(listed.exitCode).toBe(128)
    expect(listed.stderr).toStartWith("Vector Local blocked a git request to github.com.")
    const pushed = await git(["--git-dir=/nowhere", "-c", "core.hooksPath=/none", "push", "-q", "x", "y"])
    expect(pushed.exitCode).toBe(128)
    const blocked = await send("https://api.github.com/repos/octo/brain-vault", { redirect: "manual" }).catch(
      (error) => error,
    )
    expect((blocked as Error).name).toBe("EgressBlocked")
    // A local command still runs.
    expect((await git(["--version"])).exitCode).toBe(0)
  })

  test("git gets only the person's own credentials: no token in an argument, the environment, the remote or the copy's config", async () => {
    const { dir, remote } = fresh()
    const planted = {
      VECTOR_CREDENTIAL_KEY: "planted-credential-key",
      VECTOR_CLOUD_TOKEN: "planted-cloud-token",
      VECTOR_X_SERVER_PASSWORD: "planted-server-password",
    }
    const kept = Object.fromEntries(
      [...Object.keys(planted), "GIT_ASKPASS", "SSH_ASKPASS", "GIT_TERMINAL_PROMPT"].map((key) => [
        key,
        process.env[key],
      ]),
    )
    Object.assign(process.env, planted)
    delete process.env.GIT_ASKPASS
    delete process.env.SSH_ASKPASS
    // A shell may set it already; desktopGit must add it itself.
    delete process.env.GIT_TERMINAL_PROMPT
    try {
      const real = desktopGit({ remote, cwd: dir })
      const seenArgs: string[][] = []
      const seenEnv: string[][] = []
      const git: typeof real = (args, more) => {
        seenArgs.push([...args])
        seenEnv.push(Object.keys(more?.env ?? {}))
        return real(args, more)
      }
      const store = githubVaultStore({ repo: "octo/brain-vault", cache: dir, remote, api: API, git, send: answer(404) })
      const created = await VaultBackup.create(store, { cost: 2 ** 14 })
      await VaultBackup.backup({ store, opened: created, files: files("I prefer tables") })
      expect(refs(remote)).toContain("refs/heads/main")
      expect(seenArgs.flat().some((arg) => /extraheader|credential|askpass|token|@/i.test(arg))).toBe(false)
      const connecting = seenArgs.filter((args) => ["ls-remote", "fetch", "push"].includes(subcommand(args) ?? ""))
      expect(connecting.length).toBeGreaterThan(0)
      expect(connecting.every((args) => args.includes(remote))).toBe(true)
      const allowed = /^GIT_(INDEX_FILE|AUTHOR_NAME|AUTHOR_EMAIL|COMMITTER_NAME|COMMITTER_EMAIL)$/
      expect(seenEnv.flat().every((key) => allowed.test(key))).toBe(true)
      const config = await readFile(join(dir, "github", "octo", "brain-vault.git", "config"), "utf8")
      for (const word of ["[remote", "url =", "pushurl", "extraheader", "credential"])
        expect(config).not.toContain(word)

      // The environment git itself runs with: Vector's secrets are kept out, no prompt and no askpass is added. Only
      // the names checked are asked for (`printenv` prints the value of each one set), never the whole environment,
      // and only counts are compared where a value could be a secret.
      const printed = (names: string[]) =>
        real(["-c", `alias.probe=!printenv ${names.join(" ")}; true`, "probe"]).then((result) =>
          result.stdout.toString("utf8").split(/\r?\n/).filter(Boolean),
        )
      expect((await printed(Object.keys(planted))).length).toBe(0)
      expect(await printed(["GIT_TERMINAL_PROMPT"])).toEqual(["0"])
      expect((await printed(["GIT_ASKPASS", "SSH_ASKPASS"])).length).toBe(0)
    } finally {
      for (const [key, value] of Object.entries(kept)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test.skipIf(process.platform === "win32")(
    "git that cannot start shows plain copy, never the system's text",
    async () => {
      const { dir, remote } = fresh()
      const bin = join(dir, "bin")
      await mkdir(bin, { recursive: true })
      // A git on PATH that is no program the system can run: spawn fails with ENOEXEC, not ENOENT. Electron's Node reports
      // it as the child's error event (desktopGit's fixed copy); Bun throws it from spawn (the controller's fallback).
      await writeFile(join(bin, "git"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]), { mode: 0o755 })
      let settings: Partial<VaultSettings> = { backend: "github", githubRepo: "octo/brain-vault" }
      let record: KeyRecord | undefined
      const backup = createVaultBackup({
        cost: 2 ** 14,
        settings: { read: () => settings, write: (next) => void (settings = next) },
        keys: {
          secure: () => true,
          read: async () => record,
          write: async (next) => void (record = next),
          clear: async () => void (record = undefined),
        },
        memory: async () => [{ path: "memory/personal.json", text: '{"format":"vector-memory"}', repository: "" }],
        restore: async () => COUNTS_UNUSED,
        githubStore: (repo) =>
          githubVaultStore({ repo, cache: join(dir, "cache"), remote, api: API, send: answer(404) }),
        vectorStore: () => {
          throw new Error("not used")
        },
        token: async () => undefined,
        codium: async () => {
          throw new Error("not used")
        },
      })
      const path = process.env.PATH
      process.env.PATH = bin
      const result = await backup.backup().finally(() => {
        process.env.PATH = path
      })
      expect(result.ok).toBe(false)
      expect([
        "Brain Vault could not finish the backup. Try again.",
        "Vector could not set up its copy of the vault: Git could not start on this computer. Check that Git works in a terminal, then try again.",
      ]).toContain(result.message)
      expect(JSON.stringify(settings)).not.toMatch(/ENOEXEC|posix_spawn|spawn git/)
      expect(JSON.stringify(settings)).not.toContain(dir)
    },
  )

  test.skipIf(process.platform === "win32")(
    "a git program that cannot start answers fixed copy, never the errno or its path",
    async () => {
      const { dir, remote } = fresh()
      // A file that is not executable: spawn reports EACCES as the child's error event, as Electron's Node does for
      // any start failure.
      const command = join(dir, "not-git")
      await writeFile(command, "not a program\n", { mode: 0o644 })
      const result = await desktopGit({ remote, cwd: dir, command })(["--version"])
      expect(result.exitCode).toBe(127)
      expect(result.stderr).toBe(
        "Git could not start on this computer. Check that Git works in a terminal, then try again.",
      )
      expect(result.stderr).not.toContain("EACCES")
      expect(result.stderr).not.toContain(dir)
    },
  )

  test("Vector Local refuses both network backends before anything is asked", () => {
    expect(localRefusal({ type: "github", repo: "octo/brain-vault" })).toBeUndefined()
    expect(localRefusal({ type: "vector" })).toBeUndefined()
    Egress.configure(LocalPolicy.resolve({ global: { enabled: true } }))
    expect(localRefusal({ type: "github", repo: "octo/brain-vault" })).toStartWith(
      "Vector Local keeps Brain Vault off.",
    )
    expect(localRefusal({ type: "vector" })).toStartWith("Vector Local keeps Brain Vault off.")
  })

  test("reads the subcommand past git's own options", () => {
    expect(subcommand(["--git-dir=/x", "ls-remote", "url"])).toBe("ls-remote")
    expect(subcommand(["--git-dir=/x", "-c", "core.hooksPath=/y", "push", "-q"])).toBe("push")
    expect(subcommand(["--git-dir=/x", "-c", "commit.gpgsign=false", "commit-tree", "abc"])).toBe("commit-tree")
    expect(subcommand([])).toBeUndefined()
  })
})
