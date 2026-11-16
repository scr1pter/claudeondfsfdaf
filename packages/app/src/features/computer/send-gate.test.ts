import { describe, expect, jest, test } from "bun:test"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { createFakeComputer, type FakeComputerScript } from "./fake-platform"
import { ComputerSendGate } from "./send-gate"

type Client = Parameters<typeof ComputerSendGate.engine>[0]

const granted: Computer.PermissionsView = {
  rows: [
    { id: "screen", status: "granted", pane: "untrusted:screen" },
    { id: "accessibility", status: "granted", pane: "untrusted:accessibility" },
  ],
  canReset: false,
  adhoc: false,
  helperStart: "ok",
  vectorHoldsGrant: { screen: false, accessibility: false },
}
const ready: FakeComputerScript = { prefs: { enabled: true, consentedAt: 1 }, permissions: granted }
const pill = [
  { type: "text", content: "open my receipts " },
  { type: "computer", content: `@${Hands.MENTION}` },
]

/** The real fake platform, with every read counted (the fake logs only mutations). */
function platform(script: FakeComputerScript = ready, fail?: "prefs" | "permissions") {
  const fake = createFakeComputer(script)
  const reads = { prefs: 0, status: 0, state: 0, permissions: 0, recheck: 0, apps: 0 }
  const computer: Computer.ComputerPlatform = {
    ...fake,
    supported: fake.supported,
    prefs: () => {
      reads.prefs++
      return fail === "prefs" ? Promise.reject(new Error("ipc")) : fake.prefs()
    },
    status: () => {
      reads.status++
      return fake.status()
    },
    state: () => {
      reads.state++
      return fake.state()
    },
    permissions: () => {
      reads.permissions++
      return fail === "permissions" ? Promise.reject(new Error("probe")) : fake.permissions()
    },
    recheck: () => {
      reads.recheck++
      return fake.recheck()
    },
    apps: (query) => {
      reads.apps++
      return fake.apps(query)
    },
  }
  return { computer, reads }
}

function client(response: () => Promise<unknown>) {
  const calls: { params: unknown; options: { throwOnError?: boolean; signal?: AbortSignal } }[] = []
  return {
    calls,
    client: {
      experimental: {
        capabilities: {
          get: (params: unknown, options: { throwOnError?: boolean; signal?: AbortSignal }) => {
            calls.push({ params, options })
            return response()
          },
        },
      },
    } as unknown as Client,
  }
}

const capable = () =>
  client(async () => ({ data: { backgroundSubagents: false, computer: { available: true, protocol: 1 } } }))

