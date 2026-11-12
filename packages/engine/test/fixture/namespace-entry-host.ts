import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import timers from "node:timers"
import { setTimeout } from "node:timers/promises"

// Host observation is deliberately outside the engine's empty proc and precedes the final UID sweep.
const execute = promisify(execFile)
const containers = ["/mnt/vector-agent-sandbox", "/var/lib/vector-agent-sandbox", "/home/vector-agent-sandbox"]
type Identity = { pid: number; start: string; uid: number; group: number; state: string; namespacePids: number[] }
type Round = {
  index: number
  mode: "normal" | "delay" | "wait"
  leader: Identity
  spawned: Identity[]
  ready?: Identity[]
  payload?: { host: Identity; identity: Record<string, unknown> }
  result?: { code: number | null; signal: string | null; escalated: boolean; readySeen: boolean }
  stoppedBeforeUidSweep?: boolean
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
}

async function jsonFile(file: string, owner: number) {
  const opened = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await opened.stat()
    requireValue(
      info.isFile() && info.uid === owner && info.nlink === 1 && !(info.mode & 0o022) && info.size <= 65_536,
      "Invalid bounded host metadata",
    )
    const value: unknown = JSON.parse(await opened.readFile("utf8"))
    requireValue(record(value), "Invalid host metadata object")
    return value
  } finally {
    await opened.close()
  }
}

function reportPath() {
  requireValue(
    process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP),
    "Missing disposable runner directory",
  )
  return path.join(process.env.RUNNER_TEMP, "vector-probe-tools", "namespace-host.json")
}

async function identity(pid: number, expectedUid: number): Promise<Identity | undefined> {
  try {
    const [stat, status] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, "utf8"),
      fs.readFile(`/proc/${pid}/status`, "utf8"),
    ])
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)
    const users = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status)
    if (!users || !fields[19] || !/^[0-9]+$/.test(fields[19])) {
      // proc files may return an empty read when an unrelated task exits after open. Do not hide malformed live data.
      const present = await fs.lstat(`/proc/${pid}`).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ESRCH") return
        throw error
      })
      requireValue(present === undefined, "Invalid live host process identity")
      return
    }
    if (!users.slice(1).some((user) => Number(user) === expectedUid)) return
    requireValue(
      users.slice(1).every((user) => Number(user) === expectedUid),
      "An agent process has mixed user credentials",
    )
    const namespacePids = /^NSpid:[ \t]+([0-9 \t]+)$/m.exec(status)?.[1].trim().split(/\s+/).map(Number) ?? []
    const value = {
      pid,
      start: fields[19],
      uid: Number(users[1]),
      group: Number(fields[2]),
      state: fields[0],
      namespacePids,
    }
    requireValue(Number.isSafeInteger(value.group) && value.group >= 0, "Invalid host process group")
    return value
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH")) return
    throw error
  }
}

async function correlatePayload(group: Identity[], value: unknown, namespaces: unknown, uid: number, gid: number) {
  requireValue(
    record(value) && value.uid === 1000 && value.gid === 1000 && record(namespaces),
    "Missing nested payload identity",
  )
  requireValue(
    JSON.stringify(value.uidMap) === "[1000,0,1]" &&
      JSON.stringify(value.gidMap) === "[1000,0,1]" &&
      integer(value.privatePid) &&
      value.privatePid > 0 &&
      integer(value.userNamespace) &&
      value.userNamespace > 0 &&
      integer(value.pidNamespace) &&
      value.pidNamespace > 0 &&
      value.userNamespace !== namespaces.user &&
      value.pidNamespace !== namespaces.pid,
    "The payload did not enter the narrower per-command namespace",
  )
  const matches: Identity[] = []
  for (const member of group) {
    if (member.namespacePids.at(-1) !== value.privatePid) continue
    const actual = await execute(
      "/usr/bin/sudo",
      [
        "-n",
        "/usr/bin/python3",
        "-I",
        "-S",
        "/opt/vector-namespace-entry.py",
        "observe",
        String(member.pid),
        member.start,
      ],
      {
        timeout: 5000,
        maxBuffer: 1024,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      },
    )
    const observed: unknown = JSON.parse(actual.stdout)
    requireValue(
      record(observed) &&
        observed.pid === member.pid &&
        observed.start === member.start &&
        observed.uid === uid &&
        observed.gid === gid &&
        observed.pgrp === member.group &&
        observed.state !== "Z",
      "The root payload observation has a different host identity",
    )
    if (observed.userNamespace === value.userNamespace && observed.pidNamespace === value.pidNamespace) {
      requireValue(
        JSON.stringify(observed.uidMap) === JSON.stringify([1000, uid, 1]) &&
          JSON.stringify(observed.gidMap) === JSON.stringify([1000, gid, 1]) &&
          Array.isArray(observed.nspid) &&
          observed.nspid.at(-1) === value.privatePid,
        "The root-observed payload map does not preserve the exact disposable host identity",
      )
      const latest = await identity(member.pid, uid)
      requireValue(latest && same(member, latest), "The observed payload process changed identity")
      matches.push(latest)
    }
  }
  requireValue(matches.length === 1, "The host could not identify the exact live namespace payload")
  return { host: matches[0], identity: value }
}

