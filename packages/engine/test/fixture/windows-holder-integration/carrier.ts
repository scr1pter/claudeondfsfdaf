import { createHash } from "node:crypto"
import type { DeliveryReceipt } from "../../../src/tool/shell/windows-holder"
import { integrationRunner } from "./scope"

const maximumBytes = 1_048_576
const bootstrapPhases = ["spawn", "carrier-entered", "prefix-verified", "assembly-loaded"] as const
let recorded = false

export function carrierBootstrapPhase(step: number) {
  return bootstrapPhases[step]
}

export function recordCarrierReady(timings: DeliveryReceipt) {
  if (recorded) return
  recorded = true
  console.log("Verified Windows carrier transport: " + JSON.stringify(timings))
}

export async function preparePowerShellCarrier() {
  const context = integrationRunner()
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT
  if (process.env.VECTOR_DIRECT_HOLDER_BACKEND !== "carrier" || root?.toLowerCase() !== "c:\\windows")
    throw new Error("The verified Windows carrier was not selected for its hosted x64 fixture.")
  const { asset } = await import(new URL("./asset.generated.ts", import.meta.url).href)
  if (
    asset.arch !== context.arch ||
    asset.run !== context.run ||
    asset.attempt !== context.attempt ||
    asset.revision !== context.revision ||
    typeof asset.base64 !== "string" ||
    asset.base64.length > Math.ceil(maximumBytes / 3) * 4 ||
    typeof asset.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(asset.sha256)
  ) {
    throw new Error("Invalid embedded Windows carrier fixture.")
  }
  const bytes = Buffer.from(asset.base64, "base64")
  if (!bytes.length || bytes.length > maximumBytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
    throw new Error("Invalid Windows carrier fixture bytes.")
  // The ARM64 console entrypoint verifies that the carrier itself is a native process before entering the holder.
  const entry =
    context.arch === "arm64"
      ? "$assembly.EntryPoint"
      : "$assembly.GetType('VectorShellHolder',$true).GetMethod('Run',[Type]::EmptyTypes)"

  // Only validated numeric length and hex digest enter this fixed script. Stdin starts with the paired fixture bytes.
  const script = String.raw`$ErrorActionPreference='Stop'
[Console]::Error.WriteLine('VECTOR_SHELL/1 {"type":"startup","step":1}')
try {
  $length=${bytes.length}
  [byte[]]$bytes=[Array]::CreateInstance([byte],$length)
  $stream=[Console]::OpenStandardInput()
  $offset=0
  while ($offset -lt $length) {
    $read=$stream.Read($bytes,$offset,$length-$offset)
    if ($read -le 0) { throw 'Incomplete fixture prefix' }
    $offset += $read
  }
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $hex=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() }
  finally { $sha.Dispose() }
  if ($hex -cne '${asset.sha256}') { throw 'Invalid fixture prefix' }
  [Console]::Error.WriteLine('VECTOR_SHELL/1 {"type":"startup","step":2}')
  $assembly=[Reflection.Assembly]::Load($bytes)
  $entry=${entry}
  if ($null -eq $entry -or -not $entry.IsStatic -or $entry.ReturnType -ne [int]) { throw 'Invalid fixture entry point' }
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
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  if (encoded.length > 5_000) throw new Error("The Windows carrier exceeds the fixture command limit.")
  return {
    bytes,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-InputFormat",
      "Text",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      encoded,
    ],
  }
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
      if (prefixSent) throw new Error("Duplicate Windows carrier prefix.")
      prefixSent = true
      writePrefix()
    },
    afterStatus(step: number | undefined, active: boolean) {
      if (!prefixSent || configSent || !active || step === undefined || step < 3) return
      // Step 5 announces the reader is ready. Later phases require received configuration bytes.
      if (step > 5) throw new Error("Windows carrier advanced before its configuration was sent.")
      configSent = true
      writeConfig()
    },
  }
}