describe("computer send gate: local readiness", () => {
  test("an unmarked prompt reads nothing from the platform or the engine", async () => {
    const local = platform()
    const engine = capable()
    expect(
      await ComputerSendGate.check({
        prompt: [{ type: "text" }, { type: "agent" }, { type: "file" }, { type: "image" }],
        computer: local.computer,
        client: engine.client,
      }),
    ).toBeUndefined()
    expect(local.reads).toEqual({ prefs: 0, status: 0, state: 0, permissions: 0, recheck: 0, apps: 0 })
    expect(engine.calls).toEqual([])
    expect(ComputerSendGate.marked(pill)).toBe(true)
    expect(ComputerSendGate.marked([])).toBe(false)
  })

  test("a ready platform and a capable engine send; the send reads permissions once and never rechecks", async () => {
    const local = platform()
    const engine = capable()
    expect(
      await ComputerSendGate.check({ prompt: pill, computer: local.computer, client: engine.client }),
    ).toBeUndefined()
    expect(local.reads).toEqual({ prefs: 1, status: 1, state: 1, permissions: 1, recheck: 0, apps: 0 })
    expect(engine.calls).toHaveLength(1)
    expect(engine.calls[0].options.throwOnError).toBe(false)
    expect(engine.calls[0].options.signal).toBeInstanceOf(AbortSignal)
  })

  test("the popover's readiness never reads permissions, and still needs enabling, consent and an available helper", async () => {
    const local = platform()
    expect(await ComputerSendGate.readiness(local.computer)).toMatchObject({ ready: true })
    expect(local.reads.permissions).toBe(0)
    expect(local.reads.recheck).toBe(0)
    for (const script of [
      { ...ready, prefs: { enabled: false, consentedAt: 1 } },
      { ...ready, prefs: { enabled: true } },
      { ...ready, status: { available: false, reason: "permissions" as const } },
    ]) {
      const other = platform(script)
      expect(await ComputerSendGate.readiness(other.computer)).toEqual({
        ready: false,
        policy: expect.objectContaining({ enabled: true }),
      })
      expect(other.reads.permissions).toBe(0)
    }
  })

  test("missing setup is a setup refusal that keeps no engine request", async () => {
    const scripts: FakeComputerScript[] = [
      { ...ready, prefs: { enabled: false, consentedAt: 1 } },
      { ...ready, prefs: { enabled: true } },
      { ...ready, prefs: { enabled: true, consentedAt: 0 } },
      { ...ready, permissions: { ...granted, rows: [granted.rows[0], { ...granted.rows[1], status: "denied" }] } },
      { ...ready, permissions: { ...granted, rows: [granted.rows[0], granted.rows[0]] } },
      { ...ready, permissions: { ...granted, rows: [granted.rows[0]] } },
    ]
    for (const script of scripts) {
      const engine = capable()
      const refusal = await ComputerSendGate.check({
        prompt: pill,
        computer: platform(script).computer,
        client: engine.client,
      })
      expect(refusal).toBeInstanceOf(ComputerSendGate.Refusal)
      expect(refusal).toMatchObject({ key: "computer.mention.setupFirst", kind: "setup" })
      expect(engine.calls).toEqual([])
    }
  })

  test("a failed read or a blocked Windows capture can be fixed in onboarding", async () => {
    for (const fail of ["prefs", "permissions"] as const)
      expect(
        await ComputerSendGate.check({
          prompt: pill,
          computer: platform(ready, fail).computer,
          client: capable().client,
        }),
      ).toMatchObject({ key: "computer.onboarding.checkFailed", kind: "setup" })
    expect(
      await ComputerSendGate.check({
        prompt: pill,
        computer: platform({
          prefs: { enabled: true, consentedAt: 1 },
          state: { backend: "local-windows" },
          status: { available: false, reason: "blocked_by_os" },
        }).computer,
        client: capable().client,
      }),
    ).toMatchObject({ key: "computer.onboarding.windows.captureBlocked", kind: "setup" })
  })

  test("what setup cannot fix gets its fixed sentence alone", async () => {
    const cases: [Computer.ComputerPlatform | undefined, ComputerSendGate.RefusalKey][] = [
      [undefined, "computer.availability.desktop"],
      [platform({ ...ready, supported: false }).computer, "computer.status.linux"],
      [platform({ ...ready, policy: { enabled: false } }).computer, "computer.availability.company"],
      [
        platform({ ...ready, status: { available: false, reason: "policy_disabled" } }).computer,
        "computer.availability.company",
      ],
      [
        platform({ ...ready, status: { available: false, reason: "unsupported_os" } }).computer,
        "computer.availability.macos",
      ],
      [
        platform({ ...ready, status: { available: false, reason: "helper_missing" } }).computer,
        "computer.onboarding.helperFailed",
      ],
      [
        platform({
          prefs: { enabled: true, consentedAt: 1 },
          state: { backend: "local-windows" },
          status: { available: false, reason: "elevated" },
        }).computer,
        "computer.availability.elevated",
      ],
    ]
    for (const [computer, key] of cases) {
      const engine = capable()
      expect(await ComputerSendGate.check({ prompt: pill, computer, client: engine.client })).toMatchObject({
        key,
        kind: "local",
      })
      expect(engine.calls).toEqual([])
    }
  })

  test("a ready Windows platform needs its clean capture and elevation flags", async () => {
    const windows = {
      ...granted,
      rows: [],
      windows: {
        captureBlocked: false,
        elevated: false,
        inputSetup: { state: "ready" as const, mouse: true, keyboard: true },
      },
    }
    const script = { prefs: { enabled: true, consentedAt: 1 }, state: { backend: "local-windows" as const } }
    expect(
      await ComputerSendGate.check({
        prompt: pill,
        computer: platform({ ...script, permissions: windows }).computer,
        client: capable().client,
      }),
    ).toBeUndefined()
    expect(
      await ComputerSendGate.check({
        prompt: pill,
        computer: platform({ ...script, permissions: granted }).computer,
        client: capable().client,
      }),
    ).toMatchObject({ key: "computer.onboarding.checkFailed", kind: "setup" })
  })

  test("what only the fresh probe reports gets its own sentence, and Set up only where onboarding can fix it", async () => {
    const windows = {
      ...granted,
      rows: [],
      windows: {
        captureBlocked: false,
        elevated: false,
        inputSetup: { state: "ready" as const, mouse: true, keyboard: true },
      },
    }
    const script = { prefs: { enabled: true, consentedAt: 1 }, state: { backend: "local-windows" as const } }
    // The desktop's status has not caught up with what the probe found, so only the permission view reports it.
    const cases: [FakeComputerScript, ComputerSendGate.RefusalKey, "setup" | "local"][] = [
      [
        { ...script, permissions: { ...windows, windows: { captureBlocked: false, elevated: true } } },
        "computer.availability.elevated",
        "local",
      ],
      [
        { ...script, permissions: { ...windows, windows: { captureBlocked: true, elevated: false } } },
        "computer.onboarding.windows.captureBlocked",
        "setup",
      ],
      [{ ...script, permissions: { ...windows, helperStart: "failed" } }, "computer.onboarding.helperFailed", "local"],
      [{ ...ready, permissions: { ...granted, helperStart: "failed" } }, "computer.onboarding.helperFailed", "local"],
      // Never set up as well: the probe's sentence still comes first, as the same status reason's would.
      [
        { prefs: { enabled: false }, permissions: { ...granted, helperStart: "failed" } },
        "computer.onboarding.helperFailed",
        "local",
      ],
    ]
    for (const [setup, key, kind] of cases) {
      const engine = capable()
      expect(
        await ComputerSendGate.check({ prompt: pill, computer: platform(setup).computer, client: engine.client }),
      ).toMatchObject({ key, kind })
      expect(engine.calls).toEqual([])
    }
  })

  test("only what onboarding can fix needs setup", () => {
    expect(ComputerSendGate.needsSetup({ ready: true })).toBe(false)
    expect(ComputerSendGate.needsSetup({ ready: false })).toBe(true)
    for (const blocked of ["computer.onboarding.checkFailed", "computer.onboarding.windows.captureBlocked"] as const)
      expect(ComputerSendGate.needsSetup({ ready: false, blocked })).toBe(true)
    for (const blocked of [
      "computer.availability.company",
      "computer.settings.managed",
      "computer.availability.elevated",
      "computer.availability.macos",
      "computer.availability.desktop",
      "computer.status.linux",
      "computer.onboarding.helperFailed",
    ] as const)
      expect(ComputerSendGate.needsSetup({ ready: false, blocked })).toBe(false)
  })

  test("a read that never answers fails closed after the limit, so a send is refused instead of held", async () => {
    const hung = platform()
    hung.computer.permissions = () => new Promise(() => undefined)
    jest.useFakeTimers()
    try {
      const engine = capable()
      const pending = ComputerSendGate.check({ prompt: pill, computer: hung.computer, client: engine.client })
      let settled = false
      void pending.then(() => (settled = true))
      jest.advanceTimersByTime(ComputerSendGate.LIMIT - 1)
      for (let turn = 0; turn < 10; turn++) await Promise.resolve()
      expect(settled).toBe(false)
      jest.advanceTimersByTime(1)
      expect(await pending).toMatchObject({ key: "computer.onboarding.checkFailed", kind: "setup" })
      expect(engine.calls).toEqual([])
      // The popover's lighter read is bounded the same way.
      const quiet = platform()
      quiet.computer.prefs = () => new Promise(() => undefined)
      const light = ComputerSendGate.readiness(quiet.computer)
      jest.advanceTimersByTime(ComputerSendGate.LIMIT)
      expect(await light).toEqual({ ready: false, blocked: "computer.onboarding.checkFailed" })
    } finally {
      jest.useRealTimers()
    }
  })

  test("a refusal reads in English with the feature's name for any generic display", () => {
    const refusal = new ComputerSendGate.Refusal("computer.mention.setupFirst", "setup")
    expect(refusal.message).toBe(`Set up ${Hands.NAME} first`)
    expect(new ComputerSendGate.Refusal("computer.mention.shell", "local").message).toContain(Hands.NAME)
    expect(refusal).toBeInstanceOf(Error)
  })
})

