export * as LocalCommand from "./command"

// What a shell command reaches, read from its text before it runs: whether its output is this computer's own (memory
// holds what came from outside, and the after-web rule counts such output as outside), and whether it may connect to
// the network (Vector Local asks first). Both the engine's shell and the V2 runner's bash decide with these. Vector
// cannot see where a program connects, so both are allowlists: what is not known to be local is not.

/**
 * Whether a shell command's output comes from this computer: its files, the repository's own history, and the checks
 * and scripts it runs. Anything else (a fetch, a hosted issue or pull request, a remote's history, a package run
 * straight from a registry, code passed inline to an interpreter, or a program Vector does not know) may print someone
 * else's text, so it is an allowlist: what is not known to be local counts as outside content.
 */
export function local(command: string) {
  return simple(withoutHeredocs(command)).every(runsLocally)
}

// Text utilities, shell builtins and the repository's own build and check tools. Their output is this computer's.
const LOCAL_PROGRAMS = new Set([
  ...["ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "sed"],
  ...["cut", "tr", "wc", "sort", "uniq", "diff", "cmp", "comm", "echo", "printf", "pwd", "cd", "pushd", "popd"],
  ...["mkdir", "rmdir", "rm", "cp", "mv", "touch", "chmod", "chown", "ln", "stat", "file", "which", "whereis", "type"],
  ...["test", "[", "[[", "]", "]]", "true", "false", ":", "export", "set", "unset", "source", ".", "tree", "jq", "yq"],
  ...["xxd", "hexdump", "od", "basename", "dirname", "realpath", "readlink", "date", "sleep", "tee", "seq", "column"],
  ...["paste", "join", "split", "gzip", "gunzip", "unzip", "shasum", "sha1sum", "sha256sum", "md5", "md5sum"],
  ...["du", "df", "ps", "kill", "pkill", "pgrep", "uname", "whoami", "id", "clear", "exit", "read", "wait", "nl"],
  ...["rev", "fold", "fmt", "iconv", "strings", "base64", "bc", "expr", "let", "local", "declare", "printenv", "patch"],
  ...["in", "return", "shift", "open", "lsof", "tsc", "tsgo", "vitest", "jest", "pytest", "mypy", "pyright", "ruff"],
  ...["eslint", "biome", "oxlint", "prettier", "rspec", "phpunit", "xcodebuild", "swiftc", "clang", "gcc", "cc"],
  ...["c++", "cmake", "ninja", "mvn", "gradle", "gradlew", "dotnet", "swift", "mix", "turbo", "playwright"],
  ...["mocha", "knip", "vite", "drizzle-kit", "stylelint", "rustc", "rustfmt", "gofmt", "black", "isort"],
])

// What `npx` and its kin may run without counting as a registry download: tools a repository installs itself.
const LOCAL_TOOLS_RUN = new Set([
  ...["tsc", "tsgo", "vitest", "jest", "eslint", "biome", "prettier", "playwright", "tsx", "turbo", "oxlint", "mocha"],
  ...["ts-node", "knip", "svelte-check", "vue-tsc", "astro", "next", "vite", "drizzle-kit", "stylelint", "c8", "nyc"],
])

const GIT_LOCAL = new Set([
  ...["status", "diff", "log", "show", "add", "commit", "branch", "checkout", "switch", "restore", "reset", "stash"],
  ...["rev-parse", "rev-list", "merge-base", "merge", "rebase", "cherry-pick", "revert", "blame", "grep", "ls-files"],
  ...["ls-tree", "cat-file", "describe", "tag", "worktree", "mv", "rm", "clean", "apply", "am", "format-patch"],
  ...[
    "shortlog",
    "reflog",
    "notes",
    "bisect",
    "init",
    "config",
    "symbolic-ref",
    "for-each-ref",
    "show-ref",
    "name-rev",
  ],
  ...[
    "check-ignore",
    "check-attr",
    "var",
    "help",
    "version",
    "gc",
    "fsck",
    "count-objects",
    "whatchanged",
    "range-diff",
  ],
  ...["sparse-checkout", "update-index", "write-tree", "read-tree", "hash-object", "cherry", "diff-tree", "diff-index"],
  ...["diff-files", "update-ref", "stage", "annotate", "prune", "repack", "--version", "--help"],
])

// Package manager commands that reach a registry and print what it sends: a package's readme or metadata, a template,
// advisories, or a package run straight from it.
const REGISTRY = new Set([
  ...["x", "dlx", "create", "init", "view", "info", "show", "v", "docs", "home", "repo", "bugs", "search", "s"],
  ...["publish", "login", "logout", "adduser", "whoami", "owner", "access", "token", "deprecate", "dist-tag", "star"],
  ...["stars", "unpublish", "team", "org", "hook", "profile", "ping", "audit", "outdated", "upgrade", "fund"],
  ...["upgrade-interactive", "self-update", "feedback", "repl"],
])

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"])
// Reserved words open or close a compound command and run nothing themselves: in `if true; then curl …; fi` and
// `{ curl …; }` the command after them is what runs.
const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "!", "{", "}"])
// A loop's or a case's header (`for url in https://…`, `case $1 in`) is a list of words, not a command.
const HEADERS = new Set(["for", "select", "case"])
// Variables bash or zsh read as commands to run later (prompt hooks, prompts with command substitution, startup files).
const HOOK =
  /^(?:PROMPT_COMMAND|PS[0-4]|PROMPT[234]?|RPROMPT2?|RPS[12]|BASH_ENV|ENV|ZDOTDIR|precmd_functions|preexec_functions|chpwd_functions)(?:\[[^\]]*\])?\+?=/
