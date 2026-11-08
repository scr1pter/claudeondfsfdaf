import fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"
import path from "node:path"
import type { Readable } from "node:stream"
import { z } from "zod"

const token = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$(?![\s\S])/)
const runToken = z
  .string()
  .max(1024)
  .regex(/^vrt_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$(?![\s\S])/)
const cliToken = z
  .string()
  .max(4096)
  .regex(/^vct_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$(?![\s\S])/)
const secretName = /^[A-Z_][A-Z0-9_]{0,99}$(?![\s\S])/
const reserved = /^(?:VECTOR_|GITHUB_|ACTIONS_|RUNNER_|REVIEW_|NODE_|NPM_|BUN_|BASH_|GIT_|LD_|DYLD_)/
const control = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "SHELLOPTS",
  "PS4",
  "CDPATH",
  "IFS",
  "MENTIONS",
  "MODEL",
  "SHARE",
  "CI",
  "USE_GITHUB_TOKEN",
])
const Channel = z
  .object({
    v: z.literal(1),
    githubToken: token,
    runToken: runToken.optional(),
    cliToken: cliToken.optional(),
    keys: z.record(
      z.string().refine((name) => secretName.test(name) && !reserved.test(name) && !control.has(name)),
      z.string().min(1).max(16_384),
    ),
  })
  .strict()

export type Channel = z.infer<typeof Channel>
const CHANNEL_LIMIT = 131_072

export function validRunToken(value: unknown): value is string {
  return runToken.safeParse(value).success
}

function unavailable() {
  return new Error("The GitHub run credentials are unavailable or invalid.")
}

export function runTokenPath(env: Readonly<Record<string, string | undefined>>) {
  if (!env.RUNNER_TEMP || !path.isAbsolute(env.RUNNER_TEMP)) throw unavailable()
  return path.join(env.RUNNER_TEMP, "vector-secrets", "run-token")
}

async function privateDirectory(file: string) {
  const info = await fs.lstat(path.dirname(file))
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw unavailable()
}

/** Only mint writes this file. No repository-controlled file is read or overwritten. */
export async function writeRunToken(value: string, env: Readonly<Record<string, string | undefined>>) {
  if (!validRunToken(value)) throw unavailable()
  const file = runTokenPath(env)
  await fs.mkdir(path.dirname(file), { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw unavailable()
  })
  await privateDirectory(file)
  const handle = await fs.open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(value, "utf8")
  } finally {
    await handle.close()
  }
}

type PrivateTokenFile = {
  stat: () => Promise<Stats>
  read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>
  close: () => Promise<void>
}

/** The runner consumes its own private file before giving the engine any untrusted work. */
export async function readRunToken(
  env: Readonly<Record<string, string | undefined>>,
  open: (file: string, flags: number) => Promise<PrivateTokenFile> = fs.open,
) {
  const file = runTokenPath(env)
  await privateDirectory(file)
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 1024 ||
      info.nlink !== 1 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw unavailable()
    const buffer = Buffer.alloc(1025)
    let length = 0
    while (length < buffer.length) {
      const part = await handle.read(buffer, length, buffer.length - length, length)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    if (length > 1024) throw unavailable()
    const value = buffer.subarray(0, length).toString("utf8")
    if (!validRunToken(value)) throw unavailable()
    await fs.unlink(file)
    return value
  } finally {
    await handle.close()
  }
}

async function channelLine(input: AsyncIterable<Uint8Array | string>) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk)
    size += bytes.length
    if (size > CHANNEL_LIMIT) throw unavailable()
    chunks.push(bytes)
  }
  const line = Buffer.concat(chunks).toString("utf8")
  if (!line.endsWith("\n") || line.slice(0, -1).includes("\n")) throw unavailable()
  try {
    return JSON.parse(line) as unknown
  } catch {
    throw unavailable()
  }
}

/**
 * The stream's chunks from its 'data', 'end', 'close' and 'error' events, then the stream is destroyed, which closes
 * stdin as 2.13 asks. On Bun 1.3.14, once anything has read `process.stdin.isTTY` before the loader runs, as the CLI's
 * startup does, `for await (const chunk of process.stdin)` over a stdin that Bun.spawn was given as bytes ends at once
 * with none of them, while these events still deliver the whole line; through a pipe, and on Node, both ways read it.
 * A stream that has already ended or been destroyed yields nothing, so the loader refuses it instead of waiting. The
 * stream is resumed once the listeners are on: a 'data' listener does not start a stream that something paused.
 */
