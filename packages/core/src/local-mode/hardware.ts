export * as LocalHardware from "./hardware"

import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import os from "node:os"
import { untrustedChildEnvironment } from "../child-environment"
import { which } from "../util/which"

// This computer's memory and GPUs, for two things: whether a model about to load fits in the memory that is free,
// and which models to suggest. The parsers are pure; `read` gathers their input from this computer. Free memory is
// what the system says it can give a new program without swapping: macOS counts free, inactive, purgeable and
// speculative pages (os.freemem() counts only the free ones, which is far less), Linux reads MemAvailable. NVIDIA
// GPUs come from nvidia-smi when it is installed; other GPUs are not read. An NVIDIA GPU that shares system memory
// (a unified-memory system such as GB10) reports no memory of its own there, and is counted like Apple silicon.

const GB = 1024 ** 3

export type Gpu = {
  readonly name: string
  /** Its own memory in bytes, or 0 when it reports none because it shares system memory. */
  readonly total: number
  readonly free?: number
}

/** How a model's memory is held: shared with the CPU (Apple silicon), on GPUs, or in system memory alone. */
export type Kind = "unified" | "gpu" | "cpu"

export type Hardware = {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly memory: { readonly total: number; readonly free: number }
  readonly gpus: readonly Gpu[]
  readonly kind: Kind
  /** About how much memory a model can use here, in bytes. */
  readonly usable: number
}

export type Input = {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly total: number
  readonly free: number
  readonly gpus?: readonly Gpu[]
}

/**
 * The summary from raw numbers. Apple silicon lets the GPU use about two thirds of memory up to 36 GB and three
 * quarters above that, macOS's defaults, and a GPU that reports no memory of its own shares system memory the same
 * way. A computer with NVIDIA GPUs holds a model in their memory. Without a GPU a model runs from system memory, of
 * which about half is left for it.
 */
export function summarize(input: Input): Hardware {
  const gpus = input.gpus ?? []
  const shared = gpus.length > 0 && gpus.every((gpu) => gpu.total === 0)
  const kind: Kind =
    (input.platform === "darwin" && input.arch === "arm64") || shared ? "unified" : gpus.length ? "gpu" : "cpu"
  const usable =
    kind === "unified"
      ? input.total * (input.total <= 36 * GB ? 2 / 3 : 3 / 4)
      : kind === "gpu"
        ? gpus.reduce((sum, gpu) => sum + gpu.total, 0)
        : input.total / 2
  return {
    platform: input.platform,
    arch: input.arch,
    memory: { total: input.total, free: input.free },
    gpus,
    kind,
    usable: Math.floor(usable),
  }
}

/**
 * Memory a model loading now could use: free system memory, plus free GPU memory on a computer with its own GPUs,
 * which a server such as Ollama fills first.
 */
export function free(hardware: Hardware) {
  if (hardware.kind !== "gpu") return hardware.memory.free
  return hardware.memory.free + hardware.gpus.reduce((sum, gpu) => sum + (gpu.free ?? 0), 0)
}

/** "32 GB of memory shared with the GPU, about 21 GB of it for a model." */
export function describe(hardware: Hardware) {
  const total = Math.round(hardware.memory.total / GB)
  const usable = Math.floor(hardware.usable / GB)
  if (hardware.kind === "unified")
    return `This computer has ${total} GB of memory shared with its GPU; about ${usable} GB of it can hold a model.`
  if (hardware.kind === "gpu") {
    const names = [...new Set(hardware.gpus.map((gpu) => gpu.name))].join(", ")
    return `This computer has ${names} with ${usable} GB of GPU memory in all, and ${total} GB of system memory.`
  }
  return `This computer has ${total} GB of memory and no GPU Vector can read, so models run on the CPU and reply slowly.`
}

/** Free bytes from `vm_stat` on macOS: free, inactive, purgeable and speculative pages. */
export function parseVmStat(text: string) {
  const size = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 4096)
  const pages = (label: string) => Number(text.match(new RegExp(`^Pages ${label}:\\s+(\\d+)`, "m"))?.[1] ?? 0)
  return (pages("free") + pages("inactive") + pages("purgeable") + pages("speculative")) * size
}

/** MemAvailable from /proc/meminfo on Linux, in bytes, or undefined on a kernel that does not report it. */
export function parseMeminfo(text: string) {
  const kilobytes = text.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1]
  return kilobytes === undefined ? undefined : Number(kilobytes) * 1024
}

/**
 * GPUs from `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits` (MiB). A GPU whose
 * memory is not a number ("[N/A]" on a unified-memory system) is listed with a total of 0.
 */
export function parseNvidiaSmi(text: string): readonly Gpu[] {
  const mib = (part: string | undefined) =>
    part && /^\d+(?:\.\d+)?$/.test(part) ? Number(part) * 1024 * 1024 : undefined
  return text
    .split(/\r?\n/)
    .map((line) => line.split(",").map((part) => part.trim()))
    .filter((parts) => parts.length >= 3 && parts[0])
    .map((parts) => ({ name: parts[0], total: mib(parts[1]) ?? 0, free: mib(parts[2]) }))
}

/** This computer's hardware. Reading it runs vm_stat on macOS and nvidia-smi where it is installed, nothing else. */
export async function read(): Promise<Hardware> {
  const platform = process.platform
  const [available, smi] = await Promise.all([
    platform === "darwin"
      ? run(["/usr/bin/vm_stat"]).then((text) => (text ? parseVmStat(text) : undefined))
      : platform === "linux"
        ? readFile("/proc/meminfo", "utf8")
            .then(parseMeminfo)
            .catch(() => undefined)
        : Promise.resolve(undefined),
    platform === "darwin"
      ? Promise.resolve(undefined)
      : run(["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"]),
  ])
  return summarize({
    platform,
    arch: process.arch,
    total: os.totalmem(),
    free: available ?? os.freemem(),
    gpus: smi ? parseNvidiaSmi(smi) : [],
  })
}

// A command's output, or undefined when it is missing, fails or takes over two seconds. The program is found the way
// Vector finds every program, never in the repository it runs in, and gets the untrusted-child environment, without
// Vector's own secrets (F9). Node's API, since the desktop's engine runs on Node.
async function run(command: readonly string[]) {
  const executable = command[0] && which(command[0])
  if (!executable) return undefined
  return new Promise<string | undefined>((resolve) =>
    execFile(
      executable,
      command.slice(1),
      { timeout: 2_000, windowsHide: true, env: untrustedChildEnvironment() },
      (error, stdout) => resolve(error ? undefined : stdout),
    ),
  )
}
