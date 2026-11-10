export * as TaskReport from "./task-report"

// How a task batch's reports share the one tool output they return in (multi-agent contract 5.C.5). Cutting the joined
// block from its end would drop the last children's reports whole, so each report gets a fair share instead: a short
// one is kept whole, and a long one is cut to its share with its full text saved to a file the cut names.

export type Size = { readonly bytes: number; readonly lines: number }
export type Cut = { readonly maxBytes: number; readonly maxLines: number }

/** Room each entry's envelope takes beside its report: its tags, a summary line and the blank line between entries. */
export const ENVELOPE: Size = { bytes: 256, lines: 8 }

/**
 * Splits `total` among entries of the given sizes by water-filling: in ascending size, each takes what it needs or an
 * even part of what is left, whichever is less. The shares never add up to more than `total`, and an entry never gets
 * less than `floor(total / n)` unless it needs less.
 */
export function shares(sizes: readonly number[], total: number): number[] {
  const result = sizes.map(() => 0)
  let remaining = Math.max(0, Math.floor(total))
  const order = sizes
    .map((size, index) => ({ size: Math.max(0, Math.floor(size)), index }))
    .toSorted((left, right) => left.size - right.size || left.index - right.index)
  order.forEach((entry, position) => {
    const share = Math.min(entry.size, Math.floor(remaining / (order.length - position)))
    result[entry.index] = share
    remaining -= share
  })
  return result
}

/**
 * Where each report is cut so the entries fit `limits` together: undefined keeps it whole. `reserved` is room the
 * output needs beside its entries, and `notice` the most a cut adds to the text it keeps.
 */
export function cuts(
  reports: readonly Size[],
  limits: Cut,
  options: { readonly reserved?: Size; readonly notice: Size },
): (Cut | undefined)[] {
  const count = reports.length
  const totals: Size = {
    bytes: limits.maxBytes - count * ENVELOPE.bytes - (options.reserved?.bytes ?? 0),
    lines: limits.maxLines - count * ENVELOPE.lines - (options.reserved?.lines ?? 0),
  }
  // A cut report also carries the notice naming its saved file, so it asks for that room as well, in both measures.
  // Asking for more can leave another report short, so the set of cut reports grows until none is left short.
  const cut = new Set<number>()
  while (true) {
    const share = (key: keyof Size) =>
      shares(
        reports.map((report, index) => report[key] + (cut.has(index) ? options.notice[key] : 0)),
        totals[key],
      )
    const bytes = share("bytes")
    const lines = share("lines")
    const short = reports.flatMap((report, index) =>
      !cut.has(index) && (report.bytes > bytes[index] || report.lines > lines[index]) ? [index] : [],
    )
    if (short.length === 0)
      return reports.map((_, index) =>
        cut.has(index)
          ? {
              maxBytes: Math.max(0, bytes[index] - options.notice.bytes),
              maxLines: Math.max(0, lines[index] - options.notice.lines),
            }
          : undefined,
      )
    short.forEach((index) => cut.add(index))
  }
}

/** A text's size as a cut counts it. */
export function size(text: string): Size {
  return { bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length }
}