const DECLARATIONS = new Set(["export", "declare", "typeset", "local", "readonly"])
// A redirection may come before the command it applies to (`> out.txt echo`, `done < urls.txt`). An operator on its own
// takes the next word as its file.
const REDIRECT = /^(?:\d*(?:>&|<&|<>|>\||>>|<<<|<<-?|>|<)|&>>?)/
const WRAPPERS = new Set([
  "sudo",
  "time",
  "nice",
  "nohup",
  "command",
  "builtin",
  "exec",
  "env",
  "xargs",
  "timeout",
  "stdbuf",
])
const RUNTIMES = new Set(["node", "deno", "python", "python3", "ruby", "perl", "php", "lua", "tsx", "ts-node"])
const PACKAGES = new Set(["bun", "npm", "pnpm", "yarn"])
const PYTHON_PACKAGES = new Set(["pip", "pip3", "uv", "poetry", "pipenv"])
const INLINE = new Set(["-e", "--eval", "-p", "--print", "-c", "-r", "eval"])
// An interpreter's code given inline: one of INLINE, its long form with a value (`--eval=…`), or a short option that
// combines one of them (`perl -le …`, `node -pe …`, `python3 -Sc …`, `perl -E …`).
const INLINE_CODE = /^(?:--(?:eval|print)=|-[A-Za-z]*[epcrE])/
// A registry's package named as a script (`deno run npm:cowsay`, `deno run jsr:@std/http`) is fetched to run it.
const URL_ARG = /^(?:[a-z][a-z0-9+.-]*:\/\/|git@|github:|gitlab:|bitbucket:|gist:|npm:|jsr:)/i
// awk's own ways to run a command: `system(…)` (a pattern may call it too), `"cmd" | getline`, a print to a command
// inside an action, and gawk's network files. A file named system.log calls nothing.
const AWK_RUNS = /system\s*\(|getline|\/inet\/|\{[\s\S]*\|/
// tar options that run a program (a filter, a remote shell, a script between volumes, a checkpoint action), and a
// short option group with -I or -F, which take such a program.
const TAR_RUNS =
  /^--(?:to-command|use-compress-program|rsh-command|info-script|new-volume-script|checkpoint-action)|^-[A-Za-z]*[IF]/

function runsLocally(words: readonly string[]): boolean {
  const [first, ...rest] = words
  if (first === undefined) return true
  // A shell hook runs later, at every prompt or in every new shell, as trap's command does when its signal comes: a
  // prompt command, a prompt the shell expands (`PS1='$(curl …)'`), or a startup file. Set to anything, it is no
  // command known to stay on this computer.
  if (HOOK.test(first)) return first.slice(first.indexOf("=") + 1) === "" && runsLocally(rest)
  if (DECLARATIONS.has(first) && rest.some((word) => HOOK.test(word) && word.slice(word.indexOf("=") + 1) !== ""))
    return false
  // `FOO=1 cmd`: the assignment, then the command.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return runsLocally(rest)
  if (KEYWORDS.has(first)) return runsLocally(rest)
  if (HEADERS.has(first)) return true
  // `function name { …`: the name, then the body.
  if (first === "function") return runsLocally(rest.slice(1))
  const redirect = REDIRECT.exec(first)?.[0]
  if (redirect !== undefined) return runsLocally(rest.slice(redirect === first ? 1 : 0))
  const name = first.split("/").pop() ?? first
  if (name === "env") {
    const split = rest.findIndex((word) => /^-[A-Za-z]*S|^--split-string/.test(word))
    if (split >= 0)
      return simple(
        [rest[split].replace(/^-[A-Za-z]*S|^--split-string=?/, ""), ...rest.slice(split + 1)].join(" "),
      ).every(runsLocally)
  }
  if (name === "xcrun") {
    const tool = rest.findIndex(
      (word, index) => !word.startsWith("-") && !/^-{1,2}(?:sdk|toolchain|log)$/.test(rest[index - 1] ?? ""),
    )
    return tool < 0 || runsLocally(rest.slice(tool))
  }
  if (WRAPPERS.has(name))
    return runsLocally(rest.slice(rest.findIndex((word) => !/^-|^\d+[smhd]?$|^[A-Za-z_]\w*=/.test(word)) >>> 0))
  if (name === "eval") return simple(rest.join(" ")).every(runsLocally)
  // `trap 'curl …' EXIT` runs its first argument as a command line when the signal comes.
  if (name === "trap") return rest[0] === undefined || rest[0].startsWith("-") || local(rest[0])
  if (name === "awk" || name === "gawk" || name === "mawk" || name === "nawk")
    return !rest.some((word) => AWK_RUNS.test(word)) && !readsProgram(rest, ["-f", "--file", "-E", "--exec"])
  if (name === "sed")
    return !rest.some((word) =>
      sedRuns(word.startsWith("--expression=") ? word.slice(13) : word.startsWith("-") ? "" : word),
    )
  if (name === "tar")
    return !rest.some((word) => TAR_RUNS.test(word) || (!rest.includes("--force-local") && remoteArchive(word)))
  // zip tests an archive with the command `-TT` names.
  if (name === "zip") return !rest.some((word) => word === "-TT" || word.startsWith("--unzip-command"))
  if (name === "make")
    return (
      !rest.some((word) => word === "--eval" || word.startsWith("--eval=") || word === "-E") &&
      !readsProgram(rest, ["-f", "--file", "--makefile"])
    )
  if (SHELLS.has(name)) return shellLocally(rest)
  if (name === "find") {
    const at = rest.findIndex((word) => word === "-exec" || word === "-execdir" || word === "-ok")
    return at < 0 || runsLocally(rest.slice(at + 1))
  }
  if (name === "git") return gitLocally(rest)
  if (LOCAL_PROGRAMS.has(name)) return true
  if (rest.some((word) => URL_ARG.test(word))) return false
  if (name === "npx" || name === "bunx" || name === "pnpx") return toolLocally(rest)
  if (PACKAGES.has(name)) {
    const sub = rest.find((word) => !word.startsWith("-"))
    // `bun -e …` runs code inline; an option after the command (`npm exec -- tsc -p .`) is the command's own.
    const options = rest.slice(0, sub === undefined ? rest.length : rest.indexOf(sub))
    if (options.some((word) => INLINE.has(word) && word !== "-c" && word !== "-r")) return false
    if (sub === "exec") return toolLocally(rest.slice(rest.indexOf("exec") + 1))
    if (sub === "pm") return !["view", "whoami"].includes(rest[rest.indexOf("pm") + 1] ?? "")
    return sub === undefined || !REGISTRY.has(sub)
  }
  if (RUNTIMES.has(name)) {
    if (rest.some((word) => INLINE.has(word) || INLINE_CODE.test(word)) || stdinCode(rest)) return false
    // `python -m pip download` fetches like `pip download` does.
    const module = rest.indexOf("-m")
    return (
      module < 0 || !(rest[module + 1] === "pip" && ["download", "index", "search"].includes(rest[module + 2] ?? ""))
    )
  }
  if (PYTHON_PACKAGES.has(name)) return !["download", "index", "search", "publish", "upload"].includes(rest[0] ?? "")
  if (name === "go") return rest[0] !== "get" && !rest.some((word) => /^[\w.-]+\.[a-z]{2,}\/\S*@/.test(word))
  if (name === "cargo") return !["search", "install", "info", "publish", "login"].includes(rest[0] ?? "")
  // A script or binary named by its path is the repository's own, unless it is one of the known fetchers.
  return (
    first.includes("/") && !/^(?:curl|wget|gh|glab|ssh|scp|sftp|ftp|rsync|nc|telnet|http|https|xh|aria2c)$/.test(name)
  )
}

/**
 * A shell's words after its name. With `-c` its commands are the text that follows; with a script named by its path it
 * runs the repository's own script. Otherwise it runs what it reads on its input (`echo 'curl …' | sh`, `sh -s < x`,
 * a heredoc), which is as much a command line as `-c` but is not known here, so it is not local; a herestring is the
 * command line it gives (`bash <<< 'curl …'`).
 */
function shellLocally(words: readonly string[]): boolean {
  const inline = words.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word) || word === "--command")
  if (inline >= 0) return simple(words.slice(inline + 1).join(" ")).every(runsLocally)
  const command = words.find((word) => word.startsWith("--command="))
  if (command) return simple(command.slice("--command=".length)).every(runsLocally)
  const read = input(words)
  if (read.script && !read.stdin) return true
  return read.herestrings.length > 0 && !read.unknown && read.herestrings.every((text) => local(text))
}

