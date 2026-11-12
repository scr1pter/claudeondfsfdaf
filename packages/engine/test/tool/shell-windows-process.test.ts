import { describe, expect, test } from "bun:test"
import { ChildProcess } from "effect/unstable/process"
import { execFile, spawn } from "node:child_process"
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WindowsHolder } from "../../src/tool/shell/windows-holder"
import { WindowsProcess } from "../../src/tool/shell/windows-process"

const command = (text: string, shell?: string | boolean) =>
  ChildProcess.make(text, [], {
    cwd: "C:\\a project",
    env: { PATH: "C:\\Windows\\System32", USER_VALUE: "kept" },
    stdin: "ignore",
    shell,
  })
const message = (value: object) => Buffer.from(`VECTOR_SHELL/1 ${JSON.stringify(value)}\r\n`)

describe("Windows background command preparation", () => {
  test("quotes empty, spaced, embedded-quote and trailing-backslash argv like the Windows CRT", () => {
    expect(WindowsProcess.quoteArgument("")).toBe('""')
    expect(WindowsProcess.quoteArgument("simple")).toBe("simple")
    expect(WindowsProcess.quoteArgument("one two")).toBe('"one two"')
    expect(WindowsProcess.quoteArgument('one"two')).toBe('"one\\"two"')
    expect(WindowsProcess.quoteArgument("C:\\one two\\")).toBe('"C:\\one two\\\\"')
    expect(WindowsProcess.quoteArgument('a\\"b')).toBe('"a\\\\\\"b"')
    expect(WindowsProcess.quoteArgument("line\nnext")).toBe('"line\nnext"')
  })

  test("cmd receives Node's verbatim /d /s /c command without a second escaping pass", () => {
    const text = 'echo "space & quote" & echo %USER_VALUE% ^| tail'
    const normalized = WindowsProcess.normalize(command(text, "C:\\Windows\\System32\\cmd.exe"))
    expect(normalized.args).toEqual(["/d", "/s", "/c", `"${text}"`])
    expect(normalized.verbatim).toBe(true)
    expect(WindowsProcess.commandLine(normalized)).toBe(`C:\\Windows\\System32\\cmd.exe /d /s /c "${text}"`)
    expect(WindowsProcess.normalize(command(text, true), { ComSpec: "D:\\OS\\cmd.exe" }).file).toBe("D:\\OS\\cmd.exe")
  })

  test("Git Bash gets -c and an intact single command argument", () => {
    const normalized = WindowsProcess.normalize(command("printf '%s' 'a b'", "C:\\Program Files\\Git\\bin\\bash.exe"))
    expect(normalized.args).toEqual(["-c", "printf '%s' 'a b'"])
    expect(normalized.verbatim).toBe(false)
    expect(WindowsProcess.commandLine(normalized)).toBe(
      "\"C:\\Program Files\\Git\\bin\\bash.exe\" -c \"printf '%s' 'a b'\"",
    )
  })

  test("explicit PowerShell argv never becomes a shell option or interpolated holder code", () => {
    const text = '[Console]::Write("quoted text"); exit 7'
    const normalized = WindowsProcess.normalize(
      ChildProcess.make("C:\\PowerShell\\pwsh.exe", ["-NoProfile", "-Command", text], {
        cwd: "C:\\work",
        env: {},
        stdin: "ignore",
      }),
    )
    expect(normalized.args).toEqual(["-NoProfile", "-Command", text])
    expect(normalized.verbatim).toBe(false)
    expect(WindowsProcess.commandLine(normalized)).toContain('"[Console]::Write(\\"quoted text\\"); exit 7"')
    expect(WindowsHolder.script).not.toContain(text)
  })

  test("the payload gets filtered env, canonical Windows key selection and no helper controls", () => {
    const normalized = WindowsProcess.normalize(
      ChildProcess.make("pwsh.exe", [], {
        cwd: "C:\\work",
        env: {
          VECTOR_CLOUD_TOKEN: "private",
          vector_auth_content: "private",
          NODE_OPTIONS: "user-preload",
          Path: "second",
          PATH: "first",
          USER_VALUE: "visible",
        },
        extendEnv: true,
        stdin: "ignore",
      }),
      { PARENT: "retained", VECTOR_CREDENTIAL_KEY: "private" },
    )
    expect(normalized.env.PARENT).toBe("retained")
    expect(normalized.env.PATH).toBe("first")
    expect(normalized.env.Path).toBeUndefined()
    expect(normalized.env.USER_VALUE).toBe("visible")
    expect(normalized.env.NODE_OPTIONS).toBe("user-preload")
    expect(Object.keys(normalized.env).some((key) => /TOKEN|AUTH_CONTENT|CREDENTIAL_KEY/.test(key.toUpperCase()))).toBe(
      false,
    )
    expect(Object.values(normalized.env)).not.toContain("private")
  })

  test("unrepresentable streams, invalid data and oversized commands refuse before launching", () => {
    expect(() => WindowsProcess.normalize(ChildProcess.make("cmd.exe", [], { stdin: "inherit" }))).toThrow("input")
    expect(() =>
      WindowsProcess.normalize(ChildProcess.make("cmd.exe", [], { additionalFds: { fd3: { type: "input" } } })),
    ).toThrow("handles")
    expect(() => WindowsProcess.normalize(command("bad\0command", "cmd.exe"))).toThrow("Invalid")
    expect(() => WindowsProcess.commandLine(WindowsProcess.normalize(command("x".repeat(32767), "cmd.exe")))).toThrow(
      "command-line limit",
    )
    expect(() =>
      WindowsProcess.normalize(ChildProcess.make("cmd.exe", [], { env: { LARGE: "x".repeat(65536) } })),
    ).toThrow("too large")
  })

  test("the static holder fits Windows' encoded command-line bound", () => {
    const args = WindowsHolder.argumentsForHolder()
    expect(args.at(-2)).toBe("-EncodedCommand")
    expect(args.at(-1)!.length).toBeLessThanOrEqual(30_000)
    expect(Buffer.from(args.at(-1)!, "base64").toString("utf16le")).toBe(WindowsHolder.script)
  })

  test("status parsing survives byte boundaries without reading payload stdout", () => {
    const reader = new WindowsProcess.StatusReader()
    const statuses = [
      { type: "ready", pid: 17 },
      { type: "running", pid: 17 },
      { type: "exit", exitCode: 7, terminationProven: true },
    ] as const
    const bytes = Buffer.concat(statuses.map(message))
    const result = Array.from(bytes).flatMap((byte) => reader.push(Uint8Array.of(byte)))
    expect(result).toEqual([...statuses])
    expect(() => reader.finish()).not.toThrow()
  })

  test("status rejects forged shapes, missing proof, truncation and unbounded diagnostics", () => {
    for (const value of [
      { type: "ready", pid: 0 },
      { type: "ready", pid: 1.5 },
      { type: "ready", pid: 2 ** 32 },
      { type: "exit", exitCode: 0 },
      { type: "exit", exitCode: 0, terminationProven: false },
      { type: "error", message: "x".repeat(161), terminationProven: true },
    ])
      expect(() => new WindowsProcess.StatusReader().push(message(value))).toThrow()
    expect(() => new WindowsProcess.StatusReader().push(Buffer.from("payload says ready\n"))).toThrow()
    expect(() => new WindowsProcess.StatusReader().push(Buffer.alloc(16385))).toThrow("bound")
    const truncated = new WindowsProcess.StatusReader()
    truncated.push(message({ type: "ready", pid: 12 }).subarray(0, -1))
    expect(() => truncated.finish()).toThrow("Truncated")
  })

  test.skipIf(process.platform === "win32")(
    "a non-Windows host refuses rather than falling back to an uncontained process",
    async () => {
      const result = await WindowsProcess.start(command("anything"), {
        onReady: async () => {},
        onOutput: async () => {},
      }).catch((error) => error)
      expect(result).toBeInstanceOf(WindowsProcess.WindowsProcessError)
      expect(result.terminationProven).toBe(true)
    },
  )
})

