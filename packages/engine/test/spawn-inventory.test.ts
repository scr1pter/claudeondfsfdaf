import { describe, expect, test } from "bun:test"
import path from "node:path"

// The spawn review's principle 5 (docs/vector/build/v2-spawn-review.md §4: every spawn site consults the isolation
// floor), as a lint over core's and the engine's source. Every file that can start a process of its own is listed
// below with its isolation stance and why: it imports a process module (child_process, cross-spawn, a PTY library, the
// MCP SDK's stdio transport, the `open` URL opener, or Effect's Node or Bun platform spawner), or it reaches Bun's own
// spawn, spawnSync, `$` shell or openInEditor. A new file that can spawn fails here until it is reviewed and listed,
// and a listed file that no longer spawns fails as stale.
//
// Each file is transpiled first, so comments and type-only imports drop out of the run-time references. A process
// module named in a type or a comment still counts as a type-level reference, which a `type-only` entry must justify.
// Effect `ChildProcess` users need no entry of their own: they spawn through the ChildProcessSpawner service, which only
// cross-spawn-spawner.ts builds (checked below). Spawns inside dependencies, other packages and the Python native entry
// are not covered by this lint.

const ROOT = path.resolve(import.meta.dir, "../../..")

// Process modules. A distinctive name counts anywhere it appears as a string; `open` and Effect's platform index count
// only where they are imported, so `ws.on("open", …)` and a comment naming the index do not.
const MODULES = [
  { label: "child_process", pattern: /(["'`])(?:node:)?child_process\1/ },
  { label: "cross-spawn", pattern: /(["'`])cross-spawn\1/ },
  { label: "bun-pty", pattern: /(["'`])bun-pty\1/ },
  { label: "node-pty", pattern: /(["'`])(?:@lydell\/)?node-pty\1/ },
  { label: "mcp-stdio", pattern: /(["'`])@modelcontextprotocol\/sdk\/client\/stdio(?:\.js)?\1/ },
  { label: "open", pattern: /(?:\bfrom\s*|\b(?:import|require)\s*\(\s*)(["'`])open\1/ },
  // The index and NodeServices provide NodeChildProcessSpawner.layer without naming it.
  {
    label: "effect-platform",
    pattern:
      /(?:\bfrom\s*|\b(?:import|require)\s*\(\s*)(["'`])@effect\/platform-(?:node|bun)(?:-shared)?(?:\/(?:index|(?:Node|Bun)(?:Services|Context|ChildProcessSpawner))(?:\.[cm]?[jt]s)?)?\1/,
  },
]
const PRIMITIVES = [
  ...MODULES,
  { label: "Bun.spawn", pattern: /\bBun\s*\.\s*spawn(?![\w$])/ },
  { label: "Bun.spawnSync", pattern: /\bBun\s*\.\s*spawnSync(?![\w$])/ },
  { label: "Bun.$", pattern: /\bBun\s*\.\s*\$(?![\w$])/ },
  { label: "Bun.openInEditor", pattern: /\bBun\s*\.\s*openInEditor(?![\w$])/ },
  // Bun's members reached by a computed key, or destructured from Bun (`const { spawn } = Bun;`, or `globalThis.Bun`).
  {
    label: "Bun[]",
    pattern:
      /\bBun\s*\[|\}\s*=\s*(?:(?:globalThis|self)\s*\.\s*)?Bun\s*[;,)]|\b(?:globalThis|self)\s*\[\s*(["'`])Bun\1\s*\]/,
  },
  {
    label: "bun import",
    pattern:
      /\bimport\s*(?:[\w$]+|\*\s*as\s+[\w$]+|\{[^{}]*(?<![\w$])(?:spawnSync|spawn|\$|openInEditor)(?![\w$])[^{}]*\})\s*from\s*["']bun["']/,
  },
  { label: "platform spawner", pattern: /\b(?:Node|Bun)ChildProcessSpawner\b/ },
]
// The process modules whose bound names `directCalls` follows. Every other run-time primitive in a launch file is a
// start the launch check cannot see (Bun's own spawners, Effect's platform layers), so it counts as unplanned.
const TRACED = ["child_process", "cross-spawn", "bun-pty", "node-pty", "mcp-stdio", "open"]
// Building Effect's ChildProcessSpawner service, which every Effect ChildProcess command runs through.
const SPAWNER_BUILD =
  /\bimport\s*\{[^{}]*(?<![\w$])(?:make|makeHandle)(?![\w$])[^{}]*\}\s*from\s*["'`]effect\/unstable\/process\/ChildProcessSpawner["'`]|\bimport\s*\*\s*as\s+[\w$]+\s+from\s*["'`]effect\/unstable\/process\/ChildProcessSpawner["'`]|\bChildProcessSpawner\s*\.\s*(?:make|makeHandle|of)\b|\b(?:Layer|Context|Effect)\s*\.\s*\w+\(\s*(?:[\w$]+\.)?ChildProcessSpawner\s*,/
const TS = new Bun.Transpiler({ loader: "ts" })
const TSX = new Bun.Transpiler({ loader: "tsx" })

type Stance =
  | "launch"
  | "pty-backend"
  | "required-refusal"
  | "fixed-helper"
  | "type-only"
  | "windows-holder"
  | "runner"
  | "cli"
  | "plugin-host"
  | "url-opener"
  | "re-export"

// Stances (docs/vector/build/native-qualify-notes.md, NQ-4):
// - launch: routes every process through the ProcessIsolation launch decision and starts only what it returns. That
//   is the command unchanged while FLOOR and the native build are off, and a refusal off Linux under required
//   isolation; nothing here is isolated today.
// - pty-backend: a PTY adapter that only core/src/pty.ts loads, after its own launch decision.
// - required-refusal: refuses to spawn while ProcessIsolation.required().
// - fixed-helper: a fixed system program with fixed arguments and no caller-chosen command.
// - type-only: names a process module in types only.
// - windows-holder: the Windows Job Object holder, which only ShellJobs loads and refuses under required isolation.
// - runner: the CI job's own controller, run before or after the agent or in a separate job, never as the agent.
// - cli: a person's own command, which a hosted agent cannot reach.
// - plugin-host: hands a spawner to plugins, whose external code is refused under required isolation.
// - url-opener: opens a URL in the operating system's browser on a person's request.
// - re-export: re-exports a process module's class without constructing it.
const INVENTORY = {
  "packages/core/src/cross-spawn-spawner.ts": {
    stance: "launch",
    why: "The Effect spawner: ProcessIsolation.launch, or ProcessIsolation.commandPlan in a native build under required isolation (an owned command, OwnedProcess.options, is refused there first), then cross-spawn starts isolated.file.",
  },
  "packages/core/src/untrusted-git.ts": {
    stance: "launch",
    why: "Untrusted-repository Git: ProcessIsolation.launch, then execFile(isolated.file).",
  },
  "packages/core/src/brain/document/ocr.ts": {
    stance: "launch",
    why: "Document OCR's run(): ProcessIsolation.launch, then spawn(isolated.file).",
  },
  "packages/engine/src/util/process.ts": {
    stance: "launch",
    why: "Process.spawn for LSP servers and installers: ProcessIsolation.launch, then cross-spawn(isolated.file); its child_process import is a type.",
  },
  "packages/engine/src/cli/cmd/github.bundle.ts": {
    stance: "launch",
    why: "The bundle's Git helper: ProcessIsolation.launch, then spawn(isolated.file).",
  },
  "packages/engine/src/mcp/stdio.ts": {
    stance: "launch",
    why: "Local MCP servers (localTransport): ProcessIsolation.launch, then the SDK's StdioClientTransport starts isolated.file.",
  },
  "packages/core/src/pty/pty.bun.ts": {
    stance: "pty-backend",
    why: "The bun-pty adapter behind #pty; only core/src/pty.ts loads it (its lazy #pty import), after ProcessIsolation.launch.",
  },
  "packages/core/src/pty/pty.node.ts": {
    stance: "pty-backend",
    why: "The @lydell/node-pty adapter behind #pty; only core/src/pty.ts loads it (its lazy #pty import), after ProcessIsolation.launch.",
  },
  "packages/core/src/directory-identity.ts": {
    stance: "required-refusal",
    why: "The fixed Python metadata reader refuses while isolation is required, at admission (read()) and right before spawn.",
  },
  "packages/core/src/read-only-git.ts": {
    stance: "required-refusal",
    why: "The fixed Python Git verifier requires !ProcessIsolation.required() at open() and right before spawn.",
  },
  "packages/core/src/owned-process.ts": {
    stance: "fixed-helper",
    why: "groupEmpty runs /bin/ps -A -o pgid=,stat= with the untrusted-child environment during an owned stop; no caller input reaches its argv.",
  },
  "packages/core/src/pty/process.ts": {
    stance: "fixed-helper",
    why: "foreground() reads a terminal's foreground group with `ps -o tpgid= -p <pid>` for the PTY's own pid, resolved through PATH with the engine's environment.",
  },
  "packages/core/src/shell.ts": {
    stance: "fixed-helper",
    why: "killTree's Windows-only `taskkill /pid <pid> /f /t`: a fixed argv, resolved through PATH and the working directory, with the untrusted-child environment.",
  },
  "packages/core/src/config/managed.ts": {
    stance: "fixed-helper",
    why: "Company-policy readers: plutil, ls -lde, reg.exe and powershell.exe at absolute paths (PLUTIL, LS, REG, POWERSHELL) with minimal environments.",
  },
  "packages/core/src/local-mode/hardware.ts": {
    stance: "fixed-helper",
    why: "Vector Local's hardware read (run()): vm_stat or nvidia-smi with fixed arguments, found with which outside the repository, with the engine's environment.",
  },
  "packages/engine/src/lsp/launch.ts": {
    stance: "type-only",
    why: "Uses the ChildProcessWithoutNullStreams type; starts servers through Process.spawn.",
  },
  "packages/engine/src/lsp/server.ts": {
    stance: "type-only",
    why: "Uses the ChildProcessWithoutNullStreams type; starts servers through lsp/launch.ts and Process.spawn.",
  },
  "packages/engine/src/tool/shell/windows-process.ts": {
    stance: "windows-holder",
    why: "The Job Object holder (System32 powershell.exe, started by start()); only task/shells.ts loads it, and ShellJobs.start refuses a Windows background command while isolation is required (isolationRefusal).",
  },
  "packages/engine/src/cli/cmd/github.isolation.ts": {
    stance: "runner",
    why: "The native adapter's control transport (execute()); only github.sandbox.ts loads it, as the runner in `vector github sandbox prepare` and `finish`.",
  },
  "packages/engine/src/cli/cmd/github.sandbox.ts": {
    stance: "runner",
    why: "`vector github sandbox prepare|run|finish`, Linux-only: sets up the sandbox and launches the agent as vector-agent (run()); the agent never runs it.",
  },
  "packages/engine/src/cli/cmd/github.publish.ts": {
    stance: "runner",
    why: "`vector github publish`, in the separate publish job after the agent job; runs Git with hooks, helpers and credentials disabled (createPublishGit).",
  },
  "packages/engine/src/cli/cmd/ship.ts": {
    stance: "runner",
    why: "The hidden `vector ship capture`, in Ship Desk's own job that holds only a capture ticket (captureEnvironmentProblem); it runs the repository's start command, Git and Chrome there unisolated by design (startShell, git, shoot).",
  },
  "packages/engine/src/cli/cmd/db.ts": {
    stance: "cli",
    why: "`vector db` opens sqlite3 on the person's local database.",
  },
  "packages/engine/src/installation/standalone.ts": {
    stance: "cli",
    why: "A Windows-only cmd.exe start of the upgrade or removal script (launch()) from `vector upgrade`, `vector uninstall` or the app's upgrade request; a hosted agent runs only on Linux.",
  },
  "packages/engine/src/plugin/index.ts": {
    stance: "plugin-host",
    why: "Hands Bun.$ to server plugins; external plugin code is refused while isolation is required (assertExternalCodeAllowed in applyPlugin), and the internal plugins never call it.",
  },
  "packages/engine/src/mcp/index.ts": {
    stance: "url-opener",
    why: "MCP OAuth opens the authorization URL from `vector mcp auth` or the app's MCP auth request; its stdio import is a type, and servers start through mcp/stdio.ts (localTransport).",
  },
  "packages/engine/src/plugin/snowflake-cortex.ts": {
    stance: "url-opener",
    why: "Snowflake's external-browser sign-in opens the authorize URL, only from a person's provider sign-in (ProviderAuth.authorize in provider/auth.ts).",
  },
  "packages/engine/src/cli/cmd/web.ts": {
    stance: "url-opener",
    why: "`vector web` opens the local UI.",
  },
  "packages/engine/src/cli/vector-account.ts": {
    stance: "url-opener",
    why: "`vector login`, or the account gate on a person's first interactive run (ensureVectorAccount, refused without a TTY), opens the approval page (browserLogin).",
  },
  "packages/engine/src/cli/cmd/invite.ts": {
    stance: "url-opener",
    why: "`vector invite --open` opens the owner's page.",
  },
  "packages/engine/src/mcp/sdk.ts": {
    stance: "re-export",
    why: "Re-exports StdioClientTransport for mcp/index.ts's instanceof check; only mcp/stdio.ts constructs it.",
  },
} as const satisfies Record<string, { stance: Stance; why: string }>

// Calls in a launch file that start something other than the planned file, excused one by one.
const HELPER_CALLS = [
  {
    file: "packages/core/src/cross-spawn-spawner.ts",
    call: "NodeChildProcess.exec(`taskkill /pid ${proc.pid} /T /F`",
    why: "killGroup's Windows tree kill of a process this spawner started; Windows refuses every launch while isolation is required.",
  },
] as const

const listed = (stance: Stance) =>
  Object.entries(INVENTORY)
    .filter((entry) => entry[1].stance === stance)
    .map((entry) => entry[0])

function references(file: string, text: string) {
  const code = (/x$/.test(file) ? TSX : TS).transformSync(text)
  const runtime = PRIMITIVES.filter((primitive) => primitive.pattern.test(code)).map((primitive) => primitive.label)
  const types = MODULES.filter((module) => module.pattern.test(text) && !runtime.includes(module.label)).map(
    (module) => module.label,
  )
  return { code, runtime, types }
}

async function sources() {
  const files = (
    await Array.fromAsync(
      new Bun.Glob("packages/{core,engine}/src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}").scan({ cwd: ROOT }),
    )
  )
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !/\.test\.[cm]?[jt]sx?$/.test(file))
    .toSorted()
  return Promise.all(
    files.map(async (file) => {
      const text = await Bun.file(path.join(ROOT, file)).text()
      return { file, text, ...references(file, text) }
    }),
  )
}

const scanned = sources()

// The calls a file makes with names it binds from a process module, and its member calls on an inline `require(…)` or
// `import(…)` of one, whitespace collapsed.
function directCalls(code: string) {
  const spawning = (specifier: string) => MODULES.some((module) => module.pattern.test(`from "${specifier}"`))
  const names = [
    ...[...code.matchAll(/\bimport\s+([^;"'`]*?)\s+from\s*["'`]([^"'`]+)["'`]/g)]
      .filter((match) => spawning(match[2]!))
      .flatMap((match) => imported(match[1]!)),
    // `[^{}]`, not `[^}]`: the latter starts at the enclosing function's brace and captures its body.
    ...[...code.matchAll(/\{([^{}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)]
      .filter((match) => spawning(match[2]!))
      .flatMap((match) =>
        match[1]!
          .split(",")
          .map(
            (binding) =>
              binding
                .trim()
                .split(/\s*:\s*/)
                .at(-1)!,
          )
          .filter(Boolean),
      ),
    // `const cp = require("child_process")` or `= await import(…)`: the module itself, called or used as a namespace.
    ...[
      ...code.matchAll(
        /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
      ),
    ]
      .filter((match) => spawning(match[2]!))
      .flatMap((match) => [match[1]!, `${match[1]!}.`]),
  ]
  const inline = [
    ...code.matchAll(/\b(?:import|require)\s*\(\s*["'`]([^"'`]+)["'`]\s*\)\s*\)?\s*\.\s*[\w$]+\s*\([^)]{0,160}/g),
  ].filter((match) => spawning(match[1]!))
  return [
    ...names.flatMap((name) => [
      ...code.matchAll(
        new RegExp(
          `(?<![\\w$.])(?:new\\s+)?${name.replace(/[.$]/g, "\\$&")}${name.endsWith(".") ? "[\\w$]+" : ""}\\s*\\([^)]{0,160}`,
          "g",
        ),
      ),
    ]),
    ...inline,
  ].map((match) => match[0].replace(/\s+/g, " "))
}

// The local names an import clause binds: a default as itself and as `name.` (cross-spawn's default is a function with
// members, and child_process's is the module), each named binding (after `as`), and a namespace as `NS.`.
function imported(clause: string) {
  const namespace = clause.match(/\*\s*as\s+([\w$]+)/)?.[1]
  const named = (clause.match(/\{([^{}]*)\}/)?.[1] ?? "").split(",").map(
    (binding) =>
      binding
        .trim()
        .split(/\s+as\s+/)
        .at(-1)!,
  )
  const defaults = clause
    .replace(/\{[^{}]*\}|\*\s*as\s+[\w$]+/g, "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
  return [
    ...defaults.flatMap((name) => [name, `${name}.`]),
    ...named.map((name) => name.trim()).filter(Boolean),
    ...(namespace ? [`${namespace}.`] : []),
  ]
}

// A call that starts the launch decision's file with its arguments, and no shell of its own.
const planned = (call: string) =>
  /^(?:new )?[\w$.]+ ?\( ?(?:isolated\.file, ?(?:\[ ?\.\.\. ?)?isolated\.args\b|\{ ?command: isolated\.file, ?args: isolated\.args\b)/.test(
    call,
  ) && !/\bshell: (?!isolated\.shell\b|false\b)/.test(call)

// What a launch file starts besides the decided file: unplanned calls through process-module names, and every run-time
// primitive the call check cannot follow.
const unplannedCalls = (code: string, runtime: string[]) => [
  ...directCalls(code).filter((call) => !planned(call)),
  ...runtime.filter((label) => !TRACED.includes(label)).map((label) => `${label} primitive`),
]

describe("direct process spawn inventory (spawn review §4, principle 5)", () => {
  test("the scan sees every spawn primitive and ignores comments and look-alikes", () => {
    const cases: [string, string[], string[]][] = [
      ['import { spawn } from "node:child_process"\nspawn("x")', ["child_process"], []],
      ['const cp = require("child_process")\ncp.spawn("x")', ["child_process"], []],
      ['const { execFile } = await import("node:child_process")\nexecFile("x")', ["child_process"], []],
      ['import launch from "cross-spawn"\nlaunch("x")', ["cross-spawn"], []],
      ['import { spawn } from "bun-pty"\nspawn("x", [], {})', ["bun-pty"], []],
      ['createRequire(import.meta.url)("@lydell/node-pty")', ["node-pty"], []],
      ['const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")', ["mcp-stdio"], []],
      ['import open from "open"\nopen("x")', ["open"], []],
      [
        'import { NodeServices } from "@effect/platform-node"\nexport const l = NodeServices.layer',
        ["effect-platform"],
        [],
      ],
      ['Bun.spawn(["x"])', ["Bun.spawn"], []],
      ['Bun.spawnSync(["x"])', ["Bun.spawnSync"], []],
      ["Bun.$`ls`", ["Bun.$"], []],
      ['Bun.openInEditor("x")', ["Bun.openInEditor"], []],
      ['const { spawn } = Bun\nspawn(["x"])', ["Bun[]"], []],
      ['const { spawn } = globalThis.Bun\nspawn(["x"])', ["Bun[]"], []],
      ['globalThis["Bun"].spawn(["x"])', ["Bun[]"], []],
      ['import { $ } from "bun"\n$`ls`', ["bun import"], []],
      ["export const l = NodeChildProcessSpawner.layer", ["platform spawner"], []],
      ['import type { ChildProcess } from "node:child_process"', [], ["child_process"]],
      ['let p: typeof import("@lydell/node-pty")', [], ["node-pty"]],
      // A process module named in a comment needs a reviewed entry: the scan fails closed.
      ['// see "child_process"', [], ["child_process"]],
      ['// Bun.spawn(["x"])', [], []],
      ['import { CrossSpawnSpawner } from "../cross-spawn-spawner"\nexport { CrossSpawnSpawner }', [], []],
      ['export const name = "child_process_extra"', [], []],
      ['Bun.spawned()\nconst { size } = Bun.file("x")\nsize', [], []],
      ['import { serve } from "bun"\nserve({})', [], []],
      ['import OpenAI from "openai"\nws.on("open", () => new OpenAI())', [], []],
      ['import { layer } from "@effect/platform-node/NodeFileSystem"\nexport const l = layer', [], []],
    ]
    expect(
      cases.map((item) => {
        const found = references("case.ts", item[0])
        return [item[0], found.runtime, found.types]
      }),
    ).toEqual(cases)
    expect(
      references(
        "case.tsx",
        'import { spawn } from "child_process"\nexport const C = () => <b onClick={() => spawn("x")} />',
      ).runtime,
    ).toEqual(["child_process"])
  })

  test("every file that reaches a spawner is listed with its stance, and every listed file still does", async () => {
    const found = (await scanned).filter((source) => source.runtime.length > 0 || source.types.length > 0)
    expect(found.map((source) => source.file)).toEqual(
      expect.arrayContaining([
        "packages/core/src/cross-spawn-spawner.ts",
        "packages/core/src/pty/pty.bun.ts",
        "packages/engine/src/plugin/index.ts",
      ]),
    )
    expect(
      found
        .filter((source) => !Object.hasOwn(INVENTORY, source.file))
        .map(
          (source) =>
            `${source.file} ${[...source.runtime, ...source.types.map((label) => `type:${label}`)].join(",")}`,
        ),
    ).toEqual([])
    expect(Object.keys(INVENTORY).filter((file) => !found.some((source) => source.file === file))).toEqual([])
    // Reasons cite symbols, not line numbers, which no check here could keep from going stale.
    expect([...Object.values(INVENTORY), ...HELPER_CALLS].filter((entry) => /:\d/.test(entry.why))).toEqual([])
  })

  test("a type-only entry reaches spawners only in types, and every other entry at run time", async () => {
    const sources = await scanned
    expect(
      Object.entries(INVENTORY)
        .filter((entry) => {
          const source = sources.find((item) => item.file === entry[0])
          return source !== undefined && (entry[1].stance === "type-only") !== (source.runtime.length === 0)
        })
        .map((entry) => entry[0]),
    ).toEqual([])
  })

  test("the launch check sees each other way a launch file can start a process", () => {
    const cases: [string, string[]][] = [
      ['import { execFile } from "node:child_process"\nexecFile(isolated.file, isolated.args)', []],
      [
        'import { execFile } from "node:child_process"\nexecFile("git", isolated.args)',
        ['execFile("git", isolated.args'],
      ],
      ['import cp from "node:child_process"\ncp.exec("x")', ['cp.exec("x"']],
      ['import launch from "cross-spawn"\nlaunch.sync("x")', ['launch.sync("x"']],
      ['const cp = require("child_process")\ncp.spawn("x")', ['cp.spawn("x"']],
      ['const cp = await import("node:child_process")\ncp.spawn("x")', ['cp.spawn("x"']],
      ['require("node:child_process").exec("x")', ['require("node:child_process").exec("x"']],
      ['(await import("node:child_process")).exec("x")', ['import("node:child_process")).exec("x"']],
      ['Bun.spawn(["x"])', ["Bun.spawn primitive"]],
      ['Bun.spawnSync(["x"])', ["Bun.spawnSync primitive"]],
      ["Bun.$`x`", ["Bun.$ primitive"]],
      ['const { spawn } = globalThis.Bun\nspawn(["x"])', ["Bun[] primitive"]],
      ['import { $ } from "bun"\n$`x`', ["bun import primitive"]],
      [
        'import { NodeServices } from "@effect/platform-node"\nexport const l = NodeServices.layer',
        ["effect-platform primitive"],
      ],
    ]
    expect(
      cases.map((item) => {
        const found = references("case.ts", item[0])
        return [item[0], unplannedCalls(found.code, found.runtime)]
      }),
    ).toEqual(cases)
  })

  test("launch sites decide every process and start only the decided file", async () => {
    const sources = await scanned
    const files = listed("launch")
    expect(files).toHaveLength(6)
    const launches = files.map((file) => {
      const source = sources.find((item) => item.file === file)
      return {
        file,
        decides: source !== undefined && /ProcessIsolation\.(?:launch|commandPlan)\(/.test(source.code),
        planned: source !== undefined && directCalls(source.code).some(planned),
        unplanned: source ? unplannedCalls(source.code, source.runtime) : [],
      }
    })
    expect(launches.filter((launch) => !launch.decides || !launch.planned).map((launch) => launch.file)).toEqual([])
    expect(
      launches.flatMap((launch) =>
        launch.unplanned
          .filter((call) => !HELPER_CALLS.some((helper) => helper.file === launch.file && call.startsWith(helper.call)))
          .map((call) => `${launch.file} ${call}`),
      ),
    ).toEqual([])
    expect(
      HELPER_CALLS.filter(
        (helper) =>
          !launches.some(
            (launch) => launch.file === helper.file && launch.unplanned.some((call) => call.startsWith(helper.call)),
          ),
      ).map((helper) => helper.file),
    ).toEqual([])
  })

  test("required-refusal helpers refuse while isolation is required", async () => {
    const sources = await scanned
    expect(
      listed("required-refusal").map((file) => {
        const source = sources.find((item) => item.file === file)
        return [
          file,
          source?.code.includes("ProcessIsolation.required()") ?? false,
          source ? directCalls(source.code).length > 0 : false,
        ]
      }),
    ).toEqual([
      ["packages/core/src/directory-identity.ts", true, true],
      ["packages/core/src/read-only-git.ts", true, true],
    ])
  })

  test("PTY backends load only through pty.ts, which decides each terminal", async () => {
    const sources = await scanned
    const imports: Record<string, string> = (await Bun.file(path.join(ROOT, "packages/core/package.json")).json())
      .imports["#pty"]
    expect(
      [...new Set(Object.values(imports).map((target) => `packages/core/${target.replace(/^\.\//, "")}`))].toSorted(),
    ).toEqual(listed("pty-backend").toSorted())
    expect(
      sources
        .filter((source) =>
          /(["'`])#pty\1|pty\/pty\.(?:bun|node)\b|(["'`])\.\/pty\.(?:bun|node)(?:\.ts)?\2/.test(source.text),
        )
        .map((source) => source.file),
    ).toEqual(["packages/core/src/pty.ts"])
    expect(sources.find((source) => source.file === "packages/core/src/pty.ts")?.code).toMatch(
      /ProcessIsolation\.launch\(/,
    )
  })

  test("the Windows holder loads only through ShellJobs, which refuses it while isolation is required", async () => {
    const sources = await scanned
    const holder = listed("windows-holder")
    expect(holder).toEqual(["packages/engine/src/tool/shell/windows-process.ts"])
    expect(
      sources
        .filter((source) => !holder.includes(source.file))
        .filter((source) => /(["'`])[^"'`\n]*\/windows-process(?:\.ts)?\1/.test(source.text))
        .map((source) => source.file),
    ).toEqual(["packages/engine/src/task/shells.ts"])
    // The refusal's behaviour is shell-required-isolation.test.ts's (S4-3); this pins that ShellJobs still asks it.
    expect(sources.find((source) => source.file === "packages/engine/src/task/shells.ts")?.code).toMatch(
      /isolationRefusal\(\{\s*platform:\s*process\.platform,\s*required:\s*ProcessIsolation\.required\(\)\s*\}\)/,
    )
  })

  test("the plugin host refuses external plugin code while isolation is required", async () => {
    const source = (await scanned).find((item) => item.file === "packages/engine/src/plugin/index.ts")
    expect(source?.runtime).toEqual(["Bun.$"])
    expect(source?.code).toContain("ProcessIsolation.assertExternalCodeAllowed()")
  })

  test("the MCP SDK's stdio transport is constructed only at its launch site", async () => {
    const constructs = (await scanned)
      .filter((source) => /\bnew\s+(?:[\w$]+\.)?StdioClientTransport\s*\(/.test(source.text))
      .map((source) => source.file)
    expect(constructs).toEqual(["packages/engine/src/mcp/stdio.ts"])
    expect(listed("launch")).toContain("packages/engine/src/mcp/stdio.ts")
  })

  test("only cross-spawn-spawner.ts builds Effect's ChildProcessSpawner service", async () => {
    expect((await scanned).filter((source) => SPAWNER_BUILD.test(source.code)).map((source) => source.file)).toEqual([
      "packages/core/src/cross-spawn-spawner.ts",
    ])
  })
})
