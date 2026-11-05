import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['app.mjs', 'cli.mjs', 'sdk.mjs'];
for (const directory of ['backend', 'scripts', 'tests']) {
  try {
    for (const entry of await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })) {
      if (entry.isFile() && /\.(mjs|mts)$/.test(entry.name) && !entry.name.endsWith('.d.mts')) files.push(`${directory}/${entry.name}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
for (const file of files.sort()) {
  if (globalThis.Bun) {
    // Bun's --check does not provide Node's syntax-only behavior. Transpile
    // without executing modules, opening listeners, or loading dependencies.
    const transpiler = new globalThis.Bun.Transpiler({ loader: file.endsWith('.mts') ? 'ts' : 'js' });
    transpiler.transformSync(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    continue;
  }
  const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Syntax check failed: ${file}\n`);
    process.exit(1);
  }
}
process.stdout.write(JSON.stringify({ ok: true, checked: files.length }) + '\n');
