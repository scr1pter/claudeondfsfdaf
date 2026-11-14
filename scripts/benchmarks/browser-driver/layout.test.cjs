"use strict"

const assert = require("node:assert/strict")
const { test } = require("node:test")
const vm = require("node:vm")
const { observeLayout } = require("./layout.cjs")

// Only the fixed implementation runs here; caller-supplied JavaScript is not a driver action.
function read(overrides = {}, root = {}) {
  return vm.runInNewContext("(" + observeLayout.toString() + ")()", {
    window: { innerWidth: 390, innerHeight: 844, scrollX: 0, scrollY: 120, ...overrides },
    document: { documentElement: { scrollWidth: 548, scrollHeight: 1200, ...root }, body: { scrollWidth: 390, scrollHeight: 1200 } },
  })
}

test("fixed geometry reader returns only six bounded numeric fields", () => {
  const layout = JSON.parse(JSON.stringify(read()))
  assert.deepEqual(layout, { viewportWidth: 390, viewportHeight: 844, documentWidth: 548, documentHeight: 1200, scrollX: 0, scrollY: 120 })
  assert.equal(layout.documentWidth - layout.viewportWidth, 158)
})

test("invalid, unavailable or unbounded geometry stays unknown rather than a false pass", () => {
  for (const value of [NaN, Infinity, 100_000_001, -1, 0]) assert.equal(read({ innerWidth: value }), undefined)
  for (const value of [NaN, Infinity, 100_000_001]) assert.equal(read({ scrollX: value }), undefined)
  assert.equal(read({}, { scrollWidth: Infinity }), undefined)
  assert.equal(read({ scrollX: -10 }).scrollX, -10)
})
