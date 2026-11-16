import { Clock, Context, Effect, Option, Schema, Semaphore } from "effect"
import stripAnsi from "strip-ansi"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { Location } from "@vectordevai/core/location"
import { LocationServiceMap } from "@vectordevai/core/location-services"
import { Pty } from "@vectordevai/core/pty"
import { PtyHold } from "@vectordevai/core/pty/hold"
import { PtyProcess } from "@vectordevai/core/pty/process"
import { PtyID } from "@vectordevai/core/pty/schema"
import { WebFence } from "@vectordevai/core/research/fence"
import { AbsolutePath, NonNegativeInt, PositiveInt } from "@vectordevai/core/schema"
import { Shell } from "@vectordevai/core/shell"
import { PermissionPolicy } from "@vectordevai/schema/permission-policy"
import { Config } from "@/config/config"
import { ComputerSession } from "@/computer/session"
import { Session } from "@/session/session"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Plugin } from "@/plugin"
import { TaskNotify } from "@/task/notify"
import { TaskPlace } from "@/task/place"
import type { TaskPromptOps } from "./task"
import { ShellPermission } from "./shell"
import { Sandbox } from "./shell/sandbox"
import { Tool } from "./tool"
import DESCRIPTION from "./terminal.txt"

const Key = Schema.Literals([
  "enter",
  "tab",
  "escape",
  "backspace",
  "delete",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "page_up",
  "page_down",
  "space",
  "ctrl-a",
  "ctrl-b",
  "ctrl-c",
  "ctrl-d",
  "ctrl-e",
  "ctrl-f",
  "ctrl-g",
  "ctrl-h",
  "ctrl-k",
  "ctrl-l",
  "ctrl-n",
  "ctrl-o",
  "ctrl-p",
  "ctrl-r",
  "ctrl-t",
  "ctrl-u",
  "ctrl-w",
  "ctrl-x",
  "ctrl-y",
  "ctrl-z",
])
type Key = Schema.Schema.Type<typeof Key>

export const Parameters = Schema.Struct({
  action: Schema.Literals([
    "list",
    "open",
    "read",
    "type",
    "keys",
    "wait",
    "signal",
    "resize",
    "rename",
    "close",
    "reveal",
  ]).annotate({
    description: "The terminal action to perform",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "The terminal (pty_…) from list or open. Required for every action but list and open.",
  }),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(80))).annotate({
    description: "open, rename: the tab title",
  }),
  command: Schema.optional(Schema.String).annotate({
    description:
      "open: a command line, run by your shell as the shell tool runs it. With args, the program to start directly. Omit for an interactive shell.",
  }),
  args: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "open: arguments for command, which is then a program, not a command line",
  }),
  cwd: Schema.optional(Schema.String).annotate({
    description: "open: working directory, the project directory by default",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "type: the text to type. A line break submits the line, as Enter does.",
  }),
  enter: Schema.optional(Schema.Boolean).annotate({ description: "type: press Enter after the text" }),
  keys: Schema.optional(Schema.Array(Key).check(Schema.isMaxLength(32))).annotate({
    description: "keys: keys to press, in order",
  }),
  cursor: Schema.optional(NonNegativeInt).annotate({
    description: "read, wait: start from this output cursor, as an earlier result gave it",
  }),
  lines: Schema.optional(PositiveInt).annotate({
    description: "read: without a cursor, how many of the last lines to show (200 by default, at most 2000)",
  }),
  pattern: Schema.optional(Schema.String).annotate({
    description: "open, wait: a regular expression to wait for in the output; open waits for readiness when supplied",
  }),
  exit: Schema.optional(Schema.Boolean).annotate({ description: "wait: wait for the process to exit" }),
  quiet: Schema.optional(PositiveInt).annotate({
    description: "wait: wait until there is no new output for this many milliseconds",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "open with pattern, wait: give up after this many milliseconds (30000 by default, at most 60000)",
  }),
  cols: Schema.optional(PositiveInt).annotate({ description: "open, resize: columns" }),
  rows: Schema.optional(PositiveInt).annotate({ description: "open, resize: rows" }),
  focus: Schema.optional(Schema.Boolean).annotate({ description: "reveal: also move the user's keyboard focus to it" }),
  reveal: Schema.optional(Schema.Boolean).annotate({ description: "open: show it to the user right away" }),
  notify: Schema.optional(Schema.Boolean).annotate({
    description:
      "open: send you a note when the program exits, and when notify_pattern first appears, so you need not poll",
  }),
  notify_pattern: Schema.optional(Schema.String.check(Schema.isMaxLength(500))).annotate({
    description: "open with notify: a regular expression whose first appearance in the output sends a note",
  }),
  signal: Schema.optional(Schema.Literals(["interrupt", "terminate", "kill"])).annotate({
    description:
      "signal: interrupt (ctrl-c), terminate (SIGTERM) or kill (SIGKILL) the terminal's foreground program, which keeps the terminal and its output",
  }),
})
type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  action: Params["action"]
  id?: string
  title?: string
  status?: "running" | "exited"
  exitCode?: number
  cursor?: number
  matched?: "pattern" | "exit" | "quiet" | "timeout"
  signal?: "interrupt" | "terminate" | "kill"
}

// Polling actions: the same read or wait repeated is progress, not a loop (session/processor.ts).
export const POLLING_ACTIONS: ReadonlySet<string> = new Set(["list", "read", "wait", "reveal"])

