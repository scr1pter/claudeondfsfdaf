import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { Effect, Schema } from "effect"
import { SessionID } from "@vectordevai/schema/session-id"
import { ReviewRun } from "@vectordevai/schema/review-run"
import { BackgroundJobStore } from "../../src/background-job-store"
import { Database } from "../../src/database/database"
import { ReviewRequestStore } from "../../src/review/request-store"

const [filename, parent, json, run] = process.argv.slice(2)
if (!filename || !parent || !json || !run) throw new Error("Missing foreign review deletion probe input")
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]()
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const request = Schema.decodeUnknownSync(ReviewRun.Start)(JSON.parse(json))
    const parentID = SessionID.make(parent)
    const runID = SessionID.make(run)
    const ownerNonce = randomUUID()
    const owner = BackgroundJobStore.open()
    yield* Effect.addFinalizer(() => Effect.sync(() => BackgroundJobStore.close(owner)))
    const store = ReviewRequestStore.make((yield* Database.Service).db)
    const identity = { parentID, requestID: request.requestID, ownerNonce, runID }
    if (!(yield* store.reserve({ parentID, request, ownerNonce, owner })).claimed || !(yield* store.attach(identity)))
      throw new Error("Foreign process did not prepare its real reservation")
    process.stdout.write("READY\n")
    const settle = yield* Effect.promise(() => lines.next())
    if (settle.value !== "settle") throw new Error("Foreign probe expected settlement")
    yield* store.finish(identity)
    process.stdout.write("SETTLED\n")
    const late = yield* Effect.promise(() => lines.next())
    if (late.value !== "late") throw new Error("Foreign probe expected the late launch check")
    return { lateAdmitted: yield* store.begin(identity) }
  }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
)
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`)