async function snapshot(uid: number) {
  const values = await Promise.all(
    (await fs.readdir("/proc")).filter((name) => /^[1-9][0-9]*$/.test(name)).map((name) => identity(Number(name), uid)),
  )
  return values
    .filter((value): value is Identity => value !== undefined && value.uid === uid && value.state !== "Z")
    .sort((a, b) => a.pid - b.pid)
}

function same(a: Identity, b: Identity) {
  return a.pid === b.pid && a.start === b.start && a.uid === b.uid
}

function assertBaseline(current: Identity[], baseline: Identity[]) {
  requireValue(
    baseline.every((before) => current.some((after) => same(before, after))),
    "The engine or namespace keeper disappeared during host observation",
  )
}

async function acknowledge(observer: string, index: number, phase: "baseline" | "spawned" | "ready" | "stopped") {
  const file = `${observer}/${index}-${phase}.ack`
  const existing = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return
    throw error
  })
  requireValue(existing === undefined, "A host acknowledgement already exists")
  await execute("/usr/bin/sudo", ["-n", "/usr/bin/touch", "--", file], {
    timeout: 5000,
    maxBuffer: 1024,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  })
  const info = await fs.lstat(file)
  requireValue(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.uid === 0 &&
      info.size === 0 &&
      info.nlink === 1 &&
      !(info.mode & 0o022),
    "The trusted host acknowledgement is not immutable to the agent",
  )
}

async function stopped(uid: number, baseline: Identity[]) {
  const deadline = Date.now() + 5000
  while (true) {
    const current = await snapshot(uid)
    assertBaseline(current, baseline)
    const survivors = current.filter((after) => !baseline.some((before) => same(before, after)))
    if (survivors.length === 0) return
    requireValue(Date.now() < deadline, "A namespace-launch descendant survived before the final UID sweep")
    await setTimeout(10)
  }
}

