// The replay suite: a recorded trace played again with a variant's prompt, for its footprint only. Nothing in it reaches
// the owner's repository:
// - the trace's repository is cloned into a scratch folder without hardlinks, its remotes are removed, its hooks point
//   at an empty folder and it is checked out detached at the recorded commit (never a worktree, which would share
//   refs, stashes and remotes with the original);
// - recorded paths under the repository are moved to the clone, and a call whose path still leads outside it, as written
//   or once links are followed (a committed link to a folder outside), is not run; Vector's external_directory rule is
//   deny besides, so one that slips through is refused rather than approved by --dangerously-skip-permissions;
// - only read-only helpers and the read, glob and grep tools run, and edits and writes apply to the clone. Every other
//   call is answered with its recorded output through `cat`, so the next request carries what the recorded one did;
// - Vector runs with the offline shell sandbox and Vector Local on, against the local fake model server.

import { lstatSync, readlinkSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { BrainSkill } from "../../../packages/core/src/brain/skill"
import { MODEL, REPO_ROOT, environment, exec } from "../compounding/harness"
import { serve, type Call } from "../compounding/model-server"
import type { Recorded } from "../prompt-cache"
import type { Trace } from "./traces"

export type Step = {
  readonly prompt: number
  readonly call: Extract<Call, { name: string }>
  /** The recorded output `cat` answers with, when the call itself is not run. */
  readonly recorded?: string
}

const FILE_TOOLS = ["read", "glob", "grep", "edit", "write"]

/** Plays a trace with this configuration added to Vector's, and returns every request Vector sent. */
export async function replay(
  trace: Trace,
  input: { readonly config: Record<string, unknown>; readonly engine?: string; readonly scratch?: string },
) {
  if (!trace.repo) throw new Error("This trace names no repository to clone; record it again with --repo.")
  const scratch = input.scratch ?? (await mkdtemp(join(tmpdir(), "vector-prompt-evolve-replay-")))
  try {
    const clone = await cloneOf(trace, scratch)
    const outputs = join(scratch, "outputs")
    await mkdir(outputs, { recursive: true })
    const steps = plan(trace, { clone, outputs })
    await Promise.all(
      steps.flatMap((step, at) =>
        step.recorded === undefined ? [] : [writeFile(join(outputs, String(at)), step.recorded)],
      ),
    )
    const server = serve((body) => next(body, trace, steps))
    const env = {
      ...environment({
        arm: "off",
        home: join(scratch, "home"),
        dir: clone,
        bin: join(scratch, "bin"),
        registry: join(scratch, "registry"),
        url: server.url,
        // Nothing outside the clone but the recorded outputs `cat` answers with, whatever a variant's config says: a
        // path that leads out is refused, not asked, and so never approved by --dangerously-skip-permissions.
        config: {
          ...input.config,
          permission: {
            ...(input.config.permission as object | undefined),
            external_directory: {
              "*": "deny",
              [join(outputs, "*")]: "allow",
              [join(realpathSync(outputs), "*")]: "allow",
            },
          },
        },
      }),
      // A database on disk, so a trace's later prompts continue its session.
      VECTOR_AGENT_DB: join(scratch, "agent.db"),
      VECTOR_SHELL_SANDBOX: "1",
      VECTOR_LOCAL: "1",
      // The fake model server is the one model server Vector Local lets requests reach.
      VECTOR_LOCAL_POLICY: JSON.stringify({ endpoints: [server.url] }),
    }
    const engine = input.engine ?? join(REPO_ROOT, "packages", "engine", "src", "index.ts")
    // One prompt after another, each later one continuing the session.
    const runs = await trace.prompts
      .reduce(
        async (previous, _, at) => [
          ...(await previous),
          await exec(
            process.execPath,
            [
              "run",
              "--conditions=browser",
              engine,
              "run",
              ...(at > 0 ? ["--continue"] : []),
              "--format",
              "json",
              "--model",
              `anthropic/${MODEL}`,
              "--dangerously-skip-permissions",
              prompt(trace, at),
            ],
            clone,
            env,
          ),
        ],
        Promise.resolve([] as Awaited<ReturnType<typeof exec>>[]),
      )
      .finally(() => server.stop())
    return {
      requests: server.requests as Recorded[],
      exitCodes: runs.map((run) => run.exitCode),
      output: runs.map((run) => run.output).join("\n"),
    }
  } finally {
    if (!input.scratch) await rm(scratch, { recursive: true, force: true })
  }
}

/** What the fake model calls for each recorded call: the call itself where it is safe to run, else `cat` of its output. */
export function plan(trace: Trace, input: { readonly clone: string; readonly outputs: string }): Step[] {
  const clone = landing(input.clone)
  // Inside as written and where it lands: a committed link to a folder outside resolves out of the clone.
  const within = (path: unknown, cwd = input.clone) =>
    typeof path !== "string" ||
    (!relative(input.clone, resolve(cwd, path)).startsWith("..") &&
      !relative(clone, landing(resolve(cwd, path))).startsWith(".."))
  return trace.calls.map((call, at) => {
    const moved = trace.repo ? (move(call.input, trace.repo, input.clone) as Record<string, unknown>) : call.input
    const command = String(moved.command ?? "")
    const cwd = typeof moved.workdir === "string" ? resolve(input.clone, moved.workdir) : input.clone
    const runs =
      call.tool === "bash"
        ? helper(command) &&
          within(moved.workdir) &&
          command
            .trim()
            .split(/\s+/)
            .slice(1)
            .filter((word) => !word.startsWith("-"))
            .every((word) => within(word.replace(/["']/g, ""), cwd))
        : FILE_TOOLS.includes(call.tool) && [moved.filePath, moved.path].every((path) => within(path))
    if (runs) return { prompt: call.prompt, call: { name: call.tool, input: moved } }
    return {
      prompt: call.prompt,
      call: {
        name: "bash",
        input: {
          command: `cat '${join(input.outputs, String(at))}'`,
          description: String(call.input.description ?? `Recorded ${call.tool} output`),
        },
      },
      recorded: call.output,
    }
  })
}

/** The replay policy: the next recorded call of the prompt this request answers, then a short answer. */
export function next(body: Record<string, unknown>, trace: Trace, steps: readonly Step[]): Call {
  const messages = (Array.isArray(body.messages) ? body.messages : []) as { role: string; content: unknown }[]
  // The prompts are found in order, so a prompt that repeats an earlier one still counts as the next.
  const found = messages.reduce(
    (state, message, at) =>
      message.role === "user" &&
      state.prompt < trace.prompts.length &&
      text(message.content).includes(prompt(trace, state.prompt))
        ? { prompt: state.prompt + 1, at }
        : state,
    { prompt: 0, at: -1 },
  )
  const made = messages
    .slice(found.at + 1)
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === "tool_use").length
  return steps.filter((step) => step.prompt === found.prompt - 1)[made]?.call ?? { text: "Done." }
}

/**
 * A command that runs as recorded: one a learned skill may name as a helper (build contract 2.3), simple, read-only
 * and with its arguments inside the repository.
 */
export const helper = BrainSkill.helper

async function cloneOf(trace: Trace, scratch: string) {
  const clone = join(scratch, "repo")
  const hooks = join(scratch, "hooks")
  await mkdir(hooks, { recursive: true })
  // No global or system configuration, so none of the owner's hooks, templates or credential helpers apply.
  const git = async (cwd: string, args: string[]) => {
    const result = await exec("git", ["-c", `core.hooksPath=${hooks}`, ...args], cwd, {
      PATH: process.env.PATH ?? "",
      HOME: scratch,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.output}`)
    return result.stdout
  }
  await git(scratch, ["clone", "--no-hardlinks", "--quiet", trace.repo!, clone])
  for (const remote of (await git(clone, ["remote"])).split("\n").filter(Boolean))
    await git(clone, ["remote", "remove", remote])
  await git(clone, ["config", "core.hooksPath", hooks])
  await git(clone, ["checkout", "--detach", "--quiet", trace.commit ?? "HEAD"])
  return clone
}

// Where a path lands once every link on the way is followed, a link to nowhere included, as FSUtil.realpath resolves
// it: the deepest folder that exists, resolved, with the rest of the path after it.
function landing(target: string, depth = 0): string {
  const absolute = resolve(target)
  const real = (() => {
    try {
      return realpathSync(absolute)
    } catch {
      return undefined
    }
  })()
  if (real !== undefined || depth > 40) return real ?? absolute
  if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink())
    return landing(resolve(dirname(absolute), readlinkSync(absolute)), depth + 1)
  const parent = dirname(absolute)
  return parent === absolute ? absolute : join(landing(parent, depth + 1), basename(absolute))
}

function prompt(trace: Trace, at: number) {
  return trace.prompts[at]?.trim() || "Continue."
}

function text(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((block) => (block?.type === "text" ? String(block.text) : "")).join("\n")
}

// Every recorded path under the repository, moved to the clone.
function move(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string")
    return value.replace(new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$|[\\s"'\`:;,)])`, "g"), to)
  if (Array.isArray(value)) return value.map((item) => move(item, from, to))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, move(item, from, to)]))
  return value
}
