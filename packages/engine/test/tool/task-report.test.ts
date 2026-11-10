import { describe, expect, test } from "bun:test"
import { TaskReport } from "../../src/tool/task-report"

// How a task batch's reports share one tool output (multi-agent contract 5.C.5): water-filling in ascending size.

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

// A small deterministic generator, so the property cases are the same on every run.
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

describe("TaskReport.shares", () => {
  test("short entries keep everything and the rest split what is left", () => {
    expect(TaskReport.shares([40_960, 40_960, 1_024], 50_432)).toEqual([24_704, 24_704, 1_024])
    expect(TaskReport.shares([10, 20, 30], 1_000)).toEqual([10, 20, 30])
    expect(TaskReport.shares([], 1_000)).toEqual([])
  })

  test("equal entries past the total get equal parts", () => {
    expect(TaskReport.shares([100, 100, 100, 100], 200)).toEqual([50, 50, 50, 50])
  })

  test("an entry's share follows its own size, not its position", () => {
    expect(TaskReport.shares([5_000, 10, 5_000], 1_010)).toEqual([500, 10, 500])
  })

  test("a total at or below zero gives nothing", () => {
    expect(TaskReport.shares([10, 20], 0)).toEqual([0, 0])
    expect(TaskReport.shares([10, 20], -50)).toEqual([0, 0])
  })

  test("properties: within the total, never above a size, never below an even part unless it needs less", () => {
    const next = random(7)
    for (let round = 0; round < 500; round++) {
      const count = 1 + Math.floor(next() * 8)
      const sizes = Array.from({ length: count }, () => Math.floor(next() * 60_000))
      const total = Math.floor(next() * 80_000)
      const result = TaskReport.shares(sizes, total)
      expect(result).toHaveLength(count)
      expect(sum(result)).toBeLessThanOrEqual(total)
      result.forEach((share, index) => {
        expect(share).toBeLessThanOrEqual(sizes[index]!)
        expect(share).toBeGreaterThanOrEqual(Math.min(sizes[index]!, Math.floor(total / count)))
      })
      // Nothing is left over while an entry still needs more.
      if (sum(sizes) > total) expect(total - sum(result)).toBeLessThan(count)
      else expect(result).toEqual(sizes)
    }
  })
})

describe("TaskReport.cuts", () => {
  const limits = { maxBytes: 51_200, maxLines: 2_000 }
  const notice = { bytes: 300, lines: 5 }

  test("reports that fit together are kept whole", () => {
    expect(TaskReport.cuts([TaskReport.size("a"), TaskReport.size("b\nc")], limits, { notice })).toEqual([
      undefined,
      undefined,
    ])
  })

  test("long reports are cut to their share less the notice, and a short one stays whole", () => {
    const reports = [{ bytes: 40_960, lines: 41 }, { bytes: 40_960, lines: 41 }, { bytes: 1_024, lines: 2 }]
    const cuts = TaskReport.cuts(reports, limits, { notice })
    expect(cuts[2]).toBeUndefined()
    const bytes = TaskReport.shares([40_960, 40_960, 1_024], limits.maxBytes - 3 * TaskReport.ENVELOPE.bytes)
    // Cut by bytes alone: every line still fits beside the notice.
    expect(cuts[0]).toEqual({ maxBytes: bytes[0]! - notice.bytes, maxLines: 41 })
    expect(cuts[1]).toEqual(cuts[0])
  })

  test("a report of one long line cut by bytes keeps its line", () => {
    expect(TaskReport.cuts([{ bytes: 60_000, lines: 1 }], limits, { notice })).toEqual([
      { maxBytes: limits.maxBytes - TaskReport.ENVELOPE.bytes - notice.bytes, maxLines: 1 },
    ])
  })

  test("lines are shared the same way, and room kept beside the entries is taken off first", () => {
    const reports = [{ bytes: 400, lines: 1_800 }, { bytes: 100, lines: 10 }]
    const cuts = TaskReport.cuts(reports, limits, { notice, reserved: { bytes: 0, lines: 200 } })
    expect(cuts[1]).toBeUndefined()
    // Cut by lines alone: its bytes still fit beside the notice.
    expect(cuts[0]).toEqual({
      maxBytes: 400,
      maxLines: 2_000 - 2 * TaskReport.ENVELOPE.lines - 200 - 10 - notice.lines,
    })
  })

  test("properties: the entries and their notices fit the limits together", () => {
    const next = random(11)
    for (let round = 0; round < 300; round++) {
      const count = 1 + Math.floor(next() * 8)
      const reports = Array.from({ length: count }, () => ({
        bytes: Math.floor(next() * 50_000),
        lines: 1 + Math.floor(next() * 1_500),
      }))
      const cuts = TaskReport.cuts(reports, limits, { notice })
      const used = reports.map((report, index) => {
        const cut = cuts[index]
        if (!cut) return report
        return {
          bytes: Math.min(report.bytes, cut.maxBytes) + notice.bytes,
          lines: Math.min(report.lines, cut.maxLines) + notice.lines,
        }
      })
      expect(sum(used.map((item) => item.bytes))).toBeLessThanOrEqual(
        limits.maxBytes - count * TaskReport.ENVELOPE.bytes,
      )
      expect(sum(used.map((item) => item.lines))).toBeLessThanOrEqual(
        limits.maxLines - count * TaskReport.ENVELOPE.lines,
      )
      // A report that fits its even part is never cut.
      reports.forEach((report, index) => {
        const even = {
          bytes: Math.floor((limits.maxBytes - count * TaskReport.ENVELOPE.bytes) / count),
          lines: Math.floor((limits.maxLines - count * TaskReport.ENVELOPE.lines) / count),
        }
        if (report.bytes <= even.bytes && report.lines <= even.lines) expect(cuts[index]).toBeUndefined()
      })
    }
  })

  test("a text's size counts bytes, not characters, and lines by their breaks", () => {
    expect(TaskReport.size("界\nx")).toEqual({ bytes: 5, lines: 2 })
  })
})
