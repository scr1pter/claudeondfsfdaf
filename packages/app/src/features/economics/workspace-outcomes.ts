import { ExternalAgent } from "@vectordevai/schema/external-agent"
import { Billing } from "@vectordevai/schema/billing"
import { isTerminalWorkspace, type WorkspaceRecordForEconomics } from "./economics-repository"

export type WorkspaceOutcomeRecord = WorkspaceRecordForEconomics & {
  revision?: number
  isolatedPath: string
  agentSessionId?: string
  taskPrompt: string
  /** Vector's own agent ("vector") or a user's own coding agent, whose runs are never recorded. */
  runtime?: string
  excludedFromLearning?: boolean
}

// Polls repeat terminal records frequently. Retry failed captures, but only remeasure successful ones
// when their economic evidence changes or a session-family notification reports additional usage.
export function createWorkspaceOutcomeRecorder(
  record: (workspace: WorkspaceOutcomeRecord, current: () => boolean) => Promise<void>,
) {
  type State = {
    workspace: WorkspaceOutcomeRecord
    signature: string
    generation: number
    recorded?: number
    attempts: number
    requested: boolean
    pending?: Promise<boolean>
  }
  const states = new Map<string, State>()
  const lifecycle = { disposed: false }
  const run = (state: State): Promise<boolean> => {
    if (lifecycle.disposed || !isTerminalWorkspace(state.workspace)) return Promise.resolve(false)
    if (state.pending) return state.pending
    if (state.recorded === state.generation) return Promise.resolve(true)
    if (state.attempts >= 3) return Promise.resolve(false)
    const generation = state.generation
    const workspace = state.workspace
    const current = () => !lifecycle.disposed && state.generation === generation
    state.attempts += 1
    state.pending = Promise.resolve()
      .then(() => (current() ? record(workspace, current) : undefined))
      .then(() => {
        if (!current()) return false
        state.recorded = generation
        return true
      })
      .catch(() => {
        if (current() && state.attempts < 3) state.requested = true
        return false
      })
      .then((recorded) => {
        state.pending = undefined
        if (!state.requested || lifecycle.disposed) return recorded
        state.requested = false
        return run(state)
      })
    return state.pending
  }
  return {
    observe(input: WorkspaceOutcomeRecord, force = false): Promise<boolean> {
      if (lifecycle.disposed) return Promise.resolve(false)
      // A run of a user's own coding agent is never measured into the recommendations: its vendor's terms bar using
      // it to evaluate or rank models (ExternalAgent.excludedFromLearning).
      if (ExternalAgent.excludedFromLearning(input) || Billing.isCodium(input.provider)) return Promise.resolve(false)
      const key = JSON.stringify([input.sourcePath, input.id])
      const previous = states.get(key)
      if (previous && (input.revision ?? 0) < (previous.workspace.revision ?? 0))
        return previous.pending ?? Promise.resolve(previous.recorded === previous.generation)
      // Retain only fields used for evidence and routing, not the workspace's diff, logs or terminal output.
      const workspace: WorkspaceOutcomeRecord = {
        id: input.id,
        sourcePath: input.sourcePath,
        provider: input.provider,
        model: input.model,
        createdAt: input.createdAt,
        lastActivityAt: input.lastActivityAt,
        revision: input.revision,
        isolatedPath: input.isolatedPath,
        agentSessionId: input.agentSessionId,
        taskPrompt: input.taskPrompt,
        status: input.status,
        changedFilesCount: input.changedFilesCount,
        validationPassed: input.validationPassed,
        validationReport: input.validationReport && {
          hadChecks: input.validationReport.hadChecks,
          passed: input.validationReport.passed,
        },
      }
      // Routine diff refreshes advance revision/time even when economic evidence did not change.
      const signature = JSON.stringify([
        workspace.provider,
        workspace.model,
        workspace.isolatedPath,
        workspace.agentSessionId,
        workspace.taskPrompt,
        workspace.status,
        workspace.changedFilesCount,
        workspace.validationPassed,
        workspace.validationReport,
      ])
      const state: State = previous ?? { workspace, signature, generation: 0, attempts: 0, requested: false }
      state.workspace = workspace
      if (state.signature !== signature || (force && !state.requested)) {
        state.signature = signature
        state.generation += 1
        state.attempts = 0
        state.recorded = undefined
        state.requested = state.pending !== undefined
      }
      states.set(key, state)
      return run(state)
    },
    dispose() {
      lifecycle.disposed = true
      states.clear()
    },
  }
}
