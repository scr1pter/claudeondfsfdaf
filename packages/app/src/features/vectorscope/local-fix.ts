import { Option, Schema } from "effect"
import type { VectorClient } from "@vectordevai/sdk/v2/client"
import { ReviewFixControl } from "@vectordevai/schema/review-fix"
import {
  fixCandidates,
  fixPath,
  planEdits,
  plainBranch,
  type FixCandidate,
  type FixCandidates,
  type FixSkipped,
} from "@vectordevai/core/review/fix-plan"
import { hash } from "@vectordevai/core/util/encode"
import { withoutDismissed, type ReviewOutcomeLite, type ReviewPullRequest } from "../pull-requests/ai-review"
import { conversationProblem } from "./local-review"

// VS-12d (SF-10b): the desktop's fix actions, through the owner-only fix API (SF-10a) and the generated client only.
// A fix comes only from the desktop runner's own review of the owner's own pull request, checked out in place at its
// exact head: the findings its double-check confirmed with a suggestion that can be committed as is, built into a
// patch by the planner the CLI uses (core review/fix-plan.ts). The engine places a separate checkout detached at that
// commit and offers each step (apply, checks, commit, push) on its own; each needs its own approval here, a trusted
// single click on the offer it shows, after a short pause. Posting the review to GitHub, suggestions included,
// approves none of them. No engine module reaches this file (browser-bundle.test.ts).

/** How long an offer is shown before its Approve button works, so a double-click on a step cannot approve it. */
export const LOCAL_FIX_DWELL_MS = 750

export type LocalFixPullRequest = Pick<ReviewPullRequest, "number" | "headRefOid" | "baseRefOid" | "baseRefName">

export type LocalFixSource = {
  outcome: ReviewOutcomeLite
  pr: LocalFixPullRequest
  // Findings dismissed in the panel, and findings whose fix "Apply" wrote into the user's own checkout.
  dismissed: ReadonlySet<string>
  applied: ReadonlySet<string>
}

/** What the pull request panel hands the fix panel; accessors, so dismissing a finding never remounts it. */
export type LocalFixInput = {
  outcome: () => ReviewOutcomeLite
  pr: () => LocalFixPullRequest
  dismissed: () => ReadonlySet<string>
  applied: () => ReadonlySet<string>
}

export interface LocalFixAPI {
  list(signal: AbortSignal): Promise<ReviewFixControl.List>
  read(path: string, signal: AbortSignal): Promise<string | undefined>
  prepare(request: ReviewFixControl.Prepare, signal: AbortSignal): Promise<ReviewFixControl.Preview>
  preview(fixID: string, request: ReviewFixControl.Request, signal: AbortSignal): Promise<ReviewFixControl.Offer>
  execute(fixID: string, body: ReviewFixControl.Execute, signal: AbortSignal): Promise<ReviewFixControl.Result>
  cancel(fixID: string, signal: AbortSignal): Promise<ReviewFixControl.Cleanup>
}

export interface LocalFixScope {
  identity: object
  server: string
  parentID: string
  directory: string
  projectID: string
  api: LocalFixAPI
}

export type LocalFixStep = "preview" | "applied" | "committed" | "pushed"

export interface LocalFixState {
  busy?: "listing" | "preparing" | "offering" | "running" | "cancelling"
  // This conversation's open fixes, as the engine lists them.
  fixes: readonly ReviewFixControl.Summary[]
  // The fix this panel prepared: what was built, the engine's preview of it, and where its steps stand.
  found?: FixCandidates
  plan?: { used: readonly FixCandidate[]; skipped: readonly FixSkipped[] }
  preview?: ReviewFixControl.Preview
  step?: LocalFixStep
  commit?: string
  offer?: ReviewFixControl.Offer
  offeredAt?: number
  results: readonly ReviewFixControl.Result[]
  // The last answer to a prepare, a step or a cancel was lost: nothing more is sent until the open fixes are read.
  uncertain: boolean
  error: string
}

export type LocalFixAction = "prepare" | "apply" | "checks" | "commit" | "push" | "approve" | "cancel"

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
// How long a sent prepare's answer is awaited, after dispose too: long enough for the engine to make a checkout of a
// large repository, and bounded so a closed panel's request does not wait forever.
const PREPARE_MS = 5 * 60_000
const strict = { onExcessProperty: "error" } as const
const encoder = new TextEncoder()

