// The generated workflow's route and mint feed a real in-process agent, then the real isolated Git publisher.
// Models, GitHub and Vector HTTP are fixtures. V16 separately proves the actual runner/UID boundary. A follow-up on the
// same issue continues the conversation its first run saved (V27): the fake GitHub lists and serves it as the runner's
// `vector-session-<thread>` upload, and the runner's FD3 attestation is injected (V16's session-replaced job proves the
// real one).
import { afterAll, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js"
import { Database } from "@vectordevai/core/database/database"
import { EventV2 } from "@vectordevai/core/event"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { ProjectV2 } from "@vectordevai/core/project"
import { PublicSessionShare } from "@vectordevai/core/public-session-share"
import { GITHUB_WORKFLOW_VERSION, buildAgentsWorkflow } from "@vectordevai/core/review/workflow"
import { SessionAudience } from "@vectordevai/core/session/audience"
import { SessionArchive } from "@vectordevai/core/share/archive"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import {
  SESSION_NOT_RESTORED,
  SESSION_NOT_SAVED,
  SESSION_RESTORED,
  SESSION_SAVED,
  SESSION_TOO_LARGE,
  githubAgentPhase,
  type SessionExport,
  type SessionImport,
} from "../../src/cli/cmd/github.agent"
import { mintRunToken, verifyGithubRun, type Services } from "../../src/cli/cmd/github.cloud"
import { prepareGithubEnvironment } from "../../src/cli/cmd/github.environment"
import { createPublishGit, publishBundle, type PublishApi } from "../../src/cli/cmd/github.publish"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"
import { decryptConversation, encryptConversation } from "../../src/cli/cmd/github.session"
import { InstanceRef } from "../../src/effect/instance-ref"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { LLMRequestPrep } from "../../src/session/llm/request"
import { SessionRetry } from "../../src/session/retry"
import { SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { runtime, setup } from "../lib/research"
import {
  ARTIFACT_KEY,
  CHANNEL,
  OWNER,
  REPO,
  REPOSITORY_ID,
  RUN_ID,
  STORAGE,
  VALUES,
  cleanup,
  codiumFakes,
  comment,
  commitSetup,
  eventFile,
  fakeClock,
  fakeGithub,
  folder,
  git,
  holder,
  issueData,
  resetTree,
  stepEnv,
  type FakeArtifact,
  type Recorded,
} from "./github.agent-fixture"

type RouteScript = (github: unknown, context: unknown, core: unknown) => Promise<void>
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => RouteScript
type WorkflowStep = { id?: string; env?: Record<string, string>; with?: { script?: string } }
type Workflow = { jobs: Record<string, { env?: Record<string, string>; steps: WorkflowStep[] }> }
type Scenario = "codium" | "stopped" | "at-once" | "stranger" | "own-key"
type Test = Effect.Success<ReturnType<typeof setup>>
type Cloud = { requests: { method: string; path: string; authorization: string | null; body: unknown }[] }

const guard = NetworkGuard.use()
const web = FakeWeb.start({ sites: {} })
const codium = codiumFakes()
const it = runtime(web, { replacements: codium.replacements })
afterAll(async () => {
  LLMRequestPrep.pin(undefined)
  SessionRetry.pinGateway(undefined)
  await web.close()
  await cleanup()
})

const WRITER = { id: 101, login: "alice", type: "User" }
const TASK = { id: 3, body: "/vector write the notes" }
const NOTES = "Repository notes.\n"
const MARKER = "RUN-ONE-MARKER"
const FOLLOW_UP = "4243"
const SAVED_AT = "2026-11-16T12:00:00Z"
const QUESTIONS = [{ permission: "question", action: "deny" as const, pattern: "*" }]
const SESSION_LINES: string[] = [
  SESSION_RESTORED,
  SESSION_NOT_RESTORED,
  SESSION_SAVED,
  SESSION_NOT_SAVED,
  SESSION_TOO_LARGE,
]
// P6 (INV-P1): no plan id or label, no billing state, and none of the fake gateway's words in anything public. The
// unanchored words also catch "disputed" or "payment_failed_at"; "payment" alone is anchored, so the fixture memory's
// "payments" sentence (which the posting check drops) is not a billing word.
const P6 =
  /dispute|fraud|past_due|payment_failed|\bpayment\b|\bclosing\b|vector-(?:10|50|100|200)|\b(?:Plus|Pro|Max|Ultra) plan|fixture gateway|credits/i
// Codium only: an own-key run's provider costs remain evidence, while Codium's amounts and usage figures never enter
// its public output.
const AMOUNT = /[$€£]\s*\d/
const PERCENT = /\b\d+(?:\.\d+)?\s*%/
// The at-once refusal's message, which no real mint sends (2.8 "Errors"): every billing word, a plan, an amount and a
// usage figure, so the scan's channels are shown to hold none of it.
const BILLING =
  "past_due after payment_failed; dispute and fraud review; closing. Pro plan vector-50, credits $20, 80% used"
// The words codiumFakes' refusal carries (github.agent-fixture.ts), which the stopped scenario's queue sends.
const GATEWAY_WORDS = "fixture gateway words: credits, plan, $9"

for (const scenario of ["codium", "stopped", "at-once", "stranger", "own-key"] as const) {
  // Successful workflow jobs use Linux private-file guarantees; the pure stranger route works on any host.
  const journeyCase = process.platform === "linux" || scenario === "stranger" ? it.instance : it.instance.skip
  journeyCase(
    `GitHub workflow journey ${scenario} preserves route, run and publication authority`,
    () =>
      Effect.gen(function* () {
        const test = yield* setup()
        const repo = yield* repository(test)
        const ownKey = scenario === "own-key"
        codium.reset({
          codium: !ownKey,
          target: test.llm.url,
          ...(scenario === "stopped"
            ? {
                queue: [
                  { kind: "forward" as const },
                  { kind: "refuse" as const, status: 429, code: "MODEL_PLAN_DAILY_LIMIT" },
                ],
              }
            : {}),
        })
        if (scenario === "stranger") {
          const routed = yield* Effect.promise(() =>
            route(generated(false).script, {
              base: repo.base,
              run: RUN_ID,
              payload: issueComment(TASK),
              permission: "read",
            }),
          )
          expect(routed.outputs.kind).toBe("none")
          expect(codium.state.requests).toEqual([])
          expect(yield* test.llm.inputs).toEqual([])
          expectPublic(JSON.stringify(routed), true)
          expect(guard.outside()).toEqual([])
          return
        }
        // Own key (INV-K1): everything a Codium save and restore reach before their key request is there (a forced
        // session proof, the job's repository and run ids, an export and an import that record and die, a listed
        // session artifact, and a share whose every method records and dies), so the mode alone keeps them unused.
        // Own key holds no run token, so a key request itself would still answer absent.
        const used: string[] = []
        const stale = ownKey ? yield* Effect.promise(() => artifactZip(Buffer.from("not a conversation"))) : undefined
        const run = yield* pass({
          test,
          ...repo,
          scenario,
          ...(stale
            ? {
                artifacts: [{ id: 30, name: GithubAgents.sessionArtifact("17"), created_at: SAVED_AT, zip: stale }],
                share: share(used),
              }
            : {}),
          turns: Effect.gen(function* () {
            yield* test.llm.tool("write", { filePath: path.join(test.dir, "NOTES.md"), content: NOTES })
            if (scenario !== "stopped") yield* test.llm.text("Wrote repository notes.")
          }),
        })
        expect(run.status).toBe(scenario === "at-once" ? "at-once" : "ok")
        // INV-K1, in one comparison so a failure shows every channel at once: the loopback vectordev.ai saw no
        // /api/cloud-agents/* request and the client sent none, nothing reached the Codium gateway
        // (ModelPlans.CHAT_URL, /api/model-plans/chat), GitHub's artifacts were never listed or downloaded, and
        // nothing was exported, imported, shared, attested, written as session.vsa or logged as a session line.
        if (ownKey)
          expect({
            cloud: run.cloud.requests,
            urls: run.cloud.urls,
            gateway: codium.state.requests,
            artifacts: artifactRequests(run.github.seen),
            transport: run.github.transport,
            seams: run.seams,
            used,
            attested: run.attested,
            out: run.out,
            lines: sessionLines(run.lines),
          }).toEqual({
            cloud: [],
            urls: [],
            gateway: [],
            artifacts: [],
            transport: [],
            seams: { export: [], import: [] },
            used: [],
            attested: [],
            out: ["patch.diff", "summary.json"],
            lines: [],
          })
        if (scenario === "at-once") {
          expect(run.published.outcome).toBe("refused")
          yield* Effect.promise(run.publish)
          expect(run.posts).toHaveLength(1)
          expect(run.posts[0]!.body).toContain("<!-- vector:at-once -->")
          expect(run.pulls).toEqual([])
          expect(run.authority.acquired).toBe(0)
          expect(codium.state.requests).toEqual([])
          expect(run.cloud.requests.length).toBeGreaterThan(0)
          expect(run.cloud.requests.filter((request) => request.path !== GithubAgents.ENDPOINT.mint)).toEqual([])
          // Regex sanity: the refusal message the mint answered holds every word the scan looks for.
          expect(BILLING).toMatch(P6)
          expect(BILLING).toMatch(AMOUNT)
          expect(BILLING).toMatch(PERCENT)
        } else {
          expect(run.result).toMatchObject({ exitCode: 0, outcome: scenario === "stopped" ? "draft" : "changes" })
          expect(run.published.outcome).toBe(scenario === "stopped" ? "draft" : "changes")
          expect(run.pulls).toHaveLength(1)
          expect(run.pulls[0]!.draft).toBe(scenario === "stopped")
          expect(yield* Effect.promise(() => git(repo.remote, ["show", `${run.pulls[0]!.head}:NOTES.md`]))).toBe(
            "Repository notes.",
          )
          expect(run.authority).toEqual({ acquired: 1, disposed: 1 })
        }
        if (scenario === "codium" || scenario === "stopped") {
          // Without the runner's session proof a Codium run saves and restores nothing and asks for no key.
          expect(run.out).toEqual(["patch.diff", "summary.json"])
          expect(run.attested).toEqual([])
          expect(sessionLines(run.lines)).toEqual([])
          expect(calls(run.cloud)).toEqual([GithubAgents.ENDPOINT.mint, GithubAgents.ENDPOINT.settle])
          expect(run.cloud.requests.at(-1)?.body).toEqual({ outcome: scenario === "stopped" ? "draft" : "changes" })
        }
        // Regex sanity: the stopped scenario's gateway refusal carries words the scan finds.
        if (scenario === "stopped") expect(GATEWAY_WORDS).toMatch(P6)
        expectPublic(run.publicText, !ownKey)
        expect(guard.outside()).toEqual([])
      }),
    { git: true },
    30_000,
  )
}

const followUp = process.platform === "linux" ? it.instance : it.instance.skip
followUp(
  "GitHub workflow journey follow-up continues its issue thread's saved conversation and posts nothing restored",
  () =>
    Effect.gen(function* () {
      const test = yield* setup()
      const repo = yield* repository(test)
      const used: string[] = []
      const conversations = share(used, yield* sessionArchive())
      const sessions = yield* Session.Service
      const audience = SessionAudience.make(yield* Database.Service)
      codium.reset({ codium: true, target: test.llm.url })
      const first = comment(3, "alice", "/vector write the notes")
      const one = yield* pass({
        test,
        ...repo,
        scenario: "codium",
        run: RUN_ID,
        comment: TASK,
        comments: [first],
        artifacts: [],
        proof: true,
        share: conversations,
        turns: Effect.gen(function* () {
          yield* test.llm.tool("bash", { command: "echo lint-run-one", description: "Run the lint check" })
          yield* test.llm.tool("write", { filePath: path.join(test.dir, "NOTES.md"), content: NOTES })
          yield* test.llm.text(`${MARKER} wrote repository notes.`)
        }),
      })
      // Run 1: nothing to continue yet; its conversation is saved, attested and kept beside the bundle.
      expect(one.status).toBe("ok")
      expect(one.result).toMatchObject({ exitCode: 0, outcome: "changes" })
      expect(sessionLines(one.lines)).toEqual([SESSION_NOT_RESTORED, SESSION_SAVED])
      expect(one.out).toEqual(["patch.diff", GithubAgents.SESSION_FILE, "summary.json"])
      expect(one.saved).toBeDefined()
      expect(one.attested).toEqual([one.saved!])
      expect(calls(one.cloud)).toEqual([
        GithubAgents.ENDPOINT.mint,
        GithubAgents.ENDPOINT.artifactKey,
        GithubAgents.ENDPOINT.settle,
      ])
      expect(keyBodies(one.cloud)).toEqual([{ thread: "17" }])
      expect(one.cloud.requests.at(-1)?.body).toEqual({ outcome: "changes" })
      expect(one.cloud.masks).toContain(ARTIFACT_KEY.key)
      // The list found nothing, so no zip was downloaded and no key was asked for a restore.
      expect(artifactRequests(one.github.seen)).toEqual([listRequest])
      const opened = yield* Effect.promise(() =>
        decryptConversation({
          bytes: one.saved!,
          key: ARTIFACT_KEY,
          expected: { repositoryId: REPOSITORY_ID, thread: "17", rid: rid(RUN_ID) },
        }),
      )
      if (!opened) throw new Error("Run 1's saved conversation does not open.")
      expect(opened.header).toMatchObject({
        keyId: ARTIFACT_KEY.keyId,
        repositoryId: REPOSITORY_ID,
        thread: "17",
        rid: rid(RUN_ID),
      })
      expect(opened.manifest.files.map((file) => file.path)).toEqual(["session.json"])
      expect(JSON.stringify(opened.session)).toContain(MARKER)
      expect(JSON.stringify(opened.session)).toContain("echo lint-run-one")
      expect(JSON.stringify(opened.session)).not.toContain(CHANNEL.runToken)
      expect(one.pulls).toHaveLength(1)
      expect(one.pulls[0]).toMatchObject({ head: "vector/issue17-4242-1", draft: false })
      // The check's evidence; its markup's escaping by the publisher (V21) is the lead's (deviations BT08a item 1).
      expect(one.pulls[0]!.body).toContain("echo lint-run-one")
      expect(one.pulls[0]!.body).toContain("(exit 0)")
      expect(yield* Effect.promise(() => git(repo.remote, ["show", "vector/issue17-4242-1:NOTES.md"]))).toBe(
        "Repository notes.",
      )

      // The runner's upload of run 1's conversation, re-sealed under a session id this database never saw, as a hosted
      // runner's fresh database sees every saved id (deviations BT06 item 14): only `info.id` differs.
      const session = opened.session as { info: Record<string, unknown> }
      const source = SessionID.descending()
      const zip = yield* Effect.promise(() =>
        encryptConversation({
          identity: { repositoryId: REPOSITORY_ID, thread: "17", rid: rid(RUN_ID) },
          key: ARTIFACT_KEY,
          session: { ...session, info: { ...session.info, id: source } },
        }).then(artifactZip),
      )
      const entries = yield* Effect.promise(async () => {
        const reader = new ZipReader(new Uint8ArrayReader(zip), { useWebWorkers: false, useCompressionStream: false })
        const listed = await reader.getEntries()
        const files = await Promise.all(
          listed.map(async (entry) => ({ name: entry.filename, bytes: await entry.getData?.(new Uint8ArrayWriter()) })),
        )
        await reader.close()
        return files
      })
      expect(entries.map((entry) => entry.name)).toEqual([GithubAgents.SESSION_FILE])
      const served = yield* Effect.promise(() =>
        decryptConversation({
          bytes: entries[0]?.bytes ?? new Uint8Array(),
          key: ARTIFACT_KEY,
          expected: { repositoryId: REPOSITORY_ID, thread: "17", rid: rid(RUN_ID) },
        }),
      )
      expect(served?.header.rid).toBe(rid(RUN_ID))
      const back = served?.session as { info: Record<string, unknown> }
      expect(back.info.id).toBe(source)
      expect(opened.session).toEqual({ ...back, info: { ...back.info, id: session.info.id } })
      expect(yield* audience.knows(source)).toBe(false)
      const kept = {
        info: yield* sessions.get(one.sessionID as SessionID),
        messages: yield* sessions.messages({ sessionID: one.sessionID as SessionID }),
      }
      yield* test.llm.reset
      codium.reset({})

      const two = yield* pass({
        test,
        ...repo,
        scenario: "codium",
        run: FOLLOW_UP,
        comment: { id: 4, body: "/vector add a summary" },
        comments: [first, comment(4, "alice", "/vector add a summary")],
        artifacts: [{ id: 30, name: GithubAgents.sessionArtifact("17"), created_at: SAVED_AT, zip }],
        proof: true,
        share: conversations,
        turns: Effect.gen(function* () {
          yield* test.llm.tool("write", { filePath: path.join(test.dir, "NOTES.md"), content: NOTES })
          yield* test.llm.text("RUN-TWO wrote the notes again.")
        }),
      })
      expect(two.status).toBe("ok")
      expect(two.result).toMatchObject({ exitCode: 0, outcome: "changes" })
      expect(sessionLines(two.lines)).toEqual([SESSION_RESTORED, SESSION_SAVED])
      // Run 2's first model request carries run 1's history, its check among it, before the new comment.
      const firstRequest =
        (yield* test.llm.inputs)
          .map((body) => JSON.stringify(body))
          .find((body) => !body.includes("Generate a title for this conversation")) ?? ""
      expect(firstRequest).toContain(MARKER)
      expect(firstRequest).toContain("echo lint-run-one")
      expect(firstRequest.indexOf(MARKER)).toBeLessThan(firstRequest.lastIndexOf("add a summary"))
      // A new session, imported with no fork lineage and given the question rule; run 1's own session is untouched.
      expect(two.sessionID).toBeDefined()
      expect(two.sessionID).not.toBe(source)
      expect(two.sessionID).not.toBe(one.sessionID)
      expect(two.sessionID).not.toBe(session.info.id)
      expect(yield* audience.knows(source)).toBe(false)
      expect({
        info: yield* sessions.get(one.sessionID as SessionID),
        messages: yield* sessions.messages({ sessionID: one.sessionID as SessionID }),
      }).toEqual(kept)
      expect((yield* sessions.get(two.sessionID as SessionID)).permission).toEqual(QUESTIONS)
      // GitHub: the list with the job's token, then artifact 30's zip; signed storage got no authorization.
      expect(artifactRequests(two.github.seen)).toEqual([
        listRequest,
        {
          method: "GET",
          path: `/repos/${OWNER}/${REPO}/actions/artifacts/30/zip`,
          authorization: `Bearer ${CHANNEL.githubToken}`,
        },
      ])
      expect(two.github.storage).toEqual([
        { url: `${STORAGE}/artifacts/30?sig=fixture`, method: "GET", authorization: null },
      ])
      expect(two.github.transport.every((entry) => entry.method === "GET")).toBe(true)
      // The restore's key and the save's, each for the thread, then the settle.
      expect(calls(two.cloud)).toEqual([
        GithubAgents.ENDPOINT.mint,
        GithubAgents.ENDPOINT.artifactKey,
        GithubAgents.ENDPOINT.artifactKey,
        GithubAgents.ENDPOINT.settle,
      ])
      expect(keyBodies(two.cloud)).toEqual([{ thread: "17" }, { thread: "17" }])
      expect(two.cloud.requests.at(-1)?.body).toEqual({ outcome: "changes" })
      // Run 2 saved the continued conversation for the next follow-up: both runs' turns, under its own run id.
      expect(two.out).toEqual(["patch.diff", GithubAgents.SESSION_FILE, "summary.json"])
      expect(two.attested).toEqual([two.saved!])
      const next = yield* Effect.promise(() =>
        decryptConversation({
          bytes: two.saved ?? new Uint8Array(),
          key: ARTIFACT_KEY,
          expected: { repositoryId: REPOSITORY_ID, thread: "17", rid: rid(FOLLOW_UP) },
        }),
      )
      expect(JSON.stringify(next?.session)).toContain(MARKER)
      expect(JSON.stringify(next?.session)).toContain("RUN-TWO")
      // Nothing restored was logged, counted as run 2's evidence or published: run 2 runs no bash, so neither its text
      // nor its check can appear there.
      const restored = (text: string) => text.includes(MARKER) || text.includes("lint-run-one")
      expect(two.lines.filter(restored)).toEqual([])
      expect(two.pulls).toHaveLength(1)
      expect(two.pulls[0]).toMatchObject({ head: "vector/issue17-4243-1", draft: false })
      expect(two.pulls[0]!.body).not.toContain("lint-run-one")
      expect(two.pulls[0]!.body).not.toContain(MARKER)
      expect(two.pulls[0]!.body).toContain("_No test, typecheck, lint or build commands were run._")
      expect(two.posts.filter((post) => restored(post.body))).toEqual([])
      expect(yield* Effect.promise(() => git(repo.remote, ["show", "vector/issue17-4243-1:NOTES.md"]))).toBe(
        "Repository notes.",
      )
      // The save and the restore used only the archive's export and import, never a sharing endpoint (2.13).
      expect(used).toEqual([])
      expectPublic(one.publicText, true)
      expectPublic(two.publicText, true)
      expect(guard.outside()).toEqual([])
    }),
  { git: true },
  120_000,
)

/**
 * One workflow run on issue 17 through the generated file: the route script, the mint against the loopback
 * vectordev.ai, the agent phase with the channel loaded directly, the bundle as the runner hands it to publish, and the
 * publisher against an in-memory GitHub API and the bare remote. `turns` is queued only when the mint answered ok.
 * With `proof` the Codium holder is loaded as the hosted launcher starts it, so the run saves and restores its
 * conversation (V27) through the fake GitHub's artifacts and `share`'s archive. An own-key run gets an export and an
 * import that record and die, a forced session proof and VECTOR_RUN_ID, so only its mode keeps them unused (INV-K1).
 */
const pass = Effect.fn("AgentsJourney.pass")(function* (input: {
  test: Test
  base: string
  remote: string
  scenario: Exclude<Scenario, "stranger">
  run?: string
  comment?: { id: number; body: string }
  comments?: unknown[]
  artifacts?: FakeArtifact[]
  proof?: true
  share?: PublicSessionShare.Interface
  turns: Effect.Effect<void>
}) {
  const ownKey = input.scenario === "own-key"
  const run = input.run ?? RUN_ID
  const trigger = input.comment ?? TASK
  const dir = input.test.dir
  // Each run starts from the base with a clean tree: an earlier run's publisher committed its result locally.
  yield* Effect.promise(async () => {
    await git(dir, ["reset", "-q", "--hard", input.base])
    await clearOut(dir)
  })
  const workflow = generated(ownKey)
  const payload = issueComment(trigger)
  const routed = yield* Effect.promise(() =>
    route(workflow.script, { base: input.base, run, payload, permission: "write" }),
  )
  expect(routed.outputs).toMatchObject({ kind: "task", pr: "17", thread: "17", ref: input.base })
  const github = fakeGithub({
    roles: { alice: "write" },
    threads: [
      {
        number: 17,
        kind: "issue",
        data: issueData({
          title: "Write repository notes",
          body: "Document the change.",
          author: "alice",
          comments: input.comments,
        }),
      },
    ],
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
  })
  const scratch = yield* Effect.promise(() => folder("vector-journey-cloud-"))
  const clock = fakeClock(Date.now())
  const cloud = {
    elapsed: 0,
    urls: [] as string[],
    requests: [] as Cloud["requests"],
    notices: [] as string[],
    masks: [] as string[],
  }
  // Every request is recorded and answered here; the checks run after the run, since a throw in this handler would
  // only reach the client as an outage.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      cloud.requests.push({
        method: request.method,
        path: pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json().catch(() => undefined),
      })
      if (pathname === GithubAgents.ENDPOINT.mint)
        return input.scenario === "at-once"
          ? Response.json(
              { error: { code: "MODEL_PLAN_RUN_LIMIT", limit: "at-once", message: BILLING } },
              { status: 429 },
            )
          : Response.json({
              token: CHANNEL.runToken,
              runId: rid(run),
              deadline: clock.state.now + 3_600_000,
              heartbeatSeconds: 60,
              idleSeconds: 600,
            })
      if (pathname === GithubAgents.ENDPOINT.artifactKey) return Response.json(ARTIFACT_KEY)
      return Response.json(pathname === GithubAgents.ENDPOINT.heartbeat ? { ok: true, stop: false } : { ok: true })
    },
  })
  const services: Services = {
    oidc: async () => "fixture.oidc.proof",
    mask: (value) => {
      cloud.masks.push(value)
    },
    request: (url, init) => {
      cloud.urls.push(url)
      return fetch(server.url.origin + new URL(url).pathname, init)
    },
    now: () => clock.state.now + cloud.elapsed,
    monotonic: () => cloud.elapsed,
    wait: async (ms) => {
      cloud.elapsed += ms
    },
    notice: (line) => cloud.notices.push(line),
  }
  const lines = [...routed.lines]
  const attested: Buffer[] = []
  const seams = { export: [] as unknown[], import: [] as unknown[] }
  try {
    const env = {
      ...stepEnv({
        event: yield* Effect.promise(() => eventFile(payload)),
        eventName: "issue_comment",
        thread: routed.outputs.thread!,
        github: github.url,
        mode: ownKey ? "own-key" : "codium",
        ...(ownKey ? {} : { model: "vector-plan" }),
      }),
      GITHUB_RUN_ID: run,
      GITHUB_REPOSITORY_ID: REPOSITORY_ID,
      VECTOR_WORKFLOW_VERSION: workflow.version,
      VECTOR_COMMENT_ID: String(trigger.id),
      RUNNER_TEMP: scratch,
      GITHUB_OUTPUT: path.join(scratch, "output"),
      GITHUB_ENV: path.join(scratch, "environment"),
    }
    yield* Effect.promise(() => Promise.all([fs.writeFile(env.GITHUB_OUTPUT, ""), fs.writeFile(env.GITHUB_ENV, "")]))
    const status = ownKey ? "ok" : yield* Effect.promise(() => mintRunToken({ purpose: "task", env, services }))
    const fileCommands = Object.fromEntries(
      (yield* Effect.promise(() => fs.readFile(env.GITHUB_ENV, "utf8")))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf("=")
          return [line.slice(0, at), line.slice(at + 1)]
        }),
    )
    const agentEnv = { ...env, ...fileCommands, ...(ownKey ? { VECTOR_RUN_ID: rid(run) } : {}) }
    const bundleDirectory = path.join(scratch, "bundle")
    yield* Effect.promise(() => fs.mkdir(bundleDirectory))
    const ran =
      status !== "ok"
        ? undefined
        : yield* Effect.gen(function* () {
            const credentials = ownKey
              ? { ...(yield* Effect.promise(() => holder("own-key"))), sessionProof: () => true }
              : GithubSecrets.createGithubSecrets()
            const verified = ownKey
              ? undefined
              : yield* Effect.promise(async () => {
                  const token = await fs.readFile(GithubSecrets.runTokenPath(env), "utf8")
                  await credentials.load(
                    {
                      GITHUB_ACTIONS: "true",
                      VECTOR_MODE: "codium",
                      VECTOR_SECRET_CHANNEL: "stdin",
                      // As the hosted launcher starts a Codium engine (sandboxEnvironment): this build's tool boundary
                      // and the FD3 session proof. No isolation is activated.
                      ...(input.proof
                        ? {
                            [GithubAgents.TOOL_PID_NAMESPACE_ENV]: GithubSecrets.toolBoundary(),
                            [GithubAgents.SESSION_PROOF_ENV]: "fd3",
                          }
                        : {}),
                    },
                    (async function* () {
                      yield JSON.stringify({ v: 1, githubToken: CHANNEL.githubToken, runToken: token, keys: {} }) + "\n"
                    })(),
                  )
                  return verifyGithubRun(credentials, services)
                })
            yield* input.turns
            const exportSession: SessionExport = (sessionID) => {
              seams.export.push(sessionID)
              return Effect.die(new Error("An own-key run never exports its session (INV-K1)."))
            }
            const importSession: SessionImport = (value) => {
              seams.import.push(value)
              return Effect.die(new Error("An own-key run never imports a session (INV-K1)."))
            }
            const phase = githubAgentPhase({
              env: agentEnv,
              credentials,
              services,
              clock: clock.clock,
              log: (line) => lines.push(line),
              error: (line) => lines.push(line),
              session: {
                attest: (bytes) => {
                  attested.push(Buffer.from(bytes))
                  return true
                },
                ...(ownKey ? { exportSession } : {}),
              },
              restore: { request: github.request, ...(ownKey ? { importSession } : {}) },
            }).pipe(Effect.ensuring(Effect.sync(() => LLMRequestPrep.pin(undefined))))
            const result = yield* input.share
              ? phase.pipe(Effect.provideService(PublicSessionShare.Service, input.share))
              : phase
            expect(result?.exitCode).toBe(0)
            const out = path.join(dir, GithubAgents.BUNDLE_DIR)
            const listing = yield* Effect.promise(async () => (await fs.readdir(out)).sort())
            const saved = listing.includes(GithubAgents.SESSION_FILE)
              ? yield* Effect.promise(() => fs.readFile(path.join(out, GithubAgents.SESSION_FILE)))
              : undefined
            // The runner hands publish the bundle only; the checkout publish starts from is clean.
            yield* Effect.promise(async () => {
              await Promise.all(
                GithubAgents.BUNDLE_FILES.map((name) =>
                  fs.copyFile(path.join(out, name), path.join(bundleDirectory, name)),
                ),
              )
              await clearOut(dir)
            })
            return { result, verified, listing, saved }
          })
    const posts: { id: number; body: string; login: string }[] = []
    const pulls: { head: string; body: string; draft: boolean }[] = []
    const authority = { disposed: 0, acquired: 0 }
    const api: PublishApi = {
      pull: async () => {
        throw new Error("This journey publishes an issue task")
      },
      thread: async () => ({ writersOnly: true, comments: posts }),
      comment: async (_number, body) => {
        posts.push({ id: posts.length + 1, body, login: "github-actions[bot]" })
      },
      openPulls: async () => [],
      createPull: async (pull) => {
        pulls.push(pull)
        return { number: 31 }
      },
      updatePull: async () => {
        throw new Error("This journey creates its first proposal")
      },
    }
    const publish = () =>
      publishBundle({
        env: {
          ...agentEnv,
          VECTOR_ROUTE_KIND: routed.outputs.kind,
          VECTOR_ROUTE_PR: routed.outputs.pr,
          VECTOR_ROUTE_REF: routed.outputs.ref,
          VECTOR_AGENT_STATUS: status,
          // The publish step's own value: the agent job's rid output on Codium, empty on own key.
          VECTOR_RUN_ID: ownKey ? "" : (agentEnv.VECTOR_RUN_ID ?? ""),
        },
        event: { name: "issue_comment", payload },
        bundleDirectory,
        git: createPublishGit(dir),
        api,
        log: (line) => lines.push(line),
        authorize: async (app) => {
          expect(app).toBe(false)
          authority.acquired++
          return {
            auth: {
              source: "github",
              token: CHANNEL.githubToken,
              repository: `${OWNER}/${REPO}`,
              botLogin: "github-actions[bot]",
              dispose: async () => {},
            },
            api,
            git: createPublishGit(dir),
            dispose: async () => {
              authority.disposed++
            },
          }
        },
      })
    const published = yield* Effect.promise(publish)
    const files = yield* Effect.promise(async () => ({
      output: await fs.readFile(env.GITHUB_OUTPUT, "utf8"),
      environment: await fs.readFile(env.GITHUB_ENV, "utf8"),
    }))
    // The cloud client reached only vectordev.ai's cloud-agents API: mint with the OIDC proof and the generated
    // file's workflow version (2.11.4), everything else with the run token.
    expect(cloud.urls.filter((url) => !url.startsWith("https://vectordev.ai/api/cloud-agents/"))).toEqual([])
    const mints = cloud.requests.filter((request) => request.path === GithubAgents.ENDPOINT.mint)
    mints.forEach((request) =>
      expect({ method: request.method, authorization: request.authorization, body: request.body }).toEqual({
        method: "POST",
        authorization: "Bearer fixture.oidc.proof",
        body: { purpose: "task", thread: "17", workflowVersion: GITHUB_WORKFLOW_VERSION, commentId: trigger.id },
      }),
    )
    expect(
      mints.filter(
        (request) =>
          !(
            Number((request.body as { workflowVersion?: string }).workflowVersion) >=
            GithubAgents.MIN_CODIUM_WORKFLOW_VERSION
          ),
      ),
    ).toEqual([])
    expect(
      cloud.requests.filter(
        (request) =>
          request.path !== GithubAgents.ENDPOINT.mint && request.authorization !== `Bearer ${CHANNEL.runToken}`,
      ),
    ).toEqual([])
    // The account gate's starting heartbeat authorized the Codium holder before the phase.
    if (!ownKey && ran) {
      expect(ran.verified).toBe(true)
      expect(cloud.requests.find((request) => request.path === GithubAgents.ENDPOINT.heartbeat)?.body).toEqual({
        state: "starting",
      })
      expect(cloud.masks).toContain(CHANNEL.runToken)
    }
    return {
      status,
      result: ran?.result,
      lines,
      posts,
      pulls,
      published,
      publish,
      authority,
      cloud,
      github,
      attested,
      seams,
      out: ran?.listing ?? [],
      saved: ran?.saved,
      sessionID: lines.find((line) => line.startsWith("vector session "))?.slice("vector session ".length),
      publicText: JSON.stringify({ lines, posts, pulls, notices: cloud.notices, files }),
    }
  } finally {
    github.stop()
    server.stop(true)
  }
})

