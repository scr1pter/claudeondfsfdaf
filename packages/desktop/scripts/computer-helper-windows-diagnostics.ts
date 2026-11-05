// Closed diagnostics for verified Windows test artifacts; no observed content is retained.
export const WINDOWS_UNIT_SUITES = [
  "identity-and-blocklist",
  "command-line",
  "executable-json-and-pe",
  "embedded-manifest",
  "embedded-version",
  "native-cli-checks",
  "protocol",
  "server",
  "parent-identity",
  "surface-availability",
  "lifecycle",
  "caller-and-native-lifecycle",
  "window-identities",
  "window-catalog-and-focus",
  "generated-app-icons",
  "window-policy",
  "native-process-tree",
  "program-capabilities",
  "program-resolution-and-launch",
  "live-target-guard",
  "capture-geometry-and-privacy",
  "capture-service-and-receipts",
  "input-key-semantics",
  "input-owned-journal",
  "input-release-guardian",
  "input-uia-observation",
  "input-uia-binding",
  "input-service-and-cleanup",
  "accessibility-service",
  "accessibility-references",
  "user-input-detection-and-stop",
  "privileged-boundaries",
  "overlay-driver-boundaries",
] as const
export const WINDOWS_UNIT_FAILURE_LABELS = [
  "accessibility.h",
  "ai.vector.app",
  "ai.vector.app.beta",
  "ai.vector.app.dev",
  "availability.h",
  "blocklist.full-json-equality",
  "blocklist.h",
  "blocklist.verbatim-equality",
  "build-config.h",
  "capture.h",
  "cli.elevation-switch-only-adds-serving-refusal",
  "cli.exit-code-unavailable",
  "cli.invalid-arguments",
  "cli.packaged",
  "cli.probe",
  "cli.self-test",
  "cli.serve",
  "cli.unknown",
  "cli.unprivileged",
  "cli.version",
  "core.h",
  "guard.h",
  "identity.channel-count",
  "identity.channel-matrix",
  "identity.full-json-equality",
  "identity.h",
  "identity.helper-channel-matrix",
  "identity.vector-binary-count",
  "identity.vector-binary-matrix",
  "identity.vector-bundle-count",
  "identity.vector-bundle-matrix",
  "input.h",
  "integration.actual-helper-identity",
  "integration.actual-helper-witness",
  "integration.actual-responsible-hello",
  "integration.ancestry-bound",
  "integration.ancestry-first",
  "integration.ancestry-missing",
  "integration.ancestry-snapshot",
  "integration.attribute-init",
  "integration.attribute-size",
  "integration.boolean-feature-contract",
  "integration.caller-alive-witness",
  "integration.caller-artifact",
  "integration.caller-create",
  "integration.copy-unchanged-artifacts",
  "integration.desktop-denial-only-isolation",
  "integration.desktop-exact-owner",
  "integration.desktop-exact-security",
  "integration.desktop-medium-label-required",
  "integration.desktop-no-broad-acl",
  "integration.desktop-protected-acl",
  "integration.desktop-test-descriptor",
  "integration.desktop-test-sid",
  "integration.eof-helper-within-one-second",
  "integration.failed-transport-exits",
  "integration.failed-transport-nonzero-code",
  "integration.helper-alive-witness",
  "integration.helper-artifact",
  "integration.kill-actual-caller",
  "integration.lifecycle-caller-exit",
  "integration.medium-parent-chain",
  "integration.medium-parent-image",
  "integration.medium-parent-witness",
  "integration.parent-death-helper-within-one-second",
  "integration.parent-only-actual-parent-death-exit",
  "integration.parent-only-attribute-bound",
  "integration.parent-only-attributes",
  "integration.parent-only-canonical-handle",
  "integration.parent-only-child-has-no-stdin-pipe",
  "integration.parent-only-child-ready",
  "integration.parent-only-child-state",
  "integration.parent-only-create",
  "integration.parent-only-explicit-finish-is-finite",
  "integration.parent-only-explicit-skip-exit-survives-immediate-fuse",
  "integration.parent-only-finish-ready-reset",
  "integration.parent-only-fuse-exits-within-one-second-without-stdin",
  "integration.parent-only-fuse-survives-blocked-cleanup",
  "integration.parent-only-held-child-witness",
  "integration.parent-only-kill-actual-parent",
  "integration.parent-only-owned-job",
  "integration.parent-only-private-handle",
  "integration.parent-only-private-inheritance",
  "integration.parent-only-private-signals",
  "integration.parent-only-ready-signal",
  "integration.parent-only-real-lifetime-armed",
  "integration.parent-only-root-cleanup-job",
  "integration.parent-only-shared-state",
  "integration.parent-only-stdin-is-not-a-pipe",
  "integration.parent-only-test-image",
  "integration.process-bound",
  "integration.process-creation-nonzero",
  "integration.process-creation-witness",
  "integration.process-first",
  "integration.process-snapshot",
  "integration.reply-bound",
  "integration.reply-deadline",
  "integration.reply-frame-bound",
  "integration.reply-pipe",
  "integration.reply-read",
  "integration.reply-single-frame",
  "integration.request-bound",
  "integration.request-write",
  "integration.restricted-handles",
  "integration.shutdown-ack-before-exit",
  "integration.shutdown-clean-code",
  "integration.shutdown-process-exit",
  "integration.stderr-pipe",
  "integration.stderr-private",
  "integration.stdin-pipe",
  "integration.stdin-private",
  "integration.stdout-pipe",
  "integration.stdout-private",
  "integration.temporary-create",
  "integration.temporary-directory",
  "integration.temporary-unique",
  "integration.test-elevated-token-emits-no-serving-frames",
  "integration.test-elevated-token-refuses-with-exit-one",
  "integration.test-elevated-token-refuses-within-startup-bound",
  "integration.token-acl-appended-ace",
  "integration.token-acl-bounded-overflow-refusal",
  "integration.token-acl-conservative-lower-bound",
  "integration.token-acl-exact-single-user-append",
  "integration.token-acl-fixed-query-sizes",
  "integration.token-acl-malformed-ace-refusal",
  "integration.token-acl-malformed-groups-refusal",
  "integration.token-acl-preserves-existing-denies",
  "integration.token-acl-rejects-assignment-flags",
  "integration.token-acl-rejects-creator-substitution",
  "integration.token-acl-rejects-multiple-appends",
  "integration.token-acl-rejects-unsupported-or-null",
  "integration.token-acl-rejects-weak-or-wrong-append",
  "integration.token-acl-test-sid",
  "integration.token-acl-test-source",
  "integration.token-acl-truncated-sid-refusal",
  "integration.token-acl-zero-restricted-sids",
  "integration.unit-image",
  "integration.windows-permanent-feature-limits",
  "integration.windows-permissions",
  "lifecycle.h",
  "manifest.as-invoker-without-uiaccess",
  "manifest.duplicate-execution-level",
  "manifest.duplicate-fixture-refused",
  "manifest.duplicate-setting",
  "manifest.empty-setting",
  "manifest.execution-and-supported-os",
  "manifest.legacy-per-monitor-dpi",
  "manifest.load-as-data",
  "manifest.long-path-aware",
  "manifest.nested-setting",
  "manifest.per-monitor-v2",
  "manifest.required-attribute",
  "manifest.stream-write",
  "manifest.utf8-codepage",
  "pe.coff-header",
  "pe.dos-read",
  "pe.dos-signature",
  "pe.executable-kind",
  "pe.machine-matches-json-architecture",
  "pe.nt-signature",
  "pe.open",
  "pe.optional-header",
  "pe.windows-gui-subsystem",
  "permissions.status",
  "probe.unverified-parent-refused",
  "protocol.h",
  "report.json",
  "self-test.actual-check-count",
  "self-test.no-core-skip",
  "self-test.real-check-catalog",
  "self-test.report-envelope",
  "self-test.unique-check-names",
  "server.h",
  "unit.executable-path",
  "unit.resource-load",
  "unit.resource-lock",
  "unit.resource-missing",
  "unit.resource-size",
  "unit.shipping-executable-missing",
  "unit.unexpected-arguments",
  "vector-computer.exe",
  "vector-desktop-beta.exe",
  "vector-desktop-dev.exe",
  "vector-desktop.exe",
  "version-resource.file-description",
  "version-resource.fixed-bound",
  "version-resource.fixed-info",
  "version-resource.fixed-kind",
  "version-resource.numeric-equality",
  "version-resource.numeric-version",
  "version-resource.original-filename",
  "version-resource.product-name",
  "version-resource.read",
  "version-resource.size",
  "version-resource.string-bound",
  "version-resource.string-missing",
  "version-resource.string-terminator",
  "version-resource.version-strings",
  "version.actual-json-equality",
  "version.attribute-handles",
  "version.attribute-init",
  "version.attribute-size",
  "version.deadline",
  "version.helper-version",
  "version.output-bound",
  "version.pipe-create",
  "version.pipe-parent-only",
  "version.pipe-peek",
  "version.pipe-read",
  "version.platform",
  "version.process-create",
  "version.process-wait",
  "version.source-digest",
  "version.stdin-create",
] as const
export const WINDOWS_CALLER_STAGES = [
  "layout-image",
  "layout-name",
  "layout-self-ancestors",
  "layout-helper-ancestors",
  "layout-self-file",
  "layout-helper-file",
  "layout-install-root",
  "arguments",
  "parent-witness",
  "apartment",
  "token",
  "layout",
  "ancestors",
  "medium-admission",
  "restricted-token",
  "bootstrap-launch",
  "bootstrap-current",
  "child-exit",
  "final-current",
  "helper-launch",
  "console-control",
  "bootstrap-child-exit-failure",
  "helper-child-exit-failure",
  "bootstrap-child-exit-usage",
  "helper-child-exit-usage",
  "bootstrap-child-exit-access-violation",
  "helper-child-exit-access-violation",
  "bootstrap-child-exit-stack-overflow",
  "helper-child-exit-stack-overflow",
  "bootstrap-child-exit-dll-missing",
  "helper-child-exit-dll-missing",
  "bootstrap-child-exit-dll-initialization",
  "helper-child-exit-dll-initialization",
  "bootstrap-child-exit-fast-fail",
  "helper-child-exit-fast-fail",
  "bootstrap-child-exit-invalid-parameter",
  "helper-child-exit-invalid-parameter",
  "bootstrap-child-exit-other",
  "helper-child-exit-other",
  "desktop-observation",
  "desktop-access",
  "desktop-private-security",
  "desktop-private-station",
  "desktop-private-default",
  "desktop-private-access",
  "restricted-default-dacl",
  "restricted-acl-access-check",
  "restricted-acl-append-build",
  "restricted-acl-append-read",
  "restricted-acl-append-verify",
  "restricted-acl-basic-identity",
  "restricted-acl-descriptor",
  "restricted-acl-duplicate",
  "restricted-acl-observe-default",
  "restricted-acl-observe-identity",
  "restricted-acl-postproof",
  "restricted-acl-preproof",
  "restricted-acl-query-default",
  "restricted-acl-query-groups",
  "restricted-acl-query-inert",
  "restricted-acl-query-integrity",
  "restricted-acl-query-mandatory",
  "restricted-acl-query-owner",
  "restricted-acl-query-primary",
  "restricted-acl-query-privileges",
  "restricted-acl-query-restricting",
  "restricted-acl-query-restrictions",
  "restricted-acl-query-statistics",
  "restricted-acl-query-unknown",
  "restricted-acl-query-user",
  "restricted-acl-readback",
  "restricted-acl-set",
  "restricted-acl-shape-acl",
  "restricted-acl-shape-creator",
  "restricted-acl-shape-extent",
  "restricted-acl-shape-flags",
  "restricted-acl-shape-sid",
  "restricted-acl-shape-type",
  "restricted-acl-snapshot-identity",
  "restricted-acl-unchanged",
] as const
export const WINDOWS_DACL_REASONS = {
  s: "complete",
  q: "token-query-failed",
  o: "user-or-owner-invalid",
  g: "primary-group-invalid",
  m: "default-record-missing",
  z: "null-default-dacl",
  i: "invalid-acl",
  t: "unsupported-ace",
  r: "unsupported-generic-mask",
  v: "descriptor-failed",
  p: "duplicate-token-failed",
  a: "access-check-failed",
  e: "observer-exception",
  b: "restricted-user-dacl-repaired",
} as const
export type WindowsCallerContext = {
  tokenRoute: "already-serving" | "validated-linked" | "restricted-fallback"
  desktop: "parent-proved" | "owned-proved"
  owner: "user" | "other" | "unknown"
  defaultDaclProcessAll: "granted" | "denied" | "unknown"
  defaultDaclReason: (typeof WINDOWS_DACL_REASONS)[keyof typeof WINDOWS_DACL_REASONS]
}
export type WindowsDiagnostic = {
  unitSuite?: (typeof WINDOWS_UNIT_SUITES)[number]
  unitFailure?: (typeof WINDOWS_UNIT_FAILURE_LABELS)[number]
  caller?: `initial.${(typeof WINDOWS_CALLER_STAGES)[number]}` | `medium.${(typeof WINDOWS_CALLER_STAGES)[number]}`
  helper?: "safe-start" | "token-read"
  tokenRoute?: "already-serving" | "validated-linked" | "restricted-fallback"
  desktop?: "parent-proved" | "owned-proved"
  context?: WindowsCallerContext
}
const unitLabels = new Set<string>(WINDOWS_UNIT_FAILURE_LABELS)
const callerTokens = new Set<string>(WINDOWS_CALLER_STAGES.flatMap((stage) => [`initial.${stage}`, `medium.${stage}`]))

