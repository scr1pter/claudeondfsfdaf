import path from "node:path"
import type { ComputerSmokeNativeFiles } from "./computer-overlay-smoke-native-catalog"
import type { ComputerSmokeAsarDiagnostic } from "./computer-overlay-smoke-report"

// This read-only capability probe never supplies a native proof or selects a filesystem provider.
// The actual Electron caller supplies its builtin original-fs and its own fixed resources directory.
export async function computerSmokeAsarCapability(
  virtual: Pick<ComputerSmokeNativeFiles, "lstat"> & { readFile(file: string): Promise<Buffer> },
  physical: ComputerSmokeNativeFiles,
  resources: string,
): Promise<ComputerSmokeAsarDiagnostic> {
  const result: ComputerSmokeAsarDiagnostic = {
    protocol: 1,
    rawRegular: false,
    rawBounded: false,
    rawBytes: 0,
    rawRead: false,
    virtualDirectory: false,
    virtualRead: false,
  }
  try {
    const root = await physical.realpath(resources)
    const archive = path.join(root, "default_app.asar")
    const raw = await physical.lstat(archive)
    result.rawRegular = raw.isFile() && !raw.isSymbolicLink()
    result.rawBounded =
      result.rawRegular && Number.isSafeInteger(raw.size) && raw.size > 0 && raw.size <= 16 * 1024 * 1024
    if (result.rawBounded && (await physical.realpath(archive)).startsWith(root + path.sep)) {
      result.rawBytes = raw.size
      result.rawRead = (await physical.readFile(archive)).byteLength === raw.size
    }
    try {
      result.virtualDirectory = (await virtual.lstat(archive)).isDirectory()
    } catch {}
    // Reading an archive-root through Electron's virtual view may reject; only the boolean survives.
    if (result.rawRead)
      try {
        result.virtualRead = Buffer.isBuffer(await virtual.readFile(archive))
      } catch {}
  } catch {
    // An observation failure is metadata only; the complete catalog still decides admission.
  }
  return result
}
