import { endianness } from "node:os"
import { Stream } from "effect"

const FD = 3
export const args = ["--seccomp", String(FD)] as const

/** A private input for bubblewrap. The command still gets ignored stdin and captured output. */
export function options(filter: Uint8Array) {
  return { additionalFds: { [`fd${FD}`]: { type: "input", stream: Stream.make(filter) } } } as const
}

// Check the descriptors from inside the sandbox before starting the caller's program. The trusted shell uses only
// builtins here. An open extra descriptor, a missing proc mount, or an unconsumed seccomp descriptor refuses the run.
const checkDescriptors = `
[ -d /proc/self/fd ] && [ -r /proc/self/fd ] && [ -x /proc/self/fd ] || exit 125
for descriptor in /proc/self/fd/*; do
  case "$descriptor" in
    "/proc/self/fd/*") exit 125 ;;
    /proc/self/fd/[012]) continue ;;
  esac
  [ ! -L "$descriptor" ] || exit 125
done
exec "$@"
`
export function command(shell: string, args: readonly string[]) {
  return [shell, "-c", checkDescriptors, "vector-unattended", ...args]
}

// Linux's audit IDs and native syscall numbers. A different ABI is refused by the filter, including compat tasks.
const ABI = {
  x64: { audit: 0xc000003e, socket: 41, socketpair: 53 },
  arm64: { audit: 0xc00000b7, socket: 198, socketpair: 199 },
} as const

export function supported(arch = process.arch, order = endianness()) {
  return order === "LE" && (arch === "x64" || arch === "arm64")
}

// Linux seccomp_data offsets. Its 64-bit arguments store the low word first on the supported platforms.
const NUMBER = 0
const ARCH = 4
const FAMILY = 16
const SOCKET_TYPE = 24
const AF_UNIX = 1
const SOCK_STREAM = 1
const SOCKET_TYPE_MASK = 0xf
const KILL = 0x80000000
const ALLOW = 0x7fff0000
const EPERM = 0x00050001
const ENOSYS = 0x00050026
const IO_URING = [425, 426, 427]
const PIDFD_GETFD = 438

type Instruction = readonly [code: number, value: number, yes?: number, no?: number]
const load = (offset: number): Instruction => [0x20, offset]
const equal = (value: number, yes: number, no: number): Instruction => [0x15, value, yes, no]
const atLeast = (value: number, yes: number, no: number): Instruction => [0x35, value, yes, no]
const mask = (value: number): Instruction => [0x54, value]
const result = (value: number): Instruction => [0x06, value]

/**
 * Bubblewrap's private network namespace handles IP. A read-only mount cannot make a named Unix socket unusable.
 * Deny new Unix endpoints, and permit only already connected stream pairs for ordinary local subprocess IPC.
 * The filter also refuses the io_uring syscall family and cross-process descriptor retrieval.
 */
export function filter(arch = process.arch, order = endianness()) {
  if (order !== "LE" || (arch !== "x64" && arch !== "arm64")) return undefined
  const abi = ABI[arch]
  const socket = [load(FAMILY), equal(AF_UNIX, 0, 1), result(EPERM), result(ALLOW)]
  const pair = [
    load(FAMILY),
    equal(AF_UNIX, 1, 0),
    result(EPERM),
    load(SOCKET_TYPE),
    mask(SOCKET_TYPE_MASK),
    equal(SOCK_STREAM, 1, 0),
    result(EPERM),
    result(ALLOW),
  ]
  const program = [
    load(ARCH),
    equal(abi.audit, 1, 0),
    result(KILL),
    load(NUMBER),
    // x86-64 shares its audit ID with x32. This also refuses the x32 reserved syscall range on older kernels.
    ...(arch === "x64" ? [atLeast(512, 0, 1), result(ENOSYS)] : []),
    ...IO_URING.flatMap((number) => [equal(number, 0, 1), result(ENOSYS)]),
    equal(PIDFD_GETFD, 0, 1),
    result(EPERM),
    equal(abi.socket, 0, socket.length),
    ...socket,
    equal(abi.socketpair, 0, pair.length),
    ...pair,
    result(ALLOW),
  ]
  // struct sock_filter is one 16-bit opcode, two byte branch offsets, and one 32-bit operand.
  const bytes = new ArrayBuffer(program.length * 8)
  const view = new DataView(bytes)
  program.forEach(([code, value, yes = 0, no = 0], index) => {
    const offset = index * 8
    view.setUint16(offset, code, true)
    view.setUint8(offset + 2, yes)
    view.setUint8(offset + 3, no)
    view.setUint32(offset + 4, value, true)
  })
  return new Uint8Array(bytes)
}
