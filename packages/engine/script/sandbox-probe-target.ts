// Each immutable probe must resolve Core's runtime-specific imports for its actual executor.
export function sandboxProbeTarget(runtime: "node" | "bun") {
  return {
    target: runtime,
    conditions: runtime === "bun" ? ["bun", "node"] : ["node"],
    naming: { entry: runtime === "bun" ? "probe-bun.mjs" : "probe.mjs", asset: "assets/[name]-[hash].[ext]" },
  }
}
