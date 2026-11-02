"use strict"

class ProductFailure extends Error {}

function requireProduct(condition, message) {
  if (!condition) throw new ProductFailure(message)
}

function reportExit(checks, instrumentError) {
  if (instrumentError) return 2
  if (checks.some((row) => row.status === "failed")) return 1
  if (checks.every((row) => row.status === "passed")) return 0
  return 2
}

function validOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.username || url.password || url.search || url.hash)
    throw new Error("Browser acceptance requires an exact HTTP loopback origin.")
  return url.origin
}

function apiObject(value) {
  requireProduct(value !== null && typeof value === "object" && !Array.isArray(value), "Application API response must be an object.")
  return value
}

function importedDocument(value) {
  apiObject(value)
  requireProduct(Array.isArray(value.documents) && value.documents.length === 1, "Legacy importer did not return one document.")
  const row = apiObject(value.documents[0])
  requireProduct(Number.isSafeInteger(row.id) && row.id > 0 && typeof row.source === "string", "Legacy importer did not return a document identity.")
  return row
}

function batchStatusMatches(statuses, batchId, replay) {
  return statuses.some((row) => row.visible === true && typeof row.text === "string"
    && row.text.includes(batchId) && /revision/i.test(row.text)
    && (replay ? /replay/i.test(row.text) : /new|not replay|replayed:?\s*false|committed|imported/i.test(row.text)))
}

function invalidBatchStatusMatches(statuses) {
  return statuses.some((row) => row.visible === true && typeof row.text === "string"
    && /invalid|error|required|missing/i.test(row.text))
}

module.exports = { ProductFailure, requireProduct, reportExit, validOrigin, apiObject, importedDocument, batchStatusMatches, invalidBatchStatusMatches }