async function* streamChunks(stream: Readable): AsyncGenerator<Uint8Array | string> {
  const queue: (Uint8Array | string)[] = []
  const state: { ended: boolean; failed: boolean; wake?: () => void } = {
    ended: stream.readableEnded || stream.destroyed,
    failed: false,
  }
  const data = (chunk: Uint8Array | string) => {
    queue.push(chunk)
    state.wake?.()
  }
  const end = () => {
    state.ended = true
    state.wake?.()
  }
  const error = () => {
    state.failed = true
    state.wake?.()
  }
  stream.on("data", data)
  stream.on("end", end)
  stream.on("close", end)
  stream.on("error", error)
  stream.resume()
  try {
    while (true) {
      if (state.failed) throw unavailable()
      const chunk = queue.shift()
      if (chunk !== undefined) {
        yield chunk
        continue
      }
      if (state.ended) return
      await new Promise<void>((resolve) => {
        state.wake = resolve
      })
      state.wake = undefined
    }
  } finally {
    stream.removeListener("data", data)
    stream.removeListener("end", end)
    stream.removeListener("close", end)
    stream.removeListener("error", error)
    stream.destroy()
  }
}

/** One holder per CLI process. Tests create a separate holder, never replace process.env or a global service. */
export function createGithubSecrets() {
  let held: Channel | undefined
  let authorized = false
  let authorization = 0
  let loading: Promise<void> | undefined
  const load = async (env: Record<string, string | undefined>, input: AsyncIterable<Uint8Array | string>) => {
    if (env.GITHUB_ACTIONS !== "true") throw unavailable()
    const supplied = env.VECTOR_SECRET_ENV_NAMES?.split(",").filter(Boolean) ?? []
    let capture: unknown
    try {
      capture =
        env.VECTOR_SECRET_CHANNEL === "stdin"
          ? await channelLine(input)
          : { v: 1, githubToken: env.GITHUB_TOKEN, runToken: await readRunToken(env), keys: {} }
    } finally {
      // Key names are data, even if a channel's values fail validation. Never leave a listed or captured fallback
      // credential in the OS environment; recognisable token/secret names are also stripped on malformed input.
      const keys =
        capture && typeof capture === "object" && !Array.isArray(capture)
          ? (capture as Record<string, unknown>).keys
          : undefined
      const captured = keys && typeof keys === "object" && !Array.isArray(keys) ? Object.keys(keys) : []
      const privateNames = Object.keys(env).filter((name) => /(?:_TOKEN|_KEY|_SECRET|_PASSWORD)$/.test(name))
      for (const name of ["GITHUB_TOKEN", "GH_TOKEN", "VECTOR_CLI_TOKEN", ...supplied, ...captured, ...privateNames])
        delete env[name]
    }
    const parsed = Channel.safeParse(capture)
    if (!parsed.success) throw unavailable()
    if (env.VECTOR_MODE === "codium") {
      if (!parsed.data.runToken || parsed.data.cliToken || Object.keys(parsed.data.keys).length) throw unavailable()
    } else if (env.VECTOR_MODE !== "own-key" || parsed.data.runToken || !parsed.data.cliToken) throw unavailable()
    held = parsed.data
  }
  return {
    load(env: Record<string, string | undefined> = process.env, input?: AsyncIterable<Uint8Array | string>) {
      return (loading ??= load(env, input ?? streamChunks(process.stdin)).catch(() => {
        throw unavailable()
      }))
    },
    loaded: () => held !== undefined,
    pendingRunToken: () => held?.runToken,
    runToken: () => (authorized ? held?.runToken : undefined),
    githubToken: () => held?.githubToken,
    cliToken: () => held?.cliToken,
    providerKeys: () => ({ ...held?.keys }),
    async authorize(check: (value: string) => Promise<boolean>) {
      const value = held?.runToken
      if (!value) return false
      const generation = ++authorization
      authorized = false
      const accepted = await check(value).catch(() => false)
      if (generation !== authorization) return false
      if (accepted && held?.runToken === value) authorized = true
      return authorized
    },
  }
}

export const credentials = createGithubSecrets()

/**
 * Whether this process holds an own-key run's channel: loaded, with no run token (the loader refuses a run token on own
 * key and requires one on Codium). Such a run never sends a model request to Codium (INV-K1), so the provider layer
 * leaves the Codium provider out whatever the repository's configuration names.
 */
export function ownKeyRun(holder: Pick<typeof credentials, "loaded" | "pendingRunToken"> = credentials) {
  return holder.loaded() && holder.pendingRunToken() === undefined
}

// What the account gate and the agent phase say when the gate did not authorize a Codium run's token.
export const CODIUM_UNAUTHORIZED = "This Codium run is not authorized."

// Why an own-key run cannot use a Codium model, wherever one is named: MODEL, an agent's model or small_model.
export const OWN_KEY_CODIUM =
  "Codium models run only in a Codium workflow. Set MODEL to your own provider's provider/model."

export * as GithubSecrets from "./github.secrets"
