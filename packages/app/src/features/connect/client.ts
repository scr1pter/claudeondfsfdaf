import type { Connect } from "@vectordevai/schema/connect"
import type { VectorClient } from "@vectordevai/sdk/v2/client"

async function decoders() {
  const [{ Schema }, { Connect }] = await Promise.all([import("effect"), import("@vectordevai/schema/connect")])
  return {
    members: Schema.decodeUnknownSync(Schema.Array(Connect.Member)),
    runs: Schema.decodeUnknownSync(Schema.Array(Connect.Run)),
    run: Schema.decodeUnknownSync(Connect.Run),
  }
}

/** Uses the connected engine's authenticated, directory-scoped SDK transport for every operation. */
export function createConnectClient(client: Pick<VectorClient, "connect">) {
  return {
    async list(sessionID?: string, signal?: AbortSignal) {
      const result = await client.connect.list({ sessionID }, { throwOnError: true, signal })
      return (await decoders()).members(result.data)
    },
    async runs(sessionID?: string, signal?: AbortSignal) {
      const result = await client.connect.runs({ sessionID }, { throwOnError: true, signal })
      return (await decoders()).runs(result.data)
    },
    async get(runID: string, sessionID?: string, signal?: AbortSignal) {
      const result = await client.connect.get({ runID, sessionID }, { throwOnError: true, signal })
      return (await decoders()).run(result.data)
    },
    async review(sessionID: string, input: Connect.ReviewInput) {
      const result = await client.connect.review({ sessionID, connectReviewInput: input }, { throwOnError: true })
      return (await decoders()).run(result.data)
    },
    async directoryReview(input: Connect.DirectoryReviewInput, signal?: AbortSignal) {
      const result = await client.connect.directoryReview(
        { connectDirectoryReviewInput: input },
        { throwOnError: true, signal },
      )
      return (await decoders()).run(result.data)
    },
    async register(input: Connect.RegisterInput) {
      const result = await client.connect.register(
        { connectRegisterInput: { ...input, findings: [...input.findings] } },
        { throwOnError: true },
      )
      return (await decoders()).run(result.data)
    },
    async cancel(runID: string, sessionID?: string) {
      const result = await client.connect.cancel({ runID, sessionID }, { throwOnError: true })
      if (typeof result.data !== "boolean") throw new Error("The engine returned an invalid cancellation response.")
      return result.data
    },
    async dismiss(runID: string, input: Connect.DismissInput) {
      const result = await client.connect.dismiss(
        { runID, connectDismissInput: { ...input, findings: [...input.findings] } },
        { throwOnError: true },
      )
      return (await decoders()).run(result.data)
    },
  }
}
