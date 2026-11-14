export * as LocalSources from "./sources"

import type { LocalMode } from "@vectordevai/schema/local-mode"
import { Hands } from "@vectordevai/schema/hands"
import { sha256 } from "../util/sha256"
import { LocalPolicy } from "./policy"

// Every connection Vector makes, as data: what it is for, where it goes, what it sends, why Vector makes it, and how it
// behaves with Vector Local on. Each source has one labelling call site per runtime; `callSites` lists the files that
// make the request today and `planned` the files later phases add. The network log, the "Off in Vector Local" labels
// and the compliance test all read this list, so a new connection is added here first.

export type Source = {
  readonly id: string
  readonly purpose: LocalMode.Purpose
  /** Hosts the source reaches. Empty when the user or their company chooses the host. */
  readonly hosts: readonly string[]
  readonly sends: string
  readonly why: string
  readonly local: LocalMode.SourceLocal
  readonly where: readonly LocalMode.Where[]
  readonly callSites: readonly string[]
  readonly planned?: readonly string[]
  /** Shown beside the source, such as a server that passes requests on. */
  readonly note?: string
}

const VECTOR = ["vectordev.ai"]

// Cloud AI services a user may not list as a model server of their own. A company's managed file can still list one,
// such as a private Azure OpenAI deployment, which is then labelled as listed by the company. Each entry covers the
// names under it, and a `*` inside a name stands for one label, such as a region or a resource name, so a vendor
// that only serves AI is listed by its domain and a general cloud by the names of its AI services. `cloudHosts` adds
// every provider address in a model catalog: the engine's config resolution passes the bundled catalog's at start and
// adds each catalog the engine loads (`Config.localCatalog`), and `Egress.resolve` takes a catalog too.
export const CLOUD_INFERENCE_HOSTS = [
  "openai.com",
  "chatgpt.com",
  "anthropic.com",
  "claude.ai",
  // Azure: OpenAI, AI Services, AI Foundry and the serverless model endpoints, each per resource or region.
  "openai.azure.com",
  "cognitiveservices.azure.com",
  "services.ai.azure.com",
  "models.ai.azure.com",
  "inference.ai.azure.com",
  "inference.ml.azure.com",
  "cognitive.microsoft.com",
  // Google: Gemini, and Vertex AI with its regional and Regional Endpoint Platform names.
  "generativelanguage.googleapis.com",
  "aiplatform.googleapis.com",
  "*-aiplatform.googleapis.com",
  "aiplatform.*.rep.googleapis.com",
  // AWS Bedrock, its agents, FIPS and VPC endpoint forms, and Bedrock's OpenAI-compatible endpoint.
  "bedrock.*.amazonaws.com",
  "bedrock-fips.*.amazonaws.com",
  "bedrock-runtime.*.amazonaws.com",
  "bedrock-runtime-fips.*.amazonaws.com",
  "bedrock-agent-runtime.*.amazonaws.com",
  "bedrock-agent-runtime-fips.*.amazonaws.com",
  "bedrock-runtime.*.vpce.amazonaws.com",
  "bedrock-agent-runtime.*.vpce.amazonaws.com",
  "bedrock-mantle.*.api.aws",
  "inference.generativeai.*.oci.oraclecloud.com",
  "ml.cloud.ibm.com",
  "githubcopilot.com",
  "models.github.ai",
  "ai-gateway.vercel.sh",
  "gateway.ai.cloudflare.com",
  "api.cloudflare.com",
  "openrouter.ai",
  "x.ai",
  "groq.com",
  "deepseek.com",
  "mistral.ai",
  "together.ai",
  "together.xyz",
  "fireworks.ai",
  "deepinfra.com",
  "cerebras.ai",
  "sambanova.ai",
  "perplexity.ai",
  "cohere.com",
  "cohere.ai",
  "ai21.com",
  "voyageai.com",
  "replicate.com",
  "studio.nebius.com",
  "studio.nebius.ai",
  "tokenfactory.nebius.com",
  "siliconflow.cn",
  "siliconflow.com",
  "novita.ai",
  "hyperbolic.xyz",
  "featherless.ai",
  "chutes.ai",
  "venice.ai",
  "upstage.ai",
  "friendli.ai",
  "inference.net",
  "lambda.ai",
  "moonshot.ai",
  "moonshot.cn",
  "kimi.com",
  "dashscope.aliyuncs.com",
  "dashscope-*.aliyuncs.com",
  "z.ai",
  "bigmodel.cn",
  "minimax.io",
  "minimaxi.com",
  "router.huggingface.co",
  "api-inference.huggingface.co",
  "endpoints.huggingface.cloud",
  "integrate.api.nvidia.com",
  "nvcf.nvidia.com",
  "inference.baseten.co",
  "api.baseten.co",
  "inference.do-ai.run",
  "zenmux.ai",
  "api.llmgateway.io",
  "api.kilo.ai",
  "api.poe.com",
  "ollama.com",
]

