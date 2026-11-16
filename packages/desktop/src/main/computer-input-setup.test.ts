import { expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { Computer } from "@vectordevai/schema/computer"
import { createComputerPermissions } from "./computer-permissions"
import { defaultPrefs, resolve } from "./computer-settings"

test("input setup is a closed helper contract, never a model action", () => {
  const request = Schema.decodeUnknownOption(Computer.helperRequest("input.setup"), { onExcessProperty: "error" })
  for (const action of Computer.InputSetupAction.literals)
    expect(Option.isSome(request({ id: 1, op: "input.setup", action }))).toBe(true)
  for (const value of [
    { id: 1, op: "input.setup", action: "resume" },
    { id: 1, op: "input.setup", action: "start", mouse: true },
    { id: 1, op: "input.setup" },
  ])
    expect(Option.isNone(request(value))).toBe(true)
  const response = Schema.decodeUnknownOption(Computer.helperResponse("input.setup"), { onExcessProperty: "error" })
  expect(Option.isSome(response({ id: 1, ok: true, state: "ready", mouse: true, keyboard: true }))).toBe(true)
  for (const value of [
    { id: 1, ok: true, state: "ready", mouse: true, keyboard: false },
    { id: 1, ok: true, state: "ready", mouse: true, keyboard: true, keyHistory: [] },
  ])
    expect(Option.isNone(response(value))).toBe(true)
  expect(Schema.is(Computer.ToolAction)("input.setup")).toBe(false)
  expect(Schema.is(Computer.BridgeRequest)({ command: "input.setup", action: "start" })).toBe(false)
})

test("Windows setup requires consent and trusted native readiness; Mac never calls it", async () => {
  const prefs = defaultPrefs("win32")
  let native: unknown = { state: "needs-calibration", mouse: false, keyboard: false }
  const calls: unknown[] = []
  const settings = { get: () => resolve(prefs), setPrefs: async () => {} }
  const input = {
    platform: "win32" as const,
    helperVersion: "1.0.15",
    settings,
    helper: {
      probe: async () => ({
        permissions: { screen: "n/a" as const, accessibility: "n/a" as const },
        responsible: true,
        captureBlocked: false,
        elevated: false,
      }),
      request: async <T>(op: Computer.HelperOpName, args?: Record<string, unknown>) => {
        calls.push({ op, args })
        return native as T
      },
      refreshPermissions: async () => {},
    },
    promptStore: { get: () => undefined, set: () => {} },
    signing: () => "signed" as const,
    vector: { getMediaAccessStatus: () => "denied", isTrustedAccessibilityClient: () => false },
    elevated: () => false,
    openExternal: () => {},
  }
  const service = createComputerPermissions(input)
  expect((await service.list()).windows?.inputSetup?.state).toBe("unavailable")
  expect(calls).toEqual([])
  await expect(service.inputSetup("start")).rejects.toThrow("Consent")
  prefs.consentedAt = 1
  expect(await service.inputSetup("start")).toEqual(native)
  expect(calls).toEqual([{ op: "input.setup", args: { action: "start" } }])
  native = { state: "ready", mouse: true, keyboard: false }
  await expect(service.inputSetup("status")).rejects.toThrow("verified")
  native = { state: "ready", mouse: true, keyboard: true }
  expect(Computer.inputSetupReady((await service.list()).windows?.inputSetup)).toBe(true)
  const before = calls.length
  await expect(createComputerPermissions({ ...input, platform: "darwin" }).inputSetup("start")).rejects.toMatchObject({
    code: "unsupported_action",
  })
  expect(calls.length).toBe(before)
})
