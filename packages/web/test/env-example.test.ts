import { expect, test } from "bun:test"
import { ENV_NAMES } from "../../../api/_lib/everywhere/config"

// .env.example is where the deploy owner reads what production can set. Every switch and secret the Vector v2
// services read is listed there, each switch off and each secret by name only, so nothing turns on by copying it.
const example = await Bun.file(new URL("../../../.env.example", import.meta.url)).text()
const values = new Map(
  example
    .split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)] as const),
)

const switches = ["VECTOR_EVERYWHERE_ENABLED", "VECTOR_WORKSPACES_ENABLED", "VECTOR_GITHUB_BRAIN_ENABLED"]
const settings = [
  ...Object.values(ENV_NAMES),
  "VECTOR_WORKSPACES_ACCOUNTS",
  "VECTOR_WORKSPACES_ORIGIN",
  "VECTOR_WORKSPACES_SECRET",
  "VECTOR_RUN_TOKEN_SECRET",
  "VECTOR_RUN_ARTIFACT_SECRET",
]

test("every Vector v2 service switch is documented and off", () => {
  for (const name of switches) expect([name, values.get(name)]).toEqual([name, "false"])
})

test("every Vector v2 service setting and secret is documented without a value", () => {
  for (const name of settings.filter((name) => !switches.includes(name) && name !== "CRON_SECRET"))
    expect([name, values.get(name)]).toEqual([name, ""])
  expect(values.has("CRON_SECRET")).toBe(true)
})
