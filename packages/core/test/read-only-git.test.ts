import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { deflateSync, inflateSync } from "node:zlib"
import { DirectoryIdentityReader } from "../src/directory-identity"
import { ReadOnlyGit } from "../src/read-only-git"

// Repository-configured executables belong to the disposable fixture and only count/echo Git input.
// Actual Git/runtime/resource controls are CI-only; no test touches credentials or an owner's checkout.
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((file) => fs.rm(file, { recursive: true, force: true })))
})
const local = process.platform === "linux" ? test : test.skip
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

const usage = (references: boolean) =>
  Buffer.from(
    [
      "usage: git fsck [--strict] [--full] [--cache]",
      "    --[no-]strict        enable strict checking",
      "    --[no-]full          consider all object storage",
      "    --[no-]cache         include index roots",
      "    --no-reflogs         omit reflog roots",
      "    --no-dangling        omit dangling notices",
      "    --no-progress        omit progress",
      "    --no-name-objects    omit object names",
      ...(references ? ["    --[no-]references    check the references database"] : []),
      "",
    ].join("\n"),
  )
test("fsck supports only known versions with matching advertised full graph and reference capabilities", () => {
  for (const version of ["2.43.0", "2.49.1"])
    expect(ReadOnlyGit.fsckProfile(Buffer.from(`git version ${version}\n`), usage(false))).toEqual({
      references: false,
    })
  for (const version of ["2.50.0", "2.56.0", "2.56.1"])
    expect(ReadOnlyGit.fsckProfile(Buffer.from(`git version ${version}\n`), usage(true))).toEqual({ references: true })
  for (const version of ["2.42.0", "2.57.0", "3.0.0", "2.56.1.vendor", "2.056.1", "2.56.1\nextra"])
    expect(() => ReadOnlyGit.fsckProfile(Buffer.from(`git version ${version}\n`), usage(true))).toThrow(
      ReadOnlyGit.Unavailable,
    )
  expect(() => ReadOnlyGit.fsckProfile(Buffer.from("git version 2.43.0\n"), usage(true))).toThrow(
    ReadOnlyGit.Unavailable,
  )
  expect(() => ReadOnlyGit.fsckProfile(Buffer.from("git version 2.56.1\n"), usage(false))).toThrow(
    ReadOnlyGit.Unavailable,
  )
  for (const option of ["strict", "full", "cache", "no-reflogs", "no-dangling", "no-progress", "no-name-objects"]) {
    const help = Buffer.from(
      usage(true)
        .toString()
        .split("\n")
        .filter((line) => !line.startsWith(`    --${option} `) && !line.startsWith(`    --[no-]${option} `))
        .join("\n"),
    )
    expect(() => ReadOnlyGit.fsckProfile(Buffer.from("git version 2.56.1\n"), help)).toThrow(ReadOnlyGit.Unavailable)
  }
  expect(() => ReadOnlyGit.fsckProfile(Buffer.from("git version 2.56.1\n"), Buffer.alloc(16385))).toThrow(
    ReadOnlyGit.Unavailable,
  )
})
test("skipping a separate ref database verifier requires an empty private detached reference shape", () => {
  const head = "a".repeat(40)
  const refs: string[] = []
  const snapshot = { head: Buffer.from(head + "\n"), refs, packed: false, reftable: false }
  expect(() => ReadOnlyGit.privateRefShape(snapshot, head)).not.toThrow()
  for (const change of [
    { refs: ["heads"] },
    { packed: true },
    { reftable: true },
    { head: Buffer.from("ref: refs/heads/main\n") },
    { head: Buffer.from("b".repeat(40) + "\n") },
  ])
    expect(() => ReadOnlyGit.privateRefShape({ ...snapshot, ...change }, head)).toThrow(ReadOnlyGit.Unavailable)
})
test("private native diagnostics recognize only exact content-free error classes", () => {
  expect(ReadOnlyGit.commandReason("error: cannot fork() for refs: Resource temporarily unavailable")).toBe("refs-fork")
  expect(ReadOnlyGit.commandReason("error: unknown option `no-references'")).toBe("unsupported-argument")
  for (const value of [
    "error: private/path contains body",
    "12 | error: cannot fork() for refs: Resource temporarily unavailable",
    "OWNER_PRIVATE_SNIPPET",
  ])
    expect(ReadOnlyGit.commandReason(value)).toBe("Unknown")
})

