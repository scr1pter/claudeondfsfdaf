/**
 * End-to-end exerciser for the Effect HttpApi routes.
 *
 * The goal is not to be a normal unit test file. This is a route-coverage harness:
 * every public route should have a small scenario that proves the route decodes
 * requests, uses the right instance context, mutates storage when expected, and
 * returns the expected response shape.
 *
 * The script intentionally isolates `VECTOR_AGENT_DB` before importing modules that touch
 * storage. Scenarios may create/delete sessions and reset the database after each run,
 * so this must never point at a developer's real session database.
 *
 * DSL shape:
 * - `http.protected.get/post/...` starts a scenario for one OpenAPI route key.
 * - `.seeded(...)` creates typed per-scenario state using Effect helpers on `ctx`.
 * - `.at(...)` builds the request from that typed state.
 * - `.json(...)` / `.jsonEffect(...)` assert response shape and optional side effects.
 * - `.mutating()` tells the runner to reset isolated state after destructive routes.
 */
import { Effect } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { TestLLMServer } from "../../lib/llm-server"
import path from "path"
import { array, boolean, check, isRecord, message, object, stable } from "./assertions"
import { controlledPtyInput, http, route } from "./dsl"
import {
  cleanupExercisePaths,
  exerciseConfigDirectory,
  exerciseDataDirectory,
  exerciseDatabasePath,
  exerciseGlobalRoot,
} from "./environment"
import { color, printHeader, printResults } from "./report"
import { coverageResult, parseOptions, routeKey, routeKeys, selectedScenarios } from "./routing"
import { runScenario } from "./runner"
import { call, disposeApps } from "./backend"
import { Config } from "../../../src/config/config"
import { runtime } from "./runtime"
import { type Scenario } from "./types"
import { workspaceScenarios } from "./workspace-scenarios"
import { sessionScenarios } from "./session-scenarios"

function cursor(input: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(input)).toString("base64url")
}

function data(validate: (value: any) => void) {
  return (body: any) => {
    object(body)
    validate(body.data)
  }
}

// An unknown learned skill reaches the memory handler and is refused as not found, whatever the route asks of it.
function skillNotFound(body: unknown) {
  object(body)
  check(
    body.name === "MemoryError" && isRecord(body.data) && body.data.code === "not-found",
    "a learned skill that is not there should be refused as not found",
  )
}

// A task with no isolation record reaches the task manager and is refused as not found. Merge and discard are sent
// without a body, as the SDK sends them with no option, so a payload refusal cannot pass for this answer.
function notIsolated(body: unknown) {
  object(body)
  check(body.code === "not_found", "a task with no isolated changes should be refused as not found")
}

function locationData(validate: (value: any) => void) {
  return (body: any) => {
    object(body)
    object(body.location)
    object(body.location.project)
    validate(body.data)
  }
}

