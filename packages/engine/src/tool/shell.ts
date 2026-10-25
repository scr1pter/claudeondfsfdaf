import { Effect, Exit, Fiber, Stream } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { InstanceState } from "@/effect/instance-state"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { FSUtil } from "@vectordevai/core/fs-util"
import { fileURLToPath } from "url"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@vectordevai/core/shell"
import { untrustedChildEnvironment } from "@vectordevai/core/child-environment"
import { ShellID } from "./shell/id"
import { Sandbox } from "./shell/sandbox"
import { CloudCli } from "./shell/cloud-cli"
import { UNREAD } from "./shell/unread"

import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { BashArity } from "@/permission/arity"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { LocalCommand } from "@vectordevai/core/local-mode/command"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const CWD = new Set(["cd", "chdir", "popd", "pushd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  "get-content",
  "set-content",
  "add-content",
  "clear-content",
  "get-item",
  "set-item",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
// PowerShell's built-in aliases for the cmdlets above that do not share a name with the bash entries, so `gc`, `sc`
// or `gi` is checked as the cmdlet it runs. The scan maps a command name through this once, where it lowercases it.
const PS_ALIASES = new Map([
  ["ac", "add-content"],
  ["clc", "clear-content"],
  ["copy", "copy-item"],
  ["cpi", "copy-item"],
  ["del", "remove-item"],
  ["erase", "remove-item"],
  ["gc", "get-content"],
  ["gi", "get-item"],
  ["md", "new-item"],
  ["mi", "move-item"],
  ["move", "move-item"],
  ["ni", "new-item"],
  ["rd", "remove-item"],
  ["ren", "rename-item"],
  ["ri", "remove-item"],
  ["rmdir", "remove-item"],
  ["rni", "rename-item"],
  ["sc", "set-content"],
  ["si", "set-item"],
  ["sl", "set-location"],
  ["type", "get-content"],
])
// Variable qualifiers that name plain variables or environment variables rather than an item of another provider.
const PS_SCOPES = new Set(["env", "variable", "global", "local", "script", "private", "using", "workflow"])
// The built-in drives whose items are not files. Any other drive of more than one letter (`Temp:`, or one a profile
// creates with New-PSDrive) may map a folder anywhere on disk.
const PS_ITEM_DRIVES = new Set(["alias", "cert", "function", "hkcu", "hklm", "wsman"])
const CMD_FILES = new Set([
  "copy",
  "del",
  "dir",
  "erase",
  "md",
  "mkdir",
  "move",
  "rd",
  "ren",
  "rename",
  "rmdir",
  "type",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
  writes: Set<string>
  /** Files a command reads that the read tool's rules apply to, relative to the worktree. */
  reads: Set<string>
  /** Vercel and Supabase CLI calls that act on a cloud account, by permission pattern. */
  cloud: Map<string, CloudCli.Request & { command: string }>
}

type Chunk = {
  text: string
  size: number
}

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

// A command's name and arguments. Numbers and expansions are arguments too:
// without them `timeout 60 vercel` would read as `timeout vercel`, and the
// word after a wrapper's duration would be taken for the duration.
const ARGUMENTS = new Set([
  "command_name",
  "command_name_expr",
  "word",
  "string",
  "raw_string",
  "concatenation",
  "number",
  "simple_expansion",
  "expansion",
  "command_substitution",
  "arithmetic_expansion",
  "ansi_c_string",
  "translated_string",
])

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (!ARGUMENTS.has(child.type)) continue
    out.push({ type: child.type, text: child.text })
  }
  // bash passes the words after a redirect's file to the command (`cat 2>/dev/null .env` reads `.env`), but the grammar
  // keeps them with the redirect.
  return [...out, ...redirectsOf(node).flatMap((item) => bashRedirect(item)?.rest ?? [])]
}

function source(node: Node) {
  if (node.parent?.type === "redirected_statement") return node.parent.text.trim()
  const redirected = redirectsOf(node)
  return (redirected.length ? [node.text, ...redirected.map((item) => item.text)].join(" ") : node.text).trim()
}

// The redirects of a command. bash binds a redirect after `a && b`, `a | b` or `! b` to `b`, but the grammar attaches
// it to the whole statement.
function redirectsOf(node: Node): Node[] {
  const parent = node.parent
  if (!parent) return []
  if (parent.type === "redirected_statement")
    return parent.children.filter((child): child is Node => child?.type === "file_redirect")
  if (!["list", "pipeline", "negated_command"].includes(parent.type) || parent.lastNamedChild?.id !== node.id) return []
  return redirectsOf(parent)
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

// Bash statements that change the shell instead of running a program. None of
// them is a `command` node, so without these `export GIT_EXTERNAL_DIFF=/bin/sh;
// git diff` would be checked only as `git diff`.
const STATEMENTS = [
  "declaration_command",
  "unset_command",
  "function_definition",
  "variable_assignment",
  "variable_assignments",
]
const ASSIGNMENTS = new Set(["variable_assignment", "variable_assignments"])
// An assignment inside one of these (`A=1 git diff`, `export A=1`) is already
// part of that statement's pattern.
const OWNERS = new Set(["command", "declaration_command", "variable_assignments"])

// A statement the scan cannot fully read is approved only as written, behind a prefix no allow rule matches (see
// shell/unread.ts), so the read-only agents refuse it and anyone else is asked.
function unread(scan: Scan, text: string) {
  scan.patterns.add(UNREAD + text.trim())
  scan.always.add(UNREAD + text.trim())
}

// Whether bash or zsh would run a command substitution the grammar keeps as plain text: a backtick or `$(` in an
// unquoted heredoc body, in a `${VAR#...}` operand or on the right of `[[ x =~ ... ]]`. Single quotes, `$'...'` and a
// heredoc whose delimiter is quoted keep them literal, and so does a backslash, except that inside backticks an escaped
// backtick opens a nested substitution. A position the parse cannot place counts as hidden.
function hiddenSubstitution(root: Node, zsh: boolean) {
  const text = root.text
  // bash and zsh remove a backslash-newline before they read a word, so `$\` then a newline then `(` opens a
  // substitution the grammar never sees.
  const openers = (value: string) => value.match(/`|\$\(/g)?.length ?? 0
  if (/\\\r?\n/.test(text) && openers(text.replace(/\\\r?\n/g, "")) > openers(text)) return true
  const at = (node: Node) => {
    const start = node.startIndex - root.startIndex
    return text.slice(start, start + node.text.length) === node.text ? start : undefined
  }
  const literal: [number, number][] = []
  for (const node of root.descendantsOfType(["raw_string", "ansi_c_string", "heredoc_redirect"])) {
    if (!node) continue
    const bodies =
      node.type !== "heredoc_redirect"
        ? [node]
        : node.descendantsOfType("heredoc_start").some((start) => start && /['"\\]/.test(start.text))
          ? node.descendantsOfType("heredoc_body")
          : []
    for (const body of bodies) {
      if (!body) continue
      const start = at(body)
      if (start === undefined) return true
      literal.push([start, start + body.text.length])
    }
  }
  const opened = new Set<number>()
  const backticks: [number, number][] = []
  for (const node of root.descendantsOfType(["command_substitution", "process_substitution", "arithmetic_expansion"])) {
    if (!node) continue
    const start = at(node)
    if (start === undefined) return true
    opened.add(start)
    if (!node.text.startsWith("`")) continue
    opened.add(start + node.text.length - 1)
    backticks.push([start, start + node.text.length])
  }
  const within = (ranges: [number, number][], index: number) =>
    ranges.some(([start, end]) => index >= start && index < end)
  // zsh runs code through syntax the bash grammar does not model: parameter flags (`${(e)X}`) and glob qualifiers
  // (`*(e:...:)`, `*(+fn)`). Outside quotes, a parenthesised group stuck to a word is read as one; inside double
  // quotes only the flags are live.
  if (zsh) {
    const quoted: [number, number][] = []
    for (const node of root.descendantsOfType("string")) {
      if (!node) continue
      const start = at(node)
      if (start === undefined) return true
      quoted.push([start, start + node.text.length])
    }
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== "(" || within(literal, index)) continue
      if (text.slice(index - 2, index) === "${") return true
      if (within(quoted, index) || text[index + 1] === ")") continue
      if (index > 0 && !/[\s$<>=(|&;]/.test(text[index - 1])) return true
    }
  }
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "`" && !(text[index] === "$" && text[index + 1] === "(")) continue
    if (opened.has(index) || within(literal, index)) continue
    let slashes = 0
    while (text[index - 1 - slashes] === "\\") slashes++
    if (slashes % 2 === 1 && !(text[index] === "`" && within(backticks, index))) continue
    return true
  }
  return false
}

