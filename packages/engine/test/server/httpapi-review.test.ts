import { $ } from "bun"
import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { clearTimeout, setTimeout } from "node:timers"
import { Cause, ConfigProvider, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { inArray } from "drizzle-orm"
import { HttpServer } from "effect/unstable/http"
import { createVectorClient } from "@vectordevai/sdk/v2"
import { GUEST_REQUEST_HEADER } from "@vectordevai/core/free-model-guests"
import { Global } from "@vectordevai/core/global"
import { decodeLocalRun } from "@vectordevai/core/review/local-result"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Database } from "@vectordevai/core/database/database"
import { BackgroundJobStore } from "@vectordevai/core/background-job-store"
import { Flag } from "@vectordevai/core/flag/flag"
import { SessionTable } from "@vectordevai/core/session/sql"
import { foreignReview } from "../../../core/test/fixture/review-deletion"
import { tmpdir } from "../../../core/test/fixture/tmpdir"
import { ReviewLocalRun } from "@/review/local-run"
import { Config } from "@/config/config"
import { AppNodeBuilderV1 } from "@/effect/app-node-builder-v1"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { InstanceHooks } from "@/project/instance-hooks"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { ReviewApiError } from "@/server/routes/instance/httpapi/groups/review"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { reply, TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { httpApiLayer } from "./httpapi-layer"

const parentID = SessionID.make("ses_local_review_http_parent")
const auth = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`
const owner = { authorization: auth("vector", "owner-secret") }
const guest = { authorization: auth("guest", "guest-secret") }
const forwarded = { ...owner, [GUEST_REQUEST_HEADER]: "1" }
const serverConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    VECTOR_SERVER_USERNAME: "vector",
    VECTOR_SERVER_PASSWORD: "owner-secret",
    VECTOR_SERVER_GUEST_USERNAME: "guest",
    VECTOR_SERVER_GUEST_PASSWORD: "guest-secret",
    VECTOR_SERVER_GUEST_SESSIONS: parentID,
    VECTOR_DISABLE_DEFAULT_PLUGINS: true,
  }),
)
const testLayer = Layer.mergeAll(
  httpApiLayer.pipe(Layer.provide(serverConfig)),
  TestLLMServer.layer,
  AppNodeBuilderV1.build(LayerNode.group([InstanceHooks.node, InstanceStore.node, Session.node])),
)
const it = testEffect(testLayer)
const fileIt = testEffect(
  Layer.unwrap(
    Effect.gen(function* () {
      const previous = Flag.VECTOR_AGENT_DB
      const temporary = yield* Effect.acquireRelease(Effect.promise(tmpdir), (directory) =>
        Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      Flag.VECTOR_AGENT_DB = path.join(temporary.path, "review-http.sqlite")
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          Flag.VECTOR_AGENT_DB = previous
        }),
      )
      // The ordinary engine preload selects :memory:. This one scenario requires
      // independent engine processes sharing actual committed SQLite state.
      return testLayer
    }),
  ),
)
const call = <A>(run: () => Promise<A>) => Effect.promise(run)
const linuxLive = process.platform === "linux" ? it.live : it.live.skip
const windowsLive = process.platform === "win32" ? it.live : it.live.skip
const git = (cwd: string, ...args: string[]) =>
  call(() => $`git ${args}`.cwd(cwd).quiet().text()).pipe(Effect.map((text) => text.trim()))
const report = (findings: unknown[] = []) => ({
  summary: "PRIVATE_RESULT_BODY_MARKER",
  risk: "low",
  files: [],
  findings,
})
const root = `/experimental/session/${parentID}/review`

const fixture = Effect.fn("ReviewHttpTest.fixture")(function* (enabled = true) {
  const llm = yield* TestLLMServer
  const directory = yield* tmpdirScoped({
    git: true,
    trusted: true,
    config: { ...testProviderConfig(llm.url), experimental: { vectorscope: true } },
    init: (directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(directory, ".vector"), { recursive: true })
          await fs.writeFile(
            path.join(directory, ".vector/review.json"),
            JSON.stringify({ security: "off", verify: "off" }),
          )
          await fs.writeFile(path.join(directory, "visible.ts"), "export const count = 1\n")
          await fs.writeFile(path.join(directory, "private.ts"), "export const privateCount = 1\n")
        })
        yield* git(directory, "config", "core.autocrlf", "false")
        yield* git(directory, "add", ".")
        yield* git(directory, "commit", "-qm", "review base")
      }),
  })
  const head = yield* git(directory, "rev-parse", "HEAD")
  expect(yield* git(directory, "remote")).toBe("")
  yield* Effect.promise(async () => {
    await fs.writeFile(path.join(directory, "visible.ts"), "export const count = 2\n")
    await fs.writeFile(path.join(directory, "private.ts"), "export const privateCount = 'WITHHELD_HTTP_CONTENT'\n")
  })
  const server = yield* HttpServer.HttpServer
  const baseUrl = HttpServer.formatAddress(server.address)
  const raw = (method: string, route: string, headers: Record<string, string> = owner, body?: unknown) =>
    call(() =>
      fetch(new URL(route, baseUrl), {
        method,
        headers: { "x-vector-directory": directory, ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  const file = path.join(Global.Path.config, "vector.json")
  const previous = yield* call(() =>
    fs.readFile(file).catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
      throw error
    }),
  )
  yield* Effect.addFinalizer(() =>
    call(async () => {
      if (previous === undefined) await fs.rm(file, { force: true })
      else await fs.writeFile(file, previous)
      Config.refreshLocal()
      Config.confirmLocal()
    }),
  )
  const configured = yield* raw("PATCH", "/global/config", owner, {
    experimental: { vectorscope: enabled },
    agent: { vectorscope: { model: "lmstudio/test-model", disable: false } },
  })
  expect(configured.status).toBe(200)
  const created = yield* call(() =>
    fetch(new URL("/api/session", baseUrl), {
      method: "POST",
      headers: { ...owner, "content-type": "application/json" },
      body: JSON.stringify({ id: parentID, title: "Local review owner", location: { directory } }),
    }),
  )
  expect(created.status, yield* call(() => created.text())).toBe(200)
  const sdk = createVectorClient({ baseUrl, directory, headers: owner, throwOnError: true })
  const request: ReviewRun.Start = { requestID: "request_http_local_1", target: { kind: "working-tree", head } }
  return { directory, raw, sdk, request, llm }
})

function data<S extends Schema.Top>(response: Response, schema: S) {
  expect(response.status).toBe(200)
  return call(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))
}
type Diagnostic = {
  passive: boolean
  case: "discovery" | "read-asks"
  phase: "fixture" | "post" | "get-run" | "get-list" | "idle"
  runID?: string
  runStatus: ReviewRun.Status | "unavailable"
  modelRequests: number | "unavailable"
  backgroundRunning: number | "unavailable"
  stores: Map<string, BackgroundJobStore.Interface>
  storeObserved: boolean
  jobStatus:
    | "unavailable"
    | "missing"
    | "running"
    | "completed"
    | "error"
    | "cancelled"
    | "interrupted"
    | "other"
    | "query-timeout"
    | "query-failed"
  sample?: Effect.Effect<void>
  calls?: Effect.Effect<number>
}
const diagnostic = (kind: Diagnostic["case"]): Diagnostic | undefined => {
  const mode = process.env.VECTOR_REVIEW_HTTP_DIAGNOSTICS
  if (mode !== "1" && mode !== "passive") return
  return {
    passive: mode === "passive",
    case: kind,
    phase: "fixture",
    runStatus: "unavailable",
    modelRequests: "unavailable",
    backgroundRunning: "unavailable",
    jobStatus: "unavailable",
    stores: new Map(),
    storeObserved: false,
  }
}
const captureDiagnostic = (state: Diagnostic | undefined, f: Effect.Success<ReturnType<typeof fixture>>) =>
  Effect.gen(function* () {
    if (!state) return
    state.calls = f.llm.calls
    if (state.passive) {
      state.phase = "idle"
      return
    }
    state.sample = Effect.gen(function* () {
      state.modelRequests = yield* f.llm.calls
      const store = state.stores.get(f.directory)
      state.storeObserved = store !== undefined
      if (!store) return
      const rows = yield* store.forParent(parentID)
      state.backgroundRunning = rows.filter((job) => job.status === "running").length
      if (!state.runID) return
      const job = rows.find((job) => job.id === state.runID)
      state.jobStatus = !job
        ? "missing"
        : ["running", "completed", "error", "cancelled", "interrupted"].includes(job.status)
          ? job.status
          : "other"
    })
    state.phase = "idle"
  })
const reportPassiveDiagnostic = (state: Diagnostic, trigger: "watchdog" | "failure") =>
  console.error(
    "review-http-diagnostic",
    JSON.stringify({
      mode: "passive",
      case: state.case,
      trigger,
      phase: state.phase,
      runStatus: state.runStatus,
      runKnown: state.runID !== undefined,
      // The captured test server implements this as Effect.sync(() => hits.length).
      modelRequests: state.calls ? Effect.runSync(state.calls) : "unavailable",
      backgroundRunning: "unavailable",
      storeObserved: false,
      jobStatus: "unavailable",
    }),
  )
const reportDiagnostic = (state: Diagnostic, trigger: "watchdog" | "failure") =>
  Effect.gen(function* () {
    const phase = state.phase
    yield* (state.sample ?? Effect.void).pipe(
      Effect.timeoutOrElse({
        duration: "250 millis",
        orElse: () =>
          Effect.sync(() => {
            state.jobStatus = "query-timeout"
          }),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.sync(() => {
              state.jobStatus = "query-failed"
            }),
      ),
    )
    yield* Effect.sync(() =>
      console.error(
        "review-http-diagnostic",
        JSON.stringify({
          case: state.case,
          trigger,
          phase,
          runStatus: state.runStatus,
          runKnown: state.runID !== undefined,
          modelRequests: state.modelRequests,
          backgroundRunning: state.backgroundRunning,
          storeObserved: state.storeObserved,
          jobStatus: state.jobStatus,
        }),
      ),
    )
  })
const diagnosed =
  (state: Diagnostic | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    if (!state) return effect
    if (state.passive)
      return Effect.acquireUseRelease(
        Effect.sync(() => setTimeout(() => reportPassiveDiagnostic(state, "watchdog"), 25_000).unref()),
        () =>
          effect.pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Effect.sync(() => reportPassiveDiagnostic(state, "failure")) : Effect.void,
            ),
          ),
        (timer) => Effect.sync(() => clearTimeout(timer)),
      )
    return Effect.gen(function* () {
      const hooks = yield* Effect.serviceOption(InstanceHooks.Service)
      if (Option.isSome(hooks))
        yield* hooks.value.register(
          `review-http-diagnostic-${state.case}`,
          Effect.gen(function* () {
            const instance = yield* InstanceRef
            const store = yield* Effect.serviceOption(BackgroundJobStore.Service)
            if (instance && Option.isSome(store)) state.stores.set(instance.directory, store.value)
          }),
        )
      const watchdog = yield* Effect.sleep("25 seconds").pipe(
        Effect.andThen(reportDiagnostic(state, "watchdog")),
        Effect.forkScoped,
      )
      return yield* effect.pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? reportDiagnostic(state, "failure") : Effect.void)),
        Effect.ensuring(Fiber.interrupt(watchdog)),
      )
    })
  }

function finished(f: Effect.Success<ReturnType<typeof fixture>>, runID: string, state?: Diagnostic) {
  const read = f.raw("GET", `${root}/${runID}`).pipe(Effect.flatMap((response) => data(response, ReviewRun.Info)))
  return pollWithTimeout(
    (state
      ? Effect.suspend(() => {
          state.phase = "get-run"
          return read.pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                state.runStatus = value.status
                state.phase = "idle"
              }),
            ),
          )
        })
      : read
    ).pipe(Effect.map((state) => (state.status === "running" ? undefined : state))),
    "Local review did not settle",
    "15 seconds",
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("owner local review HTTP boundary", () => {
  windowsLive("Windows owner HTTP refuses private Git admission before creating a helper or calling the model", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const before = (yield* call(() => f.sdk.session.list({ directory: f.directory, internal: true }))).data
      expect(before?.map((session) => session.id)).toEqual([parentID])
      const response = yield* f.raw("POST", root, owner, f.request)
      expect(response.status).toBe(400)
      const failure = yield* call(() => response.json()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ReviewApiError)),
      )
      expect(failure.code).toBe("placement")
      expect(failure.message).toContain("this host has no pinned-directory adapter")
      expect((yield* call(() => f.sdk.session.list({ directory: f.directory, internal: true }))).data).toEqual(before)
      expect(
        (yield* f.raw("GET", root).pipe(Effect.flatMap((response) => data(response, ReviewRun.List)))).runs,
      ).toEqual([])
      expect(yield* f.llm.calls).toBe(0)
    }),
  )

  fileIt.live(
    "deletion returns structured busy before changing foreign work, then denies the foreign process's late launch",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const sessions = yield* Session.Service
        const instances = yield* InstanceStore.Service
        // Internal placement is created only by the trusted server controller.
        // The public SDK deliberately cannot choose this helper identity.
        const run = yield* instances.provide(
          { directory: f.directory },
          sessions.create(
            {
              parentID,
              internal: ReviewLocalRun.MARKER,
              title: "Foreign prepared review",
              permission: [{ permission: "*", pattern: "*", action: "deny" }],
            },
            "owner",
          ),
        )
        const filename = Database.path()
        expect(filename).not.toBe(":memory:")
        const stored = yield* Effect.gen(function* () {
          const { db } = yield* Database.Service
          return yield* db
            .select({ id: SessionTable.id, parentID: SessionTable.parent_id, internal: SessionTable.internal })
            .from(SessionTable)
            .where(inArray(SessionTable.id, [parentID, run.id]))
            .all()
            .pipe(Effect.orDie)
        }).pipe(Effect.provide(Database.layerFromPath(filename)))
        expect(stored).toHaveLength(2)
        expect(stored).toContainEqual({ id: parentID, parentID: null, internal: null })
        expect(stored).toContainEqual({ id: run.id, parentID, internal: ReviewLocalRun.MARKER })
        const foreign = foreignReview({ filename, parentID, request: f.request, runID: run.id })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            foreign.stop()
          }),
        )
        yield* call(() => foreign.ready)
        const refused = yield* f.raw("DELETE", `/session/${parentID}`)
        expect(refused.status).toBe(409)
        expect(yield* call(() => refused.json())).toMatchObject({
          _tag: "SessionBusyError",
          sessionID: parentID,
          message: "Stop this review on its owning engine before deleting the conversation.",
        })
        expect((yield* call(() => f.sdk.session.get({ sessionID: parentID }))).data?.id).toBe(parentID)
        expect((yield* call(() => f.sdk.session.get({ sessionID: run.id }))).data?.id).toBe(run.id)
        expect(yield* f.llm.inputs).toHaveLength(0)
        foreign.settle()
        yield* call(() => foreign.settled)
        expect((yield* f.raw("DELETE", `/session/${parentID}`)).status).toBe(200)
        foreign.late()
        expect(yield* call(() => foreign.done)).toEqual({ lateAdmitted: false })
        expect(yield* f.llm.inputs).toHaveLength(0)
      }),
    30_000,
  )

  linuxLive("a repository flag cannot enable the owner's default-off service", () =>
    Effect.gen(function* () {
      const f = yield* fixture(false)
      const target = yield* f
        .raw("GET", `${root}/target`)
        .pipe(Effect.flatMap((response) => data(response, ReviewRun.Target)))
      expect(target).toEqual(f.request.target)
      expect((yield* f.raw("GET", `${root}/target?workspace=ws_forged_review_workspace`)).status).toBe(400)
      const response = yield* f.raw("POST", root, owner, f.request)
      expect(response.status).toBe(400)
      expect((yield* call(() => response.json())).code).toBe("disabled")
      const listed = yield* f.raw("GET", root).pipe(Effect.flatMap((response) => data(response, ReviewRun.List)))
      expect(listed.runs).toEqual([])
      expect(yield* f.llm.inputs).toHaveLength(0)
    }),
  )

  it.live("guests and forwarded guests cannot start, discover, read or stop even an authorized parent", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      for (const headers of [guest, forwarded]) {
        for (const [method, route, body] of [
          ["POST", root, f.request],
          ["GET", root, undefined],
          ["GET", `${root}/target`, undefined],
          ["GET", `${root}/ses_guessed_run`, undefined],
          ["POST", `${root}/ses_guessed_run/stop`, undefined],
        ] as const)
          expect((yield* f.raw(method, route, headers, body)).status).toBe(403)
      }
      expect(
        (yield* f.raw("GET", root).pipe(Effect.flatMap((response) => data(response, ReviewRun.List)))).runs,
      ).toEqual([])
      expect(yield* f.llm.inputs).toHaveLength(0)
    }),
  )

  it.live("a missing parent cannot bootstrap a requested project, including when new reviews are disabled", () =>
    Effect.gen(function* () {
      const boots: string[] = []
      const hooks = yield* InstanceHooks.Service
      yield* hooks.register(
        "review-http-parent-placement",
        Effect.gen(function* () {
          boots.push((yield* InstanceState.context).directory)
        }),
      )
      const f = yield* fixture(false)
      expect((yield* f.raw("GET", "/vcs")).status).toBe(200)
      // Prove this is the real server's bootstrap hook before using its absence
      // as evidence; a different service instance would fail this assertion.
      expect(boots).toContain(f.directory)
      boots.length = 0
      const elsewhere = yield* tmpdirScoped({ git: true })
      const missing = "/experimental/session/ses_missing_review_parent/review"
      for (const [method, route, body] of [
        ["POST", missing, f.request],
        ["GET", missing, undefined],
        ["GET", `${missing}/target`, undefined],
        ["GET", `${missing}/ses_unknown_review_run`, undefined],
        ["POST", `${missing}/ses_unknown_review_run/stop`, undefined],
      ] as const) {
        const response = yield* f.raw(method, route, { ...owner, "x-vector-directory": elsewhere }, body)
        expect(response.status).toBe(400)
        expect((yield* call(() => response.json())).code).toBe("not_found")
      }
      expect(boots).toEqual([])
      expect(yield* f.llm.inputs).toHaveLength(0)
      // A normal project operation still bootstraps that directory. This is a
      // scoped review guard, not a global change to ordinary routing behavior.
      expect((yield* f.raw("GET", "/vcs", { ...owner, "x-vector-directory": elsewhere })).status).toBe(200)
      expect(boots).toContain(elsewhere)
    }),
  )

  it.live("rejects unknown authority at HTTP decode before it can be silently stripped", () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      for (const field of [
        "directory",
        "parentID",
        "settingsRef",
        "readRoot",
        "readDenies",
        "model",
        "options",
        "trust",
        "checks",
        "post",
        "consent",
      ])
        expect((yield* f.raw("POST", root, owner, { ...f.request, [field]: "forged" })).status).toBe(400)
      expect(
        (yield* f.raw("POST", root, owner, {
          ...f.request,
          target: { ...f.request.target, base: f.request.target.head },
        })).status,
      ).toBe(400)
      expect((yield* f.raw("GET", `${root}?readDenies=forged`)).status).toBe(400)
      expect(
        (yield* f.raw("GET", root).pipe(Effect.flatMap((response) => data(response, ReviewRun.List)))).runs,
      ).toEqual([])
      expect(yield* f.llm.inputs).toHaveLength(0)
    }),
  )

  linuxLive(
    "local execution and bounded cross-client discovery need no GitHub connection and never leak result JSON in summaries",
    () => {
      const state = diagnostic("discovery")
      return Effect.gen(function* () {
        const f = yield* fixture()
        yield* captureDiagnostic(state, f)
        const ids: string[] = []
        for (let n = 0; n < 3; n++) {
          const request = { ...f.request, requestID: `request_http_page_${n}` }
          yield* f.llm.push(
            reply()
              .tool(
                "StructuredOutput",
                report([
                  {
                    path: "visible.ts",
                    line: 1,
                    severity: "blocking",
                    category: "bug",
                    title: "Fixture defect",
                    body: "Changed value has a concrete consequence.",
                    confidence: 1,
                  },
                ]),
              )
              .usage({ input: 120, output: 30 }),
          )
          if (state) {
            state.phase = "post"
            state.runID = undefined
            state.runStatus = "unavailable"
            state.jobStatus = "unavailable"
          }
          const started = yield* f
            .raw("POST", root, owner, request)
            .pipe(Effect.flatMap((response) => data(response, ReviewRun.Info)))
          if (state) {
            state.runID = started.runID
            state.runStatus = started.status
            state.phase = "idle"
          }
          ids.push(started.runID)
          const complete = yield* finished(f, started.runID, state)
          expect(complete.status).toBe("completed")
          const decoded = yield* call(() => decodeLocalRun(complete, { parentID, request, runID: started.runID }))
          expect(decoded?.result?.outcome?.selection.inline).toHaveLength(1)
          expect(decoded?.result?.outcome?.cost?.input).toBe(120)
          expect(decoded?.verdict.verdict).toBe("blocking")
          expect(complete.artifact?.json).toContain("PRIVATE_RESULT_BODY_MARKER")
          if (state) state.phase = "post"
          expect(
            (yield* f
              .raw("POST", root, owner, request)
              .pipe(Effect.flatMap((response) => data(response, ReviewRun.Info)))).runID,
          ).toBe(started.runID)
          if (state) state.phase = "idle"
        }
        const pages: string[] = []
        let cursor: string | undefined
        do {
          if (state) state.phase = "get-list"
          const response = yield* f.raw("GET", `${root}?limit=1${cursor ? `&cursor=${cursor}` : ""}`)
          expect(response.status).toBe(200)
          const text = yield* call(() => response.text())
          expect(text).not.toContain("PRIVATE_RESULT_BODY_MARKER")
          expect(text).not.toContain('"artifact"')
          expect(text).not.toContain('"json"')
          const parsed = Schema.decodeUnknownOption(ReviewRun.List)(JSON.parse(text))
          if (Option.isNone(parsed)) throw new Error("The owner discovery response must match its contract.")
          expect(parsed.value.runs).toHaveLength(1)
          expect(parsed.value.runs[0]!.hasResult).toBe(true)
          pages.push(parsed.value.runs[0]!.runID)
          cursor = parsed.value.next
          if (state) state.phase = "idle"
        } while (cursor)
        expect(new Set(pages)).toEqual(new Set(ids))
        expect(yield* f.llm.inputs).toHaveLength(3)
        if (state) state.phase = "get-list"
        expect((yield* f.raw("GET", `${root}?limit=51`)).status).toBe(400)
        if (state) state.phase = "idle"
      }).pipe(diagnosed(state))
    },
    30_000,
  )

  linuxLive(
    "the server derives inherited read asks and excludes protected payloads and tools",
    () => {
      const state = diagnostic("read-asks")
      return Effect.gen(function* () {
        const f = yield* fixture()
        yield* captureDiagnostic(state, f)
        if (state) state.phase = "fixture"
        yield* call(() =>
          f.sdk.session.update({
            sessionID: parentID,
            permission: [{ permission: "read", pattern: "private.ts", action: "ask" }],
          }),
        )
        if (state) state.phase = "idle"
        yield* f.llm.push(reply().tool("read", { filePath: "private.ts" }))
        yield* f.llm.push(reply().tool("StructuredOutput", report()))
        if (state) {
          state.phase = "post"
          state.runID = undefined
          state.runStatus = "unavailable"
          state.jobStatus = "unavailable"
        }
        const started = yield* f
          .raw("POST", root, owner, f.request)
          .pipe(Effect.flatMap((response) => data(response, ReviewRun.Info)))
        if (state) {
          state.runID = started.runID
          state.runStatus = started.status
          state.phase = "idle"
        }
        const complete = yield* finished(f, started.runID, state)
        const decoded = yield* call(() =>
          decodeLocalRun(complete, { parentID, request: f.request, runID: started.runID }),
        )
        expect(decoded?.verdict.verdict).toBe("incomplete")
        expect(decoded?.result?.outcome?.unreviewed).toContain("private.ts")
        expect(JSON.stringify(yield* f.llm.inputs)).not.toContain("WITHHELD_HTTP_CONTENT")
        expect(yield* f.llm.inputs).toHaveLength(2)
      }).pipe(diagnosed(state))
    },
    30_000,
  )

  linuxLive(
    "turning new reviews off still allows owned stop and retained partial read without another provider attempt",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* f.llm.push(reply().hang())
        const started = yield* f
          .raw("POST", root, owner, f.request)
          .pipe(Effect.flatMap((response) => data(response, ReviewRun.Info)))
        yield* f.llm.wait(1)
        expect((yield* f.raw("PATCH", "/global/config", owner, { experimental: { vectorscope: false } })).status).toBe(
          200,
        )
        const stopped = yield* f
          .raw("POST", `${root}/${started.runID}/stop`)
          .pipe(Effect.flatMap((response) => data(response, ReviewRun.Info)))
        expect(stopped.status).toBe("cancelled")
        const decoded = yield* call(() =>
          decodeLocalRun(stopped, { parentID, request: f.request, runID: started.runID }),
        )
        expect(decoded?.verdict.verdict).toBe("incomplete")
        expect(decoded?.result?.outcome?.partial).toBe("timeout")
        expect(
          (yield* f
            .raw("GET", `${root}/${started.runID}`)
            .pipe(Effect.flatMap((response) => data(response, ReviewRun.Info)))).artifact,
        ).toEqual(stopped.artifact)
        expect((yield* f.raw("POST", root, owner, { ...f.request, requestID: "request_disabled_new" })).status).toBe(
          400,
        )
        expect(yield* f.llm.inputs).toHaveLength(1)
      }),
    30_000,
  )

  linuxLive(
    "wrong-parent, nested-parent and different-project requests never retarget an admitted review",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        yield* f.llm.push(reply().tool("StructuredOutput", report()))
        const started = yield* f
          .raw("POST", root, owner, f.request)
          .pipe(Effect.flatMap((response) => data(response, ReviewRun.Info)))
        yield* finished(f, started.runID)
        const other = (yield* call(() => f.sdk.session.create({ title: "Different owner parent" }))).data!
        const wrong = `/experimental/session/${other.id}/review/${started.runID}`
        expect((yield* f.raw("GET", wrong)).status).toBe(400)
        expect((yield* f.raw("POST", `${wrong}/stop`)).status).toBe(400)
        const child = (yield* call(() => f.sdk.session.create({ title: "Nested helper", parentID }))).data!
        expect((yield* f.raw("POST", `/experimental/session/${child.id}/review`, owner, f.request)).status).toBe(400)
        const elsewhere = yield* tmpdirScoped({ git: true })
        const misplaced = yield* f.raw("POST", root, { ...owner, "x-vector-directory": elsewhere }, f.request)
        // The shared routing middleware resolves an existing parent's own
        // directory before the header. An exact retry stays on that parent;
        // the unrelated directory never retargets or restarts its model work.
        const joined = yield* data(misplaced, ReviewRun.Info)
        expect(joined.runID).toBe(started.runID)
        expect(joined.request).toEqual(f.request)
        expect(yield* f.llm.inputs).toHaveLength(1)
      }),
    30_000,
  )
})