export const LOCAL_FIX_COPY = {
  uncommitted:
    "Fixes come only from a review of a pull request: uncommitted changes are not in the commit a fix starts from.",
  untrusted:
    "Fixes come only from a review of your own pull request in this repository, as the review recorded it. This review is of someone else's, a fork's, or one Vector could not tell.",
  rebuilt:
    "Your checkout is not this pull request's version of every changed file, so its fixes cannot be checked against it. Check out the pull request's branch and review it again.",
  carried:
    'Some of this review\'s findings were checked on an earlier commit. Use "Review everything again", then fix from that review.',
  head: "This review is not pinned to the pull request's exact head commit. Review it again.",
  base: "The pull request's base commit is not known. Review it again.",
  number: "This review is of another pull request than the one shown.",
  applied:
    'You used "Apply" on a finding, so a file in your checkout no longer matches the reviewed commit. Discard that change outside Vector and review again to fix in a separate checkout.',
  owner: "Owner access or this conversation's fix placement could not be verified.",
  missing:
    "Open an existing main conversation in this checkout to fix in a separate checkout. Vector will not create or move a conversation for this action.",
  mismatch: "Open this main conversation in its own checkout before fixing.",
  refused: "The engine refused this request.",
  unverifiable: "The engine returned a fix response Vector could not verify.",
  lost: "The engine's answer did not arrive.",
  mismatchPreview: "The engine's preview does not match the fix Vector built. Nothing was applied.",
  mismatchOffer: "The engine offered another step than the one asked for. Nothing was approved.",
  preimage:
    'If you used "Apply" on a finding or edited a changed file, that file differs from the reviewed commit: commit, discard or stash the change outside Vector, then prepare again.',
  moved:
    "If the base branch's latest commit is not in this clone, fetch it; if your branch moved, review it again. Then prepare again.",
  gone: "This fix is no longer open in the engine (it was cancelled, a step removed its checkout, or the engine restarted). Nothing more runs for it.",
  stopped: "This fix stopped after a failed or cancelled step and its checkout was kept. Cancel it to remove it.",
} as const

/**
 * The fixes this review offers, or why it offers none. Fixed rules, in order: a pull request review (never one of
 * uncommitted changes), of the owner's own pull request (authorship, ai-review.ts), read in place, whose findings this
 * run double-checked itself (no unchanged or carried findings), pinned to the pull request's exact head and base, with
 * no "Apply" already written into the checkout. Then the CLI's rule (fixCandidates): verified, committable inline
 * suggestions, after the findings the user dismissed are removed.
 */
export function localFixCandidates(
  source: LocalFixSource,
): { ok: true; found: FixCandidates } | { ok: false; reason: string } {
  const outcome = source.outcome
  const pr = source.pr
  const refuse = (reason: string) => ({ ok: false as const, reason })
  if (outcome.pr === undefined) return refuse(LOCAL_FIX_COPY.uncommitted)
  if (outcome.authored !== "trusted") return refuse(LOCAL_FIX_COPY.untrusted)
  if (outcome.checkout.mode !== "in-place") return refuse(LOCAL_FIX_COPY.rebuilt)
  // A reused or partial re-review copies earlier findings, verified flags included, onto this head (runReview).
  if (outcome.unchanged === true || (outcome.carried ?? 0) > 0) return refuse(LOCAL_FIX_COPY.carried)
  if (!COMMIT.test(outcome.head) || outcome.head !== pr.headRefOid) return refuse(LOCAL_FIX_COPY.head)
  if (!pr.baseRefOid || !COMMIT.test(pr.baseRefOid) || pr.baseRefOid.length !== outcome.head.length)
    return refuse(LOCAL_FIX_COPY.base)
  if (outcome.pr !== pr.number) return refuse(LOCAL_FIX_COPY.number)
  if (source.applied.size) return refuse(LOCAL_FIX_COPY.applied)
  return {
    ok: true,
    found: fixCandidates({ selection: withoutDismissed(outcome.selection, source.dismissed) }, outcome.head),
  }
}

/**
 * The prepare request for this review's fixes: the files the fixes change, read from the conversation's checkout one
 * after another, planned and patched as the CLI does. The engine re-reads every file at the head and refuses a
 * preimage that is not the committed file, so a file edited since the review (or one with a byte order mark, which a
 * read drops) is refused there and never seeded into the fix checkout. The base is the pull request's base commit.
 */
export async function localFixRequest(
  source: LocalFixSource,
  read: (path: string) => Promise<string | undefined>,
): Promise<
  | { ok: true; request: ReviewFixControl.Prepare; found: FixCandidates; plan: ReturnType<typeof planEdits> }
  | { ok: false; reason: string; found?: FixCandidates; plan?: ReturnType<typeof planEdits> }
