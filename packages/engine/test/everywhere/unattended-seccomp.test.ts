import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as UnattendedSeccomp from "../../src/tool/shell/unattended-seccomp"

// Evaluate the compiled policy over synthetic seccomp_data. This test makes no network or socket calls.
function decision(bytes: Uint8Array, arch: number, nr: number, family = 0, socketType = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const input = new Map([
    [0, nr],
    [4, arch],
    [16, family],
    [24, socketType],
  ])
  let accumulator = 0
  let pc = 0
  while (pc < bytes.byteLength) {
    const code = view.getUint16(pc, true)
    const argument = view.getUint32(pc + 4, true)
    if (code === 0x06) return argument
    if (code === 0x20) {
      if (!input.has(argument)) throw new Error("Unexpected seccomp_data offset")
      accumulator = input.get(argument)!
    } else if (code === 0x54) {
      accumulator &= argument
    } else if (code === 0x15 || code === 0x35) {
      const yes = code === 0x15 ? accumulator === argument : accumulator >= argument
      pc += view.getUint8(pc + (yes ? 2 : 3)) * 8
    } else throw new Error("Unexpected policy instruction")
    pc += 8
  }
  throw new Error("Policy fell through")
}

const ALLOW = 0x7fff0000
const EPERM = 0x00050001
const ENOSYS = 0x00050026
const KILL = 0x80000000

test.each([
  { arch: "x64", audit: 0xc000003e, socket: 41, pair: 53 },
  { arch: "arm64", audit: 0xc00000b7, socket: 198, pair: 199 },
] as const)("only the supported native ABI can use the unattended policy ($arch)", ({ arch, audit, socket, pair }) => {
  const filter = UnattendedSeccomp.filter(arch, "LE")!
  expect(decision(filter, audit, socket, 1)).toBe(EPERM)
  expect(decision(filter, audit, socket, 2)).toBe(ALLOW) // IP stays in bubblewrap's network namespace.
  expect(decision(filter, audit, pair, 1, 1 | 0x80000)).toBe(ALLOW)
  expect(decision(filter, audit, pair, 1, 2)).toBe(EPERM)
  expect(decision(filter, audit, pair, 1, 5)).toBe(EPERM)
  expect(decision(filter, audit, pair, 2, 1)).toBe(EPERM)
  for (const nr of [425, 426, 427]) expect(decision(filter, audit, nr)).toBe(ENOSYS)
  expect(decision(filter, audit, 438)).toBe(EPERM)
  expect(decision(filter, 0x40000003, socket)).toBe(KILL)
  expect(decision(filter, audit, 0)).toBe(ALLOW)
})

test("x86 compatibility syscall numbers and unsupported filter configurations fail closed", () => {
  const x64 = UnattendedSeccomp.filter("x64", "LE")!
  expect(decision(x64, 0xc000003e, 0x40000000)).toBe(ENOSYS)
  expect(decision(x64, 0xc000003e, 512)).toBe(ENOSYS)
  expect(UnattendedSeccomp.filter("ia32", "LE")).toBeUndefined()
  expect(UnattendedSeccomp.filter("arm64", "BE")).toBeUndefined()
})

test.skipIf(process.platform !== "linux")(
  "the descriptor check starts a harmless command with only standard IO",
  () => {
    const [shell, ...args] = UnattendedSeccomp.command("/bin/sh", [
      "/bin/sh",
      "-c",
      'printf "%s" "$1"',
      "fixture",
      "hello there",
    ])
    const result = spawnSync(shell!, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 2_000, encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("hello there")
  },
)

test.skipIf(process.platform !== "linux")(
  "the descriptor check refuses an extra fixture descriptor before execution",
  () => {
    const folder = mkdtempSync(join(tmpdir(), "vector-seccomp-"))
    const file = join(folder, "fixture")
    writeFileSync(file, "fixture")
    const fd = openSync(file, "r")
    try {
      rmSync(file)
      const [shell, ...args] = UnattendedSeccomp.command("/bin/sh", ["/bin/sh", "-c", "printf unexpected"])
      const result = spawnSync(shell!, args, {
        stdio: ["ignore", "pipe", "pipe", fd],
        timeout: 2_000,
        encoding: "utf8",
      })
      expect(result.status).toBe(125)
      expect(result.stdout).toBe("")
    } finally {
      closeSync(fd)
      rmSync(folder, { recursive: true, force: true })
    }
  },
)
