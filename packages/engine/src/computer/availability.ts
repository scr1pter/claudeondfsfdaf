import os from "node:os"
import { Context, Duration, Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"

export type Reason =
  | "desktop"
  | "platform"
  | "macos-version"
  | "policy"
  | "offline"
  | "guest"
  | "wsl"
  | "elevated"
  | "may-train"
  | "unattended"
  | "disabled"

const MESSAGES: Record<Reason, string> = {
  desktop: `${Hands.NAME} works in the Vector desktop app on macOS and Windows, where it can see and use your apps. Open this conversation there to continue.`,
  platform: "Not available on Linux yet",
  "macos-version": `${Hands.NAME} needs macOS 14 or later.`,
  policy: `Your company turned off ${Hands.NAME}.`,
  offline: `Vector Local's Web access is None, and apps ${Hands.NAME} uses could reach the network without Vector seeing it, so ${Hands.NAME} is off. Change Web access in Vector Local to use it.`,
  guest: "Only the owner of this computer can let Vector use it.",
  wsl: `${Hands.NAME} needs Vector's engine to run on Windows, not inside WSL.`,
  elevated: `Vector is running as administrator, so ${Hands.NAME} is off. Restart Vector normally to use it.`,
  "may-train": `${Hands.NAME} can't send your screen to a model that may train on it.`,
  unattended: `${Hands.NAME} is only available in a conversation you're in.`,
  disabled: `${Hands.NAME} is turned off for this conversation.`,
}

export function message(reason: Reason) {
  return MESSAGES[reason]
}

export function sessionReason(input: {
  parentID?: string
  internal?: string
  guest?: boolean
  freeModel?: { dataPolicy?: string }
}): Reason | undefined {
  if (input.parentID || input.internal) return "unattended"
  if (input.guest) return "guest"
  if (input.freeModel && input.freeModel.dataPolicy !== "no-training") return "may-train"
  return undefined
}

export type ClientCapabilities = { available: boolean; protocol?: number; reason?: string }

export interface Interface {
  readonly unavailable: () => Effect.Effect<Reason | undefined>
  readonly capabilities: () => Effect.Effect<ClientCapabilities>
  readonly actions: () => Effect.Effect<readonly Computer.ToolAction[]>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ComputerAvailability") {}
export const use = serviceUse(Service)

type Probe = { capabilities?: Computer.Capabilities; reason?: string }

function bridgeReason(value: Computer.Capabilities): Reason | undefined {
  if (value.backend === "remote") return "desktop"
  if (value.reason === "policy_disabled") return "policy"
  if (value.reason === "elevated") return "elevated"
  if (value.reason === "unsupported_os") return value.backend === "local-macos" ? "macos-version" : "platform"
  if (value.reason && value.reason !== "permissions") return "desktop"
  if (value.actions.length === 0) return "desktop"
  // The tool must be present for the first lease to open OS permission onboarding.
  return value.available || value.reason === "permissions" ? undefined : "desktop"
}

// Only the desktop's dedicated loopback origin receives its bearer token. Remote backends are reserved.
function endpoint() {
  const url = process.env[Computer.BRIDGE.urlEnv]
  const token = process.env[Computer.BRIDGE.tokenEnv]
  if (!url || !token) return undefined
  const parsed = URL.parse(url)
  if (
    !parsed ||
    parsed.protocol !== "http:" ||
    parsed.hostname !== Computer.BRIDGE.host ||
    !parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  )
    return undefined
  return { url: `${parsed.origin}${Computer.BRIDGE.capabilitiesPath}`, token }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const flags = yield* RuntimeFlags.Service
    const http = yield* HttpClient.HttpClient
    const client = HttpClient.filterStatusOk(http)
    const state = yield* InstanceState.make(
      Effect.fnUntraced(function* () {
        const bridge = endpoint()
        const host: Reason =
          process.platform === "linux" && (process.env.WSL_DISTRO_NAME || /microsoft/i.test(os.release()))
            ? "wsl"
            : flags.client === "desktop" && process.platform === "darwin" && Number(os.release().split(".")[0]) < 23
              ? "macos-version"
              : flags.client === "desktop" && process.platform === "linux"
                ? "platform"
                : "desktop"
        const probe = yield* Effect.cachedWithTTL(
          bridge
            ? Effect.gen(function* () {
                const decision = Egress.decide({ source: "computer-bridge", url: bridge.url, method: "GET" })
                if (decision.decision !== "allow") return { reason: "bridge_unavailable" } satisfies Probe
                return yield* client
                  .execute(
                    HttpClientRequest.get(bridge.url).pipe(
                      HttpClientRequest.setHeaders({
                        authorization: `Bearer ${bridge.token}`,
                        [Computer.BRIDGE.protocolHeader]: String(Computer.PROTOCOL),
                      }),
                    ),
                  )
                  .pipe(
                    Effect.flatMap(HttpClientResponse.schemaBodyJson(Computer.Capabilities)),
                    Effect.map((capabilities): Probe => ({ capabilities })),
                  )
              }).pipe(
                Effect.timeout("5 seconds"),
                Effect.catch(() => Effect.succeed<Probe>({ reason: "bridge_unavailable" })),
              )
            : Effect.succeed<Probe>({ reason: "no_desktop_bridge" }),
          Duration.seconds(30),
        )
        return { probe, host }
      }),
    )

    const policy = Effect.fn("ComputerAvailability.policy")(function* (): Effect.fn.Return<Reason | undefined> {
      const settings = yield* config.get()
      if (settings.computer?.enabled === false) return "policy"
      if (settings.tools?.computer === false) return "disabled"
      const local = Egress.policy()
      if (local.enabled && local.web === "none") return "offline"
      return undefined
    })

    const unavailable = Effect.fn("ComputerAvailability.unavailable")(function* () {
      const restricted = yield* policy()
      if (restricted) return restricted
      const current = yield* InstanceState.get(state)
      const result = yield* current.probe
      const value = result.capabilities
      if (!value) return current.host
      return bridgeReason(value)
    })

    const capabilities = Effect.fn("ComputerAvailability.capabilities")(function* () {
      const restricted = yield* policy()
      if (restricted) return { available: false, reason: restricted }
      const current = yield* InstanceState.get(state)
      const result = yield* current.probe
      const value = result.capabilities
      if (!value) return { available: false, reason: result.reason }
      if (value.backend === "remote")
        return { available: false, protocol: value.protocol, reason: "remote_unavailable" }
      return {
        available: bridgeReason(value) === undefined,
        protocol: value.protocol,
        ...(value.reason ? { reason: value.reason } : {}),
      }
    })

    const actions = Effect.fn("ComputerAvailability.actions")(function* () {
      if (yield* policy()) return []
      const current = yield* InstanceState.get(state)
      return (yield* current.probe).capabilities?.actions ?? []
    })

    return Service.of({ unavailable, capabilities, actions })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Config.node, RuntimeFlags.node, httpClient] })

export * as ComputerAvailability from "./availability"
