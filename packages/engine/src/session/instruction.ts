import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { httpClient } from "@vectordevai/core/effect/app-node-platform"
import path from "path"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { Effect, Layer, Context, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Config } from "@/config/config"
import { PromptTrust } from "@/config/prompt-trust"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@vectordevai/core/flag/flag"
import { FSUtil } from "@vectordevai/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Global } from "@vectordevai/core/global"
import { WebFetchRequest } from "@vectordevai/core/util/webfetch-request"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { EgressHttpClient } from "@vectordevai/core/local-mode/http-client"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { collectBoundedResponseBody } from "@vectordevai/core/tool/http-body"
import { containsPath } from "@/project/instance-context"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainPaths } from "@vectordevai/core/brain/paths"
import { Project } from "@vectordevai/core/project"
import type { MessageID } from "./schema"

/** Memory entries attached to a read result are recorded in its `loaded` metadata as `memory:<id>,<id>`. */
export const MEMORY_LOADED = "memory:"

/** Document cards a read pointed at are recorded in its `loaded` metadata as `knowledge:<id>,<id>`. */
export const KNOWLEDGE_LOADED = "knowledge:"

/**
 * Metadata key of the code-link lines a tool result carries: `{ mode, file, ids }[]`. A read points at what is linked
 * to the file it read; an edit, write or patch names the requirements linked to a file it changed (the spec guard).
 * The output holds a placeholder for each line, which every request renders again from the brain, so a forgotten
 * document is gone from old results too, and a private one stays out where private documents may not go.
 */
export const LINKS = "vector.memory.links"

export type Link = { readonly mode: "pointer" | "guard"; readonly file: string; readonly ids: readonly string[] }

// How many remote instruction URLs, and texts of each, are remembered for the research check.
const REMOTE_URLS = 32
const REMOTE_VERSIONS = 4

/** What the spec guard's lines add to one request at most, rendered again for each request. */
export const GUARD = { tokens: 200 } as const

/** The placeholder a code-link line is saved as. */
export function linked(mode: Link["mode"], file: string) {
  return mode === "pointer" ? `[documents linked to ${file}]` : `[requirements linked to ${file}]`
}

/**
 * Who a tool call's code-link lines are for: whether personal memory and private documents may go to its model, the
 * request's size (Chat gets none, and the spec guard is for Standard and Thorough work), and the ids the conversation
 * already has.
 */
export type Asking = {
  readonly sessionID: string
  readonly personal: boolean
  readonly tier?: "chat" | "light" | "standard" | "thorough"
  readonly exclude: ReadonlySet<string>
}

function extract(messages: SessionV1.WithParts[]) {
  const paths = new Set<string>()
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted) continue
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p !== "string") continue
          if (!p.startsWith(MEMORY_LOADED)) {
            paths.add(p)
            continue
          }
          for (const id of p.slice(MEMORY_LOADED.length).split(",")) paths.add(`${MEMORY_LOADED}${id}`)
        }
      }
    }
  }
  return paths
}

/** The memory entries already attached to read results in this history. */
export function attachedMemory(messages: SessionV1.WithParts[]) {
  return new Set(
    [...extract(messages)].flatMap((item) =>
      item.startsWith(MEMORY_LOADED) ? [item.slice(MEMORY_LOADED.length)] : [],
    ),
  )
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  /** The spec guard for files a tool changed: once per file per request, never for Chat or Light requests. */
  readonly guard: (
    messages: SessionV1.WithParts[],
    files: readonly string[],
    messageID: MessageID,
    asking: Asking,
  ) => Effect.Effect<{ readonly text?: string; readonly links: readonly Link[] }>
  /** Where this instance's requests run, as the brain needs it: the repository, its rules and memory files, trust. */
  readonly place: () => Effect.Effect<Brain.Place>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error>
  readonly system: () => Effect.Effect<string[], FSUtil.Error>
  /**
   * What system() puts in a prompt, by whose it is: the repository's own instruction files are the work; the user's
   * (their global files, configured files outside the repository, remote instructions) private. Remote instructions
   * are the texts prompts in this process were sent, never fetched again here.
   */
  readonly contents: () => Effect.Effect<{ readonly work: string[]; readonly private: string[] }, FSUtil.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  /** Instruction files near a file, the memory about it, and with `asking`, the line naming what is linked to it. */
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
    asking?: Asking,
  ) => Effect.Effect<{ filepath: string; content: string; link?: Link }[], FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@vector/Instruction") {}