async function main() {
  requireValue(process.platform === "linux", "The host namespace observer is Linux-only")
  const spec = await jsonFile("/opt/vector-namespace-entry.json", 0)
  requireValue(
    spec.v === 1 && typeof spec.container === "string" && containers.includes(spec.container),
    "Invalid prototype scope",
  )
  requireValue(integer(spec.uid) && spec.uid > 0 && integer(spec.gid) && spec.gid > 0, "Invalid disposable identity")
  requireValue(spec.observer === spec.container + "/namespace-observer", "Unexpected observer directory")
  requireValue(
    record(spec.keeper) && integer(spec.keeper.pid) && typeof spec.keeper.start === "string",
    "Missing keeper identity",
  )
  const observer = spec.observer
  const uid = spec.uid
  const gid = spec.gid
  const keeper = { pid: spec.keeper.pid, start: spec.keeper.start }
  const directory = await fs.lstat(observer)
  requireValue(
    directory.isDirectory() && directory.uid === 0 && !(directory.mode & 0o022),
    "Mutable observer directory",
  )
  requireValue((await fs.readdir(observer)).length === 0, "The observer directory contains stale acknowledgements")
  const rounds: Round[] = []
  let baseline: Identity[] | undefined
  let current: Round | undefined
  let summary = false
  let protocolError: Error | undefined
  let pending = ""
  let stderrBytes = 0
  let stderr = ""
  let queue = Promise.resolve()
  const child = spawn(
    "/usr/local/bin/vector",
    ["github", "sandbox", "run", "--", "node", "/opt/vector-namespace-entry-engine.mjs"],
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
  void ended.catch(() => {})
  let escalation: ReturnType<typeof timers.setTimeout> | undefined
  const deadline = timers.setTimeout(() => {
    protocolError ??= new Error("The bounded host namespace experiment did not complete")
    child.kill("SIGTERM")
    escalation = timers.setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    }, 1000)
  }, 90_000)
  const handle = async (line: string) => {
    const value: unknown = JSON.parse(line)
    requireValue(record(value) && value.v === 1, "Invalid namespace engine protocol")
    if (value.event === "namespace-engine-ready") {
      requireValue(
        !baseline && !current && !rounds.length && integer(value.pid) && value.pid > 1,
        "The engine repeated or forged readiness",
      )
      requireValue(
        value.privateHolder === true && value.emptyProc === true && value.loaderRejected === true,
        "The engine did not prove its private-channel prerequisites",
      )
      baseline = await snapshot(uid)
      requireValue(
        baseline.some((entry) => entry.pid === value.pid) &&
          baseline.some((entry) => entry.pid === keeper.pid && entry.start === keeper.start),
        "Host observation did not find the live engine and exact keeper",
      )
      requireValue(
        record(value.proof) && typeof value.proof.device === "string" && typeof value.proof.inode === "string",
        "The engine did not identify its actual proof descriptor",
      )
      // Compare metadata only. Neither observer nor entry fixture reads the private proof file's contents.
      const proof = await fs.lstat(path.join(process.env.RUNNER_TEMP!, "vector-sandbox", "session-proof.json"), {
        bigint: true,
      })
      requireValue(
        proof.isFile() && proof.uid === BigInt(process.getuid!()) && proof.nlink === 1n && !(proof.mode & 0o077n),
        "The actual sandbox proof file has the wrong owner or permissions",
      )
      const observed = await execute(
        "/usr/bin/sudo",
        ["-n", "/usr/bin/stat", "-L", "--printf=%d:%i", "--", `/proc/${value.pid}/fd/3`],
        {
          timeout: 5000,
          maxBuffer: 1024,
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        },
      )
      requireValue(
        observed.stdout === `${proof.dev}:${proof.ino}` &&
          value.proof.device === String(proof.dev) &&
          value.proof.inode === String(proof.ino),
        "The engine FD3 is not the actual sandbox proof descriptor",
      )
      await acknowledge(observer, 0, "baseline")
      return
    }
    requireValue(baseline && !summary, "The engine emitted an event outside the bounded experiment")
    if (value.event === "namespace-launch") {
      requireValue(
        integer(value.index) && value.index === rounds.length && value.index < 9 && integer(value.pid) && value.pid > 1,
        "The engine launch sequence is invalid",
      )
      const mode = value.index === 0 ? "normal" : value.index <= 4 ? "delay" : "wait"
      requireValue(value.mode === mode, "The engine changed a fixed cancellation case")
      const processes = await snapshot(uid)
      assertBaseline(processes, baseline)
      const leader = processes.find((entry) => entry.pid === value.pid)
      requireValue(
        leader && leader.group === leader.pid && !baseline.some((entry) => same(entry, leader)),
        "The host did not observe a new live disposable process-group leader",
      )
      const group = processes.filter((entry) => entry.group === leader.group)
      requireValue(
        processes.every((entry) => baseline!.some((before) => same(before, entry)) || entry.group === leader.group),
        "An unaccounted disposable process escaped the launch group",
      )
      if (value.phase === "spawned") {
        requireValue(!current, "A previous namespace launch has not stopped")
        current = { index: value.index, mode, leader, spawned: group }
        await acknowledge(observer, value.index, "spawned")
        return
      }
      requireValue(
        value.phase === "ready" && mode === "wait" && current && !current.ready && same(current.leader, leader),
        "The payload readiness sequence is invalid",
      )
      current.ready = group
      current.payload = await correlatePayload(group, value.identity, spec.namespaces, uid, gid)
      await acknowledge(observer, value.index, "ready")
      return
    }
    if (value.event === "namespace-complete") {
      requireValue(
        current && value.index === current.index && value.pid === current.leader.pid && value.mode === current.mode,
        "An unrelated launch reported completion",
      )
      requireValue(
        (value.code === null || integer(value.code)) &&
          (value.signal === null || typeof value.signal === "string") &&
          typeof value.escalated === "boolean" &&
          typeof value.readySeen === "boolean",
        "Invalid launcher exit observation",
      )
      if (current.mode === "normal") {
        requireValue(
          value.outcome === "normal" &&
            value.code === 0 &&
            value.signal === null &&
            value.readySeen === true &&
            value.escalated === false,
          "The positive namespace control did not complete",
        )
      } else {
        requireValue(
          value.outcome === "cancelled" &&
            (value.signal === "SIGTERM" || value.signal === "SIGKILL" || value.code === 143 || value.code === 137),
          "The launch did not end through observed cancellation",
        )
        requireValue(
          current.mode === "wait" ? current.ready && value.readySeen : !current.ready && !value.readySeen,
          "Cancellation did not occur at its fixed readiness phase",
        )
      }
      await stopped(uid, baseline)
      current.result = {
        code: value.code,
        signal: value.signal,
        escalated: value.escalated,
        readySeen: value.readySeen,
      }
      current.stoppedBeforeUidSweep = true
      const index = current.index
      rounds.push(current)
      current = undefined
      await acknowledge(observer, index, "stopped")
      return
    }
    requireValue(
      value.event === "namespace-engine-summary" &&
        !current &&
        rounds.length === 9 &&
        value.rounds === 9 &&
        value.prototypeOnly === true &&
        value.engineReadOnlyQualified === false &&
        value.privateHolder === true &&
        value.emptyProc === true &&
        value.loaderRejected === true &&
        value.positive === true &&
        value.earlyCancellations === 4 &&
        value.readyCancellations === 4,
      "The fixed engine experiment was incomplete",
    )
    await stopped(uid, baseline)
    summary = true
  }
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength
    if (stderr.length < 2400) stderr += chunk.toString("utf8").slice(0, 2400 - stderr.length)
    if (stderrBytes > 65_536) {
      protocolError ??= new Error("The sandbox emitted excessive fixed-probe diagnostics")
      child.kill("SIGTERM")
    }
  })
  child.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8")
    if (pending.length > 32_768) {
      protocolError ??= new Error("The sandbox exceeded its bounded protocol")
      child.kill("SIGTERM")
      return
    }
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n")
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      queue = queue
        .then(() => handle(line))
        .catch((error) => {
          protocolError ??= new Error(
            error instanceof Error && !(error instanceof SyntaxError)
              ? error.message
              : "The host refused a namespace-entry observation",
          )
          child.kill("SIGTERM")
        })
    }
  })
  try {
    const exit = await ended
    await queue
    if (protocolError) throw protocolError
    requireValue(
      pending === "" && summary && baseline && rounds.length === 9 && exit.code === 0 && exit.signal === null,
      `The host namespace experiment failed; no containment qualification is claimed: ${stderr}`,
    )
    const report = {
      v: 1,
      prototypeOnly: true,
      engineReadOnlyQualified: false,
      actualToolSeamsQualified: false,
      container: spec.container,
      uid,
      baseline,
      rounds,
      privateHolder: true,
      emptyEngineProc: true,
      loaderRejected: true,
      allGroupsStoppedBeforeUidSweep: true,
      normal: 1,
      earlyCancellations: 4,
      readyCancellations: 4,
    }
    await fs.writeFile(reportPath(), JSON.stringify(report), { mode: 0o600, flag: "wx" })
    console.log(
      JSON.stringify({
        event: "namespace-host-result",
        v: 1,
        prototypeOnly: true,
        normal: 1,
        earlyCancellations: 4,
        readyCancellations: 4,
        allGroupsStoppedBeforeUidSweep: true,
        engineReadOnlyQualified: false,
        actualToolSeamsQualified: false,
      }),
    )
  } finally {
    timers.clearTimeout(deadline)
    timers.clearTimeout(escalation)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  }
}

