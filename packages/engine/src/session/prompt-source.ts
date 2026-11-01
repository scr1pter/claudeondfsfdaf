export * as PromptSource from "./prompt-source"

import { readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "path"
import { Effect } from "effect"
import type { Config } from "@/config/config"
import { ConfigPaths } from "@/config/paths"
import { ConfigPlugin } from "@/config/plugin"
import { isRecord } from "@/util/record"
import { ConfigMigration } from "@vectordevai/core/config/migration"
import { Flag } from "@vectordevai/core/flag/flag"
import { FSUtil } from "@vectordevai/core/fs-util"
import type { Global } from "@vectordevai/core/global"
import { Glob } from "@vectordevai/core/util/glob"

// The files Vector reads into an agent's system prompt or permissions for one directory (section 8.2), from what it
// actually loads there: the config files it loaded, the agents, modes, commands, skills and plugins under its config
// directories, the skill folders outside the workspace, and the user's own instruction files. A vector.json elsewhere
// under the worktree, such as a test fixture, is not one, so a headless task that edits fixtures is not stopped. Nor is
// a repository's own AGENTS.md: users ask the agent to edit it, and the change shows in git diff.

/**
 * Under a config directory: the files an edit asks about, and the ones Vector loads into a prompt. A plugin can rewrite
 * every system prompt (`experimental.chat.system.transform`), so plugins and the modules beside them count as well.
 */
const CONFIG = {
  ask: [
    "{agent,agents,mode,modes}/**/*.md",
    "{command,commands}/**/*.md",
    "{skill,skills}/**",
    "{plugin,plugins}/**",
    "{workflow,workflows}/*.json",
  ],
  load: [
    "{agent,agents}/**/*.md",
    "{mode,modes}/*.md",
    "{command,commands}/**/*.md",
    "{workflow,workflows}/*.json",
    "{skill,skills}/**/SKILL.md",
    ConfigPlugin.ENTRIES,
    ConfigPlugin.HELPERS,
  ],
}
/** The config files Vector reads from a `.vector` folder, shared ones first. */
const VECTOR_FILES = ["vector.json", "vector.jsonc", "vector.local.json", "vector.local.jsonc"]

/** The keys of a config file that put text into a prompt or load prompt files. */
export const KEYS = ["command", "instructions", "plugin", "skills"]
/** The keys whose entries each may carry a `prompt`. */
export const PROMPTED = ["agent", "mode"]
/** Under a folder of skills: a skill and the files beside it, and the skills Vector loads. */
const SKILLS = { ask: ["**"], load: ["**/SKILL.md"] }

export type Source = {
  /** A config file, whose prompt-bearing keys are what counts; an instruction file; or a directory of prompt files. */
  readonly kind: "config" | "file" | "directory"
  readonly path: string
  /** Under a directory: the files an edit to which asks, as globs relative to it. */
  readonly ask: readonly string[]
  /** Under a directory: the files Vector loads into a prompt, which the instance-start hold covers (PromptTrust). */
  readonly load: readonly string[]
}

export type Sources = readonly Source[]

/** The prompt sources of one directory, from what Config loaded there and the user's own folders. */
export const sources = Effect.fn("PromptSource.sources")(function* (input: {
  config: Config.Interface
  global: Global.Interface
  directory: string
  worktree: string
}) {
  const loaded = yield* input.config.loaded()
  const info = yield* input.config.get()
  return build({
    ...loaded,
    skills: info.skills?.paths ?? [],
    instructions: info.instructions ?? [],
    home: input.global.home,
    config: input.global.config,
    directory: input.directory,
    worktree: input.worktree,
  })
})

/** The same, from what was loaded, resolved as the skill and instruction loaders resolve each entry. */
export function build(input: {
  /** The config files Vector loaded, or looked for in a config directory. */
  readonly files: readonly string[]
  /** The config directories it loads agents, commands, skills and plugins from. */
  readonly directories: readonly string[]
  readonly skills: readonly string[]
  readonly instructions: readonly string[]
  readonly home: string
  /** The folder the user's global AGENTS.md is read from. */
  readonly config: string
  readonly directory: string
  readonly worktree: string
}): Sources {
  const expand = (item: string) => (item.startsWith("~/") ? path.join(input.home, item.slice(2)) : item)
  const outside = (file: string) => !ConfigPaths.projectContains(file, input)
  const skills = [
    path.join(input.home, ".claude", "skills"),
    path.join(input.home, ".agents", "skills"),
    ...input.skills.map((item) =>
      path.isAbsolute(expand(item)) ? expand(item) : path.join(input.directory, expand(item)),
    ),
  ]
  // ~/.vector is loaded only once it exists, so it counts before then too: an agent that made it would otherwise plant
  // a build agent or a prompt setting that no ask saw and the first start after took as approved.
  const vector = path.join(input.home, ".vector")
  const directories = [...new Set([...input.directories, vector])]
  const files = [...new Set([...input.files, ...VECTOR_FILES.map((file) => path.join(vector, file))])]
  return [
    ...files.map((file) => ({ kind: "config" as const, path: file, ask: [], load: [] })),
    // A prompt a config file's keys keep in another file (`{file:./build.md}`) is that file's text.
    ...[...new Set(files.flatMap(references))]
      .filter((file) => !files.includes(file))
      .map((file) => ({ kind: "file" as const, path: file, ask: [], load: [] })),
    ...directories.map((dir) => ({ kind: "directory" as const, path: dir, ...CONFIG })),
    ...skills.map((dir) => ({ kind: "directory" as const, path: dir, ...SKILLS })),
    ...[path.join(input.config, "AGENTS.md"), path.join(input.home, ".claude", "CLAUDE.md")].map((file) => ({
      kind: "file" as const,
      path: file,
      ask: [],
      load: [],
    })),
    // An instruction entry is a file name, or a pattern for one, in its folder. A relative one is the repository's own
    // unless repository config is off, when it is read from the user's config folder.
    ...input.instructions
      .filter((item) => !item.startsWith("https://") && !item.startsWith("http://"))
      .flatMap((item) => {
        const entry = expand(item)
        if (path.isAbsolute(entry))
          return outside(path.dirname(entry)) ? [{ dir: path.dirname(entry), glob: path.basename(entry) }] : []
        return Flag.VECTOR_DISABLE_PROJECT_CONFIG ? [{ dir: input.config, glob: entry }] : []
      })
      .map((item) => ({ kind: "directory" as const, path: item.dir, ask: [item.glob], load: [item.glob] })),
  ]
}

/**
 * A config file's prompt-bearing keys as written, before Config substitutes `{env:}` and `{file:}` in them: the
 * `command`, `instructions`, `plugin` and `skills` keys and each agent's and mode's `prompt`. None when it has none.
 */
export function promptKeys(text: string, file: string) {
  const data = settings(text, file)
  if (!isRecord(data)) return
  const kept = Object.fromEntries([
    ...KEYS.flatMap((key) => (data[key] === undefined ? [] : [[key, data[key]]])),
    ...PROMPTED.flatMap((key) => {
      const entries = data[key]
      const prompts = isRecord(entries)
        ? Object.entries(entries).flatMap(([name, value]) =>
            isRecord(value) && value.prompt !== undefined ? [[name, value.prompt]] : [],
          )
        : []
      return prompts.length > 0 ? [[key, Object.fromEntries(prompts)]] : []
    }),
  ])
  return Object.keys(kept).length > 0 ? kept : undefined
}

/**
 * The files a config file's prompt-bearing keys name with `{file:path}`, whose text Config puts in their place
 * (ConfigVariable.substitute): `~/` from the home folder, a relative path from the config file's folder. None for a
 * config file that is missing, is not JSON or names none.
 */
export function references(file: string) {
  if (!/\.jsonc?$/.test(file)) return []
  const text = readText(file)
  const keys = text === undefined ? undefined : promptKeys(text, file)
  if (!keys) return []
  const strings = (value: unknown): string[] => {
    if (typeof value === "string") return [value]
    if (Array.isArray(value)) return value.flatMap(strings)
    if (isRecord(value)) return Object.entries(value).flatMap(([key, item]) => [key, ...strings(item)])
    return []
  }
  return [
    ...new Set(
      strings(keys).flatMap((value) =>
        [...value.matchAll(/\{file:([^}]+)\}/g)].map((match) => {
          const target = match[1]!.startsWith("~/") ? path.join(os.homedir(), match[1]!.slice(2)) : match[1]!
          return path.resolve(path.dirname(file), target)
        }),
      ),
    ),
  ]
}

