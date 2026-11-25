param(
  [string]$Version = 'latest',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Vector\bin'),
  [ValidateSet('vector.exe', 'vector-native.exe')][string]$BinaryName = 'vector.exe',
  [int]$WaitForProcessId = 0,
  [long]$WaitForStartTicks = 0,
  [string]$OperationId = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.IO.Compression.FileSystem
$utf8 = New-Object System.Text.UTF8Encoding($false)
$versionPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'
if ($Version -notin @('latest', 'beta') -and ($Version.Length -gt 100 -or $Version -cnotmatch $versionPattern)) { throw 'Invalid Vector version.' }
if (-not [IO.Path]::IsPathRooted($InstallDir) -or $InstallDir -match '[\x00-\x1f]') { throw 'InstallDir must be an absolute path without control characters.' }
if (($WaitForProcessId -gt 0) -ne ($WaitForStartTicks -gt 0) -or (($WaitForProcessId -gt 0) -and $OperationId -cnotmatch '^[a-f0-9]{32}$')) { throw 'Invalid deferred installation identity.' }
if ($WaitForProcessId -eq 0 -and $OperationId) { throw 'An operation identifier requires an exact waiting process.' }
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
$target = switch ($architecture) { 'Arm64' { 'windows-arm64' } 'X64' { 'windows-x64-baseline' } default { throw "Unsupported Windows architecture: $architecture" } }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
[IO.Directory]::CreateDirectory($InstallDir) | Out-Null
$destination = Join-Path $InstallDir $BinaryName
$metadata = Join-Path $InstallDir ".vector-$BinaryName"
$receipt = Join-Path $metadata 'receipt.tsv'
$lockPath = Join-Path $InstallDir ".vector-$BinaryName.lock"
$lock = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$stage = Join-Path $InstallDir ('.vector-stage-' + [Guid]::NewGuid().ToString('N'))
$statusPath = if ($OperationId) { Join-Path $InstallDir ".vector-update-$OperationId.json" } else { $null }
$statusCreated = $false
$replaced = $false
$metadataReplaced = $false
$committed = $false
$rollbackFailed = $false
$hadOriginal = Test-Path -LiteralPath $destination
$priorChannel = ''
$oldBinary = Join-Path $stage 'old-binary.exe'
$oldMetadata = Join-Path $stage 'old-metadata'
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $false
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromMinutes(5)

# The status writer, the hashes and the deferred waits use operators and .NET only: a cmdlet sends Windows PowerShell
# 5.1 through command discovery and module auto-load first, which stalled a deferred worker on CI.
function Write-OperationStatus([string]$state, [string]$message) {
  if (-not $statusPath) { return }
  # JSON-escape quotes, backslashes and control characters as \uXXXX without a serializer cmdlet.
  $escape = { param($found) '\u{0:x4}' -f [int][char]$found.Value }
  $json = '{"schemaVersion":1,"state":"' + [regex]::Replace($state, '[\\"\x00-\x1f]', $escape) + '","version":"' + [regex]::Replace($Version, '[\\"\x00-\x1f]', $escape) + '","message":"' + [regex]::Replace($message, '[\\"\x00-\x1f]', $escape) + '"}'
  if (-not $script:statusCreated) {
    $stream = [IO.File]::Open($statusPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $bytes = $utf8.GetBytes($json); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    $script:statusCreated = $true
    return
  }
  $temporary = [IO.Path]::Combine($stage, 'status.json')
  [IO.File]::WriteAllText($temporary, $json, $utf8)
  # PowerShell converts ordinary $null to an empty string for .NET string arguments.
  [IO.File]::Replace($temporary, $statusPath, [System.Management.Automation.Language.NullString]::Value)
}

function Download-VectorFile([string]$url, [string]$output, [long]$limit) {
  if (-not $url.StartsWith('https://')) { throw 'Only HTTPS downloads are allowed.' }
  $cancellation = New-Object Threading.CancellationTokenSource
  $cancellation.CancelAfter([TimeSpan]::FromMinutes(5))
  $response = $null
  try {
    $response = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancellation.Token).GetAwaiter().GetResult()
    if ([int]$response.StatusCode -ne 200) { throw 'Download returned an error or unexpected redirect.' }
    if ($response.Content.Headers.ContentLength -gt $limit) { throw 'Download exceeds the expected size.' }
    $bodyStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $file = [IO.File]::Open($output, [IO.FileMode]::CreateNew)
    try {
      $buffer = New-Object byte[] 65536
      [long]$total = 0
      while ($true) {
        $read = $bodyStream.ReadAsync($buffer, 0, $buffer.Length, $cancellation.Token)
        # .NET Framework's HTTP stream ignores cancellation after a read starts; bound the wait separately.
        $read.Wait($cancellation.Token)
        $count = $read.GetAwaiter().GetResult()
        if ($count -eq 0) { break }
        $total += $count
        if ($total -gt $limit) { throw 'Download exceeds the expected size.' }
        $file.Write($buffer, 0, $count)
      }
    } finally { $file.Dispose(); $bodyStream.Dispose() }
  } finally { if ($null -ne $response) { $response.Dispose() }; $cancellation.Dispose() }
}

function Assert-Regular([string]$path) {
  $item = Get-Item -LiteralPath $path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'An installation file is a link or is not a regular file.' }
}

