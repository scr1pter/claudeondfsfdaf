import { describe, expect, test } from "bun:test"
import { LocalHardware } from "../../src/local-mode/hardware"
import { LocalRecommend } from "../../src/local-mode/recommend"
import table from "../../src/local-mode/recommend-table.json"
import { NetworkGuard } from "../lib/network-guard"

const guard = NetworkGuard.use()

const GB = 1024 ** 3

describe("the bundled recommendation table", () => {
  const current = LocalRecommend.table()

  test("carries its date and the licence label", () => {
    expect(current.date).toBe("2026-10")
    expect(current.label).toBe("Examples, October 2026. Check each model's licence.")
    Object.values(current.models).forEach((entry) => expect(entry.licence.length).toBeGreaterThan(0))
  })

  test("links only to a publisher's own repository or the Ollama library", () => {
    const links = Object.values(current.models).flatMap((entry) => entry.links)
    links.forEach((link) => {
      const url = new URL(link)
      expect(url.protocol).toBe("https:")
      const ollama = url.hostname === "ollama.com" && url.pathname.startsWith("/library/")
      const huggingface = url.hostname === "huggingface.co" && url.pathname.split("/").filter(Boolean).length === 2
      expect(ollama || huggingface).toBe(true)
    })
    // An Ollama tag always comes with its library page.
    Object.values(current.models)
      .filter((entry) => entry.ollama)
      .forEach((entry) => expect(entry.links).toContain(`https://ollama.com/library/${entry.ollama!.split(":")[0]}`))
  })

  test("every model a tier names is in the table, and the agent's model fits its tier", () => {
    current.tiers.forEach((tier) => {
      ;[...Object.values(tier.roles), ...tier.alternatives].forEach((key) => expect(current.models[key]).toBeDefined())
      const agent = tier.roles["agent"]
      if (agent) expect(current.models[agent].memory_gb).toBeLessThanOrEqual(tier.min_gb)
      tier.alternatives.forEach((key) => expect(current.models[key].memory_gb).toBeLessThanOrEqual(tier.min_gb))
    })
  })
})

