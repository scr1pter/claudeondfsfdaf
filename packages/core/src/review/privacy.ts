// Zero data retention route rules (VectorScope upgrade contract, VS-23a, and addendum A's VS-33): which routes a review
// may send code on while `privacy` is "zdr", and which requests it may send there. Pure and browser-safe.
//
// Nothing calls this yet. VS-23b's admission (model resolution and Review.run) will call decideRoute for every model a
// review may use, and VS-23c's transport backstop will call it again at the top of resolveSDK and apply zdrRequestBody
// to the final body of a request on an "openrouter-attested" route. zdrBodyRefusal is the only body check that route
// needs: it covers the Anthropic Messages fields OpenRouter's `/api/v1/messages` takes as well. Every other allowed
// route sends its body unchanged: `provider` is OpenRouter's field, which a direct provider or a model server does not
// read. On those routes the transport, which alone can tell a request's format, checks an Anthropic or Google request
// with zdrFeatureRefusal, passing an Anthropic request's path.
//
// VS-33's Now part is here and has no caller either: the refusals from "server-tool" on, attestation objects in
// `zdrAttested` (readZdrAttestation), and the `attestations` an allowed decision lists. Admission must act on those.
// Until a verifier exists (Q20) it refuses a route while any listed attestation sets `verify: "api"`, and it refuses
// an OpenAI one with `verify: "api"` unless Q20 approves an admin credential. Only that admission's Vertex metadata call
// can give "durable-cache", so nothing here does.
//
// VS-33b (addendum B §1.1) has no caller either. zdrPathRefusal refuses a Batch or stored-file path on an OpenRouter or
// OpenAI-compatible route as "batch" (the Anthropic format keeps anthropicPathRefusal), and zdrBodyRefusal refuses
// OpenRouter's batch body first. VS-23c's backstop is to call zdrPathRefusal on every OpenRouter and OpenAI-compatible
// request (runner-wiring R1). The batch body check exists only inside zdrBodyRefusal, with its OpenRouter rules, so a
// direct OpenAI-compatible route still gets no body check until R1 gives it one.
//
// ZDR reduces retention; it cannot rule it out (invariant I-3). A provider may keep content its safety systems flag
// (Anthropic up to two years), legal holds override any agreement, and account settings Vector cannot see, such as
// OpenRouter's logging and Safety Retention, still apply. An entry in `zdrAttested` is the owner's statement about
// those; nothing here checks it.

import {
  denyDataCollection,
  isOpenRouterFreeModel,
  isOpenRouterURL,
  openRouterModelRouting,
  sendsToOpenRouter,
  sendsToOpenRouterFree,
} from "../free-model-catalog"
import { LocalPolicy } from "../local-mode/policy"
import { ModelPlanStatus } from "../model-plan-status"
import type { ReviewConfig, ZdrAttestation, ZdrAttestedEntry } from "./types"

export type ReviewPrivacy = NonNullable<ReviewConfig["privacy"]>

// Why a route or a request is refused: contract §1.2's thirteen, then VS-33's six.
// - decideRoute gives the route refusals and "extended-cache-unattested";
// - zdrBodyRefusal gives "server-tool" and "provider-options" for a body sent to OpenRouter,
//   "anthropic-non-zdr-feature" for an Anthropic Messages feature in one, and "batch" for OpenRouter's batch body;
// - zdrFeatureRefusal gives "grounding-tool" for a Google request, and "anthropic-non-zdr-feature" (or "batch") for an
//   Anthropic one;
// - zdrPathRefusal gives "batch" for a Batch or stored-file path on an OpenRouter or OpenAI-compatible route;
// - the transport backstop (VS-23c) also refuses a Batch request, through zdrPathRefusal, and a request whose session
//   cannot be told ("unattributed-request");
// - VS-23b's admission gives "durable-cache" for a Vertex project whose cache config may keep prompts.
export const ROUTE_REFUSALS = [
  "free-model",
  "router-or-preset",
  "fallback-models",
  "plugins",
  "unattested-provider",
  "unattested-openrouter",
  "unattested-network-server",
  "retention-required-model",
  "codium-unaccepted",
  "batch",
  "unreadable-body",
  "unattributed-request",
  "unknown-destination",
  "server-tool",
  "provider-options",
  "extended-cache-unattested",
  "grounding-tool",
  "durable-cache",
  "anthropic-non-zdr-feature",
] as const
export type RouteRefusal = (typeof ROUTE_REFUSALS)[number]

// How an allowed route is allowed:
// - "standard": privacy is "standard", so no rule applies, as before VS-23;
// - "loopback": a server on this computer that passes nothing on;
// - "openrouter-attested": OpenRouter on an attested account, sent with zdrRequestBody;
// - "attested-provider": an attested provider at an origin it reaches without configuration (`defaultOrigins`);
// - "attested-host": a model server or host listed in `zdrAttested`.
export type RouteKind = "standard" | "loopback" | "openrouter-attested" | "attested-provider" | "attested-host"
// `attestations` lists every attestation object in `zdrAttested` that attests one of the route's destinations, whichever
// entry decided the route, in destination order and each once, so admission sees each one it must act on. It is left
// out when there is none, so a decision from text entries alone is exactly as before VS-33.
export type RouteDecision =
  | { allowed: true; kind: RouteKind; attestations?: readonly ZdrAttestation[] }
  | { allowed: false; refusal: RouteRefusal }

