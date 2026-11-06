export {};

import { cpSync, mkdirSync } from "node:fs";

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
mkdirSync("dist/public", { recursive: true });
cpSync("public", "dist/public", { recursive: true });
