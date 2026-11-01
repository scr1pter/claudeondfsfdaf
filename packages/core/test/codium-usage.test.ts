import { expect, test } from "bun:test"
import { CodiumUsage } from "../src/codium-usage"

test("keeps own unknown work separate and never quantifies Codium", () => {
  expect(CodiumUsage.withCodium(undefined, 9)).toBe("Codium")
  expect(CodiumUsage.withCodium("$0.12", 9)).toBe("$0.12 + Codium")
  expect(CodiumUsage.withCodium("Cost unknown", 9)).toBe("Cost unknown + Codium")
  expect(CodiumUsage.withCodium("free", 0)).toBe("free")
  expect(CodiumUsage.ownUnpricedSteps(11, 9)).toBe(2)
  expect(CodiumUsage.ownUnpricedSteps(undefined, 9)).toBe(0)
})
