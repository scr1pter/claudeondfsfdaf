"use strict"

const path = require("node:path")
const crypto = require("node:crypto")

function origin(value) {
  const url = new URL(value)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Allow an exact HTTP(S) loopback origin, including its port.")
  return url.origin
}

function allowedURL(value, origins, socket = false) {
  try {
    const url = new URL(value)
    if (socket && ["ws:", "wss:"].includes(url.protocol)) url.protocol = url.protocol === "ws:" ? "http:" : "https:"
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && origins.has(url.origin)
  } catch {
    return false
  }
}

function inside(root, name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.png$/.test(name)) {
    throw new Error("Screenshot filename must be a simple .png basename.")
  }
  const target = path.resolve(root, name)
  const relative = path.relative(path.resolve(root), target)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Screenshot path escaped output.")
  return target
}

function authenticate(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false
  const actual = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

const roles = new Set([
  "button",
  "link",
  "textbox",
  "combobox",
  "checkbox",
  "radio",
  "tab",
  "menuitem",
  "option",
  "switch",
  "slider",
  "spinbutton",
  "searchbox",
])
const keys = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Space",
  "Shift+Tab",
  "Control+A",
  "Meta+A",
])

function target(value) {
  if (value.ref !== undefined) {
    if (
      value.role !== undefined ||
      value.name !== undefined ||
      typeof value.ref !== "string" ||
      !/^r\d+_\d+$/.test(value.ref)
    ) {
      throw new Error("Use a current ref alone, or an exact role and name.")
    }
    return { ref: value.ref }
  }
  if (!roles.has(value.role) || typeof value.name !== "string" || value.name.length > 200) {
    throw new Error("Supply a current ref or supported role with an exact name.")
  }
  return { role: value.role, name: value.name }
}

module.exports = { origin, allowedURL, inside, authenticate, target, keys }
