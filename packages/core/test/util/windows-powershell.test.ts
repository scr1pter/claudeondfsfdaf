import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WindowsPowerShell } from "../../src/util/windows-powershell"

test("Windows PowerShell child environments discard inherited module paths without changing other variables", async () => {
  const inherited = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH")),
    PSModulePath: "PowerShell 7 modules",
    psmodulepath: "differently cased inherited modules",
    VECTOR_INSTALLER_ENV_MARKER: "preserved",
    PATH: "preserved child PATH",
  }
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--eval",
      `console.log(JSON.stringify({
        modules: Object.keys(process.env).filter(key => key.toUpperCase() === "PSMODULEPATH"),
        marker: process.env.VECTOR_INSTALLER_ENV_MARKER,
        path: process.env.PATH,
      }))`,
    ],
    {
      env: WindowsPowerShell.environment("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\PowerShell.EXE", inherited),
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  )
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    expect(JSON.parse(stdout)).toEqual({ modules: [], marker: "preserved", path: "preserved child PATH" })
    expect(inherited.PSModulePath).toBe("PowerShell 7 modules")
    expect(inherited.psmodulepath).toBe("differently cased inherited modules")
  } finally {
    child.kill()
    await child.exited
  }
})

test("other commands retain their module paths", () => {
  const env = { PSModulePath: "user modules", PATH: "user path" }
  for (const command of ["pwsh.exe", "bun.exe", "npm", "C:\\tools\\custom-powershell.exe"])
    expect(WindowsPowerShell.environment(command, env)).toBe(env)
})

