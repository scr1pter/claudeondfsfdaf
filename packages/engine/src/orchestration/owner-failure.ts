/** A rejected owner handoff must not consume a human prompt already waiting on the shared session runner. */
export class WorkflowOwnerHandoffFailure extends Error {
  constructor(readonly original: unknown) {
    super("The owner workflow handoff failed", { cause: original })
  }
}
