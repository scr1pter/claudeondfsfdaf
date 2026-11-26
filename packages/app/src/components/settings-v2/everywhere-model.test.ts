import { describe, expect, test } from "bun:test"
import path from "node:path"
import type { GlobalSession, ProjectTrustStatus } from "@vectordevai/sdk/v2/client"
import type { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { COMPUTER_CAPS } from "@vectordevai/schema/everywhere"
import type { RemoteStatus } from "@/context/platform"
import {
  CLOSED_LID,
  CONTINUE_FAILED,
  CONTINUE_NOTE,
  HOW_JOBS_RUN,
  JOB_RUNNING,
  JOB_UNCONFIRMED,
  OWN_SESSION_LIMITS,
  PAGE_DESCRIPTION,
  PUSH_RULE,
  REPOSITORY_RULE,
  RULE_KEYS,
  VERSION_NOTE,
  checksLine,
  continuationState,
  continueEverywhereJob,
  everywhereJobs,
  everywhereOffered,
  everywhereTab,
  everywhereView,
  folderTrustLine,
  howJobsRun,
  jobsLine,
  jobsPage,
  openWorktree,
} from "./everywhere-model"
import { filterSettingsGroups, isSettingsTab, settingsGroups } from "./settings-registry"

test("Continue requires a successful scoped status snapshot even before the first live event", () => {
  const job = "ses_everywhere"
  expect(continuationState(undefined, job, false)).toBe("unavailable")
  expect(continuationState([], job, false)).toBe("unavailable")
  expect(continuationState({ [job]: null }, job, false)).toBe("unavailable")
  expect(continuationState({ [job]: { type: "busy" } }, job, false)).toBe("running")
  expect(continuationState({ [job]: { type: "retry" } }, job, false)).toBe("running")
  expect(continuationState({ [job]: { type: "idle" } }, job, true)).toBe("running")
  expect(continuationState({ [job]: { type: "idle" } }, job, false)).toBe("ready")
  expect(continuationState({ ses_other: { type: "busy" } }, job, false)).toBe("ready")
})

describe("continueEverywhereJob", () => {
  // A fake Engine: `statuses` answers the scoped status read (an Error rejects it), `created` answers the create.
  const run = async (input: {
    statuses?: unknown
    created?: string | Error
    working?: boolean[]
    current?: boolean[]
  }) => {
    const calls: string[] = []
    const working = [...(input.working ?? [])]
    const current = [...(input.current ?? [])]
    await continueEverywhereJob({
      job: "ses_job",
      working: () => working.shift() ?? false,
      current: () => current.shift() ?? true,
      status: async () => {
        calls.push("status")
        if (input.statuses instanceof Error) throw input.statuses
        return input.statuses
      },
      create: async () => {
        calls.push("create")
        if (input.created instanceof Error) throw input.created
        return input.created
      },
      open: (id) => calls.push(`open ${id}`),
      problem: (text) => calls.push(`problem ${text}`),
    })
    return calls
  }

  test("a live busy job is refused without asking the Engine", async () => {
    expect(await run({ working: [true], statuses: {}, created: "ses_new" })).toEqual([`problem ${JOB_RUNNING}`])
  })

  test("creates and opens a session only after the snapshot shows the job finished", async () => {
    expect(await run({ statuses: {}, created: "ses_new" })).toEqual(["status", "create", "open ses_new"])
    expect(await run({ statuses: { ses_job: { type: "idle" } }, created: "ses_new" })).toEqual([
      "status",
      "create",
      "open ses_new",
    ])
  })

  test("a busy, retrying or unreadable snapshot creates nothing", async () => {
    expect(await run({ statuses: { ses_job: { type: "busy" } }, created: "ses_new" })).toEqual([
      "status",
      `problem ${JOB_RUNNING}`,
    ])
    expect(await run({ statuses: { ses_job: { type: "retry" } }, created: "ses_new" })).toEqual([
      "status",
      `problem ${JOB_RUNNING}`,
    ])
    expect(await run({ statuses: undefined, created: "ses_new" })).toEqual(["status", `problem ${JOB_UNCONFIRMED}`])
    expect(await run({ statuses: new Error("offline"), created: "ses_new" })).toEqual([
      "status",
      `problem ${JOB_UNCONFIRMED}`,
    ])
  })

  test("a live busy event that lands while the snapshot is read still refuses", async () => {
    expect(await run({ working: [false, true], statuses: {}, created: "ses_new" })).toEqual([
      "status",
      `problem ${JOB_RUNNING}`,
    ])
  })

  test("after a server change nothing is created, reported or opened", async () => {
    expect(await run({ current: [false], statuses: {}, created: "ses_new" })).toEqual(["status"])
    expect(await run({ current: [true, false], statuses: {}, created: "ses_new" })).toEqual(["status", "create"])
    expect(await run({ current: [true, false], statuses: {}, created: new Error("gone") })).toEqual([
      "status",
      "create",
    ])
  })

  test("a create that fails or returns no session says so", async () => {
    expect(await run({ statuses: {}, created: undefined })).toEqual(["status", "create", `problem ${CONTINUE_FAILED}`])
    expect(await run({ statuses: {}, created: new Error("refused") })).toEqual([
      "status",
      "create",
      `problem ${CONTINUE_FAILED}`,
    ])
  })
})

// VE-41 (EV-21): Settings → Vector everywhere, read-only (EV-21, "Ruling on (a)"). Jobs are off by default, a folder
// is listed only when the person's own settings file lists it, a limit outside the runner's caps makes the block off,
// a block that says off reads off, and the tab shows only on the desktop, for a plan that offers it or a computer
// whose own engine already has it on.

// The same shapes as remote-model.test.ts's fixtures, copied so this file registers none of that file's tests.
const status = (fields: Partial<ModelPlanStatus.Status>) =>
  ({ signedIn: true, enabled: true, active: true, ...fields }) as unknown as ModelPlanStatus.Status
const remote = (fields: Partial<RemoteStatus> = {}): RemoteStatus => ({
  enabled: false,
  state: "off",
  phones: [],
  limit: 5,
  viewers: 0,
  pairing: { state: "idle" },
  ...fields,
})
const offeredStatus = status({ listed: ["remote", "everywhere"], entitlements: { remote: { computers: 1 } } })
const ready = (everywhere?: unknown, locked: string[] = []) =>
  everywhereView({ locked, ...(everywhere === undefined ? {} : { everywhere }) })
const PHONE = { device: "d", name: "iPhone", pairedAt: 1, connected: true, watching: false }
const JID = "vej_0000000000abcdefghjkmn"

describe("defaults", () => {
  test("a config that has not loaded is loading, not locked, and shows no settings", () => {
    const view = everywhereView(undefined)
    expect(view).toMatchObject({ state: "loading", written: false, enabled: false, locked: false, invalid: false })
    expect(jobsLine({ view })).toEqual({ text: "Reading this computer's settings…", problem: false })
    expect(howJobsRun(view)).toBeUndefined()
  })

  test("a config that could not be read says so and shows no settings", () => {
    const view = everywhereView(undefined, true)
    expect(view.state).toBe("failed")
    expect(jobsLine({ view })).toEqual({ text: "Vector could not read this computer's settings.", problem: true })
    expect(howJobsRun(view)).toBeUndefined()
  })

  test("everything is off with no block, an empty block or unrelated settings", () => {
    for (const config of [
      { locked: [] },
      { locked: [], everywhere: {} },
      { locked: [], model: "anthropic/claude", permission: { edit: "allow" } },
    ]) {
      const view = everywhereView(config)
      expect(view).toEqual({
        state: "ready",
        written: false,
        locked: false,
        invalid: false,
        enabled: false,
        rulesLocked: false,
        maxUsd: COMPUTER_CAPS.maxUsd.default,
        minutes: COMPUTER_CAPS.minutes.default,
        atOnce: COMPUTER_CAPS.atOnce.default,
        perDay: COMPUTER_CAPS.perDay.default,
        model: undefined,
        waitForComputer: true,
        push: true,
        stayAwake: false,
        projects: [],
      })
      expect(jobsLine({ view, remote: remote({ enabled: true, state: "online" }) })).toEqual({
        text: "This computer takes no jobs.",
        problem: false,
      })
    }
  })
})

describe("a lock or a block that does not decode is off", () => {
  test("a company lock keeps a written block off, and a loaded answer with no lock list counts as locked", () => {
    const view = ready({ enabled: true }, ["everywhere"])
    expect(view).toMatchObject({ written: true, enabled: false, locked: true })
    const unlisted = everywhereView({ everywhere: { enabled: true } })
    expect(unlisted).toMatchObject({ state: "ready", written: true, enabled: false, locked: true })
    for (const locked of [view, unlisted]) {
      expect(jobsLine({ view: locked }).problem).toBe(true)
      expect(howJobsRun(locked)).toBeUndefined()
    }
  })

  test("an unknown or out-of-range sub-key makes the block invalid and off", () => {
    for (const block of [{ enabled: true, pushh: false }, { enabled: true, minutes: 500 }, "on"]) {
      const view = ready(block)
      expect(view).toMatchObject({ invalid: true, enabled: false })
      expect(jobsLine({ view })).toMatchObject({ problem: true })
      expect(howJobsRun(view)).toBeUndefined()
    }
    expect(ready({ enabled: true, pushh: false }).written).toBe(true)
  })

  test("a lock on a key that carries permission rules says jobs run no commands", () => {
    for (const key of RULE_KEYS) {
      expect(ready({ enabled: true }, [key]).rulesLocked).toBe(true)
      expect(checksLine({ view: ready({ enabled: true }, [key]), os: "linux", shell: "offline-v1" })).toContain(
        "run no commands",
      )
    }
    expect(
      checksLine({ view: ready({ enabled: true }, ["share", "model"]), os: "linux", shell: "offline-v1" }),
    ).toBeUndefined()
    expect(checksLine({ view: ready({ enabled: true }), os: "macos" })).toContain("run no commands")
    expect(checksLine({ view: ready({ enabled: true }), os: "windows" })).toContain("run no commands")
  })

  test("the rule keys are the desktop runner's own list", async () => {
    // The app cannot import desktop main, so its copy is compared with the runner's source.
    const source = await Bun.file(
      path.resolve(import.meta.dir, "../../../../desktop/src/main/everywhere-wiring.ts"),
    ).text()
    const list = source.match(/const RULE_KEYS = \[([^\]]*)\]/)?.[1]
    expect(list).toBeDefined()
    expect([...(list ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1])).toEqual([...RULE_KEYS])
  })

  test("on Linux the line follows the engine's sandbox probe, and says nothing only for offline-v1", () => {
    const on = ready({ enabled: true })
    expect(checksLine({ view: on, os: "linux", shell: "offline-v1" })).toBeUndefined()
    expect(checksLine({ view: on, os: "linux", shell: "none" })).toBe(
      "On this computer jobs can edit files but run no commands: their offline sandbox needs bubblewrap (the bwrap command), and it did not start here.",
    )
    // Not read yet, or not readable: the page does not imply that commands run.
    expect(checksLine({ view: on, os: "linux" })).toContain(
      "Where it does not start, they edit files but run no commands",
    )
    // macOS and Windows have no offline sandbox, whatever the probe says.
    expect(checksLine({ view: on, os: "macos", shell: "offline-v1" })).toContain("run no commands")
  })
})

