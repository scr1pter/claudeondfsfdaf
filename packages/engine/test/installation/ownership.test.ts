import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { InstallationOwnership } from "../../src/installation/ownership"
import { Standalone } from "../../src/installation/standalone"
import { WindowsRemoval } from "../../src/installation/windows-remove"

async function directory(prefix = "vector-ownership-") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)))
  return {
    root,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}
const noCommand: Standalone.Run = async () => ({ code: 1, stdout: "", stderr: "" })

test("standalone ownership requires the exact current binary hash and uninstalls only owned files", async () => {
  await using fixture = await directory()
  const executable = path.join(fixture.root, "vector")
  const metadata = path.join(fixture.root, ".vector-vector")
  await mkdir(metadata)
  await Bun.write(executable, "synthetic executable")
  const hash = createHash("sha256").update("synthetic executable").digest("hex")
  await Bun.write(
    path.join(metadata, "receipt.tsv"),
    `vector-standalone\t1\t1.2.3\tlinux-x64-baseline\tlatest\tvector\t${hash}\t${"a".repeat(64)}\n`,
  )
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
    await Bun.write(path.join(metadata, name), name)
  const owned = await Standalone.receipt(executable)
  expect(owned?.version).toBe("1.2.3")
  expect((await InstallationOwnership.detect(noCommand, executable)).method).toBe("standalone")
  await Bun.write(executable, "unrelated replacement")
  expect(await Standalone.receipt(executable)).toBeUndefined()
  await Bun.write(executable, "synthetic executable")
  await Bun.write(path.join(metadata, "keep-user-file"), "user data")
  if (process.platform === "win32") {
    await expect(Standalone.uninstall(owned!, noCommand)).rejects.toThrow(
      "Could not identify Vector for deferred removal",
    )
    expect(await Bun.file(executable).text()).toBe("synthetic executable")
    expect(await Bun.file(path.join(metadata, "receipt.tsv")).exists()).toBe(true)
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md", "keep-user-file"])
      expect(await Bun.file(path.join(metadata, name)).text()).toBe(name === "keep-user-file" ? "user data" : name)
    return
  }
  expect(await Standalone.uninstall(owned!, noCommand)).toEqual({ status: "complete" })
  expect(await Bun.file(executable).exists()).toBe(false)
  expect(await Bun.file(path.join(metadata, "receipt.tsv")).exists()).toBe(false)
  expect(await Bun.file(path.join(metadata, "keep-user-file")).text()).toBe("user data")
})

test("Windows standalone receipts support legacy and holder archives and reject malformed holder names", async () => {
  await using fixture = await directory()
  const executable = path.join(fixture.root, "vector.exe")
  const metadata = path.join(fixture.root, ".vector-vector.exe")
  await mkdir(metadata)
  await Bun.write(executable, "synthetic executable")
  const binarySha = createHash("sha256").update("synthetic executable").digest("hex")
  const archiveSha = "a".repeat(64)
  const holder = `vector-holder-x64-${"b".repeat(64)}.exe`
  for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
    await Bun.write(path.join(metadata, name), name)

  for (const [schema, target, extra, valid] of [
    ["1", "windows-x64-baseline", [], true],
    ["2", "windows-x64-baseline", [holder], true],
    ["1", "windows-x64-baseline", [holder], false],
    ["2", "windows-x64-baseline", [], false],
    ["2", "windows-x64-baseline", ["../" + holder], false],
    ["2", "windows-x64-baseline", [holder, holder], false],
    ["2", "windows-x64-baseline", [holder.toUpperCase()], false],
    ["2", "windows-arm64", [holder], false],
    ["2", "linux-x64-baseline", [holder], false],
  ] as const) {
    const fields = ["vector-standalone", schema, "1.2.3", target, "latest", "vector.exe", binarySha, archiveSha, ...extra]
    await Bun.write(path.join(metadata, "receipt.tsv"), fields.join("\t") + "\n")
    expect((await Standalone.receipt(executable))?.version).toBe(valid ? "1.2.3" : undefined)
  }
})

test("global package listings cannot claim an unrelated running executable", async () => {
  await using fixture = await directory()
  const executable = path.join(fixture.root, "vector")
  await Bun.write(executable, "unrelated")
  const calls: string[][] = []
  const detected = await InstallationOwnership.detect(async (command) => {
    calls.push(command)
    return { code: 0, stdout: "@vectordevai/cli@1.2.3", stderr: "" }
  }, executable)
  expect(detected).toEqual({ method: "unknown" })
  expect(calls.every((command) => !command.includes("list"))).toBe(true)
})

