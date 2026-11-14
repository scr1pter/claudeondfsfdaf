export * as ComputerEvent from "./computer-event"

import { Computer } from "./computer"
import { Event } from "./event"
import { SessionID } from "./session-id"

/** V1 desktop status for the compatibility event stream; current sessions do not offer computer use. */
export const State = Event.define({
  type: "computer.state",
  schema: {
    sessionID: SessionID,
    state: Computer.ComputerState,
  },
})

export const Definitions = Event.inventory(State)