/**
 * The generated v3 workflow for this journey's mode. Every job, and every step that names one, carries
 * GITHUB_WORKFLOW_VERSION, and the CLI asks no reinstall for the steps that run it (prepareGithubEnvironment): the
 * mint and agent steps on Codium, the agent step on own key. Returns the route script and the version the step that
 * starts this journey's run carries (the mint step's on Codium, the agent step's on own key).
 */
function generated(ownKey: boolean) {
  const workflow = Bun.YAML.parse(
    buildAgentsWorkflow({
      mode: ownKey ? "own-key" : "codium",
      provider: ownKey ? "lmstudio" : "vector",
      model: ownKey ? "test-model" : "vector-plan",
      keys: [],
      autoReview: false,
      version: GithubAgents.MIN_AGENTS_CLI,
    }),
  ) as Workflow
  const jobs = Object.values(workflow.jobs)
  const agent = workflow.jobs.agent!
  const checked = agent.steps.filter((step) => step.id === "mint" || step.id === "agent")
  expect({
    jobs: jobs.map((job) => job.env?.VECTOR_WORKFLOW_VERSION),
    steps: [
      ...new Set(
        jobs.flatMap((job) =>
          job.steps.flatMap((step) => (step.env?.VECTOR_WORKFLOW_VERSION ? [step.env.VECTOR_WORKFLOW_VERSION] : [])),
        ),
      ),
    ],
    ids: checked.map((step) => step.id),
    reinstall: checked.map((step) =>
      prepareGithubEnvironment({ GITHUB_ACTIONS: "true", ...agent.env, ...step.env }, false),
    ),
  }).toEqual({
    jobs: jobs.map(() => GITHUB_WORKFLOW_VERSION),
    steps: [GITHUB_WORKFLOW_VERSION],
    ids: ownKey ? ["agent"] : ["mint", "agent"],
    reinstall: checked.map(() => undefined),
  })
  // The ids above make this the mint step on Codium and the agent step on own key, never a fallback to the job.
  const start = checked[0]!
  return {
    script: workflow.jobs.route!.steps[0]!.with!.script!,
    version: { ...agent.env, ...start.env }.VECTOR_WORKFLOW_VERSION ?? "",
  }
}