function statements(node: Node) {
  return node
    .descendantsOfType(STATEMENTS)
    .filter((child): child is Node => Boolean(child))
    .filter((child) => !ASSIGNMENTS.has(child.type) || !OWNERS.has(child.parent?.type ?? ""))
}

// Output redirects that write a file. `>&` and `<&` only duplicate a descriptor unless their target is a file name.
const WRITES = new Set([">", ">>", "&>", "&>>", ">|", ">&"])
const DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "$null", "nul"])
// Devices a command may read from without reading a file.
const INPUTS = new Set(["/dev/stdin", "/dev/zero", "/dev/random", "/dev/urandom"])

// The files a statement's redirects write. A redirect target is never one of the command's arguments, so without
// this `git status > src/index.ts` would be checked only as `git status`. `<>` opens its file for writing too.
function redirects(node: Node, ps: boolean) {
  const targets = ps
    ? psRedirects(node, false)
    : node.descendantsOfType("file_redirect").flatMap((item) => {
        const redirect = item && bashRedirect(item)
        if (!redirect || !(WRITES.has(redirect.operator) || redirect.operator === "<>")) return []
        if (redirect.operator === ">&" && /^(\d+|-)$/.test(redirect.target)) return []
        return [redirect.target]
      })
  return targets.filter((target) => target && !DEVICES.has(target.toLowerCase()))
}

// Input redirects (`< .env`, and `<>`, which reads as well as writes).
function inputRedirects(node: Node, ps: boolean) {
  if (ps) return psRedirects(node, true)
  return node.descendantsOfType("file_redirect").flatMap((item) => {
    const redirect = item && bashRedirect(item)
    return redirect && (redirect.operator === "<" || redirect.operator === "<>") ? [redirect.target] : []
  })
}

// A bash redirect's operator, the file it names, and the words after that file, which bash passes to the command
// although the grammar keeps them with the redirect (`cat < a b`). The grammar splits `<>` around an error node.
function bashRedirect(item: Node) {
  const children = item.children.filter((child): child is Node => child !== null && child.type !== "file_descriptor")
  const index = children.findIndex((child) => child.isNamed && child.type !== "ERROR")
  if (index === -1) return
  return {
    operator: children
      .slice(0, index)
      .map((child) => child.text)
      .join(""),
    target: children[index].text,
    rest: children.slice(index + 1).map((child) => ({ type: child.type, text: child.text })),
  }
}

// PowerShell's redirect targets, either the ones `<` reads from or the ones every other file operator writes.
// PowerShell reserves `<` and refuses to parse a script that uses it, so its target is never written, but it still
// names the file the way bash's `< .env` does.
function psRedirects(node: Node, input: boolean) {
  return node.descendantsOfType("redirection").flatMap((item) => {
    const operator = item?.children.find((child) => child?.type === "file_redirection_operator")?.text
    const target = item?.children.find((child) => child?.type === "redirected_file_name")?.text.trim()
    if (!operator || !target || (operator === "<") !== input) return []
    return [target]
  })
}

