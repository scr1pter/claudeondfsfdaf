import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { providerAllowed } from "@vectordevai/core/provider-policy"
import { Provider } from "@/provider/provider"
import { Env } from "@/env"
import { Plugin } from "@/plugin"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dir, "../../../..")
const notices = new Set([
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "packages/ui/LICENSE",
  "packages/http-recorder/LICENSE",
  "DEPENDENCY_NOTICES.md",
])
const borrowedClients = /Ov23li8tweQw6odWQebz|app_EMoamEEZ73f0CkXaXp7hrann|b1a00492-073a-47ea-816f-4c329264a828/
// Sign in with ChatGPT used the Codex CLI client and is off by default since 23 October 2026
// (docs/vector/owner-actions/chatgpt.md); only the provider policy may still carry that client.
const chatgptClient = { file: "packages/core/src/provider-policy.ts", id: "app_EMoamEEZ73f0CkXaXp7hrann" }

async function trackedText() {
  const command = Bun.spawn(["git", "ls-files", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const output = await new Response(command.stdout).text()
  expect(await command.exited).toBe(0)
  const names = output.split("\0").filter(Boolean)
  // Opening every tracked file at once runs past Windows' open-file limit (EMFILE) once the
  // repository holds several thousand files, so read them in bounded batches.
  const batches = Array.from({ length: Math.ceil(names.length / 256) }, (_, index) =>
    names.slice(index * 256, (index + 1) * 256),
  )
  return batches.reduce(
    async (read, batch) => [
      ...(await read),
      ...(await Promise.all(
        batch.map(async (name) => {
          if (notices.has(name) || name.startsWith("licenses/")) return { name, text: "" }
          const file = Bun.file(path.join(root, name))
          const text = (await file.exists()) ? Buffer.from(await file.arrayBuffer()).toString("latin1") : ""
          return { name, text }
        }),
      )),
    ],
    Promise.resolve<{ name: string; text: string }[]>([]),
  )
}

const tracked = trackedText()

function containsHolder(text: string, holder: string) {
  const lower = text.toLowerCase()
  return [Buffer.from(holder), Buffer.from(holder, "utf16le"), Buffer.from(holder, "utf16le").swap16()].some((bytes) =>
    lower.includes(bytes.toString("latin1")),
  )
}

async function upstreamHolder() {
  // The prohibited name is never written literally in tracked text. This guard and
  // packages/core/src/flag/legacy.ts (which imports the earlier product's environment and
  // accepts its default server username) both derive it from the required MIT notice.
  // Bundles that include legacy.ts embed the notice text, so binary audits count those
  // extra hits as legal attribution.
  const license = await Bun.file(path.join(root, "THIRD_PARTY_NOTICES.md")).text()
  const attribution = license.split("<!-- vector-upstream-attribution -->")[1]?.split("\n## ").slice(0, 2).join("\n## ")
  const holder = attribution
    ?.match(/^Copyright \(c\) \d{4} (.+)$/m)?.[1]
    ?.trim()
    .toLowerCase()
  if (!holder) throw new Error("The upstream MIT copyright notice is missing")
  return holder
}

describe("Vector source independence", () => {
  test("tracked paths and binary contents keep the upstream holder only in license notices", async () => {
    const holder = await upstreamHolder()
    const violations = (await tracked).flatMap(({ name, text }) => {
      if (notices.has(name) || name.startsWith("licenses/")) return []
      return [
        ...(name.toLowerCase().includes(holder) ? [`path: ${name}`] : []),
        ...(containsHolder(text, holder) ? [`content: ${name}`] : []),
      ]
    })
    expect(violations).toEqual([])
  })

  test("the name scan detects mixed-case bytes after NUL and both UTF-16 byte orders", async () => {
    const holder = await upstreamHolder()
    for (const bytes of [
      Buffer.from(holder.toUpperCase()),
      Buffer.from(holder.toUpperCase(), "utf16le"),
      Buffer.from(holder.toUpperCase(), "utf16le").swap16(),
    ]) {
      const binary = Buffer.concat([Buffer.from([0, 255, 0]), bytes, Buffer.from([0, 127])])
      expect(containsHolder(binary.toString("latin1"), holder)).toBe(true)
    }
    expect(containsHolder(Buffer.from([0, 255, 0, 127]).toString("latin1"), holder)).toBe(false)
  })

  test("request construction uses Vector identities and no borrowed app registrations", async () => {
    const violations = (await tracked).flatMap(({ name, text }) => {
      if (!/^(?:packages\/[^/]+\/src\/|api\/)/.test(name) || /\.(?:test|spec)\./.test(name)) return []
      const identities = [
        ...text.matchAll(/(?:["']?(?:User-Agent|originator)["']?|USER_AGENT)\s*[:=]\s*(["'`])([^"'`]+)\1/gi),
        ...text.matchAll(/(?:set|setHeader)\(["'](?:User-Agent|originator)["'],\s*(["'`])([^"'`]+)\1/gi),
      ]
      const scanned = name === chatgptClient.file ? text.replaceAll(chatgptClient.id, "") : text
      return [
        ...(borrowedClients.test(scanned) ? [`borrowed registration: ${name}`] : []),
        ...identities.filter((match) => !/^vector(?:[\/\s]|$)/i.test(match[2])).map((match) => `${name}: ${match[0]}`),
      ]
    })
    expect(violations).toEqual([])
  })
})

const it = testEffect(LayerNode.compile(LayerNode.group([Provider.node, Env.node, Plugin.node])))
it.instance(
  "explicit custom providers load without entering the built-in catalog",
  () =>
    Effect.gen(function* () {
      expect(providerAllowed("unlisted-fixture-provider")).toBe(false)
      const providers = yield* Provider.use.list()
      expect(Object.values(providers).find((provider) => provider.id === "unlisted-fixture-provider")).toMatchObject({
        source: "config",
        options: { apiKey: "fixture-credential" },
      })
    }),
  {
    trusted: true,
    config: {
      provider: {
        "unlisted-fixture-provider": {
          npm: "@ai-sdk/openai-compatible",
          options: { apiKey: "fixture-credential", baseURL: "http://127.0.0.1:1" },
          models: { example: { name: "Example" } },
        },
      },
    },
  },
)

it.instance("a GitHub token alone never loads Copilot models or selects a Copilot default", () =>
  Effect.gen(function* () {
    const env = yield* Env.Service
    yield* env.set("GITHUB_TOKEN", "fixture-github-token")
    yield* env.remove("OPENAI_API_KEY")
    const providers = yield* Provider.use.list()
    expect(Object.keys(providers).some((id) => id.startsWith("github-copilot"))).toBe(false)
    const selected = yield* Provider.use.defaultModel().pipe(Effect.option)
    expect(selected._tag === "Some" && selected.value.providerID.startsWith("github-copilot")).toBe(false)
  }),
)

it.instance("a GitHub token does not take the default model from an OpenAI key", () =>
  Effect.gen(function* () {
    const env = yield* Env.Service
    yield* env.set("GITHUB_TOKEN", "fixture-github-token")
    yield* env.set("OPENAI_API_KEY", "fixture-openai-key")
    const providers = yield* Provider.use.list()
    expect(Object.keys(providers).some((id) => id.startsWith("github-copilot"))).toBe(false)
    expect(String((yield* Provider.use.defaultModel()).providerID)).toBe("openai")
  }),
)

for (const format of ["mjs", "js"]) {
  for (const credential of ["configured", "environment", "missing"]) {
    test(`GitLab ${format} ${credential} credentials never discover a saved sign-in`, async () => {
      await using directory = await tmpdir()
      const authFile = path.join(directory.path, "data", await upstreamHolder(), "auth.json")
      await Bun.write(
        authFile,
        JSON.stringify({
          gitlab: { type: "oauth", access: "fixture-borrowed-token", refresh: "fixture-refresh", expires: 0 },
        }),
      )
      const sdk = path.join(
        path.dirname(Bun.resolveSync("gitlab-ai-provider/package.json", import.meta.dir)),
        "dist",
        `index.${format}`,
      )
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
            import fs from "node:fs"
            import { mock } from "bun:test"
            const reads = []
            mock.module("fs", () => ({
              ...fs,
              readFileSync: (filename, ...args) => {
                if (String(filename) === ${JSON.stringify(authFile)}) reads.push(String(filename))
                return fs.readFileSync(filename, ...args)
              },
            }))
            const unexpectedRequests = []
            // The SDK's eager default instance cannot accept an injected fetch.
            // This isolated process blocks any accidental OAuth refresh before import.
            globalThis.fetch = async (input) => {
              unexpectedRequests.push(String(input))
              return new Response("Unexpected credential refresh", { status: 400 })
            }
            const sdk = ${format === "mjs" ? "await import" : "require"}(${JSON.stringify(sdk)})
            const importReads = reads.length
            const requests = []
            const provider = sdk.createGitLab({
              apiKey: ${credential === "configured" ? '"fixture-configured-pat"' : "undefined"},
              fetch: async (input, init) => {
                requests.push({ url: String(input), authorization: new Headers(init.headers).get("authorization") })
                return new Response("Unauthorized fixture", { status: 401 })
              },
            })
            const models = [
              provider.agenticChat("duo-chat-sonnet-4-5"),
              provider.agenticChat("duo-chat-gpt-5-1"),
              provider.workflowChat("duo-workflow"),
            ]
            models[2].selectedModelRef = "fixture-model"
            const errors = []
            for (const model of models) {
              await model.doStream({ prompt: [{ role: "user", content: [{ type: "text", text: "fixture" }] }] })
                .then(() => errors.push("Unexpected success"), error => errors.push(error.message))
            }
            await new Promise(resolve => setTimeout(resolve, 10))
            console.log(JSON.stringify({ importReads, reads, unexpectedRequests, requests, errors }))
          `,
        ],
        {
          cwd: directory.path,
          env: {
            HOME: directory.path,
            XDG_DATA_HOME: path.join(directory.path, "data"),
            XDG_CONFIG_HOME: path.join(directory.path, "config"),
            XDG_CACHE_HOME: path.join(directory.path, "cache"),
            ...(credential === "missing" ? {} : { GITLAB_TOKEN: "fixture-environment-pat" }),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [output, error, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ exit, error }).toEqual({ exit: 0, error: "" })
      const result = JSON.parse(output)
      // Bun intercepts ESM filesystem imports; CommonJS safety is checked by
      // observing refresh requests and credentials at the actual SDK boundary.
      if (format === "mjs") {
        expect(result.importReads).toBe(0)
        expect(result.reads).toEqual([])
      }
      expect(result.unexpectedRequests).toEqual([])
      expect(result.errors).toHaveLength(3)
      if (credential === "missing") {
        expect(result.requests).toEqual([])
        expect(result.errors.every((error: string) => error.includes("API key is missing"))).toBe(true)
        return
      }
      expect(result.requests).toHaveLength(6)
      expect(result.requests.map((request: { authorization: string }) => request.authorization)).toEqual(
        Array(6).fill(credential === "configured" ? "Bearer fixture-configured-pat" : "Bearer fixture-environment-pat"),
      )
      expect(result.errors.every((error: string) => error.includes("401"))).toBe(true)
    })
  }
}
