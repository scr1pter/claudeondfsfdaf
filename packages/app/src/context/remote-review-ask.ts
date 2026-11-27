/** The review a permission ask came from, so the desktop can tell whether a phone started it. No UI imports: the desktop preload types read this file. */
export type RemoteReviewAsk = { runID: string; sessionID: string; directory: string }