/** The generated route script, run in-process as actions/github-script runs it; its info and warning lines are kept. */
async function route(script: string, input: { base: string; run: string; payload: unknown; permission: string }) {
  const outputs: Record<string, string> = {}
  const lines: string[] = []
  await new AsyncFunction("github", "context", "core", script)(
    {
      rest: {
        repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: input.permission } }) },
        reactions: { createForIssueComment: async () => ({}) },
      },
    },
    {
      repo: { owner: OWNER, repo: REPO },
      sha: input.base,
      runId: Number(input.run),
      eventName: "issue_comment",
      payload: input.payload,
    },
    {
      setOutput: (key: string, value: string) => {
        outputs[key] = value
      },
      info: (line: string) => lines.push(`route: ${line}`),
      warning: (line: string) => lines.push(`route: ${line}`),
    },
  )
  return { outputs, lines }
}

/** A writer's comment on issue 17, as the issue_comment event carries it. */
function issueComment(trigger: { id: number; body: string }) {
  return {
    action: "created",
    repository: { full_name: `${OWNER}/${REPO}`, default_branch: "main" },
    issue: { number: 17 },
    comment: { id: trigger.id, body: trigger.body, user: WRITER },
  }
}

/** The test's repository on `main`, committed, with a bare remote that holds it. */
const repository = Effect.fn("AgentsJourney.repository")(function* (test: Test) {
  const base = yield* Effect.promise(() => commitSetup(test.dir))
  const remote = yield* Effect.promise(() => folder("vector-journey-remote-"))
  yield* Effect.promise(async () => {
    await git(test.dir, ["branch", "-M", "main"])
    await git(test.dir, ["init", "--bare", remote])
    await git(test.dir, ["remote", "add", "origin", remote])
    await git(test.dir, ["push", "origin", `${base}:refs/heads/main`])
  })
  return { base, remote }
})

