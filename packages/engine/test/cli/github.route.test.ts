import { describe, expect, test } from "bun:test"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { REVIEW_ACTIONS, TASK_MENTIONS, mentionsFrom, routeGithubEvent } from "../../src/cli/cmd/github.route"

const alice = { login: "alice", type: "User" }

function issueComment(body: string, options: { pr?: boolean; user?: object; action?: string } = {}) {
  return {
    eventName: "issue_comment",
    payload: {
      action: options.action ?? "created",
      issue: { number: 7, ...(options.pr === false ? {} : { pull_request: { url: "https://api.github.com/x" } }) },
      comment: { id: 11, body, user: options.user ?? alice },
    },
  }
}

function reviewComment(body: string) {
  return {
    eventName: "pull_request_review_comment",
    payload: { action: "created", pull_request: { number: 8 }, comment: { id: 12, body, user: alice } },
  }
}

describe("routeGithubEvent", () => {
  test("pull_request: the four review actions start an automatic review, and other actions nothing", () => {
    for (const action of REVIEW_ACTIONS)
      expect(routeGithubEvent({ eventName: "pull_request", payload: { action, pull_request: { number: 7 } } })).toEqual(
        {
          job: "review",
          trigger: "auto",
          full: false,
          pr: 7,
        },
      )
    for (const action of ["closed", "edited", "labeled", "converted_to_draft", "review_requested"])
      expect(
        routeGithubEvent({ eventName: "pull_request", payload: { action, pull_request: { number: 7 } } }).job,
      ).toBe("none")
    expect(routeGithubEvent({ eventName: "pull_request", payload: { action: "opened" } }).job).toBe("none")
  })

  test("workflow_dispatch: a pr input is an automatic review; no input is a task, as before reviews", () => {
    expect(routeGithubEvent({ eventName: "workflow_dispatch", payload: { inputs: { pr: "12" } } })).toEqual({
      job: "review",
      trigger: "auto",
      full: false,
      pr: 12,
    })
    expect(routeGithubEvent({ eventName: "workflow_dispatch", payload: {} })).toEqual({ job: "task" })
    expect(routeGithubEvent({ eventName: "workflow_dispatch", payload: { inputs: {} } })).toEqual({ job: "task" })
    expect(routeGithubEvent({ eventName: "workflow_dispatch", payload: { inputs: { pr: "abc" } } }).job).toBe("none")
    expect(routeGithubEvent({ eventName: "workflow_dispatch", payload: { inputs: { pr: "-3" } } }).job).toBe("none")
  })

  test("issue_comment on a pull request: review verbs, control verbs, tasks and nothing", () => {
    const comment = { id: 11, kind: "issue" as const, author: "alice", body: "/vector review" }
    expect(routeGithubEvent(issueComment("/vector review"))).toEqual({
      job: "review",
      trigger: "command",
      full: false,
      pr: 7,
      comment,
    })
    expect(routeGithubEvent(issueComment("/vx review full"))).toMatchObject({ job: "review", full: true, pr: 7 })
    expect(routeGithubEvent(issueComment("/VX Review Full"))).toMatchObject({ job: "review", full: true })
    expect(routeGithubEvent(issueComment("LGTM\n/vector review"))).toMatchObject({ job: "review", full: false })
    expect(routeGithubEvent(issueComment("/vector pause"))).toMatchObject({ job: "control", kind: "pause", pr: 7 })
    expect(routeGithubEvent(issueComment("/vector resume"))).toMatchObject({ job: "control", kind: "resume", pr: 7 })
    expect(routeGithubEvent(issueComment("/vector dismiss not a bug"))).toMatchObject({ job: "none" })
    expect(routeGithubEvent(issueComment("/vector review the auth code and fix it"))).toEqual({ job: "task" })
    expect(routeGithubEvent(issueComment("/vector reviewer"))).toEqual({ job: "task" })
    expect(routeGithubEvent(issueComment("/vector review full please"))).toEqual({ job: "task" })
    expect(routeGithubEvent(issueComment("looks good to me"))).toMatchObject({ job: "none" })
    expect(routeGithubEvent(issueComment("> /vector review\nthanks"))).toMatchObject({ job: "none" })
    expect(routeGithubEvent(issueComment("```\n/vector review\n```"))).toMatchObject({ job: "none" })
  })

  test("a review verb on an issue that is not a pull request does nothing; a task there still runs", () => {
    expect(routeGithubEvent(issueComment("/vector review", { pr: false }))).toMatchObject({ job: "none" })
    expect(routeGithubEvent(issueComment("/vector pause", { pr: false }))).toMatchObject({ job: "none" })
    expect(routeGithubEvent(issueComment("/vector add a login page", { pr: false }))).toEqual({ job: "task" })
  })

  test("bot comments and edited comments start nothing", () => {
    const bot = { login: "github-actions[bot]", type: "Bot" }
    expect(routeGithubEvent(issueComment("/vector review", { user: bot }))).toMatchObject({ job: "none" })
    expect(routeGithubEvent(issueComment("/vector fix the build", { user: bot }))).toMatchObject({ job: "none" })
    expect(routeGithubEvent(issueComment("/vector review", { action: "edited" }))).toMatchObject({ job: "none" })
    expect(routeGithubEvent({ eventName: "issue_comment", payload: { action: "created" } })).toMatchObject({
      job: "none",
    })
  })

  test("pull_request_review_comment: the pull request is the event's, and the comment is a review comment", () => {
    expect(routeGithubEvent(reviewComment("/vector review"))).toEqual({
      job: "review",
      trigger: "command",
      full: false,
      pr: 8,
      comment: { id: 12, kind: "review", author: "alice", body: "/vector review" },
    })
    expect(routeGithubEvent(reviewComment("/vector fix"))).toEqual({ job: "task" })
    expect(routeGithubEvent(reviewComment("/vector dismiss"))).toMatchObject({ job: "none" })
    expect(routeGithubEvent(reviewComment("/vector resume"))).toMatchObject({ job: "control", kind: "resume", pr: 8 })
  })

  test("issues and schedule are tasks; every other event is not handled", () => {
    expect(routeGithubEvent({ eventName: "issues", payload: { action: "opened" } })).toEqual({ job: "task" })
    expect(routeGithubEvent({ eventName: "schedule", payload: {} })).toEqual({ job: "task" })
    for (const eventName of ["pull_request_target", "pull_request_review", "push", "workflow_run", "release"])
      expect(routeGithubEvent({ eventName, payload: {} })).toMatchObject({ job: "none" })
  })

  test("mentions: Vector aliases route tasks and custom aliases remain opt-in", () => {
    expect(routeGithubEvent(issueComment("/unrelated review"))).toMatchObject({ job: "none" })
    expect(routeGithubEvent(issueComment("/vx review"), TASK_MENTIONS)).toMatchObject({ job: "review", pr: 7 })
    expect(routeGithubEvent(issueComment("/bot review"), ["/bot"])).toMatchObject({ job: "review" })
  })

  test("a mention counts only as a word of its own, and never inside inline code", () => {
    for (const body of ["/vectorize this", "src/vs/x", "`/vector review`", "a/vector fix", "/vector-bot review"])
      expect({ body, job: routeGithubEvent(issueComment(body)).job }).toEqual({ body, job: "none" })
    for (const body of ["(/vector fix)", "/vector, fix this", "/VECTOR Fix"])
      expect({ body, route: routeGithubEvent(issueComment(body)) }).toEqual({ body, route: { job: "task" } })
  })

  test("the App handle routes the same verbs once MENTIONS names it, and @vector alone is not it", () => {
    const mentions = mentionsFrom("@Vector-Fixture,/vector,/vs")
    expect(mentions).toEqual(["@vector-fixture", "/vector", "/vs"])
    expect(routeGithubEvent(issueComment("@vector-fixture review"), mentions)).toMatchObject({ job: "review", pr: 7 })
    expect(routeGithubEvent(issueComment("@vector-fixture review full"), mentions)).toMatchObject({ full: true })
    expect(routeGithubEvent(issueComment("@vector-fixture pause"), mentions)).toMatchObject({
      job: "control",
      kind: "pause",
    })
    expect(routeGithubEvent(issueComment("@Vector-Fixture fix the build"), mentions)).toEqual({ job: "task" })
    expect(routeGithubEvent(issueComment("@vector-fixture-bot review"), mentions).job).toBe("none")
    expect(routeGithubEvent(issueComment("@vector review"), mentions).job).toBe("none")
    expect(routeGithubEvent(issueComment("@vector-fixture review")).job).toBe("none")
  })

  test("mentionsFrom reads a comma-separated MENTIONS value", () => {
    expect(TASK_MENTIONS).toEqual(GithubAgents.mentions())
    expect(mentionsFrom(undefined)).toEqual(GithubAgents.mentions())
    expect(mentionsFrom("", TASK_MENTIONS)).toEqual(TASK_MENTIONS)
    expect(mentionsFrom(" /Bot , /x ,")).toEqual(["/bot", "/x"])
  })
})