// What a shell's words say about where its commands come from: a script operand, `-s` (commands from the input even
// with operands), herestrings, and an input that is a file, a heredoc or another stream Vector cannot read.
function input(words: readonly string[]) {
  return words.reduce(
    (state, word, index) => {
      if (state.skip > 0) return { ...state, skip: state.skip - 1 }
      if (state.script) return state
      const redirect = REDIRECT.exec(word)?.[0]
      if (redirect !== undefined) {
        const target = redirect === word ? (words[index + 1] ?? "") : word.slice(redirect.length)
        const skip = redirect === word ? 1 : 0
        if (/<<<$/.test(redirect)) return { ...state, skip, herestrings: [...state.herestrings, target] }
        // `<`, `<>`, `<&` and a heredoc give the input; `>`, `>>` and `2>&1` only send output somewhere.
        if (/</.test(redirect)) return { ...state, skip, unknown: true }
        return { ...state, skip }
      }
      if (state.options && (word === "--" || word === "-")) return { ...state, options: false }
      if (state.options && /^[-+][oO]$|^--(?:rcfile|init-file)$/.test(word)) return { ...state, skip: 1 }
      if (state.options && /^-[A-Za-z]*s[A-Za-z]*$/.test(word)) return { ...state, stdin: true }
      if (state.options && /^[-+]/.test(word)) return state
      return { ...state, script: true }
    },
    { skip: 0, options: true, script: false, stdin: false, unknown: false, herestrings: [] as string[] },
  )
}

