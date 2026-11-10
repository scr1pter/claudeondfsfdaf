"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { keyboardFormReachability } = require("../../browser-check.cjs");
const originalCheck = path.join(__dirname, "original/browser-check.cjs");

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) result[argv[i].replace(/^--/, "")] = argv[i + 1];
  return result;
}

function documentFor(inaccessible) {
  const excluded = inaccessible ? ' tabindex="-1"' : "";
  return `<!doctype html><html lang="en"><head><title>Focus instrument control</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:20px;max-width:650px}input,select,textarea{display:block;max-width:100%;box-sizing:border-box}label{display:block;margin:12px 0}article{margin-top:18px;border:1px solid #aaa;padding:10px}h1{font-size:28px}</style></head><body><h1>Workflow Runner</h1><form><label>Workflow name<input id="name"${excluded}></label><label>Concurrency<select id="concurrency"${excluded}><option>1</option><option selected>2</option><option>3</option></select></label><label>Workflow definition<textarea id="definition"${excluded}></textarea></label><button id="create"${excluded}>Create workflow</button><output id="created"></output></form><article aria-label="Workflow UI created"><h2>UI created</h2><button id="last">View events UI created</button><section aria-label="Events for UI created" hidden>workflow.created job.started job.succeeded workflow.succeeded</section></article><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();document.getElementById('created').textContent='Created '+document.getElementById('name').value};document.getElementById('last').onclick=()=>document.querySelector('section').hidden=false;</script></body></html>`;
}

async function snapshot(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id,
      label: element.labels?.[0]?.textContent.trim() || element.getAttribute("aria-label") || element.textContent.trim().slice(0, 80),
      currentSingleTabAssertion: element !== document.body,
    };
  });
}


async function main() {
  const args = options(process.argv.slice(2));
  const frozenBefore = crypto.createHash("sha256").update(await fs.readFile(originalCheck)).digest("hex");
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(documentFor(request.url === "/inaccessible"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const { startProxy } = require(args["proxy-module"]);
  let blocked = 0;
  const proxy = await startProxy(new Set([base]), () => blocked++);
  const { chromium } = require(args.playwright);
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "focus-proof-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: args.chrome,
      headless: true,
      viewport: { width: 1440, height: 900 },
      timeout: 15000,
      serviceWorkers: "block",
      proxy: { server: proxy.url, bypass: "<-loopback>" },
      args: ["--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--proxy-bypass-list=<-loopback>"],
    });
    await context.route("**/*", (route) => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(base);
    await page.getByRole("button", { name: "View events UI created", exact: true }).click();
    const lastControl = await snapshot(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Tab");
    const firstTab = await snapshot(page);
    await page.keyboard.press("Tab");
    const secondTab = await snapshot(page);
    const healthyKeyboard = await keyboardFormReachability(page);

    await page.goto(base + "/inaccessible");
    const inaccessibleKeyboard = await keyboardFormReachability(page);
    const frozenAfter = crypto.createHash("sha256").update(await fs.readFile(originalCheck)).digest("hex");
    const result = {
      kind: "workflow-mobile-focus-assumption-control",
      modelCalls: 0,
      browserVersion: context.browser()?.version(),
      healthyLastControl: lastControl,
      healthyFirstTab: firstTab,
      healthySecondTab: secondTab,
      healthyNativeKeyboardFormTraversal: healthyKeyboard,
      inaccessibleNativeKeyboardFormTraversal: inaccessibleKeyboard,
      frozenCheckSha256: frozenBefore,
      frozenCheckUnchanged: frozenBefore === frozenAfter,
      blockedNetworkRequests: blocked,
      noProgrammaticFocusOrTabindexMutation: true,
    };
    await fs.writeFile(path.resolve(args.out || path.join(__dirname, "focus-proof.json")), JSON.stringify(result, null, 2));
    if (firstTab.currentSingleTabAssertion || secondTab.id !== "name" || healthyKeyboard.missingControls.length !== 0 || inaccessibleKeyboard.missingControls.length !== 4 || frozenBefore !== frozenAfter) throw new Error("Control did not establish expected focus behavior");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context?.close();
    await proxy.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
