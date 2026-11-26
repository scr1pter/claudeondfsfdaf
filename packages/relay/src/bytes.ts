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

/** Read only a fixed prefix; cancellation must not delay rejecting an oversized internal request. */
export async function readPrefix(body: ReadableStream<Uint8Array> | null, limit: number) {
  if (!body) return { bytes: new Uint8Array(0), complete: true }
  const reader = body.getReader()
  const bytes = new Uint8Array(limit)
  let size = 0
  try {
    while (size < limit) {
      const next = await reader.read().catch(() => undefined)
      if (!next) return undefined
      if (next.done) return { bytes: bytes.subarray(0, size), complete: true }
      const length = Math.min(next.value.byteLength, limit - size)
      bytes.set(next.value.subarray(0, length), size)
      size += length
    }
    // The incoming chunk may be much larger than the limit; only its fitting prefix is copied or retained.
    void reader.cancel().catch(() => {})
    return { bytes, complete: false }
  } finally {
    reader.releaseLock()
  }
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
