"use strict";
// A synthetic browser-contract control, not a real scheduler or a product pass.
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { options } = require("./browser-check.cjs");

const html = `<!doctype html><html lang="en"><head><title>Workflow control</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:20px}input,textarea,select{display:block;max-width:100%;box-sizing:border-box}article{padding:12px;border:1px solid #aaa;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body><h1>Workflow Runner</h1><section aria-label="Legacy jobs"><article aria-label="Legacy job Legacy completed">Legacy completed succeeded</article></section><form id="form"><label>Workflow name<input id="name"></label><label>Concurrency<select id="concurrency"><option>1</option><option selected>2</option><option>3</option></select></label><label>Workflow definition<textarea id="definition"></textarea></label><button>Create workflow</button></form><section aria-label="Workflow list" id="list"></section><script>
async function update(){const data=await(await fetch('/api/workflows')).json();for(const wf of data.workflows){let card=document.getElementById(wf.id);if(!card){card=document.createElement('article');card.id=wf.id;card.setAttribute('aria-label','Workflow '+wf.name);card.dataset.workflowId=wf.id;const title=document.createElement('h2');title.textContent=wf.name;const status=document.createElement('p');status.dataset.testid='workflow-status';const alert=document.createElement('p');alert.setAttribute('role','alert');const cancel=document.createElement('button');cancel.textContent='Cancel workflow '+wf.name;cancel.onclick=async()=>{await fetch('/api/workflows/'+wf.id+'/cancel',{method:'POST'});await update()};const events=document.createElement('button');events.textContent='View events '+wf.name;events.onclick=async()=>{let panel=card.querySelector('section');if(!panel){panel=document.createElement('section');panel.setAttribute('aria-label','Events for '+wf.name);card.append(panel)}panel.textContent=(await(await fetch('/api/workflows/'+wf.id+'/events?after=0')).json()).events.map(x=>x.type).join(' ')};card.append(title,status,alert,cancel,events);document.getElementById('list').append(card)}card.querySelector('[data-testid=workflow-status]').textContent=wf.status;const alert=card.querySelector('[role=alert]');alert.textContent=wf.status==='failed'?'Synthetic failure':'';alert.hidden=wf.status!=='failed';card.querySelector('button').hidden=!['queued','running'].includes(wf.status)}}
document.getElementById('form').onsubmit=async e=>{e.preventDefault();await fetch('/api/workflows',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({name:document.getElementById('name').value,concurrency:Number(document.getElementById('concurrency').value),jobs:JSON.parse(document.getElementById('definition').value)})});await update()};update();setInterval(update,150);</script></body></html>`;

function controlDocument(mode) {
  if (mode === "negative")
    return html.replace("Workflow name", "Wrong field name");
  if (mode === "inaccessible")
    return html.replace(/<form id="form">[\s\S]*?<\/form>/, (form) =>
      form.replace(/<(input|select|textarea|button)(?=[\s>])/g, '<$1 tabindex="-1"'),
    );
  if (mode === "wrap")
    return html.replace(
      "}}\ndocument.getElementById('form')",
      "}const created=document.querySelector('[aria-label=\"Workflow UI created\"]');const list=document.getElementById('list');if(created&&list.lastElementChild!==created)list.append(created);}\ndocument.getElementById('form')",
    );
  if (mode !== "delayed") return html;
  const form = html.match(/<form id="form">[\s\S]*?<\/form>/)[0];
  return html
    .replace(form, '<div id="form-slot"></div>')
    .replace(
      "document.getElementById('form').onsubmit=",
      "fetch('/control/early?legacy='+Boolean(document.querySelector('[aria-label=\"Legacy job Legacy completed\"]'))+'&form='+Boolean(document.getElementById('form')));function attachForm(){document.getElementById('form-slot').innerHTML=" +
        JSON.stringify(form) +
        ";fetch('/control/mounted');document.getElementById('form').onsubmit=",
    )
    .replace(
      "};update();setInterval(update,150);",
      "};}setTimeout(attachForm,1500);update();setInterval(update,150);",
    );
}

