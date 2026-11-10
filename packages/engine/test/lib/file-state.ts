import { Effect } from "effect"
import { FileState } from "../../src/tool/file-state"

/**
 * Records that `sessionID` has read each file as it is now, as the read tool does. edit, write and apply_patch change
 * only a file the session has read (multi-agent contract 5.F.1), so a fixture that has the fake model change a file the
 * test made records the read first. A file that does not exist is skipped.
 */
export const seen = (sessionID: string, ...files: string[]) =>
  Effect.forEach(
    files,
    (file) => FileState.stamp(file).pipe(Effect.map((stamp) => FileState.record(sessionID, file, stamp))),
    { discard: true },
  ).pipe(Effect.orDie)
