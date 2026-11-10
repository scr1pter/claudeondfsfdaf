import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { ModelPlanStatus } from "@vectordevai/core/model-plan-status"
import { Slug } from "@vectordevai/core/util/slug"
import { LLMEvent } from "@vectordevai/llm"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

const COPY_NAME_AGENT: Agent.Info = {
  name: "project-copy-name",
  mode: "primary",
  permission: [],
  options: {},
  native: true,
  // An empty prompt would fall back to the full coding-agent system prompt.
  prompt: "Reply with only a 2-3 word name for the task. No punctuation or explanation.",
}

export const projectCopyHandlers = HttpApiBuilder.group(InstanceHttpApi, "projectCopyName", (handlers) =>
  Effect.gen(function* () {
    const llm = yield* LLM.Service
    const provider = yield* Provider.Service

    const generateName = Effect.fn("ProjectCopyHttpApi.generateName")(function* (context: string | undefined) {
      const text = context?.trim()
      if (!text) return Slug.create()
      const fallback = yield* provider.defaultModel().pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!fallback) return Slug.create()
      const small = yield* provider.getSmallModel(fallback.providerID, fallback.modelID)
      // A Codium default without a helper model gets a plain name rather than one on its own model.
      if (!small && fallback.providerID === ModelPlanStatus.PROVIDER_ID) return Slug.create()
      const model = small ?? (yield* provider.getModel(fallback.providerID, fallback.modelID))
      const sessionID = SessionID.descending()
      const result = yield* llm
        .stream({
          agent: COPY_NAME_AGENT,
          user: {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: COPY_NAME_AGENT.name,
            model: { providerID: model.providerID, modelID: model.id },
          },
          system: [],
          small: true,
          tools: {},
          model,
          sessionID,
          // A name, like a title: Codium counts it as one.
          purpose: "title",
          retries: 2,
          messages: [
            {
              role: "user",
              content: `Generate a short 2-3 word name that describes this task:\n${text.slice(0, 1000)}`,
            },
          ],
        })
        .pipe(
          Stream.filter(LLMEvent.is.textDelta),
          Stream.map((event) => event.text),
          Stream.mkString,
        )
      const output = result.trim()
      return output ? slugify(output.split(/\s+/).slice(0, 3).join(" ")) : Slug.create()
    })

    return handlers.handle("generateName", (ctx) =>
      generateName(ctx.payload.context).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("project copy name generation failed", {
            projectID: ctx.params.projectID,
            cause,
          }).pipe(Effect.as(Slug.create())),
        ),
        Effect.map((name) => ({ name })),
      ),
    )
  }),
)

function slugify(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}
