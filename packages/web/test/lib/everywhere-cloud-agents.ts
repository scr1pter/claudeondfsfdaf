import { expect } from "bun:test"
import { randomBytes, randomInt } from "node:crypto"
import type { GithubAgents } from "../../../core/src/github-agents"
import type { RepoBinding } from "../../../../api/_lib/cloud-agents-binding"
import type { CloudRunTrigger, prepareCloudRun, StartCloudRunResult } from "../../../../api/_lib/cloud-agents-start"
import type { RunSource } from "../../../../packages/schema/src/codium-run-trigger"

/*
 * spec §9's FakeCloudAgents: the stand-ins for @vector that the Actions fallback's tests share. EV-32 moved them here
 * unchanged from everywhere-cloud-adapter.test.ts (EV-29, EV-30), for everywhere-journey-actions.test.ts too: a stored
 * binding hash that @vector's real decoder reads behind a stub store, a stand-in for the App's live repository read, a
 * recording prepareCloudRun that returns a ticket hash, a live workflow-mode reader, and @vector's run record behind a
 * read-only stub of its store, which notifyRunSettle's and listCloudRuns' real decoders read. Nothing here reaches a
 * network.
 */

export const BINDING_KEY = "vector:cloud-agents:binding:"
export const VECTOR_RUN_KEY = "vector:cloud-agents:run:"

export type Command = readonly (string | number)[]

/** A stored binding hash, as @vector's REDEEM writes it; `drop` removes fields, `with` adds or replaces them. */
export function bindingFields(input: {
  readonly repositoryId: string
  readonly account: string
  readonly with?: Record<string, string>
  readonly drop?: readonly string[]
}) {
  const fields: Record<string, string> = {
    repositoryId: input.repositoryId,
    ownerId: "456",
    repository: "fixture-owner/project",
    account: input.account,
    visibility: "private",
    defaultRef: "refs/heads/main",
    generation: "1",
    binderGithubId: "790",
    binderLogin: "fixture-binder",
    workflowVersion: "3",
    boundAt: String(Date.now()),
    installationId: "600",
    workflowMode: "codium",
    ...input.with,
  }
  for (const name of input.drop ?? []) delete fields[name]
  return fields
}

/** Answers bindingFor's one READ with the hash, so @vector's real decoder runs; "down" throws like a lost store. */
export function bindingStore(answer: () => Record<string, string> | undefined | "down") {
  const commands: Command[] = []
  const store = async (command: Command) => {
    commands.push(command)
    const value = answer()
    if (value === "down") throw new Error("store down")
    expect(command[0]).toBe("EVAL")
    expect(command[2]).toBe("1")
    expect(String(command[3]).startsWith(BINDING_KEY)).toBe(true)
    return [value ? Object.entries(value).flat() : []]
  }
  return { store, commands }
}

/** A stand-in for attachmentRepository, including its optional live visibility field. */
export function stubApp(answer: () => Promise<{ publicRepository: boolean; visibility?: string }>) {
  const calls: RepoBinding[] = []
  return {
    calls,
    attachmentRepository: async (binding: RepoBinding) => {
      calls.push(binding)
      return answer()
    },
  }
}
export const privateApp = () => stubApp(async () => ({ publicRepository: false, visibility: "private" }))

export function preparer(answer?: () => Promise<Awaited<ReturnType<typeof prepareCloudRun>>>) {
  const state = {
    triggers: [] as CloudRunTrigger[],
    ticketHash: randomBytes(32).toString("hex"),
    dispatches: 0,
    cancels: 0,
    dispatchAnswer: { ok: true, dispatchedAt: 1 } as StartCloudRunResult,
    onDispatch: async () => {},
  }
  const prepare: typeof prepareCloudRun = async (trigger) => {
    state.triggers.push(trigger)
    if (answer) return answer()
    return {
      ok: true,
      ticketHash: state.ticketHash,
      dispatch: async () => {
        state.dispatches++
        await state.onDispatch()
        return state.dispatchAnswer
      },
      cancel: async () => {
        state.cancels++
        return true
      },
    }
  }
  return { state, prepare }
}

export function liveModes(answer: () => Promise<"codium" | "own-key" | undefined>) {
  const calls: RepoBinding[] = []
  return {
    calls,
    liveMode: async (binding: RepoBinding) => {
      calls.push(binding)
      return answer()
    },
  }
}

export const sources = (...names: RunSource[]) => new Set<RunSource>(names)

/** A @vector run record as recordRunStart and the settle write it, which listCloudRuns' and runPages' decoders accept. */
export function vectorRun(input: {
  readonly account: string
  readonly rid: string
  readonly outcome?: GithubAgents.Outcome
  readonly with?: Record<string, string>
}) {
  const parts = /^gh-(\d+)-(\d+)-(\d+)-(\d+)$/.exec(input.rid)!
  const verdict =
    input.outcome === "changes" ? "pass" : input.outcome === "draft" || input.outcome === "failed" ? "fail" : "none"
  return {
    rid: input.rid,
    account: input.account,
    repository: "acme/app",
    repositoryId: parts[1]!,
    runUrl: `https://github.com/acme/app/actions/runs/${parts[2]}`,
    event: "workflow_dispatch",
    source: "github-dispatch",
    purpose: "task",
    startedAt: "1700000000000",
    generation: "1",
    jti: "A".repeat(22),
    ...(input.outcome ? { endedAt: "1700000600000", outcome: input.outcome, verdict } : {}),
    ...input.with,
  }
}

/**
 * @vector's store as listCloudRuns (ZREVRANGE, then the READ script) and runPages (the RECORD script) read it. It
 * records every command, and refuses any other: nothing here may write a run record.
 */
export function vectorStore(runs: () => readonly Record<string, string>[] | "down") {
  const commands: Command[] = []
  const store = async (command: Command) => {
    commands.push(command)
    const list = runs()
    if (list === "down") throw new Error("store down")
    if (command[0] === "ZREVRANGE") return list.map((run) => run.rid)
    if (command[0] === "EVAL" && command[2] === "1") {
      const run = list.find((entry) => `${VECTOR_RUN_KEY}${entry.rid}` === command[3])
      return run ? Object.entries(run).flat() : []
    }
    if (command[0] === "EVAL") return [[], ...list.map((run) => [Object.entries(run).flat(), []])]
    throw new Error(`@vector's store got ${String(command[0])}`)
  }
  return { store, commands }
}

export const runId = () => `gh-101-${randomInt(1, 2 ** 40)}-1-${randomInt(1, 2 ** 40)}`
