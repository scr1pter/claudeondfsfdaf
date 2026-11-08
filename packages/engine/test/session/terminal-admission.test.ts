import { afterEach, describe, expect } from "bun:test"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Effect, Exit } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { Brain } from "@vectordevai/core/brain/brain"
import { ModelV2 } from "@vectordevai/core/model"
import { ProviderV2 } from "@vectordevai/core/provider"
import { SessionAudience } from "@vectordevai/core/session/audience"
import type { SessionV1 } from "@vectordevai/core/v1/session"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Git } from "@/git"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { SessionTools } from "@/session/tools"
import { TaskClaims } from "@/task/claims"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// The terminal tool through SessionTools' real context: what its command lines and typed lines write passes the same
// ownership chokepoint and file-lock admission as the shell tool's commands, once per call and before any terminal
// starts or any key is typed, and a guest family's terminal gets the shell's guest read and Git guards. Terminals here
// run /bin/sh, the scan reads POSIX command lines, and terminals do not start on Windows in tests (terminal.test.ts).
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      Brain.node,
      Config.node,
      EventV2Bridge.node,
      MCP.node,
      Permission.node,
      Plugin.node,
      Provider.node,
      Session.node,
      ToolRegistry.node,
      Truncate.node,
      SessionAudience.node,
      Git.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

const ref = { providerID: ProviderV2.ID.make("local-test"), modelID: ModelV2.ID.make("model") }
const options = {
  trusted: true,
  config: {
    provider: {
      "local-test": {
        npm: "@ai-sdk/openai-compatible",
        name: "Local test",
        options: { baseURL: "http://127.0.0.1:1/v1" },
        models: { model: { name: "Test", limit: { context: 16_384, output: 1_024 } } },
      },
    },
  },
}
const REFUSAL = "This operation could expose private task data."
const SH = { action: "open", command: "/bin/sh", args: [] }

afterEach(async () => {
  for (const claim of TaskClaims.claims) TaskClaims.release(claim)
  await disposeAllInstances()
})

type Asked = { permission: string; patterns: readonly string[] }
type Output = { output: string; metadata: { id?: string; matched?: string } }

// The terminal tool as SessionTools gives it to one session. Every permission ask is recorded and allowed; `during`
// runs inside each ask, after the ownership check that comes before the asks.
const terminal = Effect.fn("TerminalAdmissionTest.terminal")(function* (
  session: Session.Info,
  asked: Asked[] = [],
  during?: (request: Asked) => void,
) {
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const provider = yield* Provider.Service
  const permission = yield* Permission.Service
  const model = yield* provider.getModel(ref.providerID, ref.modelID)
  const agent = yield* agents.get("build")
  if (!agent) throw new Error("Build agent unavailable")
  const message: SessionV1.Assistant = {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "assistant",
    parentID: MessageID.ascending(),
    agent: "build",
    mode: "build",
    cost: 0,
    path: { cwd: "/", root: "/" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    providerID: ref.providerID,
    modelID: ref.modelID,
    time: { created: Date.now() },
  }
  const tools = (yield* registry.all()).filter((item) => item.id === "terminal")
  const resolved = yield* SessionTools.resolve({
    agent,
    model,
    session,
    messages: [],
    invokedAgents: [],
    processor: { message, updateToolCall: () => Effect.succeed(undefined), completeToolCall: () => Effect.void },
    promptOps: {
      cancel: () => Effect.void,
      resolvePromptParts: () => Effect.succeed([]),
      prompt: () => Effect.die("Unexpected model request"),
    },
  }).pipe(
    Effect.provideService(ToolRegistry.Service, { ...registry, tools: () => Effect.succeed(tools) }),
    Effect.provideService(Permission.Service, {
      ...permission,
      ask: (request) =>
        Effect.sync(() => {
          const item = { permission: request.permission, patterns: request.patterns }
          asked.push(item)
          during?.(item)
        }),
    }),
  )
  // A refusal comes back as the call's failure text, a result as its output.
  return (args: Record<string, unknown>) =>
    Effect.tryPromise({
      try: async () =>
        resolved.terminal.execute!(args, {
          toolCallId: `terminal-${crypto.randomUUID()}`,
          messages: [],
          abortSignal: new AbortController().signal,
        }) as Promise<Output>,
      catch: (error) => error,
    }).pipe(Effect.exit)
})

type Call = Effect.Success<ReturnType<typeof terminal>>

const refusal = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("expected the terminal call to be refused")
  return Cause.pretty(exit.cause)
}

