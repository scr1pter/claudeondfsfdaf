import { spawn, type ChildProcess } from "node:child_process"
import { readdir, stat, unlink } from "node:fs/promises"
import path from "node:path"
import {
  BINARIES,
  DISPLAY,
  DISPLAY_UID,
  RECORDER_BYTES_MAX,
  RECORDER_FPS,
  RECORDER_SEGMENT_SECONDS,
  RECORDER_SEGMENTS_MAX,
  SCREEN,
  SCREENSHOT_MAX_WIDTH,
  X_GID,
  XAUTHORITY,
} from "./limits"

/*
 * The session recorder (contract WP A54): the screen at 2 frames a second in 1-minute segments, so a job's report can
 * show what happened (Done by Morning, WP A55: the daemon uploads a job's last ten segments as they finish; recordings
 * are kept 30 days and only the owner sees them).
 * It is off while the person holds control: nothing of a take-over is recorded. Segments sit on a memory disk with a
 * cap, so a recording never grows the computer's saved disk.
 */

export const SEGMENT = /^seg-(\d{5})\.ts$/

/** ffmpeg's arguments: x11grab at the recorder's rate, H.264 in 1-minute MPEG-TS segments numbered from `start`. */
export function recorderArgs(dir: string, start: number) {
  const width = Math.min(SCREENSHOT_MAX_WIDTH, SCREEN.width)
  return [
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-framerate",
    String(RECORDER_FPS),
    "-draw_mouse",
    "1",
    "-video_size",
    `${SCREEN.width}x${SCREEN.height}`,
    "-i",
    DISPLAY,
    "-vf",
    `scale=${width}:-2`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "32",
    "-pix_fmt",
    "yuv420p",
    "-force_key_frames",
    `expr:gte(t,n_forced*${RECORDER_SEGMENT_SECONDS})`,
    "-f",
    "segment",
    "-segment_time",
    String(RECORDER_SEGMENT_SECONDS),
    "-segment_format",
    "mpegts",
    "-reset_timestamps",
    "1",
    "-segment_start_number",
    String(start),
    path.join(dir, "seg-%05d.ts"),
  ]
}

export type Spawner = (file: string, args: string[], options: { uid?: number; gid?: number; env: Record<string, string> }) => ChildProcess

const realSpawn: Spawner = (file, args, options) =>
  spawn(file, args, {
    stdio: "ignore",
    env: { PATH: "/usr/bin:/bin", ...options.env },
    ...(options.uid !== undefined ? { uid: options.uid, gid: options.gid ?? options.uid } : {}),
  })

export class Recorder {
  private child: ChildProcess | undefined
  private next = 0
  /** Resolves once the last stopped ffmpeg exited (it closes its segment on the way out). */
  private exiting: Promise<void> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly options: { spawn?: Spawner; uid?: number | undefined } = {},
  ) {}

  running() {
    return this.child !== undefined
  }

  /** Starts recording (again), continuing the segment numbers so a take-over leaves a gap, never an overwrite. */
  async start() {
    if (this.child) return
    const existing = await this.segments()
    this.next = Math.max(this.next, existing.length ? existing[existing.length - 1]!.number + 1 : 0)
    const uid = "uid" in this.options ? this.options.uid : DISPLAY_UID
    // The display user, with the display-cookie group as its group (a child started this way keeps no other group).
    const child = (this.options.spawn ?? realSpawn)(BINARIES.ffmpeg, recorderArgs(this.dir, this.next), {
      env: { DISPLAY, XAUTHORITY },
      ...(uid !== undefined ? { uid, gid: X_GID } : {}),
    })
    this.child = child
    child.on("exit", () => {
      if (this.child === child) this.child = undefined
    })
    child.on("error", () => {
      if (this.child === child) this.child = undefined
    })
  }

  /** Stops recording; ffmpeg closes its current segment on SIGINT. */
  stop() {
    const child = this.child
    this.child = undefined
    if (!child) return
    this.exiting = new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
      child.once("error", () => resolve())
      const give = setTimeout(resolve, 4_000)
      give.unref?.()
    })
    child.kill("SIGINT")
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000)
    timer.unref?.()
    // Whatever segment was being written ends here; the next start begins a new one.
    this.next++
  }

  /** Resolves once a stopped recorder closed its last segment (at most about 4 seconds), at once if none was running. */
  settled() {
    return this.exiting
  }

  /** The segments on disk, oldest first. */
  async segments() {
    const names = await readdir(this.dir).catch(() => [] as string[])
    const found: { name: string; number: number; bytes: number }[] = []
    for (const name of names) {
      const match = SEGMENT.exec(name)
      if (!match) continue
      const info = await stat(path.join(this.dir, name)).catch(() => undefined)
      if (info?.isFile()) found.push({ name, number: Number(match[1]), bytes: info.size })
    }
    return found.sort((a, b) => a.number - b.number)
  }

  /** Drops the oldest finished segments beyond the count and size caps; the segment being written is kept. */
  async prune() {
    const segments = await this.segments()
    const writing = this.child ? segments[segments.length - 1]?.name : undefined
    let total = segments.reduce((sum, segment) => sum + segment.bytes, 0)
    let count = segments.length
    let removed = 0
    for (const segment of segments) {
      if (count <= RECORDER_SEGMENTS_MAX && total <= RECORDER_BYTES_MAX) break
      if (segment.name === writing) break
      await unlink(path.join(this.dir, segment.name)).catch(() => {})
      total -= segment.bytes
      count--
      removed++
    }
    return removed
  }
}