// The environment files the read tool asks for by default (`*.env`, `*.env.*`,
// but not `*.env.example`), so a shell command that names one asks the same way.
const ENV_FILE = /\.env(\.(?!example$)[^/\\]*)?$/
// The names a Windows wildcard is tested against when the scan cannot list the folder it would match in.
const ENV_NAMES = [".env", ".env.local", ".env.development", ".env.production", ".env.test"]
// What PowerShell (`$name`, `${name}`, `$(...)`) and cmd (`%NAME%`, `!NAME!`) expand inside a word.
const PS_EXPANSION = /\$\([^)]*\)?|\$\{[^}]*\}?|\$[\w:?]+/g
const CMD_EXPANSION = /%[^%]*%|![^!]*!/g
// What bash expands inside a word once its quotes are gone: `$name`, `${...}`, `$(...)` and `` `...` ``.
const BASH_EXPANSION = /\$\([^)]*\)?|\$\{[^}]*\}?|\$(?:[A-Za-z_]\w*|[0-9?!#@*$-])|`[^`]*`?/g

// A wildcard as a regular expression over names, lower-case ones for PowerShell and cmd. There `?` may also match
// nothing, as cmd lets a trailing one do. A `[...]` set stands for any one character, so the test can only match more.
// bash matches a leading dot only when the name spells it (`.en?`, not `*` or `?env`), which `hidden` says.
function wildcard(glob: string, win: boolean, hidden = win || !/^[*?[]/.test(glob)) {
  const source = (win ? glob.toLowerCase() : glob).replace(/\[[^\]]*\]|[*?]|[^*?[]+|\[/g, (part) => {
    if (part === "*") return ".*"
    if (part === "?") return win ? ".?" : "."
    if (part.length > 1 && part.startsWith("[")) return "."
    return part.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  })
  return new RegExp(`^${hidden ? "" : "(?!\\.)"}${source}$`, "s")
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

// The word a program gets from cmd: `^` escapes the next character outside double quotes, and the quotes themselves
// are dropped, so `.e^nv` and `".e"nv` both open `.env`.
function cmdWord(text: string) {
  return text.replace(
    /"([^"]*)"?|\^([\s\S]?)/g,
    (_, quoted: string | undefined, escaped: string | undefined) => quoted ?? escaped ?? "",
  )
}

// The word a program gets from bash once bash removes quotes and escapes: `.e""nv`, `.e\nv`, `$'.env'` and
// `$'\x2eenv'` all open `.env`. An expansion is kept as written, so a word that holds one stays unknown.
function bashWord(text: string) {
  return text.replace(
    /\\([\s\S]?)|'([^']*)'?|\$'((?:\\[\s\S]|[^'\\])*)'?|\$?"((?:\\[\s\S]|[^"\\])*)"?|\$\([^)]*\)?|\$\{[^}]*\}?|`[^`]*`?/g,
    (match, escaped?: string, single?: string, ansi?: string, double?: string) => {
      if (escaped !== undefined) return escaped === "\n" ? "" : escaped
      if (single !== undefined) return single
      if (ansi !== undefined) return ansiC(ansi)
      if (double !== undefined) return double.replace(/\\\n/g, "").replace(/\\([$`"\\])/g, "$1")
      return match
    },
  )
}

// The text of a bash `$'...'` string, with its escapes decoded as bash decodes them.
function ansiC(text: string) {
  return text.replace(
    /\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3})|c([\s\S])|([\s\S]))/g,
    (match, hex?: string, short?: string, long?: string, octal?: string, control?: string, other?: string) => {
      if (hex) return String.fromCharCode(parseInt(hex, 16))
      const point = short ?? long
      if (point) return parseInt(point, 16) <= 0x10ffff ? String.fromCodePoint(parseInt(point, 16)) : match
      if (octal) return String.fromCharCode(parseInt(octal, 8) & 0xff)
      if (control !== undefined) return String.fromCharCode(control.charCodeAt(0) & 0x1f)
      return ANSI_ESCAPES[other ?? ""] ?? match
    },
  )
}

const ANSI_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

// A word as the program it is passed to gets it: unquoted, with PowerShell's `$env:`, `$HOME` and `$PWD` expanded,
// PowerShell's backtick escapes, cmd's `^` escapes and double quotes, and bash's quotes and escapes removed, so a path
// rule tests the file the program opens.
function shellWord(arg: string, cwd: string, ps: boolean, shell: string) {
  if (ps) return expand(arg, cwd, shell).replace(/`([\s\S])/g, "$1")
  if (Shell.name(shell) === "cmd") return home(cmdWord(unquote(arg)))
  return home(bashWord(arg))
}

// A word split into its folder and the name of the file it opens. Windows opens a name whatever its case and without its
// trailing spaces and dots: `.ENV` and `'.env '` are `.env`. NTFS ends a file name at its first colon: `.env::$DATA` is
// the file's own content and `.env:notes` one of its alternate streams. A colon inside an expansion (`%X:~0,0%`) is not
// part of the name. These rules hold for PowerShell and cmd on any system, so the scan does not depend on where it runs.
function fileName(word: string, win: boolean, expansion: RegExp) {
  const base = win ? path.win32.basename(word) : path.basename(word)
  const dir = word.slice(0, word.length - base.length)
  if (!win) return { dir, name: base }
  const colon = base.replace(expansion, (text) => "*".repeat(text.length)).indexOf(":")
  return { dir, name: (colon === -1 ? base : base.slice(0, colon)).replace(/[ .]+$/, "") }
}

// A provider may be named with its module (`Microsoft.PowerShell.Core\FileSystem::C:\x`).
function provider(text: string) {
  const match = text.match(/^(?:[\w.]+\\)?([A-Za-z]+)::(.*)$/s)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

// The item a PowerShell variable reaches through a provider: `${C:\x}`, `$c:x` and `${FileSystem::C:\x}` read and
// write a file, `${function:git}` a function. `file` is the file system path, when there is one, and `folder` marks a
// drive that may map a folder the scan cannot place. Environment variables (`$env:A`) and scoped variables
// (`$global:a`) are plain variables.
function providerItem(text: string) {
  const name = text.startsWith("${") ? text.slice(2, -1).replace(/`([\s\S])/g, "$1") : text.slice(1)
  const qualified = name.match(/^(?:[\w.]+\\)?(\w+)::(.*)$/s)
  if (qualified) {
    const kind = qualified[1].toLowerCase()
    if (kind === "environment" || kind === "variable") return
    return { name, file: kind === "filesystem" ? qualified[2] : undefined, folder: false }
  }
  const drive = name.match(/^(\w+):/)
  if (!drive || PS_SCOPES.has(drive[1].toLowerCase())) return
  if (drive[1].length === 1) return { name, file: name, folder: false }
  return { name, file: undefined, folder: !PS_ITEM_DRIVES.has(drive[1].toLowerCase()) }
}

// How a statement uses a variable: `${C:\x} = 'v'` and a foreach loop only write it, `+=`, `++` and `--` read and
// write it, and anywhere else it is read.
function variableUse(node: Node) {
  if (node.parent?.type === "foreach_statement") return { read: false, write: true }
  for (let item = node.parent; item && item.type !== "statement_list"; item = item.parent) {
    if (/^(pre|post)_(increment|decrement)_expression$/.test(item.type)) return { read: true, write: true }
    // Reached from the value side of an assignment.
    if (item.type === "assignment_expression") break
    if (item.type !== "left_assignment_expression") continue
    const operator = item.parent?.children.find((child) => child?.type === "assignement_operator")?.text
    return { read: operator !== "=" || item.text.trim() !== node.text, write: true }
  }
  return { read: true, write: false }
}

function dynamic(text: string, ps: boolean, cmd: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  // cmd expands `%USERPROFILE%` (and `!NAME!` under delayed expansion) before the program sees the word, so
  // `%USERPROFILE%\.ssh\id_rsa` would otherwise pass for a path inside the project. Its `^` escapes are already gone.
  if (cmd && /[%!]/.test(text)) return true
  // Left over from home(): bash expands `~root`, `~+` and `~-` to directories the scan does not know.
  return text.includes("$") || text.startsWith("~")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean, cmd = false) {
  if (!ps) {
    return list
      .slice(1)
      .filter(
        (item) =>
          !item.text.startsWith("-") &&
          !(cmd && item.text.startsWith("/")) &&
          !(list[0]?.text === "chmod" && item.text.startsWith("+")),
      )
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

// What a command's output costs the model: unless tool_output.max_bytes is configured, a shell result keeps 30KB, close
// to what Claude Code sends, rather than the 50KB generic cap. Builds and test runs print the cause of a failure at
// the start and the summary at the end, so both ends are kept.
const SHELL_OUTPUT_BYTES = 30_000

function shellBudget(cfg: { tool_output?: { max_bytes?: number } }, limits: { maxLines: number; maxBytes: number }) {
  return {
    maxLines: limits.maxLines,
    maxBytes: cfg.tool_output?.max_bytes ?? Math.min(limits.maxBytes, SHELL_OUTPUT_BYTES),
  }
}

// The first 40% of the budget from the start of the output and the rest from its end, with what was left out between.
function headAndTail(input: {
  head: string
  rest: string
  total: number
  cut: boolean
  maxLines: number
  maxBytes: number
}) {
  if (!input.cut && input.rest.split("\n").length <= input.maxLines && input.total <= input.maxBytes)
    return { text: input.rest, cut: false }
  const start = head(input.head, Math.floor(input.maxLines * 0.4), Math.floor(input.maxBytes * 0.4))
  const end = tail(input.rest, Math.ceil(input.maxLines * 0.6), Math.ceil(input.maxBytes * 0.6)).text
  const omitted = Math.max(0, input.total - Buffer.byteLength(start, "utf-8") - Buffer.byteLength(end, "utf-8"))
  return { text: `${start}\n\n...${omitted} bytes omitted...\n\n${end}`, cut: true }
}

function head(text: string, maxLines: number, maxBytes: number) {
  const out: string[] = []
  let bytes = 0
  for (const line of text.split("\n")) {
    const size = Buffer.byteLength(line, "utf-8") + (out.length > 0 ? 1 : 0)
    if (out.length >= maxLines || bytes + size > maxBytes) break
    out.push(line)
    bytes += size
  }
  return out.join("\n")
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("ShellTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => (ps ? psParser() : bashParser()).then((parser) => parser.parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree
})

// The Vercel and Supabase CLI calls a command makes, including those in a
// command line it runs from a string (`sh -c "vercel --prod"`, `eval ...`),
// which is parsed as bash and checked command by command. Each level is a
// strictly shorter string; the depth limit only bounds pathological nesting.
const cloudRequests = Effect.fn("ShellTool.cloudRequests")(function* (
  tokens: string[],
  depth: number,
): Effect.fn.Return<CloudCli.Request[]> {
  const found = CloudCli.request(tokens)
  if (found) return [found]
  const inner = CloudCli.script(tokens)
  if (!inner?.trim() || depth >= 8) return []
  const tree = yield* parse(inner, false)
  const nested = yield* Effect.forEach(commands(tree.rootNode), (node) =>
    cloudRequests(
      parts(node).map((item) => item.text),
      depth + 1,
    ),
  )
  return nested.flat()
})

const ask = Effect.fn("ShellTool.ask")(function* (
  ctx: Tool.Context,
  scan: Scan,
  input: { readonly command: string; readonly unread?: boolean; readonly recalled?: boolean },
) {
  if (scan.dirs.size > 0) {
    const directories = Array.from(scan.dirs)
    const globs = directories.map((dir) => {
      if (process.platform === "win32") return FSUtil.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {
        command: input.command,
        directories,
        patterns: globs,
      },
    })
  }

  // The same permission the edit tool asks for, so an agent that may not edit files cannot write one through a redirect.
  if (scan.writes.size > 0) {
    yield* ctx.ask({
      permission: "edit",
      patterns: Array.from(scan.writes),
      always: ["*"],
      metadata: {
        command: input.command,
        files: Array.from(scan.writes),
      },
    })
  }

  if (scan.patterns.size > 0) {
    yield* ctx.ask({
      permission: ShellID.ToolID,
      patterns: Array.from(scan.patterns),
      always: Array.from(scan.always),
      metadata: {
        command: input.command,
      },
    })
  }

  // With Vector Local on, a command that may reach the network asks first, with the command shown: one whose output is
  // not this computer's own (LocalCommand.local: a fetch, a push, a publish, a program Vector does not know, commands a
  // shell reads from its input), a package install, a build that fetches dependencies, or a web address opened in the
  // default browser. Vector does not see where such a command connects, so it asks every time: no saved approval, rule
  // or auto-accept answers it (PermissionPolicy.requiresApproval). A terminal line Vector cannot read asks too, whatever
  // its typed text says: the shell may run a recalled or completed line instead, so it counts as a program Vector does
  // not know.
  if (scan.patterns.size > 0 && Egress.policy().enabled && (input.unread || LocalCommand.networked(input.command))) {
    yield* ctx.ask({
      permission: PermissionPolicy.NETWORK_COMMAND,
      patterns: [input.unread ? UNREAD + input.command.trim() : input.command],
      always: [],
      metadata: {
        command: input.command,
        reason: input.unread ? UNREAD_NETWORK_REASON : PermissionPolicy.NETWORK_COMMAND_REASON,
      },
    })
  }

  // The read tool's permission and patterns, so the read rules that ask for
  // `.env` files (and a session that may not read them) apply to the shell too.
  // Asked even when the command has no shell pattern: a statement whose only
  // command changes directory (`cd ${C:\proj\.env}`, `cd "$(<.env)"`) adds none,
  // yet still reads the file and prints it in the error.
  if (scan.reads.size > 0) {
    yield* ctx.ask({
      permission: "read",
      patterns: Array.from(scan.reads),
      always: Array.from(scan.reads),
      metadata: {
        command: input.command,
        files: Array.from(scan.reads),
      },
    })
  }

  if (scan.patterns.size === 0) return
  // A terminal line the shell may have filled from its history, its kill ring or a completion may be a Vercel or
  // Supabase command the scan never saw, so it asks every time as one would.
  if (input.recalled) {
    yield* ctx.ask({
      permission: PermissionPolicy.CLOUD_UNREAD,
      patterns: [UNREAD + input.command.trim()],
      always: [],
      metadata: {
        command: input.command,
        summary: RECALLED_SUMMARY,
      },
    })
  }
  // After the shell's own permission, so a session that may not run the command
  // is refused without a cloud prompt. These ask every time, as vector_cloud's
  // own actions do: auto-accept and allow rules never answer them.
  for (const [pattern, item] of scan.cloud) {
    yield* ctx.ask({
      permission: item.permission,
      patterns: [pattern],
      always: [],
      metadata: {
        command: input.command,
        provider: item.provider,
        environment: item.environment,
        action: item.action,
        summary: `Run \`${item.command}\` in the shell. It would ${item.summary} with the ${item.provider} command-line tool's own login, outside Vector Cloud.`,
      },
    })
  }
})

const UNREAD_NETWORK_REASON =
  "Vector Local is on, and Vector cannot read what this terminal line runs: the shell recalled, completed or edited part of it. It may connect to the network."

const RECALLED_SUMMARY =
  "Run a terminal line Vector cannot read: the shell may have recalled it from its history or completed part of it. It may run a Vercel or Supabase command with the command-line tool's own login, outside Vector Cloud."

// Whether Vector Local is on with Web access None, which it also is while the policy is still being resolved.
function webNone() {
  const policy = Egress.policy()
  return policy.enabled && policy.web === "none"
}

const cmd = Effect.fn("ShellTool.cmd")(function* (
  shell: string,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  workspaceRoot: string,
  ctx: Tool.Context,
  offline: Sandbox.Offline | undefined,
) {
  // With Vector Local's Web access None the command runs in the sandbox with no network but this computer's, whatever
  // VECTOR_SHELL_SANDBOX says, and is never run unwrapped (Sandbox.offline). Windows has no sandbox: there it runs as
  // below, and its notice says so.
  if (offline?.type === "refused") return yield* Effect.die(new Error(offline.message))
  if (offline?.type === "sandboxed") {
    yield* Effect.logInfo("shell tool sandbox", {
      sandboxed: true,
      mechanism: offline.wrapped.mechanism,
      network: "none",
      workspaceRoot,
      cwd,
    })
    return ChildProcess.make(offline.wrapped.command, offline.wrapped.args, {
      shell: false,
      cwd,
      env: offline.wrapped.env,
      stdin: "ignore",
      detached: true,
    })
  }

  if (Sandbox.sandboxEnabled()) {
    const wrapped = Sandbox.wrapCommand({ shell, command, cwd, env, workspaceRoot })
    yield* Effect.logInfo("shell tool sandbox", {
      sandboxed: wrapped.sandboxed,
      mechanism: wrapped.mechanism,
      workspaceRoot,
      cwd,
      ...(wrapped.reason ? { reason: wrapped.reason } : {}),
    })
    if (!wrapped.sandboxed) {
      yield* ctx.ask({
        permission: "unsandboxed_shell",
        patterns: [process.platform],
        always: [process.platform],
        metadata: {
          command,
          platform: process.platform,
          reason: wrapped.reason ?? "Vector could not apply the shell sandbox.",
        },
      })
    }
    return ChildProcess.make(wrapped.command, wrapped.args, {
      shell: wrapped.shell,
      cwd,
      env: wrapped.env,
      stdin: "ignore",
      detached: process.platform !== "win32",
    })
  }

  yield* Effect.logWarning("shell tool sandbox disabled", { workspaceRoot, cwd })

  if (process.platform === "win32" && Shell.ps(shell)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
})
const runtime = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  return Parser
})
// Each grammar loads on the first command in its language. The PowerShell grammar alone adds about 15 MiB, and a
// session whose shell is not PowerShell never parses with it.
const grammar = (wasm: () => Promise<{ default: string }>) =>
  lazy(async () => {
    const Parser = await runtime()
    const { default: asset } = await wasm()
    const parser = new Parser()
    parser.setLanguage(await Language.load(resolveWasm(asset)))
    return parser
  })
const bashParser = grammar(
  () =>
    import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
      with: { type: "wasm" },
    }),
)
const psParser = grammar(
  () =>
    import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
      with: { type: "wasm" },
    }),
)

