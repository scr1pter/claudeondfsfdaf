import { Effect } from "effect"
import { CliOwnerGate } from "./owner-gate"

export type CommandOptions = {
  readonly _: readonly (string | number)[]
  readonly action?: unknown
  readonly workflow?: unknown
  readonly local?: unknown
  readonly attach?: unknown
  readonly help?: unknown
  readonly version?: unknown
}

/** Keep owner-only actions ahead of local policy setup and any account transport. */
export async function commandGate(input: {
  options: CommandOptions
  vector: boolean
  accountRequired: boolean
  local: (attach?: string) => Promise<unknown>
  account: () => Promise<unknown>
}) {
  const opts = input.options
  const command = String(opts._[0] ?? "")
  const active = !opts.help && !opts.version
  if (active && command === "vault" && ["backup", "restore", "forget"].includes(String(opts._[1] ?? "")))
    await Effect.runPromise(CliOwnerGate.refuse("change Brain Vault backups or restore memory"))
  if (
    active &&
    ((command === "workflow" && opts.action === "resume") || (command === "run" && opts.workflow !== undefined))
  )
    await Effect.runPromise(CliOwnerGate.refuse(command === "run" ? "start workflows" : "resume workflows"))
  if (command === "run" && opts.workflow !== undefined && typeof opts.workflow !== "string")
    throw new Error("--workflow requires exactly one workflow name or file")
  if (opts.local === true && command === "run")
    await input.local(typeof opts.attach === "string" ? opts.attach : undefined)
  const offline = command === "workflow" && opts.action === "validate" && opts.attach === undefined
  if (active && input.vector && input.accountRequired && !offline) await input.account()
}