test("object manifest bounds each expanded object, total bytes and actual object count", () => {
  const line = (id: number, size = 1) => `${id.toString(16).padStart(40, "0")} blob ${size}\n`
  expect(ReadOnlyGit.objectManifest(Buffer.from(line(1) + line(2, 2)))).toEqual({ objects: 2, bytes: 3 })
  for (const value of [
    "",
    line(1).trimEnd(),
    line(1) + line(1),
    line(1, ReadOnlyGit.INTEGRITY.objectBytes + 1),
    line(1).replace("blob", "unknown"),
    line(1).replace("blob 1", "blob 01"),
    line(1).replace("blob 1", "blob -1"),
    line(1).replace("blob 1", "blob 999999999999999"),
    Array.from({ length: 17 }, (_, id) => line(id, ReadOnlyGit.INTEGRITY.objectBytes)).join(""),
    Array.from({ length: ReadOnlyGit.INTEGRITY.objects + 1 }, (_, id) => line(id)).join(""),
  ])
    expect(() => ReadOnlyGit.objectManifest(Buffer.from(value))).toThrow(ReadOnlyGit.Unavailable)
})

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
    raw: (args: string[]) =>
      promisify(execFile)("git", args, { cwd: directory, env, timeout: 10_000, encoding: "buffer" }),
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

local.each(["commit", "tree", "blob"])("forged named loose %s bytes never reach a private consumer", async (kind) => {
  const f = await fixture()
  const revision = kind === "commit" ? "HEAD" : kind === "tree" ? "HEAD^{tree}" : "HEAD:probe.txt"
  const oid = (await f.git(["rev-parse", revision])).stdout.trim()
  const object = path.join(f.gitDirectory, "objects", oid.slice(0, 2), oid.slice(2))
  const original = inflateSync(await fs.readFile(object))
  const boundary = original.indexOf(0)
  expect(boundary).toBeGreaterThan(0)
  const body = Buffer.from(original.subarray(boundary + 1))
  if (kind === "tree") {
    const name = body.indexOf(Buffer.from("probe.txt"))
    expect(name).toBeGreaterThanOrEqual(0)
    body[name] = "q".charCodeAt(0)
  } else body[body.length - 2] = body[body.length - 2] === 120 ? 121 : 120
  const forged = Buffer.concat([Buffer.from(`${kind} ${body.length}\0`), body])
  expect(forged.equals(original)).toBe(false)
  // The fixture owner may corrupt only this disposable Git-created object.
  await fs.chmod(object, 0o600)
  await fs.writeFile(object, deflateSync(forged))
  // Ordinary Git type/size reads accept the path's claimed identity. Our gate must authenticate the whole chain.
  expect((await f.git(["cat-file", "-t", oid])).stdout.trim()).toBe(kind)
  expect((await f.git(["cat-file", "-s", oid])).stdout.trim()).toBe(String(body.length))
  expect((await f.raw(["cat-file", kind, oid])).stdout).toEqual(body)
  const refused = await ReadOnlyGit.open(f.input).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(ReadOnlyGit.Unavailable)
  if (!(refused instanceof ReadOnlyGit.Unavailable)) throw new Error("Forged object reached a consumer")
  const diagnostic = refused.cause
  expect(Object.isFrozen(diagnostic)).toBe(true)
  if (!diagnostic || typeof diagnostic !== "object") throw new Error("Missing bounded integrity diagnostic")
  expect(Object.keys(diagnostic).sort()).toEqual(["command", "exit", "reason", "signal", "stderr", "stdout"])
  expect("command" in diagnostic && diagnostic.command).toBe("integrity")
  expect("exit" in diagnostic && typeof diagnostic.exit === "number" && diagnostic.exit > 0).toBe(true)
  for (const privateValue of [f.directory, f.gitDirectory, oid, body.toString("hex")])
    expect(JSON.stringify(diagnostic)).not.toContain(privateValue)
  expect(await f.calls()).toBe(0)
})

