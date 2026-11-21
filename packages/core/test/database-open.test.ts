import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { Database } from "../src/database/database"
import { tmpdir } from "./fixture/tmpdir"

describe("database open", () => {
  // When the last connection closes, SQLite removes the -wal and -shm files, so the next process to open the
  // database runs WAL recovery. Another process that opens it meanwhile (the desktop engine beside a CLI run, or the
  // two probes in review/request-store.test.ts) gets SQLITE_BUSY_RECOVERY, and it must wait on the busy timeout
  // rather than fail. The holder keeps the -shm in that mid-recovery state for a second, well under that timeout.
  test.skipIf(process.platform !== "linux")(
    "opens a WAL database while another process is still recovering it",
    async () => {
      await using directory = await tmpdir()
      const filename = path.join(directory.path, "vector.db")
      const open = Effect.void.pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped)
      await Effect.runPromise(open)
      await using holder = Bun.spawn(
        ["python3", "-I", path.join(import.meta.dir, "fixture/wal-recovery-holder.py"), `${filename}-shm`, "1000"],
        { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
      )
      const output = holder.stdout.pipeThrough(new TextDecoderStream()).getReader()
      expect((await output.read()).value).toBe("HELD\n")
      await Effect.runPromise(open)
      const opened = Date.now()
      holder.stdin.end()
      // The open finished after the holder let go: it waited out the recovery instead of finding the file free.
      expect(opened).toBeGreaterThanOrEqual(Number((await output.read()).value?.replace("RELEASING ", "")))
      expect(await holder.exited).toBe(0)
    },
    10_000,
  )
})
