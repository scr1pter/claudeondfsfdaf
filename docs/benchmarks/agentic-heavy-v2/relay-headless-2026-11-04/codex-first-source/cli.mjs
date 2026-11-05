import { readFile } from 'node:fs/promises';
import { createClient, RelayError } from './sdk.mjs';

const commands = {
  status: { positionals: 1, flags: [] },
  members: { positionals: 1, flags: [] },
  stage: { positionals: 1, flags: ['--file', '--base-version', '--key'] },
  approve: { positionals: 2, flags: [] },
  claim: { positionals: 2, flags: ['--lease-ms'] },
  commit: { positionals: 2, flags: ['--lease-token', '--key'] },
  cancel: { positionals: 2, flags: [] },
  events: { positionals: 1, flags: ['--after', '--limit'] },
};

const help = {
  commands: [
    'status WORKSPACE',
    'members WORKSPACE',
    'stage WORKSPACE --file PATH --base-version N --key KEY',
    'approve WORKSPACE IMPORT',
    'claim WORKSPACE IMPORT --lease-ms N',
    'commit WORKSPACE IMPORT --lease-token TOKEN --key KEY',
    'cancel WORKSPACE IMPORT',
    'events WORKSPACE [--after N] [--limit N]',
  ],
  environment: ['RELAY_URL', 'RELAY_TOKEN'],
};

function fail(message) {
  throw new RelayError(0, 'CLI_USAGE', message);
}

function integer(value, min, max, label) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) fail(`${label} must be an integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail(`${label} is out of range.`);
  return number;
}

function parse(args) {
  if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0])) return { help: true };
  const [command, ...rest] = args;
  if (!Object.hasOwn(commands, command)) fail('Choose a supported command; use --help for usage.');
  const definition = commands[command];
  const positionals = [];
  const flags = Object.create(null);
  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index];
    if (part.startsWith('--')) {
      if (!definition.flags.includes(part) || Object.hasOwn(flags, part)) fail('An option is unknown or repeated.');
      const value = rest[++index];
      if (value === undefined || value.startsWith('--')) fail('An option requires a value.');
      flags[part] = value;
    } else {
      positionals.push(part);
    }
  }
  if (positionals.length !== definition.positionals) fail('The command has an incorrect number of arguments.');
  for (const flag of definition.flags) {
    if (command !== 'events' && flags[flag] === undefined) fail('A required option is missing.');
  }
  return { command, positionals, flags };
}

async function run() {
  const parsed = parse(process.argv.slice(2));
  if (parsed.help) return help;
  const { command, positionals: [workspace, importId], flags } = parsed;
  if (!process.env.RELAY_URL || !process.env.RELAY_TOKEN) {
    throw new RelayError(0, 'CLI_CONFIG', 'RELAY_URL and RELAY_TOKEN must be set.');
  }
  const client = createClient({ baseUrl: process.env.RELAY_URL, token: process.env.RELAY_TOKEN });
  switch (command) {
    case 'status': return client.workspace(workspace);
    case 'members': return client.members(workspace);
    case 'stage': {
      const baseVersion = integer(flags['--base-version'], 0, Number.MAX_SAFE_INTEGER, 'Base version');
      let bytes;
      try { bytes = await readFile(flags['--file']); } catch {
        throw new RelayError(0, 'CLI_FILE', 'Unable to read the CSV input file.');
      }
      let csv;
      try { csv = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {
        throw new RelayError(0, 'CLI_FILE', 'The CSV input file must contain valid UTF-8.');
      }
      return client.stage(workspace, { baseVersion, csv }, flags['--key']);
    }
    case 'approve': return client.approve(workspace, importId);
    case 'claim': return client.claim(workspace, importId, integer(flags['--lease-ms'], 100, 5000, 'Lease duration'));
    case 'commit': return client.commit(workspace, importId, flags['--lease-token'], flags['--key']);
    case 'cancel': return client.cancel(workspace, importId);
    case 'events': {
      const options = {};
      if (flags['--after'] !== undefined) options.after = integer(flags['--after'], 0, Number.MAX_SAFE_INTEGER, 'Event cursor');
      if (flags['--limit'] !== undefined) options.limit = integer(flags['--limit'], 1, 100, 'Event limit');
      return client.events(workspace, options);
    }
    default: fail('Choose a supported command; use --help for usage.');
  }
}

function redact(value) {
  let result = value;
  const secrets = [process.env.RELAY_URL, process.env.RELAY_TOKEN];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--lease-token') secrets.push(process.argv[index + 1]);
  }
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join('[redacted]');
  }
  return result;
}

try {
  const result = await run();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const known = error instanceof RelayError;
  const output = { error: {
    code: redact(known ? error.code : 'CLI_ERROR'),
    message: redact(known ? error.message : 'Unable to complete the command.'),
  } };
  if (known && error.status > 0) output.error.status = error.status;
  process.stderr.write(`${JSON.stringify(output)}\n`);
  process.exitCode = 1;
}
