import { afterAll, afterEach, beforeAll, describe, expect } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Database } from "@vectordevai/core/database/database"
import { Global } from "@vectordevai/core/global"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import { SCOPE } from "@vectordevai/core/review/prompt"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { SessionInputTable } from "@vectordevai/core/session/sql"
import { SpendGuard } from "@vectordevai/core/spend-guard"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { ReviewRoutes } from "../../src/review/route"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Config } from "../../src/config/config"
import { Workspace } from "../../src/control-plane/workspace"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

// VS-23d (SF-15): the engine server holds the desktop's review sessions to the user config's review privacy. The
// desktop creates `vectorscope.<pass>` sessions and prompts them over HTTP (ai-review.ts), as these tests do, so no
// Review.run registers them; the HTTP prompt adopts them under "zdr" (ReviewRoutes.adopt), and the transport and the
// session runtime then refuse an unattested route before anything is sent. The user config is set as the app sets it,
// with PATCH /global/config. The fake model server is on this computer, the one route "zdr" allows without an
// attestation; `acme` is a provider on the internet that nothing attests, refused before any request.
//
// The registry and the user config files are process-global, and CI runs many files in one process (an engine shard),
// so nothing this file does outlives it: every session it creates is released after each case (a released "zdr"
// session stays refused, and no longer makes a malformed header refused process-wide), and the three user config files
// are put back as they were, or removed, once the file is done. The parity case runs first, with no user config file.

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([
    InstanceStore.node,
    Project.node,
    Session.node,
    Workspace.node,
    Database.node,
    Ripgrep.node,
    SpendGuard.node,
  ]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

// The user config files, as globalConfigFile() looks for them: PATCH /global/config writes the first that exists.
const globalFiles = ["vector.jsonc", "vector.json", "config.json"].map((name) => path.join(Global.Path.config, name))
const readGlobalFiles = () =>
  Promise.all(
    globalFiles.map(async (file) => ((await Bun.file(file).exists()) ? await Bun.file(file).text() : undefined)),
  )
const originals = await readGlobalFiles()
// Every session a case creates, released after it.
const created: string[] = []
beforeAll(async () => {
  await Promise.all(globalFiles.map((file) => rm(file, { force: true })))
})
afterEach(async () => {
  for (const id of created.splice(0)) ReviewRoutes.release(SessionID.make(id))
  await disposeAllInstances()
  await resetDatabase()
})
afterAll(async () => {
  await Promise.all(
    globalFiles.map((file, index) => {
      const original = originals[index]
      return original === undefined ? rm(file, { force: true }) : Bun.write(file, original)
    }),
  )
  // The process's own runtime reads the user config afresh, and what the next file finds is what was there before.
  await AppRuntime.runPromise(Config.use.invalidate())
  expect(await readGlobalFiles()).toEqual(originals)
  expect(unattributedHeld()).toBe(false)
})

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

const send = (route: string, body: unknown, method = "POST") =>
  request(route, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

// The user config's review block, as the app's settings write it; instances restart on the next request.
const setReview = (review: Record<string, unknown>) =>
  Effect.gen(function* () {
    expect((yield* send("/global/config", { review }, "PATCH")).status).toBe(200)
    yield* Effect.promise(() => disposeAllInstances())
  })

const ACME = {
  name: "Acme",
  id: "acme",
  env: [],
  npm: "@ai-sdk/openai-compatible",
  models: {
    coder: {
      id: "coder",
      name: "Coder",
      attachment: false,
      reasoning: false,
      temperature: false,
      tool_call: true,
      release_date: "2025-01-01",
      limit: { context: 100_000, output: 10_000 },
      cost: { input: 1, output: 2 },
      options: {},
    },
  },
  options: { apiKey: "test-key", baseURL: "https://models.invalid/v1" },
}

type Info = { id: string }
type Message = { info: { role: string; error?: { data?: { message?: string } } }; parts: { type: string }[] }

// A project with the fake model server and an unattested provider, and the desktop's calls against it.
const project = (llm: { url: string }) =>
  Effect.gen(function* () {
    const base = testProviderConfig(llm.url)
    const directory = yield* tmpdirScoped({
      trusted: true,
      git: true,
      config: {
        ...base,
        model: "lmstudio/test-model",
        provider: { ...base.provider, acme: ACME },
        command: { recheck: { template: "Review the change again." } },
      },
    })
    const at = (route: string) => `${route}?directory=${encodeURIComponent(directory)}`
    // A review pass's session, created as the desktop creates one.
    const create = (internal = "vectorscope.review") =>
      send(at("/session"), {
        title: "Vectorscope review · #7 · review",
        permission: reviewPermissionRules({}),
        internal,
      }).pipe(
        Effect.flatMap(json<Info>),
        Effect.tap((session) => Effect.sync(() => created.push(session.id))),
      )
    // The pass's prompt, as the desktop sends it: the pass's agent, the review model and the review scope.
    const body = (model: string, scope: Record<string, unknown> = {}) => {
      const [providerID, modelID] = model.split("/")
      return {
        agent: "review",
        model: { providerID, modelID },
        parts: [
          {
            type: "text",
            text: "Review this change.",
            metadata: { [SCOPE]: { paths: ["src/a.ts"], trust: "untrusted", ...scope } },
          },
        ],
      }
    }
    const prompt = (id: string, model: string, scope?: Record<string, unknown>) =>
      send(at(`/session/${id}/message`), body(model, scope)).pipe(Effect.flatMap(json<Message>))
    const promptAsync = (id: string, model: string) => send(at(`/session/${id}/prompt_async`), body(model))
    const idle = (id: string) =>
      pollWithTimeout(
        request(at("/session/status")).pipe(
          Effect.flatMap(json<Record<string, { type: string }>>),
          Effect.map((statuses) => (statuses[id]?.type === "busy" ? undefined : true)),
        ),
        "the session stayed busy",
      )
    return { directory, at, create, prompt, promptAsync, idle }
  })

const error = (message: Message) => message.info.error?.data?.message ?? ""
// Whether a request with a malformed session header would be refused process-wide: true once a "zdr" review is held.
const unattributedHeld = () =>
  ReviewRoutes.hold({
    session: () => ({}),
    model: { providerID: "lmstudio", id: "test-model" } as never,
    options: {},
    destinations: () => [],
  }) !== undefined

describe("the engine server's hold on the desktop's review sessions (VS-23d)", () => {
  it.live(
    "without a review block, or with privacy standard, nothing is registered and the requests are as before",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const desktop = yield* project(llm)
        expect(unattributedHeld()).toBe(false)
        const bodies: string[] = []
        for (const review of [
          undefined,
          { privacy: "standard" },
          { privacy: "standard", holdback: "off", zdrAttested: [] },
        ]) {
          if (review) yield* setReview(review)
          yield* llm.reset
          yield* llm.text("ok", { usage: { input: 1, output: 1 } })
          const session = yield* desktop.create()
          const answer = yield* desktop.prompt(session.id, "lmstudio/test-model")
          expect(error(answer)).toBe("")
          expect(ReviewRoutes.registered(session.id)).toBeUndefined()
          expect(ReviewRoutes.known(session.id)).toBe(false)
          const inputs = yield* llm.inputs
          expect(inputs).toHaveLength(1)
          bodies.push(JSON.stringify(inputs[0]).replaceAll(session.id, "<session>"))
        }
        expect(bodies[1]).toBe(bodies[0])
        expect(bodies[2]).toBe(bodies[0])
        expect(unattributedHeld()).toBe(false)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("under standard, a desktop prompt whose review settings ask for zdr is held: it can only raise", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const desktop = yield* project(llm)
      yield* setReview({ privacy: "standard", zdrAttested: [] })
      yield* llm.reset
      const refused = yield* desktop.create()
      const message = yield* desktop.prompt(refused.id, "acme/coder", { privacy: "zdr" })
      expect(error(message)).toContain("unattested-provider")
      expect(error(message)).toContain("Nothing was sent")
      expect(ReviewRoutes.registered(refused.id)?.decision).toEqual({ allowed: false, refusal: "unattested-provider" })
      expect(yield* llm.calls).toBe(0)

      yield* llm.text("ok", { usage: { input: 1, output: 1 } })
      const allowed = yield* desktop.create()
      const allowedID = SessionID.make(allowed.id)
      yield* Session.use.setMetadata({ sessionID: allowedID, metadata: { fixture: "keep" } }).pipe(
        provideInstanceEffect(desktop.directory),
      )
      expect(error(yield* desktop.prompt(allowed.id, "lmstudio/test-model", { privacy: "zdr" }))).toBe("")
      expect(ReviewRoutes.registered(allowed.id)).toMatchObject({
        policy: { privacy: "zdr", attested: [] },
        agent: "review",
        decision: { allowed: true, kind: "loopback" },
      })
      // The pass's own turn alone: no title or other helper request.
      expect(yield* llm.calls).toBe(1)
      const persisted = yield* Session.use.get(allowedID).pipe(provideInstanceEffect(desktop.directory))
      expect(persisted.metadata).toMatchObject({ fixture: "keep", "vector.review.zdr": true })
      yield* Session.use.setMetadata({ sessionID: allowedID, metadata: { fixture: "updated" } }).pipe(
        provideInstanceEffect(desktop.directory),
      )
      const updated = yield* Session.use.get(allowedID).pipe(provideInstanceEffect(desktop.directory))
      expect(updated.metadata).toMatchObject({ fixture: "updated", "vector.review.zdr": true })
      // A scope that says nothing lowers nothing either: the next session under standard is not held.
      yield* llm.text("ok", { usage: { input: 1, output: 1 } })
      const plain = yield* desktop.create()
      expect(error(yield* desktop.prompt(plain.id, "lmstudio/test-model"))).toBe("")
      expect(ReviewRoutes.known(plain.id)).toBe(false)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live(
    "under the user config's zdr, an unattested route is refused before anything is sent, on either prompt route",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const desktop = yield* project(llm)
        yield* setReview({ privacy: "zdr" })
        yield* llm.reset
        const refused = yield* desktop.create()
        const message = yield* desktop.prompt(refused.id, "acme/coder")
        expect(error(message)).toContain("unattested-provider")
        expect(ReviewRoutes.registered(refused.id)).toMatchObject({
          policy: { privacy: "zdr", attested: [] },
          agent: "review",
          decision: { allowed: false, refusal: "unattested-provider" },
        })
        // The verify pass's session, prompted without waiting, is adopted the same way.
        const verify = yield* desktop.create("vectorscope.verify")
        expect((yield* desktop.promptAsync(verify.id, "acme/coder")).status).toBe(204)
        yield* pollWithTimeout(
          Effect.sync(() => ReviewRoutes.registered(verify.id)),
          "the verify session was not adopted",
        )
        yield* desktop.idle(verify.id)
        expect(ReviewRoutes.registered(verify.id)?.decision).toEqual({ allowed: false, refusal: "unattested-provider" })
        expect(yield* llm.calls).toBe(0)

        // On the server on this computer the review runs, with the pass's own turn alone.
        yield* llm.text("ok", { usage: { input: 1, output: 1 } })
        const allowed = yield* desktop.create()
        expect(error(yield* desktop.prompt(allowed.id, "lmstudio/test-model"))).toBe("")
        expect(yield* llm.calls).toBe(1)
        // A session no review asked for is not held, whatever the user config says.
        yield* llm.text("ok", { usage: { input: 1, output: 1 } })
        const own = yield* send(desktop.at("/session"), { title: "Mine" }).pipe(
          Effect.flatMap(json<Info>),
          Effect.tap((session) => Effect.sync(() => created.push(session.id))),
        )
        expect(error(yield* desktop.prompt(own.id, "lmstudio/test-model"))).toBe("")
        expect(ReviewRoutes.known(own.id)).toBe(false)
        expect(yield* llm.calls).toBe(2)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live(
    "under zdr a review session run by a command, which adopts nothing, sends nothing and does not stay busy",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        const desktop = yield* project(llm)
        yield* setReview({ privacy: "zdr" })
        yield* llm.reset
        yield* llm.text("ok", { usage: { input: 1, output: 1 } })
        const session = yield* desktop.create()
        const response = yield* send(desktop.at(`/session/${session.id}/command`), {
          command: "recheck",
          arguments: "",
        })
        // The refusal is the run's, as the compaction refusal of a "zdr" review is: an internal error to this route, with
        // the user's message kept and the session idle again.
        expect(response.status).toBe(500)
        yield* desktop.idle(session.id)
        expect(ReviewRoutes.known(session.id)).toBe(false)
        expect(yield* llm.calls).toBe(0)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("a V1 command cannot reopen a recorded zdr review under standard privacy", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const desktop = yield* project(llm)
      yield* setReview({ privacy: "standard" })
      yield* llm.reset
      yield* llm.text("ok", { usage: { input: 1, output: 1 } })
      const session = yield* desktop.create()
      const sessionID = SessionID.make(session.id)
      yield* Session.use.setMetadata({ sessionID, metadata: { "vector.review.zdr": true } }).pipe(
        provideInstanceEffect(desktop.directory),
      )
      expect(ReviewRoutes.known(sessionID)).toBe(false)

      const response = yield* send(desktop.at(`/session/${sessionID}/command`), {
        command: "recheck",
        arguments: "",
      })
      expect(response.status).toBe(500)
      yield* desktop.idle(sessionID)
      expect(ReviewRoutes.known(sessionID)).toBe(false)
      expect(yield* llm.calls).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("a zdr session its review released is not adopted again, and stays refused", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const desktop = yield* project(llm)
      yield* setReview({ privacy: "zdr" })
      yield* llm.reset
      yield* llm.text("ok", { usage: { input: 1, output: 1 } })
      const session = yield* desktop.create()
      const id = SessionID.make(session.id)
      ReviewRoutes.register(id, { policy: { privacy: "zdr", attested: [] }, agent: "review" })
      ReviewRoutes.release(id)
      const message = yield* desktop.prompt(session.id, "lmstudio/test-model")
      expect(error(message)).toContain("unknown-destination")
      expect(ReviewRoutes.registered(id)).toBeUndefined()
      const persisted = yield* Session.use.get(id).pipe(provideInstanceEffect(desktop.directory))
      expect(persisted.metadata).toMatchObject({ "vector.review.zdr": true })
      expect(yield* llm.calls).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  // scope-finish takeover (2026-11-23): the V2 session API runs a session through @vectordevai/llm, which the route rules
  // do not see, so under zdr it refuses a `vectorscope.*` session before anything is stored or sent (core's
  // ReviewSessionAdmission port, read by the server package). It replaces the earlier pin of that hole as a known limit.
  it.live("under zdr the V2 session API refuses a review session's prompt and compaction before anything is sent", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const desktop = yield* project(llm)
      yield* setReview({ privacy: "zdr" })
      yield* llm.reset
      yield* llm.text("ok", { usage: { input: 1, output: 1 } })
      const session = yield* desktop.create()
      const refused = yield* send(desktop.at(`/api/session/${session.id}/prompt`), {
        prompt: { text: "Review this change." },
      })
      expect(refused.status).toBe(403)
      expect(yield* refused.text).toContain("zero data retention")
      const compacted = yield* send(desktop.at(`/api/session/${session.id}/compact`), {})
      expect(compacted.status).toBe(403)
      yield* desktop.idle(session.id)
      expect(ReviewRoutes.known(session.id)).toBe(false)
      expect(yield* llm.calls).toBe(0)
      // A session no review asked for is the V2 API's as before, whatever the review privacy says.
      const own = yield* send(desktop.at("/session"), { title: "Mine" }).pipe(
        Effect.flatMap(json<Info>),
        Effect.tap((mine) => Effect.sync(() => created.push(mine.id))),
      )
      const admitted = yield* send(desktop.at(`/api/session/${own.id}/prompt`), {
        prompt: { text: "hello" },
        resume: false,
      })
      expect(admitted.status).toBe(200)
      expect(yield* llm.calls).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("under standard the V2 session API admits a review session's prompt as before", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const desktop = yield* project(llm)
      yield* setReview({ privacy: "standard" })
      const session = yield* desktop.create()
      const admitted = yield* send(desktop.at(`/api/session/${session.id}/prompt`), {
        prompt: { text: "hello" },
        resume: false,
      })
      expect(admitted.status).toBe(200)
      expect(ReviewRoutes.known(session.id)).toBe(false)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.live("V2 refuses recorded zdr review histories without a live policy", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const desktop = yield* project(llm)
      const database = yield* Database.Service
      yield* setReview({ privacy: "standard" })
      yield* llm.reset

      const legacy = SessionID.make((yield* desktop.create()).id)
      const marked = SessionID.make((yield* desktop.create()).id)
      const historical = yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const info = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: legacy,
          agent: "review",
          model: { providerID: ProviderV2.ID.make("lmstudio"), modelID: ModelV2.ID.make("test-model") },
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          type: "text",
          sessionID: legacy,
          messageID: info.id,
          text: "Review this change.",
          metadata: { [SCOPE]: { paths: ["src/a.ts"], trust: "untrusted", privacy: "zdr" } },
        })
        yield* sessions.setMetadata({ sessionID: marked, metadata: { "vector.review.zdr": true } })
        return info.id
      }).pipe(provideInstanceEffect(desktop.directory))

      // These are existing database rows without any live registration, as when reopening prior review sessions.
      for (const sessionID of [legacy, marked]) {
        expect(ReviewRoutes.known(sessionID)).toBe(false)
        for (const [route, body] of [
          ["prompt", { prompt: { text: "Continue reviewing." }, resume: false }],
          ["free-models/resume", { messageID: historical, modelID: "test-model" }],
          ["compact", {}],
        ] as const) {
          const refused = yield* send(desktop.at(`/api/session/${sessionID}/${route}`), body)
          expect(refused.status).toBe(403)
          expect(yield* refused.text).toContain("zero data retention")
        }
        const inputs = yield* database.db
          .select({ id: SessionInputTable.id })
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, sessionID))
          .all()
        expect(inputs).toHaveLength(0)
      }
      expect(yield* llm.calls).toBe(0)
      // A resumed V1 prompt also keeps the policy if its new text brings no privacy setting.
      const resumed = yield* desktop.prompt(legacy, "acme/coder")
      expect(error(resumed)).toContain("unattested-provider")
      expect(yield* llm.calls).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )
})
