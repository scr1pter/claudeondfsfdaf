export * as SessionSkillLearn from "./skill-learn"

import { Context, Effect, Layer, Option } from "effect"
import * as Stream from "effect/Stream"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import { Brain } from "@vectordevai/core/brain/brain"
import { BrainKnowledge } from "@vectordevai/core/brain/knowledge"
import type { BrainSchema } from "@vectordevai/core/brain/schema"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { freeModelMayTrain } from "@vectordevai/core/free-model-choice"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Egress } from "@vectordevai/core/local-mode/egress"
import type { SpendGuard } from "@vectordevai/core/spend-guard"
import type { TaskSize } from "@vectordevai/core/task-size"
import { SessionV1 } from "@vectordevai/core/v1/session"
import { MemoryEvent } from "@vectordevai/schema/memory-event"
import { LLMEvent } from "@vectordevai/llm"
import { Agent } from "@/agent/agent"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Provider } from "@/provider/provider"
import { Instruction } from "./instruction"
import { LLM } from "./llm"
import { SessionMemory } from "./memory"
import type { MessageID } from "./schema"
import { Session } from "./session"
import { TitleUsage } from "./title-usage"

// Learned skills, drafted once a run is over (section 5.1): when the run's last request, Standard or Thorough work,
// turned a failing check green, with at least three tool calls and a changed file, Vector drafts the steps as a skill
// for the repository. Plain code drafts it from what the run did; where the owner lets it, the small model words it
// instead, locked to the commands and files the run showed. The draft goes through BrainSkill.propose, which holds it
// for the owner unless they chose "auto" and a second untainted session did the same. A guest's session drafts nothing,
// and a session that took in outside content drafts only what waits for review, with no model call.

/**
 * What the model drafter's request is charged to: the run that launched it, captured before that run ended, as for the
 * title and the model learner. The caller lets it go once the drafter is done.
 */
export interface Spend {
  readonly captured: SpendGuard.Captured
  /** How the request is priced: the prompt's helper cost check, so a Codium, local or plan model counts as one. */
  readonly costKind: (model: Provider.Model) => Effect.Effect<SpendGuard.CostKind>
}

export interface Interface {
  /**
   * Drafts the run's skill, if it earned one. Returns the model drafter, to run in the background where the session's
   * next prompt can cancel it, or nothing when plain code already drafted (or nothing was drafted).
   */
  readonly run: (
    session: Session.Info,
    taught: ReadonlyMap<MessageID, { readonly message: SessionV1.WithParts; readonly tier: TaskSize.Tier }>,
    snapshot: SpendGuard.Run | undefined,
    spend: Spend,
  ) => Effect.Effect<Effect.Effect<void> | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@vector/SessionSkillLearn") {}

/**
 * Whether the model drafter may word a run's skill: nothing holds the draft (a tainted session's trace never reaches a
 * model), the owner's setting allows it (`local-only`, the default, only with Vector Local on), neither the primary nor
 * the small model may train on prompts, and the run's budget neither stopped nor warned it. Desktop caps reach the
 * engine as run budgets, so they count too.
 */
export function drafts(input: {
  readonly setting: BrainSchema.SkillDrafter
  readonly local: boolean
  readonly held: boolean
  readonly run?: SpendGuard.Run
  readonly mayTrain: boolean
}) {
  if (input.held || input.mayTrain || input.run?.stopped || input.run?.warned) return false
  return input.setting === "always" || (input.setting === "local-only" && input.local)
}

// A run that did work rather than a lookup: this many completed tool calls at least, and a changed file.
const CALLS = 3

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* BrainSkill.Service
    const brain = yield* Brain.Service
    const knowledge = yield* BrainKnowledge.Service
    const instruction = yield* Instruction.Service
    const sessions = yield* Session.Service
    const guests = yield* FreeModelGuests.Service
    const flags = yield* RuntimeFlags.Service
    const provider = yield* Provider.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const events = yield* EventV2Bridge.Service

