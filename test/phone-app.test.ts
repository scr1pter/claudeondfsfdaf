import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { listedPerks, perkServices } from "../api/_lib/codium-perks"
import { switchKey } from "../api/_lib/codium-switches"
import { PHONE_ORIGIN, PHONE_SW_SCOPE, PHONE_SW_URL } from "../packages/app/src/phone/config"
import { RELAY_HOST } from "../packages/app/src/phone/remote/model"
import { copyPhoneApp, PHONE_APP_FILES } from "../packages/web/scripts/phone-app.mjs"
import { pruneVectorSite } from "../script/prune-vector-site.mjs"

// WP A38, the phone app shell. Its contract tests: the phone bundle survives the site's prune, and the phone origin
// alone gets the camera and the strict CSP. Also: vectordev.ai never serves the phone app on its own origin, the
// worker may take the whole phone origin as its scope, and phone alerts become listable once A37's push and this
// app are configured.

const ROOT = path.resolve(import.meta.dir, "..")
const HOST = new URL(PHONE_ORIGIN).host
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporary() {
  const directory = await mkdtemp(path.join(tmpdir(), "vector-phone-"))
  directories.push(directory)
  return directory
}

async function files(directory: string, prefix = ""): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(prefix, entry.name)
    if (entry.isDirectory()) found.push(...(await files(path.join(directory, entry.name), name)))
    else found.push(name.split(path.sep).join("/"))
  }
  return found.sort()
}

/** A website build with the phone app copied in, then pruned exactly as the deploy does. */
async function publish(phoneBuild: string) {
  const site = await temporary()
  await mkdir(path.join(site, "_astro"), { recursive: true })
  await mkdir(path.join(site, "_worker.js"), { recursive: true })
  await writeFile(path.join(site, "index.html"), "<html>home</html>")
  await writeFile(path.join(site, "_worker.js", "server.js"), "server code")
  expect(await copyPhoneApp({ from: phoneBuild, to: path.join(site, "phone"), required: true })).toBe(true)
  await pruneVectorSite(site)
  return site
}

describe("the phone bundle survives the prune", () => {
  test("every file a phone build makes is published under /phone, and nothing private", async () => {
    const build = await temporary()
    const made = {
      "index.html": '<!doctype html><script type="module" crossorigin src="/phone/assets/index-a1b2.js"></script>',
      "sw.js": "(()=>{})()",
      "phone.webmanifest": '{"scope":"/"}',
      "version.json": '{"build":"b1","protocol":1,"minDesktop":1}',
      "assets/index-a1b2.js": "export{}",
      "assets/index-c3d4.css": "body{}",
      "icons/icon-192.png": "png",
      "icons/icon-512.png": "png",
      "icons/apple-touch-icon.png": "png",
      "icons/favicon-32.png": "png",
    }
    for (const [file, text] of Object.entries(made)) {
      await mkdir(path.dirname(path.join(build, file)), { recursive: true })
      await writeFile(path.join(build, file), text)
    }
    // Neither of these may ever be published.
    await writeFile(path.join(build, "assets", "index-a1b2.js.map"), "{}")
    await writeFile(path.join(build, ".env"), "SECRET=1")
    const site = await publish(build)
    expect(await files(path.join(site, "phone"))).toEqual(Object.keys(made).sort())
    expect(await readFile(path.join(site, "phone", "sw.js"), "utf8")).toBe("(()=>{})()")
    expect(existsSync(path.join(site, "_worker.js"))).toBe(false)
  })

  test("a missing phone build fails a Vercel build and only warns locally", async () => {
    const empty = await temporary()
    const site = await temporary()
    await expect(copyPhoneApp({ from: empty, to: path.join(site, "phone"), required: true })).rejects.toThrow(
      `lacks ${PHONE_APP_FILES.join(", ")}`,
    )
    const warnings: string[] = []
    expect(
      await copyPhoneApp({
        from: empty,
        to: path.join(site, "phone"),
        required: false,
        warn: (text) => warnings.push(text),
      }),
    ).toBe(false)
    expect(warnings[0]).toContain("build:phone")
    expect(existsSync(path.join(site, "phone"))).toBe(false)
  })

  // CI builds the phone app before the tests (vector-codium.yml); on a machine that has not built it this is skipped.
  const built = path.join(ROOT, "packages", "app", "dist-phone")
  test.skipIf(!existsSync(path.join(built, "index.html")))(
    "the real phone build survives the prune, CSP-clean",
    async () => {
      const site = await publish(built)
      const published = await files(path.join(site, "phone"))
      for (const file of PHONE_APP_FILES) expect(published).toContain(file)
      expect(published.some((file) => file.endsWith(".map"))).toBe(false)
      const html = await readFile(path.join(site, "phone", "index.html"), "utf8")
      // Every script, stylesheet, icon and the manifest the page names is same-origin under /phone/ and was published.
      const references = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((match) => match[1])
      expect(references.length).toBeGreaterThan(2)
      for (const reference of references) {
        expect(reference.startsWith("/phone/")).toBe(true)
        expect(published).toContain(reference.slice("/phone/".length))
      }
      expect(/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html)).toBe(false)
      expect(/\sstyle=/i.test(html)).toBe(false)
      const version = JSON.parse(await readFile(path.join(site, "phone", "version.json"), "utf8"))
      expect(version.build).toMatch(/^[A-Za-z0-9._-]+$/)
      // The worker is one classic script: nothing to import.
      const worker = await readFile(path.join(site, "phone", "sw.js"), "utf8")
      expect(/^\s*import[\s{*]/m.test(worker)).toBe(false)
      expect(worker).toContain("showNotification")
    },
  )
})