test("npm ownership resolves the current native dependency from the actual global CLI package", async () => {
  await using fixture = await directory()
  const root = path.join(fixture.root, "node_modules")
  await Bun.write(path.join(root, "@vectordevai/cli/package.json"), JSON.stringify({ name: "@vectordevai/cli" }))
  await Bun.write(
    path.join(root, "@vectordevai/cli-linux-x64/package.json"),
    JSON.stringify({ name: "@vectordevai/cli-linux-x64" }),
  )
  const executable = path.join(root, "@vectordevai/cli-linux-x64/bin/vector")
  await Bun.write(executable, "native")
  expect(
    await InstallationOwnership.detect(
      async (command) => ({ code: command[0] === "npm" ? 0 : 1, stdout: root, stderr: "" }),
      executable,
    ),
  ).toEqual({ method: "npm", package: "@vectordevai/cli" })
  const other = path.join(fixture.root, "other/vector")
  await Bun.write(other, "other")
  expect((await InstallationOwnership.detect(async () => ({ code: 0, stdout: root, stderr: "" }), other)).method).toBe(
    "unknown",
  )
})

test("Bun ownership follows its actual global launcher and native dependency", async () => {
  await using fixture = await directory()
  const root = path.join(fixture.root, "node_modules")
  await Bun.write(path.join(root, "@vectordevai/cli/package.json"), JSON.stringify({ name: "@vectordevai/cli" }))
  await Bun.write(path.join(root, "@vectordevai/cli/bin/vector.cjs"), "launcher")
  await Bun.write(
    path.join(root, "@vectordevai/cli-linux-x64/package.json"),
    JSON.stringify({ name: "@vectordevai/cli-linux-x64" }),
  )
  const executable = path.join(root, "@vectordevai/cli-linux-x64/bin/vector")
  await Bun.write(executable, "native")
  const bin = path.join(fixture.root, "bin")
  await mkdir(bin)
  await symlink(path.join(root, "@vectordevai/cli/bin/vector.cjs"), path.join(bin, "vector"))
  expect(
    await InstallationOwnership.detect(
      async (command) => ({ code: command[0] === "bun" ? 0 : 1, stdout: bin, stderr: "" }),
      executable,
    ),
  ).toEqual({ method: "bun", package: "@vectordevai/cli" })
})

test("Homebrew and Scoop use recorded manager identities rather than invented repositories", async () => {
  await using fixture = await directory()
  const prefix = path.join(fixture.root, "Cellar/vector/1.2.3")
  const executable = path.join(prefix, "bin/vector")
  await Bun.write(executable, "native")
  const brew = await InstallationOwnership.detect(
    async (command) => ({
      code: 0,
      stdout:
        command[1] === "--prefix"
          ? prefix
          : JSON.stringify({
              formulae: [
                {
                  name: "vector",
                  full_name: "fixture-owner/fixture-tap/vector",
                  homepage: "https://vectordev.ai",
                  versions: { stable: "1.2.4" },
                },
              ],
            }),
      stderr: "",
    }),
    executable,
  )
  expect(brew).toEqual({ method: "homebrew", package: "fixture-owner/fixture-tap/vector", latest: "1.2.4" })
  const scoop = path.join(fixture.root, "apps/vector/1.2.3")
  await Bun.write(path.join(scoop, "vector.exe"), "native")
  await Bun.write(path.join(scoop, "install.json"), JSON.stringify({ bucket: "fixture-bucket" }))
  await Bun.write(
    path.join(scoop, "manifest.json"),
    JSON.stringify({ version: "1.2.3", homepage: "https://vectordev.ai" }),
  )
  expect(
    await InstallationOwnership.detect(
      async () => ({
        code: 0,
        stdout: JSON.stringify({ version: "1.2.4", homepage: "https://vectordev.ai" }),
        stderr: "",
      }),
      path.join(scoop, "vector.exe"),
    ),
  ).toEqual({ method: "scoop", package: "fixture-bucket/vector", latest: "1.2.4" })
})

