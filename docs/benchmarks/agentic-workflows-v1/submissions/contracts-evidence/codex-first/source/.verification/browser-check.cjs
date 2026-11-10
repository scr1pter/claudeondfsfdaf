const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const records = []
let snapshot
function action(input) {
  const result = spawnSync(process.env.NODE_EXE, [process.env.BROWSER_DRIVER_CLIENT, '--endpoint', process.env.BROWSER_DRIVER_ENDPOINT, JSON.stringify(input)], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  const response = JSON.parse(result.stdout)
  records.push({ input, response })
  fs.writeFileSync(path.join(__dirname, 'browser-log.json'), JSON.stringify(records, null, 2))
  assert(response.ok, JSON.stringify(response))
  if (response.snapshot) snapshot = response.snapshot
  return response
}
function control(name) {
  const found = snapshot.controls.find(item => item.name === name)
  assert(found, `Missing control ${name}: ${JSON.stringify(snapshot.controls)}`)
  return found.ref
}
function click(name) { action({ action: 'click', ref: control(name) }) }
function type(name, text) { action({ action: 'type', ref: control(name), text }) }
function select(name, value) { action({ action: 'select', ref: control(name), values: [value] }) }
function waitText(text) {
  for (let i = 0; i < 25; i++) {
    action({ action: 'observe' })
    if (snapshot.text.includes(text)) return
  }
  throw new Error(`Missing text ${text}: ${snapshot.text}`)
}
function mark(text) { console.log(`PASS ${text}`) }
const initial = [
  {type:'batch',batchId:'browser_01'},
  {type:'upsert',source:'notes/fern.md',title:'Fern <img src=x onerror=alert(1)>',body:'# Café 🧭 東京 é\nAMBER fern. <script>alert(1)</script> [link](https://example.invalid)'},
  {type:'upsert',source:'notes/two.md',title:'Amber two',body:'amber fern two'},
  {type:'upsert',source:'notes/three.md',title:'Amber three',body:'amber fern three'},
].map(row => JSON.stringify(row)).join('\n')
action({ action: 'open', url: 'http://127.0.0.1:' + process.env.PORT })
type('Batch NDJSON', initial)
click('Import batch'); waitText('replayed: true')
mark('batch receipt survives server restart')
select('Results per page', '2')
type('Search documents', 'amber')
click('Search'); waitText('Showing 2 results')
assert(!snapshot.controls.find(item => item.name === 'Next results').disabled)
mark('two results and continuation')
click('View citation 1'); waitText('startByte:')
assert(snapshot.text.includes('AMBER fern. <script>alert(1)</script>'))
click('Open cited document'); waitText('Document 1 · Version 1')
assert(snapshot.text.includes('# Café 🧭 東京 é'))
mark('exact original Unicode and inert HTML in citation and body')
const revision = [{ type:'batch',batchId:'browser_edit' },{ type:'upsert',source:'notes/fern.md',title:'Fern revised',body:'# Revision two\nCobalt stone 🧭' }].map(row => JSON.stringify(row)).join('\n')
type('Batch NDJSON', revision); click('Import batch'); waitText('Batch browser_edit')
click('Next results'); waitText('Collection changed')
assert(snapshot.text.includes('Showing 2 results'))
click('Restart search'); waitText('collection revision 2')
assert(snapshot.text.includes('Showing 2 results'))
assert(snapshot.controls.find(item => item.name === 'Next results').disabled)
mark('stale cursor keeps old page; restart uses current revision')
click('Open cited document'); waitText('Document 1 · Version 1')
select('Document version', '2'); waitText('# Revision two')
select('Document version', '1'); waitText('# Café 🧭 東京 é')
mark('history selector opens immutable revisions')
type('Batch NDJSON', '{invalid'); click('Import batch'); waitText('Invalid JSON')
assert(snapshot.controls.find(item => item.name === 'Batch NDJSON').value === '{invalid')
mark('failed batch preserves input and shows useful validation error')
const deletion = [{type:'batch',batchId:'browser_delete'},{type:'delete',source:'notes/fern.md'}].map(row => JSON.stringify(row)).join('\n')
type('Batch NDJSON', deletion); click('Import batch'); waitText('Batch browser_delete')
click('Open cited document'); waitText('Document 1 · Version 1')
mark('saved citation opens deleted document version')
type('Document source', 'notes/single.md'); type('Document title', 'Single local note'); type('Document text', 'single amber\nCafé 🧭')
click('Import document'); waitText('Imported document 4, version 1')
mark('legacy single document importer')
action({ action:'viewport', width:390, height:844 })
action({ action:'screenshot', path:path.join(__dirname, 'mobile.png') })
mark('390-pixel viewport screenshot')
action({ action:'viewport', width:1280, height:900 })
action({ action:'screenshot', path:path.join(__dirname, 'desktop.png') })
action({ action:'console' })
mark('desktop screenshot and console inspected')