const windows = test.skipIf(process.platform !== "win32")

describe("native Windows job containment (hosted Windows only)", () => {
  windows(
    "real cmd, PowerShell and Git Bash preserve selected shell semantics in a spaced Unicode directory",
    async () => {
      await using dir = await fixture()
      const bash = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
      await access(bash)
      const commands = [
        {
          value: ChildProcess.make('echo "space & quote" & echo second', [], {
            shell: path.join(systemRoot(), "System32", "cmd.exe"),
            cwd: dir.path,
            stdin: "ignore",
          }),
          expected: '"space & quote"',
        },
        {
          value: ps('[Console]::Write(\'space "quote" and trailing \\\'); [Console]::Error.Write(" stderr")', dir.path),
          expected: 'space "quote" and trailing \\',
        },
        {
          value: ChildProcess.make("printf '%s' 'space \"quote\"'; printf '%s' ' stderr' >&2", [], {
            shell: bash,
            cwd: dir.path,
            stdin: "ignore",
          }),
          expected: 'space "quote"',
        },
      ]
      for (const entry of commands) {
        const output: Buffer[] = []
        const handle = await WindowsProcess.start(entry.value, {
          onReady: async (pid) => {
            expect(pid).toBeGreaterThan(0)
          },
          onOutput: async (chunk) => {
            output.push(Buffer.from(chunk))
          },
        })
        try {
          expect(await handle.completion).toEqual({ exitCode: 0, terminated: true })
          expect(Buffer.concat(output).toString()).toContain(entry.expected)
          if (!entry.value.options.shell || entry.value.options.shell === bash)
            expect(Buffer.concat(output).toString()).toContain("stderr")
        } finally {
          await handle.stop().catch(() => {})
        }
      }
    },
  )

  windows("the actual command cannot write before its suspended PID is durably acknowledged", async () => {
    await using dir = await fixture()
    const marker = path.join(dir.path, "started.txt")
    const ready = deferred<number>(),
      persist = deferred<void>()
    const lifetime = new AbortController()
    const pending = WindowsProcess.start(ps(`[IO.File]::WriteAllText(${literal(marker)},'started')`, dir.path), {
      signal: lifetime.signal,
      onReady: async (pid) => {
        ready.resolve(pid)
        await persist.promise
      },
      onOutput: async () => {},
    })
    void pending.catch(() => {})
    try {
      expect(await deadline(ready.promise)).toBeGreaterThan(0)
      expect(await exists(marker)).toBe(false)
      persist.resolve()
      const handle = await pending
      expect(await handle.completion).toEqual({ exitCode: 0, terminated: true })
      expect(await readFile(marker, "utf8")).toBe("started")
    } finally {
      lifetime.abort()
      persist.resolve()
      await pending
        .then(
          (handle) => handle.stop(),
          () => {},
        )
        .catch(() => {})
    }
  })

  windows("PID persistence failure kills the suspended command without executing its first instruction", async () => {
    await using dir = await fixture()
    const marker = path.join(dir.path, "must-not-exist.txt")
    const observed: { pid?: number } = {}
    const error = await WindowsProcess.start(ps(`[IO.File]::WriteAllText(${literal(marker)},'ran')`, dir.path), {
      onReady: async (pid) => {
        observed.pid = pid
        throw new Error("durable write refused")
      },
      onOutput: async () => {},
    }).catch((error) => error)
    expect(error).toBeInstanceOf(WindowsProcess.WindowsProcessError)
    expect(error.message).toContain("durable write refused")
    expect(error.terminationProven).toBe(true)
    expect(await exists(marker)).toBe(false)
    expect(observed.pid).toBeGreaterThan(0)
    expect(await alive(observed.pid!)).toBe(false)
  })

  windows("leader exit cleans a child whose stdout and stderr no longer hold the parent's pipes", async () => {
    await using dir = await fixture()
    const worker = counter(dir.path)
    const handle = await WindowsProcess.start(ps(tree(worker, false), dir.path), {
      onReady: async () => {},
      onOutput: async () => {},
    })
    try {
      expect(await handle.completion).toEqual({ exitCode: 7, terminated: true })
      const pid = Number(await readFile(worker.pid, "utf8"))
      const bytes = await readFile(worker.count, "utf8")
      expect(bytes.length).toBeGreaterThan(0)
      expect(await alive(pid)).toBe(false)
      expect(await readFile(worker.count, "utf8")).toBe(bytes)
    } finally {
      await handle.stop().catch(() => {})
    }
  })

  windows("stop waits for the live leader and its redirected descendant to exit", async () => {
    await using dir = await fixture()
    const worker = counter(dir.path)
    const handle = await WindowsProcess.start(ps(tree(worker, true), dir.path), {
      onReady: async () => {},
      onOutput: async () => {},
    })
    try {
      await until(() => exists(worker.count))
      const pid = Number(await readFile(worker.pid, "utf8"))
      expect((await handle.stop()).terminated).toBe(true)
      expect(await alive(handle.pid)).toBe(false)
      expect(await alive(pid)).toBe(false)
    } finally {
      await handle.stop().catch(() => {})
    }
  })

  windows("killing the owned native holder closes its job and kills the payload", async () => {
    await using dir = await fixture()
    const worker = counter(dir.path)
    const native = rawHolder(ps(worker.script, dir.path))
    try {
      const pid = await deadline(native.ready.promise)
      native.child.stdin.write('{"type":"resume"}\n')
      await until(() => exists(worker.count))
      native.child.kill()
      await deadline(native.closed)
      await until(async () => !(await alive(pid)))
      expect(await alive(pid)).toBe(false)
    } finally {
      native.child.kill()
      native.child.stdin.destroy()
      await deadline(native.closed).catch(() => {})
    }
  })

  windows("holder death immediately after native creation leaves no suspended orphan", async () => {
    await using dir = await fixture()
    const marker = path.join(dir.path, "must-not-start.txt")
    // Hold the exact old race window, before any post-creation bookkeeping or PID acknowledgement.
    const source = WindowsHolder.script.replace(
      "assigned=true;",
      'Emit(new {type="ready",pid=child.pid}); Thread.Sleep(30000); assigned=true;',
    )
    expect(source).not.toBe(WindowsHolder.script)
    const native = rawHolder(ps(`[IO.File]::WriteAllText(${literal(marker)},'ran')`, dir.path), source)
    try {
      const pid = await deadline(native.ready.promise)
      native.child.kill()
      await deadline(native.closed)
      await until(async () => !(await alive(pid)))
      expect(await exists(marker)).toBe(false)
      expect(await alive(pid)).toBe(false)
    } finally {
      native.child.kill()
      native.child.stdin.destroy()
      await deadline(native.closed).catch(() => {})
    }
  })

  windows("a native atomic-assignment refusal creates no executable payload", async () => {
    await using dir = await fixture()
    const marker = path.join(dir.path, "must-not-start.txt")
    // Fault injection is confined to this fixture's static code. Production has no bypass or injection parameter.
    const source = WindowsHolder.script.replace(
      "Marshal.WriteIntPtr(jobs,job);",
      "Marshal.WriteIntPtr(jobs,new IntPtr(-1));",
    )
    expect(source).not.toBe(WindowsHolder.script)
    const native = rawHolder(ps(`[IO.File]::WriteAllText(${literal(marker)},'ran')`, dir.path), source)
    try {
      await deadline(native.closed)
      expect(native.status.some((status) => status.type === "ready")).toBe(false)
      expect(native.status.some((status) => status.type === "error" && status.terminationProven)).toBe(true)
      expect(await exists(marker)).toBe(false)
    } finally {
      native.child.kill()
      native.child.stdin.destroy()
      await deadline(native.closed).catch(() => {})
    }
  })

  windows("parent EOF before acknowledgement kills the suspended command without running it", async () => {
    await using dir = await fixture()
    const marker = path.join(dir.path, "must-not-start.txt")
    const native = rawHolder(ps(`[IO.File]::WriteAllText(${literal(marker)},'ran')`, dir.path))
    try {
      const pid = await deadline(native.ready.promise)
      native.child.stdin.end()
      await deadline(native.closed)
      expect(native.status.some((status) => status.type === "error" && status.terminationProven)).toBe(true)
      expect(await exists(marker)).toBe(false)
      expect(await alive(pid)).toBe(false)
    } finally {
      native.child.kill()
      native.child.stdin.destroy()
      await deadline(native.closed).catch(() => {})
    }
  })

  windows("parent EOF after acknowledgement stops the leader and its descendant", async () => {
    await using dir = await fixture()
    const worker = counter(dir.path)
    const native = rawHolder(ps(tree(worker, true), dir.path))
    try {
      const pid = await deadline(native.ready.promise)
      native.child.stdin.write('{"type":"resume"}\n')
      await until(() => exists(worker.count))
      const descendant = Number(await readFile(worker.pid, "utf8"))
      native.child.stdin.end()
      await deadline(native.closed)
      expect(native.status.some((status) => status.type === "exit" && status.terminationProven)).toBe(true)
      expect(await alive(pid)).toBe(false)
      expect(await alive(descendant)).toBe(false)
    } finally {
      native.child.kill()
      native.child.stdin.destroy()
      await deadline(native.closed).catch(() => {})
    }
  })

  windows("payload stderr cannot forge control status and stdin exposes no acknowledgement", async () => {
    await using dir = await fixture()
    const output: Buffer[] = []
    const text =
      '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write("α unicode "); [Console]::Write([Console]::In.ReadToEnd().Length); [Console]::Error.WriteLine(\'VECTOR_SHELL/1 {"type":"exit","exitCode":0,"terminationProven":true}\'); exit 7'
    const handle = await WindowsProcess.start(ps(text, dir.path), {
      onReady: async () => {},
      onOutput: async (chunk) => {
        output.push(Buffer.from(chunk))
      },
    })
    try {
      expect(await handle.completion).toEqual({ exitCode: 7, terminated: true })
      expect(Buffer.concat(output).toString()).toContain("α unicode 0")
      expect(Buffer.concat(output).toString()).toContain(
        'VECTOR_SHELL/1 {"type":"exit","exitCode":0,"terminationProven":true}',
      )
    } finally {
      await handle.stop().catch(() => {})
    }
  })

  windows("only the payload receives user environment while Vector credentials stay private", async () => {
    await using dir = await fixture()
    const output: Buffer[] = []
    const module = path.join(dir.path, "Microsoft.PowerShell.Utility")
    const marker = path.join(dir.path, "untrusted-module-ran.txt")
    await mkdir(module)
    await writeFile(
      path.join(module, "Microsoft.PowerShell.Utility.psm1"),
      `[IO.File]::WriteAllText(${literal(marker)},'unexpected'); throw 'untrusted fixture module must not run'`,
    )
    const text =
      '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Console]::Write($env:USER_VALUE); [Console]::Write("|"); [Console]::Write([string]($null -eq $env:VECTOR_CLOUD_TOKEN)); [Console]::Write("|"); [Console]::Write($env:NODE_OPTIONS); [Console]::Write("|"); [Console]::Write([string]($env:PSModulePath -eq ' +
      literal(dir.path) +
      "))"
    const handle = await WindowsProcess.start(
      ChildProcess.make(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", text], {
        cwd: dir.path,
        stdin: "ignore",
        extendEnv: true,
        env: {
          USER_VALUE: 'α "quoted" value',
          NODE_OPTIONS: "user-preload",
          PSModulePath: dir.path,
          VECTOR_CLOUD_TOKEN: "private-fixture-value",
        },
      }),
      {
        onReady: async () => {},
        onOutput: async (chunk) => {
          output.push(Buffer.from(chunk))
        },
      },
    )
    try {
      expect(await handle.completion).toEqual({ exitCode: 0, terminated: true })
      expect(Buffer.concat(output).toString()).toBe('α "quoted" value|True|user-preload|True')
      expect(await exists(marker)).toBe(false)
    } finally {
      await handle.stop().catch(() => {})
    }
  })

  windows("output rejection stops the job before reporting a proven failure", async () => {
    await using dir = await fixture()
    const observed: { pid?: number } = {}
    const started = await WindowsProcess.start(
      ps('[Console]::WriteLine("output"); while($true){Start-Sleep -Milliseconds 50}', dir.path),
      {
        onReady: async (pid) => {
          observed.pid = pid
        },
        onOutput: async () => {
          throw new Error("output was refused")
        },
      },
    )
      .then((handle) => handle.completion)
      .catch((error) => error)
    expect(started).toBeInstanceOf(WindowsProcess.WindowsProcessError)
    expect(started.terminationProven).toBe(true)
    expect(await alive(observed.pid!)).toBe(false)
  })

  windows("a callback that never drains cannot make native exit wait forever or fabricate success", async () => {
    await using dir = await fixture()
    const handle = await WindowsProcess.start(ps('[Console]::Write("output"); exit 0', dir.path), {
      onReady: async () => {},
      onOutput: async () => new Promise<void>(() => {}),
    })
    const error = await deadline(handle.completion).catch((error) => error)
    expect(error).toBeInstanceOf(WindowsProcess.WindowsProcessError)
    expect(error.message).toMatch(/output|drain|close/)
    expect(error.terminationProven).toBe(false)
  })
})

