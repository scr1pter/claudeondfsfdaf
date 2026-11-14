/** Resolve the same owned session tree for activity, output and permissions. */
export function runSessionAncestry(
  owned: Set<string>,
  lookup: (sessionID: string) => Promise<{ parentID?: string } | undefined>,
) {
  // A shared server may stream unrelated sessions too. Remember their immutable
  // parent links without retaining an unbounded negative cache in a long run.
  const parents = new Map<string, string | undefined>()
  return async function inRun(id: string | undefined, depth = 0): Promise<boolean> {
    if (!id || depth > 4) return false
    if (owned.has(id)) return true
    if (!parents.has(id)) {
      const session = await lookup(id)
      // A row may not be available yet; another event may retry that lookup.
      if (!session) return false
      parents.set(id, session.parentID)
      if (parents.size > 256) parents.delete(parents.keys().next().value!)
    }
    if (!(await inRun(parents.get(id), depth + 1))) return false
    owned.add(id)
    return true
  }
}
