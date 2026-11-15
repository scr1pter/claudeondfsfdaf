import { expect, test } from "bun:test"
import path from "node:path"
import { LinuxIsolation } from "@vectordevai/core/process-isolation/linux"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { CONTROL, ROOT, TEMP, WORKSPACE, assets, cell, controllerAction } from "./common"
import {
  FAILURE_PREFIX,
  OBSERVER_OPERATIONS,
  OBSERVER_PREFIX,
  PROBE_EXITS,
  PROBE_PROC,
  RUN_ERRNOS,
  RUN_OPERATIONS,
  RUN_REFUSALS,
  RUN_SYSCALLS,
  SHELL_STAGES,
  observerStage,
  probeArguments,
  probeExit,
  probeNodeStage,
  probeStage,
  runError,
  shellFailure,
  shellStage,
} from "../native-shell-payload"

test("the actual controller gate accepts only the two exact production control operations", () => {
  expect(controllerAction(["github", "sandbox", "prepare"])).toBe("prepare")
  expect(controllerAction(["github", "sandbox", "finish"])).toBe("finish")
  for (const args of [
    [],
    ["--install"],
    ["--observe"],
    ["github", "sandbox", "run"],
    ["github", "sandbox", "prepare", "--"],
    ["github", "sandbox", "finish", "--install"],
    ["github", "sandbox", "finish\0"],
    ["github", "sandbox", "PREPARE"],
  ])
    expect(() => controllerAction(args)).toThrow()
})
test("the install receipt path parser refuses traversal, aliases, unbounded or shadowing files", () => {
  const asset = { path: "runtime/node", bytes: 1, sha256: "a".repeat(64) }
  expect(assets([asset])).toEqual([asset])
  for (const path of [
    "../node",
    "runtime//node",
    "/runtime/node",
    "runtime/./node",
    "runtime/../node",
    "runtime\\node",
    "runtime/\uD800",
    "runtime/" + "a".repeat(129),
  ])
    expect(() => assets([{ ...asset, path }])).toThrow()
  for (const bytes of [-1, NaN, Infinity, 1.5, 268_435_457]) expect(() => assets([{ ...asset, bytes }])).toThrow()
  expect(() => assets([{ ...asset, source: "/workspace/other" }])).toThrow()
  expect(() => assets([asset, asset])).toThrow()
  expect(() =>
    assets([
      { ...asset, path: "z" },
      { ...asset, path: "a" },
    ]),
  ).toThrow()
  expect(() =>
    assets(Array.from({ length: 3 }, (_, i) => ({ ...asset, path: `file${i}`, bytes: 268_435_456 }))),
  ).toThrow()
})
test("fresh matrix cells cannot select sudo, an unknown runtime or mixed families", () => {
  expect(cell("node", "own-key", "baseline")).toEqual({ runtime: "node", mode: "own-key", family: "baseline" })
  expect(cell("bun", "codium", "engine-death")).toEqual({ runtime: "bun", mode: "codium", family: "engine-death" })
  for (const values of [
    ["node", "sudo", "baseline"],
    ["source", "codium", "baseline"],
    ["bun", "codium", "combined"],
  ])
    expect(() => cell(values[0], values[1], values[2])).toThrow()
})
test("every copied runtime, control tree and spec path stays outside every native mask", () => {
  // run() refuses a runtime beneath any mask, so the fixture runs only the copies under /usr/libexec.
  for (const value of [
    ROOT,
    CONTROL,
    `${ROOT}/runtime/node`,
    `${ROOT}/runtime/bun`,
    `${CONTROL}/runtime/node`,
    `${CONTROL}/runtime/bun`,
    `${CONTROL}/vector`,
    LinuxIsolation.ROOT,
    LinuxIsolation.ENTRY,
    LinuxIsolation.PYTHON,
    ...LinuxIsolation.CONTAINERS.flatMap((container) => [
      container,
      `${container}/checkout`,
      `${container}/tool-scratch`,
      `${container}/tool-namespaces/broker.sock`,
    ]),
  ])
    expect(() => LinuxIsolation.assertUnmaskedRuntime(value)).not.toThrow()
  for (const value of [TEMP, WORKSPACE, "/home/runner/.bun/bin/bun"])
    expect(() => LinuxIsolation.assertUnmaskedRuntime(value)).toThrow(LinuxIsolation.Unavailable)
})
test("the host witness failure vocabulary is closed, unique, role-prefixed and carries no free text", () => {
  const roles = ["host", "observer", "driver", "engine", "run", "probe"] as const
  expect(Object.keys(SHELL_STAGES)).toEqual([...roles])
  const all = roles.flatMap((role) => [...SHELL_STAGES[role]])
  expect(new Set(all).size).toBe(all.length)
  for (const role of roles) {
    expect(SHELL_STAGES[role].length).toBeGreaterThan(0)
    for (const label of SHELL_STAGES[role]) {
      expect(label.startsWith(role + "-")).toBe(true)
      expect(label).toMatch(/^[a-z]+(-[a-z0-9]+)+$/)
      expect(label.length).toBeLessThanOrEqual(64)
    }
  }
  // Protocol event names never double as a stage, so a reader cannot confuse the two.
  for (const event of ["engine-ready", "engine-summary", "engine-failure", "driver-exit", "driver-failure"])
    expect(all).not.toContain(event)
  expect(SHELL_STAGES.run).toHaveLength(5 + RUN_OPERATIONS.length + RUN_SYSCALLS.length * RUN_ERRNOS.length + 1)
  // The engine runtime under both proc treatments (5 x 5), then Node under the empty proc (5).
  expect(PROBE_EXITS).toEqual(["zero", "abort", "signal", "other", "error"])
  expect(SHELL_STAGES.probe).toHaveLength(30)
  expect(SHELL_STAGES.probe.filter((label) => /^probe-empty-[a-z]+-own-[a-z]+$/.test(label))).toHaveLength(25)
  expect(SHELL_STAGES.probe.filter((label) => /^probe-node-[a-z]+$/.test(label))).toHaveLength(5)
  expect(all).toHaveLength(134)
  expect(new Set(OBSERVER_OPERATIONS).size).toBe(OBSERVER_OPERATIONS.length)
  expect(FAILURE_PREFIX.endsWith(" ")).toBe(true)
  expect(OBSERVER_PREFIX.endsWith(" ")).toBe(true)
  expect(Object.keys(RUN_REFUSALS).every((label) => shellStage("run", label))).toBe(true)
})
test("Root's observer stderr yields one exact fixed stage or nothing", () => {
  const line = (stage: string) => `${OBSERVER_PREFIX}{"stage":"${stage}"}`
  for (const stage of SHELL_STAGES.observer) {
    expect(observerStage(line(stage) + "\n")).toBe(stage)
    expect(observerStage(line(stage))).toBe(stage)
  }
  expect(observerStage("sudo: unrelated\n" + line("observer-controls-agent") + "\n")).toBe("observer-controls-agent")
  for (const value of [
    line("observer-start") + "\n" + line("observer-output") + "\n",
    line("observer-unknown") + "\n",
    `${OBSERVER_PREFIX}{"stage":"observer-start","path":"/home/runner"}\n`,
    `${OBSERVER_PREFIX}{"stage": "observer-start"}\n`,
    line("observer-start") + "\r\n",
    line("/home/runner/work/_temp") + "\n",
    `${OBSERVER_PREFIX.trim()}{"stage":"observer-start"}\n`,
    " " + line("observer-start") + "\n",
    "",
    "Traceback (most recent call last):\n",
    line("observer-start") + "\n" + "x".repeat(4096),
  ])
    expect(observerStage(value)).toBeNull()
  for (const value of [undefined, null, 1, Buffer.from(line("observer-start")), { stderr: line("observer-start") }])
    expect(observerStage(value)).toBeNull()
})
test("the witness failure line re-encodes only closed fields within its bound", () => {
  const empty = {
    host: "host-controls",
    case: null,
    operation: "controls",
    observer: "observer-controls-agent",
    driver: null,
    run: null,
    driverExit: null,
    probe: null,
    probeNode: null,
    engine: null,
    engineCase: null,
    control: null,
  }
  expect(shellFailure(empty)).toBe(
    FAILURE_PREFIX +
      '{"v":1,"host":"host-controls","case":null,"operation":"controls","observer":"observer-controls-agent",' +
      '"driver":null,"run":null,"driverExit":null,"probe":null,"probeNode":null,"engine":null,"engineCase":null,' +
      '"control":null}\n',
  )
  // The shape the failure-only runtime probe reports after a launcher signal exit before any engine report.
  expect(
    shellFailure({
      ...empty,
      host: "host-close",
      operation: null,
      observer: null,
      driverExit: 134,
      probe: "probe-empty-abort-own-zero",
      probeNode: "probe-node-zero",
    }),
  ).toBe(
    FAILURE_PREFIX +
      '{"v":1,"host":"host-close","case":null,"operation":null,"observer":null,"driver":null,"run":null,' +
      '"driverExit":134,"probe":"probe-empty-abort-own-zero","probeNode":"probe-node-zero","engine":null,' +
      '"engineCase":null,"control":null}\n',
  )
  const record = {
    v: 1,
    event: "native-control-failure",
    origin: "transport",
    operation: "inspect",
    stage: "close",
    class: "ChildExit",
    errno: null,
    exit: 1,
    signal: null,
  }
  const full = {
    ...empty,
    host: "host-close",
    case: "inspect",
    operation: "inspect",
    observer: null,
    driver: "driver-run",
    run: "run-errno-lstat-eacces",
    driverExit: 125,
    probe: "probe-empty-signal-own-signal",
    probeNode: "probe-node-signal",
    engine: "engine-round",
    engineCase: "death",
    control: { v: 1, event: "native-control-failure", records: [record] },
    message: "/home/runner/private secret",
    frozen: true,
  }
  const text = shellFailure(full)
  expect(text?.startsWith(FAILURE_PREFIX) && text.endsWith("\n")).toBe(true)
  const parsed = JSON.parse(text!.slice(FAILURE_PREFIX.length))
  expect(Object.keys(parsed)).toEqual([
    "v",
    "host",
    "case",
    "operation",
    "observer",
    "driver",
    "run",
    "driverExit",
    "probe",
    "probeNode",
    "engine",
    "engineCase",
    "control",
  ])
  expect(parsed.control).toEqual(full.control)
  expect(text).not.toContain("private")
  expect(text).not.toContain("frozen")
  // A field that fails its own validation leaves the closed host stage alone on the line; no host stage, no line.
  const minimal = FAILURE_PREFIX + '{"v":1,"host":"host-close"}\n'
  for (const change of [{ host: "host-unknown" }, { host: "engine-ready" }, { host: null }])
    expect(shellFailure({ ...full, ...change })).toBeUndefined()
  for (const change of [
    { case: "unknown-case" },
    { case: 1 },
    { operation: "shell" },
    { observer: "observer-ready" },
    { driver: "driver-configuration" },
    { run: "run-errno-lstat-enoexec" },
    { run: "refused" },
    { engine: "engine-ready" },
    { engineCase: "/tmp" },
    { driverExit: -1 },
    { driverExit: 256 },
    { driverExit: 1.5 },
    { driverExit: "125" },
    { driverExit: NaN },
    { probe: "probe-empty-abort" },
    { probe: "probe-node-zero" },
    { probe: "probe-empty-crash-own-zero" },
    { probe: 134 },
    { probeNode: "probe-empty-abort-own-zero" },
    { probeNode: "probe-node-crash" },
    { probeNode: "node-zero" },
    { control: { ...full.control, message: "private" } },
    { control: { ...full.control, records: [] } },
    { control: { ...full.control, records: Array.from({ length: 5 }, () => record) } },
    { control: { ...full.control, event: "native-control-success" } },
    { control: { ...full.control, records: [{ ...record, stage: "/home/runner/private path" }] } },
    { control: { ...full.control, records: [{ ...record, extra: 1 }] } },
    { control: { ...full.control, records: [{ ...record, exit: 4096 }] } },
    { control: { ...full.control, records: [{ ...record, stage: "x".repeat(129) }] } },
    { control: [record] },
  ])
    expect(shellFailure({ ...full, ...change })).toBe(minimal)
  // A line over its 4 KiB bound also falls back to the host stage alone.
  const token = "a".repeat(128)
  const oversized = Array.from({ length: 4 }, () => ({
    ...record,
    event: token,
    origin: token,
    operation: token,
    stage: token,
    class: token,
    errno: token,
    signal: token,
  }))
  expect(shellFailure({ ...full, control: { ...full.control, records: oversized } })).toBe(minimal)
  for (const value of [undefined, null, "host-close", [full], 1]) expect(shellFailure(value)).toBeUndefined()
  expect(shellFailure(Object.fromEntries(Object.entries(full).filter((entry) => entry[0] !== "host")))).toBeUndefined()
  // A witness without either probe key is malformed and keeps only its host stage.
  for (const key of ["probe", "probeNode"])
    expect(shellFailure(Object.fromEntries(Object.entries(full).filter((entry) => entry[0] !== key)))).toBe(minimal)
  // Four records whose stage and class are the widest admitted tokens still fit the 4 KiB line bound whole.
  const widest = Array.from({ length: 4 }, () => ({ ...record, stage: "a".repeat(128), class: "b".repeat(128) }))
  const wide = shellFailure({ ...full, control: { ...full.control, records: widest } })
  expect(wide && JSON.parse(wide.slice(FAILURE_PREFIX.length)).control.records).toEqual(widest)
  expect(wide && Buffer.byteLength(wide)).toBeLessThanOrEqual(4096)
})
test("sandbox run errors map to closed labels by exact message or allowlisted errno only", () => {
  for (const [label, message] of Object.entries(RUN_REFUSALS)) expect(runError(new Error(message), "x")).toBe(label)
  expect(runError(new Error(ProcessIsolation.REFUSAL), ProcessIsolation.REFUSAL)).toBe("run-isolation")
  for (const name of RUN_OPERATIONS)
    expect(runError(new Error(`Sandbox operation ${name} failed or timed out; the run is refused.`), "x")).toBe(
      `run-operation-${name}`,
    )
  expect(runError(new LinuxIsolation.Unavailable(), "x")).toBe("run-unavailable")
  const errno = (code: string, syscall: string, file = "/home/runner/private/secret-path") =>
    Object.assign(new Error(`${code}: permission denied, ${syscall} '${file}'`), { code, syscall, path: file })
  expect(runError(errno("EACCES", "lstat"), "x")).toBe("run-errno-lstat-eacces")
  expect(runError(errno("ENOENT", "scandir"), "x")).toBe("run-errno-scandir-enoent")
  expect(runError(errno("EROFS", "open"), "x")).toBe("run-errno-open-erofs")
  for (const syscall of RUN_SYSCALLS)
    for (const code of RUN_ERRNOS) expect(SHELL_STAGES.run).toContain(runError(errno(code, syscall), "x"))
  for (const value of [
    new Error("Sandbox operation docker failed or timed out; the run is refused."),
    new Error("Sandbox operation id failed or timed out; the run is refused. /home/runner"),
    new Error(RUN_REFUSALS["run-refused"] + " "),
    new Error("/home/runner/private/secret-path"),
    errno("EACCES", "spawn /usr/bin/sudo"),
    errno("eacces", "lstat"),
    errno("ENOEXEC", "open"),
    Object.assign(new Error("x"), { code: 13, syscall: "lstat" }),
    RUN_REFUSALS["run-refused"],
    undefined,
    { message: RUN_REFUSALS["run-refused"] },
    { code: "EACCES", syscall: "lstat" },
  ])
    expect(runError(value, ProcessIsolation.REFUSAL)).toBe("run-other")
  // An accessor message is never called.
  const getter = new Error("placeholder")
  Object.defineProperty(getter, "message", {
    get() {
      throw new Error("accessor called")
    },
  })
  expect(runError(getter, "x")).toBe("run-other")
})
test("every fixture stage assignment and observer label agrees with the closed vocabulary", async () => {
  // test.yml also runs this file on Windows, whose checkout may add carriage returns; the literal checks expect LF.
  const read = async (name: string) =>
    (await Bun.file(path.join(import.meta.dir, "..", name)).text()).replaceAll("\r\n", "\n")
  const host = await read("native-shell-host.ts")
  const engine = await read("native-shell-engine.ts")
  const found = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]!)
  // Every slice asserts both of its markers, so a missing one fails here instead of widening the slice.
  const slice = (text: string, from: string, to: string) => {
    const start = text.indexOf(from)
    const end = text.indexOf(to, start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    return text.slice(start, end)
  }
  const observe = slice(host, "const OBSERVE = String.raw`", "\n`\n")
  expect(found(observe, /^\s*STAGE='([^']*)'$/gm).toSorted()).toEqual([...SHELL_STAGES.observer].toSorted())
  expect(observe).toContain(
    "sys.stderr.write('VECTOR_NATIVE_SHELL_OBSERVER '+json.dumps({'stage':STAGE},separators=(',',':'))+'\\n')",
  )
  expect(observe).toContain("sys.excepthook=observer_failure")
  expect(OBSERVER_PREFIX).toBe("VECTOR_NATIVE_SHELL_OBSERVER ")
  const union = (...lists: string[][]) => [...new Set(lists.flat())].toSorted()
  expect(
    union(
      found(observe, /operation=='([a-z-]+)'/g),
      [...observe.matchAll(/operation in \(([^)]*)\)/g)].flatMap((match) =>
        match[1]!.split(",").map((item) => item.trim().replaceAll("'", "")),
      ),
    ),
  ).toEqual([...OBSERVER_OPERATIONS].toSorted())
  expect(union(found(host, /\bat\("([^"]*)"\)/g), found(host, /^\s*host: "([^"]*)",$/gm))).toEqual(
    [...SHELL_STAGES.host].toSorted(),
  )
  expect(union(found(host, /driving\.stage = "([^"]*)"/g), found(host, /\} = \{ stage: "([^"]*)"/g))).toEqual(
    [...SHELL_STAGES.driver].toSorted(),
  )
  expect(union(found(engine, /progress\.stage = "([^"]*)"/g), found(engine, /^\s*stage: "([^"]*)",$/gm))).toEqual(
    [...SHELL_STAGES.engine].toSorted(),
  )
  // Report-only branches record another role's stage and never move the host stage.
  for (const event of ["driver-failure", "engine-failure"])
    expect(slice(host, `if (item.event === "${event}") {`, "\n      return\n    }")).not.toMatch(/\bat\(/)
  // The close stage is set only after every queued protocol handler has settled, and a role's own refusal report
  // fails the close check in both families.
  expect(host).toContain('    await queue\n    at("host-close")\n')
  const close = slice(host, '    at("host-close")\n', '    at("host-final-snapshot")\n')
  expect(close).toMatch(
    /need\(\s*!protocolError && pending\.length === 0 && engine && control && witness\.engine === null && witness\.driver === null,?\s*\)/,
  )
  expect(close).toContain('if (manifest.family === "baseline")')
  // The runtime probe runs only on the observed geometry (a launcher signal exit at close with no other role report),
  // varies only the proc treatment and the runtime, never calls at(), and is awaited before the one FAILURE line.
  const probe = slice(host, "async function runtimeProbe() {\n", "\n}\n")
  expect(probe.replace(/\s+/g, " ")).toContain(
    'const target = probing.target if ( !( target && witness.host === "host-close" && witness.driverExit !== null && ' +
      "witness.driverExit > 128 && witness.engine === null && witness.driver === null && witness.case === null ) ) return ",
  )
  const count = (text: string, part: string) => text.split(part).length - 1
  expect(count(probe, "PROBE_PROC.empty")).toBe(2)
  expect(count(probe, "PROBE_PROC.own")).toBe(1)
  expect(count(probe, "target.runtime")).toBe(2)
  expect(count(probe, "`${ROOT}/runtime/node`")).toBe(1)
  expect(count(probe, 'execute("/usr/bin/sudo", probeArguments(proc, runtime, target.uid, target.gid), {')).toBe(1)
  expect(probe.replace(/\s+/g, " ")).toContain(
    "env: ENV, timeout: 5_000, maxBuffer: 65_536, }), ) .then(() => probeExit(undefined), probeExit)",
  )
  expect(probe).not.toMatch(/\bat\(/)
  expect(count(host, "witness.probe =")).toBe(1)
  expect(count(host, "witness.probeNode =")).toBe(1)
  expect(host).not.toContain("probeTarget")
  expect(host).toContain("\nconst probing: { target?: { runtime: string; uid: number; gid: number } } = {}\n")
  expect(count(host, "probing.target =")).toBe(2)
  const environment = slice(host, '  at("host-environment")\n', '  at("host-controls")\n')
  expect(environment).toContain("  probing.target = { runtime: manifest.runtimePath, uid: spec.uid, gid: spec.gid }\n")
  // Any engine-ready report, admitted or not, clears the target first, so the probe never follows an engine report.
  expect(host).toContain(
    '    if (item.event === "engine-ready") {\n      probing.target = undefined\n      at("host-engine-ready")\n',
  )
  // Exit 125 comes first and a terminal catch follows the async handler, so nothing in it can change the exit code.
  const refusal = slice(host, 'void (role === "driver" ? driver() : main())\n', "\n  .catch(() => {})\n")
  expect(refusal).toStartWith(
    'void (role === "driver" ? driver() : main())\n  .catch(async () => {\n    process.exitCode = 125\n' +
      '    if (role === "host") {\n' +
      "      // The probe cannot reject today; if it ever did, the one FAILURE line must still be written.\n" +
      '      await runtimeProbe().catch(() => {})\n      process.stderr.write(shellFailure(witness) ?? "")\n    }\n' +
      '    process.stderr.write("Native Shell host fixture refused\\n")\n',
  )
  expect(host).toEndWith("\n  .catch(() => {})\n")
})
test("the failure-only runtime probe varies only the engine sandbox's proc treatment", async () => {
  const contains = (list: readonly string[], part: readonly string[]) =>
    list.some((_, index) => part.every((item, offset) => list[index + offset] === item))
  const groups = (proc: readonly string[]) => [
    "--dev",
    "/dev",
    ...proc,
    "--cap-add",
    "CAP_SETUID",
    "--cap-add",
    "CAP_SETGID",
    "--cap-add",
    "CAP_DAC_OVERRIDE",
    "--chdir",
  ]
  // The production engine sandbox mounts exactly the `empty` treatment, between the same fixed bwrap groups.
  const production = ProcessIsolation.engineArguments("/bin/true", [], {
    container: "/mnt/vector-agent-sandbox",
    cwd: "/runner/work/repo",
  })
  expect(ProcessIsolation.BINARY).toBe("/usr/bin/bwrap")
  expect(production.slice(0, 4)).toEqual(["--die-with-parent", "--ro-bind", "/", "/"])
  expect(contains(production, groups(PROBE_PROC.empty))).toBe(true)
  expect(contains(production, PROBE_PROC.own)).toBe(false)
  expect(production).not.toContain("--unshare-pid")
  expect(production).not.toContain("--proc")
  // The `own` treatment follows entry.py's command namespaces, which pair --unshare-pid with a private procfs.
  const read = async (name: string) =>
    (await Bun.file(path.join(import.meta.dir, name)).text()).replaceAll("\r\n", "\n")
  // These source ties compare token sequences without whitespace or trailing commas, so a formatting-only edit of a
  // production file cannot turn this first gate of every native dispatch red.
  const tokens = (text: string) => text.replace(/\s+/g, "").replace(/,(?=[)\]}])/g, "")
  const entry = tokens(await read("../../../../core/src/process-isolation/linux/entry.py"))
  expect(entry).toContain(tokens('"--dev", "/dev", "--proc", "/proc", "--cap-drop", "ALL"'))
  expect(entry).toContain(tokens('"--unshare-pid"'))
  // run()'s hosted inner chain and its native launch, which the probe repeats without the proof FD wrapper, the
  // checkout --chdir, the clean environment and the engine bundle.
  const sandbox = tokens(await read("../../../src/cli/cmd/github.sandbox.ts"))
  expect(sandbox).toContain(tokens('const launcher = hosted ? "/usr/bin/sudo" : binary const inner = hosted'))
  expect(sandbox).toContain(
    tokens("engineLaunch(inner, workspace, state!.sudo, native || ProcessIsolation.FLOOR, scope)"),
  )
  expect(sandbox).toContain(
    tokens(
      [
        '"/usr/bin/prlimit",',
        '"--core=0:0",',
        '"--",',
        '"/usr/bin/setpriv",',
        "`--reuid=${state!.uid}`,",
        "`--regid=${state!.gid}`,",
        '"--clear-groups",',
        '...(!state!.sudo ? ["--no-new-privs"] : []),',
        '"--",',
        '"/usr/bin/env",',
        '"-i",',
      ].join(" "),
    ),
  )
  expect(sandbox).toContain(tokens('return [ "-n", ...(sudo || !floor ? inner'))
  // Only formatting is ignored: a rewrapped call still matches, and a renamed binding or an extra argument does not.
  const call = tokens("engineLaunch(inner, workspace, state!.sudo, native || ProcessIsolation.FLOOR, scope)")
  expect(
    tokens("engineLaunch(\n  inner,\n  workspace,\n  state!.sudo,\n  native || ProcessIsolation.FLOOR,\n  scope,\n)"),
  ).toBe(call)
  expect(
    tokens("engineLaunch(inner, workspace, state!.sudo, native || ProcessIsolation.FLOOR, scope, extra)"),
  ).not.toContain(call)
  expect(tokens('const launcher = hosted ? "/usr/bin/sudo" : binary2\nconst inner = hosted')).not.toContain(
    tokens('const launcher = hosted ? "/usr/bin/sudo" : binary const inner = hosted'),
  )
  const expected = (proc: readonly string[], runtime: string) => [
    "-n",
    "/usr/bin/bwrap",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    ...proc,
    "--cap-add",
    "CAP_SETUID",
    "--cap-add",
    "CAP_SETGID",
    "--cap-add",
    "CAP_DAC_OVERRIDE",
    "--chdir",
    "/",
    "--",
    "/usr/bin/prlimit",
    "--core=0:0",
    "--",
    "/usr/bin/setpriv",
    "--reuid=1001",
    "--regid=1002",
    "--clear-groups",
    "--no-new-privs",
    "--",
    "/usr/bin/env",
    "-i",
    "PATH=/usr/bin:/bin",
    runtime,
    "-e",
    "0",
  ]
  expect(PROBE_PROC.empty).toEqual(["--tmpfs", "/proc", "--remount-ro", "/proc"])
  expect(PROBE_PROC.own).toEqual(["--unshare-pid", "--proc", "/proc", "--remount-ro", "/proc"])
  for (const runtime of [`${ROOT}/runtime/node`, `${ROOT}/runtime/bun`])
    for (const proc of [PROBE_PROC.empty, PROBE_PROC.own]) {
      const argv = probeArguments(proc, runtime, 1001, 1002)
      expect(argv).toEqual(expected(proc, runtime))
      expect(contains(argv, groups(proc))).toBe(true)
    }
  // The two treatments differ only in the proc segment.
  const empty = probeArguments(PROBE_PROC.empty, `${ROOT}/runtime/bun`, 1001, 1002)
  const own = probeArguments(PROBE_PROC.own, `${ROOT}/runtime/bun`, 1001, 1002)
  expect([...empty.slice(0, 8), ...empty.slice(8 + PROBE_PROC.empty.length)]).toEqual([
    ...own.slice(0, 8),
    ...own.slice(8 + PROBE_PROC.own.length),
  ])
  for (const [proc, runtime, uid, gid] of [
    [PROBE_PROC.empty, "/usr/bin/node", 1001, 1002],
    [PROBE_PROC.empty, `${ROOT}/runtime/deno`, 1001, 1002],
    [PROBE_PROC.empty, `${CONTROL}/runtime/bun`, 1001, 1002],
    [PROBE_PROC.empty, `${ROOT}/runtime/bun`, 0, 1002],
    [PROBE_PROC.empty, `${ROOT}/runtime/bun`, 1001, 1.5],
    [PROBE_PROC.empty, `${ROOT}/runtime/bun`, -1, 1002],
    [PROBE_PROC.empty, `${ROOT}/runtime/bun`, 1001, NaN],
    [[...PROBE_PROC.empty], `${ROOT}/runtime/bun`, 1001, 1002],
    [["--proc", "/proc"], `${ROOT}/runtime/bun`, 1001, 1002],
    [[], `${ROOT}/runtime/bun`, 1001, 1002],
  ] as const)
    expect(() => probeArguments(proc, runtime, uid, gid)).toThrow()
  const failure = (fields: Record<string, unknown>) => Object.assign(new Error("Command failed: private"), fields)
  expect(probeExit(undefined)).toBe("zero")
  expect(probeExit(failure({ code: 134, killed: false, signal: null }))).toBe("abort")
  // 128 + n for every Linux signal 1-64, real-time signals (glibc SIGRTMIN 34 to SIGRTMAX 64) included.
  for (const code of [129, 133, 139, 159, 160, 162, 192])
    expect(probeExit(failure({ code, killed: false, signal: null }))).toBe("signal")
  for (const code of [1, 125, 127, 128, 193, 255])
    expect(probeExit(failure({ code, killed: false, signal: null }))).toBe("other")
  const accessor = new Error("placeholder")
  Object.defineProperty(accessor, "code", {
    get() {
      throw new Error("accessor called")
    },
  })
  for (const value of [
    failure({ code: 134, killed: true, signal: null }),
    failure({ code: null, killed: false, signal: "SIGKILL" }),
    failure({ code: null, killed: true, signal: "SIGTERM" }),
    failure({ code: "ENOENT" }),
    failure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
    failure({ code: 0 }),
    failure({ code: 256 }),
    failure({ code: 134.5 }),
    failure({}),
    new Error("Native Shell fixture contract refused"),
    accessor,
    { code: 134 },
    "134",
    null,
  ])
    expect(probeExit(value)).toBe("error")
  // Both builders return members, in the vocabulary's own order.
  const built: string[] = [
    ...PROBE_EXITS.flatMap((empty) => PROBE_EXITS.map((own) => probeStage(empty, own))),
    ...PROBE_EXITS.map(probeNodeStage),
  ]
  expect(built).toEqual([...SHELL_STAGES.probe])
  expect(probeStage("abort", "zero")).toBe("probe-empty-abort-own-zero")
  expect(probeNodeStage("abort")).toBe("probe-node-abort")
})
