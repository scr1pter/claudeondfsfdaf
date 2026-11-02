import { mkdirSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
mkdirSync(resolve(root, "dist"), { recursive: true });
copyFileSync(resolve(root, "public/index.html"), resolve(root, "dist/index.html"));
