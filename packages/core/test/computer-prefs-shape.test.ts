import { describe, expect, test } from "bun:test"
import { SchemaAST } from "effect"
import { Computer } from "@vectordevai/schema/computer"

// INV-T1: there is no hidden mode. No preference, policy field, bridge command, IPC command or engine option exists
// that hides, silences or disables the glow or the banner while Vector Hands holds the computer.

/** Words a field or command that hid the overlay would carry. */
const HIDING =
  /hid(e|den|ing)|invisib|stealth|silen(t|ce)|quiet|mute|conceal|suppress|headless|unseen|overlay|glow|banner|indicator|border/i

function keys(ast: SchemaAST.AST, seen = new Set<SchemaAST.AST>()): string[] {
  if (seen.has(ast)) return []
  seen.add(ast)
  switch (ast._tag) {
    case "Objects":
      return [
        ...ast.propertySignatures.flatMap((property) => [String(property.name), ...keys(property.type, seen)]),
        ...ast.indexSignatures.flatMap((index) => keys(index.type, seen)),
      ]
    case "Union":
      return ast.types.flatMap((member) => keys(member, seen))
    case "Arrays":
      return [...ast.elements, ...ast.rest].flatMap((element) => keys(element, seen))
    case "Suspend":
      return keys(ast.thunk(), seen)
    default:
      return []
  }
}

const schemaKeys = (...schemas: { readonly ast: SchemaAST.AST }[]) => [...new Set(schemas.flatMap((s) => keys(s.ast)))]

const bridgeRequests = Object.values(Computer.BridgeCommands).map((command) => command.request)

describe("computer prefs, policy and commands shape", () => {
  test("prefs, policy and commands have no field that hides the overlay", () => {
    const surfaces: Record<string, readonly string[]> = {
      prefs: Computer.PREFS_KEYS,
      policy: Computer.POLICY_KEYS,
      settings: Computer.SETTINGS_KEYS,
      "renderer API": Computer.PLATFORM_KEYS,
      "bridge commands": schemaKeys(Computer.BridgeRequest, ...bridgeRequests),
      capabilities: schemaKeys(Computer.Capabilities),
      state: schemaKeys(Computer.ComputerState),
      "IPC command argument": schemaKeys(Computer.CommandArg),
      "engine tool input": schemaKeys(Computer.ToolInput),
      "IPC channels": Computer.IPC_CHANNELS,
      "IPC commands": Computer.Command.literals,
      "banner actions": Computer.OverlayAction.literals,
      "bridge command names": Computer.BridgeCommandName.literals,
      "tool actions": Computer.ToolAction.literals,
    }
    for (const [surface, names] of Object.entries(surfaces)) {
      expect(names.length, surface).toBeGreaterThan(0)
      expect(
        names.filter((name) => HIDING.test(name)),
        surface,
      ).toEqual([])
    }
  })

  test("the key walk reaches nested fields", () => {
    const bridge = schemaKeys(Computer.BridgeRequest)
    for (const key of ["lease", "steps", "kind", "modifiers", "approvals", "requestID", "liftDeny", "scope", "budget"])
      expect(bridge).toContain(key)
    expect(schemaKeys(Computer.ComputerState)).toEqual(
      expect.arrayContaining(["escStops", "reduceMotion", "ask", "canAlways"]),
    )
    expect(schemaKeys(Computer.ToolInput)).toEqual(expect.arrayContaining(["actions", "intent", "region", "x0"]))
  })

  test("the pattern catches the fields a hidden mode would need", () => {
    for (const name of [
      "hideBanner",
      "hidden",
      "showOverlay",
      "noGlow",
      "silent",
      "quietMode",
      "invisible",
      "stealth",
      "suppressIndicator",
      "headless",
      "hide-overlay",
    ])
      expect(HIDING.test(name), name).toBe(true)
  })

  test("the only ways to stop showing the overlay are to stop the work", () => {
    // Commands and banner actions either stop, pause, resume, hand control over or answer an ask.
    expect(Computer.Command.literals.map(String).sort()).toEqual(
      ["hand-over", "not-now", "resume", "stop", "stop-session", "takeover"].sort(),
    )
    expect(Computer.OverlayAction.literals.map(String).sort()).toEqual(
      ["allow", "continue", "deny", "hand-over", "keep-going", "not-now", "resume", "stop", "takeover"].sort(),
    )
    // The banner never offers Always allow. Every ask answer, including Keep going, Hand over and Not now, is bound
    // to the open ask's request id; stop, take over and resume never are.
    expect(Computer.OverlayAction.literals).not.toContain("always")
    expect([...Computer.OVERLAY_ANSWERS].sort()).toEqual([
      "allow",
      "continue",
      "deny",
      "hand-over",
      "keep-going",
      "not-now",
    ])
    // Locked use is deferred, so no capability can claim it.
    expect(Computer.Capabilities.fields.features.fields.locked.literal).toBe(false)
  })
})
