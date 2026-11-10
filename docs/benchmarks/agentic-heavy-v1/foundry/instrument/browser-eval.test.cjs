"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { csvRows, browserEvaluate, navigateAction, dismissDialogs, navigateWithDialogs, openInvoiceDetails, nativeSelect, choose, waitForWorkspaceSelection, waitForVisibleActivity } = require("./browser-eval.cjs");
const { buildOptions } = require("./build-output.cjs");

test("Vite output probe respects delivered CLI output/config/root overrides", () => {
  assert.deepEqual(buildOptions("vite build"), {});
  assert.deepEqual(buildOptions('tsc --noEmit && vite build --outDir="public output" --mode production'), { build: { outDir: "public output" }, mode: "production" });
  assert.deepEqual(buildOptions("vite build frontend --outDir ../public --config config/vite.ts"), { root: path.resolve("frontend"), build: { outDir: "../public" }, configFile: path.resolve("config/vite.ts") });
});

test("unresolved or dynamic build output is not silently treated as dist", () => {
  for (const script of ["bun scripts/build.ts", "vite build --outDir", 'vite build --outDir "$OUTPUT"', "vite build --outDir %OUTPUT%", "vite build --unsupported value web", "vite build web another-root"])
    assert.throws(() => buildOptions(script), /Vite/);
});

test("Vite positional input root is preserved before or after recognized options", () => {
  const expected = { root: path.resolve("web"), mode: "production" };
  assert.deepEqual(buildOptions("vite build web --mode production"), expected);
  assert.deepEqual(buildOptions("vite build --mode production web"), expected);
  assert.deepEqual(buildOptions("vite build --outDir ../public --mode production web"), { ...expected, build: { outDir: "../public" } });
});

function selectScope(label, select, { labelled = true, role = "combobox", visible = true, native = true, count = 1 } = {}) {
  const nodes = Array.from({ length: count }, () => ({}));
  function locator(matches) {
    const only = () => { assert.equal(matches.length, 1, "Expected exactly one visible native select"); return select; };
    return {
      matches,
      or(other) { return locator([...new Set([...matches, ...other.matches])]); },
      and(other) { return locator(matches.filter(item => other.matches.includes(item))); },
      filter(options) { assert.deepEqual(options, { visible: true }); return locator(visible ? matches : []); },
      waitFor: options => only().waitFor(options),
      locator: selector => only().locator(selector),
      selectOption: value => only().selectOption(value),
      inputValue: options => only().inputValue(options),
    };
  }
  return {
    locator(selector) { assert.equal(selector, "select:not([inert]):not([inert] select)"); return locator(native ? nodes : []); },
    getByRole(name, options) { if (options) assert.deepEqual(options, { name: label, exact: true }); return locator(name === role ? nodes : []); },
    getByLabel(name, options) { assert.equal(name, label); assert.deepEqual(options, { exact: true }); return locator(labelled ? nodes : []); },
  };
}

function selectFixture(snapshots, scopeOptions) {
  let reads = 0;
  const selected = [], waits = [];
  const select = {
      async waitFor(options) { waits.push(options); },
      locator(selector) {
        assert.equal(selector, "option");
        return { async evaluateAll() { return snapshots[Math.min(reads++, snapshots.length - 1)]; } };
      },
      async selectOption(value) { selected.push(value); },
  };
  const scope = selectScope("Customer", select, scopeOptions);
  return { scope, selected, waits, reads: () => reads };
}

test("select helper waits for asynchronously populated matching options", async () => {
  const fixture = selectFixture([[], [{ label: "Loading", value: "" }], [{ label: "Northstar", value: "customer-1" }]]);
  await choose(fixture.scope, "Customer", "Northstar", false, { timeout: 100, interval: 1 });
  assert.deepEqual(fixture.selected, ["customer-1"]); assert.equal(fixture.reads(), 3);
  assert.deepEqual(fixture.waits, [{ state: "visible" }]);
});