export function windowsDiagnostic(value: unknown): WindowsDiagnostic {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Windows diagnostics.")
  const body = value as Record<string, unknown>
  if (
    Object.keys(body).some(
      (key) => !["unitSuite", "unitFailure", "caller", "helper", "tokenRoute", "desktop", "context"].includes(key),
    ) ||
    (body.unitSuite !== undefined &&
      !WINDOWS_UNIT_SUITES.includes(body.unitSuite as WindowsDiagnostic["unitSuite"] & string)) ||
    (body.unitFailure !== undefined && (typeof body.unitFailure !== "string" || !unitLabels.has(body.unitFailure))) ||
    (body.caller !== undefined && (typeof body.caller !== "string" || !callerTokens.has(body.caller))) ||
    (body.helper !== undefined && body.helper !== "safe-start" && body.helper !== "token-read") ||
    (body.tokenRoute !== undefined &&
      (typeof body.tokenRoute !== "string" ||
        !["already-serving", "validated-linked", "restricted-fallback"].includes(body.tokenRoute) ||
        body.caller === undefined)) ||
    (body.desktop !== undefined &&
      (typeof body.desktop !== "string" ||
        !["parent-proved", "owned-proved"].includes(body.desktop) ||
        body.tokenRoute === undefined))
  )
    throw new Error("Invalid Windows diagnostics.")
  return {
    ...(body.unitSuite === undefined ? {} : { unitSuite: body.unitSuite as WindowsDiagnostic["unitSuite"] }),
    ...(body.unitFailure === undefined ? {} : { unitFailure: body.unitFailure as WindowsDiagnostic["unitFailure"] }),
    ...(body.caller === undefined ? {} : { caller: body.caller as WindowsDiagnostic["caller"] }),
    ...(body.helper === undefined ? {} : { helper: body.helper as WindowsDiagnostic["helper"] }),
    ...(body.tokenRoute === undefined ? {} : { tokenRoute: body.tokenRoute as WindowsDiagnostic["tokenRoute"] }),
    ...(body.desktop === undefined ? {} : { desktop: body.desktop as WindowsDiagnostic["desktop"] }),
    ...(body.context === undefined ? {} : { context: windowsCallerContext(body.context) }),
  }
}