test("Windows deferred-operation PowerShell runs no cmdlet that needs command discovery", () => {
  // Windows PowerShell 5.1 resolves a cmdlet or alias through command discovery and module auto-load, which stalled a
  // deferred-removal worker for 30 s on CI. The worker and identity probe must stay operators and .NET only.
  const generated = [
    WindowsRemoval.script({
      pid: 4242,
      startTicks: "639304879276547567",
      executable: "C:\\Vector\\vector.exe",
      metadata: "C:\\Vector\\.vector-vector.exe",
      lock: "C:\\Vector\\.vector-vector.exe.lock",
      statusFile: "C:\\Vector\\.vector-update-0.json",
      temporaryDirectory: "C:\\Vector\\.vector-uninstall-0",
      binarySha256: "a".repeat(64),
      files: ["C:\\Vector\\vector.exe", "C:\\Vector\\.vector-vector.exe\\receipt.tsv"],
    }),
    WindowsRemoval.identity(4242),
  ]
    .join("\n")
    // String literals and comments may hold any words; only code can invoke a command.
    .replace(/'(?:[^']|'')*'|"(?:[^"`]|`.)*"|#[^\n]*/g, (found) => (found.startsWith("#") ? "" : "''"))
  // Any Verb-Noun word, whatever its case or verb, names a cmdlet or function that discovery would have to find.
  expect(generated.match(/\b[a-z]\w*-[a-z]\w*/gi) ?? []).toEqual([])
  // A bare word where PowerShell expects a command must be a language keyword or one of the script's own functions;
  // anything else, such as an alias like gps or sleep, goes through command discovery.
  const functions = [...generated.matchAll(/\bfunction\s+(\w+)/gi)].map((found) => found[1].toLowerCase())
  const allowed = [
    ...["try", "catch", "finally", "if", "elseif", "else", "while", "do", "until", "for", "foreach", "function"],
    ...["param", "return", "throw", "exit", "break", "continue", "switch", "trap"],
    ...functions,
  ]
  expect(
    [...generated.matchAll(/(?<=(?:^|[;{}(|=&]|\breturn|\bthrow)[ \t]*)(?<![\w-])([a-z_][\w-]*)/gim)]
      .map((found) => found[1])
      .filter((word) => !allowed.includes(word.toLowerCase())),
  ).toEqual([])
  expect(functions).toEqual(["parentticks", "executablehash", "preparing"])
  expect(generated).toContain("GetProcessById(4242)")
})

