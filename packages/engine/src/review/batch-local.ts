// The CLI's existing local review file is the authority. Hold its ordinary lock across
// selection, model work and commit, so concurrent commands cannot purchase the same batch.
import { constants } from "node:fs"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import { ReadOnlyGit } from "@vectordevai/core/read-only-git"
import type { Effect } from "effect"
import { ReviewCheckpointLock } from "@vectordevai/core/review/checkpoint-lock"
import {
  decodeState,
  emptyState,
  monthKey,
  batchCursorDigest,
  batchCoverage,
  recordBatchCoverage,
  restoreBatchCursor,
  type BatchCursor,
} from "@vectordevai/core/review/state"
import type { ReviewBatchPlan } from "@vectordevai/core/review/plan"
import type { BatchCheckpoint, ReviewCost, ReviewState } from "@vectordevai/core/review/types"
import type { ReviewBatchStore } from "./batch"

const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const maximumBytes = 16 * 1024 * 1024
const fdPath = (handle: FileHandle) => "/proc/self/fd/" + handle.fd
const code = (error: unknown, expected: string) => error instanceof Error && "code" in error && error.code === expected
const unsafe = () => new Error("The local batch checkpoint is unavailable or is outside this owner's review state.")

async function readSized(handle: FileHandle, size: number) {
  if (size > maximumBytes) throw unsafe()
  const bytes = Buffer.alloc(size + 1)
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
  if (bytesRead !== size) throw unsafe()
  return bytes.subarray(0, bytesRead).toString("utf8")
}

export async function lockBatchFile(root: string, file: string, head: string, signal?: AbortSignal, branch?: string) {
  const metadata = await ReadOnlyGit.metadataHead(root, { signal })
  const owner = process.getuid?.()
  if (
    owner === undefined ||
    metadata.head !== head ||
    (branch && metadata.branch !== branch) ||
    path.dirname(file) !== path.join(metadata.gitDirectory, "vector", "review")
  )
    throw unsafe()
  const handles: FileHandle[] = []
  let lock: ReviewCheckpointLock.Lease | undefined
  const close = async () => {
    try {
      await lock?.release()
    } finally {
      await Promise.all(handles.map((handle) => handle.close()))
    }
  }
  try {
    const directory = async (target: string) => {
      const handle = await fs.open(target, flags | constants.O_DIRECTORY)
      handles.push(handle)
      const stat = await handle.stat()
      if (!stat.isDirectory() || stat.uid !== owner || stat.mode & 0o022) throw unsafe()
      return handle
    }
    const gitHandle = await directory(metadata.gitDirectory)
    let handle = gitHandle
    for (const segment of ["vector", "review"]) {
      const child = path.join(fdPath(handle), segment)
      try {
        await fs.mkdir(child, { mode: 0o700 })
      } catch (error) {
        if (!code(error, "EEXIST")) throw error
      }
      // Persist each ancestor before an admitted request can rely on the leaf.
      await handle.sync()
      handle = await directory(child)
    }
    const dir = fdPath(handle)
    const leaf = path.join(dir, path.basename(file))
    lock = await ReviewCheckpointLock.acquire(path.basename(file), { dir, signal })
    signal?.throwIfAborted()
    const verifyRepository = async () => {
      const visible = await fs.realpath(path.dirname(file))
      const original = await handle.stat({ bigint: true })
      const current = await fs.lstat(visible, { bigint: true })
      if (visible !== path.dirname(file) || current.dev !== original.dev || current.ino !== original.ino) throw unsafe()
      const repo = await ReadOnlyGit.metadataHead(root, { signal })
      const pinned = await gitHandle.stat({ bigint: true })
      const live = await fs.lstat(repo.gitDirectory, { bigint: true })
      if (
        repo.head !== head ||
        (branch && repo.branch !== branch) ||
        repo.gitDirectory !== metadata.gitDirectory ||
        live.dev !== pinned.dev ||
        live.ino !== pinned.ino
      )
        throw unsafe()
    }
    const owned = lock
    const verify = () => owned.use(verifyRepository)
    await verify()
    const readOwned = async () => {
      try {
        const found = await fs.open(leaf, flags)
        try {
          const stat = await found.stat()
          if (!stat.isFile() || stat.uid !== owner || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > maximumBytes)
            throw unsafe()
          return await readSized(found, stat.size)
        } finally {
          await found.close()
        }
      } catch (error) {
        if (!code(error, "ENOENT")) throw error
      }
    }
    const replaceOwned = async (encoded: string) => {
      if (Buffer.byteLength(encoded) > maximumBytes) throw unsafe()
      const temporary = leaf + "." + crypto.randomUUID() + ".tmp"
      try {
        const output = await fs.open(temporary, "wx", 0o600)
        try {
          await output.writeFile(encoded)
          await output.sync()
        } finally {
          await output.close()
        }
        await verifyRepository()
        await fs.rename(temporary, leaf)
        // A charged dispatch is safe only after both the bytes and their new name survive a restart.
        await handle.sync()
      } finally {
        await fs.rm(temporary, { force: true })
      }
    }
    const read = () =>
      owned.use(async () => {
        await verifyRepository()
        return readOwned()
      })
    const replace = (encoded: string) => owned.use(() => replaceOwned(encoded))
    return { file: leaf, text: await read(), close, verify, read, replace }
  } catch (error) {
    await close()
    throw error
  }
}

