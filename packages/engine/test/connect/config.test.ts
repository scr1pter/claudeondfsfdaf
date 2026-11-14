import { describe, expect, test } from "bun:test"
import { ConnectConfig } from "../../src/connect/config"
import { ConfigConnectV1 } from "@vectordevai/core/v1/config/connect"
import { Config } from "../../src/config/config"

describe("connected review configuration", () => {
  test("a repository cannot enable automatic work or raise a default cap", () => {
    expect(
      ConnectConfig.repositoryConnect(
        { review: { after_run: "repair", before_commit: "run", max_rounds: 3, max_cost_usd: 20 } },
        undefined,
      ),
    ).toBeUndefined()
    expect(ConfigConnectV1.review()).toEqual({
      after_run: "off",
      before_commit: "offer",
      max_rounds: 1,
      max_cost_usd: 2,
    })
  })
  test("a repository may narrow every user setting", () => {
    expect(
      ConnectConfig.repositoryConnect(
        { review: { after_run: "report", before_commit: "off", max_rounds: 1, max_cost_usd: 0.25 } },
        { review: { after_run: "repair", before_commit: "run", max_rounds: 3, max_cost_usd: 1 } },
      ),
    ).toEqual({ review: { after_run: "report", before_commit: "off", max_rounds: 1, max_cost_usd: 0.25 } })
  })
  test("the real repository-config boundary applies the narrowing whether trusted or not", () => {
    for (const trusted of [true, false]) {
      expect(
        Config.projectExecutableConfig(
          { connect: { review: { after_run: "repair", before_commit: "run", max_cost_usd: 20 } } },
          trusted,
          {},
        ).connect,
      ).toBeUndefined()
      expect(
        Config.projectExecutableConfig({ connect: { review: { after_run: "off", max_cost_usd: 0.25 } } }, trusted, {
          connect: { review: { after_run: "report", max_cost_usd: 1 } },
        }).connect,
      ).toEqual({ review: { after_run: "off", max_cost_usd: 0.25 } })
    }
  })
})