/**
 * The real SessionArchive over this runtime's database, with projects resolving to this instance's own; built as
 * github.agent-codium.test.ts's archiveShare (`:211`) builds it.
 */
const sessionArchive = Effect.fn("AgentsJourney.sessionArchive")(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  const bridge = yield* EventV2Bridge.Service
  const built = yield* Layer.build(
    SessionArchive.node.implementation as Layer.Layer<
      SessionArchive.Service,
      never,
      Database.Service | EventV2.Service | ProjectV2.Service
    >,
  ).pipe(
    Effect.provideService(EventV2.Service, bridge),
    Effect.provideService(
      ProjectV2.Service,
      ProjectV2.Service.of({
        directories: () => Effect.die(new Error("The archive's import resolves only the project.")),
        resolve: (directory) => Effect.succeed({ id: ctx.project.id, directory }),
        commit: () => Effect.die(new Error("The archive's import resolves only the project.")),
      }),
    ),
  )
  return Context.get(built, SessionArchive.Service)
})

/**
 * A share service whose methods record their name in `used` and die, except the archive's export, preview and import
 * when `archive` is given: a run may use those for its conversation, and nothing else (2.13).
 */
function share(used: string[], archive?: SessionArchive.Interface) {
  const unused = (name: string) => () => {
    used.push(name)
    return Effect.die(new Error(`The journey's runs never use the share's ${name}.`))
  }
  return PublicSessionShare.Service.of({
    export: archive?.export ?? unused("export"),
    preview: archive?.preview ?? unused("preview"),
    import: archive?.import ?? unused("import"),
    publish: unused("publish"),
    review: unused("review"),
    flush: unused("flush"),
    unshare: unused("unshare"),
    removeTree: unused("removeTree"),
    auto: unused("auto"),
    read: unused("read"),
  })
}

