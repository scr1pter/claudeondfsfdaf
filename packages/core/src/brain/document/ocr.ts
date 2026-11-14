export * as BrainOcr from "./ocr"

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parentPort, type Worker } from "node:worker_threads"
import type { BrainLimits } from "./limits"

// Explicit machine-level paths opt in to local OCR. Repository config and document content cannot select programs.
// Rendering stays outside the hardened, text-only pdf.js reader; no PDF JavaScript, shell or remote OCR is used.
export const LIMIT = { bytes: 20 * 1024 * 1024, pages: 20, seconds: 60, side: 2_400, text: 512 * 1024 } as const

type Settings = {
  readonly render: string
  readonly recognize: string
  readonly language: string
  readonly data?: string
}
export type Page =
  | { readonly type: "read"; readonly text: string; readonly truncated: boolean }
  | { readonly type: "unread" }
export type Session = { readonly read: (page: number) => Promise<Page>; readonly close: () => Promise<void> }
type Request = {
  readonly kind: "brain-ocr"
  readonly request: string
  readonly session: string
  readonly method: "open" | "read" | "close"
  readonly bytes?: Uint8Array
  readonly page?: number
  readonly chars?: number
  readonly seconds?: number
}
type Reply = { readonly kind: "brain-ocr-result"; readonly request: string; readonly result: Page | boolean }

export async function status() {
  const configured = Boolean(process.env.VECTOR_OCR_TESSERACT || process.env.VECTOR_OCR_PDFTOPPM)
  const available = Boolean(await settings())
  return {
    configured,
    available,
    ...(available
      ? {}
      : { reason: "Local OCR needs absolute paths to Tesseract and pdftoppm, with language data installed." }),
  }
}

export async function open(
  bytes: Uint8Array,
  limits: BrainLimits.Limits,
  signal?: AbortSignal,
): Promise<Session | undefined> {
  if (
    !process.env.VECTOR_OCR_TESSERACT ||
    !process.env.VECTOR_OCR_PDFTOPPM ||
    bytes.byteLength > LIMIT.bytes ||
    signal?.aborted
  )
    return undefined
  const seconds = Math.min(LIMIT.seconds, limits.seconds)
  if (!parentPort) return local(bytes, limits.pageChars, seconds, signal)
  const session = randomUUID()
  const enabled = await request(
    { kind: "brain-ocr", request: randomUUID(), session, method: "open", bytes, chars: limits.pageChars, seconds },
    signal,
  )
  if (enabled !== true) return undefined
  return {
    async read(page) {
      const result = await request({ kind: "brain-ocr", request: randomUUID(), session, method: "read", page }, signal)
      return typeof result === "object" ? result : { type: "unread" }
    },
    async close() {
      await request({ kind: "brain-ocr", request: randomUUID(), session, method: "close" })
    },
  }
}

/** Native process handles belong to the host, so terminating a parsing worker also terminates its OCR work. */
export function host(worker: Worker) {
  const sessions = new Map<string, Session>()
  const abort = new AbortController()
  const receive = async (value: unknown) => {
    if (!message(value)) return
    const result = await answer(value).catch(() => ({ type: "unread" }) as const)
    if (!abort.signal.aborted)
      worker.postMessage({ kind: "brain-ocr-result", request: value.request, result } satisfies Reply)
  }
  const answer = async (value: Request): Promise<Page | boolean> => {
    if (abort.signal.aborted) return false
    if (value.method === "open") {
      if (sessions.size > 0 || !value.bytes || value.bytes.byteLength > LIMIT.bytes) return false
      const session = await local(
        value.bytes,
        Math.min(value.chars ?? 50_000, 50_000),
        value.seconds ?? LIMIT.seconds,
        abort.signal,
      )
      if (!session) return false
      if (abort.signal.aborted) {
        await session.close()
        return false
      }
      sessions.set(value.session, session)
      return true
    }
    const session = sessions.get(value.session)
    if (!session) return false
    if (value.method === "read") return session.read(value.page ?? 0)
    sessions.delete(value.session)
    await session.close()
    return true
  }
  worker.on("message", receive)
  return {
    close() {
      abort.abort()
      worker.off("message", receive)
      sessions.forEach((session) => void session.close())
      sessions.clear()
    },
  }
}

function message(value: unknown): value is Request {
  if (typeof value !== "object" || value === null) return false
  const input = value as Partial<Request>
  return (
    input.kind === "brain-ocr" &&
    typeof input.request === "string" &&
    input.request.length <= 64 &&
    typeof input.session === "string" &&
    input.session.length <= 64 &&
    ["open", "read", "close"].includes(input.method ?? "") &&
    (input.bytes === undefined || input.bytes instanceof Uint8Array) &&
    (input.page === undefined || (Number.isSafeInteger(input.page) && input.page >= 1 && input.page <= 1_000)) &&
    (input.seconds === undefined ||
      (Number.isFinite(input.seconds) && input.seconds > 0 && input.seconds <= LIMIT.seconds)) &&
    (input.chars === undefined || (Number.isSafeInteger(input.chars) && input.chars >= 1 && input.chars <= 50_000))
  )
}

function request(input: Request, signal?: AbortSignal): Promise<Page | boolean> {
  const port = parentPort
  if (!port || signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const finish = (result: Page | boolean) => {
      clearTimeout(timer)
      port.off("message", receive)
      signal?.removeEventListener("abort", aborted)
      resolve(result)
    }
    const receive = (value: Reply) => {
      if (value?.kind === "brain-ocr-result" && value.request === input.request) finish(value.result)
    }
    const aborted = () => finish(false)
    const timer = setTimeout(aborted, (LIMIT.seconds + 5) * 1_000)
    port.on("message", receive)
    signal?.addEventListener("abort", aborted, { once: true })
    port.postMessage(input)
  })
}

