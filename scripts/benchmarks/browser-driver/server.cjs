"use strict"

const http = require("node:http")
const fs = require("node:fs/promises")
const path = require("node:path")
const crypto = require("node:crypto")
const { origin, allowedURL, inside, authenticate, target, keys } = require("./policy.cjs")
const { startProxy } = require("./proxy.cjs")
const owned = { browser: undefined, server: undefined, proxy: undefined }

const HELP = `Local benchmark browser driver; no model or deployment calls.
node server.cjs --playwright-module <package-directory> --chrome <executable>
  --out <new-or-empty-directory> --allow-origin http://127.0.0.1:<app-port>
  [--allow-origin <another-loopback-origin>] [--port 0]
  --token-stdin   Read a 24-128 character local authentication token from stdin.
  --token <token> Alternative for synthetic local credentials only.
Ready JSON goes to stdout. The driver owns its fresh headless profile and output.
`

function argumentsOf(values) {
  const result = { origins: [] }
  for (let i = 0; i < values.length; i++) {
    const key = values[i]
    if (key === "--help") return { help: true }
    if (key === "--token-stdin") {
      result.stdin = true
      continue
    }
    if (
      !["--playwright-module", "--chrome", "--out", "--allow-origin", "--port", "--token"].includes(key) ||
      !values[i + 1]
    )
      throw new Error("Unknown or incomplete option: " + key)
    const value = values[++i]
    if (key === "--allow-origin") result.origins.push(origin(value))
    else result[key.slice(2)] = value
  }
  return result
}

async function inputToken() {
  let text = ""
  for await (const chunk of process.stdin) {
    text += chunk
    if (text.length > 256) throw new Error("Local token input is too long.")
    if (text.includes("\n")) break
  }
  return text.trim()
}

async function requestBody(request) {
  let bytes = 0
  const chunks = []
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 16_384) throw new Error("Action body exceeds 16 KiB.")
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Action must be a JSON object.")
  return value
}

