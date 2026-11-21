// Settings → General's "Code review after each task" row. It shows only when the engine can review after a task
// (the codeReviewAfterTask capability) and VectorScope local reviews are on in the owner's global config, the same
// condition the Local reviews panel uses. The composer sends the setting only while the same holds, so a row that is
// hidden never sends anything.

export const CODE_REVIEW_TITLE = "Code review after each task"
export const CODE_REVIEW_DESCRIPTION =
  "When a task you send here changes files, VectorScope, Vector's code review agent, reviews all uncommitted changes in the repository once Vector is done. With LLM-as-a-judge on, it waits until the judge's last round. It reports findings and changes no files. Vector reads them with your next message, and they stay under Pull requests, Local reviews. Each review costs extra model calls on your VectorScope model. On a priced model it stops at $2 or at what is left of the run's spend limit, whichever is lower, and at $0.50 when the run has no limit. Off by default."

/** Whether Settings offers the row, and the composer sends the setting: the engine supports it and VectorScope is on. */
export function codeReviewOffered(input: { capability?: boolean; vectorscope?: boolean; disabled?: boolean }) {
  return input.capability === true && input.vectorscope === true && input.disabled !== true
}
