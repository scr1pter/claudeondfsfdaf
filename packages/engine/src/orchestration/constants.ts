/** Engine-only context keys; none is accepted in a workflow spec or tool argument. */
export const RUN = "vector.workflow.run"
export const AGENT = "vector.workflow.agent"
export const USER_START = "vector.workflow.user-start"
export const WORKFLOW_AGENT = "workflow"
export const PARTS_PER_MESSAGE = 50
export const PROGRESS_INTERVAL = 1000
export const HEARTBEAT_INTERVAL = 30_000
export const MAX_NODES = 32_000
export const MAX_READY = 64
export const MAX_BUFFERED_ITEMS = 32_000
export const GUARD_PARENT = "vector.workflow.guard-parent"
export const TASK_OFFERED = "vector.workflow.task-offered"
export const OWNER_START = "vector.workflow.owner-start"
export const SPEC = "vector.workflow.spec"

export type Run = {
  readonly title: string
  readonly revision: number
  readonly callerAgent: string
  readonly permissionKey: string
  readonly quiet?: boolean
}

export type Agent = {
  readonly runID: string
  readonly stage: string
  readonly phase: string
  readonly item: string
  /** This execution's content key; crash recovery matches a pending launch to its child by it. */
  readonly key: string
  /**
   * The runner's stable node key. Retries, repairs and later verifier rounds change the execution key, so resuming a
   * workflow agent's own session is authorized by this node identity and the verifier role instead.
   */
  readonly node?: string
  readonly round?: number
  readonly verifier?: boolean
}

export * as WorkflowMarkers from "./constants"
