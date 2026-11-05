export type Channel = "dev" | "beta" | "prod"

export function resolveChannel(): Channel {
  const raw = process.env.VECTOR_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
}
