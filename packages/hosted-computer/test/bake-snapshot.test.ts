import { describe, expect, test } from "bun:test"
import { bakeSnapshot, selfCheck, type BakeSdk } from "../script/bake-snapshot"
import { EXPECTED, microvmCheck, parseProbes, PROBES, type CheckSdk } from "../script/microvm-check"
import { IMAGE_MAX_BYTES } from "../src/limits"

// WP A54: the bake turns the image into the base snapshot in one sandbox with no network, never tagged as a
// subscriber's computer, after checking the image there; the real-microVM check boots a throwaway computer and checks
// the firewall from inside. Both are driven here with a stand-in for the provider's SDK; nothing reaches Vercel.

const DIGEST = `registry.example.test/vector-hosted/computer@sha256:${"a".repeat(64)}`
const CREDENTIALS = { token: "fixture-token", teamId: "team_fixture", projectId: "prj_fixture" }

function fakeSdk(options: { exitCode?: number; stdout?: string; snapshot?: { id: string; status: string; sizeBytes: number } } = {}) {
  const created: Record<string, unknown>[] = []
  const commands: { cmd: string; args: string[]; sudo?: boolean }[] = []
  let stops = 0
  const sdk = {
    create: async (params: Record<string, unknown>) => {
      created.push(params)
      return {
        runCommand: async (command: { cmd: string; args: string[]; sudo?: boolean }) => {
          commands.push(command)
          const text = typeof options.stdout === "string" ? options.stdout : command.args[1]?.startsWith("/opt/vector/boot.sh") ? "ready" : "ok 1234"
          return { exitCode: options.exitCode ?? 0, stdout: async () => text }
        },
        stop: async () => {
          stops++
          return { snapshot: options.snapshot ?? { id: "snap_fixture", status: "created", sizeBytes: 900_000_000 } }
        },
      }
    },
  }
  return { sdk, created, commands, stops: () => stops }
}

describe("the bake", () => {
  test("one sandbox from the digest-pinned image, no network, no vector-mode tag; answers the snapshot id", async () => {
    const fake = fakeSdk()
    const baked = await bakeSnapshot({ sdk: fake.sdk as unknown as BakeSdk, credentials: CREDENTIALS, image: DIGEST, generation: 3 })
    expect(baked).toEqual({ snapshotId: "snap_fixture", sizeBytes: 900_000_000 })
    const params = fake.created[0]!
    expect(params).toMatchObject({ image: DIGEST, persistent: true, snapshotExpiration: 0, networkPolicy: "deny-all", region: "iad1", ports: [] })
    expect(params.tags).toEqual({ "vector-bake": "3" })
    expect(JSON.stringify(params.tags)).not.toContain("vector-mode")
    expect(params).toMatchObject(CREDENTIALS)
    expect(fake.commands[0]).toMatchObject({ cmd: "/bin/sh", sudo: true })
    expect(fake.stops()).toBe(1)
  })

  test("an image not pinned by digest, a bad generation or missing settings are refused before any call", async () => {
    for (const [image, generation, credentials] of [
      ["registry.example.test/vector-hosted/computer:latest", 3, CREDENTIALS],
      [DIGEST, 0, CREDENTIALS],
      [DIGEST, 3, { ...CREDENTIALS, token: "" }],
      [DIGEST, 3, { ...CREDENTIALS, teamId: "x" }],
    ] as const) {
      const fake = fakeSdk()
      await expect(bakeSnapshot({ sdk: fake.sdk as unknown as BakeSdk, credentials, image, generation })).rejects.toThrow()
      expect(fake.created).toEqual([])
    }
  })

  test("a failed image check, an unsaved snapshot or one over 6 GB fails the bake, and the sandbox is stopped", async () => {
    for (const options of [
      { exitCode: 1, stdout: "" },
      { stdout: "ok 1" , snapshot: { id: "snap", status: "failed", sizeBytes: 1 } },
      { stdout: "ok 1", snapshot: { id: "snap", status: "created", sizeBytes: IMAGE_MAX_BYTES + 1 } },
    ]) {
      const fake = fakeSdk(options)
      await expect(bakeSnapshot({ sdk: fake.sdk as unknown as BakeSdk, credentials: CREDENTIALS, image: DIGEST, generation: 3 })).rejects.toThrow()
      expect(fake.stops()).toBeGreaterThanOrEqual(1)
    }
  })

  test("the image check covers the generation, the stamped digest, setuid files, sudo, the agent's uid and the size", () => {
    const script = selfCheck(7)
    expect(script).toContain('[ "$(cat /usr/lib/vector/GENERATION)" = "7" ]')
    expect(script).toContain("sha256sum /usr/lib/vector/base/base.tar")
    expect(script).toContain("-perm /6000")
    expect(script).toContain("! command -v sudo")
    expect(script).toContain('[ "$(id -u agent)" = "10001" ]')
    expect(script).toContain(`-le ${IMAGE_MAX_BYTES}`)
  })
})

describe("the real-microVM check", () => {
  test("its probes expect tcp/443 open and port 80, other DNS, metadata, VNC and the local viewer closed", () => {
    expect(EXPECTED).toEqual({ https: "open", http: "closed", metadata: "closed", vnc: "closed", viewer: "closed", "other-dns": "closed" })
    expect(PROBES).toContain('tcp("metadata", "169.254.169.254", 80)')
    expect(parseProbes("https open\nhttp closed\nnoise\n")).toEqual({ https: "open", http: "closed" })
  })

  test("it boots a throwaway computer never tagged vector-mode, and stops it whatever happens", async () => {
    const fake = fakeSdk({ stdout: "" })
    const failures = await microvmCheck({ sdk: fake.sdk as unknown as CheckSdk, credentials: CREDENTIALS, snapshotId: "snap_fixture" })
    expect(fake.created[0]).toMatchObject({ source: { type: "snapshot", snapshotId: "snap_fixture" }, persistent: false, tags: { "vector-check": "1" } })
    expect(fake.commands[0]!.args[1]).toMatch(/^\/opt\/vector\/boot\.sh --run-host vector-check\.invalid --session hs_[a-z2-7]{26}$/)
    // The stand-in answers nothing useful, so the checks report failures rather than passing silently.
    expect(failures.length).toBeGreaterThan(0)
    expect(fake.stops()).toBe(1)
  })
})