type Rule = {
  source: string
  destination?: string
  has?: { type: string; value: string }[]
  missing?: unknown[]
  headers?: { key: string; value: string }[]
  permanent?: boolean
}
type VercelConfig = { buildCommand: string; redirects: Rule[]; rewrites: Rule[]; headers: Rule[] }

const vercel = async () => JSON.parse(await readFile(path.join(ROOT, "vercel.json"), "utf8")) as VercelConfig
const onHost = (rule: Rule, host: string) =>
  rule.has?.some((item) => item.type === "host" && item.value === host) ?? false
const header = (rule: Rule, key: string) =>
  rule.headers?.find((item) => item.key.toLowerCase() === key.toLowerCase())?.value
// Vercel's sources are path-to-regexp patterns; these tests use only the forms below.
const matches = (source: string, pathname: string) =>
  new RegExp(`^${source.replace(/:path\*/g, "(.*)")}$`).test(pathname) ||
  (source.endsWith("/:path*") && pathname === source.slice(0, -"/:path*".length))

describe("vercel.json: camera and CSP for the phone origin only", () => {
  test("only the phone origin may use the camera, and its rule comes after the site-wide denial", async () => {
    const { headers } = await vercel()
    const everywhere = headers.findIndex((rule) => rule.source === "/(.*)" && !rule.has)
    expect(header(headers[everywhere], "Permissions-Policy")).toContain("camera=()")
    const granting = headers.filter((rule) => /camera=\((?!\))/.test(header(rule, "Permissions-Policy") ?? ""))
    expect(granting).toHaveLength(1)
    expect(onHost(granting[0], HOST)).toBe(true)
    expect(granting[0].source).toBe("/(.*)")
    expect(header(granting[0], "Permissions-Policy")).toBe("camera=(self), geolocation=(), payment=(), microphone=()")
    // Vercel applies matching rules in order, the later value winning, so the grant must come after the denial.
    expect(headers.indexOf(granting[0])).toBeGreaterThan(everywhere)
  })

  test("the phone origin gets a strict CSP, and nothing else gets that rule", async () => {
    const { headers } = await vercel()
    const rules = headers.filter((rule) => header(rule, "Content-Security-Policy"))
    expect(rules).toHaveLength(1)
    expect(onHost(rules[0], HOST)).toBe(true)
    const policy = new Map(
      header(rules[0], "Content-Security-Policy")!
        .split(";")
        .map((part) => part.trim().split(/\s+/))
        .map(([name, ...values]) => [name, values] as const),
    )
    expect(policy.get("default-src")).toEqual(["'none'"])
    expect(policy.get("script-src")).toEqual(["'self'"])
    expect(policy.get("style-src")).toEqual(["'self'"])
    expect(policy.get("worker-src")).toEqual(["'self'"])
    expect(policy.get("manifest-src")).toEqual(["'self'"])
    for (const name of ["object-src", "frame-src", "base-uri", "form-action", "frame-ancestors"])
      expect(policy.get(name)).toEqual(["'none'"])
    expect(policy.has("upgrade-insecure-requests")).toBe(true)
    // The API answers on the phone origin itself; the other hosts are the account service the phone signs in with and
    // Vector Remote's relay (WP A42), the one host the phone app opens a socket to (remote/model.ts RELAY_HOST).
    expect(policy.get("connect-src")).toEqual(["'self'", "https://*.supabase.co", `wss://${RELAY_HOST}`])
    for (const values of policy.values())
      for (const value of values) {
        expect(value).not.toMatch(/unsafe|^\*$|^https?:$|^http:\/\/|^wss?:$/)
      }
    expect(header(rules[0], "Referrer-Policy")).toBe("no-referrer")
    expect(header(rules[0], "X-Robots-Tag")).toContain("noindex")
  })

  test("the worker may take the whole phone origin as its scope, there only", async () => {
    const { headers } = await vercel()
    const allowed = headers.filter((rule) => header(rule, "Service-Worker-Allowed"))
    expect(allowed).toHaveLength(1)
    expect(onHost(allowed[0], HOST)).toBe(true)
    expect(allowed[0].source).toBe(PHONE_SW_URL)
    expect(header(allowed[0], "Service-Worker-Allowed")).toBe(PHONE_SW_SCOPE)
    // Pages, the worker and version.json are revalidated on every load; hashed assets are kept.
    const phone = headers.filter((rule) => onHost(rule, HOST) && header(rule, "Cache-Control"))
    expect(phone.map((rule) => [rule.source, header(rule, "Cache-Control")])).toEqual([
      ["/phone/(.*)", "no-cache"],
      ["/phone/assets/(.*)", "public, max-age=31536000, immutable"],
    ])
  })
})

