import { ResearchSearch } from "@vectordevai/core/research/search"
import type { BrowserAgentInput } from "../preload/types"
import type { ResearchCommand, ResearchInput } from "./research-browser"

const COMMANDS = new Set<NonNullable<BrowserAgentInput["command"]>>([
  "attach",
  "setBounds",
  "detach",
  "closeBrowser",
  "openUrl",
  "click",
  "type",
  "press",
  "wait",
  "waitForSelector",
  "waitForText",
  "takeScreenshot",
  "inspectDom",
  "inspectComputedStyles",
  "inspectPageHtml",
  "reload",
  "goBack",
  "goForward",
  "scroll",
  "clearLogs",
  "setVisible",
  "readPage",
  "observePage",
  "clickRef",
  "typeRef",
  "selectOption",
  "hover",
  "listTabs",
  "openTab",
  "switchTab",
  "closeTab",
  "readLogs",
])

export function parseBrowserAgentInput(value: unknown): BrowserAgentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid browser command.")
  const input = value as Record<string, unknown>
  const contextId = boundedString(input.contextId, "contextId", 256)
  const command = input.command === undefined ? undefined : boundedString(input.command, "command", 64)
  if (command && !COMMANDS.has(command as NonNullable<BrowserAgentInput["command"]>)) {
    throw new Error("Unknown browser command.")
  }
  return {
    contextId,
    command: command as BrowserAgentInput["command"],
    url: optionalString(input.url, "url", 8192),
    selector: optionalString(input.selector, "selector", 4096),
    ref: optionalRef(input.ref),
    text: optionalString(input.text, "text", 64 * 1024),
    key: optionalString(input.key, "key", 64),
    allowExternal: optionalBoolean(input.allowExternal, "allowExternal"),
    visible: optionalBoolean(input.visible, "visible"),
    milliseconds: optionalNumber(input.milliseconds, "milliseconds"),
    deltaY: optionalNumber(input.deltaY, "deltaY"),
    tabId: optionalTab(input.tabId),
    values: optionalValues(input.values),
    expectOrigin: optionalString(input.expectOrigin, "expectOrigin", 2048),
    expectLabel: optionalString(input.expectLabel, "expectLabel", 300),
    settle: optionalBoolean(input.settle, "settle"),
  }
}

// Research browser commands (section 5.6a) come on their own path, POST /research, and are read here alone: their own
// commands, their own fields and nothing else, so one cannot carry a visible-browser contextId or command. The run and
// the agent's session come from the engine's tool context, never from the model, and both are plain IDs.
const RESEARCH_COMMANDS = new Set<ResearchCommand>([
  "research.open",
  "research.read",
  "research.links",
  "research.find",
  "research.observe",
  "research.click",
  "research.type",
  "research.press",
  "research.scroll",
  "research.back",
  "research.screenshot",
  "research.search",
  "research.close",
])
const RESEARCH_FIELDS = new Set([
  "command",
  "runID",
  "sessionID",
  "rootID",
  "agent",
  "max",
  "images",
  "generation",
  "provenance",
  "typed",
  "url",
  "ref",
  "text",
  "key",
  "deltaY",
  "query",
  "recency",
  "limit",
  "engines",
])
const RESEARCH_ID = /^[A-Za-z0-9_-]{1,64}$/
// A run reads at most a few hundred pages and searches; this bounds one command's copy of its addresses.
const MAX_ADDRESSES = 5_000
/** The most browsers one run may have open: the lead and its researchers. */
export const MAX_RESEARCH_BROWSERS = 9

