import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { runExternalCodingAgent } from "./external-agents"
import {
  registerComputerOverlayIpc,
  setComputerOverlayControls,
  type ComputerOverlayControls,
} from "./computer-overlay-ipc"

/*
 * Guards for what the vendors' terms ask of Vector when it runs a user's own Claude Code or Codex: the run keeps every
 * sign-in method the CLI has, Vector neither adds nor removes the variables those methods read, never points Codex at
 * a home or an identity of Vector's, and only the desktop app on the user's own computer runs either of them.
 */

const root = await mkdtemp(join(tmpdir(), "vector-agent-guards-"))
afterAll(() => rm(root, { recursive: true, force: true }))

const repository = join(import.meta.dir, "..", "..", "..", "..")

// A fake CLI that writes the arguments it got and each named variable as it got it, one per line. The values are
// fixtures made up for this test.
async function recordingCli(name: string, cli: string, variables: readonly string[], events: readonly object[]) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  const body = [
    "#!/bin/sh",
    `for arg in "$@"; do printf 'arg:%s\\n' "$arg" >> '${directory}/seen'; done`,
    ...variables.map(
      (variable) =>
        `if printenv ${variable} > /dev/null; then printf '${variable}=%s\\n' "$(printenv ${variable})" >> '${directory}/seen'; fi`,
    ),
    ...events.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`),
  ].join("\n")
  await writeFile(join(directory, cli), `${body}\n`)
  await chmod(join(directory, cli), 0o755)
  return {
    env: { HOME: join(root, `${name}-home`), PATH: `${directory}:/usr/bin:/bin` },
    seen: async () => (await Bun.file(join(directory, "seen")).text()).trim().split("\n"),
  }
}

const CLAUDE_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_ENTRYPOINT",
]
const CLAUDE_RESULT = { type: "result", subtype: "success", is_error: false, result: "Done", session_id: "s-guard" }

const CODEX_VARIABLES = ["CODEX_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "OPENAI_API_KEY", "OPENAI_BASE_URL"]
const CODEX_EVENTS = [
  { type: "thread.started", thread_id: "t-guard" },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
]

describe("Claude Code runs with every sign-in method it has", () => {
  test("Vector passes the user's own Anthropic variables through unchanged and adds none of its own", async () => {
    const own = {
      ANTHROPIC_API_KEY: "fixture-api-key",
      ANTHROPIC_AUTH_TOKEN: "fixture-auth-token",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth-token",
      ANTHROPIC_BASE_URL: "https://gateway.example.test",
      CLAUDE_CODE_USE_BEDROCK: "1",
    }
    const cli = await recordingCli("claude-own", "claude", CLAUDE_VARIABLES, [CLAUDE_RESULT])
    const run = await runExternalCodingAgent({
      runtime: "claude-code",
      cwd: root,
      prompt: "fixture only",
      env: { ...cli.env, ...own },
      finishGraceMs: 50,
      killGraceMs: 50,
    })
    expect(run.exitCode).toBe(0)
    const seen = await cli.seen()
    expect(seen.filter((line) => !line.startsWith("arg:"))).toEqual(
      Object.entries(own).map(([name, value]) => `${name}=${value}`),
    )
    // Its documented flags only: never bare mode, which ignores a subscription sign-in, and no settings override that
    // could force a login method.
    const args = seen.filter((line) => line.startsWith("arg:")).map((line) => line.slice(4))
    expect(args).toContain("-p")
    expect(args).not.toContain("--bare")
    expect(args).not.toContain("--settings")
    expect(args.join(" ")).not.toMatch(/forceLoginMethod|apiKeyHelper|setup-token/)
  }, 20_000)

  test("with none of them set, the CLI gets none: Vector never supplies a key, a token or a server", async () => {
    const cli = await recordingCli("claude-none", "claude", CLAUDE_VARIABLES, [CLAUDE_RESULT])
    await runExternalCodingAgent({
      runtime: "claude-code",
      cwd: root,
      prompt: "fixture only",
      env: cli.env,
      finishGraceMs: 50,
      killGraceMs: 50,
    })
    expect((await cli.seen()).filter((line) => !line.startsWith("arg:"))).toEqual([])
  }, 20_000)
})

describe("Codex runs as itself, on its own home and sign-in", () => {
  test("Vector sets no CODEX_HOME and no originator, and keeps the user's own home as it is", async () => {
    const cli = await recordingCli("codex-none", "codex", CODEX_VARIABLES, CODEX_EVENTS)
    const run = await runExternalCodingAgent({
      runtime: "codex",
      cwd: root,
      prompt: "fixture only",
      env: cli.env,
      finishGraceMs: 50,
      killGraceMs: 50,
    })
    expect(run.exitCode).toBe(0)
    const seen = await cli.seen()
    expect(seen.filter((line) => !line.startsWith("arg:"))).toEqual([])
    const args = seen.filter((line) => line.startsWith("arg:")).map((line) => line.slice(4))
    expect(args.slice(0, 4)).toEqual(["exec", "--json", "--sandbox", "workspace-write"])
    expect(args.join(" ")).not.toMatch(/danger-full-access|dangerously|--full-auto|--yolo|--ignore-user-config/)
    expect(args.join(" ")).not.toMatch(/forced_login_method|cli_auth_credentials_store|originator/i)

    const own = await recordingCli("codex-own", "codex", CODEX_VARIABLES, CODEX_EVENTS)
    const home = join(root, "users-own-codex-home")
    await runExternalCodingAgent({
      runtime: "codex",
      cwd: root,
      prompt: "fixture only",
      env: { ...own.env, CODEX_HOME: home },
      finishGraceMs: 50,
      killGraceMs: 50,
    })
    expect((await own.seen()).filter((line) => !line.startsWith("arg:"))).toEqual([`CODEX_HOME=${home}`])
  }, 20_000)
})

// Every source file under `directory`, as [path relative to the repository, text], tests and generated code left out.
async function sources(directory: string): Promise<[string, string][]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => [])
  const files = entries.filter(
    (entry) =>
      entry.isFile() &&
      /\.(?:ts|tsx|mts|js|mjs)$/.test(entry.name) &&
      !/\.test\.|\.spec\.|\.d\.ts$/.test(entry.name) &&
      !/node_modules|[\\/]dist[\\/]|[\\/]generated/.test(join(entry.parentPath, entry.name)),
  )
  return Promise.all(
    files.map(
      async (entry): Promise<[string, string]> => [
        relative(repository, join(entry.parentPath, entry.name)),
        await Bun.file(join(entry.parentPath, entry.name)).text(),
      ],
    ),
  )
}

describe("where these agents can run", () => {
  test("no code of Vector's sets a login method, a Codex home or identity, or a Claude token", async () => {
    const files = [
      ...(await sources(join(repository, "packages", "desktop", "src"))),
      ...(await sources(join(repository, "packages", "app", "src"))),
      ...(await sources(join(repository, "packages", "schema", "src"))),
    ]
    expect(files.length).toBeGreaterThan(100)
    const offending = files.flatMap(([path, text]) =>
      /forceLoginMethod|CODEX_HOME|CODEX_INTERNAL_ORIGINATOR_OVERRIDE|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|setup-token|"--bare"/.test(
        text,
      )
        ? [path]
        : [],
    )
    expect(offending).toEqual([])
  })

  test("only the desktop app on the user's own computer starts them: no server, engine, CLI or cloud code can", async () => {
    // Everything that runs on a server Vector hosts, a remote host, a container or a CI runner. The web package is the
    // static site, which names the agents but runs none.
    const hosted = [
      "api",
      ...[
        "engine",
        "server",
        "core",
        "cli",
        "cloud",
        "client",
        "protocol",
        "sdk",
        "sdk-next",
        "plugin",
        "llm",
        "tui",
      ].map((name) => join("packages", name, "src")),
    ]
    const files = (await Promise.all(hosted.map((directory) => sources(join(repository, directory))))).flat()
    expect(files.length).toBeGreaterThan(100)
    const invokesExternal = (text: string) =>
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'][^"']*(?:schema\/external-agent|external-agents)["']|\b(?:runExternalCodingAgent|launchAgentTerminal)\s*\(/.test(
        text,
      )
    for (const text of [
      'import { runExternalCodingAgent } from "../desktop/external-agents"',
      'await import("./external-agents")',
      'require("./external-agents")',
      'import "./external-agents"',
      "runExternalCodingAgent(input)",
      "bridge.launchAgentTerminal(input)",
    ])
      expect(invokesExternal(text)).toBe(true)
    expect(invokesExternal('source: "external-agents"')).toBe(false)
    const offending = files.flatMap(([path, text]) => (invokesExternal(text) ? [path] : []))
    expect(offending).toEqual([])
  })

  test("every desktop command that starts, prompts, resumes or opens one answers only Vector's own window", async () => {
    const ipc = await Bun.file(join(import.meta.dir, "ipc.ts")).text()
    // The only separate adapter is the banner's fixed, independently authenticated control surface.
    const bannerAdapter =
      /registerComputerOverlayIpc\(\{\s*handle: \(channel, callback\) => ipcMain\.handle\(channel, callback\),\s*on: \(channel, callback\) => ipcMain\.on\(channel, callback\),\s*\}\)/g
    expect([...ipc.matchAll(bannerAdapter)]).toHaveLength(1)
    // Every remaining raw invocation registration stays inside the ordinary trusted-renderer wrapper.
    expect(ipc.replace(bannerAdapter, "").match(/ipcMain\.handle\(/g)).toHaveLength(1)
    expect(ipc).toMatch(
      /function handle<[^]*?ipcMain\.handle\(channel, \(event, \.\.\.args\) => \{\s*assertTrustedRenderer\(event\)/,
    )
    for (const channel of [
      "parallel-workspaces-create",
      "parallel-workspaces-run",
      "parallel-workspaces-follow-up",
      "parallel-workspaces-repair",
      "external-agents-launch-terminal",
      "external-agents-commands",
    ])
      expect(ipc).toContain(`handle("${channel}"`)
  })

  test("the separate banner adapter exposes only fixed controls to its exact current owner and main frame", async () => {
    const handlers = new Map<string, Parameters<Parameters<typeof registerComputerOverlayIpc>[0]["handle"]>[1]>()
    const listeners = new Map<string, Parameters<Parameters<typeof registerComputerOverlayIpc>[0]["on"]>[1]>()
    registerComputerOverlayIpc({
      handle: (channel, callback) => {
        handlers.set(channel, callback)
      },
      on: (channel, callback) => {
        listeners.set(channel, callback)
      },
    })
    expect([...handlers.keys()]).toEqual(["computer-overlay-act"])
    expect([...listeners.keys()]).toEqual(["computer-overlay-hover"])
    const mainFrame = {}
    let senderClosed = false
    let bannerClosed = false
    const contents = { id: 42, mainFrame, isDestroyed: () => senderClosed }
    const owned = { sender: contents, senderFrame: mainFrame }
    const calls: string[] = []
    const hovers: boolean[] = []
    const control: ComputerOverlayControls = {
      banner: () => ({ isDestroyed: () => bannerClosed, webContents: contents }),
      state: () => ({
        phase: "working",
        backend: "local-macos",
        mode: "foreground",
        apps: [],
        queue: [],
        escStops: false,
        stopChord: "Command+Shift+Escape",
        lease: 1,
        reduceMotion: false,
      }),
      armed: () => false,
      act: async (action) => {
        calls.push(action)
        return true
      },
      hover: (on) => {
        hovers.push(on)
      },
    }
    const invoke = handlers.get("computer-overlay-act")!
    const hover = listeners.get("computer-overlay-hover")!
    const detach = setComputerOverlayControls(control)
    try {
      for (const event of [
        { ...owned, sender: { ...contents } }, // Same ID and frame cannot impersonate the banner object.
        { ...owned, senderFrame: {} },
        { sender: contents },
      ]) {
        expect(await invoke(event, "stop")).toBe(false)
        hover(event, true)
      }
      expect(await invoke(owned, "external-agents-launch-terminal")).toBe(false)
      senderClosed = true
      expect(await invoke(owned, "stop")).toBe(false)
      senderClosed = false
      bannerClosed = true
      expect(await invoke(owned, "stop")).toBe(false)
      bannerClosed = false
      expect(calls).toEqual([])
      expect(hovers).toEqual([])
      expect(await invoke(owned, "stop")).toBe(true)
      hover(owned, true)
      expect(calls).toEqual(["stop"])
      expect(hovers).toEqual([true])
      detach()
      expect(await invoke(owned, "stop")).toBe(false)
      hover(owned, false)
      expect(calls).toEqual(["stop"])
      expect(hovers).toEqual([true])
    } finally {
      detach()
    }
  })
})
