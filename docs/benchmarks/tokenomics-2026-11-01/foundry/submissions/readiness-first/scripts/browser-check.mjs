import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
const base = `http://127.0.0.1:${process.env.PORT}`;
const runTag = Date.now().toString(36), ownerEmail = `alex.${runTag}@foundry.example.invalid`, memberEmail = `jamie.${runTag}@foundry.example.invalid`;
const artifacts = join(process.env.DATA_DIR, 'browser-verification');
mkdirSync(artifacts, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox'] });
const errors = [], external = [], checks = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true, reducedMotion: 'reduce' });
const page = await context.newPage();
page.on('pageerror', e => errors.push(e.message));
context.on('request', req => { if (!req.url().startsWith(base) && !req.url().startsWith('data:') && !req.url().startsWith('blob:')) external.push(req.url()); });
const exact = { exact: true };
const button = (p, name) => p.getByRole('button', { name, exact: true });
const dialog = name => page.getByRole('dialog', { name, exact: true });
const fill = async (p, values) => { for (const [k, v] of Object.entries(values)) await p.getByLabel(k, exact).fill(v); };
const nav = async name => { await page.getByRole('link', { name, exact: true }).click(); await page.getByRole('heading', { name: name === 'Overview' ? 'Workspace overview' : name, exact: true }).waitFor(); };
const shot = async name => page.screenshot({ path: join(artifacts, name + '.png'), fullPage: true, animations: 'disabled' });
const waitGone = async d => d.waitFor({ state: 'detached' });
const cookieHeader = async ctx => (await ctx.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
const api = async (ctx, path, method = 'GET', body) => {
  const r = await ctx.request.fetch(base + path, { method, data: body });
  const value = r.status() === 204 ? null : await r.json();
  return { status: r.status(), body: value, headers: r.headers() };
};
try {
  await page.goto(base + '/signup');
  await shot('01-signup-desktop');
  await fill(page, { Name: 'Alex Morgan', Email: ownerEmail, Password: 'Foundry-local-password-2026' });
  await button(page, 'Create account').click();
  await page.getByRole('heading', { name: 'Workspace overview' }).waitFor();
  await page.getByRole('region', { name: 'Revenue', exact: true }).waitFor();
  const me = (await api(context, '/api/auth/me')).body, wid = me.activeWorkspaceId;
  const W = p => `/api/w/${wid}${p}`;
  checks.push('Browser signup and authenticated overview');

  await nav('Customers');
  for (const c of [
    { Name: 'Aster Studio', Email: 'hello@aster.example.invalid', Company: 'Aster Studio', Notes: 'Brand and interior design partners. Deliver to the west studio.' },
    { Name: 'Northline Collective', Email: 'team@northline.example.invalid', Company: 'Northline Collective', Notes: 'A small creative team with big plans.' },
    { Name: 'Moss & Oak', Email: 'orders@moss.example.invalid', Company: 'Moss & Oak', Notes: 'Sustainable spaces and thoughtful objects.' },
    { Name: 'Ellis Workshop', Email: 'ellis@workshop.example.invalid', Company: 'Ellis Workshop', Notes: 'Custom workspace essentials.' },
  ]) {
    await button(page, 'New customer').click(); const d = dialog('New customer'); await fill(d, c); await button(d, 'Create customer').click(); await waitGone(d);
  }
  await page.getByLabel('Search customers', exact).fill('NORTHLINE');
  await page.getByRole('cell', { name: 'Northline Collective', exact: true }).first().waitFor();
  assert.equal(await button(page, 'Open customer Aster Studio').count(), 0);
  await page.getByLabel('Search customers', exact).fill('');
  await button(page, 'Edit customer Ellis Workshop').click();
  await dialog('Edit customer').getByLabel('Notes', exact).fill('Synthetic partner record. Updated through the browser.');
  await button(dialog('Edit customer'), 'Save changes').click(); await waitGone(dialog('Edit customer'));
  await button(page, 'Import customers').click();
  const csv = 'name,email,company,notes\r\n"Fern, Field",fern@field.example.invalid,Fern Field,"Quoted, note\nSecond line"\r\n';
  await dialog('Import customers').getByLabel('CSV file', exact).setInputFiles({ name: 'customers.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await button(dialog('Import customers'), 'Import CSV').click(); await waitGone(dialog('Import customers'));
  await button(page, 'Open customer Fern, Field').waitFor();
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('link', { name: 'Export customers', exact: true }).click(); const csvDownload = await downloadPromise;
  assert.match(readFileSync(await csvDownload.path(), 'utf8'), /"Quoted, note\nSecond line"/);
  await shot('02-customers-desktop');
  checks.push('Customer create/edit/search, quoted CSV import and downloaded export');

  await nav('Inventory');
  for (const p of [
    { SKU: 'DSK-001', 'Product name': 'Oak standing desk', Description: 'A solid foundation for focused work.', 'Unit price (USD)': '249.00', qty: '24' },
    { SKU: 'LMP-002', 'Product name': 'Arc desk lamp', Description: 'Warm light. Thoughtful details.', 'Unit price (USD)': '39.50', qty: '18' },
    { SKU: 'ORG-003', 'Product name': 'Desktop organizer', Description: 'A place for the little things.', 'Unit price (USD)': '24.99', qty: '4' },
  ]) {
    const { qty, ...fields } = p;
    await button(page, 'New product').click(); await fill(dialog('New product'), fields); await button(dialog('New product'), 'Create product').click(); await waitGone(dialog('New product'));
    await button(page, 'Adjust stock ' + p.SKU).click(); await fill(dialog('Adjust stock'), { 'Quantity change': qty, Reason: 'Opening warehouse delivery' }); await button(dialog('Adjust stock'), 'Save stock change').click(); await waitGone(dialog('Adjust stock'));
  }
  await button(page, 'Stock history DSK-001').click(); await dialog('Stock history').getByText('Opening warehouse delivery', exact).waitFor();
  await button(dialog('Stock history'), 'Close dialog').click();
  await shot('03-inventory-desktop');
  checks.push('Inventory create, exact dollar conversion, stock adjustment and actual history');

  await nav('Orders'); await button(page, 'New order').click();
  let d = dialog('New order');
  await d.getByLabel('Customer', exact).selectOption({ label: 'Aster Studio' });
  await d.getByLabel('Product', exact).selectOption({ label: 'DSK-001 — Oak standing desk' });
  await d.getByLabel('Quantity', exact).fill('2'); await button(d, 'Add line').click();
  await d.getByLabel('Product', exact).selectOption({ label: 'LMP-002 — Arc desk lamp' });
  await d.getByLabel('Quantity', exact).fill('3'); await button(d, 'Add line').click();
  await button(d, 'Create order').click(); await waitGone(d);
  await button(page, 'Open order ORD-000001').click(); d = dialog('Order details');
  await d.getByText('$616.50', exact).waitFor(); await button(d, 'Fulfill order').click(); await button(d, 'Create invoice').waitFor();
  await button(d, 'Create invoice').click(); await button(d, 'Create invoice').waitFor({ state: 'detached' }); await button(d, 'Close dialog').click();
  await nav('Invoices'); await button(page, 'Open invoice INV-000001').click(); d = dialog('Invoice details');
  await button(d, 'Mark sent').click(); await button(d, 'Mark paid').waitFor(); await button(d, 'Mark paid').click(); await d.getByText('Paid', exact).waitFor();
  await shot('04-invoice-desktop'); await button(d, 'Close dialog').click();
  checks.push('Multi-line order fulfillment, invoice creation and local paid transition at $616.50');

  await nav('Projects'); await button(page, 'New project').click();
  await fill(dialog('New project'), { 'Project name': 'Studio launch', Description: 'A thoughtful workspace, ready for opening day.' });
  await button(dialog('New project'), 'Create project').click(); await waitGone(dialog('New project'));
  await button(page, 'Open project Studio launch').click();
  for (const t of [
    { Title: 'Prepare the launch kits', Description: 'Coordinate desks, lighting and welcome notes for the studio team.', Status: 'In progress', Priority: 'High', 'Due date': '2026-11-12' },
    { Title: 'Review the floor plan', Description: 'Confirm the final furniture layout with the design team.', Status: 'Todo', Priority: 'Medium', 'Due date': '2026-11-09' },
    { Title: 'Approve material samples', Description: 'Oak finishes and warm tones approved.', Status: 'Done', Priority: 'Low', 'Due date': '2026-11-04' },
  ]) {
    await button(page, 'New task').click(); d = dialog('New task');
    const { Status, Priority, ...values } = t; await fill(d, values); await d.getByLabel('Status', exact).selectOption({ label: Status }); await d.getByLabel('Priority', exact).selectOption({ label: Priority }); await d.getByLabel('Assignee', exact).selectOption({ label: 'Alex Morgan' });
    await button(d, 'Create task').click(); await waitGone(d);
  }
  await page.getByLabel('Search tasks', exact).fill('launch'); await page.getByLabel('Priority filter', exact).selectOption('high');
  assert.equal(await page.getByRole('article').count(), 1);
  await page.getByLabel('Status filter', exact).selectOption('done'); assert.equal(await page.getByRole('article').count(), 0);
  await page.getByLabel('Search tasks', exact).fill(''); await page.getByLabel('Priority filter', exact).selectOption(''); await page.getByLabel('Status filter', exact).selectOption('');
  await button(page, 'Open task Prepare the launch kits').click(); d = dialog('Task details');
  await d.getByLabel('Comment', exact).fill('The first delivery is confirmed. <img src=x onerror=alert(1)>'); await button(d, 'Add comment').click(); await d.getByText('The first delivery is confirmed. <img src=x onerror=alert(1)>', exact).waitFor();
  assert.equal(await d.locator('img').count(), 0);
  const noteBytes = Buffer.from('Foundry launch notes\nSynthetic attachment.\n');
  await d.getByLabel('Attachment', exact).setInputFiles({ name: 'launch-notes.txt', mimeType: 'text/plain', buffer: noteBytes }); await button(d, 'Upload attachment').click();
  await d.getByRole('link', { name: 'Download attachment launch-notes.txt', exact: true }).waitFor();
  const dp = page.waitForEvent('download'); await d.getByRole('link', { name: 'Download attachment launch-notes.txt', exact: true }).click(); const download = await dp;
  assert.deepEqual(readFileSync(await download.path()), noteBytes);
  await d.getByLabel('Attachment', exact).setInputFiles({ name: 'unsafe.html', mimeType: 'text/html', buffer: Buffer.from('<h1>unsafe</h1>') }); await button(d, 'Upload attachment').click(); await d.getByRole('alert').filter({ hasText: 'Supported files' }).waitFor();
  await page.keyboard.press('Escape'); await waitGone(d);
  await button(page, 'Open task Prepare the launch kits').waitFor({ state: 'visible' });
  assert.equal(await button(page, 'Open task Prepare the launch kits').evaluate(el => el === document.activeElement), true);
  await shot('05-project-board-desktop');
  checks.push('Kanban create/filter, safe persisted comment, attachment upload/download, file rejection, Escape and focus return');

  await nav('Team'); await button(page, 'Invite member').click(); d = dialog('Invite member');
  await fill(d, { Email: memberEmail }); await d.getByLabel('Role', exact).selectOption('member'); await button(d, 'Create invite').click();
  await d.getByLabel('Invite token', exact).waitFor(); const inviteToken = await d.getByLabel('Invite token', exact).inputValue(); assert.ok(inviteToken.length >= 32); await button(d, 'Done').click();
  const secondContext = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const second = await secondContext.newPage(); second.on('pageerror', e => errors.push(e.message));
  await second.goto(base + '/signup'); await fill(second, { Name: 'Jamie Reed', Email: memberEmail, Password: 'Foundry-local-password-2026' }); await button(second, 'Create account').click(); await second.getByRole('heading', { name: 'Workspace overview' }).waitFor();
  await second.goto(base + '/join'); await second.getByLabel('Invite token', exact).fill(inviteToken); await button(second, 'Join workspace').click();
  await second.getByRole('heading', { name: 'Workspace overview' }).waitFor(); await second.getByLabel('Workspace', exact).selectOption(wid);
  await second.getByRole('link', { name: 'Customers', exact: true }).click(); await button(second, 'New customer').waitFor();
  await page.getByRole('cell', { name: memberEmail, exact: true }).waitFor({ timeout: 3000 });
  await nav('Customers');
  const start = Date.now();
  await button(second, 'New customer').click(); const sd = second.getByRole('dialog', { name: 'New customer', exact: true }); await fill(sd, { Name: 'Willow Design', Email: 'studio@willow.example.invalid', Company: 'Willow Design', Notes: 'Created by a second browser client.' }); await button(sd, 'Create customer').click();
  await button(page, 'Open customer Willow Design').waitFor({ timeout: 3000 }); const liveDelay = Date.now() - start; assert.ok(liveDelay < 3000, `live update took ${liveDelay} ms`);
  await nav('Team'); await page.getByLabel(`Role for ${memberEmail}`, exact).selectOption('read_only'); await button(page, `Save role for ${memberEmail}`).click();
  await button(second, 'New customer').waitFor({ state: 'detached', timeout: 3000 });
  assert.equal((await api(secondContext, W('/customers'), 'POST', { name: 'Forbidden read-only write' })).status, 403);
  checks.push(`Local invite acceptance, multi-client data refresh (${liveDelay}ms), live role downgrade and server denial`);
  await secondContext.close();

  await button(page, 'New workspace').click(); await fill(dialog('New workspace'), { 'Workspace name': 'Field office' }); await button(dialog('New workspace'), 'Create workspace').click(); await waitGone(dialog('New workspace'));
  await page.getByRole('region', { name: 'Customers', exact: true }).getByText('0', exact).waitFor();
  await page.getByLabel('Workspace', exact).selectOption(wid); await page.getByRole('region', { name: 'Revenue', exact: true }).getByText('$616.50', exact).waitFor();
  await nav('Overview'); await shot('06-overview-desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await shot('07-overview-mobile');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await button(page, 'Open navigation').click(); await shot('08-navigation-mobile'); await page.getByRole('link', { name: 'Customers', exact: true }).click(); await button(page, 'New customer').click();
  d = dialog('New customer'); await d.getByLabel('Name', exact).fill('Keyboard check'); await page.keyboard.press('Tab'); assert.equal(await d.getByLabel('Email', exact).evaluate(el => el === document.activeElement), true); await page.keyboard.press('Escape'); await waitGone(d);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await shot('09-customers-mobile');
  checks.push('Workspace creation/switch isolation, desktop 1440px, mobile 390px, keyboard Tab, no page overflow');
  await page.setViewportSize({ width: 1440, height: 1050 }); await nav('Overview');
  const cookies = await cookieHeader(context);
  const state = { base, wid, cookies, ownerId: me.user.id, checks, liveDelay, artifacts };
  writeFileSync(join(artifacts, 'state.json'), JSON.stringify(state, null, 2));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  console.log(JSON.stringify({ ok: true, checks, pageErrors: errors.length, externalRequests: external.length, screenshots: 9, artifacts }, null, 2));
} catch (e) {
  await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(JSON.stringify({ ok: false, message: e.message, pageErrors: errors, externalRequests: external, checks, currentURL: page.url(), screenshot: join(artifacts, 'failure.png') }, null, 2));
  process.exitCode = 1;
} finally { await browser.close(); }