function windowsCallerContext(value: unknown): WindowsCallerContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Windows caller context.")
  const body = value as Record<string, unknown>
  if (
    Object.keys(body).length !== 5 ||
    Object.keys(body).some(
      (key) => !["tokenRoute", "desktop", "owner", "defaultDaclProcessAll", "defaultDaclReason"].includes(key),
    ) ||
    typeof body.tokenRoute !== "string" ||
    !["already-serving", "validated-linked", "restricted-fallback"].includes(body.tokenRoute) ||
    typeof body.desktop !== "string" ||
    !["parent-proved", "owned-proved"].includes(body.desktop) ||
    typeof body.owner !== "string" ||
    !["user", "other", "unknown"].includes(body.owner) ||
    typeof body.defaultDaclProcessAll !== "string" ||
    !["granted", "denied", "unknown"].includes(body.defaultDaclProcessAll) ||
    typeof body.defaultDaclReason !== "string" ||
    !(Object.values(WINDOWS_DACL_REASONS) as string[]).includes(body.defaultDaclReason) ||
    (body.defaultDaclReason === "restricted-user-dacl-repaired"
      ? body.defaultDaclProcessAll !== "granted" ||
        body.owner === "unknown" ||
        body.tokenRoute !== "restricted-fallback"
      : body.defaultDaclReason === "complete"
        ? body.defaultDaclProcessAll === "unknown" || body.owner === "unknown"
        : body.defaultDaclProcessAll !== "unknown")
  )
    throw new Error("Invalid Windows caller context.")
  return {
    tokenRoute: body.tokenRoute,
    desktop: body.desktop,
    owner: body.owner,
    defaultDaclProcessAll: body.defaultDaclProcessAll,
    defaultDaclReason: body.defaultDaclReason,
  } as WindowsCallerContext
}

