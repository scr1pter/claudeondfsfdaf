import { afterEach, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Exit, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@vectordevai/core/cross-spawn-spawner"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { EventV2 } from "@vectordevai/core/event"
import { UNATTENDED_KEY, UNATTENDED_SHELL_KEY, UNATTENDED_SHELL_OFFLINE } from "@vectordevai/core/everywhere/frame"
import { FSUtil } from "@vectordevai/core/fs-util"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ComputerSession } from "@/computer/session"
import { Session } from "@/session/session"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { Server } from "../../src/server/server"
import { ServerAuth } from "../../src/server/auth"
import { MessageID, SessionID } from "../../src/session/schema"
import { UnattendedShell } from "../../src/session/unattended-shell"
import { ShellTool } from "../../src/tool/shell"
import { Sandbox } from "../../src/tool/shell/sandbox"
import * as UnattendedSeccomp from "../../src/tool/shell/unattended-seccomp"
import type { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"

// R-M2 (EV-16): a session the owner creates with `vector.unattended` and `vector.unattended.shell: "offline"` runs its
// commands only in Vector's offline sandbox (Linux with bubblewrap), and none where that sandbox cannot be applied.
// Everything runs through the real HTTP server in this process and the existing fake model server on this computer;
// the engine suite's network guard refuses every other host. Nothing here imports the desktop app.

const it = testEffect(TestLLMServer.layer)
// The shell tool alone, for the hosts where the sandbox is missing (as shell-sandbox-local.test.ts builds it).
const tool = testEffect(
  Layer.mergeAll(
    LayerNode.compile(
      LayerNode.group([
        CrossSpawnSpawner.node,
        FSUtil.node,
        Plugin.node,
        Truncate.node,
        Config.node,
        Agent.node,
        RuntimeFlags.node,
        ComputerSession.node,
        Session.node,
      ]),
    ),
    testInstanceStoreLayer,
  ),
)

const MODEL = "lmstudio/test-model"
const OWNER_PASSWORD = randomBytes(24).toString("base64url")
const GUEST_PASSWORD = randomBytes(24).toString("base64url")
const MARKS = {
  [UNATTENDED_KEY]: { by: "everywhere", jid: "vej_fixture", platform: "slack" },
  [UNATTENDED_SHELL_KEY]: UNATTENDED_SHELL_OFFLINE,
}
const linux = process.platform === "linux"
// Whether bubblewrap starts on this computer at all, found apart from the code under test.
const bwrap = Bun.which("bwrap")
const works =
  linux && bwrap !== null && Bun.spawnSync([bwrap, "--unshare-net", "--ro-bind", "/", "/", "true"]).exitCode === 0
// Where this engine advertises the offline sandbox: Linux, a bubblewrap only root can change, and a start that works.
const offline = works && Sandbox.unattendedBinary() !== undefined
const liveIf = (run: boolean) => (run ? it.live : it.live.skip)
let foregroundProgress: { phase: string } | undefined

afterEach(async () => {
  const progress = foregroundProgress
  foregroundProgress = undefined
  if (progress) {
    console.info(`[offline-shell foreground] last phase=${progress.phase} (Bun deadline starts at test entry)`)
  }
  await disposeAllInstances()
  await resetDatabase()
})

type Sent = { readonly status: number; readonly body: Record<string, unknown> & { message?: string } }

function harness(providerUrl: string) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const names = [
        "VECTOR_SERVER_USERNAME",
        "VECTOR_SERVER_PASSWORD",
        "VECTOR_SERVER_GUEST_USERNAME",
        "VECTOR_SERVER_GUEST_PASSWORD",
        "VECTOR_DISABLE_DEFAULT_PLUGINS",
        "VECTOR_SHELL_SANDBOX",
      ]
      const original = Object.fromEntries(names.map((key) => [key, process.env[key]]))
      Object.assign(process.env, {
        VECTOR_SERVER_USERNAME: "vector",
        VECTOR_SERVER_PASSWORD: OWNER_PASSWORD,
        VECTOR_SERVER_GUEST_USERNAME: "guest",
        VECTOR_SERVER_GUEST_PASSWORD: GUEST_PASSWORD,
        VECTOR_DISABLE_DEFAULT_PLUGINS: "1",
      })
      // The owner's other sessions run as they always do: no sandbox switch for the whole engine.
      delete process.env.VECTOR_SHELL_SANDBOX
      const tmp = await tmpdir({
        git: true,
        trusted: true,
        config: { ...testProviderConfig(providerUrl), model: MODEL, permission: { "*": "allow" } },
      })
      const listener = await Server.listen({ hostname: "127.0.0.1", port: 0 })
      const owner = ServerAuth.header({ username: "vector", password: OWNER_PASSWORD })!
      const guest = ServerAuth.header({ username: "guest", password: GUEST_PASSWORD })!
      const send = async (
        route: string,
        method: string,
        body?: unknown,
        as: "owner" | "forwarded" | "guest" | "anonymous" = "owner",
      ): Promise<Sent> => {
        const url = new URL(route, listener.url)
        url.searchParams.set("directory", tmp.path)
        const response = await fetch(url, {
          method,
          keepalive: false,
          headers: {
            ...(as === "anonymous" ? {} : { authorization: as === "guest" ? guest : owner }),
            ...(as === "forwarded" ? { "x-vector-guest-request": "1" } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        const text = await response.text()
        return { status: response.status, body: text ? JSON.parse(text) : {} }
      }
      return {
        send,
        directory: tmp.path,
        async close() {
          await listener.stop(true)
          await tmp[Symbol.asyncDispose]()
          for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
        },
      }
    }),
    (value) => Effect.promise(() => value.close()),
  )
}

type Harness = Effect.Success<ReturnType<typeof harness>>

function create(h: Harness, body: Record<string, unknown>, as: "owner" | "forwarded" | "guest" = "owner") {
  return Effect.promise(() => h.send("/session", "POST", body, as))
}

function created(h: Harness, body: Record<string, unknown>) {
  return create(h, body).pipe(
    Effect.map((response) => {
      expect(response.status).toBe(200)
      expect(response.body.id).toMatch(/^ses/)
      return response.body as unknown as Session.Info
    }),
  )
}

function stored(h: Harness, id: string) {
  return Effect.promise(async () => {
    const response = await h.send(`/session/${id}`, "GET")
    expect(response.status).toBe(200)
    return response.body as unknown as Session.Info
  })
}

/** Runs one prompt to its end and gives back the session's tool parts. */
function prompt(h: Harness, id: string, text = "Run the check.") {
  return Effect.promise(async () => {
    const response = await h.send(`/session/${id}/message`, "POST", {
      model: { providerID: "lmstudio", modelID: "test-model" },
      parts: [{ type: "text", text }],
    })
    expect(response.status).toBe(200)
    const history = await h.send(`/session/${id}/message`, "GET")
    expect(history.status).toBe(200)
    return (history.body as unknown as SessionV1.WithParts[])
      .flatMap((row) => row.parts)
      .filter((part): part is SessionV1.ToolPart => part.type === "tool")
  })
}

function completed(parts: readonly SessionV1.ToolPart[], name: string) {
  const part = parts.find((item) => item.tool === name)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? part.state : undefined
}

function failed(parts: readonly SessionV1.ToolPart[], name: string) {
  const part = parts.find((item) => item.tool === name)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? part.state.error : ""
}

// A folder for this file's own fixtures outside any checkout: under /tmp, which the offline sandbox replaces.
function scratch() {
  const root = process.platform === "win32" ? os.tmpdir() : path.join("/tmp", "vector-v2", "everywhere")
  mkdirSync(root, { recursive: true })
  return mkdtempSync(path.join(root, "ev16-"))
}

describe("which sessions are offline-only (R-M2)", () => {
  it.live("only the owner creates an offline-only session, and only with the one accepted value", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const h = yield* harness(llm.url)

      const marked = yield* created(h, { title: "Unattended", metadata: MARKS })
      expect((yield* stored(h, marked.id)).metadata).toEqual(MARKS)

      const before = yield* Effect.promise(() => h.send("/session", "GET"))
      const forwarded = yield* create(h, { title: "Forwarded", metadata: MARKS }, "forwarded")
      expect([forwarded.status, forwarded.body.message]).toEqual([403, UnattendedShell.OWNER_ONLY])
      // A guest's own credentials are refused as well (this guest, scoped to no workspace, before the check).
      expect((yield* create(h, { title: "Guest", metadata: MARKS }, "guest")).status).toBe(403)
      const after = yield* Effect.promise(() => h.send("/session", "GET"))
      expect(after.body).toEqual(before.body)

      const online = yield* create(h, { metadata: { ...MARKS, [UNATTENDED_SHELL_KEY]: "online" } })
      expect([online.status, online.body.message]).toEqual([400, UnattendedShell.INVALID])
      const alone = yield* create(h, { metadata: { [UNATTENDED_SHELL_KEY]: UNATTENDED_SHELL_OFFLINE } })
      expect([alone.status, alone.body.message]).toEqual([400, UnattendedShell.INVALID])
      // A null `vector.unattended` is no value beside the shell mark.
      const empty = yield* create(h, { metadata: { ...MARKS, [UNATTENDED_KEY]: null } })
      expect([empty.status, empty.body.message]).toEqual([400, UnattendedShell.INVALID])

      // The audience mark alone only narrows what a session hears, so a guest may still set it (EV-14).
      const audience = yield* create(h, { metadata: { [UNATTENDED_KEY]: MARKS[UNATTENDED_KEY] } }, "forwarded")
      expect(audience.status).toBe(200)
    }),
  )

  it.live("no update changes the marks: PATCH keeps them, refuses a change, and a fork copies them", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const h = yield* harness(llm.url)
      const marked = yield* created(h, { title: "Unattended", metadata: MARKS })
      const plain = yield* created(h, { title: "Plain" })

      for (const as of ["owner", "forwarded"] as const) {
        const patch = (id: string, body: Record<string, unknown>) =>
          Effect.promise(() => h.send(`/session/${id}`, "PATCH", body, as))

        // Adding either mark to a session after its creation, title and all, changes nothing.
        for (const metadata of [MARKS, { [UNATTENDED_KEY]: MARKS[UNATTENDED_KEY] }]) {
          const added = yield* patch(plain.id, { title: "Changed", metadata })
          expect({ as, status: added.status, message: added.body.message }).toEqual({
            as,
            status: 403,
            message: UnattendedShell.FIXED,
          })
        }
        const untouched = yield* stored(h, plain.id)
        expect([
          untouched.title,
          untouched.metadata?.[UNATTENDED_KEY],
          untouched.metadata?.[UNATTENDED_SHELL_KEY],
        ]).toEqual(["Plain", undefined, undefined])

        // Metadata without the marks replaces the rest and keeps them.
        const kept = yield* patch(marked.id, { metadata: { note: as } })
        expect({ as, status: kept.status }).toEqual({ as, status: 200 })
        expect((yield* stored(h, marked.id)).metadata).toEqual({ note: as, ...MARKS })

        const changed = yield* patch(marked.id, { metadata: { ...MARKS, [UNATTENDED_SHELL_KEY]: "online" } })
        expect({ as, status: changed.status, message: changed.body.message }).toEqual({
          as,
          status: 403,
          message: UnattendedShell.FIXED,
        })
        const dropped = yield* patch(marked.id, { metadata: { ...MARKS, [UNATTENDED_KEY]: null } })
        expect({ as, status: dropped.status }).toEqual({ as, status: 403 })

        // A client that writes back what it read keeps working.
        const same = yield* patch(marked.id, { metadata: { ...MARKS, other: as } })
        expect({ as, status: same.status }).toEqual({ as, status: 200 })
        expect((yield* stored(h, marked.id)).metadata).toEqual({ other: as, ...MARKS })
      }

      const fork = yield* Effect.promise(() => h.send(`/session/${marked.id}/fork`, "POST", {}))
      expect(fork.status).toBe(200)
      expect((fork.body.metadata as Record<string, unknown>)[UNATTENDED_SHELL_KEY]).toBe(UNATTENDED_SHELL_OFFLINE)
      expect((fork.body.metadata as Record<string, unknown>)[UNATTENDED_KEY]).toEqual(MARKS[UNATTENDED_KEY])
    }),
  )

  it.live("a sync replay cannot change the marks, set them without the owner, or cut a session off from them", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const h = yield* harness(llm.url)
      const marked = yield* created(h, { title: "Unattended", metadata: MARKS })
      const child = yield* created(h, { title: "Below", parentID: marked.id })
      const plain = yield* created(h, { title: "Plain" })
      const history = yield* Effect.promise(() => h.send("/sync/history", "POST", {}))
      expect(history.status).toBe(200)
      const rows = history.body as unknown as { aggregate_id: string; seq: number; type: string; data: unknown }[]
      const own = (id: string) => rows.filter((event) => event.aggregate_id === id)
      const next = (id: string) => own(id).at(-1)!.seq + 1
      const origin = own(marked.id).find((event) => /^session\.created/.test(event.type))!
      const infoOf = (id: string) =>
        (own(id).find((event) => /^session\.created/.test(event.type))!.data as { info: Session.Info }).info
      const info = infoOf(marked.id)
      const versioned = (event: { type: string; durable?: { version: number } }) =>
        EventV2.versionedType(event.type, event.durable!.version)
      const updated = versioned(SessionV1.Event.Updated)
      const deleted = versioned(SessionV1.Event.Deleted)
      const replay = (
        aggregateID: string,
        events: readonly { seq: number; type: string; info: Record<string, unknown> }[],
        as: "owner" | "forwarded" = "owner",
      ) =>
        Effect.promise(() =>
          h.send(
            "/sync/replay",
            "POST",
            {
              directory: h.directory,
              events: events.map((event) => ({
                id: EventV2.ID.create(),
                aggregateID,
                seq: event.seq,
                type: event.type,
                data: { sessionID: aggregateID, info: event.info },
              })),
            },
            as,
          ),
        )
      const update = (metadata: Record<string, unknown>) =>
        replay(marked.id, [{ seq: next(marked.id), type: updated, info: { ...info, metadata } }])

      // An update replayed without the marks would replace the session's metadata with none.
      const dropped = yield* update({ note: "replayed" })
      expect([dropped.status, dropped.body.message]).toEqual([403, UnattendedShell.FIXED])
      const changed = yield* update({ ...MARKS, [UNATTENDED_SHELL_KEY]: "online" })
      expect([changed.status, changed.body.message]).toEqual([403, UnattendedShell.FIXED])
      expect((yield* stored(h, marked.id)).metadata).toEqual(MARKS)
      // The control: the same replay with the marks as they are goes through.
      const same = yield* update({ ...MARKS, note: "replayed" })
      expect(same.status).toBe(200)
      expect((yield* stored(h, marked.id)).metadata).toEqual({ ...MARKS, note: "replayed" })

      // A replay deletes no session of a marked lineage: not the marked one (so no later creation brings its ID back
      // without the marks), not one below it, and it moves none of them to another parent.
      const gone = yield* replay(marked.id, [{ seq: next(marked.id), type: deleted, info }])
      expect([gone.status, gone.body.message]).toEqual([403, UnattendedShell.KEPT])
      const replaced = yield* replay(marked.id, [
        { seq: next(marked.id), type: deleted, info },
        { seq: next(marked.id) + 1, type: origin.type, info: { ...info, metadata: { note: "replaced" } } },
      ])
      expect([replaced.status, replaced.body.message]).toEqual([403, UnattendedShell.KEPT])
      const childInfo = infoOf(child.id)
      const below = yield* replay(child.id, [{ seq: next(child.id), type: deleted, info: childInfo }])
      expect([below.status, below.body.message]).toEqual([403, UnattendedShell.KEPT])
      const moved = yield* replay(child.id, [
        { seq: next(child.id), type: updated, info: { ...childInfo, parentID: plain.id } },
      ])
      expect([moved.status, moved.body.message]).toEqual([403, UnattendedShell.KEPT])
      expect((yield* stored(h, marked.id)).metadata).toEqual({ ...MARKS, note: "replayed" })
      expect((yield* stored(h, child.id)).parentID).toBe(marked.id)
      // The control: a session outside any marked lineage is deleted as before.
      const plainGone = yield* replay(plain.id, [{ seq: next(plain.id), type: deleted, info: infoOf(plain.id) }])
      expect(plainGone.status).toBe(200)
      expect((yield* Effect.promise(() => h.send(`/session/${plain.id}`, "GET"))).status).toBe(404)

      // A replayed creation is a creation: the shell mark takes its one value, and only from the owner.
      const fresh = SessionID.descending()
      const creation = (metadata: Record<string, unknown>, as: "owner" | "forwarded") =>
        replay(fresh, [{ seq: 0, type: origin.type, info: { ...info, id: fresh, metadata } }], as)
      const invalid = yield* creation({ ...MARKS, [UNATTENDED_SHELL_KEY]: "online" }, "owner")
      expect([invalid.status, invalid.body.message]).toEqual([403, UnattendedShell.INVALID])
      // The route is the owner's alone, so a guest-marked replay never reaches the check (which refuses it too).
      expect((yield* creation(MARKS, "forwarded")).status).toBe(403)
      expect((yield* Effect.promise(() => h.send(`/session/${fresh}`, "GET"))).status).toBe(404)

      // An orphan, a replayed session whose parent is not stored, is no offline-only session: its commands run.
      const orphan = SessionID.descending()
      const adopted = yield* replay(orphan, [
        {
          seq: 0,
          type: origin.type,
          info: { ...info, id: orphan, parentID: SessionID.descending(), metadata: { note: "orphan" } },
        },
      ])
      expect(adopted.status).toBe(200)
      const ran = yield* Effect.promise(() =>
        h.send(`/session/${orphan}/shell`, "POST", {
          agent: "build",
          model: { providerID: "lmstudio", modelID: "test-model" },
          command: "echo ran > orphan-shell.txt",
        }),
      )
      expect(ran.status).toBe(200)
      expect(existsSync(path.join(h.directory, "orphan-shell.txt"))).toBe(true)
    }),
  )

  it.live("the owner can ask whether this engine keeps an unattended session's commands offline", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const h = yield* harness(llm.url)
      const answer = yield* Effect.promise(() => h.send("/experimental/shell/unattended", "GET"))
      expect(answer).toEqual({ status: 200, body: { shell: offline ? "offline-v1" : "none" } })
      for (const as of ["forwarded", "guest"] as const) {
        const refused = yield* Effect.promise(() => h.send("/experimental/shell/unattended", "GET", undefined, as))
        expect({ as, status: refused.status, message: refused.body.message }).toEqual({
          as,
          status: 403,
          message: "The unattended shell policy requires the authenticated server owner.",
        })
      }
      expect(
        (yield* Effect.promise(() => h.send("/experimental/shell/unattended", "GET", undefined, "anonymous"))).status,
      ).toBe(401)

      // No bubblewrap on PATH, and one that cannot start: neither is advertised.
      const empty = scratch()
      const failing = scratch()
      writeFileSync(path.join(failing, "bwrap"), "#!/bin/sh\nexit 1\n")
      chmodSync(path.join(failing, "bwrap"), 0o755)
      const before = process.env.PATH
      for (const folder of [empty, failing]) {
        process.env.PATH = folder
        const none = yield* Effect.promise(() => h.send("/experimental/shell/unattended", "GET")).pipe(
          Effect.ensuring(Effect.sync(() => (process.env.PATH = before))),
        )
        expect(none).toEqual({ status: 200, body: { shell: "none" } })
      }
      rmSync(empty, { recursive: true, force: true })
      rmSync(failing, { recursive: true, force: true })
    }),
  )
})

