import { expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import { ModelV2 } from "@vectordevai/core/model"
import { ProjectV2 } from "@vectordevai/core/project"
import { ProviderV2 } from "@vectordevai/core/provider"
import { PermissionV1 } from "@vectordevai/core/v1/permission"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { SessionV1 } from "@vectordevai/schema/session-v1"
import { Agent } from "@/agent/agent"
import { ComputerSession } from "@/computer/session"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { InstanceBootstrap } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ShellTool } from "@/tool/shell"
import { ShellJobs } from "@/task/shells"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { TestConfig } from "../fixture/config"
import { pollWithTimeout, testEffect } from "../lib/effect"

// Every process in this fixture is a fake, including project discovery. Test commands never reach the OS.
function handle(code = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  })
}

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, RuntimeFlags.node, Permission.node, InstanceStore.node]),
    [
      [
        CrossSpawnSpawner.node,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(handle(1))),
        ),
      ],
      [InstanceStore.bootstrapNode, Layer.mock(InstanceBootstrap.Service, { run: Effect.void })],
    ],
  ),
)

type Request = Parameters<Tool.Context["ask"]>[0]
type State = {
  held: boolean
  completed: boolean
  spawns: ChildProcess.Command[]
  asks: Request[]
  heldRoots: SessionID[]
  completionQueries: { root: SessionID; history: readonly SessionV1.WithParts[] }[]
  parents: Map<SessionID, Session.Info>
  loadedParents: SessionID[]
  loadedHistories: SessionID[]
  rootHistory: SessionV1.WithParts[]
  ask?: Tool.Context["ask"]
  backgroundStart?: (input: ShellJobs.StartInput) => Effect.Effect<never>
}

const root = SessionID.make("ses_shell_computer_root")
const context: Tool.Context = {
  sessionID: root,
  messageID: MessageID.make("msg_shell_computer"),
  callID: "shell_computer",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.succeed("once" as const),
}

function fixture<A, E, R>(
  body: (
    state: State,
    run: (
      command: string,
      extra?: Partial<Tool.Context>,
      input?: { background?: boolean },
    ) => Effect.Effect<Tool.ExecuteResult>,
  ) => Effect.Effect<A, E, R>,
  options: { background?: boolean } = {},
) {
  return Effect.gen(function* () {
    const state: State = {
      held: false,
      completed: false,
      spawns: [],
      asks: [],
      heldRoots: [],
      completionQueries: [],
      parents: new Map([[root, session(root)]]),
      loadedParents: [],
      loadedHistories: [],
      rootHistory: [],
    }
    return yield* Effect.gen(function* () {
      const info = yield* ShellTool
      const tool = yield* info.init()
      const run = (command: string, extra: Partial<Tool.Context> = {}, input: { background?: boolean } = {}) =>
        tool.execute(
          { command, timeout: 1000, ...input },
          {
            ...context,
            ...extra,
            ask: (request) =>
              Effect.gen(function* () {
                state.asks.push(request)
                return yield* state.ask?.(request) ?? Effect.succeed("once" as const)
              }),
          },
        )
      return yield* body(state, run)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestConfig.layer({ get: () => Effect.succeed({ shell: "/bin/bash" }) }),
          RuntimeFlags.layer({ backgroundSubagents: options.background === true }),
          Layer.mock(ShellJobs.Service, {
            full: () => Effect.succeed(false),
            start: (input) => state.backgroundStart?.(input) ?? Effect.die(new Error("Unexpected background start")),
          }),
          Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) }),
          Layer.mock(Agent.Service, {}),
          Layer.mock(Truncate.Service, { limits: () => Effect.succeed({ maxLines: 100, maxBytes: 4096 }) }),
          Layer.mock(ComputerSession.Service, {
            held: (id) =>
              Effect.sync(() => {
                state.heldRoots.push(id)
                return state.held
              }),
            completedThisTurn: (id, history) =>
              Effect.sync(() => {
                state.completionQueries.push({ root: id, history })
                return state.completed
              }),
          }),
          Layer.mock(Session.Service, {
            get: (id) =>
              Effect.sync(() => {
                state.loadedParents.push(id)
                const found = state.parents.get(id)
                if (!found) throw new Error("Unexpected parent session")
                return found
              }),
            messages: ({ sessionID }) =>
              Effect.sync(() => {
                state.loadedHistories.push(sessionID)
                return state.rootHistory
              }),
          }),
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              Effect.sync(() => {
                state.spawns.push(command)
                return handle()
              }),
            ),
          ),
        ),
      ),
    )
  })
}

function failure<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) throw new Error("Expected the shell command to be refused")
    return Cause.squash(exit.cause)
  })
}

function user(id: string): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID: root,
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    },
    parts: [],
  }
}

function session(id: SessionID, parentID?: SessionID): Session.Info {
  return {
    id,
    parentID,
    slug: "shell-computer-test",
    projectID: ProjectV2.ID.make("project_shell_computer"),
    directory: "/shell-computer-test",
    title: "Shell computer test",
    version: "test",
    time: { created: 1, updated: 1 },
  }
}

