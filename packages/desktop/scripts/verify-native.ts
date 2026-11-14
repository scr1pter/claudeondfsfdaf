import { lstat, readdir, readFile, realpath } from "node:fs/promises"
import path from "node:path"

// Runs from electron-builder's afterPack under Node, so it uses node: APIs only.
//
// Bun installs only the host CPU's optional packages unless told otherwise, and electron-builder copies only what is
// installed, so an app packaged for another architecture silently carries the build machine's native modules. 1.99.99
// shipped that way: its Intel Mac, Windows ARM64 and Linux ARM64 apps held only the host's @lydell/node-pty, which
// throws while loading, so they could not open. Every packaged app must carry these for its own platform and arch.
export function requiredNativePackages(platform: NativePlatform, arch: string) {
  return [
    `@lydell/node-pty-${platform}-${arch}`,
    `@parcel/watcher-${platform}-${arch}${platform === "linux" ? "-glibc" : ""}`,
  ]
}

export type NativePlatform = "darwin" | "win32" | "linux"

export async function verifyNativeModules(
  resources: string,
  platform: NativePlatform,
  arch: string,
  options: { skipComputerHelper?: boolean } = {},
) {
  if (!options.skipComputerHelper) await verifyNativeComputerHelper(resources, platform, arch)
  const root = path.join(resources, "app.asar.unpacked", "node_modules")
  const binaries = await nativeBinaries(root)
  const problems = (
    await Promise.all(
      requiredNativePackages(platform, arch).map(async (pkg) => {
        const files = binaries.filter((file) =>
          `/${path.relative(root, file).split(path.sep).join("/")}`.includes(`/${pkg}/`),
        )
        if (!files.length) return [`${pkg} has no .node binary under ${root}`]
        const found = await Promise.all(files.map(async (file) => binaryArchitectures(await readFile(file))))
        return files.flatMap((file, index) =>
          found[index].includes(arch)
            ? []
            : [`${file} is built for ${found[index].join(", ") || "an unknown CPU"}, not ${arch}`],
        )
      }),
    )
  ).flat()
  if (!problems.length) return
  throw new Error(
    [
      `The ${platform}-${arch} app is missing native modules for its own architecture, so it would crash on launch. Install every CPU's optional packages (bun install --cpu='*') before packaging:`,
      ...problems.map((problem) => `  - ${problem}`),
    ].join("\n"),
  )
}

/** Checks the actual package layout before launch; final signature and manifest checks run separately. */
export async function verifyNativeComputerHelper(resources: string, platform: NativePlatform, arch: string) {
  if (platform === "linux") return
  if (arch !== "x64" && arch !== "arm64") throw new Error("The packaged computer helper architecture is unsupported.")
  const root = await realpath(platform === "darwin" ? path.dirname(resources) : resources)
  const file = path.join(
    root,
    platform === "darwin" ? "Helpers/VectorComputer.app/Contents/MacOS/VectorComputer" : "computer/vector-computer.exe",
  )
  const metadata = await lstat(file).catch(() => undefined)
  if (
    !metadata?.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 64 ||
    metadata.size > 64 * 1024 * 1024 ||
    (await realpath(file)) !== file
  )
    throw new Error("The packaged computer helper is missing or is not a bounded regular file at its required location.")
  const bytes = await readFile(file)
  if (
    platform === "darwin"
      ? bytes.readUInt32LE(0) !== 0xfeedfacf && bytes.readUInt32BE(0) !== 0xcafebabe
      : bytes.readUInt16LE(0) !== 0x5a4d
  )
    throw new Error("The packaged computer helper has an invalid executable format for its platform.")
  const found = binaryArchitectures(bytes)
  if (!found.includes(arch))
    throw new Error(`The packaged computer helper is built for ${found.join(", ") || "an unknown CPU"}, not ${arch}.`)
}

async function nativeBinaries(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(
    entries.map((entry) => {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) return nativeBinaries(file)
      return entry.isFile() && entry.name.endsWith(".node") ? [file] : []
    }),
  )
  return nested.flat()
}

const MACHO_CPU: Record<number, string> = { 0x7: "ia32", 0x1000007: "x64", 0x100000c: "arm64" }
const ELF_MACHINE: Record<number, string> = { 0x3: "ia32", 0x28: "armv7l", 0x3e: "x64", 0xb7: "arm64" }
const PE_MACHINE: Record<number, string> = { 0x14c: "ia32", 0x8664: "x64", 0xaa64: "arm64" }

// The CPUs a native module was compiled for, read from its Mach-O (thin or fat), ELF or PE header.
export function binaryArchitectures(bytes: Buffer) {
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) return [MACHO_CPU[bytes.readUInt32LE(4)] ?? "unknown"]
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xcafebabe) {
    const count = Math.min(bytes.readUInt32BE(4), Math.floor((bytes.length - 8) / 20))
    return Array.from({ length: count }, (_, index) => MACHO_CPU[bytes.readUInt32BE(8 + index * 20)] ?? "unknown")
  }
  if (bytes.length >= 20 && bytes.readUInt32BE(0) === 0x7f454c46) {
    const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18)
    return [ELF_MACHINE[machine] ?? "unknown"]
  }
  if (bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d) {
    const offset = bytes.readUInt32LE(0x3c)
    if (bytes.length >= offset + 6 && bytes.readUInt32LE(offset) === 0x4550)
      return [PE_MACHINE[bytes.readUInt16LE(offset + 4)] ?? "unknown"]
  }
  return []
}