describe("an offline-only session's commands (R-M2)", () => {
  liveIf(offline)(
    "reach no server on this computer, no host socket and no secret variable, and write only in the checkout",
    () =>
      Effect.gen(function* () {
        // Snapshot before the existing teardown can obscure a Bun timeout. Updates stay local to this invocation.
        const progress = { phase: "starting HTTP harness" }
        foregroundProgress = progress
        const llm = yield* TestLLMServer
        const h = yield* harness(llm.url)
        progress.phase = "preparing local fixtures"
        const fixtures = scratch()
        const tcp = yield* Effect.acquireRelease(
          Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reached-tcp") })),
          (server) => Effect.sync(() => void server.stop(true)),
        )
        const socket = path.join(fixtures, "s.sock")
        yield* Effect.acquireRelease(
          Effect.sync(() => Bun.serve({ unix: socket, fetch: () => new Response("reached-unix") })),
          (server) => Effect.sync(() => void server.stop(true)),
        )
        // A host /run entry this process sees and no PATH folder lives under.
        const searchPath = (process.env.PATH ?? "").split(path.delimiter)
        const run = readdirSync("/run").find(
          (entry) => !searchPath.some((folder) => folder.startsWith(`/run/${entry}`)),
        )
        // Two secrets in the engine's environment: one whose name reads as a secret, and one whose name does not.
        const secret = randomBytes(12).toString("hex")
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const saved = {
              EVERYWHERE_FIXTURE_TOKEN: process.env.EVERYWHERE_FIXTURE_TOKEN,
              EVERYWHERE_FIXTURE_PAT: process.env.EVERYWHERE_FIXTURE_PAT,
            }
            Object.assign(process.env, {
              EVERYWHERE_FIXTURE_TOKEN: `token-${secret}`,
              EVERYWHERE_FIXTURE_PAT: `pat-${secret}`,
            })
            return saved
          }),
          (saved) =>
            Effect.sync(() => {
              for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key]
                else process.env[key] = value
              }
            }),
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(fixtures, { recursive: true, force: true })))
        yield* Effect.promise(() =>
          writeFile(
            path.join(h.directory, "probe.sh"),
            [
              `out=$(curl -s --noproxy '*' --max-time 8 http://127.0.0.1:${tcp.port}/); echo "tcp=$? $out"`,
              `out=$(curl -s --noproxy '*' --max-time 8 --unix-socket ${socket} http://localhost/); echo "unix=$? $out"`,
              run === undefined
                ? "echo run=none"
                : `if [ -e /run/${run} ]; then echo run=present; else echo run=absent; fi`,
              'echo "token=${EVERYWHERE_FIXTURE_TOKEN:-}" "pat=${EVERYWHERE_FIXTURE_PAT:-}"',
              'cache="${XDG_CACHE_HOME:-$HOME/.cache}/ev16"; mkdir -p "$cache" && echo x > "$cache/x" && echo cache=ok',
              'echo inside > "made-$1.txt" && echo write=ok',
              // The checkout's .git is read-only inside the sandbox, so no hook reaches a later git outside it.
              "(echo x > .git/hooks/post-checkout) 2>/dev/null && echo hook=written || echo hook=refused",
              "",
            ].join("\n"),
          ),
        )

        progress.phase = "creating marked session"
        const marked = yield* created(h, { title: "Unattended", metadata: MARKS })
        progress.phase = "creating plain session"
        const plain = yield* created(h, { title: "Plain" })
        // A session below an offline-only one is offline-only too, with no mark of its own.
        progress.phase = "creating child session"
        const child = yield* created(h, { title: "Below", parentID: marked.id })
        expect(child.metadata?.[UNATTENDED_SHELL_KEY]).toBeUndefined()

        progress.phase = "preparing marked prompt"
        yield* llm.tool("bash", { command: "sh ./probe.sh marked", description: "Probe" })
        yield* llm.text("done")
        progress.phase = "awaiting marked prompt and history"
        const inside = completed(yield* prompt(h, marked.id), "bash")
        progress.phase = "preparing plain prompt"
        yield* llm.tool("bash", { command: "sh ./probe.sh plain", description: "Probe" })
        yield* llm.text("done")
        progress.phase = "awaiting plain prompt and history"
        const outside = completed(yield* prompt(h, plain.id), "bash")
        progress.phase = "preparing child prompt"
        yield* llm.tool("bash", { command: "sh ./probe.sh child", description: "Probe" })
        yield* llm.text("done")
        progress.phase = "awaiting child prompt and history"
        const below = completed(yield* prompt(h, child.id), "bash")

        progress.phase = "asserting probe results"
        for (const state of [inside, below]) {
          expect(state?.output).toStartWith(`${Sandbox.UNATTENDED_NOTICE}\n\n`)
          expect(state?.metadata.sandbox).toBe(Sandbox.UNATTENDED_NOTICE)
          expect(state?.output).toContain("tcp=7 \n")
          expect(state?.output).toContain("unix=7 \n")
          if (run !== undefined) expect(state?.output).toContain("run=absent")
          expect(state?.output).toContain("token= pat=\n")
          expect(state?.output).toContain("cache=ok")
          expect(state?.output).toContain("write=ok")
          expect(state?.output).toContain("hook=refused")
          expect(state?.output).not.toContain("reached")
          expect(state?.output).not.toContain(secret)
        }
        expect(existsSync(path.join(h.directory, "made-marked.txt"))).toBe(true)
        expect(existsSync(path.join(h.directory, "made-child.txt"))).toBe(true)

        // The control, in the same engine: a session without the mark runs as before, with no sandbox.
        expect(outside?.metadata.sandbox).toBeUndefined()
        expect(outside?.output).toContain("tcp=0 reached-tcp")
        expect(outside?.output).toContain("unix=0 reached-unix")
        if (run !== undefined) expect(outside?.output).toContain("run=present")
        expect(outside?.output).toContain(`token=token-${secret} pat=pat-${secret}`)
        expect(outside?.output).toContain("hook=written")
        expect(existsSync(path.join(h.directory, "made-plain.txt"))).toBe(true)
        progress.phase = "assertions complete"
      }),
  )

  liveIf(offline)("a background command runs in the offline sandbox too", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const h = yield* harness(llm.url)
      const tcp = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reached-tcp") })),
        (server) => Effect.sync(() => void server.stop(true)),
      )
      const marked = yield* created(h, { title: "Unattended", metadata: MARKS })
      yield* llm.tool("bash", {
        command: `out=$(curl -s --noproxy '*' --max-time 8 http://127.0.0.1:${tcp.port}/); echo "exit=$? $out" > bg.txt`,
        description: "Probe in the background",
        background: true,
      })
      yield* llm.text("done")
      const state = completed(yield* prompt(h, marked.id), "bash")
      expect(state?.output).toStartWith(`${Sandbox.UNATTENDED_NOTICE}\n\n`)
      expect(state?.metadata.background).toBe(true)
      const file = path.join(h.directory, "bg.txt")
      const written = yield* Effect.promise(async () => {
        const deadline = Date.now() + 20_000
        while (Date.now() < deadline) {
          const text = existsSync(file) ? await readFile(file, "utf8") : ""
          if (text.includes("exit=")) return text
          await Bun.sleep(100)
        }
        return ""
      })
      expect(written).toBe("exit=7 \n")
    }),
  )

  it.live("terminals and the session's own shell route never run anything for it", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const h = yield* harness(llm.url)
      const marked = yield* created(h, { title: "Unattended", metadata: MARKS })
      const plain = yield* created(h, { title: "Plain" })
      const child = yield* created(h, { title: "Below", parentID: marked.id })

      for (const id of [marked.id, child.id]) {
        yield* llm.tool("terminal", { action: "open", command: "echo ran > terminal.txt" })
        yield* llm.text("done")
        expect(failed(yield* prompt(h, id), "terminal")).toContain(UnattendedShell.TERMINAL)
        yield* llm.tool("terminal", { action: "list" })
        yield* llm.text("done")
        expect(failed(yield* prompt(h, id), "terminal")).toContain(UnattendedShell.TERMINAL)
      }
      expect(existsSync(path.join(h.directory, "terminal.txt"))).toBe(false)

      const shell = (id: string, marker: string) =>
        Effect.promise(() =>
          h.send(`/session/${id}/shell`, "POST", {
            agent: "build",
            model: { providerID: "lmstudio", modelID: "test-model" },
            command: `echo ran > ${marker}`,
          }),
        )
      for (const id of [marked.id, child.id]) {
        const refused = yield* shell(id, "user-shell.txt")
        expect([refused.status, refused.body.message]).toEqual([403, UnattendedShell.USER_SHELL])
      }
      expect(existsSync(path.join(h.directory, "user-shell.txt"))).toBe(false)
      // The control: the owner's own session runs it.
      expect((yield* shell(plain.id, "plain-shell.txt")).status).toBe(200)
      expect(existsSync(path.join(h.directory, "plain-shell.txt"))).toBe(true)
    }),
  )

  liveIf(!offline)("where the offline sandbox is missing, a command is refused and never run", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const h = yield* harness(llm.url)
      const marked = yield* created(h, { title: "Unattended", metadata: MARKS })
      const plain = yield* created(h, { title: "Plain" })
      yield* llm.tool("bash", { command: "echo ran > ran.txt", description: "Write" })
      yield* llm.text("done")
      expect(failed(yield* prompt(h, marked.id), "bash")).toContain(Sandbox.UNATTENDED_REFUSAL)
      expect(existsSync(path.join(h.directory, "ran.txt"))).toBe(false)
      yield* llm.tool("bash", { command: "echo ran > ran.txt", description: "Write" })
      yield* llm.text("done")
      completed(yield* prompt(h, plain.id), "bash")
      expect(existsSync(path.join(h.directory, "ran.txt"))).toBe(true)
      expect((yield* Effect.promise(() => h.send("/experimental/shell/unattended", "GET"))).body).toEqual({
        shell: "none",
      })
    }),
  )
})

