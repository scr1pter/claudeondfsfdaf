import { expect, test } from "bun:test"
import path from "node:path"
import { modelPlans, publicModelPlans } from "../api/_lib/model-plan-config"
import { CodiumPlan } from "../packages/schema/src/codium-plan"

// Owner rule (23 Oct 2026): Codium's plans are Plus, Pro, Max and Ultra, and nothing anyone reads calls them by their
// price. Owner decision (27 Oct 2026): Codium sells monthly plans only, with no top-ups.
const root = path.resolve(import.meta.dir, "..")
const self = path
  .relative(root, import.meta.path)
  .split(path.sep)
  .join("/")
const retired = [
  /\bCodium (?:10|50|100|200)\b/,
  // A name built from the price, such as `Codium ${price}`.
  /Codium \$\{(?:[\w.]*price|amount)\}/,
  /\bCodium \S+ top-up\b/,
]
const historicalNames = [
  {
    file: "packages/web/scripts/model-plan-setup.ts",
    line: "[`Vector Codium ${plan.price}`, `Vector Codium ${plan.name}`].includes(String(product.name))",
    reason: "Recognize the exact historical monthly product before migrating its name and metadata.",
  },
  {
    file: "packages/web/scripts/model-plan-setup.ts",
    line: "![`Vector Codium ${amount} top-up`, `Vector Codium $${amount} credit top-up`].includes(String(product.name)) ||",
    reason: "Verify the historical top-up product identity before archiving its one-time price.",
  },
  {
    file: "packages/web/test/model-plan-setup.test.ts",
    line: "name: `Vector Codium ${plan.price}`,",
    reason: "Seed the old monthly product so migration tests exercise the actual historical identity.",
  },
  {
    file: "packages/web/test/model-plan-setup.test.ts",
    line: "fake.products.push({ id: `prod_topup${amount}`, active: true, name: `Vector Codium ${amount} top-up`, metadata: {} })",
    reason: "Seed the old top-up product so cleanup tests verify its strict ownership comparison.",
  },
] as const

function retiredNameViolation(file: string, line: string) {
  return (
    retired.some((pattern) => pattern.test(line)) &&
    // A line that describes this check (the build plans do) quotes the names it rejects.
    !line.includes(path.basename(self)) &&
    !historicalNames.some((entry) => entry.file === file && entry.line === line.trim())
  )
}

test("the plans keep their ids and prices and take their new names", () => {
  expect(CodiumPlan.PLANS.map((plan) => [plan.id, plan.price, plan.name])).toEqual([
    ["vector-10", 10, "Plus"],
    ["vector-50", 50, "Pro"],
    ["vector-100", 100, "Max"],
    ["vector-200", 200, "Ultra"],
  ])
  expect(CodiumPlan.PLANS.map((plan) => CodiumPlan.rank(plan.id))).toEqual([1, 2, 3, 4])
  expect(CodiumPlan.TOPUPS).toEqual([])
  expect(CodiumPlan.name("vector-100")).toBe("Max")
  // A top-up id is not a plan, so it has no name.
  expect(CodiumPlan.name("codium-topup-50")).toBeUndefined()
  expect(CodiumPlan.name("vector-20")).toBeUndefined()
  expect(CodiumPlan.FREE).toBe("Free")
})

test("the hosted API names plans from the shared names, under the ids it always sold, and offers no top-up", () => {
  expect(modelPlans().map((plan) => [plan.id, plan.name, plan.price])).toEqual(
    CodiumPlan.PLANS.map((plan) => [plan.id, plan.name, plan.price]),
  )
  const config: { plans: { name: string }[]; topups?: unknown[] } = publicModelPlans()
  expect(config.plans.map((plan) => plan.name)).toEqual(["Plus", "Pro", "Max", "Ultra"])
  expect(config.topups ?? []).toEqual([])
})

test("nothing in the repository calls a plan or a top-up by its old numbered name", async () => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root }).stdout.toString().split("\0")
  const files = listed.filter(
    (file) => /\.(tsx?|jsx?|mjs|cjs|astro|mdx?|json|html|css|ya?ml|txt|sh)$/.test(file) && file !== self,
  )
  const found = (
    await Promise.all(
      files.map(async (file) =>
        (await Bun.file(path.join(root, file)).text())
          .split("\n")
          .flatMap((line, index) => (retiredNameViolation(file, line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
      ),
    )
  ).flat()
  // The scan has to reach the sources it guards, or an empty result would mean nothing.
  expect(files).toContain("packages/web/src/components/marketing/codium/CodiumPricing.tsx")
  expect(files.length).toBeGreaterThan(3000)
  expect(found).toEqual([])
})

test("each documented historical name exception matches exactly one line in its exact file", async () => {
  for (const entry of historicalNames) {
    expect(entry.reason.length).toBeGreaterThan(0)
    const lines = (await Bun.file(path.join(root, entry.file)).text()).split("\n")
    expect(lines.filter((line) => line.trim() === entry.line)).toHaveLength(1)
    expect(retired.some((pattern) => pattern.test(entry.line))).toBe(true)
    expect(retiredNameViolation(entry.file, `  ${entry.line}  `)).toBe(false)
  }
})

test("historical exceptions never permit numbered current product creation or names in other paths", () => {
  for (const line of [
    "name: `Vector Codium ${plan.price}`,",
    "name: `Vector Codium ${amount} top-up`,",
    'name: "Vector Codium 100",',
  ])
    expect(retiredNameViolation("packages/web/scripts/model-plan-setup.ts", line)).toBe(true)
  for (const entry of historicalNames) {
    expect(retiredNameViolation("packages/web/scripts/current-products.ts", entry.line)).toBe(true)
    expect(retiredNameViolation("packages/web/src/components/marketing/codium/CodiumPricing.tsx", entry.line)).toBe(
      true,
    )
    expect(retiredNameViolation(entry.file, `${entry.line} // another use`)).toBe(true)
  }
})

test("the check catches the old names and leaves the new ones alone", () => {
  const caught = (text: string) => retired.some((pattern) => pattern.test(text))
  for (const text of [
    "Start with Codium 10",
    "Get Codium 200",
    "name: `Codium ${price}`",
    "`Vector Codium ${pack.price} top-up`",
    "Buy Codium 50 top-up",
  ])
    expect(caught(text)).toBe(true)
  for (const text of ["Get Plus", "Vector Codium Ultra", "$10 credit top-up", "Codium credits", "Codium 2026"])
    expect(caught(text)).toBe(false)
})
