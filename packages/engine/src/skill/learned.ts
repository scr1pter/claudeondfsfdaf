export * as LearnedSkill from "./learned"

import path from "path"
import { Context, Effect, Layer } from "effect"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { freeModelMayTrain } from "@vectordevai/core/free-model-choice"
import { FSUtil } from "@vectordevai/core/fs-util"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { Permission } from "@/permission"
import type { Provider } from "@/provider/provider"
import { Instruction } from "@/session/instruction"
import { SessionPosting } from "@/session/posting"
import { Session } from "@/session/session"
import { Skill } from "."

// Learned skills as a session sees them (section 5.4). The listing is chosen once, on the session's first step that is
// not on the quick lane, and kept in brain.db, so a restart or a disposed instance shows the same lines and the
// provider's cache holds. Every step filters what was kept again, which only ever takes lines away: a guest who joined,
// a model that may train on prompts, a skill forgotten or put away since. Only a skill in that filtered listing loads,
// and its steps reach the model only as tool output each request fills in; the transcript keeps a placeholder.

/** Where a learned skill's line says it lives: no path and no id. */
export const LOCATION = "learned"

/** What a request is given in place of a learned skill's steps where they may not go. */
export const WITHHELD = "[learned skill withheld here]"

export type Loaded = {
  readonly info: Skill.Info
  readonly id: string
  readonly version: number
  /** Who put the skill in use: the owner, or Vector after two matching runs, which asks `learned_skill` first. */
  readonly approvedBy: "user" | "vector"
  /** The checks the version names, so the run can credit the skill by its own checks alone. */
  readonly checks: readonly string[]
}

export type Shared =
  | { readonly type: "shared"; readonly path: string; readonly trust: "changed"; readonly reload: "when-idle" }
  | { readonly type: "refused"; readonly reason: string; readonly message: string }

/** What sharing would write, byte for byte, or why it would refuse, before anything is written. */
export type Preview =
  | { readonly type: "preview"; readonly path: string; readonly text: string; readonly exists: boolean }
  | { readonly type: "refused"; readonly reason: string; readonly message: string }

type Viewer = {
  readonly session: Session.Info
  readonly agent: Agent.Info
  readonly model: Provider.Model
  readonly guest: boolean
}

export interface Interface {
  /**
   * The learned skills this step lists. `first` is the session's first step off the quick lane, which chooses them by
   * `query`, the request's typed text, and keeps them; every other step shows what was kept, filtered again.
   */
  readonly listing: (
    input: Viewer & { readonly query: string; readonly first: boolean },
  ) => Effect.Effect<readonly Skill.Info[]>
  /** A learned skill this step's listing shows, by name, while it is still in use. */
  readonly load: (input: Viewer & { readonly name: string }) => Effect.Effect<Loaded | undefined>
  /** Records a load once its asks passed: one use per request and skill. */
  readonly loaded: (input: {
    readonly session: Session.Info
    readonly id: string
    readonly version: number
    readonly requestID: string
  }) => Effect.Effect<void>
  /** A loaded version's content as the agent reads it, or nothing once the version is gone. */
  readonly fill: (input: { readonly id: string; readonly version: number }) => Effect.Effect<string | undefined>
  /**
   * Writes a skill the owner approved to `.vector/skills/<name>/SKILL.md` for the team, after the posting check, and
   * puts the learned copy away. Reached only from the owner's route and CLI.
   */
  readonly share: (place: Brain.Place, id: string, options?: { readonly force?: boolean }) => Effect.Effect<Shared>
  /** The file `share` would write and where, after the same checks, or its refusal. Writes nothing. */
  readonly preview: (place: Brain.Place, id: string) => Effect.Effect<Preview>
}

export class Service extends Context.Service<Service, Interface>()("@vector/LearnedSkill") {}

