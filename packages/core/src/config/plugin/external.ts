export * as ConfigExternalPlugin from "./external"

import type { Plugin as EffectPlugin } from "@vectordevai/plugin/v2/effect"
import type { Plugin as PromisePlugin } from "@vectordevai/plugin/v2/promise"
import { Effect, Schema } from "effect"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"
import { Config } from "../../config"
import { FSUtil } from "../../fs-util"
import { Location } from "../../location"
import { Npm } from "../../npm"
import { define } from "../../plugin/internal"
import { LocalPluginSdk } from "../../plugin/local-sdk"
import {
  activateOAuthApproval,
  borrowedOAuthPlugin,
  blockedPluginEntry,
  inspectOAuthPluginForLoad,
  confirmOAuthPluginLoad,
  warning,
} from "../../plugin/oauth-approval"
import { oauthPluginContext } from "../../plugin/oauth"
import { PluginPromise } from "../../plugin/promise"
import { ProcessIsolation } from "../../process-isolation"

const PluginModule = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({
      id: Schema.String,
      effect: Schema.declare<EffectPlugin["effect"]>(
        (input): input is EffectPlugin["effect"] => typeof input === "function",
      ),
    }),
    Schema.Struct({
      id: Schema.String,
      setup: Schema.declare<PromisePlugin["setup"]>(
        (input): input is PromisePlugin["setup"] => typeof input === "function",
      ),
    }),
  ]),
})

type Host = Parameters<EffectPlugin["effect"]>[0]

function externalCallback<Event>(callback: (event: Event) => Effect.Effect<void> | void) {
  ProcessIsolation.assertExternalCodeAllowed()
  return ProcessIsolation.markExternalCode((event: Event) =>
    Effect.suspend(() => {
      ProcessIsolation.assertExternalCodeAllowed()
      const result = callback(event)
      return Effect.isEffect(result) ? result : Effect.void
    }).pipe(Effect.tap(() => Effect.sync(() => ProcessIsolation.assertExternalCodeAllowed()))),
  )
}

/** Only the actual external-module loader hands out this restrictive host; compiled builtins keep their host. */
function externalHost(host: Host): Host {
  return {
    ...host,
    agent: { ...host.agent, transform: (callback) => host.agent.transform(externalCallback(callback)) },
    aisdk: {
      sdk: (callback) => host.aisdk.sdk(externalCallback(callback)),
      language: (callback) => host.aisdk.language(externalCallback(callback)),
    },
    catalog: { ...host.catalog, transform: (callback) => host.catalog.transform(externalCallback(callback)) },
    command: { ...host.command, transform: (callback) => host.command.transform(externalCallback(callback)) },
    integration: {
      ...host.integration,
      transform: (callback) => host.integration.transform(externalCallback(callback)),
    },
    reference: { ...host.reference, transform: (callback) => host.reference.transform(externalCallback(callback)) },
    skill: { ...host.skill, transform: (callback) => host.skill.transform(externalCallback(callback)) },
    plugin: {
      ...host.plugin,
      add: (input) => {
        ProcessIsolation.assertExternalCodeAllowed()
        return host.plugin.add({
          ...input,
          effect: ProcessIsolation.markExternalCode((child) =>
            Effect.suspend(() => {
              ProcessIsolation.assertExternalCodeAllowed()
              return input.effect(externalHost(child))
            }),
          ),
        })
      },
    },
  }
}

/** The actual V2 module boundary also protects direct/cached callers, before compatibility work or top-level code. */
export async function loadExternalEntry(entrypoint: string, local: boolean) {
  ProcessIsolation.assertExternalCodeAllowed()
  const inspected = inspectOAuthPluginForLoad(entrypoint)
  const target = local ? await LocalPluginSdk.prepare(entrypoint) : entrypoint
  ProcessIsolation.assertExternalCodeAllowed()
  const mod = await import(target)
  ProcessIsolation.assertExternalCodeAllowed()
  return {
    mod,
    approvals: confirmOAuthPluginLoad(inspected),
    run: (host: Host) =>
      Effect.suspend(() => {
        ProcessIsolation.assertExternalCodeAllowed()
        const value = Schema.decodeUnknownSync(PluginModule)(mod).default
        const plugin = "effect" in value ? value : PluginPromise.fromPromise(value)
        return plugin.effect(externalHost(host))
      }),
  }
}

