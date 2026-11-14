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
action({ action:'observe' })
click('Open cited document'); waitText('Document 1 · Version 1')
select('Document version', '2'); waitText('# Revision two')
select('Document version', '1'); waitText('# Café 🧭 東京 é')
mark('deleted document and both versions survive restart')
action({ action:'open', url:'http://127.0.0.1:' + process.env.PORT })
const receipt = [{type:'batch',batchId:'browser_delete'},{type:'delete',source:'notes/fern.md'}].map(row => JSON.stringify(row)).join('\n')
type('Batch NDJSON', receipt); click('Import batch'); waitText('revision 3 · replayed: true')
mark('original receipt revision survives later writes and restart')
select('Results per page', '2'); type('Search documents','amber'); click('Search'); waitText('Showing 2 results · collection revision 4')
assert(!snapshot.controls.some(item => item.name === 'Open document 1'))
click('Next results'); waitText('Showing 3 results')
assert(snapshot.controls.find(item => item.name === 'Next results').disabled)
mark('pagination appends remaining hit without duplicates and ends')
click('Open document 4'); waitText('single amber\nCafé 🧭')
assert(control('Document text'))
mark('single import persists and textarea keeps its exact accessible name')
action({action:'screenshot'})
action({action:'console'})
fs.writeFileSync(path.join(__dirname,'restart-browser-log.json'), JSON.stringify(records,null,2))
