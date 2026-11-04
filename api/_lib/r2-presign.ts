import { createHash, createHmac } from "node:crypto"
import { ApiError } from "./http.js"

/*
 * Presigned Cloudflare R2 URLs (WP A37), AWS Signature Version 4 in the query string, so a desktop or phone moves
 * bytes straight to and from R2 without holding a key:
 * - an upload (PUT) signs its exact `content-length`, so the uploader cannot send more than the server reserved (the
 *   Vault quota is a server gate, WP A44), and optionally its `content-type`;
 * - every URL lives at most 900 seconds;
 * - keys are plain paths (letters, digits, `.`, `_`, `-`, `/` between non-empty segments), never `.` or `..`.
 *
 * Buckets and settings (per bucket, never in the repository):
 *   VECTOR_R2_ACCOUNT_ID                                  the Cloudflare account that owns the buckets
 *   VECTOR_R2_VAULT_ACCESS_KEY_ID, …_SECRET_ACCESS_KEY    a token scoped to the vault bucket
 *   VECTOR_R2_VAULT_BUCKET                                default `vector-vault`
 *   VECTOR_R2_MEDIA_ACCESS_KEY_ID, …_SECRET_ACCESS_KEY    a token scoped to the media bucket
 *   VECTOR_R2_MEDIA_BUCKET                                default `vector-media`
 */

export type R2BucketName = "vault" | "media"
export type R2Method = "GET" | "PUT" | "HEAD" | "DELETE"
export type R2Configuration = { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string }

/** The longest a presigned R2 URL lives. */
export const R2_PRESIGN_MAX_SECONDS = 900
/** S3's largest single PUT, which R2 shares (5 GiB). */
const R2_MAX_PUT_BYTES = 5 * 1024 ** 3
/** SigV4's own ceiling on X-Amz-Expires, for the generic signer. */
const SIGV4_MAX_SECONDS = 604_800
const DEFAULT_BUCKETS: Record<R2BucketName, string> = { vault: "vector-vault", media: "vector-media" }

/** A bucket's settings, or undefined while any of them is missing or malformed. */
export function r2Configuration(bucket: R2BucketName): R2Configuration | undefined {
  const prefix = `VECTOR_R2_${bucket.toUpperCase()}_`
  const accountId = process.env.VECTOR_R2_ACCOUNT_ID?.trim() ?? ""
  const accessKeyId = process.env[`${prefix}ACCESS_KEY_ID`]?.trim() ?? ""
  const secretAccessKey = process.env[`${prefix}SECRET_ACCESS_KEY`]?.trim() ?? ""
  const name = process.env[`${prefix}BUCKET`]?.trim() || DEFAULT_BUCKETS[bucket]
  if (
    !/^[a-f0-9]{32}$/.test(accountId) ||
    !/^[A-Za-z0-9]{16,128}$/.test(accessKeyId) ||
    !/^[A-Za-z0-9/+=]{32,128}$/.test(secretAccessKey) ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)
  )
    return undefined
  return { accountId, accessKeyId, secretAccessKey, bucket: name }
}

/** Whether a bucket can be presigned here. */
export function r2Configured(bucket: R2BucketName) {
  return r2Configuration(bucket) !== undefined
}

/** Whether an object key follows the rules above (1 to 1024 characters). */
export function validR2Key(key: string) {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= 1024 &&
    /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(key) &&
    key.split("/").every((segment) => segment !== "." && segment !== "..")
  )
}

export type R2Presigned = {
  url: string
  method: R2Method
  /** Headers the request must send exactly as signed (`content-length` and `content-type` for an upload). */
  headers: Record<string, string>
  expiresAt: number
}

/**
 * A presigned URL for one object. `expiresIn` is at most 900 seconds (default 900). A PUT needs `contentLength`, which
 * is signed; `contentType` is signed when given. Throws 503 `R2_UNAVAILABLE` while the bucket is not configured.
 */