async function main() {
  const args = argumentsOf(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  if (!args["playwright-module"] || !args.chrome || !args.out || !args.origins.length || (args.stdin && args.token))
    throw new Error(HELP)
  const token = args.stdin ? await inputToken() : args.token
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{24,128}$/.test(token))
    throw new Error("Supply a 24-128 character synthetic local token.")
  const origins = new Set(args.origins)
  if ([...origins].some((value) => new URL(value).protocol !== "http:"))
    throw new Error("The transport-fenced benchmark driver accepts HTTP loopback app origins only.")
  const port = Number(args.port ?? 0)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.")
  const out = path.resolve(args.out)
  await fs.mkdir(out, { recursive: true })
  if ((await fs.readdir(out)).length)
    throw new Error("Output directory must be new or empty; existing profiles are never reused.")
  const profile = path.join(out, "profile")
  const screenshots = path.join(out, "screenshots")
  await fs.mkdir(screenshots)
  const { chromium } = require(path.resolve(args["playwright-module"]))
  const blocked = []
  const block = (url, kind) => {
    let host = "invalid"
    try {
      host = new URL(url).origin
    } catch {}
    blocked.push({ origin: host, kind })
    if (blocked.length > 20) blocked.shift()
  }
  const proxy = await startProxy(origins, block)
  owned.proxy = proxy
  const environment = Object.fromEntries(
    ["SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "LANG", "LC_ALL"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  )
  const browser = await chromium.launchPersistentContext(profile, {
    executablePath: path.resolve(args.chrome),
    headless: true,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: false,
    serviceWorkers: "block",
    env: environment,
    proxy: { server: proxy.url, bypass: "<-loopback>" },
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-default-apps",
      "--disable-breakpad",
      "--disable-domain-reliability",
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  })
  owned.browser = browser
  await browser.route("**/*", async (route) => {
    const request = route.request()
    if (allowedURL(request.url(), origins)) return route.continue()
    block(request.url(), request.resourceType())
    return route.abort("blockedbyclient")
  })
  await browser.routeWebSocket("**/*", (route) => {
    if (allowedURL(route.url(), origins, true)) route.connectToServer()
    else {
      block(route.url(), "websocket")
      route.close({ code: 1008, reason: "Origin is outside the benchmark allowlist." })
    }
  })
  const page = browser.pages()[0] ?? (await browser.newPage())
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(12000)
  browser.on("page", (next) => {
    if (next !== page) void next.close()
  })
  const consoleLines = []
  const appendConsole = (level, text) => {
    consoleLines.push({ level, text: String(text).slice(0, 300) })
    if (consoleLines.length > 40) consoleLines.shift()
  }
  page.on("console", (message) => appendConsole(message.type(), message.text()))
  page.on("pageerror", (error) => appendConsole("pageerror", error.message))
  page.on("dialog", (dialog) => {
    appendConsole("dialog", dialog.type() + ": " + dialog.message())
    void dialog.dismiss()
  })
  page.on("download", (download) => {
    appendConsole("download", "Download refused: " + download.suggestedFilename())
    void download.cancel()
  })
  let generation = 0
  let refs = new Map()
  let imageCount = 0

  async function snapshot() {
    for (const handle of refs.values()) await handle.dispose().catch(() => {})
    refs = new Map()
    generation++
    const text = await page.evaluate(() => ({
      title: document.title,
      text: (document.querySelector("main") ?? document.body)?.innerText?.slice(0, 5000) ?? "",
      headings: Array.from(document.querySelectorAll("h1,h2,h3,[role=heading]"))
        .filter((node) => node.getClientRects().length)
        .slice(0, 20)
        .map((node) => node.textContent.trim().slice(0, 140)),
    }))
    const handles = await page
      .locator(
        "button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=textbox],[role=combobox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch]",
      )
      .elementHandles()
    const controls = []
    let examined = 0
    for (const handle of handles.slice(0, 200)) {
      examined++
      if (!(await handle.isVisible())) {
        await handle.dispose()
        continue
      }
      const details = await handle.evaluate((node) => {
        const tag = node.tagName.toLowerCase()
        const type = node.getAttribute("type") ?? ""
        const labels = node.labels
          ? Array.from(node.labels)
              .map((label) => label.textContent)
              .join(" ")
          : ""
        const labelled = (node.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
        const role =
          node.getAttribute("role") ??
          (tag === "button"
            ? "button"
            : tag === "a"
              ? "link"
              : tag === "select"
                ? "combobox"
                : type === "checkbox" || type === "radio"
                  ? type
                  : type === "number"
                    ? "spinbutton"
                    : type === "submit" || type === "button"
                      ? "button"
                      : "textbox")
        const name = (
          node.getAttribute("aria-label") ||
          labelled ||
          labels ||
          (tag === "button" || tag === "a" ? node.textContent : node.getAttribute("placeholder")) ||
          node.getAttribute("title") ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 160)
        return {
          tag,
          role,
          name,
          type,
          disabled: Boolean(node.disabled) || node.getAttribute("aria-disabled") === "true",
          ...(tag === "select"
            ? {
                options: Array.from(node.options)
                  .slice(0, 12)
                  .map((option) => ({ label: option.label.slice(0, 80), value: option.value.slice(0, 80) })),
              }
            : {}),
          ...(tag === "input" || tag === "textarea"
            ? { value: type === "password" ? "[masked]" : String(node.value).slice(0, 160) }
            : {}),
        }
      })
      const ref = "r" + generation + "_" + (controls.length + 1)
      refs.set(ref, handle)
      controls.push({ ref, ...details })
      if (controls.length >= 80) break
    }
    const retained = new Set(refs.values())
    await Promise.all(
      handles.filter((handle) => !retained.has(handle)).map((handle) => handle.dispose().catch(() => {})),
    )
    const result = {
      untrustedPageData: true,
      generation,
      url: page.url(),
      ...text,
      controls,
      controlsTruncated: examined < handles.length,
      blockedRequests: blocked.slice(-5),
    }
    while (JSON.stringify(result).length > 24_000 && controls.length > 1) {
      const removed = controls.pop()
      await refs.get(removed.ref)?.dispose()
      refs.delete(removed.ref)
      result.controlsTruncated = true
    }
    return result
  }

  async function locate(value) {
    const selected = target(value)
    if (selected.ref) {
      const handle = refs.get(selected.ref)
      if (!handle || !(await handle.evaluate((node) => node.isConnected)) || !(await handle.isVisible()))
        throw new Error("Stale or hidden ref. Observe again.")
      return handle
    }
    const locator = page.getByRole(selected.role, { name: selected.name, exact: true })
    if ((await locator.count()) !== 1 || !(await locator.isVisible()))
      throw new Error("Exact role/name target is missing, hidden or ambiguous. Use a fresh ref.")
    return locator
  }

  async function action(value) {
    let result = {}
    switch (value.action) {
      case "open":
        if (!allowedURL(value.url, origins)) throw new Error("Navigation origin is outside the loopback allowlist.")
        result = { status: (await page.goto(value.url, { waitUntil: "domcontentloaded" }))?.status() ?? null }
        break
      case "observe":
        break
      case "click":
        await (await locate(value)).click({ timeout: 5000 })
        break
      case "type":
        if (typeof value.text !== "string" || value.text.length > 5000)
          throw new Error("Type text must be a string of at most 5000 characters.")
        await (await locate(value)).fill(value.text)
        break
      case "press":
        if (!keys.has(value.key))
          throw new Error("Unsupported key. Clipboard, browser-chrome and OS shortcuts are not allowed.")
        if (value.ref !== undefined || value.role !== undefined) await (await locate(value)).press(value.key)
        else await page.keyboard.press(value.key)
        break
      case "select":
        if (
          !Array.isArray(value.values) ||
          !value.values.length ||
          value.values.length > 12 ||
          value.values.some((item) => typeof item !== "string" || item.length > 200)
        )
          throw new Error("Select requires 1-12 string option values.")
        await (await locate(value)).selectOption(value.values)
        break
      case "viewport":
        if (![value.width, value.height].every((item) => Number.isInteger(item) && item >= 240 && item <= 2500))
          throw new Error("Viewport dimensions must be integers from 240 to 2500.")
        await page.setViewportSize({ width: value.width, height: value.height })
        break
      case "console":
        result = { entries: consoleLines.slice(-20) }
        break
      case "screenshot": {
        const file = inside(screenshots, value.filename ?? "screen-" + ++imageCount + ".png")
        try {
          await fs.access(file)
          throw new Error("Screenshot already exists; use a new filename.")
        } catch (error) {
          if (error.code !== "ENOENT") throw error
        }
        await page.screenshot({ path: file, fullPage: false, timeout: 10000 })
        result = {
          file,
          sha256: crypto
            .createHash("sha256")
            .update(await fs.readFile(file))
            .digest("hex"),
          viewport: page.viewportSize(),
        }
        break
      }
      default:
        throw new Error(
          "Unknown action. Use open, observe, click, type, press, select, screenshot, viewport or console.",
        )
    }
    if (value.action !== "console" && value.action !== "observe" && value.action !== "screenshot") {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {})
    }
    if (page.url() !== "about:blank" && !allowedURL(page.url(), origins))
      throw new Error("Navigation left the origin allowlist; the transport fence refused access.")
    return { ok: true, action: value.action, result, snapshot: await snapshot() }
  }

  let queue = Promise.resolve()
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "application/json; charset=utf-8")
    response.setHeader("Cache-Control", "no-store")
    const send = (status, value) => {
      response.writeHead(status)
      response.end(JSON.stringify(value))
    }
    if (!authenticate(request.headers.authorization, token)) return send(401, { ok: false, error: "Unauthorized." })
    if (request.method === "GET" && request.url === "/health")
      return send(200, { ok: true, ready: true, origins: [...origins] })
    if (request.method !== "POST" || request.url !== "/action")
      return send(404, { ok: false, error: "Use POST /action." })
    if (!(request.headers["content-type"] ?? "").startsWith("application/json"))
      return send(415, { ok: false, error: "Use application/json." })
    queue = queue
      .then(async () => {
        try {
          send(200, await action(await requestBody(request)))
        } catch (error) {
          const current = await snapshot().catch(() => undefined)
          send(400, {
            ok: false,
            error: String(error.message).slice(0, 700),
            ...(current ? { snapshot: current } : {}),
          })
        }
      })
      .catch((error) => {
        if (!response.writableEnded) send(500, { ok: false, error: String(error.message).slice(0, 300) })
      })
  })
  owned.server = server
  server.requestTimeout = 20_000
  server.headersTimeout = 5_000
  let stopping = false
  const close = async () => {
    if (stopping) return
    stopping = true
    server.close()
    await browser.close()
    await proxy.close()
  }
  process.once("SIGINT", () => void close())
  process.once("SIGTERM", () => void close())
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  process.stdout.write(
    JSON.stringify({ ready: true, endpoint: "http://127.0.0.1:" + server.address().port, out, origins: [...origins] }) +
      "\n",
  )
}

if (require.main === module)
  main().catch(async (error) => {
    owned.server?.close()
    await owned.browser?.close().catch(() => {})
    await owned.proxy?.close().catch(() => {})
    process.stderr.write(String(error.message) + "\n")
    process.exitCode = 1
  })

module.exports = { argumentsOf }
