import type { WindowsHolderCompanion } from "./windows-holder.asset"

export function windowsHolderCompanionName(arch: WindowsHolderCompanion["arch"], sha256: string) {
  if ((arch !== "x64" && arch !== "arm64") || sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("Invalid Windows holder companion identity.")
  return `vector-holder-${arch}-${sha256}.exe`
}
