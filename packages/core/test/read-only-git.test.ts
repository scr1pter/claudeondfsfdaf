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
// The port's path rule, which a caller checks before asking for a path-scoped read (ReviewGit.ignoredPaths, SF-13b).
test("repositoryPath accepts only plain repository-relative paths", () => {
  for (const file of ["probe.txt", "src/a b.ts", ":colon", "-v", "é.local.json", "a\tb", 'q"uote', "x".repeat(4096)])
    expect(ReadOnlyGit.repositoryPath(file)).toBe(true)
  for (const file of [
    "",
    "/abs",
    "a\\b",
    "../x",
    "a/../b",
    "./a",
    "a//b",
    "a/",
    ".git/config",
    "sub/.GIT/x",
    "a\rb",
    "a\nb",
    "a\u0000b",
    "x".repeat(4097),
  ])
    expect(ReadOnlyGit.repositoryPath(file)).toBe(false)
})

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
    // VS-34 item 4 (SF-13b): the work tree's ignore rules, index or not, each path echoed as given ("./" keeps a leading
    // ":" a path, as check-ignore takes no pathspec magic); a path none ignores exits 1.
    await fs.writeFile(path.join(f.directory, ".gitignore"), "*.local.json\n")
    const ignored = await repository.read({
      kind: "check-ignore",
      files: ["config.local.json", "probe.txt", ":colon.local.json"],
    })
    expect(ignored.code).toBe(0)
    expect(ignored.bytes.toString()).toBe("./config.local.json\n./:colon.local.json\n")
    expect(await repository.read({ kind: "check-ignore", files: ["probe.txt"] })).toEqual({
      code: 1,
      bytes: Buffer.alloc(0),
    })
    // An option-shaped name is a path after "--" and "./".
    expect((await repository.read({ kind: "check-ignore", files: ["--stdin"] })).code).toBe(1)
    for (const files of [["../counter"], [], Array.from({ length: 1025 }, (_, index) => `f${index}.txt`)])
      await expect(repository.read({ kind: "check-ignore", files })).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
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

// Fixture commits and annotated tags name an identity on the command line; no user configuration is read.
const author = ["-c", "user.name=Vector Fixture", "-c", "user.email=fixture@invalid"]
const unset = { code: 1, bytes: Buffer.alloc(0) }
const refusal = (pending: Promise<unknown>) =>
  pending.then(
    () => "answered",
    (error: unknown) => (error instanceof ReadOnlyGit.Unavailable ? error.reason : "not a refusal"),
  )
// A repository-configured program counts a call if any private read reached the live configuration.
async function guarded(f: Awaited<ReturnType<typeof fixture>>) {
  await f.git(["config", "filter.fixture.clean", f.command])
  await f.git(["config", "filter.fixture.required", "true"])
  await f.git(["config", "core.fsmonitor", f.command])
  await fs.writeFile(f.counter, "")
}
// A fixture Git step during a view first proves no private read counted a call, then clears its own calls.
async function liveGit(f: Awaited<ReturnType<typeof fixture>>, args: string[]) {
  expect(await f.calls()).toBe(0)
  const result = await f.git(args)
  await fs.writeFile(f.counter, "")
  return result
}

