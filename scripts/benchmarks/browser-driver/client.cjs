"use strict"

const http = require("node:http")

const HELP = `node client.cjs --endpoint http://127.0.0.1:<driver-port>
  [--token <synthetic-local-token> | --token-env <environment-variable>]
  '<action JSON>'
Without a JSON argument, reads the action JSON from stdin. Default token env:
BENCH_BROWSER_TOKEN. Does not load model credentials or run JavaScript on a page.
Actions: open, observe, click, type, press, select, screenshot, viewport, console.
Examples: {"action":"observe"}
  {"action":"click","role":"button","name":"Save"}
  {"action":"type","ref":"r2_3","text":"Example"}
Refs belong to the most recent snapshot. Role/name must resolve exactly once.
`

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help")) {
    process.stdout.write(HELP)
    return
  }
  let endpoint,
    token,
    variable = "BENCH_BROWSER_TOKEN",
    body
  for (let i = 0; i < args.length; i++) {
    if (["--endpoint", "--token", "--token-env"].includes(args[i])) {
      const name = args[i],
        value = args[++i]
      if (!value) throw new Error("Missing option value.")
      if (name === "--endpoint") endpoint = value
      if (name === "--token") token = value
      if (name === "--token-env") variable = value
    } else if (body === undefined) body = args[i]
    else throw new Error("Only one action JSON argument is allowed.")
  }
  const base = new URL(endpoint)
  if (
    base.protocol !== "http:" ||
    base.hostname !== "127.0.0.1" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error("Driver endpoint must be an exact http://127.0.0.1:<port> origin.")
  token ??= process.env[variable]
  if (!token) throw new Error("Missing local browser token.")
  if (body === undefined) {
    body = ""
    for await (const chunk of process.stdin) {
      body += chunk
      if (body.length > 16_384) throw new Error("Action too long.")
    }
  }
  const data = Buffer.from(JSON.stringify(JSON.parse(body)))
  if (data.length > 16_384) throw new Error("Action body exceeds 16 KiB.")
  const result = await new Promise((resolve, reject) => {
    const request = http.request(
      new URL("/action", base),
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "Content-Length": data.length,
        },
        timeout: 25_000,
      },
      (response) => {
        let text = ""
        response.setEncoding("utf8")
        response.on("data", (chunk) => {
          text += chunk
          if (text.length > 64_000) request.destroy(new Error("Driver response exceeds bound."))
        })
        response.on("end", () => {
          try {
            resolve(JSON.parse(text))
          } catch {
            reject(new Error("Driver returned invalid JSON."))
          }
        })
      },
    )
    request.on("error", reject)
    request.on("timeout", () => request.destroy(new Error("Driver request timed out.")))
    request.end(data)
  })
  process.stdout.write(JSON.stringify(result) + "\n")
  if (!result.ok) process.exitCode = 1
}

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + "\n")
    process.exitCode = 1
  })
