const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const origin = `http://127.0.0.1:${process.env.PORT || 8088}`;
const artifacts = process.env.WORKFLOW_BROWSER_OUTPUT || join(tmpdir(), 'vector', 'workflow-keyboard');

async function request(path, body) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(data)}`);
  return data;
}

(async () => {
  mkdirSync(artifacts, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
    args: ['--disable-background-networking', '--disable-sync'],
  });
  const failures = [];
  const checks = [];
  const created = [];
  try {
    for (const width of [390, 1365]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      page.on('pageerror', error => failures.push(`${width}px page error: ${error}`));
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(origin);
      const name = page.getByLabel('Workflow name', { exact: true });
      const concurrency = page.getByLabel('Concurrency', { exact: true });
      const definition = page.getByLabel('Workflow definition', { exact: true });
      const submit = page.getByRole('button', { name: 'Create workflow', exact: true });
      const focused = locator => locator.evaluate(element => element === document.activeElement);
      const check = (condition, description) => {
        (condition ? checks : failures).push(`${width}px ${description}`);
      };

      await page.keyboard.press('Tab');
      check(await focused(name), 'Tab enters Workflow name');
      await name.fill(`Keyboard submit ${width} ${crypto.randomUUID()}`);
      await page.keyboard.press('Tab');
      check(await focused(concurrency), 'Tab reaches Concurrency');
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowDown');
      check(await concurrency.inputValue() === '2', 'native select responds to keyboard');
      await page.keyboard.press('Tab');
      check(await focused(definition), 'Tab reaches Workflow definition');
      await definition.fill('[{"key":"run","name":"Keyboard run","kind":"succeed"}]');
      const workflowName = await name.inputValue();
      await page.keyboard.press('Tab');
      check(await focused(submit), 'Tab reaches Create workflow');
      await page.keyboard.press('Enter');
      const submitted = page.getByRole('article', { name: 'Workflow ' + workflowName, exact: true });
      await submitted.getByTestId('workflow-status').filter({ hasText: 'succeeded' }).waitFor({ timeout: 3000 });
      check(await focused(submit), 'keyboard submission retains a focused dashboard control');
      await page.keyboard.press('Shift+Tab');
      check(await focused(definition), 'reverse tab order remains usable after submission');

      await definition.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const disclosure = page.locator('summary');
      check(await focused(disclosure), 'Tab reaches the legacy-job disclosure');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      const legacyName = page.getByLabel('Job name', { exact: true });
      check(await focused(legacyName), 'Tab reaches legacy Job name');
      const legacyTitle = `Keyboard legacy ${width} ${crypto.randomUUID()}`;
      await legacyName.fill(legacyTitle);
      await page.keyboard.press('Tab');
      check(await focused(page.getByLabel('Job behavior', { exact: true })), 'Tab reaches legacy Job behavior');
      await page.keyboard.press('Tab');
      const legacySubmit = page.getByRole('button', { name: 'Create job', exact: true });
      check(await focused(legacySubmit), 'Tab reaches Create job');
      await page.keyboard.press('Enter');
      await page.getByRole('article', { name: 'Legacy job ' + legacyTitle, exact: true }).filter({ hasText: 'succeeded' }).waitFor({ timeout: 3000 });
      check(await focused(legacySubmit), 'legacy keyboard submission retains focus');

      for (const external of [true, false]) {
        const workflowName = `Keyboard cancel ${external ? 'external' : 'local'} ${width} ${crypto.randomUUID()}`;
        const { workflow } = await request('/api/workflows', {
          name: workflowName, concurrency: 1,
          jobs: [{ key: 'wait', name: 'Wait', kind: 'block' }],
        });
        created.push(workflow.id);
        const card = page.getByRole('article', { name: 'Workflow ' + workflowName, exact: true });
        await card.getByTestId('workflow-status').filter({ hasText: 'running' }).waitFor({ timeout: 3000 });
        const view = card.getByRole('button', { name: 'View events ' + workflowName, exact: true });
        const cancel = card.getByRole('button', { name: 'Cancel workflow ' + workflowName, exact: true });
        await view.focus();
        await page.keyboard.press('Tab');
        check(await focused(cancel), 'Tab reaches Cancel workflow');
        if (external) await request(`/api/workflows/${workflow.id}/cancel`, {});
        else await page.keyboard.press('Enter');
        await card.getByTestId('workflow-status').filter({ hasText: 'cancelled' }).waitFor({ timeout: 3000 });
        check(await focused(view), `${external ? 'external' : 'keyboard'} cancellation returns focus to View events`);
        // Keep checking event activation even if the focus-restoration regression fails.
        if (!await focused(view)) await view.focus();
        await page.keyboard.press('Enter');
        const events = card.getByRole('region', { name: 'Events for ' + workflowName, exact: true });
        await events.filter({ hasText: 'workflow.cancelled' }).waitFor({ timeout: 3000 });
        check(await focused(view), 'keyboard event activation retains focus');
        await page.waitForTimeout(1500);
        check(await focused(view), 'polling retains event-button focus');
      }
      check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
      await page.screenshot({ path: join(artifacts, `keyboard-${width}.png`), fullPage: true });
      await page.close();
    }
  } finally {
    try {
      for (const id of created) {
        const { workflow } = await request(`/api/workflows/${id}`);
        if (['queued', 'running'].includes(workflow.status)) await request(`/api/workflows/${id}/cancel`, {});
      }
    } finally { await browser.close(); }
  }
  const result = { ok: failures.length === 0, checks, failures };
  writeFileSync(join(artifacts, 'keyboard-results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert.equal(failures.length, 0, 'Keyboard regressions found');
})().catch(error => { console.error(error); process.exitCode = 1; });
