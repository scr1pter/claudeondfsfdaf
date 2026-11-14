import { Computer } from "@vectordevai/schema/computer"
import { Hands } from "@vectordevai/schema/hands"
import { ComputerMainCopy } from "./main-copy"
import { ComputerOverlayLayout } from "./overlay-layout"

export * as ComputerOverlayPage from "./overlay-page"

// The glow, banner and agent cursor as self-contained pages for desktop main's overlay windows (section 1.5 D).
// Pages load no resources, carry one inline script and take plain view messages, never ComputerState: main builds
// the views with glowView and bannerView, so holder and queue titles, ask details and directories never reach an
// overlay. Every string a message carries is set with textContent or dataset. No `@/` imports: desktop main loads
// this file.

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"

/** `end` marks the Done or Stopped flash, after which a fade applies. */
export type GlowMessage = {
  type: "glow"
  variant: "working" | "background" | "dim"
  end: boolean
  reduceMotion: boolean
}

export type BannerButton = {
  action: Computer.OverlayAction
  label: string
  /** The ask this button answers. Stop never carries one. */
  requestID?: string
  /** Inert for LIMITS.askArmMs from when the page first shows this request. */
  arm?: boolean
  /** Ignores clicks the keyboard generates. */
  clickOnly?: boolean
  primary?: boolean
}

export type BannerMessage = {
  type: "banner"
  /** "end" is the Done or Stopped flash: the fixed sentence and the dot hide, so the banner never contradicts it. */
  tone: "working" | "ask" | "paused" | "end"
  line: string
  key: string
  waiting: string
  buttons: BannerButton[]
  reduceMotion: boolean
}

/** A click ring or the ghost cursor, at a point in the cursor window's own logical points. */
export type CursorMessage = {
  type: "cursor"
  kind: "ring" | "ghost" | "hide"
  x: number
  y: number
  reduceMotion: boolean
}

/**
 * Fades the page out over LIMITS.overlayFadeMs, but only when the last view the page applied was an end view: a
 * banner with tone "end", a glow with `end`, or a cursor "hide". Any other view shows the page again and makes a later
 * fade a no-op, so a late fade from a run that ended cannot hide the next run's overlay (INV-T1).
 */
export type FadeMessage = { type: "fade" }

export type OverlayMessage = GlowMessage | BannerMessage | CursorMessage | FadeMessage

/**
 * `window.computerOverlay`, the banner preload's API (section 2.9). `onState` delivers BannerMessage views. `act`
 * resolves false when main refuses the action; the page then lets the same request be answered again.
 */
export type OverlayApi = {
  onState(cb: (message: OverlayMessage) => void): void | (() => void)
  act(action: Computer.OverlayAction, requestID?: string): Promise<boolean>
  hover(on: boolean): void
}

export function glowStripPage(edge: ComputerOverlayLayout.Edge) {
  return page({
    root: `data-page="glow" data-edge="${edge}" data-variant="working"`,
    style: GLOW_STYLE + `.layer { inset: ${INSET[edge]}; }`,
    body: `<div class="glow" aria-hidden="true"><div class="breathe"><div class="layer"></div></div></div>`,
  })
}

export function bannerPage() {
  return page({
    root: `data-page="banner" data-tone="working"`,
    style: BANNER_STYLE,
    body: [
      `<div class="banner">`,
      `<span class="dot" aria-hidden="true"></span>`,
      `<div class="text">`,
      `<span class="title">${escape(Hands.BANNER)}</span>`,
      `<span class="line" role="status" aria-live="polite"></span>`,
      `</div>`,
      `<span class="waiting" hidden></span>`,
      `<kbd class="key" hidden></kbd>`,
      `<div class="buttons"></div>`,
      `</div>`,
    ].join(""),
  })
}