describe("the shell tool for an offline-only session where no sandbox runs", () => {
  const asked: Array<Parameters<Tool.Context["ask"]>[0]> = []
  const context = (sessionID: SessionID, parentID?: SessionID): Tool.Context => ({
    sessionID,
    ...(parentID ? { parentID } : {}),
    messageID: MessageID.make("msg_offline_shell"),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (input) => Effect.sync(() => void asked.push(input)),
  })

  tool.live("is refused before anything is asked, and nothing runs, on any platform without the sandbox", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sessions = yield* Session.Service
      const marked = yield* sessions.create({ metadata: MARKS }).pipe(provideInstance(dir))
      const plain = yield* sessions.create({}).pipe(provideInstance(dir))
      const info = yield* ShellTool
      const shell = yield* info.init().pipe(provideInstance(dir))
      const marker = path.join(dir, "ran")
      const run = (id: SessionID, parentID?: SessionID) =>
        shell
          .execute({ command: `echo ran > "${marker}"` }, context(id, parentID))
          .pipe(provideInstance(dir), Effect.exit)
      asked.length = 0
      for (const [id, parentID] of [
        [marked.id, undefined],
        // A command whose session is not stored is judged by the tool context's parent.
        [SessionID.descending(), marked.id],
      ] as const) {
        const result = yield* withoutSandbox(() => run(id, parentID))
        expect(Exit.isFailure(result)).toBe(true)
        expect(String(Exit.isFailure(result) ? result.cause : "")).toContain(Sandbox.UNATTENDED_REFUSAL)
      }
      expect(asked).toEqual([])
      expect(existsSync(marker)).toBe(false)
      // The control: the same tool runs a plain session's command, which no mark reaches.
      expect(Exit.isSuccess(yield* run(plain.id))).toBe(true)
      expect(existsSync(marker)).toBe(true)
    }),
  )

  // Every read but the command's own session's dies, as Session.get does on a failed database read.
  const failing = (sessions: Session.Interface, own: SessionID, reads: SessionID[]): Session.Interface => ({
    ...sessions,
    get: (id) => {
      reads.push(id)
      return id === own ? sessions.get(id) : Effect.die(new Error("database is locked"))
    },
  })

  tool.live(
    "an ancestry that cannot be read is refused with its own message; a session with no parent reads no other",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        const sessions = yield* Session.Service
        const plain = yield* sessions.create({}).pipe(provideInstance(dir))
        const child = yield* sessions.create({ parentID: plain.id }).pipe(provideInstance(dir))
        const marker = path.join(dir, "ran")
        const run = (id: SessionID, reads: SessionID[]) =>
          ShellTool.pipe(
            Effect.provideService(Session.Service, failing(sessions, id, reads)),
            Effect.flatMap((info) => info.init()),
            Effect.flatMap((shell) => shell.execute({ command: `echo ran > "${marker}"` }, context(id))),
            provideInstance(dir),
            Effect.exit,
          )
        asked.length = 0
        // The child's parent cannot be read: refused before anything is asked, with the lineage's message rather than
        // the database's defect, and nothing runs.
        const childReads: SessionID[] = []
        const refused = yield* run(child.id, childReads)
        expect(Exit.isFailure(refused)).toBe(true)
        const cause = String(Exit.isFailure(refused) ? refused.cause : "")
        expect(cause).toContain(UnattendedShell.LINEAGE)
        expect(cause).not.toContain("database is locked")
        expect(childReads).toEqual([child.id, plain.id])
        expect(asked).toEqual([])
        expect(existsSync(marker)).toBe(false)
        // A session with no parent reads only itself, so its command runs whatever any other read would answer.
        const plainReads: SessionID[] = []
        expect(Exit.isSuccess(yield* run(plain.id, plainReads))).toBe(true)
        expect(plainReads.length).toBeGreaterThan(0)
        expect(plainReads.filter((id) => id !== plain.id)).toEqual([])
        expect(existsSync(marker)).toBe(true)
      }),
  )

  tool.live("marked fails with the typed LineageError, never a defect: a failed read, a loop and 65 sessions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sessions = yield* Session.Service
      const plain = yield* sessions.create({}).pipe(provideInstance(dir))
      const child = yield* sessions.create({ parentID: plain.id }).pipe(provideInstance(dir))
      // A lineage stored nowhere: each session's parent is the next one. The last has none (a root), the first (a
      // loop) or one that is not stored (an orphan).
      const chain = (count: number, end: "root" | "loop" | "orphan") => {
        const ids = Array.from({ length: count }, () => SessionID.descending())
        const last = { root: undefined, loop: ids[0], orphan: SessionID.descending() }[end]
        const lookup: Session.Interface = {
          ...sessions,
          get: (id) => {
            const at = ids.indexOf(id)
            if (at < 0) return sessions.get(id)
            return Effect.succeed({ ...plain, id, parentID: at + 1 < ids.length ? ids[at + 1] : last })
          },
        }
        return UnattendedShell.marked(lookup, ids[0]).pipe(provideInstance(dir))
      }
      const refused = <R>(marked: Effect.Effect<boolean, UnattendedShell.LineageError, R>) =>
        marked.pipe(
          Effect.flip,
          Effect.map((error) => ({ tag: error._tag, message: error.message })),
        )
      const lineage = { tag: "UnattendedShell.LineageError" as const, message: UnattendedShell.LINEAGE }
      const unread = UnattendedShell.marked(failing(sessions, child.id, []), child.id).pipe(provideInstance(dir))
      expect(yield* refused(unread)).toEqual(lineage)
      expect(yield* refused(chain(2, "loop"))).toEqual(lineage)
      expect(yield* refused(chain(65, "root"))).toEqual(lineage)
      // The controls: 64 sessions end at their root, and a missing ancestor ends the lineage.
      expect(yield* chain(64, "root")).toBe(false)
      expect(yield* chain(3, "orphan")).toBe(false)
    }),
  )
})

