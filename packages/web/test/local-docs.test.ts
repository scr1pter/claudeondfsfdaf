import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Option, Schema } from "effect"
import { ConfigManaged } from "@vectordevai/core/config/managed"
import { LocalPolicy } from "@vectordevai/core/local-mode/policy"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { docsNav } from "../src/data/docs-nav"
import { release111 } from "../src/data/vector-releases"
import { pruneVectorSite } from "../../../script/prune-vector-site.mjs"

// The Vector Local page (/docs/local) and the admin samples it shows: the samples are read as Vector reads company
// policy, and the page says what Vector Local is and is not, in the words the copy deck sets.
const web = path.join(import.meta.dir, "..")
const page = (await Bun.file(path.join(web, "src/pages/docs/local.astro")).text()).replace(/\s+/g, " ")
const text = page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")
const sample = await Bun.file(path.join(web, "src/data/local/vector.json")).text()
const profile = path.join(web, "src/data/local/ai.vector.managed.mobileconfig")
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

test("Vector Local has a page of its own, labelled with the release that brings it", () => {
  const features = docsNav.find((group) => group.label === "Features")?.links ?? []
  expect(features.find((link) => link.id === "local")).toMatchObject({ title: "Vector Local" })
  expect(features.find((link) => link.id === "local")?.blurb).toStartWith(release111.since)
  expect(page).toContain('<DocsPage id="local">')
  expect(text).toContain("{release111.since} Vector Local is in the desktop app and the engine it starts.")
  // The terminal's commands and WSL wait for a CLI release, and the page says so.
  expect(text).toContain("come with the next CLI release")
  expect(text).toContain("Windows WSL servers get Vector Local once a later desktop release requires that CLI.")
})

test("the page says Vector Local is a policy, not a firewall, and keeps to the copy rules", () => {
  expect(text).toContain(
    "Vector Local is a policy inside Vector, not a firewall. A person with administrator rights on the computer can remove the policy or run another program. Pair Vector Local with your network controls.",
  )
  expect(text).toContain("Ignored a policy file that standard users can change.")
  expect(text).toContain("Set by your company. Ask your administrator to change it.")
  expect(text).toContain("Free models provided by Vector")
  expect(text).toContain(
    "Ollama on Windows listens on 127.0.0.1 only. Use WSL mirrored networking, or run Ollama inside WSL. Setting OLLAMA_HOST=0.0.0.0 exposes it to your whole network.",
  )
  // What is not built yet says so.
  expect(text).toContain("does not read the mirror yet")
  expect(text).toContain("are read in a later release")
  for (const word of [/project/i, /\bexactly\b/i, /never exceeds/i, /absolute privacy/i, /controlled only by you/i])
    expect(text).not.toMatch(word)
})

test("the policy sample is one Vector reads as written: locked, on, with the company's servers", () => {
  const config = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(ConfigV1.Info))(sample))
  expect(config).toBeDefined()
  const policy = LocalPolicy.resolve({ managed: config!.local, global: { endpoints: ["http://127.0.0.1:11434"] } })
  expect(policy.warnings).toEqual([])
  expect(policy).toMatchObject({
    enabled: true,
    lock: true,
    web: "network",
    user_may: ["endpoints", "web"],
    locked_keys: ["model", "small_model"],
    updates: { url: "https://mirror.corp.example.com/vector/" },
  })
  expect(policy.endpoints).toEqual([
    { origin: "https://llm.corp.example.com", from: "managed" },
    { origin: "https://*.ml.corp.example.com", from: "managed" },
    { origin: "http://127.0.0.1:11434", from: "user" },
  ])
  // The model servers the provider sends to are on the company's list.
  expect(
    LocalPolicy.decide(policy, {
      purpose: "inference",
      url: `${config!.provider!.company!.options!.baseURL}/chat/completions`,
    }).decision,
  ).toBe("allow")
  // The page shows the sample as it is.
  expect(page).toContain("{policyJson}")
})

test("the Windows script's single line is a policy the registry reader takes as it is", () => {
  // The page's script joins the lines with -replace '\s*\r?\n\s*', ''.
  expect(page).toContain("-replace '\\\\s*\\\\r?\\\\n\\\\s*', ''")
  const line = sample.replace(/\s*\r?\n\s*/g, "")
  const query = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Vector\r\n    Config    REG_SZ    ${line}\r\n\r\n`
  expect(ConfigManaged.parseRegistry(query)).toEqual({ text: line })
  expect(JSON.parse(line)).toEqual(JSON.parse(sample))
})

test.skipIf(process.platform !== "darwin")("the macOS profile holds the same settings as the policy sample", () => {
  const converted = Bun.spawnSync(["/usr/bin/plutil", "-convert", "json", "-o", "-", profile])
  expect(converted.exitCode).toBe(0)
  // The profile's payload is what macOS writes to /Library/Managed Preferences/ai.vector.managed.plist.
  const payload = JSON.parse(converted.stdout.toString()).PayloadContent[0]
  expect(payload.PayloadType).toBe("ai.vector.managed")
  const read = JSON.parse(ConfigManaged.parseManagedPlist(JSON.stringify(payload)))
  const json = JSON.parse(sample)
  expect(read).toEqual({
    share: json.share,
    autoupdate: json.autoupdate,
    model: json.model,
    small_model: json.small_model,
    local: json.local,
  })
})

test("the site's prune keeps the Vector Local page", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "vector-local-docs-"))
  directories.push(directory)
  await mkdir(path.join(directory, "docs", "local"), { recursive: true })
  await writeFile(path.join(directory, "index.html"), "<html></html>")
  await writeFile(
    path.join(directory, "docs", "local", "index.html"),
    "<html><head><title>Vector Local</title></head></html>",
  )
  await pruneVectorSite(directory)
  expect(await readdir(path.join(directory, "docs", "local"))).toEqual(["index.html"])
})
