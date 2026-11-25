const maxHolderBytes = 1_048_576
const machines = { x64: 0x8664, arm64: 0xaa64 } as const

/** A holder image must be a native Windows console executable for the requested architecture. */
export function validateNativeWindowsHolder(bytes: Buffer, architecture: keyof typeof machines) {
  const invalid = () => new Error("Expected the selected native Windows console executable")
  if (bytes.length < 272 || bytes.length > maxHolderBytes || bytes.readUInt16LE(0) !== 0x5a4d) throw invalid()

  const pe = bytes.readUInt32LE(60)
  const optional = pe + 24
  if (pe < 64 || optional + 112 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) throw invalid()
  const sections = bytes.readUInt16LE(pe + 6)
  const optionalSize = bytes.readUInt16LE(pe + 20)
  const characteristics = bytes.readUInt16LE(pe + 22)
  const sectionTable = optional + optionalSize
  if (
    bytes.readUInt16LE(pe + 4) !== machines[architecture] ||
    optionalSize < 112 ||
    sections < 1 ||
    sections > 96 ||
    sectionTable + sections * 40 > bytes.length ||
    !(characteristics & 0x2) ||
    characteristics & 0x2000 ||
    bytes.readUInt16LE(optional) !== 0x20b ||
    bytes.readUInt16LE(optional + 68) !== 3 ||
    (bytes.readUInt16LE(optional + 70) & 0x140) !== 0x140
  ) {
    throw invalid()
  }

  const entry = bytes.readUInt32LE(optional + 16)
  const imageSize = bytes.readUInt32LE(optional + 56)
  const headerSize = bytes.readUInt32LE(optional + 60)
  const directories = bytes.readUInt32LE(optional + 108)
  if (
    entry === 0 ||
    entry >= imageSize ||
    headerSize < sectionTable + sections * 40 ||
    headerSize > bytes.length ||
    directories > (optionalSize - 112) / 8
  ) {
    throw invalid()
  }
  if (directories > 14) {
    const clr = optional + 112 + 14 * 8
    if (bytes.readUInt32LE(clr) || bytes.readUInt32LE(clr + 4)) throw invalid()
  }

  for (let index = 0; index < sections; index++) {
    const section = sectionTable + index * 40
    const virtualAddress = bytes.readUInt32LE(section + 12)
    const rawSize = bytes.readUInt32LE(section + 16)
    const rawOffset = bytes.readUInt32LE(section + 20)
    const flags = bytes.readUInt32LE(section + 36)
    if (
      flags & 0x20000000 &&
      entry >= virtualAddress &&
      entry - virtualAddress < rawSize &&
      rawOffset >= headerSize &&
      rawOffset + rawSize <= bytes.length
    ) {
      return
    }
  }
  throw invalid()
}
