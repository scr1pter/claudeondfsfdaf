import { Effect } from "effect"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { ModelPlans } from "@vectordevai/core/model-plans"
import type { ReviewOutcome } from "@vectordevai/core/review/types"
import { SessionRetry } from "@/session/retry"
import { CliError } from "../effect-cmd"
import { GithubBundle } from "./github.bundle"
import { gatewayRule, runDeadline } from "./github.agent"
import type { Services } from "./github.cloud"
import { withRunHeartbeat } from "./github.lifecycle"
import { GithubSecrets } from "./github.secrets"

export interface CodiumReviewControl {
  signal: AbortSignal
  stopped: () => GithubBundle.Stop | undefined
  /** A completed provider step ends any association with an earlier retried gateway refusal. */
  stepFinished: () => void
  /** Apply the terminal gateway row only after the runner confirms that no model result recovered it. */
  reviewFinished: (outcome: Pick<ReviewOutcome, "partial" | "specialists">) => void
  redact: (text: string) => string
  outcome: (value: GithubAgents.Outcome) => void
}

/** The runner's output can include a provider error; public Codium output never repeats billing state or prices. */
export function redactCodiumReviewText(text: string) {
  return text
    .replace(/\bvector-(?:10|50|100|200)\b/gi, "Codium")
    .replace(/\b(?:Plus|Pro|Max|Ultra) plan\b/gi, "Codium")
    .replace(/\b(?:payment(?:_failed)?|dispute|fraud|past_due|closing)\b/gi, "[withheld]")
    .replace(/\b\d+(?:\.\d+)?\s*%/g, "[withheld]")
    .replace(/[$€£]\s*\d[\d,.]*/g, "[withheld]")
}

/** Own-key callers do not enter this scope. The starting heartbeat/account gate has already authorized the holder. */
export function withCodiumReview<A, E, R>(
  use: (control: CodiumReviewControl) => Effect.Effect<A, E, R>,
  input: {
    env: Readonly<Record<string, string | undefined>>
    credentials?: Pick<typeof GithubSecrets.credentials, "runToken" | "redact">
    services?: Services
    now?: () => number
    intervalMs?: number
  },
): Effect.Effect<A | void, E | CliError, R> {
  return Effect.suspend((): Effect.Effect<A | void, E | CliError, R> => {
    const credentials = input.credentials ?? GithubSecrets.credentials
    const now = input.now ?? Date.now
    const deadline = runDeadline(input.env.VECTOR_RUN_DEADLINE, now())
    if (!credentials.runToken() || deadline === undefined)
      return Effect.fail(new CliError({ message: GithubSecrets.CODIUM_UNAUTHORIZED, exitCode: 1 }))
    const controller = new AbortController()
    const state = {
      stop: undefined as GithubBundle.Stop | undefined,
      pending: undefined as GithubBundle.Stop | undefined,
      outcome: "failed" as GithubAgents.Outcome,
    }
    const halt = (reason: GithubBundle.Stop) => {
      state.stop ??= reason
      controller.abort(state.stop)
    }
    const rule = gatewayRule({ now })
    const retry: SessionRetry.GatewayRule = {
      ...rule,
      classify: (error, provider) => {
        const decision = rule.classify(error, provider)
        if (provider === ModelPlans.PROVIDER_ID) {
          const reason = GithubBundle.stopReason(error, { codium: true })
          if (decision === "stop") halt(reason)
          // BUSY/RENEWING follow ordinary bounded retries, while concurrency has its own window. An observed
          // refusal is not yet a stop: a later successful step must be able to recover it without a false label.
          else state.pending = reason
        }
        return decision
      },
    }
    const left = deadline - GithubAgents.STOP_MARGIN_SECONDS * 1000 - now()
    const control: CodiumReviewControl = {
      signal: controller.signal,
      stopped: () => state.stop,
      stepFinished: () => {
        state.pending = undefined
      },
      reviewFinished: (outcome) => {
        const reviewers = outcome.specialists.filter((entry) => entry.name !== "verify")
        if (
          outcome.partial === "model-error" ||
          (reviewers.length > 0 && reviewers.every((entry) => entry.status === "failed"))
        )
          halt(state.pending ?? GithubBundle.stopReason(undefined, { codium: true }))
        state.pending = undefined
      },
      redact: (text) => redactCodiumReviewText(credentials.redact(text)),
      outcome: (value) => (state.outcome = value),
    }
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        SessionRetry.pinGateway(retry)
        if (left <= 0) {
          halt(GithubBundle.DEADLINE)
          return undefined
        }
        return setTimeout(() => halt(GithubBundle.DEADLINE), left)
      }),
      () =>
        withRunHeartbeat(use(control), {
          credentials,
          services: input.services,
          intervalMs: input.intervalMs,
          onStop: () => halt(GithubBundle.DEADLINE),
          outcome: () => state.outcome,
        }),
      (timer) =>
        Effect.sync(() => {
          if (timer !== undefined) clearTimeout(timer)
          SessionRetry.pinGateway(undefined)
        }),
    )
  })
}