> {
  const gate = localFixCandidates(source)
  if (!gate.ok) return gate
  const found = gate.found
  if (!found.fixes.length) return { ok: false, reason: `Nothing to fix: ${found.none}`, found }
  // One read at a time: each step waits for the one before it, since every read first reads the conversation again.
  const heads = await [...new Set(found.fixes.map((fix) => fix.path))].filter(fixPath).reduce(async (pending, path) => {
    const earlier = await pending
    const text = await read(path)
    return earlier.set(path, text === undefined ? undefined : encoder.encode(text))
  }, Promise.resolve(new Map<string, Uint8Array | undefined>()))
  const plan = planEdits(found.fixes, heads)
  if (!plan.files.length)
    return { ok: false, reason: "Nothing to fix: no fix could be made into a patch.", found, plan }
  const pr = source.pr
  const base = pr.baseRefOid!
  const request = Schema.decodeUnknownOption(
    ReviewFixControl.Prepare,
    strict,
  )({
    source: { kind: "client" },
    head: source.outcome.head,
    base,
    // As the CLI: a base that is not a plain branch name is named by its commit.
    baseBranch: plainBranch(pr.baseRefName) ? pr.baseRefName : base,
    findings: [...new Set(plan.used.map((fix) => fix.id))].sort(),
    files: await Promise.all(
      plan.files.map(async (file) => ({
        path: file.path,
        preimage: `sha256:${await sha256(file.before)}`,
        postimage: `sha256:${await sha256(file.after)}`,
      })),
    ),
    patch: plan.files.map((file) => file.patch).join(""),
  })
  if (Option.isNone(request))
    return { ok: false, reason: "This fix is not one the engine's fix API can carry. Nothing was sent.", found, plan }
  return { ok: true, request: request.value, found, plan }
}

export class LocalFixRefusal extends Error {
  code = ""
}
/** The answer to a request did not arrive or could not be verified: it may or may not have taken effect. */
export class LocalFixLost extends Error {}

const refusal = (message: string, code = "") => Object.assign(new LocalFixRefusal(message), { code })
const CODES = new Set([
  "disabled",
  "placement",
  "invalid",
  "not_found",
  "conflict",
  "unavailable",
  "corrupt",
  "permissions",
  "stale",
])

/**
 * The owner fix API through the generated client. Every call first reads the conversation again (as the local review
 * transport does), so a stale selection never reaches another checkout; outbound bodies are decoded strictly and
 * copied, and every answer is decoded strictly. A 401 or 403 is the owner copy, a 400 the engine's own message
 * (escaped and capped), and anything else, a lost connection included, is LocalFixLost.
 */
