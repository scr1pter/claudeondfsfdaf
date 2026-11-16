import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerAvailability } from "@/computer/availability"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { parameters } from "@/tool/computer"
import { ToolJsonSchema } from "@/tool/json-schema"
import { disposeAllInstances, withTmpdirInstance } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const ready: Computer.Capabilities = {
  protocol: 1,
  available: true,
  backend: "fake",
  actions: ["screenshot", "read_ui"],
  features: { background: false, uiTree: true, zoom: false, clipboard: false, locked: false },
}

afterEach(disposeAllInstances)

function fixture(body: unknown = ready, status = 200, config: ConfigV1.Info = {}) {
  const calls: HttpClientRequest.HttpClientRequest[] = []
  const client = HttpClient.make((request) => {
    calls.push(request)
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status })))
  })
  return {
    calls,
    it: testEffect(
      LayerNode.compile(ComputerAvailability.node, [
        [Config.node, TestConfig.layer({ get: () => Effect.succeed(config) })],
        [RuntimeFlags.node, RuntimeFlags.layer({ client: "cli" })],
        [httpClient, Layer.succeed(HttpClient.HttpClient, client)],
      ]),
    ),
  }
}

function environment<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  values: { url?: string; token?: string; wsl?: string } = { url: "http://127.0.0.1:45100", token: "computer-test" },
) {
  const entries = {
    [Computer.BRIDGE.urlEnv]: values.url,
    [Computer.BRIDGE.tokenEnv]: values.token,
    WSL_DISTRO_NAME: values.wsl,
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(entries).map((key) => [key, process.env[key]]))
      for (const [key, value] of Object.entries(entries)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )
}

describe("computer availability", () => {
  const cached = fixture()
  cached.it.effect("one authenticated capabilities probe is shared for 30 seconds", () =>
    environment(
      Effect.gen(function* () {
        const service = yield* ComputerAvailability.Service
        expect(yield* service.capabilities()).toEqual({ available: true, protocol: 1 })
        expect(yield* service.unavailable()).toBeUndefined()
        expect(yield* service.actions()).toEqual(["screenshot", "read_ui"])
        expect(cached.calls).toHaveLength(1)
        expect(cached.calls[0].url).toBe("http://127.0.0.1:45100/computer/capabilities")
        expect(cached.calls[0].headers.authorization).toBe("Bearer computer-test")
        expect(cached.calls[0].headers[Computer.BRIDGE.protocolHeader.toLowerCase()]).toBe("1")
        yield* TestClock.adjust(29_999)
        yield* service.capabilities()
        expect(cached.calls).toHaveLength(1)
        yield* TestClock.adjust(1)
        yield* service.capabilities()
        expect(cached.calls).toHaveLength(2)
      }).pipe(withTmpdirInstance()),
    ),
  )

  for (const values of [{}, { url: "http://127.0.0.1:45100" }, { token: "computer-test" }]) {
    const missing = fixture()
    missing.it.instance(
      `an incomplete environment pair cannot register a desktop bridge: ${Object.keys(values).join(",") || "neither"}`,
      () =>
        environment(
          Effect.gen(function* () {
            const service = yield* ComputerAvailability.Service
            expect(yield* service.capabilities()).toEqual({ available: false, reason: "no_desktop_bridge" })
            expect(yield* service.unavailable()).toBe("desktop")
            expect(yield* service.actions()).toEqual([])
            expect(missing.calls).toHaveLength(0)
          }),
          values,
        ),
    )
  }

  for (const url of [
    "https://127.0.0.1:45100",
    "http://example.com:45100",
    "http://127.0.0.1:45100/path",
    "not-a-url",
  ]) {
    const invalid = fixture()
    invalid.it.instance(`a bearer token is never sent to an invalid desktop origin: ${url}`, () =>
      environment(
        Effect.gen(function* () {
          const service = yield* ComputerAvailability.Service
          expect((yield* service.capabilities()).available).toBe(false)
          expect(invalid.calls).toHaveLength(0)
        }),
        { url, token: "computer-test" },
      ),
    )
  }

  const wsl = fixture()
  const wslTest = process.platform === "linux" ? wsl.it.instance : wsl.it.instance.skip
  wslTest("a WSL engine without a bridge reports the Windows-engine requirement", () =>
    environment(
      Effect.gen(function* () {
        const service = yield* ComputerAvailability.Service
        expect(yield* service.unavailable()).toBe("wsl")
        expect(ComputerAvailability.message("wsl")).toContain("not inside WSL")
        expect(wsl.calls).toHaveLength(0)
      }),
      { wsl: "TestDistribution" },
    ),
  )

  for (const [name, body, expected] of [
    ["missing OS grants", { ...ready, available: false, reason: "permissions" }, undefined],
    ["company disabled", { ...ready, reason: "policy_disabled" }, "policy"],
    ["elevated", { ...ready, reason: "elevated" }, "elevated"],
    ["old macOS", { ...ready, backend: "local-macos", reason: "unsupported_os" }, "macos-version"],
    ["unsupported platform", { ...ready, reason: "unsupported_os" }, "platform"],
    ["missing helper", { ...ready, reason: "helper_missing" }, "desktop"],
    ["reserved remote backend", { ...ready, backend: "remote" }, "desktop"],
    ["no supported actions", { ...ready, actions: [] }, "desktop"],
    [
      "permissions but no supported actions",
      { ...ready, available: false, reason: "permissions", actions: [] },
      "desktop",
    ],
  ] as const) {
    const bridge = fixture(body)
    bridge.it.instance(`${name}: the tool and client capability agree`, () =>
      environment(
        Effect.gen(function* () {
          const service = yield* ComputerAvailability.Service
          expect(yield* service.unavailable()).toBe(expected)
          expect((yield* service.capabilities()).available).toBe(expected === undefined)
          expect(bridge.calls).toHaveLength(1)
        }),
      ),
    )
  }

  for (const [name, body, status] of [
    ["protocol mismatch", { ...ready, protocol: 2 }, 200],
    ["locked feature is never supported", { ...ready, features: { ...ready.features, locked: true } }, 200],
    ["missing route", {}, 404],
    ["protocol refusal", {}, 426],
  ] as const) {
    const invalid = fixture(body, status)
    invalid.it.instance(`${name} is unavailable and cached`, () =>
      environment(
        Effect.gen(function* () {
          const service = yield* ComputerAvailability.Service
          expect(yield* service.capabilities()).toEqual({ available: false, reason: "bridge_unavailable" })
          expect(yield* service.unavailable()).toBe("desktop")
          expect(invalid.calls).toHaveLength(1)
        }),
      ),
    )
  }

  const disabled = fixture(ready, 200, { computer: { enabled: false } })
  disabled.it.instance("managed company off withholds without probing", () =>
    environment(
      Effect.gen(function* () {
        const service = yield* ComputerAvailability.Service
        expect(yield* service.unavailable()).toBe("policy")
        expect(yield* service.capabilities()).toEqual({ available: false, reason: "policy" })
        expect(disabled.calls).toHaveLength(0)
      }),
    ),
  )

  const conversation = fixture(ready, 200, { tools: { computer: false } })
  conversation.it.instance("a conversation tool switch is reflected in client availability", () =>
    environment(
      Effect.gen(function* () {
        const service = yield* ComputerAvailability.Service
        expect(yield* service.unavailable()).toBe("disabled")
        expect(yield* service.capabilities()).toEqual({ available: false, reason: "disabled" })
        expect(ComputerAvailability.message("disabled")).toBe(`${Hands.NAME} is turned off for this conversation.`)
        expect(conversation.calls).toHaveLength(0)
      }),
    ),
  )

  const offline = fixture()
  offline.it.instance("Vector Local Web access None withholds without probing", () =>
    environment(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = Egress.policy()
          Egress.configure(LocalPolicy.resolve({ global: { enabled: true, web: "none" } }))
          return previous
        }),
        () =>
          Effect.gen(function* () {
            const service = yield* ComputerAvailability.Service
            expect(yield* service.unavailable()).toBe("offline")
            expect(yield* service.capabilities()).toEqual({ available: false, reason: "offline" })
            expect(yield* service.actions()).toEqual([])
            expect(offline.calls).toHaveLength(0)
          }),
        (previous) => Effect.sync(() => Egress.configure(previous)),
      ),
    ),
  )

  const labelled = fixture()
  labelled.it.instance("the cached capability probe records its local bridge source without credentials", () =>
    environment(
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const previous = Egress.policy()
          const events: ReturnType<typeof Egress.events> = []
          const unsubscribe = Egress.subscribe((event) => {
            if (event.source === "computer-bridge") events.push(event)
          })
          Egress.configure(LocalPolicy.resolve({ global: { enabled: true, web: "network" } }))
          return { previous, events, unsubscribe }
        }),
        ({ events }) =>
          Effect.gen(function* () {
            const service = yield* ComputerAvailability.Service
            expect((yield* service.capabilities()).available).toBe(true)
            expect(yield* service.actions()).toEqual(ready.actions)
            expect(labelled.calls).toHaveLength(1)
            expect(events).toMatchObject([
              {
                source: "computer-bridge",
                purpose: "integration",
                class: "this-computer",
                origin: "http://127.0.0.1:45100",
                method: "GET",
                decision: "allow",
              },
            ])
            expect(JSON.stringify(events)).not.toContain("computer-test")
            expect(JSON.stringify(events)).not.toContain("/computer/capabilities")
          }),
        ({ previous, unsubscribe }) =>
          Effect.sync(() => {
            unsubscribe()
            Egress.configure(previous)
          }),
      ),
    ),
  )
})