// Whether an interpreter runs code from its input rather than a script: nothing after its name (the right side of a
// pipe, or its prompt), `-` for the input, or the input redirected while it names no script.
function stdinCode(words: readonly string[]) {
  if (words.length === 0 || words.includes("-")) return true
  const at = words.findIndex((word) => REDIRECT.test(word) && /</.test(REDIRECT.exec(word)?.[0] ?? ""))
  return at >= 0 && words.slice(0, at).every((word) => word.startsWith("-"))
}

// A repository's own tool run through npx or `npm exec`; one that runs code, such as tsx, is read as itself, so
// `npx tsx -e …` counts as inline code.
function toolLocally(words: readonly string[]) {
  const at = words.findIndex((word) => !word.startsWith("-"))
  const tool = words[at] ?? ""
  return LOCAL_TOOLS_RUN.has(tool) && (!RUNTIMES.has(tool) || runsLocally(words.slice(at)))
}

// GNU sed runs a command with its `e` command (`1e curl …`) and the `e` flag of `s` (`s/x/curl …/e`). A standalone
// `e`, or a final `e` among a substitution's flags, counts; one inside a word, such as a file name, does not.
function sedRuns(word: string) {
  return /(?:^|[^A-Za-z\\])e(?:\s|;|\}|$)/.test(word) || /\/[gpiImMw0-9]*e[gpiImMw0-9]*(?:\s|;|\}|$)/.test(word)
}