describe("the tab", () => {
  const off = { locked: [] }
  const on = { locked: [], everywhere: { enabled: true } }

  test("is hidden without the perk and shown when the plan offers it", () => {
    expect(everywhereTab({ desktop: true, server: true, builtin: true, offered: false, config: off })).toBe(false)
    expect(everywhereTab({ desktop: true, server: true, builtin: true, offered: false, config: undefined })).toBe(false)
    expect(everywhereTab({ desktop: true, server: true, builtin: true, offered: true, config: off })).toBe(true)
    // Offered while Settings points at another server: shown, and the page asks for this computer's own engine.
    expect(everywhereTab({ desktop: true, server: true, builtin: false, offered: true, config: off })).toBe(true)
  })

  test("stays shown, not offered, while this computer's own engine has it on, so the page shows that it is on", () => {
    expect(everywhereTab({ desktop: true, server: true, builtin: true, offered: false, config: on })).toBe(true)
    // Locked or not decodable, the user's own block still says on, so the page can explain why it is off.
    expect(
      everywhereTab({
        desktop: true,
        server: true,
        builtin: true,
        offered: false,
        config: { ...on, locked: ["everywhere"] },
      }),
    ).toBe(true)
  })

  test("another server's settings never count, even when the selected server is this computer's", () => {
    // The hook passes whether ServerSync's own server is built in, not useServer().current.
    expect(everywhereTab({ desktop: true, server: true, builtin: false, offered: false, config: on })).toBe(false)
  })

  test("is never shown without a server to read, as in a test page that mounts Settings bare", () => {
    expect(everywhereTab({ desktop: true, server: false, builtin: true, offered: true, config: on })).toBe(false)
    expect(everywhereTab({ desktop: true, server: false, builtin: false, offered: true, config: undefined })).toBe(
      false,
    )
  })

  test("is never shown on the web", () => {
    expect(everywhereTab({ desktop: false, server: true, builtin: true, offered: true, config: on })).toBe(false)
    expect(everywhereTab({ desktop: false, server: true, builtin: false, offered: false, config: on })).toBe(false)
  })

  test("is offered only while the perk and the Remote it needs are listed and the plan includes Remote", () => {
    expect(everywhereOffered(offeredStatus)).toBe(true)
    // An account with no plan still sees the perk listed, but has no Remote entitlement.
    expect(everywhereOffered(status({ listed: ["remote", "everywhere"] }))).toBe(false)
    expect(everywhereOffered(status({ listed: ["remote"], entitlements: { remote: { computers: 1 } } }))).toBe(false)
    expect(everywhereOffered(status({ listed: ["everywhere"], entitlements: { remote: { computers: 1 } } }))).toBe(
      false,
    )
    expect(
      everywhereOffered(
        status({ signedIn: false, listed: ["remote", "everywhere"], entitlements: { remote: { computers: 1 } } }),
      ),
    ).toBe(false)
    expect(
      everywhereOffered(
        status({ error: "x", listed: ["remote", "everywhere"], entitlements: { remote: { computers: 1 } } }),
      ),
    ).toBe(false)
    expect(everywhereOffered(undefined)).toBe(false)
  })
})

