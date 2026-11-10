export * as BrainWorker from "./host"

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { BrainWorkerEntry } from "./entry"
import { BrainWorkerProtocol } from "./protocol"
import { BrainOcr } from "../document/ocr"

// Where documents are read: a worker thread, so a file that sends a parser into a loop or makes it grow can be stopped
// without stopping the engine. The worker is started from its bundled source as an eval worker, which runs the same
// way under Bun (the CLI), Node and Electron's utility process (the desktop engine) and needs no second file inside the
// signed app. From source under Bun it starts from entry.ts itself. When no worker can start, or one keeps dying,
// documents are read on the main thread instead under tighter limits, and `status` says why.
//
// The same worker runs the local search model. Its files are sent once per worker, and every load is checked against
// the model's pinned canary vectors before a vector is used. A request's query goes ahead of the background queue, so
// it waits for at most the one passage being embedded. Embedding never runs on the main thread outside tests: once
// documents are read there, search stays with keywords and code links.

export class ExtractError extends Schema.TaggedErrorClass<ExtractError>()("BrainWorker.ExtractError", {
  /** timeout: stopped for taking too long; crashed: the worker died; failed: the reader threw; invalid: bad answer. */
  reason: Schema.Literals(["timeout", "crashed", "failed", "invalid"]),
  message: Schema.String,
}) {}

export class EmbedError extends Schema.TaggedErrorClass<EmbedError>()("BrainWorker.EmbedError", {
  /**
   * off: no worker here, so no embedding; check: the model gave vectors other than its pinned ones on this computer;
   * timeout, crashed, failed, invalid: as for reading.
   */
  reason: Schema.Literals(["off", "check", "timeout", "crashed", "failed", "invalid"]),
  message: Schema.String,
}) {}

/** A model as the worker loads it: its files are read again whenever a new worker needs them. */
export type EmbedModel = {
  /** The model, revision and graph (BrainEmbedManifest.key). */
  readonly key: string
  readonly settings: BrainWorkerProtocol.EmbedSettings
  readonly files: () => Promise<{
    readonly wasm: Uint8Array
    readonly model: Uint8Array
    readonly data?: Uint8Array
    readonly dataName?: string
    readonly tokenizer: string
    readonly config: string
  }>
  /** Sentences with the vectors the pinned model gives them. */
  readonly canaries: readonly BrainWorkerProtocol.Load["canaries"][number][]
  /** The least cosine every canary must reach for the load to count. */
  readonly threshold: number
}

/** How a load's check went: the canaries' cosines against their pinned vectors. */
export type Check = {
  readonly key: string
  readonly cosines: readonly number[]
  readonly passed: boolean
  readonly ms: number
}

export type Refused = {
  readonly type: "refused"
  readonly reason: BrainWorkerProtocol.Refusal
  readonly message: string
}

export type Status = {
  readonly mode: "worker" | "in-process"
  /** Why documents are read on the main thread, in words for Settings. */
  readonly reason?: string
  /** Worker threads alive now. */
  readonly threads: number
  /** The search model the running worker holds, if any. */
  readonly loaded?: string
  /** The last load's check. */
  readonly check?: Check
}

export type Input = { readonly name: string; readonly bytes: Uint8Array; readonly mime?: string }

