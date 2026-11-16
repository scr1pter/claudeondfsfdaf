export * as ComputerSendGate from "./send-gate"

import { resolveTemplate } from "@solid-primitives/i18n"
import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { dict } from "../../i18n/en"
import { ComputerOnboarding } from "./onboarding-model"

export type RefusalKey =
  | ComputerOnboarding.BlockedKey
  | Extract<
      keyof typeof dict,
      | "computer.mention.setupFirst"
      | "computer.mention.shell"
      | "computer.mention.command"
      | "computer.mention.quick"
      | "computer.mention.research"
      | "computer.availability.mayTrain"
      | "computer.availability.engine"
      | "computer.availability.disabled"
      | "computer.availability.localNone"
    >

export type Readiness = {
  ready: boolean
  /** The fixed sentence for what stops Hands; absent when only setup or enabling is missing. */
  blocked?: ComputerOnboarding.BlockedKey
  policy?: Computer.ComputerPolicy
}

/**
 * A computer-marked message the destination cannot carry. `setup` refusals can be fixed in onboarding; `engine`
 * refusals come from the engine that would receive the message; `local` ones need no more than their sentence.
 */
export class Refusal extends Error {
  constructor(
    readonly key: RefusalKey,
    readonly kind: "setup" | "engine" | "local",
  ) {
    super(resolveTemplate(dict[key], { name: Hands.NAME, mention: Hands.MENTION }))
    this.name = "ComputerSendGateRefusal"
  }
}

// Blockers onboarding itself can clear: a failed check can be retried there, and it opens Windows' capture setting.
const SETUP = new Set<RefusalKey>([
  "computer.onboarding.checkFailed",
  "computer.onboarding.windows.captureBlocked",
  "computer.inputSetup.required",
])

/** How long a readiness read or the engine's capability answer may take before the send fails closed. */
export const LIMIT = 5000

/**
 * A permission probe that rejects once `LIMIT` passes without an answer. On the desktop each probe asks the helper,
 * and a hung one would otherwise hold Settings and onboarding, with every change queued behind it.
 */
export function bounded<T>(probe: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The permission check did not answer")), LIMIT)
  })
  return Promise.race([probe, limit]).finally(() => clearTimeout(timer))
}

// The engine's client vocabulary (ComputerAvailability.capabilities); any other reason uses the engine sentence.
const ENGINE = new Map<string, RefusalKey>([
  ["policy", "computer.availability.company"],
  ["policy_disabled", "computer.availability.company"],
  ["disabled", "computer.availability.disabled"],
  ["offline", "computer.availability.localNone"],
  ["elevated", "computer.availability.elevated"],
])

/** Whether a prompt carries a computer pill, and so sends a mention marker. */
export function marked(prompt: readonly { type: string }[]) {
  return prompt.some((part) => part.type === "computer")
}

/**
 * Whether Hands is set up and on. Without `permissions` it reads only preferences, status and state, which never start
 * a helper probe, so the @ popover can read it as often as it opens. With it, it reads the permission view once more,
 * which on the desktop starts a fresh helper probe: only a send uses that.
 */
export async function readiness(
  computer: Computer.ComputerPlatform | undefined,
  options: { permissions?: boolean } = {},
): Promise<Readiness> {
  if (!computer) return { ready: false, blocked: "computer.availability.desktop" }
  if (!computer.supported) return { ready: false, blocked: "computer.status.linux" }
  // A read that never answers, such as a hung helper probe, fails closed rather than holding a send or the queue.
  const limit = AbortSignal.timeout(LIMIT)
  const read = await Promise.race([
    Promise.all([
      computer.prefs(),
      computer.status(),
      computer.state(),
      options.permissions ? computer.permissions() : undefined,
    ]),
    new Promise<undefined>((resolve) => limit.addEventListener("abort", () => resolve(undefined), { once: true })),
  ]).catch(() => undefined)
  if (!read) return { ready: false, blocked: "computer.onboarding.checkFailed" }
  const [settings, status, state, permissions] = read
  const view = { settings, status, backend: state.backend, permissions }
  const blocked = options.permissions
    ? (ComputerOnboarding.setupBlocked(view, true) ?? ComputerOnboarding.probeBlocked(permissions))
    : ComputerOnboarding.blocked(view, true)
  if (blocked) return { ready: false, blocked, policy: settings.policy }
  const enabled = settings.prefs.enabled === true
  return {
    ready: options.permissions
      ? enabled && ComputerOnboarding.canFinish(permissions, settings.prefs.consentedAt)
      : enabled && ComputerOnboarding.consented(settings.prefs.consentedAt) && status.available === true,
    policy: settings.policy,
  }
}

/**
 * The engine that would receive the message must report the computer capability at this app's protocol. A missing
 * field, a 404, an older engine or a failed request is unavailable, never implicit support.
 */
export async function engine(client: Pick<VectorClient, "experimental">): Promise<RefusalKey | undefined> {
  const result = await client.experimental.capabilities
    .get({}, { throwOnError: false, signal: AbortSignal.timeout(LIMIT) })
    .catch(() => undefined)
  const computer = result?.data?.computer
  if (computer?.available === true && (computer.protocol === undefined || computer.protocol === Computer.PROTOCOL))
    return
  return (computer?.available === false && ENGINE.get(computer.reason ?? "")) || "computer.availability.engine"
}

/**
 * Refuses a computer-marked message before it is cleared, queued or sent: local setup first, then the destination
 * engine. An unmarked message reads nothing.
 */
export async function check(input: {
  prompt: readonly { type: string }[]
  computer: Computer.ComputerPlatform | undefined
  client: Pick<VectorClient, "experimental">
}): Promise<Refusal | undefined> {
  if (!marked(input.prompt)) return
  const local = await readiness(input.computer, { permissions: true })
  if (!local.ready)
    return new Refusal(local.blocked ?? "computer.mention.setupFirst", needsSetup(local) ? "setup" : "local")
  const key = await engine(input.client)
  if (key) return new Refusal(key, "engine")
}

/**
 * Whether onboarding can make Hands ready: it is not set up, enabled or granted yet, a check failed, or Windows blocks
 * capture. Anything else (company off, administrator, macOS version, helper failure, no desktop) only has its sentence.
 */
export function needsSetup(readiness: Readiness) {
  return !readiness.ready && (!readiness.blocked || SETUP.has(readiness.blocked))
}