export interface RouteModel {
  providerID: string
  modelID: string
  // The ID sent, when configuration sends one other than modelID (`api.id`).
  apiID?: string
  // The SDK package, such as @ai-sdk/anthropic. It is no place a request goes, but OpenRouter's names OpenRouter.
  npm?: string
  // Where requests go, as URLs: the model's and its provider's base URLs, and the origins the requests are actually
  // sent to (provider.ts requestOrigins: the base URL with its variables filled in, else the SDK's own origin, and a
  // plugin's preconnect origin). Every one must be allowed, and with none nothing says where requests go, so the caller
  // passes the SDK's default origin too. Every text here is read as a URL, so a bare name (`gpu-box`) is unknown.
  destinations: readonly unknown[]
  // The origins the provider reaches without configuration: provider.ts SDK_ORIGINS, or the catalog's URL as shipped.
  // An attestation of the provider ID covers only these, so a base URL set anywhere else needs its own host attested.
  defaultOrigins?: readonly string[]
  // The listed price, undefined when unpriced. A zero price on an OpenRouter route is free (sendsToOpenRouterFree), as
  // resolveSDK decides when it sends a model down the free route.
  price?: { readonly input: number; readonly output: number }
  // The catalog lists it as a free model.
  freeModel?: boolean
  // The server passes this model on to a service no destination names, such as an Ollama cloud model, which a local
  // Ollama server sends to ollama.com (LocalProbe holds.passesOn).
  forwards?: boolean
}

/**
 * Whether a review may send code to this model while `privacy` is `policy.privacy`. `policy.attested` is
 * `zdrAttested`: provider IDs (`openrouter` for an OpenRouter account) and model server hosts, with a port for that
 * port alone or without one for every port, as text or as attestation objects (readZdrAttestation) whose `id` is read
 * the same way. An entry the rules cannot read attests nothing.
 * The model's own refusals come first, so no attestation overrides them: Vector Codium, free models, routers and
 * presets, the web plugin's `:online` variant, and models whose provider requires retention. Then every destination
 * must be allowed:
 * - Vector's own site (Codium and the free route) is refused;
 * - a model whose requests go to OpenRouter needs its provider ID attested, as the account, and only a provider that
 *   reaches OpenRouter without configuration (`openrouter`, or one whose `defaultOrigins` are OpenRouter's or that has
 *   none, such as a provider defined in configuration) holds an account there; OpenRouter itself over https and a
 *   stand-in on this computer (a local proxy or a test server) pass requests on to that account, and any other hop,
 *   OpenRouter over plain http included, must be an attested host as well. An account entry that pins a `region`
 *   needs every https OpenRouter destination to be that region's host, for every region its entries name, so the
 *   caller (VS-23b) passes a URL the configuration replaces, such as the catalog's shipped URL under a provider base
 *   URL, in `defaultOrigins` and not in `destinations`;
 * - otherwise a server on this computer is allowed, a server on your network only when its host is attested, and a host
 *   on the internet when it is attested, or when the provider ID is attested and it is one of `defaultOrigins`. An
 *   entry that pins a `region` attests no host and no provider here.
 * Last, an OpenAI model that keeps its prompt cache for up to 24 hours (extendedCacheOnly) is refused unless every entry
 * that attests one of its destinations accepts that (`extendedCache: true`). A route on this computer alone has none.
 */
export function decideRoute(
  model: RouteModel,
  policy: { privacy: ReviewPrivacy; attested: readonly ZdrAttestedEntry[] },
): RouteDecision {
  if (policy.privacy === "standard") return { allowed: true, kind: "standard" }
  const refusal = modelRefusal(model)
  if (refusal) return refuse(refusal)
  if (model.forwards) return refuse("unknown-destination")
  const origins = requestOrigins(model.destinations)
  if (!origins?.length) return refuse("unknown-destination")
  // An untyped caller (a raw global config) may pass entries the rules cannot read; they attest nothing.
  const entries = policy.attested.flatMap((value, index) => readEntry(value, index))
  const named = entries.filter((entry) => entry.id === model.providerID)
  const attested = {
    // A region pins an OpenRouter account and attests nothing else.
    provider: named.filter((entry) => entry.region === undefined),
    hosts: entries.filter((entry) => entry.region === undefined && entry.host !== undefined),
    defaults: (model.defaultOrigins ?? []).flatMap((item) => LocalPolicy.origin(item.trim()) ?? []),
  }
  if (sendsToOpenRouter({ providerID: model.providerID, destinations: destinations(model) })) {
    // The owner attests one agreement per provider ID: a direct provider's covers that provider, not an OpenRouter
    // account its base URL may be moved to.
    const holds =
      model.providerID === "openrouter" || !model.defaultOrigins?.length || attested.defaults.some(isOpenRouterURL)
    return decided(model, openRouterRoute(origins, { ...attested, provider: holds ? named : [] }))
  }
  const verdicts = origins.map((origin): RouteRefusal | Allowed =>
    hostClassOf(origin) === "this-computer" ? { kind: "loopback", entries: [] } : serverVerdict(origin, attested),
  )
  const refused = verdicts.find(isRefusal)
  if (refused) return refuse(refused)
  const allowed = verdicts.filter((verdict): verdict is Allowed => !isRefusal(verdict))
  return decided(model, {
    kind: allowed.find((verdict) => verdict.kind !== "loopback")?.kind ?? "loopback",
    entries: allowed.flatMap((verdict) => verdict.entries),
  })
}

