import { randomUUID } from "node:crypto"
import { createServer, type Server, type ServerResponse } from "node:http"

import { runBrowserAgent } from "./browser-agent"
import { parseBrowserAgentInput, parseResearchBrowserInput } from "./browser-bridge-input"
import { runResearchBrowser } from "./research-browser"

// The engine's way to the desktop's browsers. POST /command drives the visible agent browser (the browser tool); POST
// /research drives the research browsers (research_browser), with its own validator and its own map of browsers, so a
// command on one path has no way to name a browser of the other.
const MAX_BODY_BYTES = 256 * 1024
// A research command carries the run's addresses when the desktop's copy starts.
const MAX_RESEARCH_BYTES = 1024 * 1024

let bridgeServer: Server | undefined
let bridgeUrl = ""
let bridgeToken = ""

/**
 * Aborted once the response closes before it was sent: the engine's call ended (its fetch is aborted when the user
 * stops the turn), so nobody waits for this command any more. A response that was sent is no such end.
 */
export function callerGone(response: Pick<ServerResponse, "once" | "writableFinished">) {
  const gone = new AbortController()
  response.once("close", () => {
    if (!response.writableFinished) gone.abort()
  })
  return gone.signal
}

export async function startBrowserBridge() {
  if (bridgeServer) return { url: bridgeUrl, token: bridgeToken }

  bridgeToken = randomUUID()
  bridgeServer = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8")
    const gone = callerGone(response)
    const research = request.url === "/research"
    if (request.method !== "POST" || (request.url !== "/command" && !research)) {
      response.statusCode = 404
      response.end(JSON.stringify({ error: "Not found" }))
      return
    }
    if (request.headers.authorization !== `Bearer ${bridgeToken}`) {
      response.statusCode = 401
      response.end(JSON.stringify({ error: "Unauthorized" }))
      return
    }

    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > (research ? MAX_RESEARCH_BYTES : MAX_BODY_BYTES)) {
        response.statusCode = 413
        response.end(JSON.stringify({ error: "Request too large" }))
        request.destroy()
        return
      }
      chunks.push(buffer)
    }

    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      const result = research
        ? await runResearchBrowser(parseResearchBrowserInput(body))
        : await runBrowserAgent(undefined, parseBrowserAgentInput(body), gone)
      response.statusCode = result.ok ? 200 : 409
      response.end(JSON.stringify(result))
    } catch (error) {
      response.statusCode = 400
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    bridgeServer!.once("error", reject)
    bridgeServer!.listen(0, "127.0.0.1", () => resolve())
  })
  const address = bridgeServer.address()
  if (!address || typeof address === "string") throw new Error("Controlled browser bridge failed to bind")
  bridgeUrl = `http://127.0.0.1:${address.port}`
  return { url: bridgeUrl, token: bridgeToken }
}

export async function stopBrowserBridge() {
  const current = bridgeServer
  bridgeServer = undefined
  bridgeUrl = ""
  bridgeToken = ""
  if (!current) return
  await new Promise<void>((resolve) => current.close(() => resolve()))
}
