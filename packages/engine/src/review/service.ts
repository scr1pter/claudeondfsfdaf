// A trusted local adapter's one review entry. Target and read authority are fixed
// before the existing local pipeline runs; this does not create a second loop.

import { Effect } from "effect"
import type { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import { invocationProblems, type ReviewInvocation } from "@vectordevai/core/review/invocation"
import { reviewVerdict, type VerdictResult } from "@vectordevai/core/review/verdict"
import { SessionID } from "@/session/schema"
import type { LocalReviewDeps, LocalReviewResult } from "@/cli/cmd/review"
import { readAuthority } from "./read-authority"
import { ReviewGit } from "./git"

export type Input = ReviewInvocation & { stopSignal?: AbortSignal }
// Trusted adapter options are separate from the strict serialized invocation.
// Omitting cache preserves the service's stateless behavior.
export interface Options {
  security?: boolean
  maxComments?: number
  environment?: Readonly<Record<string, string | undefined>>
  cache?: { full: boolean }
}

export function environment(input: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(input).filter(([name]) => name === "MODEL" || /^REVIEW_[A-Z0-9_]+$/.test(name)),
  )
}

function optionProblems(options: Options): string[] {
  if (!options || typeof options !== "object" || Array.isArray(options)) return ["options"]
  const problems = Object.keys(options).filter(
    (key) => !["security", "maxComments", "environment", "cache"].includes(key),
  )
  if (options.security !== undefined && typeof options.security !== "boolean") problems.push("security")
  if (
    options.maxComments !== undefined &&
    (!Number.isInteger(options.maxComments) || options.maxComments < 0 || options.maxComments > 50)
  )
    problems.push("maxComments")
  if (
    options.cache !== undefined &&
    (!options.cache ||
      typeof options.cache !== "object" ||
      Array.isArray(options.cache) ||
      typeof options.cache.full !== "boolean" ||
      Object.keys(options.cache).some((key) => key !== "full"))
  )
    problems.push("cache")
  if (
    options.environment !== undefined &&
    (!options.environment ||
      typeof options.environment !== "object" ||
      Array.isArray(options.environment) ||
      Object.entries(options.environment).some(
        ([key, value]) =>
          (key !== "MODEL" && !/^REVIEW_[A-Z0-9_]+$/.test(key)) || (value !== undefined && typeof value !== "string"),
      ))
  )
    problems.push("environment")
  return problems
}

export interface Result extends LocalReviewResult {
  verdict: VerdictResult
}

export function execute<RunR, ModelR>(
  input: Input,
  deps: LocalReviewDeps<RunR, ModelR>,
  placement?: ReadOnlyGit.Metadata,
  options: Options = {},
) {
  return Effect.gen(function* () {
    const { stopSignal, ...invocation } = input
    const problems = [...invocationProblems(invocation), ...optionProblems(options)]
    if (problems.length) {
      const refused: Result = {
        exitCode: 2 as const,
        error: `Invalid review invocation: ${problems.join(", ")}.`,
        verdict: reviewVerdict({ kind: "failure", stage: "config" }),
      }
      return refused
    }
    const scoped: Options = {
      ...(options.security === undefined ? {} : { security: options.security }),
      ...(options.maxComments === undefined ? {} : { maxComments: options.maxComments }),
      ...(options.environment ? { environment: { ...options.environment } } : {}),
      ...(options.cache ? { cache: { ...options.cache } } : {}),
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
    const worktree = placement?.directory ?? (yield* ReviewGit.root(request.directory))
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
    const bound = placement ?? (yield* ReviewGit.metadata(worktree))
    const { executeLocalReview } = yield* Effect.promise(() => import("@/cli/cmd/review"))
    const result: LocalReviewResult = yield* ReviewGit.within(
      bound,
      request.target.head,
      Effect.suspend(() =>
        stopSignal?.aborted
          ? Effect.succeed<LocalReviewResult>({ exitCode: 2, error: "The review was cancelled before it started." })
          : executeLocalReview(
              {
                directory: request.directory,
                ...(request.target.base ? { base: request.target.base } : {}),
                ...(request.target.kind === "working-tree" ? { uncommitted: true } : {}),
                ...(request.target.kind === "staged" ? { staged: true } : {}),
                ...(request.model ? { model: request.model } : {}),
                ...(request.maxCost ? { maxCost: request.maxCost } : {}),
                checks: false,
                post: false,
                full: scoped.cache?.full ?? true,
                ...(scoped.security === undefined ? {} : { security: scoped.security }),
                ...(scoped.maxComments === undefined ? {} : { maxComments: scoped.maxComments }),
                ...(scoped.environment ? { env: scoped.environment } : {}),
                json: true,
                context: {
                  ...(request.parentID ? { parentID: SessionID.make(request.parentID) } : {}),
                  expectedHead: request.target.head,
                  settingsRef: request.settingsRef,
                  stateless: scoped.cache === undefined,
                  identity: "vectorscope",
                  ...(request.readDenies ? { readDenies: request.readDenies } : {}),
                  ...(readRoot ? { readRoot } : {}),
                  ...(admittedReads ? { admittedReads } : {}),
                  ...(stopSignal ? { stopSignal } : {}),
                },
              },
              deps,
            ),
      ),
    )
    const completed: Result = {
      ...result,
      verdict: result.outcome
        ? reviewVerdict({ kind: "outcome", outcome: result.outcome })
        : reviewVerdict({ kind: "failure", stage: result.error ? "review" : "start" }),
    }
    return completed
  }).pipe(
    Effect.catchTag("ReviewGit.Refused", (error) =>
      Effect.succeed<Result>({
        exitCode: 2,
        error: error.message,
        verdict: reviewVerdict({ kind: "failure", stage: "config" }),
      }),
    ),
  )
}

export * as ReviewService from "./service"