/**
 * One attestation object of `zdrAttested`, read for config.ts and decideRoute alike, or the first problem that makes it
 * attest nothing, as a phrase that follows "the entry" (with its `id` when that is readable). Every key must be one of
 * ZdrAttestation's, so a misspelt restriction fails closed; a key set to undefined is unset. "Text" is a string that is
 * not blank once trimmed and holds no control character. The result is a new object, trimmed, with only the keys set.
 */
export function readZdrAttestation(value: unknown): { attestation: ZdrAttestation } | { problem: string; id?: string } {
  const fields = record(value)
  if (!fields) return { problem: "is not an attestation object" }
  const id = plainText(fields.id)
  const named = id !== undefined && !NOT_A_NAME.test(id) ? id : undefined
  const problem = (phrase: string) => ({ problem: phrase, ...(named === undefined ? {} : { id: named }) })
  const stray = Object.keys(fields).find((key) => fields[key] !== undefined && !ATTESTATION_KEYS.includes(key))
  if (stray !== undefined) return problem(`has the unknown key ${JSON.stringify(stray)}`)
  if (typeof fields.id !== "string" || !fields.id.trim()) return problem('has no "id"')
  if (named === undefined) return problem('has an "id" that names neither a provider ID nor a host')
  const operator = fields.operator
  if (operator === undefined || (typeof operator === "string" && !operator.trim()))
    return problem('has no "operator", the platform operator that processes the data')
  const operatorText = plainText(operator)
  if (operatorText === undefined) return problem('has an "operator" that is not text')
  const project = fields.project === undefined ? undefined : plainText(fields.project)
  if (fields.project !== undefined && project === undefined) return problem('has a "project" that is not text')
  const region = fields.region
  if (region !== undefined && region !== "eu" && region !== "us")
    return problem('has a "region" other than "eu" or "us"')
  const extendedCache = fields.extendedCache
  if (extendedCache !== undefined && typeof extendedCache !== "boolean")
    return problem('has an "extendedCache" other than true or false')
  const verify = fields.verify
  if (verify !== undefined && verify !== "attest" && verify !== "api")
    return problem('has a "verify" other than "attest" or "api"')
  return {
    attestation: {
      id: named,
      operator: operatorText,
      ...(project === undefined ? {} : { project }),
      ...(region === undefined ? {} : { region }),
      ...(extendedCache === undefined ? {} : { extendedCache }),
      ...(verify === undefined ? {} : { verify }),
    },
  }
}

/**
 * Whether one of these model IDs is an OpenAI model whose prompt cache OpenAI keeps for up to 24 hours: gpt-5.5 and
 * later support only extended prompt caching, which holds KV tensors on GPU-local storage [G3-8, G4-11; OpenAI's
 * openai-openapi spec, `prompt_cache_retention`, read 2026-11-06]. The one model-version table: VS-23c reuses it for the
 * pre-gpt-5.5 retention setting. `gpt` and the version are matched anywhere in the ID, any case (`chatgpt-5.5`,
 * `openai/gpt-6`), with a `-`, a `_` or nothing between (`gpt5.5`, `gpt_5.5`). The minor version follows a dot, or a
 * `-` or `_` as one or two digits (`gpt-5-5`; a date such as `gpt-5-2025-08-07` is 5.0). A two-digit run without one is
 * major and minor, as the engine's gpt5OrNewer reads it (`gpt-55` is 5.5, Azure's `gpt-35-turbo` is 3.5, Venice's
 * `openai-gpt-54-pro` is 5.4), except from 10 to 29, which no OpenAI model has been, so a later `gpt-10` is 10. That
 * leans to refusal: an open model such as Cerebras-GPT-13B reads as 13. Update this when OpenAI names later models
 * otherwise. An ID that hides the model, such as an Azure deployment name, is not caught (admission metadata, VS-23b).
 */
export function extendedCacheOnly(ids: readonly unknown[]): boolean {
  const versions = ids.flatMap((id) => (typeof id === "string" ? [...id.toLowerCase().matchAll(GPT_VERSION)] : []))
  return versions.some((match) => {
    const run = match[1]
    const minorText = match[2] ?? match[3]
    const dotless = minorText === undefined && run.length === 2 && run[0] !== "1" && run[0] !== "2"
    const major = Number(dotless ? run[0] : run)
    const minor = Number(dotless ? run[1] : (minorText ?? 0))
    return major > 5 || (major === 5 && minor >= 5)
  })
}

