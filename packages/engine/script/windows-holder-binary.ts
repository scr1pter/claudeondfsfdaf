import type { WindowsHolderWire } from "../src/tool/shell/windows-holder.asset"

export type HolderArchitecture = "x64" | "arm64"

export const maximumExecutableBytes = 1_048_576

const entryPoint =
  "\ninternal static class VectorStandaloneEntryPoint { public static int Main() { return VectorShellHolder.Run(); } }\n"
const armEntryPoint = String.raw`
internal static class VectorStandaloneEntryPoint {
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsWow64Process2(IntPtr process,out ushort machine,out ushort native);
  public static int Main() {
    ushort machine,native;
    if(!IsWow64Process2(new IntPtr(-1),out machine,out native) || machine!=0 || native!=0xaa64) return 63;
    return VectorShellHolder.Run();
  }
}
`

const architectures = {
  x64: { machine: 0x8664, magic: 0x20b, directories: 112, entryPoint },
  arm64: { machine: 0x14c, magic: 0x10b, directories: 96, entryPoint: armEntryPoint },
} satisfies Record<HolderArchitecture, { machine: number; magic: number; directories: number; entryPoint: string }>

/** Use the same maintained containment code for the legacy bootstrap and managed build artifacts. */
export function compiledSource(bytes: Uint8Array, arch: HolderArchitecture) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n")
  const holder = /^const source = String\.raw`([\s\S]*?)^`$/m.exec(source)?.[1]
  if (!holder) throw new Error("The maintained Windows containment source is unavailable")
  return holder + architectures[arch].entryPoint
}

export function validateExecutable(bytes: Buffer, arch: HolderArchitecture) {
  const expected = architectures[arch]
  const invalid = () => new Error("Expected the selected managed Windows console executable")
  if (bytes.length < 272 || bytes.length > maximumExecutableBytes || bytes.readUInt16LE(0) !== 0x5a4d) throw invalid()
  const pe = bytes.readUInt32LE(0x3c)
  const optional = pe + 24
  const clr = optional + expected.directories + 14 * 8
  if (pe < 64 || clr + 8 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) throw invalid()
  const optionalSize = bytes.readUInt16LE(pe + 20)
  const flags = bytes.readUInt16LE(pe + 22)
  if (
    bytes.readUInt16LE(pe + 4) !== expected.machine ||
    optionalSize < expected.directories + 15 * 8 ||
    optional + optionalSize > bytes.length ||
    !(flags & 2) ||
    flags & 0x2000 ||
    bytes.readUInt16LE(optional) !== expected.magic ||
    bytes.readUInt16LE(optional + 68) !== 3 ||
    bytes.readUInt32LE(optional + expected.directories - 4) < 15 ||
    !bytes.readUInt32LE(clr) ||
    bytes.readUInt32LE(clr + 4) < 72
  ) {
    throw invalid()
  }
  if (arch === "arm64") verifyArchitectureNeutralIL(bytes, pe, optional + optionalSize, bytes.readUInt32LE(clr))
}

/** A native holder is a true 64-bit console image with a file-backed code entry point and no CLR header. */
export function validateNativeExecutable(bytes: Buffer, arch: HolderArchitecture) {
  const invalid = () => new Error("Expected the selected native Windows console executable")
  if (bytes.length < 272 || bytes.length > maximumExecutableBytes || bytes.readUInt16LE(0) !== 0x5a4d) throw invalid()
  const pe = bytes.readUInt32LE(0x3c)
  const optional = pe + 24
  const directories = 112
  const clr = optional + directories + 14 * 8
  if (pe < 64 || clr + 8 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) throw invalid()
  const optionalSize = bytes.readUInt16LE(pe + 20)
  const flags = bytes.readUInt16LE(pe + 22)
  const sections = optional + optionalSize
  const count = bytes.readUInt16LE(pe + 6)
  const entry = bytes.readUInt32LE(optional + 16)
  const directoryCount = bytes.readUInt32LE(optional + directories - 4)
  if (
    bytes.readUInt16LE(pe + 4) !== (arch === "x64" ? 0x8664 : 0xaa64) ||
    bytes.readUInt16LE(optional) !== 0x20b ||
    optionalSize < directories + 15 * 8 ||
    directoryCount < 15 ||
    directoryCount > (optionalSize - directories) / 8 ||
    !entry ||
    !(flags & 2) ||
    flags & 0x3100 ||
    bytes.readUInt16LE(optional + 68) !== 3 ||
    (bytes.readUInt16LE(optional + 70) & 0x140) !== 0x140 ||
    bytes.readUInt32LE(clr) ||
    bytes.readUInt32LE(clr + 4) ||
    count < 1 ||
    count > 96 ||
    sections + count * 40 > bytes.length
  )
    throw invalid()

  for (let index = 0; index < count; index++) {
    const section = sections + index * 40
    const delta = entry - bytes.readUInt32LE(section + 12)
    const rawSize = bytes.readUInt32LE(section + 16)
    const rawOffset = bytes.readUInt32LE(section + 20)
    const characteristics = bytes.readUInt32LE(section + 36)
    if (
      delta >= 0 &&
      delta < bytes.readUInt32LE(section + 8) &&
      delta < rawSize &&
      rawOffset >= sections + count * 40 &&
      rawSize <= bytes.length - rawOffset &&
      characteristics & 0x20000000
    )
      return
  }
  throw invalid()
}

/** The release ZIP keeps its existing digest-named holder descriptor for both verified formats. */
export function validatePackagedWindowsHolder(bytes: Buffer, arch: HolderArchitecture): WindowsHolderWire {
  if (bytes.length >= 272) {
    const optional = bytes.readUInt32LE(0x3c) + 24
    const clr = optional + 112 + 14 * 8
    if (
      clr + 8 <= bytes.length &&
      bytes.readUInt16LE(optional) === 0x20b &&
      !bytes.readUInt32LE(clr) &&
      !bytes.readUInt32LE(clr + 4)
    ) {
      validateNativeExecutable(bytes, arch)
      return "vsh1"
    }
  }
  validateExecutable(bytes, arch)
  return "json"
}

function verifyArchitectureNeutralIL(bytes: Buffer, pe: number, section: number, clrRva: number) {
  const count = bytes.readUInt16LE(pe + 6)
  if (count < 1 || count > 96 || section + count * 40 > bytes.length) throw new Error("Invalid PE section table")
  for (let index = 0; index < count; index++, section += 40) {
    const sectionRva = bytes.readUInt32LE(section + 12)
    const rawSize = bytes.readUInt32LE(section + 16)
    const rawOffset = bytes.readUInt32LE(section + 20)
    const delta = clrRva - sectionRva
    if (delta < 0 || delta + 72 > rawSize || rawOffset + delta + 72 > bytes.length) continue
    const flags = bytes.readUInt32LE(rawOffset + delta + 16)
    // COMIMAGE_FLAGS_ILONLY, with both 32BITREQUIRED and 32BITPREFERRED clear.
    if (flags & 1 && !(flags & 0x20002)) return
    break
  }
  throw new Error("Expected architecture-neutral IL without x86 preference")
}
