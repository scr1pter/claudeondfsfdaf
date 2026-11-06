import { Hosted } from "@vectordevai/schema/hosted"
import { WRAP_SLACK_MS } from "./limits"
import type { Report } from "./run-api"

/*
 * hostd's session loop (contract WP A54, WP A53's heartbeat). Every 30 seconds, and at once after anything worth
 * telling, hostd reports to Vector and does what the answer says:
 * - the first answers carry the job: hostd starts the agent (and the browser, when the plan's trust ramp allows it, and
 *   the recorder), then reports `booted`;
 * - `control: "person"` (a take-over): every agent process is paused and the recorder stops; back to "agent", both
 *   resume;
 * - `wrapping` with `wrapBy`: the agent is asked to finish (SIGTERM) and ended shortly before `wrapBy`;
 * - `browser: false`: the browser is closed (and not opened);
 * - `pack` and `upload`: the agent's work is packed for the person's download link and uploaded;
 * - `recording` (a Done by Morning job, WP A55): finished recording segments are reported and uploaded to the signed
 *   links the next answers carry, as the job runs, so the report keeps the last minutes even if the session ends
 *   abruptly; when the job ends, the last segments are flushed before `done` (for at most `RECORDING_FLUSH_MS`);
 * - `stopping` or `ended`, or a refusal that means the session is over: everything stops.
 * When the job ends, for whatever reason, the browser is stopped and its profile wiped, the recorder stopped, and `done`
 * reported. Nothing here holds a credential.
 */

/** How long the end of a job waits for its last recording segments to upload before it reports `done`. */
export const RECORDING_FLUSH_MS = 60_000

export type Job = { prompt: string; title?: string }

export interface AgentControl {
  start(job: Job): Promise<void>
  running(): boolean
  /** Pauses every agent process (SIGSTOP), or lets them run again. */
  pause(): Promise<void>
  resume(): Promise<void>
  /** Asks the agent to finish (SIGTERM to its process group). */
  ask(): void
  /** Ends every agent process (SIGKILL). */
  kill(): Promise<void>
  onExit(listener: () => void): void
}

export interface BrowserControl {
  start(): Promise<void>
  stop(): Promise<void>
  running(): boolean
  pageLoads(): number
}

export interface RecorderControl {
  start(): Promise<void>
  stop(): void
  running(): boolean
}

/** The recorder's finished segments and their upload (WP A55). */
export interface RecordingControl {
  /** The segments on disk, oldest first, with their files. */
  segments(): Promise<{ number: number; bytes: number; file: string }[]>
  /** Resolves once a stopped recorder closed its last segment. */
  settled(): Promise<void>
  upload(link: NonNullable<Hosted.HeartbeatAnswer["recording"]>["uploads"][number], file: string): Promise<void>
}

export type DaemonDeps = {
  session: string
  generation: number
  api: { heartbeat(report: Report): Promise<Hosted.HeartbeatAnswer> }
  upload: (link: NonNullable<Hosted.HeartbeatAnswer["upload"]>, file: string) => Promise<void>
  agent: AgentControl
  browser: BrowserControl
  recorder: RecorderControl
  /** Uploads a job's recording when the server asks for it (WP A55); without it nothing is uploaded. */
  recording?: RecordingControl
  wipe: () => Promise<void>
  /** Writes what the viewer proxy needs (session, key, who has control). */
  viewer: (state: { session: string; key: string; control: "agent" | "person" }) => Promise<void>
  /** Packs the agent's work; answers the file and its size. */
  pack: () => Promise<{ file: string; bytes: number }>
  discard: (file: string) => Promise<void>
  metrics: { cpu(): number | undefined; egressBytes(): Promise<number | undefined> }
  clock?: () => number
  schedule?: (ms: number, run: () => void) => { cancel(): void }
  log?: (line: string) => void
}

/** HTTP statuses after which the session is over for this computer (ended, revoked, not found). */
const FINAL = new Set([401, 403, 404, 409])

export class Daemon {
  private booted = false
  private done = false
  private finishing: Promise<void> | undefined
  private control: "agent" | "person" = "agent"
  private browserAllowed = false
  private wrapping = false
  private wrapTimer: { cancel(): void } | undefined
  private activeAt: number | undefined
  private handoff: Hosted.Handoff | undefined
  private archive: { file: string; bytes: number } | undefined
  private packing = false
  private uploading = false
  private uploaded = false
  private ticking: Promise<Hosted.HeartbeatAnswer | undefined> | undefined
  private again = false
  /** The server keeps this session's recording (a Done by Morning job). */
  private recordingWanted = false
  /** Recording segments uploaded, by number. */
  private readonly segmentsUploaded = new Set<number>()
  private segmentsUploading = false
  private readonly clock: () => number
  private readonly schedule: (ms: number, run: () => void) => { cancel(): void }