/**
 * Why a request body may not go to OpenRouter on a ZDR route, or undefined when zdrRequestBody may send it. `modelID`
 * is the ID the request was made for; the body's own `model` is what OpenRouter routes on, so both are checked.
 * Besides routing and plugins, a body may call only tools that run where Vector does: any other tool is "server-tool"
 * (below), and so is a file stored with OpenRouter, which only its sandbox tools read. OpenRouter also serves Anthropic's
 * Messages API (`/api/v1/messages`), so the Messages features zdrFeatureRefusal refuses there are refused here too, as
 * "anthropic-non-zdr-feature": `mcp_servers`, `container`, `thread`, and a tool that code execution may call. Per-provider
 * `provider.options` may carry retention settings, so any but an empty object is "provider-options". A Batch API body,
 * OpenRouter's shape with a top-level `requests` list or a `callback_url`, is "batch" before any other check (VS-33b).
 */
export function zdrBodyRefusal(body: unknown, modelID: string): RouteRefusal | undefined {
  const fields = record(body)
  if (!fields) return "unreadable-body"
  // OpenRouter's Batch API body: a top-level `requests` list, each request with its own `params`, and a `callback_url`.
  // It has no top-level messages or tools for the checks below to refuse.
  if (Array.isArray(fields.requests) || given(fields, "callback_url")) return "batch"
  const named = idRefusal([modelID, fields.model])
  if (named) return named
  const routing = openRouterModelRouting(fields, undefined)
  if (routing.includes("preset")) return "router-or-preset"
  if (routing.some((field) => field !== "plugins")) return "fallback-models"
  // Any plugin list, the web plugin that keeps the model (openRouterModelRouting allows it), an empty list and one that
  // turns a plugin off included, and a web search setting: both may send the query to a search provider.
  if (["plugins", "web_search_options"].some((key) => Object.hasOwn(fields, key))) return "plugins"
  const tools = toolList(fields.tools)
  const blocks = [fields.messages, fields.input].map((list) => contentBlocks(list))
  if (!tools || blocks.some((list) => list === undefined)) return "unreadable-body"
  const choice = choiceRefusal(fields.tool_choice)
  if (choice) return choice
  if (
    !tools.every(openRouterClientTool) ||
    given(fields, "deferred_tools") ||
    blocks.some((list) => list?.some(fileReference))
  )
    return "server-tool"
  if (ANTHROPIC_NON_ZDR_FIELDS.some((key) => given(fields, key)) || tools.some(codeCallable))
    return "anthropic-non-zdr-feature"
  // Only an empty `options` object is kept; anything else, null included, counts as set (one key when not an object).
  const options = record(fields.provider)?.options
  if (options !== undefined && Object.keys(record(options) ?? { options }).length > 0) return "provider-options"
  return undefined
}

/**
 * The body a request to OpenRouter sends on a ZDR route: `provider.zdr` true and `provider.data_collection` "deny",
 * whatever the configuration set there, and every other provider preference as it was (order, only, ignore,
 * allow_fallbacks, sort, max_price, quantizations, a require_parameters already set, and an empty `options`). It never
 * adds require_parameters, which is not a privacy control, and never changes its input. Undefined, so the caller
 * refuses the request, when zdrBodyRefusal names a reason.
 */
export function zdrRequestBody(body: unknown, modelID: string): Record<string, unknown> | undefined {
  const fields = record(body)
  if (!fields || zdrBodyRefusal(fields, modelID)) return undefined
  return denyDataCollection({ ...fields, provider: { ...record(fields.provider), zdr: true } })
}

// The request formats with features of their own that zero data retention does not cover. The transport tells which
// format a request has (VS-23c). A request to OpenRouter needs no check here: zdrBodyRefusal covers its Anthropic
// Messages fields.
export type ZdrRequestFormat = "anthropic" | "google"

/**
 * Why an Anthropic or Google request may not be sent on a ZDR route, or undefined when it may. Both are allow lists, so
 * a feature newer than this file is refused, and neither changes its input. `path` is the request's URL or path, which
 * the transport must pass for an Anthropic request: without it only the body is checked, so neither Batch nor any other
 * endpoint is refused here.
 * - Google: every tool must be function calling (`functionDeclarations`, or an OpenAI-style `type: "function"` tool),
 *   so Search, Maps, URL context, retrieval, code execution and computer use are "grounding-tool" [G4 §4.2]. Nothing
 *   else is checked: the request's path, `cachedContent` and a stored Files API upload in `fileData.fileUri` are left
 *   to VS-23b and VS-23c.
 * - Anthropic: the path must be one of anthropicPathRefusal's Messages endpoints (Anthropic's, wherever the base URL
 *   puts it, and Claude's on Vertex and Bedrock), and Batch on any of them is "batch". The body may not set
 *   `mcp_servers` (the MCP connector), `container` (Agent Skills and code execution containers) or `thread` (message
 *   threads), call a tool outside the eligible list (anthropicZdrTool), or refer to a stored file (the Files API); each
 *   is "anthropic-non-zdr-feature".
 */
export function zdrFeatureRefusal(request: {
  format: ZdrRequestFormat
  body: unknown
  path?: string
}): RouteRefusal | undefined {
  if (request.format !== "google" && request.path !== undefined) {
    const refused = anthropicPathRefusal(request.path)
    if (refused) return refused
  }
  const fields = record(request.body)
  const tools = toolList(fields?.tools)
  if (!fields || !tools) return "unreadable-body"
  if (request.format === "google") return tools.every(googleFunctionTool) ? undefined : "grounding-tool"
  const blocks = contentBlocks(fields.messages)
  if (!blocks) return "unreadable-body"
  if (
    ANTHROPIC_NON_ZDR_FIELDS.some((key) => given(fields, key)) ||
    !tools.every(anthropicZdrTool) ||
    blocks.some(fileReference)
  )
    return "anthropic-non-zdr-feature"
  return undefined
}

