import { Effect } from "effect"
import { pathToFileURL } from "url"
import { define } from "../internal"
import { Npm } from "../../npm"
import { ProcessIsolation } from "../../process-isolation"

export const DynamicProviderPlugin = define({
  id: "dynamic-provider",
  effect: Effect.fn(function* (ctx) {
    const npm = yield* Npm.Service
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.sdk) {
          ProcessIsolation.assertExternalValueAllowed(evt.sdk)
          return
        }
        ProcessIsolation.assertExternalCodeAllowed()

        const installedPath = evt.package.startsWith("file://")
          ? evt.package
          : (yield* npm.addAs("npm-plugins", evt.package).pipe(Effect.orDie)).entrypoint
        if (!installedPath) throw new Error(`Package ${evt.package} has no import entrypoint`)

        const mod = yield* Effect.promise(async () => {
          ProcessIsolation.assertExternalCodeAllowed()
          return (await import(
            installedPath.startsWith("file://") ? installedPath : pathToFileURL(installedPath).href
          )) as Record<string, (options: any) => any>
        }).pipe(Effect.orDie)
        const match = Object.keys(mod).find((name) => name.startsWith("create"))
        if (!match) throw new Error(`Package ${evt.package} has no provider factory export`)

        ProcessIsolation.assertExternalCodeAllowed()
        evt.sdk = ProcessIsolation.markExternalCode(mod[match](evt.options))
      }),
    )
  }),
})
