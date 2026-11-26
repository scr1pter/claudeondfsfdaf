// Host-owned diagnostic adapters see a read-only JSON view of admitted changed text. The untrusted checkout,
// system root, home, plugins, configuration and network are never mounted. Only the SF-08 scoped collector launches
// the process; interruption and scope release retain exactly its existing owner and output bound.
import { createHash } from "node:crypto"
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Context, Effect } from "effect"
import type { DiffFile } from "@vectordevai/core/review/diff"
import { heldReason, holdbackFiles, holdbackText } from "@vectordevai/core/review/holdback"

export type PinnedDiagnostic = Readonly<{
  id: string
  version: string
  sha256: string
  executable: Uint8Array
  argv: readonly string[]
}>
const emptyPins: readonly PinnedDiagnostic[] = Object.freeze([])
// Only the host trust boundary supplies this service. A repository, CLI argument or model cannot register an adapter.
export const DiagnosticCatalog = Context.Reference<readonly PinnedDiagnostic[]>("ReviewFix.DiagnosticCatalog", {
  defaultValue: () => emptyPins,
})
const MAX_BINARY = 16 * 1024 * 1024
const MAX_INPUT = 256 * 1024
const MAX_OUTPUT = 32 * 1024
const MAX_TIME = 10_000
const TTL = 5 * 60_000
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
const safePath = (name: string) =>
  !!name &&
  name.length <= 1024 &&
  name.isWellFormed() &&
  !/[\u0000-\u001f\u007f\\]/u.test(name) &&
  !name.split("/").some((part) => !part || part === "." || part === "..") &&
  !heldReason(name) &&
  holdbackText(name) === name

function project(files: readonly DiffFile[]) {
  if (files.length > 128) return
  const included = files.filter(
    (file) => !file.binary && safePath(file.path) && (!file.oldPath || safePath(file.oldPath)),
  )
  let size = 0
  for (const file of included) {
    size += file.patch.length + file.path.length
    if (size > MAX_INPUT || file.hunks.length > 1024) return
    for (const hunk of file.hunks) {
      size += hunk.header.length + 1
      if (size > MAX_INPUT) return
      for (const line of hunk.lines) {
        size += line.text.length + 1
        if (size > MAX_INPUT) return
      }
    }
  }
  const clean = holdbackFiles(included, { ignored: [] }).files
  const json = JSON.stringify({
    version: 1,
    changes: clean.map((file) => ({
      path: file.path,
      hunks: file.hunks.map((hunk) => ({
        lines: hunk.lines.map((line) => ({ kind: line.kind, line: line.newLine ?? line.oldLine, text: line.text })),
      })),
    })),
  })
  return Buffer.byteLength(json) <= MAX_INPUT ? json : undefined
}

type Refusal = { status: "not-run"; reason: string }
function refused(reason: string): Refusal {
  return { status: "not-run", reason: "Diagnostics not run: " + reason + "." }
}

export interface DiagnosticPreview {
  readonly adapter: string
  readonly version: string
  readonly sha256: string
  readonly argv: readonly string[]
  readonly head: string
  readonly inputDigest: string
  readonly inputBytes: number
  readonly timeoutMs: number
  readonly outputBytes: number
  readonly network: "off"
}
export interface DiagnosticConsent {
  readonly kind: "diagnostic-consent"
}

export interface ScopedCommand {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs: number
  outputBytes: number
}

async function launcher(): Promise<"/usr/bin/bwrap" | undefined> {
  // No PATH search or environment override. The fixed parent directories and program must be root-owned and
  // immutable to ordinary users, and symlinks are not admitted. No repository path can name this launcher.
  for (const file of ["/", "/usr", "/usr/bin", "/usr/bin/bwrap"]) {
    const info = await lstat(file)
    if (info.uid !== 0 || info.mode & 0o022 || (file.endsWith("/bwrap") ? !info.isFile() : !info.isDirectory())) return
  }
  return "/usr/bin/bwrap"
}