/**
 * Why an OpenRouter or OpenAI-compatible request may not go to this path on a ZDR route: "batch" for a Batch API or a
 * stored file, which the provider keeps beyond the request. Every path BATCH_ENDPOINT names (Anthropic's Message
 * Batches, Vertex `batchPredictionJobs` and Bedrock model invocation jobs) is "batch", and so are `/v1/batches` and
 * `/v1/files` with their subpaths, after any base URL (BATCH_OR_FILES_PATH). `path` is the request's URL or path, read
 * as anthropicPathRefusal reads it; one that is not text is "unreadable-body".
 * It is a deny list, unlike anthropicPathRefusal's allow list: every other path is undefined, and decideRoute and the
 * body checks decide the rest. So an unusual spelling of a Batch path (another case, percent-encoding, a `;` parameter,
 * backslashes, or no `/v1/`) is not refused; the transport passes the URL the SDK built, which untrusted text never
 * chooses.
 * Nothing calls it yet. VS-23c's backstop is to call it on every OpenRouter and OpenAI-compatible request (runner-wiring
 * R1); the Anthropic format keeps anthropicPathRefusal, through zdrFeatureRefusal.
 */
export function zdrPathRefusal(path: unknown): RouteRefusal | undefined {
  if (typeof path !== "string") return "unreadable-body"
  const pathname = (URL.canParse(path) ? new URL(path).pathname : path.split(/[?#]/)[0]).replace(/\/+$/, "")
  return BATCH_ENDPOINT.test(pathname) || BATCH_OR_FILES_PATH.test(pathname) ? "batch" : undefined
}

// OpenRouter's `:online` variant turns on its web plugin, which sends the query to a search provider, wherever it sits
// in a stacked variant (`:online:nitro`, `:nitro:online`). From OpenRouter's model variants as recalled: its docs could
// not be read here, so VS-23c's fake server checks the wire.
const ONLINE = /:online(?:$|[:@])/
// Anthropic's Covered Models need 30-day retention and are not available under ZDR unless Anthropic expressly
// authorizes the organization: Claude Fable 5 and 5.1 and Mythos 5 and 5.1, read 2026-11-05 [enablers §1.6]. Matched
// as a token on every provider (OpenRouter, Bedrock, Vertex and aliases), so a digit may follow (`fable5`) and a letter
// may not (`fabled-coder`). Update when Anthropic changes the list.
const RETENTION_REQUIRED = /(?:^|[^a-z0-9])(?:fable|mythos)(?![a-z])/
const CODIUM_HOST = new URL(ModelPlanStatus.SITE).hostname
// An OpenAI model's version in its ID, for extendedCacheOnly: `gpt`, a `-`, a `_` or nothing, and the major version,
// with a minor one after a dot, or after a `-` or `_` as one or two digits that no digit follows.
const GPT_VERSION = /gpt[-_]?(\d+)(?:\.(\d+)|[-_](\d{1,2})(?!\d))?/g
// Text with a space, slash, user, query, fragment or backslash names neither a provider ID nor a host. config.ts reads
// text entries with it too.
export const NOT_A_NAME = /[\s/@?#\\]/
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const ATTESTATION_KEYS: readonly string[] = ["id", "operator", "project", "region", "extendedCache", "verify"]
// `tool_choice` values that pick no particular tool, and the types of one that picks a function or a tool by name.
const PLAIN_CHOICES: readonly unknown[] = ["none", "auto", "required", "any"]
const NAMED_CHOICES: readonly unknown[] = [...PLAIN_CHOICES, "function", "tool"]
// Anthropic's feature eligibility table (platform.claude.com, "API and data retention", accessed 2026-11-06) as an
// allow list: the client tools (bash, text editor, memory, computer use and browser use) run where Vector runs, and
// the server tools it marks eligible are the advisor, tool search and the basic web search and web fetch. Every other
// type is refused: the MCP connector's `mcp_toolset`, code execution, and anything newer than this list.
const ANTHROPIC_ZDR_TOOL =
  /^(?:(?:bash|text_editor|memory|computer|computer_toolset|browser_toolset|advisor)_\d{8}|tool_search_tool_(?:regex|bm25)(?:_\d{8})?|web_search_20250305|web_fetch_20250910)$/
// The Messages fields the same table marks ineligible, set to anything: the MCP connector, a container (Agent Skills and
// code execution) and a message thread.
const ANTHROPIC_NON_ZDR_FIELDS = ["mcp_servers", "container", "thread"]
// The endpoints that take one Messages request: Anthropic's Messages and token counting, at the end of any base URL
// (`/api/v1/messages` on OpenRouter), and Claude's on Vertex (`<model>:rawPredict`, `:streamRawPredict`) and on Bedrock
// (`/model/<model>/invoke`, `/invoke-with-response-stream`), as the pinned @ai-sdk/google-vertex/anthropic and
// @ai-sdk/amazon-bedrock/anthropic build them. Their Batch APIs: Anthropic's Message Batches, Vertex's
// `batchPredictionJobs` and Bedrock's `model-invocation-job`.
const MESSAGES_ENDPOINT =
  /\/v1\/messages(?:\/count_tokens)?$|\/publishers\/anthropic\/models\/[^/:]+:(?:rawPredict|streamRawPredict)$|\/model\/[^/]+\/invoke(?:-with-response-stream)?$/
const BATCH_ENDPOINT =
  /\/v1\/messages\/batches(?:\/|$)|\/batchPredictionJobs(?:[/:]|$)|\/model-invocation-jobs?(?:\/|$)/
// The Batch and Files paths addendum B §1.1 names, with their subpaths, after any base URL, for zdrPathRefusal:
// OpenRouter's Batch API (`/api/v1/batches`), which keeps data 30 days and cannot run when privacy settings require ZDR
// (its batch-api.mdx as round three read it, T3-5), and OpenAI's (`/v1/batches`) with the Files API it reads its input
// from (`/v1/files`). Vector never uploads a file, so every Files path is refused as Batch input. Only a `/v1/` path
// matches: Azure OpenAI's `/openai/batches` and a relative `batches` do not (runner-wiring R1).
const BATCH_OR_FILES_PATH = /\/v1\/(?:batches|files)(?:\/|$)/
// Web search and web fetch from 20260209 on filter results with code execution unless `allowed_callers` is ["direct"]
// (Anthropic's server tools page, "ZDR and allowed_callers", accessed 2026-11-06).
const FILTERING_WEB_TOOL = /^web_(?:search|fetch)_(\d{8})$/
const FILTERING_SINCE = "20260209"
// The keys of an OpenAI-style function tool, which Vertex's OpenAI-compatible endpoint takes.
const FUNCTION_TOOL_KEYS: readonly string[] = ["type", "function", "name", "description", "parameters", "strict"]
const FUNCTION_DECLARATIONS: readonly string[] = ["functionDeclarations", "function_declarations"]
// No request nests its content this deep; a body that does is read as unreadable rather than walked.
const MAX_NESTING = 16

// `port` is undefined when the entry named none, and then the host is attested on every port.
type AttestedHost = { host: string; port?: string }
// One readable `zdrAttested` entry, at its place in the list. Text is read both ways, as VS-23a reads it, and accepts
// no extended cache; an attestation object reads its `id` the same way and adds what the owner attests beyond it.
type Entry = {
  index: number
  id: string
  host?: AttestedHost
  extendedCache: boolean
  region?: "eu" | "us"
  attestation?: ZdrAttestation
}
type Attested = { provider: readonly Entry[]; hosts: readonly Entry[]; defaults: readonly string[] }
// A destination, or a whole route, that passed, with the entries that attest it.
type Allowed = { kind: Exclude<RouteKind, "standard">; entries: readonly Entry[] }

function modelRefusal(model: RouteModel): RouteRefusal | undefined {
  if (model.providerID === ModelPlanStatus.PROVIDER_ID) return "codium-unaccepted"
  // Vector's free models, the catalog's free flag, and anything resolveSDK would send down the free route.
  if (
    model.freeModel ||
    model.providerID === "vector" ||
    sendsToOpenRouterFree({ ...model, id: model.modelID, destinations: destinations(model), price: model.price })
  )
    return "free-model"
  return idRefusal([model.modelID, model.apiID])
}

// What decides where a model's requests go, as free-model-catalog.ts reads it: the URLs and the SDK package.
function destinations(model: RouteModel) {
  return [model.npm, ...model.destinations]
}

// The refusals a model ID alone decides, for decideRoute and for the body's own `model`: a free variant, the free
// router or a stealth model; one of OpenRouter's routers or a preset; the web plugin's variant; a Covered Model.
function idRefusal(ids: readonly unknown[]): RouteRefusal | undefined {
  const names = ids.flatMap((id) => (typeof id === "string" && id.trim() ? [id.trim().toLowerCase()] : []))
  if (names.some((id) => isOpenRouterFreeModel(id, undefined))) return "free-model"
  if (names.some((id) => openRouterModelRouting(undefined, id).length > 0)) return "router-or-preset"
  if (names.some((id) => ONLINE.test(id))) return "plugins"
  if (names.some((id) => RETENTION_REQUIRED.test(id))) return "retention-required-model"
  return undefined
}

// The http and https origins of a model's destinations, or undefined when one of them is no place a request can be
// read as going: another scheme, no host, or text that is not a URL (a bare name included). Blank values are unset.
function requestOrigins(destinations: readonly unknown[]) {
  const urls = destinations.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : []))
  const origins = urls.flatMap((item) => LocalPolicy.origin(item) ?? [])
  return origins.length === urls.length ? origins : undefined
}

// The entry at `index` of `zdrAttested`, or none when the rules cannot read it.
function readEntry(value: unknown, index: number): Entry[] {
  if (typeof value === "string") return [{ index, id: value.trim(), host: attestedHost(value), extendedCache: false }]
  const read = readZdrAttestation(value)
  if (!("attestation" in read)) return []
  const attestation = read.attestation
  return [
    {
      index,
      id: attestation.id,
      host: attestedHost(attestation.id),
      extendedCache: attestation.extendedCache === true,
      region: attestation.region,
      attestation,
    },
  ]
}

// A route that passed is refused when its model keeps its prompt cache for up to 24 hours and any entry that attests
// it does not accept that: the strictest reading across entries, so text beside an object that accepts it still
// refuses. Otherwise it is allowed, listing the attestation objects among those entries.
function decided(model: RouteModel, verdict: RouteRefusal | Allowed): RouteDecision {
  if (isRefusal(verdict)) return refuse(verdict)
  const used = verdict.entries.filter((entry, at, all) => all.findIndex((other) => other.index === entry.index) === at)
  if (used.length && extendedCacheOnly([model.modelID, model.apiID]) && !used.every((entry) => entry.extendedCache))
    return refuse("extended-cache-unattested")
  const attestations = used.flatMap((entry) => entry.attestation ?? [])
  return attestations.length
    ? { allowed: true, kind: verdict.kind, attestations }
    : { allowed: true, kind: verdict.kind }
}

// A model whose requests go to OpenRouter. OpenRouter itself over https, and a stand-in for it on this computer, pass
// requests on to the account, which `attested.provider` covers; any other hop must be an allowed server in its own
// right, and OpenRouter over plain http is such a hop, since it would carry the code and the account's key in clear.
function openRouterRoute(origins: readonly string[], attested: Attested): RouteRefusal | Allowed {
  const relays = origins.filter((origin) => isOpenRouterURL(origin) && origin.startsWith("https://"))
  const hops = origins
    .filter((origin) => !relays.includes(origin) && hostClassOf(origin) !== "this-computer")
    .map((origin) => serverVerdict(origin, { ...attested, provider: [], defaults: [] }))
  const hop = hops.find(isRefusal)
  if (hop) return hop
  if (!attested.provider.length) return "unattested-openrouter"
  // A region pin holds only when every request to OpenRouter goes to that region's host, for every region the account's
  // entries name, so two regions never hold. A stand-in on this computer alone cannot show the region.
  const regions = attested.provider.flatMap((entry) => entry.region ?? [])
  const pinned =
    relays.length > 0 &&
    relays.every((origin) =>
      regions.every((region) => hostOf(origin).replace(/\.+$/, "") === `${region}.openrouter.ai`),
    )
  if (regions.length && !pinned) return "unattested-openrouter"
  return {
    kind: "openrouter-attested",
    entries: [...attested.provider, ...hops.flatMap((verdict) => (isRefusal(verdict) ? [] : verdict.entries))],
  }
}

// A destination that is neither this computer nor OpenRouter: Vector's own site, a server on your network, or a host
// on the internet. A provider-ID attestation never covers a server on your network. The entries are every one that
// attests this destination: the hosts that match it, and the provider's when it is one of `defaultOrigins`.
function serverVerdict(origin: string, attested: Attested): RouteRefusal | Allowed {
  const host = hostOf(origin)
  if (host === CODIUM_HOST || host.endsWith(`.${CODIUM_HOST}`)) return "codium-unaccepted"
  const port = portOf(origin)
  const hosts = attested.hosts.filter(
    (item) => item.host?.host === host && (item.host.port === undefined || item.host.port === port),
  )
  const network = LocalPolicy.hostClass(host) === "your-network"
  const provider = !network && attested.defaults.includes(origin) ? attested.provider : []
  if (hosts.length) return { kind: "attested-host", entries: [...hosts, ...provider] }
  if (network) return "unattested-network-server"
  return provider.length ? { kind: "attested-provider", entries: provider } : "unattested-provider"
}

// An entry of `zdrAttested` as a host: a name or address in any case, alone for every port or with one port
// (`gpu-box:8080`, `[fd00::1]:8080`; a bare IPv6 address names no port). Undefined for a URL or anything else that
// names no host. Every entry is read both ways: `gpu-box` attests a host of that name and a provider of that ID, both
// the owner's own statement, and each reading covers only its own rule above.
function attestedHost(entry: string): AttestedHost | undefined {
  const text = entry.trim()
  const bare = LocalPolicy.host(text)
  if (bare) return { host: bare }
  if (NOT_A_NAME.test(text) || !URL.canParse(`http://${text}`)) return undefined
  const url = new URL(`http://${text}`)
  const host = LocalPolicy.host(url.hostname)
  if (!host) return undefined
  // The URL drops http's own port, so an entry that names :80 reads as no port there.
  return /:\d+$/.test(text) ? { host, port: url.port || "80" } : { host }
}

// The tools OpenRouter hands back to the caller to run: function tools (Chat Completions and Responses), custom tools
// (Responses' freeform tools, and Messages tools, which have no type), and Anthropic's client-side bash tool, which
// OpenRouter returns to the caller unless its own `openrouter:bash` shape asks for the sandbox (its bash.mdx). Every
// other type may run on a server: OpenRouter's server tools by any spelling it accepts (`openrouter:web_search`,
// `web_search`, `web_search_preview`, `web_search_20250305`, `tool_search`), and the hosted tools it passes on to a
// provider (`code_interpreter`, `file_search`, `mcp`, `image_generation`, shells).
function openRouterClientTool(tool: Record<string, unknown>) {
  if (tool.type === undefined || tool.type === "function" || tool.type === "custom") return true
  return (
    typeof tool.type === "string" &&
    /^bash_\d{8}$/.test(tool.type) &&
    tool.parameters === undefined &&
    tool.engine === undefined
  )
}

// A `tool_choice` that forces a server tool by its own type (OpenRouter's ChatServerToolChoice) is "server-tool".
function choiceRefusal(value: unknown): RouteRefusal | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return PLAIN_CHOICES.includes(value) ? undefined : "server-tool"
  const choice = record(value)
  if (!choice) return "unreadable-body"
  return NAMED_CHOICES.includes(choice.type) ? undefined : "server-tool"
}

// Google's tools are objects with one kind of tool each; only function calling keeps nothing beyond the request.
function googleFunctionTool(tool: Record<string, unknown>) {
  const set = Object.keys(tool).filter((key) => tool[key] !== undefined)
  if (tool.type === "function") return set.every((key) => FUNCTION_TOOL_KEYS.includes(key))
  return set.length > 0 && set.every((key) => FUNCTION_DECLARATIONS.includes(key) && Array.isArray(tool[key]))
}

// A tool on Anthropic's eligible list, and one that only Claude calls (not codeCallable).
function anthropicZdrTool(tool: Record<string, unknown>) {
  if (codeCallable(tool)) return false
  if (tool.type === undefined || tool.type === "custom") return true
  if (typeof tool.type !== "string") return false
  if (ANTHROPIC_ZDR_TOOL.test(tool.type)) return true
  // A filtering version needs filtering off: `allowed_callers` set, which past codeCallable means ["direct"].
  const date = FILTERING_WEB_TOOL.exec(tool.type)?.[1]
  return date !== undefined && date >= FILTERING_SINCE && tool.allowed_callers !== undefined
}

// A tool that code execution may call: `allowed_callers` set to anything but a non-empty list of "direct" alone. That
// is programmatic tool calling, which runs in a code execution container.
function codeCallable(tool: Record<string, unknown>) {
  const callers = tool.allowed_callers
  if (callers === undefined) return false
  return !(Array.isArray(callers) && callers.length > 0 && callers.every((caller) => caller === "direct"))
}

// A path that is not one of the Messages endpoints (MESSAGES_ENDPOINT), with Batch on any of them as "batch".
function anthropicPathRefusal(path: unknown): RouteRefusal | undefined {
  if (typeof path !== "string") return "unreadable-body"
  const pathname = (URL.canParse(path) ? new URL(path).pathname : path.split(/[?#]/)[0]).replace(/\/+$/, "")
  if (BATCH_ENDPOINT.test(pathname)) return "batch"
  return MESSAGES_ENDPOINT.test(pathname) ? undefined : "anthropic-non-zdr-feature"
}

// A body's `tools`: none when unset, or a list of objects; undefined when it is anything else.
function toolList(value: unknown): Record<string, unknown>[] | undefined {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return undefined
  const tools = records(value)
  return tools.length === value.length ? tools : undefined
}

// The blocks of a message list (`messages`, or a Responses `input`) and every list nested in them (`content`, an item's
// `output`, and a custom-content document's `source.content`), the messages themselves included; undefined when they
// nest deeper than any request does.
function contentBlocks(value: unknown, depth = 0): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return []
  if (depth > MAX_NESTING) return undefined
  const items = records(value)
  const nested = items.flatMap((item) => [
    contentBlocks(item.content, depth + 1),
    contentBlocks(item.output, depth + 1),
    contentBlocks(record(item.source)?.content, depth + 1),
  ])
  if (nested.some((list) => list === undefined)) return undefined
  return [...items, ...nested.flatMap((list) => list ?? [])]
}

// A reference to a stored file: a `file_id` (OpenRouter's Files API and OpenAI-style file parts), an Anthropic file
// source, or a container upload.
function fileReference(block: Record<string, unknown>) {
  const source = record(block.source)
  return (
    block.type === "container_upload" ||
    source?.type === "file" ||
    [block.file_id, record(block.file)?.file_id, source?.file_id].some(present)
  )
}

function records(list: readonly unknown[]) {
  return list.flatMap((item): Record<string, unknown>[] => {
    const fields = record(item)
    return fields ? [fields] : []
  })
}

function present(value: unknown) {
  return value !== undefined && value !== null && !(typeof value === "string" && !value.trim())
}

function given(fields: Record<string, unknown>, key: string) {
  return Object.hasOwn(fields, key) && fields[key] !== undefined
}

function plainText(value: unknown) {
  return typeof value === "string" && value.trim() && !CONTROL.test(value) ? value.trim() : undefined
}

function hostOf(origin: string) {
  return LocalPolicy.host(new URL(origin).hostname) ?? ""
}

// The port an origin's requests use: LocalPolicy.origin leaves a scheme's own port out.
function portOf(origin: string) {
  const url = new URL(origin)
  return url.port || (url.protocol === "https:" ? "443" : "80")
}

function hostClassOf(origin: string) {
  return LocalPolicy.hostClass(hostOf(origin))
}

function isRefusal(verdict: unknown): verdict is RouteRefusal {
  return typeof verdict === "string" && (ROUTE_REFUSALS as readonly string[]).includes(verdict)
}

function refuse(refusal: RouteRefusal): RouteDecision {
  return { allowed: false, refusal }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
