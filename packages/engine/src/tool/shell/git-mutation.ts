import path from "node:path"

/** Detected effects only: scripts, interpreters and dynamic shell expressions are not a filesystem sandbox. */
export type Kind = "paths" | "index" | "head" | "tree" | "branch" | "stash" | "refs"

export type Options = {
  cwd: string
  env?: Readonly<Record<string, string | undefined>>
  aliases?: Readonly<Record<string, string | undefined>>
  trees?: readonly string[]
  /** Canonical paths supplied by the caller, including real paths and volume case folding. No I/O here. */
  canonicalize?: (file: string) => string
  /** Optional git-directory -> worktree mapping for registered linked worktrees. */
  gitDirectories?: Readonly<Record<string, string>>
}

export type Result = {
  tree: string
  directory: string
  /** Actual checkout placement can differ from the git metadata owner selected by --git-dir. */
  workingTree?: string
  gitDirectory?: string
  indexFile?: string
  effects: Kind[]
  paths: string[]
  refs: string[]
  /** Stash mutations remain distinct even when their table effects are tree/head or refs. */
  stash?: boolean
  /** One unresolved subcommand for the caller's read-only `git config --get alias.<name>` lookup. */
  alias?: string
  /** Original global options only. The alias lookup runs with the original cwd, not `directory`. */
  gitArgs: string[]
}

type Parsed = {
  cwd: string
  gitDir?: string
  worktree?: string
  index?: string
  gitArgs: string[]
  aliases: Record<string, string | undefined>
  command: string
  args: string[]
  uncertain?: boolean
}

type Effects = {
  effects: Kind[]
  paths?: string[]
  refs?: string[]
  alias?: string
  worktrees?: boolean
  stash?: boolean
}
const NONE: Effects = { effects: [] }
const READS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "grep",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "fetch",
  "push",
  "describe",
  "cat-file",
  "check-ignore",
  "check-ref-format",
  "for-each-ref",
  "help",
  "version",
])
const OPTION_VALUES = new Set([
  "--source",
  "-s",
  "--pathspec-from-file",
  "--conflict",
  "--recurse-submodules",
  "--format",
  "--sort",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--abbrev",
  "--color",
  "--exclude",
  "-e",
  "--message",
  "-m",
  "--file",
  "-F",
  "--cleanup",
  "--trailer",
  "--directory",
  "--include",
  "--whitespace",
  "--build-fake-ancestor",
  "-p",
  "-C",
  "-c",
  "--reuse-message",
  "--reedit-message",
  "--author",
  "--date",
  "--fixup",
  "--squash",
  "--template",
  "-t",
])