export function cursorPage() {
  return page({
    root: `data-page="cursor"`,
    style: CURSOR_STYLE,
    body: [
      `<div class="ring" aria-hidden="true"><i></i><i></i><i></i></div>`,
      `<div class="ghost" aria-hidden="true">`,
      `<svg class="arrow" viewBox="0 0 16 22" width="16" height="22"><path d="M1.5 1.5v16l4.2-4 2.9 6.6 2.6-1.1-2.8-6.4h6z" fill="#8b5cf6" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
      `<span class="tag">Vector</span>`,
      `</div>`,
    ].join(""),
  })
}

/** The glow: dimmed and still while paused or in a handoff, lighter and slower in background mode. */
export function glowView(state: Computer.ComputerState): GlowMessage | undefined {
  if (state.backend === "remote" || !TONE[state.phase]) return undefined
  return {
    type: "glow",
    variant:
      state.phase === "paused" || state.phase === "handoff"
        ? "dim"
        : state.mode === "background"
          ? "background"
          : "working",
    end: state.phase === "done" || state.phase === "stopped",
    reduceMotion: state.reduceMotion,
  }
}

/**
 * The banner, built only from Vector's own fields: phase, mode, backend, step, the pause, the secure-input app, the
 * app in use, the open ask's id, kind and title, the queue's length, the stop keys and reduced motion.
 */
export function bannerView(state: Computer.ComputerState): BannerMessage | undefined {
  const tone = TONE[state.phase]
  if (state.backend === "remote" || !tone) return undefined
  if (state.phase === "done" || state.phase === "stopped")
    return {
      type: "banner",
      tone: "end",
      line: ComputerMainCopy.bannerEnd({ reason: state.phase }),
      key: "",
      waiting: "",
      buttons: [],
      reduceMotion: state.reduceMotion,
    }
  const ask = state.phase === "asking" || state.phase === "handoff" || state.phase === "paused" ? state.ask : undefined
  return {
    type: "banner",
    tone: ask ? "ask" : tone,
    line: statusLine(state, ask),
    key: keyHint(state),
    waiting: state.queue.length ? ComputerMainCopy.queued({ count: state.queue.length }) : "",
    // Stop is in every active phase and is never bound to a request, armed or click-only (INV-R1).
    buttons: [...(ask ? ASK_BUTTONS[ask.kind](ask.requestID) : controls(state)), STOP],
    reduceMotion: state.reduceMotion,
  }
}

/** A script for `webContents.executeJavaScript` that hands `message` to the page as a same-window message. */
export function messageScript(message: OverlayMessage) {
  return `window.postMessage(${json(message)}, "*")`
}

/** Keep the glow's layout at its visible strip size when a native container is larger. */
export function glowSizeScript(size: Pick<ComputerOverlayLayout.Rect, "width" | "height">) {
  if (![size.width, size.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 1_000_000))
    throw new Error("The computer glow size is invalid.")
  return `(() => { const glow = document.querySelector(".glow"); if (!glow) return; glow.style.width = "${size.width}px"; glow.style.height = "${size.height}px"; glow.style.right = "auto"; glow.style.bottom = "auto"; })()`
}

/** A page as a data URL. Base64, because a `#` in a CSS colour would end a plain data URL. */
export function pageUrl(html: string) {
  const binary = Array.from(new TextEncoder().encode(html), (byte) => String.fromCharCode(byte)).join("")
  return `data:text/html;charset=utf-8;base64,${btoa(binary)}`
}

type Ask = NonNullable<Computer.ComputerState["ask"]>

const labels = ComputerMainCopy.labels

const TONE = {
  off: undefined,
  setup: undefined,
  ready: undefined,
  working: "working",
  waiting: "working",
  asking: "ask",
  handoff: "ask",
  paused: "paused",
  done: "end",
  stopped: "end",
} as const satisfies Record<Computer.ComputerPhase, BannerMessage["tone"] | undefined>

const STOP: BannerButton = { action: "stop", label: labels.stop }

// The banner never offers Always allow (INV-C4). Sensitive asks answer only to pointer clicks, as in the dock (D4).
const ASK_BUTTONS = {
  app: (requestID) => [
    { action: "deny", label: labels.deny, requestID },
    { action: "allow", label: labels.allow, requestID, arm: true, primary: true },
  ],
  sensitive: (requestID) => [
    { action: "deny", label: labels.deny, requestID, clickOnly: true },
    { action: "allow", label: labels.allowOnce, requestID, arm: true, clickOnly: true, primary: true },
  ],
  handoff: (requestID) => [{ action: "continue", label: labels.continue, requestID, primary: true }],
  check_in: (requestID) => [{ action: "keep-going", label: labels.keepGoing, requestID, primary: true }],
  pointer: (requestID) => [
    { action: "hand-over", label: labels.handOver, requestID, primary: true },
    { action: "not-now", label: labels.notNow, requestID },
  ],
} satisfies Record<Computer.AskKind, (requestID: string) => BannerButton[]>

function statusLine(state: Computer.ComputerState, ask: Ask | undefined) {
  if (ask) return ask.title || (ask.kind === "handoff" ? labels.yourTurn : labels.needsYou)
  if (state.phase === "handoff") return labels.yourTurn
  if (state.phase === "asking") return labels.needsYou
  if (state.phase === "paused")
    return state.pause ? ComputerMainCopy.pause({ reason: state.pause, app: state.secureInputHolder }) : labels.paused
  const app = state.apps.at(-1)?.name
  return state.step || (app ? ComputerMainCopy.working({ app }) : labels.working)
}

// Esc only while it stops Hands: the foreground working phase (INV-T7). Otherwise the chord, which works in every phase.
function keyHint(state: Computer.ComputerState) {
  const platform = state.backend === "local-windows" ? "windows" : "macos"
  if (state.escStops && state.phase === "working" && state.mode === "foreground")
    return ComputerMainCopy.chord(Hands.STOP_KEY, platform)
  const chord = state.stopChord || (platform === "windows" ? Hands.STOP_CHORD.win32 : Hands.STOP_CHORD.darwin)
  return ComputerMainCopy.chord(chord, platform)
}

// A pointer wait without its ask has no request to answer, so only Stop; the away pause's Resume reads Keep going.
function controls(state: Computer.ComputerState): BannerButton[] {
  if (state.phase === "paused") {
    if (state.pause === "pointer") return []
    return [{ action: "resume", label: state.pause === "away" ? labels.keepGoing : labels.resume, primary: true }]
  }
  if ((state.phase === "working" || state.phase === "waiting") && state.mode === "foreground")
    return [{ action: "takeover", label: labels.takeOver }]
  return []
}

function page(input: { root: string; style: string; body: string }) {
  return [
    `<!doctype html>`,
    `<html lang="en" ${input.root}>`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<style>${BASE_STYLE}\n${input.style}</style>`,
    `</head>`,
    `<body>${input.body}<script>${SCRIPT}</script></body>`,
    `</html>`,
  ].join("\n")
}

function escape(text: string) {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

// JSON that is also safe inside an inline script and a JavaScript string: no `<`, line or paragraph separators.
function json(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

const FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`

const BASE_STYLE = [
  `html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }`,
  `body { font: 500 13px/1.2 ${FONT}; -webkit-font-smoothing: antialiased; transition: opacity ${Computer.LIMITS.overlayFadeMs}ms ease-out; }`,
  `[data-out] body { opacity: 0; }`,
].join("\n")

// Each strip draws the screen's whole edge glow: the layer runs 400 px past the strip on the three sides that are not
// the screen's edge, so the inset shadows show only along that edge, and the corners match the neighbouring strips.
const INSET = {
  top: "0 0 -400px 0",
  right: "-400px 0 -400px -400px",
  bottom: "-400px 0 0 0",
  left: "-400px -400px -400px 0",
} satisfies Record<ComputerOverlayLayout.Edge, string>

// Only opacity animates. Dim wins over reduced motion: a paused run reads 38% whatever the motion setting.
const GLOW_STYLE = [
  `* { pointer-events: none; user-select: none; -webkit-user-select: none; }`,
  `.glow { position: fixed; inset: 0; overflow: hidden; opacity: 1; }`,
  `.breathe { position: absolute; inset: 0; animation: vector-breathe 2.8s ease-in-out infinite; }`,
  `.layer { position: absolute; box-shadow: inset 0 0 0 2px rgb(184 146 255 / 90%), inset 0 0 18px rgb(139 92 246 / 55%), inset 0 0 60px rgb(102 51 204 / 28%); }`,
  `@keyframes vector-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.72; } }`,
  `[data-variant="background"] .glow { opacity: 0.6; }`,
  `[data-variant="background"] .breathe { animation-duration: 4.2s; }`,
  `@media (prefers-reduced-motion: reduce) { .breathe { animation: none; opacity: 0.9; } }`,
  `[data-reduce-motion] .breathe { animation: none; opacity: 0.9; }`,
  `[data-variant="dim"] .glow { opacity: 0.38; }`,
  `[data-variant="dim"] .breathe { animation: none; opacity: 1; }`,
  ``,
].join("\n")

// The fixed sentence sits above the step in one column that takes the width the controls leave, so neither row can
// squeeze the other to nothing. A banner narrower than the full width drops the key hint and the waiting chip, so both
// rows keep room beside Deny, Allow once and Stop at the 420 px minimum; Stop is always there.
const BANNER_STYLE = [
  `.banner { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100vw; height: 40px; padding: 0 5px 0 14px; border: 1px solid rgb(139 92 246 / 70%); border-radius: 20px; background: rgb(18 13 29 / 92%); color: #f4f0ff; user-select: none; -webkit-user-select: none; }`,
  `.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: #b892ff; }`,
  `[data-tone="paused"] .dot { background: #9a93a8; }`,
  `.text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; justify-content: center; }`,
  `.title, .line { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`,
  `.title { font-weight: 600; line-height: 16px; }`,
  `.line { font-size: 12px; line-height: 15px; color: rgb(244 240 255 / 62%); }`,
  `[data-tone="end"] .dot, [data-tone="end"] .title { display: none; }`,
  `[data-tone="end"] .line { color: #f4f0ff; font-size: 13px; font-weight: 600; }`,
  `.waiting { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 8px; border-radius: 10px; background: rgb(139 92 246 / 28%); font-size: 12px; }`,
  `.key { flex: none; padding: 2px 6px; border: 1px solid rgb(255 255 255 / 22%); border-radius: 5px; font: inherit; font-size: 12px; color: rgb(244 240 255 / 78%); white-space: nowrap; }`,
  `@media (max-width: ${ComputerOverlayLayout.BANNER.max - 1}px) { .waiting, .key { display: none; } }`,
  `[hidden] { display: none !important; }`,
  `.buttons { flex: none; display: flex; gap: 6px; }`,
  `button { position: relative; overflow: hidden; height: 28px; padding: 0 12px; border: 1px solid rgb(255 255 255 / 18%); border-radius: 14px; background: rgb(255 255 255 / 8%); color: inherit; font: inherit; white-space: nowrap; cursor: default; }`,
  `button[data-tone="primary"] { background: rgb(255 255 255 / 16%); }`,
  `button[data-tone="stop"] { border-color: #a78bfa; background: #7c3aed; color: #fff; }`,
  `button:disabled { color: rgb(244 240 255 / 45%); }`,
  `button:focus-visible { outline: 2px solid #b892ff; outline-offset: 1px; }`,
  `button[data-arming]::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: #b892ff; animation: vector-arm var(--arm, ${Computer.LIMITS.askArmMs}ms) linear both; }`,
  `@keyframes vector-arm { from { opacity: 1; } to { opacity: 0; } }`,
  `@media (prefers-reduced-motion: reduce) { button[data-arming]::after { display: none; } }`,
  `[data-reduce-motion] button[data-arming]::after { display: none; }`,
].join("\n")

// The ripple is three still circles whose opacity runs in turn; with reduced motion one circle shows, still.
const CURSOR_STYLE = [
  `* { pointer-events: none; user-select: none; -webkit-user-select: none; }`,
  `.ring, .ghost { position: fixed; left: 0; top: 0; display: none; transform: translate(var(--x, 0px), var(--y, 0px)); }`,
  `[data-ring] .ring, [data-ghost] .ghost { display: block; }`,
  `.ring i { position: absolute; border: 2px solid #8b5cf6; border-radius: 50%; opacity: 0; animation: vector-ripple 500ms ease-out both; }`,
  `.ring i:nth-child(1) { left: -8px; top: -8px; width: 12px; height: 12px; }`,
  `.ring i:nth-child(2) { left: -16px; top: -16px; width: 28px; height: 28px; animation-delay: 100ms; }`,
  `.ring i:nth-child(3) { left: -24px; top: -24px; width: 44px; height: 44px; animation-delay: 200ms; }`,
  `@keyframes vector-ripple { 0% { opacity: 0; } 25% { opacity: 1; } 100% { opacity: 0; } }`,
  `.ghost { transition: transform 240ms ease-out; }`,
  `.arrow { display: block; }`,
  `.tag { position: absolute; left: 14px; top: 18px; padding: 2px 6px; border-radius: 6px; background: #7c3aed; color: #fff; font-size: 11px; white-space: nowrap; }`,
  `@media (prefers-reduced-motion: reduce) { .ghost { transition: none; } .ring i { animation: none; opacity: 0; } .ring i:first-child { opacity: 1; } }`,
  `[data-reduce-motion] .ghost { transition: none; }`,
  `[data-reduce-motion] .ring i { animation: none; opacity: 0; }`,
  `[data-reduce-motion] .ring i:first-child { opacity: 1; }`,
].join("\n")

// One script for every page. It accepts a message only from its own window or the banner preload, ignores anything
// malformed, writes strings only with textContent and dataset, booleans with disabled and hidden, and finite numbers
// as CSS custom properties. The arm window runs on the monotonic clock, so a wall-clock step in either direction
// cannot shorten or extend it. A fade applies only right after an end view, so a late fade from a run that ended
// cannot hide the next run's views. The script holds no comments: the pages' "no URL" check forbids `//`.
const SCRIPT = `(() => {
"use strict";
const LIMITS = ${json({ askArmMs: Computer.LIMITS.askArmMs, overlayFadeMs: Computer.LIMITS.overlayFadeMs })};
const ACTIONS = ${json(Computer.OverlayAction.literals)};
const STOP = ${json(labels.stop)};
const RING_MS = 700;
const root = document.documentElement;
const page = root.dataset.page;
const find = (name) => document.querySelector("." + name);
const parts = { line: find("line"), waiting: find("waiting"), key: find("key"), buttons: find("buttons") };
const seen = new Map();
const latched = new Set();
let shown = [];
let signature = "";
let armTimer = 0;
let ringTimer = 0;
const flag = (name, value) => {
  if (value) root.dataset[name] = "";
  else delete root.dataset[name];
};
const text = (value) => (typeof value === "string" ? value : "");
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const put = (node, value) => {
  if (node.textContent !== value) node.textContent = value;
};
const glow = (message) => {
  if (!["working", "background", "dim"].includes(message.variant)) return false;
  root.dataset.variant = message.variant;
  return true;
};
const valid = (button) =>
  !!button &&
  typeof button === "object" &&
  ACTIONS.includes(button.action) &&
  typeof button.label === "string" &&
  button.label !== "" &&
  (button.requestID === undefined || (typeof button.requestID === "string" && button.requestID !== ""));
const banner = (message) => {
  if (!["working", "ask", "paused", "end"].includes(message.tone) || !Array.isArray(message.buttons)) return false;
  root.dataset.tone = message.tone;
  put(parts.line, text(message.line));
  for (const name of ["waiting", "key"]) {
    put(parts[name], text(message[name]));
    parts[name].hidden = !parts[name].textContent;
  }
  buttons(message.buttons.filter(valid));
  return true;
};
const buttons = (list) => {
  const next = JSON.stringify(
    list.map((button) => [button.action, button.label, button.requestID, button.arm === true, button.clickOnly === true, button.primary === true]),
  );
  if (next !== signature) {
    signature = next;
    shown = list.map(make);
    const ids = new Set(shown.map((entry) => entry.id));
    for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
    for (const id of latched) if (!ids.has(id)) latched.delete(id);
    parts.buttons.replaceChildren(...shown.map((entry) => entry.node));
  }
  arm();
};
const make = (button) => {
  const stop = button.action === "stop";
  const id = stop ? undefined : button.requestID;
  if (id !== undefined && !seen.has(id)) seen.set(id, performance.now());
  const entry = {
    node: document.createElement("button"),
    action: button.action,
    id,
    arm: !stop && button.arm === true,
    clickOnly: !stop && button.clickOnly === true,
    since: id === undefined ? performance.now() : seen.get(id),
  };
  entry.node.type = "button";
  entry.node.textContent = button.label;
  entry.node.dataset.action = button.action;
  if (stop) entry.node.dataset.tone = "stop";
  else if (button.primary === true) entry.node.dataset.tone = "primary";
  entry.node.addEventListener("click", (event) => press(entry, event));
  return entry;
};
const arm = () => {
  clearTimeout(armTimer);
  const now = performance.now();
  let next = 0;
  for (const entry of shown) {
    const wait = entry.arm ? Math.max(0, entry.since + LIMITS.askArmMs - now) : 0;
    entry.node.disabled = wait > 0 || (entry.id !== undefined && latched.has(entry.id));
    if (wait > 0 && entry.node.dataset.arming === undefined) {
      entry.node.style.setProperty("--arm", wait + "ms");
      entry.node.dataset.arming = "";
    }
    if (wait === 0) delete entry.node.dataset.arming;
    if (wait > 0 && (next === 0 || wait < next)) next = wait;
  }
  if (next > 0) armTimer = setTimeout(arm, next);
};
const release = (id) => {
  if (id !== undefined && latched.delete(id)) arm();
};
const press = (entry, event) => {
  if (entry.node.disabled) return;
  if (entry.clickOnly && event.detail === 0) return;
  if (entry.id !== undefined) {
    latched.add(entry.id);
    arm();
  }
  Promise.resolve()
    .then(() => window.computerOverlay.act(entry.action, entry.id))
    .then(
      (accepted) => {
        if (accepted === false) release(entry.id);
      },
      () => release(entry.id),
    );
};
const cursor = (message) => {
  if (message.kind === "hide") {
    flag("ring", false);
    flag("ghost", false);
    return true;
  }
  if ((message.kind !== "ring" && message.kind !== "ghost") || !finite(message.x) || !finite(message.y)) return false;
  root.style.setProperty("--x", message.x + "px");
  root.style.setProperty("--y", message.y + "px");
  if (message.kind === "ghost") {
    flag("ghost", true);
    return true;
  }
  flag("ring", false);
  void root.offsetWidth;
  flag("ring", true);
  clearTimeout(ringTimer);
  ringTimer = setTimeout(() => flag("ring", false), RING_MS);
  return true;
};
const render = { glow, banner, cursor };
const ends = {
  glow: (message) => message.end === true,
  banner: (message) => message.tone === "end",
  cursor: (message) => message.kind === "hide",
};
let ended = false;
const apply = (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "fade") {
    if (ended) flag("out", true);
    return;
  }
  if (message.type !== page || !render[page](message)) return;
  ended = ends[page](message);
  flag("out", false);
  flag("reduceMotion", message.reduceMotion === true);
};
window.addEventListener("message", (event) => {
  if (event.source === window) apply(event.data);
});
if (page === "banner") {
  buttons([{ action: "stop", label: STOP }]);
  root.addEventListener("pointerenter", () => window.computerOverlay?.hover(true));
  root.addEventListener("pointerleave", () => window.computerOverlay?.hover(false));
}
window.computerOverlay?.onState(apply);
})();`
