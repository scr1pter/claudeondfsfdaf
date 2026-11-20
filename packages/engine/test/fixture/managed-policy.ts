import { existsSync } from "node:fs"
import path from "node:path"
import { ConfigManaged } from "@vectordevai/core/config/managed"

// These fixtures exercise policy semantics, not Windows ACL discovery. The real PowerShell allow/deny integration
// stays in config/managed-trust.test.ts. Limit this reader to the fixture's own existing managed folder and files.
export function useManagedPolicyFixture(directory: string) {
  if (process.platform !== "win32") return () => {}
  ConfigManaged.useTestDirectory(directory, managedPolicyAcl(directory))
  return () => ConfigManaged.useTestDirectory(directory)
}

/**
 * The fixture's Windows ACL reader: SYSTEM owns the managed folder and each managed file in it that exists, a folder
 * named vector.json included, with no other rules. Exported so tests on any platform can check what it answers.
 */
export function managedPolicyAcl(directory: string): ConfigManaged.AclReader {
  const owned = new Set([directory, path.join(directory, "vector.json"), path.join(directory, "vector.jsonc")])
  return (paths) => ({
    entries: Object.fromEntries(
      paths
        .filter((target) => owned.has(target) && existsSync(target))
        .map((target) => [target, { owner: "S-1-5-18", rules: [] }]),
    ),
  })
}
