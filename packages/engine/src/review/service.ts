// A trusted local adapter's one review entry. Target and read authority are fixed
// before the existing local pipeline runs; this does not create a second loop.

import { Effect } from "effect"
import { invocationProblems, type ReviewInvocation } from "@vectordevai/core/review/invocation"
import { reviewVerdict, type VerdictResult } from "@vectordevai/core/review/verdict"
import { SessionID } from "@/session/schema"
import type { LocalReviewDeps, LocalReviewResult } from "@/cli/cmd/review"

export type Input = ReviewInvocation & { stopSignal?: AbortSignal }
export interface Result extends LocalReviewResult {
  verdict: VerdictResult
}

export function execute<RunR, ModelR>(input: Input, deps: LocalReviewDeps<RunR, ModelR>) {
  return Effect.gen(function* () {
    const { stopSignal, ...invocation } = input
    const problems = invocationProblems(invocation)
    if (problems.length) {
      const refused: Result = {
        exitCode: 2 as const,
        error: `Invalid review invocation: ${problems.join(", ")}.`,
        verdict: reviewVerdict({ kind: "failure", stage: "config" }),
      }
      return refused
    }
    const { executeLocalReview } = yield* Effect.promise(() => import("@/cli/cmd/review"))
    const result: LocalReviewResult = yield* executeLocalReview(
      {
        directory: input.directory,
        ...(input.target.base ? { base: input.target.base } : {}),
        ...(input.target.kind === "working-tree" ? { uncommitted: true } : {}),
        ...(input.target.kind === "staged" ? { staged: true } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.maxCost ? { maxCost: input.maxCost } : {}),
        checks: false,
        post: false,
        full: true,
        json: true,
        context: {
          ...(input.parentID ? { parentID: SessionID.make(input.parentID) } : {}),
          expectedHead: input.target.head,
          settingsRef: input.settingsRef,
          stateless: true,
          ...(input.readDenies ? { readDenies: input.readDenies } : {}),
          ...(stopSignal ? { stopSignal } : {}),
        },
      },
      deps,
    )
    const completed: Result = {
      ...result,
      verdict: result.outcome
        ? reviewVerdict({ kind: "outcome", outcome: result.outcome })
        : reviewVerdict({ kind: "failure", stage: result.error ? "review" : "start" }),
    }
    return completed
  })
}

export * as ReviewService from "./service"
