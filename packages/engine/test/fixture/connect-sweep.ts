import { Layer } from "effect"
import { ConnectOwner } from "@/connect/owner"

// A graph that builds ConnectOwner with Connect on would otherwise sweep the machine's real temporary folder at start.
// The real sweep is covered by core's read-only-git tests, each on a folder of its own.
export const noSweep = Layer.succeed(ConnectOwner.Sweep, async () => ({ removed: 0, kept: 0, failed: 0 }))
