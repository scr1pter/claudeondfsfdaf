"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { origin, allowedURL, inside, authenticate, target, keys } = require("./policy.cjs")

test("only exact loopback HTTP origins can be configured", () => {
  assert.equal(origin("http://127.0.0.1:4123"), "http://127.0.0.1:4123")
  assert.equal(origin("http://[::1]:4123"), "http://[::1]:4123")
  for (const value of [
    "https://example.com",
    "http://127.0.0.1.example:4123",
    "http://127.0.0.2:4123",
    "http://user:pass@127.0.0.1:4123",
    "http://127.0.0.1:4123/path",
    "http://127.0.0.1:4123?x=1",
    "file:///etc/passwd",
  ])
    assert.throws(() => origin(value))
})

test("requests, redirects and websockets must remain on explicit origins", () => {
  const origins = new Set(["http://127.0.0.1:4123"])
  assert.equal(allowedURL("http://127.0.0.1:4123/api?x=1", origins), true)
  assert.equal(allowedURL("ws://127.0.0.1:4123/live", origins, true), true)
  for (const value of [
    "http://localhost:4123",
    "http://127.0.0.1:4124",
    "http://127.0.0.1:4123@evil.example",
    "https://example.com",
    "file:///tmp/a",
    "data:text/html,hello",
  ])
    assert.equal(allowedURL(value, origins), false)
})

test("screenshot names stay directly within their owned output directory", () => {
  const root = path.resolve("owned-output")
  assert.equal(inside(root, "mobile-1.png"), path.join(root, "mobile-1.png"))
  for (const value of [
    "../escape.png",
    "..\\escape.png",
    "/absolute.png",
    "C:\\absolute.png",
    "a/b.png",
    ".png",
    "image.jpg",
  ])
    assert.throws(() => inside(root, value))
})

test("authentication and action targets are explicit", () => {
  assert.equal(authenticate("Bearer local-fixture-token", "local-fixture-token"), true)
  assert.equal(authenticate("Bearer wrong", "local-fixture-token"), false)
  assert.equal(authenticate(undefined, "local-fixture-token"), false)
  assert.deepEqual(target({ ref: "r4_2" }), { ref: "r4_2" })
  assert.deepEqual(target({ role: "button", name: "Save" }), { role: "button", name: "Save" })
  for (const value of [
    { ref: "#button" },
    { ref: "r4_2", role: "button", name: "Save" },
    { role: "textbox" },
    { role: "script", name: "anything" },
  ])
    assert.throws(() => target(value))
  assert.equal(keys.has("Control+V"), false)
  assert.equal(keys.has("Alt+F4"), false)
})
