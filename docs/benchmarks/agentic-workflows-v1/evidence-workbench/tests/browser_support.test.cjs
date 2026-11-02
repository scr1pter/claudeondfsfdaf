"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const { ProductFailure, requireProduct, reportExit, validOrigin, apiObject, importedDocument, batchStatusMatches, invalidBatchStatusMatches } = require("../browser_support.cjs")
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

test("multiple visible statuses can include the batch outcome or validation error", () => {
  const search = { visible: true, text: "Found 2 documents." }
  assert.equal(batchStatusMatches([search, { visible: true, text: "Imported batch multi-01 at revision 4." }], "multi-01", false), true)
  assert.equal(batchStatusMatches([search, { visible: true, text: "Replayed batch multi-01 at revision 4." }], "multi-01", true), true)
  assert.equal(invalidBatchStatusMatches([search, { visible: true, text: "Invalid batch: title is required." }]), true)
})

test("unrelated or hidden statuses cannot supply the required batch evidence", () => {
  const unrelated = { visible: true, text: "Found 2 documents." }
  assert.equal(batchStatusMatches([unrelated, { visible: false, text: "Imported batch multi-01 at revision 4." }], "multi-01", false), false)
  assert.equal(batchStatusMatches([unrelated, { visible: true, text: "Imported batch other-01 at revision 4." }], "multi-01", false), false)
  assert.equal(batchStatusMatches([{ visible: true, text: "Imported batch multi-01." }], "multi-01", false), false)
  assert.equal(batchStatusMatches([{ visible: true, text: "Batch multi-01 at revision 4." }], "multi-01", true), false)
  assert.equal(invalidBatchStatusMatches([unrelated, { visible: false, text: "Invalid batch." }]), false)
})