describe("computer send gate: destination engine", () => {
  test("only an available computer capability at this protocol passes", async () => {
    expect(await ComputerSendGate.engine(capable().client)).toBeUndefined()
    expect(
      await ComputerSendGate.engine(
        client(async () => ({ data: { backgroundSubagents: false, computer: { available: true } } })).client,
      ),
    ).toBeUndefined()
    const unavailable: [() => Promise<unknown>, ComputerSendGate.RefusalKey][] = [
      [async () => ({ data: { backgroundSubagents: false } }), "computer.availability.engine"],
      [
        async () => ({ data: undefined, error: { status: 404 }, response: { status: 404 } }),
        "computer.availability.engine",
      ],
      [() => Promise.reject(new Error("offline")), "computer.availability.engine"],
      [
        async () => ({
          data: { backgroundSubagents: false, computer: { available: true, protocol: Computer.PROTOCOL + 1 } },
        }),
        "computer.availability.engine",
      ],
      [
        async () => ({
          data: { backgroundSubagents: false, computer: { available: false, reason: "no_desktop_bridge" } },
        }),
        "computer.availability.engine",
      ],
      [
        async () => ({
          data: { backgroundSubagents: false, computer: { available: false, protocol: 1, reason: "unsupported_os" } },
        }),
        "computer.availability.engine",
      ],
      [
        async () => ({ data: { backgroundSubagents: false, computer: { available: false, reason: "constructor" } } }),
        "computer.availability.engine",
      ],
    ]
    for (const [response, key] of unavailable) expect(await ComputerSendGate.engine(client(response).client)).toBe(key)
  })

  test("engine reasons with a fixed sentence keep it", async () => {
    const reasons: [string, ComputerSendGate.RefusalKey][] = [
      ["policy", "computer.availability.company"],
      ["policy_disabled", "computer.availability.company"],
      ["disabled", "computer.availability.disabled"],
      ["offline", "computer.availability.localNone"],
      ["elevated", "computer.availability.elevated"],
    ]
    for (const [reason, key] of reasons)
      expect(
        await ComputerSendGate.engine(
          client(async () => ({ data: { backgroundSubagents: false, computer: { available: false, reason } } })).client,
        ),
      ).toBe(key)
  })

  test("a ready platform still refuses a marked message for an engine without the capability", async () => {
    const engine = client(async () => ({ data: undefined, error: { status: 404 } }))
    expect(
      await ComputerSendGate.check({ prompt: pill, computer: platform().computer, client: engine.client }),
    ).toMatchObject({ key: "computer.availability.engine", kind: "engine" })
    expect(engine.calls).toHaveLength(1)
  })
})
