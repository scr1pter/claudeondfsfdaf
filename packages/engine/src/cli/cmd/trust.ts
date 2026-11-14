import { Flag } from "@vectordevai/core/flag/flag"
import type { WorkspaceTrust } from "@vectordevai/core/workspace-trust/workspace-trust"
import { Effect } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { CliOwnerGate } from "../owner-gate"
import { UI } from "../ui"

type TrustAction = "status" | "approve" | "prompts"

const pureApprovalError = "Cannot approve workspace trust while --pure is active. Rerun without --pure."

export function trustDecision(action: TrustAction, pure: boolean) {
  if (action === "status") return { approve: false } as const
  if (pure) return { approve: false, error: pureApprovalError } as const
  return { approve: true } as const
}

export function formatTrustStatus(status: WorkspaceTrust.Status, approved: boolean, pure: boolean) {
  return [
    `Workspace: ${status.workspace}`,
    `Fingerprint: ${status.fingerprint}`,
    `Status: ${status.trusted ? "trusted" : "untrusted"}`,
    ...(pure ? ["Executable repository config: disabled by --pure"] : []),
    ...(approved
      ? ["Trust approved. Rerun the command or restart Vector to load trusted executable repository config."]
      : []),
  ].join("\n")
}

/** What `vector trust prompts` prints: the prompt files outside the repository Vector holds, or that none are. */
export function formatPromptTrust(held: readonly string[]) {
  if (held.length === 0) return "No prompt files outside this repository are waiting for your approval."
  return [
    `${held.length === 1 ? "This prompt file" : "These prompt files"} outside this repository changed since you last approved ${held.length === 1 ? "it" : "them"}, so Vector does not load ${held.length === 1 ? "it" : "them"}:`,
    ...held.map((file) => `  ${file}`),
    "Check the changes, then run `vector trust prompts approve` in a terminal outside Vector.",
  ].join("\n")
}

export const TrustCommand = effectCmd({
  command: "trust <action> [step]",
  describe: "inspect or approve trust for the current workspace, or for prompt files outside it",
  builder: (yargs) =>
    yargs
      .positional("action", {
        describe: "trust operation",
        choices: ["status", "approve", "prompts"] as const,
        demandOption: true,
      })
      .positional("step", {
        describe: "with prompts: approve the held prompt files",
        choices: ["approve"] as const,
      }),
  handler: Effect.fn("Cli.trust")(function* (args: { action: TrustAction; step?: "approve" }) {
    if (args.action === "prompts") return yield* prompts(args.step === "approve")
    if (args.step) return yield* fail("Only `vector trust prompts approve` takes a second word.")
    // An agent that could approve trust from its shell would load the repository settings it just wrote.
    if (args.action === "approve") yield* CliOwnerGate.refuse("approve workspace trust")
    const decision = trustDecision(args.action, Flag.VECTOR_PURE)
    if ("error" in decision && decision.error) return yield* fail(decision.error)

    const { Config } = yield* Effect.promise(() => import("@/config/config"))
    const config = yield* Config.Service
    if (decision.approve) yield* config.approve()

    UI.println(formatTrustStatus(yield* config.trust(), decision.approve, Flag.VECTOR_PURE))
  }),
})

// Lists the prompt files outside the repository Vector holds, or approves them as they are now (section 8.3).
const prompts = Effect.fn("Cli.trust.prompts")(function* (approve: boolean) {
  // An agent that could approve its own prompt files would load whatever it wrote into them.
  if (approve) yield* CliOwnerGate.refuse("approve prompt files")
  const { Config } = yield* Effect.promise(() => import("@/config/config"))
  const { PromptTrust } = yield* Effect.promise(() => import("@/config/prompt-trust"))
  const config = yield* Config.Service
  const sources = yield* PromptTrust.current(config)
  const shown = yield* PromptTrust.status(sources)
  if (!approve) return UI.println(formatPromptTrust(shown.map((file) => file.path)))
  // What is approved is exactly the list printed here, unchanged: a file that changes in between is not.
  const result = yield* PromptTrust.approve({ config, sources, shown })
  if (result.refused)
    return yield* fail(
      "The held prompt files changed while Vector was approving them, so it approved nothing. Run `vector trust prompts` to see them again.",
    )
  UI.println(formatApproved(result.approved))
})

/** What `vector trust prompts approve` prints: each file it approved, or that none were waiting. */
export function formatApproved(approved: readonly string[]) {
  if (approved.length === 0)
    return "No prompt files were waiting. Vector recorded the prompt files outside this repository as they are now."
  return [
    `Approved ${approved.length} prompt ${approved.length === 1 ? "file" : "files"}. Vector loads ${approved.length === 1 ? "it" : "them"} from its next start:`,
    ...approved.map((file) => `  ${file}`),
  ].join("\n")
}
