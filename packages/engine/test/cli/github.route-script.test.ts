// The route job's script, taken from the generated workflow and run with fake `github`, `context` and `core` objects,
// the way actions/github-script runs it.

import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { parseReviewCommand, type ReviewCommandKind } from "@vectordevai/core/review/command"
import { buildAgentsWorkflow, buildWorkflowYaml } from "@vectordevai/core/review/workflow"
import { MENTION_CASES } from "../../../core/test/review/mention-cases"

type Script = (github: unknown, context: unknown, core: unknown, require?: unknown) => Promise<void>
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => Script

const MENTIONS = ["/vector", "/vx"]
const HEAD = "a".repeat(40)
const BASE = "b".repeat(40)
const MERGE_BASE = "c".repeat(40)

// Built for each call, since the script differs with the App opt-in and with the mentions.
function routeJob(app = false, mentions?: readonly string[]) {
  const yaml = buildWorkflowYaml({
    provider: "openai",
    model: "gpt-4.1",
    keys: [],
    autoReview: true,
    version: "1.17.14",
    ...(app ? { auth: "auto" as const } : {}),
    ...(mentions ? { mentions } : {}),
  })
  const workflow = Bun.YAML.parse(yaml) as {
    jobs: { route: { if: string; steps: { with: { script: string } }[] } }
  }
  return workflow.jobs.route
}

interface Options {
  v3?: boolean
  ownKey?: boolean
  app?: boolean
  mentions?: readonly string[]
  permission?: string
  role?: string
  permissionStatus?: number
  fork?: boolean
  compareStatus?: number
  removeStatus?: number
}

function fakeGithub(options: Options = {}) {
  const calls: { method: string; args: Record<string, unknown> }[] = []
  const fails = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status })
  const record =
    (method: string, answer: (args: Record<string, unknown>) => unknown = () => ({ data: {} })) =>
    async (args: Record<string, unknown>) => {
      calls.push({ method, args })
      return answer(args)
    }
  const github = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: record("permission", () => {
          if (options.permissionStatus) throw fails(options.permissionStatus)
          const permission = options.permission ?? "write"
          return { data: { permission, role_name: options.role ?? permission } }
        }),
        compareCommitsWithBasehead: record("compare", () => {
          if (options.compareStatus) throw fails(options.compareStatus)
          return { data: { status: "ahead", merge_base_commit: { sha: MERGE_BASE } } }
        }),
      },
      pulls: {
        get: record("pulls.get", (args) => ({
          data: {
            number: args["pull_number"],
            head: { sha: HEAD, repo: { full_name: options.fork ? "someone/r" : "o/r", id: options.fork ? 2 : 1 } },
            base: { sha: BASE, repo: { full_name: "o/r", id: 1 } },
          },
        })),
      },
      reactions: {
        createForIssue: record("react.issue-body"),
        createForIssueComment: record("react.issue"),
        createForPullRequestReviewComment: record("react.review"),
      },
      issues: {
        addLabels: record("labels.add"),
        removeLabel: record("labels.remove", () => {
          if (options.removeStatus) throw fails(options.removeStatus)
          return { data: [] }
        }),
      },
    },
  }
  return { github, calls }
}

async function route(context: object, options: Options = {}) {
  const { github, calls } = fakeGithub(options)
  const outputs: Record<string, string> = {}
  const core = {
    setOutput: (name: string, value: string) => {
      outputs[name] = value
    },
    info: () => {},
    warning: () => {},
    setFailed: (message: string) => {
      outputs["failed"] = message
    },
  }
  await new AsyncFunction(
    "github",
    "context",
    "core",
    "require",
    (options.v3 ? agentsRouteJob(options.ownKey) : routeJob(options.app, options.mentions)).steps[0]!.with.script,
  )(github, { repo: { owner: "o", repo: "r" }, sha: BASE, runId: 123, ...context }, core, (id: string) => {
    expect(id).toBe("node:crypto")
    return { createHash }
  })
  return { outputs, calls }
}

function issueComment(body: string, options: { pr?: boolean; type?: string } = {}) {
  return {
    eventName: "issue_comment",
    payload: {
      issue: { number: 7, ...(options.pr === false ? {} : { pull_request: {} }) },
      comment: { id: 11, body, user: { login: "alice", type: options.type ?? "User" } },
    },
  }
}

function reviewComment(body: string) {
  return {
    eventName: "pull_request_review_comment",
    payload: { pull_request: { number: 8 }, comment: { id: 12, body, user: { login: "alice", type: "User" } } },
  }
}

