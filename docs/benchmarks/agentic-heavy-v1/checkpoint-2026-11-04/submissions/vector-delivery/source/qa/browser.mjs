// Authorized browser client only. Evidence is runtime data outside authored source.
import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = join(process.env.DATA_DIR, 'qa-evidence');
mkdirSync(dir, { recursive: true });
const actions = JSON.parse(process.argv[2] || readFileSync(0, 'utf8'));
for (const [name, action] of actions) {
  if (action.action === 'screenshot') action.path = join(dir, name + '.png');
  const started = new Date().toISOString();
  const result = spawnSync(process.env.NODE_EXE, [process.env.BROWSER_DRIVER_CLIENT, '--endpoint', process.env.BROWSER_DRIVER_ENDPOINT], { input: JSON.stringify(action), encoding: 'utf8', timeout: 25000 });
  if (result.error) throw result.error;
  const output = JSON.parse(result.stdout);
  if (action.action === 'screenshot' && output.ok && output.result?.file) {
    // Client owns its capture path; retain the returned capture under DATA_DIR.
    const saved = join(dir, name + '.png');
    writeFileSync(saved, readFileSync(output.result.file));
    output.result.evidenceCopy = saved;
  }
  appendFileSync(join(dir, 'browser.ndjson'), JSON.stringify({ name, started, finished: new Date().toISOString(), ...output }) + '\n');
  writeFileSync(join(dir, name + '.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ name, ok: output.ok, error: output.error, result: output.result, snapshot: output.snapshot && { generation: output.snapshot.generation, url: output.snapshot.url, text: output.snapshot.text, controls: output.snapshot.controls?.filter(c => !['foundry.','Workspace','New workspace','Overview⌘ 1','Customers','Inventory','Orders','Invoices','Projects','Activity','Team','Have an invite? Join workspace ↗','Sign out'].includes(c.name)).map(c => [c.ref,c.role,c.name,c.value,c.options]), focus: output.snapshot.focus } }));
  if (!output.ok || result.status !== 0) process.exit(1);
}
