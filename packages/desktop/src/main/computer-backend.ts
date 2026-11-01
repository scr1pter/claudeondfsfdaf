import { Computer } from "@vectordevai/schema/computer"
import { ComputerError } from "./computer-bridge"
import type { HelperClient } from "./computer-helper"

/** The desktop's native-helper boundary. The client owns framing, validation, deadlines and process lifetime. */
export class NativeHelperBackend implements Computer.ComputerBackend {
  readonly kind: Computer.Backend
  private readonly client: HelperClient
  private readonly unlisten: () => void
  private readonly state: {
    hello?: Computer.HelperHello
    pending?: Promise<Computer.HelperHello>
    epoch: number
    closed: boolean
  } = { epoch: 0, closed: false }

  constructor(client: HelperClient, kind: Computer.Backend = "local-macos") {
    this.client = client
    this.kind = kind
    this.unlisten = client.onEvent((event) => {
      if (event.event !== "exit") return
      this.state.epoch++
      this.state.hello = undefined
      this.state.pending = undefined
    })
  }

  hello(): Promise<Computer.HelperHello> {
    if (this.state.closed) return Promise.reject(new ComputerError("unavailable", "The computer helper is closed."))
    if (this.state.hello) return Promise.resolve(structuredClone(this.state.hello))
    if (this.state.pending) return this.state.pending.then((hello) => structuredClone(hello))
    const epoch = this.state.epoch
    const pending = this.client
      .request<Computer.HelperHello>("hello", { protocol: { min: Computer.PROTOCOL, max: Computer.PROTOCOL } }, 5000)
      .then((hello) => {
        if (this.state.closed || epoch !== this.state.epoch)
          throw new ComputerError("unavailable", "The computer helper stopped during negotiation.")
        if (hello.protocol.min > Computer.PROTOCOL || hello.protocol.max < Computer.PROTOCOL)
          throw new ComputerError("helper_incompatible", "The computer helper uses an incompatible protocol.")
        if (!hello.responsible)
          throw new ComputerError("responsible_missing", "The computer helper does not hold its own OS permissions.")
        if (
          (this.kind === "local-macos" && hello.helper.platform !== "macos") ||
          (this.kind === "local-windows" && hello.helper.platform !== "windows")
        )
          throw new ComputerError("helper_incompatible", "The computer helper does not match this platform.")
        this.state.hello = structuredClone(hello)
        return hello
      })
      .finally(() => {
        if (epoch === this.state.epoch) this.state.pending = undefined
      })
    this.state.pending = pending
    return pending.then((hello) => structuredClone(hello))
  }

  capabilities(): { actions: Computer.ToolAction[]; features: Record<string, boolean> } {
    const hello = this.state.hello
    if (this.state.closed || !hello) return { actions: [], features: {} }
    const features = Object.fromEntries(
      Computer.HelperFeature.literals.map((feature) => [
        feature,
        feature !== "locked" &&
          !(feature === "background" && hello.helper.platform === "windows") &&
          hello.features[feature] === true,
      ]),
    )
    const capture = features["capture.exclude"] && (features["capture.display"] || features["capture.window"])
    const pointer = capture && features["input.pointer"]
    const supported: Record<Computer.ToolAction, boolean> = {
      screenshot: capture,
      zoom: capture && features["capture.zoom"],
      cursor_position: capture && features["cursor.position"],
      click: pointer,
      double_click: pointer,
      triple_click: pointer,
      right_click: pointer,
      middle_click: pointer,
      mouse_move: pointer,
      drag: pointer,
      // The helper wire is atomic; it has no persistent button-down/up operation.
      mouse_down: false,
      mouse_up: false,
      scroll: pointer,
      type: features["input.unicode"] && features["ui.secureFieldDetect"],
      key: features["input.keyboard"] && features["ui.secureFieldDetect"],
      hold_key: features["input.keyboard"] && features["ui.secureFieldDetect"],
      wait: true,
      list_apps: features["apps.list"],
      open_app: features["apps.open"],
      focus_window: features["apps.open"],
      read_ui: features["ui.tree"],
      handoff: true,
    }
    return { actions: Computer.ToolAction.literals.filter((action) => supported[action]), features }
  }

  permissions() {
    return this.client.request<Computer.PermissionsStatus>("permissions.status")
  }

  async beginSession(session: Computer.SessionBegin): Promise<void> {
    if (session.mode === "background") await this.requireFeatures("background")
    await this.client.request("session.begin", { ...session })
  }

  async updateSession(session: Partial<Computer.SessionBegin>): Promise<void> {
    if (session.mode === "background") await this.requireFeatures("background")
    // sessionId is an expected identity, not a replacement. Vector's process/window exclusions stay immutable.
    await this.client.request("session.update", {
      ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
      ...(session.phaseRevision === undefined ? {} : { phaseRevision: session.phaseRevision }),
      ...(session.approved === undefined ? {} : { approved: session.approved }),
      ...(session.mode === undefined ? {} : { mode: session.mode }),
      ...(session.escStops === undefined ? {} : { escStops: session.escStops }),
      ...(session.paused === undefined ? {} : { paused: session.paused }),
      ...(session.overlayWindowIds === undefined ? {} : { overlayWindowIds: session.overlayWindowIds }),
    })
  }

  async endSession(): Promise<void> {
    await this.client.request("session.end")
  }

  async heartbeat(): Promise<void> {
    await this.client.request("heartbeat")
  }

