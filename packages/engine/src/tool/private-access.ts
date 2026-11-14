import fs from "node:fs"
import path from "node:path"
import { Effect, Schema } from "effect"
import { FSUtil } from "@vectordevai/core/fs-util"
import type { SessionAudience } from "@vectordevai/core/session/audience"
import type { Git } from "@/git"
import type { InstanceContext } from "@/project/instance-context"
import { FileLock } from "./file-lock"

export class Refused extends Schema.TaggedErrorClass<Refused>()("PrivateAccess.Refused", {
  message: Schema.String,
}) {}

const refused = () => new Refused({ message: "This operation could expose private task data." })
type GitOptions = { env?: Record<string, string>; args?: string[] }
type Routing = { cwd: string; args: string[]; env: Record<string, string>; paths: string[] }
type Admission = { sessionID: string; guest?: undefined } | { guest: boolean; sessionID?: string }

/** Detected file and Git access only; arbitrary programs are not a filesystem sandbox. */
export function make(
  input: Admission & {
    audience: SessionAudience.Interface
    git: Git.Interface
    instance: Pick<InstanceContext, "directory">
  },
) {
  // Guest input is permanent once recorded, so only a guest answer is remembered; an owner family is asked again.
  const remembered = { guest: false }
  const guest = () =>
    input.guest !== undefined
      ? Effect.succeed(input.guest)
      : remembered.guest
        ? Effect.succeed(true)
        : input.audience.hasGuestInput(input.sessionID).pipe(
            Effect.tap((value) =>
              Effect.sync(() => {
                if (value) remembered.guest = true
              }),
            ),
          )
  const probe = Effect.fn("PrivateAccess.probe")(function* (routing: Routing, option: string) {
    // The C locale keeps the messages matched below in English whatever language the engine runs in.
    const result = yield* input.git
      .run(["--no-pager", ...routing.args, "rev-parse", "--path-format=absolute", option], {
        cwd: routing.cwd,
        env: { ...routing.env, LC_ALL: "C" },
        maxOutputBytes: 16_384,
      })
      .pipe(Effect.catchDefect(() => Effect.fail(refused())))
    if (result.truncated) return yield* refused()
    if (result.exitCode !== 0) {
      if (/not a git repository/i.test(result.stderr.toString("utf8"))) return undefined
      if (option === "--show-toplevel" && /must be run in a work tree/i.test(result.stderr.toString("utf8")))
        return undefined
      return yield* refused()
    }
    const value = result.text().replace(/\r?\n$/, "")
    if (!path.isAbsolute(value) || /[\x00\r\n]/.test(value)) return yield* refused()
    return FileLock.key(value)
  })

  // Until isolation is first used no private root exists, and nothing can overlap one, so no Git probe runs: a host
  // where Git cannot run, or a folder Git refuses, still serves guests.
  const guarded = Effect.gen(function* () {
    return (yield* input.audience.hasPrivateDirectories) && (yield* guest())
  })

  const read = Effect.fn("PrivateAccess.read")(function* (files: readonly string[], options?: { ancestors?: boolean }) {
    if (!(yield* guarded)) return
    // A per-file discovery probe must not inherit a different repository from the engine's environment.
    const ambient = environment()
    if (!ambient || Object.keys(ambient).length) return yield* refused()
    for (const file of files) {
      const target = FileLock.key(path.resolve(input.instance.directory, file))
      const privatePath = yield* options?.ancestors
        ? input.audience.overlapsPrivateDirectory(target)
        : input.audience.isPrivateDirectory(target)
      if (privatePath) return yield* refused()
      const directory = yield* Effect.try({ try: () => existingDirectory(target), catch: refused })
      const common = yield* probe({ cwd: directory, args: [], env: {}, paths: [] }, "--git-common-dir")
      // A private linked worktree shares objects, refs and packed-refs with the ordinary checkout. Protect those
      // bytes for guests without declaring the ordinary checkout or its entire .git directory durably private.
      if (common && FSUtil.contains(common, target) && (yield* input.audience.overlapsPrivateDirectory(common)))
        return yield* refused()
    }
  })

  const git = Effect.fn("PrivateAccess.git")(function* (cwd: string, options?: GitOptions) {
    if (!(yield* guarded)) return
    const routing = route(cwd, options)
    if (!routing) return yield* refused()
    yield* read(routing.paths)
    const common = yield* probe(routing, "--git-common-dir")
    if (common && (yield* input.audience.overlapsPrivateDirectory(common))) return yield* refused()
    const worktree = yield* probe(routing, "--show-toplevel")
    if (worktree && (yield* input.audience.isPrivateDirectory(worktree))) return yield* refused()
  })

  // Shell output reaches this per chunk. Without a private root no text can name one, so the guest question (a family
  // walk for an owner family, which is asked again each time) is skipped, as `read` and `git` skip it.
  const output = Effect.fn("PrivateAccess.output")(function* <A>(value: A) {
    if (!(yield* guarded)) return value
    const text = yield* Effect.try({
      try: () => (typeof value === "string" ? value : (JSON.stringify(value) ?? "")),
      catch: refused,
    })
    if (yield* input.audience.containsPrivateText(text)) return yield* refused()
    return value
  })
  return { read, git, output }
}