describe("vercel.json: one origin for the phone app", () => {
  test("the phone origin serves only the phone app and the API", async () => {
    const { redirects, rewrites } = await vercel()
    const phone = redirects.filter((rule) => onHost(rule, HOST))
    expect(phone).toHaveLength(1)
    expect(redirects.indexOf(phone[0])).toBe(0)
    expect(phone[0].destination).toBe("/phone/")
    expect(phone[0].permanent).toBe(false)
    for (const pathname of ["/", "/docs", "/codium", "/phone", "/account", "/favicon.ico"])
      expect({ pathname, redirected: matches(phone[0].source, pathname) }).toEqual({ pathname, redirected: true })
    for (const pathname of ["/phone/", "/phone/sessions", "/phone/sw.js", "/api/notify/subscribe", "/api/auth/config"])
      expect({ pathname, redirected: matches(phone[0].source, pathname) }).toEqual({ pathname, redirected: false })
    // Unknown /phone/ paths are the app's routes: the page answers them (rewrites run after real files).
    const fallback = rewrites.filter((rule) => onHost(rule, HOST))
    expect(fallback).toEqual([
      { source: "/phone/:path*", has: [{ type: "host", value: HOST }], destination: "/phone/index.html" },
    ])
  })

  test("vectordev.ai sends /phone to the phone origin instead of serving it", async () => {
    const { redirects } = await vercel()
    for (const host of ["vectordev.ai", "www.vectordev.ai"]) {
      const rule = redirects.find((item) => onHost(item, host))
      expect(rule?.source).toBe("/phone/:path*")
      expect(rule?.destination).toBe(`${PHONE_ORIGIN}/phone/:path*`)
      for (const pathname of ["/phone", "/phone/", "/phone/devices"]) expect(matches(rule!.source, pathname)).toBe(true)
    }
  })

  test("the deploy builds the phone app before the website, so the copy finds it", async () => {
    const { buildCommand } = await vercel()
    const steps = buildCommand.split("&&").map((step) => step.trim())
    expect(steps).toEqual([
      "bun --cwd packages/app run build:phone",
      "bun --cwd packages/web build",
      "node script/prune-vector-site.mjs",
    ])
    const astro = await readFile(path.join(ROOT, "packages", "web", "astro.config.mjs"), "utf8")
    expect(astro).toContain("phoneApp({")
    expect(astro).toContain('"../app/dist-phone/"')
    expect(astro).toContain('"./dist/phone/"')
  })
})