async function run(args, mode) {
  const negative = mode === "negative" || mode === "inaccessible";
  const rejectedCheck = mode === "inaccessible" ? "mobile_layout_and_keyboard" : "browser_create_workflow";
  const workflows = [];
  const observations = {};
  const server = http.createServer(async (request, response) => {
    const send = (value, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(controlDocument(mode));
      return;
    }
    if (request.url.startsWith("/control/early?")) {
      const query = new URL(request.url, "http://127.0.0.1").searchParams;
      observations.early = {
        legacyVisible: query.get("legacy") === "true",
        formPresent: query.get("form") === "true",
        at: Date.now(),
      };
      return send({ ok: true });
    }
    if (request.url === "/control/mounted") {
      observations.mountedAt = Date.now();
      return send({ ok: true });
    }
    if (request.url === "/api/workflows" && request.method === "GET")
      return send({ workflows });
    if (request.url === "/api/workflows" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const kind = input.jobs[0].kind;
      const workflow = {
        id: "control-" + (workflows.length + 1),
        name: input.name,
        status:
          kind === "block"
            ? "running"
            : kind === "fail"
              ? "failed"
              : "succeeded",
        jobs: [
          {
            status:
              kind === "block"
                ? "running"
                : kind === "fail"
                  ? "failed"
                  : "succeeded",
          },
        ],
      };
      workflows.push(workflow);
      return send({ workflow }, 201);
    }
    const match =
      /^\/api\/workflows\/([^/]+)(\/cancel|\/events\?after=0)?$/.exec(
        request.url,
      );
    if (match) {
      const workflow = workflows.find((item) => item.id === match[1]);
      if (!workflow) return send({ error: { message: "missing" } }, 404);
      if (match[2] === "/cancel") {
        workflow.status = "cancelled";
        workflow.jobs[0].status = "cancelled";
        return send({ workflow });
      }
      if (match[2]?.startsWith("/events"))
        return send({
          events: [
            "workflow.created",
            "job.started",
            "job.succeeded",
            "workflow.succeeded",
          ].map((type, i) => ({ type, seq: i + 1 })),
        });
      return send({ workflow });
    }
    send({ error: { message: "missing" } }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const out = path.join(
    path.resolve(args.out),
    mode,
  );
  await fs.mkdir(out, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, "browser-check.cjs"),
      "--base-url",
      "http://127.0.0.1:" + server.address().port,
      "--out",
      out,
      "--playwright",
      args.playwright,
      "--chrome",
      args.chrome,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let diagnostics = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      if (diagnostics.length < 65536) diagnostics += chunk.toString();
    });
  const timer = setTimeout(() => child.kill(), 90000);
  try {
    const code = await new Promise((resolve) => child.once("exit", resolve));
    await fs.writeFile(path.join(out, "launcher.log"), diagnostics);
    const result = JSON.parse(
      await fs.readFile(path.join(out, "results.json"), "utf8"),
    );
    if (
      (!negative && (code !== 0 || result.verdict !== "passed")) ||
      (negative &&
        (code !== 1 ||
          result.verdict !== "product_failure" ||
          !result.checks.some(
            (check) =>
              check.name === rejectedCheck &&
              check.status === "failed",
          )))
    )
      throw new Error(
        "Browser contract control had unexpected verdict: " + result.verdict,
      );
    if (
      mode === "delayed" &&
      (!observations.early?.legacyVisible ||
        observations.early.formPresent ||
        !(observations.mountedAt - observations.early.at >= 1000))
    )
      throw new Error("Delayed control did not preserve early legacy content before mounting its form");
    const keyboard = result.checks.find((check) => check.name === "mobile_layout_and_keyboard")?.keyboard;
    if (mode === "wrap" && keyboard?.startingControl.text !== "View events UI created")
      throw new Error("Healthy wrap control did not start on the last workflow Events button");
    if (mode === "inaccessible" && (result.checks.filter((check) => check.status === "failed").length !== 1 || keyboard?.missingControls.length !== 4))
      throw new Error("Inaccessible form control must fail only the four-control native keyboard contract");
    return {
      control:
        mode === "wrap"
          ? "positive_healthy_wrap_from_last_events_button"
          : mode === "inaccessible"
            ? "negative_form_excluded_from_native_tab_order"
            : mode === "delayed"
          ? "positive_delayed_form_with_early_legacy_content"
          : negative
            ? "negative_missing_exact_label"
            : "positive_accessible_live_contract",
      verdict: result.verdict,
      passed: result.checks.filter((check) => check.status === "passed").length,
      failed: result.checks.filter((check) => check.status === "failed").length,
      ...(mode === "wrap" || mode === "inaccessible" ? { keyboard } : {}),
      ...(mode === "delayed"
        ? { earlyLegacyVisible: true, formInitiallyAbsent: true, formDelayMs: observations.mountedAt - observations.early.at }
        : {}),
    };
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function main() {
  const args = options(process.argv.slice(2));
  console.log(
    JSON.stringify({
      controls: [await run(args, "positive"), await run(args, "delayed"), await run(args, "wrap"), await run(args, "inaccessible"), await run(args, "negative")],
      modelCalls: 0,
      productPassClaim: false,
    }),
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