function existingDirectory(file: string): string {
  const current = fs.statSync(file, { throwIfNoEntry: false })
  if (current?.isDirectory()) return file
  const parent = path.dirname(file)
  if (parent === file) throw refused()
  return existingDirectory(parent)
}

/**
 * Only routing state is copied to probes. Never forward a user subcommand or arbitrary -c/config-env settings.
 * Configuration the engine itself was started with (for example a proxy's GIT_CONFIG_* entries) is inherited the same
 * way by the probe and by the command, so only settings the command adds can make them see different repositories.
 */
function environment(extra?: Record<string, string>): Record<string, string> | undefined {
  if (
    Object.entries(extra ?? {}).some(
      ([key, value]) =>
        value &&
        (/^GIT_CONFIG(?:_|$)/.test(key) ||
          (/^GIT_TRACE/.test(key) && value !== "0") ||
          /^(?:GIT_NAMESPACE|GIT_REPLACE_REF_BASE|GIT_SHALLOW_FILE|GIT_CEILING_DIRECTORIES|GIT_DISCOVERY_ACROSS_FILESYSTEM)$/.test(
            key,
          )),
    )
  )
    return undefined
  const env = { ...process.env, ...extra }
  return Object.fromEntries(
    [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_COMMON_DIR",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ]
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]!]),
  )
}

function route(cwd: string, options?: GitOptions): Routing | undefined {
  const env = environment(options?.env)
  if (!env) return undefined
  const words = options?.args ?? []
  const args: string[] = []
  let index = /^(?:git|git\.exe)$/i.test(path.win32.basename(words[0] ?? "")) ? 1 : 0
  let directory = path.resolve(cwd)
  let gitdir = env.GIT_DIR
  let worktree = env.GIT_WORK_TREE
  while (index < words.length) {
    const word = words[index++]
    if (word === "--" || !word.startsWith("-")) break
    if (word === "-C" || word.startsWith("-C") || /^--(?:git-dir|work-tree)(?:=|$)/.test(word)) {
      const name = word.startsWith("-C") ? "-C" : word.split("=", 1)[0]
      const value = word === name ? words[index++] : name === "-C" ? word.slice(2) : word.slice(name.length + 1)
      if (value === undefined || /[\x00\r\n$`]/.test(value)) return undefined
      args.push(name, value)
      if (name === "-C") directory = path.resolve(directory, value)
      if (name === "--git-dir") gitdir = value
      if (name === "--work-tree") worktree = value
      continue
    }
    if (
      [
        "--bare",
        "--no-pager",
        "--paginate",
        "--no-replace-objects",
        "--no-lazy-fetch",
        "--no-optional-locks",
        "--literal-pathspecs",
        "--glob-pathspecs",
        "--noglob-pathspecs",
        "--icase-pathspecs",
        "--no-advice",
      ].includes(word)
    ) {
      if (word !== "--paginate" && word !== "--no-pager") args.push(word)
      continue
    }
    return undefined
  }
  const direct = [directory, gitdir, worktree, env.GIT_COMMON_DIR, env.GIT_INDEX_FILE, env.GIT_OBJECT_DIRECTORY]
    .filter((value): value is string => value !== undefined)
    .map((value) => path.resolve(directory, value))
  if (env.GIT_COMMON_DIR && gitdir) direct.push(path.resolve(directory, gitdir, env.GIT_COMMON_DIR))
  if (env.GIT_ALTERNATE_OBJECT_DIRECTORIES) {
    if (env.GIT_ALTERNATE_OBJECT_DIRECTORIES.includes('"')) return undefined
    direct.push(
      ...env.GIT_ALTERNATE_OBJECT_DIRECTORIES.split(path.delimiter).map((value) => path.resolve(directory, value)),
    )
  }
  if (direct.some((value) => /[\x00\r\n$`]/.test(value))) return undefined
  return { cwd, args, env, paths: direct }
}

export * as PrivateAccess from "./private-access"
