import { describe, expect, test } from "bun:test"
import { BrainLimits } from "@vectordevai/core/brain/document/limits"
import { BrainOcr } from "@vectordevai/core/brain/document/ocr"
import { BrainDocument } from "@vectordevai/core/brain/document/read"
import { Worker } from "node:worker_threads"
import { fileURLToPath } from "node:url"
import { Effect, Layer } from "effect"
import { BrainWorker } from "@vectordevai/core/brain/worker/host"
import { bundle } from "./fixture/bundle"
import { lines, pdf } from "./fixture/pdf"

describe("local document OCR", () => {
  test("an already cancelled read launches no native OCR work", async () => {
    const signal = AbortSignal.abort()
    expect(await BrainOcr.open(new Uint8Array(1), BrainLimits.LIMITS.worker, signal)).toBeUndefined()
  })

  test("OCR refuses a source above its independent native decoder cap", async () => {
    expect(await BrainOcr.open(new Uint8Array(BrainOcr.LIMIT.bytes + 1), BrainLimits.LIMITS.worker)).toBeUndefined()
  })

  test("a text PDF retains native text and page provenance without OCR warnings", async () => {
    const result = await BrainDocument.read(
      {
        name: "native.pdf",
        bytes: pdf({ pages: [{ runs: lines(["Native text is kept without rasterizing the page."]) }] }),
      },
      BrainLimits.LIMITS.worker,
    )
    expect(result.type).toBe("extracted")
    if (result.type !== "extracted") return
    expect(result.unread).toEqual([])
    expect(result.text).toContain("Native text is kept without rasterizing")
    expect(result.blocks[0]?.span.page).toBe(1)
    expect(result.warnings).not.toContain("ocr")
  })

  test("an unread image is never represented as recognized text", async () => {
    const result = await BrainDocument.read(
      { name: "unread.pdf", bytes: pdf({ pages: [{ image: true }] }) },
      BrainLimits.LIMITS.worker,
    )
    expect(result.type).toBe("extracted")
    if (result.type !== "extracted") return
    expect(result.text).toBe("")
    expect(result.unread).toEqual([1])
    expect(result.warnings).toContain("scanned")
    expect(result.warnings).toContain("ocr-incomplete")
  })

  test.skipIf(!process.env.VECTOR_OCR_TESSERACT || !process.env.VECTOR_OCR_PDFTOPPM)(
    "reads a real image-only PDF locally and preserves its source page",
    async () => {
      const result = await BrainDocument.read(
        {
          name: "scan.pdf",
          bytes: new Uint8Array(await Bun.file(new URL("./fixture/ocr-scan.pdf", import.meta.url)).arrayBuffer()),
        },
        BrainLimits.LIMITS.worker,
      )
      expect(result.type).toBe("extracted")
      if (result.type !== "extracted") return
      expect(result.text.toLowerCase()).toContain("vector research")
      expect(result.text).toContain("42")
      expect(result.unread).toEqual([])
      expect(result.blocks.every((block) => block.span.page === 1)).toBe(true)
      expect(result.warnings).toContain("ocr")
      expect(result.warnings).not.toContain("ocr-incomplete")
    },
  )

  test.skipIf(!process.env.VECTOR_OCR_TESSERACT || !process.env.VECTOR_OCR_PDFTOPPM)(
    "mixed PDFs combine OCR and native text without losing either source page",
    async () => {
      const result = await BrainDocument.read(
        {
          name: "mixed.pdf",
          bytes: new Uint8Array(await Bun.file(new URL("./fixture/ocr-mixed.pdf", import.meta.url)).arrayBuffer()),
        },
        BrainLimits.LIMITS.worker,
      )
      expect(result.type).toBe("extracted")
      if (result.type !== "extracted") return
      expect(result.pages).toBe(2)
      expect(result.unread).toEqual([])
      expect(
        result.blocks.some(
          (block) =>
            block.type === "paragraph" && block.span.page === 1 && block.text.toLowerCase().includes("vector research"),
        ),
      ).toBe(true)
      expect(
        result.blocks.some(
          (block) =>
            block.type === "paragraph" && block.span.page === 2 && block.text.includes("second page stays searchable"),
        ),
      ).toBe(true)
    },
  )

  test.skipIf(!process.env.VECTOR_OCR_TESSERACT || !process.env.VECTOR_OCR_PDFTOPPM)(
    "cancelling active native OCR stops the read promptly",
    async () => {
      const abort = new AbortController()
      const bytes = new Uint8Array(await Bun.file(new URL("./fixture/ocr-scan.pdf", import.meta.url)).arrayBuffer())
      const session = await BrainOcr.open(bytes, BrainLimits.LIMITS.worker, abort.signal)
      expect(session).toBeDefined()
      if (!session) return
      const started = performance.now()
      const timer = setTimeout(() => abort.abort(), 10)
      try {
        expect((await session.read(1)).type).toBe("unread")
        expect(performance.now() - started).toBeLessThan(3_000)
      } finally {
        clearTimeout(timer)
        await session.close()
      }
    },
  )

  test.skipIf(!process.env.VECTOR_OCR_TESSERACT || !process.env.VECTOR_OCR_PDFTOPPM)(
    "a parsing worker uses host-owned native OCR and receives the recognized text",
    async () => {
      const worker = new Worker(new URL("./fixture/ocr-worker.ts", import.meta.url), {
        workerData: new Uint8Array(await Bun.file(new URL("./fixture/ocr-scan.pdf", import.meta.url)).arrayBuffer()),
      })
      const bridge = BrainOcr.host(worker)
      try {
        const result = await new Promise<BrainOcr.Page>((resolve, reject) => {
          worker.on("message", (value) => {
            if (value?.type === "ocr-proof") resolve(value.result)
          })
          worker.once("error", reject)
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`OCR worker exited ${code}`))
          })
        })
        expect(result.type).toBe("read")
        if (result.type === "read") expect(result.text.toLowerCase()).toContain("vector research")
      } finally {
        bridge.close()
        await worker.terminate()
      }
    },
  )

  test.skipIf(!process.env.VECTOR_OCR_TESSERACT || !process.env.VECTOR_OCR_PDFTOPPM)(
    "the bundled document worker indexes OCR passages with their page and warning",
    async () => {
      const source = await bundle(fileURLToPath(new URL("../../src/brain/worker/entry.ts", import.meta.url)), {
        minify: true,
      })
      const bytes = new Uint8Array(await Bun.file(new URL("./fixture/ocr-scan.pdf", import.meta.url)).arrayBuffer())
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const worker = yield* BrainWorker.Service
          return yield* worker.extract({
            name: "scan.pdf",
            bytes,
            repository: "ocr-test",
            lineage: "scan.pdf",
            document: "scan-1",
          })
        }).pipe(
          Effect.provide(
            BrainWorker.layerWith().pipe(
              Layer.provide(Layer.succeed(BrainWorker.Source, BrainWorker.Source.of({ load: Effect.succeed(source) }))),
            ),
          ),
        ),
      )
      expect(result.type).toBe("extracted")
      if (result.type !== "extracted") return
      expect(result.structured.unread).toEqual([])
      expect(result.structured.warnings).toContain("ocr")
      expect(result.structured.passages.some((passage) => passage.page === 1 && passage.body.includes("42"))).toBe(true)
    },
  )
})
