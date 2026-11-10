"use strict";
// Resolve the delivered Vite output, never infer that an authored public/ tree is disposable.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function buildOptions(script) {
  const match = /(?:^|\s)vite(?:\.cmd)?\s+build\b([^;&|]*)/.exec(script);
  if (!match) throw new Error("Cannot determine Vite build invocation from delivered package script");
  const args = (match[1].match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map(value => value.replace(/"([^"]*)"|'([^']*)'/g, (_match, double, single) => double ?? single));
  const inline = {};
  for (let index = 0; index < args.length; index++) {
    if (!args[index].startsWith("-")) {
      if (inline.root || /[$`%]/.test(args[index])) throw new Error("Ambiguous or dynamic Vite input root requires independent manual output review");
      inline.root = path.resolve(args[index]);
      continue;
    }
    const [flag, attached] = args[index].split(/=(.*)/s);
    if (!["--outDir", "--config", "-c", "--mode", "-m"].includes(flag)) throw new Error("Unsupported Vite build option requires independent manual output review");
    const value = attached === undefined ? args[++index] : attached;
    if (!value || value.startsWith("-")) throw new Error("Missing Vite build option value");
    if (/[$`%]/.test(value)) throw new Error("Dynamic Vite build options require independent manual output review");
    if (flag === "--outDir") inline.build = { outDir: value };
    else if (["--config", "-c"].includes(flag)) inline.configFile = path.resolve(value);
    else inline.mode = value;
  }
  return inline;
}

async function main() {
  const app = path.resolve(process.argv[2]);
  process.chdir(app);
  const pkg = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8"));
  const inline = buildOptions(pkg.scripts?.build || "");
  const { resolveConfig } = await import(pathToFileURL(path.join(app, "node_modules", "vite", "dist", "node", "index.js")).href);
  const config = await resolveConfig(inline, "build", "production", "production");
  const input = config.build.rollupOptions.input || "index.html";
  const declared = typeof input === "string" ? [input] : Array.isArray(input) ? input : Object.values(input);
  const inputPaths = [...declared.map(value => path.resolve(config.root, value)), ...(config.configFileDependencies || []), ...(config.configFile ? [config.configFile] : [])];
  console.log("FOUNDRY_BUILD_OUTPUT=" + JSON.stringify({ root: config.root, outDir: path.resolve(config.root, config.build.outDir), publicDir: config.publicDir || null, inputPaths }));
}

module.exports = { buildOptions };
if (require.main === module) main().catch(error => { console.error(String(error.message || error)); process.exitCode = 1; });