test("select helper rejects absent or ambiguous options without selecting an arbitrary row", async () => {
  for (const options of [[], [{ label: "Northstar", value: "1" }, { label: "Northstar", value: "2" }]]) {
    const fixture = selectFixture([options]);
    await assert.rejects(choose(fixture.scope, "Customer", "Northstar", false, { timeout: 2, interval: 1 }), /expected one option/);
    assert.deepEqual(fixture.selected, []);
  }
});

test("select helper preserves contains matching only when it is unique", async () => {
  const fixture = selectFixture([[{ label: "Northstar Research", value: "customer-2" }]]);
  await choose(fixture.scope, "Customer", "Northstar", true);
  assert.deepEqual(fixture.selected, ["customer-2"]);
});

test("native select resolution accepts exact role names when exact label association is absent", async () => {
  for (const role of ["combobox", "listbox"]) {
    const fixture = selectFixture([[{ label: "Northstar", value: "customer-1" }]], { labelled: false, role });
    await choose(fixture.scope, "Customer", "Northstar");
    assert.deepEqual(fixture.selected, ["customer-1"]);
  }
});

test("native select resolution rejects hidden, nonselect and ambiguous controls", () => {
  for (const options of [{ visible: false }, { native: false }, { count: 2 }]) {
    const fixture = selectFixture([[{ label: "Northstar", value: "customer-1" }]], options);
    assert.throws(() => nativeSelect(fixture.scope, "Customer").locator("option"), /exactly one visible native select/);
    assert.deepEqual(fixture.selected, []);
  }
});

function navigationFixture(visible, box = { x: 10, y: 80, width: 100, height: 30 }, { name = "Inventory", role = "link", toggleName = "Open navigation" } = {}) {
  const clicks = [];
  const state = { visible, box };
  const controls = [{ role, name, navigation: true }, { role: "button", name: toggleName, navigation: false }];
  function locator(nodes) {
    return {
      nodes,
      or(other) { return locator([...new Set([...nodes, ...other.nodes])]); },
      first() { return locator(nodes.slice(0, 1)); },
      async isVisible() { return !!nodes[0] && (!nodes[0].navigation || state.visible); },
      async boundingBox() { return !nodes[0] ? null : nodes[0].navigation ? state.box : { x: 10, y: 10, width: 40, height: 40 }; },
      async click() {
        const control = nodes[0];
        assert.ok(control, "No matching semantic navigation control");
        if (!control.navigation) { state.visible = true; state.box = { x: 10, y: 80, width: 100, height: 30 }; }
        else assert.equal(state.visible, true, "Navigation target was clicked before opening the menu");
        clicks.push(control.name);
      },
    };
  }
  const target = {
    viewportSize: () => ({ width: 390, height: 844 }),
    getByRole(role, { name, exact = false }) {
      return locator(controls.filter(control => control.role === role && (name instanceof RegExp ? name.test(control.name) : exact ? control.name === name : control.name.includes(name))));
    },
  };
  return { target, clicks };
}

test("inline navigation is selected without opening a mobile menu", async () => {
  const fixture = navigationFixture(true);
  await navigateAction(fixture.target, "Inventory");
  assert.deepEqual(fixture.clicks, ["Inventory"]);
});

test("collapsed mobile navigation opens the specified accessible toggle first", async () => {
  const fixture = navigationFixture(false, undefined, { name: "Customers" });
  await navigateAction(fixture.target, "Customers");
  assert.deepEqual(fixture.clicks, ["Open navigation", "Customers"]);
});

test("offcanvas navigation outside the viewport opens the mobile toggle", async () => {
  const fixture = navigationFixture(true, { x: -250, y: 80, width: 200, height: 30 }, { name: "Orders" });
  await navigateAction(fixture.target, "Orders");
  assert.deepEqual(fixture.clicks, ["Open navigation", "Orders"]);
});

test("navigation accepts only an exact label with an optional numeric badge for links and buttons", async () => {
  for (const role of ["link", "button"]) for (const name of ["Orders", "Orders 1", "Orders12"]) {
    const fixture = navigationFixture(true, undefined, { name, role });
    await navigateAction(fixture.target, "Orders");
    assert.deepEqual(fixture.clicks, [name]);
  }
});