async function settings(): Promise<Settings | undefined> {
  const render = process.env.VECTOR_OCR_PDFTOPPM
  const recognize = process.env.VECTOR_OCR_TESSERACT
  const data = process.env.VECTOR_OCR_TESSDATA
  const language = process.env.VECTOR_OCR_LANGUAGE ?? "eng"
  if (
    !render ||
    !recognize ||
    !path.isAbsolute(render) ||
    !path.isAbsolute(recognize) ||
    /[\x00-\x1f]/.test(render + recognize)
  )
    return
  if (!/^[a-z][a-z0-9_]*(?:\+[a-z][a-z0-9_]*)*$/.test(language) || language.length > 64) return
  if (data && (!path.isAbsolute(data) || /[\x00-\x1f]/.test(data))) return
  const files = await Promise.all([stat(render), stat(recognize), ...(data ? [stat(data)] : [])]).catch(() => undefined)
  if (!files?.[0]?.isFile() || !files[1]?.isFile() || (data && !files[2]?.isDirectory())) return
  return { render, recognize, language, ...(data ? { data } : {}) }
}

async function local(
  bytes: Uint8Array,
  chars: number,
  seconds: number,
  signal?: AbortSignal,
): Promise<Session | undefined> {
  const config = await settings()
  if (!config || signal?.aborted || !Number.isFinite(seconds) || seconds <= 0) return
  const abort = new AbortController()
  const stop = () => abort.abort()
  signal?.addEventListener("abort", stop, { once: true })
  const timer = setTimeout(stop, seconds * 1_000)
  const state = { pages: 0, directory: undefined as string | undefined, active: undefined as Promise<Page> | undefined }
  const read = async (page: number): Promise<Page> => {
    if (abort.signal.aborted || !Number.isSafeInteger(page) || page < 1 || ++state.pages > LIMIT.pages)
      return { type: "unread" }
    state.directory ??= await mkdtemp(path.join(tmpdir(), "vector-ocr-"))
    const source = path.join(state.directory, "source.pdf")
    if (state.pages === 1) await writeFile(source, bytes, { mode: 0o600 })
    const image = path.join(state.directory, "page")
    const output = path.join(state.directory, "recognized")
    await Promise.all([rm(`${image}.pgm`, { force: true }), rm(`${output}.txt`, { force: true })])
    // A fixed rendered side bounds the raster: a grayscale PGM is at most 5.8 MB. Native decoders remain external.
    if (
      !(await run(
        config.render,
        [
          "-f",
          String(page),
          "-l",
          String(page),
          "-singlefile",
          "-scale-to",
          String(LIMIT.side),
          "-gray",
          source,
          image,
        ],
        state.directory,
        abort.signal,
      ))
    )
      return { type: "unread" }
    const size = await stat(`${image}.pgm`).catch(() => undefined)
    if (!size || size.size > LIMIT.side ** 2 + 4_096 || size.size < 10) return { type: "unread" }
    const imageBytes = await readFile(`${image}.pgm`)
    const dimensions = imageBytes
      .subarray(0, 256)
      .toString("ascii")
      .match(/^P5\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+255\s/)
    if (!dimensions || Number(dimensions[1]) > LIMIT.side || Number(dimensions[2]) > LIMIT.side)
      return { type: "unread" }
    const args = [
      `${image}.pgm`,
      output,
      "-l",
      config.language,
      "--psm",
      "3",
      ...(config.data ? ["--tessdata-dir", config.data] : []),
      "txt",
    ]
    if (!(await run(config.recognize, args, state.directory, abort.signal))) return { type: "unread" }
    const textFile = await stat(`${output}.txt`).catch(() => undefined)
    if (!textFile || textFile.size > LIMIT.text) return { type: "unread" }
    const text = (await readFile(`${output}.txt`, "utf8")).replace(/\r\n?/g, "\n").trim()
    await Promise.all([rm(`${image}.pgm`, { force: true }), rm(`${output}.txt`, { force: true })])
    return text ? { type: "read", text: text.slice(0, chars), truncated: text.length > chars } : { type: "unread" }
  }
  return {
    read(page) {
      if (state.active) return Promise.resolve({ type: "unread" })
      state.active = read(page)
        .catch(() => ({ type: "unread" }) as const)
        .finally(() => {
          state.active = undefined
        })
      return state.active
    },
    async close() {
      stop()
      clearTimeout(timer)
      signal?.removeEventListener("abort", stop)
      await state.active
      if (state.directory)
        await rm(state.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(
          () => undefined,
        )
    },
  }
}

function run(executable: string, args: readonly string[], directory: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd: directory,
      windowsHide: true,
      shell: false,
      stdio: "ignore",
      env: {
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
        TEMP: directory,
        TMP: directory,
        TMPDIR: directory,
        HOME: directory,
        LANG: "C.UTF-8",
        OMP_THREAD_LIMIT: "1",
        OMP_NUM_THREADS: "1",
      },
    })
    const stop = () => child.kill("SIGKILL")
    const timer = setTimeout(stop, 15_000)
    signal.addEventListener("abort", stop, { once: true })
    child.once("error", () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", stop)
      resolve(false)
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", stop)
      resolve(code === 0 && !signal.aborted)
    })
    if (signal.aborted) stop()
  })
}
