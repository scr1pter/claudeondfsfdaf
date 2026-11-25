export * as Wildcard from "./wildcard"

export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  // The desktop renderer has no `process` (VS-23d's holdback runs there), so it matches with case, as on Linux.
  const windows = typeof process !== "undefined" && process.platform === "win32"
  return new RegExp("^" + escaped + "$", windows ? "si" : "s").test(normalized)
}
