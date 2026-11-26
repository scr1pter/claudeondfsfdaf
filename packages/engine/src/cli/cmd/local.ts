import type { Argv } from "yargs"
import { EOL } from "os"
import { confirm, select } from "@clack/prompts"
import { Effect } from "effect"
import { Flag } from "@vectordevai/core/flag/flag"
import type { LocalMode } from "@vectordevai/schema/local-mode"
import type { LocalSettings } from "@/config/local-settings"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

// `vector local`: Vector Local in a terminal, the same settings as the Local API (PATCH /local) changes. What makes it
// stricter applies at once. What would loosen it (off, a looser Web access, a new model server, an allowed service)
// asks first, at this terminal, and never applies in a Vector the agent or Vector's own terminal started. The account
// gate leaves `vector local` reachable (index.ts), so a computer with no internet can still set it up.

const WEB = ["ask", "network", "none"] as const
const WEB_NAMES: Record<LocalMode.Web, string> = { ask: "Ask", network: "Your network only", none: "None" }
const NEEDS_TERMINAL =
  "This change would loosen Vector Local, so it needs your answer at a terminal. Run it yourself in a terminal, or use /local in the terminal UI."
// What a confirmation in this process does for a Vector that runs on its own: `vector local confirm` writes the copy
// of the block the owner let apply that the terminal's Vector reads when it starts, never the desktop app's.
const ELSEWHERE =
  "A Vector that is already running keeps holding it until it next starts, or until you confirm it with /local in its terminal UI. The desktop app keeps a record of its own, so it still holds the change."
/**
 * Which Vector these settings are for. A terminal's Vector and the desktop app read different config folders and keep
 * separate confirmed copies (Config.localConfirmedFile), so `vector local on` never turns it on in the app; only the
 * company's policy and VECTOR_LOCAL reach both.
 */
export const SURFACE =
  "This is Vector Local for Vector in a terminal. The desktop app keeps its own setting, in its Settings → Vector Local. Your company's policy applies to both."

/**
 * The SURFACE line for this process, or none in a Vector the desktop app started (VECTOR_CLIENT=desktop: its built-in
 * terminal and its agents' commands). Those inherit the app's config folders, so they show the app's own setting.
 */
export function surface(client = Flag.VECTOR_CLIENT) {
  return client === "desktop" ? undefined : SURFACE
}

export const LocalCommand = cmd({
  command: "local",
  describe: "Vector Local: run Vector's AI features on model servers you or your company host",
  builder: (yargs: Argv) =>
    yargs
      .command(LocalStatusCommand)
      .command(LocalOnCommand)
      .command(LocalOffCommand)
      .command(LocalWebCommand)
      .command(LocalDetectCommand)
      .command(LocalSetupCommand)
      .command(LocalCheckCommand)
      .command(LocalLogCommand)
      .command(LocalAllowCommand)
      .command(LocalConfirmCommand)
      .demandCommand(),
  async handler() {},
})

// Runs `attempt` without confirmation, and once more with it when the owner says yes at this terminal: the step a
// change that would loosen Vector Local takes. Anything refused fails with its reason.
const asked = Effect.fn("Cli.local.asked")(function* <A, R>(
  attempt: (confirmed: boolean) => Effect.Effect<A | Exclude<LocalSettings.Outcome, { type: "applied" }>, never, R>,
) {
  const { LocalSettings } = yield* Effect.promise(() => import("@/config/local-settings"))
  const first = yield* attempt(false)
  const done = (result: typeof first) =>
    isOutcome(result) && result.type === "refused"
      ? fail(result.changes?.length ? `${result.message} It ${result.changes.join(", ")}.` : result.message)
      : isOutcome(result) && result.type === "confirm"
        ? fail(`${NEEDS_TERMINAL} It ${result.changes.join(", ")}.`)
        : Effect.succeed(result as A)
  if (!isOutcome(first) || first.type !== "confirm") return yield* done(first)
  if (!process.stdin.isTTY || !process.stdout.isTTY) return yield* done(first)
  const answer = yield* Effect.promise(() =>
    confirm({ message: `${LocalSettings.CONFIRM} It ${first.changes.join(", ")}.`, initialValue: false }),
  )
  if (answer !== true) return yield* fail("Nothing changed.")
  return yield* done(yield* attempt(true))
})

