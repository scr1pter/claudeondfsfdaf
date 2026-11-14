import {
  CHATGPT_SIGN_IN_UNAVAILABLE,
  chatgptOAuthConfiguration,
  providerEnabled,
  providerOAuthAllowed,
} from "@vectordevai/core/provider-policy"
import { ProviderRemotePolicy } from "@vectordevai/core/provider-remote-policy"
import { pluginOAuthAllowed } from "../plugin/oauth"
import { LayerNode } from "@vectordevai/core/effect/layer-node"
import type { AuthOAuthResult, Hooks } from "@vectordevai/plugin"
import { serviceUse } from "@vectordevai/core/effect/service-use"
import { Auth } from "@/auth"
import { InstanceState } from "@/effect/instance-state"
import { optional } from "@vectordevai/core/schema"
import { Plugin } from "../plugin"
import { ProviderV2 } from "@vectordevai/core/provider"
import { ProcessIsolation } from "@vectordevai/core/process-isolation"
import { Array as Arr, Effect, Layer, Record, Result, Context, Schema } from "effect"

const When = Schema.Struct({
  key: Schema.String,
  op: Schema.Literals(["eq", "neq"]),
  value: Schema.String,
})

const TextPrompt = Schema.Struct({
  type: Schema.Literal("text"),
  key: Schema.String,
  message: Schema.String,
  placeholder: optional(Schema.String),
  when: optional(When),
})

const SelectOption = Schema.Struct({
  label: Schema.String,
  value: Schema.String,
  hint: optional(Schema.String),
})

const SelectPrompt = Schema.Struct({
  type: Schema.Literal("select"),
  key: Schema.String,
  message: Schema.String,
  options: Schema.Array(SelectOption),
  when: optional(When),
})

const Prompt = Schema.Union([TextPrompt, SelectPrompt])

export class Method extends Schema.Class<Method>("ProviderAuthMethod")({
  type: Schema.Literals(["oauth", "api"]),
  label: Schema.String,
  prompts: optional(Schema.Array(Prompt)),
}) {}

export const Methods = Schema.Record(Schema.String, Schema.Array(Method))
export type Methods = typeof Methods.Type

export class Authorization extends Schema.Class<Authorization>("ProviderAuthAuthorization")({
  url: Schema.String,
  method: Schema.Literals(["auto", "code"]),
  instructions: Schema.String,
}) {}

export const AuthorizeInput = Schema.Struct({
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  inputs: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({ description: "Prompt inputs" }),
})
export type AuthorizeInput = Schema.Schema.Type<typeof AuthorizeInput>

export const CallbackInput = Schema.Struct({
  method: Schema.Finite.annotate({ description: "Auth method index" }),
  code: Schema.optional(Schema.String).annotate({ description: "OAuth authorization code" }),
})
export type CallbackInput = Schema.Schema.Type<typeof CallbackInput>

export class OauthMissing extends Schema.TaggedErrorClass<OauthMissing>()("ProviderAuthOauthMissing", {
  providerID: ProviderV2.ID,
}) {}

export class OauthCodeMissing extends Schema.TaggedErrorClass<OauthCodeMissing>()("ProviderAuthOauthCodeMissing", {
  providerID: ProviderV2.ID,
}) {}

export class OauthCallbackFailed extends Schema.TaggedErrorClass<OauthCallbackFailed>()(
  "ProviderAuthOauthCallbackFailed",
  {},
) {}

export class ValidationFailed extends Schema.TaggedErrorClass<ValidationFailed>()("ProviderAuthValidationFailed", {
  field: Schema.String,
  message: Schema.String,
}) {}

export type Error = Auth.AuthError | OauthMissing | OauthCodeMissing | OauthCallbackFailed | ValidationFailed

type Hook = NonNullable<Hooks["auth"]>

/** The sign-in methods Vector offers for a provider, as the app, TUI and CLI list them. */
export function visibleMethods(hook: Hook) {
  ProcessIsolation.assertExternalValueAllowed(hook)
  if (!providerEnabled(hook.provider)) return []
  return hook.methods.filter((method) => method.type !== "oauth" || pluginOAuthAllowed(hook))
}