for (const replacement of [false, true]) {
  test.skipIf(process.platform !== "win32")(
    `Windows deferred standalone removal ${replacement ? "preserves a replaced executable" : "removes only owned files after its parent exits"}`,
    async () => {
      await using fixture = await directory("vector ownership '‘’‚‛%VECTOR_FIXTURE_PATH%&^-")
      const executable = path.join(fixture.root, "vector.exe")
      const metadata = path.join(fixture.root, ".vector-vector.exe")
      await mkdir(metadata)
      await Bun.write(executable, "synthetic executable")
      await Bun.write(
        path.join(metadata, "receipt.tsv"),
        `vector-standalone\t1\t1.2.3\twindows-x64\tlatest\tvector.exe\t${createHash("sha256").update("synthetic executable").digest("hex")}\t${"a".repeat(64)}\n`,
      )
      for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
        await Bun.write(path.join(metadata, name), name)
      await Bun.write(path.join(metadata, "keep-user-file"), "user data")
      // Run the real deferred-uninstall path from a disposable parent. The worker must wait for
      // that exact process to exit; using the test runner's PID would leave it waiting for the suite.
      const diagnostic = path.join(fixture.root, "uninstall-diagnostic.json")
      const script = `
        const started = Date.now();
        const checkpoint = (phase, details = {}) => Bun.write(${JSON.stringify(diagnostic)}, JSON.stringify({ phase, at: new Date().toISOString(), elapsedMs: Date.now() - started, ...details }));
        await checkpoint("bun-started");
        const { Standalone } = await import( ${JSON.stringify(new URL("../../src/installation/standalone.ts", import.meta.url).href)});
        await checkpoint("standalone-imported");
        const { WindowsPowerShell } = await import(${JSON.stringify(new URL("../../../core/src/util/windows-powershell.ts", import.meta.url).href)});
        const receipt = await Standalone.receipt(${JSON.stringify(executable)});
        if (!receipt) throw new Error("Fixture receipt was rejected");
        await checkpoint("receipt-read");
        const result = await Standalone.uninstall(receipt, async (command) => {
          await checkpoint("identity-command-starting");
          const child = Bun.spawn(command, { env: WindowsPowerShell.environment(command[0]), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
          const [code, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
          ]);
          await checkpoint("identity-command-finished", { code, stdout, stderr });
          return { code, stdout, stderr };
        });
        await checkpoint("uninstall-returned", { status: result.status });
        await Bun.write(Bun.stdout, JSON.stringify(result) + "\\n");
        await Bun.stdin.text();
      `
      const child = Bun.spawn([process.execPath, "--eval", script], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env, VECTOR_FIXTURE_PATH: "wrong-expanded-path" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      const reader = child.stdout.getReader()
      const stderr = new Response(child.stderr).text()
      const timeout = setTimeout(() => child.kill(), 30_000)
      const cleanupDeadline = Date.now() + 40_000
      const output: string[] = []
      try {
        while (!output.join("").includes("\n")) {
          const chunk = await reader.read()
          if (chunk.done) {
            const statuses = await Promise.all(
              (await readdir(fixture.root))
                .filter((name) => name.startsWith(".vector-update-") && name.endsWith(".json"))
                .map(async (name) => ({ name, status: await Bun.file(path.join(fixture.root, name)).text() })),
            )
            throw new Error(
              `Uninstall parent exited before scheduling: ${JSON.stringify({
                exitCode: await child.exited,
                stderr: await stderr,
                statuses,
                // A lock entry tells a stall in the worker's hash step apart from one in its identity step.
                entries: await readdir(fixture.root),
                diagnostic: await Bun.file(diagnostic)
                  .text()
                  .catch(() => "not written"),
              })}`,
            )
          }
          output.push(new TextDecoder().decode(chunk.value))
        }
        const result = JSON.parse(output.join("")) as Standalone.Result
        expect(result.status).toBe("scheduled")
        if (result.status !== "scheduled") throw new Error("Windows removal was not deferred")
        expect(path.dirname(result.statusFile)).toBe(fixture.root)
        expect((await Bun.file(result.statusFile).json()).state).toBe("prepared")
        expect(await Bun.file(executable).text()).toBe("synthetic executable")
        expect(await Bun.file(path.join(metadata, "receipt.tsv")).exists()).toBe(true)
        if (replacement) await Bun.write(executable, "unrelated replacement")
        child.stdin.end()
        expect(await child.exited, await stderr).toBe(0)
        // The worker writes its final status before releasing the lock. Wait for its cleanup
        // acknowledgement so status reads cannot race a write or fixture removal a live worker.
        expect(await waitForRemovalCleanup(fixture.root, cleanupDeadline)).toEqual([])
        const status = await Bun.file(result.statusFile).json()
        expect(status.state).toBe(replacement ? "failed" : "complete")
        if (replacement) {
          expect(status.message).toContain("Installation changed; removal canceled")
          expect(await Bun.file(executable).text()).toBe("unrelated replacement")
          expect(await Bun.file(path.join(metadata, "receipt.tsv")).exists()).toBe(true)
          for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
            expect(await Bun.file(path.join(metadata, name)).text()).toBe(name)
        }
        if (!replacement) {
          expect(await Bun.file(executable).exists()).toBe(false)
          expect(await Bun.file(path.join(metadata, "receipt.tsv")).exists()).toBe(false)
          for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md", "DEPENDENCY_NOTICES.md"])
            expect(await Bun.file(path.join(metadata, name)).exists()).toBe(false)
        }
        expect(await Bun.file(path.join(metadata, "keep-user-file")).text()).toBe("user data")
      } finally {
        clearTimeout(timeout)
        child.kill()
        await child.exited
        await waitForRemovalCleanup(fixture.root, cleanupDeadline)
        reader.releaseLock()
      }
    },
    45_000,
  )
}

async function waitForRemovalCleanup(root: string, deadline: number) {
  while (true) {
    const pending = (await readdir(root)).filter(
      (name) =>
        name === ".vector-vector.exe.lock" || name.startsWith(".vector-uninstall-") || name.endsWith(".json.ready"),
    )
    if (pending.length === 0 || Date.now() >= deadline) return pending
    await Bun.sleep(50)
  }
}