function isOutcome(value: unknown): value is Exclude<LocalSettings.Outcome, { type: "applied" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "confirm" || value.type === "refused")
  )
}

// Applies a change, asking first at this terminal when it would loosen Vector Local.
const change = Effect.fn("Cli.local.change")(function* (update: Omit<LocalSettings.Update, "by" | "confirm">) {
  const { LocalSettings } = yield* Effect.promise(() => import("@/config/local-settings"))
  return yield* asked((confirmed) =>
    LocalSettings.apply({ ...update, by: "cli", confirm: confirmed }).pipe(
      Effect.map((outcome) => (outcome.type === "applied" ? outcome.status : outcome)),
    ),
  )
})

export const LocalStatusCommand = effectCmd({
  command: "status",
  describe: "show Vector Local: on or off, Web access, model servers and allowed services",
  instance: false,
  builder: (yargs) => yargs.option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.local.status")(function* (args) {
    const { LocalSettings } = yield* Effect.promise(() => import("@/config/local-settings"))
    const status = LocalSettings.status()
    if (args.json) return void process.stdout.write(`${JSON.stringify(status, null, 2)}${EOL}`)
    describe(status)
  }),
})

export const LocalOnCommand = effectCmd({
  command: "on",
  describe: "turn Vector Local on",
  instance: false,
  builder: (yargs) =>
    yargs.option("web", { describe: "Web access: ask, network (your network only) or none", choices: WEB }),
  handler: Effect.fn("Cli.local.on")(function* (args) {
    const status = yield* change({ enabled: true, ...(args.web ? { web: args.web } : {}) })
    describe(status)
    if (status.policy.endpoints.length === 0)
      UI.println("No model servers are on your list yet, so model calls have nowhere to go. Run vector local setup.")
  }),
})

export const LocalOffCommand = effectCmd({
  command: "off",
  describe: "turn Vector Local off (asks first)",
  instance: false,
  handler: Effect.fn("Cli.local.off")(function* () {
    describe(yield* change({ enabled: false }))
  }),
})

export const LocalWebCommand = effectCmd({
  command: "web <setting>",
  describe: "set what web pages and searches may reach with Vector Local on (a looser setting asks first)",
  instance: false,
  builder: (yargs) =>
    yargs.positional("setting", {
      describe: "ask: the sites you approve; network: your network only; none: no internet requests",
      choices: WEB,
      demandOption: true,
    }),
  handler: Effect.fn("Cli.local.web")(function* (args) {
    describe(yield* change({ web: args.setting }))
  }),
})

export const LocalDetectCommand = effectCmd({
  command: "detect",
  describe: "find the model servers running on this computer (never your network)",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("port", { describe: "also ask this port on this computer", type: "number", array: true })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.local.detect")(function* (args) {
    const { LocalDetect } = yield* Effect.promise(() => import("@vectordevai/core/local-mode/detect"))
    const ports = [...new Set([...LocalDetect.PORTS, ...(args.port ?? [])])]
    const servers = yield* Effect.promise(() => LocalDetect.detect({ ports }))
    if (args.json) return void process.stdout.write(`${JSON.stringify(servers, null, 2)}${EOL}`)
    if (servers.length === 0)
      return UI.println(
        "No model server answered on this computer. Start Ollama, LM Studio, vLLM, llama.cpp or SGLang, or add a server elsewhere with vector local setup <address>.",
      )
    servers.forEach((server) => UI.println(serverLine(server)))
  }),
})