describe("recommendations per memory tier", () => {
  test.each([
    [4, "under-8", undefined, "qwen3-4b"],
    [10, "8", "qwen3-8b", "qwen3-8b"],
    [16, "16", "gpt-oss-20b", "gpt-oss-20b"],
    [27, "24", "qwen3-coder-30b", "qwen3-coder-30b"],
    [96, "72", "gpt-oss-120b", "gpt-oss-120b"],
    [512, "server-400", "glm-4.6", "glm-4.6"],
    [640, "server-640", "kimi-k2-thinking", "kimi-k2-thinking"],
    [1128, "server-1100", "kimi-k2-instruct", "kimi-k2-instruct"],
  ] as const)("%d GB → tier %s", (gb, tier, agent, small) => {
    const recommendation = LocalRecommend.recommend({ usable: gb * GB })
    expect(recommendation.tier).toBe(tier)
    expect(recommendation.label).toBe("Examples, October 2026. Check each model's licence.")
    expect(recommendation.roles.agent?.key).toBe(agent)
    expect(recommendation.roles.small?.key).toBe(small)
    // One model for every agent role, so the server never swaps models between them.
    ;(["subagent", "judge", "review", "research"] as const).forEach((role) =>
      expect(recommendation.roles[role]?.key).toBe(agent),
    )
  })

  test("a tier too small for the agent says so", () => {
    expect(LocalRecommend.recommend({ usable: 2 * GB }).note).toContain("needs a larger model")
  })

  test("from this computer's hardware", () => {
    const mac = LocalHardware.summarize({ platform: "darwin", arch: "arm64", total: 36 * GB, free: 20 * GB })
    expect(mac).toMatchObject({ kind: "unified", usable: 24 * GB })
    expect(LocalRecommend.recommend({ usable: mac.usable }).roles.agent?.key).toBe("qwen3-coder-30b")
    const big = LocalHardware.summarize({ platform: "darwin", arch: "arm64", total: 128 * GB, free: 90 * GB })
    expect(big.usable).toBe(96 * GB)
    const rig = LocalHardware.summarize({
      platform: "linux",
      arch: "x64",
      total: 64 * GB,
      free: 40 * GB,
      gpus: [{ name: "NVIDIA GeForce RTX 4090", total: 24 * GB, free: 23 * GB }],
    })
    expect(rig).toMatchObject({ kind: "gpu", usable: 24 * GB })
    expect(LocalHardware.free(rig)).toBe(63 * GB)
    const laptop = LocalHardware.summarize({ platform: "win32", arch: "x64", total: 16 * GB, free: 8 * GB })
    expect(laptop).toMatchObject({ kind: "cpu", usable: 8 * GB })
    expect(LocalRecommend.recommend({ usable: laptop.usable }).roles.agent?.key).toBe("qwen3-8b")
  })

  test("a company's table replaces the bundled one only when it is whole", () => {
    const override = {
      ...table,
      label: "Company models. Check each model's licence.",
      tiers: [{ id: "all", min_gb: 0, summary: "Our server.", roles: { agent: "glm-4.6" }, alternatives: [] }],
    }
    expect(LocalRecommend.recommend({ usable: GB, table: LocalRecommend.table(override) }).roles.agent?.key).toBe(
      "glm-4.6",
    )
    // A tier naming a model the table lacks, or no tier for small memory, keeps the bundled table.
    const broken = { ...override, tiers: [{ ...override.tiers[0], roles: { agent: "missing" } }] }
    expect(LocalRecommend.table(broken).label).toBe(table.label)
    expect(LocalRecommend.table({ ...override, tiers: [{ ...override.tiers[0], min_gb: 8 }] }).label).toBe(table.label)
    expect(LocalRecommend.table(null).label).toBe(table.label)
  })

  // The engine puts the reason in the policy's warnings, so a company table Vector ignores never falls back silently.
  test("says why a company table cannot be used", () => {
    const tier = { id: "all", min_gb: 0, summary: "Our server.", roles: { agent: "glm-4.6" }, alternatives: [] }
    const override = { ...table, label: "Company models. Check each model's licence.", tiers: [tier] }
    const tierWith = (change: Record<string, unknown>) => ({ ...override, tiers: [{ ...tier, ...change }] })
    const modelWith = (change: Record<string, unknown>) => ({
      ...override,
      models: { ...table.models, "glm-4.6": { ...table.models["glm-4.6"], ...change } },
    })
    expect(LocalRecommend.problem(undefined)).toBeUndefined()
    expect(LocalRecommend.problem(null)).toBeUndefined()
    expect(LocalRecommend.problem(table)).toBeUndefined()
    expect(LocalRecommend.problem(override)).toBeUndefined()
    expect(LocalRecommend.problem(42)).toBe("it is not a recommendation table")
    expect(LocalRecommend.problem(tierWith({ min_gb: 8 }))).toBe("no tier starts at 0 GB")
    expect(LocalRecommend.problem(tierWith({ roles: { agent: "missing" } }))).toBe(
      "a tier names a model the table does not have",
    )
    // A key every object inherits is not a model of the table.
    expect(LocalRecommend.problem(tierWith({ roles: { agent: "constructor" } }))).toBe(
      "a tier names a model the table does not have",
    )
    expect(LocalRecommend.problem(modelWith({ memory_gb: Infinity }))).toBe(
      "a model's memory_gb or context is not a finite number",
    )
    // The CLI prints a model's first link as it is, so only a web address may be one.
    const scripted = modelWith({ links: ["javascript:alert(1)"] })
    expect(LocalRecommend.problem(scripted)).toBe("a model's link is not an http or https address")
    expect(LocalRecommend.table(scripted).label).toBe(table.label)
    expect(LocalRecommend.table(override).label).toBe("Company models. Check each model's licence.")
  })
})

describe("roles from the models servers already have", () => {
  const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra })

  test("the largest tool-calling model with room for the role takes the agent's roles", () => {
    const roles = LocalRecommend.assign({
      required: 19_000,
      candidates: [
        { provider: "ollama", model: model("qwen3-coder:30b", { parameters: "30.5B", context: 32768, tools: true }) },
        { provider: "ollama", model: model("gemma3:12b", { parameters: "12.2B", tools: false }) },
        { provider: "ollama", model: model("llama3.3:70b", { parameters: "70.6B", context: 8192, tools: true }) },
        { provider: "ollama", model: model("gpt-oss:120b-cloud", { parameters: "116.8B", cloud: true }) },
      ],
    })
    expect(roles).toEqual({
      agent: "ollama/qwen3-coder:30b",
      subagent: "ollama/qwen3-coder:30b",
      judge: "ollama/qwen3-coder:30b",
      review: "ollama/qwen3-coder:30b",
      small: "ollama/qwen3-coder:30b",
      research: "ollama/qwen3-coder:30b",
    })
  })

  test("titles and summaries get a second, smaller model only when both fit at once", () => {
    const candidates = [
      { provider: "ollama", model: model("qwen3-coder:30b", { parameters: "30.5B", size: 19 * GB }) },
      { provider: "ollama", model: model("qwen3:4b", { parameters: "4B", size: 2.5 * GB }) },
    ]
    expect(LocalRecommend.assign({ candidates, usable: 24 * GB }).small).toBe("ollama/qwen3:4b")
    expect(LocalRecommend.assign({ candidates, usable: 20 * GB }).small).toBe("ollama/qwen3-coder:30b")
    expect(LocalRecommend.assign({ candidates }).small).toBe("ollama/qwen3-coder:30b")
  })

  test("suggests nothing when no model may run the agent", () => {
    expect(
      LocalRecommend.assign({
        candidates: [{ provider: "ollama", model: model("gemma3:12b", { tools: false }) }],
      }),
    ).toEqual({})
  })
})