function inside(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

/** Shell expansion is deliberately not guessed; unresolved targets cannot become literal filenames. */
function literal(value: string) {
  return value.length > 0 && !/[\x00\r\n$`]/.test(value) && !/%[^%]+%/.test(value) && !value.startsWith("~")
}

function assignment(word: string) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word)
  return match ? { name: match[1], value: match[2] } : undefined
}

function parse(words: readonly string[], options: Options): Parsed | undefined {
  let index = 0
  const env = { ...options.env }
  while (index < words.length) {
    const variable = assignment(words[index])
    if (!variable) break
    env[variable.name] = variable.value
    index++
  }
  if (!/^git(?:\.exe)?$/i.test(path.win32.basename(words[index] ?? ""))) return undefined
  index++
  let cwd = path.resolve(options.cwd)
  let uncertain = false
  let gitDir = env.GIT_DIR
  let worktree = env.GIT_WORK_TREE
  const aliases = { ...options.aliases }
  const gitArgs: string[] = []
  while (index < words.length) {
    const word = words[index]
    if (word === "--") {
      index++
      break
    }
    if (!word.startsWith("-")) break
    if (word === "-C" || (word.startsWith("-C") && word.length > 2)) {
      const value = word === "-C" ? words[index + 1] : word.slice(2)
      if (value === undefined) return undefined
      if (value && literal(value)) cwd = path.resolve(cwd, value)
      if (value && !literal(value)) uncertain = true
      gitArgs.push(word, ...(word === "-C" ? [value] : []))
      index += word === "-C" ? 2 : 1
      continue
    }
    if (word === "-c" || (word.startsWith("-c") && word.length > 2)) {
      const value = word === "-c" ? words[index + 1] : word.slice(2)
      if (value === undefined) return undefined
      const alias = /^alias\.([^=]+)=(.*)$/s.exec(value)
      if (alias) aliases[alias[1]] = alias[2]
      gitArgs.push(word, ...(word === "-c" ? [value] : []))
      index += word === "-c" ? 2 : 1
      continue
    }
    if (
      word === "--git-dir" ||
      word.startsWith("--git-dir=") ||
      word === "--work-tree" ||
      word.startsWith("--work-tree=")
    ) {
      const separate = !word.includes("=")
      const value = separate ? words[index + 1] : word.slice(word.indexOf("=") + 1)
      if (value === undefined) return undefined
      if (word.startsWith("--git-dir")) gitDir = literal(value) ? value : undefined
      if (word.startsWith("--work-tree")) worktree = literal(value) ? value : undefined
      if (!literal(value)) uncertain = true
      gitArgs.push(word, ...(separate ? [value] : []))
      index += separate ? 2 : 1
      continue
    }
    // These global options have a separate value but do not change mutation placement.
    if (word === "--namespace" || word === "--config-env" || word === "--super-prefix") {
      const value = words[index + 1]
      if (value === undefined) return undefined
      gitArgs.push(word, value)
      index += 2
      continue
    }
    gitArgs.push(word)
    index++
  }
  const command = words[index]
  if (!command) return undefined
  return {
    cwd,
    gitDir,
    worktree,
    index: env.GIT_INDEX_FILE,
    gitArgs,
    aliases,
    command,
    args: [...words.slice(index + 1)],
    uncertain,
  }
}

/** Splits a normal git alias as git's command aliases do; shell (`!`) aliases are never interpreted. */
function aliasWords(value: string): string[] | undefined {
  if (value.trimStart().startsWith("!")) return undefined
  const words: string[] = []
  let word = ""
  let quote = ""
  let started = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === "\\" && quote !== "'") {
      if (++index >= value.length) return undefined
      word += value[index]
      started = true
      continue
    }
    if (quote) {
      if (char === quote) quote = ""
      else word += char
      started = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) words.push(word)
      word = ""
      started = false
      continue
    }
    word += char
    started = true
  }
  if (quote) return undefined
  if (started) words.push(word)
  return words.length ? words : undefined
}

function operands(args: readonly string[], values: ReadonlySet<string> = OPTION_VALUES) {
  const after = args.indexOf("--")
  if (after >= 0) return args.slice(after + 1)
  const out: string[] = []
  for (let index = 0; index < args.length; index++) {
    const item = args[index]
    if (values.has(item)) {
      index++
      continue
    }
    if (!item.startsWith("-")) out.push(item)
  }
  return out
}

function named(args: readonly string[], options: readonly string[]) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--") break
    if (options.includes(arg) || options.some((option) => option.length > 2 && arg.startsWith(`${option}=`)))
      return true
    if (OPTION_VALUES.has(arg)) index++
  }
  return false
}

/** Valid negated booleans are positional: the last switch wins, and option values are never switches. */
function flag(args: readonly string[], name: string, short?: string, values: ReadonlySet<string> = OPTION_VALUES) {
  let enabled = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--") break
    if (arg === `--${name}`) enabled = true
    if (arg === `--no-${name}`) enabled = false
    if (values.has(arg)) {
      index++
      continue
    }
    if (!short || !/^-[A-Za-z]/.test(arg)) continue
    for (let offset = 1; offset < arg.length; offset++) {
      const option = `-${arg[offset]}`
      if (values.has(option)) {
        if (offset === arg.length - 1) index++
        break
      }
      if (arg[offset] === short) enabled = true
    }
  }
  return enabled
}

function pathEffects(paths: string[], extra: Kind[] = []): Effects {
  if (paths.length === 0 || paths.includes(".") || paths.some((file) => file.startsWith(":")))
    return { effects: [...extra, "tree"] }
  return { effects: [...extra, "paths"], paths }
}

function effects(
  command: string,
  args: string[],
  aliases: Record<string, string | undefined>,
  expanded = false,
): Effects {
  if (READS.has(command)) return NONE
  if (command === "checkout") {
    if (named(args, ["--pathspec-from-file"])) return { effects: ["tree"] }
    const orphan = args.find((item) => item.startsWith("--orphan="))
    if (orphan) return { effects: ["branch"], refs: [orphan.slice("--orphan=".length)] }
    const divider = args.indexOf("--")
    if (divider >= 0) return pathEffects(args.slice(divider + 1))
    const combined = args.find((item) => /^-[bB].+/.test(item))
    if (combined) return { effects: operands(args).length ? ["branch"] : ["head"], refs: [combined.slice(2)] }
    const creation = args.findIndex((item) => item === "-b" || item === "-B" || item === "--orphan")
    if (creation >= 0) {
      const name = args[creation + 1]
      const rest = operands(args.slice(creation + 2))
      return { effects: rest.length ? ["branch"] : ["head"], refs: name ? [name] : ["*"] }
    }
    return { effects: ["branch"], refs: operands(args) }
  }
  if (command === "switch") {
    if (named(args, ["--orphan"])) {
      const index = args.findIndex((item) => item === "--orphan" || item.startsWith("--orphan="))
      const name = args[index] === "--orphan" ? args[index + 1] : args[index].slice("--orphan=".length)
      return { effects: ["branch"], refs: name ? [name] : ["*"] }
    }
    const creation = args.findIndex((item) => ["-c", "-C", "--create", "--force-create", "--orphan"].includes(item))
    if (creation >= 0) {
      const name = args[creation + 1]
      return { effects: operands(args.slice(creation + 2)).length ? ["branch"] : ["head"], refs: name ? [name] : ["*"] }
    }
    const short = args.find((item) => /^-[cC].+/.test(item))
    if (short) return { effects: operands(args).length ? ["branch"] : ["head"], refs: [short.slice(2)] }
    const combined = args.find(
      (item) => item.startsWith("--create=") || item.startsWith("--force-create=") || item.startsWith("--orphan="),
    )
    if (combined)
      return {
        effects: operands(args).length ? ["branch"] : ["head"],
        refs: [combined.slice(combined.indexOf("=") + 1)],
      }
    return { effects: ["branch"], refs: operands(args) }
  }
  if (command === "restore") {
    const staged = flag(args, "staged", "S")
    const worktree = flag(args, "worktree", "W")
    if (staged && !worktree) return { effects: ["index"] }
    if (named(args, ["--pathspec-from-file"])) return { effects: staged ? ["index", "tree"] : ["tree"] }
    return pathEffects(operands(args), staged ? ["index"] : [])
  }
  if (command === "rm") {
    if (flag(args, "cached")) return { effects: ["index"] }
    return named(args, ["--pathspec-from-file"]) ? { effects: ["tree"] } : pathEffects(operands(args))
  }
  if (command === "mv") return pathEffects(operands(args))
  if (command === "clean") {
    if (flag(args, "dry-run", "n", new Set(["-e", "--exclude"]))) return NONE
    const forced =
      named(args, ["-f", "--force", "-i", "--interactive"]) || args.some((arg) => /^-[A-Za-z]*[fi]/.test(arg))
    return forced ? pathEffects(operands(args, new Set(["-e", "--exclude"]))) : NONE
  }
  if (command === "add") return flag(args, "dry-run", "n") ? NONE : { effects: ["index"] }
  if (command === "reset") {
    const paths = args.includes("--")
    const commit = !paths && operands(args).length > 0
    if (named(args, ["--hard", "--merge", "--keep"])) return { effects: ["tree", "head"] }
    if (commit) return { effects: ["head", "index"] }
    return { effects: ["index"] }
  }
  if (command === "commit") return flag(args, "dry-run") ? NONE : { effects: ["head", "index"] }
  if (["merge", "rebase", "pull", "cherry-pick", "revert", "am"].includes(command)) return { effects: ["tree", "head"] }
  if (command === "apply") {
    if (!named(args, ["--apply"]) && ["check", "stat", "numstat", "summary"].some((name) => flag(args, name)))
      return NONE
    return flag(args, "cached")
      ? { effects: ["index"] }
      : { effects: flag(args, "index") ? ["tree", "index"] : ["tree"] }
  }
  if (command === "stash") {
    const divider = args.indexOf("--")
    const operation = operands(divider >= 0 ? args.slice(0, divider) : args)[0]
    if (operation === "list" || operation === "show") return NONE
    if (operation === "pop" || operation === "apply") return { effects: ["tree", "head"], stash: true }
    if (operation === "branch")
      return { effects: ["tree", "head", "refs"], refs: args.slice(args.indexOf("branch") + 1), stash: true }
    if (operation === "drop" || operation === "clear") return { effects: ["refs"], refs: ["refs/stash"], stash: true }
    return { effects: ["stash"], stash: true }
  }
  if (command === "branch") {
    const mutation = named(args, [
      "-d",
      "-D",
      "-m",
      "-M",
      "-c",
      "-C",
      "-f",
      "--delete",
      "--move",
      "--copy",
      "--force",
      "--set-upstream-to",
      "--unset-upstream",
      "--edit-description",
    ])
    if (
      !mutation &&
      (operands(args).length === 0 ||
        flag(args, "list", "l") ||
        flag(args, "all", "a") ||
        flag(args, "remotes", "r") ||
        flag(args, "show-current") ||
        flag(args, "points-at") ||
        named(args, ["--contains", "--no-contains", "--merged", "--no-merged"]))
    )
      return NONE
    return { effects: ["refs"], refs: operands(args, new Set()) }
  }
  if (command === "tag") {
    const mutation = named(args, [
      "-d",
      "--delete",
      "-a",
      "--annotate",
      "-s",
      "--sign",
      "-u",
      "--local-user",
      "-f",
      "--force",
    ])
    if (
      !mutation &&
      (operands(args).length === 0 ||
        flag(args, "list", "l") ||
        flag(args, "verify", "v") ||
        flag(args, "points-at") ||
        named(args, ["--contains", "--no-contains", "--merged", "--no-merged"]))
    )
      return NONE
    return {
      effects: ["refs"],
      refs: operands(args, new Set(["-m", "--message", "-F", "--file", "-u", "--local-user"])),
    }
  }
  if (command === "symbolic-ref") {
    const refs = operands(args, new Set())
    return refs.length > 1 || named(args, ["--delete", "-d"]) ? { effects: ["refs"], refs } : NONE
  }
  if (command === "update-ref")
    return { effects: ["refs"], refs: named(args, ["--stdin"]) ? ["*"] : operands(args, new Set(["-m"])) }
  if (command === "worktree") {
    const operation = args[0]
    if (!operation || ["list", "repair"].includes(operation))
      return operation === "repair" ? { effects: ["refs"], refs: args.slice(1) } : NONE
    if (["add", "remove", "move", "prune", "lock", "unlock"].includes(operation)) {
      const refs = [
        ...operands(args.slice(1), new Set(["--reason", "--expire"])),
        ...args.filter((item) => /^-[bB].+/.test(item)).map((item) => item.slice(2)),
      ]
      return { effects: ["refs"], refs: refs.length ? refs : ["*"], worktrees: true }
    }
  }
  if (command === "submodule")
    return ["update", "init", "deinit", "add"].includes(operands(args)[0]) ? { effects: ["tree"] } : NONE
  if (command === "reflog")
    return ["expire", "delete", "drop"].includes(args[0])
      ? { effects: ["refs"], refs: args.slice(1).filter((item) => !item.startsWith("-")) }
      : NONE
  if (["gc", "prune", "replace"].includes(command)) return { effects: ["refs"], refs: operands(args, new Set()) }
  if (command === "notes") {
    const operation = operands(args, new Set(["--ref"]))[0]
    if (!["add", "append", "copy", "edit", "merge", "prune", "remove"].includes(operation)) return NONE
    const ref =
      args.find((item) => item.startsWith("--ref="))?.slice("--ref=".length) ??
      (args.includes("--ref") ? args[args.indexOf("--ref") + 1] : undefined)
    return { effects: ["refs"], refs: ref ? [ref] : ["refs/notes/*"] }
  }
  if (command === "config") {
    // The scanner's own alias resolution is read-only; a user's config write can install a later shell alias.
    return named(args, ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"])
      ? NONE
      : { effects: ["refs"], refs: ["config"] }
  }
  if (expanded) return { effects: ["tree"] }
  const alias = aliases[command]
  if (alias !== undefined) {
    const expanded = aliasWords(alias)
    return expanded ? effects(expanded[0], [...expanded.slice(1), ...args], aliases, true) : { effects: ["tree"] }
  }
  return { effects: ["tree"], alias: command }
}

export function classify(words: readonly string[], options: Options): Result | undefined {
  const parsed = parse(words, options)
  if (!parsed) return undefined
  const changed = effects(parsed.command, parsed.args, parsed.aliases)
  const canonical = options.canonicalize ?? path.resolve
  const directory = parsed.worktree && literal(parsed.worktree) ? path.resolve(parsed.cwd, parsed.worktree) : parsed.cwd
  const gitDirectory = parsed.gitDir && literal(parsed.gitDir) ? path.resolve(parsed.cwd, parsed.gitDir) : undefined
  const indexDirectory = parsed.index && literal(parsed.index) ? path.resolve(parsed.cwd, parsed.index) : undefined
  const pureIndex = changed.effects.length > 0 && changed.effects.every((kind) => kind === "index")
  const target = pureIndex && indexDirectory ? indexDirectory : (gitDirectory ?? directory)
  const mapped = Object.entries(options.gitDirectories ?? {})
    .sort(([left], [right]) => canonical(right).length - canonical(left).length)
    .find(([gitDir]) => inside(canonical(gitDir), canonical(target)))?.[1]
  const roots = [...(options.trees ?? [options.cwd])].map((tree) => canonical(tree)).sort((a, b) => b.length - a.length)
  const workingTree = roots.find((root) => inside(root, canonical(directory)))
  const metadataTree = roots.find((root) => inside(root, canonical(mapped ?? target)))
  const touchesCheckout = changed.effects.some((kind) => ["tree", "branch", "stash", "paths"].includes(kind))
  // --git-dir chooses HEAD/index identity, not where checkout files are written. An external gitdir must not
  // hide a reset/checkout that still overwrites this known checkout. Pure external index/HEAD writes stay out.
  const tree = metadataTree ?? (touchesCheckout ? workingTree : undefined)
  if (!tree) return undefined
  const paths = [
    ...new Set(
      (changed.paths ?? []).filter(literal).map((file) => {
        // A glob can touch any matching descendant: guard the known literal directory, without expanding the shell.
        const wildcard = file.search(/[?*\[]/)
        if (wildcard < 0) return path.resolve(directory, file)
        const prefix = file.slice(0, wildcard)
        return path.resolve(directory, /[\\/]$/.test(prefix) ? prefix : path.dirname(prefix || "."))
      }),
    ),
  ]
  const selectedRefs = changed.refs ?? []
  const unknownRefs =
    selectedRefs.some((ref) => !literal(ref)) || (changed.effects.includes("refs") && selectedRefs.length === 0)
  const refs = [
    ...new Set([
      ...selectedRefs
        .filter(literal)
        .flatMap((ref) => (changed.worktrees ? [ref, path.resolve(directory, ref)] : [ref])),
      ...(unknownRefs ? ["*"] : []),
    ]),
  ]
  return {
    tree,
    directory,
    ...(workingTree ? { workingTree } : {}),
    ...(gitDirectory ? { gitDirectory: canonical(gitDirectory) } : {}),
    ...(indexDirectory ? { indexFile: canonical(indexDirectory) } : {}),
    effects: [
      ...new Set<Kind>(parsed.uncertain && changed.effects.length ? [...changed.effects, "tree"] : changed.effects),
    ],
    paths,
    refs,
    ...(changed.alias ? { alias: changed.alias } : {}),
    ...(changed.stash ? { stash: true } : {}),
    gitArgs: parsed.gitArgs,
  }
}

export * as GitMutation from "./git-mutation"
