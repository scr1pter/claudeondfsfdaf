import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"
import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { createJobId } from "@vectordevai/schema/everywhere"
import { createEverywhereGit, GIT_HARDENING, runnerGitEnvironment, safeRepositoryConfig } from "./everywhere-git"

installFetchGuard()

test("unknown executable config and secret-bearing inherited environment fail closed", () => {
  expect(safeRepositoryConfig("core.repositoryformatversion\n0\0remote.origin.url\nhttps://github.com/acme/app.git\0")).toBe(true)
  for (const key of ["include.path", "filter.secrets.clean", "url.ssh://attacker/.insteadof", "credential.helper", "core.gitproxy", "diff.secret.textconv"])
    expect(safeRepositoryConfig(`${key}\nanything\0`)).toBe(false)
  const env = runnerGitEnvironment({ PATH: "/bin", HOME: "/test-home", GITHUB_TOKEN: "generated-test-secret", AWS_SECRET_ACCESS_KEY: "generated-test-secret", GIT_CONFIG_COUNT: "1" })
  expect(env.GITHUB_TOKEN).toBeUndefined()
  expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  expect(env.GIT_CONFIG_COUNT).toBeUndefined()
  expect(env.GIT_CONFIG_GLOBAL).toBe(os.devNull)
})

test("stock Windows, gh, VS Code and partial-clone settings are inert and stay allowed", () => {
  // A default Git for Windows clone (symlinks off), after `gh repo set-default`, a VS Code branch and a partial clone.
  const stock = [
    "core.repositoryformatversion\n0", "core.filemode\nfalse", "core.bare\nfalse", "core.logallrefupdates\ntrue",
    "core.symlinks\nfalse", "core.ignorecase\ntrue", "core.autocrlf\ntrue",
    "remote.origin.url\nhttps://github.com/acme/app.git", "remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*",
    "remote.origin.gh-resolved\nbase", "remote.origin.promisor\ntrue", "remote.origin.partialclonefilter\nblob:none",
    "extensions.partialclone\norigin", "branch.main.remote\norigin", "branch.main.merge\nrefs/heads/main",
    "branch.fix/retry.vscode-merge-base\norigin/main", "branch.fix/retry.rebase\nfalse", "branch.fix/retry.gh-merge-base\nmain",
    "pull.rebase\nfalse", "maintenance.auto\nfalse", "maintenance.strategy\nincremental", "maintenance.gc.enabled\nfalse",
    "submodule.vendor/lib.url\nhttps://github.com/acme/lib.git", "submodule.vendor/lib.active\ntrue",
  ]
  expect(safeRepositoryConfig(`${stock.join("\0")}\0`)).toBe(true)
  for (const key of ["submodule.vendor/lib.update", "core.editor", "core.pager", "core.askpass", "gpg.program", "http.proxy",
    "http.https://github.com/.extraheader", "includeif.gitdir:/x/.path", "remote.origin.uploadpack", "remote.origin.receivepack",
    "branch.main.vscode-merge-base.extra", "maintenance.gc.command"])
    expect({ key, safe: safeRepositoryConfig(`core.symlinks\nfalse\0${key}\nanything\0`) }).toEqual({ key, safe: false })
})