test("navigation does not broaden near labels, non-controls, or the exact mobile toggle", async () => {
  for (const name of ["Preorders", "New orders", "Orders archive", "Orders 1 archive", "OrdersX", "Orders -1", "Orders 1.5"]) {
    const fixture = navigationFixture(true, undefined, { name });
    await assert.rejects(navigateAction(fixture.target, "Orders"), /No matching semantic/);
    assert.ok(!fixture.clicks.includes(name));
  }
  await assert.rejects(navigateAction(navigationFixture(true, undefined, { name: "Orders1", role: "text" }).target, "Orders"), /No matching semantic/);
  await assert.rejects(navigateAction(navigationFixture(false, undefined, { name: "Orders1", toggleName: "Open navigation1" }).target, "Orders"), /before opening the menu/);
});

test("navigation escapes regex metacharacters in the public label", async () => {
  const fixture = navigationFixture(true, undefined, { name: "Orders (west)+ 2" });
  await navigateAction(fixture.target, "Orders (west)+");
  assert.deepEqual(fixture.clicks, ["Orders (west)+ 2"]);
  await assert.rejects(navigateAction(navigationFixture(true, undefined, { name: "Orders west" }).target, "Orders (west)+"), /No matching semantic/);
});

test("workspace completion waits for both exact backend and selected UI ids", async () => {
  let reads = 0;
  const target = selectScope("Workspace", { inputValue: async () => reads >= 3 ? "original" : "other" });
  await waitForWorkspaceSelection(target, "original", async remaining => {
    assert.ok(remaining > 0 && remaining <= 3000); reads++;
    return { activeWorkspaceId: reads >= 2 ? "original" : "other" };
  }, { timeout: 100, interval: 1 });
  assert.ok(reads >= 3);
});

test("workspace completion rejects wrong backend or stale UI without changing selection", async () => {
  for (const [backend, selected] of [["other", "original"], ["original", "other"], ["other", "other"]]) {
    const target = selectScope("Workspace", { inputValue: async () => selected });
    await assert.rejects(waitForWorkspaceSelection(target, "original", async () => ({ activeWorkspaceId: backend }), { timeout: 3, interval: 1 }), /did not persist and display/);
  }
});

test("visible activity requires the literal actor and human-readable events", async () => {
  let reads = 0;
  const delayed = { innerText: async () => ++reads === 1 ? "Loading" : "Alex Foundry created customer", getByText: () => ({ count: async () => 1, nth: () => ({ isVisible: async () => reads >= 2 }) }) };
  await waitForVisibleActivity(delayed, "Alex Foundry", { timeout: 100, interval: 1 });
  for (const text of ["Created customer", "Alex Foundry", "AlexXFoundry created customer"]) {
    const content = { innerText: async () => text, getByText: name => ({ count: async () => 1, nth: () => ({ isVisible: async () => text.includes(name) }) }) };
    await assert.rejects(waitForVisibleActivity(content, "Alex Foundry", { timeout: 3, interval: 1 }), /lacks/);
  }
});

function invoiceFixture({ unclosable = false, missing = false } = {}) {
  const events = [], timeouts = [], dialogs = [{ kind: "order", closed: false }];
  let navigations = 0, opened = false;
  const top = () => dialogs.filter(item => !item.closed).at(-1);
  const view = { async waitFor() { assert.ok(opened); } };
  const target = {
    viewportSize: () => ({ width: 1440, height: 960 }),
    keyboard: { async press(key) { assert.equal(key, "Escape"); const item = top(); events.push("Escape " + item.kind); if (!unclosable) item.closed = true; } },
    getByRole(role, options) {
      if (role === "dialog" && !options) return { count: async () => top() ? 1 : 0, last: () => ({ isVisible: async () => !!top(), elementHandle: async ({ timeout }) => { const item = top(); timeouts.push(timeout); return { async waitForElementState(state) { assert.equal(state, "hidden"); if (!item.closed) throw Object.assign(new Error("Unclosable dialog"), { name: "TimeoutError" }); }, async dispose() {} }; } }) };
      if (role === "dialog") { assert.deepEqual(options, { name: "Invoice details", exact: true }); return view; }
      const control = { or() { return this; }, first() { return this; }, isVisible: async () => true, boundingBox: async () => ({ x: 10, y: 20, width: 80, height: 30 }), async click({ timeout }) {
        timeouts.push(timeout);
        if (options.name instanceof RegExp) { assert.ok(options.name.test("Invoices")); events.push("nav " + ++navigations); if (navigations === 1) { dialogs.push({ kind: "invoice", closed: false }); throw Object.assign(new Error("Timeout exceeded: modal intercepted click"), { name: "TimeoutError" }); } }
        else { assert.equal(options.name, "Open invoice INV-1"); if (missing) { await new Promise(resolve => setTimeout(resolve, Math.min(3, timeout))); throw Object.assign(new Error("Timeout exceeded: target missing"), { name: "TimeoutError" }); } events.push(options.name); opened = true; }
      } }; return control;
    },
  };
  return { target, events, timeouts, view };
}

