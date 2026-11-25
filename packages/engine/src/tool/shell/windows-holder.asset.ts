export type TrustedWindowsHolderAsset = Readonly<{
  arch: "x64" | "arm64"
  sha256: string
  base64: string
}>

// Only the explicitly verified build replaces this module. Source-tree and ordinary builds have no direct holder.
export const trustedWindowsX64Holder: TrustedWindowsHolderAsset | undefined = undefined
export const trustedWindowsArm64Holder: TrustedWindowsHolderAsset | undefined = undefined
