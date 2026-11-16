import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AgentV2 } from "@vectordevai/core/agent"
import { Database } from "@vectordevai/core/database/database"
import { AppNodeBuilder } from "@vectordevai/core/effect/app-node-builder"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { Location } from "@vectordevai/core/location"
import { PermissionV2 } from "@vectordevai/core/permission"
import { PermissionTable } from "@vectordevai/core/permission/sql"
import { PermissionSaved } from "@vectordevai/core/permission/saved"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { Project } from "@vectordevai/core/project"
import { ProjectTable } from "@vectordevai/core/project/sql"
import { AbsolutePath } from "@vectordevai/core/schema"
import { SessionV2 } from "@vectordevai/core/session"
import { SessionTable } from "@vectordevai/core/session/sql"
import { SessionStore } from "@vectordevai/core/session/store"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

function waitForRequest() {
  return Effect.gen(function* () {
    const service = yield* PermissionV2.Service
    const events = yield* EventV2.Service
    const asked = yield* Deferred.make<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(assertion()).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

describe("PermissionV2", () => {
  test("after-screen shell markers require a fresh answer without Always or auto-accept", () => {
    for (const action of ["bash", "shell", "terminal", "pwsh", "powershell", "cmd"]) {
      const patterns = [`${PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX}git status`]
      expect(PermissionPolicy.requiresApproval(action, ["*"], patterns)).toBe(true)
      expect(PermissionPolicy.canAutoApprove(action, ["*"], patterns)).toBe(false)
      expect(PermissionPolicy.canAlwaysApprove(action, ["*"], patterns)).toBe(false)
      expect(PermissionPolicy.commandPattern(action, patterns[0])).toBe("git status")
    }
    expect(PermissionPolicy.requiresApproval("bash", [], ["git status"])).toBe(false)
    expect(PermissionPolicy.requiresApproval("bash", [], ["after-screen dangerous"])).toBe(false)
    expect(PermissionPolicy.commandPattern("read", "after-screen file.txt")).toBe("after-screen file.txt")
    expect(PermissionPolicy.requiresApproval("read", [], ["after-screen file.txt"])).toBe(false)
  })

  test("after-screen markers preserve ordinary command allowlists and deny ceilings", () => {
    const rules: PermissionV2.Ruleset = [
      { action: "bash", resource: "*", effect: "deny" },
      { action: "bash", resource: "git status*", effect: "allow" },
    ]
    expect(PermissionV2.evaluate("bash", "#after-screen git status", rules).effect).toBe("allow")
    expect(PermissionV2.evaluate("bash", "#after-screen rm report.txt", rules).effect).toBe("deny")
    expect(
      PermissionV2.evaluate("bash", "after-screen dangerous", [
        { action: "bash", resource: "after-screen *", effect: "deny" },
      ]).effect,
    ).toBe("deny")
    expect(
      PermissionV2.evaluate("bash", "#after-screen git status", rules, [
        { action: "bash", resource: "git *", effect: "deny" },
      ]).effect,
    ).toBe("deny")
  })

  it.effect("after-screen shell approval ignores configured and saved allows and never saves the reply", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["*"] })
      const before = yield* saved.list({ projectID: Project.ID.global })
      const input = assertion({ action: "bash", resources: ["#after-screen git status"], save: ["*"] })
      expect(yield* service.ask(input)).toMatchObject({ effect: "ask" })
      yield* service.reply({ requestID: input.id, reply: "always" })
      expect(yield* saved.list({ projectID: Project.ID.global })).toEqual(before)
      expect(yield* service.ask(input)).toMatchObject({ effect: "ask" })
      yield* service.reply({ requestID: input.id, reply: "once" })
      yield* setRules([{ action: "bash", resource: "git *", effect: "deny" }])
      expect(yield* service.ask(input)).toMatchObject({ effect: "deny" })
    }),
  )

  test("preserves deny ceilings across trust tiers without changing ordered rules within a tier", () => {
    const deny: PermissionV2.Ruleset = [{ action: "bash", resource: "*", effect: "deny" }]
    const allow: PermissionV2.Ruleset = [{ action: "bash", resource: "pwd", effect: "allow" }]

    expect(PermissionV2.evaluate("bash", "pwd", deny, allow).effect).toBe("deny")
    expect(PermissionV2.evaluate("bash", "pwd", [...deny, ...allow]).effect).toBe("allow")
  })

  it.effect("Cloud account actions ask under configured allow and never retain approval", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "vector_cloud_publish", resources: ["*"] })
      for (const action of [
        "vector_cloud_publish",
        "vector_cloud_database",
        "vector_cloud_environment",
        "vector_cloud_hosting",
        "vector_cloud_future",
      ]) {
        const input = assertion({ action, save: action === "vector_cloud_future" ? [] : ["*"] })
        expect(yield* service.ask(input)).toMatchObject({ effect: "ask" })
        yield* service.reply({ requestID: input.id, reply: "always" })
        expect(yield* saved.list({ projectID: Project.ID.global })).toEqual([])
        expect(yield* service.ask(input)).toMatchObject({ effect: "ask" })
        yield* service.reply({ requestID: input.id, reply: "once" })
      }
      expect(yield* service.ask(assertion({ action: "vector_cloud_inspect", save: ["*"] }))).toMatchObject({
        effect: "allow",
      })
      yield* setRules([{ action: "*", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "vector_cloud_publish", save: ["*"] }))).toMatchObject({
        effect: "deny",
      })
    }),
  )

  it.effect("keeps hidden swarm planning read-only even under broad configured and saved approvals", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const database = yield* Database.Service
      yield* database.db
        .update(SessionTable)
        .set({ internal: "swarm.planner" })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "*", resources: ["*"] })
      const service = yield* PermissionV2.Service
      for (const action of ["question", "bash", "edit", "write", "task", "external_directory", "mcp_remote"]) {
        expect(yield* service.assert(assertion({ action })).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.DeniedError)
      }
      for (const resources of [[".env"], ["config/private.key"], ["mcp:server:resource"]]) {
        expect(yield* service.ask(assertion({ resources }))).toMatchObject({ effect: "deny" })
      }
      expect(
        yield* service.deniedResources(assertion({ resources: [".env", "config/private.key", "src/index.ts"] })),
      ).toEqual([".env", "config/private.key"])
      for (const action of ["read", "grep", "glob", "list", "StructuredOutput"]) {
        expect(yield* service.ask(assertion({ action }))).toMatchObject({ effect: "allow" })
      }
      yield* setRules([{ action: "read", resource: "src/*", effect: "deny" }])
      expect(yield* service.deniedResources(assertion({ resources: ["src/index.ts", "README.md"] }))).toEqual([
        "src/index.ts",
      ])
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  // The desktop swarm planner runs as explore. Turning explore off in Settings removes it, and without an agent every
  // tool call would be denied.
  it.effect("keeps a helper session's agent after configuration turns it off", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => editor.remove(AgentV2.ID.make("test")))
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "deny" })

      const database = yield* Database.Service
      yield* database.db
        .update(SessionTable)
        .set({ internal: "swarm.planner" })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
    }),
  )

  it.effect("returns the evaluated effect and only queues prompts", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
      yield* setRules([])
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("evaluates against an explicit provider-turn agent", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions.push({ action: "read", resource: "*", effect: "deny" })
        }),
      )
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion())).toMatchObject({ effect: "allow" })
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "deny" })
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("reviewer"), (agent) => {
          agent.permissions = []
        }),
      )
      expect(yield* service.ask(assertion({ agent: AgentV2.ID.make("reviewer") }))).toMatchObject({ effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).not.toHaveProperty("agent")
    }),
  )

  it.effect("allows and denies from explicit rules without asking", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "read", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion())
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      const denied = yield* service.assert(assertion()).pipe(Effect.flip)
      expect(denied).toBeInstanceOf(PermissionV2.DeniedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("allows managed output reads without granting external directory access", () =>
    Effect.gen(function* () {
      yield* setup([
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ])
      const service = yield* PermissionV2.Service

      expect(yield* service.ask(assertion({ resources: ["tool_123"] }))).toMatchObject({ effect: "allow" })
      expect(
        yield* service.ask(assertion({ action: "external_directory", resources: ["/tmp/tool-output/*"] })),
      ).toMatchObject({ effect: "deny" })
    }),
  )

  it.effect("uses build permissions when the Session agent is omitted", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "todowrite", resource: "*", effect: "allow" }]
        }),
      )

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "todowrite", resources: ["*"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("denies omitted-agent permissions when no primary default agent exists", () =>
    Effect.gen(function* () {
      yield* setup()
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((editor) => {
        editor.remove(AgentV2.ID.make("test"))
        editor.remove(AgentV2.ID.make("build"))
      })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion())).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "deny" })
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("evaluates bash with the normal configured-rule semantics", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const bash = assertion({ action: "bash", resources: ["pwd"] })
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "allow" })

      yield* setRules([])
      expect(yield* service.ask(bash)).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeDefined()
    }),
  )

  it.effect("uses saved bash approvals while preserving configured deny precedence", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "bash", resources: ["pwd"] })

      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "allow",
      })
      expect(yield* service.list()).toEqual([])

      yield* setRules([{ action: "bash", resource: "*", effect: "deny" }])
      expect(yield* service.ask(assertion({ action: "bash", resources: ["pwd"] }))).toEqual({
        id: PermissionV2.ID.create("per_test"),
        effect: "deny",
      })
    }),
  )

  it.effect("resolves an asked permission once", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      expect(yield* service.list()).toEqual([request])
      expect(yield* service.forSession(request.sessionID)).toEqual([request])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(request.id)).toEqual(request)
      yield* service.reply({ requestID: request.id, reply: "once" })
      yield* Fiber.join(fiber)
      expect(yield* service.list()).toEqual([])
      expect(yield* service.get(request.id)).toBeUndefined()
    }),
  )

  it.effect("does not persist a sensitive permanent approval", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service
        .assert(assertion({ action: "computer_sensitive", resources: ["window:42:0"], save: ["window:42:0"] }))
        .pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toEqual([])
    }),
  )

  it.effect("purges previously saved sensitive approvals instead of authorizing them", () =>
    Effect.gen(function* () {
      yield* setup()
      const saved = yield* PermissionSaved.Service
      yield* saved.add({
        projectID: Project.ID.global,
        action: "computer_sensitive",
        resources: ["window:42:0"],
      })

      const service = yield* PermissionV2.Service
      expect(
        yield* service.ask(
          assertion({ action: "computer_sensitive", resources: ["window:42:0"], save: ["window:42:0"] }),
        ),
      ).toEqual({ id: PermissionV2.ID.create("per_test"), effect: "ask" })
      expect(yield* saved.list({ projectID: Project.ID.global })).toEqual([])
    }),
  )

  it.effect("does not let a pending approval override a newly configured deny", () =>
    Effect.gen(function* () {
      yield* setup()
      const { service, fiber, request } = yield* waitForRequest()
      yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
      yield* service.reply({ requestID: request.id, reply: "once" })

      expect(yield* Fiber.join(fiber).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.DeniedError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("stores and removes saved resources for a project", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const asked = yield* Deferred.make<PermissionV2.Request>()
      const events = yield* EventV2.Service
      const unsubscribe = yield* events.listen((event) =>
        event.type === PermissionV2.Event.Asked.type
          ? Deferred.succeed(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
          : Effect.void,
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const fiber = yield* service.assert(assertion({ save: ["src/*"] })).pipe(Effect.forkScoped)
      const request = yield* Deferred.await(asked)
      yield* service.reply({ requestID: request.id, reply: "always" })
      yield* Fiber.join(fiber)

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(PermissionTable).where(eq(PermissionTable.project_id, Project.ID.global)).all(),
      ).toMatchObject([{ action: "read", resource: "src/*" }])
      const saved = yield* PermissionSaved.Service
      const id = (yield* saved.list())[0]!.id
      expect(yield* saved.list()).toEqual([{ id, projectID: Project.ID.global, action: "read", resource: "src/*" }])
      yield* service.assert(assertion({ id: PermissionV2.ID.create("per_next"), resources: ["src/next.ts"] }))
      yield* saved.remove(id)
      expect(yield* saved.list()).toEqual([])
    }),
  )
})

// Vector Hands (build contract E1, INV-C5 and INV-S6): every computer permission asks, and only the per-app ask can be
// saved as Always allow, for concrete app keys only.
describe("PermissionPolicy computer permissions", () => {
  const COMPUTER = [
    PermissionPolicy.COMPUTER_APP,
    PermissionPolicy.COMPUTER_OBSERVE,
    PermissionPolicy.COMPUTER_INTERACT,
    PermissionPolicy.COMPUTER_SENSITIVE,
  ]
  const calculator = "app:macos:com.apple.calculator"

  test("the computer ids keep their internal names", () => {
    expect(COMPUTER).toEqual(["computer_app", "computer_observe", "computer_interact", "computer_sensitive"])
    expect(PermissionPolicy.COMPUTER_APP_PREFIX).toBe("app:")
    expect(PermissionPolicy.FLAGGED_SCREEN_REASON).toBe(
      "Text on screen looks like instructions to an AI. Check that this step is what you asked for.",
    )
    expect(PermissionPolicy.AFTER_SCREEN_REASON.length).toBeGreaterThan(0)
  })

  test("computer_* require approval and never auto-approve", () => {
    for (const permission of [...COMPUTER, "computer_future_action"]) {
      for (const always of [undefined, [], ["*"], [calculator]]) {
        for (const patterns of [undefined, ["*"], [calculator], [`${calculator}:send`]]) {
          expect(PermissionPolicy.requiresApproval(permission, always, patterns), permission).toBe(true)
          expect(PermissionPolicy.canAutoApprove(permission, always, patterns), permission).toBe(false)
        }
      }
    }
  })

  test("computer_sensitive requires approval under '*': allow and under a config allow (pure policy)", () => {
    const sensitive = PermissionPolicy.COMPUTER_SENSITIVE
    expect(PermissionPolicy.requiresApproval(sensitive, ["*"], ["*"])).toBe(true)
    expect(PermissionPolicy.requiresApproval(sensitive, [], [`${calculator}:send`])).toBe(true)
    expect(PermissionPolicy.canAutoApprove(sensitive, ["*"], ["*"])).toBe(false)
  })

  it.effect("computer_sensitive requires approval under '*': allow and under a config allow", () =>
    Effect.gen(function* () {
      const mail = "app:macos:com.apple.mail"
      const sensitive = (id: string) =>
        assertion({
          id: PermissionV2.ID.create(id),
          action: PermissionPolicy.COMPUTER_SENSITIVE,
          resources: [`${mail}:send`],
          save: [],
        })
      const app = (id: string) =>
        assertion({
          id: PermissionV2.ID.create(id),
          action: PermissionPolicy.COMPUTER_APP,
          resources: [mail],
          save: [mail],
        })

      // A "*": "allow" default answers ordinary tools but not a computer ask.
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      expect(yield* service.ask(assertion({ id: PermissionV2.ID.create("per_read") }))).toMatchObject({
        effect: "allow",
      })
      expect(yield* service.ask(sensitive("per_star_sensitive"))).toMatchObject({ effect: "ask" })
      expect(yield* service.ask(app("per_star_app"))).toMatchObject({ effect: "ask" })

      // A config allow written for the computer ids, even in a trusted repository, still asks.
      yield* setRules([
        { action: "computer_sensitive", resource: "*", effect: "allow" },
        { action: "computer_app", resource: "*", effect: "allow" },
        { action: "computer_*", resource: "*", effect: "allow" },
      ])
      expect(yield* service.ask(sensitive("per_config_sensitive"))).toMatchObject({ effect: "ask" })
      expect(yield* service.ask(app("per_config_app"))).toMatchObject({ effect: "ask" })

      // An "always" reply to a sensitive ask is answered as "once", and the next one asks again.
      const events = yield* EventV2.Service
      const replies: unknown[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === PermissionV2.Event.Replied.type) replies.push(event.data)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* service.reply({ requestID: PermissionV2.ID.create("per_config_sensitive"), reply: "always" })
      expect(replies).toContainEqual(
        expect.objectContaining({ requestID: PermissionV2.ID.create("per_config_sensitive"), reply: "once" }),
      )
      expect(yield* service.ask(sensitive("per_config_sensitive_again"))).toMatchObject({ effect: "ask" })

      // A deny still wins over everything.
      yield* setRules([
        { action: "*", resource: "*", effect: "allow" },
        { action: "computer_sensitive", resource: "*", effect: "deny" },
        { action: "computer_app", resource: mail, effect: "deny" },
      ])
      expect(yield* service.ask(sensitive("per_deny_sensitive"))).toMatchObject({ effect: "deny" })
      expect(yield* service.ask(app("per_deny_app"))).toMatchObject({ effect: "deny" })
      expect(yield* service.assert(sensitive("per_assert_deny")).pipe(Effect.flip)).toBeInstanceOf(
        PermissionV2.DeniedError,
      )
    }),
  )

  test("only computer_app with concrete app: keys can be always-approved", () => {
    const app = PermissionPolicy.COMPUTER_APP
    expect(PermissionPolicy.canAlwaysApprove(app, [calculator])).toBe(true)
    expect(PermissionPolicy.canAlwaysApprove(app, [calculator], [calculator])).toBe(true)
    expect(
      PermissionPolicy.canAlwaysApprove(app, ["app:windows:aumid:microsoft.windowscalculator_8wekyb3d8bbwe!app"]),
    ).toBe(true)
    expect(PermissionPolicy.canAlwaysApprove(app, ["app:windows:exe:microsoft corporation|notepad|notepad.exe"])).toBe(
      true,
    )
    expect(PermissionPolicy.canAlwaysApprove(app, ["*"])).toBe(false)
    expect(PermissionPolicy.canAlwaysApprove(app, [calculator, "*"])).toBe(false)
    expect(PermissionPolicy.canAlwaysApprove(app, ["window:42:0"])).toBe(false)
    expect(PermissionPolicy.canAlwaysApprove(app, [])).toBe(false)
    expect(PermissionPolicy.canAlwaysApprove(app)).toBe(false)
    // A wildcard or bare prefix names no single app.
    for (const pattern of ["app:", "app:*", "app:macos:*", "app:macos:com.apple.?alculator"])
      expect(PermissionPolicy.canAlwaysApprove(app, [pattern]), pattern).toBe(false)

    // Every other computer permission never offers Always, whatever it carries.
    for (const permission of [
      PermissionPolicy.COMPUTER_SENSITIVE,
      PermissionPolicy.COMPUTER_OBSERVE,
      PermissionPolicy.COMPUTER_INTERACT,
      "computer_future_action",
    ]) {
      for (const always of [["*"], [calculator], [`${calculator}:send`], ["window:42:0"]])
        expect(PermissionPolicy.canAlwaysApprove(permission, always, always), permission).toBe(false)
    }

    // The core wrapper the V2 reply path uses agrees.
    expect(PermissionV2.canAlwaysApprove(app, [calculator])).toBe(true)
    expect(PermissionV2.canAlwaysApprove(app, ["*"])).toBe(false)
    expect(PermissionV2.canAlwaysApprove(PermissionPolicy.COMPUTER_SENSITIVE, [calculator])).toBe(false)
  })

  test("browser_sensitive, doom_loop and ordinary permissions are unchanged", () => {
    for (const permission of ["browser_sensitive", "doom_loop"]) {
      expect(PermissionPolicy.requiresApproval(permission)).toBe(false)
      expect(PermissionPolicy.requiresApproval(permission, ["*"], ["*"])).toBe(false)
      expect(PermissionPolicy.canAutoApprove(permission)).toBe(false)
      expect(PermissionPolicy.canAutoApprove(permission, ["*"], ["*"])).toBe(false)
      expect(PermissionPolicy.canAlwaysApprove(permission, ["*"])).toBe(false)
      expect(PermissionPolicy.canAlwaysApprove(permission, [calculator])).toBe(false)
    }
    // A permission merely named like an app key is not a computer permission.
    expect(PermissionPolicy.requiresApproval("webfetch", [calculator], [calculator])).toBe(false)
    expect(PermissionPolicy.canAutoApprove("edit")).toBe(true)
    expect(PermissionPolicy.canAlwaysApprove("webfetch", ["https://example.com/*"])).toBe(true)
    expect(PermissionPolicy.canAlwaysApprove("webfetch", [])).toBe(false)
    expect(PermissionPolicy.requiresApproval("webfetch", [], ["after-web https://example.com/"])).toBe(true)
    expect(PermissionPolicy.requiresApproval(PermissionPolicy.NETWORK_COMMAND)).toBe(true)
  })
})

// Vector Hands (build contract E2, INV-C5): the V2 saved list never keeps a computer_* reply. The desktop keeps
// Always-allowed apps in its own sealed store, so a revoke in Settings takes effect at once. The saved list is watched
// here so a save that a later read would purge still shows.
const saves: PermissionSaved.AddInput[] = []
const rows: PermissionSaved.Info[] = []
const watchedSaved = Layer.succeed(
  PermissionSaved.Service,
  PermissionSaved.Service.of({
    list: (input) => Effect.sync(() => rows.filter((row) => !input?.projectID || row.projectID === input.projectID)),
    add: (input) =>
      Effect.sync(() => {
        saves.push(input)
        for (const resource of input.resources)
          rows.push({ id: PermissionSaved.ID.create(), projectID: input.projectID, action: input.action, resource })
      }),
    remove: (id) =>
      Effect.sync(() => {
        const index = rows.findIndex((row) => row.id === id)
        if (index >= 0) rows.splice(index, 1)
      }),
  }),
)
const watched = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [
      [Location.node, current],
      [PermissionSaved.node, watchedSaved],
    ],
  ),
)