function shellAsks(state: State) {
  return state.asks.filter((request) => request.permission === "bash")
}

it.instance("every command after computer completion asks once without an Always choice", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      state.completed = true
      for (const command of ["echo first", "echo first", "echo second"]) {
        yield* run(command)
        expect(shellAsks(state).at(-1)).toMatchObject({
          patterns: [command, PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX + command],
          always: [],
          metadata: { command },
        })
      }
      expect(shellAsks(state)).toHaveLength(3)
      expect(state.spawns).toHaveLength(3)
    }),
  ),
)

it.instance("compound commands retain individual permission patterns and directory changes still ask", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      state.completed = true
      yield* run("echo first && echo second")
      expect(shellAsks(state)[0]?.patterns).toEqual([
        "echo first",
        "echo second",
        PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX + "echo first",
        PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX + "echo second",
      ])
      yield* run("cd .")
      expect(shellAsks(state)[1]).toMatchObject({
        patterns: [PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX + "cd ."],
        always: [],
      })
      expect(state.spawns).toHaveLength(2)
    }),
  ),
)

it.instance("a turn without completed computer use retains ordinary shell permissions", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      state.ask = () => Effect.void
      yield* run("echo ordinary")
      expect(shellAsks(state)[0]).toMatchObject({ patterns: ["echo ordinary"], always: ["echo *"] })
      expect(state.spawns).toHaveLength(1)
    }),
  ),
)

it.instance("rule-only and Always answers cannot substitute for a fresh once answer", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      state.completed = true
      for (const answer of [undefined, "always"] as const) {
        state.ask = () => Effect.succeed(answer)
        expect(String(yield* failure(run("echo approved")))).toContain("fresh Allow once")
      }
      expect(state.spawns).toHaveLength(0)
    }),
  ),
)

it.instance("configured shell allows still publish a fresh request for each command", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      state.completed = true
      state.ask = (request) =>
        permission
          .ask({ ...request, sessionID: root, ruleset: [{ permission: "bash", pattern: "*", action: "allow" }] })
          .pipe(Effect.orDie)
      for (const answer of ["always", "once"] as const) {
        const running = yield* run("echo allowed").pipe(Effect.forkChild)
        const pending = yield* pollWithTimeout(
          permission.list().pipe(Effect.map((requests) => requests[0])),
          "Shell did not ask after computer completion",
        )
        expect(pending.always).toEqual([])
        expect(state.spawns).toHaveLength(answer === "always" ? 0 : 1)
        yield* permission.reply({ requestID: pending.id, reply: answer })
        yield* Fiber.join(running)
      }
      expect(yield* permission.approved()).toEqual([])
      expect(state.spawns).toHaveLength(2)
    }),
  ),
)

it.instance("after-screen confirmation preserves explicit shell denials", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      const permission = yield* Permission.Service
      state.completed = true
      state.ask = (request) =>
        permission
          .ask({
            ...request,
            sessionID: root,
            ruleset: [{ permission: "bash", pattern: "echo *", action: "deny" }],
          })
          .pipe(Effect.orDie)
      expect(yield* failure(run("echo denied"))).toBeInstanceOf(PermissionV1.DeniedError)
      expect(yield* permission.list()).toEqual([])
      expect(state.spawns).toHaveLength(0)
    }),
  ),
)

it.instance("an active computer lease refuses desktop control and capture before approval or spawn", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      state.held = true
      for (const command of ["xdotool mousemove 1 1", "screencapture -x screen.png", "xdotool click 1 &"]) {
        expect(String(yield* failure(run(command)))).toContain("Use the computer tool")
      }
      expect(state.asks).toHaveLength(0)
      expect(state.spawns).toHaveLength(0)
      expect(state.heldRoots.every((id) => id === root)).toBe(true)
    }),
  ),
)

it.instance("ordinary commands mentioning desktop utilities remain usable while the lease is held", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      state.held = true
      yield* run('echo "xdotool screencapture"')
      expect(state.spawns).toHaveLength(1)
    }),
  ),
)

it.instance("a lease acquired while shell approval waits prevents the pending process from starting", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<"once">()
      state.ask = () => Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(answer)))
      const running = yield* failure(run("xdotool mousemove 1 1")).pipe(Effect.forkChild)
      yield* Deferred.await(asked)
      state.held = true
      yield* Deferred.succeed(answer, "once")
      expect(String(yield* Fiber.join(running))).toContain("Use the computer tool")
      expect(state.spawns).toHaveLength(0)
    }),
  ),
)

it.instance("computer completion during ordinary shell approval requires another once answer before spawn", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const answer = yield* Deferred.make<void>()
      state.ask = (request) =>
        request.patterns.some((pattern) => pattern.startsWith(PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX))
          ? Effect.succeed("once" as const)
          : Deferred.succeed(asked, undefined).pipe(Effect.andThen(Deferred.await(answer)))
      const running = yield* run("echo pending").pipe(Effect.forkChild)
      yield* Deferred.await(asked)
      state.completed = true
      yield* Deferred.succeed(answer, undefined)
      yield* Fiber.join(running)
      expect(shellAsks(state).map((request) => request.patterns)).toEqual([
        ["echo pending"],
        ["echo pending", PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX + "echo pending"],
      ])
      expect(shellAsks(state)[1]?.always).toEqual([])
      expect(state.spawns).toHaveLength(1)
    }),
  ),
)