// Clients choose a method by its index in a list they may have read before the owner's remote ChatGPT switch
// turned off. While this build offers Sign in with ChatGPT at all, OpenAI's indexes therefore keep counting the
// ChatGPT methods when the switch hides them, so a stale choice is refused instead of landing on the method that
// moved into its place.
function indexedMethods(hook: Hook) {
  if (hook.provider !== ProviderV2.ID.openai || !chatgptOAuthConfiguration(process.env, true))
    return visibleMethods(hook)
  return providerEnabled(hook.provider) ? hook.methods : []
}

export interface Interface {
  readonly methods: () => Effect.Effect<Methods>
  readonly authorize: (
    input: {
      providerID: ProviderV2.ID
    } & AuthorizeInput,
  ) => Effect.Effect<Authorization | undefined, Error>
  readonly callback: (input: { providerID: ProviderV2.ID } & CallbackInput) => Effect.Effect<void, Error>
}

interface State {
  hooks: Record<ProviderV2.ID, Hook>
  pending: Map<ProviderV2.ID, AuthOAuthResult>
}

export class Service extends Context.Service<Service, Interface>()("@vector/ProviderAuth") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, Auth.Service | Plugin.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("ProviderAuth.state")(function* () {
        const plugins = yield* plugin.list()
        const result = {
          hooks: Record.fromEntries(
            Arr.filterMap(plugins, (hook) => {
              ProcessIsolation.assertExternalValueAllowed(hook)
              const value = hook.auth
              if (value?.provider === undefined) return Result.failVoid
              if (ProcessIsolation.isExternalCode(hook)) ProcessIsolation.markExternalCode(value)
              return Result.succeed([ProviderV2.ID.make(value.provider), value] as const)
            }),
          ),
          pending: new Map<ProviderV2.ID, AuthOAuthResult>(),
        }
        return plugins.some((hook) => ProcessIsolation.isExternalCode(hook))
          ? ProcessIsolation.markExternalCode(result)
          : result
      }),
    )
    const authState = InstanceState.get(state).pipe(
      Effect.tap((value) => Effect.sync(() => ProcessIsolation.assertExternalValueAllowed(value))),
    )

    const decode = Schema.decodeUnknownSync(Methods)
    const methods = Effect.fn("ProviderAuth.methods")(function* () {
      const hooks = (yield* authState).hooks
      return decode(
        Record.map(hooks, (item, providerID) =>
          visibleMethods(item).map((method) => ({
            type: method.type,
            label: method.label,
            ...(method.prompts && {
              prompts: method.prompts.map((prompt) => {
                if (prompt.type === "select") {
                  return {
                    type: "select" as const,
                    key: prompt.key,
                    message: prompt.message,
                    options: prompt.options,
                    ...(prompt.when && { when: prompt.when }),
                  }
                }
                return {
                  type: "text" as const,
                  key: prompt.key,
                  message: prompt.message,
                  ...(prompt.placeholder && { placeholder: prompt.placeholder }),
                  ...(prompt.when && { when: prompt.when }),
                }
              }),
            }),
          })),
        ),
      )
    })

    const authorize = Effect.fn("ProviderAuth.authorize")(function* (
      input: { providerID: ProviderV2.ID } & AuthorizeInput,
    ) {
      const snapshot = yield* authState
      const { hooks, pending } = snapshot
      if (!providerEnabled(input.providerID)) {
        return yield* new ValidationFailed({
          field: "providerID",
          message: `${input.providerID} sign-in is currently paused in Vector. Choose another provider.`,
        })
      }
      // The owner can switch ChatGPT sign-in off from vectordev.ai; read the switch before choosing the method.
      if (input.providerID === ProviderV2.ID.openai) yield* Effect.promise(() => ProviderRemotePolicy.check(true))
      ProcessIsolation.assertExternalValueAllowed(snapshot)
      const method = Object.hasOwn(hooks, input.providerID)
        ? indexedMethods(hooks[input.providerID])[input.method]
        : undefined
      if (!method) {
        return yield* new ValidationFailed({
          field: "method",
          message: `No authentication method is available at index ${input.method} for ${input.providerID}.`,
        })
      }
      if (method.type !== "oauth") return
      if (input.providerID === ProviderV2.ID.openai && !pluginOAuthAllowed(hooks[input.providerID]))
        return yield* new ValidationFailed({ field: "providerID", message: CHATGPT_SIGN_IN_UNAVAILABLE })

      if (method.prompts && input.inputs) {
        for (const prompt of method.prompts) {
          ProcessIsolation.assertExternalValueAllowed(snapshot)
          if (prompt.type === "text" && prompt.validate && input.inputs[prompt.key] !== undefined) {
            const error = prompt.validate(input.inputs[prompt.key])
            if (error) return yield* new ValidationFailed({ field: prompt.key, message: error })
          }
        }
      }

      const result = yield* Effect.promise(async () => {
        ProcessIsolation.assertExternalValueAllowed(snapshot)
        const value = await method.authorize(input.inputs)
        ProcessIsolation.assertExternalValueAllowed(snapshot)
        return ProcessIsolation.isExternalCode(snapshot) ? ProcessIsolation.markExternalCode(value) : value
      })
      ProcessIsolation.assertExternalValueAllowed(snapshot)
      ProcessIsolation.assertExternalValueAllowed(result)
      pending.set(input.providerID, result)
      return {
        url: result.url,
        method: result.method,
        instructions: result.instructions,
      }
    })

    const callback = Effect.fn("ProviderAuth.callback")(function* (
      input: { providerID: ProviderV2.ID } & CallbackInput,
    ) {
      const snapshot = yield* authState
      const current = Object.hasOwn(snapshot.hooks, input.providerID) ? snapshot.hooks[input.providerID] : undefined
      // An allowed provider without a hook has no OAuth attempt; a paused or revoked
      // hook must still be rejected before looking up or running its callback.
      if (current ? !pluginOAuthAllowed(current) : !providerOAuthAllowed(input.providerID, true)) {
        return yield* new ValidationFailed({
          field: "providerID",
          message:
            input.providerID === ProviderV2.ID.openai
              ? CHATGPT_SIGN_IN_UNAVAILABLE
              : `${input.providerID} sign-in is currently paused in Vector. Use an API key or another provider.`,
        })
      }
      const match = snapshot.pending.get(input.providerID)
      if (!match) return yield* new OauthMissing({ providerID: input.providerID })
      ProcessIsolation.assertExternalValueAllowed(match)
      if (match.method === "code" && !input.code) {
        return yield* new OauthCodeMissing({ providerID: input.providerID })
      }

      const result = yield* Effect.promise(async () => {
        ProcessIsolation.assertExternalValueAllowed(snapshot)
        ProcessIsolation.assertExternalValueAllowed(match)
        const value = await (match.method === "code" ? match.callback(input.code!) : match.callback())
        ProcessIsolation.assertExternalValueAllowed(snapshot)
        ProcessIsolation.assertExternalValueAllowed(match)
        return value
      })
      ProcessIsolation.assertExternalValueAllowed(snapshot)
      ProcessIsolation.assertExternalValueAllowed(match)
      if (!result || result.type !== "success") return yield* new OauthCallbackFailed({})

      if ("key" in result) {
        yield* Effect.suspend(() => {
          ProcessIsolation.assertExternalValueAllowed(snapshot)
          ProcessIsolation.assertExternalValueAllowed(match)
          return auth.set(input.providerID, {
            type: "api",
            key: result.key,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          })
        })
      }

      if ("refresh" in result) {
        const { type: _, provider: __, refresh, access, expires, ...extra } = result
        yield* Effect.suspend(() => {
          ProcessIsolation.assertExternalValueAllowed(snapshot)
          ProcessIsolation.assertExternalValueAllowed(match)
          return auth.set(input.providerID, {
            type: "oauth",
            access,
            refresh,
            expires,
            ...extra,
          })
        })
      }
    })

    return Service.of({ methods, authorize, callback })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Auth.node, Plugin.node] })

export * as ProviderAuth from "./auth"
