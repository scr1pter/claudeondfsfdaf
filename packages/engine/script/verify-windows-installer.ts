// Runs only in a disposable GitHub-hosted Windows runner: restores hosts and removes its exact fixture CA.
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WindowsRemoval } from "../src/installation/windows-remove"
import { WindowsPowerShell } from "../../core/src/util/windows-powershell"

if (
  process.platform !== "win32" ||
  process.env.CI !== "true" ||
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
  process.env.VECTOR_INSTALLER_WINDOWS_FIXTURE !== "1"
)
  throw new Error(
    "This fixture requires the disposable GitHub-hosted Windows CI job; it changes temporary certificate trust and hosts mappings.",
  )

const root = await mkdtemp(path.join(os.tmpdir(), "vector installer '"))
await using temporaryDirectory = {
  async [Symbol.asyncDispose]() {
    await rm(root, { recursive: true, force: true })
  },
}
const installer = path.resolve(import.meta.dir, "../../web/public/install.ps1")
const installDir = path.join(root, "installed with spaces")
const files = path.join(root, "archive")
await mkdir(files)
const powershell = path.join(process.env.SYSTEMROOT!, "System32/WindowsPowerShell/v1.0/powershell.exe")
const openssl = path.join(process.env.ProgramFiles!, "Git/usr/bin/openssl.exe")
const compiler = path.join(process.env.SYSTEMROOT!, "Microsoft.NET/Framework64/v4.0.30319/csc.exe")
const hostsPath = path.join(process.env.SYSTEMROOT!, "System32/drivers/etc/hosts")
const originalHosts = await readFile(hostsPath)
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const evidence: Record<string, boolean | number | string> = {}
const state = {
  version: "1.99.42",
  corrupt: false,
  redirect: false,
  stall: false,
  archive: new Uint8Array(),
  requests: [] as string[],
}

async function checkpoint(phase: string) {
  evidence.phase = phase
  evidence.phaseStartedAt = new Date().toISOString()
  console.log(`Windows standalone installer: ${phase}`)
  console.log(`::notice title=Windows installer checkpoint::${phase}`)
  await Bun.write(path.resolve("vector-windows-installer-evidence.json"), JSON.stringify(evidence, null, 2))
}

