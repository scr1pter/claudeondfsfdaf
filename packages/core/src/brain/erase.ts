export * as BrainErase from "./erase"

import { Effect } from "effect"
import type { ResearchStore } from "../research/store"
import type { Brain } from "./brain"
import type { BrainSchema } from "./schema"

// Erasing memory, wherever it is asked for: Settings > Memory, the learned chip on a message and `vector memory erase`
// all come here, so none of them leaves Deep research behind. Research is the repository's, like its documents:
//
// - Erasing what Vector learned about the user keeps every run.
// - Erasing a repository's memory forgets its runs, and erasing all of it forgets every repository's, the way "Forget
//   every research run" does. Forget's tombstones go with the rest of the brain's, so the same pages can be read again.
// - Erasing what Vector learned in a session forgets the runs that session started, with their tombstones kept, as the
//   entries it forgets are not learned again.

export type Scope = BrainSchema.Scope | "all"

/** What an erase took: entries from the brain, and research runs. */
export type Erased = { readonly entries: number; readonly runs: number }

type Stores = { readonly brain: Brain.Interface; readonly research: ResearchStore.Interface }

export const erase = Effect.fn("BrainErase.erase")(function* (
  input: Stores & { readonly place: Brain.Place; readonly scope: Scope },
) {
  // Research first: the brain's erase then clears the tombstones Forget leaves.
  const runs =
    input.scope === "personal"
      ? 0
      : yield* input.research.forgetAll(input.place, input.scope === "all" ? { everywhere: true } : {})
  const entries = yield* input.brain.erase(input.place, input.scope)
  return { entries, runs } satisfies Erased
})

export const session = Effect.fn("BrainErase.session")(function* (
  input: Stores & { readonly place: Brain.Place; readonly sessionID: string },
) {
  const runs = yield* input.research.forgetAll(input.place, { session: input.sessionID })
  const entries = yield* input.brain.eraseSession(input.place, input.sessionID)
  return { entries, runs } satisfies Erased
})