// Section 2.4's corpus, and the command cases from section 11.1.
const CORPUS = [
  "/vector review",
  "/vector review full",
  "/vx review",
  "/VX Review Full",
  "  /vector review  ",
  "LGTM\n/vector review",
  "/vector review the auth code and fix it",
  "/vector reviewer",
  "/vector review full please",
  "/vector pause",
  "/vector resume",
  "/vector dismiss this is intended",
  "> /vector review\nthanks",
  "```\n/vector review\n```",
  "please take a look /vector",
  "/vector fix the flaky test",
  "no command here",
]

// What the route job does for each kind the parser reads. A refused mention, like a dismissal, costs no API call.
const NONE = { kind: "none", pr: "", ref: "" }
const ROUTED: Record<ReviewCommandKind, { outputs: Record<string, string>; methods: string[] }> = {
  review: { outputs: { kind: "review", pr: "7", ref: HEAD }, methods: ["permission", "pulls.get"] },
  "review-full": { outputs: { kind: "review-full", pr: "7", ref: HEAD }, methods: ["permission", "pulls.get"] },
  task: { outputs: { kind: "task", pr: "7", ref: "" }, methods: ["permission"] },
  pause: { outputs: NONE, methods: ["permission", "labels.add", "react.issue"] },
  resume: { outputs: NONE, methods: ["permission", "labels.remove", "react.issue"] },
  dismiss: { outputs: NONE, methods: [] },
  none: { outputs: NONE, methods: [] },
}

// The workflow built for a table row: the default mentions, or GithubAgents.mentions(slug) baked in.
function mentionsFor(slug: string | undefined) {
  return slug === undefined ? undefined : GithubAgents.mentions(slug)
}

describe("the shared mention table", () => {
  test("the generated route script reads every body as core's parser does", async () => {
    for (const [body, kind, slug] of MENTION_CASES) {
      expect({ body, slug, kind: parseReviewCommand(body, GithubAgents.mentions(slug)).kind }).toEqual({
        body,
        slug,
        kind,
      })
      const { outputs, calls } = await route(issueComment(body), { mentions: mentionsFor(slug) })
      expect({ body, slug, outputs, methods: calls.map((call) => call.method) }).toEqual({
        body,
        slug,
        ...ROUTED[kind],
      })
    }
  })

  // Actions starts the route job only when the comment contains one of the mentions, ignoring case, so the filter
  // must never drop a comment the script would act on.
  test("the route job's contains() filter lets through every body the script reads a mention in", () => {
    const filtered = (slug: string | undefined) =>
      Array.from(
        routeJob(false, mentionsFor(slug)).if.matchAll(/contains\(github\.event\.comment\.body, '([^']*)'\)/g),
        (match) => match[1]!.toLowerCase(),
      )
    expect(filtered(undefined)).toEqual(GithubAgents.mentions())
    expect(filtered("vector-fixture")).toEqual(GithubAgents.mentions("vector-fixture"))
    for (const [body, , slug] of MENTION_CASES.filter((row) => row[1] !== "none"))
      expect({ body, slug, passes: filtered(slug).some((mention) => body.toLowerCase().includes(mention)) }).toEqual({
        body,
        slug,
        passes: true,
      })
  })
})

