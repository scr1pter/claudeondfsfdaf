import { describe, expect, test } from "bun:test"
import { Patch } from "@vectordevai/core/patch"

describe("Patch", () => {
  test("recovers only the absent opening marker after strict complete-body validation", () => {
    for (const body of [
      "*** Add File: add.txt\n+added\n*** End Patch",
      "*** Update File: update.txt\n@@\n-old\n+new\n*** End Patch",
      "*** Delete File: delete.txt\n*** End Patch",
      "*** Add File: literal.txt\n+*** Begin Patch\n+*** End Patch\n*** End Patch",
      "*** Add File: large.txt\n+" + "x".repeat(24_000) + "\n*** End Patch",
      "*** Add File: windows.txt\r\n+windows\r\n*** End Patch",
    ]) {
      const recovered = Patch.recoverEnvelope(body)
      expect(recovered).toEqual({ patchText: "*** Begin Patch\n" + body, recoveredMissingBegin: true })
      expect(Patch.parse(recovered.patchText)).toEqual(Patch.parse("*** Begin Patch\n" + body))
    }
  })

  test("keeps already marked input byte-for-byte unchanged and preserves heredoc handling", () => {
    const marked = "prose\n*** Begin Patch\n*** Add File: add.txt\n+added\n*** End Patch\ntrailing prose"
    expect(Patch.recoverEnvelope(marked)).toEqual({ patchText: marked, recoveredMissingBegin: false })
    const body = "*** Add File: add.txt\n+added\n*** End Patch"
    expect(Patch.recoverEnvelope("cat <<'EOF'\n" + body + "\nEOF")).toEqual({
      patchText: "*** Begin Patch\n" + body,
      recoveredMissingBegin: true,
    })
  })

  test("never invents the ending marker or recovers a preamble, suffix, code fence or duplicate marker", () => {
    const body = "*** Add File: add.txt\n+added\n*** End Patch"
    for (const input of [
      "*** Add File: add.txt\n+truncated",
      "*** Add File: add.txt\n+truncated\n*** End Pat",
      "preamble\n" + body,
      body + "\nsuffix",
      "```diff\n" + body + "\n```",
      body + "\n*** End Patch",
      "*** Add File:    \n+added\n*** End Patch",
      "@@\n-old\n+new\n*** End Patch",
    ]) {
      expect(Patch.recoverEnvelope(input)).toEqual({ patchText: input, recoveredMissingBegin: false })
      expect(() => Patch.parse(Patch.recoverEnvelope(input).patchText)).toThrow("missing Begin/End markers")
    }
    const nested = "*** Add File: ignored.txt\n+ignored\n*** Begin Patch\n*** Delete File: delete.txt\n*** End Patch"
    expect(Patch.recoverEnvelope(nested)).toEqual({ patchText: nested, recoveredMissingBegin: false })
  })

  test("rejects every malformed recovered body instead of silently dropping its lines", () => {
    for (const input of [
      "*** Add File: add.txt\nmissing plus\n*** End Patch",
      "*** Add File: add.txt\n+added\n*** Frobnicate File: other.txt\n*** End Patch",
      "*** Update File: update.txt\n*** End Patch",
      "*** Update File: update.txt\n@@\ninvalid context\n*** End Patch",
      "*** Delete File: delete.txt\nunexpected body\n*** End Patch",
    ])
      expect(() => Patch.recoverEnvelope(input)).toThrow()
  })

  test("parses add, update, and delete hunks", () => {
    expect(
      Patch.parse(
        "*** Begin Patch\n*** Add File: add.txt\n+added\n*** Update File: update.txt\n@@ section\n-old\n+new\n*** Delete File: delete.txt\n*** End Patch",
      ),
    ).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
      {
        type: "update",
        path: "update.txt",
        chunks: [{ oldLines: ["old"], newLines: ["new"], changeContext: "section", endOfFile: undefined }],
        movePath: undefined,
      },
      { type: "delete", path: "delete.txt" },
    ])
  })

  test("strips a heredoc wrapper", () => {
    expect(Patch.parse("cat <<'EOF'\n*** Begin Patch\n*** Add File: add.txt\n+added\n*** End Patch\nEOF")).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
    ])
  })

  test("derives fuzzy line updates while preserving BOM", () => {
    const update = Patch.derive("update.txt", [{ oldLines: ["  old   "], newLines: ["new"] }], "\uFEFFold\n")
    expect(update).toEqual({ content: "new\n", bom: true })
    expect(Patch.joinBom(update.content, update.bom)).toBe("\uFEFFnew\n")
  })

  test("matches EOF-anchored chunks from the end", () => {
    expect(
      Patch.derive(
        "update.txt",
        [{ oldLines: ["marker", "end"], newLines: ["marker changed", "end"], endOfFile: true }],
        "marker\nmiddle\nmarker\nend\n",
      ).content,
    ).toBe("marker\nmiddle\nmarker changed\nend\n")
  })

  test("parses the EOF marker inside update chunks", () => {
    expect(
      Patch.parse("*** Begin Patch\n*** Update File: update.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch"),
    ).toEqual([
      {
        type: "update",
        path: "update.txt",
        movePath: undefined,
        chunks: [{ oldLines: ["last"], newLines: ["end"], changeContext: undefined, endOfFile: true }],
      },
    ])
  })

  test("rejects malformed hunk bodies", () => {
    expect(() => Patch.parse("*** Begin Patch\n*** Add File: add.txt\nmissing plus\n*** End Patch")).toThrow(
      "Invalid add file line",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Update File: update.txt\n*** End Patch")).toThrow(
      "expected at least one @@ chunk",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Delete File: delete.txt\nunexpected body\n*** End Patch")).toThrow(
      "Invalid patch line",
    )
  })
})