const OFFLINE =
  "Vector did not use the terminal. With Web access None in Vector Local, commands run only inside Vector's sandbox, and a terminal cannot run there. Use the shell tool, or change Web access in Vector Local."

/** The most running terminals the agents of one conversation keep open in one place, as background commands are capped. */
export const LIMIT = 8
export const LIMIT_REFUSAL = `This conversation's agents already run ${LIMIT} terminals here. Close one you no longer need with action close, or use the shell tool for a command that finishes.`
export const SUBAGENT_REFUSAL =
  "Background subagents are turned off, so helpers do not open terminals: use the shell tool with a timeout, or leave long-running programs to the main agent."
const NOTIFY_UNAVAILABLE =
  "Notes are not available here, so notify cannot be used. Open the terminal without notify and wait on it with action wait."

const GUESTED =
  "In a session an invited guest has acted in, you can use only the terminals you opened: the user's terminals and other sessions' stay with the user."

// The bytes each key sends. A ctrl-<letter> key not listed sends the letter's control code.
const SEQUENCES: Partial<Record<Key, string>> = {
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  page_up: "\x1b[5~",
  page_down: "\x1b[6~",
  space: " ",
}

// Shells the scan's grammars do not read, which the shell tool never runs either: a line typed into one is approved
// only as written.
const FOREIGN = new Set(["fish", "nu"])
// An interactive shell expands history (`!!`, `!42`, `^old^new`) before it runs a line, and its history builtins run a
// line from it again (zsh's `r`, `fc -s` and `fc -e -` in bash and zsh, PowerShell's `r`, `ihy` and Invoke-History), so
// the line as typed does not say what runs. A `!` before a blank, `=` or `(` is never expanded (`!=`, `[ ! -f x ]`).
const HISTORY = /![^\s=(]|^\s*\^|(?:^|[\s;&|(`{])(?:r|fc|ihy|invoke-history)(?=$|[\s;&|)}])/i
// A line that sets something an interactive shell runs later, on its own, whatever comes next: a prompt variable or a
// prompt hook (bash's PROMPT_COMMAND and PS0-PS4, zsh's PROMPT and RPROMPT with prompt_subst, precmd and preexec,
// TRAP functions), a startup file (BASH_ENV, ENV, ZDOTDIR), an alias, a key binding or a widget (bind, bindkey, zle),
// a line pushed into the next prompt or the history (zsh's print -z and print -s, vared, history -s), an option
// (setopt, shopt), a trap, a script read into the shell (source, `.`), or PowerShell's prompt and PSReadLine handlers.
// The line scanned alone says nothing of what runs at the next prompt, so it asks every time, and so does every line
// typed into that terminal after it, an empty Enter included.
const HOOKS = new RegExp(
  [
    String.raw`(?:^|[\s;&|(\`{])(?:PROMPT_COMMAND|PS[0-4]|PROMPT[234]?|RPROMPT2?|RPS[12]|BASH_ENV|ENV|ZDOTDIR|precmd_functions|preexec_functions|chpwd_functions|zle_\w+)(?:\[[^\]]*\])?\+?=`,
    String.raw`(?:^|[;&|({\n]|\b(?:then|do|else))\s*(?:\w+=\S*\s+)*(?:builtin\s+|command\s+)?(?:alias|unalias|bind|bindkey|zle|vared|setopt|unsetopt|shopt|source|trap|enable|autoload|zmodload|doskey|Set-PSReadLineOption|Set-PSReadLineKeyHandler|Register-EngineEvent|\.(?=\s+\S))(?=$|\s)`,
    String.raw`\bprint\s+(?:-\w*\s+)*-\w*[zs]`,
    String.raw`\bhistory\s+(?:-\w*\s+)*-\w*s`,
    String.raw`(?:^|[;&|({\n]\s*)(?:function\s+)?(?:precmd|preexec|chpwd|periodic|zshexit|zshaddhistory|command_not_found_handler?|TRAP[A-Z]+|prompt)\s*(?:\(\s*\)|\{)`,
    String.raw`\bfunction\s+(?:global:)?prompt\b`,
    String.raw`\$function:(?:global:)?prompt\b`,
  ].join("|"),
  "i",
)
// Keys that may put text in the line Vector never sees: history (arrows, page keys, ctrl-p and ctrl-n, ctrl-r's search),
// the kill ring (ctrl-y), and keys after which the next ones are commands (escape for Meta or vi's command mode, where
// `k` recalls a line, and ctrl-x, whose ctrl-e hands the line to an editor).
const RECALLS: ReadonlySet<Key> = new Set([
  "up",
  "down",
  "page_up",
  "page_down",
  "escape",
  "ctrl-n",
  "ctrl-p",
  "ctrl-r",
  "ctrl-x",
  "ctrl-y",
])
const CLOUD_CLIS = ["vercel", "supabase"]

// The line the agent has typed into a terminal since it last submitted one, whether Vector knows it exactly (a key that
// edits or recalls text, such as tab completion, arrows or history search, leaves it unknown), and whether the shell may
// have filled it from somewhere else (history, the kill ring), so that it may run any command at all.
type Line = { readonly text: string; readonly exact: boolean; readonly recalled?: boolean }
type Stroke = { readonly text: string } | { readonly key: Key }

const EMPTY: Line = { text: "", exact: true }

export const TerminalTool = Tool.define<
  typeof Parameters,
  Metadata,
  | Config.Service
  | Plugin.Service
  | LocationServiceMap.Service
  | ChildProcessSpawner
  | FSUtil.Service
  | FreeModelGuests.Service
  | ComputerSession.Service
  | Session.Service
  | RuntimeFlags.Service
>(
  "terminal",
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const locations = yield* LocationServiceMap.Service
    const permission = yield* ShellPermission
    const guests = yield* FreeModelGuests.Service
    const flags = yield* RuntimeFlags.Service
    // Exit and pattern notes (notify). A build that leaves TaskNotify out (a test of the tool alone) refuses notify.
    const notifier = yield* Effect.serviceOption(TaskNotify.Service)
    // By terminal. Lines the user types themselves are not here: the scan sees only what the agent typed.
    const pending = new Map<PtyID, Line>()
    // Terminals whose shell the agent gave a hook (HOOKS): every line it types there after asks every time.
    const tainted = new Set<PtyID>()
    // One input at a time per terminal, from reading its pending line to the last keystroke: two calls of one message
    // run at once, and each must scan the line the other left, not the one before it.
    const locks = new Map<PtyID, Semaphore.Semaphore>()
    const locked = (id: PtyID) => {
      const lock = locks.get(id) ?? Semaphore.makeUnsafe(1)
      locks.set(id, lock)
      return lock.withPermits(1)
    }
    const forget = (id: PtyID) => {
      pending.delete(id)
      tainted.delete(id)
      locks.delete(id)
    }

    // In a session an invited guest has acted in, the terminals the agent did not open (the user's, such as the one a
    // Host locally agent runs in, and other sessions') are neither listed nor used: what the agent reads there would
    // reach the transcript the guest sees, and Full access would approve the asks for them on its own.
    const guested = (ctx: Tool.Context) => guests.marked(ctx.sessionID)

    // Reading, waiting on, resizing or closing a terminal the agent did not open asks first, under other:<id>.
    const askOther = Effect.fn("TerminalTool.askOther")(function* (params: Params, ctx: Tool.Context, info: Pty.Info) {
      if (own(info, ctx)) return
      const pattern = `${PermissionPolicy.TERMINAL_OTHER}${info.id}`
      yield* ctx.ask({
        permission: PermissionPolicy.TERMINAL,
        patterns: [pattern],
        always: [pattern],
        metadata: { action: params.action, id: info.id, title: info.title },
      })
    })

    const list = Effect.fn("TerminalTool.list")(function* (ctx: Tool.Context) {
      const pty = yield* Pty.Service
      const all = yield* pty.list()
      const infos = (yield* guested(ctx)) ? all.filter((info) => own(info, ctx)) : all
      return {
        title: "Terminals",
        metadata: { action: "list" as const },
        output:
          infos.length === 0
            ? "No terminals here. Open one with action open."
            : WebFence.escape(
                infos
                  .map((info) =>
                    [
                      describe(info, ctx),
                      `  cwd: ${info.cwd}`,
                      `  command: ${Shell.commandLine(info.command, info.args).replace(/\s+/g, " ").slice(0, 200)}`,
                    ].join("\n"),
                  )
                  .join("\n"),
              ),
      }
    })

    const open = Effect.fn("TerminalTool.open")(function* (params: Params, ctx: Tool.Context, directory: string) {
      const pty = yield* Pty.Service
      if (params.args !== undefined && params.command === undefined)
        return usage(params, "args needs command: the program to start with them.")
      if (params.notify_pattern !== undefined && params.notify !== true)
        return usage(params, "notify_pattern needs notify: true.")
      // Refused before anything is asked: a helper while background subagents are off, a conversation that already
      // runs the most terminals here, and notify where no note can reach the session.
      if (ctx.parentID !== undefined && !flags.backgroundSubagents) return yield* Effect.die(new Error(SUBAGENT_REFUSAL))
      const root = conversation(ctx.sessionID)
      const running = (yield* pty.list()).filter(
        (info) => info.status === "running" && info.owner?.kind === "agent" && conversation(info.owner.sessionID) === root,
      )
      if (running.length >= LIMIT) return yield* Effect.die(new Error(LIMIT_REFUSAL))
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (params.notify && (Option.isNone(notifier) || !ops)) return usage(params, NOTIFY_UNAVAILABLE)
      const shell = Shell.acceptable((yield* config.get()).shell)
      const cwd = params.cwd ? yield* permission.resolvePath(params.cwd, directory, shell) : directory
      // What the scan reads: the command line as the shell gets it, or the program and its arguments as one. An
      // interactive shell runs nothing yet; its directory is still checked.
      const line =
        params.command === undefined
          ? ""
          : params.args === undefined
            ? params.command
            : argv(shell, [params.command, ...params.args])
      if (line === undefined)
        return usage(
          params,
          `Vector did not open the terminal: ${Shell.name(shell)} cannot pass one of the arguments literally. Run the command line instead.`,
        )
      // A terminal runs outside the shell sandbox: with it on, that is asked after the refusals, before the shell asks.
      const scan = yield* permission.ask(ctx, {
        command: line,
        cwd,
        shell,
        ...(Sandbox.sandboxEnabled() ? { first: unsandboxed(line || shell) } : {}),
      })
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      // As the shell tool does before it spawns: the files the command line writes become this session's changes.
      yield* permission.admit(ctx, [scan])
      const created = yield* pty.create(
        {
          title: params.title ?? (line.split("\n")[0].slice(0, 80) || undefined),
          cwd,
          env: extra.env,
          ...(params.command === undefined
            ? {}
            : params.args === undefined
              ? { command: shell, args: Shell.args(shell, params.command, cwd) }
              : { command: params.command, args: [...params.args] }),
        },
        { kind: "agent", sessionID: ctx.sessionID },
        permission.beforeRun([scan]),
      )
      // The terminal keeps its location alive while it runs, and its watch sends the notes notify asked for.
      const send =
        params.notify && Option.isSome(notifier) && ops
          ? noteSender(notifier.value, ops, ctx, created, yield* Effect.context<never>())
          : undefined
      const watching = yield* PtyHold.whileRunning(
        locations,
        Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        created.id,
        send ? watcher(created, params.notify_pattern, send) : {},
      )
      // A program that ended before the watch began is told of at once.
      if (!watching && send && created.status === "exited") send("exited")
      if (params.cols !== undefined || params.rows !== undefined)
        yield* pty.update(created.id, { size: size(params.cols ?? 80, params.rows ?? 24) })
      if (params.reveal) yield* pty.reveal(created.id, { focus: false })
      if (params.pattern !== undefined)
        return yield* wait({ action: "open", pattern: params.pattern, timeout: params.timeout }, ctx, created)
      // Up to 500 ms for the first output, so the result shows a prompt, an error or a banner.
      for (let tries = 0; tries < 10; tries++) {
        const read = yield* pty.read(created.id, { limit: 0 })
        if (read.end > 0 || read.info.status === "exited") break
        yield* Effect.sleep("50 millis")
      }
      const read = yield* pty.read(created.id, { lines: 40, limit: 64_000 })
      return {
        title: read.info.title,
        metadata: metadata(params, read.info, { cursor: read.cursor }),
        output: [
          `Opened ${describe(read.info, ctx)} in ${read.info.cwd}.`,
          `cursor=${read.cursor}`,
          "",
          tail(clean(read.output), 40, 16_000) || "(no output yet)",
        ].join("\n"),
      }
    })

    const read = Effect.fn("TerminalTool.read")(function* (params: Params, ctx: Tool.Context, info: Pty.Info) {
      const pty = yield* Pty.Service
      yield* askOther(params, ctx, info)
      const read = yield* params.cursor === undefined
        ? pty.read(info.id, { lines: Math.min(params.lines ?? 200, 2000), limit: 256_000 })
        : pty.read(info.id, { cursor: params.cursor, limit: 32_000 })
      return {
        title: read.info.title,
        metadata: metadata(params, read.info, { cursor: read.cursor }),
        output: [
          describe(read.info, ctx),
          position(read, params.cursor),
          "",
          (params.cursor === undefined ? clean(read.output).slice(-16_000) : clean(read.output)) || "(no output)",
        ].join("\n"),
      }
    })

    // Types into a terminal: every ask first, for the terminal and for each line the strokes submit, then the write.
    const input = Effect.fn("TerminalTool.input")(function* (
      params: Params,
      ctx: Tool.Context,
      info: Pty.Info,
      writes: readonly string[],
      strokes: readonly Stroke[],
    ) {
      const pty = yield* Pty.Service
      if (info.status === "exited")
        return {
          title: info.title,
          metadata: metadata(params, info),
          output: `${describe(info, ctx)}. Nothing was typed.`,
        }
      const pattern = `${own(info, ctx) ? PermissionPolicy.TERMINAL_OWN : PermissionPolicy.TERMINAL_OTHER}${info.id}`
      yield* ctx.ask({
        permission: PermissionPolicy.TERMINAL_INPUT,
        patterns: [pattern],
        always: [pattern],
        metadata: {
          id: info.id,
          title: info.title,
          ...(params.text === undefined ? {} : { text: params.text }),
          ...(params.text !== undefined && params.enter ? { enter: true } : {}),
          ...(params.keys === undefined ? {} : { keys: params.keys }),
        },
      })
      // Who reads what is typed: an interactive shell, whose lines the scan reads as the commands they are; fish or nu,
      // whose grammar it does not read; or a program (a command line's, a REPL, a dev server, ssh), for which a line is
      // its own input and no shell command at all, so it goes as written, unread, with no shell history to recall.
      const reader = readerOf(info)
      const shell = reader === "shell" ? info.command : Shell.acceptable((yield* config.get()).shell)
      const from = yield* locked(info.id)(
        Effect.gen(function* () {
          const continuation = Shell.ps(shell) ? "`" : Shell.name(shell) === "cmd" ? "^" : "\\"
          let line = pending.get(info.id) ?? EMPTY
          const typed = submit(
            line,
            strokes,
            continuation,
          )
          const scans = yield* Effect.forEach(typed.lines, (line) =>
            Effect.gen(function* () {
              if (reader === "program")
                return yield* permission.ask(ctx, { command: line.text, cwd: info.cwd, shell, unread: true })
              // A hook set now, or before, runs commands at the next prompt that no line says.
              const hooked = tainted.has(info.id) || HOOKS.test(line.text)
              if (HOOKS.test(line.text)) tainted.add(info.id)
              const recalled = line.recalled === true || HISTORY.test(line.text) || hooked
              return yield* permission.ask(ctx, {
                command: line.text,
                cwd: info.cwd,
                shell,
                unread: !line.exact || recalled || reader === "foreign",
                // A word of an unknown line that tab completion may have finished as a cloud CLI's name (`verc` and
                // tab).
                recalled:
                  recalled ||
                  (!line.exact &&
                    line.text
                      .split(/[\s;&|()`{}]+/)
                      .some((word) => word !== "" && CLOUD_CLIS.some((cli) => cli.startsWith(word.toLowerCase())))),
              })
            }),
          )
          // One admission for every line the strokes submit, before the first keystroke: a line refused above or here
          // types nothing, and leaves no claim on a file an earlier line of the same call names.
          yield* permission.admit(ctx, scans)
          const from = (yield* pty.read(info.id, { limit: 0 })).end
          for (const [index, data] of writes.entries()) {
            // A program reads escape and the key right after it as one Alt combination, unless they come apart.
            if (index > 0 && writes[index - 1] === "\x1b") yield* Effect.sleep("50 millis")
            yield* permission.beforeRun(scans)
            yield* pty.write(info.id, data)
            // Retain only the prefix actually written if a later admission refuses the remaining strokes.
            line = writes.length === 1 ? typed.line : submit(line, strokes.slice(index, index + 1), continuation).line
            pending.set(info.id, line)
          }
          return from
        }),
      )
      yield* Effect.sleep("300 millis")
      const read = yield* pty.read(info.id, { cursor: from, limit: 32_000 })
      const shown = clean(read.output)
      return {
        title: read.info.title,
        metadata: metadata(params, read.info, { cursor: read.cursor }),
        output: [
          describe(read.info, ctx),
          position(read),
          // The cursor points past everything read, so output cut from the front is named, not skipped unseen.
          ...(shown.length > 8_000
            ? [
                `Showing the last 8000 characters of this output. Read with cursor=${from} to see the output before them.`,
              ]
            : []),
          "",
          shown.slice(-8_000) || "(no new output yet)",
        ].join("\n"),
      }
    })

    const wait = Effect.fn("TerminalTool.wait")(function* (params: Params, ctx: Tool.Context, info: Pty.Info) {
      const pty = yield* Pty.Service
      if (params.pattern === undefined && params.exit !== true && params.quiet === undefined)
        return usage(params, "wait needs pattern, exit: true or quiet, to know what to wait for.")
      yield* askOther(params, ctx, info)
      const pattern = params.pattern === undefined ? undefined : matcher(params.pattern)
      const timeout = Math.min(params.timeout ?? 30_000, 60_000)
      const started = yield* Clock.currentTimeMillis
      const state: { raw: string; text: string; found: boolean; next: number; changed: number; start?: number } = {
        raw: "",
        text: "",
        found: pattern?.test("") === true,
        next: params.cursor ?? 0,
        changed: started,
      }
      while (true) {
        const read = yield* pty.read(info.id, { cursor: state.next })
        state.start ??= read.start
        state.next = read.cursor
        const now = yield* Clock.currentTimeMillis
        if (read.output) {
          // Enough to match a ready line in a chatty log, without cleaning megabytes on every poll.
          state.raw = (state.raw + read.output).slice(-512_000)
          state.text = clean(state.raw)
          // The model's pattern runs on the last MATCH_WINDOW characters only: a pattern that backtracks badly over a
          // long log would otherwise hold the engine on every poll.
          state.found = pattern?.test(state.text.slice(-MATCH_WINDOW)) === true
          state.changed = now
        }
        const matched = state.found
          ? "pattern"
          : read.info.status === "exited"
            ? "exit"
            : params.quiet !== undefined && now - state.changed >= params.quiet
              ? "quiet"
              : now - started >= timeout
                ? "timeout"
                : undefined
        if (matched !== undefined || ctx.abort.aborted)
          return {
            title: read.info.title,
            metadata: metadata(params, read.info, { cursor: read.cursor, ...(matched ? { matched } : {}) }),
            output: [
              describe(read.info, ctx),
              matched === undefined
                ? "Stopped waiting: the call was aborted."
                : {
                    pattern: "Matched the pattern.",
                    exit: "The process exited.",
                    quiet: "No new output for the quiet period.",
                    timeout: `Gave up after ${timeout} ms.`,
                  }[matched],
              position({ ...read, start: state.start ?? read.start }, params.cursor),
              "",
              tail(state.text, 200, 16_000) || "(no new output)",
            ].join("\n"),
          }
        yield* Effect.sleep("100 millis")
      }
    })

    const change = Effect.fn("TerminalTool.change")(function* (params: Params, ctx: Tool.Context, info: Pty.Info) {
      const pty = yield* Pty.Service
      yield* askOther(params, ctx, info)
      if (params.action === "close") {
        const was = { ...info }
        yield* pty.remove(info.id)
        forget(info.id)
        // The close hangs the program up; one that ignores it is killed with its process group (PtyProcess.ended).
        const gone = was.status === "running" ? yield* PtyProcess.ended(was.pid) : true
        return {
          title: was.title,
          metadata: metadata(params, was),
          output: gone
            ? `Closed ${describe(was, ctx)}.`
            : `Closed the terminal ${was.id}, but its program (pid ${was.pid}) is still running and could not be ended.`,
        }
      }
      if (params.action === "rename") {
        if (params.title === undefined || params.title.trim() === "") return usage(params, "rename needs a title.")
        const updated = yield* pty.update(info.id, { title: params.title.trim() })
        return {
          title: updated.title,
          metadata: metadata(params, updated),
          output: `Renamed ${updated.id} to "${WebFence.escape(updated.title)}".`,
        }
      }
      if (params.cols === undefined || params.rows === undefined)
        return usage(params, "resize needs both cols and rows.")
      const next = size(params.cols, params.rows)
      const updated = yield* pty.update(info.id, { size: next })
      return {
        title: updated.title,
        metadata: metadata(params, updated),
        output:
          updated.status === "exited"
            ? `${describe(updated, ctx)}. Nothing was resized.`
            : `Resized ${updated.id} to ${next.cols} columns and ${next.rows} rows.`,
      }
    })

    // Interrupts, terminates or kills the terminal's foreground program and keeps the terminal, its output and its shell.
    const signal = Effect.fn("TerminalTool.signal")(function* (params: Params, ctx: Tool.Context, info: Pty.Info) {
      const pty = yield* Pty.Service
      if (params.signal === undefined) return usage(params, "signal needs signal: interrupt, terminate or kill.")
      yield* askOther(params, ctx, info)
      if (info.status === "exited")
        return { title: info.title, metadata: metadata(params, info), output: `${describe(info, ctx)}. Nothing was signalled.` }
      const sent =
        params.signal === "interrupt"
          ? yield* pty.write(info.id, "\x03").pipe(Effect.as(true))
          : process.platform === "win32"
            ? false
            : PtyProcess.signal(PtyProcess.foreground(info.pid), params.signal === "kill" ? "SIGKILL" : "SIGTERM")
      if (params.signal === "interrupt") pending.set(info.id, EMPTY)
      yield* Effect.sleep("300 millis")
      const after = yield* pty.get(info.id)
      return {
        title: after.title,
        metadata: { ...metadata(params, after), signal: params.signal },
        output: sent
          ? `Sent ${params.signal} to the foreground program of ${describe(after, ctx)}.`
          : process.platform === "win32"
            ? "On Windows a terminal's program can be interrupted (signal interrupt) or ended with the terminal (action close); terminate and kill are not available."
            : `${describe(after, ctx)}. Vector found no program to signal.`,
      }
    })

    const reveal = Effect.fn("TerminalTool.reveal")(function* (params: Params, info: Pty.Info) {
      const pty = yield* Pty.Service
      yield* pty.reveal(info.id, { focus: params.focus === true })
      return {
        title: info.title,
        metadata: metadata(params, info),
        output: `Asked Vector to show ${info.id} in the terminal panel. A client without a terminal panel shows nothing.`,
      }
    })

    const run = Effect.fn("TerminalTool.run")(function* (params: Params, ctx: Tool.Context, directory: string) {
      const offline = Egress.policy()
      // Refused before anything is asked: a terminal runs outside the sandbox Web access None keeps every command in.
      if (["open", "type", "keys", "signal"].includes(params.action) && offline.enabled && offline.web === "none")
        return yield* Effect.die(new Error(OFFLINE))
      if (params.pattern !== undefined && params.pattern.length > PATTERN_MAX)
        return usage(params, `The pattern is longer than ${PATTERN_MAX} characters. Wait for a shorter one.`)
      if (params.action === "list") return yield* list(ctx)
      if (params.action === "open") return yield* open(params, ctx, directory)
      if (params.id === undefined)
        return usage(params, `The ${params.action} action needs the id of a terminal. List them with action list.`)
      const id = Option.getOrUndefined(Schema.decodeUnknownOption(PtyID)(params.id))
      if (id === undefined) return notFound(params, params.id)
      const pty = yield* Pty.Service
      const info = yield* pty.get(id)
      if (!own(info, ctx) && (yield* guested(ctx)))
        return { title: params.action, metadata: { action: params.action, id: info.id }, output: GUESTED }
      if (params.action === "read") return yield* read(params, ctx, info)
      if (params.action === "wait") return yield* wait(params, ctx, info)
      if (params.action === "reveal") return yield* reveal(params, info)
      if (params.action === "signal") return yield* signal(params, ctx, info)
      if (params.action === "resize" || params.action === "close" || params.action === "rename")
        return yield* change(params, ctx, info)
      if (params.action === "keys") {
        if (!params.keys?.length) return usage(params, "keys needs at least one key to press.")
        return yield* input(
          params,
          ctx,
          info,
          params.keys.map((key) => SEQUENCES[key] ?? String.fromCharCode(key.charCodeAt(5) - 96)),
          params.keys.map((key) => ({ key })),
        )
      }
      if (params.text === undefined) return usage(params, "type needs text to type.")
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(params.text))
        return usage(params, "Vector did not type: the text holds control characters. Use keys for control keys.")
      const data = params.text.replace(/\r?\n/g, "\r") + (params.enter ? "\r" : "")
      return yield* input(
        params,
        ctx,
        info,
        [data],
        data
          .split(/([\r\t])/)
          .filter((part) => part !== "")
          .map((part): Stroke => (part === "\r" ? { key: "enter" } : part === "\t" ? { key: "tab" } : { text: part })),
      )
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          return yield* run(params, ctx, instance.directory).pipe(
            // The location's own terminals: the ones the app's terminal panel lists.
            Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(instance.directory) }))),
            Effect.catchTag("Pty.NotFoundError", (error) => Effect.succeed(notFound(params, error.ptyID))),
          )
        }).pipe(Effect.orDie),
    }
  }),
)

// The lines a run of strokes hands over to run, and the line it leaves pending. Once the line is unknown, no stroke is
// known not to run it: the second key of bash's ctrl-x ctrl-e or ctrl-x e, or an editor's ZZ, runs it with no Enter.
// So a run of strokes that reaches an unknown line asks for that line as it stands, and a clear of an unknown line asks
// for the line it may have run instead of clearing it.
function submit(line: Line, strokes: readonly Stroke[], continuation: string) {
  const typed = strokes.reduce(
    (state, stroke) => {
      const next = press(state.line, stroke, continuation)
      const blind = state.blind || !state.line.exact
      if (next.runs) return { lines: [...state.lines, state.line], line: next.line, blind: false }
      if (blind && next.line.exact)
        return { lines: [...state.lines, { ...state.line, exact: false }], line: next.line, blind: false }
      return { ...state, line: next.line, blind }
    },
    { lines: [] as Line[], line, blind: false },
  )
  return { lines: typed.blind ? [...typed.lines, typed.line] : typed.lines, line: typed.line }
}

// What one stroke does to the pending line, and whether it hands the line over to run. Printable text appends,
// backspace drops a character, ctrl-c and ctrl-u clear the line, a key that may recall text marks it recalled, and any
// other key leaves it unknown. Enter after an unescaped continuation character (bash's `\`, PowerShell's backtick, cmd's
// `^`) does not run anything yet: the shell reads the next line as more of the same command, so the scan reads them
// together.
function press(line: Line, stroke: Stroke, continuation: string): { line: Line; runs?: boolean } {
  if ("text" in stroke) return { line: { ...line, text: line.text + stroke.text } }
  if (stroke.key === "space") return { line: { ...line, text: line.text + " " } }
  if (stroke.key === "enter" && continued(line.text, continuation))
    return { line: { ...line, text: line.text.slice(0, -1) } }
  if (stroke.key === "enter") return { line: EMPTY, runs: true }
  // bash's operate-and-get-next and zsh's accept-line-and-down-history run the line as Enter does, then recall the
  // history line after it: none after a line typed new.
  if (stroke.key === "ctrl-o")
    return { line: line.exact ? EMPTY : { text: "", exact: false, recalled: line.recalled }, runs: true }
  // A program that reads the terminal a line at a time takes the text typed so far at ctrl-d, with no newline; a line
  // editor deletes a character instead. On an empty line it is the end of input.
  if (stroke.key === "ctrl-d") return line.text ? { line: { ...line, exact: false }, runs: true } : { line }
  if (stroke.key === "backspace") return { line: { ...line, text: Array.from(line.text).slice(0, -1).join("") } }
  if (stroke.key === "ctrl-c") return { line: EMPTY }
  // In vi's command mode ctrl-u clears the line and keeps the mode, where the next letters are commands (`k` recalls a
  // line), so a line that may be there stays recalled. ctrl-c starts a new line in insert mode.
  if (stroke.key === "ctrl-u") return { line: line.recalled ? { text: "", exact: false, recalled: true } : EMPTY }
  if (RECALLS.has(stroke.key)) return { line: { ...line, exact: false, recalled: true } }
  return { line: { ...line, exact: false } }
}

// An odd run of the character at the end: the last one is not itself escaped.
function continued(text: string, char: string) {
  return (text.length - 1 - text.split("").findLastIndex((item) => item !== char)) % 2 === 1
}

// A program and its arguments as one command line for the scan: a word stays bare when every shell reads it as
// written, and is quoted for this shell otherwise. Undefined when the shell cannot take a word literally.
function argv(shell: string, words: readonly string[]) {
  const quoted = words.map((word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : Shell.quote(shell, word)))
  if (quoted.some((word) => word === undefined)) return
  return quoted.join(" ")
}

// Program output as text: escape sequences stripped, each line as its last redraw left it, backspaces applied, the
// other control characters dropped, and no tag that reads as one of Vector's own.
function clean(raw: string) {
  return WebFence.escape(
    stripAnsi(raw)
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => {
        const drawn = line.replace(/\r+$/, "")
        return backspace(drawn.slice(drawn.lastIndexOf("\r") + 1))
      })
      .join("\n")
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""),
  )
}

function backspace(line: string) {
  if (!line.includes("\b")) return line
  const out: string[] = []
  for (const char of line) {
    if (char === "\b") {
      out.pop()
      continue
    }
    out.push(char)
  }
  return out.join("")
}

function tail(text: string, lines: number, chars: number) {
  return text.split("\n").slice(-lines).join("\n").slice(-chars)
}

// How much of the latest output a wait pattern is matched against, and the longest pattern taken.
const MATCH_WINDOW = 64_000
const PATTERN_MAX = 500

// The pattern as a regular expression, or as literal text when it is not a valid one.
function matcher(pattern: string) {
  try {
    return new RegExp(pattern, "m")
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "m")
  }
}

function size(cols: number, rows: number) {
  return { cols: Math.min(Math.max(cols, 20), 500), rows: Math.min(Math.max(rows, 5), 200) }
}

// A terminal runs outside the shell sandbox, the one that bounds what auto-approved commands can do, so starting one
// with the sandbox on asks under a permission of its own: never the shell tool's unsandboxed_shell (whose "always" and
// auto-accept would then start every terminal, and every command whose sandbox failed, without a word), never answered
// by auto-accept or Full access, and with no "always" (PermissionPolicy.canAutoApprove).
function unsandboxed(command: string) {
  return {
    permission: PermissionPolicy.TERMINAL_UNSANDBOXED,
    patterns: [process.platform],
    always: [],
    metadata: { command, platform: process.platform, reason: "Terminals run outside the shell sandbox." },
  }
}

// What reads the lines typed into a terminal (see input).
function readerOf(info: Pty.Info): "shell" | "foreign" | "program" {
  if (Shell.interactive(info.command, info.args)) return "shell"
  if (FOREIGN.has(Shell.name(info.command)) && info.args.every((arg) => /^-(?:l|i|-login|-interactive)$/.test(arg)))
    return "foreign"
  return "program"
}

// A terminal the session's agent opened, its parent's when this is a subagent, or one of its own helpers' (a subagent
// it started, or theirs): the main agent reads its helper's dev server as its own.
function own(info: Pty.Info, ctx: Tool.Context) {
  if (info.owner?.kind !== "agent") return false
  if (info.owner.sessionID === ctx.sessionID || info.owner.sessionID === ctx.parentID) return true
  return lineage(info.owner.sessionID).includes(ctx.sessionID)
}

// The conversation a session belongs to: its topmost ancestor this engine knows of.
function conversation(sessionID: string) {
  return lineage(sessionID).at(-1) ?? sessionID
}

// What a terminal's watch does for notify: one note when notify_pattern first appears, and one when the program exits
// on its own. A terminal closed or removed sends none: the agent closed it, or its session or location ended.
function watcher(info: Pty.Info, pattern: string | undefined, send: (state: "exited" | "matched") => void): PtyHold.Watch {
  const regex = pattern === undefined ? undefined : matcher(pattern)
  const state = { raw: "", matched: false, timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const check = () => {
    state.timer = undefined
    if (state.matched || !regex) return
    if (!regex.test(clean(state.raw).slice(-MATCH_WINDOW))) return
    state.matched = true
    state.raw = ""
    send("matched")
  }
  return {
    onData: (chunk) => {
      if (state.matched || !regex) return
      state.raw = (state.raw + chunk).slice(-MATCH_WINDOW * 2)
      // At most one match every 200 ms, whatever the output rate.
      state.timer ??= setTimeout(check, 200)
    },
    onEnd: () => {
      if (state.timer) clearTimeout(state.timer)
      if (!state.matched && regex) check()
      if (info.status === "exited") send("exited")
    },
  }
}

// Sends a terminal's notes to the session that opened it, through TaskNotify, as a background command's exit note goes.
// The note names the terminal and where to read from; the output itself stays in the terminal, read as data.
function noteSender(
  notify: TaskNotify.Interface,
  ops: TaskPromptOps,
  ctx: Tool.Context,
  info: Pty.Info,
  context: Context.Context<never>,
) {
  const run = Effect.runForkWith(context)
  return (state: "exited" | "matched") => {
    const title = WebFence.escape(info.title)
    const text =
      state === "exited"
        ? `Terminal ${info.id} "${title}" exited with code ${info.exitCode ?? "unknown"}. Read its output with the terminal tool: action read, id ${info.id}.`
        : `Terminal ${info.id} "${title}" printed what notify_pattern waits for. Read its output with the terminal tool: action read, id ${info.id}.`
    run(
      notify
        .enqueue({
          parentID: ctx.sessionID,
          note: {
            kind: "terminal",
            terminalID: info.id,
            state,
            ...(info.exitCode === undefined ? {} : { exitCode: info.exitCode }),
            text,
            wake: true,
          },
          ops,
          agent: ctx.agent,
        })
        .pipe(Effect.catchCause((cause) => Effect.logWarning("a terminal's note was not sent", { id: info.id, cause }))),
    )
  }
}

// A session's ancestors, nearest first, as far as this engine started them (TaskPlace keeps who started whom).
function lineage(sessionID: string) {
  const found: string[] = []
  for (let id = TaskPlace.parentOf(sessionID); id !== undefined && found.length < 32; id = TaskPlace.parentOf(id)) {
    if (found.includes(id)) break
    found.push(id)
  }
  return found
}

function describe(info: Pty.Info, ctx: Tool.Context) {
  const status =
    info.status === "running" ? `running (pid ${info.pid})` : `exited with code ${info.exitCode ?? "unknown"}`
  const owner = info.owner === undefined ? "the user's" : own(info, ctx) ? "yours" : "another agent session's"
  return `Terminal ${info.id} "${WebFence.escape(info.title)}": ${status}, ${owner}`
}

// Where a result leaves off: the cursor to read from next, whether more output is kept past it, and how much output
// before the requested cursor is already gone.
function position(read: Pty.ReadOutput, cursor?: number) {
  return [
    `cursor=${read.cursor}${read.cursor < read.end ? ", more output: yes" : ""}`,
    ...(cursor !== undefined && read.start > cursor
      ? [`${read.start - cursor} earlier characters are no longer kept.`]
      : []),
  ].join("\n")
}

function metadata(params: Params, info: Pty.Info, extra?: Pick<Metadata, "cursor" | "matched">): Metadata {
  return {
    action: params.action,
    id: info.id,
    title: info.title,
    status: info.status,
    ...(info.exitCode === undefined ? {} : { exitCode: info.exitCode }),
    ...extra,
  }
}

function usage(params: Params, output: string) {
  return { title: params.action, metadata: { action: params.action }, output }
}

function notFound(params: Params, id: string) {
  return {
    title: params.action,
    metadata: { action: params.action, id },
    output: `No terminal ${id} here. List terminals with action list.`,
  }
}