describe("this computer's hardware", () => {
  test("parses macOS vm_stat, counting inactive and purgeable pages as free", () => {
    const text = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               10000.",
      "Pages active:                            500000.",
      "Pages inactive:                          200000.",
      "Pages speculative:                         5000.",
      "Pages throttled:                              0.",
      "Pages wired down:                        150000.",
      "Pages purgeable:                          30000.",
    ].join("\n")
    expect(LocalHardware.parseVmStat(text)).toBe((10000 + 200000 + 5000 + 30000) * 16384)
  })

  test("parses Linux MemAvailable", () => {
    expect(LocalHardware.parseMeminfo("MemTotal:       65536000 kB\nMemAvailable:   40000000 kB\n")).toBe(
      40000000 * 1024,
    )
    expect(LocalHardware.parseMeminfo("MemTotal: 1 kB\n")).toBeUndefined()
  })

  test("parses nvidia-smi's CSV", () => {
    expect(
      LocalHardware.parseNvidiaSmi("NVIDIA H100 80GB HBM3, 81559, 80000\nNVIDIA H100 80GB HBM3, 81559, 1\n\n"),
    ).toEqual([
      { name: "NVIDIA H100 80GB HBM3", total: 81559 * 1024 * 1024, free: 80000 * 1024 * 1024 },
      { name: "NVIDIA H100 80GB HBM3", total: 81559 * 1024 * 1024, free: 1 * 1024 * 1024 },
    ])
    expect(LocalHardware.parseNvidiaSmi("NVIDIA-SMI has failed")).toEqual([])
  })

  test("a GPU that shares system memory counts like Apple silicon", () => {
    // A unified-memory system reports no memory of its own for its GPU. "[N/A]" is how nvidia-smi writes a value it
    // cannot report; this line is written by hand, not recorded from such a system.
    const gpus = LocalHardware.parseNvidiaSmi("NVIDIA GB10, [N/A], [N/A]\n")
    expect(gpus).toEqual([{ name: "NVIDIA GB10", total: 0, free: undefined }])
    const spark = LocalHardware.summarize({ platform: "linux", arch: "arm64", total: 128 * GB, free: 100 * GB, gpus })
    expect(spark).toMatchObject({ kind: "unified", usable: 96 * GB })
    expect(LocalHardware.free(spark)).toBe(100 * GB)
    expect(LocalHardware.describe(spark)).toBe(
      "This computer has 128 GB of memory shared with its GPU; about 96 GB of it can hold a model.",
    )
    expect(LocalRecommend.recommend({ usable: spark.usable }).roles.agent?.key).toBe("gpt-oss-120b")
  })

  test("describes it in plain words", () => {
    expect(
      LocalHardware.describe(LocalHardware.summarize({ platform: "darwin", arch: "arm64", total: 32 * GB, free: 0 })),
    ).toBe("This computer has 32 GB of memory shared with its GPU; about 21 GB of it can hold a model.")
    expect(
      LocalHardware.describe(LocalHardware.summarize({ platform: "linux", arch: "x64", total: 16 * GB, free: 0 })),
    ).toBe("This computer has 16 GB of memory and no GPU Vector can read, so models run on the CPU and reply slowly.")
  })

  test("reads this computer without any connection", async () => {
    const hardware = await LocalHardware.read()
    expect(hardware.memory.total).toBeGreaterThan(0)
    expect(hardware.memory.free).toBeGreaterThan(0)
    expect(hardware.memory.free).toBeLessThanOrEqual(hardware.memory.total)
    expect(guard.attempts()).toEqual([])
  })
})