export const LocalSetupCommand = effectCmd({
  command: "setup [address]",
  describe: "add a model server: find one on this computer, or read the one at an address",
  builder: (yargs) =>
    yargs
      .positional("address", { describe: "the server's address, such as http://10.0.0.5:8000", type: "string" })
      .option("provider", { describe: "the provider name to add it as, such as ollama", type: "string" }),
  handler: Effect.fn("Cli.local.setup")(function* (args) {
    const { LocalSettings } = yield* Effect.promise(() => import("@/config/local-settings"))
    const { LocalDetect } = yield* Effect.promise(() => import("@vectordevai/core/local-mode/detect"))
    const { LocalProbe } = yield* Effect.promise(() => import("@vectordevai/core/local-mode/probe"))
    const servers = args.address
      ? yield* Effect.promise(() => LocalSettings.probe({ url: args.address! })).pipe(
          Effect.flatMap((read) =>
            read.server ? Effect.succeed([read.server]) : fail(read.message ?? "Nothing answered."),
          ),
        )
      : yield* Effect.promise(() => LocalDetect.detect())
    if (servers.length === 0) return yield* noServer()
    const server = yield* choose(servers)
    // A server on the list that answers differently now may be another one in its place, on a shared computer too.
    const changed = LocalSettings.identity(server)
    if (changed.length > 0)
      UI.println(
        `${UI.Style.TEXT_WARNING}${LocalProbe.changedMessage(server.origin)} Changed since it was added: ${changed.join(", ")}.${UI.Style.TEXT_NORMAL}`,
      )
    // With Vector Local on, putting the server on the list asks first, as does a new identity for one on it, and
    // nothing is written if the answer is no.
    const added = yield* asked((confirmed) =>
      LocalSettings.addServer({ server, provider: args.provider, by: "cli", confirm: confirmed }),
    )
    UI.println(
      `Added ${serverLine(server)} as ${added.provider}, with ${added.models.length} model${added.models.length === 1 ? "" : "s"}.`,
    )
    if (server.class !== "this-computer" && !server.encrypted) UI.println(LocalSettings.NOT_ENCRYPTED)
    if (server.forwards) UI.println(LocalSettings.FORWARDS)
    if (server.class === "this-computer") UI.println(LocalProbe.SHARED_MACHINE)
    UI.println(`Check a model with vector local check --model ${added.provider}/<model>.`)
  }),
})

export const LocalCheckCommand = effectCmd({
  command: "check",
  describe: "check every layer of Vector Local; exits 0 when all pass, 1 when one fails, 2 when Vector Local is off",
  builder: (yargs) =>
    yargs
      .option("model", { describe: "also run this model with the role's tools, as provider/model", type: "string" })
      .option("role", {
        describe: "the role --model is checked for (review: Vectorscope)",
        choices: ["agent", "subagent", "review", "judge", "research"] as const,
      })
      .option("yes", {
        describe: "load the model even if it may not fit in free memory",
        type: "boolean",
        default: false,
      })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.local.check")(function* (args) {
    const { LocalSettings } = yield* Effect.promise(() => import("@/config/local-settings"))
    const models = yield* LocalSettings.modelsRow().pipe(Effect.orElseSucceed(() => undefined))
    const report = yield* Effect.promise(() => LocalSettings.check({ models }))
    const checked = args.model
      ? yield* LocalSettings.checkModel({ model: args.model, role: args.role, confirmed: args.yes })
      : undefined
    if (checked?.type === "refused") return yield* fail(checked.message)
    const model = checked?.checked
    const code = LocalSettings.exitCode(report)
    process.exitCode = code === 0 && model && model.result !== "works" ? 1 : code
    if (args.json)
      return void process.stdout.write(`${JSON.stringify({ ...report, ...(model ? { model } : {}) }, null, 2)}${EOL}`)
    report.rows.forEach((row) => {
      UI.println(`${MARKS[row.status]} ${row.title}`)
      if (row.detail) UI.println(`  ${UI.Style.TEXT_DIM}${row.detail}${UI.Style.TEXT_NORMAL}`)
    })
    if (model)
      UI.println(
        `${model.result === "works" ? MARKS.pass : model.result === "ask" ? MARKS.warn : MARKS.fail} ${model.model}: ${model.result}${model.message ? `. ${model.message}` : ""}`,
      )
  }),
})

export const LocalLogCommand = effectCmd({
  command: "log",
  describe: "show what Vector sent or blocked while Vector Local was on (origins only)",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("blocked", { describe: "only blocked requests", type: "boolean", default: false })
      .option("since", { describe: "only since then: 30m, 2h, 7d or a date", type: "string" })
      .option("session", { describe: "only this session, with its subagents and helpers", type: "string" })
      .option("json", { describe: "print JSON", type: "boolean", default: false }),
  handler: Effect.fn("Cli.local.log")(function* (args) {
    const { Egress } = yield* Effect.promise(() => import("@vectordevai/core/local-mode/egress"))
    const since = args.since === undefined ? undefined : sinceOf(args.since, Date.now())
    if (since === null) return yield* fail(`--since takes a span such as 30m, 2h or 7d, or a date, not ${args.since}.`)
    const events = yield* Effect.promise(() =>
      Egress.exported({
        ...(since === undefined ? {} : { since }),
        ...(args.session ? { session: args.session } : {}),
        ...(args.blocked ? { blocked: true } : {}),
      }),
    )
    if (args.json) return void process.stdout.write(`${JSON.stringify(events, null, 2)}${EOL}`)
    if (events.length === 0) return UI.println("Nothing in the network log matches.")
    events.forEach((event) => UI.println(eventLine(event)))
  }),
})

