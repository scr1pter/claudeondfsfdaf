import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ShipDesk } from "@vectordevai/schema/ship-desk"
import yargs from "yargs"
import { ShipCommand } from "../../src/cli/cmd/ship"

let directory: string
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "ship-validate-"))
})
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

const config = {
  install: "fixture-install-command",
  build: "fixture-build-command",
  start: "fixture-start-command",
  port: 4100,
  routes: ["/", "/pricing?test=fixture-route-value"],
}

async function writeConfig(content: string | Buffer) {
  await fs.mkdir(path.join(directory, ".vector"), { recursive: true })
  await fs.writeFile(path.join(directory, ".vector", "ship.json"), content)
}

async function validate() {
  const current = process.cwd()
  const exitCode = process.exitCode
  const output: string[] = []
  const stderr = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    output.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
  process.chdir(directory)
  process.exitCode = 0
  try {
    await yargs(["ship", "validate"])
      .command(ShipCommand)
      .strict()
      .exitProcess(false)
      .fail((message, error) => {
        throw error ?? new Error(message)
      })
      .parseAsync()
    return { code: process.exitCode, output: output.join("").replace(/\x1b\[[0-9;]*m/g, "") }
  } finally {
    process.chdir(current)
    process.exitCode = exitCode ?? 0
    stderr.mockRestore()
  }
}

test("validates the local capture plan without a Git checkout, a ticket, or exposing config values", async () => {
  await writeConfig(JSON.stringify(config))
  const result = await validate()
  expect(result.code).toBe(0)
  expect(result.output).toContain("Local Ship Desk configuration is valid.")
  expect(result.output).toContain("Configured app port 4100.")
  expect(result.output).toContain("Steps include install, build, start.")
  expect(result.output).toContain("2 configured routes, up to 4 images across both versions.")
  expect(result.output).toContain("Hosted capture uses the pull request's base commit")
  expect(result.output).not.toContain("fixture-")
  expect(await fs.readdir(directory)).toEqual([".vector"])
  expect(await fs.readdir(path.join(directory, ".vector"))).toEqual(["ship.json"])
})

test("uses the capture parser's default route and rejects the same malformed plans", async () => {
  await writeConfig(JSON.stringify({ start: config.start, port: 4100 }))
  const valid = await validate()
  expect(valid.code).toBe(0)
  expect(valid.output).toContain("1 configured route, up to 2 images")
  expect(valid.output).toContain("Steps include start.")
  await writeConfig(JSON.stringify({ ...config, routes: ["https://fixture.invalid/"] }))
  const invalid = await validate()
  expect(invalid.code).toBe(1)
  expect(invalid.output).toContain("The local .vector/ship.json is not valid.")
  expect(invalid.output).not.toContain("fixture.invalid")
})

test("distinguishes a missing configuration from a file exceeding the byte cap", async () => {
  const absent = await validate()
  expect(absent.code).toBe(1)
  expect(absent.output).toContain("The current directory has no .vector/ship.json.")
  const shortButWide = `{"ignored":"${"é".repeat(ShipDesk.LIMITS.shipJsonBytes / 2)}"}`
  await writeConfig(shortButWide)
  const oversized = await validate()
  expect(oversized.code).toBe(1)
  expect(oversized.output).toContain("The local .vector/ship.json exceeds 16 KiB.")
})

test("refuses a linked config directory even when its destination contains a valid config", async () => {
  const other = path.join(directory, "other")
  await fs.mkdir(other)
  await fs.writeFile(path.join(other, "ship.json"), JSON.stringify(config))
  await fs.symlink(other, path.join(directory, ".vector"), "junction")
  const result = await validate()
  expect(result.code).toBe(1)
  expect(result.output).toContain("Use a regular .vector/ship.json file in the current directory.")
  expect(result.output).not.toContain(other)
})

test("refuses a hard-linked config and then rejects invalid UTF-8 in a regular file", async () => {
  const other = path.join(directory, "other.json")
  const name = path.join(directory, ".vector", "ship.json")
  await fs.mkdir(path.dirname(name))
  await fs.writeFile(other, JSON.stringify(config))
  await fs.link(other, name)
  const linked = await validate()
  expect(linked.code).toBe(1)
  expect(linked.output).toContain("Use a regular .vector/ship.json file in the current directory.")
  await fs.unlink(name)
  await writeConfig(Buffer.from([0x7b, 0xff, 0x7d]))
  const invalid = await validate()
  expect(invalid.code).toBe(1)
  expect(invalid.output).toContain("The local .vector/ship.json is not valid UTF-8.")
})
