import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { ReadOnlyGit } from "../src/read-only-git"

// Every executable configured below belongs to this disposable fixture. It can only increment its counter and echo
// Git's input; no test touches a platform, credentials, an owner's checkout or the running application.
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((file) => fs.rm(file, { recursive: true, force: true })))
})
const local = process.platform === "linux" ? test : test.skip
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

async function fixture(attributes = "probe.txt filter=fixture\n") {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vector-readonly-fixture-")))
  temporary.push(base)
  const directory = path.join(base, "repository")
  await fs.mkdir(directory)
  const env = {
    PATH: process.env.PATH,
    HOME: base,
    XDG_CONFIG_HOME: base,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  }
  const git = (args: string[], cwd = directory) => promisify(execFile)("git", args, { cwd, env, timeout: 10_000 })
  await git(["init", "--quiet"])
  await git(["config", "core.autocrlf", "false"])
  await fs.writeFile(path.join(directory, ".gitattributes"), attributes)
  await fs.writeFile(path.join(directory, "probe.txt"), "saved contents\n")
  await git(["add", ".gitattributes", "probe.txt"])
  await git([
    "-c",
    "user.name=Vector Fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  ])
  const gitDirectory = path.join(directory, ".git")
  const counter = path.join(base, "counter")
  const script = path.join(base, "counter.cjs")
  await fs.writeFile(
    script,
    [
      'const fs = require("node:fs");',
      'fs.appendFileSync(process.argv[2], "call\\n");',
      "fs.writeFileSync(1, fs.readFileSync(0));",
      "",
    ].join("\n"),
  )
  const command = [process.execPath, script, counter].map(quote).join(" ")
  const input = { directory, gitDirectory, commonDirectory: gitDirectory }
  return {
    base,
    directory,
    gitDirectory,
    counter,
    command,
    git,
    input,
    calls: async () => (await fs.readFile(counter, "utf8").catch(() => "")).split("\n").filter(Boolean).length,
    changed: async (byte: string, seconds: number) => {
      const file = path.join(directory, "probe.txt")
      await fs.writeFile(file, byte.repeat(Buffer.byteLength("saved contents\n") - 1) + "\n")
      await fs.utimes(file, seconds, seconds)
    },
  }
}

local("private lifetime becomes closed synchronously and cannot be reset by its caller", async () => {
  const f = await fixture()
  const repository = await ReadOnlyGit.open(f.input)
  let closing: Promise<void> | undefined
  try {
    expect(repository.isOpen()).toBe(true)
    expect(Reflect.set(repository, "isOpen", () => true)).toBe(false)
    expect(Object.getOwnPropertyDescriptor(repository, "isOpen")).toMatchObject({
      writable: false,
      configurable: false,
    })
    closing = repository.close()
    expect(repository.isOpen()).toBe(false)
    await expect(repository.read({ kind: "status" })).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    await closing
    expect(repository.isOpen()).toBe(false)
    await repository.close()
    expect(repository.isOpen()).toBe(false)
  } finally {
    await (closing ?? repository.close())
  }
})

local.each(["clean", "process"])(
  "private status never executes an active %s filter or read-side programs",
  async (kind) => {
    const f = await fixture()
    expect((await ReadOnlyGit.inspect(f.input)).dirty).toBe(false)
    if (kind === "process") {
      const script = path.join(f.base, "process.cjs")
      await fs.writeFile(
        script,
        [
          'const fs = require("node:fs");',
          'fs.appendFileSync(process.argv[2], "start\\n");',
          "function read(n) { const b = Buffer.alloc(n); let p = 0; while(p < n) { const size = fs.readSync(0, b, p, n - p, null); if (!size) { if (!p) return; throw Error('short packet'); } p += size; } return b; }",
          "function packet() { const h = read(4); if (!h) return undefined; const n = parseInt(h.toString(), 16); return n === 0 ? null : read(n - 4); }",
          "function list() { const out = []; for (;;) { const p = packet(); if (p === undefined) return; if (p === null) return out; out.push(p); } }",
          "function write(b) { fs.writeSync(1, (b.length + 4).toString(16).padStart(4, '0')); fs.writeSync(1, b); }",
          "function flush() { fs.writeSync(1, '0000'); }",
          "if (!list()) process.exit(0); write(Buffer.from('git-filter-server\\n')); write(Buffer.from('version=2\\n')); flush();",
          "if (!list()) process.exit(0); write(Buffer.from('capability=clean\\n')); write(Buffer.from('capability=smudge\\n')); flush();",
          "while (list()) { const content = list(); if (!content) break; write(Buffer.from('status=success\\n')); flush(); for (const b of content) write(b); flush(); flush(); }",
          "",
        ].join("\n"),
      )
      await f.git(["config", "filter.fixture.process", [process.execPath, script, f.counter].map(quote).join(" ")])
    } else {
      await f.git(["config", "filter.fixture.clean", f.command])
    }
    await f.git(["config", "filter.fixture.required", "true"])
    await f.changed("C", 1_900_000_001)
    // This ordinary Git control proves the driver is effective; the next distinct mtime prevents a cached false pass.
    expect((await f.git(["-c", "core.fsmonitor=false", "status", "--porcelain"])).stdout).toContain("probe.txt")
    expect(await f.calls()).toBeGreaterThan(0)
    await fs.writeFile(f.counter, "")
    await f.changed("T", 1_900_000_111)
    await f.git(["config", "core.fsmonitor", f.command])
    await f.git(["config", "diff.external", f.command])
    await f.git(["config", "diff.fixture.command", f.command])
    await f.git(["config", "diff.fixture.textconv", f.command])
    await fs.appendFile(path.join(f.directory, ".gitattributes"), "probe.txt diff=fixture\n")
    const hooks = path.join(f.base, "hooks")
    await fs.mkdir(hooks)
    await fs.writeFile(path.join(hooks, "post-index-change"), `#!/bin/sh\nexec ${f.command}\n`, { mode: 0o700 })
    await f.git(["config", "core.hooksPath", hooks])
    const index = await fs.readFile(path.join(f.gitDirectory, "index"))
    const config = await fs.readFile(path.join(f.gitDirectory, "config"))
    const result = await ReadOnlyGit.inspect(f.input)
    expect(result.dirty).toBe(true)
    expect(await f.calls()).toBe(0)
    expect(await fs.readFile(path.join(f.gitDirectory, "index"))).toEqual(index)
    expect(await fs.readFile(path.join(f.gitDirectory, "config"))).toEqual(config)
  },
)

local("a driver installed after private config capture cannot cross into the read", async () => {
  const f = await fixture("probe.txt filter=latefixture\n")
  await f.changed("L", 1_900_000_123)
  // Many bounded copies publish enough asynchronous progress for a deterministic, observed capture barrier.
  const content = Buffer.alloc(4 * 1024 * 1024)
  let seed = 0x12345678
  for (let i = 0; i < content.length; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    content[i] = seed & 255
  }
  await fs.writeFile(path.join(f.directory, "large.bin"), content)
  await f.git(["add", "large.bin"])
  await f.git([
    "-c",
    "user.name=Vector Fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "--quiet",
    "-m",
    "copy barrier",
  ])
  const staging = path.join(f.base, "temporary")
  await fs.mkdir(staging)
  const previous = process.env.TMPDIR
  process.env.TMPDIR = staging
  const inspect = ReadOnlyGit.inspect(f.input)
  const installed = (async () => {
    const deadline = Date.now() + 5000
    for (;;) {
      const names = await fs.readdir(staging)
      const captured = (
        await Promise.all(
          names.map((name) =>
            fs.stat(path.join(staging, name, "git", "config")).then(
              () => true,
              () => false,
            ),
          ),
        )
      ).some(Boolean)
      if (captured) break
      if (Date.now() > deadline) throw new Error("The private-config capture barrier was not observed")
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    // Direct bounded append avoids consulting or refreshing any live index while the helper is in flight.
    await fs.appendFile(
      path.join(f.gitDirectory, "config"),
      `\n[filter "latefixture"]\nclean = ${f.command}\nrequired = true\n`,
    )
  })()
  try {
    const results = await Promise.allSettled([inspect, installed])
    for (const result of results) if (result.status === "rejected") throw result.reason
    const result = results[0]
    if (result.status !== "fulfilled") throw new Error("Private inspection did not complete")
    expect(result.value.dirty).toBe(true)
    expect(await f.calls()).toBe(0)
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
  await f.changed("P", 1_900_000_456)
  await f.git(["status", "--porcelain"])
  expect(await f.calls()).toBeGreaterThan(0)
})

local("linked worktrees preserve builtin EOL semantics and discard source index skip flags", async () => {
  const f = await fixture("probe.txt text eol=crlf\n")
  const linked = path.join(f.base, "linked")
  await f.git(["worktree", "add", "--quiet", "-b", "fixture-linked", linked])
  const gitDirectory = path.resolve(linked, (await f.git(["rev-parse", "--git-dir"], linked)).stdout.trim())
  const input = { directory: linked, gitDirectory, commonDirectory: f.gitDirectory }
  const index = await fs.readFile(path.join(gitDirectory, "index"))
  expect(await fs.readFile(path.join(linked, "probe.txt"), "utf8")).toBe("saved contents\r\n")
  expect((await ReadOnlyGit.inspect(input)).dirty).toBe(false)
  expect(await fs.readFile(path.join(gitDirectory, "index"))).toEqual(index)
  await f.git(["update-index", "--skip-worktree", "--", "probe.txt"], linked)
  await f.git(["update-index", "--assume-unchanged", "--", "probe.txt"], linked)
  await fs.writeFile(path.join(linked, "probe.txt"), "other contents\r\n")
  const skipped = await fs.readFile(path.join(gitDirectory, "index"))
  expect((await ReadOnlyGit.inspect(input)).dirty).toBe(true)
  expect(await fs.readFile(path.join(gitDirectory, "index"))).toEqual(skipped)
})

local("the scoped typed port covers review collection and refuses option-shaped authority", async () => {
  const f = await fixture()
  await f.git(["config", "filter.fixture.clean", f.command])
  await f.git(["config", "filter.fixture.required", "true"])
  await f.git(["config", "diff.external", f.command])
  await f.git(["config", "core.fsmonitor", f.command])
  const index = await fs.readFile(path.join(f.gitDirectory, "index"))
  const repository = await ReadOnlyGit.open(f.input)
  try {
    expect(repository.directory).toBe(f.directory)
    expect(repository.branch).toBeTruthy()
    expect((await repository.read({ kind: "resolve", revision: "HEAD" })).bytes.toString().trim()).toBe(repository.head)
    expect(
      (await repository.read({ kind: "merge-base", left: "HEAD", right: repository.head })).bytes.toString().trim(),
    ).toBe(repository.head)
    expect(
      (await repository.read({ kind: "object", action: "blob", revision: "HEAD", file: "probe.txt" })).bytes.toString(),
    ).toBe("saved contents\n")
    expect(
      (await repository.read({ kind: "object", action: "size", revision: "index", file: "probe.txt" })).bytes
        .toString()
        .trim(),
    ).toBe("15")
    expect(
      (await repository.read({ kind: "batch-files", revision: "HEAD", files: ["probe.txt"] })).bytes.toString(),
    ).toContain("saved contents")
    expect(
      (
        await repository.read({ kind: "grep", revision: "HEAD", symbol: "saved", excludes: ["**/ignored/**"] })
      ).bytes.toString(),
    ).toContain("probe.txt")
    expect((await repository.read({ kind: "history", revision: "HEAD", file: "probe.txt" })).code).toBe(0)
    expect(
      (
        await repository.read({ kind: "blame", revision: "HEAD", file: "probe.txt", first: 1, last: 1 })
      ).bytes.toString(),
    ).toContain("saved contents")
    expect((await repository.read({ kind: "tree", revision: "HEAD", file: "probe.txt" })).bytes.toString()).toContain(
      "probe.txt",
    )
    expect((await repository.read({ kind: "roots", revision: "HEAD" })).bytes.toString().trim()).toBe(repository.head)
    expect((await repository.read({ kind: "subjects", from: "HEAD", to: repository.head })).code).toBe(0)
    await f.changed("R", 1_900_000_888)
    expect((await repository.read({ kind: "diff", from: "HEAD" })).bytes.toString()).toContain("probe.txt")
    expect((await repository.read({ kind: "diff", from: "HEAD", names: true })).bytes.toString()).toContain("probe.txt")
    expect((await repository.read({ kind: "status", untracked: "no" })).bytes.toString()).toContain("probe.txt")
    await fs.writeFile(path.join(f.directory, "extra.txt"), "new untracked contents\n")
    expect((await repository.read({ kind: "untracked" })).bytes.toString()).toContain("extra.txt")
    expect((await repository.read({ kind: "added-diff", file: "extra.txt" })).bytes.toString()).toContain("b/extra.txt")
    await fs.writeFile(path.join(f.base, "outside.txt"), "PRIVATE-UNREACHABLE-BYTES")
    await fs.symlink(path.join(f.base, "outside.txt"), path.join(f.directory, "linked.txt"))
    await expect(repository.read({ kind: "added-diff", file: "linked.txt" })).rejects.toBeInstanceOf(
      ReadOnlyGit.Unavailable,
    )
    expect((await repository.status()).dirty).toBe(true)
    await expect(repository.read({ kind: "diff", from: "-c filter.fixture.clean=bad" })).rejects.toBeInstanceOf(
      ReadOnlyGit.Unavailable,
    )
    await expect(repository.read({ kind: "added-diff", file: "../counter" })).rejects.toBeInstanceOf(
      ReadOnlyGit.Unavailable,
    )
    await expect(
      repository.read({ kind: "object", action: "blob", revision: "HEAD", file: "../counter" }),
    ).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    await expect(
      repository.read({ kind: "command", args: ["log", "--output=../counter"] } as unknown as ReadOnlyGit.Read),
    ).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    expect(await f.calls()).toBe(0)
    expect(await fs.readFile(path.join(f.gitDirectory, "index"))).toEqual(index)
  } finally {
    await repository.close()
  }
  await expect(repository.read({ kind: "resolve", revision: "HEAD" })).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
})

local.each([
  "alternates",
  "include",
  "linked-object",
  "submodule",
  "split",
  "unknown-extension",
  "oversized-config",
  "sparse-config",
])("unsupported %s metadata fails without running a configured program", async (kind) => {
  const f = await fixture()
  await f.git(["config", "filter.fixture.clean", f.command])
  await f.git(["config", "filter.fixture.required", "true"])
  if (kind === "alternates")
    await fs.writeFile(path.join(f.gitDirectory, "objects", "info", "alternates"), f.base + "\n")
  if (kind === "include")
    await fs.appendFile(
      path.join(f.gitDirectory, "config"),
      `\n[include]\npath = ${quote(path.join(f.base, "never-read"))}\n`,
    )
  if (kind === "linked-object") {
    const existing = new Set(await fs.readdir(path.join(f.gitDirectory, "objects")))
    const unused = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0")).find(
      (name) => !existing.has(name),
    )
    if (!unused) throw new Error("Fixture has no unused loose-object directory")
    await fs.symlink(f.base, path.join(f.gitDirectory, "objects", unused))
  }
  if (kind === "submodule") {
    const oid = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
    await f.git(["update-index", "--add", "--cacheinfo", `160000,${oid},nested`])
  }
  if (kind === "split") await f.git(["update-index", "--split-index"])
  if (kind === "sparse-config") await f.git(["config", "core.sparseCheckout", "true"])
  if (kind === "unknown-extension")
    await fs.appendFile(path.join(f.gitDirectory, "config"), "\n[extensions]\nvectorUnknown = true\n")
  if (kind === "oversized-config")
    await fs.appendFile(path.join(f.gitDirectory, "config"), "\n#" + "x".repeat(64 * 1024))
  await fs.writeFile(f.counter, "")
  await expect(ReadOnlyGit.inspect(f.input)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
  expect(await f.calls()).toBe(0)
})

local("global and command-environment executable settings cannot enter private Git", async () => {
  const f = await fixture()
  await f.changed("E", 1_900_000_777)
  const global = path.join(f.base, "global-config")
  await fs.writeFile(
    global,
    `[filter "fixture"]\nclean = ${f.command}\nrequired = true\n[core]\nfsmonitor = ${f.command}\n`,
  )
  const keys = [
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_EXTERNAL_DIFF",
    "GIT_EXEC_PATH",
    "PATH",
  ]
  const previous = keys.map((key) => [key, process.env[key]] as const)
  const bin = path.join(f.base, "bin")
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\nexec ${f.command}\n`, { mode: 0o700 })
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: global,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "filter.fixture.clean",
    GIT_CONFIG_VALUE_0: f.command,
    GIT_EXTERNAL_DIFF: f.command,
    GIT_EXEC_PATH: f.base,
    PATH: bin + path.delimiter + process.env.PATH,
  })
  try {
    expect((await ReadOnlyGit.inspect(f.input)).dirty).toBe(true)
    expect(await f.calls()).toBe(0)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

local("a TMPDIR symlink alias into the repository refuses before any Git execution", async () => {
  const f = await fixture()
  await f.git(["config", "filter.fixture.clean", f.command])
  const destination = path.join(f.directory, "temporary")
  const alias = path.join(f.base, "temporary-alias")
  await fs.mkdir(destination)
  await fs.symlink(destination, alias)
  const previous = process.env.TMPDIR
  process.env.TMPDIR = alias
  try {
    await expect(ReadOnlyGit.inspect(f.input)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    expect(await fs.readdir(destination)).toEqual([])
    expect(await f.calls()).toBe(0)
  } finally {
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
})

local("metadata polling observes a primary binding without Git, index or object access", async () => {
  const f = await fixture()
  const expected = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
  await f.git(["config", "filter.fixture.clean", f.command])
  await f.git(["config", "core.fsmonitor", f.command])
  await fs.rename(path.join(f.gitDirectory, "index"), path.join(f.base, "saved-index"))
  await fs.rename(path.join(f.gitDirectory, "objects"), path.join(f.base, "saved-objects"))
  const bin = path.join(f.base, "fake-bin")
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\nexec ${f.command}\n`, { mode: 0o700 })
  const previous = process.env.PATH
  process.env.PATH = bin
  try {
    const metadata = await ReadOnlyGit.metadataHead(f.directory)
    const identity = await fs.stat(f.gitDirectory, { bigint: true })
    expect(metadata).toEqual({
      ...f.input,
      commonIdentity:
        identity.birthtimeNs > 0n && identity.birthtimeNs !== identity.ctimeNs
          ? { dev: identity.dev.toString(), ino: identity.ino.toString(), birth: identity.birthtimeNs.toString() }
          : undefined,
      head: expected,
      branch: (await fs.readFile(path.join(f.gitDirectory, "HEAD"), "utf8")).trim().slice(16),
      objectValidated: false,
    })
    expect(await f.calls()).toBe(0)
  } finally {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  }
})

local("metadata polling validates a real linked registration and packed branch reference", async () => {
  const f = await fixture()
  const linked = path.join(f.base, "linked-metadata")
  await f.git(["worktree", "add", "--quiet", "-b", "metadata-linked", linked])
  const gitDirectory = path.resolve(linked, (await f.git(["rev-parse", "--git-dir"], linked)).stdout.trim())
  await f.git(["pack-refs", "--all"])
  const metadata = await ReadOnlyGit.metadataHead(linked)
  expect(metadata.directory).toBe(linked)
  expect(metadata.gitDirectory).toBe(gitDirectory)
  expect(metadata.commonDirectory).toBe(f.gitDirectory)
  expect(metadata.commonIdentity).toEqual((await ReadOnlyGit.metadataHead(f.directory)).commonIdentity)
  expect(metadata.branch).toBe("metadata-linked")
  expect(metadata.head).toBe((await f.git(["rev-parse", "HEAD"], linked)).stdout.trim())
  expect(metadata.objectValidated).toBe(false)
  await fs.writeFile(path.join(gitDirectory, "gitdir"), path.join(f.directory, ".git") + "\n")
  await expect(ReadOnlyGit.metadataHead(linked)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
})

local(
  "pinned common-store identity survives ordinary writes but separates a physical clone with the same HEAD and remote",
  async () => {
    const f = await fixture()
    await f.git(["remote", "add", "origin", "https://example.invalid/vector/same.git"])
    const initial = await ReadOnlyGit.metadataHead(f.directory)
    await fs.writeFile(path.join(f.directory, "probe.txt"), "changed contents\n")
    await f.git(["add", "probe.txt"])
    await f.git([
      "-c",
      "user.name=Vector Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "--quiet",
      "-m",
      "next",
    ])
    const changed = await ReadOnlyGit.metadataHead(f.directory)
    expect(changed.head).not.toBe(initial.head)
    expect(changed.commonIdentity).toEqual(initial.commonIdentity)
    expect(Object.isFrozen(changed.commonIdentity)).toBe(true)
    const clone = path.join(f.base, "clone")
    await f.git(["clone", "--quiet", "--no-hardlinks", f.directory, clone])
    await f.git(["remote", "set-url", "origin", "https://example.invalid/vector/same.git"], clone)
    const copied = await ReadOnlyGit.metadataHead(clone)
    expect(copied.head).toBe(changed.head)
    expect(copied.commonIdentity).not.toEqual(changed.commonIdentity)
    expect((await f.git(["remote", "get-url", "origin"], clone)).stdout).toBe(
      (await f.git(["remote", "get-url", "origin"])).stdout,
    )
  },
)

local("a replacement store with identical paths and HEAD cannot acquire the old admission's identity", async () => {
  const f = await fixture()
  const original = await ReadOnlyGit.metadataHead(f.directory)
  expect(original.commonIdentity).toBeDefined()
  const saved = path.join(f.base, "original-store")
  await fs.rename(f.gitDirectory, saved)
  await fs.cp(saved, f.gitDirectory, { recursive: true })
  // A just-created directory can have indistinguishable birth/ctime. Evolve
  // real metadata with an ordinary write; never treat an unbound input as an
  // attested replacement or sleep until a heuristic happens to pass.
  await f.git(["config", "--local", "fixture.scopeIdentity", "replacement"])
  const replacement = await ReadOnlyGit.metadataHead(f.directory)
  expect(replacement.commonIdentity).toBeDefined()
  expect(replacement.head).toBe(original.head)
  expect(replacement.commonDirectory).toBe(original.commonDirectory)
  expect(replacement.commonIdentity).not.toEqual(original.commonIdentity)
  await expect(ReadOnlyGit.open(original)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
  expect(await f.calls()).toBe(0)
  const current = await ReadOnlyGit.open(replacement)
  try {
    expect(current.commonIdentity).toEqual(replacement.commonIdentity)
  } finally {
    await current.close()
  }
  await fs.rename(f.gitDirectory, path.join(f.base, "replacement-store"))
  await fs.rename(saved, f.gitDirectory)
  await expect(ReadOnlyGit.open(replacement)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
  const restored = await ReadOnlyGit.open(original)
  try {
    expect(restored.commonIdentity).toEqual(original.commonIdentity)
  } finally {
    await restored.close()
  }
})

local("a metadata HEAD observation cannot substitute for commit-object validation", async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.gitDirectory, "HEAD"), "0".repeat(40) + "\n")
  const metadata = await ReadOnlyGit.metadataHead(f.directory)
  expect(metadata.head).toBe("0".repeat(40))
  expect(metadata.branch).toBeUndefined()
  expect(metadata.objectValidated).toBe(false)
  await expect(ReadOnlyGit.open(metadata)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
})

local("full open rejects an existing blob whose SHA was observed in HEAD metadata", async () => {
  const f = await fixture()
  const blob = (await f.git(["hash-object", "probe.txt"])).stdout.trim()
  expect(blob).toMatch(/^[0-9a-f]{40}$/)
  await fs.writeFile(path.join(f.gitDirectory, "HEAD"), blob + "\n")
  const metadata = await ReadOnlyGit.metadataHead(f.directory)
  expect(metadata.head).toBe(blob)
  expect(metadata.objectValidated).toBe(false)
  await expect(ReadOnlyGit.open(metadata)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
})

local("metadata polling handles ordinary quoted configuration and validates worktree config redirection", async () => {
  const f = await fixture()
  await f.git(["config", "extensions.worktreeConfig", "true"])
  await fs.appendFile(path.join(f.gitDirectory, "config"), '\n[remote "fixture"]\nurl = "fixture; quoted # data"\n')
  await fs.writeFile(path.join(f.gitDirectory, "config.worktree"), '[core]\nworktree = ".."\nbare = false\n')
  expect((await ReadOnlyGit.metadataHead(f.directory)).objectValidated).toBe(false)
  await fs.appendFile(path.join(f.gitDirectory, "config.worktree"), `\n[core]\nworktree = ${JSON.stringify(f.base)}\n`)
  await expect(ReadOnlyGit.metadataHead(f.directory)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
})

local.each([
  "nested",
  "root-alias",
  "marker-symlink",
  "outside-marker",
  "malformed-marker",
  "config-symlink",
  "head-symlink",
  "reftable",
  "head-bound",
  "ref-bound",
  "packed-bound",
  "duplicate-packed",
  "malformed-config",
])("metadata polling refuses %s without unsafe discovery", async (kind) => {
  const f = await fixture()
  let root = f.directory
  const marker = path.join(root, ".git")
  if (kind === "nested") {
    root = path.join(root, "nested")
    await fs.mkdir(root)
  }
  if (kind === "root-alias") {
    root = path.join(f.base, "alias")
    await fs.symlink(f.directory, root)
  }
  if (kind === "marker-symlink" || kind === "outside-marker" || kind === "malformed-marker") {
    const moved = path.join(f.base, "primary-git")
    await fs.rename(marker, moved)
    if (kind === "marker-symlink") await fs.symlink(moved, marker)
    if (kind === "outside-marker") await fs.writeFile(marker, `gitdir: ${moved}\n`)
    if (kind === "malformed-marker") await fs.writeFile(marker, `gitdir: ${moved}\nsecond indirection\n`)
  }
  if (kind === "config-symlink" || kind === "head-symlink") {
    const name = kind === "config-symlink" ? "config" : "HEAD"
    const moved = path.join(f.base, "saved-" + name)
    await fs.rename(path.join(marker, name), moved)
    await fs.symlink(moved, path.join(marker, name))
  }
  if (kind === "reftable") await fs.appendFile(path.join(marker, "config"), '\n[extensions]\nrefStorage = "reftable"\n')
  if (kind === "head-bound") await fs.writeFile(path.join(marker, "HEAD"), "ref: refs/heads/" + "a".repeat(4096) + "\n")
  if (kind === "ref-bound")
    await fs.writeFile(path.join(marker, "HEAD"), "ref: refs/heads/" + "a/".repeat(65) + "leaf\n")
  if (kind === "packed-bound") {
    await fs.writeFile(path.join(marker, "HEAD"), "ref: refs/heads/missing\n")
    await fs.writeFile(path.join(marker, "packed-refs"), "#" + "x".repeat(4 * 1024 * 1024))
  }
  if (kind === "duplicate-packed") {
    const reference = (await fs.readFile(path.join(marker, "HEAD"), "utf8")).trim().slice(5)
    const oid = (await fs.readFile(path.join(marker, reference), "utf8")).trim()
    await fs.rm(path.join(marker, reference))
    await fs.writeFile(path.join(marker, "packed-refs"), `${oid} ${reference}\n${oid} ${reference}\n`)
  }
  if (kind === "malformed-config")
    await fs.appendFile(path.join(marker, "config"), '\n[remote "broken"]\nurl = "unterminated\n')
  await expect(ReadOnlyGit.metadataHead(root)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
  expect(await f.calls()).toBe(0)
})

local.each(["commondir-outside", "commondir-symlink", "backpointer-symlink", "backpointer-alias"])(
  "linked metadata refuses %s bindings",
  async (kind) => {
    const f = await fixture()
    const linked = path.join(f.base, "linked-invalid")
    await f.git(["worktree", "add", "--quiet", "-b", "metadata-invalid", linked])
    const gitDirectory = path.resolve(linked, (await f.git(["rev-parse", "--git-dir"], linked)).stdout.trim())
    if (kind === "commondir-outside") await fs.writeFile(path.join(gitDirectory, "commondir"), f.base + "\n")
    if (kind === "backpointer-alias") {
      await fs.mkdir(path.join(linked, "nested"))
      await fs.writeFile(path.join(gitDirectory, "gitdir"), linked + "/nested/../.git\n")
    }
    if (kind === "commondir-symlink" || kind === "backpointer-symlink") {
      const name = kind === "commondir-symlink" ? "commondir" : "gitdir"
      const moved = path.join(f.base, "saved-" + name)
      await fs.rename(path.join(gitDirectory, name), moved)
      await fs.symlink(moved, path.join(gitDirectory, name))
    }
    await expect(ReadOnlyGit.metadataHead(linked)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    expect(await f.calls()).toBe(0)
  },
)

local.each(["marker", "config", "HEAD", "ref"])("metadata FIFO %s refuses without a blocking open", async (kind) => {
  const f = await fixture()
  const reference = (await fs.readFile(path.join(f.gitDirectory, "HEAD"), "utf8")).trim().slice(5)
  const target = kind === "marker" ? f.gitDirectory : path.join(f.gitDirectory, kind === "ref" ? reference : kind)
  await fs.rename(target, path.join(f.base, "saved-fifo-target"))
  await promisify(execFile)("mkfifo", [target], { timeout: 5000 })
  await expect(ReadOnlyGit.metadataHead(f.directory)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
  expect(await f.calls()).toBe(0)
})

test.skipIf(process.platform === "linux")(
  "hosts without a pinned-directory adapter refuse before Git starts",
  async () => {
    await expect(
      ReadOnlyGit.inspect({ directory: "/unread", gitDirectory: "/unread", commonDirectory: "/unread" }),
    ).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
  },
)
