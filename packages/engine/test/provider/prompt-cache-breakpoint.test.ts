import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "@/provider/transform"

const stable = "Stable policy α\nwith an exact boundary."
const rest = "\nSession-specific context."
const original = {
  model: "gpt-6.1-sol",
  input: [
    { role: "developer", content: stable + rest },
    { role: "user", content: "Question" },
  ],
  tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
  reasoning: { effort: "medium" },
  prompt_cache_key: "unchanged-session",
}
const transform = (body: unknown = original, options: { enabled?: boolean; url?: string; marker?: string } = {}) =>
  ProviderTransform.promptCacheBreakpointBody({
    enabled: options.enabled ?? true,
    url: options.url ?? "https://api.openai.com/v1/responses",
    marker: options.marker ?? ProviderTransform.promptCachePrefix(stable),
    body: JSON.stringify(body),
  })

describe("opt-in Responses stable-prefix breakpoint", () => {
  test("preserves all text, roles, order, tools, reasoning and the cache key", () => {
    const body = JSON.parse(transform()!)
    expect(body).toEqual({
      ...original,
      input: [
        {
          role: "developer",
          content: [
            { type: "input_text", text: stable, prompt_cache_breakpoint: { mode: "explicit", ttl: "30m" } },
            { type: "input_text", text: rest },
          ],
        },
        original.input[1],
      ],
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
    })
    expect(body.input[0].content.map((part: { text: string }) => part.text).join("")).toBe(stable + rest)
  })

  test("splits an exact prefix across existing text parts without dropping their metadata", () => {
    const body = JSON.parse(
      transform({
        ...original,
        input: [
          {
            role: "system",
            content: [
              { type: "input_text", text: stable.slice(0, 5), annotation: "keep" },
              { type: "input_text", text: stable.slice(5) + rest, annotation: "also keep" },
            ],
          },
        ],
      })!,
    )
    expect(body.input[0].role).toBe("system")
    expect(body.input[0].content).toEqual([
      { type: "input_text", text: stable.slice(0, 5), annotation: "keep" },
      {
        type: "input_text",
        text: stable.slice(5),
        annotation: "also keep",
        prompt_cache_breakpoint: { mode: "explicit", ttl: "30m" },
      },
      { type: "input_text", text: rest, annotation: "also keep" },
    ])
  })

  test("is default-off, model-specific, exact-boundary checked and destination constrained", () => {
    expect(transform(original, { enabled: false })).toBeUndefined()
    expect(transform(original, { marker: ProviderTransform.promptCachePrefix("changed") })).toBeUndefined()
    expect(transform({ ...original, model: "gpt-6.2-sol" })).toBeUndefined()
    for (const url of [
      "https://proxy.example/v1/responses",
      "http://api.openai.com/v1/responses",
      "https://api.openai.com/v1/chat/completions",
      "http://localhost:123/v1/responses",
    ])
      expect(transform(original, { url })).toBeUndefined()
    for (const url of ["http://127.0.0.1:123/v1/responses", "http://[::1]:123/v1/responses"])
      expect(transform(original, { url })).toBeDefined()
  })

  test("declines malformed content and existing cache policies instead of overriding them", () => {
    for (const body of [
      { ...original, prompt_cache_options: { mode: "explicit" } },
      { ...original, prompt_cache_retention: "24h" },
      { ...original, input: [{ role: "user", content: stable + rest }] },
      { ...original, input: [{ role: "developer", content: [{ type: "input_image", image_url: "x" }] }] },
      {
        ...original,
        input: [
          {
            role: "developer",
            content: [{ type: "input_text", text: stable, prompt_cache_breakpoint: { mode: "explicit" } }],
          },
        ],
      },
    ])
      expect(transform(body)).toBeUndefined()
  })

  test("leaves existing later-item breakpoints unchanged, including mixed TTL policies", () => {
    for (const ttl of ["30m", "12h"]) {
      const body = {
        ...original,
        input: [
          original.input[0],
          {
            role: "user",
            content: [{ type: "input_text", text: "Question", prompt_cache_breakpoint: { mode: "explicit", ttl } }],
          },
        ],
      }
      expect(transform(body)).toBeUndefined()
    }
    expect(
      transform({
        ...original,
        input: [...original.input, { role: "developer", content: "Later policy", prompt_cache_breakpoint: {} }],
      }),
    ).toBeUndefined()
  })
})
