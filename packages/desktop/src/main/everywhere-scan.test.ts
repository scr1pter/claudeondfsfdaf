import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"
import { expect, test } from "bun:test"
import { addedLines, mayPushDiff } from "./everywhere-scan"

installFetchGuard()

test("only added text reaches the local posting check, and binary or secret changes stay local", async () => {
  const diff = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old private text\n+new text\n"
  expect(addedLines(diff)).toBe("new text")
  let calls = 0
  const check = async (parts: readonly string[]) => { calls++; expect(parts).toEqual(["new text"]); return { status: "clean" as const, parts } }
  expect(await mayPushDiff(diff, ["ses_fixture"], check)).toBe(true)
  expect(await mayPushDiff("GIT binary patch\nliteral 3", [], check)).toBe(false)
  expect(await mayPushDiff("@@ -0,0 +1 @@\n+-----BEGIN PRIVATE KEY-----\n", [], check)).toBe(false)
  expect(calls).toBe(1)
})

test("changed, unavailable and interactive posting decisions never authorize a push", async () => {
  const diff = "@@ -0,0 +1 @@\n+new text\n"
  let calls = 0
  expect(await mayPushDiff(diff, [], async () => { calls++; return { status: "ask", parts: ["new text"] } })).toBe(false)
  expect(await mayPushDiff(diff, [], async () => { calls++; return { status: "changed", parts: ["new text"] } })).toBe(false)
  expect(await mayPushDiff(diff, [], async () => { calls++; throw new Error("fake outage") })).toBe(false)
  expect(calls).toBe(3)
})

test("three-plus additions are hunk content, so secrets and privacy checks cannot be skipped", async () => {
  const diff = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -0,0 +1,2 @@\n+++private marker\n++++source text\n"
  expect(addedLines(diff)).toBe("++private marker\n+++source text")
  let calls = 0
  expect(await mayPushDiff(diff, [], async (parts) => {
    calls++
    expect(parts).toEqual(["++private marker\n+++source text"])
    return { status: "ask", parts }
  })).toBe(false)
  let secretChecks = 0
  expect(await mayPushDiff("@@ -0,0 +1 @@\n+++-----BEGIN PRIVATE KEY-----\n", [], async (parts) => {
    secretChecks++
    return { status: "clean", parts }
  })).toBe(false)
  expect(secretChecks).toBe(0)
  expect(calls).toBe(1)
})

test("truncated or extra hunk content fails closed and multiple valid hunks retain every addition", () => {
  expect(addedLines("@@ -0,0 +1,2 @@\n+only one\n")).toBeUndefined()
  expect(addedLines("@@ -0,0 +1 @@\n+one\n+extra\n")).toBeUndefined()
  expect(addedLines("+headerless content\n")).toBeUndefined()
  expect(addedLines("@@ -1,2 +1,2 @@\n keep\n-old\n+++new\n@@ -8 +8 @@\n-old\n+last\n\\ No newline at end of file\n")).toBe("++new\nlast")
})
