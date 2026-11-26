import { Effect, Option } from "effect"
import type { DiffFile } from "@vectordevai/core/review/diff"
import type { DepthPlan } from "@vectordevai/core/review/plan"
import { countHistory, type RiskAssessment, type RiskHistory } from "@vectordevai/core/review/risk"
import type { ReviewOutcome } from "@vectordevai/core/review/types"
import { ReviewSnapshot } from "./private-snapshot"

export * as ReviewDepth from "./depth"

// Match the history gatherer's five commits per file and ten files. A shallow, unavailable, malformed,
// timed-out or oversized read supplies no history, never a fabricated zero. History has zero band weight.
export function history(
  input: ReviewSnapshot.Placement & { base: string },
  files: readonly DiffFile[],
  deadline: number,
) {
  const selected = files
    .filter((file) => file.status !== "added" && !file.binary)
    .toSorted((a, b) => b.additions + b.deletions - a.additions - a.deletions || a.path.localeCompare(b.path))
    .slice(0, 10)
  if (!selected.length) return Effect.succeed(undefined)
  const now = Date.now()
  const since = Math.floor(now / 1000) - 90 * 24 * 60 * 60
  return ReviewSnapshot.within<RiskHistory | undefined>(
    input,
    performance.now() + Math.min(4000, deadline - now),
    (view, signal) =>
      Effect.gen(function* () {
        if (view.repository.shallow) return
        const subjects = new Map<string, string>()
        for (const file of selected) {
          const observed = yield* Effect.tryPromise(() =>
            view.repository.read(
              {
                kind: "depth-history",
                revision: input.base,
                file: file.oldPath ?? file.path,
              },
              signal,
            ),
          ).pipe(Effect.option)
          if (Option.isNone(observed)) return
          const result = observed.value
          if (result.code !== 0 || result.bytes.length > 64 * 1024) return
          const fields = result.bytes.toString("utf8").split("\0")
          if (fields.pop() !== "" || fields.length % 3 !== 0 || fields.length > 15) return
          for (let i = 0; i < fields.length; i += 3) {
            const id = fields[i]!
            const time = fields[i + 1]!
            if (!/^[0-9a-f]{40}$/.test(id) || !/^\d{1,12}$/.test(time)) return
            if (Number(time) >= since && Number(time) <= Math.floor(now / 1000)) subjects.set(id, fields[i + 2]!)
          }
        }
        return countHistory([...subjects.values()])
      }),
    () => undefined,
  )
}

export function notes(
  auto: { risk: RiskAssessment; plan: DepthPlan; partialReach: boolean },
  actual: ReviewOutcome["specialists"],
): string[] {
  const { risk, plan } = auto
  const incomplete = plan.specialists.filter(
    (name) => !actual.some((pass) => pass.name === name && pass.status === "ok"),
  )
  return [
    `Automatic review depth: ${plan.effective}. Planned passes: ${plan.specialists.join(", ")}. Each pass uses the existing review time and cost limits.`,
    ...risk.reasons,
    ...(auto.partialReach ? ["The impact search was incomplete. Its dependent count is a lower bound."] : []),
    ...(!risk.missing.includes("churn")
      ? ["History covers up to five base commits per file, across at most ten changed files in the last 90 days."]
      : []),
    ...(risk.missing.length
      ? [
          `Unavailable depth inputs: ${[...(risk.missing.includes("churn") ? ["history"] : []), ...(risk.missing.includes("dependents") ? ["impact dependents"] : [])].join(" and ")}.`,
        ]
      : []),
    ...(plan.limited.includes("security-off")
      ? ["The requested automatic depth could not run its security pass because security is disabled."]
      : []),
    ...(incomplete.length ? [`Automatic depth did not finish these planned passes: ${incomplete.join(", ")}.`] : []),
  ]
}
