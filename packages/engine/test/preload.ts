// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import { afterAll } from "bun:test"

// Managed-policy fixtures must pass the production ownership check even when a Linux runner starts with umask 0002.
// Keep newly created test paths unwritable by other users; trust tests explicitly chmod the unsafe cases.
if (process.platform !== "win32") process.umask(process.umask() | 0o022)

// Set XDG env vars FIRST, before any src/ imports
const dir = path.join(os.tmpdir(), "vector-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(async () => {
  const { AppRuntime } = await import("../src/effect/app-runtime")
  await AppRuntime.dispose()

  const busy = (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "EBUSY"
  const rm = async (left: number): Promise<void> => {
    Bun.gc(true)
    await sleep(100)
    return fs.rm(dir, { recursive: true, force: true }).catch((error) => {
      if (!busy(error)) throw error
      if (left <= 1 && process.platform !== "win32") throw error
      if (left <= 1) return
      return rm(left - 1)
    })
  }

  // Windows can keep SQLite WAL handles alive until GC finalizers run, so we
  // force GC and retry teardown to avoid flaky EBUSY in test cleanup.
  await rm(30)
})

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")
process.env["VECTOR_MODELS_PATH"] = path.join(import.meta.dir, "tool", "fixtures", "models-api.json")
// Keep vectordev.ai out of tests, including the owner's live ChatGPT sign-in switch.
process.env["VECTOR_DISABLE_MODELS_FETCH"] = "true"
// The local search model is never downloaded in tests; a test installs the fixture model from a folder.
process.env["VECTOR_BRAIN_EMBED"] = "off"
process.env["VECTOR_EXPERIMENTAL_EVENT_SYSTEM"] = "true"
process.env["VECTOR_EXPERIMENTAL_WORKSPACES"] = "true"

// Every engine test runs under the strict network guard: a connection that would leave this computer throws
// EgressBlocked before it is made, and a child process reaches the guard's own proxy, which refuses it too. It goes in
// before any src/ module loads, so none keeps a fetch, WebSocket or socket class of its own from before it. A file that
// pins names of its own (NetworkGuard.use) puts its guard in this one's place while it runs, then puts this one back.
const { NetworkGuard } = await import("../../core/test/lib/network-guard")
NetworkGuard.suite()
// Without ripgrep on PATH Vector downloads it from GitHub, which the guard refuses, so the tests that search files
// need it installed (CI installs it). Said here once, since each of them fails with "Install ripgrep (rg)".
if (!Bun.which("rg"))
  console.warn(
    "ripgrep (rg) is not on PATH. The engine tests that search files need it: the strict network guard keeps Vector from downloading it.",
  )

// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["VECTOR_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings. Vector reads it only through
// ConfigManaged.useTestDirectory, called here before anything resolves Vector Local; the variable only tells test files
// where the folder is.
const testManagedConfigDir = path.join(dir, "managed")
process.env["VECTOR_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir
const { ConfigManaged } = await import("@vectordevai/core/config/managed")
ConfigManaged.useTestDirectory(testManagedConfigDir)

// Write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "cache", "vector")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")

// Clear provider and server auth env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["LLM_GATEWAY_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]
delete process.env["VECTOR_SERVER_PASSWORD"]
delete process.env["VECTOR_SERVER_USERNAME"]
// A guest password alone turns server authentication on too.
delete process.env["VECTOR_SERVER_GUEST_PASSWORD"]
delete process.env["VECTOR_SERVER_GUEST_USERNAME"]
delete process.env["VECTOR_SERVER_GUEST_WORKSPACES"]
delete process.env["VECTOR_SERVER_GUEST_WORKSPACE_DIRECTORIES"]
delete process.env["VECTOR_SERVER_GUEST_SESSIONS"]
delete process.env["VECTOR_EXPERIMENTAL"]
delete process.env["VECTOR_ENABLE_EXPERIMENTAL_MODELS"]
delete process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
delete process.env["OTEL_EXPORTER_OTLP_HEADERS"]
delete process.env["OTEL_RESOURCE_ATTRIBUTES"]

// Use in-memory sqlite
process.env["VECTOR_AGENT_DB"] = ":memory:"

// Effect's default ConfigProvider copies process.env the first time anything reads it and keeps that copy for the
// whole process. Server.Default(), AppRuntime and RuntimeFlags all read through it, so whichever test file reached it
// first decided what every later file saw: a file that sets the server passwords and disposes instances before
// restoring them (test/server/local.test.ts, the memory-* server tests) left them in the copy, and
// httpapi-compression.test.ts's unauthenticated requests then got 401. Take the copy here, from this clean
// environment, so no file order can change it. Server.listen installs a fresh provider and still reads the live env.
const { ConfigProvider, Context } = await import("effect")
Context.getReferenceUnsafe(Context.empty(), ConfigProvider.ConfigProvider)

// Now safe to import from src/
const { initProjectors } = await import("../src/server/projectors")

initProjectors()
