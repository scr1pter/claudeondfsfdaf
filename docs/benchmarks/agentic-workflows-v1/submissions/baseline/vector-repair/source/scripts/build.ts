export {};

const result = await Bun.build({
  entrypoints: ["server/index.ts"],
  outdir: "dist",
  target: "bun",
  external: ["bun:sqlite"],
});
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