describe("allowed repositories", () => {
  test("only the everywhere block lists folders, and nothing is listed by default", () => {
    expect(
      everywhereView({ locked: [], projects: [{ directory: "/home/me/one", repository: "me/one" }] }).projects,
    ).toEqual([])
    expect(ready({ enabled: true }).projects).toEqual([])
    expect(ready({ projects: [{ directory: "/home/me/one", repository: "me/one" }] }).projects).toEqual([
      { directory: "/home/me/one", repository: "me/one" },
    ])
  })
})

describe("how jobs run", () => {
  const rows = (values: string[]) => [
    { label: "US dollars per job", value: values[0] },
    { label: "Minutes per job", value: values[1] },
    { label: "Jobs at once", value: values[2] },
    { label: "Jobs a day", value: values[3] },
    { label: "Model", value: values[4] },
    { label: "Wait for my computer", value: values[5] },
    { label: "Push the branch and open a draft pull request", value: values[6], note: PUSH_RULE },
    { label: "Stay awake to take jobs while plugged in", value: values[7], note: CLOSED_LID },
  ]

  test("shows the defaults for a block that sets nothing, whether jobs are on or off", () => {
    const defaults = rows(["2.00", "45", "1", "20", "Your default model", "On", "On", "Off"])
    for (const block of [undefined, {}, { enabled: false }, { enabled: true }])
      expect(howJobsRun(ready(block))).toEqual(defaults)
  })

  test("shows a saved block as saved", () => {
    const saved = ready({
      enabled: true,
      max_usd: 7.5,
      minutes: 30,
      at_once: 2,
      per_day: 5,
      model: "anthropic/claude-x",
      wait_for_computer: false,
      push: false,
      stay_awake: true,
    })
    expect(howJobsRun(saved)).toEqual(rows(["7.50", "30", "2", "5", "anthropic/claude-x", "Off", "Off", "On"]))
  })

  test("a limit at the runner's cap shows as saved, and one past it makes the block off and shows nothing", () => {
    const capped = {
      max_usd: COMPUTER_CAPS.maxUsd.max,
      minutes: COMPUTER_CAPS.minutes.max,
      at_once: COMPUTER_CAPS.atOnce.max,
      per_day: COMPUTER_CAPS.perDay.max,
    }
    expect(howJobsRun(ready(capped))?.slice(0, 4)).toEqual(rows(["50.00", "120", "3", "100"]).slice(0, 4))
    expect(howJobsRun(ready({ max_usd: 0.01 }))?.[0]).toEqual({ label: "US dollars per job", value: "0.01" })
    for (const [key, value] of Object.entries(capped)) {
      const over = ready({ enabled: true, [key]: key === "max_usd" ? value + 0.01 : value + 1 })
      expect(over).toMatchObject({ invalid: true, enabled: false })
      expect(howJobsRun(over)).toBeUndefined()
    }
    expect(howJobsRun(ready({ minutes: 0 }))).toBeUndefined()
  })

  test("shows nothing while a company lock keeps jobs off", () => {
    expect(howJobsRun(ready({ enabled: true, minutes: 30 }, ["everywhere"]))).toBeUndefined()
    expect(howJobsRun(everywhereView({ everywhere: { enabled: true } }))).toBeUndefined()
    // A lock on another key leaves the settings shown.
    expect(howJobsRun(ready({ enabled: true }, ["share"]))).toHaveLength(8)
  })
})

