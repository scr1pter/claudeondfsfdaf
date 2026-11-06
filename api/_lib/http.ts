import type { IncomingMessage, ServerResponse } from "node:http"

export type ApiRequest = IncomingMessage & {
  body?: unknown
  query?: Record<string, string | string[] | undefined>
}
export type ApiResponse = ServerResponse & {
  status?: (code: number) => ApiResponse
  json?: (value: unknown) => void
  redirect?: (status: number, location: string) => void
}

export class ApiError extends Error {
  /** Extra fields for the error body, such as `{reason, action}` or `{perk, plan}`. They never replace `code` or `message`. */
  readonly detail?: Readonly<Record<string, unknown>>
  /** Sent as the `retry-after` header, in seconds. */
  readonly retryAfterSeconds?: number
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    options: { detail?: Readonly<Record<string, unknown>>; retryAfterSeconds?: number } = {},
  ) {
    super(message)
    if (options.detail) this.detail = options.detail
    if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = options.retryAfterSeconds
  }
}

export function json(response: ApiResponse, status: number, value: unknown) {
  response.statusCode = status
  response.setHeader("content-type", "application/json; charset=utf-8")
  response.setHeader("cache-control", "no-store")
  response.end(JSON.stringify(value))
}

export function redirect(response: ApiResponse, status: number, location: string) {
  response.statusCode = status
  response.setHeader("location", location)
  response.setHeader("cache-control", "no-store")
  response.end()
}

export function requireMethod(request: ApiRequest, method: string) {
  if (request.method === method) return
  throw new ApiError(405, "METHOD_NOT_ALLOWED", `Use ${method} for this endpoint.`)
}

export async function readRawBody(request: ApiRequest, limit = 1_000_000) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new ApiError(413, "BODY_TOO_LARGE", "The request body is too large.")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export async function readJson<T>(request: ApiRequest, limit = 64_000): Promise<T> {
  if (request.body !== undefined) {
    const serialized = typeof request.body === "string" ? request.body : JSON.stringify(request.body)
    if (typeof serialized !== "string") {
      throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.")
    }
    if (Buffer.byteLength(serialized, "utf8") > limit) {
      throw new ApiError(413, "BODY_TOO_LARGE", "The request body is too large.")
    }
    if (typeof request.body !== "string") return request.body as T
    try {
      return JSON.parse(request.body) as T
    } catch {
      throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.")
    }
  }
  const raw = await readRawBody(request, limit)
  if (!raw.length) return {} as T
  try {
    return JSON.parse(raw.toString("utf8")) as T
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body must be valid JSON.")
  }
}

export function queryValue(request: ApiRequest, key: string) {
  const value = request.query?.[key]
  if (Array.isArray(value)) return value[0]
  if (value) return value
  const url = new URL(request.url ?? "/", "https://vectordev.ai")
  return url.searchParams.get(key) ?? undefined
}

export function handleApiError(response: ApiResponse, error: unknown) {
  if (error instanceof ApiError) {
    if (error.retryAfterSeconds !== undefined)
      response.setHeader("retry-after", String(Math.max(1, Math.ceil(error.retryAfterSeconds))))
    json(response, error.statusCode, { error: { ...error.detail, code: error.code, message: error.message } })
    return
  }
  console.error("Vector API error", error)
  json(response, 500, {
    error: {
      code: "INTERNAL_ERROR",
      message: "Vector could not complete this request. Please try again.",
    },
  })
}