export function makeDiagnosticAdapters<E>(
  launch: (command: ScopedCommand) => Effect.Effect<
    {
      exitCode: number | null
      timedOut: boolean
      output: string
      truncated: boolean
    },
    E
  >,
  platform: Effect.Effect<NodeJS.Platform>,
  available: () => Promise<"/usr/bin/bwrap" | undefined> = launcher,
) {
  const issued = new WeakMap<DiagnosticPreview, { payload: string; program: Uint8Array; expires: number }>()
  const grants = new WeakMap<DiagnosticConsent, { preview: DiagnosticPreview; actor: string; expires: number }>()
  const preview = Effect.fnUntraced(function* (input: { adapter: string; head: string; files: readonly DiffFile[] }) {
    if ((yield* platform) !== "linux" || process.platform !== "linux") return refused("Linux isolation is unavailable")
    if (!/^[a-f0-9]{40}$/.test(input.head)) return refused("the exact review head is unavailable")
    const catalog = yield* DiagnosticCatalog
    const matches = catalog.filter((item) => item.id === input.adapter)
    const item = matches[0]
    if (!item || matches.length !== 1) return refused("no owner-pinned adapter is available")
    if (
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) ||
      !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,48})?$/.test(item.version) ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      item.executable.byteLength < 4 ||
      item.executable.byteLength > MAX_BINARY ||
      item.argv.length > 32 ||
      item.argv.some(
        (word) => typeof word !== "string" || !word || word.length > 256 || /[\u0000-\u001f\u007f]/u.test(word),
      )
    )
      return refused("the host adapter pin is invalid")
    const program = Uint8Array.from(item.executable)
    if (
      hash(program) !== item.sha256 ||
      !Buffer.from(program.subarray(0, 4)).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    )
      return refused("the executable does not match the pinned Linux binary")
    const payload = project(input.files)
    if (payload === undefined) return refused("the input exceeds its bound")
    const plan: DiagnosticPreview = Object.freeze({
      adapter: item.id,
      version: item.version,
      sha256: item.sha256,
      argv: Object.freeze([...item.argv]),
      head: input.head,
      inputDigest: hash(payload),
      inputBytes: Buffer.byteLength(payload),
      timeoutMs: MAX_TIME,
      outputBytes: MAX_OUTPUT,
      network: "off",
    })
    issued.set(plan, { program, payload, expires: Date.now() + TTL })
    return { status: "ready" as const, preview: plan }
  })

  // Trusted UI/CLI code calls this only after showing this exact preview and authenticating the actor. A handle is
  // an opaque in-process capability. Neither replayed JSON nor another preview/actor can consume it.
  function approve(plan: DiagnosticPreview, actor: string): DiagnosticConsent | undefined {
    const record = issued.get(plan)
    if (!record || record.expires <= Date.now() || !actor || actor.length > 256) return
    const grant = Object.freeze({ kind: "diagnostic-consent" as const })
    grants.set(grant, { preview: plan, actor, expires: record.expires })
    return grant
  }

  const run = Effect.fnUntraced(function* (input: {
    preview: DiagnosticPreview
    actor: string
    consent: DiagnosticConsent
    signal?: AbortSignal
  }) {
    const { preview: plan, signal } = input
    if ((yield* platform) !== "linux" || process.platform !== "linux") return refused("Linux isolation is unavailable")
    const authorization = grants.get(input.consent)
    const prepared = issued.get(plan)
    if (
      !prepared ||
      !authorization ||
      authorization.preview !== plan ||
      authorization.actor !== input.actor ||
      authorization.expires <= Date.now()
    )
      return refused("this operation needs its own current approval")
    if (signal?.aborted) return refused("the operation was cancelled")
    const bwrap = yield* Effect.promise(() => available().catch(() => undefined))
    if (!bwrap) return refused("the trusted sandbox launcher is unavailable")
    // There was an await: consume immediately before the first effect, checking the identical live objects a second
    // time. Concurrent or repeated attempts cannot run once another attempt has spent this approval.
    if (
      grants.get(input.consent) !== authorization ||
      issued.get(plan) !== prepared ||
      authorization.expires <= Date.now()
    )
      return refused("this operation needs its own current approval")
    grants.delete(input.consent)
    issued.delete(plan)
    const job = Effect.acquireUseRelease(
      Effect.tryPromise(() => mkdtemp("/tmp/vector-diagnostic-")),
      (dir) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise(() =>
            writeFile(path.join(dir, "adapter"), prepared.program, { flag: "wx", mode: 0o500 }),
          )
          yield* Effect.tryPromise(() =>
            writeFile(path.join(dir, "change.json"), prepared.payload, { flag: "wx", mode: 0o400 }),
          )
          const result = yield* launch({
            command: bwrap,
            // No shell, exposed /proc, devices, host root, home, runtime libraries, inherited PATH or repository.
            // Dynamic programs have no interpreter here and fail closed. Only a self-contained fixed binary can run.
            args: [
              "--die-with-parent",
              "--unshare-all",
              "--cap-drop",
              "ALL",
              "--clearenv",
              "--tmpfs",
              "/",
              "--dir",
              "/tool",
              "--dir",
              "/input",
              "--ro-bind",
              path.join(dir, "adapter"),
              "/tool/adapter",
              "--ro-bind",
              path.join(dir, "change.json"),
              "/input/change.json",
              "--chdir",
              "/input",
              "--remount-ro",
              "/",
              "--",
              "/tool/adapter",
              ...plan.argv,
            ],
            cwd: dir,
            env: {},
            timeoutMs: plan.timeoutMs,
            outputBytes: plan.outputBytes,
          })
          if (result.timedOut) return refused("the adapter exceeded its time limit")
          if (result.truncated || Buffer.byteLength(result.output) > MAX_OUTPUT)
            return refused("the adapter exceeded its output limit")
          if (result.exitCode !== 0) return refused("the sandbox or pinned adapter failed")
          const output = holdbackText(result.output)
          if (Buffer.byteLength(output) > MAX_OUTPUT) return refused("the redacted output exceeded its limit")
          return {
            status: "ran" as const,
            adapter: plan.adapter,
            version: plan.version,
            output,
          }
        }),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    ).pipe(Effect.catch(() => Effect.succeed(refused("the sandbox or pinned adapter is unavailable"))))
    if (!signal) return yield* job
    const cancelled = Effect.callback<Refusal>((resume) => {
      const abort = () => resume(Effect.succeed(refused("the operation was cancelled")))
      if (signal.aborted) {
        abort()
        return
      }
      signal.addEventListener("abort", abort, { once: true })
      return Effect.sync(() => signal.removeEventListener("abort", abort))
    })
    return yield* Effect.raceFirst(job, cancelled)
  })
  return Object.freeze({ preview, approve, run })
}