describe("the route script", () => {
  test("its outputs agree with core's parseReviewCommand for every command in the corpus", async () => {
    for (const body of CORPUS) {
      const parsed = parseReviewCommand(body, MENTIONS).kind
      const expected = parsed === "review" || parsed === "review-full" || parsed === "task" ? parsed : "none"
      const { outputs } = await route(issueComment(body))
      expect({ body, kind: outputs["kind"] }).toEqual({ body, kind: expected })
      if (expected === "task") expect(outputs["pr"]).toBe("7")
      if (expected === "review" || expected === "review-full")
        expect(outputs).toEqual({ kind: expected, pr: "7", ref: HEAD })
      if (expected === "none") expect(outputs["pr"]).toBe("")
    }
  })

  test("a user without write access gets a confused reaction and no runner", async () => {
    const denied = await route(issueComment("/vector review"), { permission: "read" })
    expect(denied.outputs).toEqual({ kind: "none", pr: "", ref: "" })
    expect(denied.calls.map((call) => call.method)).toEqual(["permission", "react.issue"])
    expect(denied.calls[1]?.args).toMatchObject({ comment_id: 11, content: "confused" })

    // Any error counts as no; so does triage.
    expect((await route(issueComment("/vector review"), { permissionStatus: 404 })).outputs["kind"]).toBe("none")
    expect((await route(issueComment("/vector review"), { permission: "read", role: "triage" })).outputs["kind"]).toBe(
      "none",
    )
    // A maintainer shows as "write" with role "maintain".
    expect(
      (await route(issueComment("/vector review"), { permission: "write", role: "maintain" })).outputs["kind"],
    ).toBe("review")

    const review = await route(reviewComment("/vector review"), { permission: "none" })
    expect(review.calls.at(-1)).toMatchObject({ method: "react.review", args: { comment_id: 12, content: "confused" } })
  })

  test("pause adds the label and resume removes it; a missing label is fine", async () => {
    const paused = await route(issueComment("/vector pause"))
    expect(paused.outputs["kind"]).toBe("none")
    expect(paused.calls.map((call) => call.method)).toEqual(["permission", "labels.add", "react.issue"])
    expect(paused.calls[1]?.args).toMatchObject({ issue_number: 7, labels: ["vector:paused"] })
    expect(paused.calls[2]?.args).toMatchObject({ content: "+1" })

    const resumed = await route(issueComment("/vector resume"), { removeStatus: 404 })
    expect(resumed.outputs["kind"]).toBe("none")
    expect(resumed.calls.map((call) => call.method)).toEqual(["permission", "labels.remove", "react.issue"])
    expect(resumed.calls[1]?.args).toMatchObject({ issue_number: 7, name: "vector:paused" })

    // Pausing is a writer's call too.
    const denied = await route(issueComment("/vector pause"), { permission: "read" })
    expect(denied.calls.map((call) => call.method)).toEqual(["permission", "react.issue"])
  })

  test("a fork's ref is the merge-base, and the base commit when compare fails", async () => {
    const fork = await route(issueComment("/vector review"), { fork: true })
    expect(fork.outputs).toEqual({ kind: "review", pr: "7", ref: MERGE_BASE })
    expect(fork.calls.find((call) => call.method === "compare")?.args).toMatchObject({ basehead: `${BASE}...${HEAD}` })
    const fallback = await route(issueComment("/vector review"), { fork: true, compareStatus: 404 })
    expect(fallback.outputs).toEqual({ kind: "review", pr: "7", ref: BASE })
    const same = await route(issueComment("/vector review full"))
    expect(same.outputs).toEqual({ kind: "review-full", pr: "7", ref: HEAD })
    expect(same.calls.some((call) => call.method === "compare")).toBe(false)
  })

  test("workflow_dispatch reviews the pull request it names, with no permission check", async () => {
    const dispatched = await route({ eventName: "workflow_dispatch", payload: { inputs: { pr: "12" } } })
    expect(dispatched.outputs).toEqual({ kind: "review", pr: "12", ref: HEAD })
    expect(dispatched.calls.map((call) => call.method)).toEqual(["pulls.get"])
    const bad = await route({ eventName: "workflow_dispatch", payload: { inputs: { pr: "x" } } })
    expect(bad.outputs["kind"]).toBe("none")
    expect(bad.outputs["failed"]).toContain("inputs.pr")
  })

  test("bots, issues that are not pull requests, and tasks on issues", async () => {
    const bot = await route(issueComment("/vector review", { type: "Bot" }))
    expect(bot.outputs["kind"]).toBe("none")
    expect(bot.calls).toEqual([])
    const issue = await route(issueComment("/vector review", { pr: false }))
    expect(issue.outputs["kind"]).toBe("none")
    expect(issue.calls).toEqual([])
    const task = await route(issueComment("/vector add a settings page", { pr: false }))
    expect(task.outputs).toEqual({ kind: "task", pr: "7", ref: "" })
    expect(task.calls.map((call) => call.method)).toEqual(["permission"])
  })

  test("a task needs write access too, so nobody else starts the task job or takes a queued task's place", async () => {
    const denied = await route(issueComment("/vector hi", { pr: false }), { permission: "read" })
    expect(denied.outputs).toEqual({ kind: "none", pr: "", ref: "" })
    expect(denied.calls.map((call) => call.method)).toEqual(["permission", "react.issue"])
    expect(denied.calls[1]?.args).toMatchObject({ comment_id: 11, content: "confused" })
    const failed = await route(reviewComment("/vector fix the typo"), { permissionStatus: 500 })
    expect(failed.outputs["kind"]).toBe("none")
  })
})

