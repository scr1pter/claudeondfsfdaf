import { createHash } from "node:crypto"

export const maximumNativeSourceBytes = 65_536
export const windowsHolderNativeSources = Object.freeze([
  "packages/engine/native/windows-holder/holder.cpp",
  "packages/engine/native/windows-holder/CMakeLists.txt",
  "packages/engine/src/tool/shell/windows-holder-protocol.ts",
])

/** @param {Uint8Array} bytes */
export function canonicalWindowsHolderNativeSource(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximumNativeSourceBytes)
    throw new Error("Invalid Windows holder source size.")
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  return Buffer.from(decoder.decode(bytes).replaceAll("\r\n", "\n"))
}

/** @param {Readonly<Record<string, Uint8Array>>} sources */
export function windowsHolderNativeSourceSha256(sources) {
  if (Object.keys(sources).length !== windowsHolderNativeSources.length)
    throw new Error("Invalid Windows holder source set.")
  const digest = createHash("sha256").update("vector-windows-holder-native-source-v2\0")
  for (const file of windowsHolderNativeSources) {
    if (!Object.hasOwn(sources, file)) throw new Error("A Windows holder source input is missing.")
    const bytes = canonicalWindowsHolderNativeSource(sources[file])
    const length = Buffer.alloc(4)
    length.writeUInt32LE(bytes.byteLength)
    digest.update(file).update("\0").update(length).update(bytes)
  }
  return digest.digest("hex")
}
