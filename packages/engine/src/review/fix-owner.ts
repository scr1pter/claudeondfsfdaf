export * as ReviewFixOwner from "./fix-owner"

// VS-12d (SF-10a): the owner fix API's trusted adapter for the consented fix executor (review/fix.ts). The owner's
// client sends a patch for the conversation's checked-out branch; the engine places it in a fix checkout detached at
// that branch's exact head and shows the preview. Each later step (apply, checks, commit, push) is offered on its own:
// the engine builds the exact operation, shows it with an approval offer bound to the authenticated owner, the head,
// the patch digest, the operation (and a commit's identity) and a five-minute expiry, and only an execute that echoes
// that offer approves and runs it, once. The executor re-verifies everything before each effect.
//
// The patch and its finding references come from the client, and the engine verifies neither the findings nor that a
// review made them: the preview says so, and the commit message never calls them verified. Only the owner's GLOBAL
// experimental.vectorscope setting enables new fixes, Linux only, never in a CI job or a GitHub run. Everything is in
// memory: a restart forgets every fix and approval, and the boot sweep removes their checkouts. No model is called.

import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Exit, Layer, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { FSUtil } from "@vectordevai/core/fs-util"
import {
  createFixConsentPolicy,
  FIX_LIMITS,
  type FixProposal,
  type FixRefusal,
} from "@vectordevai/core/review/fix-proposal"
import { ReviewFixControl } from "@vectordevai/schema/review-fix"
import { Git } from "@/git"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { ReviewFix } from "./fix"
import { ReviewOwner } from "./owner"

/** Open fixes per project in this process, and how long an approval offer stands (under the contract's consentMs). */
export const LIMIT = Object.freeze({ fixes: ReviewFixControl.LIMIT.fixes, approvalMs: 5 * 60_000 })

export class Error extends Schema.TaggedErrorClass<Error>()("ReviewFixOwner.Error", {
  code: Schema.Literals([
    "disabled",
    "placement",
    "invalid",
    "not_found",
    "conflict",
    "unavailable",
    "corrupt",
    "permissions",
    "stale",
  ]),
  message: Schema.String,
}) {}

type Code = Error["code"]
type Step = ReviewFixControl.Request["kind"]
// The executor's own operation shapes, so the two cannot drift; apply has none.
type Operation =
  | { readonly kind: "apply" }
  | ReviewFix.ChecksOperation
  | Effect.Success<ReturnType<typeof ReviewFix.commitOperation>>
  | Effect.Success<ReturnType<typeof ReviewFix.pushOperation>>
// The fix's commit is not kept here: it is read from the fix's branch (commitOf), which outlives an interrupted request.
type Held = {
  sessionID: SessionID
  projectID: string
  directory: string
  actor: string
  proposal: FixProposal
  preview: ReviewFixControl.Preview
}
type Pending = {
  offerID: string
  actor: string
  operation: Operation
  identity?: ReviewFix.Identity
  operationDigest: string
  head: string
  patchDigest: string
  expiresAt: number
}

const fail = (code: Code, message: string) => new Error({ code, message })
const mine = (held: Held, sessionID: SessionID, context: { project: { id: string }; directory: string }) =>
  held.sessionID === sessionID &&
  held.projectID === context.project.id &&
  held.directory === FSUtil.realpath(context.directory)
// The states each step waits for (the executor checks them again).
const WAITING: Record<Step, readonly ReviewFix.State[]> = {
  apply: ["preview"],
  checks: ["applied", "committed"],
  commit: ["applied"],
  push: ["committed"],
}
// Finding references that go into a commit message as they are; any other leaves the list out.
const FINDING_ID = /^[A-Za-z0-9_.:-]{1,64}$/
// How many commits the checks note reads to count other authors.
const AUTHORS_READ = 1_000