test("invoice opening closes delayed modal and uses exact opener without requiring number markup", async () => {
  const fixture = invoiceFixture(); assert.equal(await openInvoiceDetails(fixture.target, "INV-1", { timeout: 100, attemptTimeout: 20 }), fixture.view);
  assert.deepEqual(fixture.events, ["Escape order", "nav 1", "Escape invoice", "nav 2", "Open invoice INV-1"]); assert.ok(fixture.timeouts.every(value => value > 0 && value <= 100));
});

test("invoice opening does not force-close an unclosable dialog", async () => {
  const fixture = invoiceFixture({ unclosable: true }); await assert.rejects(openInvoiceDetails(fixture.target, "INV-1", { timeout: 30 }), /deadline exceeded/); assert.ok(fixture.events.length > 0 && fixture.events.every(event => event === "Escape order"));
});

function dismissalFixture({ busyEscapes = 0, reused = false, layers = 1, fatal = false } = {}) {
  const dialogs = Array.from({ length: layers }, (_, id) => ({ id, closed: false }));
  const events = [], budgets = []; let escapes = 0;
  const current = () => dialogs.filter(item => !item.closed).at(-1);
  const target = {
    keyboard: { async press(key) { assert.equal(key, "Escape"); escapes++; const item = current(); events.push("Escape " + item.id); if (escapes <= busyEscapes) return; if (reused && escapes === busyEscapes + 1) events.push("same node changed accessible name"); else item.closed = true; } },
    getByRole(role) {
      assert.equal(role, "dialog");
      return { count: async () => current() ? 1 : 0, last: () => ({ isVisible: async () => !!current(), async elementHandle({ timeout }) {
        budgets.push(timeout); if (fatal) throw new Error("browser closed"); const item = current(); events.push("bound " + item.id);
        return { async waitForElementState(state, { timeout }) { budgets.push(timeout); assert.equal(state, "hidden"); if (!item.closed) { await new Promise(resolve => setTimeout(resolve, 1)); throw Object.assign(new Error("Timeout exceeded: still visible"), { name: "TimeoutError" }); } }, async dispose() { events.push("dispose " + item.id); } };
      } }) };
    },
  };
  return { target, events, budgets, dialogs };
}

test("normal modal dismissal retries temporarily ignored Escape within one deadline", async () => {
  const fixture = dismissalFixture({ busyEscapes: 2 }); await dismissDialogs(fixture.target, { timeout: 100, attemptTimeout: 10 });
  assert.equal(fixture.events.filter(event => event.startsWith("Escape")).length, 3);
  assert.equal(fixture.events.filter(event => event.startsWith("dispose")).length, 3);
  assert.ok(fixture.dialogs.every(item => item.closed)); assert.ok(fixture.budgets.every(value => value > 0 && value <= 10));
});

test("normal modal dismissal reacquires reused nodes and binds nested dialog waits", async () => {
  for (const options of [{ reused: true }, { layers: 2 }]) {
    const fixture = dismissalFixture(options); await dismissDialogs(fixture.target, { timeout: 100, attemptTimeout: 10 });
    assert.equal(fixture.events.filter(event => event.startsWith("Escape")).length, 2);
    assert.ok(fixture.dialogs.every(item => item.closed));
  }
});