describe("the capability an engine reports", () => {
  tool.live("is none on Windows and macOS, whose commands are refused, whatever this computer has", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      for (const platform of ["win32", "darwin"] as const) {
        expect({ platform, shell: yield* UnattendedShell.policy(spawner, platform) }).toEqual({
          platform,
          shell: "none",
        })
        expect(yield* UnattendedShell.refusal(spawner, platform)).toBe(Sandbox.UNATTENDED_REFUSAL)
      }
    }),
  )

  // The self-test alone, past the root-ownership check, so a runner that is not root covers it too.
  ;(process.platform === "win32" || !UnattendedSeccomp.supported() ? tool.live.skip : tool.live)(
    "comes from a self-test that runs the fixed arguments and counts only exit 0",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const folder = scratch()
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(folder, { recursive: true, force: true })))
        const recorded = path.join(folder, "args")
        const policy = path.join(folder, "policy")
        const shell = "/bin/sh"
        const fake = (code: number) => {
          const file = path.join(folder, `bwrap-${code}`)
          writeFileSync(
            file,
            `#!/bin/sh\nprintf '%s\\0' "$@" > '${recorded}'\ncat > '${policy}' || exit 1\nexit ${code}\n`,
          )
          chmodSync(file, 0o755)
          return file
        }
        expect(yield* UnattendedShell.selfTest(spawner, fake(1), shell)).toBe(false)
        expect(readFileSync(recorded, "utf8").split("\0").slice(0, -1)).toEqual(UnattendedShell.selfTestArgs(shell))
        expect(readFileSync(policy)).toEqual(Buffer.from(UnattendedSeccomp.filter()!))
        expect(UnattendedShell.selfTestArgs(shell).slice(-3)).toEqual([shell, "-c", ":"])
        expect(yield* UnattendedShell.selfTest(spawner, fake(0), shell)).toBe(true)
      }),
  )

  // Bun closes an extra stdio pipe (fd 3 and up) once more when it collects the child, after the descriptor number
  // may belong to something else in this process: an HTTP socket, a database, the file watcher's epoll descriptor.
  ;(process.platform === "win32" || !UnattendedSeccomp.supported() ? tool.live.skip : tool.live)(
    "hands bubblewrap its policy without leaving a descriptor number to be closed again later",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const folder = scratch()
        yield* Effect.addFinalizer(() => Effect.sync(() => rmSync(folder, { recursive: true, force: true })))
        const policy = path.join(folder, "policy")
        // Reads the policy from whichever descriptor `--seccomp` names, as bubblewrap does.
        const fake = path.join(folder, "bwrap")
        writeFileSync(
          fake,
          `#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != --seccomp ]; do shift; done\neval "cat <&$2" > '${policy}' || exit 1\n`,
        )
        chmodSync(fake, 0o755)
        for (const _ of [1, 2, 3]) expect(yield* UnattendedShell.selfTest(spawner, fake, "/bin/sh")).toBe(true)
        expect(readFileSync(policy)).toEqual(Buffer.from(UnattendedSeccomp.filter()!))
        const held = Array.from({ length: 16 }, () => openSync("/dev/null", "r"))
        yield* Effect.addFinalizer(() => Effect.sync(() => held.filter(isOpen).forEach((fd) => closeSync(fd))))
        Bun.gc(true)
        yield* spawner.exitCode(ChildProcess.make("/bin/sh", ["-c", ":"], { stdin: "ignore" }))
        Bun.gc(true)
        expect(held.filter((fd) => !isOpen(fd))).toEqual([])
      }),
  )
})

