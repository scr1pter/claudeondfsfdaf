"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const http = require("node:http")
const net = require("node:net")
const { startProxy } = require("./proxy.cjs")

async function fixture(handler) {
  let received = 0
  let authorization
  const server = http.createServer((request, response) => {
    received++
    authorization = request.headers["proxy-authorization"]
    request.on("error", () => {})
    response.on("error", () => {})
    if (handler && handler(request, response)) return
    response.writeHead(202, { "Content-Type": "text/plain" })
    response.end("owned fixture")
  })
  server.on("connection", (socket) => socket.on("error", () => socket.destroy()))
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
        response.on("error", reject)
      })
      .on("error", reject)
  })
}

function signal() {
  let resolve
  const promise = new Promise((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

async function bounded(promise) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned reset control timed out.")), 3000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
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

test("a real client TCP reset during upload closes only that upstream request", async () => {
  const started = signal()
  const aborted = signal()
  const app = await fixture((request) => {
    if (request.url !== "/upload") return false
    request.once("aborted", aborted.resolve)
    started.resolve()
    return true
  })
  const proxy = await startProxy(new Set([app.origin]), () => {})
  const endpoint = new URL(proxy.url)
  const client = http.request({
    hostname: endpoint.hostname,
    port: endpoint.port,
    path: app.origin + "/upload",
    method: "POST",
    headers: { "Content-Length": 128_000 },
  })
  client.on("error", () => {})
  try {
    client.write("partial upload")
    await bounded(started.promise)
    client.socket.resetAndDestroy()
    await bounded(aborted.promise)
    assert.deepEqual(await request(proxy.url, app.origin + "/next"), { status: 202, body: "owned fixture" })
  } finally {
    client.destroy()
    await proxy.close()
    await app.close()
  }
})

test("a real client TCP reset during a response cancels only that upstream response", async () => {
  const canceled = signal()
  const app = await fixture((request, response) => {
    if (request.url !== "/stream") return false
    response.once("close", canceled.resolve)
    response.writeHead(200, { "Content-Type": "text/plain" })
    response.write("partial response")
    return true
  })
  const proxy = await startProxy(new Set([app.origin]), () => {})
  const endpoint = new URL(proxy.url)
  const reset = signal()
  const client = http.get(
    { hostname: endpoint.hostname, port: endpoint.port, path: app.origin + "/stream" },
    (response) => {
      response.on("error", () => {})
      response.once("data", () => {
        response.socket.resetAndDestroy()
        reset.resolve()
      })
    },
  )
  client.on("error", () => {})
  try {
    await bounded(reset.promise)
    await bounded(canceled.promise)
    assert.deepEqual(await request(proxy.url, app.origin + "/next"), { status: 202, body: "owned fixture" })
  } finally {
    client.destroy()
    await proxy.close()
    await app.close()
  }
})

test("real upstream TCP resets before and after headers do not crash the proxy", async () => {
  const reset = signal()
  const app = await fixture((request, response) => {
    if (request.url === "/before") {
      request.socket.resetAndDestroy()
      return true
    }
    if (request.url !== "/after") return false
    response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": 128_000 })
    response.write("partial response")
    reset.promise.then(() => response.socket.resetAndDestroy())
    return true
  })
  const proxy = await startProxy(new Set([app.origin]), () => {})
  try {
    assert.equal((await request(proxy.url, app.origin + "/before")).status, 502)
    const endpoint = new URL(proxy.url)
    const failed = new Promise((resolve, reject) => {
      http
        .get({ hostname: endpoint.hostname, port: endpoint.port, path: app.origin + "/after" }, (response) => {
          response.once("data", reset.resolve)
          response.once("error", (error) => resolve(error.code))
          response.once("end", () => reject(new Error("Truncated response unexpectedly completed.")))
        })
        .on("error", reject)
    })
    assert.equal(await bounded(failed), "ECONNRESET")
    assert.deepEqual(await request(proxy.url, app.origin + "/next"), { status: 202, body: "owned fixture" })
  } finally {
    await proxy.close()
    await app.close()
  }
})

test("real TCP resets of refused CONNECT and upgrade sockets leave the proxy available", async () => {
  const app = await fixture()
  const proxy = await startProxy(new Set([app.origin]), () => {})
  const endpoint = new URL(proxy.url)
  try {
    for (const headers of [
      "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n",
      "GET " +
        app.origin +
        "/socket HTTP/1.1\r\nHost: " +
        new URL(app.origin).host +
        "\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    ]) {
      await bounded(
        new Promise((resolve, reject) => {
          const client = net.connect({ host: endpoint.hostname, port: endpoint.port })
          client.once("connect", () => client.write(headers))
          client.once("data", (data) => {
            assert.match(data.toString(), /^HTTP\/1\.1 403/)
            client.resetAndDestroy()
          })
          client.once("close", resolve)
          client.on("error", reject)
        }),
      )
      assert.equal((await request(proxy.url, app.origin + "/next")).status, 202)
    }
  } finally {
    await proxy.close()
    await app.close()
  }
})