export function localFixTransport(
  client: Pick<VectorClient, "session" | "review" | "file">,
  source: Pick<LocalFixScope, "parentID" | "directory" | "projectID">,
): LocalFixAPI {
  const params = { sessionID: source.parentID, directory: source.directory }
  const placement = async (signal: AbortSignal) => {
    const problem = await conversationProblem(client, source, signal).catch(() => "unverified" as const)
    if (problem === "missing") throw refusal(LOCAL_FIX_COPY.missing)
    if (problem === "unverified") throw refusal(LOCAL_FIX_COPY.owner)
    if (problem === "mismatch") throw refusal(LOCAL_FIX_COPY.mismatch)
  }
  const send = async <S extends Schema.Decoder<unknown>>(
    schema: S,
    signal: AbortSignal,
    request: () => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
  ): Promise<S["Type"]> => {
    await placement(signal)
    const result = await request().catch(() => {
      throw new LocalFixLost(LOCAL_FIX_COPY.lost)
    })
    const status = result.response?.status
    if (status === 401 || status === 403) throw refusal(LOCAL_FIX_COPY.owner)
    if (status === 400) {
      const error = result.error && typeof result.error === "object" ? (result.error as Record<string, unknown>) : {}
      throw typeof error.code === "string" && CODES.has(error.code) && typeof error.message === "string"
        ? refusal(visible(error.message, false).slice(0, 1_000), error.code)
        : refusal(LOCAL_FIX_COPY.refused)
    }
    if (status !== 200 || result.error !== undefined) throw new LocalFixLost(LOCAL_FIX_COPY.lost)
    const decoded = Schema.decodeUnknownOption(schema, strict)(result.data)
    if (Option.isNone(decoded)) throw new LocalFixLost(LOCAL_FIX_COPY.unverifiable)
    return decoded.value
  }
  const outbound = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown): S["Type"] => {
    const decoded = Schema.decodeUnknownOption(schema, strict)(value)
    if (Option.isNone(decoded)) throw refusal("Vector could not build a request the fix API accepts. Nothing was sent.")
    return decoded.value
  }
  const fixID = (value: string) => outbound(ReviewFixControl.FixID, value)
  return Object.freeze({
    list: (signal: AbortSignal) =>
      send(ReviewFixControl.List, signal, () => client.review.fix.list(params, { signal, throwOnError: false })),
    read: async (path: string, signal: AbortSignal) => {
      await placement(signal)
      const result = await client.file
        .read({ directory: source.directory, path }, { signal, throwOnError: false })
        .catch(() => undefined)
      return result?.response?.status === 200 && result.data?.type === "text" ? result.data.content : undefined
    },
    prepare: (input: ReviewFixControl.Prepare, signal: AbortSignal) => {
      const request = outbound(ReviewFixControl.Prepare, input)
      // The desktop's fixes change existing files only, and the generated client types both digests as strings.
      const files = request.files.flatMap((file) =>
        file.preimage !== null && file.postimage !== null
          ? [{ path: file.path, preimage: file.preimage, postimage: file.postimage }]
          : [],
      )
      if (files.length !== request.files.length)
        throw refusal("Vector could not build a request the fix API accepts. Nothing was sent.")
      // The generated SDK takes mutable arrays: give it fresh copies of the decoded request, never the caller's.
      const body = {
        source: { kind: request.source.kind },
        head: request.head,
        base: request.base,
        baseBranch: request.baseBranch,
        findings: [...request.findings],
        files,
        patch: request.patch,
      }
      return send(ReviewFixControl.Preview, signal, () =>
        client.review.fix.prepare({ ...params, reviewFixControlPrepare: body }, { signal, throwOnError: false }),
      )
    },
    preview: (id: string, input: ReviewFixControl.Request, signal: AbortSignal) => {
      const request = outbound(ReviewFixControl.Request, input)
      const body =
        request.kind === "checks"
          ? {
              kind: request.kind,
              commands: request.commands.map((command) => ({ argv: [...command.argv], cwd: command.cwd })),
            }
          : request.kind === "push"
            ? { kind: request.kind, remote: request.remote, mode: request.mode }
            : { kind: request.kind }
      return send(ReviewFixControl.Offer, signal, () =>
        client.review.fix.preview(
          { ...params, fixID: fixID(id), reviewFixControlRequest: body },
          { signal, throwOnError: false },
        ),
      )
    },
    execute: (id: string, input: ReviewFixControl.Execute, signal: AbortSignal) => {
      const request = outbound(ReviewFixControl.Execute, input)
      const body = {
        offerID: request.offerID,
        head: request.head,
        patchDigest: request.patchDigest,
        operationDigest: request.operationDigest,
      }
      return send(ReviewFixControl.Result, signal, () =>
        client.review.fix.execute(
          { ...params, fixID: fixID(id), reviewFixControlExecute: body },
          { signal, throwOnError: false },
        ),
      )
    },
    cancel: (id: string, signal: AbortSignal) =>
      send(ReviewFixControl.Cleanup, signal, () =>
        client.review.fix.cancel({ ...params, fixID: fixID(id) }, { signal, throwOnError: false }),
      ),
  })
}

/**
 * Whether a listed fix's Cancel works now (the prepared fix's when no fixID is given). It works with the setting off
 * and during a running step, but only for the fix whose step runs, since that Cancel stops the step: any other fix's
 * Cancel waits for the step, so it can never stop a step it does not name.
 */
export function localFixCancel(state: LocalFixState, fixID = state.preview?.fixID) {
  if (state.busy === "running" && fixID !== state.preview?.fixID)
    return {
      enabled: false,
      reason: "A step of the fix prepared here is running. Wait for it, or stop it with that fix's own Cancel.",
    }
  if (state.busy && state.busy !== "running")
    return { enabled: false, reason: "Wait for the current request to finish." }
  return { enabled: true }
}

/**
 * Which actions the panel offers now, with why not. Every step needs the setting, no request in flight, no lost
 * answer, a prepared fix, no offer waiting, no dismissed finding in the fix and no files a check left behind; then the
 * order the engine enforces: apply first and once, checks after apply, commit after apply, push after commit. Approve
 * needs a shown offer that has not expired, and only after LOCAL_FIX_DWELL_MS. Cancel (the prepared fix's, as
 * localFixCancel) works even with the setting off.
 */