local("packed corruption refuses while a clean private packed graph preserves exact content", async () => {
  const f = await fixture()
  await f.git(["gc", "--prune=now", "--quiet"])
  const repository = await ReadOnlyGit.open(f.input)
  try {
    expect(
      (await repository.read({ kind: "object", action: "blob", revision: "HEAD", file: "probe.txt" })).bytes,
    ).toEqual(Buffer.from("saved contents\n"))
  } finally {
    await repository.close()
  }
  const packs = (await fs.readdir(path.join(f.gitDirectory, "objects/pack"))).filter((name) => name.endsWith(".pack"))
  expect(packs.length).toBe(1)
  const pack = path.join(f.gitDirectory, "objects/pack", packs[0]!)
  const bytes = await fs.readFile(pack)
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
  await fs.chmod(pack, 0o600)
  await fs.writeFile(pack, bytes)
  await expect(ReadOnlyGit.open(f.input)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
})

local("declared loose-object allocation amplification refuses within the limited verifier", async () => {
  const f = await fixture()
  const positive = await ReadOnlyGit.open(f.input)
  await positive.close()
  const oid = "f".repeat(40)
  const directory = path.join(f.gitDirectory, "objects", oid.slice(0, 2))
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, oid.slice(2)), deflateSync(Buffer.from("tree 1099511627776\0x")))
  await expect(ReadOnlyGit.open(f.input)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
  // A failed verifier releases its bounded engine admission and leaves the owner checkout intact.
  await fs.rm(path.join(directory, oid.slice(2)))
  const repository = await ReadOnlyGit.open(f.input)
  await repository.close()
  expect((await f.git(["status", "--porcelain"])).stdout).toBe("")
})

local("a genuine local shallow boundary preserves readable head content without fetching parents", async () => {
  const f = await fixture()
  await f.git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "Second fixture head",
  ])
  const directory = path.join(f.base, "shallow")
  await f.git(["clone", "--quiet", "--depth=1", `file://${f.directory}`, directory], f.base)
  const repository = await ReadOnlyGit.open({
    directory,
    gitDirectory: path.join(directory, ".git"),
    commonDirectory: path.join(directory, ".git"),
  })
  try {
    expect(repository.shallow).toBe(true)
    expect(
      (await repository.read({ kind: "object", action: "blob", revision: "HEAD", file: "probe.txt" })).bytes,
    ).toEqual(Buffer.from("saved contents\n"))
  } finally {
    await repository.close()
  }
})

local("a missing ordinary parent is never treated as an inferred shallow boundary", async () => {
  const f = await fixture()
  const parent = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
  await f.git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "Second fixture head",
  ])
  await fs.rm(path.join(f.gitDirectory, "objects", parent.slice(0, 2), parent.slice(2)))
  await expect(ReadOnlyGit.open(f.input)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
})