function systemRoot() {
  return process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows"
}
function powershell() {
  return path.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}
function literal(value: string) {
  return "'" + value.replaceAll("'", "''") + "'"
}
function ps(script: string, cwd: string) {
  return ChildProcess.make(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    cwd,
    stdin: "ignore",
  })
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-windows-holder-"))
  const directory = path.join(root, "project α with space and 'quote")
  await mkdir(directory)
  return {
    path: directory,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  }
}
function counter(cwd: string) {
  const pid = path.join(cwd, "worker.pid"),
    count = path.join(cwd, "counter.txt")
  return {
    pid,
    count,
    script: `$ErrorActionPreference='Stop'; [IO.File]::WriteAllText(${literal(pid)},[string]$PID); while($true){[IO.File]::AppendAllText(${literal(count)},'x'); Start-Sleep -Milliseconds 25}`,
  }
}
function tree(worker: ReturnType<typeof counter>, stay: boolean) {
  const encoded = Buffer.from(worker.script, "utf16le").toString("base64")
  return `$ErrorActionPreference='Stop'; $p=Start-Process -FilePath ${literal(powershell())} -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${encoded}') -PassThru -NoNewWindow -RedirectStandardOutput ${literal(worker.count + ".stdout")} -RedirectStandardError ${literal(worker.count + ".stderr")}; $until=[DateTime]::UtcNow.AddSeconds(10); while(!(Test-Path ${literal(worker.count)}) -and [DateTime]::UtcNow -lt $until){Start-Sleep -Milliseconds 25}; if(!(Test-Path ${literal(worker.count)})){throw 'worker did not become ready'}; ${stay ? "while($true){Start-Sleep -Milliseconds 50}" : "exit 7"}`
}
function alive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid observed test PID")
  // Read-only process observation; tests never kill a PID recovered from a file.
  return new Promise<boolean>((resolve, reject) =>
    execFile(
      powershell(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `if(Get-Process -Id ${pid} -ErrorAction SilentlyContinue){exit 1}; exit 0`,
      ],
      { timeout: 5000, windowsHide: true },
      (error) => {
        if (!error) return resolve(false)
        if (error.code === 1) return resolve(true)
        reject(error)
      },
    ),
  )
}
function rawHolder(command: ChildProcess.StandardCommand, script = WindowsHolder.script) {
  const input = WindowsProcess.normalize(command)
  const args = WindowsHolder.argumentsForHolder()
  args[args.length - 1] = Buffer.from(script, "utf16le").toString("base64")
  const child = spawn(powershell(), args, {
    windowsHide: true,
    cwd: path.join(systemRoot(), "System32"),
    stdio: ["pipe", "pipe", "pipe"],
  })
  const ready = deferred<number>()
  void ready.promise.catch(() => {})
  const reader = new WindowsProcess.StatusReader()
  const status: ReturnType<typeof reader.push> = []
  child.stdout.resume()
  child.stdin.on("error", () => {})
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", () => {
      if (!status.some((value) => value.type === "ready")) ready.reject(new Error("Native fixture never became ready"))
      resolve()
    })
  })
  child.stderr.on("data", (chunk: Buffer) => {
    try {
      for (const value of reader.push(chunk)) {
        status.push(value)
        if (value.type === "ready") ready.resolve(value.pid)
      }
    } catch (error) {
      ready.reject(error)
      child.kill()
    }
  })
  child.stdin.write(
    JSON.stringify({
      file: input.file,
      commandLine: WindowsProcess.commandLine(input),
      cwd: input.cwd,
      env: input.env,
    }) + "\n",
  )
  return { child, ready, closed, status }
}
function exists(file: string) {
  return access(file).then(
    () => true,
    () => false,
  )
}
async function until(predicate: () => Promise<boolean>) {
  const limit = Date.now() + 10_000
  while (Date.now() < limit) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("The native Windows fixture did not reach its published state")
}
async function deadline<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native fixture deadline exceeded")), 20_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