/** The artifact's download as the runner uploads it: a zip that holds session.vsa (github.agent-codium.test.ts `:197`). */
async function artifactZip(bytes: Uint8Array) {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add(GithubAgents.SESSION_FILE, new Uint8ArrayReader(Uint8Array.from(bytes)), {
    level: 0,
    useWebWorkers: false,
    useCompressionStream: false,
  })
  return writer.close()
}

/** Back to the checked-out tree: the agent's edits and the bundle directory go, ignored state stays. */
async function clearOut(dir: string) {
  await fs.rm(path.join(dir, GithubAgents.BUNDLE_DIR), { recursive: true, force: true })
  await resetTree(dir)
}

/** The run id mint answers for `run` of this repository. */
function rid(run: string) {
  return GithubAgents.runId(REPOSITORY_ID, run, "1", "99")
}

/** The restore's artifact list for issue 17, with the job's token. */
const listRequest = {
  method: "GET",
  path: `/repos/${OWNER}/${REPO}/actions/artifacts`,
  search: "?name=vector-session-17&per_page=100&page=1",
  authorization: `Bearer ${CHANNEL.githubToken}`,
}

function artifactRequests(seen: Recorded[]) {
  return seen.filter((request) => request.path.includes("/actions/artifacts"))
}

/** The cloud paths in order without the heartbeats, whose number depends on timing. */
function calls(cloud: Cloud) {
  return cloud.requests
    .filter((request) => request.path !== GithubAgents.ENDPOINT.heartbeat)
    .map((request) => request.path)
}

function keyBodies(cloud: Cloud) {
  return cloud.requests
    .filter((request) => request.path === GithubAgents.ENDPOINT.artifactKey)
    .map((request) => request.body)
}

function sessionLines(lines: string[]) {
  return lines.filter((line) => SESSION_LINES.includes(line))
}

/** P6 over everything a run makes public, and no fixture credential, conversation key or identity token in it. */
function expectPublic(text: string, codiumRun: boolean) {
  expect(text).not.toMatch(P6)
  if (codiumRun) {
    expect(text).not.toMatch(AMOUNT)
    expect(text).not.toMatch(PERCENT)
  }
  expect([...VALUES, ARTIFACT_KEY.key, "fixture.oidc.proof"].filter((secret) => text.includes(secret))).toEqual([])
}
