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
    // The agent phase loads no project, configuration or plugin unless the channel's credentials are in memory, and a
    // Codium run (refused until V18c) loads none at all. Consent is read from the holder: the loader has already taken
    // VECTOR_CLI_TOKEN out of the environment. Codium never shares (2.13).
    if (args.phase === "agent") {
      if (!GithubSecrets.credentials.loaded() || process.env.VECTOR_MODE !== "own-key") return false
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
        const { AGENT_NEEDS_CHANNEL, githubAgentPhase, refuseCodiumAgent } = yield* Effect.promise(
          () => import("./github.agent"),
        )
        if (!GithubSecrets.credentials.loaded()) {
          console.error(AGENT_NEEDS_CHANNEL)
          process.exitCode = 1
          return
        }
        const result =
          process.env.VECTOR_MODE === "own-key"
            ? yield* githubAgentPhase({ share: sharing.get(args) })
            : yield* Effect.promise(() => refuseCodiumAgent())
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
      .command(GithubSandboxCommand)
      .demandCommand(),
  async handler() {},
})
