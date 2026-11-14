import { expect, test } from "bun:test"
import { createVectorClient } from "@vectordevai/sdk/v2"
import { stopConnectedReviews } from "@/cli/cmd/run/connect-stop"

test("an attached run cancels each tracked review with its session and never sends task or shell IDs", async () => {
  const requests: Request[] = []
  const client = createVectorClient({
    baseUrl: "http://fixture.invalid",
    fetch: async (request) => {
      requests.push(request)
      return new URL(request.url).pathname.includes("cr_failed")
        ? new Response("unavailable", { status: 503 })
        : Response.json(false)
    },
  })
  expect(
    await stopConnectedReviews(client, "ses_owner", ["cr_one", "ses_child", "shl_shell", "cr_one", "cr_failed"]),
  ).toEqual(["cr_failed"])
  expect(requests).toHaveLength(2)
  expect(requests.map((request) => new URL(request.url).pathname).toSorted()).toEqual([
    "/experimental/connect/runs/cr_failed/cancel",
    "/experimental/connect/runs/cr_one/cancel",
  ])
  for (const request of requests) {
    expect(request.method).toBe("POST")
    expect(new URL(request.url).searchParams.get("sessionID")).toBe("ses_owner")
  }
})
