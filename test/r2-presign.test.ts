import { afterEach, describe, expect, test } from "bun:test"
import { createHash, createHmac } from "node:crypto"
import { presignR2, presignSigV4, r2Configuration, R2_PRESIGN_MAX_SECONDS, validR2Key } from "../api/_lib/r2-presign"

// WP A37: presigned R2 URLs (SigV4 in the query string). The signer is checked against AWS's published example for a
// presigned GET; R2's own rules (900 s at most, a signed content length on every upload, plain keys) are checked on
// top. Nothing here reaches a network.

const ENV = [
  "VECTOR_R2_ACCOUNT_ID",
  "VECTOR_R2_VAULT_ACCESS_KEY_ID",
  "VECTOR_R2_VAULT_SECRET_ACCESS_KEY",
  "VECTOR_R2_VAULT_BUCKET",
  "VECTOR_R2_MEDIA_ACCESS_KEY_ID",
  "VECTOR_R2_MEDIA_SECRET_ACCESS_KEY",
  "VECTOR_R2_MEDIA_BUCKET",
] as const
const saved = new Map(ENV.map((name) => [name, process.env[name]]))
afterEach(() =>
  saved.forEach((value, name) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }),
)

// Placeholder credentials in R2's shapes (32 hex for the key id, 64 hex for the secret); not real keys.
const CONFIG = {
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "a".repeat(32),
  secretAccessKey: "b".repeat(64),
  bucket: "vector-vault",
}
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)

/** The SigV4 steps written out once more, to check a URL's signature independently of the module. */
function expectedSignature(url: URL, method: string, headers: Record<string, string>, secret: string) {
  const query = [...url.searchParams.entries()].filter(([name]) => name !== "X-Amz-Signature")
  const encode = (value: string) =>
    encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const canonicalQuery = query
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .sort()
    .join("&")
  const all = { host: url.host, ...headers }
  const names = Object.keys(all).sort()
  const canonical = [
    method,
    url.pathname,
    canonicalQuery,
    names.map((name) => `${name}:${all[name as keyof typeof all]}\n`).join(""),
    names.join(";"),
    "UNSIGNED-PAYLOAD",
  ].join("\n")
  const date = url.searchParams.get("X-Amz-Date")!
  const scope = url.searchParams.get("X-Amz-Credential")!.split("/").slice(1).join("/")
  const toSign = ["AWS4-HMAC-SHA256", date, scope, createHash("sha256").update(canonical).digest("hex")].join("\n")
  const [day, region, service] = scope.split("/")
  const hmac = (key: string | Buffer, value: string) => createHmac("sha256", key).update(value).digest()
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day!), region!), service!), "aws4_request")
  return createHmac("sha256", key).update(toSign).digest("hex")
}

describe("SigV4 query signing", () => {
  test("reproduces AWS's presigned GET example (examplebucket/test.txt, 24 May 2013, 86400 s)", () => {
    const url = presignSigV4({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      service: "s3",
      // AWS's documented example credentials, published for exactly this check.
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: Date.UTC(2013, 4, 24, 0, 0, 0),
      expiresIn: 86400,
    })
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    )
  })

  test("refuses a life past SigV4's seven days", () => {
    const input = {
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      region: "us-east-1",
      service: "s3",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      now: NOW,
    }
    expect(() => presignSigV4({ ...input, expiresIn: 604_801 })).toThrow("7 days")
    expect(() => presignSigV4({ ...input, expiresIn: 0 })).toThrow("7 days")
  })
})

