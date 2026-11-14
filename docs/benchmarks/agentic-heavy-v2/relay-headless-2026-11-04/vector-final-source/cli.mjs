import { open } from 'node:fs/promises';
import { createClient, RelayError } from './sdk.mjs';

const help = `Relay Directory — JSON client for the running local service

Usage: <runtime> cli.mjs COMMAND
  status WORKSPACE
  members WORKSPACE
  stage WORKSPACE --file PATH --base-version N --key KEY
  approve WORKSPACE IMPORT
  claim WORKSPACE IMPORT --lease-ms N
  commit WORKSPACE IMPORT --lease-token TOKEN --key KEY
  cancel WORKSPACE IMPORT
  events WORKSPACE [--after N] [--limit N]
  --help

Set RELAY_URL and RELAY_TOKEN. Success is one JSON value on stdout;
failure is one JSON error on stderr with a nonzero exit code.
Events default to after=0, limit=50. Lease duration: 100–5000 ms.
CSV files must be valid UTF-8 and at most 65,536 bytes.
`;

const commands = {
  status: { positional: 1, flags: [] },
  members: { positional: 1, flags: [] },
  stage: { positional: 1, flags: ['--file', '--base-version', '--key'] },
  approve: { positional: 2, flags: [] },
  claim: { positional: 2, flags: ['--lease-ms'] },
  commit: { positional: 2, flags: ['--lease-token', '--key'] },
  cancel: { positional: 2, flags: [] },
  events: { positional: 1, flags: ['--after', '--limit'], optional: true },
};

function usage() {
  throw new RelayError(0, 'USAGE_ERROR', 'Invalid command arguments. Use --help.');
}

function parse(args) {
  const [command, ...rest] = args;
  if (!Object.hasOwn(commands, command)) usage();
  const definition = commands[command];
  const positional = [];
  const flags = Object.create(null);
  for (let index = 0; index < rest.length; index++) {
    const value = rest[index];
    if (value.startsWith('-')) {
      if (!definition.flags.includes(value) || Object.hasOwn(flags, value)) usage();
      const next = rest[++index];
      // Values are opaque: lease tokens and file paths can begin with hyphens.
      // Required flags, positional counts and command-specific validation still apply.
      if (!next) usage();
      flags[value] = next;
    } else {
      positional.push(value);
    }
  }
  if (positional.length !== definition.positional || positional.some(value => !value)) usage();
  if (!definition.optional && definition.flags.some(flag => !Object.hasOwn(flags, flag))) usage();
  return { command, positional, flags };
}

function number(value, min, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) usage();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) usage();
  return parsed;
}

async function csvFile(path) {
  let file;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) throw new RelayError(0, 'FILE_ERROR', 'Unable to read the CSV file.');
    if (stat.size > 65536) throw new RelayError(0, 'FILE_TOO_LARGE', 'CSV exceeds the 65,536-byte limit.');
    // Bound the read even if the file grows after stat(). Keep a leading BOM in the submitted bytes.
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > 65536) throw new RelayError(0, 'FILE_TOO_LARGE', 'CSV exceeds the 65,536-byte limit.');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new RelayError(0, 'INVALID_UTF8', 'CSV must contain valid UTF-8.');
    }
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError(0, 'FILE_ERROR', 'Unable to read the CSV file.');
  } finally {
    await file?.close().catch(() => {});
  }
}

async function run(args) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(help);
    return;
  }
  const { command, positional: [workspace, importId], flags } = parse(args);
  const client = createClient({ baseUrl: process.env.RELAY_URL, token: process.env.RELAY_TOKEN });
  let result;
  switch (command) {
    case 'status': result = await client.workspace(workspace); break;
    case 'members': result = await client.members(workspace); break;
    case 'stage': {
      const baseVersion = number(flags['--base-version'], 0);
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(flags['--key'])) usage();
      const csv = await csvFile(flags['--file']);
      result = await client.stage(workspace, { baseVersion, csv }, flags['--key']);
      break;
    }
    case 'approve': result = await client.approve(workspace, importId); break;
    case 'claim': result = await client.claim(workspace, importId, number(flags['--lease-ms'], 100, 5000)); break;
    case 'commit': result = await client.commit(workspace, importId, flags['--lease-token'], flags['--key']); break;
    case 'cancel': result = await client.cancel(workspace, importId); break;
    case 'events': result = await client.events(workspace, {
      ...(flags['--after'] === undefined ? {} : { after: number(flags['--after'], 0) }),
      ...(flags['--limit'] === undefined ? {} : { limit: number(flags['--limit'], 1, 100) }),
    }); break;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Never render an upstream message/code, exception, URL, environment value or argument.
// An arbitrary server response may contain credentials, even in its error code.
const safeMessages = {
  USAGE_ERROR: 'Invalid command arguments. Use --help.',
  INVALID_CONFIG: 'Set a valid RELAY_URL and RELAY_TOKEN.',
  INVALID_ARGUMENT: 'Invalid client argument.',
  TRANSPORT_ERROR: 'Unable to complete the service request.',
  FILE_ERROR: 'Unable to read the CSV file.',
  FILE_TOO_LARGE: 'CSV exceeds the 65,536-byte limit.',
  INVALID_UTF8: 'CSV must contain valid UTF-8.',
};

try {
  await run(process.argv.slice(2));
} catch (error) {
  let result = { code: 'CLIENT_ERROR', message: 'The command could not be completed.' };
  if (error instanceof RelayError) {
    if (error.status === 0 && Object.hasOwn(safeMessages, error.code)) {
      result = { code: error.code, message: safeMessages[error.code] };
    } else if (Number.isInteger(error.status) && error.status >= 100 && error.status <= 599) {
      result = {
        code: error.code === 'INVALID_RESPONSE' ? 'INVALID_RESPONSE' : 'HTTP_ERROR',
        message: error.code === 'INVALID_RESPONSE' ? 'The service returned an invalid response.' :
          `Service request failed (HTTP ${error.status}).`,
        status: error.status,
      };
    }
  }
  process.stderr.write(`${JSON.stringify({ error: result })}\n`);
  process.exitCode = 1;
}
