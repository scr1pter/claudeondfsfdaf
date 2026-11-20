import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import path from "node:path"
import { LocalMode } from "@vectordevai/schema/local-mode"
import { LocalPolicy } from "../../src/local-mode/policy"
import { LocalSources } from "../../src/local-mode/sources"

const ROOT = path.resolve(import.meta.dir, "../../../..")
const on = LocalPolicy.resolve({ global: { enabled: true } })

describe("LocalSources registry", () => {
  test("names each source once, in lower case with hyphens", () => {
    const ids = LocalSources.SOURCES.map((source) => source.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id))).toEqual([])
    expect(LocalSources.get("webfetch")?.purpose).toBe("web-page")
    expect(LocalSources.get("nothing")).toBeUndefined()
  })

  test("covers every purpose", () => {
    const purposes = new Set(LocalSources.SOURCES.map((source) => source.purpose))
    // web-search stays only so the network log still reads the lines an earlier version wrote for its search
    // services; Vector searches with its own browser now.
    expect(LocalMode.Purpose.literals.filter((purpose) => !purposes.has(purpose))).toEqual(["web-search"])
  })

  test("points every call site at a file in the repository", async () => {
    const missing = (
      await Promise.all(
        LocalSources.SOURCES.flatMap((source) => source.callSites).map(async (file) =>
          (await Bun.file(path.join(ROOT, file)).exists()) ? undefined : file,
        ),
      )
    ).filter(Boolean)
    expect(missing).toEqual([])
    // A source with no call site yet names the files that will make its requests.
    expect(
      LocalSources.SOURCES.filter((source) => source.callSites.length === 0 && !source.planned?.length).map(
        (source) => source.id,
      ),
    ).toEqual([])
  })

  test("lists hosts as plain lower-case host names", () => {
    const hosts = LocalSources.SOURCES.flatMap((source) => source.hosts)
    expect(hosts.filter((host) => LocalPolicy.host(host) !== host)).toEqual([])
  })

  test("says what each source sends and why", () => {
    expect(LocalSources.SOURCES.filter((source) => !source.sends.trim() || !source.why.trim())).toEqual([])
  })

  test("Brain Vault says a backup carries memory, learned skills and workflow insights, and Vector Local blocks it", () => {
    // Since B10 a backup also holds the learned `skills` and `insights` sections (engine brain/vault-memory.ts).
    const vault = LocalSources.get("brain-vault")
    expect(vault?.sends).toContain("learned skills and workflow insights")
    expect(vault?.why).toContain("learned skills and workflow insights")
    expect(vault?.local).toBe("blocked")
    expect(vault?.callSites).toEqual(
      expect.arrayContaining([
        "packages/desktop/src/main/vault-backup.ts",
        "packages/desktop/src/main/vault-github.ts",
      ]),
    )
  })

  test("decides each source's own hosts the way its Vector Local setting says", () => {
    const rows = LocalSources.SOURCES.flatMap((source) =>
      source.hosts.map((host) => {
        const verdict = LocalPolicy.decide(on, {
          purpose: source.purpose,
          url: `https://${host}/`,
          source: source.id,
          manual: source.purpose === "updates",
        })
        return { id: source.id, host, local: source.local, decision: verdict.decision, allowable: verdict.allowable }
      }),
    )
    const wrong = rows.filter((row) => {
      if (row.local === "not-allowable") return row.decision !== "block" || row.allowable
      if (row.local === "blocked") return row.decision !== "block"
      if (row.local === "allow-with-reason") return row.decision !== "block" || !row.allowable
      if (row.local === "ask-once") return row.decision !== "ask"
      if (row.local === "allowed") return row.decision === "block"
      return false
    })
    expect(wrong).toEqual([])
  })

  test("lets an allow entry open blocked and allow-with-reason sources, never a not-allowable one", () => {
    const sources = LocalSources.SOURCES.filter((source) => source.hosts.length > 0 && source.purpose !== "updates")
    const policy = LocalPolicy.resolve({
      global: {
        enabled: true,
        allow: sources.map((source) => ({ source: source.id, reason: "Test", added_at: 1, added_by: "app" as const })),
      },
    })
    const rows = sources.map((source) => ({
      id: source.id,
      local: source.local,
      decision: LocalPolicy.decide(policy, {
        purpose: source.purpose,
        url: `https://${source.hosts[0]}/`,
        source: source.id,
      }).decision,
    }))
    expect(rows.filter((row) => row.local === "not-allowable" && row.decision !== "block")).toEqual([])
    expect(
      rows.filter((row) => (row.local === "blocked" || row.local === "allow-with-reason") && row.decision !== "allow"),
    ).toEqual([])
  })

  test("the cheap gate skips blocked sources without an attempt, and decides model calls per request", () => {
    const blocked = (id: string, policy = on) => LocalPolicy.blocks(policy, LocalSources.get(id)!)
    expect(blocked("model-catalog")).toBe(true)
    expect(blocked("usage-checkin")).toBe(true)
    expect(blocked("chatgpt-signin")).toBe(true)
    expect(blocked("everywhere")).toBe(true)
    expect(blocked("embedding-model")).toBe(false)
    expect(blocked("webfetch")).toBe(false)
    expect(blocked("cloud-inference")).toBe(false)
    expect(blocked("model-catalog", LocalPolicy.OFF)).toBe(false)
    const allowed = LocalPolicy.resolve({
      global: { enabled: true, allow: [{ source: "model-catalog", reason: "Prices", added_at: 1, added_by: "cli" }] },
    })
    expect(blocked("model-catalog", allowed)).toBe(false)
  })

  test("refuses regional and per-resource cloud hosts too", () => {
    const hosts = [
      "https://us-central1-aiplatform.googleapis.com",
      "https://bedrock-runtime.us-east-1.amazonaws.com",
      "https://myres.cognitiveservices.azure.com",
      "https://myres.services.ai.azure.com",
      "https://myres.openai.azure.com",
      "https://api.moonshot.ai",
      "https://dashscope.aliyuncs.com",
    ]
    const policy = LocalPolicy.resolve({ global: { enabled: true, endpoints: [...hosts, "https://gpu.example.com"] } })
    expect(policy.endpoints).toEqual([{ origin: "https://gpu.example.com", from: "user" }])
    expect(policy.warnings).toHaveLength(hosts.length)
    // A pattern's `*` is one name's worth of letters, digits and hyphens, never a way around its fixed part.
    expect(LocalPolicy.hostMatches("bedrock-runtime.eu-west-1.amazonaws.com", "bedrock-runtime.*.amazonaws.com")).toBe(
      true,
    )
    expect(LocalPolicy.hostMatches("bedrock-runtime.evil.example", "bedrock-runtime.*.amazonaws.com")).toBe(false)
    expect(LocalPolicy.hostMatches("aiplatform.googleapis.com.evil.example", "*-aiplatform.googleapis.com")).toBe(false)
    expect(LocalPolicy.hostMatches("my-aiplatform.googleapis.com", "*-aiplatform.googleapis.com")).toBe(true)
  })

  test("refuses the cloud AI hosts the foundations review found accepted, and keeps a company's own server", () => {
    const hosts = [
      "https://api.individual.githubcopilot.com",
      "https://api.business.githubcopilot.com",
      "https://codestral.mistral.ai",
      "https://ai-gateway.vercel.sh",
      "https://api.together.ai",
      "https://bedrock-agent-runtime.us-east-1.amazonaws.com",
      "https://vpce-0a1b2c3d-4e5f.bedrock-runtime.us-east-1.vpce.amazonaws.com",
      "https://my-endpoint.eastus.inference.ai.azure.com",
      "https://api.replicate.com",
      "https://api.studio.nebius.com",
      "https://api.siliconflow.cn",
      "https://api.moonshot.cn",
      "https://dashscope-intl.aliyuncs.com",
      "https://bedrock-mantle.us-east-1.api.aws",
      "https://us-central1-aiplatform.googleapis.com",
      "https://aiplatform.us-central1.rep.googleapis.com",
    ]
    const own = ["https://kimi.inference.corp.example.com", "https://gpu.example.com", "http://10.0.0.5:8000"]
    const policy = LocalPolicy.resolve({ global: { enabled: true, endpoints: [...hosts, ...own] } })
    expect(policy.endpoints.map((endpoint) => endpoint.origin)).toEqual(own)
    expect(policy.warnings).toHaveLength(hosts.length)
    // A general cloud is listed by its AI services' names, so a company's own server there is still its own.
    for (const host of ["ec2-3-4-5-6.compute-1.amazonaws.com", "myapp.azurewebsites.net", "storage.googleapis.com"])
      expect({
        host,
        refused: LocalSources.CLOUD_INFERENCE_HOSTS.some((pattern) => LocalPolicy.hostMatches(host, pattern)),
      }).toEqual({
        host,
        refused: false,
      })
  })

  test("adds every cloud provider address in the model catalog, and none on this computer or the network", () => {
    const hosts = LocalSources.cloudHosts({
      newcloud: { api: "https://api.newcloud.example/v1" },
      regional: { api: "https://inference.${REGION}.regional.example/openai" },
      ollama: { api: "http://localhost:11434/v1" },
      lmstudio: { api: "http://127.0.0.1:1234/v1" },
      box: { api: "http://gpu-box:8000/v1" },
      mixed: { models: { one: { provider: { api: "https://models.mixed.example/api" } } } },
      variable: { api: "${OPENAI_BASE_URL}" },
      none: {},
    })
    expect(hosts).toEqual(
      expect.arrayContaining(["api.newcloud.example", "inference.*.regional.example", "models.mixed.example"]),
    )
    expect(hosts.filter((host) => /localhost|127\.0\.0\.1|gpu-box|variable|\$/.test(host))).toEqual([])
    const policy = LocalPolicy.resolve({
      global: {
        enabled: true,
        endpoints: [
          "https://api.newcloud.example",
          "https://inference.eu-1.regional.example",
          "http://localhost:11434",
        ],
      },
      cloudHosts: hosts,
    })
    expect(policy.endpoints).toEqual([{ origin: "http://localhost:11434", from: "user" }])
  })

  test("never lists Vector's own hosts, from any source", () => {
    const user = LocalPolicy.resolve({
      global: { enabled: true, endpoints: ["https://vectordev.ai", "https://api.vectordev.ai"] },
    })
    expect(user.endpoints).toEqual([])
    expect(user.warnings).toHaveLength(2)
    const managed = LocalPolicy.resolve({
      managed: {
        enabled: true,
        endpoints: ["https://vectordev.ai", "https://*.vectordev.ai", "https://gpu.corp.example"],
      },
    })
    expect(managed.endpoints).toEqual([{ origin: "https://gpu.corp.example", from: "managed" }])
    expect(managed.warnings.filter((warning) => warning.includes("vectordev.ai"))).toHaveLength(2)
    // So an unlabelled request to them is never `listed`.
    expect(LocalPolicy.decide(user, { purpose: "unknown", url: "https://api.vectordev.ai/" }).decision).toBe("block")
  })

  test("refuses a cloud AI host known by its domain's digest, and the names under it", () => {
    // A stand-in for the gateway whose name stays out of this repository.
    const digests = new Set([createHash("sha256").update("gateway.example").digest("hex")])
    expect(
      [
        "gateway.example",
        "api.gateway.example",
        "GATEWAY.EXAMPLE.",
        "gateway.example.evil.test",
        "agateway.example",
      ].map((host) => LocalSources.digestListed(host, digests)),
    ).toEqual([true, true, true, false, false])
    expect(LocalSources.digestListed("api.vectordev.ai")).toBe(false)
  })

  test("logs a model call to a cloud AI host as cloud-inference, even when the company lists it", () => {
    const azure = "https://acme.openai.azure.com/openai/v1/chat/completions"
    expect(LocalSources.inference(azure)).toBe("cloud-inference")
    expect(LocalSources.inference("https://llm.example.com/v1/chat/completions")).toBe("local-inference")
    expect(LocalSources.inference("http://127.0.0.1:11434/v1/chat/completions")).toBe("local-inference")
    expect(LocalSources.inference("http://gpu-box:8000/v1")).toBe("local-inference")
    // The company's listing lets it through, labelled as its endpoint; a user cannot list it.
    const company = LocalPolicy.resolve({ managed: { enabled: true, endpoints: ["https://acme.openai.azure.com"] } })
    expect(
      LocalPolicy.decide(company, { purpose: "inference", url: azure, source: LocalSources.inference(azure) }),
    ).toMatchObject({ decision: "allow", class: "listed" })
    expect(
      LocalPolicy.decide(on, { purpose: "inference", url: azure, source: LocalSources.inference(azure) }),
    ).toMatchObject({ decision: "block", rule: "not-allowable" })
  })

  test("refuses the cloud AI hosts as a user's model servers by default", () => {
    const policy = LocalPolicy.resolve({
      global: { enabled: true, endpoints: LocalSources.CLOUD_INFERENCE_HOSTS.map((host) => `https://${host}`) },
    })
    expect(policy.endpoints).toEqual([])
    expect(policy.warnings).toHaveLength(LocalSources.CLOUD_INFERENCE_HOSTS.length)
  })

  test("declares the desktop's laptop-job requests as an account source that Vector Local blocks like Vector Remote", () => {
    expect(LocalSources.get("everywhere")).toMatchObject({
      purpose: "account",
      hosts: ["vectordev.ai"],
      local: "blocked",
      where: ["desktop"],
      callSites: ["packages/desktop/src/main/everywhere-runner.ts"],
    })
    expect(LocalSources.get("everywhere")?.local).toBe(LocalSources.get("remote")!.local)
    // The job's git fetch and push are git-remote, decided before git starts.
    expect(LocalSources.get("git-remote")?.callSites).toContain("packages/desktop/src/main/everywhere-git.ts")
    const claim = {
      purpose: "account" as const,
      url: "https://vectordev.ai/api/everywhere/jobs/claim",
      source: "everywhere",
    }
    expect(LocalPolicy.decide(on, claim)).toMatchObject({ decision: "block", rule: "vector-service", allowable: true })
    expect(LocalPolicy.decide(LocalPolicy.OFF, claim).decision).toBe("allow")
  })
})
