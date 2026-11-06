"use strict";
const $ = (selector, parent = document) => parent.querySelector(selector);
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const alertMessage = (element, message = "") => {
  element.textContent = message;
  element.hidden = !message;
};
const statusBadge = (status) => {
  const badge = node("span", "status", status);
  badge.dataset.status = status;
  return badge;
};
const clockTime = (timestamp) => new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dateTime = (timestamp) => new Date(timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status}).`);
  return body;
}
const workflowCards = new Map();
const legacyCards = new Map();
let refreshing = false;
function jobView(job) {
  const view = node("div", "workflow-job");
  const heading = node("div", "job-heading");
  const title = node("div", "job-name", job.name);
  title.append(node("span", "job-key", job.key));
  heading.append(title, statusBadge(job.status));
  view.append(heading);
  if (job.dependsOn.length) view.append(node("p", "job-deps", `After: ${job.dependsOn.join(", ")}`));
  if (job.attempts.length) {
    const list = node("ol", "attempts");
    list.setAttribute("aria-label", `Attempts for ${job.name}`);
    for (const attempt of job.attempts) {
      const item = node("li", "attempt");
      item.dataset.status = attempt.status;
      item.append(document.createTextNode(`Attempt ${attempt.number} · ${attempt.status}`));
      if (attempt.pid) item.append(document.createTextNode(` · PID ${attempt.pid}`));
      const time = node("time", "", ` · ${clockTime(attempt.startedAt)}${attempt.finishedAt ? " → " + clockTime(attempt.finishedAt) : ""}`);
      time.dateTime = new Date(attempt.startedAt).toISOString();
      item.append(time);
      list.append(item);
    }
    view.append(list);
  } else view.append(node("p", "job-deps", job.status === "queued" ? "Waiting to run" : "No attempts"));
  if (job.status === "failed" && job.error) {
    const error = node("p", "", job.error);
    error.setAttribute("role", "alert");
    view.append(error);
  }
  if (job.result) {
    const output = node("details", "output");
    output.dataset.outputId = job.id;
    output.append(node("summary", "", "Worker output"), node("pre", "", job.result));
    view.append(output);
  }
  return view;
}
function makeCard(workflow) {
  const article = node("article", "workflow-card");
  article.dataset.workflowId = workflow.id;
  article.setAttribute("aria-label", `Workflow ${workflow.name}`);
  const content = node("div");
  const footer = node("div", "workflow-footer");
  const eventsButton = node("button", "quiet", "View events ↗");
  eventsButton.type = "button";
  eventsButton.setAttribute("aria-label", `View events ${workflow.name}`);
  eventsButton.setAttribute("aria-expanded", "false");
  const cancelButton = node("button", "danger", "Cancel workflow");
  cancelButton.type = "button";
  cancelButton.setAttribute("aria-label", `Cancel workflow ${workflow.name}`);
  const region = node("section", "event-region");
  region.hidden = true;
  region.id = `events-${workflow.id}`;
  region.setAttribute("aria-label", `Events for ${workflow.name}`);
  eventsButton.setAttribute("aria-controls", region.id);
  const eventHeading = node("h4", "", "Event history");
  const eventList = node("ol");
  region.append(eventHeading, eventList);
  const error = node("p");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const card = { article, content, cancelButton, eventsButton, region, eventList, error,
    fingerprint: "", eventFingerprint: "", eventsOpen: false, eventsBusy: false, cancelling: false };
  eventsButton.addEventListener("click", async () => {
    card.eventsOpen = !card.eventsOpen;
    region.hidden = !card.eventsOpen;
    eventsButton.setAttribute("aria-expanded", String(card.eventsOpen));
    if (card.eventsOpen) await refreshEvents(workflow.id, card);
  });
  cancelButton.addEventListener("click", async () => {
    if (card.cancelling) return;
    card.cancelling = true;
    cancelButton.disabled = true;
    cancelButton.textContent = "Cancelling…";
    alertMessage(error);
    try {
      await api(`/api/workflows/${workflow.id}/cancel`, { method: "POST" });
      await refresh();
    } catch (failure) { alertMessage(error, failure.message); }
    finally {
      card.cancelling = false;
      cancelButton.disabled = false;
      cancelButton.textContent = "Cancel workflow";
    }
  });
  footer.append(eventsButton, cancelButton);
  article.append(content, footer, error, region);
  return card;
}
function updateCard(workflow, card) {
  const fingerprint = JSON.stringify(workflow);
  if (card.fingerprint === fingerprint) return;
  const openOutputs = new Set([...card.content.querySelectorAll("details[open]")].map((details) => details.dataset.outputId));
  card.fingerprint = fingerprint;
  const head = node("div", "workflow-head");
  const title = node("div", "workflow-title");
  const status = statusBadge(workflow.status);
  status.dataset.testid = "workflow-status";
  title.append(node("h3", "", workflow.name), status);
  const meta = node("div", "workflow-meta");
  const succeeded = workflow.jobs.filter((job) => job.status === "succeeded").length;
  meta.append(node("span", "", `${succeeded}/${workflow.jobs.length} steps complete`),
    node("span", "", `Concurrency ${workflow.concurrency}`), node("span", "", dateTime(workflow.createdAt)));
  const progress = node("div", "progress-track");
  progress.setAttribute("aria-hidden", "true");
  for (const job of workflow.jobs) {
    const segment = node("span", "progress-segment");
    segment.dataset.status = job.status;
    progress.append(segment);
  }
  head.append(title, meta, progress);
  const list = node("div", "job-list");
  for (const job of workflow.jobs) list.append(jobView(job));
  card.content.replaceChildren(head, list);
  for (const details of card.content.querySelectorAll("details")) details.open = openOutputs.has(details.dataset.outputId);
  card.cancelButton.hidden = !["queued", "running"].includes(workflow.status);
}
async function refreshEvents(id, card) {
  if (card.eventsBusy || !card.eventsOpen) return;
  card.eventsBusy = true;
  try {
    const { events } = await api(`/api/workflows/${id}/events?after=0`);
    const fingerprint = JSON.stringify(events);
    if (fingerprint !== card.eventFingerprint) {
      card.eventFingerprint = fingerprint;
      card.eventList.replaceChildren(...events.map((event) => {
        const item = node("li");
        item.append(node("span", "event-seq", String(event.seq).padStart(2, "0")),
          node("span", "event-type", event.type),
          node("span", "event-extra", [event.jobKey, event.attempt ? `#${event.attempt}` : "", clockTime(event.createdAt)].filter(Boolean).join(" · ")));
        return item;
      }));
    }
    alertMessage(card.error);
  } catch (failure) { alertMessage(card.error, failure.message); }
  finally { card.eventsBusy = false; }
}
function renderWorkflows(workflows) {
  $("#workflow-count").textContent = $("#nav-count").textContent = workflows.length;
  $("#workflow-empty").hidden = workflows.length > 0;
  $("#stat-active").textContent = workflows.filter((workflow) => ["queued", "running"].includes(workflow.status)).length;
  $("#stat-succeeded").textContent = workflows.filter((workflow) => workflow.status === "succeeded").length;
  $("#stat-failed").textContent = workflows.filter((workflow) => workflow.status === "failed").length;
  $("#stat-attempts").textContent = workflows.reduce((sum, workflow) => sum + workflow.jobs.reduce((count, job) => count + job.attempts.length, 0), 0);
  const list = $("#workflow-list");
  workflows.forEach((workflow, index) => {
    let card = workflowCards.get(workflow.id);
    if (!card) { card = makeCard(workflow); workflowCards.set(workflow.id, card); }
    updateCard(workflow, card);
    if (list.children[index] !== card.article) list.insertBefore(card.article, list.children[index] || null);
  });
  for (const [id, card] of workflowCards) if (!workflows.some((workflow) => workflow.id === id)) {
    card.article.remove(); workflowCards.delete(id);
  }
}
function renderLegacy(jobs) {
  $("#legacy-count").textContent = jobs.length;
  if (!jobs.length) return;
  const list = $("#jobs");
  if (!legacyCards.size) list.replaceChildren();
  for (const job of jobs) {
    let card = legacyCards.get(job.id);
    if (!card) {
      card = { element: node("article", "panel legacy-card"), fingerprint: "" };
      card.element.setAttribute("aria-label", `Legacy job ${job.name}`);
      legacyCards.set(job.id, card); list.prepend(card.element);
    }
    const fingerprint = JSON.stringify(job);
    if (fingerprint === card.fingerprint) continue;
    card.fingerprint = fingerprint;
    card.element.replaceChildren(node("h3", "", job.name), statusBadge(job.status),
      node("p", "workflow-meta", `${job.kind} · Attempt ${job.attempt} · ${dateTime(job.created_at)}`));
    if (job.result) card.element.append(node("pre", "legacy-result", job.result));
    if (job.error) {
      const error = node("p", "", job.error);
      error.setAttribute("role", "alert"); card.element.append(error);
    }
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [{ workflows }, { jobs }, health] = await Promise.all([api("/api/workflows"), api("/api/jobs"), api("/api/health")]);
    renderWorkflows(workflows);
    renderLegacy(jobs);
    $("#connection-label").textContent = health.ok ? "Local instance" : "Unavailable";
    $("#connection").classList.remove("offline");
    alertMessage($("#connection-error"));
    await Promise.all([...workflowCards].map(([id, card]) => refreshEvents(id, card)));
  } catch {
    $("#connection-label").textContent = "Reconnecting…";
    $("#connection").classList.add("offline");
    alertMessage($("#connection-error"), "Could not reach the local runner. Retrying automatically; the last saved view is shown.");
  } finally { refreshing = false; }
}
const workflowForm = $("#workflow-form");
let creatingWorkflow = false;
// The pending guard also covers keyboard submission; suppress a second mouse click
// even if a very fast local response finishes between the two clicks.
$("#create-workflow").addEventListener("click", (event) => {
  if (event.detail > 1) event.preventDefault();
});
workflowForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (creatingWorkflow) return;
  const error = $("#workflow-error");
  alertMessage(error);
  let jobs;
  try { jobs = JSON.parse($("#definition").value); }
  catch { alertMessage(error, "Workflow definition must be a valid JSON array of jobs."); return; }
  creatingWorkflow = true;
  const button = $("#create-workflow");
  button.disabled = true;
  try {
    const { workflow } = await api("/api/workflows", { method: "POST", headers: {
      "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(),
    }, body: JSON.stringify({ name: $("#workflow-name").value, concurrency: Number($("#concurrency").value), jobs }) });
    $("#create-note").textContent = `Created ${workflow.name}. Follow its progress in Workflows.`;
    await refresh();
  } catch (failure) { alertMessage(error, failure.message); }
  finally { creatingWorkflow = false; button.disabled = false; }
});
const jobForm = $("#job-form");
let creatingJob = false;
jobForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (creatingJob) return;
  creatingJob = true;
  const error = $("#job-error"), button = $("button", jobForm);
  alertMessage(error); button.disabled = true;
  try {
    await api("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("#job-name").value, kind: $("#job-kind").value }) });
    jobForm.reset(); await refresh();
  } catch (failure) { alertMessage(error, failure.message); }
  finally { creatingJob = false; button.disabled = false; }
});
refresh();
setInterval(refresh, 800);
