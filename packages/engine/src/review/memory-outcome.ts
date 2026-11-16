export * as ReviewMemoryOutcome from "./memory-outcome"

import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { Cause, Effect, Option, Schema } from "effect"
import type { ReviewMemory } from "@vectordevai/core/brain/review-memory"
import { Database } from "@vectordevai/core/database/database"
import { decodeLocalResult } from "@vectordevai/core/review/local-result"
import { ReviewRequestStore } from "@vectordevai/core/review/request-store"
import { ReviewRequestTable } from "@vectordevai/core/review/request.sql"
import { ReviewSourceBinding } from "@vectordevai/core/review/source-binding"
import { ReviewMemoryControl } from "@vectordevai/schema/review-memory"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import type { ReadAuthority } from "./read-authority"
import { ReviewGit } from "./git"
import { ReviewLifecycle } from "./lifecycle"
import { ReviewMemoryScope } from "./memory-scope"

export const LIMIT = Object.freeze({
  files: 40,
  captures: 8,
  citations: 8,
  quote: 500,
  blob: 1024 * 1024,
  evidence: 8192,
})
export class Refused extends Schema.TaggedErrorClass<Refused>()("ReviewMemoryOutcome.Refused", {
  code: Schema.Literals(["invalid", "unavailable", "unsupported", "stale", "quote-mismatch", "limit"]),
  message: Schema.String,
}) {}
const refused = (code: Refused["code"]) =>
  new Refused({
    code,
    message: "Exact committed-head evidence is unavailable for this review outcome. No memory was proposed.",
  })
const pathValue = (value: string) =>
  value.length > 0 &&
  value.length <= 512 &&
  !/[\\:*?\x00-\x1f\x7f]/.test(value) &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
const sourceInput = Schema.Struct({
  parentID: SessionID,
  reviewID: SessionID,
  files: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(LIMIT.files)),
}).annotate({ parseOptions: { onExcessProperty: "error" } })
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const frozen = <A>(value: A): A => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen)
    Object.freeze(value)
  }
  return value
}

/** A token, not a serializable verification marker. Only this collector can mint a recognized handle. */
export interface Handle {
  readonly _tag: "ReviewMemoryOutcome.Handle"
}
export interface Evidence {
  readonly kind: "committed-head"
  readonly source: ReviewMemory.Source
  readonly scope: string
  readonly sourceBindingSha256: string
  readonly finding: { readonly id: string; readonly path: string; readonly line: number; readonly sha256: string }
  readonly artifact: { readonly sha256: string; readonly bytes: number }
  readonly citations: readonly ReviewMemory.Citation[]
}
export interface Interface {
  readonly capture: (artifact: unknown, findingID: unknown) => Effect.Effect<Handle, Refused>
  readonly inspect: (handle: unknown, artifact: unknown) => Effect.Effect<Evidence, Refused>
  readonly release: (handle: unknown) => void
}

/**
 * Inactive collector only. Its source selectors do not grant authority: opening
 * needs a live admitted private view, a genuine running reservation and an
 * internal read policy. No owner/propose/reopen or persistence operation exists.
 * A future trusted integration must retain evidence before that view closes;
 * neither a legacy artifact nor caller JSON can reconstruct this verification.
 */