describe("PermissionV2 computer replies", () => {
  watched.effect("V2 never saves computer_*", () =>
    Effect.gen(function* () {
      saves.length = 0
      rows.length = 0
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const service = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const replies: unknown[] = []
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === PermissionV2.Event.Replied.type) replies.push(event.data)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      const mail = "app:macos:com.apple.mail"
      const cases = [
        // computer_app's "always" is published as "always" so the desktop can save the app in its own store (INV-S3).
        { action: PermissionPolicy.COMPUTER_APP, resources: [mail], published: "always" },
        { action: PermissionPolicy.COMPUTER_SENSITIVE, resources: [`${mail}:send`], published: "once" },
        { action: PermissionPolicy.COMPUTER_OBSERVE, resources: [mail], published: "once" },
        { action: PermissionPolicy.COMPUTER_INTERACT, resources: [mail], published: "once" },
        { action: "computer_future_action", resources: [mail], published: "once" },
      ]
      for (const [index, item] of cases.entries()) {
        const input = assertion({
          id: PermissionV2.ID.create(`per_hands_${index}`),
          action: item.action,
          resources: item.resources,
          save: item.resources,
        })
        expect(yield* service.ask(input)).toMatchObject({ effect: "ask" })
        yield* service.reply({ requestID: input.id, reply: "always" })
        expect(replies, item.action).toContainEqual(
          expect.objectContaining({ requestID: input.id, reply: item.published }),
        )
        expect(saves, item.action).toEqual([])

        // The next ask for the same app or step asks again.
        const again = { ...input, id: PermissionV2.ID.create(`per_hands_${index}_again`) }
        expect(yield* service.ask(again)).toMatchObject({ effect: "ask" })
        yield* service.reply({ requestID: again.id, reply: "once" })
      }
      expect(saves).toEqual([])
      expect(rows).toEqual([])

      // A computer approval an older build saved is purged on the next read and answers nothing.
      for (const action of cases.map((item) => item.action))
        rows.push({ id: PermissionSaved.ID.create(), projectID: Project.ID.global, action, resource: mail })
      expect(
        yield* service.ask(
          assertion({
            id: PermissionV2.ID.create("per_hands_old"),
            action: PermissionPolicy.COMPUTER_APP,
            resources: [mail],
            save: [mail],
          }),
        ),
      ).toMatchObject({ effect: "ask" })
      expect(rows).toEqual([])

      // A computer_app "always" answers only that ask: a waiting request that an approval saved meanwhile would allow
      // is still the person's to answer.
      yield* setRules([])
      const waiting = assertion({ id: PermissionV2.ID.create("per_hands_waiting") })
      expect(yield* service.ask(waiting)).toMatchObject({ effect: "ask" })
      rows.push({ id: PermissionSaved.ID.create(), projectID: Project.ID.global, action: "read", resource: "src/*" })
      const app = assertion({
        id: PermissionV2.ID.create("per_hands_app"),
        action: PermissionPolicy.COMPUTER_APP,
        resources: [mail],
        save: [mail],
      })
      expect(yield* service.ask(app)).toMatchObject({ effect: "ask" })
      yield* service.reply({ requestID: app.id, reply: "always" })
      expect(yield* service.get(waiting.id)).toMatchObject({ id: waiting.id })
      yield* service.reply({ requestID: waiting.id, reply: "once" })
      rows.length = 0

      // The watch does see an ordinary save.
      const read = assertion({ id: PermissionV2.ID.create("per_hands_read"), save: ["src/*"] })
      expect(yield* service.ask(read)).toMatchObject({ effect: "ask" })
      yield* service.reply({ requestID: read.id, reply: "always" })
      expect(saves).toEqual([{ projectID: Project.ID.global, action: "read", resources: ["src/*"] }])
    }),
  )
})
