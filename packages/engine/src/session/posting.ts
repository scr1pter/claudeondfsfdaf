export * as SessionPosting from "./posting"

import { Effect, Schema } from "effect"
import { BrainPosting } from "@vectordevai/core/brain/posting"
import { Git } from "@/git"
import { Instruction } from "./instruction"
import { SessionID } from "./schema"
import { Session } from "./session"

// The posting check as the engine runs it (section 6.4a): for the owner-only route desktop main calls before it posts
// or commits, and in-process for the CLI's own GitHub writes. The sessions a post names are followed to the sessions
// they launched, so what a subagent was shown counts too.

/** Levels of launched sessions followed below the ones a post names, and sessions followed in all. */
const DEPTH = 3
const SESSIONS = 200

export type Input = BrainPosting.Input & { readonly sessionIDs?: readonly string[] }

export const check = Effect.fn("SessionPosting.check")(function* (input: Input) {
  const instruction = yield* Instruction.Service
  const sessions = yield* Session.Service
  const git = yield* Git.Service
  const place = yield* instruction.place()
  const contributors = yield* lineage(input.sessionIDs ?? [], sessions.children)
  return yield* BrainPosting.run(place, {
    parts: input.parts,
    typed: input.typed,
    ...(input.untrusted ? { untrusted: true } : {}),
    ...(input.hosts ? { hosts: input.hosts } : {}),
    sessionIDs: contributors,
    // A token the repository's own files hold is not private: the post goes to that repository.
    known: (tokens) =>
      Effect.forEach(
        tokens,
        (token) =>
          git.run(["grep", "-q", "-w", "-F", "-I", "-i", "-e", token, "--"], { cwd: place.root }).pipe(
            Effect.map((result) => (result.exitCode === 0 ? [token] : [])),
            Effect.catchCause(() => Effect.succeed([] as string[])),
          ),
        { concurrency: 4 },
      ).pipe(Effect.map((found) => new Set(found.flat()))),
  })
})

/**
 * The check for a post nobody is there to answer: what overlaps the owner's memory is dropped, and the log says how
 * many sentences went, never which. Text the user typed is never changed, so it is posted only when nothing overlaps.
 */
export const headless = Effect.fn("SessionPosting.headless")(function* (
  input: Input & { readonly log: (line: string) => void },
) {
  const result = yield* check(input)
  if (result.status === "ask")
    return yield* new Refused({
      message: `Vector did not post this: ${result.dropped.length === 1 ? "1 sentence of your text repeats" : `${result.dropped.length} sentences of your text repeat`} what Vector knows about you.`,
    })
  if (result.dropped.length)
    input.log(
      `Left out ${result.dropped.length === 1 ? "1 sentence that repeats" : `${result.dropped.length} sentences that repeat`} what Vector knows about you.`,
    )
  if (result.links)
    input.log(`Left out ${result.links} ${result.links === 1 ? "link" : "links"} that point off GitHub.`)
  return result.parts
})

/** A post that did not happen: the user's own text overlaps memory, and nobody is there to ask. */
export class Refused extends Schema.TaggedErrorClass<Refused>()("PostingRefused", { message: Schema.String }) {}

/** Every contributor, or a refusal. A truncated or unreadable family cannot authorize a post. */
export function lineage(
  ids: readonly string[],
  children: (parentID: SessionID) => Effect.Effect<readonly Pick<Session.Info, "id">[]>,
): Effect.Effect<string[], Refused> {
  return Effect.gen(function* () {
    const seen = new Set(ids)
    if (seen.size > SESSIONS)
      return yield* new Refused({
        message: "Vector could not inspect every contributing session, so nothing was posted.",
      })
    const descend = (frontier: readonly string[], depth: number): Effect.Effect<void, Refused> =>
      Effect.gen(function* () {
        if (!frontier.length) return
        // Lookup defects and interruption propagate. Neither becomes an empty family.
        const found = yield* Effect.forEach(frontier, (id) => children(SessionID.make(id)), { concurrency: 8 })
        const next = [...new Set(found.flat().map((child) => child.id as string))].filter((id) => !seen.has(id))
        if (!next.length) return
        if (depth === 0 || seen.size + next.length > SESSIONS)
          return yield* new Refused({
            message: "Vector could not inspect every contributing session, so nothing was posted.",
          })
        next.forEach((id) => seen.add(id))
        yield* descend(next, depth - 1)
      })
    yield* descend([...seen], DEPTH)
    return [...seen]
  })
}
