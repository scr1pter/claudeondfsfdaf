import { join, resolve } from "node:path"
import { openStore } from "./storage"

const store = openStore(process.env.DATA_DIR ?? ".data")
const root = resolve("dist")
const json = (value: unknown, status = 200) => Response.json(value, { status })

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4123),
  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/api/health") return json({ ok: true, schemaVersion: 1 })
      if (url.pathname === "/api/import" && request.method === "POST") {
        const text = await request.text()
        const inputs: unknown[] = request.headers.get("content-type")?.includes("ndjson")
          ? text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line))
          : [JSON.parse(text)]
        const documents = inputs.map((input) => store.import(input))
        return json({ documents }, 201)
      }
      if (url.pathname === "/api/documents") return json({ documents: store.list() })
      const match = /^\/api\/documents\/(\d+)$/.exec(url.pathname)
      if (match) {
        const document = store.get(Number(match[1]))
        return document ? json({ document }) : json({ error: { code: "not_found", message: "Document not found." } }, 404)
      }
      if (url.pathname === "/api/search") {
        const query = url.searchParams.get("q") ?? ""
        return json({ query, results: store.search(query) })
      }
      if (url.pathname.startsWith("/api/")) return json({ error: { code: "not_found", message: "Unknown endpoint." } }, 404)
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
      const file = Bun.file(join(root, url.pathname === "/" ? "index.html" : url.pathname))
      if (await file.exists()) return new Response(file)
      return new Response(Bun.file(join(root, "index.html")))
    } catch (error) {
      return json({ error: { code: "invalid_document", message: error instanceof Error ? error.message : "Invalid request." } }, 400)
    }
  },
})

console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${server.port}` }))
process.on("SIGTERM", () => { server.stop(); store.close(); process.exit(0) })
