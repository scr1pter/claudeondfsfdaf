"use strict"

const http = require("node:http")
const { allowedURL } = require("./local-policy.cjs")

async function startProxy(origins, blocked) {
  const sockets = new Set()
  const server = http.createServer((request, response) => {
    request.on("error", () => request.destroy())
    response.on("error", () => response.destroy())
    if (!allowedURL(request.url, origins)) {
      blocked(request.url, "proxy")
      response.writeHead(403, { "Content-Type": "text/plain", Connection: "close" })
      response.end("Origin is outside the benchmark allowlist.")
      return
    }
    const url = new URL(request.url)
    if (url.protocol !== "http:") {
      response.writeHead(403, { Connection: "close" })
      response.end("This benchmark proxy accepts HTTP loopback targets only.")
      return
    }
    const headers = { ...request.headers, host: url.host }
    delete headers["proxy-authorization"]
    delete headers["proxy-connection"]
    const upstream = http.request(
      {
        hostname: url.hostname === "localhost" ? "127.0.0.1" : url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || 80,
        method: request.method,
        path: url.pathname + url.search,
        headers,
        timeout: 15_000,
      },
      (result) => {
        result.on("error", unavailable)
        if (response.destroyed) {
          result.destroy()
          return
        }
        response.writeHead(result.statusCode, result.headers)
        result.pipe(response)
      },
    )
    function unavailable() {
      if (response.destroyed || response.writableEnded) return
      if (response.headersSent) {
        response.destroy()
        return
      }
      response.writeHead(502, { Connection: "close" })
      response.end("Allowed local target was unavailable.")
    }
    upstream.on("timeout", () => upstream.destroy(new Error("Allowed local target timed out.")))
    upstream.on("error", unavailable)
    request.on("error", () => upstream.destroy())
    response.on("error", () => upstream.destroy())
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy()
    })
    request.on("aborted", () => upstream.destroy())
    request.pipe(upstream)
  })
  server.on("connection", (socket) => {
    sockets.add(socket)
    // Chrome may reset a keep-alive connection while another request is in flight.
    socket.on("error", () => socket.destroy())
    socket.once("close", () => sockets.delete(socket))
  })
  server.on("connect", (request, socket) => {
    blocked("https://" + request.url, "proxy-connect")
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
  })
  server.on("upgrade", (request, socket) => {
    // The browser's routeWebSocket owns protocol handling. Never open a tunnel here.
    blocked(request.url, "proxy-upgrade")
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
  })
  server.requestTimeout = 20_000
  server.headersTimeout = 5000
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return {
    url: "http://127.0.0.1:" + server.address().port,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve)
        for (const socket of sockets) socket.destroy()
      }),
  }
}

module.exports = { startProxy }