/**
 * The shell tool's permission scan and asks, for a command line another tool hands to a shell (the terminal tool's
 * submitted lines). It reads with the child process spawner (git check-ignore, cygpath) and FSUtil, as the shell does.
 */
export const ShellPermission = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner
  const fs = yield* FSUtil.Service

  const cygpath = Effect.fn("ShellTool.cygpath")(function* (shell: string, text: string) {
    const lines = yield* spawner
      .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))
    const file = lines[0]?.trim()
    if (!file) return
    return FSUtil.normalizePath(file)
  })

  const resolvePath = Effect.fn("ShellTool.resolvePath")(function* (text: string, root: string, shell: string) {
    if (process.platform === "win32") {
      if (Shell.posix(shell) && text.startsWith("/") && FSUtil.windowsPath(text) === text) {
        const file = yield* cygpath(shell, text)
        if (file) return file
      }
      return FSUtil.normalizePath(path.resolve(root, FSUtil.windowsPath(text)))
    }
    return path.resolve(root, text)
  })

  const argPath = Effect.fn("ShellTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
    return yield* wordPath(shellWord(arg, cwd, ps, shell), cwd, ps, shell)
  })

  // The path a word names once its shell has read it (see shellWord), or nothing when the scan cannot know it.
  const wordPath = Effect.fn("ShellTool.wordPath")(function* (text: string, cwd: string, ps: boolean, shell: string) {
    const file = text && prefix(text)
    if (!file || dynamic(file, ps, Shell.name(shell) === "cmd")) return
    const next = ps ? provider(file) : file
    if (!next) return
    return yield* resolvePath(next, cwd, shell)
  })

  // Whether git, started in cwd, finds a work tree that holds every path. check-ignore refuses a path outside the
  // work tree, and a start with none, by the same test git diff uses before it compares two whole files. A path the
  // scan could not resolve may point anywhere, and with none at all there is nothing to show inside. Nothing the
  // repository configures runs before the command is approved.
  const inWorkTree = Effect.fn("ShellTool.inWorkTree")(function* (paths: (string | undefined)[], cwd: string) {
    const known = paths.filter((item): item is string => item !== undefined)
    if (known.length === 0 || known.length < paths.length) return false
    const code = yield* spawner
      .exitCode(
        ChildProcess.make("git", ["-c", "core.fsmonitor=false", "check-ignore", "--", ...known], {
          cwd,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.catch(() => Effect.succeed(128)))
    return code === 0 || code === 1
  })

  const collect = Effect.fn("ShellTool.collect")(function* (
    root: Node,
    cwd: string,
    ps: boolean,
    shell: string,
    instance: InstanceContext,
  ) {
    const scan: Scan = {
      dirs: new Set<string>(),
      patterns: new Set<string>(),
      always: new Set<string>(),
      writes: new Set<string>(),
      reads: new Set<string>(),
      cloud: new Map(),
    }
    const shellKind = ShellID.toKind(Shell.name(shell))
    const win = ps || shellKind === "cmd"
    const list = commands(root).map((node) => {
      const command = parts(node)
      const tokens = command.map((item) => item.text)
      // PowerShell runs `Microsoft.PowerShell.Management\Get-Content` and its alias `gc` as Get-Content, cmd runs
      // `ty^pe` as `type`, and bash runs `c''at` as `cat`.
      const name = ps ? tokens[0]?.toLowerCase().replace(/^[\w.]+\\/, "") : tokens[0]
      return {
        node,
        command,
        tokens,
        cmd: ps
          ? name && (PS_ALIASES.get(name) ?? name)
          : name === undefined
            ? name
            : shellKind === "cmd"
              ? cmdWord(unquote(name)).toLowerCase()
              : bashWord(name),
      }
    })
    // `cat .env`, `grep KEY .env.local` or `source .env` read the same secrets the read tool asks for, so they ask
    // under read too. A name the scan cannot resolve (`"$HOME/.env"`, `%USERPROFILE%\.env`) is asked for as written.
    // The name is tested as the program gets it, so cmd's `type .e^nv` asks as `type .env` does.
    const expansion = ps ? PS_EXPANSION : win ? CMD_EXPANSION : BASH_EXPANSION
    const fold = (item: string) => (win ? item.toLowerCase() : item)
    const envRead = Effect.fnUntraced(function* (text: string) {
      const file = fileName(shellWord(text, cwd, ps, shell), win, expansion)
      if (ENV_FILE.test(fold(file.name))) return yield* readTarget(file.dir + file.name)
      // A wildcard (`.en?`, `.e*`) or an expansion inside the name (`.e%X:~0,0%nv`, `.e"$X"nv`) asks for each
      // environment file it would open in its folder or, when the scan cannot list that folder, for one it could
      // open. A name that is only an expansion (`$file`) may be anything, as `cat $file` may be in bash.
      // bash's brace expansion (`.e{n,}v`) and zsh's glob syntax (`.e(n|x)v`, `.env(N)`) open names a plain wildcard
      // would, so each group counts as one.
      const named = win ? file.name : file.name.replace(/\{[^{}]*(?:,|\.\.)[^{}]*\}/g, "*").replace(/\([^()]*\)/g, "*")
      const glob = named.replace(expansion, "*")
      if (!file.name.replace(expansion, "") || !/[*?[]/.test(glob)) return yield* linkedEnv(file.dir + file.name)
      const folder = /[*?[]/.test(file.dir) ? undefined : yield* wordPath(file.dir || ".", cwd, ps, shell)
      const names = folder ? yield* entries(folder) : ENV_NAMES
      // An expansion may begin with the dot a wildcard would not match.
      const match = wildcard(glob, win, win || !/^[*?[]/.test(file.name))
      const found = names.filter((item) => ENV_FILE.test(fold(item)) && match.test(fold(item)))
      for (const item of folder ? found : found.slice(0, 1)) yield* readTarget(file.dir + item)
    })
    const entries = (folder: string) =>
      fs.readDirectoryEntries(folder).pipe(
        Effect.map((items) => items.map((entry) => entry.name)),
        Effect.catch(() => Effect.succeed([] as string[])),
      )
    // An input redirect opens its file whatever the file is called, and bash's `$(<file)` prints it without running
    // any command. So every file a redirect reads asks under read, as the read tool asks for it, and for its folder
    // when that lies outside the project, as `cat` of the same file does. A wildcard opens the one file it matches.
    const redirectRead = Effect.fnUntraced(function* (text: string) {
      yield* envRead(text)
      const word = shellWord(text, cwd, ps, shell)
      if (DEVICES.has(word.toLowerCase()) || INPUTS.has(word)) return
      // A target the scan cannot place (`< "$IN"`, `< ~other/x`, `< ~+/x`) may be any file, so it is approved only as
      // written.
      if (!win && (new RegExp(BASH_EXPANSION.source).test(word) || /^~[^/]/.test(word))) unread(scan, `< ${text}`)
      const file = fileName(word, win, expansion)
      // Inside or outside is decided on the file's real path, as the read tool decides it, so a link in the
      // repository to a file outside it asks for that folder.
      const folder = yield* real(yield* wordPath(file.dir || ".", cwd, ps, shell))
      if (folder && !containsPath(folder, instance)) scan.dirs.add(folder)
      const resolved = yield* real(
        /[*?[]/.test(file.name) ? undefined : yield* wordPath(file.dir + file.name, cwd, ps, shell),
      )
      if (resolved && !containsPath(resolved, instance)) scan.dirs.add(path.dirname(resolved))
      const match = wildcard(file.name, win)
      const opened = resolved
        ? [resolved]
        : folder
          ? (yield* entries(folder)).filter((item) => match.test(fold(item))).map((item) => path.join(folder, item))
          : []
      // A name the scan cannot resolve (`< "$IN"`), or a wildcard that matches nothing, is asked for as written.
      if (opened.length === 0) scan.reads.add(file.dir + file.name)
      for (const item of opened) scan.reads.add(path.relative(instance.worktree, item))
    })
    const real = (item: string | undefined) =>
      Effect.try({ try: () => (item ? FSUtil.realpath(item) : undefined), catch: (cause) => cause }).pipe(
        Effect.orElseSucceed(() => item),
      )
    // A link to an environment file, or on Windows its 8.3 short name (`ENV~1`), opens it under another name, so the
    // name it really has is tested too, as the read tool tests both.
    const linkedEnv = Effect.fnUntraced(function* (word: string) {
      const resolved = yield* wordPath(word, cwd, ps, shell)
      if (!resolved) return
      const real = yield* Effect.try({ try: () => FSUtil.realpath(resolved), catch: (cause) => cause }).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (!real || !ENV_FILE.test(win ? path.win32.basename(real).toLowerCase() : path.basename(real))) return
      scan.reads.add(path.relative(instance.worktree, real))
    })
    // A name with a wildcard (`*.env`) is asked for as written, not as the folder it starts in.
    const readTarget = Effect.fnUntraced(function* (word: string) {
      const resolved = /[*?[]/.test(word) ? undefined : yield* wordPath(word, cwd, ps, shell)
      scan.reads.add(resolved ? path.relative(instance.worktree, resolved) : word)
    })
    // A directory change anywhere in the command leaves unknown where git diff starts looking for its work tree.
    const moved = list.some((item) => item.cmd !== undefined && CWD.has(item.cmd))

    for (const item of list) {
      const tokens = item.tokens
      const cmd = item.cmd
      // `git diff` prints any two files once one of them lies outside the work tree (`git diff /dev/null ~/.ssh/id_rsa`),
      // --no-index or not, so its arguments are paths as much as cat's. A revision resolves inside the workspace.
      const diff = cmd === "git" && tokens[1] === "diff"
      const paths: (string | undefined)[] = []

      if (cmd && (FILES.has(cmd) || diff || (shellKind === "cmd" && CMD_FILES.has(cmd)))) {
        for (const arg of pathArgs(diff ? item.command.slice(1) : item.command, ps, shellKind === "cmd")) {
          const resolved = yield* argPath(arg, cwd, ps, shell)
          yield* Effect.logInfo("resolved path", { arg, resolved })
          paths.push(resolved)
          if (!resolved || containsPath(resolved, instance)) continue
          const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
          scan.dirs.add(dir)
        }
      }

      if (tokens.length && (!cmd || !CWD.has(cmd))) {
        scan.patterns.add(source(item.node))
        scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
      }
      // Outside a git work tree, or once one of its paths lies outside the work tree, `git diff a b` is
      // `git diff --no-index a b` and prints both whole files, directories included, so it answers to the rules
      // written for --no-index, such as the read-only specialists' deny. A path inside the project is not enough: a
      // nested repository or submodule ends the work tree at its own root, and a .git directory has none.
      // Without a path (`git diff`, `git diff --stat`) git only shows the work tree's own changes.
      if (
        diff &&
        !tokens.includes("--no-index") &&
        (instance.project.vcs !== "git" ||
          ((paths.length > 0 || tokens.includes("--")) && (moved || !(yield* inWorkTree(paths, cwd)))))
      )
        scan.patterns.add(["git", "diff", "--no-index", ...tokens.slice(2)].join(" "))

      for (const arg of item.command.slice(1)) yield* envRead(arg.text)

      for (const cloud of yield* cloudRequests(tokens, 0)) {
        const text = source(item.node)
        scan.cloud.set(
          [cloud.provider.toLowerCase(), path.basename(cwd), cloud.environment, `shell ${cloud.action}`].join("/"),
          { ...cloud, command: text.length > 200 ? `${text.slice(0, 200)}…` : text },
        )
      }
    }

    // `while read line; do ...; done < .env`. PowerShell refuses to parse `<`, so its file is never opened.
    for (const source of inputRedirects(root, ps)) yield* ps ? envRead(source) : redirectRead(source)
    // `$(<file)` prints a file without running a command, so it is checked like one, approved only as written.
    if (!ps) {
      for (const node of root.descendantsOfType("command_substitution")) {
        if (!node || node.descendantsOfType("command").length > 0) continue
        if (node.descendantsOfType("file_redirect").length === 0) continue
        scan.patterns.add(node.text)
        scan.always.add(node.text)
      }
    }

    // A .NET method call runs code without being a command (`[IO.File]::ReadAllText('.env')`), so without this a
    // statement made only of calls would run with no permission asked at all. Each chain of calls is checked like
    // a bash statement: approved only as written, and asking under read for an environment file it names.
    if (ps) {
      for (const node of root.descendantsOfType("invokation_expression")) {
        if (!node || node.parent?.type === "invokation_expression") continue
        scan.patterns.add(node.text)
        scan.always.add(node.text)
        for (const text of node.descendantsOfType("string_literal")) if (text) yield* envRead(text.text)
      }

      // A PowerShell statement need not run a command to act: `${C:\x}` reads a file and `$env:A = 1` changes what a
      // later command does. So a statement without a command, as well as every assignment and function definition,
      // is checked like bash's are, approved only as written. One nested in another is part of that one's text.
      const exact = [
        ...root
          .descendantsOfType("statement_list")
          .flatMap((list) => list?.namedChildren ?? [])
          .filter((node): node is Node => node !== null && node.type !== "comment" && node.type !== "empty_statement")
          .filter((node) => node.descendantsOfType("command").length === 0),
        ...root
          .descendantsOfType(["assignment_expression", "function_statement"])
          .filter((node): node is Node => Boolean(node)),
      ]
      // A command the grammar cannot parse (`Get-Content $dir/.en?`) may do anything the scan did not see.
      if (root.hasError) unread(scan, root.text)
      const ids = new Set(exact.map((node) => node.id))
      for (const node of exact) {
        let outer = node.parent
        while (outer && !ids.has(outer.id)) outer = outer.parent
        if (outer) continue
        scan.patterns.add(node.text.trim())
        scan.always.add(node.text.trim())
      }

      // A provider variable is a file read or write without a command (`$k = ${C:\Users\me\.ssh\id_rsa}`,
      // `${C:\Users\me\.bashrc} = 'evil'`), so it asks what the read and edit tools ask for that file, outside
      // the project too. An item of another provider (`${function:git} = { ... }`) is asked for as written.
      for (const node of root.descendantsOfType("variable")) {
        const item = node && providerItem(node.text)
        if (!node || !item) continue
        const use = variableUse(node)
        const resolved = item.file ? yield* resolvePath(item.file, cwd, shell) : undefined
        const target = resolved ? path.relative(instance.worktree, resolved) : item.name
        if (use.read) scan.reads.add(target)
        // The provider globs the path and reads a stream by its file's name, so `${C:\proj\.en?}` and
        // `${C:\proj\.env::$DATA}` read `.env` the way `Get-Content .en?` does.
        if (use.read && item.file) yield* envRead(item.file)
        if (use.write) scan.writes.add(target)
        if (resolved && !containsPath(resolved, instance)) scan.dirs.add(path.dirname(resolved))
        // A drive the scan cannot place (`${Temp:\x}`) is outside the project as far as it knows.
        if (item.folder) scan.dirs.add(path.win32.dirname(item.name))
      }

      // `switch -File .env { ... }` reads the file line by line.
      for (const node of root.descendantsOfType("switch_filename")) {
        if (!node) continue
        yield* envRead(node.text)
        const resolved = yield* argPath(node.text, cwd, ps, shell)
        if (resolved && !containsPath(resolved, instance)) scan.dirs.add(path.dirname(resolved))
      }
    }

    // A target that cannot be resolved (`> "$OUT"`) is asked for as written, so a rule that denies edits denies it.
    for (const target of redirects(root, ps)) {
      const resolved = yield* argPath(target, cwd, ps, shell)
      scan.writes.add(resolved ? path.relative(instance.worktree, resolved) : target)
      if (!resolved || containsPath(resolved, instance)) continue
      scan.dirs.add(path.dirname(resolved))
    }

    // PowerShell's grammar has none of these node types. "Always" approves
    // only the exact statement, since a changed environment or a redefined
    // name alters what an already-allowed command does.
    if (!ps) {
      for (const node of statements(root)) {
        const text = source(node)
        scan.patterns.add(text)
        scan.always.add(text)
      }
    }

    // bash and zsh: a command the grammar cannot parse, or one that hides a command substitution from it, may run
    // anything the scan did not see. A statement made only of redirects runs a program too (zsh's READNULLCMD).
    if (!ps && shellKind !== "cmd") {
      if (root.hasError || hiddenSubstitution(root, Shell.name(shell) === "zsh")) unread(scan, root.text)
      for (const node of root.descendantsOfType("redirected_statement")) {
        if (!node) continue
        if (node.namedChildren.every((child) => child?.type === "file_redirect" || child?.type === "heredoc_redirect"))
          unread(scan, node.text)
      }
    }

    // cmd is read with the bash grammar, which does not know cmd's syntax: in `for /f %a in (.env) do echo %a`, which
    // reads .env line by line, bash sees `.env` as a command in a subshell. So any cmd word may name an environment
    // file, and a command the grammar cannot parse is approved only as written.
    if (shellKind === "cmd") {
      for (const node of root.descendantsOfType(["word", "string", "raw_string", "concatenation"])) {
        if (node) yield* envRead(node.text)
      }
      if (root.hasError) unread(scan, root.text)
    }

    return scan
  })

  return {
    resolvePath,
    ask: Effect.fn("ShellPermission.ask")(function* (
      ctx: Tool.Context,
      input: {
        readonly command: string
        readonly cwd: string
        readonly shell: string
        // Vector could not tell exactly what runs: ask for the line only as written, behind the unread prefix. With
        // Vector Local on it also asks as a network command, since what runs may be any program.
        readonly unread?: boolean
        // The shell may have filled the line from its history, its kill ring or a completion, so it may run any command,
        // a cloud CLI among them: it also asks under PermissionPolicy.CLOUD_UNREAD, every time.
        readonly recalled?: boolean
      },
    ) {
      const instance = yield* InstanceState.context
      const ps = Shell.ps(input.shell)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tree = yield* Effect.acquireRelease(parse(input.command, ps), (tree) =>
            Effect.sync(() => tree.delete()),
          )
          const scan = yield* collect(tree.rootNode, input.cwd, ps, input.shell, instance)
          if (!containsPath(input.cwd, instance)) scan.dirs.add(input.cwd)
          if (input.unread) unread(scan, input.command)
          yield* ask(ctx, scan, input)
        }),
      )
    }),
  }
})

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const spawner = yield* ChildProcessSpawner
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service
    const flags = yield* RuntimeFlags.Service
    const permission = yield* ShellPermission
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const shellEnv = Effect.fn("ShellTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return untrustedChildEnvironment(process.env, extra.env)
    })

    // The sessions already told, on their first command with Web access None, that the sandbox limits commands.
    const told = new Set<string>()

    const run = Effect.fn("ShellTool.run")(function* (
      input: {
        shell: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        workspaceRoot: string
      },
      ctx: Tool.Context,
    ) {
      const limits = shellBudget(yield* config.get(), yield* trunc.limits())
      const keep = limits.maxBytes * 2
      // The start of the output, kept for the head of a long result; the ring buffer below keeps only the end.
      let start = ""
      let total = 0
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      const closeSink = Effect.fnUntraced(function* () {
        const stream = sink
        if (!stream) return
        sink = undefined
        if (stream.destroyed || stream.closed) return
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              let settled = false
              const done = () => {
                if (settled) return
                settled = true
                stream.off("close", done)
                stream.off("error", done)
                stream.off("finish", done)
                resolve()
              }
              stream.once("close", done)
              stream.once("error", done)
              stream.once("finish", done)
              stream.end(done)
            }),
        ).pipe(Effect.catch(() => Effect.void))
      })

      const offline = webNone() ? Sandbox.offline(input) : undefined
      const notice = offline && offline.type !== "refused" ? offline.notice : undefined
      // The first command of a session with Web access None says what the sandbox limits, before its own output.
      const first = notice !== undefined && !told.has(ctx.sessionID)
      if (first) told.add(ctx.sessionID)

      yield* ctx.metadata({
        metadata: {
          output: "",
          ...(notice ? { sandbox: notice } : {}),
        },
      })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.addFinalizer(closeSink)
          const handle = yield* spawner.spawn(
            yield* cmd(input.shell, input.command, input.cwd, input.env, input.workspaceRoot, ctx, offline),
          )

          const output = yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              if (total < limits.maxBytes) start += chunk
              total += size
              list.push({ text: chunk, size })
              used += size
              while (used > keep) {
                const item = list[0]
                if (!item) break
                cut = true
                const excess = used - keep
                if (item.size <= excess) {
                  list.shift()
                  used -= item.size
                  continue
                }
                // Trim only the excess: dropping a whole large chunk can discard the entire tail
                // when a pipe delivers a command's final newline in a separate chunk.
                const bytes = Buffer.from(item.text, "utf-8")
                let offset = excess
                while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++
                list[0] = { text: bytes.subarray(offset).toString("utf-8"), size: bytes.length - offset }
                used -= offset
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            // Process close can precede the output consumer's final metadata write.
            // Keep draining inside the race so abort and timeout still bound it.
            Effect.all([handle.exitCode, Fiber.join(output)], { concurrency: 2 }).pipe(
              Effect.map((result) => result[0]),
              // raceAll selects the first success; preserve output failures too.
              Effect.exit,
              Effect.map((result) => ({ kind: "exit" as const, result })),
            ),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
          }
          if (exit.kind === "timeout") {
            expired = true
          }
          if ((exit.kind !== "exit" || Exit.isFailure(exit.result)) && (yield* handle.isRunning)) {
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? yield* exit.result : null
        }),
      ).pipe(Effect.orDie)

      const meta: string[] = []
      if (expired) {
        meta.push(
          `shell tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      // Only `output` reaches the model; `metadata` does not. Without this a
      // failure that writes nothing to stdout or stderr — `grep -q`, `git diff
      // --quiet`, a build that logs to a file — reads as a clean run.
      if (code !== null && code !== 0) meta.push(`Command exited with code ${code}`)
      const raw = list.map((item) => item.text).join("")
      const end = headAndTail({ head: start, rest: raw, total, cut, ...limits })
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }
      if (first) output = `${notice}\n\n${output}`

      if (meta.length > 0) {
        output += "\n\n<shell_metadata>\n" + meta.join("\n") + "\n</shell_metadata>"
      }
      return {
        title: input.command,
        metadata: {
          output: last || preview(output),
          exit: code,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
          ...(notice ? { sandbox: notice } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = shellBudget(cfg, yield* trunc.limits())
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        yield* Effect.logInfo("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              const cwd = params.workdir
                ? yield* permission.resolvePath(params.workdir, instanceCtx.directory, shell)
                : instanceCtx.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? defaultTimeoutMs
              // Refused before anything is asked: with Web access None a command runs only in the sandbox, and this
              // computer has none to run it in.
              const refused = webNone() ? Sandbox.offlineRefusal() : undefined
              if (refused) return yield* Effect.die(new Error(refused))
              yield* permission.ask(ctx, { command: params.command, cwd, shell })

              return yield* run(
                {
                  shell,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  // The worktree, not the working directory: a command run from
                  // a subdirectory still has to be able to write anywhere in the
                  // project it belongs to.
                  workspaceRoot: instanceCtx.worktree,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
