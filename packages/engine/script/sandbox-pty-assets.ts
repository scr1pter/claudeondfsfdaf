import { constants } from "node:fs"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"

/** Copy the existing locked Ubuntu PTY runtime into the fixture bundle's own directory. */
export async function stageSandboxPtyAssets(core: string, output: string, runtime: "node" | "bun") {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("The immutable PTY fixture uses the pinned Linux x64 adapters")

  const files: string[] = []
  const copy = async (source: string, relative: string) => {
    const destination = path.join(output, relative)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL)
    files.push(relative)
  }

  if (runtime === "bun") {
    const root = path.dirname(path.dirname(Bun.resolveSync("bun-pty", core)))
    const library = "rust-pty/target/release/librust_pty.so"
    await copy(path.join(root, library), library)
    return files
  }

  const resolve = createRequire(path.join(core, "package.json"))
  const wrapperEntry = resolve.resolve("@lydell/node-pty")
  const platformEntry = createRequire(wrapperEntry).resolve("@lydell/node-pty-linux-x64")
  const packages = [
    {
      name: "@lydell/node-pty",
      source: path.dirname(wrapperEntry),
      files: ["package.json", "index.js"],
    },
    {
      name: "@lydell/node-pty-linux-x64",
      source: path.dirname(path.dirname(platformEntry)),
      files: [
        "package.json",
        "lib/eventEmitter2.js",
        "lib/index.js",
        "lib/interfaces.js",
        "lib/terminal.js",
        "lib/types.js",
        "lib/unixTerminal.js",
        "lib/utils.js",
        "prebuilds/linux-x64/pty.node",
      ],
    },
  ]
  for (const item of packages)
    for (const relative of item.files)
      await copy(path.join(item.source, relative), path.join("node_modules", item.name, relative))
  return files
}
