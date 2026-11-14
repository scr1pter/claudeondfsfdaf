const disposers = new Set<(directory: string) => Promise<void>>()
// Directories whose instance is going away, counted, since a reload and a dispose of one directory can overlap.
const going = new Map<string, number>()
let shuttingDown = false

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

/**
 * Whether the instance of this directory is going away: disposed, reloaded, or Vector shutting down. Work it stops
 * meanwhile was interrupted rather than cancelled, so a restart can report it.
 */
export function disposing(directory: string) {
  return shuttingDown || going.has(directory)
}

/** Counts the directory as disposing until the returned function runs. */
export function markDisposing(directory: string) {
  going.set(directory, (going.get(directory) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (going.get(directory) ?? 1) - 1
    if (left > 0) going.set(directory, left)
    else going.delete(directory)
  }
}

/** The runtime is shutting down: from now on every directory counts as disposing. */
export function shutdown() {
  shuttingDown = true
}

// Every disposal of an instance (InstanceStore.disposeContext and reload) runs through here, marked as disposing.
export async function disposeInstance(directory: string) {
  const release = markDisposing(directory)
  try {
    await Promise.allSettled([...disposers].map((disposer) => disposer(directory)))
  } finally {
    release()
  }
}
