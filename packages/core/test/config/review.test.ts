import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { mergeReviewConfig } from "@vectordevai/core/review/config"
import { ConfigV1 } from "@vectordevai/core/v1/config/config"
import { ConfigReviewV1 } from "@vectordevai/core/v1/config/review"

// VS-23d (SF-15): the hidden `review` block of the user's global config. It decodes whatever its three keys hold, so a
// value the strict decoder would refuse never drops the whole user config (which would lower privacy), and the block
// read as mergeReviewConfig's `global` only raises what review.json and the environment ask.

const strict = { errors: "all", onExcessProperty: "error" } as const
const decode = (value: unknown) => Schema.decodeUnknownSync(ConfigV1.Info)(value, strict)

describe("the global review block (VS-23d)", () => {
  test("decodes privacy, holdback and zdrAttested strictly, keeping every value as written", () => {
    const review = {
      privacy: "zdr",
      holdback: "secrets",
      zdrAttested: ["openrouter", { id: "acme", operator: "aws" }],
    }
    expect(decode({ review }).review).toEqual(review)
    expect(Schema.decodeUnknownSync(ConfigReviewV1.Info)(review, strict)).toEqual(review)
  })

  test("a value that is not a level, or not a list, still decodes, so the user config is never dropped", () => {
    const loose = [
      { privacy: " ZDR ", holdback: "maybe" },
      { privacy: 1, holdback: true, zdrAttested: "openrouter" },
      { privacy: { level: "zdr" }, holdback: null, zdrAttested: { id: "acme" } },
      {},
    ]
    for (const review of loose) expect(decode({ model: "acme/coder", review })).toEqual({ model: "acme/coder", review })
  })

  test("a key outside the three is dropped, VS-30's runtime among them", () => {
    const decoded = Schema.decodeUnknownSync(ConfigV1.Info)({ review: { privacy: "zdr", runtime: "ask", other: 1 } })
    expect(decoded.review).toEqual({ privacy: "zdr" })
  })

  test("a config without the block decodes as before", () => {
    const config = { model: "acme/coder", experimental: { vectorscope: true } }
    expect(decode(config)).toEqual(config)
    expect(Object.hasOwn(decode(config), "review")).toBe(false)
  })

  test("as mergeReviewConfig's global it raises privacy and holdback, which no repository or environment lowers", () => {
    const global = decode({ review: { privacy: "zdr", holdback: "secrets", zdrAttested: ["openrouter"] } }).review
    const jsons = [undefined, '{"privacy":"standard","holdback":"off"}', '{"privacy":"zdr"}', "{"]
    const envs = [{}, { REVIEW_PRIVACY: "standard", REVIEW_HOLDBACK: "off" }]
    for (const text of jsons)
      for (const env of envs)
        for (const at of ["base", "working-tree"] as const) {
          const merged = mergeReviewConfig({ surface: "local", global, json: { at, text }, env, trigger: "local" })
          expect({ text, env, at, privacy: merged.config.privacy, holdback: merged.config.holdback }).toEqual({
            text,
            env,
            at,
            privacy: "zdr",
            holdback: "secrets",
          })
          // zdrAttested is trusted from the global config on "local", whatever the repository says.
          expect(merged.config.zdrAttested).toEqual(["openrouter"])
        }
    // A value that is not a level reads as the strictest, with a warning.
    const odd = mergeReviewConfig({ surface: "local", global: decode({ review: { privacy: 1 } }).review })
    expect(odd.config.privacy).toBe("zdr")
    expect(odd.warnings).toEqual([
      'review.privacy in the global config must be "standard" or "zdr"; using "zdr", the stricter setting.',
    ])
  })

  test("an empty or standard block reads as no block at all", () => {
    const none = mergeReviewConfig({ surface: "local", json: { at: "working-tree", text: '{"verify":"off"}' } })
    for (const review of [{}, { privacy: "standard", holdback: "off" }, { zdrAttested: [] }]) {
      const global = decode({ review }).review
      expect(
        mergeReviewConfig({ surface: "local", global, json: { at: "working-tree", text: '{"verify":"off"}' } }),
      ).toEqual(none)
    }
  })
})
