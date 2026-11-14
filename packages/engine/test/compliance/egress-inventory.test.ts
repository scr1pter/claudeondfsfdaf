import { describe, expect, test } from "bun:test"
import path from "node:path"
import { LocalSources } from "@vectordevai/core/local-mode/sources"

// Vector Local's inventory of connections (plan section 4.5), as a lint over the engine's, core's and the llm package's
// source: every file that makes a connection of its own (a global fetch, a WebSocket, an http or https request, a raw
// socket, or Effect's HTTP client) is a call site the source registry lists, or is listed below with why it needs no
// source of its own; each connection and each HTTP client request is labelled or decided where it is made, or excused
// one by one; and every file that writes an http or https address is a call site or says why it needs none. A new
// connection is added to the registry first. Dependency code (npm's installer, the embedding model's downloader) is
// covered by the backstop guard, not by this lint. The end-to-end check that nothing else connects is the strict-guard
// run in test/local-mode/local-run.test.ts.

const ROOT = path.resolve(import.meta.dir, "../../../..")

// What makes a connection, read with comments taken out: a call, or a global fetch handed on as a parameter's default.
// A function or method named fetch, whose first parameter has a type, is a declaration, not a call.
const CALLS: readonly RegExp[] = [
  /(?<![\w.$])(?<!function\s+)fetch\((?!\s*\w+\??\s*:)/g,
  /globalThis\.fetch\(/g,
  /=\s*fetch\s*[,)]/g,
  // The global fetch chosen as a fallback and called (`(options.fetch ?? fetch)(url)`), or handed on as a property.
  /\bfetch\)\(/g,
  /\b\w+:\s*fetch\s*[,})]/g,
  /new WebSocket\(/g,
  /\bhttps?\.(?:request|get)\(/g,
  /\bnet\.(?:connect|createConnection)\(/g,
  /\btls\.connect\(/g,
  /\{\s*connect\s*\}\s*=\s*(?:await\s+)?import\(\s*"node:(?:tls|net)"\s*\)/g,
  /Bun\.connect\(/g,
]
// Effect's HTTP client, which a call site labels for the requests it makes with it (EgressHttpClient.labelled).
const PRIMITIVES: readonly RegExp[] = [...CALLS, /HttpClient\.HttpClient\b/g]
// Each request a file that holds the HTTP client makes with it: one built (HttpClientRequest.get and its kin) and one
// sent (`.execute(`, the client's own or WebFetchRequest's).
const HOLDS_CLIENT = /HttpClient\.HttpClient\b|WebFetchRequest\.execute\b/
const REQUESTS: readonly RegExp[] = [
  /\bHttpClientRequest\.(?:get|post|put|patch|del|delete|head|options|make)\(/g,
  /\.execute\(/g,
]
const connects = (text: string) => PRIMITIVES.some((primitive) => new RegExp(primitive.source).test(text))

// What labels or decides a connection where it is made.
const GATE =
  /Egress\.(?:fetch|decide|policy|record)\b|EgressHttpClient\.|EgressAttribution\.granted|LocalPolicy\.decide|webAccess\(|githubFetch\(|Git\.refusal/
// How far before a call (in lines) the gate deciding it may be: a decision, then the request built and sent.
const BEFORE = 25
// How far after an HTTP client request its label may be: the request is built, piped through its options, then
// labelled (`.pipe(…, EgressHttpClient.labelled(source))`).
const AFTER = 12

// Files that connect, or hold the HTTP client, but make no request a source would name.
const WITHOUT_SOURCE: Readonly<Record<string, string>> = {
  "packages/core/src/plugin/internal.ts": "Hands plugins the HTTP client; it sends nothing itself.",
  "packages/engine/src/util/effect-http-client.ts": "Retry helpers for the HTTP client; it sends nothing itself.",
  "packages/engine/src/server/shared/ui.ts": "Takes the HTTP client but serves the embedded web UI from disk.",
  "packages/engine/src/server/routes/instance/httpapi/server.ts": "Provides the HTTP client to the server's routes.",
  "packages/core/src/local-mode/egress.ts": "Vector Local's own send: every labelled request goes out here.",
  "packages/core/src/local-mode/http-client.ts": "Vector Local's labelled HTTP client, which sends through Egress.",
  "packages/core/src/util/webfetch-request.ts":
    "The pinned fetch webfetch, remote skills and instruction URLs send through; each caller labels its requests.",
  "packages/core/src/oauth/page.ts": "A sign-in page's script, which runs in the browser that opened the page.",
  "packages/core/src/aisdk.ts":
    "The V2 AI SDK service's model fetch, which no runner sends through yet; the backstop guard decides it as unlabelled, and a V2 turn's model is refused under Vector Local before a route is built.",
  // A provider's sign-in and its signed-in fetch take the global fetch as a default. Sign-in is not labelled yet: the
  // backstop guard decides it as unlabelled, so with Vector Local on it reaches only this computer and the list, and a
  // signed-in model's calls go through provider.ts's model call decision first.
  "packages/core/src/oauth/copilot.ts": "GitHub Copilot's sign-in token exchange, decided by the backstop guard.",
  "packages/core/src/oauth/device.ts": "A provider's device sign-in, decided by the backstop guard.",
  "packages/core/src/oauth/openrouter.ts": "OpenRouter's sign-in exchange, decided by the backstop guard.",
  "packages/core/src/oauth/digitalocean.ts":
    "DigitalOcean's sign-in and its model router list, decided by the backstop guard.",
  "packages/core/src/oauth/owned.ts":
    "A signed-in provider's fetch, which provider.ts's model call decision sends through.",
  "packages/engine/src/tool/vector-cloud.ts":
    "The desktop app's bridge on this computer; the desktop makes Vector Cloud's requests (vector-cloud).",
  "packages/engine/src/control-plane/dev/debug-workspace-plugin.ts": "A development-only workspace plugin.",
  // Not labelled yet: the backstop guard decides these as unlabelled, so with Vector Local on they reach only this
  // computer and the model servers on the list.
  "packages/engine/src/control-plane/workspace.ts": "Experimental remote workspaces, decided by the backstop guard.",
  "packages/engine/src/server/routes/instance/httpapi/middleware/proxy.ts":
    "Experimental remote workspaces' proxy, decided by the backstop guard.",
  "packages/engine/src/server/routes/instance/httpapi/middleware/workspace-routing.ts":
    "Experimental remote workspaces' routing, decided by the backstop guard.",
}

// Call sites of the registry that consult Vector Local through another file, and how. Every other call site of an
// engine source consults it itself.
const DECIDED_ELSEWHERE: Readonly<Record<string, string>> = {
  "packages/engine/src/tool/research-search.ts":
    "Decides each results page a search loads with ResearchSearch.reachable (core research/search.ts) before it asks the desktop's research browser.",
  "packages/core/src/tool/research-search.ts":
    "Decides each results page a search loads with ResearchSearch.reachable (research/search.ts) before it asks the desktop's research browser.",
  "packages/llm/src/route/executor.ts":
    "Sends through the HTTP client LayerNodePlatform.requestExecutor gives it, which decides each request as a model call (EgressHttpClient.models).",
  "packages/core/src/plugin/provider/snowflake-cortex.ts":
    "A V2 route's model calls are refused before the route is built (SessionRunnerModel.allowedInLocal); a V1 call goes through provider.ts's fetch first.",
  "packages/core/src/plugin/provider/google-vertex.ts":
    "A V2 route's model calls are refused before the route is built (SessionRunnerModel.allowedInLocal); a V1 call goes through provider.ts's fetch first.",
  "packages/engine/src/git/index.ts":
    "Decides each git command that connects with Git.refusal (core git.ts) before git starts: the review's and the GitHub handler's fetches and pushes.",
  "packages/engine/src/review/source.ts":
    "Fetches a review's commits through Git.run (git/index.ts), which decides each fetch.",
  "packages/engine/src/worktree/index.ts":
    "Decides each git command that connects with Git.refusal (core git.ts) before git starts: a reset's fetch, a submodule update.",
  "packages/core/src/research/reader.ts":
    "Sends with the client its caller hands it, which tool/research-read.ts and tool/research-run.ts label research-reader.",
}

// The http and https addresses a file writes. One on this computer, a reserved example name, or one built from parts
// (`http://${host}`, `http://[${address}]`) is not a destination of its own.
const ADDRESS = /["'`]https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g
const NOT_A_DESTINATION =
  /^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|vector\.internal)$|\.localhost$|(?:^|\.)example(?:\.(?:com|org|net))?$|\.(?:test|invalid)$/

const MODEL_API =
  "A model API's address: model calls go through provider.ts's model call decision (V1) or the request executor's (EgressHttpClient.models), and go only to a listed server under Vector Local."
const GATEWAY =
  "A model gateway's address, and Vector's as the HTTP-Referer the gateway reads, sent inside model calls that provider.ts's decision or the request executor's decides."
const SHOWN = "An address written into config or shown to people; nothing here connects to it."
const SIGN_IN = "A provider's sign-in addresses, handed to the sign-in helpers the backstop guard decides."
const GIT = "A GitHub address for git; each of Vector's git commands is decided before git starts (Git.refusal)."

// Files that write an address but are not call sites, each with why that address needs no source of its own.
const ADDRESSES: Readonly<Record<string, string>> = {
  "packages/core/src/brain/embed-manifest.ts":
    "The embedding model's download addresses, which brain/embed.ts fetches as embedding-model.",
  "packages/core/src/config/migration.ts": SHOWN,
  "packages/core/src/github-copilot/copilot-provider.ts": MODEL_API,
  "packages/core/src/model-plan-status.ts":
    "Codium's addresses; it sends with the transport its caller hands it, model-plans.ts's plans-catalog in the engine.",
  "packages/core/src/npm-config.ts": "npm's default registry, which npm.ts reaches as npm-plugins or lsp-install.",
  "packages/core/src/oauth/poe.ts": SIGN_IN,
  "packages/core/src/plugin/provider/cloudflare-workers-ai.ts": MODEL_API,
  "packages/core/src/plugin/provider/digitalocean.ts": MODEL_API,
  "packages/core/src/plugin/provider/gitlab.ts": MODEL_API,
  "packages/core/src/plugin/provider/kilo.ts": GATEWAY,
  "packages/core/src/plugin/provider/llmgateway.ts": GATEWAY,
  "packages/core/src/plugin/provider/nvidia.ts": GATEWAY,
  "packages/core/src/plugin/provider/openrouter.ts": GATEWAY,
  "packages/core/src/plugin/provider/poe.ts": MODEL_API,
  "packages/core/src/plugin/provider/vector.ts":
    "Free models' address, which only the free model route sends to (vector-free-models); free models are off under Vector Local.",
  "packages/core/src/plugin/provider/vercel.ts": GATEWAY,
  "packages/core/src/plugin/provider/xai.ts": MODEL_API,
  "packages/core/src/plugin/provider/zenmux.ts": GATEWAY,
  "packages/core/src/provider-policy.ts": "The sign-in origins Vector accepts for each provider; it connects to none.",
  "packages/core/src/public-session-share.ts": SHOWN,
  "packages/core/src/repository.ts": GIT,
  "packages/core/src/research/export.ts":
    "The Office Open XML namespace names a .docx export writes into the file; nothing connects to them.",
  "packages/core/src/review/fix-proposal.ts":
    "The canonical GitHub remote accepted by the proposal validator; it connects to nothing and grants no execution.",
  "packages/core/src/review/format.ts": SHOWN,
  "packages/core/src/session/runner/model.ts": MODEL_API,
  "packages/engine/src/cli/cmd/github.git.ts": GIT,
  "packages/engine/src/cli/cmd/github.review.ts": GIT,
  "packages/engine/src/cli/cmd/pr.ts": GIT,
  "packages/engine/src/config/local-settings.ts":
    "Addresses vector local check asks Vector Local's decision about without connecting: a documentation address no network routes, and vectordev.ai.",
  "packages/engine/src/config/schema.ts": SHOWN,
  "packages/engine/src/config/tui-migrate.ts": SHOWN,
  "packages/engine/src/mcp/oauth-provider.ts":
    "Vector's address in the client details it registers for an MCP server's sign-in; nothing here connects to it.",
  "packages/engine/src/plugin/digitalocean.ts": MODEL_API,
  "packages/engine/src/plugin/github-copilot/copilot.ts": MODEL_API,
  "packages/engine/src/plugin/gitlab.ts": MODEL_API,
  "packages/engine/src/plugin/poe.ts": MODEL_API,
  "packages/engine/src/plugin/xai.ts": MODEL_API,
  "packages/engine/src/provider/transform.ts":
    "OpenAI's API address, compared with a model's configured address to decide whether prompt cache boundaries apply; nothing here connects to it.",
  "packages/engine/src/server/routes/instance/httpapi/handlers/teams.ts": SHOWN,
  "packages/engine/src/util/repository.ts": GIT,
  "packages/llm/src/protocols/anthropic-messages.ts": MODEL_API,
  "packages/llm/src/protocols/gemini.ts": MODEL_API,
  "packages/llm/src/protocols/openai-chat.ts": MODEL_API,
  "packages/llm/src/protocols/openai-responses.ts": MODEL_API,
  "packages/llm/src/providers/amazon-bedrock.ts": MODEL_API,
  "packages/llm/src/providers/cloudflare.ts": MODEL_API,
  "packages/llm/src/providers/openai-compatible-profile.ts": MODEL_API,
}

// Each address `text` writes that is a destination of its own.
const addresses = (text: string) =>
  [...text.matchAll(ADDRESS)].map((match) => match[1].toLowerCase()).filter((host) => !NOT_A_DESTINATION.test(host))

// Comments are taken out with their lines kept, so a call's line number is the file's.
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, "")).replace(/(^|[^:\\])\/\/.*$/gm, "$1")

async function sources() {
  const files = await Array.fromAsync(new Bun.Glob("packages/{core,engine,llm}/src/**/*.{ts,tsx}").scan({ cwd: ROOT }))
  return Promise.all(
    files
      .map((file) => file.replaceAll("\\", "/"))
      .filter((file) => !/\.test\.tsx?$/.test(file))
      .toSorted()
      .map(async (file) => ({ file, text: strip(await Bun.file(path.join(ROOT, file)).text()) })),
  )
}

// Connections a call site makes without a label where it makes them, one by one, each with why that is safe. Each names
// the file and a piece of its line; a call that is not here must be labelled or decided within BEFORE lines of it.
const UNLABELLED_CALLS: ReadonlyArray<{ readonly file: string; readonly call: string; readonly why: string }> = [
  {
    file: "packages/core/src/plugin/provider/google-vertex.ts",
    call: "fetch(input, { ...init, headers })",
    why: "Vertex's signed request, sent by provider.ts's model call decision (V1) or refused before a V2 route is built.",
  },
  {
    file: "packages/core/src/plugin/provider/snowflake-cortex.ts",
    call: "upstream: FetchLike = fetch",
    why: "Cortex's request rewrite; provider.ts decides the model call before this fetch runs.",
  },
  {
    file: "packages/core/src/session/runner/model-plan-route.ts",
    call: "await fetch(input, init)",
    why: "Calls the fetch the route was given; Vector Codium is refused under Vector Local before a route is built.",
  },
  {
    file: "packages/engine/src/plugin/openai/codex.ts",
    call: "return fetch(request, requestInit)",
    why: "ChatGPT sign-in's HTTP requests inside provider.ts's fetch, which decides each model call before it runs.",
  },
  {
    file: "packages/engine/src/plugin/openai/ws.ts",
    call: "new WebSocket(options.url, connect)",
    why: "ChatGPT sign-in's Responses socket, opened only once route() in the same file decides its model call (Egress.decide), or with the decision the pool made for that call.",
  },
  {
    file: "packages/engine/src/plugin/openai/codex.ts",
    call: "httpFetch: fetch",
    why: "The HTTP fallback of ChatGPT sign-in's WebSocket transport, inside provider.ts's fetch; ws.ts decides each socket.",
  },
  {
    file: "packages/core/src/model-plans.ts",
    call: "(input.request ?? fetch)(CHAT_URL",
    why: "Vector Codium's own fetch, which provider.ts's model call decision sends through; Codium is off under Vector Local.",
  },
  {
    file: "packages/core/src/research/reader.ts",
    call: "WebFetchRequest.execute(options.http",
    why: "Sends with the client its caller hands it, labelled research-reader there (tool/research-read.ts, tool/research-run.ts).",
  },
  {
    file: "packages/core/src/research/reader.ts",
    call: "HttpClientRequest.get(input.url)",
    why: "Sends with the client its caller hands it, labelled research-reader there (tool/research-read.ts, tool/research-run.ts).",
  },
  {
    file: "packages/llm/src/route/executor.ts",
    call: ".execute(request)",
    why: "Sends through the HTTP client LayerNodePlatform.requestExecutor gives it, which decides each request as a model call (EgressHttpClient.models).",
  },
  {
    file: "packages/engine/src/plugin/snowflake-cortex.ts",
    call: "return fetch(requestInput, init)",
    why: "Cortex's request inside provider.ts's fetch, which decides each model call before it runs.",
  },
  {
    file: "packages/engine/src/plugin/snowflake-cortex.ts",
    call: "await fetch(requestInput, prepareRequest())",
    why: "Cortex's request inside provider.ts's fetch, which decides each model call before it runs.",
  },
  {
    file: "packages/engine/src/provider/provider.ts",
    call: "void fetch(origin, { signal: AbortSignal.abort() })",
    why: "Starts Bun's HTTP client with a request aborted before it begins; nothing is resolved, connected or sent.",
  },
  {
    file: "packages/engine/src/provider/provider.ts",
    call: "return fetch(input, { ...init, headers })",
    why: "Vertex's signed request, the send of provider.ts's model call decision.",
  },
  {
    file: "packages/engine/src/provider/provider.ts",
    call: "const response = await fetch(url, init)",
    why: "Snowflake's request rewrite, the send of provider.ts's model call decision.",
  },
  {
    file: "packages/engine/src/review/source.ts",
    call: "fetch(",
    why: "Its own helper named fetch, which runs git fetch through Git.run; each fetch is decided there.",
  },
  {
    file: "packages/engine/src/tool/browser.ts",
    call: "return fetch(`${url}/command`",
    why: "The desktop app's browser bridge on this computer; the page itself is decided before (webAccess).",
  },
  {
    file: "packages/core/src/tool/research-search.ts",
    call: "fetch(`${desktop.url}/research`",
    why: "The desktop app's browser bridge on this computer; each results page is decided before (ResearchSearch.reachable), and the desktop's research proxy decides every request a research browser makes.",
  },
  {
    file: "packages/engine/src/tool/research-browser.ts",
    call: "fetch(`${process.env.VECTOR_BROWSER_BRIDGE_URL}/research`",
    why: "The desktop app's browser bridge on this computer; each address an agent opens is decided before (webAccess), and the desktop's research proxy decides every page a research browser reaches.",
  },
]

// Each raw connection in `text`, and each HTTP client request in a file that holds the client, with its line, for files
// the inventory lists.
function calls(file: string, text: string) {
  const lines = text.split("\n")
  const found = (primitives: readonly RegExp[], after: number) =>
    primitives.flatMap((primitive) =>
      [...text.matchAll(primitive)].map((match) => {
        const line = text.slice(0, match.index).split("\n").length
        const near = lines
          .slice(Math.max(0, line - 1 - BEFORE), line + after)
          .filter((item) => !/^\s*import\b/.test(item))
          .join("\n")
        return { file, line, text: lines[line - 1].trim(), gated: GATE.test(near) }
      }),
    )
  return [...found(CALLS, 5), ...(HOLDS_CLIENT.test(text) ? found(REQUESTS, AFTER) : [])]
}

describe("Vector Local's connection inventory", () => {
  test("every file that connects is a call site in the source registry or says why it needs none", async () => {
    const listed = new Set(LocalSources.SOURCES.flatMap((source) => [...source.callSites, ...(source.planned ?? [])]))
    const connecting = (await sources()).filter((item) => connects(item.text)).map((item) => item.file)
    // The scan sees the call sites it should, so an empty result means something.
    expect(connecting).toEqual(
      expect.arrayContaining(["packages/engine/src/provider/provider.ts", "packages/core/src/model-catalog.ts"]),
    )
    expect(connecting.filter((file) => !listed.has(file) && !Object.hasOwn(WITHOUT_SOURCE, file))).toEqual([])
  })

  test("the files it excuses still exist and still connect", async () => {
    const all = new Map((await sources()).map((item) => [item.file, item.text]))
    const stale = Object.keys(WITHOUT_SOURCE).filter((file) => {
      const text = all.get(file)
      return text === undefined || !connects(text)
    })
    expect(stale).toEqual([])
  })

  test("every call site of an engine source consults Vector Local, or says which file does", async () => {
    const all = new Map((await sources()).map((item) => [item.file, item.text]))
    // webAccess (tool/webfetch.ts) is how the browser tool decides a page, and githubFetch (cli/cmd/github.shared.ts)
    // how Vector's own GitHub requests are labelled.
    const gated = (file: string) => /local-mode\/|LocalPolicy|Egress|webAccess\(|githubFetch/.test(all.get(file) ?? "")
    const sites = LocalSources.SOURCES.filter((source) => source.where.includes("engine")).flatMap((source) =>
      source.callSites.filter((file) => all.has(file)).map((file) => ({ source: source.id, file })),
    )
    expect(sites.length).toBeGreaterThan(20)
    expect(sites.filter((site) => !gated(site.file) && !Object.hasOwn(DECIDED_ELSEWHERE, site.file))).toEqual([])
    // An excuse names a call site that still exists and has not gained a gate of its own.
    const stale = Object.keys(DECIDED_ELSEWHERE).filter(
      (file) => !sites.some((site) => site.file === file) || gated(file),
    )
    expect(stale).toEqual([])
  })

  test("every file that writes an address is a call site in the source registry or says why it needs none", async () => {
    const listed = new Set(LocalSources.SOURCES.flatMap((source) => [...source.callSites, ...(source.planned ?? [])]))
    const writing = (await sources()).filter((item) => addresses(item.text).length > 0)
    // The scan sees addresses where they are, so an empty result means something.
    expect(writing.map((item) => item.file)).toEqual(
      expect.arrayContaining(["packages/core/src/model-catalog.ts", "packages/llm/src/protocols/openai-chat.ts"]),
    )
    expect(
      writing
        .filter(
          (item) =>
            !listed.has(item.file) && !Object.hasOwn(WITHOUT_SOURCE, item.file) && !Object.hasOwn(ADDRESSES, item.file),
        )
        .map((item) => `${item.file} ${[...new Set(addresses(item.text))].join(", ")}`),
    ).toEqual([])
    // An excuse names a file that still writes an address and has not become a call site.
    const all = new Map(writing.map((item) => [item.file, item.text]))
    expect(Object.keys(ADDRESSES).filter((file) => !all.has(file) || listed.has(file))).toEqual([])
  })

  test("every connection a call site makes is labelled or decided where it is made, or excused one by one", async () => {
    const found = (await sources())
      .filter((item) => !Object.hasOwn(WITHOUT_SOURCE, item.file))
      .flatMap((item) => calls(item.file, item.text))
    expect(found.filter((call) => call.gated).length).toBeGreaterThan(0)
    const excused = (call: (typeof found)[number]) =>
      UNLABELLED_CALLS.some((item) => item.file === call.file && call.text.includes(item.call))
    expect(
      found.filter((call) => !call.gated && !excused(call)).map((call) => `${call.file}:${call.line} ${call.text}`),
    ).toEqual([])
    // Each excuse still names an unlabelled call.
    expect(
      UNLABELLED_CALLS.filter(
        (item) => !found.some((call) => !call.gated && call.file === item.file && call.text.includes(item.call)),
      ),
    ).toEqual([])
  })
})