export function localFixActions(
  state: LocalFixState,
  input: { enabled: boolean; dismissed: ReadonlySet<string>; now: number; dwellMs?: number },
): Record<LocalFixAction, { enabled: boolean; reason?: string }> {
  const no = (reason: string) => ({ enabled: false, reason })
  const yes = { enabled: true }
  const leftovers = state.results.some((result) => result.kind === "checks" && (result.leftovers?.length ?? 0) > 0)
  const dismissed = state.preview?.findings.some((id) => input.dismissed.has(id)) === true
  const common = !input.enabled
    ? no("Fixes are off in the owner's global VectorScope settings.")
    : state.busy
      ? no("Wait for the current request to finish.")
      : state.uncertain
        ? no("The last answer was lost. Check open fixes first.")
        : undefined
  const stepCommon =
    common ??
    (!state.preview
      ? no("Prepare a fix checkout first.")
      : state.offer
        ? no("Approve or dismiss the offer shown first.")
        : dismissed
          ? no("You dismissed a finding this fix includes. Cancel this fix and prepare again.")
          : leftovers
            ? no("A check left files in the fix checkout. Cancel this fix.")
            : undefined)
  const step = state.step
  const offerAge = input.now - (state.offeredAt ?? input.now)
  return {
    prepare: common ?? (state.preview ? no("Cancel this fix to prepare another.") : yes),
    apply: stepCommon ?? (step === "preview" ? yes : no("The patch is already applied.")),
    checks: stepCommon ?? (step === "applied" || step === "committed" ? yes : no("Apply the patch first.")),
    commit:
      stepCommon ??
      (step === "applied" ? yes : step === "preview" ? no("Apply the patch first.") : no("Already committed.")),
    push:
      stepCommon ??
      (step === "committed" && state.commit
        ? yes
        : step === "pushed"
          ? no("Already pushed.")
          : no("Commit the fix first.")),
    approve:
      common ??
      (!state.offer
        ? no("Preview a step first.")
        : dismissed
          ? no("You dismissed a finding this fix includes. Cancel this fix and prepare again.")
          : input.now >= state.offer.expiresAt
            ? no("This offer expired. Preview the step again.")
            : offerAge < (input.dwellMs ?? LOCAL_FIX_DWELL_MS)
              ? no("Read the offer first.")
              : yes),
    cancel: localFixCancel(state),
  }
}

/**
 * The fix panel's controller: one per conversation, server and owner authority, never per review. Nothing is sent on
 * construction. Every request runs one at a time and is dropped when a newer one or dispose overtakes it. Each step is
 * a preview (an offer; nothing runs), then a single execute that echoes the offer, sent only for a trusted single
 * activation after the pause, and never retried or chained. Dispose aborts a running step (the engine stops it and
 * spends its offer) and cancels the fix this panel prepared, best effort: a later panel could only cancel it. A prepare
 * already sent is not aborted: the fix it placed is cancelled as soon as its answer arrives (within PREPARE_MS).
 */
