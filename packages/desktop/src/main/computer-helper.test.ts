import { afterEach, describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import path from "node:path"
import { Computer } from "@vectordevai/schema/computer"
import { createFakeHelper, main, manualClock, type FakeOptions } from "../../test/computer/fake-helper"
import { frameReader } from "../../test/computer/transcript"
import { ComputerError } from "./computer-bridge"
import {
  ComputerHelper,
  createHelperClient,
  developmentHelperCommand,
  helperPath,
  preflight,
  type HelperChannel,
} from "./computer-helper"
import { encodeFrame } from "./computer-protocol"

// D14: the actual C1 helper runs in-process on its manual clock. Injected checks/spawn/probe functions below do
// not execute commands, start subprocesses, capture a screen, request permissions or post real input.

type Time = ReturnType<typeof manualClock>
type Request = { id: number; op: Computer.HelperOpName } & Record<string, unknown>
type Stop = { time: Time; close(): Promise<void> }
const stops: Stop[] = []

async function flush() {
  // Settle only promise continuations; all elapsed time in these tests comes from the explicit manual clock.
  for (let count = 0; count < 20; count++) await Promise.resolve()
}

afterEach(async () => {
  const closing = stops.splice(0).map((stop) => ({ ...stop, done: stop.close() }))
  for (let round = 0; round < 3; round++) {
    closing.forEach((stop) => stop.time.advance(1000))
    await flush()
  }
  await Promise.all(closing.map((stop) => stop.done))
})

function fakeChannel(
  options: FakeOptions = {},
  time = manualClock(1000),
  changeHello?: (value: Record<string, unknown>) => unknown,
) {
  const data = new Set<(bytes: Uint8Array) => void>()
  const exits = new Set<(event: { code?: number; signal?: string }) => void>()
  const requests: Request[] = []
  const held: Uint8Array[] = []
  const ignore = new Set<Computer.HelperOpName>()
  const state = { hold: false, ends: 0, kills: 0, exited: false }
  const send = (bytes: Uint8Array) => {
    for (const listener of data) listener(bytes)
  }
  const exit = (event: { code?: number; signal?: string }) => {
    if (state.exited) return
    state.exited = true
    for (const listener of exits) listener(event)
  }
  const fake = createFakeHelper(options, {
    clock: time,
    write(bytes) {
      const value = JSON.parse(Buffer.from(bytes).subarray(4).toString("utf8")) as Record<string, unknown>
      const frame =
        changeHello && value.ok === true && "protocol" in value && "helper" in value
          ? encodeFrame(changeHello(value))
          : bytes
      if (state.hold) held.push(frame)
      else send(frame)
    },
    exit: (code) => exit({ code }),
  })
  const reader = frameReader({
    onFrame(bytes) {
      const request = JSON.parse(Buffer.from(bytes).toString("utf8")) as Request
      requests.push(request)
      if (!ignore.has(request.op)) fake.receive(encodeFrame(request))
    },
  })
  const channel: HelperChannel = {
    write: (bytes) => reader.push(bytes),
    end() {
      state.ends++
      fake.endOfInput()
    },
    kill() {
      state.kills++
      fake.endOfInput()
      exit({ signal: "SIGKILL" })
    },
    onData(cb) {
      data.add(cb)
      return () => void data.delete(cb)
    },
    onExit(cb) {
      exits.add(cb)
      return () => void exits.delete(cb)
    },
  }
  return {
    channel,
    time,
    fake,
    requests,
    held,
    ignore,
    state,
    deliver: (index: number) => send(held.splice(index, 1)[0]!),
    inject: (value: unknown) => send(encodeFrame(value)),
    raw: send,
    crash: (code = 1) => exit({ code }),
  }
}

function clientFixture(options: FakeOptions = {}) {
  const wire = fakeChannel(options)
  const client = createHelperClient(wire.channel, { clock: wire.time })
  stops.push({ time: wire.time, close: () => client.close() })
  return { ...wire, client }
}

function supervisor(
  input: {
    fake?: FakeOptions
    changeHello?: (value: Record<string, unknown>) => unknown
    check?: (executable: string) => Promise<void>
  } = {},
) {
  const time = manualClock(1000)
  const connections: ReturnType<typeof fakeChannel>[] = []
  const spawns: { executable: string; args: readonly string[]; platform: string }[] = []
  const checked: string[] = []
  const helper = new ComputerHelper({
    platform: "darwin",
    channel: "beta",
    packaged: true,
    appPath: path.join(path.sep, "Applications", "Vector Beta.app"),
    clock: time,
    check: async (executable) => {
      checked.push(executable)
      await input.check?.(executable)
    },
    spawn(executable, args, platform) {
      spawns.push({ executable, args, platform })
      const connection = fakeChannel(input.fake, time, input.changeHello)
      connections.push(connection)
      return connection.channel
    },
  })
  stops.push({ time, close: () => helper.close() })
  return { helper, time, spawns, connections, checked }
}

describe("helper client", () => {
  test("starts ids at 1, keeps them unique, and protects op/id from supplied arguments", async () => {
    const { client, requests } = clientFixture()
    await expect(client.request("permissions.status", { id: 99, op: "shutdown" })).resolves.toEqual({
      screen: "granted",
      accessibility: "granted",
    })
    await client.request("displays.list")
    expect(requests.map(({ id, op }) => ({ id, op }))).toEqual([
      { id: 1, op: "permissions.status" },
      { id: 2, op: "displays.list" },
    ])
  })

  test("correlates out-of-order responses with each request's op schema", async () => {
    const fixture = clientFixture()
    fixture.state.hold = true
    const permissions = fixture.client.request<Computer.PermissionsStatus>("permissions.status")
    const displays = fixture.client.request<{ displays: Computer.DisplayInfo[] }>("displays.list")
    fixture.deliver(1)
    expect((await displays).displays).toHaveLength(1)
    fixture.deliver(0)
    expect((await permissions).screen).toBe("granted")
    fixture.state.hold = false
  })

  test("a valid helper refusal rejects only that request and keeps serving", async () => {
    const fixture = clientFixture()
    await expect(fixture.client.request("ui.focused")).rejects.toMatchObject({ code: "unavailable" })
    await expect(fixture.client.request("permissions.status")).resolves.toMatchObject({ screen: "granted" })
    expect(fixture.state.kills).toBe(0)
  })

  test("delivers real helper events, and unsubscribe removes the listener", async () => {
    const fixture = clientFixture()
    const events: Computer.HelperEvent[] = []
    const remove = fixture.client.onEvent((event) => events.push(event))
    fixture.fake.control({ type: "lock", locked: true })
    remove()
    fixture.fake.control({ type: "lock", locked: false })
    expect(events).toEqual([{ event: "locked", locked: true }])
    await expect(fixture.client.request("permissions.status")).resolves.toMatchObject({ screen: "granted" })
  })

  test("a helper cannot manufacture a process exit event", async () => {
    const fixture = clientFixture()
    fixture.ignore.add("permissions.status")
    const rejected = fixture.client.request("permissions.status").catch((error: unknown) => error)
    const events: Computer.HelperEvent[] = []
    fixture.client.onEvent((event) => events.push(event))
    fixture.inject({ event: "exit", code: 73 })
    expect(await rejected).toMatchObject({ code: "failed" })
    expect(events).toEqual([{ event: "exit" }])
    expect(fixture.state.kills).toBe(1)
  })

  test("id 0, an unsent id and a response for the wrong op fail the channel closed", async () => {
    for (const response of [
      { id: 0, ok: false, code: "failed", error: "Unattributable" },
      { id: 2, ok: true },
      { id: 1, ok: true, apps: [] },
    ]) {
      const fixture = clientFixture()
      fixture.ignore.add("permissions.status")
      const rejected = fixture.client.request("permissions.status").catch((error: unknown) => error)
      fixture.inject(response)
      expect(await rejected).toMatchObject({ code: "failed" })
      expect(fixture.state.kills).toBe(1)
      await expect(fixture.client.request("displays.list")).rejects.toMatchObject({
        code: "unavailable",
        reason: "helper_missing",
      })
    }
  })

  test("malformed framing rejects pending requests without surfacing private bytes", async () => {
    const fixture = clientFixture()
    fixture.ignore.add("permissions.status")
    const pending = fixture.client.request("permissions.status").catch((error: unknown) => error)
    const privateBody = Buffer.from('{"private":"must-not-appear"')
    const prefix = Buffer.alloc(4)
    prefix.writeUInt32BE(privateBody.length)
    expect(() => fixture.raw(Buffer.concat([prefix, privateBody]))).not.toThrow()
    const error = await pending
    expect(error).toMatchObject({ code: "failed" })
    expect(String(error)).not.toContain("must-not-appear")
    expect(fixture.state.kills).toBe(1)
  })

  test("deadline sends cancel then releaseAll, and a late answer cannot settle a newer request", async () => {
    const fixture = clientFixture()
    fixture.ignore.add("permissions.status")
    const timedOut = fixture.client.request("permissions.status", {}, 100).catch((error: unknown) => error)
    fixture.time.advance(99)
    expect(fixture.requests.map((request) => request.op)).toEqual(["permissions.status"])
    fixture.time.advance(1)
    expect(await timedOut).toMatchObject({ code: "timeout" })
    await flush()
    expect(
      fixture.requests.slice(1).map(({ id, op, target }) => ({ id, op, ...(target === undefined ? {} : { target }) })),
    ).toEqual([
      { id: 2, op: "cancel", target: 1 },
      { id: 3, op: "input.releaseAll" },
    ])
    fixture.inject({ id: 1, ok: true, screen: "denied", accessibility: "denied" })
    const displays = await fixture.client.request<{ displays: Computer.DisplayInfo[] }>("displays.list")
    expect(displays.displays).toHaveLength(1)
    expect(fixture.requests.at(-1)?.id).toBe(4)
    expect(fixture.state.kills).toBe(0)
  })

  test("missing cleanup acknowledgement kills after its 2 s bound", async () => {
    const fixture = clientFixture()
    fixture.ignore.add("permissions.status")
    fixture.ignore.add("cancel")
    const timedOut = fixture.client.request("permissions.status", {}, 100).catch((error: unknown) => error)
    fixture.time.advance(100)
    expect(await timedOut).toMatchObject({ code: "timeout" })
    fixture.time.advance(1999)
    await flush()
    expect(fixture.state.kills).toBe(0)
    fixture.time.advance(1)
    await flush()
    expect(fixture.state.kills).toBe(1)
    expect(fixture.requests.filter((request) => request.op === "cancel")).toHaveLength(1)
    expect(fixture.requests.filter((request) => request.op === "input.releaseAll")).toHaveLength(1)
  })

  test("hello is bounded at 5 s and never starts normal timeout recovery", async () => {
    const fixture = clientFixture({ hangHello: true })
    const rejected = fixture.client.request("hello", { protocol: { min: 1, max: 1 } }).catch((error: unknown) => error)
    fixture.time.advance(4999)
    expect(fixture.state.kills).toBe(0)
    fixture.time.advance(1)
    expect(await rejected).toMatchObject({ code: "timeout" })
    expect(fixture.state.kills).toBe(1)
    expect(fixture.requests.map((request) => request.op)).toEqual(["hello"])
  })

  test("close bounds release at 300 ms, then shutdown, then closes and kills once", async () => {
    const fixture = clientFixture()
    fixture.ignore.add("input.releaseAll")
    fixture.ignore.add("shutdown")
    const closed = fixture.client.close()
    await expect(fixture.client.request("permissions.status")).rejects.toMatchObject({
      code: "unavailable",
      reason: "helper_missing",
    })
    fixture.time.advance(299)
    expect(fixture.requests.map((request) => request.op)).toEqual(["input.releaseAll"])
    expect(fixture.state.kills).toBe(0)
    fixture.time.advance(1)
    await flush()
    expect(fixture.requests.map((request) => request.op)).toEqual(["input.releaseAll", "shutdown"])
    fixture.time.advance(300)
    await closed
    await fixture.client.close()
    expect(fixture.state.ends).toBe(1)
    expect(fixture.state.kills).toBe(1)
  })

  test("channel EOF makes the actual fake release and exit, and is forwarded once", async () => {
    const fixture = clientFixture()
    const events: Computer.HelperEvent[] = []
    fixture.client.onEvent((event) => events.push(event))
    fixture.channel.end()
    expect(fixture.fake.log.some((entry) => entry.kind === "release" && entry.reason === "eof")).toBe(true)
    expect(events).toEqual([{ event: "exit", code: 0 }])
    await expect(fixture.client.request("permissions.status")).rejects.toMatchObject({
      code: "unavailable",
      reason: "helper_missing",
    })
  })
})

describe("helper supervisor", () => {
  test("shares startup, negotiates protocol 1 and uses the fixed serve argv", async () => {
    const fixture = supervisor()
    const first = fixture.helper.start()
    expect(fixture.helper.start()).toBe(first)
    const hello = await first
    expect(hello.protocol).toEqual({ min: 1, max: 1 })
    expect(hello.responsible).toBe(true)
    expect(fixture.spawns).toHaveLength(1)
    expect(fixture.checked).toEqual([fixture.spawns[0]!.executable])
    expect(fixture.spawns[0]!.args).toEqual(["--stdio", "--parent-pid", String(process.pid)])
    expect(fixture.connections[0]!.requests[0]).toEqual({ id: 1, op: "hello", protocol: { min: 1, max: 1 } })
    await expect(fixture.helper.request("permissions.status")).resolves.toMatchObject({ screen: "granted" })
  })

  test("a non-overlapping range is refused with helper_incompatible", async () => {
    const fixture = supervisor({ fake: { protocol: { min: 2, max: 2 } } })
    await expect(fixture.helper.start()).rejects.toMatchObject({ code: "helper_incompatible" })
    expect(fixture.connections[0]!.fake.log.some((entry) => entry.kind === "exit")).toBe(true)
  })

  test("unresponsible, inverted-range or oversized-limit greetings fail closed", async () => {
    for (const changed of [
      { responsible: false },
      { protocol: { min: 2, max: 1 } },
      { limits: { maxFrameBytes: Computer.LIMITS.helperFrameBytes + 1 } },
    ]) {
      const fixture = supervisor({ changeHello: (value) => ({ ...value, ...changed }) })
      await expect(fixture.helper.start()).rejects.toBeInstanceOf(ComputerError)
      expect(fixture.connections[0]!.state.kills).toBe(1)
      expect(
        fixture.connections[0]!.requests.every(
          (request) => !request.op.startsWith("input.") || request.op === "input.releaseAll",
        ),
      ).toBe(true)
    }
  })

  test("sends heartbeat every 2 s and stops it on close", async () => {
    const fixture = supervisor()
    await fixture.helper.start()
    const connection = fixture.connections[0]!
    fixture.time.advance(1999)
    expect(connection.requests.filter((request) => request.op === "heartbeat")).toHaveLength(0)
    fixture.time.advance(1)
    expect(connection.requests.filter((request) => request.op === "heartbeat")).toHaveLength(1)
    await fixture.helper.close()
    fixture.time.advance(10_000)
    expect(connection.requests.filter((request) => request.op === "heartbeat")).toHaveLength(1)
  })

  test("allows at most three automatic restarts per rolling minute while idle", async () => {
    const fixture = supervisor()
    await fixture.helper.start()
    for (let restart = 0; restart < 3; restart++) {
      fixture.connections.at(-1)!.crash()
      fixture.time.advance(99)
      await flush()
      expect(fixture.spawns).toHaveLength(restart + 1)
      fixture.time.advance(1)
      await flush()
      await fixture.helper.start()
      expect(fixture.spawns).toHaveLength(restart + 2)
    }
    fixture.connections.at(-1)!.crash()
    fixture.time.advance(100)
    await flush()
    expect(fixture.spawns).toHaveLength(4)
    await expect(fixture.helper.start()).rejects.toMatchObject({ code: "unavailable", reason: "helper_missing" })
    await expect(fixture.helper.request("permissions.status")).rejects.toMatchObject({
      code: "unavailable",
      reason: "helper_missing",
    })
    await expect(fixture.helper.resume()).rejects.toMatchObject({ code: "unavailable", reason: "helper_missing" })
    expect(fixture.spawns).toHaveLength(4)
    fixture.time.advance(60_000)
    await fixture.helper.resume()
    expect(fixture.spawns).toHaveLength(5)
  })

  test("a crash during a run emits exit and stays stopped until explicit Resume", async () => {
    const fixture = supervisor()
    const events: Computer.HelperEvent[] = []
    fixture.helper.onEvent((event) => events.push(event))
    await fixture.helper.start()
    fixture.helper.setRunActive(true)
    fixture.connections[0]!.crash(17)
    fixture.time.advance(60_000)
    await flush()
    expect(events).toEqual([{ event: "exit", code: 17 }])
    expect(fixture.connections[0]!.state.kills).toBe(1)
    expect(fixture.spawns).toHaveLength(1)
    await expect(fixture.helper.start()).rejects.toMatchObject({ code: "unavailable", reason: "helper_missing" })
    await fixture.helper.resume()
    expect(fixture.spawns).toHaveLength(2)
  })

  test("preflight rejection prevents spawn entirely", async () => {
    const fixture = supervisor({
      check: (executable) =>
        preflight({
          platform: "win32",
          os: "10.0.22631",
          executable,
          arch: "x64",
          hashes: { x64: "0".repeat(64) },
          read: async () => Buffer.from("different helper"),
        }),
    })
    await expect(fixture.helper.start()).rejects.toMatchObject({ code: "unavailable", reason: "helper_missing" })
    expect(fixture.spawns).toHaveLength(0)
  })

  test("close during preflight never lets a delayed check spawn a helper", async () => {
    const gate = Promise.withResolvers<void>()
    const fixture = supervisor({ check: () => gate.promise })
    const starting = fixture.helper.start()
    const rejected = starting.catch((error: unknown) => error)
    await fixture.helper.close()
    gate.resolve()
    expect(await rejected).toMatchObject({ code: "stopped" })
    expect(fixture.spawns).toHaveLength(0)
  })

  test("probe consumes C1's nested permission status and uses only the fixed probe argv", async () => {
    for (const platform of ["macos", "windows"] as const) {
      const time = manualClock()
      const commands: readonly string[][] = []
      const seen = commands as string[][]
      const helper = new ComputerHelper({
        platform: platform === "macos" ? "darwin" : "win32",
        channel: "beta",
        packaged: false,
        clock: time,
        check: async () => {},
        spawn: () => {
          throw new Error("A probe must not start a serving helper")
        },
        probeCommand: async (argv) => {
          seen.push([...argv])
          const text: string[] = []
          const code = main(["--probe", "--json", "--platform", platform], {
            out: (value) => text.push(value),
            err: (value) => {
              throw new Error(value)
            },
          })
          return { code: code ?? null, stdout: text.join("") }
        },
      })
      stops.push({ time, close: () => helper.close() })
      await expect(helper.probe()).resolves.toMatchObject({
        permissions: { screen: platform === "macos" ? "granted" : "n/a" },
        responsible: true,
      })
      expect(commands[0]!.slice(1)).toEqual(["--probe", "--json"])
    }
  })
})

describe("helper preflight and paths", () => {
  test("uses fixed packaged names and platform-specific development output", () => {
    const app = path.join(path.sep, "Applications", "Vector Beta.app")
    expect(helperPath("darwin", "beta", true, { appPath: app })).toBe(
      path.join(app, "Contents/Helpers/VectorComputer.app/Contents/MacOS/VectorComputer"),
    )
    expect(helperPath("win32", "prod", true, { resourcesPath: "C:\\Vector\\resources" })).toBe(
      "C:\\Vector\\resources\\computer\\vector-computer.exe",
    )
    expect(helperPath("darwin", "dev", false, { devRoot: "/project" })).toBe(
      path.join("/project", "native/out/darwin/VectorComputer.app/Contents/MacOS/VectorComputer"),
    )
    expect(helperPath("win32", "dev", false, { devRoot: "/project" })).toBe(
      path.join("/project", "native/out/win32/vector-computer.exe"),
    )
    expect(() => helperPath("linux", "prod", true)).toThrow(ComputerError)
  })

  test("refuses unsupported OS versions before reading or checking any executable", async () => {
    const touched: string[] = []
    for (const [platform, os] of [
      ["darwin", "22.6.0"],
      ["win32", "10.0.19040"],
      ["linux", "6.8.0"],
    ] as const) {
      await expect(
        preflight({
          platform,
          os,
          executable: "/not-read",
          arch: "x64",
          run: async () => {
            touched.push("run")
            return { code: 0, stdout: "" }
          },
          read: async () => {
            touched.push("read")
            return Buffer.alloc(0)
          },
        }),
      ).rejects.toMatchObject({ code: "unsupported_os" })
    }
    expect(touched).toEqual([])
  })

  test("Windows requires a compiled hash for this architecture, matching the file bytes", async () => {
    const bytes = Buffer.from("trusted helper fixture")
    const read: string[] = []
    const input = {
      platform: "win32",
      os: "10.0.19041",
      executable: "C:\\Vector\\vector-computer.exe",
      arch: "arm64",
      read: async (file: string) => {
        read.push(file)
        return bytes
      },
      run: async () => {
        throw new Error("Windows hash preflight must not call codesign")
      },
    } as const
    await expect(preflight({ ...input, hashes: { x64: "0".repeat(64) } })).rejects.toMatchObject({
      code: "unavailable",
      reason: "helper_missing",
    })
    expect(read).toEqual([])
    await expect(preflight({ ...input, hashes: { arm64: "0".repeat(64) } })).rejects.toMatchObject({
      code: "unavailable",
      reason: "helper_missing",
    })
    await expect(
      preflight({ ...input, hashes: { arm64: createHash("sha256").update(bytes).digest("hex") } }),
    ).resolves.toBeUndefined()
    expect(read).toEqual([input.executable, input.executable])
  })

  test("Developer ID verification binds the helper to Vector's Team ID", async () => {
    const commands: (readonly string[])[] = []
    const executable = path.join(
      path.sep,
      "Applications/Vector.app/Contents/Helpers/VectorComputer.app/Contents/MacOS/VectorComputer",
    )
    const appPath = path.join(path.sep, "Applications/Vector.app")
    await preflight({
      platform: "darwin",
      os: "23.0.0",
      executable,
      appPath,
      arch: "arm64",
      run: async (argv) => {
        commands.push(argv)
        return { code: 0, stdout: commands.length === 1 ? "Executable=Vector\nTeamIdentifier=TEAM123456\n" : "" }
      },
    })
    expect(commands[0]).toEqual(["/usr/bin/codesign", "-dv", "--verbose=4", appPath])
    expect(commands[1]).toEqual([
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      "-R",
      'anchor apple generic and certificate leaf[subject.OU] = "TEAM123456"',
      path.resolve(executable, "../../.."),
    ])
  })

  test("a refused Developer ID requirement never falls back to ad-hoc verification", async () => {
    const commands: (readonly string[])[] = []
    await expect(
      preflight({
        platform: "darwin",
        os: "23.0.0",
        executable: "/VectorComputer.app/Contents/MacOS/VectorComputer",
        arch: "arm64",
        run: async (argv) => {
          commands.push(argv)
          return { code: commands.length === 1 ? 0 : 1, stdout: "TeamIdentifier=TEAM123456\n" }
        },
      }),
    ).rejects.toMatchObject({ code: "unavailable", reason: "helper_missing" })
    expect(commands).toHaveLength(2)
    expect(commands[1]).toContain("-R")
  })

  test("ad-hoc builds still require strict helper signature verification", async () => {
    const commands: (readonly string[])[] = []
    await preflight({
      platform: "darwin",
      os: "23.0.0",
      executable: "/VectorComputer.app/Contents/MacOS/VectorComputer",
      arch: "arm64",
      run: async (argv) => {
        commands.push(argv)
        return { code: 0, stdout: "TeamIdentifier=not set\nSignature=adhoc\n" }
      },
    })
    expect(commands[1]).toContain("--strict")
    expect(commands[1]).not.toContain("-R")
  })

  test("beta and prod ignore an invalid development-command value without parsing it", () => {
    const previous = process.env.VECTOR_COMPUTER_HELPER_COMMAND
    process.env.VECTOR_COMPUTER_HELPER_COMMAND = "not JSON, never execute"
    try {
      expect(developmentHelperCommand("beta")).toBeUndefined()
      expect(developmentHelperCommand("prod")).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.VECTOR_COMPUTER_HELPER_COMMAND
      else process.env.VECTOR_COMPUTER_HELPER_COMMAND = previous
    }
  })
})