const scenarios: Scenario[] = [
  ...workspaceScenarios,
  ...sessionScenarios,
  http.protected
    .get("/computer/protected-paths", "computer.protectedPaths")
    .seeded((ctx) => ctx.file("AGENTS.md", "Private computer protection instruction fixture."))
    .json(200, (body, ctx) => {
      object(body)
      array(body.paths)
      array(body.directories)
      check(
        [...body.paths, ...body.directories].every(
          (file) => typeof file === "string" && path.isAbsolute(file) && !file.includes("\0"),
        ),
        "protected computer paths must be absolute file names",
      )
      check(
        body.paths.includes(path.join(ctx.directory!, "AGENTS.md")),
        "protected computer paths should include this project's instruction file",
      )
      check(
        body.directories.includes(exerciseConfigDirectory),
        "protected computer directories should include the isolated engine config",
      )
      check(Buffer.byteLength(JSON.stringify(body)) <= 1024 * 1024, "protected computer metadata must stay bounded")
      check(
        !JSON.stringify(body).includes("Private computer protection instruction fixture."),
        "protected computer metadata must not disclose instruction contents",
      )
    }),
  http.protected
    .post("/computer/screenshots/prune", "computer.screenshots.prune")
    .mutating()
    .probe({ path: "/computer/screenshots/prune", body: { before: 0 } })
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Screenshot retention fixture" })
        const user = yield* ctx.message(session.id, { text: "Keep the conversation after deleting old screenshots." })
        const attachmentURL = "data:image/png;base64,aHR0cGFwaS1wcml2YXRlLXNjcmVlbg=="
        const removed = yield* ctx.toolMessage(user.info, { tool: "computer", attachmentURL, end: 10 })
        yield* ctx.toolMessage(user.info, { tool: "computer", attachmentURL, end: 30 })
        yield* ctx.toolMessage(user.info, { tool: "read", attachmentURL, end: 10 })
        const other = yield* ctx.session({ title: "Unselected screenshot fixture" })
        const otherUser = yield* ctx.message(other.id)
        yield* ctx.toolMessage(otherUser.info, { tool: "computer", attachmentURL, end: 10 })
        return {
          session,
          removed,
          before: yield* ctx.messages(session.id),
          other,
          otherBefore: yield* ctx.messages(other.id),
        }
      }),
    )
    .at((ctx) => ({
      path: "/computer/screenshots/prune",
      headers: ctx.headers(),
      body: { sessionID: ctx.state.session.id, before: 20 },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.removed === 1, "pruning should count only the selected old computer screenshot")
        const after = yield* ctx.messages(ctx.state.session.id)
        const parts = after.flatMap((message) => message.parts)
        const removed = parts.find((part) => part.id === ctx.state.removed.id)
        check(removed?.type === "tool", "pruning must retain the computer tool part")
        check(removed.state.status === "completed", "pruning must preserve the completed tool status")
        check(removed.state.metadata.screenshotRemoved === true, "pruning must mark the removed screenshot")
        check(!removed.state.attachments?.length, "the selected screenshot attachment must be deleted")
        check(removed.state.output === "Keep this recorded tool output.", "pruning must preserve tool output")
        check(
          stable(parts.filter((part) => part.id !== removed.id)) ===
            stable(ctx.state.before.flatMap((message) => message.parts).filter((part) => part.id !== removed.id)),
          "pruning must preserve user text, newer screenshots and ordinary tool attachments",
        )
        check(
          stable(yield* ctx.messages(ctx.state.other.id)) === stable(ctx.state.otherBefore),
          "pruning must not change another session's screenshots",
        )
      }),
    ),
  http.protected
    .get("/experimental/session/usage", "experimental.session.usage")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Usage fixture" })
        yield* ctx.llmText("Local usage response", { usage: { input: 12, output: 7 } })
        const prompt = http.protected
          .post("/session/{sessionID}/message", "usage.fixture.prompt")
          .at(() => ({
            path: route("/session/{sessionID}/message", { sessionID: session.id }),
            headers: ctx.headers(),
            body: {
              agent: "build",
              model: { providerID: "lmstudio", modelID: "test-model" },
              parts: [{ type: "text", text: "Record local usage" }],
            },
          }))
          .json(200, (body) => {
            object(body)
            object(body.info)
            check(body.info.role === "assistant", "usage fixture should persist an assistant response")
          })
        const result = yield* call(prompt, { ...ctx, state: undefined })
        yield* prompt.expect(ctx, undefined, result)
        yield* ctx.llmWait(1)
        return { session, messages: yield* ctx.messages(session.id) }
      }),
    )
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.modelResponses === 1, "usage should count the persisted assistant response")
        check(body.conversations === 1 && body.completedChats === 1, "usage should count the completed conversation")
        check(body.lifetimeCost === 0, "local fixture usage should have no inference cost")
        check(body.lifetimeTokens === 19, "usage should count the local response's reported tokens")
        check(body.inputTokens === 12 && body.outputTokens === 7, "usage should preserve input and output counts")
        array(body.favoriteModels)
        check(body.favoriteModels.length === 1, "usage should identify the single local model")
        object(body.favoriteModels[0])
        check(body.favoriteModels[0].modelID === "test-model", "usage should identify the model used for the response")
        check(
          stable(yield* ctx.messages(ctx.state.session.id)) === stable(ctx.state.messages),
          "reading usage must not mutate the transcript",
        )
      }),
    ),
  http.protected
    .get("/global/health", "global.health")
    .global()
    .json(200, (body) => {
      object(body)
      check(body.healthy === true, "server should report healthy")
    }),
  http.protected
    .get("/experimental/session/usage", "experimental.session.usage.codium")
    .inProject({ git: true })
    .seeded((ctx) => ctx.codiumSession())
    .json(200, (body) => {
      object(body)
      check(body.lifetimeTokens === 0 && body.lifetimeCost === 0, "Codium usage must not expose tokens or dollars")
      check(
        body.inputTokens === 0 && body.outputTokens === 0 && body.reasoningTokens === 0 && body.cachedTokens === 0,
        "all token components must exclude Codium",
      )
      check(body.codiumResponses === 1 && body.modelResponses === 1, "Codium response activity should remain visible")
      check(body.completedChats === 1 && body.activeDays === 1, "Codium should retain chat and day activity")
      array(body.favoriteModels)
      check(body.favoriteModels.length === 0, "Codium must not appear in token-share preferences")
      array(body.days)
      object(body.days[0])
      check(body.days[0].tokens === 0 && body.days[0].codium === 1, "Codium-only days should remain visible")
    }),
  http.protected
    .get("/api/session/{sessionID}", "v2.session.get.codium")
    .inProject({ git: true })
    .seeded((ctx) => ctx.codiumSession())
    .at((ctx) => ({ path: route("/api/session/{sessionID}", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(
      200,
      data((body) => {
        object(body)
        check(body.codiumSteps === 1, "session info should expose the stored Codium step count")
        check(body.cost === 0, "Codium steps must not count as local dollar spend")
        object(body.tokens)
        check(body.tokens.input === 0 && body.tokens.output === 0, "session totals should exclude Codium tokens")
      }),
    ),
  http.protected
    .get("/api/session/{sessionID}/spend", "v2.session.spend.codium")
    .inProject({ git: true })
    .seeded((ctx) => ctx.codiumSession())
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/spend", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(
      200,
      data((body) => {
        object(body)
        check(body.costKind === "codium" && body.codiumSteps === 1, "spend response should preserve Codium billing")
        check(body.unpricedSteps === 0 && body.spentUsd === 0, "Codium must not consume dollar or unknown-step caps")
      }),
    ),
  http.protected
    .get("/global/event", "global.event")
    .global()
    .stream()
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.contentType.includes("text/event-stream"), "global event should be an SSE stream")
          check(result.text.includes("server.connected"), "global event should emit initial connection event")
        }),
      "status",
    ),
  http.protected.get("/global/config", "global.config.get").global().json(),
  http.protected
    .patch("/global/config", "global.config.update")
    .global()
    .seeded(() =>
      Effect.promise(() =>
        Bun.write(
          path.join(exerciseConfigDirectory, "vector.jsonc"),
          JSON.stringify({ username: "httpapi-global" }, null, 2),
        ),
      ),
    )
    .at(() => ({ path: "/global/config", body: { username: "httpapi-global" } }))
    .jsonEffect(
      200,
      (body) =>
        Effect.gen(function* () {
          object(body)
          check(body.username === "httpapi-global", "global config update should return patched config")
          const text = yield* Effect.promise(() => Bun.file(path.join(exerciseConfigDirectory, "vector.jsonc")).text())
          check(text.includes('"username": "httpapi-global"'), "global config update should write isolated config file")
        }),
      "status",
    ),
  http.protected
    .post("/global/dispose", "global.dispose")
    .global()
    .mutating()
    .json(
      200,
      (body) => {
        check(body === true, "global dispose should return true")
      },
      "status",
    ),
  http.protected.get("/path", "path.get").json(200, (body, ctx) => {
    object(body)
    check(body.directory === ctx.directory, "directory should resolve from x-vector-directory")
    check(body.worktree === ctx.directory, "worktree should resolve from x-vector-directory")
  }),
  http.protected.get("/vcs", "vcs.get").json(),
  http.protected.get("/vcs/status", "vcs.status").json(200, array),
  http.protected
    .get("/vcs/diff", "vcs.diff")
    .at((ctx) => ({ path: "/vcs/diff?mode=git", headers: ctx.headers() }))
    .json(200, array),
  http.protected.get("/vcs/diff/raw", "vcs.diff.raw").status(
    200,
    (_ctx, result) =>
      Effect.sync(() => {
        check(typeof result.text === "string", "raw VCS diff should return text")
      }),
    "status",
  ),
  http.protected
    .post("/vcs/apply", "vcs.apply")
    .inProject({ git: false })
    .at((ctx) => ({ path: "/vcs/apply", headers: ctx.headers(), body: { patch: "" } }))
    .status(400, undefined, "status"),
  http.protected.get("/command", "command.list").json(200, array, "status"),
  http.protected.get("/agent", "app.agents").json(200, array, "status"),
  http.protected.get("/skill", "app.skills").json(200, array, "status"),
  http.protected.get("/lsp", "lsp.status").json(200, array),
  http.protected.get("/formatter", "formatter.status").json(200, array),
  http.protected.get("/config", "config.get").json(200, undefined, "status"),
  http.protected
    .patch("/config", "config.update")
    .mutating()
    .at((ctx) => ({ path: "/config", headers: ctx.headers(), body: { username: "httpapi-local" } }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.username === "httpapi-local", "local config update should return patched config")
      },
      "status",
    ),
  http.protected
    .patch("/config", "config.update.invalid")
    .at((ctx) => ({ path: "/config", headers: ctx.headers(), body: { username: 1 } }))
    .status(400),
  http.protected.get("/config/providers", "config.providers").json(),
  http.protected.get("/config/trust", "config.trust.get").json(
    200,
    (body) => {
      object(body)
      boolean(body.trusted)
      boolean(body.ignored)
    },
    "status",
  ),
  http.protected
    .post("/config/trust", "config.trust.approve")
    .mutating()
    .at((ctx) => ({ path: "/config/trust", headers: ctx.headers() }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.trusted === true, "approving trust should leave the project trusted")
        check(body.ignored === false, "a trusted project's config is no longer ignored")
      },
      "status",
    ),
  // The first start records the owner's global prompt files as they are (section 8.3), so nothing is held here.
  http.protected.get("/config/prompt-trust", "config.promptTrust.get").json(
    200,
    (body) => {
      object(body)
      array(body.held)
      array(body.files)
      check(
        body.held.length === 0 && body.files.length === 0,
        "the first start records the owner's prompt files as they are, so nothing is held",
      )
    },
    "status",
  ),
  http.protected
    .post("/config/prompt-trust/approve", "config.promptTrust.approve")
    .mutating()
    .at((ctx) => ({ path: "/config/prompt-trust/approve", headers: ctx.headers(), body: { files: [] } }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.approved === 0, "approving the empty list the owner was shown approves nothing")
      },
      "status",
    ),
  // A file the owner was never shown is never approved unseen: the list must be read again.
  http.protected
    .post("/config/prompt-trust/approve", "config.promptTrust.approve.stale")
    .mutating()
    .at((ctx) => ({
      path: "/config/prompt-trust/approve",
      headers: ctx.headers(),
      body: { files: [{ path: "/nowhere/.vector/agents/unseen.md", fingerprint: "0".repeat(64) }] },
    }))
    .status(409),
  http.protected.get("/project", "project.list").json(200, array, "status"),
  http.protected.get("/project/current", "project.current").json(
    200,
    (body, ctx) => {
      object(body)
      check(body.worktree === ctx.directory, "current project should resolve from scenario directory")
    },
    "status",
  ),
  http.protected
    .patch("/project/{projectID}", "project.update")
    .mutating()
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/project/{projectID}", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: { name: "HTTP API Project", commands: { start: "bun --version" } },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.name === "HTTP API Project", "project update should return patched name")
        check(
          isRecord(body.commands) && body.commands.start === "bun --version",
          "project update should return patched command",
        )
      },
      "status",
    ),
  http.protected
    .patch("/project/{projectID}", "project.update.missing")
    .mutating()
    .at((ctx) => ({
      path: route("/project/{projectID}", { projectID: "project_httpapi_missing" }),
      headers: ctx.headers(),
      body: { name: "Missing Project" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/project/git/init", "project.initGit")
    .mutating()
    .inProject({ git: false })
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.worktree === ctx.directory, "git init should return current project")
        check(body.vcs === "git", "git init should mark the project as git-backed")
      },
      "status",
    ),
  http.protected
    .get("/project/{projectID}/directories", "project.directories")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/project/{projectID}/directories", { projectID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, array, "status"),
  http.protected
    .post("/experimental/project/{projectID}/copy/generate-name", "experimental.projectCopy.generateName")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy/generate-name", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.name === "string" && body.name.length > 0, "generated copy name should be non-empty")
    }),
  http.protected
    .post("/experimental/project/{projectID}/copy", "experimental.projectCopy.create")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .delete("/experimental/project/{projectID}/copy", "experimental.projectCopy.remove")
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy", { projectID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/experimental/project/{projectID}/copy/refresh", "experimental.projectCopy.refresh")
    .mutating()
    .seeded((ctx) => ctx.project())
    .at((ctx) => ({
      path: route("/experimental/project/{projectID}/copy/refresh", { projectID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .status(204, undefined, "status"),
  http.protected.get("/provider", "provider.list").json(),
  http.protected.get("/provider/auth", "provider.auth").json(),
  http.protected.get("/provider/free-models/consent", "provider.freeModels.consent").json(200, (body) => {
    object(body)
    check(typeof body.training === "boolean", "free-model consent should say whether training was accepted")
  }),
  // Withdrawing is the non-destructive direction: it never records an acceptance the test user did not give.
  http.protected
    .post("/provider/free-models/consent", "provider.freeModels.setConsent")
    .mutating()
    .at((ctx) => ({ path: "/provider/free-models/consent", headers: ctx.headers(), body: { training: false } }))
    .json(200, (body) => {
      object(body)
      check(body.training === false, "withdrawing free-model consent should report it withdrawn")
    }),
  http.protected
    .post("/provider/{providerID}/oauth/authorize", "provider.oauth.authorize")
    .at((ctx) => ({
      path: route("/provider/{providerID}/oauth/authorize", { providerID: "httpapi" }),
      headers: ctx.headers(),
      body: { method: "bad" },
    }))
    .status(400),
  http.protected
    .post("/provider/{providerID}/oauth/callback", "provider.oauth.callback")
    .at((ctx) => ({
      path: route("/provider/{providerID}/oauth/callback", { providerID: "httpapi" }),
      headers: ctx.headers(),
      body: { method: "bad" },
    }))
    .status(400),
  http.protected.get("/permission", "permission.list").json(200, array),
  http.protected
    .post("/permission/{requestID}/reply", "permission.reply.invalid")
    .at((ctx) => ({
      path: route("/permission/{requestID}/reply", { requestID: "per_httpapi" }),
      headers: ctx.headers(),
      body: { reply: "bad" },
    }))
    .status(400),
  http.protected
    .post("/permission/{requestID}/reply", "permission.reply")
    .at((ctx) => ({
      path: route("/permission/{requestID}/reply", { requestID: "per_httpapi" }),
      headers: ctx.headers(),
      body: { reply: "once" },
    }))
    .json(404, object, "status"),
  http.protected.get("/question", "question.list").json(200, array),
  http.protected
    .post("/question/{requestID}/reply", "question.reply.invalid")
    .at((ctx) => ({
      path: route("/question/{requestID}/reply", { requestID: "que_httpapi_reply" }),
      headers: ctx.headers(),
      body: { answers: "Yes" },
    }))
    .status(400),
  http.protected
    .post("/question/{requestID}/reply", "question.reply")
    .at((ctx) => ({
      path: route("/question/{requestID}/reply", { requestID: "que_httpapi_reply" }),
      headers: ctx.headers(),
      body: { answers: [["Yes"]] },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/question/{requestID}/reject", "question.reject")
    .at((ctx) => ({
      path: route("/question/{requestID}/reject", { requestID: "que_httpapi_reject" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/file", "file.list")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/file?${new URLSearchParams({ path: "." })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/file/content", "file.read")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/file/content?${new URLSearchParams({ path: "hello.txt" })}`, headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.content === "hello\n", `content should match seeded file exactly: ${JSON.stringify(body)}`)
    }),
  http.protected
    .get("/file/content", "file.read.missing")
    .at((ctx) => ({ path: `/file/content?${new URLSearchParams({ path: "missing.txt" })}`, headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.type === "text" && body.content === "", "missing file content should return an empty text result")
    }),
  http.protected.get("/file/status", "file.status").json(200, array),
  http.protected
    .get("/find", "find.text")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: `/find?${new URLSearchParams({ pattern: "hello" })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/find/file", "find.files")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({
      path: `/find/file?${new URLSearchParams({ query: "hello", dirs: "false" })}`,
      headers: ctx.headers(),
    }))
    .json(200, array),
  http.protected
    .get("/find/symbol", "find.symbols")
    .seeded((ctx) => ctx.file("hello.ts", "export const hello = 1\n"))
    .at((ctx) => ({ path: `/find/symbol?${new URLSearchParams({ query: "hello" })}`, headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/event", "event.stream")
    .stream()
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.contentType.includes("text/event-stream"), "event should be an SSE stream")
          check(result.text.includes("server.connected"), "event should emit initial connection event")
        }),
      "status",
    ),
  http.protected.get("/mcp", "mcp.status").json(),
  http.protected
    .delete("/mcp/{name}", "mcp.remove")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const add = http.protected
          .post("/mcp", "mcp.remove.fixture")
          .at(() => ({
            path: "/mcp",
            headers: ctx.headers(),
            body: { name: "httpapi-remove", config: { type: "local", command: ["bun", "--version"], enabled: false } },
          }))
          .json(200, (body) => {
            object(body)
            object(body["httpapi-remove"])
            check(body["httpapi-remove"].status === "disabled", "MCP removal fixture must not spawn a process")
          })
        const result = yield* call(add, { ...ctx, state: undefined })
        yield* add.expect(ctx, undefined, result)
        check(ctx.directory !== undefined, "MCP removal needs an isolated project")
        return { directory: ctx.directory }
      }),
    )
    .at((ctx) => ({ path: route("/mcp/{name}", { name: "httpapi-remove" }), headers: ctx.headers() }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(body.success === true, "MCP removal should report success")
        const config = yield* Effect.promise(() => Bun.file(Config.integrationStore(ctx.state.directory)).json())
        object(config)
        check(
          config.mcp === undefined || (isRecord(config.mcp) && config.mcp["httpapi-remove"] === undefined),
          "MCP removal should delete the durable configuration",
        )
        const status = http.protected.get("/mcp", "mcp.remove.readback").json(200, (body) => {
          object(body)
          check(body["httpapi-remove"] === undefined, "removed MCP integration must disappear from runtime status")
        })
        const result = yield* call(status, ctx)
        yield* status.expect(ctx, undefined, result)
      }),
    ),
  http.protected
    .post("/mcp", "mcp.add")
    .mutating()
    .at((ctx) => ({
      path: "/mcp",
      headers: ctx.headers(),
      body: { name: "httpapi-disabled", config: { type: "local", command: ["bun", "--version"], enabled: false } },
    }))
    .json(
      200,
      (body) => {
        object(body)
        object(body["httpapi-disabled"])
        check(body["httpapi-disabled"].status === "disabled", "disabled MCP server should be added without spawning")
      },
      "status",
    ),
  http.protected
    .post("/mcp", "mcp.add.invalid")
    .at((ctx) => ({
      path: "/mcp",
      headers: ctx.headers(),
      body: { name: "httpapi-invalid", config: { type: "invalid" } },
    }))
    .status(400),
  http.protected
    .post("/mcp/{name}/auth", "mcp.auth.start")
    .at((ctx) => ({ path: route("/mcp/{name}/auth", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .delete("/mcp/{name}/auth", "mcp.auth.remove")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/auth", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/auth/authenticate", "mcp.auth.authenticate")
    .at((ctx) => ({
      path: route("/mcp/{name}/auth/authenticate", { name: "httpapi-missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/auth/callback", "mcp.auth.callback")
    .at((ctx) => ({
      path: route("/mcp/{name}/auth/callback", { name: "httpapi-missing" }),
      headers: ctx.headers(),
      body: { code: "code" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/connect", "mcp.connect")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/connect", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .post("/mcp/{name}/disconnect", "mcp.disconnect")
    .mutating()
    .at((ctx) => ({ path: route("/mcp/{name}/disconnect", { name: "httpapi-missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected.get("/pty/shells", "pty.shells").json(200, array),
  http.protected.get("/pty", "pty.list").json(200, array),
  http.protected
    .post("/pty", "pty.create")
    .mutating()
    .at((ctx) => ({ path: "/pty", headers: ctx.headers(), body: controlledPtyInput("HTTP API PTY") }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.title === "HTTP API PTY", "PTY create should return requested title")
        check(body.command === "/bin/sh", "PTY create should use controlled shell command")
        check(body.cwd === ctx.directory, "PTY create should default cwd to scenario directory")
      },
      "status",
    ),
  http.protected
    .post("/pty", "pty.create.invalid")
    .at((ctx) => ({ path: "/pty", headers: ctx.headers(), body: { command: 1 } }))
    .status(400),
  http.protected
    .post("/pty/{ptyID}/connect-token", "pty.connectToken.invalid")
    .at((ctx) => ({
      path: route("/pty/{ptyID}/connect-token", { ptyID: "pty_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(403, undefined, "status"),
  http.protected
    .get("/pty/{ptyID}", "pty.get")
    .at((ctx) => ({ path: route("/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .status(404),
  http.protected
    .put("/pty/{ptyID}", "pty.update")
    .mutating()
    .at((ctx) => ({
      path: route("/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }),
      headers: ctx.headers(),
      body: { size: { rows: 0, cols: 0 } },
    }))
    .status(400),
  http.protected
    .delete("/pty/{ptyID}", "pty.remove")
    .mutating()
    .at((ctx) => ({ path: route("/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .get("/pty/{ptyID}/connect", "pty.connect")
    .at((ctx) => ({ path: route("/pty/{ptyID}/connect", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .status(404, undefined, "none"),
  http.protected.get("/experimental/console", "experimental.console.get").json(),
  http.protected.get("/experimental/console/orgs", "experimental.console.listOrgs").json(),
  http.protected
    .post("/experimental/console/switch", "experimental.console.switchOrg")
    .at((ctx) => ({
      path: "/experimental/console/switch",
      headers: ctx.headers(),
      body: { accountID: "httpapi-account", orgID: "httpapi-org" },
    }))
    .status(400, undefined, "none"),
  // Vector Local: each route as the owner reads or changes it, with Vector Local off as the exercise starts. Nothing here
  // leaves this computer: Find servers asks only this computer's ports, and the address read is one nothing answers.
  http.protected.get("/local", "local.get").json(200, (body) => {
    object(body)
    object(body.policy)
    check(body.policy.enabled === false, "Vector Local is off until the owner turns it on")
    check(body.agent === false, "the exercise is not a Vector the agent started")
    check(Array.isArray(body.sources) && body.sources.length > 0, "the status should list Vector's services")
  }),
  http.protected
    .patch("/local", "local.update")
    .mutating()
    .at((ctx) => ({ path: "/local", headers: ctx.headers(), body: { enabled: false } }))
    .json(200, (body) => {
      object(body)
      object(body.policy)
      check(body.policy.enabled === false, "keeping Vector Local off tightens nothing and needs no confirmation")
    }),
  http.protected.get("/local/egress", "local.egress.list").json(200, array),
  http.protected.get("/local/egress/summary", "local.egress.summary").json(200, (body) => {
    object(body)
    object(body.model_calls)
    check(typeof body.pages === "number", "the summary should count web pages")
  }),
  http.protected
    .get("/local/egress/export", "local.egress.export")
    .at((ctx) => ({ path: "/local/egress/export?format=csv", headers: ctx.headers() }))
    .status(200, (_ctx, result) =>
      Effect.sync(() => {
        check(result.contentType.includes("text/csv"), "a CSV export should say it is CSV")
        check(result.text.startsWith("time,source,purpose"), "a CSV export should start with its columns")
      }),
    ),
  http.protected
    .delete("/local/egress", "local.egress.clear")
    .json(200, (body) => check(body === true, "the owner may erase the network log")),
  http.protected
    .post("/local/egress/report", "local.egress.report")
    .at((ctx) => ({ path: "/local/egress/report", headers: ctx.headers(), body: { events: [] } }))
    .json(200, (body) => check(body === 0, "with Vector Local off the log takes no events")),
  http.protected
    .post("/local/detect", "local.detect")
    .at((ctx) => ({ path: "/local/detect", headers: ctx.headers(), body: {} }))
    .json(200, array),
  http.protected
    .post("/local/probe", "local.probe")
    .at((ctx) => ({ path: "/local/probe", headers: ctx.headers(), body: { url: "http://127.0.0.1:9" } }))
    .json(200, (body) => {
      object(body)
      check(body.server === null, "nothing answers on the discard port")
      check(typeof body.message === "string", "the result should say why no server was read")
    }),
  http.protected
    .post("/local/servers", "local.servers.add")
    .mutating()
    .at((ctx) => ({ path: "/local/servers", headers: ctx.headers(), body: { url: "http://127.0.0.1:9" } }))
    .json(
      400,
      (body) => {
        object(body)
        check(body.name === "LocalError", "Add server should reach the Local handler, not fail decoding")
      },
      "status",
    ),
  http.protected
    .post("/local/check", "local.check")
    .at((ctx) => ({ path: "/local/check", headers: ctx.headers(), body: {} }))
    .json(200, (body) => {
      object(body)
      check(body.result === "off", "with Vector Local off the check says so")
      check(Array.isArray(body.rows), "the check should return its rows")
    }),
  http.protected
    .post("/local/grant", "local.grant")
    .at((ctx) => ({ path: "/local/grant", headers: ctx.headers(), body: { source: "github" } }))
    .json(
      400,
      (body) => {
        object(body)
        check(body.name === "LocalError", "a grant for a service Vector Local never asks about should be refused")
      },
      "status",
    ),
  http.protected
    .post("/local/startup/release", "local.startup.release")
    .at((ctx) => ({ path: "/local/startup/release", headers: ctx.headers() }))
    .json(200, (body) => check(body === false, "a Vector that started without the first run's hold holds nothing")),
  http.protected.get("/local/recommend", "local.recommend").json(200, (body) => {
    object(body)
    check(typeof body.label === "string", "model suggestions should carry their dated label")
    object(body.roles)
  }),
  http.protected.get("/memory", "memory.list").json(200, (body) => {
    object(body)
    check(Array.isArray(body.entries), "memory list should return entries")
    check(typeof body.stats === "object", "memory list should return counts")
  }),
  http.protected
    .get("/memory", "memory.list.learned")
    .at((ctx) => ({ path: "/memory?filter=learned", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(Array.isArray(body.entries), "memory list should return what Vector learned on its own")
    }),
  http.protected
    .post("/memory", "memory.create")
    .mutating()
    .at((ctx) => ({
      path: "/memory",
      headers: ctx.headers(),
      body: { kind: "decision", text: "HTTP API memory: releases go out on Thursdays.", scope: "repository" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(
          body.text === "HTTP API memory: releases go out on Thursdays.",
          "memory create should return the saved text",
        )
        check(body.status === "active", "a memory the user adds is active")
      },
      "status",
    ),
  http.protected
    .post("/memory", "memory.create.secret")
    .mutating()
    .at((ctx) => ({
      path: "/memory",
      headers: ctx.headers(),
      body: { kind: "fact", text: "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB", scope: "repository" },
    }))
    .json(400, object, "status"),
  http.protected
    .get("/memory/{memoryID}", "memory.get")
    .at((ctx) => ({ path: route("/memory/{memoryID}", { memoryID: "m0none" }), headers: ctx.headers() }))
    .json(400, object, "status"),
  http.protected
    .patch("/memory/{memoryID}", "memory.update")
    .mutating()
    .at((ctx) => ({
      path: route("/memory/{memoryID}", { memoryID: "m0none" }),
      headers: ctx.headers(),
      body: { pinned: true },
    }))
    .json(400, object, "status"),
  http.protected
    .patch("/memory/{memoryID}", "memory.update.undo")
    .mutating()
    .at((ctx) => ({
      path: route("/memory/{memoryID}", { memoryID: "m0none" }),
      headers: ctx.headers(),
      body: { action: "undo" },
    }))
    .json(
      400,
      (body) => {
        object(body)
        check(body.name === "MemoryError", "undo should reach the memory handler, not fail decoding")
      },
      "status",
    ),
  http.protected
    .delete("/memory/{memoryID}", "memory.remove")
    .mutating()
    .at((ctx) => ({ path: route("/memory/{memoryID}", { memoryID: "m0none" }), headers: ctx.headers() }))
    .json(400, object, "status"),
  http.protected.post("/memory/tidy", "memory.tidy").mutating().json(200, object, "status"),
  http.protected
    .post("/memory/erase", "memory.erase")
    .mutating()
    .at((ctx) => ({ path: "/memory/erase", headers: ctx.headers(), body: { scope: "repository" } }))
    .json(200, (body) => check(typeof body === "number", "memory erase should return a count"), "status"),
  http.protected
    .delete("/memory/sessions/{sessionID}", "memory.eraseSession")
    .mutating()
    .at((ctx) => ({ path: route("/memory/sessions/{sessionID}", { sessionID: "ses_none" }), headers: ctx.headers() }))
    .json(200, (body) => check(body === 0, "a session that taught nothing erases nothing"), "status"),
  http.protected
    .get("/memory/export", "memory.export")
    .at((ctx) => ({ path: "/memory/export?scope=personal&format=json", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(body.format === "vector-memory" && body.version === 1, "an export should say what it is")
    }),
  http.protected
    .post("/memory/import", "memory.import")
    .mutating()
    .at((ctx) => ({
      path: "/memory/import",
      headers: ctx.headers(),
      body: { text: "# Notes\n\nNothing to bring in." },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(Array.isArray(body.entries) && body.entries.length === 0, "a page with no entries imports none")
      },
      "status",
    ),
  http.protected.get("/memory/settings", "memory.settings.get").json(200, (body) => {
    object(body)
    check(
      typeof body.facets === "object" && body.modelLearner === "local-only",
      "learning settings should say each facet and the model learner",
    )
  }),
  http.protected
    .patch("/memory/settings", "memory.settings.update")
    .mutating()
    .at((ctx) => ({ path: "/memory/settings", headers: ctx.headers(), body: { learning: true } }))
    .json(200, (body) => {
      object(body)
      check(body.learning === true, "memory settings should keep learning on")
      check(typeof body.repositoryDocs === "boolean", "memory settings should say whether repository docs are read")
      check(body.keepOriginals === false, "originals are not kept unless the user turns it on")
    }),
  http.protected.get("/memory/skills", "memory.skills.list").json(200, (body) => {
    object(body)
    check(Array.isArray(body.skills) && body.skills.length === 0, "a new repository has no learned skills")
    check(
      isRecord(body.settings) && body.settings.skills === "review" && body.settings.skillDrafter === "local-only",
      "skills wait for review and drafts are worded locally by default",
    )
  }),
  http.protected
    .get("/memory/skills", "memory.skills.list.review")
    .at((ctx) => ({ path: "/memory/skills?filter=review", headers: ctx.headers() }))
    .json(200, (body) => {
      object(body)
      check(Array.isArray(body.skills) && body.skills.length === 0, "no drafts wait in a new repository")
    }),
  http.protected
    .get("/memory/skills/{memoryID}", "memory.skills.get.missing")
    .at((ctx) => ({ path: route("/memory/skills/{memoryID}", { memoryID: "s0none" }), headers: ctx.headers() }))
    .json(400, skillNotFound, "status"),
  http.protected
    .patch("/memory/skills/{memoryID}", "memory.skills.update.missing")
    .mutating()
    .at((ctx) => ({
      path: route("/memory/skills/{memoryID}", { memoryID: "s0none" }),
      headers: ctx.headers(),
      body: { action: "approve" },
    }))
    .json(400, skillNotFound, "status"),
  http.protected
    .delete("/memory/skills/{memoryID}", "memory.skills.forget.missing")
    .mutating()
    .at((ctx) => ({ path: route("/memory/skills/{memoryID}", { memoryID: "s0none" }), headers: ctx.headers() }))
    .json(400, skillNotFound, "status"),
  http.protected
    .get("/memory/skills/{memoryID}/share", "memory.skills.sharePreview.missing")
    .at((ctx) => ({ path: route("/memory/skills/{memoryID}/share", { memoryID: "s0none" }), headers: ctx.headers() }))
    .json(400, skillNotFound, "status"),
  http.protected
    .post("/memory/skills/{memoryID}/share", "memory.skills.share.missing")
    .mutating()
    .at((ctx) => ({
      path: route("/memory/skills/{memoryID}/share", { memoryID: "s0none" }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(400, skillNotFound, "status"),
  http.protected.get("/memory/workflow", "memory.workflow.get").json(200, (body) => {
    object(body)
    check(
      body.mode === "apply" && body.explore === false,
      "workflow insights apply learned defaults and do not explore by default",
    )
    check(
      Array.isArray(body.tiers) &&
        body.tiers.map((item) => (isRecord(item) ? item.tier : undefined)).join(",") === "light,standard,thorough",
      "workflow insights should list every size",
    )
    check(
      body.tiers.every((item) => isRecord(item) && Array.isArray(item.arms) && item.arms.length === 0),
      "a new repository has no runs",
    )
  }),
  http.protected
    .delete("/memory/workflow", "memory.workflow.reset")
    .mutating()
    .json(
      200,
      (body) => {
        object(body)
        check(body.removed === 0, "a repository with no runs forgets none")
      },
      "status",
    ),
  http.protected
    .delete("/memory/workflow", "memory.workflow.reset.invalid")
    .at((ctx) => ({ path: "/memory/workflow?tier=chat", headers: ctx.headers() }))
    .status(400),
  http.protected.get("/memory/model", "memory.model.get").json(200, (body) => {
    object(body)
    check(body.state === "absent", "no search model is downloaded until the user asks")
    check(body.downloads === false, "tests turn search model downloads off")
    check(
      Array.isArray(body.options) && body.options.length === 2,
      "the model status should list what can be downloaded",
    )
  }),
  // Downloads are off in tests; installing from a folder is what an offline computer does instead.
  http.protected
    .post("/memory/model", "memory.model.update")
    .mutating()
    .at((ctx) => ({ path: "/memory/model", headers: ctx.headers(), body: { action: "download" } }))
    .json(400, (body) => {
      object(body)
      check(isRecord(body.data) && body.data.reason === "off", "a download where downloads are off should be refused")
    }),
  http.protected.get("/memory/documents", "memory.documents.list").json(200, (body) => {
    object(body)
    check(Array.isArray(body.documents), "documents list should return documents")
    check(typeof body.indexing === "boolean", "documents list should say whether anything is being read")
    check(
      isRecord(body.limits) && body.limits.upload === 64 * 1024 * 1024,
      "documents list should give the upload limit",
    )
  }),
  // The upload takes multipart form data only; memory-documents.test.ts sends real files.
  http.protected
    .post("/memory/documents", "memory.documents.upload")
    .mutating()
    .at((ctx) => ({ path: "/memory/documents", headers: ctx.headers(), body: { file: "not a file" } }))
    .status(415, undefined, "none"),
  http.protected
    .post("/memory/documents/path", "memory.documents.path")
    .mutating()
    .at((ctx) => ({ path: "/memory/documents/path", headers: ctx.headers(), body: { path: "missing.md" } }))
    .json(400, (body) => {
      object(body)
      check(isRecord(body.data) && body.data.reason === "not-found", "a missing file should be refused as not found")
    }),
  http.protected
    .post("/memory/documents/text", "memory.documents.text")
    .mutating()
    .at((ctx) => ({
      path: "/memory/documents/text",
      headers: ctx.headers(),
      body: { name: "HTTP API notes", text: "# Notes\n\nReleases MUST go out on Thursdays." },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.type === "queued", "pasted text should be queued as a document")
        check(isRecord(body.document) && body.document.visibility === "private", "pasted text is private")
      },
      "status",
    ),
  http.protected
    .post("/memory/documents/probe", "memory.documents.probe")
    .at((ctx) => ({ path: "/memory/documents/probe", headers: ctx.headers(), body: { path: "missing.md" } }))
    .json(400, object, "status"),
  http.protected
    .get("/memory/documents/{documentID}", "memory.documents.get")
    .at((ctx) => ({ path: route("/memory/documents/{documentID}", { documentID: "dnone" }), headers: ctx.headers() }))
    .json(400, object, "status"),
  http.protected
    .patch("/memory/documents/{documentID}", "memory.documents.update")
    .mutating()
    .at((ctx) => ({
      path: route("/memory/documents/{documentID}", { documentID: "dnone" }),
      headers: ctx.headers(),
      body: { action: "pause" },
    }))
    .json(400, object, "status"),
  http.protected
    .delete("/memory/documents/{documentID}", "memory.documents.remove")
    .mutating()
    .at((ctx) => ({ path: route("/memory/documents/{documentID}", { documentID: "dnone" }), headers: ctx.headers() }))
    .json(400, object, "status"),
  http.protected
    .get("/memory/documents/{documentID}/pages/{page}", "memory.documents.page")
    .at((ctx) => ({
      path: route("/memory/documents/{documentID}/pages/{page}", { documentID: "dnone", page: "1" }),
      headers: ctx.headers(),
    }))
    .json(400, object, "status"),
  http.protected
    .get("/memory/documents/{documentID}/file", "memory.documents.file")
    .at((ctx) => ({
      path: route("/memory/documents/{documentID}/file", { documentID: "dnone" }),
      headers: ctx.headers(),
    }))
    .json(400, object, "status"),
  // Nothing is sent to a model here: the flag is off by default, and no document dnone exists either way.
  http.protected
    .get("/memory/documents/{documentID}/distill", "memory.distill.estimate")
    .at((ctx) => ({
      path: route("/memory/documents/{documentID}/distill", { documentID: "dnone" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.refused === "object", "an estimate for a document that is not there says why it would not run")
    }),
  http.protected
    .post("/memory/documents/{documentID}/distill", "memory.distill.run")
    .mutating()
    .at((ctx) => ({
      path: route("/memory/documents/{documentID}/distill", { documentID: "dnone" }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(400, object, "status"),
  http.protected.get("/memory/records", "memory.records.list").json(200, (body) => {
    object(body)
    check(Array.isArray(body.records), "records list should return records")
  }),
  http.protected
    .get("/memory/records/{recordID}", "memory.records.get")
    .at((ctx) => ({ path: route("/memory/records/{recordID}", { recordID: "rnone" }), headers: ctx.headers() }))
    .json(400, object, "status"),
  http.protected
    .patch("/memory/records/{recordID}", "memory.records.update")
    .mutating()
    .at((ctx) => ({
      path: route("/memory/records/{recordID}", { recordID: "rnone" }),
      headers: ctx.headers(),
      body: { action: "not-applicable" },
    }))
    .json(400, object, "status"),
  http.protected
    .post("/memory/posting-check", "memory.posting.check")
    .at((ctx) => ({
      path: "/memory/posting-check",
      headers: ctx.headers(),
      body: { parts: ["Fixed the retry loop."], typed: false },
    }))
    .json(200, (body) => {
      object(body)
      check(body.status === "clean", "text that repeats nothing of the owner's memory posts as it is")
    }),
  http.protected
    .get("/memory/knowledge", "memory.knowledge")
    .at((ctx) => ({ path: "/memory/knowledge?ids=rnone,dnone", headers: ctx.headers() }))
    .json(200, (body) => check(Array.isArray(body) && body.length === 0, "ids nothing holds give no cards")),
  http.protected
    .get("/memory/links", "memory.links")
    .at((ctx) => ({ path: "/memory/links?file=src/none.ts", headers: ctx.headers() }))
    .json(200, (body) => check(Array.isArray(body) && body.length === 0, "a file nothing is linked to has no links")),
  http.protected.get("/memory/research", "memory.research.list").json(200, (body) => {
    object(body)
    check(Array.isArray(body.runs), "the research list should return runs")
    check(typeof body.limit === "number" && typeof body.retain === "number", "the research list should say its limits")
  }),
  http.protected
    .delete("/memory/research", "memory.research.forgetAll")
    .mutating()
    .json(200, (body) => check(typeof body === "number", "forgetting all research should return a count"), "status"),
  http.protected
    .get("/memory/research/{runID}", "memory.research.get")
    .at((ctx) => ({ path: route("/memory/research/{runID}", { runID: "run_none" }), headers: ctx.headers() }))
    .json(400, object, "status"),
  http.protected
    .delete("/memory/research/{runID}", "memory.research.forget")
    .mutating()
    .at((ctx) => ({ path: route("/memory/research/{runID}", { runID: "run_none" }), headers: ctx.headers() }))
    .json(400, object, "status"),
  http.protected
    .post("/memory/research/{runID}/keep", "memory.research.keep")
    .mutating()
    .at((ctx) => ({ path: route("/memory/research/{runID}/keep", { runID: "run_none" }), headers: ctx.headers() }))
    .json(400, object, "status"),
  http.protected
    .get("/memory/research/{runID}/export", "memory.research.export")
    .at((ctx) => ({ path: route("/memory/research/{runID}/export", { runID: "run_none" }), headers: ctx.headers() }))
    .json(400, object, "status"),
  http.protected
    .get("/memory/research/{runID}/sources/{sourceID}", "memory.research.source")
    .at((ctx) => ({
      path: route("/memory/research/{runID}/sources/{sourceID}", { runID: "run_none", sourceID: "S1" }),
      headers: ctx.headers(),
    }))
    .json(400, object, "status"),
  http.protected
    .delete("/memory/research/{runID}/sources/{sourceID}", "memory.research.forgetSource")
    .mutating()
    .at((ctx) => ({
      path: route("/memory/research/{runID}/sources/{sourceID}", { runID: "run_none", sourceID: "S1" }),
      headers: ctx.headers(),
    }))
    .json(400, object, "status"),
  http.protected.get("/memory/review", "memory.review.list").json(200, array),
  http.protected
    .patch("/memory/review/{itemID}", "memory.review.resolve")
    .mutating()
    .at((ctx) => ({
      path: route("/memory/review/{itemID}", { itemID: "vnone" }),
      headers: ctx.headers(),
      body: { action: "dismiss" },
    }))
    .json(400, object, "status"),
  http.protected.get("/experimental/workspace/adapter", "experimental.workspace.adapter.list").json(200, array),
  http.protected.get("/experimental/workspace", "experimental.workspace.list").json(200, array),
  http.protected.get("/experimental/workspace/status", "experimental.workspace.status").json(200, array),
  http.protected
    .post("/experimental/workspace", "experimental.workspace.create")
    .at((ctx) => ({ path: "/experimental/workspace", headers: ctx.headers(), body: {} }))
    .status(400),
  http.protected
    .post("/experimental/workspace/sync-list", "experimental.workspace.syncList")
    .status(204, undefined, "status"),
  http.protected
    .delete("/experimental/workspace/{id}", "experimental.workspace.remove")
    .mutating()
    .at((ctx) => ({
      path: route("/experimental/workspace/{id}", { id: "wrk_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(200),
  http.protected
    .post("/experimental/workspace/warp", "experimental.workspace.warp")
    .at((ctx) => ({
      path: "/experimental/workspace/warp",
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected
    .post("/experimental/control-plane/move-session", "experimental.controlPlane.moveSession")
    .global()
    .at(() => ({
      path: "/experimental/control-plane/move-session",
      body: {},
    }))
    .status(400),
  http.protected
    .get("/experimental/tool", "tool.list")
    .at((ctx) => ({
      path: `/experimental/tool?${new URLSearchParams({ provider: "lmstudio", model: "test-model" })}`,
      headers: ctx.headers(),
    }))
    .json(200, array, "status"),
  http.protected.get("/experimental/tool/ids", "tool.ids").json(200, array),
  http.protected.get("/experimental/worktree", "worktree.list").json(200, array),
  http.protected
    .post("/experimental/worktree", "worktree.create")
    .mutating()
    .at((ctx) => ({ path: "/experimental/worktree", headers: ctx.headers(), body: { name: "api-dsl" } }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(typeof body.directory === "string", "created worktree should include directory")
          yield* ctx.worktreeRemove(body.directory)
        }),
      "status",
    ),
  http.protected
    .post("/experimental/worktree", "worktree.create.invalid")
    .at((ctx) => ({ path: "/experimental/worktree", headers: ctx.headers(), body: { name: 1 } }))
    .status(400),
  http.protected
    .delete("/experimental/worktree", "worktree.remove")
    .mutating()
    .seeded((ctx) => ctx.worktree({ name: "api-remove" }))
    .at((ctx) => ({ path: "/experimental/worktree", headers: ctx.headers(), body: { directory: ctx.state.directory } }))
    .json(200, (body) => {
      check(body === true, "worktree remove should return true")
    }),
  http.protected
    .post("/experimental/worktree/reset", "worktree.reset")
    .mutating()
    .seeded((ctx) => ctx.worktree({ name: "api-reset" }))
    .at((ctx) => ({
      path: "/experimental/worktree/reset",
      headers: ctx.headers(),
      body: { directory: ctx.state.directory },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "worktree reset should return true")
        yield* ctx.worktreeRemove(ctx.state.directory)
      }),
    ),
  http.protected
    .get("/experimental/session", "experimental.session.list")
    .at((ctx) => ({ path: "/experimental/session?roots=false&archived=false", headers: ctx.headers() }))
    .json(200, array),
  http.protected.get("/experimental/capabilities", "experimental.capabilities.get").json(200, (body) => {
    check(typeof body === "object" && body !== null, "capabilities should be an object")
    check("backgroundSubagents" in body, "capabilities should report background subagents")
    check("computer" in body && isRecord(body.computer), "capabilities should report computer availability")
    check(body.computer.available === false, "computer use needs a desktop bridge")
    check(body.computer.reason === "no_desktop_bridge", "computer availability should explain the missing bridge")
    check(
      typeof (body as { subagentLimits?: unknown }).subagentLimits === "boolean",
      "capabilities should report whether task lists carry subagent limits",
    )
    check(
      (body as { workDelegation?: unknown }).workDelegation === true,
      "capabilities should report that Work requests are offered subagents",
    )
    check(
      (body as { sessionStop?: unknown }).sessionStop === true,
      "capabilities should report the route that stops a session with its helpers",
    )
    check(
      (body as { taskPromote?: unknown }).taskPromote === true,
      "capabilities should report the route that moves a session's tasks to the background",
    )
    check(
      (body as { taskResume?: unknown }).taskResume === true,
      "capabilities should report the route that resumes a session's stopped or interrupted tasks",
    )
    check(
      (body as { taskAttention?: unknown }).taskAttention === true,
      "capabilities should report that tasks say when they wait on the user",
    )
    check(
      (body as { taskIsolation?: unknown }).taskIsolation === true,
      "capabilities should report the routes that review, merge and discard isolated tasks",
    )
    check(
      (body as { backgroundShells?: unknown }).backgroundShells === true,
      "capabilities should report that task lists, stop and wait reach background commands",
    )
  }),
  http.protected
    .post("/experimental/session/{sessionID}/background", "experimental.session.background")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Background route owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/background", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      check(body === false, "background route should be a no-op without running subagents")
    }),
  http.protected
    .post("/experimental/session/{sessionID}/stop", "experimental.session.stop")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Session stop owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/stop", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { helpers: true },
    }))
    .json(200, (body) => {
      object(body)
      array(body.tasks)
      check(body.aborted === false, "stopping an idle session should abort no turn")
      check(body.tasks.length === 0, "an idle session should have no helpers to stop")
      check(
        body.shells === 0 && body.excluded === 0 && body.skipped === 0,
        "an idle session should have no commands or workspaces to count",
      )
    }),
  http.protected.get("/experimental/workflow/saved", "experimental.workflow.saved").json(200, (body) => {
    object(body)
    array(body.workflows)
  }),
  http.protected
    .post("/experimental/workflow/validate", "experimental.workflow.validate.invalid")
    .withLlm()
    .at((ctx) => ({ path: "/experimental/workflow/validate", headers: ctx.headers(), body: { spec: "{}" } }))
    .json(200, (body) => {
      object(body)
      check(body.ok === false, "invalid workflow must not validate")
      array(body.issues)
    }),
  http.protected
    .post("/experimental/session/{sessionID}/workflow", "experimental.workflow.start.invalid")
    .withLlm()
    .seeded((ctx) => ctx.session({ title: "Invalid workflow owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/workflow", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { spec: "{}" },
    }))
    .status(400),
  http.protected
    .get("/experimental/session/{sessionID}/workflow", "experimental.workflow.list")
    .seeded((ctx) => ctx.session({ title: "Workflow board owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/workflow", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      array(body.runs)
      check(body.runs.length === 0, "fresh workflow board must be empty")
    }),
  http.protected
    .get("/experimental/session/{sessionID}/workflow/{runID}", "experimental.workflow.get.missing")
    .seeded((ctx) => ctx.session({ title: "Workflow detail owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/workflow/{runID}", {
        sessionID: ctx.state.id,
        runID: "ses_missing",
      }),
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .post("/experimental/session/{sessionID}/workflow/{runID}/resume", "experimental.workflow.resume.missing")
    .seeded((ctx) => ctx.session({ title: "Workflow resume owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/workflow/{runID}/resume", {
        sessionID: ctx.state.id,
        runID: "ses_missing",
      }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400),
  http.protected.get("/experimental/resource", "experimental.resource.list").json(),
  http.protected
    .get("/experimental/session/{sessionID}/tasks", "experimental.task.list")
    .seeded((ctx) => ctx.session({ title: "Task board owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      array(body.tasks)
      check(body.tasks.length === 0 && body.truncated === false, "a fresh task board should be empty")
      object(body.limits)
      const limits = body.limits as Record<string, unknown>
      check(
        ["running", "queued", "maxRunning", "launched", "maxPerRequest"].every(
          (key) => typeof limits[key] === "number",
        ),
        "the task board should carry the conversation's subagent counts and limits",
      )
      check(
        limits.running === 0 && limits.launched === 0 && limits.maxRunning === 8 && limits.maxPerRequest === 32,
        "a fresh conversation should have no subagents and the default limits",
      )
      object(limits.spend)
      check(
        typeof (limits.spend as Record<string, unknown>).spentUsd === "number",
        "the task board should carry the request's subagent spend",
      )
    }),
  http.protected
    .get("/experimental/session/{sessionID}/tasks", "experimental.task.list.active")
    .seeded((ctx) => ctx.session({ title: "Active task board owner" }))
    .at((ctx) => ({
      path: `${route("/experimental/session/{sessionID}/tasks", { sessionID: ctx.state.id })}?active=true&descendants=true`,
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      array(body.tasks)
      check(body.tasks.length === 0 && body.truncated === false, "a fresh active task board should be empty")
    }),
  http.protected
    .get("/experimental/session/{sessionID}/tasks", "experimental.task.list.shells")
    .seeded((ctx) => ctx.session({ title: "Background command board owner" }))
    .at((ctx) => ({
      path: `${route("/experimental/session/{sessionID}/tasks", { sessionID: ctx.state.id })}?shells=true`,
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      object(body)
      array(body.tasks)
      array(body.shells)
      check(body.shells.length === 0, "a fresh conversation should have no background commands")
    }),
  http.protected
    .get("/experimental/session/{sessionID}/tasks/{taskID}", "experimental.task.inspect.missing")
    .seeded((ctx) => ctx.session({ title: "Task inspection owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks/{taskID}", {
        sessionID: ctx.state.id,
        taskID: "ses_missing",
      }),
      headers: ctx.headers(),
    }))
    .status(400),
  http.protected
    .post("/experimental/session/{sessionID}/tasks/{taskID}/message", "experimental.task.message.missing")
    .seeded((ctx) => ctx.session({ title: "Task instruction owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks/{taskID}/message", {
        sessionID: ctx.state.id,
        taskID: "ses_missing",
      }),
      headers: ctx.headers(),
      body: { text: "Keep the existing public API", delivery: "steer" },
    }))
    .status(400),
  http.protected
    .post("/experimental/session/{sessionID}/tasks/stop", "experimental.task.stop.empty")
    .seeded((ctx) => ctx.session({ title: "Task stop owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks/stop", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { all: true },
    }))
    .json(200, (body) => {
      object(body)
      array(body.tasks)
      check(body.tasks.length === 0, "stopping an empty board should not start work")
    }),
  http.protected
    .post("/experimental/session/{sessionID}/tasks/background", "experimental.task.background")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Task background owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks/background", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(200, (body) => {
      object(body)
      array(body.tasks)
      check(body.tasks.length === 0, "a fresh session should have no task to move to the background")
    }),
  http.protected
    .post("/experimental/session/{sessionID}/tasks/resume", "experimental.task.resume.missing")
    .seeded((ctx) => ctx.session({ title: "Task resume owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks/resume", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { taskIDs: ["ses_missing"] },
    }))
    .status(400),
  http.protected
    .get("/experimental/session/{sessionID}/tasks/{taskID}/changes", "experimental.task.changes.missing")
    .seeded((ctx) => ctx.session({ title: "Task changes owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks/{taskID}/changes", {
        sessionID: ctx.state.id,
        taskID: "ses_missing",
      }),
      headers: ctx.headers(),
    }))
    .json(400, notIsolated),
  http.protected
    .post("/experimental/session/{sessionID}/tasks/{taskID}/merge", "experimental.task.merge.missing")
    .seeded((ctx) => ctx.session({ title: "Task merge owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks/{taskID}/merge", {
        sessionID: ctx.state.id,
        taskID: "ses_missing",
      }),
      headers: ctx.headers(),
    }))
    .json(400, notIsolated),
  http.protected
    .post("/experimental/session/{sessionID}/tasks/{taskID}/discard", "experimental.task.discard.missing")
    .seeded((ctx) => ctx.session({ title: "Task discard owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks/{taskID}/discard", {
        sessionID: ctx.state.id,
        taskID: "ses_missing",
      }),
      headers: ctx.headers(),
    }))
    .json(400, notIsolated),
  http.protected
    .post("/experimental/session/{sessionID}/tasks/resume", "experimental.task.resume.invalid")
    .seeded((ctx) => ctx.session({ title: "Task resume owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks/resume", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { taskIDs: [] },
    }))
    .status(400),
  http.protected
    .post("/experimental/session/{sessionID}/tasks/wait", "experimental.task.wait.invalid")
    .seeded((ctx) => ctx.session({ title: "Task wait owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks/wait", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { taskIDs: [], timeout: 0 },
    }))
    .status(400),
  http.protected
    .post("/experimental/session/{sessionID}/tasks/bridge/register", "experimental.task.bridge.register")
    .seeded((ctx) => ctx.session({ title: "Desktop task bridge owner" }))
    .at((ctx) => ({
      path: route("/experimental/session/{sessionID}/tasks/bridge/register", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { tasks: [] },
    }))
    .json(200, (body) => {
      object(body)
      check(typeof body.lease === "string" && body.lease.length >= 32, "the bridge should issue an opaque lease")
      check(typeof body.expiresAt === "number", "the bridge lease should expire")
    }),
  ...(["poll", "receipt"] as const).map((action) =>
    http.protected
      .post(`/experimental/session/{sessionID}/tasks/bridge/${action}`, `experimental.task.bridge.${action}.invalid`)
      .seeded((ctx) => ctx.session({ title: "Desktop lease rejection" }))
      .at((ctx) => ({
        path: route(`/experimental/session/{sessionID}/tasks/bridge/${action}`, { sessionID: ctx.state.id }),
        headers: ctx.headers(),
        body: {
          lease: "x".repeat(64),
          ...(action === "poll" ? { timeout: 0 } : { commandID: "missing", error: "Not executed" }),
        },
      }))
      .status(400),
  ),
  http.protected
    .post("/sync/history", "sync.history.list")
    .at((ctx) => ({ path: "/sync/history", headers: ctx.headers(), body: {} }))
    .json(200, array),
  http.protected
    .post("/sync/replay", "sync.replay")
    .at((ctx) => ({ path: "/sync/replay", headers: ctx.headers(), body: { directory: ctx.directory, events: [] } }))
    .status(400),
  http.protected
    .post("/sync/steal", "sync.steal.invalid")
    .at((ctx) => ({ path: "/sync/steal", headers: ctx.headers(), body: {} }))
    .status(400, undefined, "status"),
  http.protected
    .post("/sync/start", "sync.start")
    .mutating()
    .preserveDatabase()
    .json(200, (body) => {
      check(body === true, "sync start should return true when no workspace sessions exist")
    }),
  http.protected
    .post("/instance/dispose", "instance.dispose")
    .mutating()
    .json(200, (body) => {
      check(body === true, "instance dispose should return true")
    }),
  http.protected
    .post("/log", "app.log")
    .global()
    .at(() => ({ path: "/log", body: { service: "httpapi-exercise", level: "info", message: "route coverage" } }))
    .json(200, (body) => {
      check(body === true, "log route should return true")
    }),
  ...[true, false].map((exists) =>
    http.protected
      .get("/auth/{providerID}", `auth.exists.${exists ? "present" : "missing"}`)
      .global()
      .seeded(() =>
        Effect.promise(() =>
          Bun.write(
            path.join(exerciseDataDirectory, "auth.json"),
            JSON.stringify(exists ? { lmstudio: { type: "api", key: "isolated-test-key" } } : {}),
          ),
        ),
      )
      .at(() => ({ path: route("/auth/{providerID}", { providerID: "lmstudio" }) }))
      .json(200, (body) => {
        check(body === exists, "auth presence should report only whether the isolated credential exists")
      }),
  ),
  http.protected
    .put("/auth/{providerID}", "auth.set")
    .global()
    .at(() => ({
      path: route("/auth/{providerID}", { providerID: "lmstudio" }),
      body: { type: "api", key: "test-key" },
    }))
    .jsonEffect(200, (body) =>
      Effect.gen(function* () {
        check(body === true, "auth set should return true")
        const auth = yield* Effect.promise(() => Bun.file(path.join(exerciseDataDirectory, "auth.json")).json())
        object(auth)
        check(isRecord(auth.lmstudio) && auth.lmstudio.key === "test-key", "auth set should write isolated auth file")
      }),
    ),
  http.protected
    .delete("/auth/{providerID}", "auth.remove")
    .global()
    .seeded(() =>
      Effect.promise(() =>
        Bun.write(
          path.join(exerciseDataDirectory, "auth.json"),
          JSON.stringify({ lmstudio: { type: "api", key: "remove-me" } }),
        ),
      ),
    )
    .at(() => ({ path: route("/auth/{providerID}", { providerID: "lmstudio" }) }))
    .jsonEffect(200, (body) =>
      Effect.gen(function* () {
        check(body === true, "auth remove should return true")
        const auth = yield* Effect.promise(() => Bun.file(path.join(exerciseDataDirectory, "auth.json")).json())
        object(auth)
        check(auth.lmstudio === undefined, "auth remove should delete provider from isolated auth file")
      }),
    ),
  http.protected.get("/api/health", "v2.health.get").json(200, (body) => {
    object(body)
    check(body.healthy === true, "v2 server should report healthy")
  }),
  http.protected.get("/api/location", "v2.location.get").json(200, object),
  http.protected.get("/api/agent", "v2.agent.list").json(200, locationData(array)),
  http.protected.get("/api/model", "v2.model.list").json(200, locationData(array)),
  http.protected.get("/api/provider", "v2.provider.list").json(200, locationData(array)),
  http.protected.get("/api/integration", "v2.integration.list").json(200, locationData(array)),
  http.protected
    .get("/api/integration/{integrationID}", "v2.integration.get")
    .at((ctx) => ({
      path: route("/api/integration/{integrationID}", { integrationID: "missing" }),
      headers: ctx.headers(),
    }))
    .json(200, object),
  http.protected
    .post("/api/integration/{integrationID}/connect/key", "v2.integration.connect.key")
    .at((ctx) => ({
      path: route("/api/integration/{integrationID}/connect/key", { integrationID: "missing" }),
      headers: ctx.headers(),
      body: { key: "test" },
    }))
    .status(500, undefined, "status"),
  http.protected
    .post("/api/integration/{integrationID}/connect/oauth", "v2.integration.connect.oauth")
    .at((ctx) => ({
      path: route("/api/integration/{integrationID}/connect/oauth", { integrationID: "missing" }),
      headers: ctx.headers(),
      body: { methodID: "missing", inputs: {} },
    }))
    .status(500, undefined, "status"),
  http.protected
    .get("/api/integration/attempt/{attemptID}", "v2.integration.attempt.status")
    .at((ctx) => ({
      path: route("/api/integration/attempt/{attemptID}", { attemptID: "con_missing" }),
      headers: ctx.headers(),
    }))
    .status(500, undefined, "status"),
  http.protected
    .post("/api/integration/attempt/{attemptID}/complete", "v2.integration.attempt.complete")
    .at((ctx) => ({
      path: route("/api/integration/attempt/{attemptID}/complete", { attemptID: "con_missing" }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(500, undefined, "status"),
  http.protected
    .delete("/api/integration/attempt/{attemptID}", "v2.integration.attempt.cancel")
    .at((ctx) => ({
      path: route("/api/integration/attempt/{attemptID}", { attemptID: "con_missing" }),
      headers: ctx.headers(),
    }))
    .status(204, undefined, "status"),
  http.protected
    .delete("/api/credential/{credentialID}", "v2.credential.remove")
    .at((ctx) => ({
      path: route("/api/credential/{credentialID}", { credentialID: "cred_missing" }),
      headers: ctx.headers(),
    }))
    .status(204, undefined, "status"),
  http.protected
    .patch("/api/credential/{credentialID}", "v2.credential.update")
    .at((ctx) => ({
      path: route("/api/credential/{credentialID}", { credentialID: "cred_missing" }),
      headers: ctx.headers(),
      body: { label: "Work" },
    }))
    .status(204, undefined, "status"),
  http.protected.get("/api/command", "v2.command.list").json(200, locationData(array)),
  http.protected.get("/api/skill", "v2.skill.list").json(200, locationData(array)),
  http.protected
    .get("/api/event", "v2.event.subscribe")
    .stream()
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.contentType.includes("text/event-stream"), "v2 event should be an SSE stream")
          check(result.text.includes("server.connected"), "v2 event should emit initial connection event")
          check(!result.text.includes('"location"'), "v2 connection event should not be scoped to a location")
        }),
      "status",
    ),
  http.protected
    .get("/api/fs/read/*", "v2.fs.read")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: "/api/fs/read/hello.txt", headers: ctx.headers() }))
    .status(
      200,
      (_ctx, result) =>
        Effect.sync(() => {
          check(result.text === "hello\n", "v2 fs read should return the file body")
          check(result.contentType.includes("text/plain"), "v2 fs read should return the file content type")
        }),
      "status",
    ),
  http.protected.get("/api/fs/list", "v2.fs.list").json(200, locationData(array)),
  http.protected
    .get("/api/fs/find", "v2.fs.find")
    .seeded((ctx) => ctx.file("hello.txt", "hello\n"))
    .at((ctx) => ({ path: "/api/fs/find?query=hello&type=file", headers: ctx.headers() }))
    .json(200, locationData(array)),
  http.protected.get("/api/pty", "v2.pty.list").json(200, locationData(array)),
  http.protected
    .post("/api/pty", "v2.pty.create")
    .mutating()
    .at((ctx) => ({ path: "/api/pty", headers: ctx.headers(), body: controlledPtyInput("HTTP API V2 PTY") }))
    .json(200, locationData(object)),
  http.protected
    .get("/api/pty/{ptyID}", "v2.pty.get")
    .at((ctx) => ({ path: route("/api/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .put("/api/pty/{ptyID}", "v2.pty.update")
    .mutating()
    .at((ctx) => ({
      path: route("/api/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }),
      headers: ctx.headers(),
      body: { title: "missing" },
    }))
    .json(404, object, "status"),
  http.protected
    .delete("/api/pty/{ptyID}", "v2.pty.remove")
    .mutating()
    .at((ctx) => ({ path: route("/api/pty/{ptyID}", { ptyID: "pty_httpapi_missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected
    .post("/api/pty/{ptyID}/connect-token", "v2.pty.connectToken")
    .at((ctx) => ({
      path: route("/api/pty/{ptyID}/connect-token", { ptyID: "pty_httpapi_missing" }),
      headers: { ...ctx.headers(), "x-vector-ticket": "1" },
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/pty/{ptyID}/connect", "v2.pty.connect")
    .at((ctx) => ({
      path: route("/api/pty/{ptyID}/connect", { ptyID: "pty_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404, undefined, "none"),
  http.protected.get("/api/reference", "v2.reference.list").json(200, object),
  http.protected
    .get("/api/provider/{providerID}", "v2.provider.get")
    .at((ctx) => ({ path: route("/api/provider/{providerID}", { providerID: "missing" }), headers: ctx.headers() }))
    .json(404, object, "status"),
  http.protected.get("/api/permission/request", "v2.permission.request.list").json(200, (body) => {
    object(body)
    object(body.location)
    array(body.data)
  }),
  http.protected.get("/api/question/request", "v2.question.request.list").json(200, (body) => {
    object(body)
    object(body.location)
    array(body.data)
  }),
  http.protected
    .post("/api/session/{sessionID}/permission", "v2.session.permission.create")
    .seeded((ctx) => ctx.session({ title: "Permission create owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/permission", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { action: "read", resources: [".env"] },
    }))
    .json(200, (body) => {
      object(body)
      object(body.data)
      check(typeof body.data.id === "string", "permission create should return an ID")
      check(body.data.effect === "ask", "permission create should create a pending request")
    }),
  http.protected
    .get("/api/session/{sessionID}/permission", "v2.session.permission.list")
    .seeded((ctx) => ctx.session({ title: "Permission list owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/permission", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, data(array)),
  http.protected
    .get("/api/session/{sessionID}/permission/{requestID}", "v2.session.permission.get")
    .seeded((ctx) => ctx.session({ title: "Permission get owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/permission/{requestID}", {
        sessionID: ctx.state.id,
        requestID: "per_httpapi_missing",
      }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/question", "v2.session.question.list")
    .seeded((ctx) => ctx.session({ title: "Question list owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/question", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, data(array)),
  http.protected
    .post("/api/session/{sessionID}/permission/{requestID}/reply", "v2.session.permission.reply")
    .seeded((ctx) => ctx.session({ title: "Permission owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/permission/{requestID}/reply", {
        sessionID: ctx.state.id,
        requestID: "per_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { reply: "once" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/question/{requestID}/reply", "v2.session.question.reply")
    .seeded((ctx) => ctx.session({ title: "Question reply owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/question/{requestID}/reply", {
        sessionID: ctx.state.id,
        requestID: "que_httpapi_missing",
      }),
      headers: ctx.headers(),
      body: { answers: [] },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/question/{requestID}/reject", "v2.session.question.reject")
    .seeded((ctx) => ctx.session({ title: "Question reject owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/question/{requestID}/reject", {
        sessionID: ctx.state.id,
        requestID: "que_httpapi_missing",
      }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected.get("/api/permission/saved", "v2.permission.saved.list").json(200, (body) => {
    object(body)
    array(body.data)
  }),
  http.protected
    .delete("/api/permission/saved/{id}", "v2.permission.saved.remove")
    .at((ctx) => ({ path: route("/api/permission/saved/{id}", { id: "psv_httpapi_missing" }), headers: ctx.headers() }))
    .status(204, undefined, "status"),
  http.protected
    .get("/api/session", "v2.session.list")
    .at((ctx) => ({ path: "/api/session?roots=true", headers: ctx.headers() }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.data)
        object(body.cursor)
      },
      "none",
    ),
  http.protected
    .get("/api/session", "v2.session.list.filters")
    .at((ctx) => ({
      path: `/api/session?${new URLSearchParams({
        limit: "2",
        order: "asc",
        path: ".",
        roots: "false",
        start: "0",
        search: "missing",
        directory: ctx.directory ?? "",
      })}`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.data)
        object(body.cursor)
      },
      "none",
    ),
  http.protected
    .get("/api/session", "v2.session.list.cursor")
    .at((ctx) => ({
      path: `/api/session?${new URLSearchParams({
        limit: "2",
        cursor: cursor({
          order: "desc",
          directory: ctx.directory,
          anchor: { id: "ses_httpapi_missing", time: 0, direction: "next" },
        }),
      })}`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.data)
        object(body.cursor)
      },
      "none",
    ),
  http.protected
    .get("/api/session", "v2.session.list.cursor.invalid")
    .at((ctx) => ({
      path: `/api/session?${new URLSearchParams({
        cursor: "invalid",
      })}`,
      headers: ctx.headers(),
    }))
    .status(400, undefined, "none"),
  http.protected.get("/api/session/active", "v2.session.active").json(200, data(object), "none"),
  http.protected
    .post("/api/session", "v2.session.create")
    .at((ctx) => ({
      path: "/api/session",
      headers: { ...ctx.headers(), "content-type": "application/json" },
      body: {},
    }))
    .json(200, data(object)),
  http.protected
    .get("/api/session/{sessionID}", "v2.session.get")
    .seeded((ctx) => ctx.session({ title: "Session get" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(200, data(object)),
  http.protected
    .get("/api/session/{sessionID}/spend", "v2.session.spend.unguarded")
    .seeded((ctx) => ctx.session({ title: "Session spend" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/spend", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    // A session no run guard has seen in this process answers no snapshot, never a zero one.
    .json(200, (body) => {
      object(body)
      check(body.data === undefined, "expected no spend snapshot for an unguarded session")
    }),
  http.protected
    .post("/api/session/{sessionID}/agent", "v2.session.switchAgent")
    .seeded((ctx) => ctx.session({ title: "Switch agent" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/agent", { sessionID: ctx.state.id }),
      headers: { ...ctx.headers(), "content-type": "application/json" },
      body: { agent: "plan" },
    }))
    .status(204, undefined, "none"),
  http.protected
    .post("/api/session/{sessionID}/model", "v2.session.switchModel")
    .seeded((ctx) => ctx.session({ title: "Switch model" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/model", { sessionID: ctx.state.id }),
      headers: { ...ctx.headers(), "content-type": "application/json" },
      body: { model: { providerID: "lmstudio", id: "test-model" } },
    }))
    .status(204, undefined, "none"),
  http.protected
    .get("/api/session/{sessionID}/context", "v2.session.context")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/context", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/revert/stage", "v2.session.revert.stage")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/revert/stage", { sessionID: "ses_httpapi_missing" }),
      headers: { ...ctx.headers(), "content-type": "application/json" },
      body: { messageID: "msg_httpapi_missing" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/revert/clear", "v2.session.revert.clear")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/revert/clear", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/revert/commit", "v2.session.revert.commit")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/revert/commit", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/message", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages.params")
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/message", { sessionID: "ses_httpapi_missing" })}?${new URLSearchParams({
        limit: "2",
        order: "asc",
      })}`,
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages.cursor")
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/message", { sessionID: "ses_httpapi_missing" })}?${new URLSearchParams({
        limit: "2",
        directory: ctx.directory ?? "",
        cursor: cursor({ id: "msg_httpapi_missing", time: 0, order: "desc", direction: "next" }),
      })}`,
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/message", "v2.session.messages.cursor.invalid")
    .seeded((ctx) => ctx.session({ title: "Invalid message cursor owner" }))
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/message", { sessionID: ctx.state.id })}?${new URLSearchParams({
        cursor: cursor({ id: "msg_httpapi_missing", time: 0, order: "desc", direction: "next" }),
        order: "asc",
      })}`,
      headers: ctx.headers(),
    }))
    .status(400, undefined, "none"),
  http.protected
    .get("/api/session/{sessionID}/history", "v2.session.history")
    .seeded((ctx) => ctx.session({ title: "Session history" }))
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/history", { sessionID: ctx.state.id })}?${new URLSearchParams({
        after: "0",
        limit: "2",
      })}`,
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body) => {
        object(body)
        array(body.data)
        check(typeof body.hasMore === "boolean", "Expected a history exhaustion signal")
      },
      "none",
    ),
  http.protected
    .get("/api/session/{sessionID}/history", "v2.session.history.missing")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/history", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/history", "v2.session.history.invalid")
    .seeded((ctx) => ctx.session({ title: "Invalid history sequence" }))
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/history", { sessionID: ctx.state.id })}?after=-1`,
      headers: ctx.headers(),
    }))
    .json(400, object, "status"),
  http.protected
    .get("/api/session/{sessionID}/event", "v2.session.events.missing")
    .at((ctx) => ({
      path: `${route("/api/session/{sessionID}/event", { sessionID: "ses_httpapi_missing" })}?after=0`,
      headers: ctx.headers(),
    }))
    .status(404, undefined, "status"),
  http.protected
    .post("/api/session/{sessionID}/interrupt", "v2.session.interrupt")
    .seeded((ctx) => ctx.session({ title: "Interrupt session" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/interrupt", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .status(204, undefined, "none"),
  http.protected
    .get("/api/session/{sessionID}/message/{messageID}", "v2.session.message.missing")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/message/{messageID}", {
        sessionID: "ses_httpapi_missing",
        messageID: "msg_httpapi_missing",
      }),
      headers: ctx.headers(),
    }))
    .json(404, object, "status"),
  http.protected
    .post("/api/session/{sessionID}/prompt", "v2.session.prompt.invalid")
    .seeded((ctx) => ctx.session({ title: "Invalid prompt owner" }))
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/prompt", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .status(400, undefined, "none"),
  http.protected
    .post("/api/session/{sessionID}/compact", "v2.session.compact")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/compact", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404, undefined, "status"),
  http.protected
    .post("/api/session/{sessionID}/wait", "v2.session.wait")
    .at((ctx) => ({
      path: route("/api/session/{sessionID}/wait", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404, undefined, "status"),
  http.protected
    .get("/session", "session.list")
    .seeded((ctx) => ctx.session({ title: "List me" }))
    .at((ctx) => ({ path: "/session?roots=true", headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      array(body)
      check(
        body.some((item) => isRecord(item) && item.id === ctx.state.id && item.title === "List me"),
        "seeded session should be listed",
      )
    }),
  http.protected
    .get("/session/status", "session.status")
    .seeded((ctx) => ctx.session({ title: "Status session" }))
    .json(200, object),
  http.protected
    .post("/session", "session.create")
    .mutating()
    .at((ctx) => ({ path: "/session", headers: ctx.headers(), body: { title: "Created session" } }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.title === "Created session", "created session should use requested title")
        check(body.directory === ctx.directory, "created session should use scenario directory")
      },
      "status",
    ),
  http.protected
    .get("/session/{sessionID}", "session.get")
    .seeded((ctx) => ctx.session({ title: "Get me" }))
    .at((ctx) => ({ path: route("/session/{sessionID}", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body, ctx) => {
      object(body)
      check(body.id === ctx.state.id, "should return requested session")
      check(body.title === "Get me", "should preserve seeded title")
    }),
  http.protected
    .get("/session/{sessionID}", "session.get.missing")
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .status(404),
  http.protected
    .patch("/session/{sessionID}", "session.update")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Before rename" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { title: "After rename" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.title === "After rename", "updated session should use new title")
      },
      "status",
    ),
  http.protected
    .patch("/session/{sessionID}", "session.update.invalid")
    .mutating()
    .at((ctx) => ({
      path: route("/session/{sessionID}", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
      body: { title: 1 },
    }))
    .status(400),
  http.protected
    .delete("/session/{sessionID}", "session.delete")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Delete me" }))
    .at((ctx) => ({ path: route("/session/{sessionID}", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete should return true")
        check((yield* ctx.sessionGet(ctx.state.id)) === undefined, "deleted session should not remain in storage")
      }),
    ),
  http.protected
    .get("/session/{sessionID}/children", "session.children")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const parent = yield* ctx.session({ title: "Parent" })
        const child = yield* ctx.session({ title: "Child", parentID: parent.id })
        return { parent, child }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/children", { sessionID: ctx.state.parent.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      array(body)
      check(
        body.some((item) => isRecord(item) && item.id === ctx.state.child.id && item.parentID === ctx.state.parent.id),
        "children should include seeded child",
      )
    }),
  http.protected
    .get("/session/{sessionID}/todo", "session.todo")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Todo session" })
        const todos = [{ content: "cover session todo", status: "pending" as const, priority: "high" as const }]
        yield* ctx.todos(session.id, todos)
        return { session, todos }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/todo", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      check(stable(body) === stable(ctx.state.todos), "todos should match seeded state")
    }),
  http.protected
    .get("/session/{sessionID}/diff", "session.diff")
    .seeded((ctx) => ctx.session({ title: "Diff session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/diff", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, array),
  http.protected
    .get("/session/{sessionID}/message", "session.messages")
    .seeded((ctx) => ctx.session({ title: "Messages session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/message", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      array(body)
      check(body.length === 0, "new session should have no messages")
    }),
  http.protected
    .get("/session/{sessionID}/message/{messageID}", "session.message")
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Message get session" })
        const message = yield* ctx.message(session.id, { text: "read me" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
      }),
      headers: ctx.headers(),
    }))
    .json(200, (body, ctx) => {
      object(body)
      check(isRecord(body.info) && body.info.id === ctx.state.message.info.id, "should return requested message")
      check(
        Array.isArray(body.parts) && body.parts.some((part) => isRecord(part) && part.id === ctx.state.message.part.id),
        "message should include seeded part",
      )
    }),
  http.protected
    .patch("/session/{sessionID}/message/{messageID}/part/{partID}", "part.update")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Part update session" })
        const message = yield* ctx.message(session.id, { text: "before" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}/part/{partID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
        partID: ctx.state.message.part.id,
      }),
      headers: ctx.headers(),
      body: { ...ctx.state.message.part, text: "after" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.type === "text" && body.text === "after", "updated part should be returned")
      },
      "status",
    ),
  http.protected
    .delete("/session/{sessionID}/message/{messageID}/part/{partID}", "part.delete")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Part delete session" })
        const message = yield* ctx.message(session.id, { text: "delete part" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}/part/{partID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
        partID: ctx.state.message.part.id,
      }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete part should return true")
        const messages = yield* ctx.messages(ctx.state.session.id)
        check(messages[0]?.parts.length === 0, "deleted part should not remain on message")
      }),
    ),
  http.protected
    .delete("/session/{sessionID}/message/{messageID}", "session.deleteMessage")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Message delete session" })
        const message = yield* ctx.message(session.id, { text: "delete message" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message/{messageID}", {
        sessionID: ctx.state.session.id,
        messageID: ctx.state.message.info.id,
      }),
      headers: ctx.headers(),
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "delete message should return true")
        check((yield* ctx.messages(ctx.state.session.id)).length === 0, "deleted message should not remain")
      }),
    ),
  http.protected
    .post("/session/{sessionID}/fork", "session.fork")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Fork source" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/fork", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {},
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(typeof body.id === "string", "fork should return a session")
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/abort", "session.abort")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Abort session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/abort", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(200, (body) => {
      check(body === true, "abort should return true")
    }),
  http.protected
    .post("/session/{sessionID}/abort", "session.abort.missing")
    .at((ctx) => ({
      path: route("/session/{sessionID}/abort", { sessionID: "ses_httpapi_missing" }),
      headers: ctx.headers(),
    }))
    .json(200, (body) => {
      check(body === true, "missing session abort should remain a no-op success")
    }),
  http.protected
    .post("/session/{sessionID}/init", "session.init")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Init session" })
        const message = yield* ctx.message(session.id, { text: "initialize" })
        yield* ctx.llmText("initialized")
        yield* ctx.llmText("initialized")
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/init", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { providerID: "lmstudio", modelID: "test-model", messageID: ctx.state.message.info.id },
    }))
    .jsonEffect(200, (body, ctx) =>
      Effect.gen(function* () {
        check(body === true, "init should return true")
        yield* ctx.llmWait(1)
      }),
    ),
  http.protected
    .post("/session/{sessionID}/message", "session.prompt")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "LLM prompt session" })
        yield* ctx.llmText("fake assistant")
        yield* ctx.llmText("fake assistant")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/message", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        agent: "build",
        model: { providerID: "lmstudio", modelID: "test-model" },
        parts: [{ type: "text", text: "hello llm" }],
      },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(isRecord(body.info) && body.info.role === "assistant", "prompt should return assistant message")
          check(
            Array.isArray(body.parts) && body.parts.some((part) => isRecord(part) && part.text === "fake assistant"),
            "assistant message should use fake LLM text",
          )
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/prompt_async", "session.prompt_async")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Async prompt session" })
        yield* ctx.llmText("fake async assistant")
        yield* ctx.llmText("fake async assistant")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/prompt_async", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: {
        agent: "build",
        model: { providerID: "lmstudio", modelID: "test-model" },
        parts: [{ type: "text", text: "hello async" }],
      },
    }))
    .status(204, (ctx) =>
      Effect.gen(function* () {
        yield* ctx.llmWait(1)
      }),
    ),
  http.protected
    .post("/session/{sessionID}/command", "session.command")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Command session" })
        yield* ctx.llmText("command done")
        yield* ctx.llmText("command done")
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/command", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { command: "init", arguments: "", model: "lmstudio/test-model" },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          object(body)
          check(isRecord(body.info) && body.info.role === "assistant", "command should return assistant message")
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/shell", "session.shell")
    .preserveDatabase()
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Shell session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/shell", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { agent: "build", model: { providerID: "lmstudio", modelID: "test-model" }, command: "printf shell-ok" },
    }))
    .json(
      200,
      (body) => {
        object(body)
        check(isRecord(body.info) && body.info.role === "assistant", "shell should return assistant message")
        check(
          Array.isArray(body.parts) && body.parts.some((part) => isRecord(part) && part.type === "tool"),
          "shell should return a tool part",
        )
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/summarize", "session.summarize")
    .preserveDatabase()
    .withLlm()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Summarize session" })
        yield* ctx.message(session.id, { text: "summarize this work" })
        const summary = [
          "## Goal",
          "- Exercise session summarize.",
          "",
          "## Constraints & Preferences",
          "- Use fake LLM.",
          "",
          "## Progress",
          "### Done",
          "- Summary generated.",
          "",
          "### In Progress",
          "- (none)",
          "",
          "### Blocked",
          "- (none)",
          "",
          "## Key Decisions",
          "- Keep route local.",
          "",
          "## Next Steps",
          "- (none)",
          "",
          "## Critical Context",
          "- Test fixture.",
          "",
          "## Relevant Files",
          "- test/server/httpapi-exercise/index.ts: scenario",
        ].join("\n")
        yield* ctx.llmText(summary)
        yield* ctx.llmText(summary)
        return session
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/summarize", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { providerID: "lmstudio", modelID: "test-model", auto: false },
    }))
    .jsonEffect(
      200,
      (body, ctx) =>
        Effect.gen(function* () {
          check(body === true, "summarize should return true")
          const messages = yield* ctx.messages(ctx.state.id)
          check(
            messages.some((message) => message.info.role === "assistant" && message.info.summary === true),
            "summarize should create a summary assistant message",
          )
          yield* ctx.llmWait(1)
        }),
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/revert", "session.revert")
    .mutating()
    .seeded((ctx) =>
      Effect.gen(function* () {
        const session = yield* ctx.session({ title: "Revert session" })
        const message = yield* ctx.message(session.id, { text: "revert me" })
        return { session, message }
      }),
    )
    .at((ctx) => ({
      path: route("/session/{sessionID}/revert", { sessionID: ctx.state.session.id }),
      headers: ctx.headers(),
      body: { messageID: ctx.state.message.info.id },
    }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.session.id, "revert should return the session")
        check(
          isRecord(body.revert) && body.revert.messageID === ctx.state.message.info.id,
          "revert should record reverted message",
        )
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/unrevert", "session.unrevert")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Unrevert session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/unrevert", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
    }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.id, "unrevert should return the session")
      },
      "status",
    ),
  http.protected
    .post("/session/{sessionID}/permissions/{permissionID}", "permission.respond")
    .seeded((ctx) => ctx.session({ title: "Deprecated permission session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/permissions/{permissionID}", {
        sessionID: ctx.state.id,
        permissionID: "per_httpapi_deprecated",
      }),
      headers: ctx.headers(),
      body: { response: "once" },
    }))
    .json(404, object, "status"),
  http.protected
    .post("/session/{sessionID}/share", "session.share.disabledConsent")
    .inProject({ git: true, config: { share: "disabled" } })
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Share session" }))
    .at((ctx) => ({
      path: route("/session/{sessionID}/share", { sessionID: ctx.state.id }),
      headers: ctx.headers(),
      body: { consent: { version: 1, public: true, updates: false }, expiresAt: Date.now() + 60_000 },
    }))
    .jsonEffect(400, (body, ctx) =>
      Effect.gen(function* () {
        object(body)
        check(
          body._tag === "InvalidRequestError" && body.kind === "SharingUnavailable",
          "disabled sharing must reject even a valid publish payload",
        )
        const session = http.protected
          .get("/session/{sessionID}", "session.share.readback")
          .at(() => ({ path: route("/session/{sessionID}", { sessionID: ctx.state.id }), headers: ctx.headers() }))
          .json(200, (body) => {
            object(body)
            check(body.share === undefined, "disabled sharing must leave the session private")
          })
        const result = yield* call(session, ctx)
        yield* session.expect(ctx, undefined, result)
      }),
    ),
  http.protected
    .delete("/session/{sessionID}/share", "session.unshare")
    .mutating()
    .seeded((ctx) => ctx.session({ title: "Unshare session" }))
    .at((ctx) => ({ path: route("/session/{sessionID}/share", { sessionID: ctx.state.id }), headers: ctx.headers() }))
    .json(
      200,
      (body, ctx) => {
        object(body)
        check(body.id === ctx.state.id, "unshare should return the session")
      },
      "status",
    ),
  http.protected
    .post("/tui/append-prompt", "tui.appendPrompt")
    .at((ctx) => ({ path: "/tui/append-prompt", headers: ctx.headers(), body: { text: "hello" } }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/select-session", "tui.selectSession.invalid")
    .at((ctx) => ({ path: "/tui/select-session", headers: ctx.headers(), body: { sessionID: "invalid" } }))
    .status(400),
  http.protected.post("/tui/open-help", "tui.openHelp").json(200, boolean, "status"),
  http.protected.post("/tui/open-sessions", "tui.openSessions").json(200, boolean, "status"),
  http.protected.post("/tui/open-themes", "tui.openThemes").json(200, boolean, "status"),
  http.protected.post("/tui/open-models", "tui.openModels").json(200, boolean, "status"),
  http.protected.post("/tui/submit-prompt", "tui.submitPrompt").json(200, boolean, "status"),
  http.protected.post("/tui/clear-prompt", "tui.clearPrompt").json(200, boolean, "status"),
  http.protected
    .post("/tui/execute-command", "tui.executeCommand")
    .at((ctx) => ({ path: "/tui/execute-command", headers: ctx.headers(), body: { command: "agent_cycle" } }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/show-toast", "tui.showToast")
    .at((ctx) => ({
      path: "/tui/show-toast",
      headers: ctx.headers(),
      body: { title: "Exercise", message: "covered", variant: "info", duration: 1000 },
    }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/publish", "tui.publish")
    .at((ctx) => ({
      path: "/tui/publish",
      headers: ctx.headers(),
      body: { type: "tui.prompt.append", properties: { text: "published" } },
    }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/select-session", "tui.selectSession")
    .seeded((ctx) => ctx.session({ title: "TUI select" }))
    .at((ctx) => ({ path: "/tui/select-session", headers: ctx.headers(), body: { sessionID: ctx.state.id } }))
    .json(200, boolean, "status"),
  http.protected
    .post("/tui/control/response", "tui.control.response")
    .at((ctx) => ({ path: "/tui/control/response", headers: ctx.headers(), body: { ok: true } }))
    .json(200, boolean, "status"),
  http.protected
    .get("/tui/control/next", "tui.control.next")
    .mutating()
    .seeded((ctx) => ctx.tuiRequest({ path: "/tui/exercise", body: { text: "queued" } }))
    .json(
      200,
      (body) => {
        object(body)
        check(body.path === "/tui/exercise", "control next should return queued path")
        object(body.body)
        check(body.body.text === "queued", "control next should return queued body")
      },
      "status",
    ),
  http.protected
    .post("/global/upgrade", "global.upgrade")
    .global()
    .probe({ path: "/global/upgrade", body: { target: 1 } })
    .at(() => ({ path: "/global/upgrade", body: { target: 1 } }))
    .status(400),
]

const llmScenarios = new Set([
  "experimental.session.usage",
  "session.init",
  "session.prompt",
  "session.prompt_async",
  "session.command",
  "session.summarize",
])

const main = Effect.gen(function* () {
  yield* Effect.addFinalizer(() => Effect.promise(() => disposeApps()).pipe(Effect.andThen(cleanupExercisePaths)))
  const options = parseOptions(Bun.argv.slice(2))
  const modules = yield* Effect.promise(() => runtime())
  const effectRoutes = routeKeys(OpenApi.fromApi(modules.PublicApi))
  const selected = selectedScenarios(options, scenarios)
  const missing = effectRoutes.filter((route) => !scenarios.some((scenario) => route === routeKey(scenario)))
  const extra = scenarios.filter((scenario) => !effectRoutes.includes(routeKey(scenario)))

  for (const scenario of scenarios) {
    if (scenario.kind === "active" && llmScenarios.has(scenario.name) && !scenario.project?.llm) {
      return yield* Effect.fail(new Error(`${scenario.name} must use TestLLMServer via .withLlm()`))
    }
  }

  printHeader(options, effectRoutes, selected, missing, extra, {
    database: exerciseDatabasePath,
    global: exerciseGlobalRoot,
  })

  const results =
    options.mode === "coverage"
      ? selected.map(coverageResult)
      : yield* Effect.forEach(
          selected,
          (scenario) =>
            Effect.gen(function* () {
              if (options.progress) console.log(`${color.dim}RUN ${routeKey(scenario)} ${scenario.name}${color.reset}`)
              return yield* runScenario(options)(scenario)
            }),
          { concurrency: 1 },
        )
  printResults(results, missing, extra)

  if (results.some((result) => result.status === "fail"))
    return yield* Effect.fail(new Error("one or more scenarios failed"))
  if (options.failOnSkip && results.some((result) => result.status === "skip"))
    return yield* Effect.fail(new Error("one or more scenarios are skipped"))
  if (options.failOnMissing && missing.length > 0)
    return yield* Effect.fail(new Error("one or more routes have no scenario"))
  return undefined
})

Effect.runPromise(main.pipe(Effect.provide(TestLLMServer.layer), Effect.scoped)).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`${color.red}${message(error)}${color.reset}`)
    process.exit(1)
  },
)