export const LocalAllowCommand = effectCmd({
  command: "allow <source>",
  describe: "allow a service with Vector Local on, with the reason (asks first), or take one back with --remove",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("source", {
        describe: "the service, as vector local status --json lists it",
        type: "string",
        demandOption: true,
      })
      .option("reason", { describe: "why you allow it; shown beside it", type: "string" })
      .option("host", {
        describe: "only these hosts (without --host it covers every host the service reaches)",
        type: "string",
        array: true,
      })
      .option("remove", { describe: "take the allowance back", type: "boolean", default: false }),
  handler: Effect.fn("Cli.local.allow")(function* (args) {
    if (args.remove) return describe(yield* change({ allow: { remove: [args.source] } }))
    if (!args.reason?.trim()) return yield* fail(`Say why you allow ${args.source} with --reason.`)
    describe(
      yield* change({
        allow: {
          add: [{ source: args.source, reason: args.reason, ...(args.host?.length ? { hosts: args.host } : {}) }],
        },
      }),
    )
  }),
})

export const LocalConfirmCommand = effectCmd({
  command: "confirm",
  describe: "apply a change to your config that would loosen Vector Local and waits for you (asks first)",
  instance: false,
  handler: Effect.fn("Cli.local.confirm")(function* () {
    const { LocalSettings } = yield* Effect.promise(() => import("@/config/local-settings"))
    const held = LocalSettings.status().held
    if (!held) return UI.println("No change to Vector Local is waiting for you.")
    if (LocalSettings.agentMarked()) return yield* fail(LocalSettings.AGENT)
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      return yield* fail(`${NEEDS_TERMINAL} It ${held.changes.join(", ")}.`)
    const answer = yield* Effect.promise(() =>
      confirm({ message: `${LocalSettings.CONFIRM} It ${held.changes.join(", ")}.`, initialValue: false }),
    )
    if (answer !== true) return yield* fail("Nothing changed.")
    const outcome = yield* LocalSettings.apply({ held: [...held.changes], confirm: true, by: "cli" })
    if (outcome.type !== "applied") return yield* fail(outcome.type === "refused" ? outcome.message : NEEDS_TERMINAL)
    describe(outcome.status)
    UI.println(`${UI.Style.TEXT_DIM}${ELSEWHERE}${UI.Style.TEXT_NORMAL}`)
  }),
})

const MARKS = {
  pass: `${UI.Style.TEXT_SUCCESS}✓${UI.Style.TEXT_NORMAL}`,
  warn: `${UI.Style.TEXT_WARNING}!${UI.Style.TEXT_NORMAL}`,
  fail: `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`,
} as const

// The status, as a person reads it.
function describe(status: {
  readonly policy: LocalMode.Policy
  readonly held?: { readonly changes: readonly string[] }
  readonly log: { readonly directory: string; readonly retain_days: number }
}) {
  const policy = status.policy
  if (!policy.enabled) {
    UI.println("Vector Local is off. Turn it on with vector local on.")
    UI.println(
      `${UI.Style.TEXT_DIM}Run Vector's AI features on model servers you or your company host.${UI.Style.TEXT_NORMAL}`,
    )
  }
  if (policy.enabled)
    UI.println(`Vector Local is on${policy.lock ? ". Set by your company. Ask your administrator to change it." : "."}`)
  UI.println(`Web access: ${WEB_NAMES[policy.web]}`)
  UI.println(
    `Model servers: ${
      policy.endpoints.length === 0
        ? "none yet (vector local setup adds one)"
        : policy.endpoints
            .map(
              (item) =>
                `${item.origin}${item.from === "managed" ? " (listed by your company)" : ""}${policy.pins?.[item.origin] ? "" : " (no identity pin)"}`,
            )
            .join(", ")
    }`,
  )
  if (policy.allow.length > 0)
    UI.println(`Allowed services: ${policy.allow.map((item) => `${item.source} (${item.reason})`).join(", ")}`)
  if (status.held)
    UI.println(
      `${UI.Style.TEXT_WARNING}A change to your config would loosen Vector Local: it ${status.held.changes.join(", ")}. It waits for you: run vector local confirm. A Vector that is already running applies that when it next starts, except the desktop app, which keeps a record of its own.${UI.Style.TEXT_NORMAL}`,
    )
  policy.warnings.forEach((warning) => UI.println(`${UI.Style.TEXT_WARNING}${warning}${UI.Style.TEXT_NORMAL}`))
  UI.println(
    `${UI.Style.TEXT_DIM}Network log: kept for ${status.log.retain_days} days in ${status.log.directory} while Vector Local is on.${UI.Style.TEXT_NORMAL}`,
  )
  const note = surface()
  if (note) UI.println(`${UI.Style.TEXT_DIM}${note}${UI.Style.TEXT_NORMAL}`)
}