describe("presignR2", () => {
  test("an upload signs its exact content length (and type) on R2's path-style host, region auto", () => {
    const signed = presignR2("vault", {
      method: "PUT",
      key: "vaults/v_1/chunks/ab12",
      expiresIn: 600,
      contentLength: 1234,
      contentType: "application/octet-stream",
      now: NOW,
      configuration: CONFIG,
    })
    const url = new URL(signed.url)
    expect(url.origin).toBe(`https://${CONFIG.accountId}.r2.cloudflarestorage.com`)
    expect(url.pathname).toBe("/vector-vault/vaults/v_1/chunks/ab12")
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host")
    expect(url.searchParams.get("X-Amz-Credential")).toBe(`${CONFIG.accessKeyId}/20261103/auto/s3/aws4_request`)
    expect(url.searchParams.get("X-Amz-Date")).toBe("20261103T120000Z")
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600")
    expect(signed.headers).toEqual({ "content-length": "1234", "content-type": "application/octet-stream" })
    expect(signed.method).toBe("PUT")
    expect(signed.expiresAt).toBe(NOW + 600_000)
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      expectedSignature(url, "PUT", signed.headers, CONFIG.secretAccessKey),
    )
    // A different length is a different signature: the uploader cannot send more than was reserved.
    const other = presignR2("vault", {
      method: "PUT",
      key: "vaults/v_1/chunks/ab12",
      expiresIn: 600,
      contentLength: 1235,
      contentType: "application/octet-stream",
      now: NOW,
      configuration: CONFIG,
    })
    expect(new URL(other.url).searchParams.get("X-Amz-Signature")).not.toBe(url.searchParams.get("X-Amz-Signature"))
  })

  test("a download signs only the host and defaults to the 900-second ceiling", () => {
    const signed = presignR2("media", {
      method: "GET",
      key: "playbooks/vector-review/1.0.0.tgz",
      now: NOW,
      configuration: { ...CONFIG, bucket: "vector-media" },
    })
    const url = new URL(signed.url)
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host")
    expect(url.searchParams.get("X-Amz-Expires")).toBe(String(R2_PRESIGN_MAX_SECONDS))
    expect(signed.headers).toEqual({})
    expect(url.searchParams.get("X-Amz-Signature")).toBe(expectedSignature(url, "GET", {}, CONFIG.secretAccessKey))
    for (const method of ["HEAD", "DELETE"] as const)
      expect(presignR2("vault", { method, key: "a/b", now: NOW, configuration: CONFIG }).method).toBe(method)
  })

  test("refuses lives over 900 s, uploads without a length, lengths on reads and bad content types", () => {
    const base = { key: "a/b", now: NOW, configuration: CONFIG }
    expect(() => presignR2("vault", { ...base, method: "GET", expiresIn: 901 })).toThrow("900")
    expect(() => presignR2("vault", { ...base, method: "GET", expiresIn: 0 })).toThrow("900")
    expect(() => presignR2("vault", { ...base, method: "GET", expiresIn: 1.5 })).toThrow("900")
    expect(() => presignR2("vault", { ...base, method: "PUT" })).toThrow("content length")
    expect(() => presignR2("vault", { ...base, method: "PUT", contentLength: -1 })).toThrow("content length")
    expect(() => presignR2("vault", { ...base, method: "PUT", contentLength: 6 * 1024 ** 3 })).toThrow("content length")
    expect(() => presignR2("vault", { ...base, method: "GET", contentLength: 1 })).toThrow("Only an R2 upload")
    expect(() =>
      presignR2("vault", { ...base, method: "PUT", contentLength: 1, contentType: "text/html\r\nx: y" }),
    ).toThrow("content type")
    expect(() => presignR2("vault", { ...base, method: "POST" as "GET" })).toThrow("Unsupported")
  })

  test("keys are plain paths: no empty, dot or dot-dot segments, no leading slash, no odd characters", () => {
    for (const key of ["a", "vaults/v_1/chunks/ab12", "ops/cards/c-1/0.webp", "x.y-z_9"])
      expect(validR2Key(key)).toBe(true)
    for (const key of [
      "",
      "/a",
      "a/",
      "a//b",
      "a/../b",
      "./a",
      "a/.",
      "a b",
      "a?b",
      "a#b",
      "a%2fb",
      "é",
      "a\nb",
      "x".repeat(1025),
    ])
      expect(validR2Key(key)).toBe(false)
    expect(() => presignR2("vault", { method: "GET", key: "../secret", now: NOW, configuration: CONFIG })).toThrow(
      "key",
    )
  })

  test("reads each bucket's settings from the environment and answers 503 while one is missing", () => {
    for (const name of ENV) delete process.env[name]
    expect(r2Configuration("vault")).toBeUndefined()
    expect(() => presignR2("vault", { method: "GET", key: "a", now: NOW })).toThrow(
      expect.objectContaining({ statusCode: 503, code: "R2_UNAVAILABLE" }),
    )
    process.env.VECTOR_R2_ACCOUNT_ID = CONFIG.accountId
    process.env.VECTOR_R2_VAULT_ACCESS_KEY_ID = CONFIG.accessKeyId
    process.env.VECTOR_R2_VAULT_SECRET_ACCESS_KEY = CONFIG.secretAccessKey
    expect(r2Configuration("vault")).toEqual(CONFIG)
    expect(r2Configuration("media")).toBeUndefined()
    process.env.VECTOR_R2_MEDIA_ACCESS_KEY_ID = "c".repeat(32)
    process.env.VECTOR_R2_MEDIA_SECRET_ACCESS_KEY = "d".repeat(64)
    process.env.VECTOR_R2_MEDIA_BUCKET = "my-media"
    expect(r2Configuration("media")).toMatchObject({ bucket: "my-media", accessKeyId: "c".repeat(32) })
    process.env.VECTOR_R2_ACCOUNT_ID = "not-an-account"
    expect(r2Configuration("vault")).toBeUndefined()
    process.env.VECTOR_R2_ACCOUNT_ID = CONFIG.accountId
    process.env.VECTOR_R2_VAULT_BUCKET = "Bad_Bucket"
    expect(r2Configuration("vault")).toBeUndefined()
    delete process.env.VECTOR_R2_VAULT_BUCKET
    expect(new URL(presignR2("vault", { method: "GET", key: "a", now: NOW }).url).pathname).toBe("/vector-vault/a")
  })
})