export interface Interface {
  readonly extract: (
    input: Input & { readonly repository: string; readonly lineage: string; readonly document: string },
  ) => Effect.Effect<
    { readonly type: "extracted"; readonly structured: BrainWorkerProtocol.Structured } | Refused,
    ExtractError
  >
  readonly probe: (
    input: Input,
  ) => Effect.Effect<{ readonly type: "probed"; readonly probe: BrainWorkerProtocol.Probed } | Refused, ExtractError>
  readonly status: () => Effect.Effect<Status>
  /**
   * Vectors for texts, L2-normalised. The model is loaded first when the running worker does not hold it, and the load
   * fails with reason "check" when its canaries do not match. A query goes ahead of background work.
   */
  readonly embed: (input: {
    readonly model: EmbedModel
    readonly texts: readonly string[]
    readonly role: "query" | "passage"
    readonly priority: "query" | "background"
  }) => Effect.Effect<readonly Float32Array[], EmbedError>
  /** Whether the running worker holds this model now, so a query would not wait for a load. */
  readonly loaded: (key: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@vector/BrainWorker") {}

/** The worker's bundled source. A build provides it (the engine carries it as a string); from source there is none. */
export class Source extends Context.Service<Source, { readonly load: Effect.Effect<string | undefined> }>()(
  "@vector/BrainWorkerSource",
) {}

export type Options = {
  /** Milliseconds a new worker has to say it is ready. */
  readonly ready?: number
  /** Milliseconds a document may take to read, by kind, before its worker is stopped. */
  readonly timeout?: { readonly pdf: number; readonly other: number }
  /** Milliseconds a worker with nothing to do stays alive. */
  readonly idle?: number
  /** Read on the main thread only, as tests do. */
  readonly inline?: boolean
  /** Milliseconds a model may take to load and a background batch to embed, before its worker is stopped. */
  readonly embed?: { readonly load: number; readonly batch: number }
}

const DEFAULTS = {
  ready: 5_000,
  timeout: { pdf: 120_000, other: 30_000 },
  idle: 5 * 60_000,
  embed: { load: 120_000, batch: 60_000 },
}

// Node and Electron honour these; Bun ignores them, so there the readers' own caps and terminate are the guard.
const RESOURCES = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 }

/**
 * Two crashes this close together that no one document explains (the reader died with nothing to read, or on two
 * different files) and documents are read on the main thread for the rest of the process.
 */
const CRASH_WINDOW = 10 * 60_000

const ENTRY = new URL("./entry.ts", import.meta.url)

export const layerWith = (options: Options = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const source = yield* Source
      const bundled = yield* source.load
      const host = make(bundled, options)
      yield* Effect.addFinalizer(() => Effect.sync(host.close))
      return host.service
    }),
  )

export const layer = layerWith()

/** Reads on the main thread, with no worker: what tests of the knowledge store use. */
export const layerInline = Layer.effect(
  Service,
  Effect.gen(function* () {
    const host = make(undefined, { inline: true })
    yield* Effect.addFinalizer(() => Effect.sync(host.close))
    return host.service
  }),
)

/** No bundled source: replaced by the engine, whose builds carry one. */
export const sourceNode = makeGlobalNode({
  service: Source,
  layer: Layer.succeed(Source, Source.of({ load: Effect.succeed(undefined) })),
  deps: [],
})

export const node = makeGlobalNode({ service: Service, layer, deps: [sourceNode] })

