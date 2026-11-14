/*
 * The reader of Codex's run records (contract §4.18: "run records for Remote's run list", with a `verdict` for Ship
 * Desk). Codex's `listCloudRuns(account, {limit})` (api/_lib/cloud-agents-runs.ts on vector-at-mention) is this shape;
 * the integration commit (A59) registers it, as this build never imports Codex's files. Remote's run list (A40) and
 * Ship Desk's verdicts and run checks (A49) read the same registration. Until A59 nothing is registered, and both say
 * so instead of guessing.
 */

export type CloudRunReader = (account: string, input: { limit: number }) => Promise<readonly unknown[]>
let cloudRuns: CloudRunReader | undefined

export function registerCloudRunReader(reader: CloudRunReader) {
  if (typeof reader !== "function" || cloudRuns) throw new Error("Remote's GitHub run list has exactly one reader.")
  cloudRuns = reader
}

export function cloudRunReader() {
  return cloudRuns
}
