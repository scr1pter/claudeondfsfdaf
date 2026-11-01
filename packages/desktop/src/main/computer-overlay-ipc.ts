import { ComputerOverlayPage } from "@vectordevai/app/computer/overlay-page"
import { Computer } from "@vectordevai/schema/computer"
import { Schema } from "effect"

type Contents = { id: number; isDestroyed(): boolean; mainFrame: unknown }
type Sender = { sender: Contents; senderFrame?: unknown }
export type ComputerOverlayControls = {
  banner(): { isDestroyed(): boolean; webContents: Contents } | undefined
  state(): Computer.ComputerState
  armed(requestID: string): boolean
  act(action: Computer.OverlayAction, requestID?: string): Promise<boolean>
  hover(on: boolean): void
}

let controls: ComputerOverlayControls | undefined

/** D22 attaches the active controller; shutdown detaches it before disposing the windows. */
export function setComputerOverlayControls(next: ComputerOverlayControls | undefined) {
  controls = next
}

function trusted(event: Sender, control: ComputerOverlayControls) {
  const banner = control.banner()
  return (
    !!banner &&
    !banner.isDestroyed() &&
    !event.sender.isDestroyed() &&
    event.sender === banner.webContents &&
    event.sender.id === banner.webContents.id &&
    !!event.senderFrame &&
    event.senderFrame === banner.webContents.mainFrame
  )
}

/** These are separate from ordinary renderer IPC: the banner receives no main-window API. */
export async function dispatchComputerOverlayAction(
  event: Sender,
  control: ComputerOverlayControls | undefined,
  action: unknown,
  requestID?: unknown,
) {
  if (!control || !trusted(event, control) || !Schema.is(Computer.OverlayAction)(action)) return false
  if (requestID !== undefined && (typeof requestID !== "string" || !requestID || requestID.length > 128)) return false
  const state = control.state()
  const button = ComputerOverlayPage.bannerView(state)?.buttons.find((button) => button.action === action)
  if (!button) return false
  if (Computer.OVERLAY_ANSWERS.includes(action)) {
    if (!state.ask || requestID !== state.ask.requestID || requestID !== button.requestID) return false
    if (action === "allow" && !control.armed(state.ask.requestID)) return false
  } else if (requestID !== undefined) return false
  return control.act(action, typeof requestID === "string" ? requestID : undefined).then(
    (result) => result === true,
    () => false,
  )
}

export function registerComputerOverlayIpc(input: {
  handle(channel: string, callback: (event: Sender, action: unknown, requestID?: unknown) => Promise<boolean>): void
  on(channel: string, callback: (event: Sender, on: unknown) => void): void
}) {
  input.handle("computer-overlay-act", (event, action, requestID) =>
    dispatchComputerOverlayAction(event, controls, action, requestID),
  )
  input.on("computer-overlay-hover", (event, on) => {
    if (controls && trusted(event, controls) && typeof on === "boolean") controls.hover(on)
  })
}
