import path from "node:path"
import { Effect, Option, Schema } from "effect"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Wildcard } from "@vectordevai/core/util/wildcard"
import type { PermissionV1 } from "@vectordevai/core/v1/permission"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { Git } from "@/git"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import { readAuthority } from "./read-authority"
import type { ReviewService } from "./service"

export class Refused extends Schema.TaggedErrorClass<Refused>()("ReviewLocalAdmission.Refused", {
  code: Schema.Literals(["invalid", "placement", "permissions", "stale"]),
  message: Schema.String,
}) {}

// Only an authenticated server adapter constructs this from the requester's
// session and its actual tool placement. It is never decoded from a request.
export interface Source {
  sessionID: string
  directory: string
  worktree: string
  permission: readonly PermissionV1.Rule[]
}

export interface Admitted {
  request: ReviewRun.Start
  invocation: ReviewService.Input
}

export const prepare = Effect.fn("ReviewLocalAdmission.prepare")(function* (input: unknown, source: Source) {
  const decoded = Schema.decodeUnknownOption(ReviewRun.Start, { onExcessProperty: "error" })(input)
  if (Option.isNone(decoded)) return yield* new Refused({ code: "invalid", message: "Invalid local review request." })
  const request: ReviewRun.Start = {
    ...decoded.value,
    target: { ...decoded.value.target },
  }
  if (
    !source.sessionID ||
    source.sessionID.includes("\0") ||
    !path.isAbsolute(source.directory) ||
    !path.isAbsolute(source.worktree) ||
    source.directory.includes("\0") ||
    source.worktree.includes("\0") ||
    path.parse(source.worktree).root === source.worktree
  )
    return yield* new Refused({ code: "placement", message: "A local Git worktree is required for this review." })

  const directory = path.resolve(source.directory)
  const worktree = path.resolve(source.worktree)
  const sessionID = source.sessionID
  const root = FSUtil.realpath(worktree)
  if (!FSUtil.contains(root, FSUtil.realpath(directory)))
    return yield* new Refused({ code: "placement", message: "The conversation is outside its review worktree." })
  // The caller's rules precede the helper's blanket read allow. Until a scoped
  // approval handshake exists, withhold asks as well as denies. This deliberately
  // preserves restrictive matches even if another caller rule allows an alias.
  const restrictive = source.permission.filter((rule) => rule.action !== "allow")
  if (restrictive.some((rule) => ["grep", "glob", "list"].some((tool) => Wildcard.match(tool, rule.permission))))
    return yield* new Refused({
      code: "permissions",
      message: "This conversation's search restrictions cannot be preserved by the local review adapter.",
    })
  const denies = restrictive.filter((rule) => Wildcard.match("read", rule.permission)).map((rule) => rule.pattern)
  if (denies.length > 999 || denies.some((pattern) => !pattern || pattern.length > 4096 || pattern.includes("\0")))
    return yield* new Refused({ code: "permissions", message: "The conversation's read restrictions are invalid." })

  // Freeze canonical facts before the first asynchronous Git/model operation.
  // Retain both the original name and its admitted symlink destination when the
  // service later projects these paths into its helper worktree. Reviews have
  // no authority over unrelated saved output from the owner's other sessions.
  const authority = readAuthority([...denies, path.join(TRUNCATION_DIR, "*")], {
    directory: worktree,
    worktree,
    readRoot: worktree,
  })
  if (authority.absolute.length > 1000)
    return yield* new Refused({ code: "permissions", message: "The conversation has too many read restrictions." })
  const git = yield* Git.Service
  const placement = yield* git.run(["rev-parse", "--show-toplevel"], { cwd: directory })
  if (
    placement.exitCode !== 0 ||
    !placement.text().trim() ||
    FSUtil.realpath(placement.text().trim()) !== root ||
    FSUtil.realpath(worktree) !== root
  )
    return yield* new Refused({ code: "placement", message: "The conversation's Git worktree changed." })
  const head = yield* git.run(["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"], {
    cwd: directory,
  })
  if (head.exitCode !== 0 || head.text().trim() !== request.target.head)
    return yield* new Refused({ code: "stale", message: "The review head changed. Start a new review." })

  const invocation: ReviewService.Input = {
    version: 1,
    mode: "review",
    directory,
    target: request.target,
    settingsRef: request.target.head,
    parentID: sessionID,
    readRoot: worktree,
    readDenies: authority.absolute,
    ...(request.maxCost === undefined ? {} : { maxCost: request.maxCost }),
  }
  return { request, invocation } satisfies Admitted
})

export * as ReviewLocalAdmission from "./local-admission"
