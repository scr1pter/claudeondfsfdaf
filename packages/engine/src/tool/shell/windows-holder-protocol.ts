const headerBytes = 8
const lengthBytes = 4
const maxPayloadBytes = 524_288

export type NativeHolderLaunch = Readonly<{
  file: string
  commandLine: string
  cwd: string
  env: Readonly<Record<string, string>>
}>

/** Encode the private native holder input as counted little-endian UTF-16 strings. */
export function encodeNativeHolderLaunch(input: NativeHolderLaunch) {
  const fields = [input.file, input.commandLine, input.cwd]
  if (fields.some((field) => !field || field.includes("\0")) || input.commandLine.length > 32_766)
    throw new Error("Invalid Windows holder command")

  const environment = Object.entries(input.env)
  let payload = lengthBytes + fields.reduce((bytes, field) => bytes + lengthBytes + field.length * 2, 0)
  let blockUnits = 1
  for (const [name, value] of environment) {
    if (!name || name.includes("=") || name.includes("\0") || value.includes("\0"))
      throw new Error("Invalid Windows holder environment")
    payload += lengthBytes * 2 + (name.length + value.length) * 2
    blockUnits += name.length + value.length + 2
  }
  if (blockUnits > 65_536 || payload > maxPayloadBytes) throw new Error("Windows holder configuration is too large")

  const frame = Buffer.allocUnsafe(headerBytes + payload)
  frame.write("VSH1", 0, 4, "ascii")
  frame.writeUInt32LE(payload, 4)
  let offset = headerBytes
  const writeString = (value: string) => {
    offset = frame.writeUInt32LE(value.length, offset)
    offset += frame.write(value, offset, value.length * 2, "utf16le")
  }
  for (const field of fields) writeString(field)
  offset = frame.writeUInt32LE(environment.length, offset)
  for (const [name, value] of environment) {
    writeString(name)
    writeString(value)
  }
  return frame
}
