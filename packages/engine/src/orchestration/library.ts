import path from "node:path"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { LayerNodePlatform } from "@vectordevai/core/effect/app-node-platform"
import { WorkflowSpec } from "@vectordevai/core/orchestration/spec"
import { Workflow } from "@vectordevai/schema/workflow"
import { Config } from "@/config/config"
import { ConfigPaths } from "@/config/paths"
import { PromptTrust } from "@/config/prompt-trust"
import { InstanceState } from "@/effect/instance-state"

export type Entry = Workflow.Saved & { readonly spec?: WorkflowSpec.Spec }

export class LibraryError extends Schema.TaggedErrorClass<LibraryError>()("WorkflowLibrary.LibraryError", {
  name: Schema.String,
  message: Schema.String,
  issues: Schema.Array(Workflow.Issue),
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<readonly Entry[], LibraryError>
  readonly get: (name: string) => Effect.Effect<Entry | undefined, LibraryError>
}
export class Service extends Context.Service<Service, Interface>()("@vector/WorkflowLibrary") {}

/** Policy dependencies are explicit so tests exercise the real loader without mutating process trust state. */
export type Loader = {
  readonly config: Pick<Config.Interface, "get" | "loaded" | "trustedPath">
  readonly fs: FileSystem.FileSystem
  readonly context: { readonly directory: string; readonly worktree?: string }
  readonly allowed: (file: string) => boolean
  readonly locked: () => readonly string[]
}

export const load = Effect.fn("WorkflowLibrary.load")(function* (input: Loader) {
  yield* input.config.get()
  if (input.locked().includes("command")) return []
  const loaded = yield* input.config.loaded()
  const entries: Entry[] = []
  for (const directory of loaded.directories) {
    const project = ConfigPaths.projectContains(directory, input.context)
    const approved = yield* input.config.trustedPath(directory)
    // Project enumeration itself uses the approved snapshot, so new on-disk files
    // cannot enter the library between approval and execution.
    if (project && !approved) continue
    const root = approved ?? directory
    for (const folder of ["workflow", "workflows"]) {
      const names = yield* input.fs
        .readDirectory(path.join(root, folder))
        .pipe(
          Effect.catch((cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed([] as string[])
              : Effect.fail(
                  new LibraryError({ name: "", message: `Cannot list saved workflows: ${cause.message}`, issues: [] }),
                ),
          ),
        )
      for (const filename of names.filter((name) => name.endsWith(".json")).sort()) {
        const logical = path.join(directory, folder, filename)
        const mapped = yield* input.config.trustedPath(logical)
        const owned = ConfigPaths.projectContains(logical, input.context)
        if ((owned && !mapped) || !input.allowed(logical)) continue
        const source = mapped ?? logical
        const name = filename.slice(0, -5)
        const metadata = { name, title: name, source: owned ? ("repository" as const) : ("user" as const), inputs: [] }
        const parsed = yield* read(input.fs, source).pipe(
          Effect.map((text) => WorkflowSpec.parse(text, { source: "saved" })),
          Effect.catch((cause) =>
            Effect.succeed({
              ok: false as const,
              issues: [
                {
                  path: "",
                  message: cause instanceof LibraryError ? cause.message : `Cannot read workflow: ${cause.message}`,
                },
              ],
            }),
          ),
        )
        if (!input.allowed(logical)) continue
        const issues = [
          ...(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)
            ? [
                {
                  path: "/name",
                  message:
                    "Saved workflow names must be 1–64 lowercase letters, digits, underscores or hyphens, starting with a letter or digit.",
                },
              ]
            : []),
          ...parsed.issues,
        ]
        entries.push(
          parsed.ok
            ? {
                ...metadata,
                title: parsed.spec.title,
                ...(parsed.spec.description === undefined ? {} : { description: parsed.spec.description }),
                inputs: Object.entries(parsed.spec.inputs ?? {}).map(([name, input]) => ({
                  name,
                  required: input.required ?? false,
                  ...(input.description === undefined ? {} : { description: input.description }),
                  ...(input.default === undefined ? {} : { default: input.default }),
                })),
                ...(issues.length ? { issues } : { spec: parsed.spec }),
              }
            : { ...metadata, issues },
        )
      }
    }
  }

  // Exact names retain normal project-over-user precedence. Differently cased
  // names are all refused, including collisions with an overridden user entry.
  const spellings = new Map<string, Set<string>>()
  const selected = new Map<string, Entry>()
  for (const entry of entries) {
    const names = spellings.get(entry.name.toLowerCase()) ?? new Set<string>()
    names.add(entry.name)
    spellings.set(entry.name.toLowerCase(), names)
    if (selected.get(entry.name)?.source === "repository" && entry.source === "user") continue
    selected.set(entry.name, entry)
  }
  return [...selected.values()]
    .map((entry): Entry => {
      const names = spellings.get(entry.name.toLowerCase())!
      if (names.size === 1) return entry
      const { spec, ...metadata } = entry
      return {
        ...metadata,
        issues: [
          ...(entry.issues ?? []),
          {
            path: "/name",
            message: `Case-colliding saved workflow names are refused: ${[...names].sort().join(", ")}.`,
          },
        ],
      }
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
})

/** Read at most the byte ceiling plus one, even if a file grows after stat. */
const read = Effect.fn("WorkflowLibrary.read")(function* (fs: FileSystem.FileSystem, file: string) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const before = yield* fs.stat(file)
      if (before.type !== "File")
        return yield* new LibraryError({
          name: "",
          message: "A saved workflow must be a regular JSON file.",
          issues: [],
        })
      const handle = yield* fs.open(file, { flag: "r" })
      const info = yield* handle.stat
      if (info.type !== "File")
        return yield* new LibraryError({
          name: "",
          message: "A saved workflow must be a regular JSON file.",
          issues: [],
        })
      if (info.size > BigInt(WorkflowSpec.BYTES.saved))
        return yield* new LibraryError({ name: "", message: "A saved workflow must be at most 256 KiB.", issues: [] })
      const chunks: Uint8Array[] = []
      let bytes = 0
      while (bytes <= WorkflowSpec.BYTES.saved) {
        const chunk = yield* handle.readAlloc(Math.min(64 * 1024, WorkflowSpec.BYTES.saved + 1 - bytes))
        if (Option.isNone(chunk) || chunk.value.byteLength === 0) break
        chunks.push(chunk.value)
        bytes += chunk.value.byteLength
      }
      if (bytes > WorkflowSpec.BYTES.saved)
        return yield* new LibraryError({ name: "", message: "A saved workflow must be at most 256 KiB.", issues: [] })
      return Buffer.concat(chunks).toString("utf8")
    }),
  )
})

export function select(entries: readonly Entry[], name: string): Effect.Effect<Entry | undefined, LibraryError> {
  const entry = entries.find((entry) => entry.name === name)
  if (!entry) return Effect.succeed(undefined)
  if (entry.issues?.length || !entry.spec)
    return Effect.fail(
      new LibraryError({ name, message: `Saved workflow "${name}" is invalid.`, issues: entry.issues ?? [] }),
    )
  return Effect.succeed(entry)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FileSystem.FileSystem
    const list = Effect.fn("WorkflowLibrary.list")(function* () {
      return yield* load({
        config,
        fs,
        context: yield* InstanceState.context,
        allowed: PromptTrust.allowed,
        locked: Config.lockedKeys,
      })
    })
    return Service.of({
      list,
      get: Effect.fn("WorkflowLibrary.get")(function* (name) {
        return yield* select(yield* list(), name)
      }),
    })
  }),
)
export const node = LayerNode.make({ service: Service, layer, deps: [Config.node, LayerNodePlatform.filesystem] })

export * as WorkflowLibrary from "./library"
