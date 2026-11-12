import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"
import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
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
    expect(await runner.mapped()).toBe(true)
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
    expect(await runner.mapped()).toBe(false)
    git("remote", "add", "origin", "https://github.com/acme/other.git")
    expect(await runner.mapped()).toBe(false)
    git("remote", "set-url", "origin", "https://github.com.evil.invalid/acme/app.git")
    expect(await runner.mapped()).toBe(false)
    git("remote", "set-url", "origin", "ssh://git@github.com/ACME/APP.git")
    expect(await runner.mapped()).toBe(true)
    git("config", "include.path", "ignored-fixture-config")
    expect(await runner.mapped()).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("network git uses a canonical URL and job-specific ref rather than shared FETCH_HEAD", async () => {
  const calls: readonly string[][] = []
  const mutable = calls as string[][]
  const runner = createEverywhereGit({ directory: os.tmpdir(), repository: "acme/app", identity: { name: "Fixture", email: "fixture@example.invalid" },
    execute: async ({ args }) => { mutable.push([...args]); return args.includes("rev-parse") ? "a".repeat(40) : "" } })
  const snapshot = { config: [], pushUrl: "https://github.com/acme/app.git", baseSha: "a".repeat(40) }
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
