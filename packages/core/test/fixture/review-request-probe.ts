// A real second engine process using the same SQLite reservation implementation.
// The parent waits until both connections are ready before releasing admission.
import { randomUUID } from "node:crypto"
import { Effect, Schema } from "effect"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { SessionID } from "@vectordevai/schema/session-id"
import { Database } from "../../src/database/database"
import { ReviewRequestStore } from "../../src/review/request-store"
import { BackgroundJobStore } from "../../src/background-job-store"

const [filename, parent, json] = process.argv.slice(2)
if (!filename || !parent || !json) throw new Error("Missing review request probe input")
const request = Schema.decodeUnknownSync(ReviewRun.Start)(JSON.parse(json))
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const store = ReviewRequestStore.make((yield* Database.Service).db)
    process.stdout.write("READY\n")
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          process.stdin.once("end", resolve)
          process.stdin.resume()
        }),
    )
    const owner = BackgroundJobStore.open()
    yield* Effect.addFinalizer(() => Effect.sync(() => BackgroundJobStore.close(owner)))
    return yield* store.reserve({ parentID: SessionID.make(parent), request, ownerNonce: randomUUID(), owner })
  }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
)
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`)
