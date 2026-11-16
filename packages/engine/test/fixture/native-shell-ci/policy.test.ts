import { expect, test } from "bun:test"
import { assets, cell, controllerAction } from "./common"

test("the actual controller gate accepts only the two exact production control operations", () => {
  expect(controllerAction(["github", "sandbox", "prepare"])).toBe("prepare")
  expect(controllerAction(["github", "sandbox", "finish"])).toBe("finish")
  for (const args of [
    [],
    ["--install"],
    ["--observe"],
    ["github", "sandbox", "run"],
    ["github", "sandbox", "prepare", "--"],
    ["github", "sandbox", "finish", "--install"],
    ["github", "sandbox", "finish\0"],
    ["github", "sandbox", "PREPARE"],
  ])
    expect(() => controllerAction(args)).toThrow()
})
test("the install receipt path parser refuses traversal, aliases, unbounded or shadowing files", () => {
  const asset = { path: "runtime/node", bytes: 1, sha256: "a".repeat(64) }
  expect(assets([asset])).toEqual([asset])
  for (const path of [
    "../node",
    "runtime//node",
    "/runtime/node",
    "runtime/./node",
    "runtime/../node",
    "runtime\\node",
    "runtime/\uD800",
    "runtime/" + "a".repeat(129),
  ])
    expect(() => assets([{ ...asset, path }])).toThrow()
  for (const bytes of [-1, NaN, Infinity, 1.5, 268_435_457]) expect(() => assets([{ ...asset, bytes }])).toThrow()
  expect(() => assets([{ ...asset, source: "/workspace/other" }])).toThrow()
  expect(() => assets([asset, asset])).toThrow()
  expect(() =>
    assets([
      { ...asset, path: "z" },
      { ...asset, path: "a" },
    ]),
  ).toThrow()
  expect(() =>
    assets(Array.from({ length: 3 }, (_, i) => ({ ...asset, path: `file${i}`, bytes: 268_435_456 }))),
  ).toThrow()
})
test("fresh matrix cells cannot select sudo, an unknown runtime or mixed families", () => {
  expect(cell("node", "own-key", "baseline")).toEqual({ runtime: "node", mode: "own-key", family: "baseline" })
  expect(cell("bun", "codium", "engine-death")).toEqual({ runtime: "bun", mode: "codium", family: "engine-death" })
  for (const values of [
    ["node", "sudo", "baseline"],
    ["source", "codium", "baseline"],
    ["bun", "codium", "combined"],
  ])
    expect(() => cell(values[0], values[1], values[2])).toThrow()
})