test("actual git ignores hooks, holds workflow files, and detects metadata changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "everywhere-git-"))
  const git = (...args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${os.devNull}`, ...args], {
    cwd: directory, env: runnerGitEnvironment(), stdio: ["ignore", "pipe", "pipe"],
  }).toString()
  try {
    git("init", "-q", "-b", "main")
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.invalid")
    git("remote", "add", "origin", "git@github.com:acme/app.git")
    await writeFile(path.join(directory, "README.md"), "before\n")
    await mkdir(path.join(directory, ".husky"))
    await writeFile(path.join(directory, ".husky", "pre-commit"), "#!/bin/sh\nprintf ran > hook-ran\n")
    await chmod(path.join(directory, ".husky", "pre-commit"), 0o700)
    git("config", "core.hooksPath", ".husky")
    git("add", ".")
    git("commit", "-qm", "fixture")
    const runner = createEverywhereGit({ directory, repository: "acme/app", identity: { name: "Fixture", email: "fixture@example.invalid" } })
    expect(await runner.mapping()).toBe("mapped")
    const snapshot = await runner.snapshot()
    await writeFile(path.join(directory, "README.md"), "after\n")
    await writeFile(path.join(directory, ".husky", "pre-commit"), "#!/bin/sh\nprintf malicious > hook-ran\n")
    await mkdir(path.join(directory, ".github"))
    await writeFile(path.join(directory, ".github", "new.yml"), "unsafe: workflow\n")
    const staged = await runner.stage(snapshot, directory)
    expect(staged?.held.sort()).toEqual([".github/new.yml", ".husky/pre-commit"])
    expect(staged?.files).toBe(1)
    expect(await runner.commit(snapshot, directory, "Fixture [skip ci]")).toMatch(/^[0-9a-f]{40}$/)
    expect(await readFile(path.join(directory, "hook-ran")).catch(() => undefined)).toBeUndefined()
    git("config", "core.fsmonitor", "changed")
    expect(await runner.unchanged(snapshot)).toBe(false)
    expect(await runner.stage(snapshot, directory)).toBeUndefined()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("the actual local remote must match the declared allowed project before work can start", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "everywhere-remote-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, env: runnerGitEnvironment(), stdio: "pipe" })
  try {
    git("init", "-q")
    const runner = createEverywhereGit({ directory, repository: "acme/app", identity: { name: "Fixture", email: "fixture@example.invalid" } })
    expect(await runner.mapping()).toBe("other-repository")
    git("remote", "add", "origin", "https://github.com/acme/other.git")
    expect(await runner.mapping()).toBe("other-repository")
    git("remote", "set-url", "origin", "https://github.com.evil.invalid/acme/app.git")
    expect(await runner.mapping()).toBe("other-repository")
    git("remote", "set-url", "origin", "ssh://git@github.com/ACME/APP.git")
    expect(await runner.mapping()).toBe("mapped")
    // What a default Git for Windows clone and `gh repo set-default` write to the actual local config.
    git("config", "core.symlinks", "false")
    git("config", "remote.origin.gh-resolved", "base")
    expect(await runner.mapping()).toBe("mapped")
    git("config", "include.path", "ignored-fixture-config")
    expect(await runner.mapping()).toBe("unsafe-config")
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("network git uses a canonical URL and job-specific ref rather than shared FETCH_HEAD", async () => {
  const calls: readonly string[][] = []
  const mutable = calls as string[][]
  const directory = await realpath(os.tmpdir())
  const runner = createEverywhereGit({ directory: os.tmpdir(), repository: "acme/app", identity: { name: "Fixture", email: "fixture@example.invalid" },
    execute: async ({ args }) => { mutable.push([...args]); return args.includes("config") ? "remote.origin.url\nhttps://github.com/acme/app.git\0" : args.includes("--git-path") ? path.join(directory, `vector-fixture-${jid}-config.worktree`) : args.some((arg) => ["--show-toplevel", "--absolute-git-dir", "--git-common-dir"].includes(arg)) ? directory : args.includes("rev-parse") ? "a".repeat(40) : "" } })
  const snapshot = { directory, gitDirectory: directory, commonDirectory: directory, config: [], pushUrl: "https://github.com/acme/app.git", baseSha: "a".repeat(40) }
  const jid = createJobId(Date.now())
  await runner.fetch(snapshot, "main", jid)
  await runner.push(snapshot, os.tmpdir(), "vector/ve-abcdefghijkl")
  expect(mutable.every((args) => GIT_HARDENING.every((flag) => args.includes(flag)))).toBe(true)
  const pushed = mutable.find((args) => args.includes("push"))!
  expect(pushed).toContain("https://github.com/acme/app.git")
  expect(pushed).toContain("HEAD:refs/heads/vector/ve-abcdefghijkl")
  expect(pushed).not.toContain("origin")
  expect(pushed).not.toContain("--force")
  expect(mutable.find((args) => args.includes("fetch"))).toContain(`refs/heads/main:refs/vector-everywhere/${jid}`)
})

test("core.worktree cannot redirect snapshot or publication outside the allowed canonical directory", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "everywhere-place-"))
  const outside = await mkdtemp(path.join(os.tmpdir(), "everywhere-outside-"))
  const git = (...args: string[]) => execFileSync("git", ["-c", `core.hooksPath=${os.devNull}`, ...args], {
    cwd: directory, env: runnerGitEnvironment(), stdio: ["ignore", "pipe", "pipe"],
  }).toString()
  try {
    git("init", "-q", "-b", "main")
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.invalid")
    git("remote", "add", "origin", "https://github.com/acme/app.git")
    await writeFile(path.join(directory, "README.md"), "allowed\n")
    await writeFile(path.join(outside, "README.md"), "outside\n")
    git("add", ".")
    git("commit", "-qm", "fixture")
    const runner = createEverywhereGit({ directory, repository: "acme/app", identity: { name: "Fixture", email: "fixture@example.invalid" } })
    git("config", "core.worktree", outside)
    await expect(runner.snapshot()).rejects.toThrow("The Everywhere working directory does not match")
    git("config", "--unset", "core.worktree")
    const snapshot = await runner.snapshot()
    expect(snapshot.directory).toBe(await realpath(directory))
    expect(await runner.stage(snapshot, outside)).toBeUndefined()
    expect(await runner.commit(snapshot, outside, "Refused [skip ci]")).toBeUndefined()
    expect(await runner.push(snapshot, outside, "vector/ve-abcdefghijkl")).toBe(false)
    expect(await readFile(path.join(outside, "README.md"), "utf8")).toBe("outside\n")
    expect(git("status", "--porcelain")).toBe("")
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

async function linkedRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "everywhere-linked-"))
  const project = path.join(root, "project")
  const worktree = path.join(root, "worktree")
  await mkdir(project)
  const git = (...args: string[]) => execFileSync("git", [...GIT_HARDENING, ...args], {
    cwd: project, env: runnerGitEnvironment(), stdio: ["ignore", "pipe", "pipe"],
  }).toString()
  git("init", "-q", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.invalid")
  git("config", "extensions.worktreeConfig", "true")
  git("remote", "add", "origin", "https://github.com/acme/app.git")
  await writeFile(path.join(project, "README.md"), "allowed\n")
  git("add", ".")
  git("commit", "-qm", "fixture")
  git("worktree", "add", "--detach", worktree, "HEAD")
  return { root, project, worktree, git }
}

test("active config.worktree includes, filters and URL rewrites are refused before network or writes", async () => {
  const f = await linkedRepository()
  let authentications = 0
  const runner = createEverywhereGit({ directory: f.worktree, repository: "acme/app", identity: { name: "Fixture", email: "fixture@example.invalid" },
    authenticate: async () => { authentications++; return undefined } })
  try {
    // A newly created linked worktree legitimately has no config.worktree file.
    expect(await runner.mapping()).toBe("mapped")
    for (const key of ["include.path", "filter.fixture.clean", "url.https://rewrite.invalid/.insteadOf"]) {
      const snapshot = await runner.snapshot()
      f.git("-C", f.worktree, "config", "--worktree", key, "fixture-missing")
      expect(await runner.mapping()).toBe("unsafe-config")
      await expect(runner.snapshot()).rejects.toThrow("Everywhere refuses executable repository configuration")
      await expect(runner.fetch(snapshot, "main", createJobId(Date.now()))).rejects.toThrow("Everywhere git authority changed")
      expect(await runner.stage(snapshot, f.worktree)).toBeUndefined()
      expect(await runner.commit(snapshot, f.worktree, "Refused [skip ci]")).toBeUndefined()
      expect(await runner.push(snapshot, f.worktree, "vector/ve-abcdefghijkl")).toBe(false)
      f.git("-C", f.worktree, "config", "--worktree", "--unset", key)
    }
    f.git("-C", f.worktree, "config", "--worktree", "remote.origin.url", "https://github.com/acme/other.git")
    expect(await runner.mapping()).toBe("other-repository")
    expect(authentications).toBe(0)
    expect(f.git("-C", f.worktree, "status", "--porcelain")).toBe("")
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test("a switched .git pointer cannot reuse old metadata hashes to authorize another git directory", async () => {
  const f = await linkedRepository()
  let authentications = 0
  const runner = createEverywhereGit({ directory: f.worktree, repository: "acme/app", identity: { name: "Fixture", email: "fixture@example.invalid" },
    authenticate: async () => { authentications++; return undefined } })
  try {
    const snapshot = await runner.snapshot()
    const originalConfig = await readFile(path.join(snapshot.commonDirectory, "config"), "utf8")
    const replacement = path.join(f.root, "replacement.git")
    f.git("init", "--bare", "-q", replacement)
    f.git("--git-dir", replacement, "config", "core.bare", "false")
    f.git("--git-dir", replacement, "config", "core.worktree", f.worktree)
    f.git("--git-dir", replacement, "config", "remote.origin.url", "https://github.com/acme/app.git")
    await writeFile(path.join(f.worktree, ".git"), `gitdir: ${replacement.replaceAll("\\", "/")}\n`)
    expect(await readFile(path.join(snapshot.commonDirectory, "config"), "utf8")).toBe(originalConfig)
    expect(await runner.unchanged(snapshot)).toBe(false)
    await expect(runner.fetch(snapshot, "main", createJobId(Date.now()))).rejects.toThrow("Everywhere git authority changed")
    expect(await runner.stage(snapshot, f.worktree)).toBeUndefined()
    expect(await runner.commit(snapshot, f.worktree, "Refused [skip ci]")).toBeUndefined()
    expect(await runner.push(snapshot, f.worktree, "vector/ve-abcdefghijkl")).toBe(false)
    expect(authentications).toBe(0)
    expect(await readFile(path.join(f.worktree, "README.md"), "utf8")).toBe("allowed\n")
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
