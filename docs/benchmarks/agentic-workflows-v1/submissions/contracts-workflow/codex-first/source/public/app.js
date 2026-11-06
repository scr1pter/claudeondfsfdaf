const $ = selector => document.querySelector(selector);
const openEvents = new Set();
const eventData = new Map();
const cards = new Map();
let lastLegacy = "", refreshing = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function alertMessage(node, message = "") {
  node.textContent = message;
  node.hidden = !message;
}
async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "The request could not be completed.");
  return data;
}
function statusBadge(status) {
  return element("span", "status status-" + status, status);
}
function time(value) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function renderJob(job, index) {
  const row = element("div", "job-row");
  const heading = element("div", "job-heading");
  heading.append(element("span", "job-number", String(index + 1).padStart(2, "0")),
    element("span", "job-title", job.name), statusBadge(job.status));
  const info = element("p", "job-info");
  info.append(element("code", "", job.key), document.createTextNode(" · " + job.kind + " · " +
    (job.dependsOn.length ? "after " + job.dependsOn.join(", ") : "no dependencies") + " · up to " + job.maxAttempts + " attempt" + (job.maxAttempts === 1 ? "" : "s")));
  row.append(heading, info);
  if (job.attempts.length) {
    const panel = element("div", "attempts");
    panel.setAttribute("tabindex", "0");
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Attempts for " + job.name);
    const table = element("table");
    const thead = element("thead"), titles = element("tr");
    for (const label of ["ATTEMPT", "STATUS", "PID", "STARTED", "FINISHED"]) {
      const th = element("th", "", label); th.scope = "col"; titles.append(th);
    }
    thead.append(titles);
    const body = element("tbody");
    for (const attempt of job.attempts) {
      const tr = element("tr");
      const status = element("td"); status.append(statusBadge(attempt.status));
      tr.append(element("td", "", "#" + attempt.number), status,
        element("td", "", attempt.pid === null ? "—" : String(attempt.pid)),
        element("td", "", time(attempt.startedAt)),
        element("td", "", attempt.finishedAt === null ? "—" : time(attempt.finishedAt)));
      body.append(tr);
    }
    table.append(thead, body); panel.append(table); row.append(panel);
  }
  if (job.error) {
    const error = element("p", "error", job.error);
    if (job.status === "failed") error.setAttribute("role", "alert");
    row.append(error);
  }
  if (job.result) {
    const details = element("details", "result");
    details.dataset.jobId = job.id;
    details.append(element("summary", "", "Worker output"), element("pre", "", job.result));
    row.append(details);
  }
  return row;
}
function renderCard(workflow) {
  const article = element("article", "workflow-card");
  article.dataset.workflowId = workflow.id;
  article.setAttribute("aria-label", "Workflow " + workflow.name);
  const head = element("div", "card-head"), titleRow = element("div", "card-title-row");
  const title = element("h3", "card-title");
  const icon = element("span", "workflow-icon", "↳"); icon.setAttribute("aria-hidden", "true");
  title.append(icon, document.createTextNode(workflow.name));
  const badge = statusBadge(workflow.status); badge.dataset.testid = "workflow-status";
  titleRow.append(title, badge);
  const meta = element("p", "card-meta");
  meta.append(element("code", "", workflow.id.slice(0, 8)), element("span", "", workflow.jobs.length + " jobs"),
    element("span", "", "Concurrency " + workflow.concurrency),
    element("span", "", "Created " + new Date(workflow.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })));
  head.append(titleRow, meta);
  const jobs = element("div", "job-list");
  workflow.jobs.forEach((job, index) => jobs.append(renderJob(job, index)));
  const actions = element("div", "card-actions");
  const eventsButton = element("button", "event-button");
  eventsButton.type = "button"; eventsButton.dataset.action = "events";
  eventsButton.setAttribute("aria-label", "View events " + workflow.name);
  eventsButton.setAttribute("aria-expanded", String(openEvents.has(workflow.id)));
  eventsButton.setAttribute("aria-controls", "events-" + workflow.id);
  eventsButton.append(element("span", "", "≡"), document.createTextNode("View events"), element("span", "", openEvents.has(workflow.id) ? "⌃" : "⌄"));
  eventsButton.addEventListener("click", async () => {
    if (openEvents.has(workflow.id)) openEvents.delete(workflow.id);
    else openEvents.add(workflow.id);
    updateCard(workflow);
    if (openEvents.has(workflow.id)) {
      await loadEvents(workflow.id);
      updateCard(cards.get(workflow.id)?.workflow || workflow);
    }
  });
  actions.append(eventsButton);
  if (["queued", "running"].includes(workflow.status)) {
    const cancel = element("button", "cancel-button", "Cancel workflow");
    cancel.type = "button"; cancel.dataset.action = "cancel";
    cancel.setAttribute("aria-label", "Cancel workflow " + workflow.name);
    cancel.addEventListener("click", async () => {
      cancel.disabled = true; cancel.textContent = "Cancelling…";
      try {
        const result = await api("/api/workflows/" + workflow.id + "/cancel", { method: "POST" });
        if (openEvents.has(workflow.id)) await loadEvents(workflow.id);
        updateCard(result.workflow); await refresh();
      } catch (failure) {
        alertMessage($("#connection-error"), failure.message); cancel.disabled = false; cancel.textContent = "Cancel workflow";
      }
    });
    actions.append(cancel);
  } else {
    actions.append(element("span", "event-info", "Updated " + time(workflow.updatedAt)));
  }
  article.append(head, jobs, actions);
  if (openEvents.has(workflow.id)) {
    const region = element("section", "events-region");
    region.id = "events-" + workflow.id;
    region.setAttribute("aria-label", "Events for " + workflow.name);
    region.append(element("h4", "", "Events for " + workflow.name));
    const data = eventData.get(workflow.id);
    if (!data) region.append(element("p", "events-empty", "Loading events…"));
    else if (data.error) { const error = element("p", "error", data.error); error.setAttribute("role", "alert"); region.append(error); }
    else {
      const list = element("ol");
      list.tabIndex = 0;
      for (const event of data.events) {
        const li = element("li");
        li.append(element("span", "event-seq", String(event.seq).padStart(2, "0")),
          element("span", "", event.type),
          element("span", "event-info", [event.jobKey, event.attempt ? "#" + event.attempt : "", time(event.createdAt)].filter(Boolean).join(" · ")));
        list.append(li);
      }
      region.append(list);
    }
    article.append(region);
  }
  return article;
}
function updateCard(workflow) {
  const signature = JSON.stringify([workflow, openEvents.has(workflow.id), eventData.get(workflow.id)]);
  const old = cards.get(workflow.id);
  if (old?.signature === signature) return old.node;
  const focus = old?.node.contains(document.activeElement) ? document.activeElement.dataset.action : null;
  const expanded = new Set(old ? [...old.node.querySelectorAll("details[open]")].map(item => item.dataset.jobId) : []);
  const scroll = old?.node.querySelector(".events-region ol")?.scrollTop || 0;
  const node = renderCard(workflow);
  for (const details of node.querySelectorAll("details")) details.open = expanded.has(details.dataset.jobId);
  if (old?.node.isConnected) old.node.replaceWith(node);
  const events = node.querySelector(".events-region ol");
  if (events) events.scrollTop = scroll;
  if (focus) node.querySelector('[data-action="' + focus + '"]')?.focus({ preventScroll: true });
  cards.set(workflow.id, { node, signature, workflow });
  return node;
}
async function loadEvents(id) {
  try { eventData.set(id, await api("/api/workflows/" + id + "/events?after=0")); }
  catch (failure) { eventData.set(id, { error: failure.message }); }
}
function renderLegacy(jobs) {
  const signature = JSON.stringify(jobs);
  if (signature === lastLegacy) return;
  lastLegacy = signature;
  const nodes = jobs.slice().reverse().map(job => {
    const card = element("article", "legacy-card");
    card.setAttribute("aria-label", "Legacy job " + job.name);
    const title = element("div", "legacy-title-row");
    title.append(element("h3", "", job.name), statusBadge(job.status));
    card.append(title, element("p", "card-meta", job.kind + " · Attempt " + job.attempt));
    if (job.result) card.append(element("pre", "", job.result));
    if (job.error) { const error = element("p", "error", job.error); error.setAttribute("role", "alert"); card.append(error); }
    return card;
  });
  $("#jobs").replaceChildren(...(nodes.length ? nodes : [element("p", "legacy-empty", "No legacy jobs yet. Single jobs will appear here.")]));
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [workflowData, legacyData] = await Promise.all([api("/api/workflows"), api("/api/jobs")]);
    await Promise.all([...openEvents].map(loadEvents));
    const workflows = workflowData.workflows;
    const parent = $("#workflows");
    if (workflows.length && parent.querySelector(".empty-state")) parent.replaceChildren();
    for (const workflow of workflows) {
      const node = updateCard(workflow);
      if (!node.isConnected) parent.prepend(node);
    }
    $("#active-count").textContent = workflows.filter(workflow => ["queued", "running"].includes(workflow.status)).length;
    $("#success-count").textContent = workflows.filter(workflow => workflow.status === "succeeded").length;
    $("#attempt-count").textContent = workflows.reduce((total, workflow) => total + workflow.jobs.reduce((count, job) => count + job.attempts.length, 0), 0);
    $("#workflow-count").textContent = workflows.length;
    $("#legacy-count").textContent = legacyData.jobs.length;
    renderLegacy(legacyData.jobs);
    $("#sync-state").textContent = "Synced " + time(Date.now()) + " · refreshes every second";
    alertMessage($("#connection-error"));
  } catch (failure) {
    $("#sync-state").textContent = "Connection interrupted";
    alertMessage($("#connection-error"), "Could not refresh the local runner. " + failure.message);
  } finally { refreshing = false; }
}
$("#workflow-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector("button[type=submit]");
  if (button.disabled) return;
  alertMessage($("#workflow-error"));
  button.disabled = true;
  try {
    let jobs;
    try { jobs = JSON.parse($("#definition").value); }
    catch { throw new Error("Workflow definition must be a valid JSON array of jobs."); }
    await api("/api/workflows", {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ name: $("#workflow-name").value, concurrency: Number($("#concurrency").value), jobs }),
    });
    $("#workflow-name").value = "";
    await refresh();
  } catch (failure) { alertMessage($("#workflow-error"), failure.message); }
  finally { button.disabled = false; }
});
$("#job-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector("button[type=submit]");
  if (button.disabled) return;
  alertMessage($("#job-error")); button.disabled = true;
  try {
    await api("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("#job-name").value, kind: $("#job-kind").value }) });
    form.reset(); await refresh();
  } catch (failure) { alertMessage($("#job-error"), failure.message); }
  finally { button.disabled = false; }
});
refresh();
setInterval(refresh, 1000);