const layer: Layer.Layer<
  Service,
  never,
  | FSUtil.Service
  | Config.Service
  | Global.Service
  | HttpClient.HttpClient
  | RuntimeFlags.Service
  | Brain.Service
  | BrainKnowledge.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const brain = yield* Brain.Service
    const knowledge = yield* BrainKnowledge.Service
    const http = HttpClient.filterStatusOk(withTransientReadRetry(EgressHttpClient.make(yield* HttpClient.HttpClient)))
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]
    // RULES.md (repository and global), MEMORY.md and the legacy BRAIN.md are no longer loaded whole here: the brain
    // mirrors them and sends rules whole, MEMORY.md to its budget, and the rest only when relevant (see Brain).
    const memoryFiles = [
      { file: ".vector/RULES.md", type: "rules" as const },
      { file: ".vector/BRAIN.md", type: "brain" as const },
      { file: "BRAIN.md", type: "brain" as const },
    ]

    // The remote instructions prompts in this process were sent, by URL: each one's latest few texts.
    const fetched = new Map<string, string[]>()

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string) {
      const ctx = yield* InstanceState.context
      if (!Flag.VECTOR_DISABLE_PROJECT_CONFIG) {
        return yield* fs
          .globUp(instruction, ctx.directory, ctx.worktree)
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      }
      return yield* fs
        .globUp(instruction, global.config, global.config)
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    })

    const read = Effect.fnUntraced(function* (filepath: string) {
      return (yield* fs.readFileStringSafe(filepath)) ?? ""
    })

    // Every instruction file goes to the model with the system prompt, and a repository can ship AGENTS.md as a link to
    // ../../.ssh/id_rsa. A file inside the project is read only where it really lands inside the project; one found
    // above a directory that is not a git repository is the user's own.
    const landsInProject = Effect.fnUntraced(function* (file: string) {
      const ctx = yield* InstanceState.context
      if (!containsPath(file, ctx)) return true
      // A link that cannot be resolved (a loop) cannot be read either, and the read reports it.
      const resolved = yield* Effect.try({ try: () => FSUtil.realpath(file), catch: (error) => error }).pipe(
        Effect.option,
      )
      if (Option.isNone(resolved)) return true
      const target = resolved.value
      if (
        containsPath(target, {
          ...ctx,
          directory: FSUtil.realpath(ctx.directory),
          worktree: FSUtil.realpath(ctx.worktree),
        })
      )
        return true
      yield* Effect.logWarning("not loading a project instruction file that links outside the project", {
        file,
        target,
      })
      return false
    })

    const projectFiles = (found: Effect.Effect<string[], unknown>) =>
      found.pipe(
        Effect.catch(() => Effect.succeed([] as string[])),
        Effect.flatMap((matches) => Effect.filter(matches, landsInProject)),
      )

    const fetch = Effect.fnUntraced(function* (url: string) {
      // Instruction URLs are remote config: with Vector Local on, one that is not on this computer or the list, or
      // allowed, is skipped without a request, and the rest are decided and logged as they are sent.
      const decided = LocalPolicy.decide(Egress.policy(), { purpose: "config-remote", url, source: "remote-config" })
      if (decided.decision !== "allow") return ""
      // Instruction URLs come from the user's own config (or a project they trusted), so an intranet page is fine.
      return yield* WebFetchRequest.execute(http, HttpClientRequest.get(url), {
        authorize: () => Effect.void,
        authorizePrivate: () => Effect.void,
      }).pipe(
        Effect.flatMap((response) =>
          collectBoundedResponseBody(response, 1024 * 1024, () => new Error("Remote instructions exceed 1 MiB")),
        ),
        Effect.map((body) => new TextDecoder().decode(body)),
        Effect.scoped,
        Effect.timeout(5000),
        EgressHttpClient.labelled("remote-config"),
        Effect.catch(() => Effect.succeed("")),
      )
    })

    const place = Effect.fn("Instruction.place")(function* () {
      const ctx = yield* InstanceState.context
      // A repository's rules and memory are still its own files, so VECTOR_DISABLE_PROJECT_CONFIG skips them: a code
      // review runs on a pull request's tree and must not take instructions from it.
      const sources = Flag.VECTOR_DISABLE_PROJECT_CONFIG
        ? []
        : yield* Effect.forEach(memoryFiles, (item) =>
            projectFiles(fs.findUp(item.file, ctx.directory, ctx.worktree)).pipe(
              Effect.map((matches) => matches.map((match) => ({ path: path.resolve(match), type: item.type }))),
            ),
          ).pipe(Effect.map((found) => found.flat()))
      const trust = yield* cfg.trust()
      return {
        // Every worktree and Parallel Workspace of a repository shares its memory; a folder outside git has its own.
        repository: ctx.project.id === Project.ID.global ? BrainPaths.folderKey(ctx.directory) : ctx.project.id,
        root: ctx.worktree === "/" ? ctx.directory : ctx.worktree,
        sources,
        // Memory a repository ships waits for review while its own settings are untrusted.
        held: !trust.trusted && trust.settings,
      } satisfies Brain.Place
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      s.claims.delete(messageID)
    })

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      const config = yield* cfg.get()
      const ctx = yield* InstanceState.context
      const paths = new Set<string>()

      for (const file of globalFiles) {
        if (yield* fs.existsSafe(file)) {
          paths.add(path.resolve(file))
          break
        }
      }

      // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
      if (!Flag.VECTOR_DISABLE_PROJECT_CONFIG) {
        for (const file of instructionFiles) {
          const matches = yield* projectFiles(fs.findUp(file, ctx.directory, ctx.worktree))
          if (matches.length > 0) {
            matches.forEach((item) => paths.add(path.resolve(item)))
            break
          }
        }
      }

      if (config.instructions) {
        for (const raw of config.instructions) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) continue
          const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
          const matches = yield* path.isAbsolute(instruction)
            ? fs
                .glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                })
                .pipe(Effect.catch(() => Effect.succeed([] as string[])))
            : projectFiles(relative(instruction))
          matches.forEach((item) => paths.add(path.resolve(item)))
        }
      }

      // An instruction file outside the repository that changed since the owner last approved it waits for them. A held
      // global AGENTS.md keeps its place, so CLAUDE.md does not stand in for it.
      return new Set([...paths].filter(PromptTrust.allowed))
    })

    const system = Effect.fn("Instruction.system")(function* () {
      const config = yield* cfg.get()
      const paths = yield* systemPaths()
      const urls = (config.instructions ?? []).filter(
        (item) => item.startsWith("https://") || item.startsWith("http://"),
      )

      const files = yield* Effect.forEach(Array.from(paths), read, { concurrency: 8 })
      const remote = yield* Effect.forEach(urls, fetch, { concurrency: 4 })
      urls.forEach((url, i) => {
        if (!remote[i]) return
        const known = (fetched.get(url) ?? []).filter((text) => text !== remote[i])
        fetched.delete(url)
        fetched.set(url, [...known, remote[i]].slice(-REMOTE_VERSIONS))
        if (fetched.size > REMOTE_URLS) fetched.delete(fetched.keys().next().value!)
      })

      return [
        ...Array.from(paths).flatMap((item, i) => (files[i] ? [`Instructions from: ${item}\n${files[i]}`] : [])),
        ...urls.flatMap((item, i) => (remote[i] ? [`Instructions from: ${item}\n${remote[i]}`] : [])),
      ]
    })

    const contents = Effect.fn("Instruction.contents")(function* () {
      const ctx = yield* InstanceState.context
      const config = yield* cfg.get()
      const paths = Array.from(yield* systemPaths())
      const files = yield* Effect.forEach(paths, read, { concurrency: 8 })
      const local = paths.flatMap((item, i) =>
        files[i] ? [{ text: `Instructions from: ${item}\n${files[i]}`, own: containsPath(item, ctx) }] : [],
      )
      return {
        work: local.flatMap((item) => (item.own ? [item.text] : [])),
        private: [
          ...local.flatMap((item) => (item.own ? [] : [item.text])),
          ...(config.instructions ?? []).flatMap((url) =>
            (fetched.get(url) ?? []).map((text) => `Instructions from: ${url}\n${text}`),
          ),
        ],
      }
    })

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
      asking?: Asking,
    ) {
      const sys = yield* systemPaths()
      const already = extract(messages)
      const results: { filepath: string; content: string; link?: Link }[] = []
      const s = yield* InstanceState.get(state)
      const root = path.resolve(yield* InstanceState.directory)

      const target = path.resolve(filepath)
      let current = path.dirname(target)

      // Walk upward from the file being read and attach nearby instruction files once per message.
      while (current.startsWith(root) && current !== root) {
        const found = yield* find(current)
        if (!found || found === target || sys.has(found) || already.has(found) || !(yield* landsInProject(found))) {
          current = path.dirname(current)
          continue
        }

        let set = s.claims.get(messageID)
        if (!set) {
          set = new Set()
          s.claims.set(messageID, set)
        }
        if (set.has(found)) {
          current = path.dirname(current)
          continue
        }

        set.add(found)
        const content = yield* read(found)
        if (content) {
          results.push({ filepath: found, content: `Instructions from: ${found}\n${content}` })
        }

        current = path.dirname(current)
      }

      // Memory about this file comes with it, once per session: a lesson cited from it, or the repair a repeated
      // failure needed when a file it touched is read. Scoped rules are already in the digest, so they never repeat.
      const claimed = s.claims.get(messageID) ?? new Set<string>()
      const attached = yield* brain.attach(yield* place(), {
        file: target,
        personal: false,
        exclude: new Set(
          [...already, ...claimed].flatMap((item) =>
            item.startsWith(MEMORY_LOADED) ? [item.slice(MEMORY_LOADED.length)] : [],
          ),
        ),
      })
      if (attached.text) {
        attached.ids.forEach((id) => claimed.add(`${MEMORY_LOADED}${id}`))
        s.claims.set(messageID, claimed)
        results.push({ filepath: `${MEMORY_LOADED}${attached.ids.join(",")}`, content: attached.text })
      }

      // Documents linked to the file, in one line, once per file per request (T4).
      if (asking && asking.tier !== "chat") {
        const brainPlace = yield* place()
        const file = BrainPaths.relative(brainPlace.root, target)
        if (!claimed.has(`${KNOWLEDGE_LOADED}${file}`) && !linkedSince(messages, "pointer").has(file)) {
          const pointer = yield* knowledge.pointers(brainPlace, {
            file,
            personal: asking.personal,
            exclude: asking.exclude,
            sessionID: asking.sessionID,
            ...(requestOf(messages) ? { requestID: requestOf(messages)! } : {}),
          })
          if (pointer.text) {
            claimed.add(`${KNOWLEDGE_LOADED}${file}`)
            s.claims.set(messageID, claimed)
            results.push({
              filepath: `${KNOWLEDGE_LOADED}${pointer.ids.join(",")}`,
              content: linked("pointer", file),
              link: { mode: "pointer", file, ids: pointer.ids },
            })
          }
        }
      }

      return results
    })

    const guard = Effect.fn("Instruction.guard")(function* (
      messages: SessionV1.WithParts[],
      files: readonly string[],
      messageID: MessageID,
      asking: Asking,
    ) {
      // The guard is for work that changes what a requirement covers; a quick change gets on without it.
      if (asking.tier === "chat" || asking.tier === "light") return { links: [] }
      const brainPlace = yield* place()
      const s = yield* InstanceState.get(state)
      const claimed = s.claims.get(messageID) ?? new Set<string>()
      const done = linkedSince(messages, "guard")
      const links = yield* Effect.forEach(
        [...new Set(files.map((file) => BrainPaths.relative(brainPlace.root, file)))],
        (file) =>
          Effect.gen(function* () {
            if (done.has(file) || claimed.has(`guard:${file}`)) return []
            // A requirement the conversation already has is still named: the guard asks for a check, not a read.
            const line = yield* knowledge.guard(brainPlace, {
              file,
              personal: asking.personal,
              exclude: new Set(),
              sessionID: asking.sessionID,
              ...(requestOf(messages) ? { requestID: requestOf(messages)! } : {}),
            })
            if (!line.text) return []
            claimed.add(`guard:${file}`)
            return [{ mode: "guard" as const, file, ids: line.ids }]
          }),
      ).pipe(Effect.map((found) => found.flat()))
      s.claims.set(messageID, claimed)
      if (links.length === 0) return { links }
      return { text: links.map((item) => linked("guard", item.file)).join("\n"), links }
    })

    return Service.of({ clear, guard, place, systemPaths, system, contents, find, resolve })
  }),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