test("App opt-in rejects fork tasks before an OIDC-enabled job and routes fork review through the safe fallback", async () => {
  const denied = await route(issueComment("/vector fix the bug"), { app: true, fork: true })
  expect(denied.outputs.kind).toBe("none")
  expect(denied.calls.filter((call) => call.method === "pulls.get")).toHaveLength(1)
  const fork = await route(issueComment("/vector review"), { app: true, fork: true })
  expect(fork.outputs).toMatchObject({ kind: "review", app: "false", ref: MERGE_BASE })
  const own = await route(issueComment("/vector review"), { app: true })
  expect(own.outputs).toMatchObject({ kind: "review", app: "true", ref: HEAD })
  const unsupported = await route(reviewComment("/vector review"), { app: true })
  expect(unsupported.outputs).toMatchObject({ kind: "review", app: "false" })
})

function agentsRouteJob(ownKey = false) {
  return (
    Bun.YAML.parse(
      buildAgentsWorkflow({
        mode: ownKey ? "own-key" : "codium",
        provider: "vector",
        model: "vector-plan",
        keys: [],
        autoReview: false,
        version: GithubAgents.MIN_AGENTS_CLI,
        handle: "vector-dev",
        schedules: [{ id: "daily", cron: "17 9 * * 1-5", prompt: "fix bugs" }],
      }),
    ) as {
      jobs: {
        route: {
          if: string
          concurrency: { group: string; "cancel-in-progress": boolean }
          steps: { with: { script: string } }[]
        }
      }
    }
  ).jobs.route
}
function openedIssue(
  options: { author?: number; sender?: number; association?: string; title?: string; body?: string } = {},
) {
  return {
    eventName: "issues",
    payload: {
      sender: { id: options.sender ?? 4, login: "alice", type: "User" },
      issue: {
        number: 17,
        title: options.title ?? "bug",
        body: options.body ?? "@vector-dev fix this",
        user: { id: options.author ?? 4, login: "alice", type: "User" },
        author_association: options.association ?? "NONE",
      },
    },
  }
}
function dispatch(mode: string, input: Record<string, string> = {}, user = { id: 4, login: "alice", type: "User" }) {
  return { eventName: "workflow_dispatch", payload: { inputs: { mode, ...input }, sender: user } }
}

