export * as PlaybookClient from "./playbooks"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "@vectordevai/core/global"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { PlaybookInstall } from "@vectordevai/core/playbooks/install"
import { Egress } from "@vectordevai/core/local-mode/egress"
import { VectorAccount } from "@vectordevai/core/vector-account"
import { Playbooks } from "@vectordevai/schema/playbooks"
import { Auth } from "@/auth"
import { SessionMemory } from "@/session/memory"

export type Entry = { name: string; version: string; sha256: string; installed: boolean; current: boolean }
export type Install = { name: string; version: string; sha256: string; replace?: boolean }
export class Refused extends Schema.TaggedErrorClass<Refused>()("PlaybookClient.Refused", { message: Schema.String }) {}
export interface Interface {
  readonly list: () => Effect.Effect<Entry[], Refused>
  readonly install: (input: Install) => Effect.Effect<{ name: string; version: string }, Refused>
}
export class Service extends Context.Service<Service, Interface>()("@vector/PlaybookClient") {}

export function make(input: { auth: Pick<Auth.Interface, "get">; directory?: string; request?: PlaybookInstall.Request; environment?: () => string | undefined }): Interface {
  const request: PlaybookInstall.Request = input.request ?? ((url, init) => Egress.fetch("plans-catalog", url, init))
  const directory = input.directory ?? Global.Path.config
  const links = Effect.fn("PlaybookClient.links")(function* () {
    const stored = yield* input.auth.get("vector").pipe(Effect.orElseSucceed(() => undefined))
    return yield* Effect.tryPromise({ try: async () => {
      const token = await VectorAccount.resolveVectorToken({ environment: input.environment ? input.environment() : process.env.VECTOR_CLI_TOKEN,
        stored: async () => stored?.type === "api" ? stored.key : undefined })
      if (!token) throw new Error("Sign in to Vector to see your Playbooks.")
      const response = await request(`${ModelPlanStatus.SITE}/api/account/playbooks`, {
        headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error("Vector Playbooks are unavailable for this account right now.")
      const value = Playbooks.decodeLinks(await response.json())
      if (!value) throw new Error("The Playbooks listing is invalid.")
      return value
    }, catch: (error) => new Refused({ message: error instanceof Error ? error.message : "Cannot read Vector Playbooks." }) })
  })
  return {
    list: Effect.fn("PlaybookClient.list")(function* () {
      const catalog = yield* links()
      return yield* Effect.tryPromise({ try: () => Promise.all(catalog.map(async (entry): Promise<Entry> => {
        const target = path.join(directory, "workflows", `${entry.name}.json`)
        const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        const bytes = stat?.isFile() && !stat.isSymbolicLink() && stat.size <= Playbooks.MAX_BYTES ? await fs.readFile(target) : undefined
        return { name: entry.name, version: entry.version, sha256: entry.sha256, installed: Boolean(stat),
          current: Boolean(bytes && createHash("sha256").update(bytes).digest("hex") === entry.sha256) }
      })), catch: () => new Refused({ message: "Cannot read installed personal Playbooks." }) })
    }),
    install: Effect.fn("PlaybookClient.install")(function* (selection) {
      if (SessionMemory.agentStarted()) return yield* new Refused({ message: "Install Playbooks yourself in Settings → Agents → Workflows." })
      if (!Playbooks.validName(selection.name) || !Playbooks.validVersion(selection.version) || !Playbooks.validSha256(selection.sha256))
        return yield* new Refused({ message: "Choose a Playbook from the current listing." })
      // A fresh authenticated link prevents an old browser selection from silently installing a different release.
      const link = (yield* links()).find((entry) => entry.name === selection.name && entry.version === selection.version && entry.sha256 === selection.sha256)
      if (!link) return yield* new Refused({ message: "This Playbook changed. Refresh the listing and select its new version." })
      yield* Effect.tryPromise({ try: () => PlaybookInstall.install({ link, directory, request, replace: selection.replace }),
        catch: (error) => new Refused({ message: error instanceof Error ? error.message : "Cannot install this Playbook." }) })
      return { name: link.name, version: link.version }
    }),
  }
}

const layer = Layer.effect(Service, Effect.gen(function* () { return make({ auth: yield* Auth.Service }) }))
export const node = LayerNode.make({ service: Service, layer, deps: [Auth.node] })
