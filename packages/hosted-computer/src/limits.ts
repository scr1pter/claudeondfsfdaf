/*
 * The cloud computer's fixed layout (contract WP A54): who runs what, where things live and how much they may use.
 * boot.sh, the Dockerfile and image/nftables.conf repeat these numbers; test/image.test.ts checks they agree.
 *
 * Users, each with one job, so no process holds more than it needs (S7):
 * - root            boot.sh and hostd: the firewall, mounts, starting and pausing everything else, git's mirror.
 * - agent  10001    the agent and everything it runs. No sudo, no setuid binary on the disk, no new privileges, no
 *                   access to the display, the VNC socket, the browser's debugging pipe or any GitHub token.
 * - viewer 10002    the viewer proxy, the only process listening on the network (Hosted.VIEWER_PORT).
 * - git    10003    git's network steps, in mirrors only hostd writes, with a token that lives for one operation.
 * - browser 10004   Chromium, under its managed policy, with its profile on a memory disk wiped after every job.
 * - display 10005   the virtual display, its VNC server (a Unix socket only the viewer can reach) and the recorder.
 */

export const AGENT_UID = 10001
export const VIEWER_UID = 10002
export const GIT_UID = 10003
export const BROWSER_UID = 10004
export const DISPLAY_UID = 10005
/** Agent and browser: the downloads folder in the agent's work. */
export const SHARE_GID = 10010
/** Browser and display: the display's access cookie. */
export const X_GID = 10011

/** The agent's disk: a 10 GB filesystem of its own (a sparse, loop-mounted file), the only place it can write. */
export const DATA_PATH = "/data"
export const WORK_DIR = "/data/work"
export const AGENT_HOME = "/data/home"
export const DOWNLOADS_DIR = "/data/work/downloads"
/**
 * The data path's size. Decimal: with the base image held to `IMAGE_MAX_BYTES`, a computer's saved disk stays within
 * the 16 GB the nightly storage charge assumes (`HOSTED_DISK_GB_MAX` in api/_lib/hosted-rates.ts, WP A53).
 */
export const DATA_QUOTA_BYTES = 10_000_000_000
/** The most the base image may hold on disk (the bake refuses more). */
export const IMAGE_MAX_BYTES = 6_000_000_000

/** Everything that is not the agent's disk and may change at run time is on memory disks under here. */
export const RUN_DIR = "/run/vector"
export const HOSTD_SOCKET = "/run/vector/hostd/actions.sock"
export const VNC_SOCKET = "/run/vector/vnc/vnc.sock"
export const VIEWER_STATE = "/run/vector/viewer/state.json"
export const XAUTHORITY = "/run/vector/x/auth"
export const BROWSER_PROFILE = "/run/vector/browser/profile"
export const RECORDINGS_DIR = "/run/vector/rec"
export const LOG_DIR = "/run/vector/log"
/** Packed files on their way to the person's download link: root's, never the agent's quota, deleted after upload. */
export const PACK_DIR = "/var/lib/vector/pack"
/** git's mirrors, one bare repository per GitHub repository, owned by the git user. */
export const MIRROR_DIR = "/var/lib/vector/git"
/** The base image's installed parts and what boot.sh verifies them against. */
export const BASE_DIR = "/usr/lib/vector/base"
export const GENERATION_FILE = "/usr/lib/vector/GENERATION"

/** The virtual display. Screenshots are at most `SCREENSHOT_MAX_WIDTH` wide, so this one is never scaled. */
export const DISPLAY = ":1"
export const SCREEN = Object.freeze({ width: 1280, height: 800 })
export const SCREENSHOT_MAX_WIDTH = 1280

/** The recorder: frames a second and the length of one segment. Recording is off during a take-over. */
export const RECORDER_FPS = 2
export const RECORDER_SEGMENT_SECONDS = 60
/** Segments kept on the recordings memory disk before the oldest is dropped (12 hours, the longest job). */
export const RECORDER_SEGMENTS_MAX = 720
export const RECORDER_BYTES_MAX = 192 * 1024 * 1024

/** A wrap-up ends the agent this long before `wrapBy`, so the profile is wiped and `done` sent in time. */
export const WRAP_SLACK_MS = 20_000
/** A tool's command gets this long to exit after SIGTERM before it is killed. */
export const KILL_GRACE_MS = 3_000
/** Each git network step may take this long. */
export const GIT_STEP_MS = 10 * 60_000
/** The longest a GitHub token handed to git may live (one operation, then it is dropped). */
export const GIT_TOKEN_MAX_MS = 60 * 60_000

export const BINARIES = Object.freeze({
  setpriv: "/usr/bin/setpriv",
  xdotool: "/usr/bin/xdotool",
  ffmpeg: "/usr/bin/ffmpeg",
  chromium: "/usr/bin/chromium-browser",
  git: "/usr/bin/git",
  tar: "/usr/bin/tar",
  vector: "/usr/local/bin/vector",
  nft: "/usr/sbin/nft",
})
