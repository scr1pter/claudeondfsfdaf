import { describe, expect, test } from "bun:test"
import { fromUtf8, readPrefix, utf8 } from "../src/bytes"

// R46a (P7 addendum, R46-1): a body the Worker reads (a DNS-over-HTTPS answer, a 5xx page's first bytes) is read as it
// arrives and only to its limit. The streams here hold nothing ahead (highWaterMark 0), so each pull is one read.

function chunked(chunks: number[][], fail?: Error) {
  const stream = { pulled: 0, cancelled: 0 }
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks[stream.pulled++]
        if (next) return controller.enqueue(new Uint8Array(next))
        if (fail) return controller.error(fail)
        controller.close()
      },
      cancel() {
        stream.cancelled++
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, body }
}

describe("readPrefix", () => {
  test("a body that ends before the limit is read whole and complete", async () => {
    const { stream, body } = chunked([[1, 2], [3]])
    const read = await readPrefix(body, 4)
    expect({ bytes: [...read!.bytes], complete: read!.complete }).toEqual({ bytes: [1, 2, 3], complete: true })
    expect(stream).toEqual({ pulled: 3, cancelled: 0 })
  })

  test("reading stops once the limit has come, keeps only the limit, and cancels the rest", async () => {
    const { stream, body } = chunked([
      [1, 2],
      [3, 4],
      [5, 6],
      [7, 8],
    ])
    const read = await readPrefix(body, 4)
    expect({ bytes: [...read!.bytes], complete: read!.complete }).toEqual({ bytes: [1, 2, 3, 4], complete: false })
    expect(stream).toEqual({ pulled: 2, cancelled: 1 })

    const wide = chunked([[1, 2, 3], [4, 5, 6], [7]])
    const cut = await readPrefix(wide.body, 4)
    expect({ bytes: [...cut!.bytes], complete: cut!.complete }).toEqual({ bytes: [1, 2, 3, 4], complete: false })
    expect(wide.stream).toEqual({ pulled: 2, cancelled: 1 })
  })

  // check.ts depends on this: a 5xx page that sends exactly the limit and then stalls is judged without a further read.
  test("a body of exactly the limit is not complete even when it ends there, and the rest is cancelled", async () => {
    const { stream, body } = chunked([
      [1, 2],
      [3, 4],
    ])
    const read = await readPrefix(body, 4)
    expect({ bytes: [...read!.bytes], complete: read!.complete }).toEqual({ bytes: [1, 2, 3, 4], complete: false })
    expect(stream).toEqual({ pulled: 2, cancelled: 1 })
  })

  test("a body that fails while read answers undefined", async () => {
    const { body } = chunked([[1, 2]], new TypeError("Network connection lost."))
    expect(await readPrefix(body, 64)).toBeUndefined()
  })

  test("no body is empty and complete", async () => {
    const read = await readPrefix(null, 64)
    expect({ bytes: read!.bytes.byteLength, complete: read!.complete }).toEqual({ bytes: 0, complete: true })
  })
})

describe("fromUtf8", () => {
  test("refuses bytes that are not UTF-8", () => {
    expect(fromUtf8(new Uint8Array([0x7b, 0xff, 0x7d]))).toBeUndefined()
    expect(fromUtf8(utf8("é"))).toBe("é")
  })
})
