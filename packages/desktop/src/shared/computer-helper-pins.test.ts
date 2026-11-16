import { describe, expect, test } from "bun:test"
import { decodeComputerHelperPins, encodeComputerHelperPins, extractComputerHelperPins } from "./computer-helper-pins"

const x64 = "a".repeat(64)
const arm64 = "b".repeat(64)
const prefix = "vector-computer-helper-pins-v1:"

describe("compiled computer helper pin documents", () => {
  test("one canonical ASCII document carries both actual architecture hashes", () => {
    const encoded = encodeComputerHelperPins({ arm64: arm64.toUpperCase(), x64 })
    expect(encoded).toBe(`${prefix}x64=${x64};arm64=${arm64};end`)
    expect(decodeComputerHelperPins(encoded)).toEqual({ x64, arm64 })
    expect(encodeComputerHelperPins({ x64 })).toBe(`${prefix}x64=${x64};end`)
    expect(decodeComputerHelperPins(encodeComputerHelperPins({ arm64 }))).toEqual({ arm64 })
    expect(decodeComputerHelperPins(encodeComputerHelperPins({}))).toEqual({})
  })

  test("unsupported architectures, malformed hashes and non-map values cannot enter the build", () => {
    for (const value of [
      undefined,
      null,
      [],
      "{}",
      new Date(),
      { ia32: x64 },
      { x64: "bad" },
      { x64: 12 },
      { x64: undefined },
      { arm64: `${arm64}\n` },
    ])
      expect(() => encodeComputerHelperPins(value)).toThrow()
  })

  test("runtime decoding rejects noncanonical, duplicate and altered documents", () => {
    for (const value of [
      undefined,
      "",
      `${prefix}x64=${x64};arm64=${arm64};end `,
      `${prefix}arm64=${arm64};x64=${x64};end`,
      `${prefix}x64=${x64};x64=${x64};end`,
      `${prefix}ia32=${x64};end`,
      `${prefix}x64=${x64.toUpperCase()};end`,
      `${prefix}x64=${x64}end`,
      `${prefix}x64=${x64};;end`,
      `${prefix}x64=${x64};END`,
      `${prefix}x64=${x64};end\n`,
    ])
      expect(() => decodeComputerHelperPins(value)).toThrow()
  })

  test("inspection finds the same complete document across ordinary quote and minifier choices", () => {
    const marker = encodeComputerHelperPins({ x64, arm64 })
    for (const source of [
      `const pins = "${marker}";`,
      `const p='${marker}';`,
      `const p=\`${marker}\`;`,
      `var p="${marker}";export{p};`,
    ])
      expect(extractComputerHelperPins(source)).toEqual({ x64, arm64 })
    expect(extractComputerHelperPins([`const prefix="${prefix}";`, `export const pins="${marker}";`])).toEqual({
      x64,
      arm64,
    })
  })

  test("missing, duplicate, conflicting, unsupported and malformed complete documents refuse", () => {
    const marker = encodeComputerHelperPins({ x64 })
    for (const source of [
      `const prefix="${prefix}";`,
      `"${marker}";"${marker}"`,
      `"${marker}";"${encodeComputerHelperPins({ arm64 })}"`,
      `"${prefix}ia32=${x64};end"`,
      `"${prefix}x64=bad;end"`,
      `"${marker}suffix"`,
      `"${prefix}x64=${x64};"`,
    ])
      expect(() => extractComputerHelperPins(source)).toThrow()
  })

  test("the compiler preserves a single inspectable constant while Main decodes that exact value", async () => {
    const marker = encodeComputerHelperPins({ x64, arm64 })
    for (const minify of [false, true]) {
      const built = await Bun.build({
        entrypoints: ["computer-helper-pins-fixture.ts"],
        target: "node",
        format: "esm",
        minify,
        define: { VECTOR_COMPUTER_HELPER_SHA256: JSON.stringify(marker) },
        plugins: [
          {
            name: "computer-helper-pins-fixture",
            setup(builder) {
              builder.onResolve({ filter: /^computer-helper-pins-fixture\.ts$/ }, () => ({
                path: "computer-helper-pins-fixture.ts",
                namespace: "fixture",
              }))
              builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                contents: `import { decodeComputerHelperPins } from ${JSON.stringify(import.meta.dirname + "/computer-helper-pins.ts")}; export const hashes = typeof VECTOR_COMPUTER_HELPER_SHA256 === "undefined" ? undefined : decodeComputerHelperPins(VECTOR_COMPUTER_HELPER_SHA256);`,
                loader: "ts",
                resolveDir: import.meta.dirname,
              }))
            },
          },
        ],
      })
      expect(built.success).toBe(true)
      expect(extractComputerHelperPins(await built.outputs[0]!.text())).toEqual({ x64, arm64 })
    }
  })
})