describe("turning jobs off", () => {
  const on = {
    locked: [],
    everywhere: { enabled: true, projects: [{ directory: "/home/me/one", repository: "me/one" }] },
  }

  test("once the settings file says off, the page reads off and the tab goes away while not offered", () => {
    expect(everywhereView(on)).toMatchObject({ enabled: true, written: true })
    expect(everywhereTab({ desktop: true, server: true, builtin: true, offered: false, config: on })).toBe(true)
    const saved = { ...on, everywhere: { ...on.everywhere, enabled: false } }
    expect(everywhereView(saved)).toMatchObject({ enabled: false, written: false })
    expect(jobsLine({ view: everywhereView(saved), remote: remote({ enabled: true, state: "online" }) })).toEqual({
      text: "This computer takes no jobs.",
      problem: false,
    })
    expect(everywhereTab({ desktop: true, server: true, builtin: true, offered: false, config: saved })).toBe(false)
  })
})

describe("a listed folder's trust", () => {
  const status = (fields: Partial<ProjectTrustStatus>): ProjectTrustStatus => ({
    workspace: "/home/me/one",
    trusted: false,
    ignored: true,
    settings: false,
    approvable: true,
    ...fields,
  })

  test("a folder that is not open is not read, and its jobs wait", () => {
    expect(folderTrustLine({ kind: "closed" }, "one")).toEqual({
      text: "Not open in Vector. Its jobs wait until you open it and trust it.",
      problem: true,
      canTrust: false,
    })
    expect(folderTrustLine({ kind: "reading" }, "one")).toMatchObject({ problem: false, canTrust: false })
    expect(folderTrustLine({ kind: "read" }, "one")).toMatchObject({ problem: true, canTrust: false })
  })

  test("a folder without settings of its own is offered trust too, since nothing else asks about it", () => {
    const line = folderTrustLine({ kind: "read", status: status({ settings: false }) }, "one")
    expect(line).toMatchObject({ text: "Not trusted, so its jobs wait until you trust it.", problem: true })
    expect(line.canTrust).toBe(true)
    expect(line.detail).toContain("one has no Vector settings of its own")
    expect(folderTrustLine({ kind: "read", status: status({ settings: true }) }, "one").canTrust).toBe(true)
  })

  test("a listed folder is open when its path is an open project's, compared as the app compares project paths", () => {
    expect(openWorktree("/home/me/one", ["/home/me/two", "/home/me/one"])).toBe("/home/me/one")
    // The picker's Windows spelling against the engine's: the trust read uses the engine's.
    expect(openWorktree("C:\\work\\repo", ["C:/work/repo"])).toBe("C:/work/repo")
    expect(openWorktree("C:/work/repo", ["C:\\work\\repo\\"])).toBe("C:\\work\\repo\\")
    // Case is kept, so a different case reads as not open, and nothing is read for it.
    expect(openWorktree("C:\\Work\\Repo", ["c:/work/repo"])).toBeUndefined()
    expect(openWorktree("/home/me/one", ["/home/me/one/sub", "/home/me"])).toBeUndefined()
  })

  test("a trusted folder is fine, and trust is offered only where the engine would take the approval", () => {
    expect(folderTrustLine({ kind: "read", status: status({ trusted: true, ignored: false }) }, "one")).toEqual({
      text: "Trusted.",
      problem: false,
      canTrust: false,
    })
    // Not the owner, or settings off with --pure: the jobs still wait, with nothing to press.
    expect(folderTrustLine({ kind: "read", status: status({ approvable: false }) }, "one")).toMatchObject({
      problem: true,
      canTrust: false,
    })
    expect(folderTrustLine({ kind: "read", status: status({ ignored: false, settings: true }) }, "one")).toMatchObject({
      problem: true,
      canTrust: false,
    })
  })
})

