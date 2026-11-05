import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  WINDOWS_CALLER_STAGES,
  WINDOWS_UNIT_FAILURE_LABELS,
  WINDOWS_UNIT_SUITES,
  WINDOWS_DACL_REASONS,
  WindowsCheckFailure,
  WindowsDiagnosticReader,
  windowsCommandReason,
  windowsDiagnostic,
  windowsContextReceipt,
} from "./computer-helper-windows-diagnostics"

const bytes = (value: string) => Buffer.from(value)

test("Windows unit catalog binds existing fixed native suite and failure labels", async () => {
  const main = await readFile(new URL("../native/computer-helper/windows/tests/main.cpp", import.meta.url), "utf8")
  const integration = await readFile(
    new URL("../native/computer-helper/windows/tests/integration_tests.cpp", import.meta.url),
    "utf8",
  )
  expect([...main.matchAll(/run_check\("([a-z0-9-]+)"/g)].map((match) => match[1])).toEqual([...WINDOWS_UNIT_SUITES])
  const labels = [
    ...new Set(
      [...(main + "\n" + integration).matchAll(/"([a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+)"/g)].map((match) => match[1]!),
    ),
  ].toSorted()
  expect(labels).toEqual([...WINDOWS_UNIT_FAILURE_LABELS])
  const desktop = await readFile(
    new URL("../native/computer-helper/windows/tests/caller_desktop.h", import.meta.url),
    "utf8",
  )
  const caller =
    (await readFile(new URL("../native/computer-helper/windows/tests/caller.cpp", import.meta.url), "utf8")) + desktop
  const token = await readFile(
    new URL("../native/computer-helper/windows/tests/caller_token_acl.h", import.meta.url),
    "utf8",
  )
  const stages = [...caller.matchAll(/stage = "([a-z-]+)"/g)].map((match) => match[1]!)
  const exits = [...caller.matchAll(/"((?:bootstrap|helper)-child-exit-[a-z-]+)"/g)].map((match) => match[1]!)
  const tokenStages = [...token.matchAll(/"(restricted-acl-[a-z-]+)"/g)].map((match) => match[1]!)
  expect([...new Set([...stages, ...exits, ...tokenStages])].toSorted()).toEqual([...WINDOWS_CALLER_STAGES].toSorted())
  const catalogue = integration.match(/constexpr std::array<std::string_view, (\d+)> stages\{([^;]+)\};/s)
  expect(Number(catalogue?.[1])).toBe(WINDOWS_CALLER_STAGES.length)
  const forwarded = catalogue?.[2] ?? ""
  expect([...forwarded.matchAll(/"([a-z-]+)"/g)].map((match) => match[1])).toEqual([...WINDOWS_CALLER_STAGES])
})

test("restricted startup snapshot requires current authority without the historical filtering getter", async () => {
  const token = await readFile(
    new URL("../native/computer-helper/windows/tests/caller_token_acl.h", import.meta.url),
    "utf8",
  )
  const snapshot = token.slice(
    token.indexOf("inline Snapshot snapshot("),
    token.indexOf("inline bool ensure_owned_restricted("),
  )
  const queries = [...snapshot.matchAll(/\b(?:read|scalar)\((Token[A-Za-z]+)\)/g)]
    .map((match) => match[1]!)
    .toSorted()
  expect(queries).toEqual(
    [
      "TokenUser",
      "TokenOwner",
      "TokenPrimaryGroup",
      "TokenIntegrityLevel",
      "TokenGroups",
      "TokenRestrictedSids",
      "TokenPrivileges",
      "TokenStatistics",
      "TokenMandatoryPolicy",
      "TokenSandBoxInert",
    ].toSorted(),
  )
  expect(snapshot).toContain("result.token = luid(stats->TokenId)")
  expect(snapshot).toContain("result.authentication = luid(stats->AuthenticationId)")
  expect(snapshot).toContain("result.type = static_cast<DWORD>(stats->TokenType)")
  // The strict historical getter and its previous closed failure categories remain available.
  expect(token).toContain('case TokenHasRestrictions: return "restricted-acl-query-restrictions"')
  expect(token).toContain('"restricted-acl-restrictions-short"')
})

test("split lines preserve only exact unit failure and Caller stage, with the first cause retained", () => {
  const reader = new WindowsDiagnosticReader("unit")
  for (const chunk of ["PASS identity-and-", "blocklist\r\nPASS server\nPASS unknown-secret\n"])
    reader.consume(bytes(chunk), "stdout")
  for (const chunk of [
    "private /owner/secret\nFAIL integration.reply-",
    "pipe\nvector-caller-failure medium.layout\nvector-caller-failure initial.child-exit\n",
  ])
    reader.consume(bytes(chunk), "stderr")
  expect(reader.finish()).toEqual({
    unitSuite: "server",
    unitFailure: "integration.reply-pipe",
    caller: "medium.layout",
  })
  expect(windowsCommandReason({ code: 1, diagnostic: { windows: reader.finish() } }, "probe")).toBe(
    "windows-caller-medium.layout",
  )
})

test("unknown fields, incomplete lines, overlong lines and output past the bound never serialize", () => {
  const reader = new WindowsDiagnosticReader("caller")
  reader.consume(
    bytes(
      "x".repeat(193) +
        "vector-caller-failure initial.layout\nvector-caller-failure initial.private-secret\nFAIL integration.reply-pipe\nvector-caller-failure medium.layout",
    ),
    "stderr",
  )
  expect(reader.finish()).toEqual({})
  const bounded = new WindowsDiagnosticReader("caller")
  bounded.consume(bytes("x".repeat(65_536) + "\nvector-caller-failure initial.layout\n"), "stderr")
  expect(bounded.finish()).toEqual({})
  for (const value of [
    { caller: "initial.secret" },
    { unitFailure: "integration.owner-secret" },
    { unitSuite: "owner-secret" },
    { caller: "medium.layout", path: "/owner" },
  ])
    expect(() => windowsDiagnostic(value)).toThrow()
  for (const reason of [
    "private-secret",
    "windows-caller-medium.secret",
    "windows-probe-exit-999",
    "windows-probe-exit-001",
  ])
    expect(() => new WindowsCheckFailure(reason)).toThrow()
})

test("command outcome categories retain finite exit and bound failures without a pass conversion", () => {
  expect(windowsCommandReason({ code: 1 }, "probe")).toBe("windows-probe-exit-1")
  expect(windowsCommandReason({ code: 3221225477 }, "probe")).toBe("windows-probe-exit-unknown")
  expect(windowsCommandReason({ code: 0, timedOut: true }, "channel")).toBe("windows-channel-deadline")
  expect(() => {
    new WindowsCheckFailure("windows-probe-invalid-responsible")
  }).not.toThrow()
  const reader = new WindowsDiagnosticReader("caller")
  reader.consume(bytes("vector-caller-failure initial.layout-helper-ancestors\n"), "stderr")
  expect(reader.finish()).toEqual({ caller: "initial.layout-helper-ancestors" })
})

test("bootstrap/helper exits and fixed helper messages retain the primary child cause only", () => {
  const overflow = new WindowsDiagnosticReader("caller")
  overflow.consume(
    bytes("vector-caller-failure initial.helper-child-exit-stack-overflow\nprivate-stack-content\n"),
    "stderr",
  )
  expect(overflow.finish()).toEqual({ caller: "initial.helper-child-exit-stack-overflow" })
  for (const stage of WINDOWS_CALLER_STAGES) {
    const reader = new WindowsDiagnosticReader("caller")
    reader.consume(
      bytes(`vector-caller-failure medium.${stage}\nvector-caller-failure initial.bootstrap-child-exit-failure\n`),
      "stderr",
    )
    expect(reader.finish().caller).toBe(`medium.${stage}`)
    expect(
      new WindowsCheckFailure(windowsCommandReason({ code: 1, diagnostic: { windows: reader.finish() } }, "probe"))
        .reason,
    ).toBe(`windows-caller-medium.${stage}`)
  }
  const helper = new WindowsDiagnosticReader("unit")
  helper.consume(
    bytes(
      "The computer helper could not start safely.\nvector-caller-failure initial.helper-child-exit-failure\nThe helper process token could not be read.\n",
    ),
    "stderr",
  )
  expect(helper.finish()).toEqual({ helper: "safe-start", caller: "initial.helper-child-exit-failure" })
  expect(windowsCommandReason({ code: 1, diagnostic: { windows: helper.finish() } }, "probe")).toBe(
    "windows-caller-initial.helper-child-exit-failure.helper-safe-start",
  )
  expect(new WindowsCheckFailure("windows-caller-initial.helper-child-exit-failure.helper-safe-start").reason).toBe(
    "windows-caller-initial.helper-child-exit-failure.helper-safe-start",
  )
  const token = new WindowsDiagnosticReader("caller")
  token.consume(bytes("The helper process token could not be read.\ntoken.step.private-secret\n"), "stderr")
  expect(windowsCommandReason({ code: 1, diagnostic: { windows: token.finish() } }, "probe")).toBe(
    "windows-helper-token-read",
  )
  expect(() => windowsDiagnostic({ helper: "private-secret" })).toThrow()
  expect(
    () => new WindowsCheckFailure("windows-caller-initial.helper-child-exit-failure.helper-private-secret"),
  ).toThrow()
})

test("token and desktop receipts remain bound to the first exact failure line", () => {
  const reader = new WindowsDiagnosticReader("unit")
  reader.consume(
    bytes(
      "vector-caller-failure medium.helper-child-exit-failure r=serving d=parent\nvector-caller-failure initial.bootstrap-child-exit-failure r=restricted d=owned\n",
    ),
    "stderr",
  )
  expect(reader.finish()).toEqual({
    caller: "medium.helper-child-exit-failure",
    tokenRoute: "already-serving",
    desktop: "parent-proved",
  })
  const reason = windowsCommandReason({ code: 1, diagnostic: { windows: reader.finish() } }, "probe")
  expect(reason).toBe("windows-caller-medium.helper-child-exit-failure.route-already-serving.desktop-parent-proved")
  expect(new WindowsCheckFailure(reason).reason).toBe(reason)
  for (const text of [
    "vector-caller-failure initial.layout r=owner-secret",
    "vector-caller-failure initial.layout d=owned",
    "vector-caller-failure initial.layout r=linked d=private-name",
  ]) {
    const bad = new WindowsDiagnosticReader("caller")
    bad.consume(bytes(text + "\n"), "stderr")
    expect(bad.finish()).toEqual({})
  }
  for (const value of [
    { tokenRoute: "restricted-fallback" },
    { caller: "initial.layout", desktop: "owned-proved" },
    { caller: "initial.layout", tokenRoute: "owner-secret" },
  ])
    expect(() => windowsDiagnostic(value)).toThrow()
})

test("outer context receipts retain only token/default-DACL facts and preserve room for the first cause", () => {
  const reader = new WindowsDiagnosticReader("unit")
  const context = "vector-caller-context initial r=restricted d=parent o=x a=d c=s\n"
  const helper = "The computer helper could not start safely.\n"
  const failure = "vector-caller-failure medium.helper-child-exit-dll-initialization r=s d=parent\n"
  expect(Buffer.byteLength(context + helper + failure)).toBeLessThanOrEqual(192)
  expect(Buffer.byteLength(failure)).toBeLessThanOrEqual(96)
  reader.consume(bytes(context + helper + failure), "stderr")
  expect(reader.finish()).toEqual({
    context: {
      tokenRoute: "restricted-fallback",
      desktop: "parent-proved",
      owner: "other",
      defaultDaclProcessAll: "denied",
      defaultDaclReason: "complete",
    },
    helper: "safe-start",
    caller: "medium.helper-child-exit-dll-initialization",
    tokenRoute: "already-serving",
    desktop: "parent-proved",
  })
  expect(windowsContextReceipt(reader.finish().context!)).toBe(context)
  const outer = new WindowsDiagnosticReader("caller")
  outer.consume(bytes(context + "vector-caller-failure initial.bootstrap-child-exit-dll-initialization\n"), "stderr")
  expect(outer.finish().tokenRoute).toBe("restricted-fallback")
  expect(outer.finish().desktop).toBe("parent-proved")
  for (const text of [
    "vector-caller-context initial r=restricted d=owned o=secret a=d c=s",
    "vector-caller-context medium r=serving d=parent o=u a=g c=s",
    "vector-caller-context initial r=linked d=parent o=u a=g c=s private",
  ]) {
    const bad = new WindowsDiagnosticReader("caller")
    bad.consume(bytes(text + "\n"), "stderr")
    expect(bad.finish()).toEqual({})
  }
  expect(() =>
    windowsDiagnostic({
      context: {
        tokenRoute: "already-serving",
        desktop: "parent-proved",
        owner: "user",
        defaultDaclProcessAll: "granted",
        defaultDaclReason: "complete",
        sid: "private",
      },
    }),
  ).toThrow()
})

test("unknown access observations preserve an exact closed cause without inventing denied access", async () => {
  const caller =
    (await readFile(new URL("../native/computer-helper/windows/tests/caller.cpp", import.meta.url), "utf8")) +
    (await readFile(new URL("../native/computer-helper/windows/tests/caller_token_acl.h", import.meta.url), "utf8"))
  const native = [
    ...new Set(
      [...caller.matchAll(/cause\s*=\s*([^;\n]+)/g)].flatMap((match) =>
        [...match[1]!.matchAll(/'([a-z])'/g)].map((value) => value[1]!),
      ),
    ),
  ].toSorted()
  expect(native).toEqual(Object.keys(WINDOWS_DACL_REASONS).toSorted())
  for (const [code, reason] of Object.entries(WINDOWS_DACL_REASONS)) {
    const text = `vector-caller-context initial r=restricted d=parent o=u a=${code === "s" || code === "b" ? "g" : "n"} c=${code}\n`
    const reader = new WindowsDiagnosticReader("caller")
    reader.consume(bytes(text), "stderr")
    expect(reader.finish().context?.defaultDaclReason).toBe(reason)
    expect(reader.finish().context?.defaultDaclProcessAll).toBe(code === "s" || code === "b" ? "granted" : "unknown")
    expect(windowsContextReceipt(reader.finish().context!)).toBe(text)
  }
  for (const text of [
    "vector-caller-context initial r=restricted d=parent o=u a=n c=secret",
    "vector-caller-context initial r=restricted d=parent o=u a=g c=r",
    "vector-caller-context initial r=restricted d=parent o=n a=n c=s",
    "vector-caller-context initial r=linked d=parent o=u a=g c=b",
    "vector-caller-context initial r=restricted d=parent o=u a=n c=b",
  ]) {
    const reader = new WindowsDiagnosticReader("caller")
    reader.consume(bytes(text + "\n"), "stderr")
    expect(reader.finish()).toEqual({})
  }
})
