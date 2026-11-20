// Byte helpers on web platform APIs only (the Worker has no Buffer).

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })

export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text) as Uint8Array<ArrayBuffer>
}

export function fromUtf8(bytes: Uint8Array): string | undefined {
  try {
    return decoder.decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Reads a body as its bytes arrive until `limit` of them came or it ended, then cancels the rest, so at most `limit`
 * bytes plus one chunk are ever held. `bytes` is at most the first `limit`; `complete` means the body ended before
 * `limit` bytes came. Undefined when the read failed (an error, or the request's signal aborting it); no body reads as
 * empty and complete.
 */
export async function readPrefix(body: ReadableStream<Uint8Array> | null, limit: number) {
  if (!body) return { bytes: new Uint8Array(0), complete: true }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let complete = false
  while (size < limit) {
    const next = await reader.read().catch(() => undefined)
    if (!next) return undefined
    if (next.done) {
      complete = true
      break
    }
    chunks.push(next.value)
    size += next.value.byteLength
  }
  if (!complete) await reader.cancel().catch(() => {})
  const bytes = new Uint8Array(Math.min(size, limit))
  let offset = 0
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.byteLength - offset)
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return { bytes, complete }
}

export function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Decodes unpadded base64url. Only the canonical spelling is accepted, so one value has one text. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined
  let binary: string
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4))
  } catch {
    return undefined
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return base64url(bytes) === text ? bytes : undefined
}

export function hex(bytes: Uint8Array): string {
  let text = ""
  for (const byte of bytes) text += byte.toString(16).padStart(2, "0")
  return text
}

/** Compares two byte strings in time that depends only on their lengths. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index++) difference |= left[index]! ^ right[index]!
  return difference === 0
}
