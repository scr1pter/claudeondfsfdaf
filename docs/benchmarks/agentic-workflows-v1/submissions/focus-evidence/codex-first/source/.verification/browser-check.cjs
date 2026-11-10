const { spawnSync } = require("node:child_process");
const { appendFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");
const assert = require("node:assert/strict");
const log = resolve(".verification/browser-log.ndjson");
let snapshot;
function action(value) {
  const result = spawnSync(process.env.NODE_EXE, [process.env.BROWSER_DRIVER_CLIENT, "--endpoint", process.env.BROWSER_DRIVER_ENDPOINT], { input: JSON.stringify(value), encoding: "utf8", timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const response = JSON.parse(result.stdout);
  appendFileSync(log, JSON.stringify({ action: value.action, response }) + "\n");
  assert.equal(response.ok, true, JSON.stringify(response));
  snapshot = response.snapshot ?? snapshot;
  return response;
}
function waitFor(predicate, message) {
  const end = Date.now() + 8000;
  do { action({ action: "observe" }); if (predicate(snapshot)) return; } while (Date.now() < end);
  throw new Error(message + "\n" + snapshot.text);
}
const has = (text) => snapshot.text.replace(/\r\n/g, "\n").includes(text);
function click(name) { action({ action: "click", role: "button", name }); }
function type(name, text) { action({ action: "type", role: "textbox", name, text }); }
function select(name, value) { action({ action: "select", role: "combobox", name, values: [value] }); }
function control(name) { return snapshot.controls.find((x) => x.name === name); }
function resultButtons() { return snapshot.controls.filter((x) => /^Open document \d+$/.test(x.name)); }
function batch(id, ...ops) { return [JSON.stringify({ type: "batch", batchId: id }), ...ops.map((op) => JSON.stringify(op))].join("\n"); }
const original = "# Field log\r\nCafé 🧭 amber fern. e\u0301 東京.\n<script>document.title='ATTACK'</script><img src='/api/never-load' onerror=\"document.title='ATTACK'\"> [local link](/api/never-load)";
const initial = batch("browser_01", { type: "upsert", source: "notes/fern.md", title: "Fern <b>log</b>", body: original },
  ...Array.from({ length: 4 }, (_, i) => ({ type: "upsert", source: "notes/field-" + (i + 2) + ".md", title: "Field note " + (i + 2), body: "Amber fern record " + (i + 2) + "." })));
action({ action: "open", url: "http://127.0.0.1:" + process.env.PORT });
type("Batch NDJSON", initial);
click("Import batch");
waitFor(() => has("Batch browser_01") && has("replayed: true"), "original batch should replay");
type("Batch NDJSON", '{"type":"batch","batchId":"broken"}\n{"type":"upsert","source":"bad","title":"","body":"x"}');
click("Import batch");
waitFor(() => has("Batch import failed:"), "invalid batch should show useful error");
assert.ok(control("Batch NDJSON").value.includes('"batchId":"broken"'), "failed batch should retain text");
type("Search documents", "amber fern");
select("Results per page", "2");
click("Search");
waitFor(() => resultButtons().length === 2 && has("collection revision 1"), "first page should have two results");
assert.deepEqual(resultButtons().map((x) => x.name), ["Open document 1", "Open document 2"]);
click("Next results");
waitFor(() => resultButtons().length === 4, "second page should append two hits");
click("Next results");
waitFor(() => resultButtons().length === 5 && control("Next results").disabled, "end of pagination should disable next");
click("Search");
waitFor(() => resultButtons().length === 2, "new search should reset");
click("View citation 1");
waitFor(() => has("Start byte: 0") && has("End byte:") && has(original.replace(/\r\n/g, "\n")), "citation should show exact original Unicode text");
assert.equal(snapshot.title, "Evidence Workbench", "imported scripts must remain text");
click("Open cited document");
waitFor(() => !!control("Document version"), "cited document should open");
assert.equal(control("Document version").options.length, 1);
type("Document source", "notes/fern.md");
type("Document title", "Fern revision");
type("Document text", "Cobalt 🧭 amber fern.\nReplacement body.");
click("Import document");
waitFor(() => has("Imported document 1, version 2."), "legacy importer should create next version");
click("Next results");
waitFor(() => !!control("Restart search") && has("Collection changed"), "material write should expose stale cursor");
assert.equal(resultButtons().length, 2, "stale page must not append results");
click("Restart search");
waitFor(() => resultButtons().length === 2 && has("collection revision 2") && !control("Restart search"), "restart should use new collection revision");
click("Open document 1");
waitFor(() => has("Replacement body.") && control("Document version")?.options.length === 2, "latest version should be shown");
select("Document version", "1");
waitFor(() => has(original.replace(/\r\n/g, "\n")) && has("Version 1"), "historical selection should show original body");
type("Batch NDJSON", batch("browser_delete", { type: "delete", source: "notes/fern.md" }));
click("Import batch");
waitFor(() => has("Batch browser_delete") && has("revision 3"), "delete should advance revision");
click("Open cited document");
waitFor(() => has("Version 1") && has(original.replace(/\r\n/g, "\n")), "citation should open exact version after deletion");
action({ action: "viewport", width: 1280, height: 960 });
action({ action: "screenshot", path: resolve(".verification/desktop.png"), fullPage: true });
action({ action: "viewport", width: 390, height: 844 });
action({ action: "screenshot", path: resolve(".verification/mobile.png"), fullPage: true });
assert.equal(snapshot.title, "Evidence Workbench");
const consoleResult = action({ action: "console" });
writeFileSync(resolve(".verification/browser-console.json"), JSON.stringify(consoleResult, null, 2));
writeFileSync(resolve(".verification/browser-summary.json"), JSON.stringify({ passed: true, assertions: ["batch replay", "invalid batch retained", "pagination 2+2+1", "stale cursor restart", "legacy import version 2", "historical selector", "immutable citation after deletion", "untrusted HTML remains text", "desktop and 390px screenshots"], finalTitle: snapshot.title }, null, 2));
console.log("Browser workflow passed; desktop/mobile screenshots and action log saved under .verification.");



