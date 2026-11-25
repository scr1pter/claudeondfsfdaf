import { createHash } from "node:crypto"
import { release } from "node:os"
import { argumentsForScript } from "./windows-holder"
import {
  trustedWindowsArm64Holder,
  trustedWindowsX64Holder,
  type TrustedWindowsHolderAsset,
} from "./windows-holder.asset"

const maximumBytes = 1_048_576
const phaseNames = { "utility-loaded": "prefix-verified", "compiler-returned": "assembly-loaded" } as const

export function carrierPhase(phase: string) {
  return phase === "utility-loaded" || phase === "compiler-returned" ? phaseNames[phase] : phase
}

export function compiledWindowsHolderArchitecture(systemRoot: string): TrustedWindowsHolderAsset["arch"] | undefined {
  if (systemRoot.toLowerCase() !== "c:\\windows") return
  // Windows 11 22H2 ships native ARM64 .NET Framework 4.8.1.
  if (process.arch === "x64" || (process.arch === "arm64" && Number(release().split(".")[2]) >= 22_621))
    return process.arch
}

// Use the pinned System32 carrier on the standard Windows installation. An unbundled build can still use the legacy holder.
export function windowsHolderCarrier(systemRoot: string) {
  const arch = compiledWindowsHolderArchitecture(systemRoot)
  const asset = arch === "x64" ? trustedWindowsX64Holder : arch === "arm64" ? trustedWindowsArm64Holder : undefined
  if (!asset) return
  if (asset.arch !== arch) throw new Error("The Windows containment holder asset has the wrong architecture")
  return prepareCarrier(asset)
}

export function prepareCarrier(asset: TrustedWindowsHolderAsset) {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || asset.base64.length > Math.ceil(maximumBytes / 3) * 4)
    throw new Error("The Windows containment holder asset is invalid")
  const bytes = Buffer.from(asset.base64, "base64")
  if (!bytes.length || bytes.length > maximumBytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error("The Windows containment holder asset failed verification")
  // The ARM64 entry point first verifies that the PowerShell process is native ARM64.
  const entry =
    asset.arch === "arm64"
      ? "$assembly.EntryPoint"
      : "$assembly.GetType('VectorShellHolder',$true).GetMethod('Run',[Type]::EmptyTypes)"

  // Only validated numeric length and hex digest enter this fixed script. Stdin starts with the build-verified holder bytes.
  const script = String.raw`$ErrorActionPreference='Stop'
[Console]::Error.WriteLine('VECTOR_SHELL/1 {"type":"startup","step":1}')
try {
  $length=${bytes.length}
  [byte[]]$bytes=[Array]::CreateInstance([byte],$length)
  $stream=[Console]::OpenStandardInput()
  $offset=0
  while ($offset -lt $length) {
    $read=$stream.Read($bytes,$offset,$length-$offset)
    if ($read -le 0) { throw 'Incomplete holder bytes' }
    $offset += $read
  }
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $hex=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
  if ($hex -cne '${asset.sha256}') { throw 'Invalid holder bytes' }
  [Console]::Error.WriteLine('VECTOR_SHELL/1 {"type":"startup","step":2}')
  $assembly=[Reflection.Assembly]::Load($bytes)
  $entry=${entry}
  if ($null -eq $entry -or -not $entry.IsStatic -or $entry.ReturnType -ne [int]) { throw 'Invalid holder entry point' }
} catch {
  [Console]::Error.WriteLine('VECTOR_SHELL/1 {"type":"error","terminationProven":true,"message":"The Windows carrier could not verify and load the holder"}')
  exit 1
}
[Console]::Error.WriteLine('VECTOR_SHELL/1 {"type":"startup","step":3}')
try { $code=[int]$entry.Invoke($null,$null) }
catch {
  [Console]::Error.WriteLine('VECTOR_SHELL/1 {"type":"error","terminationProven":false,"message":"The Windows carrier could not invoke the holder"}')
  exit 1
}
exit $code`
  return { bytes, args: argumentsForScript(script, 5_000) }
}

/** Only full, successfully processed status chunks may authorize a separate configuration write. */
export function carrierDelivery(writePrefix: () => void, writeConfig: () => void) {
  let prefixSent = false
  let configSent = false
  return {
    get configurationSent() {
      return configSent
    },
    begin() {
      if (prefixSent) throw new Error("Duplicate Windows containment holder prefix")
      prefixSent = true
      writePrefix()
    },
    afterStatus(step: number | undefined, active: boolean) {
      if (!prefixSent || configSent || !active || step === undefined || step < 3) return
      // Native step 4 announces the read. Later native phases require a successfully parsed configuration.
      if (step > 4) throw new Error("Windows containment holder advanced before receiving its configuration")
      configSent = true
      writeConfig()
    },
  }
}
