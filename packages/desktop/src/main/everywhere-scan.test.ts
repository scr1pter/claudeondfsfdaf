import { installFetchGuard } from "../../../web/test/lib/everywhere-fetch-guard"
import { expect, test } from "bun:test"
import { addedLines, mayPushDiff } from "./everywhere-scan"

installFetchGuard()

test("only added text reaches the local posting check, and binary or secret changes stay local", async () => {
  const diff = "--- a/file\n+++ b/file\n-old private text\n+new text\n"
  expect(addedLines(diff)).toBe("new text")
  let calls = 0
  const check = async (parts: readonly string[]) => { calls++; expect(parts).toEqual(["new text"]); return { status: "clean" as const, parts } }
  expect(await mayPushDiff(diff, ["ses_fixture"], check)).toBe(true)
  expect(await mayPushDiff("GIT binary patch\nliteral 3", [], check)).toBe(false)
  expect(await mayPushDiff("+-----BEGIN PRIVATE KEY-----", [], check)).toBe(false)
  expect(calls).toBe(1)
})

test("changed, unavailable and interactive posting decisions never authorize a push", async () => {
  expect(await mayPushDiff("+new text", [], async () => ({ status: "ask", parts: ["new text"] }))).toBe(false)
  expect(await mayPushDiff("+new text", [], async () => ({ status: "changed", parts: ["new text"] }))).toBe(false)
  expect(await mayPushDiff("+new text", [], async () => { throw new Error("fake outage") })).toBe(false)
})
