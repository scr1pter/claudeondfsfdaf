import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { checkBranch, checkRepository, defaultBranch, gitEnv, GitError, HostGit, LOCKED_CONFIG, type Repository } from "../src/git"
import { runProgram, type Runner, type RunOptions } from "../src/run"

// WP A54, S7: GitHub tokens exist only inside hostd's git steps, while every agent process is paused. The token goes to
// git's environment only (never the command line, never a file), and only steps in hostd's own mirror carry it; the
// git user never runs git against the agent's repository (a push moves through a bundle). Runs real git against local
// repositories standing in for GitHub.

const TOKEN = `ghs_${"T0kenValue".repeat(4)}`
const NOW = Date.now()
const REPO: Repository = { owner: "vector-fixture", name: "app" }
const cleanups: string[] = []
afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" },
  })

function world(options: { token?: () => Promise<{ token: string; expiresAt: number }> } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "vector-git-"))
  cleanups.push(root)
  const remote = path.join(root, "github", "app.git")
  const seed = path.join(root, "seed")
  const mirrorDir = path.join(root, "mirror")
  const workDir = path.join(root, "work")
  for (const dir of [seed, mirrorDir, workDir]) mkdirSync(dir, { recursive: true })
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote)
  git(seed, "init", "--quiet", "-b", "main")
  writeFileSync(path.join(seed, "README.md"), "hello\n")
  git(seed, "add", ".")
  git(seed, "commit", "--quiet", "-m", "first")
  git(seed, "push", "--quiet", remote, "main")

  const calls: { args: readonly string[]; cwd?: string; env: Record<string, string> }[] = []
  const events: string[] = []
  const run: Runner = async (file, args, runOptions: RunOptions) => {
    calls.push({ args, ...(runOptions.cwd ? { cwd: runOptions.cwd } : {}), env: runOptions.env ?? {} })
    if (runOptions.env?.GIT_CONFIG_VALUE_0) events.push("git+token")
    return runProgram(file, args, runOptions)
  }
  const hostGit = new HostGit({
    run,
    tokens: async (repository, access) => {
      events.push(`token:${repository.owner}/${repository.name}:${access}`)
      return options.token ? options.token() : { token: TOKEN, expiresAt: NOW + 50 * 60_000 }
    },
    pauseAgent: async () => {
      events.push("pause")
      return async () => {
        events.push("resume")
      }
    },
    clock: () => NOW,
    mirrorDir,
    workDir,
    remote: () => remote,
    gitUid: undefined,
    agentUid: undefined,
  })
  return { root, remote, seed, mirrorDir, workDir, calls, events, hostGit }
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? allFiles(full) : entry.isFile() ? [full] : []
  })
}

