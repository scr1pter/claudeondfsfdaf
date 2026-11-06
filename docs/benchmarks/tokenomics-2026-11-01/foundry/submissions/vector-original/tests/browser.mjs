import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const base=`http://127.0.0.1:${process.env.PORT||3000}`;
const out=join(resolve(process.env.DATA_DIR||'.foundry-data'),'verification');mkdirSync(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:['--no-sandbox','--disable-background-networking','--disable-component-update']});
const context=await browser.newContext({viewport:{width:1440,height:1100},deviceScaleFactor:1,reducedMotion:'reduce'});
const page=await context.newPage();page.setDefaultTimeout(10000);
const errors=[];const external=[];let checks=0;
page.on('pageerror',e=>errors.push(e.message));
await context.route('**/*',route=>{if(new URL(route.request().url()).origin===base)return route.continue();external.push(route.request().url());return route.abort();});
const click=async name=>page.getByRole('button',{name,exact:true}).click();
const fill=async(label,value)=>page.getByLabel(label,{exact:true}).fill(value);
const nav=async name=>page.getByRole('link',{name,exact:true}).click();
const dialog=()=>page.getByRole('dialog');
const close=async()=>{await click('Close dialog');await dialog().waitFor({state:'hidden'});};
const saved=async()=>{await dialog().waitFor({state:'hidden'});checks++;};
const waitText=async text=>{await page.getByText(text,{exact:true}).first().waitFor();};
const http=async(path,method='GET',body)=>{const r=await context.request.fetch(base+'/api'+path,{method,data:body});assert(r.ok(),`${method} ${path}: ${r.status()} ${await r.text()}`);return r.status()===204?{}:r.json();};
try{
  await page.goto(base+'/signup');
  await fill('Name','Mara Ellis');await fill('Email',`mara-${Date.now()}@example.invalid`);await fill('Password','A-local-workspace-2026');await click('Create account');
  await page.getByRole('region',{name:'Revenue',exact:true}).waitFor();checks++;
  const me=await http('/auth/me');let wid=me.activeWorkspaceId;const W=()=>`/w/${wid}`;
  await click('New workspace');await fill('Workspace name','Oak & Field Studio');await click('Create workspace');await saved();await page.getByLabel('Workspace',{exact:true}).selectOption({label:'Oak & Field Studio'});
  wid=(await http('/auth/me')).activeWorkspaceId;
  await nav('Customers');await click('New customer');await fill('Name','Avery Chen');await fill('Email','avery.chen@example.invalid');await fill('Company','Common Ground');await fill('Notes','Prefers consolidated deliveries.\nSpring workspace refresh.');await click('Create customer');await saved();
  await click('New customer');await fill('Name','Noah Brooks');await fill('Email','noah.brooks@example.invalid');await fill('Company','Northline Works');await click('Create customer');await saved();
  await fill('Search customers','COMMON');await page.getByRole('button',{name:'Open customer Avery Chen',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Open customer Noah Brooks',exact:true}).count(),0);await fill('Search customers','');checks++;
  await click('Edit customer Avery Chen');await fill('Notes','Consolidate deliveries. Handle with care.');await click('Save changes');await saved();
  await click('Open customer Avery Chen');await dialog().getByText('Common Ground',{exact:true}).waitFor();
  await page.getByLabel('Attachment',{exact:true}).setInputFiles({name:'delivery-notes.txt',mimeType:'text/plain',buffer:Buffer.from('Local delivery notes\nKeep upright.\n')});
  await page.waitForTimeout(1200);await click('Upload attachment');await page.getByRole('link',{name:'Download attachment delivery-notes.txt',exact:true}).waitFor();
  const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Download attachment delivery-notes.txt'}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'delivery-notes.txt');checks++;
  await page.getByLabel('Attachment',{exact:true}).setInputFiles({name:'not-allowed.html',mimeType:'text/html',buffer:Buffer.from('<p>No</p>')});await click('Upload attachment');await page.getByRole('alert').filter({hasText:'Allowed files'}).waitFor();checks++;await close();
  await click('Import customers');await page.getByLabel('CSV file').setInputFiles({name:'customers.csv',mimeType:'text/csv',buffer:Buffer.from('name,email,company,notes\r\n"River, Lane",river.lane@example.invalid,Paper & Pine,"Met at the local studio\nFollow up in November"')});await click('Import CSV');await saved();
  const csvPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Export customers',exact:true}).click();assert.equal((await csvPromise).suggestedFilename(),'customers.csv');checks++;
  await nav('Inventory');
  for(const p of [{sku:'DSK-001',name:'Studio desk organizer',price:'48.75',stock:'24',description:'Solid oak. A calmer corner of the desk.'},{sku:'NTB-002',name:'Everyday notebook',price:'12.40',stock:'60',description:'A good place for the next big idea.'}]){
    await click('New product');await fill('SKU',p.sku);await fill('Product name',p.name);await fill('Description',p.description);await fill('Unit price (USD)',p.price);await click('Create product');await saved();
    await click('Adjust stock '+p.sku);await fill('Quantity change',p.stock);await fill('Reason','Initial studio stock');await click('Save stock change');await saved();
  }
  await click('Stock history DSK-001');await dialog().getByText('Initial studio stock',{exact:true}).waitFor();await close();checks++;
  await page.screenshot({path:join(out,'desktop-inventory.png'),fullPage:true});
  await nav('Orders');await click('New order');await page.getByLabel('Customer',{exact:true}).selectOption({label:'Avery Chen'});
  for(const [sku,quantity] of [['DSK-001','2'],['NTB-002','5']]){const option=await page.getByLabel('Product',{exact:true}).locator('option').filter({hasText:sku}).getAttribute('value');await page.getByLabel('Product',{exact:true}).selectOption(option);await fill('Quantity',quantity);await click('Add line');}
  await click('Remove line NTB-002');assert(await dialog().isVisible());assert.equal((await http(W()+'/orders')).orders.length,0);checks++;
  await page.getByLabel('Product',{exact:true}).selectOption({label:'NTB-002 — Everyday notebook'});await fill('Quantity','5');await click('Add line');
  await dialog().getByText('$159.50',{exact:true}).waitFor();await click('Create order');await saved();
  await click('Open order ORD-000001');await click('Fulfill order');await dialog().getByText('Fulfilled',{exact:true}).waitFor();await click('Create invoice');await dialog().getByText('Invoiced as INV-000001',{exact:false}).waitFor();await close();checks++;
  await nav('Invoices');await click('Open invoice INV-000001');await dialog().getByText('Avery Chen',{exact:true}).waitFor();await click('Mark sent');await dialog().getByText('Sent',{exact:true}).waitFor();await click('Mark paid');await dialog().getByText('Paid',{exact:true}).waitFor();await page.screenshot({path:join(out,'desktop-invoice.png'),fullPage:true});await close();checks++;
  await nav('Projects');await click('New project');await fill('Project name','The November collection');await fill('Description','Thoughtful essentials, ready for a new season.');await click('Create project');await saved();await click('Open project The November collection');
  for(const t of [{title:'Prepare the studio samples',description:'Select finishes and prepare the first collection for review.',status:'done',priority:'high'},{title:'Refine the collection story',description:'Bring the craft, materials and people into focus.',status:'in_progress',priority:'medium'},{title:'Plan the launch delivery',description:'Confirm packaging and the final handoff with Common Ground.',status:'todo',priority:'high'}]){
    await click('New task');await fill('Title',t.title);await fill('Description',t.description);await page.getByLabel('Status',{exact:true}).selectOption(t.status);await page.getByLabel('Priority',{exact:true}).selectOption(t.priority);await page.getByLabel('Assignee',{exact:true}).selectOption({label:'Mara Ellis'});await fill('Due date','2026-11-15');await click('Create task');await saved();
  }
  await fill('Search tasks','launch');await page.getByLabel('Status filter',{exact:true}).selectOption('todo');await page.getByLabel('Priority filter',{exact:true}).selectOption('high');assert.equal(await page.getByRole('article').count(),1);checks++;
  await fill('Search tasks','');await page.getByLabel('Status filter',{exact:true}).selectOption('');await page.getByLabel('Priority filter',{exact:true}).selectOption('');
  await click('Edit task Plan the launch delivery');await fill('Title','Plan the launch delivery');await click('Save changes');await saved();
  await click('Open task Refine the collection story');await fill('Comment','The material samples look excellent. <script>window.unsafe=true</script>');await click('Add comment');await dialog().getByText('The material samples look excellent. <script>window.unsafe=true</script>',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.unsafe),undefined);checks++;
  await page.getByLabel('Attachment',{exact:true}).setInputFiles({name:'collection-brief.md',mimeType:'text/markdown',buffer:Buffer.from('# Collection brief\nMade for everyday work.')});await click('Upload attachment');await page.getByRole('link',{name:'Download attachment collection-brief.md'}).waitFor();await close();
  await page.screenshot({path:join(out,'desktop-board.png'),fullPage:true});
  // A second browser context is a separate client with a durable, isolated session.
  const other=await browser.newContext();const inviteePage=await other.newPage();await inviteePage.goto(base+'/signup');
  const inviteeEmail=`elliot-${Date.now()}@example.invalid`;
  await inviteePage.getByLabel('Name',{exact:true}).fill('Elliot Reed');await inviteePage.getByLabel('Email',{exact:true}).fill(inviteeEmail);await inviteePage.getByLabel('Password',{exact:true}).fill('Another-local-password-2026');await inviteePage.getByRole('button',{name:'Create account',exact:true}).click();await inviteePage.getByRole('region',{name:'Revenue',exact:true}).waitFor();
  await nav('Team');await click('Invite member');await fill('Email',inviteeEmail);await page.getByLabel('Role',{exact:true}).selectOption('member');await click('Create invite');await page.getByLabel('Invite token',{exact:true}).waitFor();const invite=await page.getByLabel('Invite token',{exact:true}).inputValue();await close();
  await inviteePage.goto(base+'/join');await inviteePage.getByLabel('Invite token',{exact:true}).fill(invite);await inviteePage.getByRole('button',{name:'Join workspace',exact:true}).click();await inviteePage.getByRole('region',{name:'Revenue',exact:true}).waitFor();await page.getByRole('cell',{name:inviteeEmail,exact:true}).waitFor();checks++;
  await inviteePage.goto(base+'/inventory');await inviteePage.getByRole('columnheader',{name:'Product',exact:true}).waitFor();assert.equal(await inviteePage.getByRole('button',{name:'New product',exact:true}).count(),0);
  await page.getByLabel('Role for '+inviteeEmail,{exact:true}).selectOption('manager');await click('Save role for '+inviteeEmail);await inviteePage.getByRole('button',{name:'New product',exact:true}).waitFor({timeout:3000});checks++;
  await inviteePage.getByRole('button',{name:'New product',exact:true}).click();await inviteePage.getByRole('dialog',{name:'New product',exact:true}).waitFor();
  await page.getByLabel('Role for '+inviteeEmail,{exact:true}).selectOption('read_only');await click('Save role for '+inviteeEmail);await inviteePage.getByRole('button',{name:'New product',exact:true}).waitFor({state:'hidden',timeout:3000});await inviteePage.getByRole('alert').filter({hasText:'Your role has changed'}).waitFor({timeout:3000});assert.equal(await inviteePage.getByRole('button',{name:'Create product',exact:true}).count(),0);await inviteePage.getByRole('button',{name:'Close dialog',exact:true}).click();checks++;
  await nav('Customers');const liveStart=Date.now();await other.request.post(base+'/api'+W()+'/customers',{data:{name:'Not allowed'}}).then(r=>assert.equal(r.status(),403));
  await http(W()+'/customers','POST',{name:'Sage Morgan',email:'sage.morgan@example.invalid',company:'Atelier Nine'});
  await page.getByRole('button',{name:'Open customer Sage Morgan',exact:true}).waitFor({timeout:3000});assert(Date.now()-liveStart<3000);checks++;
  await nav('Overview');await page.getByRole('region',{name:'Revenue',exact:true}).getByText('$159.50',{exact:true}).waitFor();await page.screenshot({path:join(out,'desktop-overview.png'),fullPage:true});
  // Keyboard dialog focus, Escape and focus restoration.
  await nav('Customers');const trigger=page.getByRole('button',{name:'New customer',exact:true});await trigger.focus();await page.keyboard.press('Enter');await dialog().waitFor();assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Close dialog');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('name')),'name');await page.keyboard.press('Escape');await dialog().waitFor({state:'hidden'});assert(await trigger.evaluate(el=>el===document.activeElement));checks++;
  await page.getByLabel('Workspace',{exact:true}).selectOption(me.workspaces[0].id);await page.getByText('Your next great relationship starts here',{exact:true}).waitFor();await page.getByLabel('Workspace',{exact:true}).selectOption(wid);await page.getByRole('button',{name:'Open customer Avery Chen',exact:true}).waitFor();checks++;
  // Mobile navigation and layout on all major pages.
  await page.setViewportSize({width:390,height:844});
  for(const name of ['Overview','Customers','Inventory','Orders','Invoices','Projects','Activity','Team']){
    await click('Open navigation');await nav(name);await page.waitForTimeout(100);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Horizontal page overflow on ${name}`);checks++;
    if(name==='Overview')await page.screenshot({path:join(out,'mobile-overview.png'),fullPage:true});
  }
  await click('Open navigation');await nav('Projects');await click('Open project The November collection');await page.screenshot({path:join(out,'mobile-board.png'),fullPage:true});
  await click('New task');await page.screenshot({path:join(out,'mobile-task-form.png'),fullPage:true});assert(await dialog().evaluate(el=>el.scrollWidth<=el.clientWidth));await close();checks++;
  await click('Open navigation');await nav('Customers');await click('New customer');await fill('Name','Temporary customer');await click('Create customer');await saved();
  page.once('dialog',d=>d.accept());await click('Delete customer Temporary customer');await page.getByRole('button',{name:'Open customer Temporary customer',exact:true}).waitFor({state:'hidden'});checks++;
  await click('Open navigation');await click('Sign out');await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();await fill('Email',me.user.email);await fill('Password','A-local-workspace-2026');await click('Sign in');await page.getByRole('region',{name:'Revenue',exact:true}).waitFor();assert.equal(await page.getByLabel('Workspace',{exact:true}).inputValue(),wid);checks++;
  await click('Open navigation');await nav('Team');page.once('dialog',d=>d.accept());await click('Remove member '+inviteeEmail);
  await inviteePage.waitForFunction(id=>document.querySelector('select#workspace')?.value!==id,wid,{timeout:3000});await inviteePage.getByText('A home for everything you sell',{exact:true}).waitFor({timeout:3000});checks++;
  await context.storageState({path:join(out,'browser-session.json')});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  writeFileSync(join(out,'browser-report.json'),JSON.stringify({checks,pageErrors:errors,externalRequests:external,workspaceId:wid,userId:me.user.id,screenshots:['desktop-overview','desktop-inventory','desktop-invoice','desktop-board','mobile-overview','mobile-board','mobile-task-form']},null,2));
  console.log(`Browser verification passed: ${checks} workflow/layout checks, no page errors or external requests. Seven screenshots saved under DATA_DIR/verification.`);
  await other.close();
} catch(e){await page.screenshot({path:join(out,'browser-failure.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(0,1800));if(await dialog().count())console.error(await dialog().ariaSnapshot());console.error('Page errors:',errors);throw e;} finally {await browser.close();}
