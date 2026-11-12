import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"
import { githubShareConsent, prepareGithubEnvironment } from "./github.environment"
import type { PublicSession } from "@vectordevai/schema/public-session"
import { TASK_MENTIONS, mentionsFrom, routeGithubEvent } from "./github.route"
import { GithubSecrets } from "./github.secrets"

export { extractResponseText, formatPromptTooLargeError, parseGitHubRemote } from "./github.shared"

export const GithubInstallCommand = effectCmd({
  command: "install",
  describe: "install the GitHub agent",
  handler: () =>
    Effect.gen(function* () {
      const { githubInstall } = yield* Effect.promise(() => import("./github.handler"))
      return yield* githubInstall()
    }),
})

export const GithubMintCommand = effectCmd({
  command: "mint",
  describe: "authorize a Codium GitHub Actions run",
  builder: (yargs) => yargs.option("purpose", { choices: ["task", "review"] as const, demandOption: true }),
  instance: false,
  handler: (args) =>
    Effect.gen(function* () {
      const { mintRunToken } = yield* Effect.promise(() => import("./github.cloud"))
      return yield* Effect.promise(() => mintRunToken({ purpose: args.purpose }))
    }),
})

export const GithubBindCommand = effectCmd({
  command: "bind",
  describe: "bind this GitHub Actions repository to Vector",
  instance: false,
  handler: () =>
    Effect.gen(function* () {
      const { bindRepository } = yield* Effect.promise(() => import("./github.cloud"))
      process.exitCode = yield* Effect.promise(() => bindRepository())
    }),
})

export const GithubPublishCommand = effectCmd({
  command: "publish",
  describe: "publish a validated GitHub agent result",
  instance: false,
  handler: () =>
    Effect.gen(function* () {
      const { githubPublish } = yield* Effect.promise(() => import("./github.publish"))
      return yield* githubPublish()
    }),
})

export const GithubSandboxCommand = effectCmd({
  command: "sandbox <action>",
  describe: "isolate a GitHub Actions agent and collect its bundle",
  builder: (yargs) =>
    yargs
      .positional("action", { choices: ["prepare", "run", "finish"] as const, demandOption: true })
      .parserConfiguration({ "populate--": true }),
  instance: false,
  handler: (args) =>
    Effect.gen(function* () {
      const sandbox = yield* Effect.promise(() => import("./github.sandbox"))
      if (args.action === "run") {
        process.exitCode = yield* Effect.promise(() => sandbox.run(args["--"] ?? []))
        return
      }
      return yield* Effect.promise(() => (args.action === "prepare" ? sandbox.prepare() : sandbox.finish()))
    }),
})

// Capture workflow consent before project configuration and plugins are loaded.
const sharing = new WeakMap<object, PublicSession.Consent | undefined>()

export const GithubRunCommand = effectCmd({
  command: "run",
  describe: "run the GitHub agent",
  builder: (yargs) =>
    yargs
      .option("event", {
        type: "string",
        describe: "GitHub mock event to run the agent for",
      })
      .option("token", {
        type: "string",
        describe: "GitHub personal access token (github_pat_********)",
      })
      .option("phase", {
        choices: ["agent"] as const,
        describe: "run the v3 agent job's phase, inside `vector github sandbox run`",
      })
      // A mock event or token never reaches the agent phase: it reads only the Actions event and the secret channel.
      .conflicts("phase", ["event", "token"]),
  instance: (args) => {
    // The agent phase loads no project, configuration or plugin unless the channel's credentials are in memory. A Codium
    // run's engine starts only with the run token the account gate authorized, and index.ts has already set VECTOR_PURE
    // and VECTOR_DISABLE_PROJECT_CONFIG for it, so no repository plugin or configuration loads; Codium never shares
    // (2.13). Own-key consent is read from the holder: the loader has already taken VECTOR_CLI_TOKEN out of the
    // environment.
    if (args.phase === "agent") {
      if (!GithubSecrets.credentials.loaded()) return false
      if (process.env.VECTOR_MODE === "codium") return GithubSecrets.credentials.runToken() !== undefined
      if (process.env.VECTOR_MODE !== "own-key") return false
      sharing.set(
        args,
        githubShareConsent({
          SHARE: process.env.SHARE,
          VECTOR_SHARE_CONSENT: process.env.VECTOR_SHARE_CONSENT,
          VECTOR_CLI_TOKEN: GithubSecrets.credentials.cliToken(),
        }),
      )
      return true
    }
    sharing.set(args, githubShareConsent(process.env))
    const warning = prepareGithubEnvironment(process.env, false)
    if (warning) console.warn(warning)
    return true
  },
  handler: (args) =>
    Effect.gen(function* () {
      if (args.phase === "agent") {
        const { AGENT_NEEDS_CHANNEL, UNKNOWN_MODE, githubAgentPhase } = yield* Effect.promise(
          () => import("./github.agent"),
        )
        // The same checks as the instance rule, which started no instance for these.
        const mode = process.env.VECTOR_MODE
        const refused = !GithubSecrets.credentials.loaded()
          ? AGENT_NEEDS_CHANNEL
          : mode === "codium" && GithubSecrets.credentials.runToken() === undefined
            ? GithubSecrets.CODIUM_UNAUTHORIZED
            : mode !== "codium" && mode !== "own-key"
              ? UNKNOWN_MODE
              : undefined
        if (refused) {
          console.error(refused)
          process.exitCode = 1
          return
        }
        const result = yield* githubAgentPhase({ share: mode === "own-key" ? sharing.get(args) : undefined })
        // Nothing comes back when SIGINT or SIGTERM ended the phase, which then set 130 or 143.
        if (result) process.exitCode = result.exitCode
        return
      }
      const { githubRun, githubEventContext } = yield* Effect.promise(() => import("./github.handler"))
      // Reviews have their own job, so the event is routed before any task work starts.
      const context = githubEventContext(args)
      const route = routeGithubEvent(context, mentionsFrom(process.env["MENTIONS"], TASK_MENTIONS))
      return yield* githubRun({ ...args, context, route, share: sharing.get(args) })
    }),
})

export const GithubReviewCommand = effectCmd({
  command: "review",
  describe: "review a pull request and post the results",
  builder: (yargs) =>
    yargs
      .option("event", {
        type: "string",
        describe: "GitHub event JSON to review instead of the Actions event",
      })
      .option("pr", {
        type: "number",
        describe: "pull request number to review",
      })
      .option("dry-run", {
        type: "boolean",
        describe: "print every write as JSON instead of posting it",
      }),
  // The pull request's own vector.json, `.vector` agents and plugins, AGENTS.md and .vector/RULES.md never configure
  // the reviewer, whatever the workflow file sets: both flags are on before the instance loads any of them.
  instance: () => {
    const warning = prepareGithubEnvironment(process.env, true)
    if (warning) console.warn(warning)
    return true
  },
  handler: (args) =>
    Effect.gen(function* () {
      const { githubReview } = yield* Effect.promise(() => import("./github.review"))
      return yield* githubReview({ event: args.event, pr: args.pr, dryRun: args["dry-run"] })
    }),
})

export const GithubCommand = cmd({
  command: "github",
  describe: "manage GitHub agent",
  builder: (yargs) =>
    yargs
      .command(GithubInstallCommand)
      .command(GithubRunCommand)
      .command(GithubReviewCommand)
      .command(GithubMintCommand)
      .command(GithubBindCommand)
      .command(GithubPublishCommand)
      .command(GithubSandboxCommand)
      .demandCommand(),
  async handler() {},
})
