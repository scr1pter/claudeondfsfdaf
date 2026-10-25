import type { Debugger } from "electron"

type Tools = Pick<Debugger, "attach" | "detach" | "isAttached">

// Electron lets one client attach to a web contents' debugger, and Vector has two uses for an agent browser tab's: the
// tab's own file chooser interception (browser-agent.ts) and Vector Local's guard (local-mode.ts). They share one
// attachment: the first use attaches, and the last to let go detaches. A debugger something else attached (developer
// tools) is not taken over.
const holders = new WeakMap<Tools, number>()

/**
 * Holds a debugger for one use. Returns the function that lets it go, which says whether that detached it, or
 * undefined when the debugger cannot attach.
 */
export function holdDebugger(tools: Tools) {
  const count = holders.get(tools) ?? 0
  // Held but no longer attached: something detached it (a crash, developer tools), so this use attaches it again.
  if ((count === 0 || !tools.isAttached()) && !attach(tools)) return undefined
  holders.set(tools, count + 1)
  const state = { held: true }
  return () => {
    if (!state.held) return false
    state.held = false
    const left = Math.max(0, (holders.get(tools) ?? 1) - 1)
    holders.set(tools, left)
    if (left > 0) return false
    if (tools.isAttached()) tools.detach()
    return true
  }
}

function attach(tools: Tools) {
  try {
    tools.attach("1.3")
    return true
  } catch {
    return false
  }
}