describe("phone alerts become listable (A37 and A38)", () => {
  const NAMES = [
    "VECTOR_VAPID_PUBLIC_KEY",
    "VECTOR_VAPID_PRIVATE_KEY",
    "VECTOR_VAPID_SUBJECT",
    "VECTOR_PHONE_APP_ORIGIN",
    "MODEL_PLANS_ENABLED",
    "CODIUM_LISTED_PERKS",
    "KV_REST_API_URL",
    "KV_REST_API_TOKEN",
    "UPSTASH_REDIS_REST_URL",
    "UPSTASH_REDIS_REST_TOKEN",
    "CODIUM_STRIPE_MODE",
    "STRIPE_SECRET_KEY",
    "VERCEL_ENV",
  ]
  const saved = new Map(NAMES.map((name) => [name, process.env[name]]))
  beforeEach(() => {
    for (const name of NAMES) delete process.env[name]
  })
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
  // RFC 8291 appendix A's application-server key pair, a published test key (also test/web-push.test.ts's).
  const configure = () =>
    Object.assign(process.env, {
      VECTOR_VAPID_PUBLIC_KEY:
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
      VECTOR_VAPID_PRIVATE_KEY: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
      VECTOR_VAPID_SUBJECT: "https://vectordev.ai/support",
      VECTOR_PHONE_APP_ORIGIN: PHONE_ORIGIN,
    })

  test("ready only with the VAPID keys and the phone app's origin", async () => {
    const ready = () => perkServices.alerts?.(fetch)
    expect(await ready()).toBe(false)
    configure()
    expect(await ready()).toBe(true)
    delete process.env.VECTOR_PHONE_APP_ORIGIN
    expect(await ready()).toBe(false)
    process.env.VECTOR_PHONE_APP_ORIGIN = "http://remote.vectordev.ai"
    expect(await ready()).toBe(false)
    process.env.VECTOR_PHONE_APP_ORIGIN = PHONE_ORIGIN
    process.env.VECTOR_VAPID_PRIVATE_KEY = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"
    expect(await ready()).toBe(false)
  })

  test("listed once the owner lists it, and gone while the push switch is off", async () => {
    configure()
    Object.assign(process.env, {
      MODEL_PLANS_ENABLED: "true",
      CODIUM_LISTED_PERKS: "alerts",
      KV_REST_API_URL: "https://store.example.test",
      KV_REST_API_TOKEN: "fixture-kv-token",
      CODIUM_STRIPE_MODE: "test",
      VERCEL_ENV: "preview",
    })
    const switches = new Map<string, string>()
    // Each case gets its own fetcher: the switch cache is kept per fetcher.
    const store = () => async (_url: string | URL | Request, init?: RequestInit) => {
      const [command, key] = JSON.parse(String(init?.body)) as string[]
      const result = command === "SMEMBERS" ? [] : command === "GET" ? (switches.get(key) ?? null) : null
      return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
    }
    expect(await listedPerks(store() as typeof fetch)).toEqual(new Set(["alerts"]))
    switches.set(switchKey("push"), "off")
    expect(await listedPerks(store() as typeof fetch)).toEqual(new Set())
    switches.delete(switchKey("push"))
    delete process.env.VECTOR_VAPID_PUBLIC_KEY
    expect(await listedPerks(store() as typeof fetch)).toEqual(new Set())
  })
})
