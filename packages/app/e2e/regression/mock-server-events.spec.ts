import { expect, test } from "@playwright/test"
import { createServer } from "node:http"
import { mockVectorServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"

for (const sameOrigin of [false, true]) {
  test(`API mocks leave documents and modules on the local server (${sameOrigin ? "same-origin" : "separate"} backend)`, async ({
    page,
  }) => {
    const served: string[] = []
    const mocked: string[] = []
    const server = createServer((request, response) => {
      served.push(request.url ?? "")
      if (request.url === "/") {
        response.setHeader("content-type", "text/html")
        response.end('<!doctype html><p id="state"></p><script type="module" src="/entry.js"></script>')
        return
      }
      if (request.url === "/entry.js" || request.url === "/module.js") {
        response.setHeader("content-type", "text/javascript")
        response.end(
          request.url === "/entry.js"
            ? 'import { marker } from "/module.js"; document.querySelector("#state").textContent = marker'
            : 'export const marker = "assets reached the local server"',
        )
        return
      }
      response.end("unhandled local response")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Fixture server did not bind a TCP port")
      const baseURL = `http://127.0.0.1:${address.port}`
      await mockVectorServer(page, {
        baseURL,
        serverPort: sameOrigin ? String(address.port) : undefined,
        onRequest: (url) => mocked.push(url.pathname),
        directory: "/vector/assets",
        provider: { fixture: true },
        project: {},
        sessions: [{ id: "known" }],
        pageMessages: () => ({ items: [] }),
      })
      await page.goto(baseURL)
      await expect(page.locator("#state")).toHaveText("assets reached the local server")
      expect(served).toEqual(expect.arrayContaining(["/", "/entry.js", "/module.js"]))
      expect(mocked).toEqual([])
      const responses = await page.evaluate(
        async ({ backendPort, sameOrigin }) => ({
          provider: await (await fetch("/provider?directory=test")).json(),
          messages: await (await fetch("/session/known/message?limit=1")).json(),
          events: await (await fetch("/global/event")).text(),
          unknownBackend: await fetch(`http://127.0.0.1:${backendPort}/unknown-backend-api`).then((response) =>
            sameOrigin ? response.text() : response.json(),
          ),
          unknownLocal: await (await fetch("/unknown-local-path")).text(),
        }),
        { backendPort: sameOrigin ? String(address.port) : (process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"), sameOrigin },
      )
      expect(responses).toEqual({
        provider: { fixture: true },
        messages: [],
        events: ": ok\n\n",
        unknownBackend: sameOrigin ? "unhandled local response" : {},
        unknownLocal: "unhandled local response",
      })
      expect(mocked).toEqual([
        "/provider",
        "/session/known/message",
        "/global/event",
        ...(sameOrigin ? [] : ["/unknown-backend-api"]),
      ])
      expect(served).not.toContain("/provider?directory=test")
      expect(served).toContain("/unknown-local-path")
    } finally {
      await page.close()
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })
}

test("keeps global event envelopes separate from directory presence payloads", async ({ page }) => {
  const directory = "/vector/sse-isolation"
  const globalEvent = { directory, payload: { type: "session.deleted", properties: { id: "session-fixture" } } }
  const presenceEvent = { type: "client.joined", properties: { clientID: "peer", username: "Teammate", at: 1 } }
  const globalEvents = [globalEvent]
  const directoryEvents = [presenceEvent]
  await page.route("**/sse-fixture", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }))
  await mockVectorServer(page, {
    directory,
    provider: {},
    project: {},
    sessions: [],
    pageMessages: () => ({ items: [] }),
    events: () => globalEvents.splice(0, 1),
    directoryEvents: () => directoryEvents.splice(0, 1),
  })
  await page.goto("/sse-fixture")

  const presence = await page.evaluate(async () => (await fetch("/event")).text())
  expect(presence).toBe(`data: ${JSON.stringify(presenceEvent)}\n\n`)
  expect(globalEvents).toEqual([globalEvent])
  expect(directoryEvents).toEqual([])
  const global = await page.evaluate(async () => (await fetch("/global/event")).text())
  expect(global).toBe(`data: ${JSON.stringify(globalEvent)}\n\n`)
  expect(globalEvents).toEqual([])

  globalEvents.push(globalEvent)
  expect(await page.evaluate(async () => (await fetch("/event")).text())).toBe(": ok\n\n")
  expect(globalEvents).toEqual([globalEvent])
  directoryEvents.push(presenceEvent)
  const concurrent = await page.evaluate(() =>
    Promise.all(["/global/event", "/event"].map(async (path) => (await fetch(path)).text())),
  )
  expect(concurrent).toEqual([`data: ${JSON.stringify(globalEvent)}\n\n`, `data: ${JSON.stringify(presenceEvent)}\n\n`])
  expect(globalEvents).toEqual([])
  expect(directoryEvents).toEqual([])
})

test("the event-stream transport passes every other request on with its body", async ({ page }) => {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  const posted: unknown[] = []
  await page.route("**/sse-transport-fixture", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  )
  await page.route(/\/session\/ses_transport\/prompt_async(?:\?|$)/, (route) => {
    posted.push(route.request().postDataJSON())
    return route.fulfill({ status: 204, body: "" })
  })
  const transport = await installSseTransport<unknown>(page, { server, path: "/global/event" })
  await page.goto("/sse-transport-fixture")

  // The SDK hands fetch a Request that carries the body, as every composer send and permission reply does.
  const body = { parts: [{ type: "text", text: "hello" }] }
  const status = await page.evaluate(
    async (input) => {
      const response = await fetch(
        new Request(`${input.server}/session/ses_transport/prompt_async`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input.body),
        }),
      )
      return response.status
    },
    { server, body },
  )
  expect(status).toBe(204)
  expect(posted).toEqual([body])
  expect(await transport.connections()).toEqual([])

  // A Request for the event stream still opens a transport stream, with its headers.
  await page.evaluate((server) => {
    void fetch(new Request(`${server}/global/event`, { headers: { "x-fixture": "stream" } }))
  }, server)
  const connection = await transport.waitForConnection()
  expect(connection.path).toBe("/global/event")
  expect(connection.headers["x-fixture"]).toBe("stream")
})