const result = (exit: Exit.Exit<Output, unknown>) => {
  if (Exit.isFailure(exit)) throw new Error(`expected the terminal call to succeed: ${Cause.pretty(exit.cause)}`)
  return exit.value
}

// What a terminal shows once the shell has run every line typed before `echo done`: a line refused earlier would have
// been typed, and so echoed and run, before it.
const settled = Effect.fn("TerminalAdmissionTest.settled")(function* (call: Call, id: string) {
  result(yield* call({ action: "type", id, text: "echo done", enter: true }))
  expect(result(yield* call({ action: "wait", id, pattern: "^done$", timeout: 20_000 })).metadata.matched).toBe(
    "pattern",
  )
  return result(yield* call({ action: "read", id, lines: 2000 })).output
})

// A helper session in the owner's conversation, holding the claim a launch gives it.
const helper = Effect.fn("TerminalAdmissionTest.helper")(function* (
  owner: Session.Info,
  title: string,
  paths: string[] = [],
) {
  const instance = yield* InstanceState.context
  const sessions = yield* Session.Service
  const session = yield* sessions.create({ parentID: owner.id, title })
  const claim = TaskClaims.reserve({
    tree: instance.worktree,
    directory: instance.directory,
    parentSessionID: owner.id,
    taskID: session.id,
    title,
    paths,
  })
  TaskClaims.bind(claim, session.id)
  return session
})

const changedBy = (owner: Session.Info, file: string) =>
  Effect.gen(function* () {
    const instance = yield* InstanceState.context
    return TaskClaims.conflicts({ tree: instance.worktree, sessionID: owner.id, file }).map(
      (conflict) => conflict.entry.taskID,
    )
  })

