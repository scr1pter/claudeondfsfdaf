import { expect, test } from "bun:test"
import path from "node:path"
import { LinuxIsolation } from "@vectordevai/core/process-isolation/linux"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { CONTROL, ROOT, TEMP, WORKSPACE, assets, cell, controllerAction } from "./common"
import {
  FAILURE_PREFIX,
  OBSERVER_OPERATIONS,
  OBSERVER_PREFIX,
  RUN_ERRNOS,
  RUN_OPERATIONS,
  RUN_REFUSALS,
  RUN_SYSCALLS,
  SHELL_STAGES,
  observerStage,
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
  const roles = ["host", "observer", "driver", "engine", "run"] as const
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
    engine: null,
    engineCase: null,
    control: null,
  }
  expect(shellFailure(empty)).toBe(
    FAILURE_PREFIX +
      '{"v":1,"host":"host-controls","case":null,"operation":"controls","observer":"observer-controls-agent",' +
      '"driver":null,"run":null,"driverExit":null,"engine":null,"engineCase":null,"control":null}\n',
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
})
