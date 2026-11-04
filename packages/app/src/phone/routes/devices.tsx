import { createResource, createSignal, For, onMount, Show } from "solid-js"
import { phoneApi } from "../api"
import { phonePath } from "../config"
import { canPair } from "../environment"
import { computerLine, decodeDevices, fairUseLine, lastSeenLine, pairedCount, type AccountDevice } from "../remote/model"
import { planNotice } from "../status"
import { Empty, InstallCard, Notice, Panel, type RouteProps } from "./parts"
import { ConfirmButton, ConnectionNotice, Row, useRemoteView } from "./remote-parts"

// Remote's devices (WP A42): the computers this phone is paired with, every device of the account as the relay holds
// it (A40's `GET /api/remote/devices`), removing one for good, and "Disconnect all". The paired count comes from the
// account's status; the relay refuses a pairing over the plan's count whatever this page shows (S1).
export function DevicesRoute(props: RouteProps) {
  const view = useRemoteView(props.remote)
  const [problem, setProblem] = createSignal<string>()
  const [done, setDone] = createSignal<string>()
  const [devices, { refetch }] = createResource(async () =>
    decodeDevices(await phoneApi("/api/remote/devices", props.session)),
  )
  onMount(() => void props.remote.load())

  const limit = () => {
    const remote = props.status.entitlements.remote
    const computers = remote && typeof remote === "object" ? (remote as { computers?: unknown }).computers : undefined
    return typeof computers === "number" ? computers : 0
  }
  const count = () =>
    pairedCount(props.status.remote, devices.latest) ??
    `Your plan pairs up to ${limit()} ${limit() === 1 ? "computer" : "computers"}.`

  const failed = (cause: unknown) =>
    setProblem(cause instanceof Error && cause.message ? cause.message : "Vector could not do that. Try again.")

  const remove = async (device: AccountDevice) => {
    setProblem(undefined)
    setDone(undefined)
    try {
      if (device.device === view().device) {
        // This phone: its keys and pairings go too, and it can pair again under a new id.
        await props.remote.reset()
        setDone("This phone was removed. Pair a computer to use Remote here again.")
      } else {
        await phoneApi(`/api/remote/devices/${encodeURIComponent(device.device)}/revoke`, props.session, {
          method: "POST",
          body: {},
        })
        if (view().computers.some((computer) => computer.device === device.device))
          await props.remote.forget(device.device)
        setDone(`${device.name} was removed. It can pair again from Vector's Settings.`)
      }
      refetch()
      props.refresh()
    } catch (cause) {
      failed(cause)
    }
  }

  const disconnectAll = async () => {
    setProblem(undefined)
    setDone(undefined)
    try {
      await phoneApi("/api/remote/kill", props.session, { method: "POST", body: {} })
      setDone("Every device was disconnected. Paired devices connect again the next time they are used.")
      refetch()
    } catch (cause) {
      failed(cause)
    }
  }

  return (
    <Panel title="Devices">
      <Notice text={planNotice(props.status)} />
      <p class="phone-meta">{count()}</p>
      <Show
        when={canPair(props.environment)}
        fallback={
          <InstallCard
            environment={props.environment}
            reason="On iPhone and iPad, pairing happens inside the installed app, which keeps its own keys apart from Safari."
          />
        }
      >
        <ConnectionNotice remote={props.remote} view={view()} />
        <section class="phone-stack" aria-label="Paired with this phone">
          <h3>Paired with this phone</h3>
          <Show when={view().computers.length} fallback={<Empty>This phone is not paired with a computer.</Empty>}>
            <For each={view().computers}>
              {(computer) => (
                <Row title={computer.name} meta={computerLine(computer)}>
                  <ConfirmButton
                    label="Forget"
                    confirm="Forget it on this phone?"
                    onConfirm={() => props.remote.forget(computer.device)}
                  />
                </Row>
              )}
            </For>
          </Show>
          <button type="button" class="phone-button" onClick={() => props.navigate(phonePath("pair"))}>
            Pair a computer
          </button>
        </section>
      </Show>
      <section class="phone-stack" aria-label="Every device on your account">
        <h3>Every device on your account</h3>
        <Show when={devices.error}>
          <Notice text="Vector could not list your devices. Check your connection and try again." />
        </Show>
        <Show when={fairUseLine(devices.latest?.fairUse ?? "ok")}>{(line) => <Notice text={line()} />}</Show>
        <Show when={devices.latest} fallback={<p class="phone-loading">Loading devices…</p>}>
          {(list) => (
            <Show when={list().devices.length} fallback={<Empty>No device has connected to Vector Remote yet.</Empty>}>
              <For each={list().devices}>
                {(device) => (
                  <Row
                    title={`${device.name}${device.device === view().device ? " (this phone)" : ""}`}
                    meta={`${device.role === "computer" ? "Computer" : "Phone"} · ${lastSeenLine(device)}${
                      device.overLimit ? " · over your plan's limit, so it cannot connect" : ""
                    }`}
                  >
                    <ConfirmButton
                      label="Remove"
                      confirm={`Remove ${device.name} for good?`}
                      onConfirm={() => remove(device)}
                    />
                  </Row>
                )}
              </For>
            </Show>
          )}
        </Show>
        <ConfirmButton
          label="Disconnect all"
          confirm="Disconnect every device now?"
          onConfirm={disconnectAll}
          disabled={!devices.latest?.devices.length}
        />
        <p class="phone-meta">
          Disconnect all closes every connection at once. Removing a device unpairs it for good; it can pair again
          later.
        </p>
      </section>
      <Notice text={done()} />
      <Notice text={problem()} />
    </Panel>
  )
}
