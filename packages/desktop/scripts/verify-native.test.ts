import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { binaryArchitectures, verifyNativeComputerHelper, verifyNativeModules } from "./verify-native"

const ELF = { x64: 0x3e, arm64: 0xb7 }
const MACHO = { x64: 0x1000007, arm64: 0x100000c }
const PE = { x64: 0x8664, arm64: 0xaa64 }

function elf(arch: keyof typeof ELF) {
  const bytes = Buffer.alloc(64)
  bytes.writeUInt32BE(0x7f454c46, 0)
  bytes[4] = 2
  bytes[5] = 1
  bytes.writeUInt16LE(ELF[arch], 18)
  return bytes
}

function macho(arch: keyof typeof MACHO) {
  const bytes = Buffer.alloc(64)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(MACHO[arch], 4)
  return bytes
}

function fat(arches: (keyof typeof MACHO)[]) {
  const bytes = Buffer.alloc(Math.max(64, 8 + arches.length * 20))
  bytes.writeUInt32BE(0xcafebabe, 0)
  bytes.writeUInt32BE(arches.length, 4)
  arches.forEach((arch, index) => bytes.writeUInt32BE(MACHO[arch], 8 + index * 20))
  return bytes
}

function pe(arch: keyof typeof PE) {
  const bytes = Buffer.alloc(0x80)
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(0x40, 0x3c)
  bytes.writeUInt32LE(0x4550, 0x40)
  bytes.writeUInt16LE(PE[arch], 0x44)
  return bytes
}

async function packagedApp(files: Record<string, Buffer>, helper?: { platform: "darwin" | "win32"; bytes: Buffer }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "vector-native-"))
  const resources = path.join(root, "Resources")
  await mkdir(resources)
  if (helper)
    await Bun.write(
      path.join(
        helper.platform === "darwin" ? root : resources,
        helper.platform === "darwin"
          ? "Helpers/VectorComputer.app/Contents/MacOS/VectorComputer"
          : "computer/vector-computer.exe",
      ),
      helper.bytes,
    )
  for (const [file, bytes] of Object.entries(files))
    await Bun.write(path.join(resources, "app.asar.unpacked", "node_modules", file), bytes)
  return {
    resources,
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}

test("reads the CPU from Mach-O, fat Mach-O, ELF and PE headers", () => {
  expect(binaryArchitectures(macho("x64"))).toEqual(["x64"])
  expect(binaryArchitectures(fat(["x64", "arm64"]))).toEqual(["x64", "arm64"])
  expect(binaryArchitectures(elf("arm64"))).toEqual(["arm64"])
  expect(binaryArchitectures(pe("arm64"))).toEqual(["arm64"])
  expect(binaryArchitectures(Buffer.from("not a binary"))).toEqual([])
})

// 1.99.99's Linux ARM64 AppImage was packaged on an x64 runner and held only the x64 packages.
test("an app packaged with only the build machine's natives fails", async () => {
  await using app = await packagedApp({
    "@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node": elf("x64"),
    "@parcel/watcher-linux-x64-glibc/watcher.node": elf("x64"),
  })
  const failure = verifyNativeModules(app.resources, "linux", "arm64")
  await expect(failure).rejects.toThrow("@lydell/node-pty-linux-arm64 has no .node binary")
  await expect(failure).rejects.toThrow("@parcel/watcher-linux-arm64-glibc has no .node binary")
})

test("a native package holding another CPU's binary fails", async () => {
  await using app = await packagedApp(
    {
      "@lydell/node-pty-win32-arm64/prebuilds/win32-arm64/conpty.node": pe("x64"),
      "@parcel/watcher-win32-arm64/watcher.node": pe("arm64"),
    },
    { platform: "win32", bytes: pe("arm64") },
  )
  await expect(verifyNativeModules(app.resources, "win32", "arm64")).rejects.toThrow("is built for x64, not arm64")
})

test("an app carrying its own architecture's natives passes, alongside other architectures", async () => {
  await using app = await packagedApp(
    {
      "@lydell/node-pty-darwin-arm64/prebuilds/darwin-arm64/pty.node": macho("arm64"),
      "@lydell/node-pty-darwin-x64/prebuilds/darwin-x64/pty.node": macho("x64"),
      "@parcel/watcher-darwin-arm64/watcher.node": macho("arm64"),
      "@parcel/watcher-darwin-x64/watcher.node": fat(["x64", "arm64"]),
    },
    { platform: "darwin", bytes: fat(["x64", "arm64"]) },
  )
  await verifyNativeModules(app.resources, "darwin", "x64")
  await verifyNativeModules(app.resources, "darwin", "arm64")
})


test("a missing packaged computer helper fails even when all native modules match", async () => {
  await using app = await packagedApp({
    "@lydell/node-pty-win32-arm64/prebuilds/win32-arm64/conpty.node": pe("arm64"),
    "@parcel/watcher-win32-arm64/watcher.node": pe("arm64"),
  })
  await expect(verifyNativeModules(app.resources, "win32", "arm64")).rejects.toThrow("computer helper is missing")
  await expect(
    verifyNativeModules(app.resources, "win32", "arm64", { skipComputerHelper: true }),
  ).resolves.toBeUndefined()
})

test("each Windows package requires its actual helper architecture", async () => {
  await using app = await packagedApp({}, { platform: "win32", bytes: pe("arm64") })
  await expect(verifyNativeComputerHelper(app.resources, "win32", "arm64")).resolves.toBeUndefined()
  await expect(verifyNativeComputerHelper(app.resources, "win32", "x64")).rejects.toThrow("not x64")
})

test("a macOS package requires the requested slice at its Contents/Helpers location", async () => {
  await using app = await packagedApp({}, { platform: "darwin", bytes: macho("arm64") })
  await expect(verifyNativeComputerHelper(app.resources, "darwin", "arm64")).resolves.toBeUndefined()
  await expect(verifyNativeComputerHelper(app.resources, "darwin", "x64")).rejects.toThrow("not x64")
})

test("unknown helper CPU bytes and unsupported package architectures fail", async () => {
  await using app = await packagedApp({}, { platform: "win32", bytes: Buffer.alloc(64) })
  await expect(verifyNativeComputerHelper(app.resources, "win32", "x64")).rejects.toThrow("executable format")
  await expect(verifyNativeComputerHelper(app.resources, "win32", "ia32")).rejects.toThrow("unsupported")
})

test("a linked packaged helper cannot substitute another regular file", async () => {
  await using app = await packagedApp({})
  await Bun.write(path.join(app.resources, "real.exe"), pe("x64"))
  await mkdir(path.join(app.resources, "computer"))
  await symlink(path.join(app.resources, "real.exe"), path.join(app.resources, "computer/vector-computer.exe"))
  await expect(verifyNativeComputerHelper(app.resources, "win32", "x64")).rejects.toThrow("regular file")
})

test("a Linux package has no computer helper requirement", async () => {
  await using app = await packagedApp({})
  await expect(verifyNativeComputerHelper(app.resources, "linux", "x64")).resolves.toBeUndefined()
})


test("another platform's executable cannot satisfy the helper CPU check", async () => {
  await using app = await packagedApp({}, { platform: "win32", bytes: elf("x64") })
  await expect(verifyNativeComputerHelper(app.resources, "win32", "x64")).rejects.toThrow("executable format")
})
