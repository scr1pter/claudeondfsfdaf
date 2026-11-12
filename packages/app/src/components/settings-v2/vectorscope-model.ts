import type { Config } from "@vectordevai/sdk/v2/client"

export type VectorScopeSettings = { model: string; variant: string; disabled: boolean }

export function readVectorScope(config: Config | undefined): VectorScopeSettings | undefined {
  if (!config) return
  const entry = config.agent?.vectorscope
  const model = entry?.model?.trim() ?? ""
  return { model, variant: model ? (entry?.variant?.trim() ?? "") : "", disabled: entry?.disable === true }
}

export function vectorScopePatch(settings: VectorScopeSettings): Config {
  return {
    agent: {
      vectorscope: {
        model: settings.model.trim(),
        variant: settings.model.trim() ? settings.variant.trim() : "",
        disable: settings.disabled,
      },
    },
  }
}

export function vectorScopeKey(settings: VectorScopeSettings) {
  return JSON.stringify([settings.model, settings.variant, settings.disabled])
}

export function vectorScopeLocked(paths: readonly string[]) {
  return paths.some((path) =>
    [
      "agent",
      "agent.vectorscope",
      "agent.vectorscope.model",
      "agent.vectorscope.variant",
      "agent.vectorscope.disable",
    ].includes(path),
  )
}

export function vectorScopeOwner<T>(proof: { sdk: T; provedOwner: boolean } | undefined, current: T, loading: boolean) {
  return proof !== undefined && !loading && proof.sdk === current && proof.provedOwner === true
}
