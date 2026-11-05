import { readFileSync } from 'node:fs';
import { createClient } from './sdk.mjs';
const args = process.argv.slice(2);
if (args[0] === '--help') {
  console.log('Relay Directory: status members stage approve claim commit cancel events');
} else {
  try {
    if (!process.env.RELAY_URL || !process.env.RELAY_TOKEN) throw new Error('configuration');
    const client = createClient({baseUrl: process.env.RELAY_URL, token: process.env.RELAY_TOKEN});
    const [command, workspace, importId] = args;
    const flag = name => { const index = args.indexOf('--' + name); if (index < 0 || !args[index + 1]) throw new Error('flag'); return args[index + 1]; };
    const number = name => { const value = flag(name); if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('number'); return Number(value); };
    if (!workspace) throw new Error('workspace');
    let value;
    if (command === 'status') value = await client.workspace(workspace);
    else if (command === 'members') value = await client.members(workspace);
    else if (command === 'stage') value = await client.stage(workspace, {baseVersion: number('base-version'), csv: readFileSync(flag('file'), 'utf8')}, flag('key'));
    else if (command === 'approve') value = await client.approve(workspace, importId);
    else if (command === 'claim') value = await client.claim(workspace, importId, number('lease-ms'));
    else if (command === 'commit') value = await client.commit(workspace, importId, flag('lease-token'), flag('key'));
    else if (command === 'cancel') value = await client.cancel(workspace, importId);
    else if (command === 'events') value = await client.events(workspace, {after: number('after'), limit: number('limit')});
    else throw new Error('command');
    console.log(JSON.stringify(value));
  } catch (error) {
    console.error(JSON.stringify({error: {code: typeof error.code === 'string' ? error.code : 'CLI_ERROR', message: 'Command failed'}}));
    process.exitCode = 1;
  }
}
