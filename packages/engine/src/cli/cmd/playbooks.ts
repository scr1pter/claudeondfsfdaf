import { Effect } from "effect"
import { Global } from "@vectordevai/core/global"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { PlaybookInstall } from "@vectordevai/core/playbooks/install"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { VectorAccount } from "@vectordevai/core/vector-account"
import { Playbooks } from "@vectordevai/schema/playbooks"
import { Auth } from "@/auth"
import { CliOwnerGate } from "../owner-gate"
import { CliError, effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

export const PlaybooksCommand = effectCmd({
  command: "playbooks [name]",
  describe: "list Vector Playbooks or install one in your personal workflows",
  instance: false,
  builder: (yargs) => yargs
    .positional("name", { type: "string", describe: "the exact playbook name to install" })
    .option("replace", { type: "boolean", default: false, describe: "replace an installed playbook" }),
  handler: Effect.fn("Cli.playbooks")(function* (args) {
    if (args.name) yield* CliOwnerGate.refuse("install Vector Playbooks")
    const auth = yield* Auth.Service
    const stored = yield* auth.get("vector").pipe(Effect.orElseSucceed(() => undefined))
    const token = yield* Effect.promise(() => VectorAccount.resolveVectorToken({
      environment: process.env.VECTOR_CLI_TOKEN,
      stored: async () => stored?.type === "api" ? stored.key : undefined,
    }).catch(() => undefined))
    if (!token) return yield* fail("Sign in to Vector to see your Playbooks.")
    const listing = yield* Effect.tryPromise({
      try: async () => {
        const response = await Egress.fetch("plans-catalog", `${ModelPlanStatus.SITE}/api/account/playbooks`, {
          headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error("Vector Playbooks are unavailable for this account right now.")
        const links = Playbooks.decodeLinks(await response.json())
        if (!links) throw new Error("The playbook listing is invalid.")
        return links
      }, catch: (error) => new CliError({ message: error instanceof Error ? error.message : "Cannot read Playbooks." }),
    })
    if (!args.name) {
      for (const link of listing) UI.println(`${link.name} ${link.version}`)
      if (!listing.length) UI.println("No Playbooks are listed right now.")
      return
    }
    const link = listing.find((item) => item.name === args.name)
    if (!link) return yield* fail("Choose an exact playbook name from vector playbooks.")
    yield* CliOwnerGate.refuse("install Vector Playbooks")
    const installed = yield* Effect.tryPromise({
      try: () => PlaybookInstall.install({
        link, directory: Global.Path.config, replace: args.replace,
        request: (url, init) => Egress.fetch("plans-catalog", String(url), init),
      }), catch: (error) => new CliError({ message: error instanceof Error ? error.message : "Cannot install Playbook." }),
    })
    UI.println(`Installed ${installed.name} ${installed.version}. Start it with /workflow ${installed.name}.`)
  }),
})
