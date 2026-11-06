import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const id = option("--job-id");
const attempt = Number(option("--attempt"));
const kind = option("--kind");
const directory = process.env.WORKFLOW_MARKER_DIR;
const parent = Number(process.env.WORKFLOW_PARENT_PID);
if (
  !directory ||
  !/^[A-Za-z0-9_-]{1,100}$/.test(id) ||
  !Number.isInteger(attempt) ||
  attempt < 1
) {
  process.exit(64);
}
mkdirSync(directory, { recursive: true });
const prefix = join(directory, `${id}.${attempt}`);
writeFileSync(
  `${prefix}.started.json`,
  JSON.stringify({ jobId: id, attempt, pid: process.pid, parent }),
);

if (kind === "block") {
  while (!existsSync(`${prefix}.release`)) {
    try {
      if (Number.isInteger(parent) && parent > 0) process.kill(parent, 0);
    } catch {
      process.exit(71);
    }
    await Bun.sleep(20);
  }
}
if (kind === "fail" || (kind === "fail_once" && attempt === 1)) {
  writeFileSync(`${prefix}.finished.json`, JSON.stringify({ exitCode: 5 }));
  console.error("Synthetic worker requested failure");
  process.exit(5);
}
writeFileSync(`${prefix}.finished.json`, JSON.stringify({ exitCode: 0 }));
console.log(JSON.stringify({ jobId: id, attempt, message: "completed" }));
