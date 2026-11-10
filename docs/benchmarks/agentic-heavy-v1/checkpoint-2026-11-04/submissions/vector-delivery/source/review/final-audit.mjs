// Independent review of the concrete, bounded QA and judge evidence set.
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const qa = join(process.env.DATA_DIR, 'qa-evidence');
const judge = join(process.env.DATA_DIR, 'review-evidence');
const checks = [];
function check(value, label) { if (!value) throw new Error(label); checks.push(label); }
function data(root, name) { return JSON.parse(readFileSync(join(root, name + '.json'), 'utf8')); }
function snapshot(root, name) { const record = data(root, name); check(record.ok === true, `${name}: action succeeded`); return record.snapshot; }
function focus(root, name, expected) { const s = snapshot(root, name); check(s.controls.find(c => c.ref === s.focus.focusedRef)?.name === expected, `${name}: focus ${expected}`); return s; }
const r1 = data(qa, 'final-revocation-results');
check(r1.passed && r1.assertions === 72 && r1.results.length === 5, 'QA independent revocation report complete');
for (const row of r1.results) {
  check(row.status === row.expected, `${row.name}: correct denial`);
  check(!row.committed, `${row.name}: no commit`);
  check(row.revisionDelta === 0 && row.activityDelta === 0, `${row.name}: no revision/activity`);
  check(row.newBlobs.length === 0, `${row.name}: no orphan blob`);
}
const ownR1 = data(judge, 'revocation-results');
check(ownR1.passed && ownR1.results.length === 5 && ownR1.results.every(r => r.passed), 'Judge current independent revocation 5/5');
for (const [artifact, name] of [['final-r2-sku-exact','SKU'],['final-r2-quantity-exact','Quantity change'],['final-r2-invite-token-exact','Invite token'],['final-r2-signup-labels','Password'],['final-r2-customer-loaded','Attachment']]) {
  const s = snapshot(qa, artifact);
  check(s.controls.filter(c => c.name === name).length === 1, `QA exact named field ${name}`);
}
snapshot(qa, 'final-r2-overview-exact');
snapshot(judge, 'final-overview-exact');
focus(judge, 'final-sku-exact', 'SKU');
for (const root of [qa, judge]) {
  for (const [kind, name] of [['customer','UI Avery revised'],['order','ORD-000001'],['invoice','INV-000001'],['task','Prepare launch kit']]) {
    const artifact = root === qa ? `final-r3-${kind}-exact` : `final-${kind}-exact`;
    const s = snapshot(root, artifact);
    check(s.controls.filter(c => c.role === 'button' && c.name === `Open ${kind} ${name}`).length === 1, `${artifact}: unique canonical Open`);
  }
}
snapshot(judge, 'final-project-exact');
snapshot(qa, 'final-r3-project-exact');
for (const [kind, name] of [['customer','UI Avery revised'],['order','ORD-000001'],['invoice','INV-000001'],['task','Prepare launch kit']]) {
  const s = snapshot(qa, `final-readonly-${kind}`);
  check(s.controls.filter(c => c.role === 'button' && c.name === `Open ${kind} ${name}`).length === 1, `QA read_only ${kind}: unique canonical Open`);
  check(!s.controls.some(c => /^(New customer|New order|New task|Edit customer |Delete customer |Edit task |Delete task |Fulfill order|Create invoice|Mark sent|Mark paid|Void invoice|Add comment|Upload attachment)/.test(c.name)), `QA read_only ${kind}: forbidden actions absent`);
}
snapshot(qa, 'final-readonly-project');
for (const [root, artifact] of [[qa,'final-r4-settled'],[judge,'final-focus-settled']]) {
  const s = focus(root, artifact, 'Search tasks');
  check(!s.controls.some(c => c.name === 'Edit task Prepare launch kit'), `${artifact}: edited task left retained filter`);
}
for (const [root, artifact] of [[qa,'final-r4-tab-continuation'],[judge,'final-focus-tab']]) focus(root, artifact, 'Status filter');
for (const [root, nested, outer] of [[qa,'final-r4-nested-escape','final-r4-outer-escape'],[judge,'final-nested-escape','final-customer-escape']]) {
  focus(root, nested, 'Delete attachment qa-ui-note.txt');
  focus(root, outer, 'Open customer UI Avery revised');
}
for (const [name, expected] of [['api-results',251],['edge-results',73],['final-browser-assertions',44]]) {
  const report = data(qa, name);
  check(report.passed && report.assertions === expected, `QA ${name}: ${expected} passing assertions`);
}
const output = {passed: true, at: new Date().toISOString(), assertions: checks.length, checks};
writeFileSync(join(judge, 'final-evidence-audit.json'), JSON.stringify(output, null, 2));
console.log(`PASS ${checks.length} judge final evidence assertions`);
