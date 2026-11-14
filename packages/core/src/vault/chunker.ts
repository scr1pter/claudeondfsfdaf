export * as VaultChunker from "./chunker"

// Content-defined chunking of one file's plaintext, before compression, so an edit in one place changes only the
// chunks around it and the rest dedupe with the previous version. A gear hash over the bytes cuts where its top bits
// are zero, with normalized chunking (harder to cut before the average size, easier after) and hard minimum and
// maximum sizes. The gear table comes from the vault's chunker key (VaultCrypto.gear), so the cut points, and the chunk
// sizes the store sees, depend on a secret as well as the content.

export type Sizes = { readonly min: number; readonly avg: number; readonly max: number }

export const SIZES: Sizes = { min: 16 * 1024, avg: 64 * 1024, max: 256 * 1024 }

/** A mask of the top `bits` bits of a 32-bit hash. */
function top(bits: number) {
  return bits >= 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
}

/** The end offset of each chunk of `data`, in order; the last is `data.byteLength`. An empty file has no chunks. */
export function cut(data: Uint8Array, gear: Uint32Array, sizes: Sizes = SIZES): number[] {
  if (gear.length !== 256) throw new Error("A gear table has 256 entries.")
  if (!(sizes.min > 0 && sizes.min <= sizes.avg && sizes.avg <= sizes.max)) throw new Error("Chunk sizes are out of order.")
  const bits = Math.round(Math.log2(sizes.avg))
  const small = top(bits + 2)
  const large = top(Math.max(1, bits - 2))
  const ends: number[] = []
  for (let start = 0; start < data.byteLength; ) {
    const end = next(data, start, gear, sizes, small, large)
    ends.push(end)
    start = end
  }
  return ends
}

function next(data: Uint8Array, start: number, gear: Uint32Array, sizes: Sizes, small: number, large: number) {
  const left = data.byteLength - start
  if (left <= sizes.min) return data.byteLength
  const max = Math.min(left, sizes.max)
  const normal = Math.min(sizes.avg, max)
  let hash = 0
  let i = sizes.min
  for (; i < normal; i++) {
    hash = ((hash << 1) + gear[data[start + i]!]!) >>> 0
    if ((hash & small) >>> 0 === 0) return start + i + 1
  }
  for (; i < max; i++) {
    hash = ((hash << 1) + gear[data[start + i]!]!) >>> 0
    if ((hash & large) >>> 0 === 0) return start + i + 1
  }
  return start + max
}

/** The chunks of `data` as views into it. */
export function split(data: Uint8Array, gear: Uint32Array, sizes: Sizes = SIZES): Uint8Array[] {
  let start = 0
  return cut(data, gear, sizes).map((end) => {
    const chunk = data.subarray(start, end)
    start = end
    return chunk
  })
}
