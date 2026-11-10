import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SystemPrompt } from "../../../packages/engine/src/session/system"
import { AGENT_PROMPTS, DIR, HARNESS_BASE, REPO_ROOT, load, render, type Variant } from "./variants"

const root = await mkdtemp(join(tmpdir(), "prompt-evolve-variants-"))
afterAll(() => rm(root, { recursive: true, force: true }))

const claude = { api: { id: "claude-sonnet-4-5" } } as Parameters<typeof SystemPrompt.provider>[0]
const identity = (await load(DIR)).find((variant) => variant.id === "identity")!
const variant = (extra: Partial<Variant>): Variant => ({ ...identity, id: "test", ...extra })

describe("variants", () => {
  test("identity is the provider prompt byte for byte, with and without explore", async () => {
    expect(identity.base).toBe(HARNESS_BASE)
    for (const explore of [true, false])
      expect(await render(identity, { explore })).toBe(SystemPrompt.provider(claude, explore).join(""))
    expect(await render(identity, { explore: false })).not.toBe(await render(identity, { explore: true }))
  })

  test("the explore rewrite applies to a provider prompt, never to a specialist's own prompt", async () => {
    const text = 'Search with subagent_type "explore" first.'
    expect(await render(variant({ text }), { explore: false })).toBe(
      "Search with a search specialist from the task tool's list first.",
    )
    expect(await render(variant({ text, base: `${AGENT_PROMPTS}/general.txt` }), { explore: false })).toBe(text)
  })

  test("a patch replaces text that occurs exactly once, and anything else throws", async () => {
    const base = await Bun.file(join(REPO_ROOT, HARNESS_BASE)).text()
    const patched = await render(variant({ patches: [{ find: "# Code References", replace: "# References" }] }), {
      explore: true,
    })
    expect(patched).toBe(base.replace("# Code References", "# References"))
    // `$&` in a replacement is text, not a back-reference.
    expect(await render(variant({ text: "a b", patches: [{ find: "b", replace: "$&$&" }] }), { explore: true })).toBe(
      "a $&$&",
    )
    await expect(render(variant({ patches: [{ find: "Vector", replace: "V" }] }), { explore: true })).rejects.toThrow(
      "matches",
    )
    await expect(
      render(variant({ patches: [{ find: "no such sentence", replace: "x" }] }), { explore: true }),
    ).rejects.toThrow("0 times")
    await expect(render(variant({ patches: [{ find: "", replace: "x" }] }), { explore: true })).rejects.toThrow(
      "exactly once",
    )
  })

  test("load reads a folder of variants, resolves a file beside its variant, and refuses bad ones", async () => {
    const good = join(root, "good")
    await mkdir(good, { recursive: true })
    await writeFile(join(good, "short.txt"), "Be brief.")
    await writeFile(join(good, "short.json"), JSON.stringify({ ...identity, id: "short", file: "short.txt" }))
    const [short] = await load(good)
    expect(short!.file).toBe(join(good, "short.txt"))
    expect(await render(short!, { explore: true })).toBe("Be brief.")

    const refused = async (name: string, value: Record<string, unknown>, again?: Record<string, unknown>) => {
      const dir = join(root, name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "a.json"), JSON.stringify(value))
      if (again) await writeFile(join(dir, "b.json"), JSON.stringify(again))
      return load(dir).then(
        () => "loaded",
        (error: Error) => error.message,
      )
    }
    expect(await refused("outside", { ...identity, base: "README.md" })).toContain("built-in prompt")
    expect(await refused("both", { ...identity, text: "a", file: "b.txt" })).toContain("not both")
    expect(await refused("twice", identity, identity)).toContain("Two variants")
    expect(await refused("id", { ...identity, id: "Not An Id" })).toContain("lowercase")
  })
})
