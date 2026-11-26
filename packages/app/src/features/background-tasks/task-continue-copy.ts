// The note above a task's message box, under its card in the Background tasks pane. Hard-coded English, as the rest of
// the pane's task copy.

/** A task still running takes the message at its next safe step. */
export const TASK_DELIVERED_COPY = "Delivered at the next safe step. Your conversation stays open."

/**
 * A finished task that takes no more messages: a desktop workspace, a workflow run, or one without a task id. Its own
 * session refuses prompts ("Subagent sessions cannot be prompted."), so the note sends people to their conversation,
 * which can continue the work, and never to that session.
 */
export const TASK_FINISHED_COPY =
  "This task has finished and takes no more messages. Ask in your conversation to continue its work; your draft is kept."

/** The note for a task that cannot be continued from the pane: delivered while it runs, else the finished copy. */
export function taskMessageNote(editable: boolean) {
  return editable ? TASK_DELIVERED_COPY : TASK_FINISHED_COPY
}
