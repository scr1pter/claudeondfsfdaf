import type { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import type { Session } from "@/session/session"
import type { Snapshot } from "@/snapshot"
import type { SessionRevert } from "@/session/revert"
import { Effect } from "effect"
import * as ApiError from "../errors"

export function mapStorageNotFound<A, R>(self: Effect.Effect<A, StorageNotFoundError, R>) {
  return self.pipe(Effect.mapError((error) => ApiError.notFound(error.message)))
}

export function mapBusy<A, R>(self: Effect.Effect<A, Session.BusyError, R>) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: error.detail ?? `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
  )
}

// Keep revert failures together so both endpoints return the same stable API errors.
//
// A collected snapshot is a 409, not a 500: the request was valid, the server
// state simply no longer allows it, and the client needs to tell the user their
// files were left untouched.
export function mapRevert<A, R>(
  self: Effect.Effect<
    A,
    Session.BusyError | Snapshot.SnapshotUnavailableError | SessionRevert.IsolatedError | SessionRevert.WorkflowError,
    R
  >,
) {
  return self.pipe(
    Effect.catchTag("SessionBusyError", (error) =>
      Effect.fail(
        new ApiError.SessionBusyError({
          sessionID: error.sessionID,
          message: `Session is busy: ${error.sessionID}`,
        }),
      ),
    ),
    Effect.catchTag("SnapshotUnavailableError", (error) =>
      Effect.fail(
        new ApiError.ConflictError({
          resource: error.hash,
          message: error.file
            ? `The snapshot for this change is no longer available, so ${error.file} was left as it is. Nothing was deleted.`
            : "The snapshot for this change is no longer available, so your files were left as they are.",
        }),
      ),
    ),
    Effect.catchTag("SessionRevert.WorkflowError", (error) =>
      Effect.fail(new ApiError.ConflictError({ resource: "workflow", message: error.message })),
    ),
    Effect.catchTag("SessionRevert.IsolatedError", (error) =>
      Effect.fail(new ApiError.ConflictError({ resource: "isolated-task", message: error.message })),
    ),
  )
}
