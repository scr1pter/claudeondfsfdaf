import { beforeEach, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"
import { Effect } from "effect"
import { ChildEnvironment } from "@vectordevai/core/child-environment"
import { cliIt } from "../lib/cli-process"

// `vector memory skills` and `vector memory workflow` as a user runs them: the real CLI in a process of its own, with
// its own home and data folder, in a git repository of its own. No command drafts a skill, so one comes in the way a
// user brings one from another computer: an export read back with `vector memory import`, which waits for review.

const IMPORT = [
  "## Skills",
  "",
  "### learned-bun-typecheck-src",
  "",
  "When bun typecheck fails in src: steps that made it pass here before.",
  "",
  "- checks: `bun typecheck`",
  "- commands: `git diff src`",
  "- paths: `src/a.ts`",
  "",
  "```markdown",
  "## Steps",
  "1. Run `bun typecheck`.",
  "2. Read src/a.ts and fix the type.",
  "```",
  "",
].join("\n")

// The CLI runs as the owner runs it in their own terminal: without the agent marker, which every child of a process
// that resolved Vector Local otherwise inherits, and under which these commands refuse.
beforeEach(() => {
  ChildEnvironment.inherit({ agent: false })
})

cliIt.live(
  "lists, approves and shares a learned skill, and shows and resets workflow insights",
  (fixture) =>
    Effect.gen(function* () {
      const root = path.join(fixture.home, "repo")
      yield* Effect.promise(async () => {
        await fs.mkdir(root, { recursive: true })
        await $`git init -q && git -c user.email=test@vector.test -c user.name=Test commit -q --allow-empty -m root`
          .cwd(root)
          .quiet()
        await fs.writeFile(path.join(root, "skills.md"), IMPORT)
      })
      const vector = (args: string[]) =>
        fixture.vector.spawn(["memory", ...args], {
          cwd: root,
          env: { VECTOR_AGENT_DB: path.join(fixture.home, "vector.db") },
          timeoutMs: 60_000,
        })

      fixture.vector.expectExit(yield* vector(["import", "skills.md"]), 0, "vector memory import")
      const waiting = yield* vector(["skills", "--review", "--json"])
      fixture.vector.expectExit(waiting, 0, "vector memory skills --review")
      const [draft] = JSON.parse(waiting.stdout) as { id: string; status: string; skill: { name: string } }[]
      expect(draft).toMatchObject({ status: "proposed", skill: { name: "learned-bun-typecheck-src" } })
      // In use, there is nothing yet; the list says so in words.
      const empty = yield* vector(["skills"])
      fixture.vector.expectExit(empty, 0, "vector memory skills")
      expect(empty.stdout + empty.stderr).toContain("Vector has not learned a skill here yet.")

      // A draft is shared only once the owner approved it.
      const early = yield* vector(["skills", "share", draft!.id, "--yes"])
      fixture.vector.expectExit(early, 1, "vector memory skills share before approval")
      expect(early.stdout + early.stderr).toContain("Approve the skill yourself before sharing it")
      fixture.vector.expectExit(yield* vector(["skills", "approve", draft!.id]), 0, "vector memory skills approve")
      const shared = yield* vector(["skills", "share", draft!.id, "--yes"])
      fixture.vector.expectExit(shared, 0, "vector memory skills share --yes")
      // It prints the file before it writes it, then how to commit it and trust the settings again.
      expect(shared.stdout).toContain("name: learned-bun-typecheck-src")
      expect(shared.stdout + shared.stderr).toContain("git add .vector/skills/learned-bun-typecheck-src/SKILL.md")
      expect(shared.stdout + shared.stderr).toContain("run `vector trust approve` in a terminal outside Vector")
      const file = yield* Effect.promise(() =>
        fs.readFile(path.join(root, ".vector/skills/learned-bun-typecheck-src/SKILL.md"), "utf8"),
      )
      expect(file).toContain('  version: "1"')
      expect(file).toContain("2. Read src/a.ts and fix the type.")

      const insights = yield* vector(["workflow", "--json"])
      fixture.vector.expectExit(insights, 0, "vector memory workflow --json")
      expect(JSON.parse(insights.stdout)).toMatchObject({
        mode: "apply",
        explore: false,
        tiers: [
          { tier: "light", arms: [], excluded: 0 },
          { tier: "standard", arms: [], excluded: 0 },
          { tier: "thorough", arms: [], excluded: 0 },
        ],
      })
      const thorough = yield* vector(["workflow", "--tier", "thorough", "--json"])
      expect(JSON.parse(thorough.stdout).tiers.map((item: { tier: string }) => item.tier)).toEqual(["thorough"])
      const unconfirmed = yield* vector(["workflow", "reset"])
      fixture.vector.expectExit(unconfirmed, 1, "vector memory workflow reset without --yes")
      expect(unconfirmed.stdout + unconfirmed.stderr).toContain("Run it again with --yes to confirm.")
      const reset = yield* vector(["workflow", "reset", "--yes"])
      fixture.vector.expectExit(reset, 0, "vector memory workflow reset --yes")
      expect(reset.stdout + reset.stderr).toContain("Forgot 0 runs")
    }),
  180_000,
)
