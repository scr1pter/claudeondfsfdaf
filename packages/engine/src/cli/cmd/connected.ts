import { Effect } from "effect"
import { createVectorClient } from "@vectordevai/sdk/v2"
import type { Connect } from "@vectordevai/schema/connect"
import { Flag } from "@vectordevai/core/flag/flag"
import { ServerAuth } from "@/server/auth"
import { CliOwnerGate } from "../owner-gate"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { sanitizeTerminalText } from "@vectordevai/tui/util/presentation"
import { errorMessage } from "@vectordevai/tui/util/error"

export const CONNECTED_ACTIONS = ["list", "runs", "review", "cancel"] as const

type Arguments = {
  action: string
  runID?: string
  session?: string
  uncommitted?: boolean
  staged?: boolean
  base?: string
}

export function reviewTarget(args: Arguments): Connect.Target {
  const choices = Number(!!args.uncommitted) + Number(!!args.staged) + Number(args.base !== undefined)
  if (choices > 1) throw new Error("Choose one of --uncommitted, --staged or --base.")
  if (args.base !== undefined) {
    if (!args.base || args.base.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(args.base))
      throw new Error("--base needs a valid git ref.")
    return { kind: "branch", base: args.base }
  }
  return { kind: args.staged ? "staged" : "uncommitted" }
}

export async function executeConnectedCommand(client: ReturnType<typeof createVectorClient>, args: Arguments) {
  if (!(CONNECTED_ACTIONS as readonly string[]).includes(args.action))
    throw new Error("Unknown connected-tools action.")
  if (args.action === "review" || args.action === "cancel")
    await Effect.runPromise(
      CliOwnerGate.refuse(
        args.action === "review" ? "start connected reviews from the shell" : "cancel connected reviews from the shell",
      ),
    )
  if (args.action !== "review" && (args.uncommitted || args.staged || args.base !== undefined))
    throw new Error("Review targets are only used with review.")
  if (args.action !== "cancel" && args.runID) throw new Error("A run ID is only used with cancel.")
  if (args.action === "list")
    return (await client.connect.list({ ...(args.session ? { sessionID: args.session } : {}) })).data
  if (args.action === "runs")
    return (await client.connect.runs({ ...(args.session ? { sessionID: args.session } : {}) })).data
  if (args.action === "cancel") {
    if (!args.runID) throw new Error("cancel requires a run ID.")
    return (await client.connect.cancel({ runID: args.runID, ...(args.session ? { sessionID: args.session } : {}) }))
      .data
  }
  if (!args.session) throw new Error("review requires --session so the result reaches your conversation.")
  return (
    await client.connect.review({
      sessionID: args.session,
      connectReviewInput: { target: reviewTarget(args), background: true },
    })
  ).data
}

export const ConnectedCommand = cmd({
  command: "connected <action> [runID]",
  describe: "list connected tools, inspect review runs, start a review or cancel it on a running server",
  builder: (yargs) =>
    yargs
      .positional("action", { type: "string", choices: CONNECTED_ACTIONS, demandOption: true })
      .positional("runID", { type: "string", describe: "review run to cancel" })
      .option("attach", { type: "string", demandOption: true, describe: "URL of the server" })
      .option("session", { type: "string", describe: "conversation ID" })
      .option("dir", { type: "string", describe: "directory on the server" })
      .option("uncommitted", { type: "boolean", default: false })
      .option("staged", { type: "boolean", default: false })
      .option("base", { type: "string", describe: "branch review base" })
      .option("json", { type: "boolean", default: false })
      .option("username", { type: "string" })
      .option("password", { type: "string", describe: "prefer VECTOR_SERVER_PASSWORD" }),
  handler: async (args) => {
    ServerAuth.assertSecurePasswordTransport(args.attach, args.password ?? Flag.VECTOR_SERVER_PASSWORD)
    const client = createVectorClient({
      baseUrl: args.attach,
      directory: args.dir,
      headers: ServerAuth.headers({ username: args.username, password: args.password }),
      throwOnError: true,
    })
    const result = await executeConnectedCommand(client, args).catch((error: unknown) => {
      UI.error(sanitizeTerminalText(errorMessage(error)))
      process.exitCode = 1
      return undefined
    })
    if (result === undefined) return
    console.log(args.json ? JSON.stringify(result, null, 2) : formatConnectedResult(result))
  },
})

export function formatConnectedResult(result: unknown): string {
  if (typeof result === "boolean") return result ? "Review cancelled." : "That review is no longer running."
  if (!Array.isArray(result)) return sanitizeTerminalText(JSON.stringify(result, null, 2))
  return (
    result
      .map(
        (item: {
          title?: string
          state?: string
          reason?: string
          place?: string
          sendsTo?: string
          id?: string
          status?: string
          result?: { summary?: string }
        }) =>
          sanitizeTerminalText(
            item.title
              ? `${item.title}: ${item.state}${item.reason ? ` — ${item.reason}` : ""}; runs ${item.place}${item.sendsTo ? `; sends to ${item.sendsTo}` : ""}`
              : `${item.id}: ${item.status}${item.result?.summary ? ` — ${item.result.summary}` : ""}`,
          ),
      )
      .join("\n") || "No connected runs."
  )
}