function serverLine(server: {
  readonly name: string
  readonly version?: string
  readonly origin: string
  readonly class: string
  readonly models: readonly { readonly cloud?: boolean }[]
}) {
  const place = { "this-computer": "this computer", "your-network": "your network", internet: "the internet" }[
    server.class
  ]
  const models = server.models.filter((model) => !model.cloud).length
  return `${[server.name, server.version].filter(Boolean).join(" ")} at ${server.origin} (${place ?? server.class}, ${models} model${models === 1 ? "" : "s"})`
}

function eventLine(event: LocalMode.Event) {
  const time = new Date(event.time).toISOString().replace("T", " ").slice(0, 19)
  const mark = event.decision === "allow" ? "sent   " : event.decision === "ask" ? "asked  " : "blocked"
  const session = event.root_session_id ? `  ${event.root_session_id}` : ""
  return `${time}  ${mark}  ${event.source.padEnd(22)} ${event.origin}  ${UI.Style.TEXT_DIM}${event.rule}${session}${UI.Style.TEXT_NORMAL}`
}

/**
 * When `--since` starts, in milliseconds: a span back from `now` (30m, 2h, 7d) or a date. Null for anything else.
 */
export function sinceOf(input: string, now: number) {
  const span = /^(\d+)\s*(m|h|d)$/i.exec(input.trim())
  if (span) return now - Number(span[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[span[2]!.toLowerCase() as "m"]
  const date = Date.parse(input)
  return Number.isNaN(date) ? null : date
}

// Which server to add: the only one found, or the one picked at this terminal.
const choose = Effect.fn("Cli.local.choose")(function* <S extends { readonly origin: string; readonly name: string }>(
  servers: readonly S[],
) {
  if (servers.length === 1) return servers[0]!
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return yield* fail(
      `Several servers answered: ${servers.map((server) => server.origin).join(", ")}. Name one: vector local setup <address>.`,
    )
  const picked = yield* Effect.promise(() =>
    select({
      message: "Which server should Vector add?",
      options: servers.map((server) => ({ value: server.origin, label: `${server.name} at ${server.origin}` })),
    }),
  )
  const server = servers.find((item) => item.origin === picked)
  if (!server) return yield* fail("Nothing changed.")
  return server
})

// Nothing answered on this computer: what it has room for, and what to install.
const noServer = Effect.fn("Cli.local.noServer")(function* () {
  const { LocalHardware } = yield* Effect.promise(() => import("@vectordevai/core/local-mode/hardware"))
  const { LocalSettings } = yield* Effect.promise(() => import("@/config/local-settings"))
  const hardware = yield* Effect.promise(() => LocalHardware.read())
  // The company's table when its policy sets one Vector can use, else the bundled examples.
  const suggested = LocalSettings.recommendation(hardware.usable)
  UI.println("No model server answered on this computer.")
  UI.println(LocalHardware.describe(hardware))
  const agent = suggested.roles.agent
  if (agent)
    UI.println(
      `For the agent: ${agent.name} (${agent.quantization}, about ${agent.memory_gb} GB). ${agent.links[0] ?? ""}`,
    )
  UI.println(`${UI.Style.TEXT_DIM}${suggested.label}${UI.Style.TEXT_NORMAL}`)
  UI.println("Start a server, then run vector local setup again, or name one elsewhere: vector local setup <address>.")
})