test("session gates preserve attended reader models and withhold unreviewed free models", () => {
  expect(ComputerAvailability.sessionReason({})).toBeUndefined()
  expect(ComputerAvailability.sessionReason({ freeModel: { dataPolicy: "no-training" } })).toBeUndefined()
  expect(ComputerAvailability.sessionReason({ parentID: "parent" })).toBe("unattended")
  expect(ComputerAvailability.sessionReason({ internal: "helper" })).toBe("unattended")
  expect(ComputerAvailability.sessionReason({ guest: true })).toBe("guest")
  expect(ComputerAvailability.sessionReason({ freeModel: { dataPolicy: "may-train" } })).toBe("may-train")
  expect(ComputerAvailability.sessionReason({ freeModel: {} })).toBe("may-train")
  expect(ComputerAvailability.message("desktop")).toContain(`${Hands.NAME} works in the Vector desktop app`)
  expect(ComputerAvailability.message("guest")).toBe("Only the owner of this computer can let Vector use it.")
})

test("the offered schema and decoder follow the bridge action list, including batches", () => {
  const schema = parameters(["read_ui", "hold_key"])
  const json = ToolJsonSchema.fromSchema(schema)
  expect(json.properties?.action).toMatchObject({ enum: ["read_ui", "hold_key"] })
  const decode = Schema.decodeUnknownSync(schema)
  expect(decode({ action: "read_ui" })).toEqual({ action: "read_ui" })
  expect(() => decode({ action: "click" })).toThrow()
  expect(() => decode({ action: "read_ui", actions: [{ action: "click" }] })).toThrow()
  expect(() => decode({ action: "hold_key", seconds: 11 })).toThrow()
})