export const make = (input: { clock?: () => number } = {}) =>
  Effect.gen(function* () {
    const reviews = yield* ReviewOwner.Service
    const sessions = yield* Session.Service
    const fix = yield* ReviewFix.Service
    const git = yield* Git.Service
    const clock = input.clock ?? Date.now
    const policy = createFixConsentPolicy(clock)
    const fixes = new Map<string, Held>()
    // At most one approval offer stands per fix: a new preview replaces it, and every execute that reaches it spends it.
    const offers = new Map<string, Pending>()
    // Fixes being placed per project, counted with `fixes` against the limit before the first yield of a prepare.
    const placing = new Map<string, number>()

    const read = (cwd: string, args: string[]) => git.run(args, { cwd, env: { GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } })
    const open = (projectID: string) =>
      [...fixes.values()].filter((held) => held.projectID === projectID).length + (placing.get(projectID) ?? 0)

    /** New work is on only with the owner's global setting, on Linux, outside a CI job or a GitHub run. */
    const gate = Effect.fnUntraced(function* () {
      if (!(yield* reviews.enabled()))
        return yield* fail("disabled", "VectorScope fixes are disabled in the owner's settings.")
      if (process.platform !== "linux")
        return yield* fail("unavailable", "Applying a review fix is available on Linux only. Nothing was changed.")
      // As the CLI's apply step refuses (cli/cmd/review.fix.ts fixRefusal), for every step, not only checks.
      if ((yield* ReviewFix.RunnerContext)())
        return yield* fail(
          "unavailable",
          "Vector never places, commits or pushes a fix in a CI job or a GitHub run, which may hold secrets or write tokens. Nothing was changed.",
        )
    })

    /** The conversation's checked-out branch, read from its own checkout. */
    const branch = Effect.fnUntraced(function* (directory: string) {
      const result = yield* read(directory, ["symbolic-ref", "-q", "HEAD"])
      const ref = result.text().trim()
      if (result.exitCode !== 0 || !ref.startsWith("refs/heads/"))
        return yield* fail("placement", "Check out a branch in this conversation's folder before fixing it.")
      return ref.slice("refs/heads/".length)
    })

    /** The branch still names `head`. */
    const atHead = Effect.fnUntraced(function* (directory: string, name: string, head: string, message: string) {
      const result = yield* read(directory, [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `refs/heads/${name}^{commit}`,
      ])
      if (result.exitCode !== 0 || result.text().trim() !== head) return yield* fail("stale", message)
    })

    /** The executor's state of a fix, forgetting one it no longer holds (a failed step removed its checkout). */
    const current = (fixID: string) =>
      fix.state(fixID).pipe(
        Effect.mapError(refusal),
        Effect.tap((state) =>
          state
            ? Effect.void
            : Effect.sync(() => {
                fixes.delete(fixID)
                offers.delete(fixID)
              }),
        ),
      )

    /** This conversation's fix in this project and folder, and its state; anything else is not found. */
    const owned = Effect.fnUntraced(function* (sessionID: SessionID, fixID: string, starting: boolean) {
      const source = yield* reviews.placement(sessionID, starting)
      const held = fixes.get(fixID)
      const state = held && mine(held, sessionID, source.context) ? yield* current(fixID) : undefined
      if (!held || !state) return yield* fail("not_found", "This conversation has no such fix.")
      return { held, state }
    })

    /**
     * Frees the limit's slots that no request can use again. Fixes the executor no longer holds are forgotten; at the
     * limit, this project's fixes whose conversation was deleted (no route reaches them) or archived (no step runs for
     * them) are cancelled, which keeps a commit's branch as cancel does. Only this project's: a cancel from another
     * project's context would not find the placement.
     */
    const sweep = Effect.fnUntraced(function* (projectID: string) {
      yield* Effect.forEach([...fixes.keys()], (fixID) => current(fixID), { discard: true })
      if (open(projectID) < LIMIT.fixes) return
      const gone = yield* Effect.filter(
        [...fixes.entries()].filter((entry) => entry[1].projectID === projectID),
        (entry) =>
          sessions.get(entry[1].sessionID).pipe(
            Effect.map((session) => session.time.archived !== undefined),
            Effect.catchTag("NotFoundError", () => Effect.succeed(true)),
          ),
      )
      yield* Effect.forEach(
        gone,
        (entry) =>
          fix.cancel(entry[0]).pipe(
            Effect.flatMap((removed) =>
              removed.removed
                ? Effect.void
                : Effect.logWarning("an unreachable fix's checkout was kept", { fixID: entry[0], removed }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("an unreachable fix was not cancelled", { fixID: entry[0], cause }),
            ),
            // Forgotten either way: nothing can reach it, and a kept checkout is the boot sweep's.
            Effect.ensuring(
              Effect.sync(() => {
                if (fixes.get(entry[0]) !== entry[1]) return
                fixes.delete(entry[0])
                offers.delete(entry[0])
              }),
            ),
          ),
        { discard: true },
      )
    })

    /**
     * The fix's commit, read from its branch rather than kept in memory, so a commit step whose request was interrupted
     * after the executor made the branch still has a commit to push. Only a commit whose one parent is the head counts;
     * the executor checks again that the branch names its own commit before a push.
     */
    const commitOf = Effect.fnUntraced(function* (held: Held) {
      const result = yield* read(held.directory, [
        "rev-list",
        "--parents",
        "-n",
        "1",
        "--end-of-options",
        `refs/heads/${held.proposal.scope.destinationBranch}`,
        "--",
      ])
      const ids = result.text().trim().split(" ")
      if (result.exitCode === 0 && ids.length === 2 && ids[1] === held.proposal.head) return ids[0]
      return undefined
    })

    const prepare = Effect.fn("ReviewFixOwner.prepare")(function* (
      sessionID: SessionID,
      actor: string,
      input: ReviewFixControl.Prepare,
    ) {
      yield* gate()
      const source = yield* reviews.placement(sessionID, true)
      const directory = FSUtil.realpath(source.context.directory)
      const projectID = source.context.project.id
      const name = yield* branch(directory)
      yield* atHead(
        directory,
        name,
        input.head,
        "The conversation's branch is no longer at the commit this fix was made for. Nothing was placed.",
      )
      yield* sweep(projectID)
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          // Counted and taken in one uninterruptible step, so concurrent prepares cannot pass the limit together.
          if (open(projectID) >= LIMIT.fixes)
            return Effect.fail(
              fail("conflict", `At most ${LIMIT.fixes} fixes are open in a project at once. Cancel one first.`),
            )
          placing.set(projectID, (placing.get(projectID) ?? 0) + 1)
          // reserve is not restored on purpose: it makes only local Git reads and writes the fix's record, and an
          // interrupted reserve could leave a record whose fixID this adapter never learns (the boot sweep's to remove).
          // The checkout itself is made by fix.preview, which is interruptible and removed on every exit but a success.
          return fix.reserve({ head: input.head }).pipe(
            Effect.mapError(refusal),
            Effect.flatMap((placement) => {
              const proposal = {
                version: 1 as const,
                scope: {
                  kind: "local" as const,
                  repository: placement.repository,
                  worktree: placement.worktree,
                  sourceBranch: name,
                  baseBranch: input.baseBranch,
                  destinationBranch: `vector/fix-${placement.fixID.slice(4, 12)}`,
                },
                base: input.base,
                head: input.head,
                findings: [...input.findings].sort(),
                files: input.files.map((file) => ({ ...file })),
                patch: input.patch,
              }
              return restore(fix.preview({ fixID: placement.fixID, proposal })).pipe(
                Effect.mapError(refusal),
                Effect.map(
                  (shown) =>
                    ({
                      ...shown,
                      files: shown.files.map((file) => ({ ...file })),
                      baseBranch: input.baseBranch,
                      source: input.source,
                      findingsVerified: false as const,
                      findings: proposal.findings,
                      notes: [
                        "The engine did not verify the findings this fix names: the patch and its finding references come from your client.",
                        "Nothing is applied, committed or pushed until you approve each step, and no command has run.",
                      ],
                    }) satisfies ReviewFixControl.Preview,
                ),
                // Every exit but a success, an interrupt included, removes the placement; only a success is held.
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? Effect.sync(() => {
                        fixes.set(placement.fixID, {
                          sessionID,
                          projectID,
                          directory,
                          actor,
                          proposal,
                          preview: exit.value,
                        })
                      })
                    : fix.cancel(placement.fixID).pipe(
                        Effect.flatMap((removed) =>
                          removed.removed
                            ? Effect.void
                            : Effect.logWarning("a refused fix checkout was kept", { fixID: placement.fixID, removed }),
                        ),
                        Effect.catchCause((cause) =>
                          Effect.logWarning("a refused fix checkout was not removed", {
                            fixID: placement.fixID,
                            cause,
                          }),
                        ),
                      ),
                ),
              )
            }),
            Effect.ensuring(
              Effect.sync(() => {
                placing.set(projectID, (placing.get(projectID) ?? 1) - 1)
              }),
            ),
          )
        }),
      )
    })

    const preview = Effect.fn("ReviewFixOwner.preview")(function* (
      sessionID: SessionID,
      actor: string,
      fixID: string,
      request: ReviewFixControl.Request,
    ) {
      yield* gate()
      const found = yield* owned(sessionID, fixID, true)
      const held = found.held
      if (held.actor !== actor)
        return yield* fail("permissions", "Only the owner who prepared this fix can approve it.")
      if (!WAITING[request.kind].includes(found.state))
        return yield* fail("conflict", "This fix is not waiting for that step. Nothing was changed.")
      const step = yield* operation(held, request)
      yield* atHead(
        held.directory,
        held.proposal.scope.sourceBranch,
        held.proposal.head,
        "The reviewed branch moved since this fix was prepared. Nothing was changed.",
      )
      const operationDigest = `sha256:${sha256(JSON.stringify([step.operation, step.identity ?? null]))}`
      const pending = {
        offerID: randomUUID(),
        actor,
        operation: step.operation,
        ...(step.identity ? { identity: step.identity } : {}),
        operationDigest,
        head: held.proposal.head,
        patchDigest: held.preview.patchDigest,
        expiresAt: clock() + LIMIT.approvalMs,
      } satisfies Pending
      offers.set(fixID, pending)
      return {
        offerID: pending.offerID,
        fixID,
        operation: step.operation,
        operationDigest,
        head: pending.head,
        digest: held.preview.digest,
        patchDigest: pending.patchDigest,
        expiresAt: pending.expiresAt,
        ...(step.identity ? { identity: step.identity } : {}),
        notes: step.notes,
      } satisfies ReviewFixControl.Offer
    })

    /** The exact operation a step runs, what it is made with, and what the owner should know before approving it. */
    const operation = Effect.fnUntraced(function* (held: Held, request: ReviewFixControl.Request) {
      const proposal = held.proposal
      if (request.kind === "apply")
        return {
          operation: Object.freeze({ kind: "apply" as const }),
          notes: [
            "Only the separate fix checkout changes; your checkout, index and files are not changed.",
            "Commands: none. Nothing is committed or pushed by this step.",
          ],
        }
      if (request.kind === "checks") {
        const checks = yield* ReviewFix.checksOperation({
          kind: "checks",
          commands: request.commands.map((command) => ({ argv: [...command.argv], cwd: command.cwd })),
          network: "off",
          timeoutMs: FIX_LIMITS.commandMs,
          outputBytes: FIX_LIMITS.outputBytes,
        }).pipe(Effect.mapError(refusal))
        const authors = yield* authorship(held)
        return {
          operation: checks,
          notes: [
            `Checks run the project's own code at ${proposal.head.slice(0, 12)} in a sandbox with the network off, each for at most ${FIX_LIMITS.commandMs / 1000} seconds.`,
            "A check can read files outside the fix checkout, your home folder among them. Its output is shown to you and never kept.",
            ...(authors ? [authors] : []),
          ],
        }
      }
      if (request.kind === "commit") {
        const identity = yield* commitIdentity(held.directory)
        const commit = yield* ReviewFix.commitOperation({
          kind: "commit",
          message: commitMessage(proposal, held.preview.digest),
        }).pipe(Effect.mapError(refusal))
        // A note is at most 512 characters, so the identity is shown in the offer's `identity`, not in the note.
        return {
          operation: commit,
          identity,
          notes: [
            `Commits to the new branch ${proposal.scope.destinationBranch} in this repository as the identity this offer shows.`,
            "Nothing is pushed; your branch, index and files stay as they are.",
          ],
        }
      }
      const made = yield* commitOf(held)
      if (!made)
        return yield* fail(
          "conflict",
          "This fix's branch no longer names a commit on the head, so nothing can be pushed.",
        )
      const push = yield* ReviewFix.pushOperation(
        { kind: "push", remote: request.remote, commit: made, mode: request.mode },
        made,
      ).pipe(Effect.mapError(refusal))
      const local = push.remote.startsWith("file:///")
      if (!local && !(yield* configured(held.directory, push.remote)))
        return yield* fail(
          "invalid",
          "Push only to an https address this repository has as a remote's url, or to a repository on this computer (file:///…).",
        )
      // The remote may be up to 2,048 characters, so it is shown in the operation, not in the note.
      return {
        operation: push,
        notes: [
          `Pushes ${made.slice(0, 12)} as the new branch ${proposal.scope.destinationBranch} to the remote this offer's operation names; nothing else is pushed.`,
          local
            ? "That repository is on this computer: its hooks do not run, but its own Git configuration is read."
            : "Git pushes with your own credentials for this address. Vector makes no GitHub call.",
          ...(push.mode === "draft-pr" ? ["No pull request is opened by this step."] : []),
        ],
      }
    })

    /**
     * The checks note on code others wrote: how many commits between the base and the head are by other authors, or
     * that they could not be counted. The base comes from the client, so one that is not an earlier commit of the head
     * (the head itself included) says so rather than counting an empty or unrelated range.
     */
    const authorship = Effect.fnUntraced(function* (held: Held) {
      const base = held.proposal.base
      const head = held.proposal.head
      const ancestor =
        base === head
          ? undefined
          : yield* read(held.directory, ["merge-base", "--is-ancestor", "--end-of-options", base, head])
      if (!ancestor || ancestor.exitCode !== 0)
        return "The base this fix names is not an earlier commit of the head, so Vector did not count who wrote the commits a check runs. A check runs all the code at the head, whoever wrote it."
      const range = `${base}..${head}`
      const email = yield* setting(held.directory, "user.email")
      const count = yield* read(held.directory, ["rev-list", "--count", "--end-of-options", range])
      const log = yield* read(held.directory, [
        "log",
        "-n",
        `${AUTHORS_READ}`,
        "--format=%ae",
        "--end-of-options",
        range,
      ])
      const total = Number(count.text().trim())
      if (count.exitCode !== 0 || log.exitCode !== 0 || !Number.isSafeInteger(total) || total < 1)
        return "Vector could not read the commits between the base and the head to count who wrote them. A check runs all the code at the head, whoever wrote it."
      const emails = log.text().split("\n").filter(Boolean)
      const others = emails.filter((item) => item !== email).length
      if (!others) return undefined
      return total > emails.length
        ? `At least ${others} of the ${total} commits between the base and the head are by other authors; a check runs their code too.`
        : `${others} of the ${total} commits between the base and the head are by other authors; a check runs their code too.`
    })

    /**
     * The commit's author and committer: the owner's Git identity in the conversation's repository, field by field, or
     * Vector's where one is unset (SF-09's rule, as task commits do).
     */
    const commitIdentity = Effect.fnUntraced(function* (directory: string) {
      const identity = {
        name: (yield* setting(directory, "user.name")) || "Vector",
        email: (yield* setting(directory, "user.email")) || "bot@vectordev.ai",
      }
      if (!ReviewFix.person(identity))
        return yield* fail(
          "invalid",
          "Your Git user.name and user.email are not a plain name and address, so the fix cannot be committed with them.",
        )
      return Object.freeze(identity)
    })

    /** One Git setting of the conversation's repository, or empty when unset. */
    const setting = (directory: string, key: string) =>
      read(directory, ["config", "--default", "", "--get", key]).pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.text().trim() : "")),
      )

    /** An https remote is one this repository already names as a remote's url or pushurl. */
    const configured = Effect.fnUntraced(function* (directory: string, remote: string) {
      const result = yield* read(directory, ["config", "-z", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"])
      return result
        .text()
        .split("\0")
        .filter(Boolean)
        .some((item) => item.slice(item.indexOf("\n") + 1) === remote)
    })

    const execute = Effect.fn("ReviewFixOwner.execute")(function* (
      sessionID: SessionID,
      actor: string,
      fixID: string,
      input: ReviewFixControl.Execute,
    ) {
      // A refusal here (disabled, a CI job, another conversation) leaves the offer unspent.
      yield* gate()
      const held = (yield* owned(sessionID, fixID, true)).held
      // Taken and spent in one synchronous step: of two executes of one offer, exactly one gets it, and every execute
      // that gets it spends it, whatever happens next.
      const pending = offers.get(fixID)
      if (!pending || pending.offerID !== input.offerID)
        return yield* fail("permissions", "This approval is not the one shown for this fix. Preview the step again.")
      offers.delete(fixID)
      if (pending.actor !== actor) return yield* fail("permissions", "This approval was offered to another owner.")
      const now = clock()
      if (now >= pending.expiresAt) return yield* fail("stale", "This approval expired. Preview the step again.")
      if (
        input.head !== pending.head ||
        input.patchDigest !== pending.patchDigest ||
        input.operationDigest !== pending.operationDigest
      )
        return yield* fail("stale", "This is not the step that was shown. Preview it again; nothing was changed.")
      const approved = yield* Effect.tryPromise({
        try: () => policy.approve(held.proposal, pending.operation, actor, pending.expiresAt - now),
        // approve answers with typed refusals; a rejection would be a fault in the contract, refused rather than a 500.
        catch: () =>
          fail("unavailable", "The approval could not be checked. Nothing was changed; preview the step again."),
      })
      if (!approved.ok) return yield* consentRefused(approved.reason)
      const spend = { fixID, proposal: held.proposal, consent: approved.consent, policy, actor }
      // After a successful step the consent is used and revoke refuses it ("used"); that result is ignored on purpose.
      const revoke = Effect.sync(() => policy.revoke(approved.consent))
      const operation = pending.operation
      if (operation.kind === "apply")
        return yield* fix.apply(spend).pipe(
          Effect.map((done) => ({
            kind: "apply" as const,
            fixID,
            worktree: done.worktree,
            head: done.head,
            digest: done.digest,
            patchDigest: done.patchDigest,
            consumedAt: done.consumedAt,
            files: done.files.map((file) => ({ ...file })),
          })),
          Effect.mapError(refusal),
          Effect.ensuring(revoke),
        )
      if (operation.kind === "checks")
        return yield* fix.checks({ ...spend, operation }).pipe(
          Effect.map((done) => ({
            kind: "checks" as const,
            fixID,
            head: done.head,
            digest: done.digest,
            operation: done.operation,
            consumedAt: done.consumedAt,
            results: done.results.map((result) => ({ ...result, argv: [...result.argv] })),
            ...(done.aborted ? { aborted: done.aborted } : {}),
            ...(done.leftovers ? { leftovers: [...done.leftovers] } : {}),
            passed: done.passed,
          })),
          Effect.mapError(refusal),
          Effect.ensuring(revoke),
        )
      if (operation.kind === "commit") {
        const identity = pending.identity
        if (!identity) return yield* fail("corrupt", "This commit approval has no identity.")
        return yield* fix.commit({ ...spend, operation, identity }).pipe(
          Effect.map((done) => ({
            kind: "commit" as const,
            fixID,
            head: done.head,
            digest: done.digest,
            commit: done.commit,
            tree: done.tree,
            branch: done.branch,
            author: { ...done.author },
            consumedAt: done.consumedAt,
          })),
          Effect.mapError(refusal),
          Effect.ensuring(revoke),
        )
      }
      return yield* fix.push({ ...spend, operation }).pipe(
        Effect.map((done) => ({
          kind: "push" as const,
          fixID,
          commit: done.commit,
          remote: done.remote,
          ref: done.ref,
          mode: done.mode,
          consumedAt: done.consumedAt,
        })),
        Effect.mapError(refusal),
        Effect.ensuring(revoke),
      )
    })

    /** Stops a running check or push and removes the checkout; turning new fixes off never prevents it (as stop). */
    const cancel = Effect.fn("ReviewFixOwner.cancel")(function* (sessionID: SessionID, fixID: string) {
      const held = (yield* owned(sessionID, fixID, false)).held
      offers.delete(fixID)
      const result = yield* fix.cancel(fixID).pipe(Effect.mapError(refusal))
      if (result.removed && fixes.get(fixID) === held) fixes.delete(fixID)
      return result satisfies ReviewFixControl.Cleanup
    })

    const list = Effect.fn("ReviewFixOwner.list")(function* (sessionID: SessionID) {
      const source = yield* reviews.placement(sessionID)
      const entries = [...fixes.entries()].filter((entry) => mine(entry[1], sessionID, source.context))
      const summaries = yield* Effect.forEach(entries, (entry) =>
        Effect.gen(function* () {
          const state = yield* current(entry[0])
          if (!state) return []
          const commit = state === "committed" || state === "pushed" ? yield* commitOf(entry[1]) : undefined
          return [
            {
              fixID: entry[0],
              state,
              head: entry[1].proposal.head,
              sourceBranch: entry[1].proposal.scope.sourceBranch,
              destinationBranch: entry[1].proposal.scope.destinationBranch,
              digest: entry[1].preview.digest,
              patchDigest: entry[1].preview.patchDigest,
              ...(commit ? { commit } : {}),
            },
          ]
        }),
      )
      return { fixes: summaries.flat() } satisfies ReviewFixControl.List
    })

    return { prepare, preview, execute, cancel, list }
  })