describe("git through hostd", () => {
  test("clone, fetch and push work, and the token is only ever in git's environment, while the agent is paused", async () => {
    const w = world()
    const checkout = await w.hostGit.clone(REPO, "app")
    expect(readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("hello\n")

    // The agent's own work, on a vector/ branch.
    git(checkout, "checkout", "--quiet", "-b", "vector/fix")
    writeFileSync(path.join(checkout, "fix.txt"), "fixed\n")
    git(checkout, "add", ".")
    git(checkout, "commit", "--quiet", "-m", "fix")
    await w.hostGit.push(REPO, "app", "vector/fix")
    expect(git(w.remote, "rev-parse", "vector/fix").exitCode).toBe(0)

    // Someone else moves main on GitHub; fetch brings it in as origin/main.
    writeFileSync(path.join(w.seed, "later.txt"), "later\n")
    git(w.seed, "add", ".")
    git(w.seed, "commit", "--quiet", "-m", "later")
    git(w.seed, "push", "--quiet", w.remote, "main")
    await w.hostGit.fetch(REPO, "app")
    expect(git(checkout, "rev-parse", "origin/main").stdout.toString().trim()).toBe(git(w.seed, "rev-parse", "HEAD").stdout.toString().trim())

    // Every token step sat between a pause and a resume: each mirror update reads GitHub's default branch and fetches
    // under one token, and the push has its own.
    expect(w.events).toEqual([
      "pause",
      "token:vector-fixture/app:read",
      "git+token",
      "git+token",
      "resume",
      "pause",
      "token:vector-fixture/app:write",
      "git+token",
      "resume",
      "pause",
      "token:vector-fixture/app:read",
      "git+token",
      "git+token",
      "resume",
    ])
    for (const call of w.calls) {
      expect(call.args.join(" ")).not.toContain(TOKEN)
      expect(call.args.join(" ")).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString("base64"))
      for (const setting of LOCKED_CONFIG) expect(call.args).toContain(setting)
      expect(call.env.GIT_CONFIG_NOSYSTEM).toBe("1")
      expect(call.env.GIT_TERMINAL_PROMPT).toBe("0")
    }
    const tokenSteps = w.calls.filter((call) => call.env.GIT_CONFIG_VALUE_0)
    expect(tokenSteps).toHaveLength(5)
    for (const step of tokenSteps) {
      expect(step.cwd).toStartWith(w.mirrorDir)
      expect(step.env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader")
      expect(step.args).toContain(w.remote)
    }
    // Nothing on disk holds the token: not the mirror, not the agent's working copy.
    for (const file of [...allFiles(w.mirrorDir), ...allFiles(w.workDir)]) {
      // Git's own temporary files (a `tmp_pack_*` being renamed into place) can go between listing and reading.
      let bytes: Buffer
      try {
        bytes = readFileSync(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      expect({ file, found: bytes.includes(TOKEN) }).toEqual({ file, found: false })
    }
  })

  test("the git user never runs git in or against the agent's repository; a push moves through a bundle", async () => {
    const w = world()
    const checkout = await w.hostGit.clone(REPO, "app")
    git(checkout, "checkout", "--quiet", "-b", "vector/bundle")
    git(checkout, "commit", "--quiet", "--allow-empty", "-m", "empty")
    w.calls.length = 0
    await w.hostGit.push(REPO, "app", "vector/bundle")
    const mirrorSteps = w.calls.filter((call) => call.cwd?.startsWith(w.mirrorDir))
    expect(mirrorSteps.length).toBeGreaterThan(0)
    for (const step of mirrorSteps) expect(step.args.some((arg) => arg === checkout || arg.startsWith(`${checkout}/`))).toBe(false)
    const fromBundle = mirrorSteps.find((step) => step.args.includes("fetch"))!
    expect(fromBundle.args.find((arg) => arg.endsWith(".bundle"))).toBeDefined()
    // The bundle is gone afterwards.
    expect(readdirSync(w.workDir).filter((name) => name.endsWith(".bundle"))).toEqual([])
  })

  test("a bundle the agent swaps for a link is refused, and the link's target keeps its mode", async () => {
    const w = world()
    const checkout = await w.hostGit.clone(REPO, "app")
    git(checkout, "checkout", "--quiet", "-b", "vector/swap")
    git(checkout, "commit", "--quiet", "--allow-empty", "-m", "empty")
    const secret = path.join(w.root, "secret")
    writeFileSync(secret, "private", { mode: 0o600 })
    const swapping = new HostGit({
      run: async (file, args, options) => {
        const result = await runProgram(file, args, options)
        const bundle = args.find((arg) => arg.endsWith(".bundle"))
        if (args.includes("bundle") && bundle) {
          rmSync(bundle)
          symlinkSync(secret, bundle)
        }
        return result
      },
      tokens: async () => ({ token: TOKEN, expiresAt: NOW + 60_000 }),
      pauseAgent: async () => async () => {},
      clock: () => NOW,
      mirrorDir: w.mirrorDir,
      workDir: w.workDir,
      remote: () => w.remote,
      gitUid: undefined,
      agentUid: undefined,
    })
    await expect(swapping.push(REPO, "app", "vector/swap")).rejects.toBeInstanceOf(GitError)
    expect(statSync(secret).mode & 0o777).toBe(0o600)
  })

  test("the mirror is readable by the agent's group and nobody else", async () => {
    const w = world()
    await w.hostGit.clone(REPO, "app")
    const mirror = w.hostGit.mirrorPath(REPO)
    expect(statSync(path.join(mirror, "config")).mode & 0o777).toBe(0o640)
    expect(readFileSync(path.join(mirror, "config"), "utf8")).toContain("sharedrepository = 0640")
  })

  test("pushes go to vector/ branches only; names are checked before git runs", async () => {
    const w = world()
    await w.hostGit.clone(REPO, "app")
    for (const branch of ["main", "vector/../main", "vector/", "--force", "vector/x.lock", "refs/heads/vector/x"])
      await expect(w.hostGit.push(REPO, "app", branch)).rejects.toBeInstanceOf(GitError)
    expect(() => checkBranch("vector/fix-123/part")).not.toThrow()
    for (const directory of ["..", "../outside", "a/b", ".", ""]) expect(() => w.hostGit.checkoutPath(directory)).toThrow(GitError)
    for (const repository of [{ owner: "-x", name: "a" }, { owner: "o", name: ".." }, { owner: "o", name: "a b" }])
      expect(() => checkRepository(repository)).toThrow(GitError)
    await expect(w.hostGit.clone(REPO, "app")).rejects.toThrow("already exists")
  })

  test("a token that is missing, malformed, expired or too long-lived is refused, and the agent resumes anyway", async () => {
    for (const grant of [
      async () => {
        throw new Error("run-API host refused")
      },
      async () => ({ token: "short", expiresAt: NOW + 60_000 }),
      async () => ({ token: TOKEN, expiresAt: NOW - 1 }),
      async () => ({ token: TOKEN, expiresAt: NOW + 2 * 3_600_000 }),
    ]) {
      const w = world({ token: grant })
      await expect(w.hostGit.clone(REPO, "app")).rejects.toThrow()
      expect(w.events.filter((event) => event === "pause").length).toBe(w.events.filter((event) => event === "resume").length)
      expect(w.events).not.toContain("git+token")
    }
  })

  test("the mirror follows GitHub's default branch, read from ls-remote", () => {
    expect(defaultBranch("ref: refs/heads/trunk\tHEAD\n0123abcd\tHEAD\n")).toBe("trunk")
    expect(defaultBranch("0123abcd\tHEAD\n")).toBeUndefined()
    expect(defaultBranch("ref: refs/heads/--upload-pack=x\tHEAD\n")).toBeUndefined()
    expect(defaultBranch("ref: refs/heads/a/../b\tHEAD\n")).toBeUndefined()
  })

  test("git's environment: no system or user configuration and no prompts; the header is Basic, scoped to github.com", () => {
    expect(gitEnv("/h")).toEqual({
      HOME: "/h",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      LANG: "C",
    })
    expect(gitEnv("/h", "abc")).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from("x-access-token:abc").toString("base64")}`,
    })
    expect(LOCKED_CONFIG).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null", "credential.helper=", "http.proxy=", "protocol.allow=never"]))
  })
})