export function localFixController(input: {
  scope: LocalFixScope
  enabled: () => boolean
  dismissed: () => ReadonlySet<string>
  changed: (state: LocalFixState) => void
  now?: () => number
  dwellMs?: number
}) {
  const scope = { ...input.scope }
  const api = scope.api
  const now = input.now ?? Date.now
  let state: LocalFixState = { fixes: [], results: [], uncertain: false, error: "" }
  let revision = 0
  let disposed = false
  let observation: AbortController | undefined
  const emit = (patch: Partial<LocalFixState>) => {
    if (disposed) return
    state = { ...state, ...patch }
    input.changed(state)
  }
  const begin = (busy: NonNullable<LocalFixState["busy"]>) => {
    if (disposed || state.busy) return
    const controller = new AbortController()
    observation = controller
    const epoch = ++revision
    emit({ busy, error: "" })
    return { signal: controller.signal, current: () => !disposed && revision === epoch && !controller.signal.aborted }
  }
  const actions = () =>
    localFixActions(state, {
      enabled: input.enabled(),
      dismissed: input.dismissed(),
      now: now(),
      dwellMs: input.dwellMs,
    })
  const failure = (cause: unknown, hint = "") =>
    cause instanceof LocalFixRefusal
      ? `${cause.message}${hint ? ` ${hint}` : ""}`
      : cause instanceof LocalFixLost
        ? cause.message
        : "The engine could not complete the fix request."
  const cleared = {
    found: undefined,
    plan: undefined,
    preview: undefined,
    step: undefined,
    commit: undefined,
    offer: undefined,
    offeredAt: undefined,
  } satisfies Partial<LocalFixState>

  const check = async () => {
    const operation = begin("listing")
    if (!operation) return
    try {
      const list = await api.list(operation.signal)
      if (!operation.current()) return
      const mine = state.preview ? list.fixes.find((fix) => fix.fixID === state.preview!.fixID) : undefined
      const placed = (fix: ReviewFixControl.Summary): fix is ReviewFixControl.Summary & { state: LocalFixStep } =>
        fix.state === "preview" || fix.state === "applied" || fix.state === "committed" || fix.state === "pushed"
      emit({
        fixes: list.fixes,
        uncertain: false,
        ...(!state.preview
          ? {}
          : !mine
            ? { ...cleared, error: LOCAL_FIX_COPY.gone }
            : !placed(mine)
              ? { ...cleared, error: LOCAL_FIX_COPY.stopped }
              : {
                  step: mine.state,
                  commit: mine.commit,
                  ...(mine.state !== state.step ? { offer: undefined, offeredAt: undefined } : {}),
                }),
      })
    } catch (cause) {
      if (operation.current()) emit({ error: failure(cause) })
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
  }

  const prepare = async (source: LocalFixSource) => {
    if (!actions().prepare.enabled) return
    const operation = begin("preparing")
    if (!operation) return
    let sent = false
    let prepared = false
    try {
      const built = await localFixRequest(source, (path) => api.read(path, operation.signal))
      if (!operation.current()) return
      if (!built.ok) {
        emit({
          error: built.reason,
          found: built.found,
          plan: built.plan && { used: built.plan.used, skipped: built.plan.skipped },
        })
        return
      }
      if (!input.enabled()) return
      sent = true
      // Once sent, the prepare runs on its own bounded signal, never the panel's: aborting it after the engine placed
      // the fix would lose the only answer that names it, so a late answer comes back here and is removed below.
      const preview = await api.prepare(built.request, AbortSignal.timeout(PREPARE_MS))
      // Current again after the comparison, which awaits a digest: dispose or a newer request may land during it.
      const shown = operation.current() && (await sameFix(preview, built.request)) && operation.current()
      if (!shown) {
        // Overtaken after the engine placed it, or not the fix built here: nothing here can show it, so it is removed,
        // on its own signal, since closing the panel must not abort removing a fix it was never shown.
        const removing = api.cancel(preview.fixID, AbortSignal.timeout(30_000)).catch(() => undefined)
        if (!operation.current()) return
        await removing
        if (operation.current()) emit({ error: LOCAL_FIX_COPY.mismatchPreview })
        return
      }
      prepared = true
      emit({
        ...cleared,
        found: built.found,
        plan: { used: built.plan.used, skipped: built.plan.skipped },
        preview,
        step: "preview",
        results: [],
      })
    } catch (cause) {
      if (operation.current())
        emit({
          error: failure(
            cause,
            cause instanceof LocalFixRefusal && cause.code === "invalid"
              ? LOCAL_FIX_COPY.preimage
              : cause instanceof LocalFixRefusal && cause.code === "stale"
                ? LOCAL_FIX_COPY.moved
                : "",
          ),
          ...(sent && cause instanceof LocalFixLost ? { uncertain: true } : {}),
        })
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
    if (prepared) await check()
  }

  const offer = async (request: ReviewFixControl.Request) => {
    if (!actions()[request.kind].enabled) return
    const preview = state.preview!
    const operation = begin("offering")
    if (!operation) return
    try {
      const offered = await api.preview(preview.fixID, request, operation.signal)
      // A late answer to an earlier preview, or one after dispose, is never shown (the epoch guard in begin).
      if (!operation.current()) return
      if (!sameOffer(offered, request, preview, state.commit)) {
        emit({ error: LOCAL_FIX_COPY.mismatchOffer })
        return
      }
      emit({ offer: offered, offeredAt: now() })
    } catch (cause) {
      if (operation.current()) emit({ error: failure(cause) })
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
  }

  const approve = async (activation: { trusted: boolean; clicks: number }) => {
    const offered = state.offer
    // A script's synthetic click, the second click of a double-click, or a click before the pause approves nothing.
    if (!offered || !activation.trusted || activation.clicks > 1 || !actions().approve.enabled) return
    const operation = begin("running")
    if (!operation) return
    // One execute per offer: it is gone before anything is sent, so nothing can send it twice.
    emit({ offer: undefined, offeredAt: undefined })
    const body: ReviewFixControl.Execute = {
      offerID: offered.offerID,
      head: offered.head,
      patchDigest: offered.patchDigest,
      operationDigest: offered.operationDigest,
    }
    try {
      const result = await api.execute(offered.fixID, body, operation.signal)
      if (!operation.current()) return
      if (result.fixID !== offered.fixID || result.kind !== offered.operation.kind)
        throw new LocalFixLost(LOCAL_FIX_COPY.unverifiable)
      emit({
        results: [...state.results, result],
        ...(result.kind === "apply"
          ? { step: "applied" as const }
          : result.kind === "commit"
            ? { step: "committed" as const, commit: result.commit }
            : result.kind === "push"
              ? { step: "pushed" as const }
              : {}),
      })
    } catch (cause) {
      if (operation.current())
        emit({
          error:
            cause instanceof LocalFixLost
              ? `${cause.message} This step may or may not have run. Check open fixes before anything else; Vector does not send it again.`
              : failure(cause),
          ...(cause instanceof LocalFixLost ? { uncertain: true } : {}),
        })
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
  }

  const cancel = async (fixID: string) => {
    if (disposed || !localFixCancel(state, fixID).enabled) return
    // Only the running step's own fix gets here while it runs (localFixCancel), and its Cancel stops the step: the
    // request is dropped (the engine stops it and spends its offer), then the fix goes.
    if (state.busy === "running") {
      revision++
      observation?.abort()
      emit({ busy: undefined })
    }
    const operation = begin("cancelling")
    if (!operation) return
    let done = false
    try {
      const cleanup = await api.cancel(fixID, operation.signal)
      if (!operation.current()) return
      done = true
      emit({
        ...(state.preview?.fixID === fixID ? cleared : {}),
        error: cleanup.removed ? "" : `The fix checkout was kept: ${visible(cleanup.reason, false)}`,
      })
    } catch (cause) {
      if (operation.current())
        emit({ error: failure(cause), ...(cause instanceof LocalFixLost ? { uncertain: true } : {}) })
    } finally {
      if (operation.current()) emit({ busy: undefined })
    }
    if (done) await check()
  }

  input.changed(state)
  return {
    state: () => state,
    actions,
    check,
    prepare,
    offer,
    approve,
    dismiss: () => {
      if (state.offer && !state.busy) emit({ offer: undefined, offeredAt: undefined })
    },
    cancel,
    dispose: () => {
      if (disposed) return
      const fixID = state.preview?.fixID
      disposed = true
      revision++
      observation?.abort()
      if (fixID) void api.cancel(fixID, AbortSignal.timeout(30_000)).catch(() => undefined)
    },
  }
}

/** The engine's preview is of exactly the fix built here: the same patch and digest, commits, findings and files. */
async function sameFix(preview: ReviewFixControl.Preview, request: ReviewFixControl.Prepare) {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((item, i) => item === b[i])
  return (
    preview.patch === request.patch &&
    preview.patchDigest === `sha256:${await hash(preview.patch)}` &&
    preview.head === request.head &&
    preview.base === request.base &&
    preview.baseBranch === request.baseBranch &&
    preview.source.kind === "client" &&
    preview.findingsVerified === false &&
    preview.destinationBranch.startsWith("vector/fix-") &&
    same(preview.findings, [...request.findings].sort()) &&
    same(preview.files.map((file) => file.path).sort(), request.files.map((file) => file.path).sort())
  )
}

/** The engine offered exactly the step asked for, for this fix at this head and patch. */
function sameOffer(
  offer: ReviewFixControl.Offer,
  request: ReviewFixControl.Request,
  preview: ReviewFixControl.Preview,
  commit: string | undefined,
) {
  const operation = offer.operation
  if (
    offer.fixID !== preview.fixID ||
    offer.head !== preview.head ||
    offer.digest !== preview.digest ||
    offer.patchDigest !== preview.patchDigest ||
    operation.kind !== request.kind
  )
    return false
  if (operation.kind === "checks" && request.kind === "checks")
    return (
      operation.network === "off" &&
      operation.commands.length === request.commands.length &&
      operation.commands.every(
        (command, i) =>
          command.cwd === request.commands[i]!.cwd &&
          command.argv.length === request.commands[i]!.argv.length &&
          command.argv.every((arg, j) => arg === request.commands[i]!.argv[j]),
      )
    )
  if (operation.kind === "push" && request.kind === "push")
    return operation.remote === request.remote && operation.mode === request.mode && operation.commit === commit
  if (operation.kind === "commit") return offer.identity !== undefined
  return offer.identity === undefined
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

// ---------------------------------------------------------------------------------------------------------------
// Presentation: plain text lines the view renders as text nodes, never HTML.

/** Text as it may be shown: every control, format and separator character escaped (newline and tab kept if asked). */
export function visible(text: string, multiline = true) {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) =>
    multiline && (char === "\n" || char === "\t") ? char : `\\u{${char.codePointAt(0)!.toString(16)}}`,
  )
}

const clamp = (text: string, size: number) => (text.length > size ? `${text.slice(0, size - 1)}…` : text)
const short = (commit: string) => commit.slice(0, 7)
const STATUS = { added: "A", deleted: "D", modified: "M" } as const

/** The fixes a prepare takes (or took), each on one line, and what is left out, in the desktop's words. */
export function candidateLines(
  found: FixCandidates,
  plan?: { used: readonly FixCandidate[]; skipped: readonly FixSkipped[] },
) {
  const left = found.left
  return [
    ...(plan?.used ?? found.fixes).map(
      (fix) =>
        `${fix.id} · ${fix.label} · ${visible(fix.path, false)}:${fix.start} · ${clamp(visible(fix.title, false), 160)}`,
    ),
    ...(left.unverified ? [`Left out: ${left.unverified} with a suggestion the double-check did not confirm.`] : []),
    ...(left.unfixable
      ? [`Left out: ${left.unfixable} confirmed without a suggestion that can be committed as is.`]
      : []),
    ...(left.unchecked ? [`Left out: ${left.unchecked} confirmed with a fix the guardrail could not check.`] : []),
    ...(left.unlisted
      ? [`Left out: ${left.unlisted} confirmed with a suggestion but not placed on a changed line in this review.`]
      : []),
    ...(plan?.skipped ?? []).map((item) => `Left out: ${item.id} (${visible(item.path, false)}): ${item.reason}.`),
  ]
}

/** Everything a prepared fix is before any step: where it is, its branches, its destination, its files and digest. */
export function previewLines(preview: ReviewFixControl.Preview) {
  return [
    `Fix checkout: ${visible(preview.worktree, false)} (separate from yours, detached at ${short(preview.head)})`,
    `Repository: ${visible(preview.repository, false)}`,
    `Branch: ${visible(preview.sourceBranch, false)} at ${short(preview.head)}; base ${visible(preview.baseBranch, false)} (${short(preview.base)})`,
    `Destination: a new branch ${visible(preview.destinationBranch, false)} in this repository, only if you approve the commit`,
    "Commands: none",
    "Files:",
    ...preview.files.map(
      (file) => `  ${STATUS[file.status]} ${visible(file.path, false)} (+${file.additions} -${file.deletions})`,
    ),
    `Proposal: ${preview.digest}`,
  ]
}

/** One step's offer, exactly: what runs, with what, and the engine's notes, then when it expires. */
export function offerLines(offer: ReviewFixControl.Offer, time = (ms: number) => new Date(ms).toLocaleTimeString()) {
  const operation = offer.operation
  const body =
    operation.kind === "apply"
      ? ["Apply the patch above in the fix checkout. Commands: none. Your checkout, index and files are not changed."]
      : operation.kind === "checks"
        ? [
            "Run these checks in the fix checkout, one after another:",
            ...operation.commands.map(
              (command) =>
                `  ${command.argv.map((arg) => visible(arg, false)).join(" ")} in ${visible(command.cwd, false)}`,
            ),
            "Network: off",
            `Each command: at most ${Math.round(operation.timeoutMs / 1_000)} s, and ${Math.round(operation.outputBytes / 1_024)} KiB of its output shown.`,
          ]
        : operation.kind === "commit"
          ? [
              "Commit the applied fix to its new branch with this message:",
              ...operation.message
                .replace(/\n$/, "")
                .split("\n")
                .map((line) => `  ${visible(line, false)}`),
              `Author and committer: ${offer.identity ? `${visible(offer.identity.name, false)} <${visible(offer.identity.email, false)}>` : "unknown"}`,
            ]
          : [
              `Push commit ${operation.commit} to ${visible(operation.remote, false)}`,
              operation.mode === "branch"
                ? "Mode: branch (the commit's new branch only)"
                : "Mode: draft-pr (the commit's new branch only; this step opens no pull request)",
            ]
  return [
    ...body,
    ...offer.notes.map((note) => `Note: ${visible(note, false)}`),
    `This offer can be approved once, until ${time(offer.expiresAt)}.`,
  ]
}

/** A step's result. Check output is the project's own code's output: escaped, shown, never kept. */
export function resultLines(result: ReviewFixControl.Result) {
  if (result.kind === "apply")
    return [
      "Applied in the fix checkout. Your checkout, index and files were not changed.",
      ...result.files.map(
        (file) => `  ${STATUS[file.status]} ${visible(file.path, false)} (+${file.additions} -${file.deletions})`,
      ),
    ]
  if (result.kind === "checks")
    return [
      ...result.results.flatMap((check) => [
        `$ ${check.argv.map((arg) => visible(arg, false)).join(" ")} (in ${visible(check.cwd, false)}): ${check.timedOut ? "timed out" : `exit ${check.exitCode ?? "unknown"}`}, ${check.durationMs} ms`,
        ...(check.output ? [visible(check.output)] : []),
        ...(check.truncated ? ["(output truncated)"] : []),
      ]),
      ...(result.aborted
        ? [
            result.aborted === "head"
              ? "The checks stopped: the reviewed branch moved."
              : "The checks stopped: the fix checkout changed.",
          ]
        : []),
      ...(result.leftovers?.length
        ? [
            `A check left files in the fix checkout: ${result.leftovers.map((file) => visible(file, false)).join(", ")}. No later step runs while they are there; cancel this fix.`,
          ]
        : []),
      `${result.passed ? "Every check passed" : "Not every check passed"}. This is information only: it approves no change, commit or push.`,
    ]
  if (result.kind === "commit")
    return [
      `Committed ${short(result.commit)} on the new branch ${visible(result.branch, false)} as ${visible(result.author.name, false)} <${visible(result.author.email, false)}>. Nothing was pushed.`,
    ]
  return [
    `Pushed ${short(result.commit)} to ${visible(result.remote, false)} as ${visible(result.ref, false)} (${result.mode}).`,
  ]
}
