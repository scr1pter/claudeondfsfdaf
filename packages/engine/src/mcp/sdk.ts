// The MCP SDK brings its own zod copy and a JSON Schema validator, a few hundred modules in all. Most sessions
// configure no MCP server, so the MCP service and catalog load this module on their first connection or call
// instead of with every engine. Import it dynamically; a static import puts the SDK back on every startup.
import { pathToFileURL } from "node:url"
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js"
import {
  ErrorCode,
  ListRootsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { InstallationVersion } from "@vectordevai/core/installation/version"

export { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
export { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
export { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
export { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
export {
  CallToolResultSchema,
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"

const CLIENT_OPTIONS = {
  capabilities: {
    // sampling: {},
    // elicitation: {},
    roots: {},
    // tasks: {},
  },
} satisfies ClientOptions

export function createClient(directory: string) {
  const client = new Client({ name: "vector", version: InstallationVersion }, CLIENT_OPTIONS)
  client.setRequestHandler(ListRootsRequestSchema, () =>
    Promise.resolve({ roots: [{ uri: pathToFileURL(directory).href }] }),
  )
  return client
}

/**
 * True when a request failed because the server did not answer in time. The SDK
 * also reports an aborted request as a RequestTimeout McpError, so a cancelled
 * tool call is excluded through its abort signal.
 */
export function isRequestTimeout(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false
  return (
    error instanceof McpError && error.code === ErrorCode.RequestTimeout && /timed out|timeout/i.test(error.message)
  )
}

// Some servers publish output schemas the SDK cannot resolve; listing their tools retries without those schemas.
export const TolerantListToolsResultSchema = ListToolsResultSchema.extend({
  tools: ToolSchema.omit({ outputSchema: true }).array(),
})