export const open = Effect.fn("ReviewMemoryOutcome.open")(function* (input: unknown, reads: ReadAuthority) {
  const parsed = Schema.decodeUnknownOption(sourceInput)(input)
  if (
    Option.isNone(parsed) ||
    parsed.value.parentID === parsed.value.reviewID ||
    parsed.value.files.some((file) => !pathValue(file)) ||
    !reads ||
    typeof reads.denied !== "function" ||
    typeof reads.patternsFor !== "function"
  )
    return yield* refused("invalid")
  const selectors = frozen(structuredClone(parsed.value))
  const files = new Set(selectors.files)
  const denied = reads.denied
  const view = yield* ReviewGit.Current
  const ownerNonce = yield* ReviewLifecycle.Current
  if (!view || !ownerNonce) return yield* refused("unavailable")
  const requests = yield* ReviewRequestStore.Service
  const database = yield* Database.Service
  const lifecycle = yield* ReviewLifecycle.Service
  const handles = new WeakMap<object, Evidence>()
  const count = { value: 0 }
  const binding: { value?: ReviewSourceBinding.Info; request?: ReviewRun.Start } = {}
  const current = Effect.gen(function* () {
    if ((yield* ReviewGit.Current) !== view || (yield* ReviewLifecycle.Current) !== ownerNonce)
      return yield* refused("unavailable")
    if (!view.repository.isOpen()) return yield* refused("unavailable")
    yield* view.preflight().pipe(Effect.mapError(() => refused("unavailable")))
    const snapshot = yield* requests
      .sourceSnapshot(selectors.parentID, selectors.reviewID)
      .pipe(Effect.mapError(() => refused("unavailable")))
    if (!snapshot?.sourceBinding || snapshot.phase !== "running") return yield* refused("unavailable")
    // ready() is deliberately pre-start/attached-only. This bounded read proves
    // the exact running collector without changing that admission contract.
    const owners = yield* database.db
      .select({ nonce: ReviewRequestTable.owner_nonce })
      .from(ReviewRequestTable)
      .where(
        and(
          eq(ReviewRequestTable.parent_session_id, selectors.parentID),
          eq(ReviewRequestTable.run_id, selectors.reviewID),
          eq(ReviewRequestTable.request_id, snapshot.request.requestID),
          eq(ReviewRequestTable.owner_nonce, ownerNonce),
          eq(ReviewRequestTable.phase, "running"),
        ),
      )
      .limit(2)
      .all()
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(refused("unavailable")),
        ),
      )
    if (owners.length !== 1) return yield* refused("unavailable")
    const original = snapshot.sourceBinding
    const scope = ReviewMemoryScope.repositoryScope(view.repository)
    if (
      !scope ||
      scope !== original.scope ||
      view.repository.head !== snapshot.request.target.head ||
      view.metadata.head !== snapshot.request.target.head ||
      view.repository.directory !== original.worktree ||
      view.metadata.directory !== original.worktree ||
      view.repository.gitDirectory !== original.gitDirectory ||
      view.metadata.gitDirectory !== original.gitDirectory ||
      view.repository.commonDirectory !== original.commonDirectory ||
      view.metadata.commonDirectory !== original.commonDirectory ||
      (binding.value && JSON.stringify(original) !== JSON.stringify(binding.value)) ||
      (binding.request && JSON.stringify(snapshot.request) !== JSON.stringify(binding.request))
    )
      return yield* refused("stale")
    return snapshot
  })
  const within = <A, E>(effect: Effect.Effect<A, E>) =>
    lifecycle
      .within(
        selectors.parentID,
        selectors.reviewID,
      )(effect)
      .pipe(Effect.mapError((error) => (error instanceof Refused ? error : refused("unavailable"))))
  const initial = yield* within(current)
  binding.value = frozen(structuredClone(initial.sourceBinding!))
  binding.request = frozen(structuredClone(initial.request))
  const target = frozen(structuredClone(initial.request.target))
  const source = frozen({ parentID: selectors.parentID, reviewID: selectors.reviewID, head: target.head })
  const artifact = (input: unknown) => {
    const value = Schema.decodeUnknownOption(ReviewRun.Artifact, { onExcessProperty: "error" })(input)
    if (Option.isNone(value)) return undefined
    const descriptor = Object.freeze({
      version: value.value.version,
      json: value.value.json,
      bytes: value.value.bytes,
      sha256: value.value.sha256,
    })
    if (Buffer.byteLength(descriptor.json) !== descriptor.bytes || sha(descriptor.json) !== descriptor.sha256)
      return undefined
    const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(descriptor.json)
    const result = Option.isSome(json) ? decodeLocalResult(json.value, target) : undefined
    return result?.outcome ? { artifact: descriptor, result: result.outcome } : undefined
  }
  const readable = (file: string) =>
    Effect.try({
      try: () => pathValue(file) && files.has(file) && !denied(file),
      catch: () => refused("unavailable"),
    }).pipe(Effect.flatMap((allowed) => (allowed ? Effect.void : Effect.fail(refused("unavailable")))))
  const object = (operation: Parameters<typeof view.repository.read>[0]) =>
    Effect.tryPromise({
      try: () => view.repository.read(operation),
      catch: () => refused("unavailable"),
    })
  const inspect: Interface["inspect"] = (handle, inputArtifact) =>
    within(
      Effect.gen(function* () {
        if (!handle || typeof handle !== "object") return yield* refused("invalid")
        const evidence = handles.get(handle)
        const retained = artifact(inputArtifact)
        if (
          !evidence ||
          !retained ||
          evidence.artifact.sha256 !== retained.artifact.sha256 ||
          evidence.artifact.bytes !== retained.artifact.bytes
        )
          return yield* refused("invalid")
        yield* current
        for (const citation of evidence.citations) yield* readable(citation.path)
        // No await may separate these ownership/lifetime witnesses from publication.
        if (handles.get(handle) !== evidence) return yield* refused("invalid")
        if (!view.repository.isOpen()) return yield* refused("unavailable")
        return evidence
      }),
    )
  return {
    capture: (inputArtifact, findingID) =>
      within(
        Effect.gen(function* () {
          yield* current
          if (!Schema.is(ReviewMemoryControl.ID)(findingID)) return yield* refused("invalid")
          const retained = artifact(inputArtifact)
          if (!retained) return yield* refused("invalid")
          const selected = retained.result.selection
          const findings = [
            ...selected.inline,
            ...selected.outsideDiff,
            ...selected.elsewhere,
            ...selected.nits,
            ...selected.overflow,
          ].filter((finding) => finding.id === findingID)
          if (findings.length !== 1) return yield* refused("invalid")
          const finding = findings[0]!
          if (finding.side !== "RIGHT" || !finding.quotes?.length) return yield* refused("unsupported")
          if (finding.quotes.length > LIMIT.citations || count.value >= LIMIT.captures) return yield* refused("limit")
          yield* readable(finding.path)
          const citations: ReviewMemory.Citation[] = []
          for (const quote of finding.quotes) {
            const file = quote.path || finding.path
            if (quote.side !== "RIGHT") return yield* refused("unsupported")
            if (
              !Number.isSafeInteger(quote.line) ||
              quote.line <= 0 ||
              quote.line > 10_000_000 ||
              !quote.code.trim() ||
              quote.code.length > LIMIT.quote ||
              Buffer.byteLength(quote.code) > LIMIT.quote
            )
              return yield* refused("limit")
            yield* readable(file)
            yield* current
            const tree = yield* object({ kind: "tree", revision: source.head, file })
            const entry = tree.bytes.toString("utf8")
            const boundary = entry.indexOf("\t")
            const header = entry.slice(0, boundary).split(" ")
            if (
              tree.code !== 0 ||
              tree.bytes.length > 1024 ||
              boundary < 0 ||
              entry.slice(boundary + 1) !== file + "\0" ||
              header.length !== 3 ||
              !["100644", "100755"].includes(header[0]!) ||
              header[1] !== "blob" ||
              !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(header[2]!)
            )
              return yield* refused("unavailable")
            const size = yield* object({ kind: "object", action: "size", revision: source.head, file })
            const amount = size.bytes.toString("ascii").trim()
            if (
              size.code !== 0 ||
              size.bytes.length > 20 ||
              !/^(?:0|[1-9][0-9]*)$/.test(amount) ||
              Number(amount) > LIMIT.blob
            )
              return yield* refused("unavailable")
            const blob = yield* object({ kind: "object", action: "blob", revision: source.head, file })
            if (blob.code !== 0 || blob.bytes.length !== Number(amount) || blob.bytes.includes(0))
              return yield* refused("unavailable")
            const objectID = createHash(header[2]!.length === 40 ? "sha1" : "sha256")
              .update(`blob ${blob.bytes.byteLength}\0`)
              .update(blob.bytes)
              .digest("hex")
            if (objectID !== header[2]) return yield* refused("unavailable")
            const text = blob.bytes.toString("utf8")
            if (!Buffer.from(text).equals(blob.bytes)) return yield* refused("unavailable")
            const lines = text.split("\n")
            const trailing = quote.code.endsWith("\n")
            const length = quote.code.split("\n").length - (trailing ? 1 : 0)
            const end = quote.line - 1 + length
            const actual = lines.slice(quote.line - 1, end).join("\n") + (trailing && end < lines.length ? "\n" : "")
            if (actual !== quote.code || end > lines.length) return yield* refused("quote-mismatch")
            citations.push(frozen({ path: file, line: quote.line, head: source.head, quote: quote.code }))
          }
          yield* current
          for (const citation of citations) yield* readable(citation.path)
          const evidence: Evidence = frozen({
            kind: "committed-head",
            source,
            scope: binding.value!.scope,
            sourceBindingSha256: sha(JSON.stringify(binding.value)),
            finding: { id: findingID, path: finding.path, line: finding.line, sha256: sha(JSON.stringify(finding)) },
            artifact: { sha256: retained.artifact.sha256, bytes: retained.artifact.bytes },
            citations,
          })
          if (Buffer.byteLength(JSON.stringify(evidence)) > LIMIT.evidence || count.value >= LIMIT.captures)
            return yield* refused("limit")
          // The final read policy can synchronously close the admitted view.
          if (!view.repository.isOpen()) return yield* refused("unavailable")
          count.value++
          const handle = Object.freeze({ _tag: "ReviewMemoryOutcome.Handle" as const })
          handles.set(handle, evidence)
          return handle
        }),
      ),
    inspect,
    release: (handle) => {
      if (handle && typeof handle === "object") handles.delete(handle)
    },
  } satisfies Interface
})