export function windowsContextReceipt(value: WindowsCallerContext) {
  const context = windowsCallerContext(value)
  const route =
    context.tokenRoute === "already-serving"
      ? "serving"
      : context.tokenRoute === "validated-linked"
        ? "linked"
        : "restricted"
  const desktop = context.desktop === "parent-proved" ? "parent" : "owned"
  const owner = context.owner === "user" ? "u" : context.owner === "other" ? "x" : "n"
  const access =
    context.defaultDaclProcessAll === "granted" ? "g" : context.defaultDaclProcessAll === "denied" ? "d" : "n"
  const cause = Object.entries(WINDOWS_DACL_REASONS).find(([, reason]) => reason === context.defaultDaclReason)![0]
  return `vector-caller-context initial r=${route} d=${desktop} o=${owner} a=${access} c=${cause}\n`
}

/** Lines are bounded independently of stream chunks; unknown text is discarded immediately. */
export class WindowsDiagnosticReader {
  private value: WindowsDiagnostic = {}
  private lines = { stdout: "", stderr: "" }
  private overflow = { stdout: false, stderr: false }
  private remaining = 65_536
  constructor(private readonly mode: "unit" | "caller") {}
  consume(bytes: Uint8Array, stream: "stdout" | "stderr") {
    const bounded = bytes.subarray(0, this.remaining)
    this.remaining -= bounded.length
    for (const byte of bounded) {
      if (byte === 10) {
        if (!this.overflow[stream]) {
          const line = this.lines[stream].replace(/\r$/, "")
          if (!this.value.context && stream === "stderr") {
            const context =
              /^vector-caller-context initial r=(serving|linked|restricted) d=(parent|owned) o=(u|x|n) a=(g|d|n) c=(s|q|o|g|m|z|i|t|r|v|p|a|e|b)$/.exec(
                line,
              )
            if (
              context &&
              (context[5] === "b"
                ? context[1] === "restricted" && context[4] === "g" && context[3] !== "n"
                : context[5] === "s"
                  ? context[4] !== "n" && context[3] !== "n"
                  : context[4] === "n")
            )
              this.value.context = {
                tokenRoute:
                  context[1] === "serving"
                    ? "already-serving"
                    : context[1] === "linked"
                      ? "validated-linked"
                      : "restricted-fallback",
                desktop: context[2] === "parent" ? "parent-proved" : "owned-proved",
                owner: context[3] === "u" ? "user" : context[3] === "x" ? "other" : "unknown",
                defaultDaclProcessAll: context[4] === "g" ? "granted" : context[4] === "d" ? "denied" : "unknown",
                defaultDaclReason: WINDOWS_DACL_REASONS[context[5] as keyof typeof WINDOWS_DACL_REASONS],
              }
            if (context && this.value.caller?.startsWith("initial.") && !this.value.tokenRoute && this.value.context) {
              this.value.tokenRoute = this.value.context.tokenRoute
              this.value.desktop = this.value.context.desktop
            }
          }
          if (this.mode === "unit" && stream === "stdout" && line.startsWith("PASS ")) {
            const suite = line.slice(5)
            const index = WINDOWS_UNIT_SUITES.indexOf(suite as (typeof WINDOWS_UNIT_SUITES)[number])
            if (
              index >= 0 &&
              (this.value.unitSuite === undefined || index > WINDOWS_UNIT_SUITES.indexOf(this.value.unitSuite))
            )
              this.value.unitSuite = WINDOWS_UNIT_SUITES[index]
          }
          if (this.mode === "unit" && stream === "stderr" && line.startsWith("FAIL ") && unitLabels.has(line.slice(5)))
            this.value.unitFailure = line.slice(5) as WindowsDiagnostic["unitFailure"]
          if (!this.value.caller && stream === "stderr") {
            const caller =
              /^vector-caller-failure ((?:initial|medium)\.[a-z-]+)(?: r=(s|l|r|serving|linked|restricted))?(?: d=(parent|owned))?$/.exec(
                line,
              )
            if (caller && callerTokens.has(caller[1]!) && (!caller[3] || caller[2])) {
              this.value.caller = caller[1] as WindowsDiagnostic["caller"]
              if (caller[2])
                this.value.tokenRoute =
                  caller[2] === "serving" || caller[2] === "s"
                    ? "already-serving"
                    : caller[2] === "linked" || caller[2] === "l"
                      ? "validated-linked"
                      : "restricted-fallback"
              if (caller[3]) this.value.desktop = caller[3] === "parent" ? "parent-proved" : "owned-proved"
              if (caller[1]!.startsWith("initial.") && !caller[2] && this.value.context) {
                this.value.tokenRoute = this.value.context.tokenRoute
                this.value.desktop = this.value.context.desktop
              }
            }
          }
          if (!this.value.helper && stream === "stderr") {
            if (line === "The computer helper could not start safely.") this.value.helper = "safe-start"
            if (line === "The helper process token could not be read.") this.value.helper = "token-read"
          }
        }
        this.lines[stream] = ""
        this.overflow[stream] = false
      } else if (this.lines[stream].length < 192) this.lines[stream] += String.fromCharCode(byte)
      else this.overflow[stream] = true
    }
  }
  finish() {
    return windowsDiagnostic(this.value)
  }
}