export type Interface = Effect.Success<ReturnType<typeof make>>
export class Service extends Context.Service<Service, Interface>()("@vector/ReviewFixOwner") {}
export const layer = Layer.effect(Service, make())
export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [ReviewOwner.node, Session.node, ReviewFix.node, Git.node],
})

/** The executor's refusals as the API's codes; the executor's message passes through. */
function refusal(error: ReviewFix.Refused | ReviewOwner.Error) {
  if (error._tag === "ReviewOwner.Error") return fail(error.code, error.message)
  return fail(REASONS[error.reason], error.message)
}

function consentRefused(reason: FixRefusal) {
  return fail(REASONS[reason], `The approval was refused (${reason}). Preview the step again.`)
}

const REASONS: Record<ReviewFix.Reason, Code> = {
  // The environment refuses: no sandbox, no dependencies, Linux only, a CI job or a GitHub run.
  unavailable: "unavailable",
  sandbox: "unavailable",
  dependencies: "unavailable",
  context: "unavailable",
  clock: "unavailable",
  // The request or the patch is not one the executor can run.
  proposal: "invalid",
  operation: "invalid",
  path: "invalid",
  symlink: "invalid",
  binary: "invalid",
  limit: "invalid",
  patch: "invalid",
  scope: "invalid",
  preimage: "invalid",
  postimage: "invalid",
  remote: "invalid",
  // The branch, the proposal or the approval's time moved on.
  head: "stale",
  digest: "stale",
  expiry: "stale",
  // The approval is not this owner's, this step's, or still pending.
  actor: "permissions",
  capacity: "permissions",
  unknown: "permissions",
  revoked: "permissions",
  used: "permissions",
  mismatch: "permissions",
  // The fix or its checkout is not in the state the step needs.
  state: "conflict",
  worktree: "conflict",
  destination: "conflict",
  push: "conflict",
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

/**
 * Only the finding references (when each is a plain ID), the reviewed commit and the proposal digest, so no client
 * text but those IDs reaches the commit; within the contract's message limit, the list dropped first.
 */
function commitMessage(proposal: FixProposal, digest: string) {
  const count = proposal.findings.length
  const head = [
    `Apply a Vector fix for ${count} review ${count === 1 ? "finding" : "findings"}`,
    "",
    `Reviewed commit: ${proposal.head}`,
    `Proposal: ${digest}`,
  ]
  const full = proposal.findings.every((id) => FINDING_ID.test(id))
    ? `${[...head, "", "Finding references, as the owner's client named them:", ...proposal.findings.map((id) => `- ${id}`)].join("\n")}\n`
    : undefined
  return full && Buffer.byteLength(full) <= FIX_LIMITS.messageBytes ? full : `${head.join("\n")}\n`
}
