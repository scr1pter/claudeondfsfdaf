import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { WorkflowPlan } from "@vectordevai/core/orchestration/plan"
import { WorkflowPredicate } from "@vectordevai/core/orchestration/predicate"
import { WorkflowSpec } from "@vectordevai/core/orchestration/spec"
import { WorkflowTemplate } from "@vectordevai/core/orchestration/template"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { Glob } from "@vectordevai/core/util/glob"
import { InstanceState } from "@/effect/instance-state"
import { Git } from "@/git"
import { WorkflowMarkers } from "./constants"

type Json = typeof Schema.Json.Type
export type Item = { readonly key: string; readonly value: Json; readonly source?: string }
export type Output = { readonly stage: string; readonly key: string; readonly value: Json }
export type From = Extract<WorkflowSpec.Source, { readonly from: unknown }>

export class SourceError extends Schema.TaggedErrorClass<SourceError>()("WorkflowSources.SourceError", {
  code: Schema.Literals(["files", "git", "limit", "path"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly initial: (source?: WorkflowSpec.Source) => Effect.Effect<readonly Item[], SourceError>
}
export class Service extends Context.Service<Service, Interface>()("@vector/WorkflowSources") {}

const CANDIDATES = 10_000
const GIT_BYTES = 2 * 1024 * 1024

/** Enumerate only local inputs. Upstream output sources are projected as nodes settle. */
export const initial = Effect.fn("WorkflowSources.initial")(function* (
  source: WorkflowSpec.Source | undefined,
  input: {
    readonly cwd: string
    readonly git: Pick<Git.Interface, "run">
    readonly ripgrep: Pick<Ripgrep.Interface, "glob">
  },
) {
  if (!source) return [{ key: WorkflowPlan.key({ single: true }), value: null }] satisfies Item[]
  if ("from" in source) return []
  if ("items" in source) {
    const occurrences = new Map<string, number>()
    return source.items.map((value) => {
      const content = WorkflowPlan.key(value)
      const occurrence = occurrences.get(content) ?? 0
      occurrences.set(content, occurrence + 1)
      return { key: WorkflowPlan.key({ literal: content, occurrence }), value }
    })
  }
  if ("files" in source) {
    const found = yield* input.ripgrep
      .glob({
        cwd: input.cwd,
        pattern: source.files.glob,
        hidden: source.files.hidden ?? false,
        follow: false,
        limit: CANDIDATES + 1,
      })
      .pipe(Effect.mapError((error) => new SourceError({ code: "files", message: error.message })))
    if (found.length > CANDIDATES)
      return yield* new SourceError({
        code: "limit",
        message: `The files source matched more than ${CANDIDATES} candidates; narrow its glob.`,
      })
    const files = found
      .map((entry) => entry.path)
      .filter(
        (file) =>
          (source.files.hidden || !file.split("/").some((part) => part.startsWith("."))) &&
          !(source.files.exclude ?? []).some((pattern) => Glob.match(pattern, file)),
      )
    return yield* paths(files, source.files.limit)
  }

  const run = (args: string[]) =>
    input.git.run(args, { cwd: input.cwd, maxOutputBytes: GIT_BYTES }).pipe(
      Effect.flatMap((result) =>
        result.exitCode !== 0
          ? Effect.fail(
              new SourceError({
                code: "git",
                message:
                  result.stderr.toString("utf8").trim().slice(0, 1024) ||
                  "Cannot read changed files from this repository.",
              }),
            )
          : result.truncated
            ? Effect.fail(
                new SourceError({
                  code: "limit",
                  message: "The changed-files listing exceeded 2 MiB; narrow the repository changes.",
                }),
              )
            : Effect.succeed(result.text()),
      ),
    )
  // With no base, enumerate staged, unstaged and untracked changes. An explicit
  // base compares its resolved commit to the working tree, plus untracked files.
  const prefix = (yield* run(["rev-parse", "--show-prefix"])).replace(/\r?\n$/, "")
  const status = (yield* run(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."]))
    .split("\0")
    .filter(Boolean)
    .map((entry) => ({ code: entry.slice(0, 2), file: entry.slice(3) }))
  const changed = source.changed_files.base
    ? yield* Effect.gen(function* () {
        const commit = (yield* run([
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${source.changed_files.base}^{commit}`,
        ])).trim()
        if (!/^[a-f0-9]{40,64}$/i.test(commit))
          return yield* new SourceError({ code: "git", message: "The changed-files base did not resolve to a commit." })
        const entries = (yield* run([
          "diff",
          "--no-ext-diff",
          "--no-renames",
          "--no-relative",
          "--name-status",
          "-z",
          commit,
          "--",
          ".",
        ]))
          .split("\0")
          .filter(Boolean)
        return [
          ...entries.flatMap((code, index) =>
            index % 2 === 0 && entries[index + 1] ? [{ code, file: entries[index + 1] }] : [],
          ),
          ...status.filter((entry) => entry.code === "??"),
        ]
      })
    : status
  const files = changed
    .filter((entry) => source.changed_files.include_deleted || !entry.code.includes("D"))
    .flatMap((entry) => (!prefix || entry.file.startsWith(prefix) ? [entry.file.slice(prefix.length)] : []))
    .filter(
      (file) =>
        !source.changed_files.include?.length ||
        source.changed_files.include.some((pattern) => Glob.match(pattern, file)),
    )
  return yield* paths(files, source.changed_files.limit)
})

function paths(files: readonly string[], limit?: number) {
  const invalid = files.find(
    (file) =>
      !file ||
      path.isAbsolute(file) ||
      /^[A-Za-z]:/.test(file) ||
      file.split(/[\\/]/).includes("..") ||
      file.includes("\0"),
  )
  if (invalid !== undefined)
    return Effect.fail(
      new SourceError({
        code: "path",
        message: "A workflow file source returned a path outside the current directory.",
      }),
    )
  const unique = [...new Set(files)].sort()
  if (limit === undefined && unique.length > 1000)
    return Effect.fail(
      new SourceError({
        code: "limit",
        message: "The file source matched more than 1,000 files; narrow it or set an explicit limit.",
      }),
    )
  return Effect.succeed(unique.slice(0, limit).map((value) => ({ key: WorkflowPlan.key({ file: value }), value })))
}

/**
 * The caller supplies cumulative outputs in settlement order and admits each returned key once.
 * A settled node's key and projected element index give duplicate values distinct identities.
 */
export function project(
  source: From,
  outputs: readonly Output[],
  state: { readonly complete: boolean },
): readonly Item[] {
  return [...iterate(source, outputs, state)]
}

/** Pull only as many candidates as the scheduler can admit; buffered sorts and dedupe have visible safety bounds. */
export function* iterate(
  source: From,
  outputs: readonly Output[],
  state: { readonly complete: boolean },
): Generator<Item> {
  if (!state.complete && (source.wait === "all" || source.sort_by)) return
  const stages = new Set(typeof source.from === "string" ? [source.from] : source.from)
  const seen = new Set<string>()
  function* selected() {
    for (const output of outputs) {
      if (!stages.has(output.stage)) continue
      const value = source.path ? WorkflowTemplate.lookup(output.value, source.path.split("."), true) : output.value
      if (value === undefined) continue
      const values = Array.isArray(value) ? value : [value]
      for (let index = 0; index < values.length; index++) {
        const item = values[index]
        if (!WorkflowPredicate.evaluate(source.where, item)) continue
        const dedupe = source.dedupe_by ? WorkflowTemplate.lookup(item, source.dedupe_by.split(".")) : undefined
        if (dedupe !== undefined) {
          const key = WorkflowPlan.key(dedupe)
          if (seen.has(key)) continue
          if (seen.size >= WorkflowMarkers.MAX_BUFFERED_ITEMS)
            throw new SourceError({
              code: "limit",
              message: "Workflow dedupe exceeded 32,000 distinct buffered keys; narrow the source.",
            })
          seen.add(key)
        }
        yield {
          key: WorkflowPlan.key({ stage: output.stage, node: output.key, path: source.path, index, value: item }),
          value: item as Json,
          source: `${output.stage}#${output.key}:${index}`,
        }
      }
    }
  }
  const buffered: Item[] = []
  if (source.sort_by) {
    for (const item of selected()) {
      if (buffered.length >= WorkflowMarkers.MAX_BUFFERED_ITEMS)
        throw new SourceError({
          code: "limit",
          message: "Workflow sorting exceeded 32,000 buffered items; narrow the source.",
        })
      buffered.push(item)
    }
    buffered.sort((left, right) => {
      const a = WorkflowTemplate.lookup(left.value, source.sort_by!.split("."))
      const b = WorkflowTemplate.lookup(right.value, source.sort_by!.split("."))
      if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
      return compare(a, b) * (source.desc ? -1 : 1)
    })
  }
  const batch = (members: Item[]): Item => ({
    key: WorkflowPlan.key({ members: members.map((member) => member.key) }),
    value: members.map((member) => member.value),
    source: members.map((member) => member.source).join(","),
  })
  let members: Item[] = []
  let count = 0
  for (const item of source.sort_by ? buffered : selected()) {
    if (source.limit !== undefined && count >= source.limit) break
    count += 1
    if (!source.batch) yield item
    if (source.batch) {
      members.push(item)
      if (members.length === source.batch) {
        yield batch(members)
        members = []
      }
    }
    if (source.limit !== undefined && count >= source.limit) break
  }
  if (state.complete && members.length) yield batch(members)
}

function compare(left: unknown, right: unknown) {
  if (typeof left === "number" && typeof right === "number") return left - right
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0
  const a = WorkflowPlan.canonical(left)
  const b = WorkflowPlan.canonical(right)
  return a < b ? -1 : a > b ? 1 : 0
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const git = yield* Git.Service
    const ripgrep = yield* Ripgrep.Service
    return Service.of({
      initial: Effect.fn("WorkflowSources.Service.initial")(function* (source) {
        return yield* initial(source, { cwd: yield* InstanceState.directory, git, ripgrep })
      }),
    })
  }),
)
export const node = LayerNode.make({ service: Service, layer, deps: [Git.node, Ripgrep.node] })

export * as WorkflowSources from "./sources"