it.instance("completion during an edit approval is reflected in the first shell request", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      state.ask = (request) =>
        Effect.sync(() => {
          if (request.permission === "edit") state.completed = true
          return "once" as const
        })
      yield* run("echo report > report.txt")
      expect(state.asks[0]?.permission).toBe("edit")
      expect(shellAsks(state)).toHaveLength(1)
      expect(
        shellAsks(state)[0]?.patterns.some((pattern) =>
          pattern.startsWith(PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX),
        ),
      ).toBe(true)
      expect(state.spawns).toHaveLength(1)
    }),
  ),
)

it.instance("completion during a sensitive-file permission adds a fresh shell request", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      state.ask = (request) =>
        Effect.sync(() => {
          if (request.permission === "read") state.completed = true
          return "once" as const
        })
      yield* run("cat .env")
      expect(state.asks.map((request) => request.permission)).toEqual(["bash", "read", "bash"])
      expect(shellAsks(state)[1]).toMatchObject({
        patterns: ["cat .env", PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX + "cat .env"],
        always: [],
      })
      expect(state.spawns).toHaveLength(1)
    }),
  ),
)

it.instance("shell checks complete root history and follows nested subagents to their root", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      state.completed = true
      const visible = [user("msg_visible")]
      const history = [user("msg_full_history")]
      yield* run("echo root", { messages: visible, history: () => Effect.succeed(history) })
      expect(state.completionQueries[0]).toEqual({ root, history })
      const parent = SessionID.make("ses_shell_computer_parent")
      const child = SessionID.make("ses_shell_computer_child")
      state.parents.set(child, session(child, parent))
      state.parents.set(parent, session(parent, root))
      state.parents.set(root, session(root))
      state.rootHistory = [user("msg_persisted_root")]
      yield* run("echo child", {
        sessionID: child,
        parentID: parent,
        messages: visible,
        history: () => Effect.die(new Error("A child must use its root's persisted history")),
      })
      expect(state.loadedParents).toEqual([root, child, parent, root])
      expect(state.loadedHistories).toEqual([root])
      expect(state.completionQueries.at(-1)).toEqual({ root, history: state.rootHistory })
      expect(shellAsks(state)).toHaveLength(2)
      expect(state.spawns).toHaveLength(2)
    }),
  ),
)

it.instance("persisted ancestry enforces the root gate when the context parent is missing or stale", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      const parent = SessionID.make("ses_shell_persisted_parent")
      const child = SessionID.make("ses_shell_persisted_child")
      state.parents.set(child, session(child, parent))
      state.parents.set(parent, session(parent, root))
      state.held = true
      for (const parentID of [undefined, SessionID.make("ses_stale_parent")]) {
        expect(String(yield* failure(run("xdotool mousemove 1 1", { sessionID: child, parentID })))).toContain(
          "Use the computer tool",
        )
      }
      expect(state.heldRoots).toEqual([root, root])
      expect(state.loadedParents).toEqual([child, parent, root, child, parent, root])
      expect(state.asks).toHaveLength(0)
      expect(state.spawns).toHaveLength(0)
    }),
  ),
)

it.instance("releasing the lease leaves same-turn shell confirmation in force", () =>
  fixture((state, run) =>
    Effect.gen(function* () {
      state.completed = true
      state.held = false
      yield* run("xdotool mousemove 1 1")
      expect(shellAsks(state)[0]).toMatchObject({
        patterns: ["xdotool mousemove 1 1", PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX + "xdotool mousemove 1 1"],
        always: [],
      })
      expect(state.spawns).toHaveLength(1)
    }),
  ),
)

it.instance("background setup carries the same late after-screen guard through to process start", () =>
  fixture(
    (state, run) =>
      Effect.gen(function* () {
        state.ask = (request) =>
          request.patterns.some((pattern) => pattern.startsWith(PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX))
            ? Effect.void
            : Effect.succeed("once" as const)
        state.backgroundStart = (input) =>
          Effect.gen(function* () {
            // The background manager's session/slot/output setup can wait after the tool's initial scan.
            state.completed = true
            if (input.beforeSpawn) yield* input.beforeSpawn
            state.spawns.push(input.process)
            return yield* Effect.die(new Error("Background process started without a fresh confirmation"))
          })
        const refused = yield* failure(run("echo background", { extra: { promptOps: {} } }, { background: true }))
        expect(String(refused)).toContain("fresh Allow once")
        expect(shellAsks(state).map((request) => request.patterns)).toEqual([
          ["echo background"],
          ["echo background", PermissionPolicy.AFTER_SCREEN_COMMAND_PREFIX + "echo background"],
        ])
        expect(state.spawns).toEqual([])
      }),
    { background: true },
  ),
)