test("normal modal dismissal propagates browser errors instead of retrying them", async () => {
  const fixture = dismissalFixture({ fatal: true }); await assert.rejects(dismissDialogs(fixture.target, { timeout: 100 }), /browser closed/);
  assert.ok(!fixture.events.some(event => event.startsWith("Escape")));
});

test("safe navigation retries overlays under one deadline without business actions", async () => {
  const fixture = invoiceFixture(); await navigateWithDialogs(fixture.target, "Invoices", { timeout: 100, attemptTimeout: 20 });
  assert.deepEqual(fixture.events, ["Escape order", "nav 1", "Escape invoice", "nav 2"]);
  assert.ok(fixture.timeouts.every(value => value > 0 && value <= 100));
});

test("invoice navigation retries share one deadline and missing targets still fail", async () => {
  const fixture = invoiceFixture({ missing: true }); const start = Date.now(); await assert.rejects(openInvoiceDetails(fixture.target, "INV-1", { timeout: 15, attemptTimeout: 4 }), /deadline exceeded/); assert.ok(Date.now() - start < 100); assert.ok(!fixture.events.includes("Open invoice INV-1"));
  let visible = false; const timeouts = [];
  const target = { viewportSize: () => ({ width: 390, height: 844 }), getByRole(_role, { name }) {
    const toggle = name === "Open navigation";
    const control = { or() { return this; }, first() { return this; }, isVisible: async () => toggle || visible, boundingBox: async () => ({ x: 10, y: 10, width: 50, height: 30 }), async click({ timeout }) { timeouts.push(timeout); if (toggle) { await new Promise(resolve => setTimeout(resolve, 8)); visible = true; } } }; return control;
  } };
  await navigateAction(target, "Invoices", { timeout: 100 }); assert.equal(timeouts.length, 2); assert.ok(timeouts[1] < timeouts[0], "Mobile toggle and navigation click must share one attempt deadline");
});

test("CSV parser preserves RFC4180 quoted commas, doubled quotes and embedded newlines", () => {
  assert.deepEqual(csvRows('id,name,notes\r\n1,"Research, then ""deliver""","First line\nSecond, ""quoted"" line"\r\n'),
    [["id", "name", "notes"], ["1", 'Research, then "deliver"', 'First line\nSecond, "quoted" line']]);
});

test("CSV parser supports BOM, empty trailing cells and quoted empty values", () => {
  assert.deepEqual(csvRows('\uFEFFa,b,c\n1,"",\n2,x,'), [["a", "b", "c"], ["1", "", ""], ["2", "x", ""]]);
  assert.deepEqual(csvRows(""), []);
  assert.deepEqual(csvRows('""'), [[""]]);
});

test("CSV parser never normalizes or evaluates formula-looking values", () => {
  assert.deepEqual(csvRows('name,notes\n"  =SUM(1,2)",@command\n'), [["name", "notes"], ["  =SUM(1,2)", "@command"]]);
  assert.deepEqual(csvRows("name,notes\n'=SUM(1),'+formula\n"), [["name", "notes"], ["'=SUM(1)", "'+formula"]]);
});

test("CSV parser rejects invalid quoting rather than silently accepting broken exports", () => {
  for (const invalid of ['"unfinished', 'a,"ok"bad', 'a,b"c']) assert.throws(() => csvRows(invalid), /CSV/);
});

test("browser evaluator refuses external URLs before loading Playwright or launching Chrome", async () => {
  await assert.rejects(browserEvaluate({ baseURL: "https://example.invalid" }), /loopback/);
  await assert.rejects(browserEvaluate({ baseURL: "http://127.0.0.1:3000", playwrightModule: "relative", chromePath: "relative" }), /Absolute/);
});

test("frozen browser inventory contains40 distinct public-contract checks", () => {
  const source = fs.readFileSync(path.join(__dirname, "browser-eval.cjs"), "utf8");
  const names = [...source.matchAll(/await check\("([^"]+)"/g)].map(match => match[1]);
  assert.equal(names.length, 40);
  assert.equal(new Set(names).size, 40);
});