/** The code-link lines a tool result carries. */
export function links(part: SessionV1.Part): Link[] {
  if (part.type !== "tool" || part.state.status !== "completed") return []
  const value = part.state.metadata?.[LINKS]
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("file" in item) || typeof item.file !== "string") return []
    const mode = "mode" in item && item.mode === "guard" ? ("guard" as const) : ("pointer" as const)
    const ids =
      "ids" in item && Array.isArray(item.ids)
        ? item.ids.filter((id: unknown): id is string => typeof id === "string")
        : []
    return ids.length > 0 ? [{ mode, file: item.file, ids }] : []
  })
}

// The request a tool call answers starts at the last user message: what it was given since then, it was given once.
function linkedSince(messages: readonly SessionV1.WithParts[], mode: Link["mode"]) {
  const start = messages.findLastIndex((message) => message.info.role === "user")
  return new Set(
    messages
      .slice(Math.max(0, start))
      .flatMap((message) => message.parts.flatMap((part) => links(part).filter((item) => item.mode === mode)))
      .map((item) => item.file),
  )
}

function requestOf(messages: readonly SessionV1.WithParts[]) {
  return messages.findLast((message) => message.info.role === "user")?.info.id
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, FSUtil.node, Global.node, RuntimeFlags.node, httpClient, Brain.node, BrainKnowledge.node],
})

export * as Instruction from "./instruction"
