/** Actions also searches for legacy ##[ commands inside a line, even after an ordinary log prefix. */
export function sanitizeActionsLog(value: string) {
  return value
    .split(/\r\n|\r|\n/)
    .map((line) => {
      // Prefix any line containing the V2 delimiter, irrespective of its leading Unicode whitespace. Ordinary
      // fixed status lines retain their wording; raw session/model data is never modified by this output function.
      const plain = line.replaceAll("##[", "## [")
      return plain.includes("::") ? `Vector output: ${plain}` : plain
    })
    .join("\n")
}
