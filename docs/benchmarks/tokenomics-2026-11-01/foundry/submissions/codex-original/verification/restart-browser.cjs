const {chromium}=require(process.env.PLAYWRIGHT_MODULE);
const assert=require('node:assert/strict');
const fs=require('node:fs'); const path=require('node:path');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});try{
 const base=`http://127.0.0.1:${process.env.PORT}`;
 const state=JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR,'browser-verification.json'),'utf8'));
 const context=await browser.newContext({storageState:path.join(process.env.DATA_DIR,'browser-storage.json'),viewport:{width:1440,height:1060},reducedMotion:'reduce'});const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/overview');await page.getByRole('region',{name:'Revenue',exact:true}).getByText('$237.00',{exact:true}).waitFor();assert.equal(await page.getByLabel('Workspace',{exact:true}).inputValue(),state.w);
 await page.getByRole('status').waitFor({state:'hidden'});await page.screenshot({path:'verification/artifacts/overview-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'verification/artifacts/overview-mobile.png',fullPage:true});
 await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('button',{name:'Customers',exact:true}).click();await page.getByRole('button',{name:'Open customer Ada Lane',exact:true}).click();await page.getByRole('dialog',{name:'Customer details',exact:true}).waitFor();await page.screenshot({path:'verification/artifacts/customer-mobile.png',fullPage:true});await page.keyboard.press('Escape');
 await page.goto(base+'/orders');await page.getByRole('button',{name:'Open order ORD-000001',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Open order ORD-000002',exact:true}).count(),1);
 await page.setViewportSize({width:1440,height:1060});await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();await page.getByLabel('Email',{exact:true}).fill(state.email);await page.getByLabel('Password',{exact:true}).fill('synthetic-pass-12345');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('region',{name:'Revenue',exact:true}).getByText('$237.00',{exact:true}).waitFor();assert.deepEqual(errors,[]);
 await context.storageState({path:path.join(process.env.DATA_DIR,'browser-storage.json')});
 console.log('Restart browser verification passed: persisted session and workspace, direct routes, records and revenue, sign out/sign in, final desktop/mobile captures.');
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1});
