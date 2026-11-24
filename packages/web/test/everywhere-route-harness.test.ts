import { expect, test } from "bun:test"
import { RouteHarness } from "./lib/everywhere-account"
import { installFetchGuard } from "./lib/everywhere-fetch-guard"

installFetchGuard()

test("the route harness closes after an asynchronous refusal leaves a POST body unread", async () => {
  const harness = new RouteHarness()
  harness.mount({
    "/read": async (request, response) => {
      await Bun.sleep(1)
      const chunks: Uint8Array[] = []
      for await (const chunk of request) chunks.push(chunk)
      response.end(Buffer.concat(chunks))
    },
    "/refuse": async (_request, response) => {
      await Bun.sleep(1)
      response.statusCode = 401
      response.end("Refused")
    },
  })
  await harness.start()
  const input = { body: "synthetic body" }
  const accepted = await harness.call("POST", "/read", input)
  expect(accepted.body).toEqual(input.body)
  const refused = await harness.call("POST", "/refuse", input)
  expect(refused).toMatchObject({ status: 401, text: "Refused" })

  const closed = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => closed.resolve(false), 2_000)
  try {
    void harness.stop().then(() => closed.resolve(true))
    expect(await closed.promise).toBe(true)
  } finally {
    clearTimeout(timer)
  }
})