// An archive on another host (`host:path`, `user@host:path`), which tar reaches through a remote shell. A Windows
// path such as C:\backup.tar is a local file.
function remoteArchive(word: string) {
  const file = word.startsWith("--file=") ? word.slice("--file=".length) : word
  return !file.startsWith("-") && /^[^/\\]+:/.test(file) && !/^[A-Za-z]:[\\/]/.test(file)
}

// Whether a program that reads its code from a file named by one of `options` (make's makefile, awk's program file)
// reads it from its input instead (`-f -`, `-f /dev/stdin`), where a heredoc or herestring is as much a command line
// as `sh -c`. A file the repository has is its own, as a script is.
function readsProgram(words: readonly string[], options: readonly string[]) {
  return words.some((word, index) => {
    const named = options.includes(word)
      ? (words[index + 1] ?? "")
      : options.flatMap((option) => (word.startsWith(`${option}=`) ? [word.slice(option.length + 1)] : []))[0]
    return named !== undefined && (named === "-" || /^\/(?:dev|proc)\//.test(named))
  })
}

function gitLocally(words: readonly string[]): boolean {
  const [first, ...rest] = words
  if (first === undefined) return true
  // A configuration override can turn any command into a fetch or a shell (`-c alias.x='!curl …'`).
  if (first === "-c" || first.startsWith("--config-env")) return false
  if (["-C", "--git-dir", "--work-tree", "--namespace"].includes(first)) return gitLocally(rest.slice(1))
  if (first.startsWith("-")) return gitLocally(rest)
  if (first === "remote")
    return ["-v", "--verbose", "get-url", "add", "remove", "rm", "rename", "set-url", undefined].includes(rest[0])
  if (first === "submodule") return rest[0] === "status"
  return GIT_LOCAL.has(first)
}

// A heredoc's body is data for the command that reads it, not commands of its own.
function withoutHeredocs(command: string) {
  return command
    .split("\n")
    .reduce<{ lines: string[]; until?: string }>(
      (state, line) => {
        if (state.until !== undefined) return line.trim() === state.until ? { lines: state.lines } : state
        const heredoc = /<<-?\s*["']?([A-Za-z_][\w-]*)["']?/.exec(line)?.[1]
        return { lines: [...state.lines, line], ...(heredoc ? { until: heredoc } : {}) }
      },
      { lines: [] },
    )
    .lines.join("\n")
}

/**
 * The simple commands of a command line, each as its words: split at `;`, `&`, `|` and newlines outside quotes, with
 * `$(…)` and backticks as commands of their own (they run inside double quotes too), and comments dropped.
 */
function simple(line: string) {
  const out: string[][] = []
  // The quoting each open `$(` or backtick interrupted, restored when it closes.
  const open: { readonly quote: string | undefined; readonly tick: boolean }[] = []
  let words: string[] = []
  let word = ""
  let quote: string | undefined
  const end = () => {
    if (word) words.push(word)
    word = ""
  }
  const cut = () => {
    end()
    if (words.length) out.push(words)
    words = []
  }
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    const next = line[index + 1]
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
      continue
    }
    if (char === "\\") {
      if (next !== "\n") word += next ?? ""
      index++
      continue
    }
    if (char === "$" && next === "(") {
      cut()
      open.push({ quote, tick: false })
      quote = undefined
      index++
      continue
    }
    if (char === "`") {
      cut()
      if (open.at(-1)?.tick) quote = open.pop()!.quote
      else {
        open.push({ quote, tick: true })
        quote = undefined
      }
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = undefined
      else word += char
      continue
    }
    if (char === ")" && open.length && !open.at(-1)!.tick) {
      cut()
      quote = open.pop()!.quote
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (char === "#" && word === "") {
      const stop = line.indexOf("\n", index)
      index = stop < 0 ? line.length : stop - 1
      continue
    }
    // `2>&1` and `&>` are redirections; `&&`, `&` and `|` end a command.
    if (char === "&" && (word.endsWith(">") || word.endsWith("<") || next === ">")) {
      word += char
      continue
    }
    if (char === ";" || char === "&" || char === "|" || char === "\n" || char === "(" || char === ")") {
      cut()
      continue
    }
    if (char === " " || char === "\t") {
      end()
      continue
    }
    word += char
  }
  cut()
  return out
}

// Package installs reach a registry, though what they print is this computer's own, so they count as network commands.
const INSTALLS =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci|update|up|upgrade)|(?:pip3?|uv|poetry|pipenv)\s+(?:install|add|sync|lock|update)|uv\s+pip\s+install|gem\s+install|cargo\s+(?:install|fetch|update)|go\s+(?:get|install|mod\s+download)|brew\s+(?:install|upgrade|update)|(?:apt|apt-get|dnf|yum)\s+(?:install|update|upgrade)|playwright\s+install)\b/