function make(bundled: string | undefined, options: Options) {
  const ocr = new Map<Worker, ReturnType<typeof BrainOcr.host>>()
  const ready = options.ready ?? DEFAULTS.ready
  const timeout = options.timeout ?? DEFAULTS.timeout
  const idle = options.idle ?? DEFAULTS.idle
  const limits = options.embed ?? DEFAULTS.embed
  // From source under Bun the worker can start from entry.ts; anywhere else it needs the bundled source.
  const fromSource = bundled === undefined && Boolean(process.versions.bun) && existsSync(fileURLToPath(ENTRY))
  const state: {
    worker?: Worker
    starting?: Promise<Worker>
    mode: Status["mode"]
    reason?: string
    threads: number
    /** When the reader died, and the file it was reading then, by the hash of its bytes. */
    crashes: { readonly at: number; readonly file?: string }[]
    next: number
    waiting: Map<
      number,
      { resolve: (message: unknown) => void; reject: (error: ExtractError) => void; bytes?: Uint8Array }
    >
    timer?: ReturnType<typeof setTimeout>
    /** Calls waiting on the worker now; it is stopped for idleness only once none is. */
    busy: number
    /** The model the running worker (or, inline, this thread) holds. */
    loaded?: string
    check?: Check
  } = {
    mode: options.inline || (bundled === undefined && !fromSource) ? "in-process" : "worker",
    ...(options.inline
      ? { reason: "Tests read documents on the main thread." }
      : bundled === undefined && !fromSource
        ? { reason: "This build of Vector does not include its background reader." }
        : {}),
    threads: 0,
    crashes: [],
    next: 1,
    waiting: new Map(),
    busy: 0,
  }
  const lock = Semaphore.makeUnsafe(1)
  // Loading and background batches, one at a time; a query takes neither lock.
  const embedding = Semaphore.makeUnsafe(1)

  // One worker failed for good: whatever waited on it fails. A file that kills the reader is that file's doing, and it
  // must never be read on the main thread, so the same file dying again counts once; only crashes that no one file
  // explains end worker mode.
  const crashed = (worker: Worker, message: string) => {
    ocr.get(worker)?.close()
    ocr.delete(worker)
    if (state.worker === worker) {
      state.worker = undefined
      state.loaded = undefined
    }
    const waiting = [...state.waiting.values()]
    state.waiting.clear()
    const now = Date.now()
    const read = waiting.find((item) => item.bytes)?.bytes
    const file = read ? createHash("sha256").update(read).digest("hex") : undefined
    state.crashes = [
      ...state.crashes.filter((crash) => now - crash.at < CRASH_WINDOW && (!file || crash.file !== file)),
      { at: now, ...(file ? { file } : {}) },
    ]
    if (state.crashes.length >= 2) fallBack("Vector's background reader stopped twice in 10 minutes.")
    // Last, since a waiting read may carry on at once.
    waiting.forEach((item) => item.reject(new ExtractError({ reason: "crashed", message })))
  }

  const fallBack = (reason: string) => {
    state.mode = "in-process"
    state.reason = reason
    stop()
  }

  const stop = () => {
    clearTimeout(state.timer)
    const worker = state.worker
    state.worker = undefined
    state.starting = undefined
    if (!options.inline) state.loaded = undefined
    if (worker) {
      ocr.get(worker)?.close()
      ocr.delete(worker)
      void worker.terminate()
    }
  }

  const start = () =>
    new Promise<Worker>((resolve, reject) => {
      const worker =
        bundled !== undefined
          ? new Worker(bundled, { eval: true, execArgv: [], resourceLimits: RESOURCES })
          : new Worker(ENTRY, { execArgv: [], resourceLimits: RESOURCES })
      ocr.set(worker, BrainOcr.host(worker))
      state.threads++
      // An idle worker never keeps a CLI process alive; a request's own timer does while it waits.
      worker.unref()
      const started = { done: false }
      const timer = setTimeout(() => {
        void worker.terminate()
        reject(new Error(`it did not start within ${Math.round(ready / 1000)} seconds`))
      }, ready)
      worker.on("message", (message: unknown) => {
        if (!started.done && isReady(message)) {
          started.done = true
          clearTimeout(timer)
          resolve(worker)
          return
        }
        const id = typeof message === "object" && message !== null && "id" in message ? message.id : undefined
        const waiting = typeof id === "number" ? state.waiting.get(id) : undefined
        if (!waiting || typeof id !== "number") return
        state.waiting.delete(id)
        waiting.resolve(message)
      })
      worker.on("error", (error) => {
        if (!started.done) {
          clearTimeout(timer)
          reject(error)
          return
        }
        crashed(worker, error.message)
      })
      worker.on("exit", () => {
        ocr.get(worker)?.close()
        ocr.delete(worker)
        state.threads--
        if (state.worker === worker && started.done) crashed(worker, "Vector's background reader stopped.")
      })
    })

  // The running worker, started on first use. A worker that cannot start ends worker mode for this process.
  const running = Effect.fnUntraced(function* () {
    if (state.worker) return state.worker
    state.starting ??= start()
    const worker = yield* Effect.tryPromise({
      try: () => state.starting!,
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }).pipe(
      Effect.catch((message: string) => {
        fallBack(`Vector's background reader could not start here: ${message}`)
        return Effect.logWarning("brain reader runs on the main thread", { reason: state.reason }).pipe(
          Effect.as(undefined),
        )
      }),
    )
    state.starting = undefined
    if (worker && state.mode === "worker") {
      state.worker = worker
      yield* Effect.logInfo("brain reader started in a worker thread", {
        source: bundled === undefined ? "file" : "bundle",
      })
    }
    return state.mode === "worker" ? worker : undefined
  })

  const send = (worker: Worker, request: BrainWorkerProtocol.Request) =>
    Effect.callback<unknown, ExtractError>((resume) => {
      state.waiting.set(request.id, {
        resolve: (message) => resume(Effect.succeed(message)),
        reject: (error) => resume(Effect.fail(error)),
        ...(request.type === "extract" || request.type === "probe" ? { bytes: request.bytes } : {}),
      })
      worker.postMessage(request)
      return Effect.sync(() => state.waiting.delete(request.id))
    })

  const call = (request: BrainWorkerProtocol.Request, ms: number) => lock.withPermit(ask(request, ms))

  // One request to the worker, or to this thread when there is none. A timed-out request stops the worker, as a hung
  // reader must be stopped; `patient` leaves it running and only stops waiting, as a late query is still useful work.
  const ask = (request: BrainWorkerProtocol.Request, ms: number, patient = false) =>
    Effect.gen(function* () {
      clearTimeout(state.timer)
      state.busy++
      const worker = state.mode === "worker" ? yield* running() : undefined
      const late = new ExtractError({
        reason: "timeout",
        message: `Reading took longer than ${Math.round(ms / 1000)} seconds, so Vector stopped it.`,
      })
      // On the main thread a read cannot be stopped from outside, so it is told to stop: the readers give the event
      // loop a turn after every page and every 200 blocks there, and stop at the next one once the time is up.
      const abort = new AbortController()
      const answer = worker
        ? yield* send(worker, request).pipe(
            Effect.timeoutOrElse({
              duration: ms,
              orElse: () => (patient ? Effect.fail(late) : Effect.sync(stop).pipe(Effect.andThen(Effect.fail(late)))),
            }),
          )
        : yield* Effect.promise(() =>
            BrainWorkerEntry.handle(
              request.type === "extract" || request.type === "probe" ? { ...request, limits: "inline" } : request,
              abort.signal,
            ),
          ).pipe(
            Effect.timeoutOrElse({
              duration: ms,
              orElse: () => Effect.sync(() => abort.abort()).pipe(Effect.andThen(Effect.fail(late))),
            }),
          )
      const decoded = Schema.decodeUnknownOption(BrainWorkerProtocol.Response)(answer)
      if (Option.isNone(decoded) || !("id" in decoded.value) || decoded.value.id !== request.id)
        return yield* new ExtractError({
          reason: "invalid",
          message: "Vector's background reader gave an answer it could not use.",
        })
      if (decoded.value.type === "failed")
        return yield* new ExtractError({ reason: "failed", message: decoded.value.message })
      return decoded.value
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state.busy--
          if (!state.worker || state.busy > 0) return
          const current = state.worker
          clearTimeout(state.timer)
          state.timer = setTimeout(() => {
            if (state.worker === current && state.busy === 0) stop()
          }, idle)
          state.timer.unref?.()
        }),
      ),
    )

  const id = () => state.next++

  // A worker's answer as an embedding error: what went wrong reading becomes what went wrong embedding.
  const embedError = (error: ExtractError) =>
    new EmbedError({
      reason: error.reason,
      message:
        error.reason === "timeout"
          ? "The search model took too long, so Vector stopped it."
          : error.reason === "crashed"
            ? "Vector's background reader stopped while it ran the search model."
            : error.message,
    })

  // The model into the running worker (or this thread, inline), with its canaries checked against their pinned vectors.
  const load = Effect.fnUntraced(function* (model: EmbedModel) {
    if (state.loaded === model.key) return
    const files = yield* Effect.tryPromise({
      try: () => model.files(),
      catch: (error) =>
        new EmbedError({
          reason: "failed",
          message: `Vector could not read the search model's files: ${error instanceof Error ? error.message : String(error)}`,
        }),
    })
    const answer = yield* ask(
      {
        id: id(),
        type: "load",
        key: model.key,
        wasm: files.wasm,
        model: files.model,
        ...(files.data ? { data: files.data } : {}),
        ...(files.dataName ? { dataName: files.dataName } : {}),
        tokenizer: files.tokenizer,
        config: files.config,
        settings: model.settings,
        canaries: model.canaries,
      },
      limits.load,
    ).pipe(Effect.mapError(embedError))
    if (answer.type !== "loaded")
      return yield* new EmbedError({ reason: "invalid", message: "Vector's background reader answered out of turn." })
    const passed =
      answer.dims === model.settings.dims &&
      answer.cosines.length === model.canaries.length &&
      answer.cosines.every((cosine) => cosine >= model.threshold)
    state.check = { key: model.key, cosines: answer.cosines, passed, ms: answer.ms }
    if (!passed)
      return yield* new EmbedError({
        reason: "check",
        message: `The search model gave different vectors on this computer than it should (lowest match ${Math.min(...answer.cosines, 1).toFixed(3)}, needed ${model.threshold}).`,
      })
    state.loaded = model.key
    yield* Effect.logInfo("brain search model loaded", { key: model.key, ms: Math.round(answer.ms), mode: state.mode })
  })

  const vectors = Effect.fnUntraced(function* (
    model: EmbedModel,
    texts: readonly string[],
    role: "query" | "passage",
    priority: "query" | "background",
  ) {
    if (texts.length === 0) return [] as Float32Array[]
    const answer = yield* ask(
      { id: id(), type: "embed", key: model.key, texts: [...texts], role },
      limits.batch,
      priority === "query",
    ).pipe(Effect.mapError(embedError))
    if (
      answer.type !== "embedded" ||
      answer.dims !== model.settings.dims ||
      answer.vectors.length !== texts.length * answer.dims
    )
      return yield* new EmbedError({
        reason: "invalid",
        message: "Vector's background reader gave vectors it could not use.",
      })
    return texts.map((_, index) => answer.vectors.slice(index * answer.dims, (index + 1) * answer.dims))
  })

  const service = Service.of({
    extract: Effect.fn("BrainWorker.extract")(function* (input) {
      const answer = yield* call(
        {
          id: id(),
          type: "extract",
          name: input.name,
          bytes: input.bytes,
          ...(input.mime ? { mime: input.mime } : {}),
          repository: input.repository,
          lineage: input.lineage,
          document: input.document,
          limits: "worker",
        },
        isPdf(input) ? timeout.pdf : timeout.other,
      )
      if (answer.type === "refused") return { type: "refused" as const, reason: answer.reason, message: answer.message }
      if (answer.type !== "extracted")
        return yield* new ExtractError({
          reason: "invalid",
          message: "Vector's background reader answered out of turn.",
        })
      return { type: "extracted" as const, structured: answer.result }
    }),
    probe: Effect.fn("BrainWorker.probe")(function* (input) {
      const answer = yield* call(
        {
          id: id(),
          type: "probe",
          name: input.name,
          bytes: input.bytes,
          ...(input.mime ? { mime: input.mime } : {}),
          limits: "worker",
        },
        isPdf(input) ? timeout.pdf : timeout.other,
      )
      if (answer.type === "refused") return { type: "refused" as const, reason: answer.reason, message: answer.message }
      if (answer.type !== "probed")
        return yield* new ExtractError({
          reason: "invalid",
          message: "Vector's background reader answered out of turn.",
        })
      return { type: "probed" as const, probe: answer.result }
    }),
    status: () =>
      Effect.sync(() => ({
        mode: state.mode,
        ...(state.reason ? { reason: state.reason } : {}),
        threads: state.threads,
        ...(state.loaded ? { loaded: state.loaded } : {}),
        ...(state.check ? { check: state.check } : {}),
      })),
    embed: Effect.fn("BrainWorker.embed")(function* (input) {
      if (state.mode !== "worker" && !options.inline)
        return yield* new EmbedError({
          reason: "off",
          message: `Search by meaning needs Vector's background reader, which is not running here: ${state.reason ?? "unknown reason"}`,
        })
      // A query never waits for a load or for the background queue: it runs beside them, and the worker answers it
      // after the one item it may be busy with.
      if (input.priority === "query") {
        if (state.loaded !== input.model.key)
          return yield* new EmbedError({ reason: "off", message: "The search model is not loaded yet." })
        return yield* vectors(input.model, input.texts, input.role, "query")
      }
      return yield* embedding.withPermit(
        Effect.gen(function* () {
          yield* load(input.model)
          return yield* vectors(input.model, input.texts, input.role, "background")
        }),
      )
    }),
    loaded: (key) => Effect.sync(() => state.loaded === key && (options.inline === true || state.worker !== undefined)),
  })

  return { service, close: stop }
}

function isReady(message: unknown) {
  return typeof message === "object" && message !== null && "type" in message && message.type === "ready"
}

// pdf.js takes a header anywhere in the first kilobyte, so that is where a PDF is told by its bytes.
function isPdf(input: Input) {
  return new TextDecoder("latin1").decode(input.bytes.subarray(0, 1024)).includes("%PDF-")
}