async function finalAssertion() {
  requireValue(
    process.env.PROBE_NAMESPACE_CLEANUP_OUTCOME === "success" &&
      process.env.PROBE_FINISH_OUTCOME === "success" &&
      process.env.PROBE_AGENT_OUTCOME === "success",
    "The prototype or trusted cleanup did not complete",
  )
  const report = await jsonFile(reportPath(), process.getuid!())
  requireValue(
    report.v === 1 &&
      report.prototypeOnly === true &&
      report.engineReadOnlyQualified === false &&
      report.actualToolSeamsQualified === false &&
      report.privateHolder === true &&
      report.emptyEngineProc === true &&
      report.loaderRejected === true &&
      report.allGroupsStoppedBeforeUidSweep === true &&
      report.normal === 1 &&
      report.earlyCancellations === 4 &&
      report.readyCancellations === 4 &&
      Array.isArray(report.rounds) &&
      report.rounds.length === 9,
    "The host report does not prove this bounded prototype",
  )
  requireValue(
    typeof report.container === "string" &&
      containers.includes(report.container) &&
      integer(report.uid) &&
      report.uid > 0,
    "The host report refers to an unrelated sandbox",
  )
  requireValue(
    report.rounds.every(
      (value, index) =>
        record(value) &&
        value.index === index &&
        value.stoppedBeforeUidSweep === true &&
        record(value.result) &&
        (index === 0
          ? value.mode === "normal" && value.result.code === 0
          : index <= 4
            ? value.mode === "delay"
            : value.mode === "wait" &&
              record(value.payload) &&
              record(value.payload.host) &&
              value.payload.host.uid === report.uid),
    ),
    "The host report lacks an independently stopped cancellation round",
  )
  const container = await fs.lstat(report.container).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return
    throw error
  })
  requireValue(
    container === undefined && (await snapshot(report.uid)).length === 0,
    "The disposable sandbox or a live agent process remains after trusted cleanup",
  )
  console.log(
    "Namespace-entry prototype passed its bounded host observations; production floor and engine read-only qualification remain pending.",
  )
}

if (process.argv.slice(2).join(" ") === "--module-load-check") {
  console.log("Namespace host fixture modules loaded")
} else if (process.argv.slice(2).join(" ") === "--assert") {
  await finalAssertion()
} else {
  requireValue(process.argv.length === 2, "Unexpected namespace host invocation")
  await main()
}
