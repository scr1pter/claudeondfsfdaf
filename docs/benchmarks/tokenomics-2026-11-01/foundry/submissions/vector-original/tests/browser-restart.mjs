import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
const out=join(resolve(process.env.DATA_DIR||'.foundry-data'),'verification');
const report=JSON.parse(readFileSync(join(out,'browser-report.json'),'utf8'));
const base=`http://127.0.0.1:${process.env.PORT||3000}`;
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:['--no-sandbox','--disable-background-networking']});
try{
  const ctx=await browser.newContext({viewport:{width:1440,height:1100},storageState:join(out,'browser-session.json')});
  const page=await ctx.newPage();
  await page.goto(base+'/overview');await page.getByRole('region',{name:'Revenue',exact:true}).getByText('$159.50',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Workspace',{exact:true}).inputValue(),report.workspaceId);
  await page.getByRole('link',{name:'Customers',exact:true}).click();await page.getByRole('button',{name:'Open customer Avery Chen',exact:true}).click();
  const download=await ctx.request.get(base+`/api/w/${report.workspaceId}/attachments?entityType=customer&entityId=`+(await ctx.request.get(base+`/api/w/${report.workspaceId}/customers?q=Avery`).then(r=>r.json())).customers[0].id);
  const attachment=(await download.json()).attachments[0];assert.equal(attachment.fileName,'delivery-notes.txt');
  assert.equal(await ctx.request.get(base+`/api/w/${report.workspaceId}/attachments/${attachment.id}/download`).then(r=>r.text()),'Local delivery notes\nKeep upright.\n');
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('link',{name:'Projects',exact:true}).click();await page.getByRole('button',{name:'Open project The November collection',exact:true}).click();
  assert.equal(await page.getByRole('article').count(),3);
  await page.screenshot({path:join(out,'desktop-board.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('link',{name:'Overview',exact:true}).click();await page.screenshot({path:join(out,'desktop-overview.png'),fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(out,'mobile-overview.png'),fullPage:true,animations:'disabled'});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  console.log('Browser restart verification passed: existing session, selected workspace, revenue, board and exact attachment bytes. Refreshed desktop/mobile screenshots.');
}finally{await browser.close();}
