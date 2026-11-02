"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { ProductFailure, requireProduct, reportExit, validOrigin, apiObject, importedDocument } = require("../browser_support.cjs")
const inventory = require("../inventory.json")

test("positive browser report and explicit product assertion", () => {
  requireProduct(true, "positive")
  assert.equal(reportExit(inventory.browser.map((name) => ({ name, status: "passed" })), null), 0)
  assert.equal(validOrigin("http://127.0.0.1:4123"), "http://127.0.0.1:4123")
})

test("negative assertion produces a product failure", () => {
  assert.throws(() => requireProduct(false, "synthetic mismatch"), ProductFailure)
  assert.equal(reportExit([{ status: "failed" }, { status: "not_run" }], null), 1)
})

test("missing evidence and Chrome faults produce instrument failures", () => {
  assert.equal(reportExit([{ status: "not_run" }], null), 2)
  assert.equal(reportExit([{ status: "failed" }], "Chrome unavailable"), 2)
})

test("browser scope rejects non-loopback, credentials, and paths", () => {
  for (const value of ["https://127.0.0.1:4123", "http://example.invalid:4123", "http://127.0.0.1:4123/other", "http://user:secret@127.0.0.1:4123", "http://127.0.0.1:4123/?q=x"])
    assert.throws(() => validOrigin(value))
})

test("malformed product JSON stays a product failure", () => {
  for (const value of [null, [], "text", 4]) assert.throws(() => apiObject(value), ProductFailure)
  for (const value of [{}, { documents: [null] }, { documents: [1] }, { documents: [{ id: 1 }] }])
    assert.throws(() => importedDocument(value), ProductFailure)
  assert.equal(importedDocument({ documents: [{ id: 2, source: "local/a" }] }).id, 2)
})