  constructor(private readonly deps: DaemonDeps) {
    this.clock = deps.clock ?? Date.now
    this.schedule =
      deps.schedule ??
      ((ms, run) => {
        const timer = setTimeout(run, ms)
        return { cancel: () => clearTimeout(timer) }
      })
    deps.agent.onExit(() => void this.finish("agent finished"))
  }

  /** The agent did something (a computer action, a tool call, output). */
  touch(at = this.clock()) {
    this.activeAt = Math.max(this.activeAt ?? 0, at)
  }

  /** The guard or the agent handed the computer to the person; reported until the person takes over. */
  handOff(reason: Hosted.Handoff) {
    this.handoff = reason
    void this.tick()
  }

  /** Whether the agent may act now (not paused for the person, not finished). */
  acting() {
    return this.booted && !this.done && this.control === "agent"
  }

  status() {
    return { booted: this.booted, done: this.done, control: this.control, wrapping: this.wrapping, browser: this.browserAllowed }
  }

  private async report(): Promise<Report> {
    const egress = await this.deps.metrics.egressBytes().catch(() => undefined)
    const cpu = this.deps.metrics.cpu()
    return {
      ...(cpu !== undefined ? { cpu } : {}),
      ...(this.activeAt !== undefined ? { activeAt: this.activeAt } : {}),
      pageLoads: this.deps.browser.pageLoads(),
      ...(egress !== undefined ? { egressBytes: egress } : {}),
      ...(this.booted ? { booted: true } : {}),
      ...(this.done ? { done: true } : {}),
      ...(this.archive ? { archiveBytes: this.archive.bytes } : {}),
      ...(this.uploaded ? { uploaded: true } : {}),
      generation: this.deps.generation,
      ...(this.handoff ? { handoff: this.handoff } : {}),
      ...(await this.recordingReport()),
    }
  }

  /**
   * The recording part of a report, once the server asked for this session's recording: finished segments among the
   * last `RECORDING_SEGMENTS` not uploaded yet (the oldest few), and the ones uploaded.
   */
  private async recordingReport(): Promise<Pick<Report, "segments" | "uploadedSegments">> {
    if (!this.recordingWanted || !this.deps.recording) return {}
    const all = await this.deps.recording.segments().catch(() => [])
    // The segment being written is not finished.
    const finished = (this.deps.recorder.running() ? all.slice(0, -1) : all).slice(-Hosted.RECORDING_SEGMENTS)
    const segments = finished
      .filter(
        (segment) =>
          !this.segmentsUploaded.has(segment.number) && segment.bytes > 0 && segment.bytes <= Hosted.RECORDING_SEGMENT_MAX_BYTES,
      )
      .slice(0, Hosted.RECORDING_REPORT_MAX)
      .map((segment) => ({ n: segment.number, bytes: segment.bytes }))
    const uploaded = [...this.segmentsUploaded].sort((a, b) => a - b).slice(-Hosted.RECORDING_SEGMENTS)
    return { ...(segments.length ? { segments } : {}), ...(uploaded.length ? { uploadedSegments: uploaded } : {}) }
  }

  /** PUTs each segment the answer signed a link for; a failed one is reported again and gets a new link. */
  private async uploadSegments(uploads: NonNullable<Hosted.HeartbeatAnswer["recording"]>["uploads"]) {
    const recording = this.deps.recording
    if (!recording || this.segmentsUploading || !uploads.length) return false
    this.segmentsUploading = true
    let any = false
    try {
      const files = new Map((await recording.segments()).map((segment) => [segment.number, segment]))
      for (const link of uploads) {
        const segment = files.get(link.n)
        if (!segment || this.segmentsUploaded.has(link.n)) continue
        try {
          await recording.upload(link, segment.file)
          this.segmentsUploaded.add(link.n)
          any = true
        } catch {
          this.deps.log?.(`uploading recording segment ${link.n} failed`)
        }
      }
    } finally {
      this.segmentsUploading = false
    }
    return any
  }

  /**
   * At the end of a job whose recording the server keeps: waits for the recorder to close its last segment, then reports
   * and uploads the segments not yet uploaded, for at most `RECORDING_FLUSH_MS`, before `done` is reported.
   */
  private async flushRecording() {
    const recording = this.deps.recording
    if (!recording || !this.recordingWanted) return
    await recording.settled().catch(() => {})
    const until = this.clock() + RECORDING_FLUSH_MS
    for (let round = 0; round < 4 && this.clock() < until; round++) {
      const report = await this.report()
      if (!report.segments?.length) return
      let answer: Hosted.HeartbeatAnswer
      try {
        answer = await this.deps.api.heartbeat(report)
      } catch {
        return
      }
      if (answer.state === "ended" || answer.state === "stopping" || !answer.recording?.uploads.length) return
      await this.uploadSegments(answer.recording.uploads)
    }
  }