  async displays() {
    return (await this.client.request<{ displays: Computer.DisplayInfo[] }>("displays.list")).displays
  }

  async cursorPosition() {
    await this.requireFeatures("cursor.position")
    return this.client.request<Computer.NativeCursor>("cursor.position")
  }

  async apps(query?: { installed?: boolean }) {
    await this.requireFeatures("apps.list")
    return (await this.client.request<{ apps: Computer.HelperApp[] }>("apps.list", query)).apps
  }

  async resolveLaunch(path: string): Promise<Computer.LaunchResolution> {
    await this.requireFeatures("apps.resolve")
    return this.client.request<Computer.LaunchResolution>("apps.resolve", { path })
  }

  async launchProgram(program: Computer.NativeProgramLaunch, phase?: Computer.NativePhase): Promise<void> {
    await this.requireFeatures("program.launch")
    await this.client.request("program.launch", { token: program.token, binding: program.binding, ...phase })
  }

  async activate(app: Computer.AppIdentity, phase?: Computer.NativePhase): Promise<void> {
    await this.requireFeatures("apps.open")
    requireForeground(await this.client.request<{ foreground?: boolean }>("app.activate", { identity: app, ...phase }))
  }

  async launch(target: Computer.AppIdentity | { path: string }, phase?: Computer.NativePhase): Promise<void> {
    await this.requireFeatures("apps.open")
    requireForeground(
      await this.client.request<{ foreground?: boolean }>(
        "app.launch",
        "platform" in target ? { identity: target, ...phase } : { path: target.path, ...phase },
      ),
    )
  }

  async focusWindow(windowId: string, phase?: Computer.NativePhase): Promise<void> {
    await this.requireFeatures("apps.open")
    requireForeground(await this.client.request<{ foreground?: boolean }>("window.focus", { windowId, ...phase }))
  }

  async capture(request: Computer.CaptureRequest, deadlineMs: number) {
    await this.requireFeatures(
      "capture.exclude",
      "display" in request.target ? "capture.display" : "capture.window",
      ...(request.zoom ? (["capture.zoom"] as const) : []),
    )
    const result = await this.client.request<(Computer.CaptureHeader & { bytes: Uint8Array }) | { paused: true }>(
      "capture",
      { ...request },
      deadlineMs,
    )
    if ("paused" in result) throw new ComputerError("paused", "The target window is minimized.")
    const { bytes, ...header } = result
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== header.imageBytes)
      throw new ComputerError("capture_unavailable", "The computer helper returned an incomplete image.")
    return { header, bytes }
  }

  async tree(request: Computer.TreeRequest, deadlineMs: number) {
    await this.requireFeatures("ui.tree")
    return this.client.request<Computer.TreeResult>("ui.tree", request, deadlineMs)
  }

  hitTest(captureId: string, x: number, y: number) {
    return this.client.request<Computer.HitResult>("ui.hittest", { captureId, x, y })
  }

  focused() {
    return this.client.request<Computer.HitResult>("ui.focused")
  }

  resolveRef(ref: string) {
    return this.client.request<Computer.HitResult>("ui.resolve", { ref })
  }

  async perform(ref: string, action: string, phase?: Computer.NativePhase, expected?: Computer.NativeElementTarget) {
    await this.requireFeatures("ui.actions")
    return this.client.request<{ took?: boolean }>("ui.perform", { ref, action, ...phase, ...expected })
  }

  async setValue(ref: string, value: string, phase?: Computer.NativePhase, expected?: Computer.NativeElementTarget) {
    await this.requireFeatures("ui.actions", "ui.secureFieldDetect")
    return this.client.request<{ took?: boolean }>("ui.setValue", { ref, value, ...phase, ...expected })
  }

  async input(input: Computer.InputOp, deadlineMs: number): Promise<void> {
    const features: Computer.HelperFeature[] =
      input.op === "input.type"
        ? ["input.unicode", "ui.secureFieldDetect"]
        : input.op === "input.key" || input.op === "input.hold"
          ? ["input.keyboard", "ui.secureFieldDetect"]
          : ["input.pointer", "capture.exclude"]
    await this.requireFeatures(...features)
    await this.client.request(input.op, input, deadlineMs)
  }

  async releaseAll() {
    return (await this.client.request<{ released: number }>("input.releaseAll", {}, 300)).released
  }

  async cancel(id?: string): Promise<void> {
    if (id === undefined) {
      await this.client.request("cancel")
      return
    }
    const target = Number(id)
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(target))
      throw new ComputerError("failed", "The computer helper request ID is invalid.")
    await this.client.request("cancel", { target })
  }

  async close(): Promise<void> {
    if (this.state.closed) return
    this.state.closed = true
    this.state.epoch++
    this.state.hello = undefined
    this.state.pending = undefined
    this.unlisten()
    await this.client.close()
  }

  onEvent(callback: (event: Computer.HelperEvent) => void) {
    return this.client.onEvent(callback)
  }

  private async requireFeatures(...features: Computer.HelperFeature[]) {
    await this.hello()
    const supported = this.capabilities().features
    if (features.some((feature) => supported[feature] !== true))
      throw new ComputerError("unsupported_action", "The computer helper does not support this operation.")
  }
}

function requireForeground(result: { foreground?: boolean }) {
  if (result.foreground === false)
    throw new ComputerError("not_foreground", "The target app could not be brought to the foreground.")
}
