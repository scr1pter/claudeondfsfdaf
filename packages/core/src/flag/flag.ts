import { Config } from "effect"
import { migrateEnvironment } from "./migrate"

migrateEnvironment()

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env.VECTOR_EXPERIMENTAL_DISABLE_COPY_ON_SELECT
const fff = process.env.VECTOR_DISABLE_FFF

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("VECTOR_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,

  VECTOR_AUTO_HEAP_SNAPSHOT: truthy("VECTOR_AUTO_HEAP_SNAPSHOT"),
  VECTOR_GIT_BASH_PATH: process.env.VECTOR_GIT_BASH_PATH,
  VECTOR_AGENT_CONFIG: process.env.VECTOR_AGENT_CONFIG,
  get VECTOR_CONFIG_CONTENT() {
    return process.env.VECTOR_CONFIG_CONTENT
  },
  VECTOR_DISABLE_AUTOUPDATE: truthy("VECTOR_DISABLE_AUTOUPDATE"),
  VECTOR_ALWAYS_NOTIFY_UPDATE: truthy("VECTOR_ALWAYS_NOTIFY_UPDATE"),
  VECTOR_DISABLE_PRUNE: truthy("VECTOR_DISABLE_PRUNE"),
  VECTOR_DISABLE_TERMINAL_TITLE: truthy("VECTOR_DISABLE_TERMINAL_TITLE"),
  VECTOR_SHOW_TTFD: truthy("VECTOR_SHOW_TTFD"),
  VECTOR_DISABLE_AUTOCOMPACT: truthy("VECTOR_DISABLE_AUTOCOMPACT"),
  VECTOR_DISABLE_MODELS_FETCH: truthy("VECTOR_DISABLE_MODELS_FETCH"),
  VECTOR_DISABLE_MOUSE: truthy("VECTOR_DISABLE_MOUSE"),
  VECTOR_FAKE_VCS: process.env.VECTOR_FAKE_VCS,
  VECTOR_SERVER_PASSWORD: process.env.VECTOR_SERVER_PASSWORD,
  VECTOR_SERVER_USERNAME: process.env.VECTOR_SERVER_USERNAME,
  VECTOR_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("VECTOR_DISABLE_FFF"),

  // Experimental
  VECTOR_EXPERIMENTAL_FILEWATCHER: Config.boolean("VECTOR_EXPERIMENTAL_FILEWATCHER").pipe(Config.withDefault(false)),
  VECTOR_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("VECTOR_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  VECTOR_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("VECTOR_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  VECTOR_MODELS_URL: process.env.VECTOR_MODELS_URL,
  VECTOR_MODELS_PATH: process.env.VECTOR_MODELS_PATH,
  VECTOR_AGENT_DB: process.env.VECTOR_AGENT_DB,

  VECTOR_WORKSPACE_ID: process.env.VECTOR_WORKSPACE_ID,
  VECTOR_EXPERIMENTAL_WORKSPACES: enabledByExperimental("VECTOR_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get VECTOR_DISABLE_PROJECT_CONFIG() {
    return truthy("VECTOR_DISABLE_PROJECT_CONFIG")
  },
  get VECTOR_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("VECTOR_EXPERIMENTAL_REFERENCES")
  },
  get VECTOR_EXPERIMENTAL_CONNECT() {
    return enabledByExperimental("VECTOR_EXPERIMENTAL_CONNECT")
  },
  get VECTOR_TUI_CONFIG() {
    return process.env.VECTOR_TUI_CONFIG
  },
  get VECTOR_AGENT_CONFIG_DIR() {
    return process.env.VECTOR_AGENT_CONFIG_DIR
  },
  get VECTOR_PURE() {
    return truthy("VECTOR_PURE")
  },
  get VECTOR_PERMISSION() {
    return process.env.VECTOR_PERMISSION
  },
  get VECTOR_PLUGIN_META_FILE() {
    return process.env.VECTOR_PLUGIN_META_FILE
  },
  // Asking a model to read a document for suggestions (quote-locked distillation). Off unless set.
  get VECTOR_KNOWLEDGE_DISTILL() {
    return truthy("VECTOR_KNOWLEDGE_DISTILL")
  },
  get VECTOR_CLIENT() {
    return process.env.VECTOR_CLIENT ?? "cli"
  },
}