export function parseResearchBrowserInput(value: unknown): ResearchInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid research browser command.")
  const input = value as Record<string, unknown>
  const extra = Object.keys(input).find((key) => !RESEARCH_FIELDS.has(key))
  if (extra) throw new Error(`Research browser commands take no ${extra.slice(0, 64)}.`)
  if (typeof input.command !== "string" || !RESEARCH_COMMANDS.has(input.command as ResearchCommand))
    throw new Error("Unknown research browser command.")
  if (input.agent !== "research" && input.agent !== "researcher") throw new Error("Invalid research browser agent.")
  if (
    typeof input.max !== "number" ||
    !Number.isInteger(input.max) ||
    input.max < 1 ||
    input.max > MAX_RESEARCH_BROWSERS
  )
    throw new Error("Invalid research browser count.")
  return {
    command: input.command as ResearchCommand,
    runID: researchID(input.runID, "runID"),
    sessionID: researchID(input.sessionID, "sessionID"),
    ...(input.rootID === undefined ? {} : { rootID: researchID(input.rootID, "rootID") }),
    agent: input.agent,
    max: input.max,
    ...(input.images === undefined ? {} : { images: optionalBoolean(input.images, "images")! }),
    ...(input.generation === undefined ? {} : { generation: researchID(input.generation, "generation") }),
    ...(input.provenance === undefined ? {} : { provenance: addresses(input.provenance, "provenance") }),
    ...(input.typed === undefined ? {} : { typed: addresses(input.typed, "typed") }),
    ...(input.url === undefined ? {} : { url: optionalString(input.url, "url", 8192)! }),
    ...(input.ref === undefined || input.ref === "" ? {} : { ref: optionalRef(input.ref)! }),
    ...(input.text === undefined ? {} : { text: optionalString(input.text, "text", 2_000)! }),
    ...(input.key === undefined ? {} : { key: optionalString(input.key, "key", 32)! }),
    ...(input.deltaY === undefined ? {} : { deltaY: optionalNumber(input.deltaY, "deltaY")! }),
    // A query is the agent's words and a site filter: at most 200 characters and a host name.
    ...(input.query === undefined ? {} : { query: optionalString(input.query, "query", 600)! }),
    ...(input.recency === undefined ? {} : { recency: recency(input.recency) }),
    ...(input.limit === undefined ? {} : { limit: limit(input.limit) }),
    ...(input.engines === undefined ? {} : { engines: engines(input.engines) }),
  }
}

function recency(value: unknown) {
  const found = (["day", "week", "month", "year"] as const).find((item) => item === value)
  if (!found) throw new Error("Invalid research browser recency.")
  return found
}

function limit(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ResearchSearch.MAX_RESULTS)
    throw new Error("Invalid research browser limit.")
  return value
}

// The engines a search may reach, each once, in Vector's order.
function engines(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Invalid research browser engines.")
  if (value.some((item) => !ResearchSearch.ENGINES.includes(item)) || new Set(value).size !== value.length)
    throw new Error("Invalid research browser engines.")
  return ResearchSearch.ENGINES.filter((engine) => value.includes(engine))
}

function researchID(value: unknown, name: string) {
  if (typeof value !== "string" || !RESEARCH_ID.test(value)) throw new Error(`Invalid research browser ${name}.`)
  return value
}

function addresses(value: unknown, name: string) {
  if (!Array.isArray(value) || value.length > MAX_ADDRESSES) throw new Error(`Invalid research browser ${name}.`)
  return value.map((item) => {
    if (typeof item !== "string" || item.length > 8192 || !/^https?:\/\//i.test(item))
      throw new Error(`Invalid research browser ${name}.`)
    return item
  })
}

// The handles observe gives, ref_1 to ref_9999. A model may fill every optional field, so "" is no ref.
function optionalRef(value: unknown) {
  if (value === undefined || value === "") return
  if (typeof value !== "string" || !/^ref_\d{1,4}$/.test(value)) throw new Error("Invalid browser ref.")
  return value
}

// The handles listTabs gives, tab_1 to tab_9999.
function optionalTab(value: unknown) {
  if (value === undefined || value === "") return
  if (typeof value !== "string" || !/^tab_\d{1,4}$/.test(value)) throw new Error("Invalid browser tab.")
  return value
}

// selectOption's option values or labels: as many as a select offers the agent at once.
function optionalValues(value: unknown) {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 32) throw new Error("Invalid browser values.")
  return value.map((item) => {
    if (typeof item !== "string" || item.length > 1024) throw new Error("Invalid browser values.")
    return item
  })
}

function boundedString(value: unknown, name: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`Invalid browser ${name}.`)
  }
  return value
}

function optionalString(value: unknown, name: string, max: number) {
  if (value === undefined) return
  if (typeof value !== "string" || value.length > max) throw new Error(`Invalid browser ${name}.`)
  return value
}

function optionalBoolean(value: unknown, name: string) {
  if (value === undefined) return
  if (typeof value !== "boolean") throw new Error(`Invalid browser ${name}.`)
  return value
}

function optionalNumber(value: unknown, name: string) {
  if (value === undefined) return
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid browser ${name}.`)
  return value
}