/** Whether a file, as written or where it really lands, is one an edit to which changes a prompt. */
export function is(file: string, sources: Sources) {
  const spellings = [path.resolve(file), real(file)]
  return sources.some((source) =>
    [source.path, real(source.path)].some((root) =>
      spellings.some((item) => (source.kind === "directory" ? matches(root, source.ask, item) : root === item)),
    ),
  )
}

/** Whether `file` lies under `dir` and matches one of `globs` relative to it. */
export function matches(dir: string, globs: readonly string[], file: string) {
  if (dir === file || !FSUtil.contains(dir, file)) return false
  const relative = path.relative(dir, file).split(path.sep).join("/")
  return globs.some((glob) => Glob.match(glob, relative))
}

// Where a path really lands, or the path as written when a link loop leaves that unknown.
function real(file: string) {
  try {
    return FSUtil.realpath(file)
  } catch {
    return path.resolve(file)
  }
}

// A config file Config cannot parse fails to load anyway; here it has no prompt-bearing keys.
function settings(text: string, file: string) {
  try {
    return ConfigMigration.parseConfig(text, file)
  } catch {
    return undefined
  }
}

export function readText(file: string) {
  try {
    return statSync(file, { throwIfNoEntry: false })?.isFile() ? readFileSync(file, "utf8") : undefined
  } catch {
    return undefined
  }
}
