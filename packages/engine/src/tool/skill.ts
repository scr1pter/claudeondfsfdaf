import path from "path"
import { Effect, Option, Schema } from "effect"
import { Ripgrep } from "@vectordevai/core/ripgrep"
import { Global } from "@vectordevai/core/global"
import { BrainSkill } from "@vectordevai/core/brain/skill"
import { FreeModelGuests } from "@vectordevai/core/free-model-guests"
import { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionMemory } from "@/session/memory"
import { SessionID } from "@/session/schema"
import { Skill } from "../skill"
import { LearnedSkill } from "../skill/learned"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

type Metadata = {
  name: string
  dir: string
  remote: boolean
  /** A learned skill's entry and version: the transcript keeps these and the placeholder, never its steps. */
  learned?: string
  version?: number
  [SessionMemory.SKILL]?: { id: string; version: number; checks: string[] }
}

export const SkillTool = Tool.define<
  typeof Parameters,
  Metadata,
  Skill.Service | Ripgrep.Service | Global.Service | Agent.Service | Session.Service | FreeModelGuests.Service
>(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service
    const global = yield* Global.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const guests = yield* FreeModelGuests.Service
    // The registry's learned skills. A skill tool built without them (a test of disk skills) uses the session
    // runtime's, if it has any, when it is called.
    const registered = yield* Effect.serviceOption(LearnedSkill.Service)

    // A learned skill (section 5.4): only one this step's listing shows, and its steps never in the transcript. The
    // transcript keeps a placeholder, which each request fills in from the loaded version where personal memory may go.
    const learn = Effect.fnUntraced(function* (name: string, ctx: Tool.Context<Metadata>) {
      const learned = Option.getOrUndefined(
        Option.isSome(registered) ? registered : yield* Effect.serviceOption(LearnedSkill.Service),
      )
      const agent = yield* agents.get(ctx.agent)
      const model = ctx.extra?.model as Provider.Model | undefined
      if (!learned || !agent || !model) return undefined
      const session = yield* sessions.get(SessionID.make(ctx.sessionID)).pipe(Effect.orDie)
      const guest = yield* guests.marked(session.id)
      const found = yield* learned.load({ session, agent, model, guest, name })
      if (!found) return undefined
      yield* ctx.ask({ permission: "skill", patterns: [name], always: [name], metadata: {} })
      // What Vector put in use on its own, from two matching runs, asks before it loads; what the owner approved does
      // not.
      if (found.approvedBy === "vector")
        yield* ctx.ask({ permission: "learned_skill", patterns: [name], always: [name], metadata: {} })
      yield* learned.loaded({
        session,
        id: found.id,
        version: found.version,
        requestID: SessionMemory.request(ctx.messages)[0]?.info.id ?? ctx.messageID,
      })
      return {
        title: `Loaded learned skill: ${name}`,
        output: BrainSkill.placeholder(name, found.version),
        metadata: {
          name,
          dir: "",
          remote: false,
          learned: found.id,
          version: found.version,
          [SessionMemory.SKILL]: { id: found.id, version: found.version, checks: [...found.checks] },
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          // A skill on disk or built in wins over a learned one of the same name.
          const learned = (yield* skill.get(params.name)) ? undefined : yield* learn(params.name, ctx)
          if (learned) return learned
          const info = yield* skill
            .require(params.name)
            .pipe(Effect.catchTag("Skill.NotFoundError", (error) => Effect.die(new Error(error.message))))

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const dir = path.dirname(info.location)
          const base = dir
          const files = yield* ripgrep.find({
            cwd: dir,
            pattern: "!**/SKILL.md",
            hidden: true,
            follow: false,
            signal: ctx.abort,
            limit: 10,
          })

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files.map((file) => `<file>${path.resolve(dir, file.path)}</file>`).join("\n"),
              "</skill_files>",
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
              // A skill pulled from a skills URL is someone else's text, as a slash command of it is: memory written
              // after it waits for review.
              remote: info.location.startsWith(path.join(global.cache, "skills") + path.sep),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
