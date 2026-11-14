export type ComputerHelperPins = Partial<Record<"x64" | "arm64", string>>

const prefix = "vector-computer-helper-pins-v1:"
const architectures = ["x64", "arm64"] as const

/** A single ASCII constant is both decoded by Main and inspected in the final packaged Main bundle. */
export function encodeComputerHelperPins(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new Error("Computer helper pins must be a supported architecture hash map.")
  const entries = Object.entries(value)
  if (
    entries.some(
      ([arch, hash]) =>
        !architectures.includes(arch as "x64" | "arm64") || typeof hash !== "string" || !/^[a-f0-9]{64}$/i.test(hash),
    )
  )
    throw new Error("Computer helper pins require SHA-256 hashes for x64 or arm64.")
  return (
    prefix +
    architectures
      .flatMap((arch) => {
        const hash: unknown = Reflect.get(value, arch)
        return Object.hasOwn(value, arch) && typeof hash === "string" ? [`${arch}=${hash.toLowerCase()};`] : []
      })
      .join("") +
    "end"
  )
}

export function decodeComputerHelperPins(value: unknown): ComputerHelperPins {
  if (typeof value !== "string" || value.length > 200 || !value.startsWith(prefix) || !value.endsWith("end"))
    throw new Error("The compiled computer helper pin document is invalid.")
  const body = value.slice(prefix.length, -3)
  const entries = body === "" ? [] : body.endsWith(";") ? body.slice(0, -1).split(";") : [""]
  const parsed = entries.map((entry) => /^(x64|arm64)=([a-f0-9]{64})$/.exec(entry))
  if (parsed.some((entry) => !entry)) throw new Error("The compiled computer helper pin entry is invalid.")
  const hashes = Object.fromEntries(parsed.map((entry) => [entry![1]!, entry![2]!]))
  if (encodeComputerHelperPins(hashes) !== value)
    throw new Error("The compiled computer helper pins are duplicated or out of canonical order.")
  return hashes
}

/** Prefix literals used by the decoder are not documents; duplicate complete documents are ambiguous. */
export function extractComputerHelperPins(documents: string | readonly string[]): ComputerHelperPins {
  const pattern = /(?<![a-zA-Z0-9_-])vector-computer-helper-pins-v1:[^\s"'`\\]{0,200}?end(?=$|[^a-zA-Z0-9_:;=-])/g
  const matches = (typeof documents === "string" ? [documents] : documents).flatMap((document) =>
    Array.from(document.matchAll(pattern), (match) => match[0]),
  )
  if (matches.length !== 1)
    throw new Error("Packaged Main must contain exactly one complete computer helper pin document.")
  return decodeComputerHelperPins(matches[0])
}
