import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { VaultError } from "@vectordevai/core/vault/error"
import { VaultGitHub } from "@vectordevai/core/vault/github"
import { VaultBackup } from "@vectordevai/core/vault/vault"
import { tmpdir } from "../fixture/tmpdir"

// Brain Vault's free GitHub backend over real git, against a bare repository on this computer standing in for GitHub
// (nothing reaches the network; the privacy check's answers are given). Every push is checked private first and
// replaces the branch with one parentless commit, so forgotten versions leave it and the repository keeps 7.

const COST = 2 ** 14
const encoder = new TextEncoder()
const ISOLATED = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }

const git: VaultGitHub.Git = async (args, options) => {
  const result = spawnSync("git", [...args], {
    input: options?.input,
    env: { ...process.env, ...ISOLATED, ...options?.env },
    maxBuffer: 256 * 1024 * 1024,
  })
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr.toString("utf8") }
}

function sh(args: string[], cwd?: string) {
  const result = spawnSync("git", args, { cwd, env: { ...process.env, ...ISOLATED, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } })
  if (result.status !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString("utf8").trim()
}

type Answer = { status: number; body?: unknown } | "offline"

function github(answer: () => Answer) {
  const requests: { url: string; init: RequestInit }[] = []
  const send: VaultGitHub.Send = async (url, init) => {
    requests.push({ url, init })
    const next = answer()
    if (next === "offline") throw new TypeError("fetch failed")
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status })
  }
  return { send, requests }
}

async function setup() {
  const tmp = await tmpdir()
  const remote = path.join(tmp.path, "remote.git")
  sh(["init", "--bare", "-q", "-b", "main", remote])
  let answer: Answer = { status: 404 }
  const fake = github(() => answer)
  const make = (name: string) =>
    VaultGitHub.store({ repo: "octo/brain-vault", remote, api: "https://api.github.test", dir: path.join(tmp.path, name), git, send: fake.send })
  return {
    tmp,
    remote,
    make,
    requests: fake.requests,
    answer: (next: Answer) => {
      answer = next
    },
  }
}

const file = (text: string): VaultBackup.Input => ({ path: "memory/personal.json", section: "memory", bytes: encoder.encode(text), repository: "" })

describe("VaultGitHub.checkPrivate", () => {
  test("only a 404 or an answer that says private lets a push go", async () => {
    const check = (answer: Answer) =>
      VaultGitHub.checkPrivate({ api: "https://api.github.test/", repo: "octo/brain-vault", send: github(() => answer).send }).then(
        () => "ok",
        (error: unknown) => (error instanceof VaultError ? error.code : "other"),
      )
    expect(await check({ status: 404 })).toBe("ok")
    expect(await check({ status: 200, body: { private: true } })).toBe("ok")
    expect(await check({ status: 200, body: { private: false } })).toBe("public-repo")
    expect(await check({ status: 200, body: {} })).toBe("public-repo")
    expect(await check({ status: 301 })).toBe("public-repo")
    expect(await check({ status: 403 })).toBe("public-repo")
    expect(await check("offline")).toBe("public-repo")
    const fake = github(() => ({ status: 404 }))
    await VaultGitHub.checkPrivate({ api: "https://api.github.test", repo: "octo/brain-vault", send: fake.send })
    expect(fake.requests[0]!.url).toBe("https://api.github.test/repos/octo/brain-vault")
    // No sign-in is sent: a public repository is visible without one, which is the whole check.
    expect(JSON.stringify(fake.requests[0]!.init.headers)).not.toMatch(/authorization/i)
    expect(fake.requests[0]!.init.redirect).toBe("manual")
  })

  test("repository names are owner/repo", () => {
    expect(VaultGitHub.parseRepo("octo/brain-vault")?.full).toBe("octo/brain-vault")
    for (const bad of ["octo", "octo/", "/repo", "octo/repo/extra", "octo/..", "octo/repo.git", "https://github.com/octo/repo", "-octo/repo"])
      expect(VaultGitHub.parseRepo(bad)).toBeUndefined()
  })
})