    const run = Effect.fn("SessionSkillLearn.run")(function* (
      session: Session.Info,
      taught: ReadonlyMap<MessageID, { readonly message: SessionV1.WithParts; readonly tier: TaskSize.Tier }>,
      snapshot: SpendGuard.Run | undefined,
      spend: Spend,
    ) {
      if (session.parentID || session.internal || flags.pure) return undefined
      const last = [...taught.values()]
        .filter((item) => item.message.info.role === "user")
        .toSorted((a, b) => (a.message.info.id < b.message.info.id ? -1 : 1))
        .at(-1)
      if (!last || (last.tier !== "standard" && last.tier !== "thorough")) return undefined
      if (yield* guests.marked(session.id)) return undefined
      const settings = yield* brain.learnSettings()
      if (!settings.learning || settings.skills === "off") return undefined
      const msgs = yield* sessions.messages({ sessionID: session.id }).pipe(Effect.orDie)
      const index = msgs.findIndex((message) => message.info.id === last.message.info.id)
      const turn = index < 0 ? [] : msgs.slice(index)
      if (!SessionMemory.finished(turn)) return undefined
      const calls = turn.flatMap((message) =>
        message.parts.filter((part) => part.type === "tool" && part.state.status === "completed"),
      )
      if (calls.length < CALLS || SessionMemory.edited(turn).length === 0) return undefined
      const place = yield* instruction.place()
      // A run that loaded a skill and did what it says drafts nothing; one that went its own way may draft a new version.
      const load = SessionMemory.skills(turn)[0]
      const detail = load ? yield* skills.get(place, load.id) : undefined
      const loaded = detail?.entry.skill && {
        id: detail.entry.id,
        key: detail.entry.skill.key,
        checks: detail.entry.skill.checks,
        commands: detail.entry.skill.commands,
        paths: detail.entry.paths,
      }
      const trace = SessionMemory.trace(msgs, last.message.info.time.created, place.root, loaded)
      if (!trace || (load && (!loaded || !BrainSkill.diverged(trace)))) return undefined
      // Held as the memory tool holds what the agent writes: outside content, an untrusted repository, a document read
      // from outside, or a Vector an agent started; private when it read a private document.
      const read = yield* knowledge.sources(place, SessionMemory.documents(msgs))
      const decided = SessionMemory.writeHold({
        guest: false,
        agent: SessionMemory.agentStarted(),
        held: place.held,
        messages: msgs,
        sources: read.documents,
        missing: read.missing.length,
      })
      const propose = Effect.fnUntraced(function* (draft: BrainSkill.Draft | undefined) {
        if (!draft) return
        const result = yield* skills.propose(place, draft, {
          origin: "agent",
          sessionID: session.id,
          requestID: trace.requestID,
          ...(decided.hold ? { hold: decided.hold } : {}),
          ...(decided.private ? { private: true } : {}),
          evidence: {
            type: "run",
            command: trace.check?.command ?? "",
            requestID: trace.requestID,
            verified: trace.signal === "recovered",
          },
          ...(loaded && loaded.key === draft.key ? { supersedes: loaded.id } : {}),
          trace,
        })
        // Ids and outcomes only: never a skill's name, key, files or text.
        yield* Effect.logInfo("skill drafted", {
          result: result.type,
          ...(result.type === "refused" ? { reason: result.reason } : { "skill.id": result.entry.id }),
        })
        // The app's chip under the request ("Drafted a skill for your review: learned-…") reads the entry from the
        // owner's skill routes, so the event carries its id only.
        if (result.type === "added" || result.type === "superseded" || result.type === "promoted")
          yield* events.publish(MemoryEvent.Learned, {
            sessionID: session.id,
            entryIDs: [result.entry.id],
            messageID: trace.requestID,
          })
      })
      const plain = BrainSkill.draft(trace)
      const model = yield* drafter(last.message.info, {
        setting: settings.skillDrafter,
        held: decided.hold !== undefined,
        run: snapshot,
      })
      if (!model) {
        yield* propose(plain)
        return undefined
      }
      // Cancelled by the next prompt, the run still gets the plain draft.
      return modelDraft(session, last.message.info, model, trace, spend).pipe(
        Effect.flatMap((worded) => propose(worded ?? plain)),
        Effect.onInterrupt(() => propose(plain).pipe(Effect.ignore)),
        Effect.catchCause((cause) => Effect.logWarning("skill drafter failed", { cause })),
      )
    })

    // The small model, when the model drafter may run (`drafts`).
    const drafter = Effect.fnUntraced(function* (
      user: SessionV1.Info,
      input: { readonly setting: BrainSchema.SkillDrafter; readonly held: boolean; readonly run?: SpendGuard.Run },
    ) {
      if (user.role !== "user") return undefined
      const primary = yield* provider.getModel(user.model.providerID, user.model.modelID).pipe(Effect.option)
      if (Option.isNone(primary)) return undefined
      const model = (yield* provider.getSmallModel(user.model.providerID, user.model.modelID)) ?? primary.value
      const mayTrain = freeModelMayTrain(primary.value) || freeModelMayTrain(model)
      return drafts({ ...input, local: Egress.policy().enabled, mayTrain }) ? model : undefined
    })

    // One request on the title helper's settings: no tools, no repository context, the run's trace wrapped as data. Its
    // reply counts only as far as `BrainSkill.lock` finds it within what the run showed. Like the model learner's, the
    // request is charged to the run that launched it; a run that has stopped since its snapshot keeps the plain draft.
    const modelDraft = Effect.fnUntraced(function* (
      session: Session.Info,
      user: SessionV1.Info,
      model: Provider.Model,
      trace: BrainSkill.Trace,
      spend: Spend,
    ) {
      const title = yield* agents.get("title")
      if (!title || user.role !== "user") return undefined
      if (yield* spend.captured.stopped) return undefined
      const usage = TitleUsage.create({
        sessionID: session.id,
        model,
        publish: events.publish,
        purpose: "memory",
        spend: spend.captured,
        costKind: yield* spend.costKind(model),
      })
      const reply = yield* llm
        .stream({
          agent: { ...title, name: "brain.skill", prompt: BrainSkill.PROMPT, temperature: 0 },
          user,
          system: [],
          small: true,
          tools: {},
          model,
          sessionID: session.id,
          retries: 1,
          started: usage.started,
          messages: [{ role: "user", content: BrainSkill.request(trace) }],
        })
        .pipe(
          Stream.tap(usage.record),
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
          Effect.ensuring(usage.finish()),
          Effect.catchCause(() => Effect.succeed("")),
        )
      return BrainSkill.lock(reply, trace)
    })

    return Service.of({ run })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    BrainSkill.node,
    Brain.node,
    BrainKnowledge.node,
    Instruction.node,
    Session.node,
    FreeModelGuests.node,
    RuntimeFlags.node,
    Provider.node,
    Agent.node,
    LLM.node,
    EventV2Bridge.node,
  ],
})