export const Plugin = define({
  id: "config-plugin",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const npm = yield* Npm.Service
    yield* Effect.gen(function* () {
      const configured: { package: string; options?: Record<string, any>; project: boolean }[] = []

      for (const entry of yield* config.entries()) {
        if (config.executable?.(entry) === false) continue
        if (entry.type === "document") {
          const directory = entry.path ? path.dirname(entry.path) : location.directory
          for (const item of entry.info.plugins ?? []) {
            const ref = typeof item === "string" ? { package: item } : item
            const packageName = (() => {
              if (ref.package.startsWith("file://")) return fileURLToPath(ref.package)
              if (ref.package.startsWith("./") || ref.package.startsWith("../")) {
                return path.resolve(directory, ref.package)
              }
              return ref.package
            })()
            configured.push({
              package: config.executablePath?.(entry, packageName) ?? packageName,
              options: ref.options,
              project: config.scope?.(entry) === "project",
            })
          }
        }

        if (entry.type === "directory") {
          const files = yield* fs
            .glob("{plugin,plugins}/*.{ts,js}", {
              cwd: entry.path,
              absolute: true,
              include: "file",
              dot: true,
              symlink: true,
            })
            .pipe(Effect.orElseSucceed(() => []))
          files.sort()
          for (const file of files)
            configured.push({ package: config.executablePath?.(entry, file) ?? file, project: false })
        }
      }

      for (const ref of configured) {
        yield* Effect.gen(function* () {
          ProcessIsolation.assertExternalCodeAllowed()
          if (borrowedOAuthPlugin(ref.package)) return
          // The user's own config may follow a range or the latest release; a project must name an exact version.
          if (ref.project && !path.isAbsolute(ref.package) && !pinned(ref.package)) {
            yield* Effect.logWarning(`Skipped mutable plugin package ${ref.package}; use an exact version`)
            return
          }
          const entrypoint = path.isAbsolute(ref.package)
            ? pathToFileURL(ref.package).href
            : (yield* npm.addAs("npm-plugins", ref.package)).entrypoint
          if (!entrypoint || blockedPluginEntry(entrypoint)) return

          const loaded = yield* Effect.promise(() => loadExternalEntry(entrypoint, path.isAbsolute(ref.package)))
          ProcessIsolation.assertExternalCodeAllowed()
          const value = (yield* Schema.decodeUnknownEffect(PluginModule)(loaded.mod)).default
          ProcessIsolation.assertExternalCodeAllowed()
          yield* ctx.plugin.add({
            id: value.id,
            effect: (host) =>
              Effect.gen(function* () {
                ProcessIsolation.assertExternalCodeAllowed()
                for (const approval of loaded.approvals) {
                  const release = activateOAuthApproval(approval)
                  yield* Effect.addFinalizer(() => Effect.sync(release))
                  yield* Effect.logWarning(
                    `Approved OAuth plugin ${approval.plugin}@${approval.version} for ${approval.declaration.provider}. ${warning}`,
                  )
                }
                yield* loaded.run({ ...oauthPluginContext(host, loaded.approvals), options: ref.options ?? {} })
              }),
          })
        }).pipe(Effect.ignoreCause)
      }
    }).pipe(Effect.forkScoped({ startImmediately: true }))
  }),
})

function pinned(spec: string) {
  const match = spec.match(/^(?:@[^/]+\/[^@]+|[^@/][^@]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/)
  return match !== null
}