function isOpen(fd: number) {
  try {
    fstatSync(fd)
    return true
  } catch {
    return false
  }
}

describe("Sandbox.unattended", () => {
  const input = (env: NodeJS.ProcessEnv = process.env, cwd = os.tmpdir()) => ({
    shell: "/bin/sh",
    command: "true",
    cwd,
    env,
    workspaceRoot: os.tmpdir(),
  })

  test("is refused on Windows, macOS, other systems and Linux without bubblewrap, with no command to run", () => {
    for (const platform of ["win32", "darwin", "freebsd"] as const) {
      expect(Sandbox.unattendedBinary(platform)).toBeUndefined()
      expect(Sandbox.unattended({ ...input(), platform })).toEqual({
        type: "refused",
        message: Sandbox.UNATTENDED_REFUSAL,
      })
    }
    withoutBwrapSync(() => {
      expect(Sandbox.unattendedBinary("linux")).toBeUndefined()
      expect(Sandbox.unattended({ ...input(), platform: "linux" })).toEqual({
        type: "refused",
        message: Sandbox.UNATTENDED_REFUSAL,
      })
    })
    // Web access None keeps running a command unfiltered on Windows; an unattended session's never runs there.
    expect(Sandbox.offline({ ...input(), platform: "win32" }).type).toBe("unfiltered")
  })

  test("refuses a bubblewrap that is not root's", () => {
    const folder = scratch()
    const fake = path.join(folder, "bwrap")
    writeFileSync(fake, "#!/bin/sh\nexit 0\n")
    chmodSync(fake, 0o777)
    const before = process.env.PATH
    process.env.PATH = folder
    try {
      // Writable by anyone, so anyone could swap it: never trusted, whoever owns it.
      expect(Sandbox.unattendedBinary("linux")).toBeUndefined()
      expect(Sandbox.unattended({ ...input(), platform: "linux" }).type).toBe("refused")
    } finally {
      process.env.PATH = before
      rmSync(folder, { recursive: true, force: true })
    }
  })

  test.skipIf(Sandbox.unattendedBinary() === undefined)(
    "wraps a command with no network, private /tmp and /run, the secrets hidden and a scrubbed environment",
    () => {
      const workspace = scratch()
      const home = path.join(workspace, "home")
      mkdirSync(path.join(home, ".ssh"), { recursive: true })
      writeFileSync(path.join(home, ".netrc"), "machine example.com password fixture\n")
      mkdirSync(path.join(home, ".cache"), { recursive: true })
      mkdirSync(path.join(home, ".docker"), { recursive: true })
      writeFileSync(path.join(home, ".git-credentials"), "https://fixture@example.com\n")
      mkdirSync(path.join(workspace, ".git", "hooks"), { recursive: true })
      try {
        const decided = Sandbox.unattended({
          shell: "/bin/sh",
          command: "true",
          cwd: workspace,
          workspaceRoot: workspace,
          home,
          env: {
            PATH: process.env.PATH,
            LANG: "C.UTF-8",
            LC_ALL: "C",
            HOME: home,
            JAVA_HOME: "/opt/java",
            HTTP_PROXY: "http://127.0.0.1:3128",
            https_proxy: "http://127.0.0.1:3128",
            GH_TOKEN: "fixture",
            gh_token: "fixture",
            AWS_SECRET_ACCESS_KEY: "fixture",
            DATABASE_URL: "postgres://fixture",
            NPM_PAT: "fixture",
            SSH_AUTH_SOCK: "/tmp/agent.sock",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus",
            LD_PRELOAD: "/tmp/fixture.so",
            TMP: "/var/tmp",
          },
        })
        expect(decided.type).toBe("sandboxed")
        if (decided.type !== "sandboxed") return
        expect(decided.notice).toBe(Sandbox.UNATTENDED_NOTICE)
        expect(decided.wrapped.mechanism).toBe("bubblewrap")
        expect(decided.wrapped.seccomp).toEqual(UnattendedSeccomp.filter())
        const command = UnattendedSeccomp.command(Sandbox.unattendedBootstrap()!, ["/bin/sh", "-c", "true"])
        expect(decided.wrapped.args.slice(-command.length)).toEqual(command)
        const args = decided.wrapped.args.join("\n")
        for (const expected of [
          "--unshare-net",
          "--seccomp\n0",
          "--cap-drop\nALL",
          "--tmpfs\n/tmp",
          `--tmpfs\n${home}/.ssh`,
          `--ro-bind\n/dev/null\n${home}/.netrc`,
          // The unattended run's own stores, beside the shell sandbox's list.
          `--tmpfs\n${home}/.docker`,
          `--ro-bind\n/dev/null\n${home}/.git-credentials`,
        ])
          expect(args).toContain(expected)
        // The checkout's .git is bound read-only after the checkout itself is bound writable.
        const writable = args.indexOf(`--bind\n${workspace}\n${workspace}\n`)
        expect(writable).toBeGreaterThan(-1)
        expect(args.indexOf(`--ro-bind\n${workspace}/.git\n${workspace}/.git\n`)).toBeGreaterThan(writable)
        if (existsSync("/run")) expect(args).toContain("--tmpfs\n/run")
        // Nothing outside the checkout is writable: not the host's /tmp, nor a cache in the home folder.
        expect(args).not.toContain(`--bind\n${os.tmpdir()}\n`)
        expect(args).not.toContain(`--bind\n${home}/.cache\n`)
        expect(decided.wrapped.env).toEqual({
          PATH: process.env.PATH,
          LANG: "C.UTF-8",
          LC_ALL: "C",
          HOME: home,
          JAVA_HOME: "/opt/java",
          TMPDIR: "/tmp",
          XDG_CACHE_HOME: "/tmp/.cache",
          GOCACHE: "/tmp/.cache/go-build",
          npm_config_cache: "/tmp/.npm",
          BUN_INSTALL_CACHE_DIR: "/tmp/.bun-cache",
        })
        // A working folder outside the checkout is refused, never run with a wider grant.
        expect(Sandbox.unattended({ ...input(process.env, os.homedir()), workspaceRoot: workspace })).toEqual({
          type: "refused",
          message: Sandbox.UNATTENDED_REFUSAL,
        })
        // A .git that is a link cannot be pinned read-only, so the command is refused.
        const linked = scratch()
        symlinkSync(path.join(workspace, ".git"), path.join(linked, ".git"))
        expect(Sandbox.unattended({ ...input(process.env, linked), workspaceRoot: linked })).toEqual({
          type: "refused",
          message: Sandbox.UNATTENDED_REFUSAL,
        })
        rmSync(linked, { recursive: true, force: true })
        // Web access None's own sandbox is unchanged: it still binds the host's temporary folder back in.
        const web = Sandbox.offline({ ...input({ PATH: process.env.PATH }), cwd: workspace, workspaceRoot: workspace })
        expect(web.type === "sandboxed" ? web.wrapped.args.join("\n") : "").toContain(`--bind\n${os.tmpdir()}\n`)
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  test.skipIf(!offline)(
    "a command it wraps cannot read the home folder's secrets, which a command outside it can",
    () => {
      // The home folder sits inside the checkout, since the sandbox replaces /tmp: what hides these is the secret list.
      const workspace = scratch()
      const home = path.join(workspace, "home")
      const secret = randomBytes(12).toString("hex")
      mkdirSync(path.join(home, ".ssh"), { recursive: true })
      writeFileSync(path.join(home, ".ssh", "id_fixture"), `ssh-${secret}`)
      writeFileSync(path.join(home, ".netrc"), `netrc-${secret}`)
      writeFileSync(path.join(home, ".git-credentials"), `credentials-${secret}`)
      writeFileSync(path.join(home, "notes.txt"), "readable")
      const command =
        'cat "$HOME/.ssh/id_fixture" "$HOME/.netrc" "$HOME/.git-credentials" "$HOME/notes.txt" 2>/dev/null; echo " home=$HOME"'
      try {
        const decided = Sandbox.unattended({
          shell: "/bin/sh",
          command,
          cwd: workspace,
          workspaceRoot: workspace,
          home,
          env: { PATH: process.env.PATH, HOME: "/elsewhere" },
        })
        expect(decided.type).toBe("sandboxed")
        if (decided.type !== "sandboxed") return
        const filter = path.join(workspace, "test-filter")
        writeFileSync(filter, decided.wrapped.seccomp!)
        const fd = openSync(filter, "r")
        const inside = (() => {
          try {
            return Bun.spawnSync([decided.wrapped.command, ...decided.wrapped.args], {
              env: decided.wrapped.env,
              stdio: [fd, "pipe", "pipe"],
            })
          } finally {
            closeSync(fd)
          }
        })()
        const outside = Bun.spawnSync(["/bin/sh", "-c", command], { env: { PATH: process.env.PATH, HOME: home } })
        expect(inside.stdout.toString()).toBe(`readable home=${home}\n`)
        expect(outside.stdout.toString()).toBe(
          `ssh-${secret}netrc-${secret}credentials-${secret}readable home=${home}\n`,
        )
      } finally {
        rmSync(workspace, { recursive: true, force: true })
      }
    },
  )

  // vector-everywhere.yml installs bubblewrap and sets this, so the Linux cases above cannot skip there unnoticed.
  test.skipIf(process.env.VECTOR_TEST_REQUIRE_BWRAP !== "1")("bubblewrap works on this runner", () => {
    expect({ works, offline }).toEqual({ works: true, offline: true })
  })
})

// Runs with no bubblewrap on PATH where this test runs: PATH names an empty folder until it is done.
function withoutBwrapSync(run: () => void) {
  const empty = mkdtempSync(path.join(os.tmpdir(), "vector-no-bwrap-"))
  const before = process.env.PATH
  process.env.PATH = empty
  try {
    run()
  } finally {
    process.env.PATH = before
    rmSync(empty, { recursive: true, force: true })
  }
}

// Where the sandbox exists here, the shell tool's command runs with no bubblewrap on PATH; elsewhere as it is.
function withoutSandbox<A, E, R>(run: () => Effect.Effect<A, E, R>) {
  if (Sandbox.unattendedBinary() === undefined) return run()
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const empty = mkdtempSync(path.join(os.tmpdir(), "vector-no-bwrap-"))
      const before = process.env.PATH
      process.env.PATH = empty
      return { empty, before }
    }),
    run,
    (state) =>
      Effect.sync(() => {
        process.env.PATH = state.before
        rmSync(state.empty, { recursive: true, force: true })
      }),
  )
}