# parentTicks returns $null once the waiting process is gone and '' while it is exiting or its start time cannot be
# read, so every identity check compares strings instead of calling a method on a null-valued start time.
function parentTicks {
  try { $process = [Diagnostics.Process]::GetProcessById($WaitForProcessId) } catch { if ($_.Exception.GetBaseException() -is [ArgumentException]) { return $null }; throw }
  try { return $process.StartTime.ToUniversalTime().Ticks.ToString() } catch { return '' } finally { $process.Dispose() }
}

# Windows PowerShell 5.1's own file hash command uses the CryptoServiceProvider class, which is FIPS-validated;
# SHA256::Create() gives SHA256Managed, which throws on a machine whose policy allows only FIPS algorithms.
function fileSha256([string]$path) {
  $stream = [IO.File]::OpenRead($path)
  try {
    $sha = [Security.Cryptography.SHA256CryptoServiceProvider]::new()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

function holderDigest([string]$name, [string]$releaseTarget) {
  $arch = switch -CaseSensitive ($releaseTarget) {
    'windows-arm64' { 'arm64' }
    'windows-x64' { 'x64' }
    'windows-x64-baseline' { 'x64' }
    default { throw 'Invalid Windows holder target.' }
  }
  $match = [regex]::Match($name, "\Avector-holder-${arch}-([a-f0-9]{64})\.exe\z")
  if (-not $match.Success) { throw 'Invalid Windows holder filename.' }
  return $match.Groups[1].Value
}

function Assert-Holder([string]$path, [string]$digest) {
  $attributes = [IO.File]::GetAttributes($path)
  if ($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) { throw 'The Windows holder must be a regular file.' }
  $size = [IO.FileInfo]::new($path).Length
  if ($size -le 0 -or $size -gt 1048576 -or (fileSha256 $path) -cne $digest) { throw 'Windows holder checksum or size did not match.' }
}

try {
  [IO.Directory]::CreateDirectory($stage) | Out-Null
  if ($OperationId) { Write-OperationStatus 'preparing' 'Downloading and verifying the requested Vector release.' }
  if ((Test-Path -LiteralPath $destination) -or (Test-Path -LiteralPath $metadata)) {
    Assert-Regular $destination
    Assert-Regular $receipt
    $info = Get-Item -LiteralPath $metadata -Force
    if (-not $info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid standalone metadata directory.' }
    $row = [IO.File]::ReadAllText($receipt)
    if ($row -cnotmatch '\Avector-standalone\t(1|2)\t[^\t\r\n]+\t[^\t\r\n]+\t(latest|beta)\t[^\t\r\n]+\t[a-f0-9]{64}\t[a-f0-9]{64}(\t[^\t\r\n]+)?\n\z') { throw 'Invalid standalone receipt.' }
    $fields = $row.TrimEnd("`n").Split("`t")
    if ($fields[2].Length -gt 100 -or $fields[2] -cnotmatch $versionPattern -or $fields[3] -cnotmatch '^(darwin-(arm64|x64(-baseline)?)|linux-(arm64|x64(-baseline)?)(-musl)?|windows-(arm64|x64(-baseline)?))$') { throw 'Invalid receipt version or target.' }
    if (($fields[1] -ceq '1' -and $fields.Length -ne 8) -or ($fields[1] -ceq '2' -and $fields.Length -ne 9)) { throw 'Invalid standalone receipt.' }
    if ($fields[1] -ceq '2') { $null = holderDigest $fields[8] $fields[3] }
    $priorChannel = $fields[4]
    if ($fields[5] -cne $BinaryName -or (fileSha256 $destination) -cne $fields[6]) { throw 'Existing executable differs from its standalone receipt; it was not overwritten.' }
    $names = @(Get-ChildItem -LiteralPath $metadata -Force | ForEach-Object { $_.Name } | Sort-Object)
    if (($names -join '|') -cne 'DEPENDENCY_NOTICES.md|LICENSE|receipt.tsv|THIRD_PARTY_NOTICES.md') { throw 'Standalone metadata contains unrelated files; preserve or move them first.' }
    foreach ($name in @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'DEPENDENCY_NOTICES.md')) { Assert-Regular (Join-Path $metadata $name) }
  }
  $releaseFile = Join-Path $stage 'release.json'
  Download-VectorFile "https://vectordev.ai/api/cli-release?version=$Version&target=$target" $releaseFile 64000
  $release = [IO.File]::ReadAllText($releaseFile) | ConvertFrom-Json
  $names = @($release.PSObject.Properties.Name | Sort-Object)
  if (($names -join '|') -cne 'filename|pathname|sha256|size|target|url|version') { throw 'Invalid release response fields.' }
  if ($release.version -cnotmatch $versionPattern -or $release.version.Length -gt 100 -or $release.target -cne $target) { throw 'Invalid release version or target.' }
  if ($Version -notin @('latest', 'beta') -and $release.version -cne $Version) { throw 'Server returned a different version.' }
  if ($Version -eq 'latest' -and $release.version.Contains('-')) { throw 'Stable channel returned a prerelease.' }
  if ($release.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $release.size -notmatch '^[1-9][0-9]{0,9}$' -or [long]$release.size -gt 1000000000) { throw 'Invalid archive checksum or size.' }
  $uri = [Uri]$release.url
  $expectedPath = "releases/vector-cli/v$($release.version)/vector-$target.zip"
  if ($uri.Scheme -cne 'https' -or $uri.Host -cnotmatch '^[a-z0-9]+\.public\.blob\.vercel-storage\.com$' -or $release.url -cne "https://$($uri.Host)/$expectedPath" -or $release.pathname -cne $expectedPath -or $release.filename -cne "vector-$target.zip") { throw 'Invalid archive URL.' }
  $archive = Join-Path $stage 'archive.zip'
  Download-VectorFile $release.url $archive ([long]$release.size)
  if ((Get-Item -LiteralPath $archive).Length -ne [long]$release.size -or (fileSha256 $archive) -cne $release.sha256) { throw 'Archive checksum or size did not match; existing installation is unchanged.' }
  $extracted = Join-Path $stage 'extracted'
  [IO.Directory]::CreateDirectory($extracted) | Out-Null
  $holder = $null
  $expectedEntries = @('DEPENDENCY_NOTICES.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'vector.exe')
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    $entries = @($zip.Entries.FullName)
    if ($entries.Length -ne 4 -and $entries.Length -ne 5) { throw 'Archive contains unexpected paths or duplicate entries.' }
    foreach ($name in $expectedEntries) {
      if (@($entries -ceq $name).Length -ne 1) { throw 'Archive contains unexpected paths or duplicate entries.' }
    }
    if ($entries.Length -eq 5) {
      $holder = $entries | Where-Object { $_ -cnotin $expectedEntries }
      $digest = holderDigest $holder $target
    }
    [long]$total = 0
    foreach ($entry in $zip.Entries) {
      $kind = ($entry.ExternalAttributes -shr 16) -band 0xf000
      if ($kind -ne 0 -and $kind -ne 0x8000) { throw 'Archive links and special files are forbidden.' }
      if ($entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint) { throw 'Archive reparse points are forbidden.' }
      if ($holder -and $entry.FullName -ceq $holder -and ($entry.Length -le 0 -or $entry.Length -gt 1048576)) { throw 'Windows holder exceeds its size limit.' }
      $total += $entry.Length
      if ($total -gt 1000000000) { throw 'Extracted archive is too large.' }
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $extracted $entry.FullName), $false)
    }
  } finally { $zip.Dispose() }
  if ($holder) {
    $stagedHolder = [IO.Path]::Combine($extracted, $holder)
    Assert-Holder $stagedHolder $digest
  }
  $stagedBinary = Join-Path $extracted 'vector.exe'
  $reported = & $stagedBinary --version
  if ($LASTEXITCODE -ne 0 -or ($reported -join "`n") -cne $release.version) { throw 'Verified binary reports a different version; existing installation is unchanged.' }
  $newMetadata = Join-Path $stage 'new-metadata'
  [IO.Directory]::CreateDirectory($newMetadata) | Out-Null
  foreach ($name in @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'DEPENDENCY_NOTICES.md')) { [IO.File]::Move((Join-Path $extracted $name), (Join-Path $newMetadata $name)) }
  $channel = if ($Version -eq 'beta' -or $release.version.Contains('-') -or ($Version -ne 'latest' -and $priorChannel -eq 'beta')) { 'beta' } else { 'latest' }
  $binaryHash = fileSha256 $stagedBinary
  $receiptSchema = if ($holder) { '2' } else { '1' }
  $receiptSuffix = if ($holder) { "`t$holder`n" } else { "`n" }
  [IO.File]::WriteAllText((Join-Path $newMetadata 'receipt.tsv'), "vector-standalone`t$receiptSchema`t$($release.version)`t$target`t$channel`t$BinaryName`t$binaryHash`t$($release.sha256)$receiptSuffix", $utf8)
  if ($WaitForProcessId -gt 0) {
    $expected = $WaitForStartTicks.ToString()
    if ((parentTicks) -ne $expected) { throw 'The upgrading process identity changed before preparation.' }
    Write-OperationStatus 'prepared' 'Verified update is waiting for Vector to exit.'
    $acknowledgement = "$statusPath.ready"
    $ackDeadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not [IO.File]::Exists($acknowledgement)) {
      if ((parentTicks) -ne $expected -or [DateTime]::UtcNow -gt $ackDeadline) { throw 'Vector did not acknowledge the prepared update; the existing installation remains unchanged.' }
      [Threading.Thread]::Sleep(50)
    }
    if ([IO.File]::GetAttributes($acknowledgement) -band [IO.FileAttributes]::ReparsePoint) { throw 'An installation file is a link or is not a regular file.' }
    if ([IO.File]::ReadAllText($acknowledgement) -cne "ready`n") { throw 'Invalid prepared-update acknowledgement.' }
    $deadline = [DateTime]::UtcNow.AddMinutes(15)
    while ($null -ne ($ticks = parentTicks)) {
      # Exiting: no start time to compare, so it waits for the process to be gone.
      if ($ticks -ne '' -and $ticks -ne $expected) { throw 'The upgrading process identity changed.' }
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Timed out waiting for Vector to exit; the old version remains installed.' }
      [Threading.Thread]::Sleep(200)
    }
  }
  if ($holder) {
    $holderDestination = [IO.Path]::Combine($InstallDir, $holder)
    if (-not [IO.File]::Exists($holderDestination)) {
      try { [IO.File]::Move($stagedHolder, $holderDestination) } catch {
        # A different standalone binary may install the same digest under its own lock.
        if (-not [IO.File]::Exists($holderDestination)) { throw }
      }
    }
    Assert-Holder $holderDestination $digest
  }
  if ($hadOriginal) {
    $replaced = $true
    [IO.File]::Replace($stagedBinary, $destination, $oldBinary)
  } else {
    [IO.File]::Move($stagedBinary, $destination)
    $replaced = $true
  }
  if (Test-Path -LiteralPath $metadata) { [IO.Directory]::Move($metadata, $oldMetadata) }
  [IO.Directory]::Move($newMetadata, $metadata)
  $metadataReplaced = $true
  $committed = $true
  try { Write-OperationStatus 'complete' "Vector $($release.version) is installed." } catch { Write-Warning "Vector is installed, but completion status could not be written: $statusPath" }
  Write-Host "Vector $($release.version) installed at $destination"
  Write-Host "Add this directory to PATH if needed: $InstallDir"
} catch {
  $failure = $_
  if (-not $committed) {
    try {
      if ($metadataReplaced -and (Test-Path -LiteralPath $metadata)) { Remove-Item -LiteralPath $metadata -Recurse -Force }
      if (Test-Path -LiteralPath $oldMetadata) { [IO.Directory]::Move($oldMetadata, $metadata) }
    } catch { $rollbackFailed = $true }
    try {
      if ($replaced) {
        if ([IO.File]::Exists($oldBinary)) {
          if ([IO.File]::Exists($destination)) {
            [IO.File]::Replace($oldBinary, $destination, [System.Management.Automation.Language.NullString]::Value)
          } else { [IO.File]::Move($oldBinary, $destination) }
        } elseif (-not $hadOriginal) { [IO.File]::Delete($destination) }
      }
    } catch { $rollbackFailed = $true }
  }
  if ($rollbackFailed) { Write-Warning "Rollback could not finish. Recovery files were preserved at $stage" }
  if ($statusCreated) { try { Write-OperationStatus 'failed' $failure.Exception.Message } catch { Write-Warning "Could not update operation status at $statusPath" } }
  Write-Error $failure -ErrorAction Continue
  exit 1
} finally {
  $client.Dispose()
  $handler.Dispose()
  if (-not $rollbackFailed -and (Test-Path -LiteralPath $stage)) {
    try { Remove-Item -LiteralPath $stage -Recurse -Force } catch { Write-Warning "Temporary files remain at $stage" }
  }
  $lock.Dispose()
  try { [IO.File]::Delete($lockPath) } catch { Write-Warning "Inspect the installation lock at $lockPath before another operation." }
  if ($statusCreated) { Remove-Item -LiteralPath "$statusPath.ready" -Force -ErrorAction SilentlyContinue }
  if ($OperationId) {
    $helper = Join-Path $InstallDir ".vector-upgrade-$OperationId"
    if ($PSCommandPath -ceq (Join-Path $helper 'install.ps1')) { Remove-Item -LiteralPath $helper -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
