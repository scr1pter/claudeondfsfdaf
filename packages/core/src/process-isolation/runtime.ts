import fs, { type BigIntStats } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { LinuxIsolation } from "../process-isolation/linux"

export interface Metadata {
  readonly kind: "file" | "directory" | "other"
  readonly device: bigint
  readonly inode: bigint
  readonly uid: number
  readonly gid: number
  readonly mode: number
  readonly links: bigint
  readonly size: bigint
  readonly modified: bigint
  readonly changed: bigint
}

/** Internal bounded reader port; no caller-selected paths, activation flags or process authority. */
export interface Reader {
  readonly canonical: (name: string) => string
  readonly metadata: (name: string) => Metadata
  readonly open: (name: string) => {
    readonly metadata: () => Metadata
    readonly read: (limit: number) => Uint8Array
    readonly close: () => void
  }
}

type Stdio = "pipe" | "ignore" | "inherit"
export interface Options {
  readonly cwd?: string
  readonly shell?: boolean | string
  readonly env?: NodeJS.ProcessEnv
  readonly stdio: readonly [Stdio, Stdio, Stdio]
  readonly additionalFDs: readonly number[]
}

function metadata(value: BigIntStats): Metadata {
  return {
    kind: value.isFile() ? "file" : value.isDirectory() ? "directory" : "other",
    device: value.dev,
    inode: value.ino,
    uid: Number(value.uid),
    gid: Number(value.gid),
    mode: Number(value.mode),
    links: value.nlink,
    size: value.size,
    modified: value.mtimeNs,
    changed: value.ctimeNs,
  }
}

const system: Reader = {
  canonical: (name) => fs.realpathSync(name),
  metadata: (name) => metadata(fs.lstatSync(name, { bigint: true })),
  open: (name) => {
    // Node/libuv opens these descriptors close-on-exec. No FD is retained past this synchronous reader.
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    return {
      metadata: () => metadata(fs.fstatSync(fd, { bigint: true })),
      read: (limit) => {
        const bytes = Buffer.alloc(limit + 1)
        let size = 0
        while (size < bytes.length) {
          const count = fs.readSync(fd, bytes, size, bytes.length - size, size)
          if (count === 0) break
          size += count
        }
        return bytes.subarray(0, size)
      },
      close: () => fs.closeSync(fd),
    }
  },
}

function requireValue(value: unknown): asserts value {
  if (!value) throw new LinuxIsolation.Unavailable()
}

function same(left: Metadata, right: Metadata) {
  return (
    left.kind === right.kind &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode &&
    left.links === right.links &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  )
}

/**
 * Attests fixed installed metadata/bytes only. CPython getpath/stdlib closure and live broker/mask admission
 * remain separate native CI gates; this reader does not execute an interpreter or establish a live lease.
 */
export function create(reader: Reader) {
  const chain = (name: string, kind: Metadata["kind"]) => {
    requireValue(reader.canonical(name) === name)
    const value = reader.metadata(name)
    requireValue(value.kind === kind && value.uid === 0 && value.gid === 0 && !(value.mode & 0o022))
    for (let parent = path.posix.dirname(name); ; parent = path.posix.dirname(parent)) {
      const info = reader.metadata(parent)
      requireValue(
        info.kind === "directory" &&
          info.uid === 0 &&
          info.gid === 0 &&
          !(info.mode & 0o022) &&
          reader.canonical(parent) === parent,
      )
      if (parent === "/") break
    }
    return value
  }
  const fixed = (name: string, limit: number) => {
    const observed = chain(name, "file")
    const source = reader.open(name)
    try {
      const before = source.metadata()
      requireValue(
        same(observed, before) &&
          before.kind === "file" &&
          before.uid === 0 &&
          before.gid === 0 &&
          (before.mode & 0o7777) === 0o444 &&
          before.links === 1n &&
          before.size > 0n &&
          before.size <= BigInt(limit),
      )
      const bytes = source.read(limit)
      requireValue(bytes.length <= limit && BigInt(bytes.length) === before.size)
      requireValue(same(before, source.metadata()) && same(before, chain(name, "file")))
      return bytes
    } finally {
      source.close()
    }
  }
  const read = (entrySHA: string | undefined) => {
    try {
      requireValue(typeof entrySHA === "string" && /^[0-9a-f]{64}$/.test(entrySHA))
      // This exact system alias may resolve to its Root-owned versioned executable; never use PATH.
      const alias = reader.metadata(LinuxIsolation.PYTHON)
      requireValue(alias.uid === 0 && alias.gid === 0 && alias.links === 1n)
      const python = reader.canonical(LinuxIsolation.PYTHON)
      requireValue(/^\/usr\/bin\/python3(?:\.[0-9]+)?$/.test(python))
      const interpreter = chain(python, "file")
      requireValue(interpreter.links === 1n && (interpreter.mode & 0o111) !== 0)
      const asset = fixed(LinuxIsolation.ENTRY, 131_072)
      requireValue(createHash("sha256").update(asset).digest("hex") === entrySHA)
      const text = new TextDecoder("utf-8", { fatal: true }).decode(asset)
      requireValue(!text.includes("\0") && Buffer.from(text, "utf8").equals(asset))
      const spec = LinuxIsolation.decodeSpec(fixed(LinuxIsolation.SPEC, LinuxIsolation.LIMITS.metadataBytes))
      requireValue(
        same(alias, reader.metadata(LinuxIsolation.PYTHON)) &&
          reader.canonical(LinuxIsolation.PYTHON) === python &&
          same(interpreter, chain(python, "file")),
      )
      return Object.freeze({ python, spec })
    } catch {
      // Do not expose runtime paths, Root metadata, file contents or filesystem errors to a tool.
      throw new LinuxIsolation.Unavailable()
    }
  }
  return Object.freeze({
    read,
    plan(entrySHA: string | undefined, file: string, args: readonly string[], options: Options) {
      requireValue(
        process.platform === "linux" &&
          Array.isArray(options.stdio) &&
          options.stdio.length === 3 &&
          options.stdio.every((value) => ["pipe", "ignore", "inherit"].includes(value)) &&
          Array.isArray(options.additionalFDs) &&
          options.additionalFDs.length === 0,
      )
      const env = Object.freeze({ ...(options.env ?? process.env) })
      const runtime = read(entrySHA)
      const selected = LinuxIsolation.planLaunch(
        file,
        args,
        {
          platform: process.platform,
          parentPID: process.pid,
          cwd: options.cwd ?? process.cwd(),
          shell: options.shell,
          env,
          extraFDs: [],
        },
        runtime.spec,
      )
      return Object.freeze({
        file: selected.file,
        args: selected.args,
        options: Object.freeze({ cwd: options.cwd, env, shell: false as const }),
        isolation: "native" as const,
        cancellation: "native-owner" as const,
      })
    },
  })
}

const installed = create(system)
export const read = (entrySHA: string | undefined) => installed.read(entrySHA)
export const plan = (entrySHA: string | undefined, file: string, args: readonly string[], options: Options) =>
  installed.plan(entrySHA, file, args, options)

export * as ProcessIsolationRuntime from "./runtime"