describe("v3 route", () => {
  test("issues bind the author to the sender and require fresh writer access", async () => {
    const accepted = await route(openedIssue(), { v3: true })
    expect(accepted.outputs).toEqual({ kind: "task", pr: "17", ref: BASE, thread: "17", app: "true" })
    expect(accepted.calls.map((call) => call.method)).toEqual(["permission", "react.issue-body"])
    expect(accepted.calls.at(-1)!.args.content).toBe("eyes")
    for (const context of [openedIssue({ sender: 5 }), openedIssue({ author: 5 })]) {
      const result = await route(context, { v3: true })
      expect(result.outputs.kind).toBe("none")
      expect(result.calls).toEqual([])
    }
    for (const permission of ["read", "triage", "none"]) {
      const result = await route(openedIssue(), { v3: true, permission })
      expect(result.outputs.kind).toBe("none")
      expect(result.calls.map((call) => call.method)).toEqual(["permission"])
    }
    expect((await route(openedIssue(), { v3: true, permissionStatus: 403 })).outputs.kind).toBe("none")
    expect((await route(openedIssue({ author: 0, sender: 0 }), { v3: true })).outputs.kind).toBe("none")
    expect(
      (await route(openedIssue({ title: "@vector-dev fix bug", body: "details" }), { v3: true })).outputs.kind,
    ).toBe("task")
    expect(agentsRouteJob().if).toContain("github.event.issue.title")
    expect((await route(openedIssue({ body: "@vector-dev review" }), { v3: true })).outputs.kind).toBe("none")
  })

  test("refusals react only to associated authors without granting them authority", async () => {
    for (const association of ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIMER", "NONE"]) {
      const result = await route(openedIssue({ association }), { v3: true, permission: "read" })
      expect(result.outputs.kind).toBe("none")
      const reaction = result.calls.find((call) => call.method === "react.issue-body")
      expect(reaction?.args.content).toBe(
        ["OWNER", "MEMBER", "COLLABORATOR"].includes(association) ? "confused" : undefined,
      )
    }
    expect(agentsRouteJob().concurrency["cancel-in-progress"]).toBe(false)
    expect(agentsRouteJob().concurrency.group).toContain(
      "github.event.comment.author_association || github.event.issue.author_association",
    )
    expect(agentsRouteJob().concurrency.group).toContain(
      "github.event.comment.user.id || github.event.issue.user.id || github.run_id",
    )
  })

  test("comment PR tasks pin the current head and refuse forks", async () => {
    for (const context of [issueComment("@vector-dev fix tests"), reviewComment("@vector-dev fix tests")]) {
      const result = await route(context, { v3: true })
      expect(result.outputs.kind).toBe("task")
      expect(result.outputs.ref).toBe(HEAD)
      expect(result.outputs.thread).toBe(context.eventName === "issue_comment" ? "7" : "8")
      expect(result.calls.map((call) => call.method)).toEqual([
        "permission",
        "pulls.get",
        context.eventName === "issue_comment" ? "react.issue" : "react.review",
      ])
      expect(result.calls.at(-1)!.args.content).toBe("eyes")
      expect((await route(context, { v3: true, fork: true })).outputs.kind).toBe("none")
      expect((await route(context, { v3: true, permission: "triage" })).outputs.kind).toBe("none")
    }
    expect((await route(issueComment("/vs fix issue", { pr: false }), { v3: true })).outputs.ref).toBe(BASE)
    expect((await route(issueComment("/vs review"), { v3: true, fork: true })).outputs.ref).toBe(MERGE_BASE)
  })

  test("manual dispatches route task/review/bind and require a current human writer", async () => {
    const task = await route(dispatch("task", { prompt: "$(touch bad)\n${{ secrets.X }}" }), { v3: true })
    expect(task.outputs).toEqual({ kind: "task", pr: "", ref: BASE, thread: "dispatch-123", app: "false" })
    expect((await route(dispatch("bind", { code: "private" }), { v3: true })).outputs.kind).toBe("bind")
    expect((await route(dispatch("review", { pr: "9" }), { v3: true })).outputs).toEqual({
      kind: "review",
      pr: "9",
      ref: HEAD,
      thread: "9",
      app: "true",
    })
    for (const pr of ["", "0", "-1", "1e2", "1;bad"])
      expect((await route(dispatch("review", { pr }), { v3: true })).outputs.kind).toBe("none")
    expect((await route(dispatch("task"), { v3: true, permission: "read" })).outputs.kind).toBe("none")
    expect((await route(dispatch("unknown"), { v3: true })).outputs.kind).toBe("none")
  })

  test("only the configured dispatch bot with a nonempty ticket reaches admission", async () => {
    for (const login of ["vector-dev[bot]", "github-actions[bot]", "vector-dev-other[bot]", "Copilot"]) {
      const user = { id: 600, login, type: "Bot" }
      for (const ticket of ["", " ", "vtk_fixture"]) {
        const result = await route(dispatch("task", { ticket }, user), { v3: true, permission: "read" })
        expect(result.outputs.kind).toBe(login === "vector-dev[bot]" && ticket === "vtk_fixture" ? "task" : "none")
        expect(result.calls).toEqual([])
      }
    }
    expect(
      (
        await route(dispatch("bind", { ticket: "vtk_fixture" }, { id: 600, login: "vector-dev[bot]", type: "Bot" }), {
          v3: true,
        })
      ).outputs.kind,
    ).toBe("none")
    expect((await route(issueComment("@vector-dev fix it", { type: "Bot" }), { v3: true })).outputs.kind).toBe("none")
    expect(
      (
        await route(dispatch("task", { ticket: "vtk_fixture" }, { id: 600, login: "vector-dev[bot]", type: "Bot" }), {
          v3: true,
          ownKey: true,
        })
      ).outputs.kind,
    ).toBe("none")
  })

  test("schedules use the configured cron's stable hashed thread, never prompt data", async () => {
    const result = await route({ eventName: "schedule", payload: { schedule: "17 9 * * 1-5" } }, { v3: true })
    expect(result.outputs.kind).toBe("task")
    expect(result.outputs.thread).toBe(
      "schedule-" + createHash("sha256").update("17 9 * * 1-5").digest("hex").slice(0, 8),
    )
    expect(GithubAgents.THREAD_PATTERN.test(result.outputs.thread!)).toBe(true)
    expect(result.outputs.ref).toBe(BASE)
    expect(result.calls).toEqual([])
    expect((await route({ eventName: "schedule", payload: { schedule: "unknown" } }, { v3: true })).outputs.kind).toBe(
      "none",
    )
  })

  test("control commands remain writer-only and queued jobs receive no executable input", async () => {
    for (const verb of ["pause", "resume"]) {
      const result = await route(issueComment(`@vector-dev ${verb}`), { v3: true })
      expect(result.outputs.kind).toBe("control")
      expect(result.calls.at(-1)!.args.content).toBe("+1")
    }
    expect((await route(issueComment("/vector dismiss ignore"), { v3: true })).calls).toEqual([])
    expect(agentsRouteJob().steps[0]!.with.script).not.toContain("${{")
    expect((await route({ ...dispatch("task"), runId: "123\nref=evil" }, { v3: true })).outputs.kind).toBe("none")
  })
})
