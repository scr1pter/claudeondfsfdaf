import { describe, expect, test } from "bun:test"
import { ComputerImages } from "@/computer/images"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPFkAAAAASUVORK5CYII=",
  "base64",
)
// A complete JPEG geometry header with an APP segment and three image components; pixel decoding is separate.
const jpeg = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 1, 194, 3, 32, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff,
  0xd9,
])
const url = (mime: string, bytes: Uint8Array) => `data:image/${mime};base64,${Buffer.from(bytes).toString("base64")}`

describe("computer encoded image dimensions", () => {
  test("reads a PNG IHDR and baseline or progressive JPEG SOF", () => {
    expect(ComputerImages.dimensions(url("png", png))).toEqual({ w: 1, h: 1 })
    expect(ComputerImages.dimensions(url("jpeg", jpeg))).toEqual({ w: 800, h: 450 })
    const progressive = Buffer.from(jpeg)
    progressive[9] = 0xc2
    expect(ComputerImages.dimensions(url("jpeg", progressive))).toEqual({ w: 800, h: 450 })
  })

  test("requires the declared MIME to match the header and never fetches remote images", () => {
    for (const value of [
      url("jpeg", png),
      url("png", jpeg),
      url("gif", png),
      url("webp", png),
      "https://example.invalid/image.png",
      "file:///image.png",
      png.toString("base64"),
    ])
      expect(ComputerImages.dimensions(value)).toBeUndefined()
  })

  test("a complete PNG IHDR is required before dimensions are trusted", () => {
    for (const length of [0, 8, 16, 24, 32])
      expect(ComputerImages.dimensions(url("png", png.subarray(0, length)))).toBeUndefined()
    for (const [offset, value] of [
      [0, 0],
      [11, 12],
      [12, 0],
      [24, 3],
      [25, 7],
      [26, 1],
      [27, 1],
      [28, 2],
    ]) {
      const malformed = Buffer.from(png)
      malformed[offset] = value
      expect(ComputerImages.dimensions(url("png", malformed))).toBeUndefined()
    }
  })

  test("zero and oversized PNG declarations fail before a pixel decoder allocates", () => {
    for (const value of [0, 16_385, 0x7fff_ffff, 0xffff_ffff]) {
      for (const offset of [16, 20]) {
        const malformed = Buffer.from(png)
        malformed.writeUInt32BE(value, offset)
        expect(ComputerImages.dimensions(url("png", malformed))).toBeUndefined()
      }
    }
  })

  test("JPEG segments must be complete and the SOF component layout must be valid", () => {
    for (const length of [0, 2, 3, 5, 10, 15, 26])
      expect(ComputerImages.dimensions(url("jpeg", jpeg.subarray(0, length)))).toBeUndefined()
    for (const [offset, value] of [
      [0, 0],
      [3, 0],
      [5, 1],
      [9, 0xda],
      [9, 0xd9],
      [9, 0xd8],
      [11, 16],
      [12, 1],
      [17, 0],
      [17, 4],
      [19, 0],
      [21, 1],
      [23, 4],
    ]) {
      const malformed = Buffer.from(jpeg)
      malformed[offset] = value
      expect(ComputerImages.dimensions(url("jpeg", malformed))).toBeUndefined()
    }
    const missing = Buffer.from(jpeg)
    missing[9] = 0xc4
    expect(ComputerImages.dimensions(url("jpeg", missing))).toBeUndefined()
  })

  test("JPEG zero or oversized dimensions are rejected", () => {
    for (const value of [0, 16_385, 65_535]) {
      for (const offset of [13, 15]) {
        const malformed = Buffer.from(jpeg)
        malformed.writeUInt16BE(value, offset)
        expect(ComputerImages.dimensions(url("jpeg", malformed))).toBeUndefined()
      }
    }
  })

  test("base64 header syntax is checked before decoding", () => {
    const encoded = png.toString("base64")
    for (const data of ["", "A", `!${encoded}`, `${encoded}\n`, encoded.slice(0, 8) + "=" + encoded.slice(9)])
      expect(ComputerImages.dimensions(`data:image/png;base64,${data}`)).toBeUndefined()
  })

  test("large payloads remain bounded and a JPEG SOF beyond the header budget is refused", () => {
    expect(ComputerImages.dimensions(url("png", Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)])))).toEqual({
      w: 1,
      h: 1,
    })
    const app = Buffer.alloc(65_535)
    app.writeUInt16BE(app.length, 0)
    const late = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), app, jpeg.subarray(8)])
    expect(ComputerImages.dimensions(url("jpeg", late))).toBeUndefined()
  })
})