async function run(command: string[], env?: Record<string, string>, signal?: AbortSignal) {
  const child = Bun.spawn(command, {
    env: WindowsPowerShell.environment(command[0], { ...process.env, ...env }),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    signal,
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}
function processCleanup(stop: () => void, completion: Promise<unknown>) {
  const state = { disposed: false }
  return {
    async [Symbol.asyncDispose]() {
      if (state.disposed) return
      state.disposed = true
      stop()
      const deadline = Promise.withResolvers<void>()
      const timer = setTimeout(() => deadline.reject(new Error("Fixture process cleanup exceeded two seconds")), 2_000)
      try {
        // The caller or waitStatus reports process failures; disposal only joins termination.
        await Promise.race([
          completion.then(
            () => undefined,
            () => undefined,
          ),
          deadline.promise,
        ])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
const ps = (command: string) => run([powershell, "-NoProfile", "-NonInteractive", "-Command", command])
async function pack(version: string, companion?: { name: string; bytes: Uint8Array }) {
  const source = path.join(root, "Fixture.cs")
  await writeFile(
    source,
    `using System; using System.Threading; class Fixture { static void Main(string[] args) { if(args.Length>0 && args[0]=="--version") Console.WriteLine("${version}"); else Thread.Sleep(900000); } }`,
  )
  const built = await run([compiler, "/nologo", "/target:exe", `/out:${path.join(files, "vector.exe")}`, source])
  assert.equal(built.code, 0, built.stderr + built.stdout)
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
    await writeFile(path.join(files, name), name)
  const entries = ["vector.exe", "LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"]
  if (companion) {
    await writeFile(path.join(files, companion.name), companion.bytes)
    entries.push(companion.name)
  }
  const zip = path.join(root, "archive.zip")
  const zipped = await ps(
    `Compress-Archive -LiteralPath ${entries.map((name) => quote(path.join(files, name))).join(",")} -DestinationPath ${quote(zip)} -Force`,
  )
  assert.equal(zipped.code, 0, zipped.stderr)
  state.archive = await Bun.file(zip).bytes()
  state.version = version
}
async function install(extra: string[] = [], signal?: AbortSignal) {
  return await run(
    [
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      installer,
      "-InstallDir",
      installDir,
      ...extra,
    ],
    {
      // Native installer prerequisites only; the fixture server is already running independently.
      PATH: [path.dirname(powershell), path.join(process.env.SYSTEMROOT!, "System32")].join(";"),
    },
    signal,
  )
}
async function waitStatus(file: string, expected: string, operation: ReturnType<typeof run>) {
  const outcome: { result?: Awaited<ReturnType<typeof run>>; error?: string } = {}
  void operation.then(
    (result) => {
      outcome.result = { ...result, stdout: result.stdout.slice(-4_000), stderr: result.stderr.slice(-4_000) }
    },
    (error) => {
      outcome.error = String(error).slice(-4_000)
    },
  )
  const failure = async (reason: string) => {
    const status = await Bun.file(file)
      .slice(0, 8_000)
      .text()
      .catch((error) => `Status unavailable: ${String(error).slice(-1_000)}`)
    const detail = JSON.stringify({ expected, status, operation: outcome.result ?? outcome.error ?? "still running" })
    evidence[path.basename(file)] = detail
    return new Error(`${reason}: ${detail}`)
  }
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const status = await Bun.file(file)
      .json()
      .catch(() => undefined)
    if (status?.state === "failed") throw await failure(`Operation failed while waiting for ${expected}`)
    if (status?.state === expected) return
    if (outcome.result || outcome.error) throw await failure(`Operation exited before ${expected}`)
    await Bun.sleep(100)
  }
  throw await failure(`Timed out waiting for ${expected}`)
}

// Exercise the actual atomic status writer before deferred installation can hide a replacement error.
await checkpoint("atomic status transitions")
const statusWriter = (await Bun.file(installer).text()).match(
  /^function Write-OperationStatus\([^\n]+\) \{[\s\S]*?^\}/m,
)?.[0]
assert.ok(statusWriter, "The installer status writer must be present")
// The writer JSON-escapes values itself, so its literals hold double quotes and backslashes; an encoded command keeps
// them out of command-line quoting. The fourth transition's message holds each kind of character the writer escapes
// (quote, backslash, CR, LF, TAB, a control) and non-ASCII text it writes as UTF-8; ConvertFrom-Json must return it.
const statusTransitions = await run([
  powershell,
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(
    `$ErrorActionPreference = 'Stop'; $stage = ${quote(root)}; $statusPath = ${quote(path.join(root, "status-transition.json"))}; $script:statusCreated = $false; $Version = '1.99.42'; $utf8 = New-Object System.Text.UTF8Encoding($false); ${statusWriter}; foreach ($state in @('preparing', 'prepared', 'failed')) { Write-OperationStatus $state ('fixture ' + $state); $status = [IO.File]::ReadAllText($statusPath) | ConvertFrom-Json; if ($status.state -cne $state -or $status.message -cne ('fixture ' + $state) -or $status.version -cne $Version -or $status.schemaVersion -ne 1) { throw 'The actual installer status writer did not preserve the transition.' } }; $escaped = 'quote ' + [char]34 + ' backslash ' + [char]92 + ' CR ' + [char]13 + ' LF ' + [char]10 + ' TAB ' + [char]9 + ' SOH ' + [char]1 + ' non-ASCII ' + [char]0xe9 + [char]0x65e5; Write-OperationStatus 'failed' $escaped; $status = [IO.File]::ReadAllText($statusPath) | ConvertFrom-Json; if ($status.state -cne 'failed' -or $status.message -cne $escaped -or $status.version -cne $Version -or $status.schemaVersion -ne 1) { throw 'The actual installer status writer did not return the escaped message exactly.' }`,
    "utf16le",
  ).toString("base64"),
])
assert.equal(statusTransitions.code, 0, statusTransitions.stderr + statusTransitions.stdout)
evidence.atomicStatusTransitions = true
evidence.statusMessageEscaping = true

await checkpoint("temporary certificate trust")
const certificate = path.join(root, "certificate.pem")
const key = path.join(root, "key.pem")
const administrator = await ps(
  "$ErrorActionPreference = 'Stop'; $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()); if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The disposable Windows installer fixture requires administrator access to LocalMachine Root.' }",
)
assert.equal(administrator.code, 0, administrator.stderr)
const generated = await run([
  openssl,
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  key,
  "-out",
  certificate,
  "-days",
  "1",
  "-subj",
  "/CN=Vector isolated installer fixture",
  "-addext",
  "subjectAltName=DNS:vectordev.ai,DNS:fixture.public.blob.vercel-storage.com",
])
assert.equal(generated.code, 0, generated.stderr)
const der = path.join(root, "certificate.cer")
assert.equal((await run([openssl, "x509", "-in", certificate, "-outform", "der", "-out", der])).code, 0)
const thumbprint = createHash("sha1")
  .update(await Bun.file(der).bytes())
  .digest("hex")
  .toUpperCase()
const certificatePath = `Cert:\\LocalMachine\\Root\\${thumbprint}`
const absent = await ps(
  `$ErrorActionPreference = 'Stop'; if (Test-Path -LiteralPath ${quote(certificatePath)}) { throw 'The fixture certificate already exists; refusing to take ownership.' }`,
)
assert.equal(absent.code, 0, absent.stderr)
// Register before import so partial failures still remove only this newly generated certificate.
await using trustedCertificate = {
  async [Symbol.asyncDispose]() {
    const removed = await ps(
      `$ErrorActionPreference = 'Stop'; if (Test-Path -LiteralPath ${quote(certificatePath)}) { Remove-Item -LiteralPath ${quote(certificatePath)} -ErrorAction Stop }; if (Test-Path -LiteralPath ${quote(certificatePath)}) { throw 'The fixture certificate was not removed.' }`,
    )
    assert.equal(removed.code, 0, removed.stderr)
  },
}
// CurrentUser Root can require UI even on CI; the disposable hosted runner is an administrator.
const trusted = await ps(
  `(Import-Certificate -FilePath ${quote(der)} -CertStoreLocation 'Cert:\\LocalMachine\\Root' -ErrorAction Stop).Thumbprint`,
)
assert.equal(trusted.code, 0, trusted.stderr)
assert.equal(trusted.stdout.trim().toUpperCase(), thumbprint)
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 443,
  idleTimeout: 0,
  tls: { cert: Bun.file(certificate), key: Bun.file(key) },
  fetch(request) {
    const url = new URL(request.url)
    state.requests.push(url.pathname)
    if (state.redirect) return Response.redirect("https://unapproved.invalid/archive", 302)
    if (url.pathname === "/api/cli-release") {
      const target = url.searchParams.get("target")!
      const filename = `vector-${target}.zip`
      const pathname = `releases/vector-cli/v${state.version}/${filename}`
      return Response.json({
        version: state.version,
        target,
        filename,
        pathname,
        url: `https://fixture.public.blob.vercel-storage.com/${pathname}`,
        size: state.archive.length,
        sha256: state.corrupt ? "0".repeat(64) : createHash("sha256").update(state.archive).digest("hex"),
      })
    }
    if (state.stall)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(state.archive.slice(0, 1))
          },
        }),
        { headers: { "content-length": String(state.archive.length) } },
      )
    return new Response(state.archive)
  },
})
try {
  await checkpoint("initial fixture archive")
  await writeFile(
    hostsPath,
    Buffer.concat([
      originalHosts,
      Buffer.from("\r\n127.0.0.1 vectordev.ai fixture.public.blob.vercel-storage.com # Vector isolated CI fixture\r\n"),
    ]),
  )
  await pack("1.99.42")
  await checkpoint("initial beta installation")
  const initial = await install(["-Version", "beta"])
  assert.equal(initial.code, 0, initial.stderr)
  const executable = path.join(installDir, "vector.exe")
  const first = await Bun.file(executable).bytes()
  const receipt = path.join(installDir, ".vector-vector.exe/receipt.tsv")
  const firstReceipt = await Bun.file(receipt).text()
  assert.equal(firstReceipt.split("\t")[1], "1")
  assert.equal(firstReceipt.split("\t")[4], "beta")
  evidence.nodeFreeInstall = true
  evidence.betaChannel = true
  await checkpoint("checksum rejection")
  state.corrupt = true
  assert.notEqual((await install()).code, 0)
  assert.deepEqual(await Bun.file(executable).bytes(), first)
  state.corrupt = false
  await checkpoint("redirect rejection")
  state.redirect = true
  assert.notEqual((await install()).code, 0)
  assert.deepEqual(await Bun.file(executable).bytes(), first)
  state.redirect = false
  evidence.checksumAndRedirectPreserveOld = true
  const arch = process.arch
  assert(arch === "x64" || arch === "arm64")
  // The v1 synthetic executable provides known, checked bytes. The companion itself is never run here.
  const digest = createHash("sha256").update(first).digest("hex")
  const companionName = `vector-holder-${arch}-${digest}.exe`
  const installedCompanion = path.join(installDir, companionName)
  await checkpoint("companion checksum rejection with a valid ZIP checksum")
  const corruptedCompanion = Buffer.from(first)
  corruptedCompanion[0] = corruptedCompanion[0]! ^ 0xff
  await pack("1.99.43", { name: companionName, bytes: corruptedCompanion })
  const corruptHolder = await install(["-Version", state.version])
  assert.notEqual(corruptHolder.code, 0)
  assert.match(corruptHolder.stderr, /Windows holder checksum or size did not match/)
  assert.equal(await Bun.file(installedCompanion).exists(), false)
  assert.deepEqual(await Bun.file(executable).bytes(), first)
  assert.equal(await Bun.file(receipt).text(), firstReceipt)
  evidence.companionChecksumRejection = true
  await checkpoint("update fixture archive")
  await pack("1.99.43", { name: companionName, bytes: first })
  await checkpoint("companion destination collision refusal")
  const unrelated = "unrelated file at the fixture companion path"
  await writeFile(installedCompanion, unrelated, { flag: "wx" })
  const collision = await install(["-Version", state.version])
  assert.notEqual(collision.code, 0)
  assert.match(collision.stderr, /Windows holder checksum or size did not match/)
  assert.equal(await Bun.file(installedCompanion).text(), unrelated)
  assert.deepEqual(await Bun.file(executable).bytes(), first)
  assert.equal(await Bun.file(receipt).text(), firstReceipt)
  await rm(installedCompanion)
  evidence.companionCollisionPreservesOld = true
  await checkpoint("unacknowledged update preparation")
  const abandoned = Bun.spawn([executable, "--hold"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  await using abandonedCleanup = processCleanup(() => abandoned.kill(), abandoned.exited)
  const abandonedIdentity = await ps(WindowsRemoval.identity(abandoned.pid))
  assert.equal(abandonedIdentity.code, 0, abandonedIdentity.stderr)
  const abandonedOperation = randomBytes(16).toString("hex")
  const abandonedStatus = path.join(installDir, `.vector-update-${abandonedOperation}.json`)
  const unacknowledgedController = new AbortController()
  const unacknowledged = install(
    [
      "-Version",
      state.version,
      "-WaitForProcessId",
      String(abandoned.pid),
      "-WaitForStartTicks",
      abandonedIdentity.stdout.trim(),
      "-OperationId",
      abandonedOperation,
    ],
    unacknowledgedController.signal,
  )
  await using unacknowledgedCleanup = processCleanup(() => unacknowledgedController.abort(), unacknowledged)
  try {
    await waitStatus(abandonedStatus, "prepared", unacknowledged)
  } finally {
    await abandonedCleanup[Symbol.asyncDispose]()
  }
  assert.notEqual((await unacknowledged).code, 0)
  assert.deepEqual(await Bun.file(executable).bytes(), first)
  assert.equal(await Bun.file(receipt).text(), firstReceipt)
  assert.equal(await Bun.file(installedCompanion).exists(), false)
  evidence.unacknowledgedExitPreservesOld = true
  await checkpoint("running executable update preparation")
  const holder = Bun.spawn([executable, "--hold"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  await using holderCleanup = processCleanup(() => holder.kill(), holder.exited)
  const identity = await ps(WindowsRemoval.identity(holder.pid))
  assert.equal(identity.code, 0, identity.stderr)
  const operation = randomBytes(16).toString("hex")
  const status = path.join(installDir, `.vector-update-${operation}.json`)
  const pendingController = new AbortController()
  const pending = install(
    [
      "-Version",
      state.version,
      "-WaitForProcessId",
      String(holder.pid),
      "-WaitForStartTicks",
      identity.stdout.trim(),
      "-OperationId",
      operation,
    ],
    pendingController.signal,
  )
  await using pendingCleanup = processCleanup(() => pendingController.abort(), pending)
  try {
    await waitStatus(status, "prepared", pending)
    await writeFile(`${status}.ready`, "ready\n", { flag: "wx" })
    assert.deepEqual(
      await Bun.file(executable).bytes(),
      first,
      "A running executable must remain unchanged until it exits",
    )
    assert.equal(await Bun.file(installedCompanion).exists(), false)
  } finally {
    await holderCleanup[Symbol.asyncDispose]()
  }
  await checkpoint("running executable replacement")
  const replaced = await pending
  assert.equal(replaced.code, 0, replaced.stderr)
  await waitStatus(status, "complete", pending)
  evidence.runningExecutableReplacement = true
  const current = await Bun.file(executable).bytes()
  assert.deepEqual(await Bun.file(installedCompanion).bytes(), first)
  const expectedReceipt = [
    "vector-standalone",
    "2",
    state.version,
    arch === "arm64" ? "windows-arm64" : "windows-x64-baseline",
    "beta",
    "vector.exe",
    createHash("sha256").update(current).digest("hex"),
    createHash("sha256").update(state.archive).digest("hex"),
    companionName,
  ].join("\t")
  assert.equal(await Bun.file(receipt).text(), expectedReceipt + "\n")
  evidence.companionUpgradeAndReceipt = true
  await checkpoint("stalled body five-minute deadline")
  state.stall = true
  const started = Date.now()
  const stalledController = new AbortController()
  const watchdog = setTimeout(() => {
    evidence.stalledBodyWatchdog = true
    console.error("Stalled-body installer exceeded the 330-second harness watchdog")
    stalledController.abort()
  }, 330_000)
  const stalledOperation = install([], stalledController.signal)
  await using stalledCleanup = processCleanup(() => stalledController.abort(), stalledOperation)
  const stalled = await stalledOperation.finally(() => clearTimeout(watchdog))
  assert.equal(stalledController.signal.aborted, false, "Stalled-body installer exceeded the harness watchdog")
  assert.notEqual(stalled.code, 0)
  assert(Date.now() - started < 325_000, "Stalled body must terminate at the five-minute download deadline")
  assert(Date.now() - started >= 290_000, "The fixture must remain connected until the actual body deadline")
  assert.deepEqual(await Bun.file(executable).bytes(), current)
  evidence.stalledBodyMilliseconds = Date.now() - started
  evidence.stalledBodyPreservesOld = true
  await checkpoint("running executable removal preparation")
  const removalHolder = Bun.spawn([executable, "--hold"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
  await using removalHolderCleanup = processCleanup(() => removalHolder.kill(), removalHolder.exited)
  const removalIdentity = await ps(WindowsRemoval.identity(removalHolder.pid))
  assert.equal(removalIdentity.code, 0, removalIdentity.stderr)
  const removalOperation = randomBytes(16).toString("hex")
  const removalStatus = path.join(installDir, `.vector-update-${removalOperation}.json`)
  const removalDirectory = path.join(installDir, `.vector-uninstall-${removalOperation}`)
  await mkdir(removalDirectory)
  const metadata = path.dirname(receipt)
  await writeFile(path.join(metadata, "keep-user-file"), "preserve")
  const removalScript = path.join(removalDirectory, "remove.ps1")
  await writeFile(
    removalScript,
    WindowsRemoval.script({
      pid: removalHolder.pid,
      startTicks: removalIdentity.stdout.trim(),
      executable,
      metadata,
      lock: path.join(installDir, ".vector-vector.exe.lock"),
      statusFile: removalStatus,
      temporaryDirectory: removalDirectory,
      binarySha256: createHash("sha256").update(current).digest("hex"),
      files: [
        executable,
        receipt,
        ...["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"].map((name) => path.join(metadata, name)),
      ],
    }),
  )
  const removingController = new AbortController()
  const removing = run(
    [powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", removalScript],
    undefined,
    removingController.signal,
  )
  await using removingCleanup = processCleanup(() => removingController.abort(), removing)
  try {
    await waitStatus(removalStatus, "prepared", removing)
    await writeFile(`${removalStatus}.ready`, "ready\n", { flag: "wx" })
    assert.equal(await Bun.file(executable).exists(), true)
  } finally {
    await removalHolderCleanup[Symbol.asyncDispose]()
  }
  await checkpoint("running executable removal")
  const removed = await removing
  assert.equal(removed.code, 0, removed.stderr)
  await waitStatus(removalStatus, "complete", removing)
  assert.equal(await Bun.file(executable).exists(), false)
  assert.equal(await Bun.file(receipt).exists(), false)
  assert.equal(await Bun.file(path.join(metadata, "keep-user-file")).text(), "preserve")
  assert.deepEqual(await Bun.file(installedCompanion).bytes(), first)
  evidence.companionPreservedOnUninstall = true
  evidence.runningExecutableUninstall = true
  await checkpoint("acceptance checks complete")
} finally {
  server.stop(true)
  await writeFile(hostsPath, originalHosts)
  await Bun.write(path.resolve("vector-windows-installer-evidence.json"), JSON.stringify(evidence, null, 2))
}
console.log("Windows standalone installer acceptance passed", evidence)