describe("this computer's jobs", () => {
  const session = (id: string, updated: number, metadata?: Record<string, unknown>) =>
    ({
      id,
      title: `Slack: job ${id}`,
      directory: `/data/everywhere-worktree/p/${id}`,
      time: { created: 1, updated },
      ...(metadata ? { metadata } : {}),
    }) as unknown as GlobalSession
  const mark = (fields: Record<string, unknown>) => ({ "vector.unattended": fields })

  test("lists only sessions the runner marked, with their platform's name, newest first", () => {
    const jobs = everywhereJobs([
      session("ses_a", 10, mark({ by: "everywhere", jid: JID, platform: "slack" })),
      session("ses_b", 30, mark({ by: "everywhere", jid: JID, platform: "linear" })),
      session("ses_c", 20),
      session("ses_d", 40, { other: true }),
      session("ses_e", 50, mark({ by: "someone", jid: JID, platform: "slack" })),
      session("ses_f", 60, mark({ by: "everywhere", jid: "nope", platform: "slack" })),
      session("ses_g", 70, mark({ by: "everywhere", jid: JID, platform: "teams" })),
      session("ses_h", 80, { "vector.unattended": "everywhere" }),
    ])
    expect(jobs.map((job) => [job.id, job.platformName])).toEqual([
      ["ses_b", "Linear"],
      ["ses_a", "Slack"],
    ])
    expect(jobs[0]).toMatchObject({ jid: JID, platform: "linear", directory: "/data/everywhere-worktree/p/ses_b" })
  })

  test("keeps at most twenty, and a continued session's title at most 100 characters", () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      session(`ses_${index}`, index, mark({ by: "everywhere", jid: JID, platform: "jira" })),
    )
    const jobs = everywhereJobs(many)
    expect(jobs).toHaveLength(20)
    expect(jobs[0]!.id).toBe("ses_24")
    const long = everywhereJobs([
      { ...session("ses_x", 1, mark({ by: "everywhere", jid: JID, platform: "slack" })), title: "x".repeat(300) },
    ])
    expect(long[0]!.continueTitle).toHaveLength(100)
    expect(long[0]!.continueTitle.startsWith("Continue: ")).toBe(true)
  })
})