// Ordinary reviews hold the writer lock only at publication. A ledger created or updated while
// their model was running must survive, including when the ordinary review began with no cache.
export async function concurrentBatchRecord(
  file: string,
  previous: string | undefined,
  previouslyBatch: boolean,
  writer?: Pick<ReviewCheckpointLock.Lease, "directory">,
) {
  let current: string | undefined
  try {
    if (!writer && (await fs.realpath(path.dirname(file))) !== path.dirname(file)) return { changed: true } as const
    const handle = await fs.open(writer ? path.join(writer.directory, path.basename(file)) : file, flags)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.nlink !== 1) throw unsafe()
      current = await readSized(handle, stat.size)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (!code(error, "ENOENT")) return { changed: true } as const
  }
  if (current === previous) return
  if (current) {
    try {
      const row = JSON.parse(current)
      const state = row?.version === 1 && typeof row.state === "string" ? decodeState(row.state) : undefined
      if (
        state &&
        (row.batch !== undefined ||
          row.batchAccounting === true ||
          row.batchUncertainMonth ||
          state.inflight?.run.startsWith("batch:"))
      )
        return { changed: true, row, state } as const
    } catch {
      // A stale ordinary writer cannot repair or certify an unrecognized checkpoint.
    }
  }
  if (previouslyBatch) return { changed: true } as const
}

export function unknownOwnSpend(cost?: ReviewCost) {
  return (
    cost?.kind === "unknown" ||
    ((cost?.kind === "priced" || (cost?.costUsd ?? 0) > 0) && !!(cost?.usageMissing || cost?.partial))
  )
}

interface LocalMetadata {
  cursor: BatchCheckpoint
  // Baseline into the existing review cost total. No second spend accumulator.
  initialCostUsd: number
  usageMissing?: true
  uncertainMonth?: string
}

// An interrupted provider may have accepted work across a month boundary. Until recovery there is
// no settled end timestamp; retain the recovery month as well as any known incomplete settlement.
export function uncertainBatchMonth(state: ReviewState | undefined, raw: unknown, carried: unknown, now: number) {
  const month = monthKey(now)
  return state?.inflight?.run.startsWith("batch:") ||
    carried === month ||
    (raw && typeof raw === "object" && "uncertainMonth" in raw && raw.uncertainMonth === month)
    ? month
    : undefined
}