describe("VaultGitHub.store", () => {
  test("backs up over git, restores on another computer, and each push is one parentless commit", async () => {
    const env = await setup()
    await using _ = env.tmp
    const store = env.make("cache-a")
    const created = await VaultBackup.create(store, { cost: COST })
    const first = await VaultBackup.backup({ store, opened: created, files: [file("I prefer tables for comparisons")] })
    const second = await VaultBackup.backup({ store, opened: created, files: [file("I prefer tables for comparisons, always")] })
    expect(sh(["--git-dir", env.remote, "rev-list", "--count", "main"])).toBe("1")
    const names = sh(["--git-dir", env.remote, "ls-tree", "-r", "--name-only", "main"]).split("\n")
    expect(names).toContain("vault.json")
    expect(names).toContain("README.md")
    expect(names).toContain(`versions/${first.snapshot.id}`)
    expect(names).toContain(`versions/${second.snapshot.id}.json`)
    expect(names.every((name) => /^(README\.md|vault\.json|versions\/v\d{13}-[0-9a-f]{8}(\.json)?|objects\/[0-9a-f]{2}\/[0-9a-f]{64})$/.test(name))).toBe(true)
    // Nothing in the repository reads as the content.
    for (const name of names) expect(sh(["--git-dir", env.remote, "show", `main:${name}`])).not.toContain("prefer tables")
    // Every push was checked first.
    expect(env.requests.length).toBe(2)

    const other = env.make("cache-b")
    const opened = await VaultBackup.unlock(other, created.code)
    const listing = await other.list()
    expect(listing.snapshots.map((snapshot) => snapshot.id)).toEqual([second.snapshot.id, first.snapshot.id])
    expect(listing.storedBytes).toBeGreaterThan(0)
    const read = await VaultBackup.read({ store: other, opened })
    expect(read.files[0]!.bytes.toString("utf8")).toBe("I prefer tables for comparisons, always")
    const old = await VaultBackup.read({ store: other, opened, version: first.snapshot.id })
    expect(old.files[0]!.bytes.toString("utf8")).toBe("I prefer tables for comparisons")
  })

  test("a public repository is refused before anything is pushed", async () => {
    const env = await setup()
    await using _ = env.tmp
    const store = env.make("cache")
    const created = await VaultBackup.create(store, { cost: COST })
    await VaultBackup.backup({ store, opened: created, files: [file("first")] })
    const tip = sh(["--git-dir", env.remote, "rev-parse", "main"])
    env.answer({ status: 200, body: { private: false, full_name: "octo/brain-vault" } })
    const refused = await VaultBackup.backup({ store, opened: created, files: [file("second")] }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(VaultError)
    expect((refused as VaultError).code).toBe("public-repo")
    expect((refused as Error).message).toContain("octo/brain-vault is public")
    expect(sh(["--git-dir", env.remote, "rev-parse", "main"])).toBe(tip)
    env.answer({ status: 403 })
    const unknown = await VaultBackup.backup({ store, opened: created, files: [file("third")] }).catch((error: unknown) => error)
    expect((unknown as VaultError).code).toBe("public-repo")
    expect(sh(["--git-dir", env.remote, "rev-parse", "main"])).toBe(tip)
  })

  test("keeps the newest 7 versions, and forget takes a version and the pieces only it named off the branch", async () => {
    const env = await setup()
    await using _ = env.tmp
    const store = env.make("cache")
    const created = await VaultBackup.create(store, { cost: COST })
    const ids: string[] = []
    for (let i = 0; i < 9; i++)
      ids.push((await VaultBackup.backup({ store, opened: created, files: [file(`version ${i}`)], now: Date.now() + i * 1000 })).snapshot.id)
    const listed = (await store.list()).snapshots.map((snapshot) => snapshot.id)
    expect(listed).toEqual(ids.slice(2).reverse())
    const objects = () => sh(["--git-dir", env.remote, "ls-tree", "-r", "--name-only", "main"]).split("\n").filter((name) => name.startsWith("objects/"))
    expect(objects()).toHaveLength(7)
    await VaultBackup.forget({ store, opened: created, version: ids[4]! })
    expect(objects()).toHaveLength(6)
    expect((await store.list()).snapshots.map((snapshot) => snapshot.id)).not.toContain(ids[4])
    expect(sh(["--git-dir", env.remote, "rev-list", "--count", "main"])).toBe("1")
  })

  test("a repository holding anything but a vault is refused", async () => {
    const env = await setup()
    await using _ = env.tmp
    const work = path.join(env.tmp.path, "work")
    sh(["init", "-q", "-b", "main", work])
    await Bun.write(path.join(work, "src", "index.ts"), "export {}\n")
    sh(["add", "."], work)
    sh(["commit", "-q", "-m", "code"], work)
    sh(["push", "-q", env.remote, "main"], work)
    const refused = await VaultBackup.create(env.make("cache"), { cost: COST }).catch((error: unknown) => error)
    expect((refused as VaultError).code).toBe("exists")
    expect((refused as Error).message).toContain("not a Brain Vault")
  })

  test("two computers backing up at once cannot overwrite each other", async () => {
    const env = await setup()
    await using _ = env.tmp
    const a = env.make("cache-a")
    const created = await VaultBackup.create(a, { cost: COST })
    await VaultBackup.backup({ store: a, opened: created, files: [file("first")] })
    const b = env.make("cache-b")
    const opened = await VaultBackup.unlock(b, created.code)
    // b reads the branch, then a pushes, then b's push finds the branch moved.
    await b.list()
    await VaultBackup.backup({ store: a, opened: created, files: [file("from a")] })
    const lost = await VaultBackup.backup({ store: b, opened, files: [file("from b")] }).catch((error: unknown) => error)
    expect((lost as VaultError).code).toBe("unavailable")
    expect((lost as Error).message).toContain("changed while Vector backed up")
    expect((await VaultBackup.read({ store: env.make("cache-c"), opened })).files[0]!.bytes.toString("utf8")).toBe("from a")
    // Run again, it reads the branch afresh and goes through.
    await VaultBackup.backup({ store: b, opened, files: [file("from b")] })
    expect((await VaultBackup.read({ store: env.make("cache-d"), opened })).files[0]!.bytes.toString("utf8")).toBe("from b")
  })

  test("deleting the vault leaves only a README, and a new vault may start there", async () => {
    const env = await setup()
    await using _ = env.tmp
    const store = env.make("cache")
    const created = await VaultBackup.create(store, { cost: COST })
    await VaultBackup.backup({ store, opened: created, files: [file("gone soon")] })
    await store.destroy()
    expect(sh(["--git-dir", env.remote, "ls-tree", "-r", "--name-only", "main"])).toBe("README.md")
    const fresh = env.make("cache-new")
    expect(await fresh.readKey()).toBeUndefined()
    const next = await VaultBackup.create(fresh, { cost: COST })
    await VaultBackup.backup({ store: fresh, opened: next, files: [file("new vault")] })
    expect((await VaultBackup.read({ store: env.make("cache-check"), opened: next })).files[0]!.bytes.toString("utf8")).toBe("new vault")
  })
})