export class WindowsCheckFailure extends Error {
  constructor(readonly reason: string) {
    const caller =
      /^windows-caller-((?:initial|medium)\.[a-z-]+)(?:\.route-(already-serving|validated-linked|restricted-fallback))?(?:\.desktop-(parent-proved|owned-proved))?(?:\.helper-(safe-start|token-read))?$/.exec(
        reason,
      )
    const known = caller && callerTokens.has(caller[1]!) && (!caller[3] || caller[2])
    const helper = reason === "windows-helper-safe-start" || reason === "windows-helper-token-read"
    const fixed = [
      "deadline",
      "output-limit",
      "invalid-json",
      "invalid-permissions",
      "invalid-responsible",
      "invalid-elevated",
      "invalid-capture-blocked",
      "no-frame",
    ]
    const command = /^windows-(?:probe|channel)-(.+)$/.exec(reason)?.[1]
    const exit = command ? /^exit-(0|[1-9][0-9]{0,2}|unknown)$/.exec(command)?.[1] : undefined
    if (
      !known &&
      !helper &&
      !(command && fixed.includes(command)) &&
      !(exit && (exit === "unknown" || Number(exit) <= 255))
    )
      throw new Error("Invalid Windows check failure.")
    super(reason)
  }
}
export function windowsCommandReason(
  result: { code: number | null; timedOut?: boolean; diagnostic?: { windows?: WindowsDiagnostic } },
  mode: "probe" | "channel",
) {
  const observed = result.diagnostic?.windows
  if (observed?.caller)
    return `windows-caller-${observed.caller}${observed.tokenRoute ? `.route-${observed.tokenRoute}` : ""}${observed.desktop ? `.desktop-${observed.desktop}` : ""}${observed.helper ? `.helper-${observed.helper}` : ""}`
  if (observed?.helper) return `windows-helper-${observed.helper}`
  if (result.timedOut) return `windows-${mode}-deadline`
  const code = result.code
  return `windows-${mode}-exit-${Number.isSafeInteger(code) && code !== null && code >= 0 && code <= 255 ? code : "unknown"}`
}
