import type { VectorClient } from "@vectordevai/sdk/v2"
import { isConnectID } from "./background-wait"

/** Attached servers outlive the CLI. Cancel each owned review through its own endpoint, never task.stop. */
export async function stopConnectedReviews(client: VectorClient, sessionID: string, ids: Iterable<string>) {
  const reviews = [...new Set(ids)].filter(isConnectID)
  const stopped = await Promise.allSettled(
    reviews.map((runID) =>
      client.connect
        .cancel({ runID, sessionID }, { signal: AbortSignal.timeout(5_000), throwOnError: true })
        .then((result) => {
          if (typeof result.data !== "boolean") throw new Error("The server did not confirm review cancellation.")
        }),
    ),
  )
  return reviews.filter((_id, index) => stopped[index]?.status === "rejected")
}
