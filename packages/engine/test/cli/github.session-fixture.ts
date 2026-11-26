import { Context, Effect, Layer } from "effect"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import { Database } from "@vectordevai/core/database/database"
import { EventV2 } from "@vectordevai/core/event"
import { GithubAgents } from "@vectordevai/core/github-agents"
import { ProjectV2 } from "@vectordevai/core/project"
import { SessionArchive } from "@vectordevai/core/share/archive"
import { InstanceRef } from "../../src/effect/instance-ref"
import { EventV2Bridge } from "../../src/event-v2-bridge"

/** The artifact's download as the runner uploads it: a zip that holds session.vsa. */
export async function artifactZip(bytes: Uint8Array) {
  const writer = new ZipWriter(new Uint8ArrayWriter())
  await writer.add(GithubAgents.SESSION_FILE, new Uint8ArrayReader(Uint8Array.from(bytes)), {
    level: 0,
    useWebWorkers: false,
    useCompressionStream: false,
  })
  return writer.close()
}

/** The real session archive, with project lookup bound to the current test instance. */
export const sessionArchive = Effect.fn("GithubSessionFixture.sessionArchive")(function* () {
  const ctx = yield* InstanceRef
  if (!ctx) return yield* Effect.die(new Error("InstanceRef not provided"))
  const bridge = yield* EventV2Bridge.Service
  const built = yield* Layer.build(
    SessionArchive.node.implementation as Layer.Layer<
      SessionArchive.Service,
      never,
      Database.Service | EventV2.Service | ProjectV2.Service
    >,
  ).pipe(
    Effect.provideService(EventV2.Service, bridge),
    Effect.provideService(
      ProjectV2.Service,
      ProjectV2.Service.of({
        directories: () => Effect.die(new Error("The archive's import resolves only the project.")),
        resolve: (directory) => Effect.succeed({ id: ctx.project.id, directory }),
        commit: () => Effect.die(new Error("The archive's import resolves only the project.")),
      }),
    ),
  )
  return Context.get(built, SessionArchive.Service)
})
