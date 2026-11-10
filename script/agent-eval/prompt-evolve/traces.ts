#!/usr/bin/env bun
// Recorded runs for the replay suite: what the user asked, and every tool call with the output it got. A trace is made
// from `vector export <session>` JSON or a harness `--dump` file, redacted with BrainScan.redact, and kept outside the
// repository, since it holds the owner's code, paths and commands: in
// ${XDG_STATE_HOME:-~/.local/state}/vector-prompt-evolve/traces/, a folder only its owner can open.
//
//   bun script/agent-eval/prompt-evolve/traces.ts <export.json> [--repo <path>] [--commit <sha>] [--name <name>]

import { chmod, mkdir, readdir, realpath, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { BrainScan } from "../../../packages/core/src/brain/scan"
import { REPO_ROOT } from "./variants"

export type Call = {
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly output: string
  /** Which of the trace's prompts the call answered. */
  readonly prompt: number
}

export type Trace = {
  /** The repository the run worked in, which replay clones. */
  readonly repo?: string
  readonly commit?: string
  readonly prompts: readonly string[]
  readonly calls: readonly Call[]
}

export function directory(env: Record<string, string | undefined> = process.env) {
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "vector-prompt-evolve", "traces")
}

/** A trace from `vector export` JSON or a `--dump` file (the compounding harness's, or footprint's list of requests). */
export function parse(value: unknown, options: { readonly repo?: string; readonly commit?: string } = {}): Trace {
  const data = value as Record<string, unknown>
  const recorded = Array.isArray(value) ? value : Array.isArray(data?.requests) ? data.requests : undefined
  const trace = recorded ? fromRequests(recorded) : fromExport(data)
  const repo = options.repo ?? trace.repo
  return redact({
    ...trace,
    ...(repo ? { repo: resolve(repo) } : {}),
    ...(options.commit ? { commit: options.commit } : {}),
  })
}

export async function save(trace: Trace, name: string, env: Record<string, string | undefined> = process.env) {
  if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) throw new Error(`A trace name is letters, digits, ".", "_" and "-": ${name}`)
  const dir = directory(env)
  if (await inside(dir))
    throw new Error(`Traces stay outside the repository, and ${dir} is inside it. Set XDG_STATE_HOME elsewhere.`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const file = join(dir, `${name}.json`)
  await writeFile(file, `${JSON.stringify(trace, null, 1)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  return file
}

export async function list(env: Record<string, string | undefined> = process.env) {
  const names = await readdir(directory(env)).catch(() => [])
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => basename(name, ".json"))
    .toSorted()
}

export async function read(name: string, env: Record<string, string | undefined> = process.env): Promise<Trace> {
  return Bun.file(join(directory(env), `${name}.json`)).json()
}

function fromExport(data: Record<string, unknown>): Trace {
  const messages = (Array.isArray(data?.messages) ? data.messages : []) as {
    info?: Record<string, unknown>
    parts?: Record<string, unknown>[]
  }[]
  const prompts: string[] = []
  const calls = messages.flatMap((message) => {
    if (message.info?.role === "user") {
      prompts.push(
        (message.parts ?? [])
          .flatMap((part) => (part.type === "text" && !part.synthetic ? [String(part.text ?? "")] : []))
          .join("\n"),
      )
      return []
    }
    return (message.parts ?? []).flatMap((part) => {
      const state = (part.state ?? {}) as Record<string, unknown>
      if (part.type !== "tool" || (state.status !== "completed" && state.status !== "error")) return []
      const output = typeof state.output === "string" ? state.output : String(state.error ?? "")
      return [
        {
          tool: String(part.tool),
          input: (state.input ?? {}) as Record<string, unknown>,
          output,
          prompt: Math.max(0, prompts.length - 1),
        },
      ]
    })
  })
  const info = (data?.info ?? {}) as Record<string, unknown>
  return { ...(typeof info.directory === "string" ? { repo: info.directory } : {}), prompts, calls }
}

// The longest conversation the model was sent holds every call and result. A user message without a tool result
// starts a prompt.
function fromRequests(recorded: readonly unknown[]): Trace {
  const bodies = recorded.map(
    (item) => ((item as { body?: Record<string, unknown> }).body ?? {}) as Record<string, unknown>,
  )
  const longest = bodies
    .filter((body) => Array.isArray(body.tools) && body.tools.length > 0)
    .toSorted((a, b) => size(b) - size(a))[0]
  const messages = (longest?.messages ?? []) as { role: string; content: unknown }[]
  const blocks = (message: { content: unknown }) =>
    (typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : Array.isArray(message.content)
        ? message.content
        : []) as Record<string, unknown>[]
  const results = new Map(
    messages.flatMap((message) =>
      blocks(message).flatMap((block) =>
        block.type === "tool_result" ? [[String(block.tool_use_id), flatten(block.content)] as const] : [],
      ),
    ),
  )
  const prompts: string[] = []
  const calls = messages.flatMap((message) => {
    const content = blocks(message)
    if (message.role === "user" && !content.some((block) => block.type === "tool_result")) {
      prompts.push(content.flatMap((block) => (block.type === "text" ? [String(block.text)] : [])).join("\n"))
      return []
    }
    if (message.role !== "assistant") return []
    return content.flatMap((block) =>
      block.type === "tool_use"
        ? [
            {
              tool: String(block.name),
              input: (block.input ?? {}) as Record<string, unknown>,
              output: results.get(String(block.id)) ?? "",
              prompt: Math.max(0, prompts.length - 1),
            },
          ]
        : [],
    )
  })
  return { prompts, calls }
}

function size(body: Record<string, unknown>) {
  return Array.isArray(body.messages) ? body.messages.length : 0
}

function flatten(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(flatten).join("\n")
  if (value && typeof value === "object" && "text" in value) return flatten(value.text)
  return ""
}

// Every string a trace keeps, prompts, inputs and outputs alike, with credentials replaced.
function redact(trace: Trace): Trace {
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return BrainScan.redact(value).text
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]))
    return value
  }
  return {
    ...trace,
    prompts: trace.prompts.map((prompt) => BrainScan.redact(prompt).text),
    calls: trace.calls.map((call) => ({
      ...call,
      input: clean(call.input) as Record<string, unknown>,
      output: BrainScan.redact(call.output).text,
    })),
  }
}

// Whether a folder is the repository or under it, symlinks resolved as far as the folder exists.
async function inside(dir: string) {
  const root = await realpath(REPO_ROOT)
  const existing = async (path: string): Promise<string> =>
    realpath(path).catch(() =>
      dirname(path) === path ? path : existing(dirname(path)).then((parent) => join(parent, basename(path))),
    )
  const path = relative(root, await existing(resolve(dir)))
  return !path.startsWith("..") && !path.startsWith("/")
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined)
  const file = argv.find((item, at) => !item.startsWith("--") && !argv[at - 1]?.startsWith("--"))
  if (!file) {
    process.stderr.write(
      "Usage: bun script/agent-eval/prompt-evolve/traces.ts <export.json> [--repo <path>] [--commit <sha>] [--name <name>]\n",
    )
    process.exit(2)
  }
  const trace = parse(await Bun.file(file).json(), { repo: flag("repo"), commit: flag("commit") })
  if (!trace.repo) process.stderr.write("No repository in this file: give --repo, or replay cannot clone one.\n")
  process.stdout.write(`${await save(trace, flag("name") ?? basename(file).replace(/\.json$/, ""))}\n`)
}
