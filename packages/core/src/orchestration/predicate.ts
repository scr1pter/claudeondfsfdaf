export * as WorkflowPredicate from "./predicate"

import type { WorkflowSpec } from "./spec"
import { WorkflowTemplate } from "./template"

export function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, i) => equal(value, right[i]))
    )
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        equal(Object.getOwnPropertyDescriptor(left, key)?.value, Object.getOwnPropertyDescriptor(right, key)?.value),
    )
  )
}

export function evaluate(predicate: WorkflowSpec.Predicate | undefined, value: unknown): boolean {
  if (!predicate) return true
  if ("all" in predicate) return predicate.all.every((item) => compare(item, value))
  if ("any" in predicate) return predicate.any.some((item) => compare(item, value))
  if ("not" in predicate) return !compare(predicate.not, value)
  return compare(predicate, value)
}

function compare(predicate: WorkflowSpec.Comparison, value: unknown): boolean {
  const actual = predicate.path ? WorkflowTemplate.lookup(value, predicate.path.split(".")) : value
  if ("exists" in predicate) return (actual !== undefined) === predicate.exists
  if (actual === undefined) return false
  if ("equals" in predicate) return equal(actual, predicate.equals)
  if ("not_equals" in predicate) return !equal(actual, predicate.not_equals)
  if ("in" in predicate) return predicate.in.some((item) => equal(actual, item))
  if ("contains" in predicate)
    return typeof actual === "string" && typeof predicate.contains === "string"
      ? actual.includes(predicate.contains)
      : Array.isArray(actual) && actual.some((item) => equal(item, predicate.contains))
  if (typeof actual !== "number" || !Number.isFinite(actual)) return false
  if ("gt" in predicate) return actual > predicate.gt
  if ("gte" in predicate) return actual >= predicate.gte
  if ("lt" in predicate) return actual < predicate.lt
  if ("lte" in predicate) return actual <= predicate.lte
  return false
}
