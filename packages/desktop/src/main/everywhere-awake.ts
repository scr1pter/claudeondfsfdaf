/** Electron is injected; merely importing this unwired module never holds the owner's computer awake. */
export function createEverywhereAwake(input: {
  readonly onBattery: () => boolean
  readonly start: (kind: "prevent-app-suspension") => number
  readonly stop: (id: number) => void
}) {
  let blocker: number | undefined
  const update = (jobsOn: boolean, stayAwake: boolean) => {
    const wanted = jobsOn && stayAwake && !input.onBattery()
    if (wanted && blocker === undefined) blocker = input.start("prevent-app-suspension")
    if (!wanted && blocker !== undefined) { input.stop(blocker); blocker = undefined }
  }
  return { update, dispose: () => update(false, false) }
}
