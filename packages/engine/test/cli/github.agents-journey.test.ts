// The generated workflow's route and mint feed a real in-process agent, then the real isolated Git publisher.
// Models, GitHub and Vector HTTP are fixtures. V16 separately proves the actual runner/UID boundary.
import { afterAll, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { buildAgentsWorkflow } from "@vectordevai/core/review/workflow"
import { FakeWeb } from "../../../core/test/lib/fake-web"
import { NetworkGuard } from "../../../core/test/lib/network-guard"
import { githubAgentPhase } from "../../src/cli/cmd/github.agent"
import { mintRunToken, verifyGithubRun, type Services } from "../../src/cli/cmd/github.cloud"
import { createPublishGit, publishBundle, type PublishApi } from "../../src/cli/cmd/github.publish"
import { GithubSecrets } from "../../src/cli/cmd/github.secrets"
import { LLMRequestPrep } from "../../src/session/llm/request"
import { SessionRetry } from "../../src/session/retry"
import { runtime, setup } from "../lib/research"
import {
  CHANNEL,
  OWNER,
  REPO,
  RUN_ID,
  cleanup,
  codiumFakes,
  commitSetup,
  eventFile,
  fakeClock,
  fakeGithub,
  folder,
  git,
  holder,
  issueData,
  stepEnv,
} from "./github.agent-fixture"

type RouteScript = (github: unknown, context: unknown, core: unknown) => Promise<void>
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => RouteScript
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

for (const scenario of ["codium", "stopped", "at-once", "stranger", "own-key"] as const) {
  // Successful workflow jobs use Linux private-file guarantees; the pure stranger route works on any host.
  const journeyCase = process.platform === "linux" || scenario === "stranger" ? it.instance : it.instance.skip
  journeyCase(
    `GitHub workflow journey ${scenario} preserves route, run and publication authority`,
    () =>
      Effect.gen(function* () {
        const test = yield* setup()
        const base = yield* Effect.promise(() => commitSetup(test.dir))
        const remote = yield* Effect.promise(() => folder("vector-journey-remote-"))
        yield* Effect.promise(async () => {
          await git(test.dir, ["branch", "-M", "main"])
          await git(test.dir, ["init", "--bare", remote])
          await git(test.dir, ["remote", "add", "origin", remote])
          await git(test.dir, ["push", "origin", `${base}:refs/heads/main`])
        })
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
        const writer = { id: 101, login: "alice", type: "User" }
        const payload = {
          action: "created",
          repository: { full_name: `${OWNER}/${REPO}`, default_branch: "main" },
          issue: { number: 17 },
          comment: { id: 3, body: "/vector write the notes", user: writer },
        }
        const outputs: Record<string, string> = {}
        const script = Bun.YAML.parse(
          buildAgentsWorkflow({
            mode: ownKey ? "own-key" : "codium",
            provider: ownKey ? "lmstudio" : "vector",
            model: ownKey ? "test-model" : "vector-plan",
            keys: [],
            autoReview: false,
            version: GithubAgents.MIN_AGENTS_CLI,
          }),
        ) as { jobs: { route: { steps: { with: { script: string } }[] } } }
        yield* Effect.promise(() =>
          new AsyncFunction("github", "context", "core", script.jobs.route.steps[0]!.with.script)(
            {
              rest: {
                repos: {
                  getCollaboratorPermissionLevel: async () => ({
                    data: { permission: scenario === "stranger" ? "read" : "write" },
                  }),
                },
                reactions: { createForIssueComment: async () => ({}) },
              },
            },
            {
              repo: { owner: OWNER, repo: REPO },
              sha: base,
              runId: Number(RUN_ID),
              eventName: "issue_comment",
              payload,
            },
            {
              setOutput: (key: string, value: string) => {
                outputs[key] = value
              },
              info: () => {},
              warning: () => {},
            },
          ),
        )
        if (scenario === "stranger") {
          expect(outputs.kind).toBe("none")
          expect(codium.state.requests).toEqual([])
          expect(yield* test.llm.inputs).toEqual([])
          expect(guard.outside()).toEqual([])
          return
        }
        expect(outputs).toMatchObject({ kind: "task", pr: "17", thread: "17", ref: base })
        const github = fakeGithub({
          roles: { alice: "write" },
          threads: [
            {
              number: 17,
              kind: "issue",
              data: issueData({ title: "Write repository notes", body: "Document the change.", author: "alice" }),
            },
          ],
        })
        const scratch = yield* Effect.promise(() => folder("vector-journey-cloud-"))
        const clock = fakeClock(Date.now())
        const cloud = { elapsed: 0, requests: [] as { path: string; body: unknown }[], notices: [] as string[] }
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const pathname = new URL(request.url).pathname
            const body = await request.json()
            cloud.requests.push({ path: pathname, body })
            if (pathname.endsWith("/mint")) {
              expect(request.headers.get("authorization")).toBe("Bearer fixture.oidc.proof")
              expect(body).toEqual({ purpose: "task", thread: "17", workflowVersion: "3", commentId: 3 })
              return scenario === "at-once"
                ? Response.json({ error: { code: "MODEL_PLAN_RUN_LIMIT", limit: "at-once" } }, { status: 429 })
                : Response.json({
                    token: CHANNEL.runToken,
                    runId: `gh-123-${RUN_ID}-1-99`,
                    deadline: clock.state.now + 3_600_000,
                    heartbeatSeconds: 60,
                    idleSeconds: 600,
                  })
            }
            expect(request.headers.get("authorization")).toBe(`Bearer ${CHANNEL.runToken}`)
            return Response.json(pathname.endsWith("/heartbeat") ? { ok: true, stop: false } : { ok: true })
          },
        })
        const services: Services = {
          oidc: async () => "fixture.oidc.proof",
          mask: () => {},
          request: (url, init) => {
            expect(url.startsWith("https://vectordev.ai/api/cloud-agents/")).toBe(true)
            return fetch(server.url.origin + new URL(url).pathname, init)
          },
          now: () => clock.state.now + cloud.elapsed,
          monotonic: () => cloud.elapsed,
          wait: async (ms) => {
            cloud.elapsed += ms
          },
          notice: (line) => cloud.notices.push(line),
        }
        const lines: string[] = []
        try {
          const env = {
            ...stepEnv({
              event: yield* Effect.promise(() => eventFile(payload)),
              eventName: "issue_comment",
              thread: outputs.thread!,
              github: github.url,
              mode: ownKey ? "own-key" : "codium",
              ...(ownKey ? {} : { model: "vector-plan" }),
            }),
            GITHUB_REPOSITORY_ID: "123",
            VECTOR_COMMENT_ID: "3",
            RUNNER_TEMP: scratch,
            GITHUB_OUTPUT: path.join(scratch, "output"),
            GITHUB_ENV: path.join(scratch, "environment"),
          }
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(env.GITHUB_OUTPUT, ""), fs.writeFile(env.GITHUB_ENV, "")]),
          )
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
          const agentEnv = { ...env, ...fileCommands }
          const bundleDirectory = path.join(scratch, "bundle")
          yield* Effect.promise(() => fs.mkdir(bundleDirectory))
          if (status === "ok") {
            const credentials = ownKey
              ? yield* Effect.promise(() => holder("own-key"))
              : GithubSecrets.createGithubSecrets()
            if (!ownKey) {
              const token = yield* Effect.promise(() => fs.readFile(GithubSecrets.runTokenPath(env), "utf8"))
              yield* Effect.promise(() =>
                credentials.load(
                  { GITHUB_ACTIONS: "true", VECTOR_MODE: "codium", VECTOR_SECRET_CHANNEL: "stdin" },
                  (async function* () {
                    yield JSON.stringify({ v: 1, githubToken: CHANNEL.githubToken, runToken: token, keys: {} }) + "\n"
                  })(),
                ),
              )
              expect(yield* Effect.promise(() => verifyGithubRun(credentials, services))).toBe(true)
            }
            yield* test.llm.tool("write", { filePath: path.join(test.dir, "NOTES.md"), content: "Repository notes.\n" })
            if (scenario !== "stopped") yield* test.llm.text("Wrote repository notes.")
            const result = yield* githubAgentPhase({
              env: agentEnv,
              credentials,
              services,
              clock: clock.clock,
              log: (line) => lines.push(line),
              error: (line) => lines.push(line),
            })
            expect(result).toMatchObject({ exitCode: 0, outcome: scenario === "stopped" ? "draft" : "changes" })
            yield* Effect.promise(async () => {
              for (const name of GithubAgents.BUNDLE_FILES)
                await fs.copyFile(path.join(test.dir, "vector-out", name), path.join(bundleDirectory, name))
              await git(test.dir, ["reset", "--hard", base])
              await git(test.dir, ["clean", "-fdx"])
            })
          }
          expect(status).toBe(scenario === "at-once" ? "at-once" : "ok")
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
            createPull: async (input) => {
              pulls.push(input)
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
                VECTOR_ROUTE_KIND: outputs.kind,
                VECTOR_ROUTE_PR: outputs.pr,
                VECTOR_ROUTE_REF: outputs.ref,
                VECTOR_AGENT_STATUS: status,
              },
              event: { name: "issue_comment", payload },
              bundleDirectory,
              git: createPublishGit(test.dir),
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
                  git: createPublishGit(test.dir),
                  dispose: async () => {
                    authority.disposed++
                  },
                }
              },
            })
          const published = yield* Effect.promise(publish)
          if (scenario === "at-once") {
            expect(published.outcome).toBe("refused")
            yield* Effect.promise(publish)
            expect(posts).toHaveLength(1)
            expect(posts[0]!.body).toContain("<!-- vector:at-once -->")
            expect(pulls).toEqual([])
            expect(authority.acquired).toBe(0)
            expect(codium.state.requests).toEqual([])
          } else {
            expect(published.outcome).toBe(scenario === "stopped" ? "draft" : "changes")
            expect(pulls).toHaveLength(1)
            expect(pulls[0]!.draft).toBe(scenario === "stopped")
            expect(yield* Effect.promise(() => git(remote, ["show", `${pulls[0]!.head}:NOTES.md`]))).toBe(
              "Repository notes.",
            )
            expect(authority).toEqual({ acquired: 1, disposed: 1 })
          }
          if (ownKey) {
            expect(cloud.requests).toEqual([])
            expect(codium.state.requests).toEqual([])
          } else {
            expect(cloud.requests.some((request) => request.path.endsWith("/mint"))).toBe(true)
            if (scenario !== "at-once")
              expect(cloud.requests.at(-1)?.body).toEqual({ outcome: scenario === "stopped" ? "draft" : "changes" })
          }
          const publicText = JSON.stringify({ lines, posts, pulls, notices: cloud.notices })
          expect(publicText).not.toMatch(
            /dispute|fraud|past_due|payment_failed|vector-(?:10|50|100|200)|\b(?:Plus|Pro|Max|Ultra) plan/i,
          )
          // Own-key provider costs remain evidence; Codium's private amounts never enter its public output.
          if (!ownKey) expect(publicText).not.toMatch(/[$€£]\s*\d/i)
          expect(guard.outside()).toEqual([])
        } finally {
          github.stop()
          server.stop(true)
        }
      }).pipe(Effect.ensuring(Effect.sync(() => LLMRequestPrep.pin(undefined)))),
    { git: true },
    30_000,
  )
}
