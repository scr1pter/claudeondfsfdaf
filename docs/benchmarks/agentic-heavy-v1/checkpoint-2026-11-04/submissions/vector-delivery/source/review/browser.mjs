// Recording wrapper for the supplied authorized browser client; never browser libraries.
import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
const [name, text] = process.argv.slice(2);
const action = JSON.parse(text || readFileSync(0, 'utf8'));
const dir = join(process.env.DATA_DIR, 'review-evidence');
mkdirSync(dir, {recursive: true});
const result = spawnSync(process.env.NODE_EXE, [process.env.BROWSER_DRIVER_CLIENT, '--endpoint', process.env.BROWSER_DRIVER_ENDPOINT], {input: JSON.stringify(action), encoding: 'utf8', timeout: 30000});
if (result.error) throw result.error;
const output = JSON.parse(result.stdout);
writeFileSync(join(dir, name + '.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ok: output.ok, error: output.error, result: output.result, snapshot: output.snapshot && {generation: output.snapshot.generation, url: output.snapshot.url, text: output.snapshot.text, controls: output.snapshot.controls?.filter(control => !['foundry.','Workspace','New workspace','Overview⌘ 1','Customers','Inventory','Orders','Invoices','Projects','Activity','Team','Have an invite? Join workspace ↗','Sign out'].includes(control.name)), focus: output.snapshot.focus}}));
if (!output.ok || result.status !== 0) process.exitCode = 1;