// Cloud AI services a user may not list either, by the SHA-256 of their domain, so the name stays out of this
// repository: the Zen gateway. Each covers the names under it, as CLOUD_INFERENCE_HOSTS' entries do.
const CLOUD_INFERENCE_DIGESTS = new Set(["15f3d522b114416a3a7cacfa7426bb80a64c3dcd6bb6ed5cf490037bb78d28c9"])

// What a `${VARIABLE}` in a catalog address is read as while the address is parsed.
const PLACEHOLDER = "vector-variable"

/** Whether a host is, or is under, a cloud AI service listed by its digest. */
export function digestListed(input: string, digests: ReadonlySet<string> = CLOUD_INFERENCE_DIGESTS) {
  const name = LocalPolicy.host(input)
  if (!name) return false
  // A plain-JavaScript digest, so the app's policy in the browser lists the same hosts as the engine's.
  const labels = name.split(".")
  return labels.some((_, index) => digests.has(sha256(labels.slice(index).join("."))))
}

/**
 * The cloud AI hosts with every provider address in a model catalog added: a provider's `api`, and a model's own. A
 * provider on this computer or the user's network (Ollama, LM Studio) is left out, and a `${VARIABLE}` in an address,
 * such as a region, reads as `*`.
 */
export function cloudHosts(
  catalog: Readonly<
    Record<
      string,
      {
        readonly api?: string
        readonly models?: Readonly<Record<string, { readonly provider?: { readonly api?: string } }>>
      }
    >
  >,
) {
  const addresses = Object.values(catalog).flatMap((provider) => [
    provider.api,
    ...Object.values(provider.models ?? {}).map((model) => model.provider?.api),
  ])
  const hosts = addresses.flatMap((address) => {
    const written = address?.trim().replace(/\$\{[^}]*\}/g, PLACEHOLDER)
    if (!written || !URL.canParse(written)) return []
    const url = new URL(written)
    if (url.protocol !== "http:" && url.protocol !== "https:") return []
    // An address that is all variable, such as `${BASE_URL}`, reads as a name with no dot and is left out.
    return LocalPolicy.hostClass(url.hostname) === "internet" ? [url.hostname.replaceAll(PLACEHOLDER, "*")] : []
  })
  return [...new Set([...CLOUD_INFERENCE_HOSTS, ...hosts])]
}

