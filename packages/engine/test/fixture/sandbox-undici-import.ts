import Undici, { Agent, getGlobalDispatcher } from "@effect/platform-node/Undici"

// Only import and compare actual exports; do not create clients, open sockets, or launch tool processes.
console.log(
  JSON.stringify({
    agent: typeof Agent,
    dispatcher: typeof getGlobalDispatcher,
    same: Undici.Agent === Agent,
  }),
)