// Deep research's agents: a worker's and the judge's output leaves the machine (prompt.ts audienceOf), and the lead
// researches rather than repeating repository work.
const OUTWARD = new Set([Agent.RESEARCH, Agent.RESEARCHER, Agent.RESEARCH_JUDGE])

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* BrainSkill.Service
    const instruction = yield* Instruction.Service
    const flags = yield* RuntimeFlags.Service
    const fsys = yield* FSUtil.Service
    const brain = yield* Brain.Service
    const knowledge = yield* BrainKnowledge.Service
    const sessions = yield* Session.Service
    const git = yield* Git.Service

    // A root session the owner works in, on an agent that may load skills, with no guest in it. Vectorscope's
    // reviewers and Vector's helpers are internal, and subagents have a parent.
    const eligible = (input: Viewer) =>
      !flags.pure &&
      !input.guest &&
      !input.session.parentID &&
      !input.session.internal &&
      !OUTWARD.has(input.agent.name) &&
      !Permission.disabled(["skill"], input.agent.permission).has("skill")

    // What was kept for the session, as this step may show it: private lines only where personal memory may go.
    const shown = Effect.fnUntraced(function* (input: Viewer) {
      if (!eligible(input)) return []
      const place = yield* instruction.place()
      return yield* skills.stored(place, { sessionID: input.session.id, personal: !freeModelMayTrain(input.model) })
    })

    const listing = Effect.fn("LearnedSkill.listing")(function* (
      input: Viewer & { readonly query: string; readonly first: boolean },
    ) {
      if (!eligible(input)) return []
      if (input.first) {
        const place = yield* instruction.place()
        const chosen = yield* skills.listing(place, { query: input.query, personal: !freeModelMayTrain(input.model) })
        yield* skills.store(place, input.session.id, chosen)
        yield* Effect.annotateCurrentSpan({ "skill.listed": chosen.length })
      }
      return (yield* shown(input)).map(info)
    })

    const load = Effect.fn("LearnedSkill.load")(function* (input: Viewer & { readonly name: string }) {
      const row = (yield* shown(input)).find((item) => item.name === input.name)
      if (!row) return undefined
      const place = yield* instruction.place()
      const detail = yield* skills.get(place, row.id)
      const version = yield* skills.version(place, row.id, row.version)
      if (detail?.entry.status !== "active" || !detail.entry.skill || !version) return undefined
      yield* Effect.annotateCurrentSpan({ "skill.id": row.id })
      return {
        info: info(row),
        id: row.id,
        version: row.version,
        approvedBy: detail.entry.skill.approvedBy === "user" ? ("user" as const) : ("vector" as const),
        checks: version.checks,
      } satisfies Loaded
    })

    const loaded = Effect.fn("LearnedSkill.loaded")(function* (input: {
      readonly session: Session.Info
      readonly id: string
      readonly version: number
      readonly requestID: string
    }) {
      const place = yield* instruction.place()
      yield* skills.loaded(place, {
        id: input.id,
        version: input.version,
        sessionID: input.session.id,
        requestID: input.requestID,
      })
    })

    const fill = Effect.fn("LearnedSkill.fill")(function* (input: { readonly id: string; readonly version: number }) {
      const place = yield* instruction.place()
      const version = yield* skills.version(place, input.id, input.version)
      return version ? BrainSkill.content(version) : undefined
    })

    const share = Effect.fn("LearnedSkill.share")(function* (
      place: Brain.Place,
      id: string,
      options?: { readonly force?: boolean },
    ) {
      yield* Effect.annotateCurrentSpan({ "skill.id": id })
      const ready = yield* prepare(place, id)
      if (ready.type === "refused") return ready
      if (ready.exists && options?.force !== true)
        return {
          type: "refused" as const,
          reason: "exists",
          message: `${ready.path} already exists. Share again with force to replace it.`,
        }
      yield* fsys.writeWithDirs(ready.target, ready.text).pipe(Effect.orDie)
      yield* skills.shared(place, id, ready.path)
      return { type: "shared" as const, path: ready.path, trust: "changed" as const, reload: "when-idle" as const }
    })

    // The Share panel shows this, so the owner sees the file the server writes, not a guess at it.
    const preview = Effect.fn("LearnedSkill.preview")(function* (place: Brain.Place, id: string) {
      yield* Effect.annotateCurrentSpan({ "skill.id": id })
      const ready = yield* prepare(place, id)
      if (ready.type === "refused") return ready
      return { type: "preview" as const, path: ready.path, text: ready.text, exists: ready.exists }
    })

    // Every check sharing makes before it writes: approved by the owner, nothing of their personal memory, and a path
    // inside the repository.
    const prepare = Effect.fnUntraced(function* (place: Brain.Place, id: string) {
      const ready = yield* skills.shareable(place, id)
      if ("refused" in ready) return { type: "refused" as const, reason: ready.refused, message: ready.message }
      // The file reaches the team: what it shares with the owner's memory of them is theirs to take out first.
      const checked = yield* SessionPosting.check({
        parts: [ready.text],
        typed: false,
        sessionIDs: ready.sessions,
      }).pipe(
        Effect.provideService(Instruction.Service, instruction),
        Effect.provideService(Session.Service, sessions),
        Effect.provideService(Git.Service, git),
        Effect.provideService(Brain.Service, brain),
        Effect.provideService(BrainKnowledge.Service, knowledge),
      )
      if (checked.status !== "clean")
        return {
          type: "refused" as const,
          reason: "personal",
          message: [
            "These sentences repeat what Vector knows about you. Edit them out of the skill before sharing it:",
            ...checked.dropped.map((item) => `- ${item.text}`),
          ].join("\n"),
        }
      const name = ready.entry.skill!.name
      const relative = [".vector", "skills", name, "SKILL.md"].join("/")
      const target = path.join(place.root, ".vector", "skills", name, "SKILL.md")
      // A link in the way could land the file anywhere on the computer.
      if (!FSUtil.writableInside(place.root, target))
        return {
          type: "refused" as const,
          reason: "outside",
          message: `${relative} is a link or lands outside this repository, so Vector does not write it.`,
        }
      return {
        type: "ready" as const,
        path: relative,
        target,
        text: ready.text,
        exists: yield* fsys.existsSafe(target),
      }
    })

    return Service.of({ listing, load, loaded, fill, share, preview })
  }),
)

function info(row: BrainSkill.Listed): Skill.Info {
  return { name: row.name, description: row.description, location: LOCATION, content: "" }
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    BrainSkill.node,
    Instruction.node,
    RuntimeFlags.node,
    FSUtil.node,
    Brain.node,
    BrainKnowledge.node,
    Session.node,
    Git.node,
  ],
})
