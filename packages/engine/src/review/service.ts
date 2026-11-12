// A trusted local adapter's one review entry. Target and read authority are fixed
// before the existing local pipeline runs; this does not create a second loop.

import { Effect } from "effect"
import path from "node:path"
import { invocationProblems, type ReviewInvocation } from "@vectordevai/core/review/invocation"
import { reviewVerdict, type VerdictResult } from "@vectordevai/core/review/verdict"
import { SessionID } from "@/session/schema"
import { Git } from "@/git"
import type { LocalReviewDeps, LocalReviewResult } from "@/cli/cmd/review"
import { readAuthority } from "./read-authority"

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
    // Callers may retain their objects while model setup yields. Keep the admitted
    // target and restrictive read authority fixed for the whole invocation.
    const request: ReviewInvocation = {
      ...invocation,
      target: { ...invocation.target },
      ...(invocation.readDenies ? { readDenies: [...invocation.readDenies] } : {}),
    }
    if (stopSignal?.aborted) {
      const stopped: Result = {
        exitCode: 2,
        error: "The review was cancelled before it started.",
        verdict: reviewVerdict({ kind: "failure", stage: "start" }),
      }
      return stopped
    }
    // Relative read resources name the tool worktree, even when the requested
    // directory is nested inside it. Resolve that trusted placement before
    // admitting canonical facts; a missing placement never guesses an origin.
    const git = yield* Git.Service
    const placement = request.readDenies?.length
      ? yield* git.run(["rev-parse", "--show-toplevel"], { cwd: request.directory })
      : undefined
    const worktree = placement?.text().trim()
    if (placement && (placement.exitCode !== 0 || !worktree || !path.isAbsolute(worktree))) {
      const refused: Result = {
        exitCode: 2,
        error: "Cannot resolve the review worktree for read authority.",
        verdict: reviewVerdict({ kind: "failure", stage: "config" }),
      }
      return refused
    }
    const readRoot = request.readRoot ?? worktree
    // Later adapter/model setup may add aliases, but cannot replace these paths.
    const admittedReads =
      worktree && request.readDenies?.length
        ? readAuthority(request.readDenies, {
            directory: worktree,
            worktree,
            ...(readRoot ? { readRoot } : {}),
          })
        : undefined
    const { executeLocalReview } = yield* Effect.promise(() => import("@/cli/cmd/review"))
    const result: LocalReviewResult = yield* executeLocalReview(
      {
        directory: request.directory,
        ...(request.target.base ? { base: request.target.base } : {}),
        ...(request.target.kind === "working-tree" ? { uncommitted: true } : {}),
        ...(request.target.kind === "staged" ? { staged: true } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(request.maxCost ? { maxCost: request.maxCost } : {}),
        checks: false,
        post: false,
        full: true,
        json: true,
        context: {
          ...(request.parentID ? { parentID: SessionID.make(request.parentID) } : {}),
          expectedHead: request.target.head,
          settingsRef: request.settingsRef,
          stateless: true,
          identity: "vectorscope",
          ...(request.readDenies ? { readDenies: request.readDenies } : {}),
          ...(readRoot ? { readRoot } : {}),
          ...(admittedReads ? { admittedReads } : {}),
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