export const SOURCES: readonly Source[] = [
  {
    id: "local-inference",
    purpose: "inference",
    hosts: [],
    sends: "Prompts, the files and pages the agent read, and memory it recalled",
    why: "Runs the agent, subagents, the judge, Vectorscope, research and the helpers on the model servers you list",
    local: "allowed",
    where: ["engine"],
    callSites: [
      "packages/engine/src/provider/provider.ts",
      "packages/llm/src/route/executor.ts",
      "packages/core/src/effect/app-node-platform.ts",
      "packages/engine/src/plugin/openai/ws.ts",
      "packages/core/src/local-mode/probe.ts",
    ],
  },
  {
    id: "local-server-check",
    purpose: "integration",
    hosts: [],
    sends: "Requests for a model server's name, version and models, and a larger-context copy you ask for; no prompts",
    why: "Finds model servers on this computer, checks a server you add, and checks a listed server's identity before its first model call",
    local: "allow-with-reason",
    where: ["engine"],
    callSites: ["packages/core/src/local-mode/probe.ts", "packages/core/src/local-mode/servers/ollama.ts"],
    note: "Reaches this computer and the servers on your list; add a server to the list, or allow this source, to check another one",
  },
  {
    id: "cloud-inference",
    purpose: "inference",
    hosts: CLOUD_INFERENCE_HOSTS,
    sends: "Prompts, the files and pages the agent read, and memory it recalled",
    why: "Runs models from cloud AI services you connected",
    local: "not-allowable",
    where: ["engine"],
    callSites: [
      "packages/engine/src/provider/provider.ts",
      "packages/llm/src/route/executor.ts",
      "packages/core/src/effect/app-node-platform.ts",
      "packages/engine/src/plugin/openai/ws.ts",
      "packages/core/src/plugin/provider/google-vertex.ts",
      "packages/engine/src/plugin/snowflake-cortex.ts",
      "packages/core/src/plugin/provider/snowflake-cortex.ts",
      "packages/engine/src/plugin/github-copilot/models.ts",
    ],
    note: "Allowed only when your company's policy lists the host, labelled Company endpoint (listed by your company)",
  },
  {
    id: "ollama-cloud-models",
    purpose: "inference",
    hosts: ["ollama.com"],
    sends: "Prompts and context, through the Ollama app on this computer",
    why: "Ollama's cloud models run on ollama.com even when Ollama runs here",
    local: "not-allowable",
    where: ["engine"],
    callSites: ["packages/engine/src/provider/provider.ts"],
    note: "The local Ollama app forwards these models to ollama.com",
  },
  {
    id: "vector-free-models",
    purpose: "inference",
    hosts: [...VECTOR, "openrouter.ai"],
    sends: "Prompts and context",
    why: "Free models provided by Vector",
    local: "not-allowable",
    where: ["engine"],
    callSites: ["packages/core/src/free-models.ts", "packages/core/src/session/runner/free-model-route.ts"],
  },
  {
    id: "vector-codium",
    purpose: "inference",
    hosts: VECTOR,
    sends: "Prompts and context",
    why: "Vector Codium models",
    local: "not-allowable",
    where: ["engine"],
    callSites: ["packages/core/src/model-plans.ts", "packages/core/src/session/runner/model-plan-route.ts"],
  },
  {
    id: "chatgpt-signin",
    purpose: "account",
    hosts: ["auth.openai.com", "chatgpt.com"],
    sends: "Your ChatGPT sign-in",
    why: "Sign in with ChatGPT",
    local: "not-allowable",
    where: ["engine"],
    callSites: [
      "packages/engine/src/plugin/openai/ws.ts",
      "packages/engine/src/plugin/openai/codex.ts",
      "packages/core/src/plugin/provider/openai.ts",
    ],
  },
  {
    id: "model-catalog",
    purpose: "catalog",
    hosts: VECTOR,
    sends: "Your Vector version",
    why: "Refreshes the list of models and their prices",
    local: "blocked",
    where: ["engine"],
    callSites: ["packages/core/src/model-catalog.ts"],
  },
  {
    id: "free-models-catalog",
    purpose: "catalog",
    hosts: VECTOR,
    sends: "Your Vector version",
    why: "Lists the free models provided by Vector",
    local: "blocked",
    where: ["engine"],
    callSites: ["packages/core/src/free-models.ts"],
  },
  {
    id: "plans-catalog",
    purpose: "catalog",
    hosts: VECTOR,
    sends: "Your Vector version and sign-in",
    why: "Lists Vector Codium plans and credits",
    local: "blocked",
    where: ["engine"],
    callSites: ["packages/core/src/model-plans.ts"],
  },
  {
    id: "provider-policy",
    purpose: "policy",
    hosts: VECTOR,
    sends: "Your Vector version",
    why: "Reads which sign-in methods Vector may offer",
    local: "blocked",
    where: ["engine"],
    callSites: ["packages/core/src/provider-remote-policy.ts"],
  },
  {
    id: "vector-account",
    purpose: "account",
    hosts: VECTOR,
    sends: "Your Vector sign-in",
    why: "Signs you in to Vector and checks your licence",
    local: "blocked",
    where: ["engine", "desktop"],
    callSites: [
      "packages/engine/src/cli/vector-account.ts",
      "packages/engine/src/cli/cmd/github.app.ts",
      "packages/desktop/src/main/vector-account.ts",
    ],
  },
  {
    id: "teams",
    purpose: "account",
    hosts: VECTOR,
    sends: "Your Vector sign-in and team",
    why: "Team membership and your organization's shared config",
    local: "blocked",
    where: ["engine"],
    callSites: ["packages/core/src/teams/client.ts", "packages/engine/src/config/config.ts"],
  },
  {
    id: "usage-checkin",
    purpose: "usage",
    hosts: VECTOR,
    sends: "Your version, platform and a count of sessions",
    why: "Counts active installs",
    local: "blocked",
    where: ["engine", "desktop"],
    callSites: ["packages/desktop/src/main/usage-checkin.ts", "packages/engine/src/cli/usage-report.ts"],
  },
  {
    id: "crash-reports",
    purpose: "crash",
    hosts: [],
    sends: "Error reports from the app, when you turned them on",
    why: "Finds crashes in the app",
    local: "blocked",
    where: ["renderer"],
    callSites: [
      "packages/app/src/entry.tsx",
      "packages/desktop/src/renderer/index.tsx",
      "packages/desktop/src/main/egress-filter.ts",
    ],
  },
  {
    id: "telemetry",
    purpose: "telemetry",
    hosts: [],
    sends: "Traces, to the OpenTelemetry endpoint you configured",
    why: "Your own tracing setup",
    local: "allow-with-reason",
    where: ["engine"],
    callSites: ["packages/core/src/observability.ts"],
  },
  {
    id: "support-report",
    purpose: "support",
    hosts: VECTOR,
    sends: "The report you write and the logs you attach",
    why: "Sends a support report you asked to send",
    local: "allow-with-reason",
    where: ["desktop"],
    callSites: ["packages/desktop/src/main/bug-report.ts"],
  },
  {
    id: "release-notes",
    purpose: "release-notes",
    hosts: VECTOR,
    sends: "Your Vector version",
    why: "Shows what changed in a new version",
    local: "blocked",
    where: ["renderer"],
    callSites: ["packages/app/src/context/highlights.tsx", "packages/desktop/src/main/egress-filter.ts"],
  },
  {
    id: "site-assets",
    purpose: "asset",
    hosts: VECTOR,
    sends: "Nothing but the request",
    why: "Loads the pictures in release notes",
    local: "blocked",
    where: ["renderer"],
    callSites: ["packages/app/src/components/dialog-release-notes.tsx", "packages/desktop/src/main/egress-filter.ts"],
    note: "Vector's icon is bundled with the app, so notifications and the sidebar load none",
  },
  {
    id: "updates",
    purpose: "updates",
    hosts: VECTOR,
    sends: "Your version and platform",
    why: "Checks for and downloads new versions",
    local: "ask-once",
    where: ["engine", "desktop"],
    callSites: [
      "packages/desktop/src/main/updater.ts",
      "packages/desktop/src/main/egress-filter.ts",
      "packages/engine/src/cli/upgrade.ts",
      "packages/engine/src/cli/cmd/upgrade.ts",
      "packages/engine/src/installation/standalone.ts",
      "packages/engine/src/installation/index.ts",
    ],
    note: "Automatic checks are off; a check you start asks each time, and a company mirror is allowed",
  },
  {
    id: "help-assistant",
    purpose: "help",
    hosts: VECTOR,
    sends: "Your question",
    why: "Answers questions about Vector",
    local: "blocked",
    where: ["desktop"],
    callSites: ["packages/desktop/src/main/help-assistant.ts"],
    note: "Off with Vector Local on; a question to it says so",
  },
  {
    id: "share",
    purpose: "share",
    hosts: VECTOR,
    sends: "The session you share",
    why: "Share links",
    local: "allow-with-reason",
    where: ["engine"],
    callSites: ["packages/core/src/share/transport.ts", "packages/engine/src/share/session.ts"],
  },
  {
    id: "embedding-model",
    purpose: "model-download",
    hosts: ["huggingface.co"],
    sends: "Nothing but the download request",
    why: "Downloads the memory-search model once",
    local: "ask-once",
    where: ["engine"],
    callSites: ["packages/core/src/brain/embed.ts"],
  },
  {
    id: "dictation-model",
    purpose: "model-download",
    hosts: ["huggingface.co"],
    sends: "Nothing but the download request",
    why: "Downloads the dictation model once",
    local: "ask-once",
    where: ["renderer"],
    callSites: ["packages/app/src/workers/local-transcription.worker.ts", "packages/desktop/src/main/egress-filter.ts"],
    note: "With Vector Local on, dictation uses the model only when it is already on this computer",
  },
  {
    id: "ripgrep-download",
    purpose: "tool-download",
    hosts: ["github.com", "objects.githubusercontent.com"],
    sends: "Your platform",
    why: "Downloads ripgrep for search when it is not installed",
    local: "ask-once",
    where: ["engine"],
    callSites: ["packages/core/src/ripgrep/binary.ts"],
  },
  {
    id: "lsp-install",
    purpose: "lsp-install",
    hosts: ["registry.npmjs.org", "proxy.golang.org", "rubygems.org", "github.com"],
    sends: "The language server's name and your platform",
    why: "Installs language servers for code intelligence",
    local: "ask-once",
    where: ["engine"],
    callSites: ["packages/engine/src/lsp/server.ts", "packages/core/src/npm.ts"],
  },
  {
    id: "npm-plugins",
    purpose: "plugin",
    hosts: ["registry.npmjs.org"],
    sends: "The package names in your config",
    why: "Installs plugins and provider packages you configured",
    local: "ask-once",
    where: ["engine"],
    callSites: ["packages/core/src/npm.ts"],
  },
  {
    id: "remote-config",
    purpose: "config-remote",
    hosts: [],
    sends: "Your Vector version",
    why: "Reads config and skills from addresses in your config",
    local: "allow-with-reason",
    where: ["engine"],
    callSites: [
      "packages/engine/src/config/config.ts",
      "packages/core/src/skill/discovery.ts",
      "packages/engine/src/session/instruction.ts",
      "packages/engine/src/cli/cmd/providers.ts",
    ],
  },
  {
    id: "mcp-remote",
    purpose: "mcp",
    hosts: [],
    sends: "Tool calls and their arguments",
    why: "Remote MCP servers you configured",
    local: "allow-with-reason",
    where: ["engine"],
    callSites: ["packages/engine/src/mcp/index.ts", "packages/engine/src/cli/cmd/mcp.ts"],
  },
  {
    id: "github",
    purpose: "integration",
    hosts: ["github.com", "api.github.com", ...VECTOR],
    sends:
      "Pull requests, review comments, your GitHub sign-in, and in GitHub Actions the workflow's identity token for the Vector GitHub App",
    why: "Pull requests and reviews on GitHub",
    local: "allow-with-reason",
    where: ["engine", "desktop"],
    callSites: [
      "packages/engine/src/cli/cmd/github.shared.ts",
      "packages/engine/src/cli/cmd/github.auth.ts",
      "packages/engine/src/cli/cmd/github.handler.ts",
      "packages/engine/src/cli/cmd/github.attachment.ts",
      "packages/engine/src/cli/cmd/review.ts",
      "packages/desktop/src/main/github-pr.ts",
      "packages/desktop/src/main/github-api.ts",
    ],
    note: "GitHub Enterprise on your network can be listed instead",
  },
  {
    id: "gitlab",
    purpose: "integration",
    hosts: ["gitlab.com"],
    sends: "Merge requests and your GitLab sign-in",
    why: "Merge requests on GitLab",
    local: "allow-with-reason",
    where: ["desktop"],
    callSites: ["packages/desktop/src/main/gitlab.ts"],
  },
  {
    id: "vector-cloud",
    purpose: "integration",
    hosts: ["api.vercel.com", "vercel.com", "api.supabase.com", "supabase.com"],
    sends: "Your Vercel and Supabase sign-ins and the changes you ask for",
    why: "Vector Cloud runs your Vercel and Supabase accounts",
    local: "allow-with-reason",
    where: ["desktop"],
    callSites: ["packages/desktop/src/main/cloud-vercel-api.ts", "packages/desktop/src/main/cloud-supabase-api.ts"],
  },
  {
    id: "git-remote",
    purpose: "git-remote",
    hosts: [],
    sends: "Your repository's commits and git credentials",
    why: "Vector's own fetches and pushes for worktrees, reviews and pull requests",
    local: "allow-with-reason",
    where: ["engine"],
    callSites: [
      "packages/core/src/git.ts",
      "packages/engine/src/git/index.ts",
      "packages/engine/src/worktree/index.ts",
      "packages/engine/src/review/source.ts",
    ],
    note: "Decided on the remote's host before git starts",
  },
  {
    id: "webfetch",
    purpose: "web-page",
    hosts: [],
    sends: "The address the agent reads",
    why: "Reads a web page for the agent, after your approval",
    local: "allowed",
    where: ["engine"],
    callSites: ["packages/engine/src/tool/webfetch.ts", "packages/core/src/tool/webfetch.ts"],
    note: "Follows Web access",
  },
  {
    id: "computer-bridge",
    purpose: "integration",
    hosts: ["127.0.0.1"],
    sends: "Capability checks and authenticated computer commands, including requested input",
    why: `Connects to the desktop bridge for ${Hands.NAME} on this computer`,
    local: "allowed",
    where: ["engine"],
    callSites: ["packages/engine/src/computer/availability.ts", "packages/engine/src/computer/transport.ts"],
    note: `${Hands.SHORT} is off when Web access is None. These requests stay on this computer; cancellation and lease cleanup remain available.`,
  },
  {
    id: "agent-browser",
    purpose: "browser",
    hosts: [],
    sends: "The pages the agent opens and what it types there",
    why: "The browser the agent drives, after your approval",
    local: "allowed",
    where: ["desktop", "engine"],
    callSites: [
      "packages/desktop/src/main/browser-agent.ts",
      "packages/desktop/src/main/egress-filter.ts",
      "packages/engine/src/tool/browser.ts",
    ],
    note: "Follows Web access",
  },
  {
    id: "research-reader",
    purpose: "research-reader",
    hosts: [],
    sends: "The addresses research reads",
    why: "Reads pages for Deep research, after your approval",
    local: "allowed",
    where: ["engine"],
    callSites: [
      "packages/engine/src/tool/research-read.ts",
      "packages/engine/src/tool/research-run.ts",
      "packages/core/src/tool/research-read.ts",
      "packages/core/src/tool/research-run.ts",
      "packages/core/src/research/reader.ts",
    ],
    note: "Follows Web access, the run's approval and where each address came from",
  },
  {
    id: "research-browser",
    purpose: "research-browser",
    hosts: [],
    sends:
      "The pages each research agent's own browser opens, what it types into search fields, and research's searches, as Google's or DuckDuckGo's results page for the query",
    why: "Each Deep research agent reads pages and searches in a browser of its own, with no cookies or sign-ins",
    local: "allowed",
    where: ["desktop", "engine"],
    callSites: [
      "packages/core/src/local-mode/egress-proxy.ts",
      "packages/core/src/research/search.ts",
      "packages/core/src/tool/research-search.ts",
      "packages/desktop/src/main/research-proxy.ts",
      "packages/desktop/src/main/research-browser.ts",
      "packages/desktop/src/main/research-search-page.ts",
      "packages/desktop/src/main/egress-filter.ts",
      "packages/engine/src/tool/research-browser.ts",
      "packages/engine/src/tool/research-search.ts",
    ],
    note: "Goes through Vector's research proxy, which never reaches this computer, your network or a cloud metadata address. Each address an agent opens, each results page a search loads, and each request their pages make, follows Web access as it is now",
  },
  {
    id: "external-agents",
    purpose: "integration",
    hosts: [],
    sends: "Whatever those programs send",
    why: "Runs Claude Code, Codex or Cursor as outside agents",
    local: "blocked",
    where: ["desktop"],
    callSites: ["packages/desktop/src/main/external-agents.ts"],
    note: "Not started with Vector Local on: they make their own connections, which Vector Local does not see",
  },
  {
    id: "unlabelled",
    purpose: "unknown",
    hosts: [],
    sends: "Whatever the request carries",
    why: "A connection no part of Vector labelled, which Vector's network guard sees",
    local: "blocked",
    where: ["engine", "desktop"],
    callSites: ["packages/core/src/local-mode/guard.ts", "packages/desktop/src/main/egress-filter.ts"],
    note: "Reaches only this computer and the model servers on your list; anything else the guard sees is blocked and logged with the code that made it. That covers Vector's worker threads: the threads of a process share one policy and one log, so the blocks of the terminal UI's main thread and of its workers are in the engine's log. The brain's reader is sealed instead: it refuses every connection off this computer and logs none, since it makes none of its own. Worker threads are covered under Bun when started through the global Worker or the worker_threads module, and under Node when their first import is the guard, as the brain's reader's is. The guard does not see Bun.fetch, a fetch, WebSocket or Bun.connect kept from before it started, Bun.SQL or Bun.RedisClient, or under Bun the ws package, whose one use in Vector (the OpenAI WebSocket transport) decides each model call itself, pooled sockets included, and the undici package, whose fetch is Bun.fetch there, so the GitHub requests of vector github are not seen. A request for a model server on your list on this computer or your network goes direct: one the proxy settings would still send to a proxy is refused, with a note to add its host to NO_PROXY. A listed server with an internet name may go through your company's proxy. The terminal UI's syntax highlighting downloads grammars from github.com in a worker thread, so with Vector Local on, including when it is turned on while the terminal UI runs, those downloads are blocked and logged",
  },
  {
    id: "chromium-network",
    purpose: "unknown",
    hosts: [],
    sends:
      "Name lookups, early connections and certificate checks for the hosts the app's windows and browsers name, and the proxy setup file a system set to find its proxy names",
    why: "Chromium makes these itself for the pages it shows, below the layer where Vector decides each request",
    local: "not-covered",
    where: ["desktop"],
    callSites: ["packages/desktop/src/main/egress-filter.ts", "packages/desktop/src/main/local-mode.ts"],
    note: "Vector decides and logs every request Chromium makes for its windows, the agent's browser, the research browsers and the updater. Some traffic happens below that and is not in the network log. Chromium may look up a name a page links to before the request Vector refuses: Vector Local turns that name prefetching off when Vector starts, so after Vector Local is turned on it stops only once Vector restarts. A page can still have Chromium look up and connect to a host it names with a preconnect link, without sending a request, and Vector Local does not stop that. With Vector Local on, WebRTC uses no UDP. Its TCP goes through a research browser's proxy, and Vector's own windows run only the app. The agent's browser has no WebRTC peer connections and no WebTransport in its pages, in the frames they make and in their dedicated workers, but a shared or service worker a page starts still has WebTransport, and its connections are not in the network log. QUIC is off from the next start. The Electron smoke checks the agent's browser on macOS; it has not run on Windows or Linux yet. A system set to find its proxy itself (WPAD or a proxy setup file) has Chromium fetch that file. The operating system checks the certificates of the sites the windows load (revocation lists and OCSP on macOS and Windows). On Windows and Linux, Vector Local points Chromium's spellcheck dictionary downloads at this computer",
  },
  {
    id: "agent-programs",
    purpose: "unknown",
    hosts: [],
    sends: "Whatever those programs send",
    why: "Shell commands, stdio MCP servers and language servers make their own connections",
    local: "not-covered",
    where: ["engine"],
    callSites: ["packages/engine/src/tool/shell.ts"],
    note: "With Web access None the shell sandbox blocks the agent's shell commands on macOS and Linux. Stdio MCP servers and language servers run outside the sandbox, and Windows has no such block",
  },
]

const BY_ID = new Map(SOURCES.map((source) => [source.id, source]))

/**
 * The registry source a model call to `url` is decided and logged as: a cloud AI service, known by its host whether or
 * not a company lists it (cloud-inference, which only the company's own listing lets through, labelled as listed by
 * the company), or else a model server someone hosts (local-inference), listed or not. An Ollama cloud model, which a
 * server on the list passes on, is told apart by its name where the model is known.
 */
export function inference(url: string | URL) {
  const name = URL.canParse(String(url)) ? new URL(String(url)).hostname : ""
  if (!name || LocalPolicy.hostClass(name) !== "internet") return "local-inference"
  const cloud = CLOUD_INFERENCE_HOSTS.some((pattern) => LocalPolicy.hostMatches(name, pattern)) || digestListed(name)
  return cloud ? "cloud-inference" : "local-inference"
}

export function get(id: string) {
  return BY_ID.get(id)
}
