"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const http = require("node:http")
const { startProxy } = require("./proxy.cjs")

async function fixture() {
  let received = 0
  let authorization
  const server = http.createServer((request, response) => {
    received++
    authorization = request.headers["proxy-authorization"]
    response.writeHead(202, { "Content-Type": "text/plain" })
    response.end("owned fixture")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    origin: "http://127.0.0.1:" + server.address().port,
    received: () => received,
    authorization: () => authorization,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}

function request(proxy, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(proxy)
    http
      .get({ hostname: endpoint.hostname, port: endpoint.port, path: url, headers }, (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => {
          body += chunk
        })
        response.on("end", () => resolve({ status: response.statusCode, body }))
      })
      .on("error", reject)
  })
}

test("transport forwards only an allowed local origin and strips proxy credentials", async () => {
  const app = await fixture()
  const proxy = await startProxy(new Set([app.origin]), () => {})
  try {
    assert.deepEqual(await request(proxy.url, app.origin + "/api", { "proxy-authorization": "local-proxy-fixture" }), {
      status: 202,
      body: "owned fixture",
    })
    assert.equal(app.received(), 1)
    assert.equal(app.authorization(), undefined)
  } finally {
    await proxy.close()
    await app.close()
  }
})

test("transport never connects to a different loopback origin", async () => {
  const denied = await fixture()
  const blocked = []
  const proxy = await startProxy(new Set(["http://127.0.0.1:1"]), (url, kind) => blocked.push(kind))
  try {
    assert.equal((await request(proxy.url, denied.origin + "/secret")).status, 403)
    assert.equal(denied.received(), 0)
    assert.deepEqual(blocked, ["proxy"])
  } finally {
    await proxy.close()
    await denied.close()
  }
})
