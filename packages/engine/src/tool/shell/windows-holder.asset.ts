export type TrustedWindowsHolderAsset = Readonly<{
  arch: "x64" | "arm64"
  sha256: string
  base64: string
}>

export type WindowsHolderCompanion = Readonly<{
  arch: TrustedWindowsHolderAsset["arch"]
  size: number
  sha256: string
}>

export type WindowsHolderCompanionBundle = Readonly<{
  placement: "cli" | "electron"
  targets: Readonly<Partial<Record<WindowsHolderCompanion["arch"], WindowsHolderCompanion>>>
}>

// Only the explicitly verified build replaces this module.
export const trustedWindowsX64Holder: TrustedWindowsHolderAsset | undefined = undefined
export const trustedWindowsArm64Holder: TrustedWindowsHolderAsset | undefined = undefined
export const trustedWindowsHolderCompanion: WindowsHolderCompanionBundle | undefined = undefined
