import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "@/provider/transform"

const eligible = {
  setting: undefined,
  providerID: "openai",
  npm: "@ai-sdk/openai",
  modelID: "gpt-6.1-sol",
  apiKey: true,
  url: "https://api.openai.com/v1",
}

describe("Responses cache default eligibility", () => {
  test("defaults on only for the exact supported official API path", () => {
    for (const url of [
      undefined,
      "https://api.openai.com/v1",
      "https://api.openai.com/v1/",
      "https://api.openai.com/v1/responses",
    ]) {
      expect(ProviderTransform.promptCacheBreakpointsEnabled({ ...eligible, url })).toBe(true)
    }
  })

  test("explicit false opts out even on the supported official path", () => {
    expect(ProviderTransform.promptCacheBreakpointsEnabled({ ...eligible, setting: false })).toBe(false)
  })

  test("default official eligibility rejects query strings and fragments", () => {
    for (const url of ["https://api.openai.com/v1?preview=true", "https://api.openai.com/v1#preview"]) {
      expect(ProviderTransform.promptCacheBreakpointsEnabled({ ...eligible, url })).toBe(false)
    }
  })

  test("reviewed loopback destinations require explicit true", () => {
    for (const url of [
      "http://127.0.0.1:1234/v1",
      "http://[::1]:1234/v1",
      "http://127.0.0.1:1234/v1?preview=true#local",
    ]) {
      expect(ProviderTransform.promptCacheBreakpointsEnabled({ ...eligible, url })).toBe(false)
      expect(ProviderTransform.promptCacheBreakpointsEnabled({ ...eligible, url, setting: true })).toBe(true)
      expect(ProviderTransform.promptCacheBreakpointsEnabled({ ...eligible, url, setting: false })).toBe(false)
    }
  })

  test("does not activate on proxies, lookalike domains or unreviewed routes", () => {
    for (const url of [
      "https://proxy.example/v1",
      "https://api.openai.com.example/v1",
      "http://api.openai.com/v1",
      "https://api.openai.com:8443/v1",
      "https://api.openai.com/other",
      "https://user:password@api.openai.com/v1",
      "http://localhost:1234/v1",
      "not a URL",
    ]) {
      expect(ProviderTransform.promptCacheBreakpointsEnabled({ ...eligible, url })).toBe(false)
      expect(ProviderTransform.promptCacheBreakpointsEnabled({ ...eligible, url, setting: true })).toBe(false)
    }
  })

  test("requires exact model, SDK, provider and API-key eligibility", () => {
    for (const patch of [
      { providerID: "azure" },
      { npm: "@ai-sdk/openai-compatible" },
      { modelID: "gpt-6.2-sol" },
      { apiKey: false },
      { setting: "true" },
      { setting: null },
      { url: new URL("https://api.openai.com/v1") },
    ]) {
      expect(ProviderTransform.promptCacheBreakpointsEnabled({ ...eligible, ...patch })).toBe(false)
    }
  })
})