describe("what the page says", () => {
  const on = ready({ enabled: true })

  test("about jobs on this computer, most pressing first", () => {
    // Nothing is said about Remote until its state is read, so Remote that is on is never reported off.
    expect(jobsLine({ view: on, remote: "loading" })).toEqual({
      text: "Reading Vector Remote on this computer…",
      problem: false,
    })
    expect(jobsLine({ view: on, localOn: true, remote: remote({ enabled: true, state: "online" }) })).toEqual({
      text: "Vector Local is on, so this computer takes no jobs.",
      problem: true,
    })
    expect(jobsLine({ view: on, remote: remote() })).toEqual({
      text: "Jobs need Vector Remote, which is off on this computer.",
      problem: true,
    })
    expect(jobsLine({ view: on, remote: remote({ enabled: true, state: "paused" }) })).toEqual({
      text: "Your Vector Codium plan is paused, so Remote is off until its payment goes through.",
      problem: true,
    })
    expect(jobsLine({ view: on, remote: remote({ enabled: true, state: "online" }) })).toEqual({
      text: "Connected for jobs. No phone is paired, and none is needed for jobs.",
      problem: false,
    })
    expect(jobsLine({ view: on, remote: remote({ enabled: true, state: "online", phones: [PHONE] }) })).toEqual({
      text: "Jobs can reach this computer.",
      problem: false,
    })
    expect(jobsLine({ view: on, remote: remote({ enabled: true, state: "connecting" }) }).problem).toBe(false)
  })

  test("a closed lid sleeps the computer, and a job waits only with Wait for my computer, for at most about two hours", () => {
    expect(CLOSED_LID).toContain("closed lid puts this computer to sleep")
    expect(CLOSED_LID).toContain("only if Wait for my computer is on")
    expect(CLOSED_LID).toContain("at most about two hours")
  })

  test("a job's own session keeps the engine's limits, and the new session is the way out", () => {
    for (const phrase of [
      "run only offline and inside the job's folder",
      "the job's permission rules stay",
      "nothing personal about you",
      "free models that may train on prompts stay refused",
      "subagents cannot run in task isolation",
      "Continue in a new session on this branch starts an ordinary session in the job's folder",
    ])
      expect(OWN_SESSION_LIMITS).toContain(phrase)
    expect(CONTINUE_NOTE).toContain("Vector keeps the folder untrusted")
    // Continue is for a finished job; while one runs the page says so in its place.
    expect(CONTINUE_NOTE).toContain("only once it has finished")
    expect(JOB_RUNNING).toContain("once it has finished")
    // Trust does not hold the folder's own instruction files: the new session reads them from its first message.
    expect(CONTINUE_NOTE).toContain("still reads its AGENTS.md and other instruction files")
  })

  test("copy is plain: no price, token, claim or the word project", () => {
    for (const text of [
      PAGE_DESCRIPTION,
      HOW_JOBS_RUN,
      CLOSED_LID,
      OWN_SESSION_LIMITS,
      CONTINUE_NOTE,
      JOB_RUNNING,
      JOB_UNCONFIRMED,
      CONTINUE_FAILED,
      VERSION_NOTE,
      REPOSITORY_RULE,
      PUSH_RULE,
      folderTrustLine({ kind: "closed" }, "one").text,
      checksLine({ view: ready(), os: "linux" })!,
      checksLine({ view: ready(), os: "linux", shell: "none" })!,
      ...(howJobsRun(ready()) ?? []).flatMap((row) => [row.label, row.value, row.note ?? ""]),
    ]) {
      expect(text).not.toMatch(/\$|token|project/i)
    }
    expect(REPOSITORY_RULE).toContain("open in Vector and you trust it")
    expect(PUSH_RULE).toContain("private repository only")
    // The page writes nothing (EV-21, "Ruling on (a)") and shows the settings read-only under How jobs run, so it
    // says exactly that and points at no control.
    expect(PAGE_DESCRIPTION).toBe(
      "Jobs started from a chat or an issue run on this computer, each in its own copy of a repository you allow. Jobs are off unless this computer's settings file turns them on. This page shows those settings and changes none of them.",
    )
    expect(HOW_JOBS_RUN).toBe(
      "From this computer's settings file. A job stops at its own limit for dollars or minutes when that is lower.",
    )
    expect(REPOSITORY_RULE).toContain("Nothing is listed by default.")
  })

  test("the jobs page on vectordev.ai is linked only while the plan offers the perk", () => {
    expect(jobsPage(true)).toBe("https://vectordev.ai/everywhere")
    expect(jobsPage(false)).toBeUndefined()
  })
})

describe("Settings search", () => {
  test("finds the page by what people call it, right after Vector Local", () => {
    for (const query of ["Vector everywhere", "slack", "linear", "jira", "this computer takes jobs"])
      expect(filterSettingsGroups(query).flatMap((group) => group.items.map((item) => item.value))).toEqual([
        "everywhere",
      ])
    expect(isSettingsTab("everywhere")).toBe(true)
    const personal = settingsGroups[0]!.items.map((item) => item.value)
    expect(personal.indexOf("everywhere")).toBe(personal.indexOf("local") + 1)
  })
})