export function presignR2(
  bucket: R2BucketName,
  input: {
    method: R2Method
    key: string
    expiresIn?: number
    contentLength?: number
    contentType?: string
    now?: number
    configuration?: R2Configuration
  },
): R2Presigned {
  const configuration = input.configuration ?? r2Configuration(bucket)
  if (!configuration) throw new ApiError(503, "R2_UNAVAILABLE", "File storage is temporarily unavailable.")
  const expiresIn = input.expiresIn ?? R2_PRESIGN_MAX_SECONDS
  if (!Number.isSafeInteger(expiresIn) || expiresIn < 1 || expiresIn > R2_PRESIGN_MAX_SECONDS)
    throw new Error(`A presigned R2 URL lives 1 to ${R2_PRESIGN_MAX_SECONDS} seconds.`)
  if (!["GET", "PUT", "HEAD", "DELETE"].includes(input.method)) throw new Error("Unsupported R2 method.")
  if (!validR2Key(input.key)) throw new Error("That R2 object key is not valid.")
  const headers: Record<string, string> = {}
  if (input.method === "PUT") {
    if (
      input.contentLength === undefined ||
      !Number.isSafeInteger(input.contentLength) ||
      input.contentLength < 0 ||
      input.contentLength > R2_MAX_PUT_BYTES
    )
      throw new Error("An R2 upload signs its exact content length.")
    headers["content-length"] = String(input.contentLength)
    if (input.contentType !== undefined) {
      if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.contentType))
        throw new Error("That content type is not valid.")
      headers["content-type"] = input.contentType
    }
  } else if (input.contentLength !== undefined || input.contentType !== undefined)
    throw new Error("Only an R2 upload signs a content length or type.")
  const now = input.now ?? Date.now()
  const url = presignSigV4({
    method: input.method,
    url: new URL(
      `https://${configuration.accountId}.r2.cloudflarestorage.com/${configuration.bucket}/${input.key
        .split("/")
        .map(encodeSegment)
        .join("/")}`,
    ),
    region: "auto",
    service: "s3",
    accessKeyId: configuration.accessKeyId,
    secretAccessKey: configuration.secretAccessKey,
    now,
    expiresIn,
    headers,
  })
  return { url, method: input.method, headers, expiresAt: Math.floor(now / 1000) * 1000 + expiresIn * 1000 }
}

/**
 * The generic SigV4 query-string signer (`UNSIGNED-PAYLOAD`). `url`'s path must already be encoded as S3 expects (each
 * segment percent-encoded once); its query, if any, is signed too. `headers` are signed besides `host`.
 */
export function presignSigV4(input: {
  method: string
  url: URL
  region: string
  service: string
  accessKeyId: string
  secretAccessKey: string
  now: number
  expiresIn: number
  headers?: Readonly<Record<string, string>>
}) {
  if (!Number.isSafeInteger(input.expiresIn) || input.expiresIn < 1 || input.expiresIn > SIGV4_MAX_SECONDS)
    throw new Error("A SigV4 presigned URL lives 1 second to 7 days.")
  const amzDate = new Date(Math.floor(input.now / 1000) * 1000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
  const day = amzDate.slice(0, 8)
  const scope = `${day}/${input.region}/${input.service}/aws4_request`
  const signed = new Map<string, string>([["host", input.url.host]])
  for (const [name, value] of Object.entries(input.headers ?? {}))
    signed.set(name.toLowerCase(), value.trim().replace(/\s+/g, " "))
  const names = [...signed.keys()].sort()
  const query: [string, string][] = [
    ...input.url.searchParams.entries(),
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(input.expiresIn)],
    ["X-Amz-SignedHeaders", names.join(";")],
  ]
  const canonicalQuery = query
    .map(([name, value]) => [encodeSegment(name), encodeSegment(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&")
  const canonicalRequest = [
    input.method.toUpperCase(),
    input.url.pathname || "/",
    canonicalQuery,
    names.map((name) => `${name}:${signed.get(name)}\n`).join(""),
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n")
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n")
  let key: Buffer = createHmac("sha256", `AWS4${input.secretAccessKey}`).update(day).digest()
  for (const part of [input.region, input.service, "aws4_request"])
    key = createHmac("sha256", key).update(part).digest()
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex")
  return `${input.url.origin}${input.url.pathname || "/"}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

/** RFC 3986 percent-encoding as SigV4 wants it: everything but A-Z a-z 0-9 - . _ ~ is encoded. */
function encodeSegment(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}