local(
  "impact reads committed trees, literal import paths and word matches within each requested output cap",
  async () => {
    const f = await fixture("*.ts diff=fixture\n")
    await fs.mkdir(path.join(f.directory, "src"))
    const importer = "src/[x].ts"
    await fs.writeFile(path.join(f.directory, importer), 'import { Needle } from "./dep"\nconst joinedNeedle = 1\n')
    await fs.writeFile(path.join(f.directory, "src", "other.ts"), "export const Needle = 1\n")
    await fs.writeFile(path.join(f.directory, "package.json"), '{"name":"pinned"}\n')
    await f.git(["add", "--all"])
    await f.git([...author, "commit", "-qm", "impact sources"])
    const reviewed = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
    await f.git(["checkout", "-q", "--detach", "HEAD^"])
    await fs.mkdir(path.join(f.directory, "src"), { recursive: true })
    await fs.writeFile(path.join(f.directory, importer), "export const LiveOnly = 3\n")
    await fs.writeFile(path.join(f.directory, "package.json"), '{"name":"live"}\n')
    await f.git(["config", "diff.fixture.textconv", f.command])
    await guarded(f)
    const repo = await ReadOnlyGit.open(f.input)
    const grep = (search: Extract<ReadOnlyGit.Read, { kind: "impact-grep" }>["search"], maxBytes = 1024) =>
      repo.read({ kind: "impact-grep", revision: reviewed, maxBytes, search })
    try {
      expect(repo.head).not.toBe(reviewed)
      const noSizes = (rev: string) =>
        repo.read({ kind: "impact-tree", revision: rev, maxBytes: 4096, namesAndIdsOnly: true })
      expect((await noSizes(reviewed)).bytes.toString()).toContain("\t" + importer + "\0")
      expect((await noSizes(repo.head)).bytes.toString()).not.toContain(importer)
      const listed = await repo.read({ kind: "impact-tree", revision: reviewed, maxBytes: 4096 })
      expect(listed.code).toBe(0)
      expect(listed.bytes.toString()).toContain("\t" + importer + "\0")
      expect(await repo.read({ kind: "impact-tree", revision: repo.head, maxBytes: 1 })).toEqual({
        code: 3,
        bytes: Buffer.alloc(0),
      })
      const manifest = await grep({ kind: "manifests", exclude: [] })
      expect(manifest.code).toBe(0)
      expect(manifest.bytes.toString()).toContain('{"name":"pinned"}')
      expect(manifest.bytes.toString()).not.toContain('"live"')
      const imports = await grep({ kind: "imports", files: [importer] })
      expect(imports.code).toBe(0)
      expect(imports.bytes.toString()).toContain("import { Needle }")
      expect(imports.bytes.toString()).not.toContain("joinedNeedle")
      expect(imports.bytes.toString()).not.toContain("LiveOnly")
      expect(imports.bytes.toString()).not.toContain("other.ts")
      expect(
        (
          await grep({ kind: "symbols", names: ["Needle"], exclude: [":(top,exclude,literal)src/other.ts"] })
        ).bytes.toString(),
      ).toBe(reviewed + ":" + importer + "\0")
      expect(await grep({ kind: "symbols", names: ["Missing"], exclude: [] })).toEqual({
        code: 1,
        bytes: Buffer.alloc(0),
      })
      expect(
        await repo.read({ kind: "show", revision: reviewed, file: importer, maxBytes: 2, distinguishLarge: true }),
      ).toEqual({ code: 3, bytes: Buffer.alloc(0) })
      for (const op of [
        { kind: "imports", files: ["../outside"] },
        { kind: "symbols", names: ["Needle\nother"], exclude: [] },
        { kind: "manifests", exclude: [":(attr)probe"] },
      ] as const)
        await expect(grep(op)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
      await expect(repo.read({ kind: "impact-tree", revision: "HEAD", maxBytes: 4096 })).rejects.toBeInstanceOf(
        ReadOnlyGit.Unavailable,
      )
      await expect(repo.read({ kind: "impact-version" }, AbortSignal.abort())).rejects.toBeInstanceOf(
        ReadOnlyGit.Unavailable,
      )
      await expect(repo.status(AbortSignal.abort())).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
      expect((await repo.status()).head).toBe(repo.head)
      expect((await repo.read({ kind: "impact-version" })).bytes.toString()).toStartWith("git version ")
      expect(await f.calls()).toBe(0)
    } finally {
      await repo.close()
    }
  },
)

local("show reads bounded raw bytes only from a regular file in the exact private commit", async () => {
  const f = await fixture("probe.txt diff=fixture\n")
  const first = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
  await f.git(["update-index", "--add", "--cacheinfo", `160000,${first},submodule`])
  await f.git([...author, "commit", "-qm", "historical gitlink"])
  const previous = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
  await f.git(["update-index", "--force-remove", "submodule"])
  await fs.mkdir(path.join(f.directory, "nested"))
  await fs.writeFile(path.join(f.directory, "nested", "empty"), "")
  await fs.symlink("probe.txt", path.join(f.directory, "link"))
  const bytes = Buffer.from([0, 255, 10, 128])
  await fs.writeFile(path.join(f.directory, "probe.txt"), bytes)
  await fs.writeFile(path.join(f.directory, ":(glob)*"), "literal", { mode: 0o755 })
  await fs.writeFile(path.join(f.directory, "large"), Buffer.alloc(1024 * 1024 + 1, 97))
  await f.git(["add", "-A"])
  await f.git([...author, "commit", "-qm", "file kinds and sizes"])
  await f.git([...author, "tag", "-a", "tagged", "-m", "tag object"])
  const tag = (await f.git(["rev-parse", "tagged"])).stdout.trim()
  const tree = (await f.git(["rev-parse", "HEAD^{tree}"])).stdout.trim()
  await fs.writeFile(path.join(f.directory, "probe.txt"), "staged")
  await f.git(["add", "probe.txt"])
  await fs.writeFile(path.join(f.directory, "probe.txt"), "on disk")
  await f.git(["config", "diff.fixture.textconv", f.command])
  await guarded(f)

  const repository = await ReadOnlyGit.open(f.input)
  const show = (file: string, maxBytes: number, revision = repository.head) =>
    repository.read({ kind: "show", file, revision, maxBytes })
  try {
    expect(await show("probe.txt", bytes.length)).toEqual({ code: 0, bytes })
    expect(await show("probe.txt", bytes.length - 1)).toEqual(unset)
    expect(await show("probe.txt", 15, previous)).toEqual({ code: 0, bytes: Buffer.from("saved contents\n") })
    expect(await show(":(glob)*", 7)).toEqual({ code: 0, bytes: Buffer.from("literal") })
    expect(await show("nested/empty", 0)).toEqual({ code: 0, bytes: Buffer.alloc(0) })
    expect(await show("large", 1024 * 1024)).toEqual(unset)
    for (const file of ["missing", "nested", "link"]) expect(await show(file, 128)).toEqual(unset)
    expect(await show("submodule", 128, previous)).toEqual(unset)
    for (const revision of [tag, tree, "0".repeat(40)]) expect(await show("probe.txt", 128, revision)).toEqual(unset)
    for (const file of ["../probe.txt", ".git/HEAD", "/absolute", "x\nother", "\ud800"])
      await expect(show(file, 128)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    for (const revision of ["HEAD", previous.slice(0, 10), "--all", previous + ":probe.txt"])
      await expect(show("probe.txt", 128, revision)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    for (const limit of [-1, 1.5, Infinity, 1024 * 1024 + 1])
      await expect(show("probe.txt", limit)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    expect(await f.calls()).toBe(0)
  } finally {
    await repository.close()
  }
  await expect(show("probe.txt", 128)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
})

local("the private view reports only whether captured info attributes or excludes may contain rules", async () => {
  const f = await fixture()
  const attributes = path.join(f.gitDirectory, "info", "attributes")
  const exclude = path.join(f.gitDirectory, "info", "exclude")
  const initial = await ReadOnlyGit.open(f.input)
  try {
    // Git init supplied its ordinary template. Later changes cannot alter this view's answer.
    expect(initial.hasInfoRules).toBe(false)
    await fs.writeFile(attributes, "# comment\r\n \t\r\n")
    await fs.writeFile(exclude, "\\#literal\n")
    expect(initial.hasInfoRules).toBe(false)
  } finally {
    await initial.close()
  }
  const withExclude = await ReadOnlyGit.open(f.input)
  try {
    expect(withExclude.hasInfoRules).toBe(true)
    expect(Reflect.set(withExclude, "hasInfoRules", false)).toBe(false)
    await fs.rm(exclude)
    await fs.writeFile(attributes, "doc.md linguist-generated\n")
  } finally {
    await withExclude.close()
  }
  const withAttributes = await ReadOnlyGit.open(f.input)
  try {
    expect(withAttributes.hasInfoRules).toBe(true)
  } finally {
    await withAttributes.close()
  }
  await fs.writeFile(attributes, "# comment\r\n \t\r\n")
  const comments = await ReadOnlyGit.open(f.input)
  try {
    expect(comments.hasInfoRules).toBe(false)
  } finally {
    await comments.close()
  }
})

local("path references prove absence only after a literal search of the whole private commit", async () => {
  const f = await fixture("*.bin diff=fixture\n")
  const original = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
  await fs.symlink("old/lib.data.ts", path.join(f.directory, "link"))
  await f.git(["add", "link"])
  await f.git([...author, "commit", "-qm", "link target"])
  const linked = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
  await f.git(["rm", "-q", "link"])
  await f.git(["update-index", "--add", "--cacheinfo", `160000,${original},submodule`])
  await f.git([...author, "commit", "-qm", "gitlink"])
  const gitlink = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
  await f.git(["update-index", "--force-remove", "submodule"])
  await fs.mkdir(path.join(f.directory, "nested"))
  const binary = path.join(f.directory, "nested", "references.bin")
  await fs.writeFile(binary, Buffer.from("\0prefixLIB.DATA_suffix\0--version\0otherZname\n"))
  await f.git(["add", "nested"])
  await f.git([...author, "commit", "-qm", "binary references"])
  await fs.writeFile(binary, "onlyInIndex")
  await f.git(["add", "nested"])
  await fs.writeFile(binary, "onlyOnDisk")
  await f.git(["config", "diff.fixture.textconv", f.command])
  await guarded(f)

  const repository = await ReadOnlyGit.open(f.input)
  const references = (file: string, revision = repository.head) =>
    repository.read({ kind: "path-references", file, revision })
  try {
    expect(
      await repository.read({
        kind: "unaliased-changes",
        from: original,
        to: repository.head,
        files: ["nested/references.bin"],
      }),
    ).toEqual({
      code: 0,
      bytes: Buffer.alloc(0),
    })
    for (const to of [linked, gitlink])
      expect(await repository.read({ kind: "unaliased-changes", from: original, to, files: ["probe.txt"] })).toEqual({
        code: 2,
        bytes: Buffer.alloc(0),
      })
    // The old path is absent from the tree and has no diff hunk. A reference to its stem still blocks a skip.
    for (const file of ["old/lib.data.ts", "old/--version.ts"])
      expect(await references(file)).toEqual({ code: 0, bytes: Buffer.alloc(0) })
    for (const file of ["old/other.name.ts", "onlyInIndex.md", "onlyOnDisk.ts"])
      expect(await references(file)).toEqual(unset)
    expect(await references("old/lib.data.ts", original)).toEqual(unset)
    for (const revision of [linked, gitlink, "0".repeat(40)])
      expect(await references("old/lib.data.ts", revision)).toEqual({ code: 2, bytes: Buffer.alloc(0) })
    expect(await references("old/é.ts")).toEqual({ code: 2, bytes: Buffer.alloc(0) })
    for (const file of ["../x", ".git/config", "old/a\nb.ts"])
      await expect(references(file)).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    await expect(references("old/lib.data.ts", "HEAD")).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
    expect(await f.calls()).toBe(0)
  } finally {
    await repository.close()
  }
})

local(
  "unrelated asset links allow a proof while aliases of changed instructions or config targets refuse it",
  async () => {
    const f = await fixture()
    for (const dir of ["assets", "public", "src", "docs"]) await fs.mkdir(path.join(f.directory, dir))
    await fs.writeFile(path.join(f.directory, "assets", "icon.svg"), "<svg/>")
    await fs.writeFile(path.join(f.directory, "src", "policy.ts"), "// instructions\n")
    await fs.writeFile(path.join(f.directory, "src", "code.ts"), "// old\n")
    await fs.writeFile(path.join(f.directory, "docs", "help.md"), "Introduction.\n")
    await fs.symlink("icon.svg", path.join(f.directory, "assets", "badge.svg"))
    await fs.symlink("../assets/icon.svg", path.join(f.directory, "public", "badge.svg"))
    await fs.symlink("src/policy.ts", path.join(f.directory, "AGENTS.md"))
    const save = async (message: string) => {
      await f.git(["add", "-A"])
      await f.git([...author, "commit", "-qm", message])
      return (await f.git(["rev-parse", "HEAD"])).stdout.trim()
    }
    const base = await save("ordinary files and confined links")
    await fs.appendFile(path.join(f.directory, "docs", "help.md"), "More details.\n")
    await fs.appendFile(path.join(f.directory, "src", "code.ts"), "// new\n")
    const docs = await save("unrelated documentation and comments")
    await fs.appendFile(path.join(f.directory, "src", "policy.ts"), "// changed instructions\n")
    const changed = await save("target contents changed")
    await fs.chmod(path.join(f.directory, "assets", "icon.svg"), 0o755)
    const mode = await save("asset mode changed")
    await fs.unlink(path.join(f.directory, "public", "badge.svg"))
    await fs.symlink("../assets/./icon.svg", path.join(f.directory, "public", "badge.svg"))
    const retargeted = await save("same destination by a changed link")
    await guarded(f)
    const repository = await ReadOnlyGit.open(f.input)
    const check = (from: string, to: string, files: string[]) =>
      repository.read({ kind: "unaliased-changes", from, to, files })
    const clear = { code: 0, bytes: Buffer.alloc(0) }
    const unknown = { code: 2, bytes: Buffer.alloc(0) }
    try {
      expect(await check(base, docs, ["docs/help.md", "src/code.ts"])).toEqual(clear)
      for (const candidate of ["AGENTS.md", "sRc/PoLiCy.ts", "assets/icon.svg", "assets", "public/badge.svg"])
        expect(await check(base, docs, [candidate])).toEqual(unknown)
      // Target mode and object identity are compared even if the caller accidentally omits the changed target.
      expect(await check(docs, changed, ["docs/help.md"])).toEqual(unknown)
      expect(await check(changed, mode, ["docs/help.md"])).toEqual(unknown)
      expect(await check(mode, retargeted, ["docs/help.md"])).toEqual(unknown)
      // "icon" is only in filenames and raw link targets, never in a regular blob.
      expect(await repository.read({ kind: "path-references", revision: docs, file: "old/Icon.ts" })).toEqual(clear)
      expect(await repository.read({ kind: "path-references", revision: docs, file: "old/unused.ts" })).toEqual(unset)
      await expect(check(base, docs, ["../outside"])).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
      expect(await f.calls()).toBe(0)
    } finally {
      await repository.close()
    }
  },
)

local("link proofs refuse dangling, escaping, directory, chained, ambiguous and excessive links", async () => {
  const f = await fixture()
  await fs.mkdir(path.join(f.directory, "assets"))
  await fs.writeFile(path.join(f.directory, "assets", "file"), "unchanged\n")
  await fs.symlink("assets/file", path.join(f.directory, "good"))
  await f.git(["add", "-A"])
  await f.git([...author, "commit", "-qm", "safe link"])
  const base = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
  const unsupported: string[] = []
  const save = async (reason: string) => {
    await f.git(["add", "-A"])
    await f.git([...author, "commit", "-qm", reason])
    unsupported.push((await f.git(["rev-parse", "HEAD"])).stdout.trim())
  }
  const bad = path.join(f.directory, "link")
  for (const target of ["missing", "/outside", "../outside", "assets", "good", "good/../probe.txt", "link"]) {
    await fs.symlink(target, bad)
    await save(target)
    await fs.unlink(bad)
  }
  await fs.writeFile(path.join(f.directory, "assets", "File"), "case collision\n")
  await save("ambiguous asset names")
  await fs.unlink(path.join(f.directory, "assets", "File"))
  for (let index = 0; index < 64; index++) await fs.symlink("assets/file", path.join(f.directory, "extra" + index))
  await save("65 links exceed the limit")

  const repository = await ReadOnlyGit.open(f.input)
  try {
    for (const to of unsupported) {
      // Checking only the suspect tree against itself detects invalid inventories independently of the changed link set.
      expect(await repository.read({ kind: "unaliased-changes", from: to, to, files: ["example.md"] })).toEqual({
        code: 2,
        bytes: Buffer.alloc(0),
      })
    }
    expect(await repository.read({ kind: "unaliased-changes", from: base, to: base, files: ["example.md"] })).toEqual({
      code: 0,
      bytes: Buffer.alloc(0),
    })
  } finally {
    await repository.close()
  }
})

local(
  "named references resolve to private-snapshot commits from loose and packed refs as rev-parse does",
  async () => {
    const f = await fixture()
    const head = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
    const branch = (await fs.readFile(path.join(f.gitDirectory, "HEAD"), "utf8")).trim().slice(16)
    const side = (await f.git([...author, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "side"])).stdout.trim()
    await f.git(["branch", "packed-branch", side])
    await f.git([...author, "tag", "-a", "annotated", "-m", "annotated", side])
    await f.git(["branch", "dup", side])
    await f.git(["tag", "tree-tag", "HEAD^{tree}"])
    await f.git(["pack-refs", "--all"])
    await f.git(["branch", "loose-branch", head])
    await f.git(["update-ref", "refs/remotes/origin/main", side])
    await f.git(["tag", "light", side])
    await f.git(["tag", "dup", head])
    await f.git([...author, "tag", "-a", "loose-annotated", "-m", "loose", side])
    await f.git(["branch", "release", head])
    await f.git(["tag", "release/1.0", side])
    await f.git(["branch", "cafe", head])
    await f.git(["branch", "v1-gcafe", side])
    // A stale packed line below the loose branch release's file. Git's lstat there fails with ENOTDIR, and Git reads
    // the name as missing without looking in packed-refs. Without the sorted trait, Git sorts the lines itself.
    const packedFile = path.join(f.gitDirectory, "packed-refs")
    await fs.writeFile(
      packedFile,
      (await fs.readFile(packedFile, "utf8")).replace(" sorted ", " ") + `${side} refs/heads/release/2.0\n`,
    )
    const tag = (await f.git(["rev-parse", "refs/tags/annotated"])).stdout.trim()
    expect(tag).not.toBe(side)
    expect(await fs.readFile(packedFile, "utf8")).toContain(`${tag} refs/tags/annotated\n^${side}\n`)
    const resolved = [
      ["loose-branch", head],
      [branch, head],
      [`refs/heads/${branch}`, head],
      ["heads/loose-branch", head],
      ["packed-branch", side],
      ["refs/heads/packed-branch", side],
      ["origin/main", side],
      ["remotes/origin/main", side],
      ["refs/remotes/origin/main", side],
      ["light", side],
      ["tags/light", side],
      ["refs/tags/light", side],
      ["annotated", side],
      ["refs/tags/annotated", side],
      // A loose annotated tag peels through the private object store.
      ["loose-annotated", side],
      // A branch named release beside the tag namespace release/, and a tag release/1.0 below that branch's file.
      ["release", head],
      ["release/1.0", side],
      // Refs answer before Git reads a hex-shaped or describe-shaped name as an object id.
      ["cafe", head],
      ["v1-gcafe", side],
    ]
    for (const [name, oid] of resolved)
      expect((await f.git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).stdout.trim()).toBe(oid)
    // No ref holds these, and none can be an object id: abc and x-gabc are too short, and -G is not describe output.
    const missing = [
      "missing",
      "refs/heads/missing",
      "origin/missing",
      "heads/missing",
      "release/2.0",
      "refs/heads/release/2.0",
      "abc",
      "x-gabc",
      "x-Gcafe",
    ]
    for (const name of missing)
      await expect(f.git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).rejects.toThrow()
    await guarded(f)
    const repository = await ReadOnlyGit.open(f.input)
    try {
      for (const [name, oid] of resolved)
        expect(await repository.read({ kind: "reference", name })).toEqual({ code: 0, bytes: Buffer.from(oid + "\n") })
      for (const name of missing) expect(await repository.read({ kind: "reference", name })).toEqual(unset)
      // rev-parse warns and takes the tag; a base must not depend on that.
      expect(await refusal(repository.read({ kind: "reference", name: "dup" }))).toBe("the reference name is ambiguous")
      expect(await refusal(repository.read({ kind: "reference", name: "tree-tag" }))).toBe(
        "the reference does not name a commit",
      )
      expect(repository.isOpen()).toBe(true)
      expect(await f.calls()).toBe(0)
    } finally {
      await repository.close()
    }
  },
  60_000,
)

local(
  "named references refuse unsafe names, links, symbolic or tampered refs and objects outside the snapshot",
  async () => {
    const f = await fixture()
    const head = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
    const side = (await f.git([...author, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "side"])).stdout.trim()
    await f.git(["branch", "packed-branch", side])
    await f.git([...author, "tag", "-a", "annotated", "-m", "annotated", side])
    await f.git(["pack-refs", "--all"])
    await f.git(["branch", "loose-branch", head])
    const heads = path.join(f.gitDirectory, "refs", "heads")
    const packedFile = path.join(f.gitDirectory, "packed-refs")
    const packed = await fs.readFile(packedFile, "utf8")
    const peel = `^${side}\n`
    const branchLine = `${side} refs/heads/packed-branch\n`
    expect(packed).toContain(peel)
    expect(packed).toContain(branchLine)
    await guarded(f)
    const repository = await ReadOnlyGit.open(f.input)
    const named = (name: string) => repository.read({ kind: "reference", name })
    try {
      for (const name of [
        "-x",
        "--output=../counter",
        "a..b",
        "HEAD@{1}",
        "x.lock",
        "a//b",
        "bad\u0001name",
        "",
        "refs/notes/x",
        "refs/heads",
        "x^{commit}",
        "a\\b",
        ".hidden",
        "trailing.",
        "x/",
        "/x",
        "@",
        "HEAD",
        "FETCH_HEAD",
        "ORIG_HEAD",
        "main-worktree/HEAD",
        head,
        // Git's get_oid_hex reads uppercase too, and rev-parse takes 40 hex as an object id before any ref.
        head.toUpperCase(),
        "lone\ud800",
      ])
        expect(await refusal(named(name))).toBe("the reference name is unsupported")
      expect(await refusal(repository.read({ kind: "reference", name: 1 } as unknown as ReadOnlyGit.Read))).toBe(
        "the reference name is unsupported",
      )
      // No ref holds these, but Git reads each as a short object id or `git describe` output, so code 1 would let a
      // next candidate replace a commit Git found. Since Git 2.49 describe output needs a ref name and a count before
      // -g, as in x-1-g<hex>; older Git, Ubuntu 24.04's 2.43 among them, also reads x-g<hex>, so the view refuses both.
      const short = head.slice(0, 7)
      const objectNames = [
        short,
        short.toUpperCase(),
        head.slice(0, 39),
        `v1.0-3-g${short}`,
        `refs/heads/x-1-g${short.toUpperCase()}`,
      ]
      for (const name of objectNames)
        expect((await liveGit(f, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).stdout.trim()).toBe(head)
      for (const name of [...objectNames, `refs/heads/x-g${short.toUpperCase()}`, "deadbeef"])
        expect(await refusal(named(name))).toBe("the name may be an object id; fetch or pass a commit")
      await liveGit(f, ["symbolic-ref", "refs/heads/symbolic", "refs/heads/loose-branch"])
      await fs.writeFile(path.join(heads, "upper"), head.toUpperCase() + "\n")
      await fs.writeFile(path.join(heads, "wide"), "a".repeat(64) + "\n")
      for (const name of ["symbolic", "upper", "wide"])
        expect(await refusal(named(name))).toBe("symbolic or non-SHA1 reference is unsupported")
      await fs.writeFile(path.join(heads, "empty"), "")
      expect(await refusal(named("empty"))).toBe("invalid metadata line")
      const later = (
        await liveGit(f, [...author, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "later"])
      ).stdout.trim()
      await liveGit(f, ["update-ref", "refs/heads/later", later])
      await liveGit(f, [...author, "tag", "-a", "fresh", "-m", "fresh", side])
      const fresh = (await liveGit(f, ["rev-parse", "refs/tags/fresh"])).stdout.trim()
      for (const name of ["later", "fresh"])
        expect(await refusal(named(name))).toBe(
          "the reference's object is not in the private snapshot; fetch or pass a commit",
        )
      await fs.symlink("loose-branch", path.join(heads, "linked"))
      for (const name of ["linked", "refs/heads/linked"])
        expect(await refusal(named(name))).toBe("linked references are unsupported")
      await fs.symlink("../heads", path.join(f.gitDirectory, "refs", "tags", "nested"))
      expect(await refusal(named("nested/loose-branch"))).toBe("linked reference directories are unsupported")
      // Git reads the tag object, not the peel line, so a packed tag record without one peels in the private store.
      await fs.writeFile(packedFile, packed.replace(peel, ""))
      expect((await liveGit(f, ["rev-parse", "--verify", "--quiet", "annotated^{commit}"])).stdout.trim()).toBe(side)
      expect(await named("annotated")).toEqual({ code: 0, bytes: Buffer.from(side + "\n") })
      for (const [content, name, reason] of [
        [
          packed.replace(peel, `^${head}\n`),
          "annotated",
          "the packed reference's peeled commit does not match its tag",
        ],
        [packed.replace(peel, `^${"z".repeat(40)}\n`), "annotated", "packed-refs is malformed"],
        // Git reads a CRLF record's name as ending in a carriage return, and so the name itself as missing.
        [packed.replace(branchLine, branchLine.replace("\n", "\r\n")), "packed-branch", "packed-refs is malformed"],
        // Under the sorted trait Git's binary search may miss a record out of order.
        [packed.replace(branchLine, "") + branchLine, "packed-branch", "packed-refs is malformed"],
        [packed.slice(0, -1), "packed-branch", "packed-refs is malformed"],
        [packed.replace(peel, peel + peel), "packed-branch", "packed-refs is malformed"],
        [
          packed.replace(branchLine, branchLine + branchLine),
          "packed-branch",
          "the packed reference has no unique commit",
        ],
        [
          packed.replace(branchLine, branchLine + peel),
          "packed-branch",
          "a peeled packed line follows only an annotated tag",
        ],
        [
          packed + `${side} refs/tags/peeled-commit\n${peel}`,
          "peeled-commit",
          "a peeled packed line follows only an annotated tag",
        ],
        [
          packed + `${fresh} refs/tags/fresh-packed\n${peel}`,
          "fresh-packed",
          "the reference's object is not in the private snapshot; fetch or pass a commit",
        ],
      ]) {
        await fs.writeFile(packedFile, content)
        expect(await refusal(named(name))).toBe(reason)
      }
      // Decoded, the byte 0xff would read as U+FFFD and match this name, although Git compares other bytes.
      const [before, after] = packed.split(branchLine)
      await fs.writeFile(
        packedFile,
        Buffer.concat([
          Buffer.from(`${before}${side} refs/heads/packed-branch`),
          Buffer.from([0xff]),
          Buffer.from(`\n${after}`),
        ]),
      )
      expect(await refusal(named("packed-branch�"))).toBe("packed-refs is malformed")
      await fs.writeFile(packedFile, packed)
      expect(await named("annotated")).toEqual({ code: 0, bytes: Buffer.from(side + "\n") })
      expect(await named("loose-branch")).toEqual({ code: 0, bytes: Buffer.from(head + "\n") })
      expect(repository.isOpen()).toBe(true)
      expect(await f.calls()).toBe(0)
    } finally {
      await repository.close()
    }
  },
  60_000,
)

local(
  "a name rev-parse would also find outside branches and tags refuses rather than resolve differently",
  async () => {
    const f = await fixture()
    const head = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
    const side = (await f.git([...author, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "side"])).stdout.trim()
    await f.git(["update-ref", "refs/stash", side])
    await f.git(["branch", "stash", head])
    await f.git(["update-ref", "refs/notes/commits", side])
    await f.git(["branch", "x", head])
    await f.git(["update-ref", "refs/heads/heads/x", side])
    await f.git(["update-ref", "refs/remotes/origin/main", side])
    await f.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
    await f.git(["branch", "config", head])
    await f.git(["branch", "shadow", head])
    await fs.writeFile(path.join(f.gitDirectory, "shadow"), side + "\n")
    // Git's own first places: refs/<name> before the tag and branch namespaces, and <remote> as <remote>/HEAD.
    for (const [name, oid] of [
      ["stash", side],
      ["heads/x", head],
      ["origin", side],
    ])
      expect((await f.git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).stdout.trim()).toBe(oid)
    const linked = path.join(f.base, "linked")
    await f.git(["worktree", "add", "--quiet", "-b", "linked-branch", linked])
    const gitDirectory = path.resolve(linked, (await f.git(["rev-parse", "--git-dir"], linked)).stdout.trim())
    // refs/bisect is per worktree, so this one lives in the linked worktree's own Git directory.
    await f.git(["update-ref", "refs/bisect/bad", side], linked)
    expect(await fs.readFile(path.join(gitDirectory, "refs", "bisect", "bad"), "utf8")).toBe(side + "\n")
    // Git reads branches only from the common directory. A stray branch-shaped file in the linked worktree's own Git
    // directory answers nothing (ghost), and does not override the packed record (ghost-packed).
    await fs.writeFile(path.join(f.gitDirectory, "packed-refs"), `${side} refs/heads/ghost-packed\n`)
    await fs.mkdir(path.join(gitDirectory, "refs", "heads"), { recursive: true })
    for (const name of ["ghost", "ghost-packed"])
      await fs.writeFile(path.join(gitDirectory, "refs", "heads", name), head + "\n")
    await expect(f.git(["rev-parse", "--verify", "--quiet", "ghost^{commit}"], linked)).rejects.toThrow()
    expect((await f.git(["rev-parse", "--verify", "--quiet", "ghost-packed^{commit}"], linked)).stdout.trim()).toBe(
      side,
    )
    await guarded(f)
    const primary = await ReadOnlyGit.open(f.input)
    try {
      expect(await primary.read({ kind: "reference", name: "ghost" })).toEqual(unset)
      expect(await primary.read({ kind: "reference", name: "ghost-packed" })).toEqual({
        code: 0,
        bytes: Buffer.from(side + "\n"),
      })
      for (const name of ["stash", "notes/commits", "origin", "config", "shadow"])
        expect(await refusal(primary.read({ kind: "reference", name }))).toBe(
          "the reference name resolves outside branches and tags",
        )
      expect(await refusal(primary.read({ kind: "reference", name: "heads/x" }))).toBe(
        "the reference name is ambiguous",
      )
      for (const name of ["x", "refs/heads/x", "linked-branch"])
        expect(await primary.read({ kind: "reference", name })).toEqual({ code: 0, bytes: Buffer.from(head + "\n") })
      expect(await primary.read({ kind: "reference", name: "bisect/bad" })).toEqual(unset)
      expect(await f.calls()).toBe(0)
    } finally {
      await primary.close()
    }
    const worktree = await ReadOnlyGit.open({ directory: linked, gitDirectory, commonDirectory: f.gitDirectory })
    try {
      for (const name of ["bisect/bad", "ghost", "ghost-packed"])
        expect(await refusal(worktree.read({ kind: "reference", name }))).toBe(
          "the reference name resolves outside branches and tags",
        )
      for (const name of ["x", "linked-branch"])
        expect(await worktree.read({ kind: "reference", name })).toEqual({ code: 0, bytes: Buffer.from(head + "\n") })
      expect(await f.calls()).toBe(0)
    } finally {
      await worktree.close()
    }
  },
  90_000,
)

local(
  "a linked reference directory refuses even when the detached view never read it at open",
  async () => {
    const f = await fixture()
    const head = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
    const branch = (await fs.readFile(path.join(f.gitDirectory, "HEAD"), "utf8")).trim().slice(16)
    await f.git(["checkout", "--detach", "--quiet"])
    const heads = path.join(f.gitDirectory, "refs", "heads")
    await fs.rename(heads, path.join(f.base, "heads-elsewhere"))
    await fs.symlink(path.join(f.base, "heads-elsewhere"), heads)
    await guarded(f)
    const repository = await ReadOnlyGit.open(f.input)
    try {
      expect(repository.head).toBe(head)
      expect(repository.branch).toBeUndefined()
      // Without the refusal the branch would read as missing, and the next candidate could answer instead.
      for (const name of [branch, `refs/heads/${branch}`, "missing"])
        expect(await refusal(repository.read({ kind: "reference", name }))).toBe(
          "linked reference directories are unsupported",
        )
      expect(repository.isOpen()).toBe(true)
      expect(await f.calls()).toBe(0)
    } finally {
      await repository.close()
    }
  },
  60_000,
)

local(
  "origin/HEAD reads as its validated remote-tracking target, unset as code 1, and malformed or linked as a refusal",
  async () => {
    const f = await fixture()
    const head = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
    await guarded(f)
    const repository = await ReadOnlyGit.open(f.input)
    const origin = path.join(f.gitDirectory, "refs", "remotes", "origin")
    const pointer = path.join(origin, "HEAD")
    const defaultBranch = () => repository.read({ kind: "default-branch" })
    try {
      expect(await defaultBranch()).toEqual(unset)
      await liveGit(f, ["update-ref", "refs/remotes/origin/main", head])
      expect(await defaultBranch()).toEqual(unset)
      await liveGit(f, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
      expect(await fs.readFile(pointer, "utf8")).toBe("ref: refs/remotes/origin/main\n")
      expect(await defaultBranch()).toEqual({ code: 0, bytes: Buffer.from("refs/remotes/origin/main\n") })
      expect(await refusal(repository.read({ kind: "reference", name: "origin/HEAD" }))).toBe(
        "symbolic or non-SHA1 reference is unsupported",
      )
      await fs.writeFile(pointer, "ref: refs/remotes/origin/release/2.0\n")
      expect(await defaultBranch()).toEqual({ code: 0, bytes: Buffer.from("refs/remotes/origin/release/2.0\n") })
      const malformed = "origin/HEAD does not name an origin branch"
      for (const [content, reason] of [
        [`${head}\n`, malformed],
        ["ref: refs/remotes/upstream/main\n", malformed],
        ["ref: refs/heads/main\n", malformed],
        ["ref: refs/remotes/origin/a..b\n", malformed],
        ["ref: refs/remotes/origin/\n", malformed],
        ["ref: refs/remotes/origin/main \n", malformed],
        ["ref:refs/remotes/origin/main\n", malformed],
        ["ref: refs/remotes/origin/HEAD\n", malformed],
        ["ref: refs/remotes/origin/main\r\n", "invalid metadata line"],
        ["", "invalid metadata line"],
        ["ref: refs/remotes/origin/main\nref: refs/remotes/origin/next\n", "invalid metadata line"],
      ]) {
        await fs.writeFile(pointer, content)
        expect(await refusal(defaultBranch())).toBe(reason)
      }
      await fs.rm(pointer)
      await fs.symlink("main", pointer)
      expect(await refusal(defaultBranch())).toBe("linked references are unsupported")
      await fs.rm(pointer)
      expect(await defaultBranch()).toEqual(unset)
      await fs.writeFile(path.join(f.gitDirectory, "packed-refs"), `${head} refs/remotes/origin/HEAD\n`)
      expect(await refusal(defaultBranch())).toBe(malformed)
      await fs.rm(path.join(f.gitDirectory, "packed-refs"))
      // A linked remote directory refuses instead of reading as unset.
      await fs.rename(origin, path.join(f.base, "origin-elsewhere"))
      await fs.symlink(path.join(f.base, "origin-elsewhere"), origin)
      expect(await refusal(defaultBranch())).toBe("linked reference directories are unsupported")
      expect(repository.isOpen()).toBe(true)
      expect(await f.calls()).toBe(0)
    } finally {
      await repository.close()
    }
  },
  60_000,
)

local("HEAD keeps its branch-name refusals after the reference validator is shared", async () => {
  const f = await fixture()
  const head = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
  await f.git(["branch", "team/feature"])
  const marker = path.join(f.gitDirectory, "HEAD")
  for (const name of [
    "a..b",
    "x.lock",
    "a//b",
    "x@{1}",
    "bad\u0001name",
    ".hidden",
    "trailing.",
    "x/",
    "x^y",
    "a\\b",
  ]) {
    await fs.writeFile(marker, `ref: refs/heads/${name}\n`)
    expect(await refusal(ReadOnlyGit.metadataHead(f.directory))).toBe("invalid branch reference")
  }
  await fs.writeFile(marker, "ref: refs/heads/team/feature\n")
  expect(await ReadOnlyGit.metadataHead(f.directory)).toMatchObject({ head, branch: "team/feature" })
})

const looseObject = (f: Awaited<ReturnType<typeof fixture>>, oid: string) =>
  fs.stat(path.join(f.gitDirectory, "objects", oid.slice(0, 2), oid.slice(2))).then(
    () => true,
    () => false,
  )

local(
  "short and uppercase commit ids resolve only to one commit in the private object store, never through a ref",
  async () => {
    const f = await fixture()
    // The shortest prefix of at least the given length that holds a letter, so its uppercase spelling differs.
    const lettered = (oid: string, length: number) => oid.slice(0, Math.max(length, oid.search(/[a-f]/) + 1))
    const listed = async (prefix: string) =>
      (await f.git(["rev-parse", `--disambiguate=${prefix}`])).stdout.split("\n").filter(Boolean)
    const head = (await f.git(["rev-parse", "HEAD"])).stdout.trim()
    const side = (await f.git([...author, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "side"])).stdout.trim()
    const tree = (await f.git(["rev-parse", "HEAD^{tree}"])).stdout.trim()
    const blob = (await f.git(["rev-parse", "HEAD:probe.txt"])).stdout.trim()
    await f.git([...author, "tag", "-a", "on-side", "-m", "on-side", side])
    await f.git([...author, "tag", "-a", "on-tree", "-m", "on-tree", "HEAD^{tree}"])
    const tag = (await f.git(["rev-parse", "refs/tags/on-side"])).stdout.trim()
    const treeTag = (await f.git(["rev-parse", "refs/tags/on-tree"])).stdout.trim()
    // Two blobs whose ids share seven digits. The tagged one is packed, the unreachable one stays loose.
    const collision = await Promise.all(
      ["collision 26993\n", "collision 30025\n"].map(async (content, index) => {
        const file = path.join(f.base, `collision-${index}`)
        await fs.writeFile(file, content)
        return (await f.git(["hash-object", "-w", "--no-filters", "--", file])).stdout.trim()
      }),
    )
    expect(collision[0].slice(0, 7)).toBe(collision[1].slice(0, 7))
    expect(collision[0][7]).not.toBe(collision[1][7])
    await f.git(["tag", "collision", collision[0]])
    await f.git(["repack", "-a", "-d", "-q"])
    expect(await looseObject(f, collision[0])).toBe(false)
    expect(await looseObject(f, collision[1])).toBe(true)
    // A branch named like a short id of side, and a tag named like no object's id, both holding HEAD's commit.
    const sideBranch = lettered(side, 10)
    await f.git(["branch", sideBranch, head])
    const hexTag = "abcdef0123"
    await f.git(["tag", hexTag, head])
    const short = head.slice(0, 7)
    for (const [prefix, oids] of [
      [short, [head]],
      [lettered(head, 7), [head]],
      [head.slice(0, 39), [head]],
      [sideBranch, [side]],
      [hexTag, []],
      [tag.slice(0, 7), [tag]],
      [collision[0].slice(0, 7), [...collision].sort()],
      [collision[0].slice(0, 8), [collision[0]]],
      [blob.slice(0, 7), [blob]],
      [tree.slice(0, 7), [tree]],
      [treeTag.slice(0, 7), [treeTag]],
    ] as const)
      expect(await listed(prefix)).toEqual([...oids])
    const resolved = [
      [short, head],
      [lettered(head, 7).toUpperCase(), head],
      [head.slice(0, 39), head],
      [head.toUpperCase(), head],
      [side.slice(0, sideBranch.length + 2), side],
      // Git looks a ref up in its own spelling, and the branch is lowercase, so the object answers.
      [sideBranch.toUpperCase(), side],
      // A short id of an annotated tag peels to its commit.
      [tag.slice(0, 7), side],
      ["HEAD", head],
      [head, head],
    ]
    for (const [revision, oid] of resolved)
      expect((await f.git(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])).stdout.trim()).toBe(oid)
    // Git reads a ref of the exact spelling before a short object id, whether or not an object has that prefix.
    const refNamed = [sideBranch, hexTag]
    for (const revision of refNamed)
      expect((await f.git(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])).stdout.trim()).toBe(head)
    const ambiguous = collision[0].slice(0, 7)
    const notCommits = [collision[0].slice(0, 8), blob.slice(0, 7), tree.slice(0, 7), treeTag.slice(0, 7)]
    for (const revision of [ambiguous, ...notCommits])
      await expect(f.git(["rev-parse", "--verify", "--quiet", `${revision}^{commit}`])).rejects.toThrow()
    const unsupported = [
      head.slice(0, 6),
      head.slice(0, 6).toUpperCase(),
      head + "0",
      "a".repeat(64),
      `${short}^{tree}`,
      `-${short}`,
      ` ${short}`,
      "main",
      "Head",
      "",
    ]
    await guarded(f)
    const repository = await ReadOnlyGit.open(f.input)
    const resolve = (revision: string) => repository.read({ kind: "resolve", revision })
    try {
      for (const [revision, oid] of resolved)
        expect(await resolve(revision)).toEqual({ code: 0, bytes: Buffer.from(oid + "\n") })
      // A short id never answers through a ref, so a ref of its spelling refuses it.
      for (const revision of refNamed)
        expect(await refusal(resolve(revision))).toBe(
          "the short object id is also a reference name; pass the full commit",
        )
      expect(await refusal(resolve(ambiguous))).toBe("the short object id is ambiguous; pass more digits")
      for (const revision of notCommits)
        expect(await refusal(resolve(revision))).toBe("the short object id does not name a commit")
      for (const revision of unsupported)
        expect(await refusal(resolve(revision))).toBe("only a captured HEAD or exact SHA1 revision is supported")
      expect(
        await refusal(repository.read({ kind: "resolve", revision: 1234567 } as unknown as ReadOnlyGit.Read)),
      ).toBe("only a captured HEAD or exact SHA1 revision is supported")
      // A commit made after open, with no ref, is in the live store only. Only the private snapshot answers.
      const later = (
        await liveGit(f, [...author, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "later"])
      ).stdout.trim()
      expect((await liveGit(f, ["rev-parse", "--verify", "--quiet", `${later.slice(0, 7)}^{commit}`])).stdout).toBe(
        later + "\n",
      )
      expect((await liveGit(f, ["rev-parse", `--disambiguate=${later.slice(0, 7)}`])).stdout).toBe(later + "\n")
      for (const revision of [later.slice(0, 7), lettered(later, 7).toUpperCase()])
        expect(await refusal(resolve(revision))).toBe(
          "no object in the private snapshot has that short id; fetch or pass a full commit",
        )
      for (const revision of [later, later.toUpperCase()]) expect(await resolve(revision)).toEqual(unset)
      // Refs are live. A ref made after open with a short id's spelling makes that id refuse, where Git takes the ref.
      const late = head.slice(0, 8)
      expect(await resolve(late)).toEqual({ code: 0, bytes: Buffer.from(head + "\n") })
      await liveGit(f, ["update-ref", `refs/heads/${late}`, side])
      expect((await liveGit(f, ["rev-parse", "--verify", "--quiet", `${late}^{commit}`])).stdout).toBe(side + "\n")
      expect(await refusal(resolve(late))).toBe("the short object id is also a reference name; pass the full commit")
      expect(repository.isOpen()).toBe(true)
      expect(await resolve(short)).toEqual({ code: 0, bytes: Buffer.from(head + "\n") })
      expect(await f.calls()).toBe(0)
    } finally {
      await repository.close()
    }
  },
  60_000,
)

local(
  "annotated tags peel through the private object store, loose or packed, nested, not to a tree or outside tags",
  async () => {
    const f = await fixture()
    const side = (await f.git([...author, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "side"])).stdout.trim()
    const tree = (await f.git(["rev-parse", "HEAD^{tree}"])).stdout.trim()
    await f.git([...author, "tag", "-a", "loose-tag", "-m", "loose", side])
    const tag = (await f.git(["rev-parse", "refs/tags/loose-tag"])).stdout.trim()
    await f.git([...author, "tag", "-a", "nested-tag", "-m", "nested", "loose-tag"])
    await f.git([...author, "tag", "-a", "tree-tag", "-m", "tree", "HEAD^{tree}"])
    await f.git([...author, "tag", "-a", "nested-tree-tag", "-m", "nested tree", "tree-tag"])
    // Git refuses to point a branch at a tag object, but reads a branch file that does.
    await fs.writeFile(path.join(f.gitDirectory, "refs", "heads", "at-tag"), tag + "\n")
    await f.git(["update-ref", "refs/remotes/origin/at-tag", tag])
    // The objects are packed and the refs stay loose. A tag made afterwards keeps a loose object.
    await f.git(["repack", "-a", "-d", "-q"])
    expect(await fs.readFile(path.join(f.gitDirectory, "refs", "tags", "loose-tag"), "utf8")).toBe(tag + "\n")
    expect(await looseObject(f, tag)).toBe(false)
    await f.git([...author, "tag", "-a", "fresh-object", "-m", "fresh", side])
    expect(await looseObject(f, (await f.git(["rev-parse", "refs/tags/fresh-object"])).stdout.trim())).toBe(true)
    const commits = ["loose-tag", "refs/tags/loose-tag", "nested-tag", "fresh-object"]
    // Git peels a tag object under a branch or remote-tracking ref too; this view peels one only under refs/tags/.
    const outside = ["at-tag", "origin/at-tag"]
    const trees = ["tree-tag", "nested-tree-tag"]
    const live = async (git: (args: string[]) => Promise<{ stdout: string }>) => {
      for (const name of [...commits, ...outside])
        expect((await git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).stdout).toBe(side + "\n")
      for (const name of trees)
        await expect(git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`])).rejects.toThrow()
    }
    await live(f.git)
    await guarded(f)
    const repository = await ReadOnlyGit.open(f.input)
    const view = async () => {
      for (const name of commits)
        expect(await repository.read({ kind: "reference", name })).toEqual({ code: 0, bytes: Buffer.from(side + "\n") })
      for (const name of outside)
        expect(await refusal(repository.read({ kind: "reference", name }))).toBe(
          "only a tag reference may name an annotated tag",
        )
      for (const name of trees)
        expect(await refusal(repository.read({ kind: "reference", name }))).toBe("the reference does not name a commit")
    }
    try {
      await view()
      // Packed, Git records the fully peeled object after every ref to a tag, whatever its namespace. Since Git 2.55
      // pack-refs refuses a branch that names a tag object, so the branch leaves the loose store first and its record
      // is written as earlier Git packed it, in sorted place before the first record (the default branch).
      await fs.rm(path.join(f.gitDirectory, "refs", "heads", "at-tag"))
      await liveGit(f, ["pack-refs", "--all"])
      const packedFile = path.join(f.gitDirectory, "packed-refs")
      const [header, ...records] = (await fs.readFile(packedFile, "utf8")).split(/(?<=\n)/)
      expect(header).toBe("# pack-refs with: peeled fully-peeled sorted \n")
      expect(records[0].slice(41) > "refs/heads/at-tag\n").toBe(true)
      await fs.writeFile(packedFile, [header, `${tag} refs/heads/at-tag\n^${side}\n`, ...records].join(""))
      const packed = await fs.readFile(packedFile, "utf8")
      for (const name of ["refs/heads/at-tag", "refs/remotes/origin/at-tag", "refs/tags/loose-tag"])
        expect(packed).toContain(`${tag} ${name}\n^${side}\n`)
      expect(packed).toMatch(new RegExp(`^[0-9a-f]{40} refs/tags/nested-tag\n\\^${side}$`, "m"))
      expect(packed).toMatch(new RegExp(`^[0-9a-f]{40} refs/tags/nested-tree-tag\n\\^${tree}$`, "m"))
      expect(await looseObject(f, tag)).toBe(false)
      await expect(fs.stat(path.join(f.gitDirectory, "refs", "tags", "loose-tag"))).rejects.toThrow()
      await live((args) => liveGit(f, args))
      await view()
      expect(repository.isOpen()).toBe(true)
      expect(await f.calls()).toBe(0)
    } finally {
      await repository.close()
    }
  },
  60_000,
)

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

local("Git status stat-cache refresh preserves the captured private index and concurrent review status", async () => {
  const f = await fixture()
  const repository = await ReadOnlyGit.open(f.input)
  try {
    const index = path.join(f.gitDirectory, "index")
    const before = await fs.readFile(index)
    await fs.utimes(path.join(f.directory, "probe.txt"), 1_700_000_000, 1_700_000_000)
    expect((await f.git(["status", "--porcelain=v1"])).stdout).toBe("")
    const refreshed = await fs.readFile(index)
    expect(refreshed.equals(before)).toBe(false)
    expect(await Promise.all([repository.status(), repository.status()])).toEqual([
      { head: repository.head, dirty: false },
      { head: repository.head, dirty: false },
    ])
    expect(
      (await repository.read({ kind: "object", action: "blob", revision: "index", file: "probe.txt" })).bytes,
    ).toEqual(Buffer.from("saved contents\n"))
    expect(await fs.readFile(index)).toEqual(refreshed)
    expect(await f.calls()).toBe(0)
  } finally {
    await repository.close()
  }
})

local.each(["staged-content", "staged-mode", "head", "branch"] as const)(
  "a real %s change still refuses status against the captured private snapshot",
  async (change) => {
    const f = await fixture()
    const repository = await ReadOnlyGit.open(f.input)
    try {
      if (change === "staged-content") {
        await fs.writeFile(path.join(f.directory, "probe.txt"), "new staged contents\n")
        await f.git(["add", "probe.txt"])
      }
      if (change === "staged-mode") await f.git(["update-index", "--chmod=+x", "probe.txt"])
      if (change === "head")
        await f.git([
          "-c",
          "user.name=Vector Fixture",
          "-c",
          "user.email=fixture@invalid",
          "commit",
          "--allow-empty",
          "--quiet",
          "-m",
          "new captured head",
        ])
      if (change === "branch") {
        await f.git(["update-ref", "refs/heads/rebound", repository.head])
        await f.git(["symbolic-ref", "HEAD", "refs/heads/rebound"])
      }
      await expect(repository.status()).rejects.toBeInstanceOf(ReadOnlyGit.Unavailable)
      expect(await f.calls()).toBe(0)
    } finally {
      await repository.close()
    }
  },
)

local(
  "a refreshed private stat cache still detects equal-size content edits with the original mtime restored",
  async () => {
    const f = await fixture()
    const file = path.join(f.directory, "probe.txt")
    await fs.utimes(file, 1_700_000_000, 1_700_000_000)
    const repository = await ReadOnlyGit.open(f.input)
    try {
      expect((await repository.status()).dirty).toBe(false)
      const before = await fs.stat(file, { bigint: true })
      const index = await fs.readFile(path.join(f.gitDirectory, "index"))
      await fs.writeFile(file, "Z".repeat(Number(before.size) - 1) + "\n")
      await fs.utimes(file, 1_700_000_000, 1_700_000_000)
      const after = await fs.stat(file, { bigint: true })
      expect(after.size).toBe(before.size)
      expect(after.mtimeNs).toBe(before.mtimeNs)
      expect(after.ctimeNs).not.toBe(before.ctimeNs)
      expect((await repository.status()).dirty).toBe(true)
      expect(await fs.readFile(path.join(f.gitDirectory, "index"))).toEqual(index)
      expect(await f.calls()).toBe(0)
    } finally {
      await repository.close()
    }
  },
)

// Stale private snapshots (C5). Every sweep below runs on its own folder, never on the real temporary folder.
const DAY = 24 * 60 * 60 * 1000
const SNAPSHOT_NAME = /^vector-readonly-git-[A-Za-z0-9]{6}$/
const liveMarker = () => `${process.pid} ${Math.floor(performance.timeOrigin)}\n`
async function sweepRoot() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vector-sweep-fixture-")))
  temporary.push(root)
  return root
}
// A folder shaped like open()'s snapshot. mkdir keeps a setgid parent's bit, so the mode is set explicitly, as open() does.
async function snapshotFolder(root: string, name: string, mode = 0o700) {
  const folder = path.join(root, name)
  await fs.mkdir(path.join(folder, "git", "objects"), { recursive: true })
  await fs.writeFile(path.join(folder, "git", "objects", "pack"), "private\n")
  await fs.chmod(folder, mode)
  return folder
}

local("sweepStale removes only old, dead, private snapshot directories of this user", async () => {
  const root = await sweepRoot()
  const outside = path.join(root, "outside")
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, "keep.txt"), "outside\n")
  const target = await snapshotFolder(root, "target")
  // Each matching name, and what a sweep two days from now does with it.
  const rows = [
    {
      name: "vector-readonly-git-Old001",
      aged: "removed",
      make: async (folder: string) => {
        await fs.symlink(outside, path.join(folder, "link"))
        await fs.mkdir(path.join(folder, "inner"))
        await fs.symlink(path.join(outside, "keep.txt"), path.join(folder, "inner", "file-link"))
      },
    },
    { name: "vector-readonly-git-Dead01", aged: "removed", marker: "2147483647 1\n" },
    { name: "vector-readonly-git-Junk01", aged: "removed", marker: "not a marker\n" },
    {
      name: "vector-readonly-git-Fresh1",
      aged: "kept",
      make: async (folder: string) => {
        const seconds = (Date.now() + 2 * DAY - 60_000) / 1000
        await fs.utimes(folder, seconds, seconds)
      },
    },
    { name: "vector-readonly-git-Live01", aged: "kept", marker: liveMarker() },
    { name: "vector-readonly-git-Mode01", aged: "kept", mode: 0o755 },
    {
      name: "vector-readonly-git-Link01",
      aged: "kept",
      replace: (entry: string) => fs.symlink(target, entry),
    },
    {
      name: "vector-readonly-git-File01",
      aged: "kept",
      replace: async (entry: string) => {
        await fs.writeFile(entry, "a file\n")
        await fs.chmod(entry, 0o700)
      },
    },
    {
      name: "vector-readonly-git-Mark01",
      aged: "failed",
      make: (folder: string) =>
        fs.symlink(path.join(root, "vector-readonly-git-Live01", "owner"), path.join(folder, "owner")),
    },
  ] as const
  for (const row of rows) {
    const entry = path.join(root, row.name)
    if ("replace" in row) {
      await row.replace(entry)
      continue
    }
    await snapshotFolder(root, row.name, "mode" in row ? row.mode : 0o700)
    if ("marker" in row) await fs.writeFile(path.join(entry, "owner"), row.marker)
    if ("make" in row) await row.make(entry)
  }
  // Real 0700 folders whose names open() never makes.
  for (const name of [
    "vector-readonly-git-Short",
    "vector-readonly-git-Long001",
    "vector-readonly-git-ab_c12",
    "prefix-vector-readonly-git-Abc123",
  ])
    await snapshotFolder(root, name)
  const original = (await fs.readdir(root)).sort()
  expect(original.filter((name) => SNAPSHOT_NAME.test(name)).sort()).toEqual(rows.map((row) => row.name).sort())
  const all = { removed: 0, kept: rows.length, failed: 0 }

  expect(await ReadOnlyGit.sweepStale({ directory: root, now: Date.now() })).toEqual(all)
  expect(await ReadOnlyGit.sweepStale({ directory: root, now: Date.now() + 2 * DAY, olderThanMs: 3 * DAY })).toEqual(
    all,
  )
  // A threshold that is not a number, or under the one-hour floor, removes nothing and reads nothing.
  for (const olderThanMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -DAY, 60 * 60 * 1000 - 1])
    expect(await ReadOnlyGit.sweepStale({ directory: root, now: Date.now() + 2 * DAY, olderThanMs })).toEqual({
      removed: 0,
      kept: 0,
      failed: 0,
    })
  expect(await ReadOnlyGit.sweepStale({ directory: root, now: Number.NaN })).toEqual({
    removed: 0,
    kept: 0,
    failed: 0,
  })
  expect((await fs.readdir(root)).sort()).toEqual(original)

  const count = (aged: string) => rows.filter((row) => row.aged === aged).length
  expect(await ReadOnlyGit.sweepStale({ directory: root, now: Date.now() + 2 * DAY })).toEqual({
    removed: count("removed"),
    kept: count("kept"),
    failed: count("failed"),
  })
  const removed = new Set<string>(rows.filter((row) => row.aged === "removed").map((row) => row.name))
  expect((await fs.readdir(root)).sort()).toEqual(original.filter((name) => !removed.has(name)))
  expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside\n")
  expect(await fs.readFile(path.join(target, "git", "objects", "pack"), "utf8")).toBe("private\n")
  expect((await fs.lstat(path.join(root, "vector-readonly-git-Link01"))).isSymbolicLink()).toBe(true)
  expect(await fs.readFile(path.join(root, "vector-readonly-git-Live01", "owner"), "utf8")).toBe(liveMarker())
})

test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)(
  "sweepStale keeps an old snapshot that another user owns",
  async () => {
    const root = await sweepRoot()
    await snapshotFolder(root, "vector-readonly-git-Root01")
    const foreign = await snapshotFolder(root, "vector-readonly-git-Other1")
    await fs.chown(foreign, 65534, 65534)
    expect(await ReadOnlyGit.sweepStale({ directory: root, now: Date.now() + 2 * DAY })).toEqual({
      removed: 1,
      kept: 1,
      failed: 0,
    })
    expect(await fs.readdir(root)).toEqual(["vector-readonly-git-Other1"])
  },
)

test("sweepStale tolerates a missing folder", async () => {
  const root = await sweepRoot()
  expect(await ReadOnlyGit.sweepStale({ directory: path.join(root, "missing"), now: Date.now() + 2 * DAY })).toEqual({
    removed: 0,
    kept: 0,
    failed: 0,
  })
})

test.skipIf(process.platform === "linux")("sweepStale leaves everything in place off Linux", async () => {
  const root = await sweepRoot()
  await snapshotFolder(root, "vector-readonly-git-Old001")
  expect(await ReadOnlyGit.sweepStale({ directory: root, now: Date.now() + 2 * DAY })).toEqual({
    removed: 0,
    kept: 0,
    failed: 0,
  })
  expect(await fs.readdir(root)).toEqual(["vector-readonly-git-Old001"])
})

local("open() marks its private snapshot with this process, and a sweep keeps it while the process lives", async () => {
  const f = await fixture()
  const snapshots = async () => (await fs.readdir(os.tmpdir())).filter((name) => SNAPSHOT_NAME.test(name))
  const before = new Set(await snapshots())
  const repository = await ReadOnlyGit.open(f.input)
  // Another process may open a snapshot in the same folder meanwhile; only the ones this process marked count.
  const added = (
    await Promise.all(
      (await snapshots())
        .filter((name) => !before.has(name))
        .map(async (name) =>
          (await fs.readFile(path.join(os.tmpdir(), name, "owner"), "utf8").catch(() => undefined)) === liveMarker()
            ? [name]
            : [],
        ),
    )
  ).flat()
  try {
    expect(added).toHaveLength(1)
    const marker = path.join(os.tmpdir(), added[0], "owner")
    const info = await fs.lstat(marker)
    expect(info.isFile()).toBe(true)
    expect(info.mode & 0o777).toBe(0o600)
    const text = await fs.readFile(marker, "utf8")
    expect(text).toBe(liveMarker())
    // The same marker in an old snapshot of its own keeps it while this process lives.
    const root = await sweepRoot()
    const copy = await snapshotFolder(root, "vector-readonly-git-Copy01")
    await fs.writeFile(path.join(copy, "owner"), text)
    expect(await ReadOnlyGit.sweepStale({ directory: root, now: Date.now() + 2 * DAY })).toEqual({
      removed: 0,
      kept: 1,
      failed: 0,
    })
    expect(await repository.status()).toEqual({ head: repository.head, dirty: false })
  } finally {
    await repository.close()
  }
  expect(await fs.lstat(path.join(os.tmpdir(), added[0])).catch(() => undefined)).toBeUndefined()
})
