import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "../../src/flag/flag"

const saved = {
  VECTOR_EXPERIMENTAL: process.env.VECTOR_EXPERIMENTAL,
  VECTOR_EXPERIMENTAL_CONNECT: process.env.VECTOR_EXPERIMENTAL_CONNECT,
}

afterEach(() => {
  Object.entries(saved).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key]
    if (value !== undefined) process.env[key] = value
  })
})

function read(input: { VECTOR_EXPERIMENTAL?: string; VECTOR_EXPERIMENTAL_CONNECT?: string }) {
  delete process.env.VECTOR_EXPERIMENTAL
  delete process.env.VECTOR_EXPERIMENTAL_CONNECT
  Object.entries(input).forEach(([key, value]) => {
    process.env[key] = value
  })
  return Flag.VECTOR_EXPERIMENTAL_CONNECT
}

describe("Flag.VECTOR_EXPERIMENTAL_CONNECT", () => {
  test("is off unless it is turned on explicitly", () => {
    expect(read({})).toBe(false)
    expect(read({ VECTOR_EXPERIMENTAL_CONNECT: "true" })).toBe(true)
    expect(read({ VECTOR_EXPERIMENTAL_CONNECT: "1" })).toBe(true)
    expect(read({ VECTOR_EXPERIMENTAL_CONNECT: "false" })).toBe(false)
  })

  test("the umbrella VECTOR_EXPERIMENTAL does not turn it on", () => {
    expect(read({ VECTOR_EXPERIMENTAL: "true" })).toBe(false)
    expect(read({ VECTOR_EXPERIMENTAL: "1", VECTOR_EXPERIMENTAL_CONNECT: "0" })).toBe(false)
    expect(read({ VECTOR_EXPERIMENTAL: "true", VECTOR_EXPERIMENTAL_CONNECT: "true" })).toBe(true)
  })
})
