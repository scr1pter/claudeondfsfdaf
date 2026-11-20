// PowerShell 5.1 treats smart quotes as delimiters and reads BOM-less scripts as ANSI.
// Decode string data at runtime so generated source stays ASCII regardless of path characters.
const literal = (value: string) =>
  `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, "utf8").toString("base64")}')))`

// The worker and the identity probe use operators and .NET only. A cmdlet such as Get-Process or Get-FileHash sends
// Windows PowerShell 5.1 through command discovery and module auto-load first; on CI that stalled a worker for 30 s
// between "preparing" and "prepared" even with the native PSModulePath restored (see ci-harness-repairs.md).
export function identity(pid: number) {
  return `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString()`
}

// parentTicks returns $null once the parent is gone and '' while it is exiting or its start time cannot be read, so
// every identity check compares strings instead of calling a method on a null-valued start time.
export function script(input: {
  pid: number
  startTicks: string
  executable: string
  metadata: string
  lock: string
  statusFile: string
  temporaryDirectory: string
  binarySha256: string
  files: string[]
}) {
  return `$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$status = ${literal(input.statusFile)}
$expected = ${literal(input.startTicks)}
$created = $false
$committed = $false
$lock = $null
function parentTicks {
  try { $process = [Diagnostics.Process]::GetProcessById(${input.pid}) } catch { if ($_.Exception.GetBaseException() -is [ArgumentException]) { return $null }; throw }
  try { return $process.StartTime.ToUniversalTime().Ticks.ToString() } catch { return '' } finally { $process.Dispose() }
}
function executableHash {
  $stream = [IO.File]::OpenRead(${literal(input.executable)})
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}
function preparing($phase) { [IO.File]::WriteAllText($status, '{"state":"preparing","phase":"' + $phase + '"}', $utf8) }
try {
  $file = [IO.File]::Open($status, [IO.FileMode]::CreateNew)
  $file.Dispose()
  $created = $true
  preparing 'identity'
  $ticks = parentTicks
  if ($null -eq $ticks) { throw 'Vector exited before removal was prepared' }
  if ($ticks -ne $expected) { throw 'Process identity changed' }
  preparing 'lock'
  $lock = [IO.File]::Open(${literal(input.lock)}, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  preparing 'hash'
  if ((executableHash) -ne ${literal(input.binarySha256)}) { throw 'Executable changed; removal canceled' }
  [IO.File]::WriteAllText($status, '{"state":"prepared"}', $utf8)
  $acknowledgement = "$status.ready"
  $ackDeadline = [DateTime]::UtcNow.AddSeconds(10)
  while (-not [IO.File]::Exists($acknowledgement)) {
    if ((parentTicks) -ne $expected -or [DateTime]::UtcNow -gt $ackDeadline) { throw 'Vector did not acknowledge the prepared removal; installation remains unchanged' }
    [Threading.Thread]::Sleep(50)
  }
  if (([IO.File]::GetAttributes($acknowledgement) -band [IO.FileAttributes]::ReparsePoint) -or [IO.File]::ReadAllText($acknowledgement) -cne "ready\`n") { throw 'Invalid prepared-removal acknowledgement' }
  $deadline = [DateTime]::UtcNow.AddMinutes(15)
  while ($null -ne ($ticks = parentTicks)) {
    # Exiting: no start time to compare, so it waits for the process to be gone.
    if (($ticks -ne '' -and $ticks -ne $expected) -or [DateTime]::UtcNow -gt $deadline) { throw 'Process identity changed or exit timed out' }
    [Threading.Thread]::Sleep(200)
  }
  if (([IO.File]::GetAttributes(${literal(input.metadata)}) -band [IO.FileAttributes]::ReparsePoint) -or (executableHash) -ne ${literal(input.binarySha256)}) { throw 'Installation changed; removal canceled' }
  ${input.files.map((file) => `[IO.File]::Delete(${literal(file)})`).join("\n  ")}
  if ([IO.Directory]::GetFileSystemEntries(${literal(input.metadata)}).Length -eq 0) { [IO.Directory]::Delete(${literal(input.metadata)}) }
  $committed = $true
  try { [IO.File]::WriteAllText($status, '{"state":"complete"}', $utf8) } catch { [Console]::Error.WriteLine('WARNING: Vector was removed, but its completion status could not be written.') }
} catch {
  # JSON-escape quotes, backslashes and control characters as \\uXXXX without a serializer cmdlet.
  $message = [regex]::Replace($_.Exception.Message, '[\\\\"\\x00-\\x1f]', { param($found) '\\u{0:x4}' -f [int][char]$found.Value })
  if ($created -and -not $committed) { [IO.File]::WriteAllText($status, '{"state":"failed","message":"' + $message + '"}', $utf8) }
  [Console]::Error.WriteLine($_.ToString())
  exit 1
} finally {
  if ($null -ne $lock) { $lock.Dispose(); [IO.File]::Delete(${literal(input.lock)}) }
  if ($created) { try { [IO.File]::Delete("$status.ready") } catch {} }
  try { [IO.Directory]::Delete(${literal(input.temporaryDirectory)}, $true) } catch {}
}

`
}

export * as WindowsRemoval from "./windows-remove"