if (process.platform !== "win32")
  describe("terminal admission", () => {
    it.instance(
      "a guest next to an owner-only family is refused that family's files without its names, before any terminal or keystroke; the owner is told which subagent",
      () =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const sessions = yield* Session.Service
          const audience = yield* SessionAudience.Service
          const owner = yield* sessions.create({ title: "Owner chat" })
          const rotate = yield* helper(owner, "Rotate the signing keys")
          const vault = yield* helper(owner, "Guard the vault", ["vault"])
          yield* audience.fenceIsolation({ sessionID: rotate.id, actor: "owner" })
          const guest = yield* sessions.create({ title: "Guest chat" }, "guest")
          const notes = path.join(instance.directory, "notes.md")
          const owned = path.join(instance.directory, "vault", "new.ts")
          yield* Effect.promise(() => fs.writeFile(notes, "two\n"))
          TaskClaims.touch(rotate.id, notes)

          const texts = {
            guest: [
              `${notes} was changed by another conversation's running subagent and stays its file until it finishes. It was not changed. Wait for it to finish.`,
              `${owned} belongs to another conversation's running subagent. It was not changed. Wait for it to finish.`,
            ],
            owner: [
              `${notes} was changed by the running subagent "Rotate the signing keys" (${rotate.id}) and stays its file until it finishes. It was not changed. Wait for its report, send it the change with task_manage message, or stop it first.`,
              `${owned} belongs to the running subagent "Guard the vault" (${vault.id}), which owns vault. It was not changed. Wait for its report, send it the change with task_manage message, or stop it first.`,
            ],
          }
          const lines = ["printf x > notes.md", "printf x > vault/new.ts"]
          // Every refusal the guest got, checked below for the family's names.
          const seen: string[] = []
          const list = yield* terminal(owner)
          for (const [who, session] of [
            ["guest", guest],
            ["owner", owner],
          ] as const) {
            // A command line that writes one of the family's files starts no terminal and asks nothing.
            for (const [index, command] of lines.entries()) {
              const asked: Asked[] = []
              const call = yield* terminal(session, asked)
              const text = refusal(yield* call({ action: "open", command }))
              expect(text).toContain(texts[who][index])
              expect(asked).toEqual([])
              if (who === "guest") seen.push(text)
            }
            expect(result(yield* list({ action: "list" })).output).toBe("No terminals here. Open one with action open.")

            // A typed line that writes one types nothing: no ask names the line, and the shell never sees it.
            const asked: Asked[] = []
            const call = yield* terminal(session, asked)
            const id = result(yield* call(SH)).metadata.id!
            for (const [index, line] of lines.entries()) {
              asked.length = 0
              const text = refusal(yield* call({ action: "type", id, text: line, enter: true }))
              expect(text).toContain(texts[who][index])
              expect(asked.map((item) => item.permission)).toEqual(["terminal_input"])
              if (who === "guest") seen.push(text)
            }
            expect(yield* settled(call, id)).not.toContain("printf")
            result(yield* call({ action: "close", id }))
          }
          expect(seen).toHaveLength(4)
          for (const text of seen) {
            expect(text).not.toContain("Rotate")
            expect(text).not.toContain("Guard")
            expect(text).not.toContain(rotate.id)
            expect(text).not.toContain(vault.id)
            expect(text).not.toContain(owner.id)
            expect(text).not.toContain("which owns")
          }
          expect(yield* Effect.promise(() => fs.readFile(notes, "utf8"))).toBe("two\n")
          expect(existsSync(owned)).toBe(false)
        }),
      options,
    )

    it.instance(
      "a typed line that writes a file makes it the helper's change",
      () =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const sessions = yield* Session.Service
          const owner = yield* sessions.create({ title: "Owner chat" })
          const writer = yield* helper(owner, "Write the report")
          const out = path.join(instance.directory, "out.txt")
          const call = yield* terminal(writer)
          const id = result(yield* call(SH)).metadata.id!
          result(yield* call({ action: "type", id, text: "printf report > out.txt; echo written", enter: true }))
          expect(
            result(yield* call({ action: "wait", id, pattern: "^written$", timeout: 20_000 })).metadata.matched,
          ).toBe("pattern")
          expect(yield* Effect.promise(() => fs.readFile(out, "utf8"))).toBe("report")
          expect(yield* changedBy(owner, out)).toEqual([writer.id])

          // The parent's own terminal is then refused the file, as an edit would be, until the helper settles.
          const parent = yield* terminal(owner)
          expect(refusal(yield* parent({ action: "open", command: "printf mine > out.txt" }))).toContain(
            `${out} was changed by the running subagent "Write the report" (${writer.id}) and stays its file until it finishes.`,
          )
          expect(yield* Effect.promise(() => fs.readFile(out, "utf8"))).toBe("report")
        }),
      options,
    )

    it.instance(
      "a two-line type whose second line writes a sibling's file types nothing and claims nothing for the first",
      () =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const sessions = yield* Session.Service
          const owner = yield* sessions.create({ title: "Owner chat" })
          const writer = yield* helper(owner, "Write the report")
          const vault = yield* helper(owner, "Guard the vault", ["vault"])
          const first = path.join(instance.directory, "first.txt")
          const call = yield* terminal(writer)
          const id = result(yield* call(SH)).metadata.id!
          const text = refusal(
            yield* call({ action: "type", id, text: "printf a > first.txt\nprintf b > vault/x.ts", enter: true }),
          )
          expect(text).toContain(
            `${path.join(instance.directory, "vault", "x.ts")} belongs to the running subagent "Guard the vault" (${vault.id}), which owns vault. It was not changed. Report the change you need to the parent.`,
          )
          expect(yield* settled(call, id)).not.toContain("printf")
          expect(existsSync(first)).toBe(false)
          expect(yield* changedBy(owner, first)).toEqual([])
        }),
      options,
    )

    it.instance(
      "a claim made while a call's lines are asked for refuses the whole call at admission",
      () =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const sessions = yield* Session.Service
          const owner = yield* sessions.create({ title: "Owner chat" })
          const writer = yield* helper(owner, "Write the report")
          const late = yield* sessions.create({ parentID: owner.id, title: "Late writer" })
          const first = path.join(instance.directory, "first.txt")
          const second = path.join(instance.directory, "second.txt")
          // The sibling claims second.txt while the second line's edit is being asked for: after that line's own
          // ownership check passed, before anything is typed.
          const call = yield* terminal(writer, [], (request) => {
            if (request.permission !== "edit" || !request.patterns.some((item) => item.endsWith("second.txt"))) return
            if (TaskClaims.forTask(late.id).length) return
            TaskClaims.bind(
              TaskClaims.reserve({
                tree: instance.worktree,
                directory: instance.directory,
                parentSessionID: owner.id,
                taskID: late.id,
                title: "Late writer",
                paths: ["second.txt"],
              }),
              late.id,
            )
          })
          const id = result(yield* call(SH)).metadata.id!
          const text = refusal(
            yield* call({ action: "type", id, text: "printf a > first.txt\nprintf b > second.txt", enter: true }),
          )
          expect(text).toContain(
            `${second} belongs to the running subagent "Late writer" (${late.id}), which owns second.txt. It was not changed. Report the change you need to the parent.`,
          )
          expect(yield* settled(call, id)).not.toContain("printf")
          expect(existsSync(first)).toBe(false)
          expect(existsSync(second)).toBe(false)
          expect(yield* changedBy(owner, first)).toEqual([])
        }),
      options,
    )

    it.instance(
      "a guest family's terminal neither opens in a private task folder nor types git worktree list beside it; an owner's does both",
      () =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const git = yield* Git.Service
          const sessions = yield* Session.Service
          const audience = yield* SessionAudience.Service
          const run = Effect.fnUntraced(function* (args: string[], cwd = instance.directory) {
            const done = yield* git.run(args, { cwd })
            expect(done.exitCode).toBe(0)
            return done.text().replace(/\r?\n$/, "")
          })
          // A private task's checkout, linked to this repository, as isolation makes it. The guest's arguments never
          // spell it: the terminal opens in a link to it, so only the read guard can stop the open.
          const secret = path.join(yield* tmpdirScoped(), "private-terminal-checkout")
          yield* Effect.promise(() => fs.writeFile(path.join(instance.directory, "public.ts"), "export {}\n"))
          yield* run(["add", "public.ts"])
          yield* run(["commit", "-m", "public fixture"])
          yield* run(["worktree", "add", "-b", "vector/subagent/terminal", secret])
          const metadata = yield* run(["rev-parse", "--absolute-git-dir"], secret)
          for (const directory of [secret, metadata])
            yield* audience.fenceIsolation({ sessionID: "ses_private_terminal", actor: "owner", directory })
          yield* Effect.promise(() => fs.symlink(secret, path.join(instance.directory, "alias"), "dir"))

          const owner = yield* sessions.create({ title: "Owner chat" })
          const guest = yield* sessions.create({ title: "Guest chat" })
          yield* audience.markGuest(guest.id)
          const list = yield* terminal(owner)

          const asked: Asked[] = []
          const call = yield* terminal(guest, asked)
          expect(refusal(yield* call({ ...SH, cwd: "alias" }))).toContain(REFUSAL)
          expect(asked).toEqual([])
          expect(result(yield* list({ action: "list" })).output).toBe("No terminals here. Open one with action open.")

          const id = result(yield* call(SH)).metadata.id!
          asked.length = 0
          const text = refusal(yield* call({ action: "type", id, text: "git worktree list", enter: true }))
          expect(text).toContain(REFUSAL)
          expect(text).not.toContain(secret)
          expect(asked.map((item) => item.permission)).toEqual(["terminal_input"])
          expect(yield* settled(call, id)).not.toContain("worktree")
          // The owner reads the guest's terminal in full: the command never ran there.
          expect(result(yield* list({ action: "read", id, lines: 2000 })).output).not.toContain(secret)

          const own = yield* terminal(owner)
          expect(result(yield* own({ ...SH, cwd: "alias" })).metadata.id).toBeDefined()
          const shell = result(yield* own(SH)).metadata.id!
          result(yield* own({ action: "type", id: shell, text: "git worktree list", enter: true }))
          const listed = result(
            yield* own({ action: "wait", id: shell, pattern: path.basename(secret), timeout: 20_000 }),
          )
          expect(listed.metadata.matched).toBe("pattern")
          expect(listed.output).toContain(secret)
        }),
      { ...options, git: true },
    )

    it.instance(
      "with the shell sandbox on, a line the guest guard or the ownership check refuses is never asked to run unsandboxed",
      () =>
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = process.env.VECTOR_SHELL_SANDBOX
              process.env.VECTOR_SHELL_SANDBOX = "1"
              return previous
            }),
            (previous) =>
              Effect.sync(() => {
                if (previous === undefined) delete process.env.VECTOR_SHELL_SANDBOX
                else process.env.VECTOR_SHELL_SANDBOX = previous
              }),
          )
          const instance = yield* InstanceState.context
          const sessions = yield* Session.Service
          const audience = yield* SessionAudience.Service
          // A private folder the guest's arguments never spell (a link to it), so only ShellPermission's read guard
          // refuses it, after the arguments' own check.
          const secret = yield* tmpdirScoped()
          yield* Effect.promise(() => fs.writeFile(path.join(secret, "notes.txt"), "private\n"))
          yield* audience.fenceIsolation({ sessionID: "ses_private_sandbox", actor: "owner", directory: secret })
          yield* Effect.promise(() => fs.symlink(secret, path.join(instance.directory, "alias"), "dir"))
          const owner = yield* sessions.create({ title: "Owner chat" })
          const writer = yield* helper(owner, "Write the report")
          yield* helper(owner, "Guard the vault", ["vault"])
          const guest = yield* sessions.create({ title: "Guest chat" })
          yield* audience.markGuest(guest.id)

          // The guest guard: a terminal in the private folder, or a line that lists it.
          const visitor: Asked[] = []
          const outside = yield* terminal(guest, visitor)
          expect(refusal(yield* outside({ ...SH, cwd: "alias" }))).toContain(REFUSAL)
          expect(visitor).toEqual([])
          const shell = result(yield* outside(SH)).metadata.id!
          visitor.length = 0
          expect(
            refusal(yield* outside({ action: "type", id: shell, text: "cat < alias/notes.txt", enter: true })),
          ).toContain(REFUSAL)
          expect(visitor.map((item) => item.permission)).toEqual(["terminal_input"])
          expect(yield* settled(outside, shell)).not.toContain("private")

          // The ownership check: a command line or a typed line that writes the sibling's file.
          const asked: Asked[] = []
          const call = yield* terminal(writer, asked)
          expect(refusal(yield* call({ action: "open", command: "printf x > vault/new.ts" }))).toContain(
            "which owns vault",
          )
          expect(asked).toEqual([])
          const id = result(yield* call(SH)).metadata.id!
          // An admitted terminal asks to run unsandboxed first, before the shell's own asks.
          expect(asked[0]).toEqual({ permission: "unsandboxed_shell", patterns: [process.platform] })
          expect(asked.filter((item) => item.permission === "unsandboxed_shell")).toHaveLength(1)
          asked.length = 0
          expect(refusal(yield* call({ action: "type", id, text: "printf x > vault/new.ts", enter: true }))).toContain(
            "which owns vault",
          )
          expect(asked.map((item) => item.permission)).toEqual(["terminal_input"])
          asked.length = 0
          result(yield* call({ action: "type", id, text: "echo admitted", enter: true }))
          expect(asked.map((item) => item.permission).slice(0, 2)).toEqual(["terminal_input", "unsandboxed_shell"])
          expect(asked.filter((item) => item.permission === "unsandboxed_shell")).toHaveLength(1)
          expect(asked.length).toBeGreaterThan(2)
        }),
      options,
    )
  })