test.skipIf(process.platform !== "win32")(
  "pwsh to Bun to Windows PowerShell loads native certificate and installer commands",
  async () => {
    // Turbo's strict environment must retain native command discovery before entering the PowerShell chain.
    expect(process.env.PATHEXT?.toUpperCase().split(";"), "Core tests must preserve the host PATHEXT").toContain(".EXE")
    const comspec = process.env.COMSPEC ?? process.env.ComSpec
    expect(comspec, "Core tests must preserve the host ComSpec").toBeDefined()
    expect(await Bun.file(comspec!).exists(), "The inherited ComSpec must identify the native command shell").toBe(true)
    const pwsh = Bun.which("pwsh.exe")
    if (!pwsh) throw new Error("The native module-path regression requires PowerShell 7")
    const root = await mkdtemp(path.join(os.tmpdir(), "vector powershell '"))
    const file = path.join(root, "hash fixture.txt")
    const entry = path.join(root, "child.ts")
    const diagnostic = path.join(root, "diagnostic.json")
    const outerDiagnostic = path.join(root, "pwsh-diagnostic.json")
    const nativeDiagnostic = path.join(root, "native-diagnostic.json")
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
    try {
      await Bun.write(file, "installer hash fixture\n")
      await Bun.write(
        entry,
        `import assert from "node:assert/strict"
      import { appendFileSync } from "node:fs"
      const started = performance.now()
      // Preserve timeout evidence synchronously before termination can stop this process.
      const checkpoint = (phase, details = {}) => appendFileSync(${JSON.stringify(diagnostic)}, JSON.stringify({ phase, at: new Date().toISOString(), elapsedMs: performance.now() - started, ...details }) + "\\n")
      await checkpoint("bun-started")
      const { WindowsPowerShell } = await import(${JSON.stringify(new URL("../../src/util/windows-powershell.ts", import.meta.url).href)})
      await checkpoint("helper-imported")
      assert.ok(process.env.PSModulePath, "pwsh must pass its module paths through Bun")
      const powershell = ${JSON.stringify(path.join(process.env.SYSTEMROOT!, "System32/WindowsPowerShell/v1.0/powershell.exe"))}
      const environment = WindowsPowerShell.environment(powershell)
      const presence = (env) => Object.fromEntries(["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SYSTEMROOT", "PSModulePath", "PSModuleAnalysisCachePath"].map(name => [name, Object.entries(env).some(([key, value]) => key.toUpperCase() === name.toUpperCase() && value !== undefined)]))
      await checkpoint("environment-presence", { inherited: presence(process.env), native: presence(environment) })
      const child = Bun.spawn([powershell, "-NoProfile", "-NonInteractive", "-Command", ${JSON.stringify(
        `$ErrorActionPreference = 'Stop'
function Write-FixtureCheckpoint([string] $phase) {
  [IO.File]::AppendAllText(${quote(nativeDiagnostic)}, ([DateTime]::UtcNow.ToString('o') + ' ' + $phase + [Environment]::NewLine))
}
Write-FixtureCheckpoint 'native-script-started'
$certificateProvider = (Get-PSDrive Cert).Provider.Name
Write-FixtureCheckpoint 'certificate-provider-loaded'
$archiveCommand = (Get-Command Expand-Archive -ErrorAction Stop).Name
Write-FixtureCheckpoint 'archive-command-loaded'
$processId = (Get-Process -Id $PID).Id
Write-FixtureCheckpoint 'process-command-finished'
$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath ${quote(file)}).Hash
Write-FixtureCheckpoint 'file-hash-finished'
[pscustomobject]@{ Edition = $PSEdition; CertificateProvider = $certificateProvider; ArchiveCommand = $archiveCommand; ProcessId = $processId; Hash = $hash; Marker = $env:VECTOR_INSTALLER_ENV_MARKER } | ConvertTo-Json -Compress
Write-FixtureCheckpoint 'native-output-written'`,
      )}], { env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
      await checkpoint("native-started", { pid: child.pid })
      const timeout = setTimeout(() => {
        try {
          checkpoint("native-watchdog-fired", { pid: child.pid })
        } finally {
          child.kill()
        }
      }, 15_000)
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
        await checkpoint("native-finished", { code, stdout, stderr })
        assert.equal(code, 0, stderr)
        await Bun.write(Bun.stdout, stdout)
        await checkpoint("bun-output-written")
      } finally {
        clearTimeout(timeout)
        child.kill()
        await child.exited
      }`,
      )
      const child = Bun.spawn(
        [
          pwsh,
          "-NoProfile",
          "-NonInteractive",
          // Keep the nested script out of Windows argument quoting; fixture paths contain spaces and apostrophes.
          "-EncodedCommand",
          Buffer.from(
            `$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$details = @{ bunPath = ${quote(process.execPath)}; entryPath = ${quote(entry)}; entryExists = [IO.File]::Exists(${quote(entry)}); arguments = @('run', '--no-env-file', ${quote(entry)}); pathExt = $env:PATHEXT; comSpec = $env:ComSpec }
# Operators and .NET only, as in the rest of this stage: a cmdlet such as ConvertTo-Json sends pwsh through PSModulePath
# and the module analysis cache to find its module, which can take longer than the whole fixture's deadline.
function Write-FixtureCheckpoint([string] $phase) {
  $details.phase = $phase
  $details.at = [DateTime]::UtcNow.ToString('o')
  $details.elapsedMs = $clock.ElapsedMilliseconds
  $fields = foreach ($key in $details.Keys) { $key + '=' + ($details[$key] -join ',') }
  [IO.File]::AppendAllText(${quote(outerDiagnostic)}, (($fields -join '; ') + [Environment]::NewLine))
}
Write-FixtureCheckpoint 'pwsh-started'
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = ${quote(process.execPath)}
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($argument in $details.arguments) { $start.ArgumentList.Add($argument) }
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
try {
  if (-not $process.Start()) { throw 'Bun child did not start' }
  $details.processId = $process.Id
  Write-FixtureCheckpoint 'bun-process-started'
  $output = $process.StandardOutput.ReadToEndAsync()
  $errorOutput = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(15000)) {
    Write-FixtureCheckpoint 'bun-wait-deadline'
    throw 'Bun child did not exit before the native deadline'
  }
  Write-FixtureCheckpoint 'bun-process-exited'
  if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($output, $errorOutput), 1000)) {
    Write-FixtureCheckpoint 'bun-stream-deadline'
    throw 'Bun child streams did not close'
  }
  $details.exitCode = $process.ExitCode
  $details.stdoutBytes = [Text.Encoding]::UTF8.GetByteCount($output.Result)
  $details.stderrBytes = [Text.Encoding]::UTF8.GetByteCount($errorOutput.Result)
  Write-FixtureCheckpoint 'bun-invocation-finished'
  [Console]::Out.Write($output.Result)
  [Console]::Error.Write($errorOutput.Result)
  exit $process.ExitCode
} finally {
  try {
    if ($details.ContainsKey('processId') -and -not $process.HasExited) {
      try {
        Write-FixtureCheckpoint 'bun-tree-kill-started'
      } finally {
        $process.Kill($true)
        try {
          Write-FixtureCheckpoint 'bun-tree-kill-returned'
        } finally {
          if (-not $process.WaitForExit(1000)) { throw 'Bun child did not exit after cleanup' }
        }
      }
      Write-FixtureCheckpoint 'bun-tree-cleanup-finished'
    }
  } finally {
    $process.Dispose()
  }
}`,
            "utf16le",
          ).toString("base64"),
        ],
        {
          env: { ...process.env, VECTOR_INSTALLER_ENV_MARKER: "preserved" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const watchdog = { fired: false }
      const timeout = setTimeout(() => {
        watchdog.fired = true
        child.kill()
      }, 20_000)
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        const checkpoints = await Bun.file(diagnostic)
          .text()
          .catch(() => "not written")
        for (const line of checkpoints.split(/\r?\n/).filter((line) => line.includes('"phase":"environment-presence"')))
          console.info(`[windows-powershell] ${line}`)
        const details = JSON.stringify({
          pwsh,
          stderr,
          outerWatchdogFired: watchdog.fired,
          outerDiagnostic: await Bun.file(outerDiagnostic)
            .text()
            .catch(() => "not written"),
          diagnostic: checkpoints,
          nativeDiagnostic: await Bun.file(nativeDiagnostic)
            .text()
            .catch(() => "not written"),
        })
        expect(code, details).toBe(0)
        expect(stdout.trim(), details).not.toBe("")
        expect(JSON.parse(stdout)).toEqual({
          Edition: "Desktop",
          CertificateProvider: "Certificate",
          ArchiveCommand: "Expand-Archive",
          ProcessId: expect.any(Number),
          Hash: createHash("sha256").update("installer hash fixture\n").digest("hex").toUpperCase(),
          Marker: "preserved",
        })
      } finally {
        clearTimeout(timeout)
        child.kill()
        await child.exited
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
