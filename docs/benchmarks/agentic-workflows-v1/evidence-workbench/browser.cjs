"use strict"

const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const { ProductFailure, requireProduct, reportExit, validOrigin, apiObject, importedDocument, batchStatusMatches, invalidBatchStatusMatches } = require("./browser_support.cjs")
const inventory = require("./inventory.json")

async function main() {
  const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, index) => [process.argv[2 + index * 2], process.argv[3 + index * 2]]))
  const origin = validOrigin(args["--origin"])
  const out = path.resolve(args["--out"])
  const checks = inventory.browser.map((name) => ({ name, status: "not_run" }))
  const blocked = []
  let instrumentError = null
  let context
  let proxy
  let profile
  let page

  async function api(method, route, payload, expected = 201) {
    requireProduct(route.startsWith("/api/") && !route.startsWith("//"), "Invalid local API route.")
    const response = await fetch(origin + route, {
      method, redirect: "error", signal: AbortSignal.timeout(7000),
      headers: { "content-type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    }).catch(() => { throw new ProductFailure("Application API became unavailable.") })
    requireProduct(response.status === expected, `Expected HTTP ${expected}, received ${response.status}.`)
    const value = await response.json().catch(() => { throw new ProductFailure("Application API returned invalid JSON.") })
    return apiObject(value)
  }

  async function importDocument(source, title, body) {
    const value = await api("POST", "/api/import", { source, title, body })
    return importedDocument(value)
  }

  function payload(batchId, rows) {
    return [{ type: "batch", batchId }, ...rows].map((row) => JSON.stringify(row)).join("\n") + "\n"
  }

  async function poll(action, predicate, message, timeout = 4000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await action()
      if (predicate(value)) return value
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new ProductFailure(message)
  }

  async function reset() {
    await page.goto(origin, { waitUntil: "domcontentloaded" })
    await page.getByRole("heading", { name: "Evidence Workbench", exact: true }).waitFor()
  }

  async function search(query, count) {
    await page.getByRole("textbox", { name: "Search documents", exact: true }).fill(query)
    const response = page.waitForResponse((item) => {
      const url = new URL(item.url())
      return url.origin === origin && url.pathname === "/api/search" && url.searchParams.get("q") === query
    })
    await page.getByRole("button", { name: "Search", exact: true }).click()
    requireProduct((await response).status() === 200, "Browser search request failed.")
    if (count !== undefined) await poll(() => page.getByTestId("search-result").count(), (value) => value === count, "Browser result count did not update.")
  }

  async function showBody(expected) {
    await poll(() => page.getByTestId("document-body").textContent().catch(() => null), (value) => value === expected, "Document viewer did not display the exact original text.")
  }

  async function statuses() {
    return page.getByRole("status").evaluateAll((elements) => elements.map((element) => {
      const style = getComputedStyle(element)
      return {
        text: element.innerText ?? element.textContent ?? "",
        visible: element.getClientRects().length > 0 && style.visibility !== "hidden" && style.visibility !== "collapse",
      }
    }))
  }

  async function uiBatch(batchId, rows, replay = false) {
    await page.getByRole("textbox", { name: "Batch NDJSON", exact: true }).fill(payload(batchId, rows))
    const response = page.waitForResponse((item) => new URL(item.url()).origin === origin && new URL(item.url()).pathname === "/api/batches")
    await page.getByRole("button", { name: "Import batch", exact: true }).click()
    requireProduct((await response).status() === (replay ? 200 : 201), "Browser batch submission failed.")
    await poll(statuses, (rows) => batchStatusMatches(rows, batchId, replay), "Batch status omitted its ID, revision, or replay outcome.")
  }

  async function run(name, action) {
    const row = checks.find((item) => item.name === name)
    try {
      await action()
      row.status = "passed"
    } catch (error) {
      if (error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError) throw error
      row.status = "failed"
      row.detail = String(error.message || error).slice(0, 450)
    }
  }

  try {
    const chrome = process.env.VECTOR_BENCH_CHROME
    const playwrightModule = process.env.VECTOR_BENCH_PLAYWRIGHT_MODULE
    const proxyPath = process.env.VECTOR_BENCH_BROWSER_PROXY
    if (![chrome, playwrightModule, proxyPath].every((value) => value && fs.existsSync(value))) throw new Error("Explicit local Chrome, Playwright, and frozen proxy paths are required.")
    const { chromium } = require(playwrightModule)
    const { startProxy } = require(proxyPath)
    const { allowedURL } = require(path.join(path.dirname(proxyPath), "policy.cjs"))
    const origins = new Set([origin])
    proxy = await startProxy(origins, (url, layer) => blocked.push({ url: String(url).slice(0, 500), layer }))
    profile = fs.mkdtempSync(path.join(os.tmpdir(), "ewb-"))
    context = await chromium.launchPersistentContext(profile, {
      executablePath: chrome, headless: true, viewport: { width: 1200, height: 850 },
      proxy: { server: proxy.url, bypass: "" },
      args: ["--proxy-bypass-list=<-loopback>", "--disable-background-networking", "--disable-component-update", "--disable-sync"],
      serviceWorkers: "block", acceptDownloads: false,
    })
    context.setDefaultTimeout(4000)
    context.setDefaultNavigationTimeout(8000)
    await context.route("**/*", (route) => allowedURL(route.request().url(), origins) ? route.continue() : route.abort("blockedbyclient"))
    if (context.routeWebSocket) await context.routeWebSocket("**/*", (socket) => socket.close())
    page = context.pages()[0] || await context.newPage()
    context.on("page", (other) => { if (other !== page) other.close().catch(() => {}) })
    page.on("dialog", (dialog) => dialog.dismiss())

    await run("browser.import", async () => {
      await reset()
      const rows = [{ type: "upsert", source: "browser/batch", title: "Browser batch", body: "uibatchtoken Café 🧭" }]
      await uiBatch("ui-batch-01", rows)
      await uiBatch("ui-batch-01", rows, true)
      const invalid = '{"type":"batch","batchId":"ui-invalid"}\n{"type":"upsert"}\n'
      await page.getByRole("textbox", { name: "Batch NDJSON", exact: true }).fill(invalid)
      const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/batches")
      await page.getByRole("button", { name: "Import batch", exact: true }).click()
      requireProduct((await response).status() === 400, "Invalid browser batch was accepted.")
      requireProduct(await page.getByRole("textbox", { name: "Batch NDJSON", exact: true }).inputValue() === invalid, "Failed batch erased the entered text.")
      await poll(statuses, invalidBatchStatusMatches, "Validation error was not visible.")
      await page.getByRole("textbox", { name: "Document source", exact: true }).fill("browser/legacy-ui")
      await page.getByRole("textbox", { name: "Document title", exact: true }).fill("Legacy UI remains")
      await page.getByRole("textbox", { name: "Document text", exact: true }).fill("legacyuibrowser")
      const legacyResponse = page.waitForResponse((item) => new URL(item.url()).origin === origin && new URL(item.url()).pathname === "/api/import")
      await page.getByRole("button", { name: "Import document", exact: true }).click()
      requireProduct((await legacyResponse).status() === 201, "Legacy browser import did not complete successfully.")
      await search("legacyuibrowser", 1)
    })

    await run("browser.search", async () => {
      const one = await importDocument("browser/search-a", "Search A", "uiarchivetoken fern")
      const two = await importDocument("browser/search-b", "Search B", "uiarchivetoken stone")
      await reset()
      await search("uiarchivetoken", 2)
      const text = await page.getByRole("list", { name: "Search results", exact: true }).innerText()
      requireProduct(text.includes("Search A") && text.includes("Search B") && text.includes(one.source) && text.includes(two.source), "Search results omitted titles or sources.")
    })

    await run("browser.detail", async () => {
      const body = "# Browser original\nCafé 🧭 東京 e\u0301\nuidetailtoken\nSecond paragraph."
      const row = await importDocument("browser/detail", "Browser original", body)
      await reset()
      await search("uidetailtoken", 1)
      await page.getByRole("button", { name: `Open document ${row.id}`, exact: true }).click()
      await showBody(body)
      await page.setViewportSize({ width: 390, height: 844 })
      requireProduct(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), "Document page overflows the mobile viewport.")
      await page.getByRole("textbox", { name: "Search documents", exact: true }).fill("uidetailtoken")
      await page.getByRole("button", { name: "Search", exact: true }).click()
      await page.setViewportSize({ width: 1200, height: 850 })
    })

    await run("browser.citation", async () => {
      const body = "# Cited original\nCafé 🧭 東京\nuineedletoken exact evidence."
      const row = await importDocument("browser/citation", "Cited original", body)
      await reset()
      await search("uineedletoken", 1)
      await page.getByRole("button", { name: `View citation ${row.id}`, exact: true }).click()
      await page.getByTestId("citation-quote").waitFor()
      const quote = await page.getByTestId("citation-quote").textContent()
      requireProduct(quote && body.includes(quote) && quote.includes("uineedletoken"), "Citation viewer omitted the exact evidence quote.")
      const text = await page.locator("body").innerText()
      requireProduct(/version\s*:?\s*1/i.test(text) && /byte/i.test(text), "Citation viewer omitted version or byte offsets.")
      await page.getByRole("button", { name: "Open cited document", exact: true }).click()
      await showBody(body)
    })

    await run("browser.replacement", async () => {
      const body = "🧭 uireplaceoldtoken original evidence."
      const row = await importDocument("browser/replacement", "Before UI replacement", body)
      await reset()
      await search("uireplaceoldtoken", 1)
      await page.getByRole("button", { name: `View citation ${row.id}`, exact: true }).click()
      await page.getByTestId("citation-quote").waitFor()
      await uiBatch("ui-replace-01", [{ type: "upsert", source: row.source, title: "After UI replacement", body: "uireplacenewtoken revised evidence." }])
      await page.getByRole("button", { name: "Open cited document", exact: true }).click()
      await showBody(body)
      await search("uireplaceoldtoken", 0)
      await search("uireplacenewtoken", 1)
    })

    await run("browser.history", async () => {
      const body = "uihistoryoriginal first version 🧭"
      const row = await importDocument("browser/history", "First UI history", body)
      await importDocument("browser/history", "Second UI history", "uihistorycurrent second version")
      await reset()
      await search("uihistorycurrent", 1)
      await page.getByRole("button", { name: `Open document ${row.id}`, exact: true }).click()
      await showBody("uihistorycurrent second version")
      await page.getByRole("combobox", { name: "Document version", exact: true }).selectOption("1")
      await showBody(body)
      await page.getByRole("combobox", { name: "Document version", exact: true }).selectOption("2")
      await showBody("uihistorycurrent second version")
    })

    await run("browser.untrusted", async () => {
      const title = '<img src="/_ewb_probe" onerror="globalThis.__ewbInjected=1"> Literal title'
      const body = 'uiuntrustedtoken\n<script>globalThis.__ewbInjected=1</script>\n<img src="/_ewb_probe" onerror="globalThis.__ewbInjected=1">\n[link](javascript:alert(1))'
      const row = await importDocument("browser/<b>literal-source</b>", title, body)
      await reset()
      await search("uiuntrustedtoken", 1)
      const resultText = await page.getByTestId("search-result").innerText()
      requireProduct(resultText.includes(title) && resultText.includes(row.source), "Imported title or source was interpreted or altered.")
      await page.getByRole("button", { name: `Open document ${row.id}`, exact: true }).click()
      await showBody(body)
      requireProduct(await page.getByTestId("document-body").locator("script,img,a,iframe,object").count() === 0, "Imported text created active DOM elements.")
      requireProduct(await page.evaluate(() => globalThis.__ewbInjected === undefined && !document.querySelector('img[src="/_ewb_probe"]')), "Imported markup executed or became a resource.")
      await page.getByRole("button", { name: `View citation ${row.id}`, exact: true }).click()
      await page.getByTestId("citation-quote").waitFor()
      requireProduct(await page.getByTestId("citation-quote").locator("script,img,a").count() === 0, "Citation interpreted imported HTML.")
    })

    await run("browser.pagination", async () => {
      const ids = []
      for (let index = 0; index < 5; index++) ids.push((await importDocument(`browser/page-${index}`, `UI page ${index}`, "uipaginationtoken")).id)
      await reset()
      await page.getByRole("combobox", { name: "Results per page", exact: true }).selectOption("2")
      await search("uipaginationtoken", 2)
      const next = page.getByRole("button", { name: "Next results", exact: true })
      const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/search")
      await next.click()
      requireProduct((await response).status() === 200, "Next-results request failed.")
      await poll(() => page.getByRole("list", { name: "Search results", exact: true }).innerText(), (text) => text.includes("UI page 2") || text.includes("UI page 3"), "Next-results view did not advance.")
      await importDocument("browser/page-unrelated", "Unrelated change", "uiunrelatedtoken")
      const stale = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/search")
      await next.click()
      requireProduct((await stale).status() === 409, "Browser did not submit its stale revision-bound cursor.")
      await page.getByText(/Collection changed/i).first().waitFor()
      const restarted = page.waitForResponse((item) => new URL(item.url()).origin === origin && new URL(item.url()).pathname === "/api/search")
      await page.getByRole("button", { name: "Restart search", exact: true }).click()
      requireProduct((await restarted).status() === 200, "Restart-search request failed.")
      await poll(() => page.getByRole("list", { name: "Search results", exact: true }).innerText(), (text) => text.includes("UI page 0") && text.includes("UI page 1"), "Restart did not display a fresh first page.")
      await poll(() => page.getByTestId("search-result").count(), (count) => count === 2, "Restart did not begin a fresh first page.")
      const text = await page.getByRole("list", { name: "Search results", exact: true }).innerText()
      requireProduct(text.includes("UI page 0") && text.includes("UI page 1"), "Restart retained a mixed-revision continuation.")
      requireProduct(await page.getByRole("combobox", { name: "Results per page", exact: true }).inputValue() === "2", "Restart lost selected page size.")
      requireProduct(await page.getByRole("textbox", { name: "Search documents", exact: true }).inputValue() === "uipaginationtoken", "Restart lost the query.")
    })
    await page.screenshot({ path: path.join(out, "browser-final.png") })
  } catch (error) {
    instrumentError = "Owned browser harness failure: " + String(error.stack || error).slice(0, 1600)
  } finally {
    if (context) await context.close().catch((error) => { instrumentError ||= "Browser close failed: " + error.message })
    if (proxy) await proxy.close().catch((error) => { instrumentError ||= "Proxy close failed: " + error.message })
    if (profile) {
      const temporaryRoot = path.resolve(os.tmpdir())
      const target = path.resolve(profile)
      const relative = path.relative(temporaryRoot, target)
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && !relative.includes(path.sep) && relative.startsWith("ewb-"))
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      else instrumentError ||= "Owned profile cleanup path failed boundary validation."
    }
    fs.writeFileSync(path.join(out, "browser.json"), JSON.stringify({ checks, instrumentError, blockedRequests: blocked }, null, 2) + "\n")
  }
  process.exitCode = reportExit(checks, instrumentError)
}

main().catch((error) => { console.error(error.stack); process.exitCode = 2 })