  /** One heartbeat (calls that arrive during one run it once more afterwards). */
  tick(): Promise<Hosted.HeartbeatAnswer | undefined> {
    if (this.ticking) {
      this.again = true
      return this.ticking
    }
    this.ticking = (async () => {
      let answer: Hosted.HeartbeatAnswer | undefined
      do {
        this.again = false
        try {
          answer = await this.deps.api.heartbeat(await this.report())
          await this.apply(answer)
        } catch (error) {
          const status = (error as { status?: number }).status
          this.deps.log?.(`heartbeat failed${status ? ` (${status})` : ""}`)
          if (status !== undefined && FINAL.has(status)) await this.finish("session over")
          answer = undefined
        }
      } while (this.again)
      return answer
    })().finally(() => {
      this.ticking = undefined
    })
    return this.ticking
  }

  private async apply(answer: Hosted.HeartbeatAnswer) {
    await this.deps.viewer({ session: this.deps.session, key: answer.viewerKey, control: answer.control }).catch(() => {})
    if (answer.state === "ended" || answer.state === "stopping") return this.finish("session over")
    this.browserAllowed = answer.browser === true
    if (answer.recording && this.deps.recording) {
      const first = !this.recordingWanted
      this.recordingWanted = true
      if (answer.recording.uploads.length && !this.finishing)
        void this.uploadSegments(answer.recording.uploads).then((uploaded) => {
          if (uploaded) void this.tick()
        })
      else if (first && !this.finishing) this.again = true
    }

    if (answer.job && !this.booted && !this.done) {
      this.booted = true
      this.touch()
      await this.deps.agent.start(answer.job)
      if (this.browserAllowed) await this.deps.browser.start().catch(() => this.deps.log?.("browser did not start"))
      if (answer.control === "agent") await this.deps.recorder.start().catch(() => {})
      this.again = true
    }

    if (answer.control !== this.control) {
      this.control = answer.control
      if (answer.control === "person") {
        // A take-over: nothing of the agent runs and nothing is recorded until the person hands back.
        this.handoff = undefined
        this.deps.recorder.stop()
        await this.deps.agent.pause()
      } else if (!this.done) {
        await this.deps.agent.resume()
        if (this.booted) await this.deps.recorder.start().catch(() => {})
      }
    }

    if (!this.browserAllowed && this.deps.browser.running()) await this.deps.browser.stop()
    else if (this.browserAllowed && this.booted && !this.done && !this.deps.browser.running())
      await this.deps.browser.start().catch(() => {})

    if (answer.state === "wrapping" && answer.wrapBy !== undefined && !this.wrapping && !this.done) {
      this.wrapping = true
      this.deps.agent.ask()
      const end = Math.max(0, answer.wrapBy - WRAP_SLACK_MS - this.clock())
      this.wrapTimer = this.schedule(end, () => void this.finish("wrap-up time"))
    }

    if (answer.pack && !this.archive && !this.packing) {
      this.packing = true
      void this.deps
        .pack()
        .then((archive) => {
          this.archive = archive
          this.uploaded = false
          void this.tick()
        })
        .catch(() => this.deps.log?.("packing the files failed"))
        .finally(() => {
          this.packing = false
        })
    }
    if (answer.upload && this.archive && !this.uploaded && !this.uploading) {
      this.uploading = true
      const archive = this.archive
      void this.deps
        .upload(answer.upload, archive.file)
        .then(() => {
          this.uploaded = true
          void this.tick()
        })
        .catch(() => this.deps.log?.("uploading the files failed"))
        .finally(() => {
          this.uploading = false
        })
    } else if (this.uploaded && this.archive && !answer.upload && !answer.pack) {
      // The server checked the upload and stopped asking: the packed copy is no longer needed.
      const file = this.archive.file
      this.archive = undefined
      this.uploaded = false
      await this.deps.discard(file).catch(() => {})
    }
  }

  /**
   * Ends the job: the agent, the browser (profile wiped), the recorder, the last recording segments (unless the session
   * is already over); then reports `done`. Runs once.
   */
  finish(why: string): Promise<void> {
    this.finishing ??= (async () => {
      this.deps.log?.(`finishing: ${why}`)
      this.wrapTimer?.cancel()
      this.deps.recorder.stop()
      await this.deps.agent.kill().catch(() => {})
      await this.deps.browser.stop().catch(() => {})
      await this.deps.wipe().catch(() => this.deps.log?.("profile wipe failed"))
      if (why !== "session over") await this.flushRecording().catch(() => {})
      this.done = true
      void this.tick()
    })()
    return this.finishing
  }
}
