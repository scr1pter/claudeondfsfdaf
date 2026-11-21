import { describe, expect, test } from "bun:test"
import { reviewPermissionRules } from "@vectordevai/core/review/permission"
import { Permission } from "@/permission"
import { ReviewMcp } from "@/review/mcp"

// In-process descriptors only. No SDK transport, subprocess, model or remote server is started.
const fake = {
  endpoint: "https://fake.invalid/mcp?token=owner-secret",
  instructions: "Untrusted server instructions",
  capability: { kind: "tool", id: "read_invoice", schemaHash: ReviewMcp.digest(['{"type":"object"}']) },
  annotations: { readOnlyHint: true },
} as const
const context = { owner: "owner-one", repository: "project-one", server: "billing" }
const identity = {
  serverIdentity: "fake-server-01",
  endpointHash: ReviewMcp.digest(["https", fake.endpoint]),
  capabilitiesHash: ReviewMcp.digest([fake.capability.id, fake.capability.schemaHash]),
}
const input = { context, identity, capability: fake.capability, trust: "untrusted", use: "snapshot" } as const
const grant: ReviewMcp.Grant = { ...context, ...identity, selected: [{ ...fake.capability, access: "read" }] }
const source = () => [grant]

describe("VectorScope MCP consent", () => {
  test("only one matching owner/repository/server grant admits an explicitly selected read", () => {
    expect(ReviewMcp.decide(input).status).toBe("missing-grant")
    for (const key of ["owner", "repository", "server"] as const)
      expect(ReviewMcp.decide({ ...input, context: { ...context, [key]: "other" } }, source).status).toBe(
        "missing-grant",
      )
    expect(ReviewMcp.decide(input, () => [grant, grant]).status).toBe("ambiguous-grant")
    expect(ReviewMcp.decide(input, source).status).toBe("granted-read")
    expect(ReviewMcp.decide({ ...input, capability: { ...fake.capability, kind: "resource" } }, source).status).toBe(
      "capability-denied",
    )
    expect(ReviewMcp.decide(input, () => [{ ...grant, selected: [...grant.selected, ...grant.selected] }]).status).toBe(
      "capability-denied",
    )
  })
  test("tool names and server readOnlyHint cannot authorize unknown or possibly-writing operations", () => {
    const spoof = { ...fake.capability, id: "get_or_delete", annotations: fake.annotations }
    expect(ReviewMcp.decide({ ...input, capability: spoof }, source).status).toBe("capability-denied")
    for (const access of ["unknown", "possibly-writing"] as const) {
      const unsafe = { ...grant, selected: [{ ...spoof, access }] }
      expect(ReviewMcp.decide({ ...input, capability: spoof }, () => [unsafe]).status).toBe("capability-denied")
    }
  })
  test("changes to the endpoint, server, whole inventory or individual schema invalidate approval", () => {
    for (const key of ["serverIdentity", "endpointHash", "capabilitiesHash"] as const)
      expect(
        ReviewMcp.decide({ ...input, identity: { ...identity, [key]: ReviewMcp.digest(["updated"]) } }, source).status,
      ).toBe("identity-changed")
    const changed = { ...fake.capability, schemaHash: ReviewMcp.digest(["other schema"]) }
    expect(ReviewMcp.decide({ ...input, capability: changed }, source).status).toBe("capability-denied")
    const bad = { ...input, identity: { ...identity, endpointHash: "" } }
    expect(ReviewMcp.decide(bad, () => [{ ...grant, endpointHash: "" }]).status).toBe("identity-changed")
  })
  test("no live route or alternate MCP read, and no raw capability, arguments or credentials in the audit", () => {
    expect(ReviewMcp.LIVE_REVIEW_MCP).toBe(false)
    let reads = 0
    const count = () => {
      reads++
      return [grant]
    }
    for (const trust of ["trusted", "untrusted"] as const) {
      const decision = ReviewMcp.decide({ ...input, use: "live", trust }, count)
      expect(decision.status).toBe(trust === "trusted" ? "live-disabled" : "untrusted-live")
    }
    expect(reads).toBe(0)
    expect(
      Permission.evaluate("read", "mcp:billing:file:///private.env.example", reviewPermissionRules({})).action,
    ).toBe("deny")
    const canary = "secret-query-data"
    const request = { ...input, arguments: { query: canary } }
    const audit = ReviewMcp.decide(request, () => {
      throw new Error(fake.endpoint + canary)
    })
    expect(audit.status).toBe("unavailable")
    expect(Object.keys(audit.audit).sort()).toEqual(["capabilityHash", "contextHash", "identityHash", "status"])
    for (const value of [context.server, canary, "owner-secret", fake.instructions, fake.capability.id])
      expect(JSON.stringify(audit)).not.toContain(value)
  })
})
