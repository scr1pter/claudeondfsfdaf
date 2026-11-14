export * as ConnectReviewService from "./review-service"

import path from "node:path"
import { Context, Effect } from "effect"
import { Connect } from "@vectordevai/schema/connect"
import { readAuthority } from "@/review/read-authority"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import type { SessionPrompt } from "@/session/prompt"
import type { ConnectAdapter } from "./adapter"

const qualified = Symbol("Connect qualified VectorScope service")
export interface Capability {
  readonly [qualified]: true
}

interface Admission {
  readonly helper: ConnectAdapter.HelperHandle
  readonly active: () => boolean
  readonly readRoot: string
  readonly readDenies: readonly string[]
}
const admissions = new WeakMap<Capability, Admission>()

// Only the hub calls this, after its existing read preflight and inside a
// placed Task's verified callback. Neither request JSON nor a copied handle
// can supply service identity or replace the frozen read authority.
export function qualify(input: {
  readonly helper: ConnectAdapter.HelperHandle
  readonly active: () => boolean
  readonly readRoot: string
  readonly readDenies: readonly string[]
}): Capability {
  const valid =
    path.isAbsolute(input.readRoot) &&
    !input.readRoot.includes("\0") &&
    input.readDenies.length < 1_000 &&
    input.readDenies.every((pattern) => !!pattern && pattern.length <= 4_096 && !pattern.includes("\0"))
  const authority = readAuthority(valid ? [...input.readDenies, path.join(TRUNCATION_DIR, "*")] : ["*"], {
    directory: input.readRoot,
    worktree: input.readRoot,
    readRoot: input.readRoot,
  })
  const capability = Object.freeze({ [qualified]: true as const })
  admissions.set(
    capability,
    Object.freeze({
      helper: input.helper,
      active: () => valid && input.active(),
      readRoot: input.readRoot,
      readDenies: Object.freeze([...authority.absolute]),
    }),
  )
  return capability
}

const admission = (capability: Capability) =>
  Effect.suspend(() => {
    const found = admissions.get(capability)
    return found && found.active()
      ? Effect.succeed(found)
      : Effect.fail(
          new Connect.Refusal({ code: "unavailable", message: "The qualified VectorScope service is unavailable." }),
        )
  })

export const scope = (capability: Capability) =>
  admission(capability).pipe(Effect.map(({ readRoot, readDenies }) => ({ readRoot, readDenies })))

export const ALLOWED = ["prompt", "cancel"] as const
export function refusedMessage(member: string) {
  return `Connect runs VectorScope's review with only the prompt loop's prompt and cancel; ${member} is not available to it.`
}

// ReviewService owns invocation and collection; its existing runner still
// consumes SessionPrompt. Supply only the hub's qualified helper calls, never
// the ambient prompt service or additional prompt options.
export function bridge(helper: ConnectAdapter.HelperHandle): SessionPrompt.Interface {
  const refuse = (member: string) => () => Effect.die(new Error(refusedMessage(member)))
  return {
    prompt: (input, options) =>
      options === undefined ? helper.prompt(input) : Effect.die(new Error(refusedMessage("prompt options"))),
    cancel: (sessionID) => helper.cancel(sessionID),
    currentModel: refuse("currentModel"),
    awaitTitles: refuse("awaitTitles"),
    loop: refuse("loop"),
    resumeFreeModels: refuse("resumeFreeModels"),
    shell: refuse("shell"),
    command: refuse("command"),
    resolvePromptParts: refuse("resolvePromptParts"),
    admit: refuse("admit"),
  }
}

export const service = (
  capability: Capability,
  check: (input: SessionPrompt.PromptInput) => Effect.Effect<void, Connect.Refusal>,
) =>
  Effect.gen(function* () {
    const found = yield* admission(capability)
    const { SessionPrompt } = yield* Effect.promise(() => import("@/session/prompt"))
    return Context.make(
      SessionPrompt.Service,
      SessionPrompt.Service.of(
        bridge({
          prompt: (input) =>
            admission(capability).pipe(
              Effect.flatMap(() => check(input)),
              Effect.orDie,
              Effect.flatMap(() => found.helper.prompt(input)),
            ),
          cancel: (sessionID) => found.helper.cancel(sessionID),
        }),
      ),
    )
  })