export function localBatchStore(
  state: ReviewState | undefined,
  raw: unknown,
  policy: string,
  allowCompletedReuse = true,
  persistPending?: (state: ReviewState, metadata: LocalMetadata) => Effect.Effect<void, Error>,
  options: { now?: () => number; carriedMonth?: string; knownMonthLedger?: boolean } = {},
) {
  const now = options.now ?? Date.now
  const meta =
    raw &&
    typeof raw === "object" &&
    "cursor" in raw &&
    raw.cursor !== null &&
    typeof raw.cursor === "object" &&
    "version" in raw.cursor &&
    raw.cursor.version === 1 &&
    "head" in raw.cursor &&
    typeof raw.cursor.head === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(raw.cursor.head) &&
    "initialCostUsd" in raw &&
    typeof raw.initialCostUsd === "number" &&
    Number.isFinite(raw.initialCostUsd) &&
    raw.initialCostUsd >= 0
      ? (raw as LocalMetadata)
      : undefined
  let result: { plan: ReviewBatchPlan; cursor: BatchCursor; metadata: LocalMetadata } | undefined
  let alreadyComplete = false
  const total = state?.costUsd ?? 0
  const same = (plan: ReviewBatchPlan) => meta?.cursor?.head === plan.head
  // Ordinary older receipts aggregate multiple runs and have no per-head starting balance.
  const unknownBaseline = (head: string) =>
    !meta && (raw !== undefined || state?.batch?.head === head || (state?.head === head && state.reviews > 0))
  // This file lock outlives every review: an in-flight marker read under a new lock is an
  // interrupted run whose last provider charge is unknown. The next capped review must not borrow it.
  const interruption = state?.inflight?.run.startsWith("batch:") ? state.inflight : undefined
  // Freeze inherited uncertainty when the lock is obtained; unrelated future months are free once
  // this interrupted receipt has been carried through a write that clears the pending marker.
  const recoveryMonth = uncertainBatchMonth(state, meta, options.carriedMonth, now())
  const metadataFor = (plan: ReviewBatchPlan, cursor: BatchCursor, missing = false): LocalMetadata => ({
    cursor,
    initialCostUsd: same(plan) ? meta!.initialCostUsd : total,
    ...(missing || unknownBaseline(plan.head) || interruption?.head === plan.head || (same(plan) && meta?.usageMissing)
      ? { usageMissing: true as const }
      : {}),
    ...(missing || (!options.knownMonthLedger && unknownBaseline(plan.head) && state?.month?.key === monthKey(now()))
      ? { uncertainMonth: monthKey(now()) }
      : recoveryMonth
        ? { uncertainMonth: recoveryMonth }
        : {}),
  })
  const store: ReviewBatchStore = {
    policy,
    ...(persistPending
      ? {
          begin(plan: ReviewBatchPlan, cursor: BatchCursor) {
            const pending = recordBatchCoverage(
              {
                ...(state ?? emptyState()),
                inflight: { head: plan.head, run: "batch:" + plan.id, at: now(), costUsd: 0 },
              },
              plan,
              cursor,
            )!
            return persistPending(pending, metadataFor(plan, cursor))
          },
        }
      : {}),
    resume(plan) {
      const checkpoint = state?.batch ?? meta?.cursor
      if ((raw !== undefined && !meta) || (state?.failed && !checkpoint)) return "mismatch"
      if (!checkpoint || checkpoint.head !== plan.head) return
      if (!meta || !same(plan) || total < meta.initialCostUsd) return "mismatch"
      // Both values are read only through the owner-bound file descriptor; a repo-authored
      // JSON or model report is never an input to this function.
      const cursor = restoreBatchCursor(plan, checkpoint, batchCursorDigest(meta.cursor))
      if (!cursor) return "mismatch"
      alreadyComplete =
        batchCoverage(plan, cursor)?.complete === true &&
        !state?.batch &&
        state?.head === plan.head &&
        !state.failed &&
        !state.unreviewed.length
      if (alreadyComplete && !allowCompletedReuse) {
        alreadyComplete = false
        return
      }
      return cursor
    },
    spent(plan, monthlyCap, headCap = true) {
      if (raw !== undefined && !meta) return
      if (
        state?.batch?.head === plan.head &&
        (!same(plan) || batchCursorDigest(state.batch) !== batchCursorDigest(meta!.cursor))
      )
        return
      if (
        monthlyCap &&
        (recoveryMonth === monthKey(now()) ||
          (!options.knownMonthLedger && unknownBaseline(plan.head) && state?.month?.key === monthKey(now())))
      )
        return
      if (!headCap) return 0
      if (unknownBaseline(plan.head) || interruption?.head === plan.head) return
      if (!same(plan)) return 0
      if (!meta || meta.usageMissing || total < meta.initialCostUsd) return
      return total - meta.initialCostUsd
    },
    record(plan, cursor, cost) {
      result = {
        plan,
        cursor,
        metadata: metadataFor(plan, cursor, unknownOwnSpend(cost)),
      }
    },
  }
  return {
    store,
    continues: (head: string) =>
      (raw !== undefined && !meta) ||
      meta?.cursor.head === head ||
      state?.batch?.head === head ||
      interruption?.head === head,
    get recorded() {
      return result !== undefined
    },
    get alreadyComplete() {
      return alreadyComplete
    },
    get metadata() {
      return result?.metadata
    },
    coverage(state: ReviewState) {
      return result ? recordBatchCoverage(state, result.plan, result.cursor) : undefined
    },
  }
}