// Builds that fetch the dependencies they lack: Maven and Gradle unless told to stay offline, dotnet's restore (which
// build, run, test and publish start with), SwiftPM and Xcode's package resolution, Mix's deps and Hex, Cargo unless
// offline, and Go's module downloads.
const FETCHING_BUILDS =
  /(?:^|[\s;&|(])(?:(?:(?:\.\/)?(?:mvnw?|gradlew?))(?![^;&|]*\s(?:-o|--offline)\b)|dotnet\s+(?:restore|build|run|test|publish|pack|add|workload|tool\s+(?:install|update|restore))|swift\s+(?:build|run|test|package\s+(?:resolve|update|fetch|edit))|mix\s+(?:deps\.get|deps\.update|hex\.\S+|archive\.install|local\.hex|local\.rebar)|cargo\s+(?:build|b|run|r|test|t|check|c|clippy|doc|bench|add|vendor|generate-lockfile)(?![^;&|]*\s(?:--offline|--frozen)\b)|go\s+(?:build|run|test|generate|mod\s+tidy|work\s+sync)|xcodebuild(?![^;&|]*\s(?:-disableAutomaticPackageResolution|-version|-help|-usage|-showsdks)\b))(?=[\s;&|)]|$)/

// A web address opened in the default browser, which is signed in to the user's accounts. A file opened is not, nor
// is a Windows path such as C:\notes.txt.
const OPENS_ADDRESS =
  /(?:^|[\s;&|(])(?:open|xdg-open|start|wslview|gio\s+open|explorer(?:\.exe)?)\s+(?:[^;&|]*\s)?["']?(?!file:)[a-z][a-z0-9+.-]+:/i

/**
 * Whether a shell command may reach the network: its output is not this computer's own, it installs packages, it
 * builds with dependencies it may fetch, or it opens a web address. A script an interpreter runs (`node script.js`,
 * `python3 build.py`) or a repository's own script (`npm test`, `make`) counts as local, so it may still connect.
 */
export function networked(command: string) {
  return !local(command) || INSTALLS.test(command) || FETCHING_BUILDS.test(command) || OPENS_ADDRESS.test(command)
}
