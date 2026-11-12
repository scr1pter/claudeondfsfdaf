export * as PluginHost from "./host"

import type { PluginContext as Interface } from "@vectordevai/plugin/v2/effect"
import { Effect, Schema } from "effect"
import { AgentV2 } from "../agent"
import { AISDK } from "../aisdk"
import { Catalog } from "../catalog"
import { CommandV2 } from "../command"
import { Credential } from "../credential"
import { Integration } from "../integration"
import { ModelV2 } from "../model"
import { PluginV2 } from "../plugin"
import { ProviderV2 } from "../provider"
import { Reference } from "../reference"
import type { DeepMutable } from "../schema"
import { SkillV2 } from "../skill"
import { ProcessIsolation } from "../process-isolation"

const mutable = <T>(value: T) => value as DeepMutable<T>

function sourceEffect<A, E, R>(external: boolean, run: () => Effect.Effect<A, E, R>) {
  return Effect.suspend(() => {
    if (external) ProcessIsolation.assertExternalCodeAllowed()
    return run().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (external) ProcessIsolation.assertExternalCodeAllowed()
        }),
      ),
    )
  })
}

export const make = Effect.fn("PluginHost.make")(function* (plugin: PluginV2.Interface) {
  const agents = yield* AgentV2.Service
  const aisdk = yield* AISDK.Service
  const catalog = yield* Catalog.Service
  const commands = yield* CommandV2.Service
  const integration = yield* Integration.Service
  const reference = yield* Reference.Service
  const skill = yield* SkillV2.Service

  return {
    options: {},
    agent: {
      reload: agents.reload,
      transform: (callback) =>
        agents.transform((draft) =>
          callback({
            list: () => mutable(draft.list()),
            get: (id) => mutable(draft.get(AgentV2.ID.make(id))),
            default: (id) => draft.default(id === undefined ? undefined : AgentV2.ID.make(id)),
            update: (id, update) => draft.update(AgentV2.ID.make(id), update),
            remove: (id) => draft.remove(AgentV2.ID.make(id)),
          }),
        ),
    },
    aisdk: {
      sdk: (callback) => {
        const adapter: Parameters<AISDK.Interface["hook"]["sdk"]>[0] = (event) => {
          const output = {
            model: mutable(event.model),
            package: event.package,
            options: event.options,
            sdk: event.sdk,
          }
          const result = callback(output)
          return Effect.suspend(() => (Effect.isEffect(result) ? result : Effect.void)).pipe(
            Effect.tap(() => Effect.sync(() => (event.sdk = output.sdk))),
          )
        }
        if (ProcessIsolation.isExternalCode(callback)) ProcessIsolation.markExternalCode(adapter)
        return aisdk.hook.sdk(adapter)
      },
      language: (callback) => {
        const adapter: Parameters<AISDK.Interface["hook"]["language"]>[0] = (event) => {
          const output = {
            model: mutable(event.model),
            sdk: event.sdk,
            options: event.options,
            language: event.language,
          }
          const result = callback(output)
          return Effect.suspend(() => (Effect.isEffect(result) ? result : Effect.void)).pipe(
            Effect.tap(() => Effect.sync(() => (event.language = output.language))),
          )
        }
        if (ProcessIsolation.isExternalCode(callback)) ProcessIsolation.markExternalCode(adapter)
        return aisdk.hook.language(adapter)
      },
    },
    catalog: {
      reload: catalog.reload,
      transform: (callback) =>
        catalog.transform((draft) =>
          callback({
            provider: {
              list: () => mutable(draft.provider.list()),
              get: (id) => mutable(draft.provider.get(ProviderV2.ID.make(id))),
              update: (id, update) => draft.provider.update(ProviderV2.ID.make(id), update),
              remove: (id) => draft.provider.remove(ProviderV2.ID.make(id)),
            },
            model: {
              get: (providerID, modelID) =>
                mutable(draft.model.get(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID))),
              update: (providerID, modelID, update) =>
                draft.model.update(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID), update),
              remove: (providerID, modelID) =>
                draft.model.remove(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
              default: {
                get: draft.model.default.get,
                set: (providerID, modelID) =>
                  draft.model.default.set(ProviderV2.ID.make(providerID), ModelV2.ID.make(modelID)),
              },
            },
          }),
        ),
    },
    command: {
      reload: commands.reload,
      transform: commands.transform,
    },
    integration: {
      reload: integration.reload,
      connection: {
        active: (id) => integration.connection.active(Integration.ID.make(id)),
        resolve: (connection) =>
          integration.connection.resolve(
            connection.type === "credential" ? { ...connection, id: Credential.ID.make(connection.id) } : connection,
          ),
      },
      transform: (callback) =>
        integration.transform((draft) =>
          callback({
            list: () => mutable(draft.list()),
            get: (id) => mutable(draft.get(Integration.ID.make(id))),
            update: (id, update) => draft.update(Integration.ID.make(id), update),
            remove: (id) => draft.remove(Integration.ID.make(id)),
            method: {
              list: (id) => mutable(draft.method.list(Integration.ID.make(id))),
              update: (input) => {
                if ("authorize" in input) {
                  const methodID = Integration.MethodID.make(input.method.id)
                  const refresh = input.refresh
                  const external = ProcessIsolation.isExternalCode(callback)
                  const implementation: Integration.OAuthImplementation = {
                    integrationID: Integration.ID.make(input.integrationID),
                    method: { ...input.method, id: methodID },
                    authorize: (inputs) =>
                      sourceEffect(external, () => input.authorize(inputs)).pipe(
                        Effect.map((authorization) => {
                          if (external) ProcessIsolation.assertExternalCodeAllowed()
                          if (authorization.mode === "auto") {
                            const value: Integration.OAuthAuthorization = {
                              ...authorization,
                              callback: sourceEffect(external, () => authorization.callback).pipe(
                                Effect.map((credential) =>
                                  credential.type === "key"
                                    ? Credential.Key.make(credential)
                                    : Credential.OAuth.make({
                                        ...credential,
                                        methodID: Integration.MethodID.make(credential.methodID),
                                      }),
                                ),
                              ),
                            }
                            if (external) {
                              ProcessIsolation.markExternalCode(value.callback)
                              ProcessIsolation.markExternalCode(value)
                            }
                            return value
                          }
                          const value: Integration.OAuthAuthorization = {
                            ...authorization,
                            callback: (code: string) =>
                              sourceEffect(external, () => authorization.callback(code)).pipe(
                                Effect.map((credential) =>
                                  credential.type === "key"
                                    ? Credential.Key.make(credential)
                                    : Credential.OAuth.make({
                                        ...credential,
                                        methodID: Integration.MethodID.make(credential.methodID),
                                      }),
                                ),
                              ),
                          }
                          if (external) {
                            ProcessIsolation.markExternalCode(value.callback)
                            ProcessIsolation.markExternalCode(value)
                          }
                          return value
                        }),
                      ),
                    ...(refresh
                      ? {
                          refresh: (value: Credential.OAuth) =>
                            sourceEffect(external, () => refresh(value)).pipe(
                              Effect.map((next) =>
                                Credential.OAuth.make({
                                  ...next,
                                  methodID: Integration.MethodID.make(next.methodID),
                                }),
                              ),
                            ),
                        }
                      : {}),
                    ...(input.label
                      ? {
                          label: (value: Credential.OAuth) => {
                            if (external) ProcessIsolation.assertExternalCodeAllowed()
                            const result = input.label!(value)
                            if (external) ProcessIsolation.assertExternalCodeAllowed()
                            return result
                          },
                        }
                      : {}),
                  }
                  if (external) {
                    ProcessIsolation.markExternalCode(implementation)
                    ProcessIsolation.markExternalCode(implementation.authorize)
                    ProcessIsolation.markExternalCode(implementation.refresh)
                    ProcessIsolation.markExternalCode(implementation.label)
                  }
                  draft.method.update(implementation)
                  return
                }
                if (input.method.type === "env") {
                  draft.method.update({
                    integrationID: Integration.ID.make(input.integrationID),
                    method: { type: "env", names: input.method.names },
                  })
                  return
                }
                draft.method.update({
                  integrationID: Integration.ID.make(input.integrationID),
                  method: { type: "key", label: input.method.label },
                })
              },
              remove: (id, method) =>
                draft.method.remove(Integration.ID.make(id), Schema.decodeUnknownSync(Integration.Method)(method)),
            },
          }),
        ),
    },
    plugin: {
      add: (input) => plugin.add(PluginV2.ID.make(input.id), input.effect),
      remove: (id) => plugin.remove(PluginV2.ID.make(id)),
    },
    reference: {
      reload: reference.reload,
      transform: (callback) =>
        reference.transform((draft) =>
          callback({
            add: (name, source) => draft.add(name, Schema.decodeUnknownSync(Reference.Source)(source)),
            remove: draft.remove,
            list: draft.list,
          }),
        ),
    },
    skill: {
      reload: skill.reload,
      transform: (callback) =>
        skill.transform((draft) =>
          callback({
            source: (source) => draft.source(Schema.decodeUnknownSync(SkillV2.Source)(source)),
            list: draft.list,
          }),
        ),
    },
  } satisfies Interface
})
