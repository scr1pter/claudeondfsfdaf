import { inflateSync } from "node:zlib"

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~"

function decode(lines: string[]) {
  const chunks: Buffer[] = []
  for (const line of lines) {
    const first = line.charCodeAt(0)
    const length = first >= 65 && first <= 90 ? first - 64 : first >= 97 && first <= 122 ? first - 70 : 0
    if (!length || line.length !== 1 + Math.ceil(length / 4) * 5) throw new Error("Invalid Git binary line")
    const bytes = Buffer.alloc(Math.ceil(length / 4) * 4)
    for (let index = 1, offset = 0; index < line.length; index += 5, offset += 4) {
      let value = 0
      for (const char of line.slice(index, index + 5)) {
        const digit = ALPHABET.indexOf(char)
        if (digit < 0) throw new Error("Invalid Git binary digit")
        value = value * 85 + digit
      }
      if (value > 0xffff_ffff) throw new Error("Invalid Git binary word")
      bytes.writeUInt32BE(value, offset)
    }
    chunks.push(bytes.subarray(0, length))
  }
  return Buffer.concat(chunks)
}

function deltaValid(bytes: Buffer, limit: number) {
  let cursor = 0
  const whole = () => {
    let value = 0
    let shift = 0
    for (;;) {
      if (cursor >= bytes.length || shift > 49) throw new Error("Invalid Git delta integer")
      const byte = bytes[cursor++]!
      value += (byte & 0x7f) * 2 ** shift
      if (!Number.isSafeInteger(value) || value > limit) throw new Error("Git delta exceeds its file limit")
      if (!(byte & 0x80)) return value
      shift += 7
    }
  }
  const source = whole()
  const target = whole()
  let output = 0
  while (cursor < bytes.length) {
    const command = bytes[cursor++]!
    if (command & 0x80) {
      let offset = 0
      let count = 0
      for (let index = 0; index < 4; index++) {
        if (!(command & (1 << index))) continue
        if (cursor >= bytes.length) return false
        offset += bytes[cursor++]! * 2 ** (index * 8)
      }
      for (let index = 0; index < 3; index++) {
        if (!(command & (1 << (index + 4)))) continue
        if (cursor >= bytes.length) return false
        count += bytes[cursor++]! * 2 ** (index * 8)
      }
      count ||= 0x10000
      if (offset + count > source) return false
      output += count
    } else {
      if (!command || cursor + command > bytes.length) return false
      cursor += command
      output += command
    }
    if (output > target) return false
  }
  return output === target
}

/** Validate both directions before Git can inflate a binary patch or allocate its declared delta result. */
export function boundedBinaryPatch(block: string, limit: number) {
  const start = block.indexOf("\nGIT binary patch\n")
  if (start < 0) return true
  const lines = block.slice(start + "\nGIT binary patch\n".length).split("\n")
  let cursor = 0
  let sections = 0
  try {
    while (cursor < lines.length) {
      while (lines[cursor] === "") cursor++
      if (cursor >= lines.length) break
      const header = /^(literal|delta) (\d+)$/.exec(lines[cursor++]!)
      if (!header || ++sections > 2) return false
      const size = Number(header[2])
      if (!Number.isSafeInteger(size) || size > limit) return false
      const encoded: string[] = []
      while (cursor < lines.length && lines[cursor] !== "") encoded.push(lines[cursor++]!)
      const bytes = inflateSync(decode(encoded), { maxOutputLength: Math.max(1, Math.min(limit + 1, size + 1)) })
      if (bytes.length !== size || (header[1] === "delta" && !deltaValid(bytes, limit))) return false
    }
    return sections > 0
  } catch {
    return false
  }
}
