export * as ConnectReviewPrompt from "./review-prompt"

import { Context, Effect } from "effect"
// Types only at the top: the prompt loop's module is loaded lazily in `service`, after the review modules that already
// load it, so connect never closes the cycle registry → connect tool → hub → adapter → review run → prompt → registry.
import type { SessionPrompt } from "@/session/prompt"
import type { ConnectAdapter } from "./adapter"

// The prompt loop as VectorScope's review sees it when connect runs it. `Review.run` needs a SessionPrompt service,
// and uses only `prompt` and `cancel`. Connect gives it one built from the hub's helper handle, so every prompt goes
// through the handle's checks: only the run's own hidden reviewer sessions, only as VectorScope's own agents, and only
// while the run is going. Every other member dies with a plain message, so a later change to the review that reaches
// for more of the loop fails loudly instead of getting around the handle. This bridge goes away when VectorScope's own
// review service lands (VS-08, CW-20).

/** The only members the bridge passes on. */
export const ALLOWED = ["prompt", "cancel"] as const

/** The message a member outside `ALLOWED` dies with. */
export function refusedMessage(member: string) {
  return `Connect runs VectorScope's review with only the prompt loop's prompt and cancel; ${member} is not available to it.`
}

/** The SessionPrompt shape built from a helper handle: `prompt` and `cancel` go through it, and nothing else works. */
export function bridge(helper: ConnectAdapter.HelperHandle): SessionPrompt.Interface {
  const refuse = (member: string) => () => Effect.die(new Error(refusedMessage(member)))
  return {
    prompt: (input, options) =>
      // Prompt options change how the loop treats the prompt (free-model rules and the like); the review sets none,
      // and nothing about a reviewer session may be widened through them.
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

/** The bridge as the SessionPrompt service, ready to provide to `Review.run`. */
export const service = (helper: ConnectAdapter.HelperHandle) =>
  Effect.promise(() => import("@/session/prompt")).pipe(
    Effect.map(({ SessionPrompt }) => Context.make(SessionPrompt.Service, SessionPrompt.Service.of(bridge(helper)))),
  )