local("a partial-clone configuration cannot permit promised missing objects or lazy fetch", async () => {
  const f = await fixture()
  await f.git(["config", "core.repositoryformatversion", "1"])
  await f.git(["config", "extensions.partialClone", "fixture-no-network"])
  await expect(ReadOnlyGit.open(f.input)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
  expect(await f.calls()).toBe(0)
})

const integrityCI = test.skipIf(process.env.VECTOR_READONLY_GIT_INTEGRITY_CI !== "1" || process.platform !== "linux")

integrityCI(
  "modern reference verification forks are refused while full detached-object verification stays mandatory",
  async () => {
    const f = await fixture()
    const head = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
    await fs.writeFile(path.join(f.gitDirectory, "HEAD"), head + "\n")
    await fs.rm(path.join(f.gitDirectory, "refs"), { recursive: true })
    await fs.mkdir(path.join(f.gitDirectory, "refs"))
    const image = await DirectoryIdentityReader.pythonImage(performance.now() + 10000)
    if (!image) throw new Error("Missing actual fixed runtime proof")
    const run = async (args: string[]) => {
      expect(await image.validate(performance.now() + 10000)).toBe(true)
      expect(image.isOpen()).toBe(true)
      return new Promise<{ code: number; bytes: Buffer; known: string }>((resolve, reject) => {
        const output: Buffer[] = [],
          error: Buffer[] = []
        let failed = false,
          size = 0
        const child = spawn(
          DirectoryIdentityReader.PYTHON,
          ["-I", "-S", "-c", ReadOnlyGit.PROCESS_SOURCE, "/usr/bin/git", ...args],
          {
            cwd: f.base,
            env: {
              PATH: "/usr/bin:/bin",
              HOME: f.base,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: os.devNull,
              LC_ALL: "C",
            },
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
          },
        )
        child.once("error", () => {
          failed = true
        })
        child.once("close", (code, killed) => {
          clearTimeout(timer)
          if (failed || killed || code === null) {
            reject(new Error("Actual fixed verifier child failed"))
            return
          }
          const known =
            Buffer.concat(error)
              .toString()
              .split(/\r?\n/)
              .map(ReadOnlyGit.commandReason)
              .find((value) => value !== "Unknown") ?? "Unknown"
          resolve({ code, bytes: Buffer.concat(output), known })
        })
        const timer = setTimeout(() => {
          failed = true
          child.kill("SIGKILL")
        }, 10000)
        const collect = (sink: Buffer[], chunk: Buffer) => {
          size += chunk.length
          if (size > 16384) {
            failed = true
            child.kill("SIGKILL")
            return
          }
          sink.push(chunk)
        }
        child.stdout?.on("data", (chunk: Buffer) => collect(output, chunk))
        child.stderr?.on("data", (chunk: Buffer) => collect(error, chunk))
        if (!child.stdout || !child.stderr) {
          failed = true
          child.kill("SIGKILL")
        }
      })
    }
    try {
      const base = [
        "--no-pager",
        `--git-dir=${f.gitDirectory}`,
        `--work-tree=${f.directory}`,
        "-c",
        "core.commitGraph=false",
        "-c",
        "core.multiPackIndex=false",
      ]
      const version = await run(["--version"])
      expect(version.code).toBe(0)
      const help = await run([...base, "fsck", "-h"])
      expect([0, 129]).toContain(help.code)
      const profile = ReadOnlyGit.fsckProfile(version.bytes, help.bytes)
      const full = [
        ...base,
        "fsck",
        "--strict",
        "--full",
        "--cache",
        "--no-reflogs",
        "--no-dangling",
        "--no-progress",
        "--no-name-objects",
      ]
      const normal = await run(full)
      if (profile.references) {
        expect(normal.code).toBe(8)
        expect(normal.known).toBe("refs-fork")
      } else expect(normal.code).toBe(0)
      const verified = await run([...full, ...(profile.references ? ["--no-references"] : [])])
      expect(verified.code).toBe(0)
      const repository = await ReadOnlyGit.open(f.input)
      try {
        expect(
          (await repository.read({ kind: "object", action: "blob", revision: "HEAD", file: "probe.txt" })).bytes,
        ).toEqual(Buffer.from("saved contents\n"))
      } finally {
        await repository.close()
      }
    } finally {
      image.close()
    }
  },
  30000,
)

integrityCI.each(["loose", "packed", "reftable", "head"])(
  "unsupported private %s reference data refuses before a consumer",
  async (kind) => {
    const f = await fixture()
    const head = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
    const prefix = path.join(await fs.realpath(os.tmpdir()), "vector-readonly-git-")
    const original = fs.opendir
    let injected = false
    fs.opendir = async (...args) => {
      const directory = await fs.realpath(args[0])
      if (!injected && directory.startsWith(prefix) && directory.endsWith(path.join("git", "refs"))) {
        injected = true
        if (kind === "loose") await fs.writeFile(path.join(directory, "unexpected"), head + "\n")
        if (kind === "packed")
          await fs.writeFile(path.join(path.dirname(directory), "packed-refs"), head + " refs/heads/unexpected\n")
        if (kind === "reftable") await fs.mkdir(path.join(path.dirname(directory), "reftable"))
        if (kind === "head")
          await fs.writeFile(path.join(path.dirname(directory), "HEAD"), "ref: refs/heads/unexpected\n")
      }
      return original(...args)
    }
    try {
      await expect(ReadOnlyGit.open(f.input)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
      expect(injected).toBe(true)
    } finally {
      fs.opendir = original
    }
  },
  30000,
)

function signal() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function bounded<A>(promise: Promise<A>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

integrityCI.each(["close", "cancel"])(
  "%s joins the actual held copy before disposing private storage",
  async (kind) => {
    const f = await fixture()
    const controller = new AbortController()
    const repository = await ReadOnlyGit.open(f.input, { signal: controller.signal })
    const target = path.join(f.directory, "new", "untracked.txt")
    await fs.mkdir(path.dirname(target))
    await fs.writeFile(target, "actual bounded copy\n")
    const identity = await fs.stat(target, { bigint: true })
    const prefix = path.join(await fs.realpath(os.tmpdir()), "vector-readonly-git-")
    const entered = signal(),
      proceed = signal(),
      joined = signal()
    const events: string[] = []
    const originalOpen = fs.open,
      originalRm = fs.rm
    let temporary: string | undefined
    let closing: Promise<void> | undefined
    // Only actual handles for this unique disposable source are wrapped. All reads/bytes/authority are genuine.
    fs.open = async (...args) => {
      const handle = await originalOpen(...args)
      try {
        const info = await handle.stat({ bigint: true })
        if (typeof args[0] === "string" && args[0].startsWith(prefix))
          temporary = prefix + args[0].slice(prefix.length).split(path.sep)[0]
        if (info.dev === identity.dev && info.ino === identity.ino) {
          const read = handle.read.bind(handle),
            close = handle.close.bind(handle)
          Object.defineProperty(handle, "read", {
            value: async (buffer: Buffer, offset: number, length: number, position: number) => {
              const result = await read(buffer, offset, length, position)
              events.push("actual-read")
              entered.resolve()
              await proceed.promise
              events.push("released-read")
              return result
            },
          })
          Object.defineProperty(handle, "close", {
            value: async () => {
              await close()
              events.push("source-handle-closed")
            },
          })
        }
        return handle
      } catch (error) {
        await handle.close()
        throw error
      }
    }
    fs.rm = async (...args) => {
      if (args[0] === temporary) events.push("storage-disposal")
      return originalRm(...args)
    }
    try {
      const pending = repository.read({ kind: "added-diff", file: "new/untracked.txt" })
      const outcome = pending.then(
        () => {
          events.push("read-settled")
          return undefined
        },
        (error: unknown) => {
          events.push("read-settled")
          return error
        },
      )
      await bounded(entered.promise, "Actual copy did not reach its held pread")
      const nativeThen = pending.then
      // Observe the real Promise.allSettled ownership edge, not a timed !isDone/scheduler guess.
      Object.defineProperty(pending, "then", {
        configurable: true,
        value: function <TResult1 = Awaited<typeof pending>, TResult2 = never>(
          fulfilled?: ((value: Awaited<typeof pending>) => TResult1 | PromiseLike<TResult1>) | null,
          rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): Promise<TResult1 | TResult2> {
          Object.defineProperty(pending, "then", { configurable: true, value: nativeThen })
          joined.resolve()
          return pending.then<TResult1, TResult2>(fulfilled, rejected)
        },
      })
      if (kind === "cancel") {
        controller.abort()
        expect(repository.isOpen()).toBe(false)
      }
      closing = repository.close().then(() => {
        events.push("close-settled")
      })
      expect(repository.isOpen()).toBe(false)
      await bounded(joined.promise, "Close did not join the actual whole-copy promise")
      if (!temporary) throw new Error("Actual copy never acquired private storage")
      expect((await fs.stat(temporary)).isDirectory()).toBe(true)
      proceed.resolve()
      expect(await bounded(outcome, "Cancelled actual copy did not settle")).toBeInstanceOf(ReadOnlyGit.Unavailable)
      await bounded(closing, "Close did not finish after the actual copy finalized")
      expect(events.indexOf("source-handle-closed")).toBeLessThan(events.indexOf("read-settled"))
      expect(events.indexOf("read-settled")).toBeLessThan(events.indexOf("storage-disposal"))
      expect(events.indexOf("storage-disposal")).toBeLessThan(events.indexOf("close-settled"))
      await expect(fs.stat(temporary)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(
        repository.read({ kind: "object", action: "size", revision: "HEAD", file: "probe.txt" }),
      ).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    } finally {
      proceed.resolve()
      fs.open = originalOpen
      fs.rm = originalRm
      await (closing ?? repository.close())
      if (temporary) await originalRm(temporary, { recursive: true, force: true })
    }
  },
  30_000,
)

integrityCI(
  "the fixed launcher proves no-fork limits, closes high FDs and refuses root identity",
  async () => {
    const image = await DirectoryIdentityReader.pythonImage(performance.now() + 10_000)
    expect(image).toBeDefined()
    if (!image) throw new Error("Missing actual fixed runtime image")
    try {
      expect(await image.validate(performance.now() + 10_000)).toBe(true)
      const high = await fs.open(os.devNull, "r")
      const stdio: ("ignore" | "pipe" | number)[] = ["ignore", "pipe", "ignore"]
      while (stdio.length < 1024) stdio.push("ignore")
      stdio.push(high.fd)
      const run = (args: string[]) =>
        new Promise<{ code: number | null; bytes: Buffer }>((resolve, reject) => {
          const child = spawn(DirectoryIdentityReader.PYTHON, args, {
            env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
            stdio,
            shell: false,
          })
          if (!child.stdout) throw new Error("Missing actual launcher stdout")
          const output: Buffer[] = []
          child.stdout.on("data", (chunk: Buffer) => output.push(chunk))
          const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
          let failed = false
          child.once("error", () => {
            failed = true
          })
          child.once("close", (code) => {
            clearTimeout(timer)
            if (failed) reject(new Error("Actual launcher child could not start"))
            else resolve({ code, bytes: Buffer.concat(output) })
          })
        })
      try {
        // First prove the same high descriptor mapping really reaches an ordinary trusted child.
        const positive = await run(["-I", "-S", "-c", "import os; os.fstat(1024); os.write(1,b'inherited\\n')"])
        expect(positive).toEqual({ code: 0, bytes: Buffer.from("inherited\n") })
        const result = await run([
          "-I",
          "-S",
          "-c",
          ReadOnlyGit.PROCESS_SOURCE,
          DirectoryIdentityReader.PYTHON,
          "-I",
          "-S",
          "-c",
          String.raw`import os, ctypes
libc=ctypes.CDLL(None, use_errno=True)
class Limit(ctypes.Structure):
    _fields_=[("soft",ctypes.c_ulong),("hard",ctypes.c_ulong)]
for key,value in ((9,536870912),(0,8),(4,0),(7,64),(6,0)):
    r=Limit()
    assert libc.getrlimit(key,ctypes.byref(r))==0 and r.soft==value and r.hard==value
assert libc.prctl(39,0,0,0,0)==1
try:
    bytearray(1073741824)
    os._exit(4)
except MemoryError:
    pass
try:
    os.fstat(1024)
    os._exit(2)
except OSError:
    pass
try:
    os.fork()
    os._exit(3)
except OSError as e:
    assert e.errno==11
os.write(1,b"bounded\n")
`,
        ])
        if (process.getuid?.() === 0) expect(result).toEqual({ code: 125, bytes: Buffer.alloc(0) })
        else expect(result).toEqual({ code: 0, bytes: Buffer.from("bounded\n") })
      } finally {
        await high.close()
      }
    } finally {
      image.close()
    }
  },
  30_000,
)

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
    const grep = await repository.read({ kind: "grep", revision: "HEAD", symbol: "saved", excludes: ["**/ignored/**"] })
    expect(grep.code).toBe(0)
    expect(grep.bytes.toString()).toContain("probe.txt")
    expect(grep.bytes.toString()).toContain("saved contents")
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
