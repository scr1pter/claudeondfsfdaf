import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { parseUnifiedDiff } from "@vectordevai/core/review/diff"
import { DiagnosticCatalog, makeDiagnosticAdapters, type ScopedCommand } from "../../src/review/diagnostic-adapter"

const marker = "ghp_" + "t7Px".repeat(9)
const binary = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x7a])
const pin = {
  id: "fixture",
  version: "1.2.3",
  sha256: createHash("sha256").update(binary).digest("hex"),
  executable: binary,
  argv: ["--fixture", "/input/change.json"],
}
const makeInput = () => ({
  adapter: "fixture",
  head: "a".repeat(40),
  files: parseUnifiedDiff(
    [
      "diff --git a/src/fixture.ts b/src/fixture.ts",
      "--- a/src/fixture.ts",
      "+++ b/src/fixture.ts",
      "@@ -1 +1 @@",
      "-const sample = null",
      '+const sample = "' + marker + '"',
      "diff --git a/.env b/.env",
      "--- a/.env",
      "+++ b/.env",
      "@@ -1 +1 @@",
      "-FIXTURE=before",
      "+FIXTURE=concealed",
    ].join("\n"),
  ),
})
const positive = process.platform === "linux" ? test : test.skip

test("the default catalog and unsupported systems have no execution path", async () => {
  let calls = 0
  const build = (platform: NodeJS.Platform) =>
    makeDiagnosticAdapters(() => {
      calls++
      return Effect.die("unexpected launch")
    }, Effect.succeed(platform))
  const missing = await Effect.runPromise(build("linux").preview(makeInput()))
  expect(missing.status).toBe("not-run")
  const unavailable = await Effect.runPromise(
    build("darwin")
      .preview(makeInput())
      .pipe(Effect.provideService(DiagnosticCatalog, [pin])),
  )
  expect(unavailable).toEqual({ status: "not-run", reason: "Diagnostics not run: Linux isolation is unavailable." })
  expect(calls).toBe(0)
})

positive(
  "only an exact pinned preview and one actor-bound consent can reach the SF-08 owner; the projection and result are redacted",
  async () => {
    const commands: ScopedCommand[] = []
    const observed: string[] = []
    const adapters = makeDiagnosticAdapters(
      (command) =>
        Effect.promise(async () => {
          commands.push(command)
          observed.push(await readFile(path.join(command.cwd, "change.json"), "utf8"))
          expect((await readFile(path.join(command.cwd, "adapter"))).equals(Buffer.from(binary))).toBe(true)
          return { exitCode: 0, timedOut: false, truncated: false, output: "Synthetic fixture " + marker }
        }),
      Effect.succeed("linux"),
      async () => "/usr/bin/bwrap",
    )
    const issue = (input = makeInput()) =>
      Effect.runPromise(adapters.preview(input).pipe(Effect.provideService(DiagnosticCatalog, [pin])))
    const wrongPin = await Effect.runPromise(
      adapters
        .preview(makeInput())
        .pipe(Effect.provideService(DiagnosticCatalog, [{ ...pin, sha256: "b".repeat(64) }])),
    )
    expect(wrongPin.status).toBe("not-run")
    const first = await issue()
    const second = await issue({ ...makeInput(), head: "b".repeat(40) })
    if (first.status !== "ready" || second.status !== "ready") throw Error("fixture pin refused")
    const owner = "fixture-owner"
    const key = adapters.approve(first.preview, owner)!
    expect(adapters.approve({ ...first.preview }, owner)).toBeUndefined()
    const invoke = (preview = first.preview, actor = owner, consent = key) =>
      Effect.runPromise(adapters.run({ preview, actor, consent }))
    expect((await invoke(first.preview, "another actor")).status).toBe("not-run")
    expect((await invoke(second.preview)).status).toBe("not-run")
    expect((await invoke(first.preview, owner, { ...key })).status).toBe("not-run")
    const answers = await Promise.all([invoke(), invoke()])
    expect(answers.filter((answer) => answer.status === "ran")).toEqual([
      { status: "ran", adapter: "fixture", version: "1.2.3", output: "Synthetic fixture [redacted]" },
    ])
    expect(commands).toHaveLength(1)
    const command = commands[0]!
    expect(command.command).toBe("/usr/bin/bwrap")
    expect(command.env).toEqual({})
    expect(command.args).toEqual([
      "--die-with-parent",
      "--unshare-all",
      "--cap-drop",
      "ALL",
      "--clearenv",
      "--tmpfs",
      "/",
      "--dir",
      "/tool",
      "--dir",
      "/input",
      "--ro-bind",
      path.join(command.cwd, "adapter"),
      "/tool/adapter",
      "--ro-bind",
      path.join(command.cwd, "change.json"),
      "/input/change.json",
      "--chdir",
      "/input",
      "--remount-ro",
      "/",
      "--",
      "/tool/adapter",
      "--fixture",
      "/input/change.json",
    ])
    expect(observed[0]).toContain("src/fixture.ts")
    expect(observed[0]).toContain("[redacted]")
    for (const hidden of [marker, ".env", "concealed"]) expect(observed[0]).not.toContain(hidden)
    expect(
      await stat(command.cwd).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    expect((await invoke()).status).toBe("not-run")
  },
)

positive(
  "discard truncated, unavailable or failed output, join cancellation and remove private input files",
  async () => {
    const issue = (adapters: ReturnType<typeof makeDiagnosticAdapters>) =>
      Effect.runPromise(adapters.preview(makeInput()).pipe(Effect.provideService(DiagnosticCatalog, [pin])))
    for (const failure of ["truncated", "timeout", "failed", "missing"] as const) {
      let called = 0
      const adapters = makeDiagnosticAdapters(
        () => {
          called++
          return Effect.succeed({
            exitCode: failure === "failed" ? 1 : 0,
            output: marker + " unsafe tail",
            timedOut: failure === "timeout",
            truncated: failure === "truncated",
          })
        },
        Effect.succeed("linux"),
        async () => (failure === "missing" ? undefined : "/usr/bin/bwrap"),
      )
      const result = await issue(adapters)
      if (result.status !== "ready") throw Error("preview unavailable")
      const run = await Effect.runPromise(
        adapters.run({
          preview: result.preview,
          actor: "tester",
          consent: adapters.approve(result.preview, "tester")!,
        }),
      )
      expect(run.status).toBe("not-run")
      expect(JSON.stringify(run)).not.toContain(marker)
      expect(called).toBe(failure === "missing" ? 0 : 1)
    }
    const controller = new AbortController()
    let stage = ""
    let clean = false
    const adapter = makeDiagnosticAdapters(
      (command) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            stage = command.cwd
            setTimeout(() => controller.abort(), 0)
          }),
          () => Effect.never,
          () =>
            Effect.sync(() => {
              clean = true
            }),
        ),
      Effect.succeed("linux"),
      async () => "/usr/bin/bwrap",
    )
    const result = await issue(adapter)
    if (result.status !== "ready") throw Error("preview unavailable")
    const run = await Effect.runPromise(
      adapter.run({
        preview: result.preview,
        actor: "tester",
        consent: adapter.approve(result.preview, "tester")!,
        signal: controller.signal,
      }),
    )
    expect(run.status).toBe("not-run")
    expect(clean).toBe(true)
    expect(
      await stat(stage).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  },
)
