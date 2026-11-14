import { test, expect } from "bun:test";
import { join } from "node:path";
const origin = `http://127.0.0.1:${process.env.PORT}`;
test("full server restart preserves session, selection, all domains, files, analytics, revision and idempotency", async () => {
  const s = await Bun.file(join(process.env.DATA_DIR!, "verification-state.json")).json();
  async function req(path: string, method = "GET", data?: unknown) {
    const response = await fetch(origin + path, { method, headers: { cookie: s.cookie, ...(data ? { "Content-Type": "application/json" } : {}) }, body: data ? JSON.stringify(data) : undefined });
    expect(response.status).toBe(200);
    return response.json();
  }
  const me = await req("/api/auth/me");
  expect(me.user.id).toBe(s.user.id); expect(me.activeWorkspaceId).toBe(s.w);
  const base = `/api/w/${s.w}`;
  expect(await req(base + "/summary")).toEqual(s.summary);
  expect((await req(base + "/sync")).revision).toBe(s.revision);
  for (const [kind, record] of [["customers", s.customer], ["products", s.product], ["orders", s.order], ["invoices", s.invoice], ["projects", s.project], ["tasks", s.task]]) {
    expect((await req(`${base}/${kind}/${record.id}`))[kind.slice(0, -1)].id).toBe(record.id);
  }
  expect((await req(`${base}/tasks/${s.task.id}/comments`)).comments.length).toBeGreaterThan(0);
  const response = await fetch(`${origin}${base}/attachments/${s.attachment.id}/download`, { headers: { cookie: s.cookie } });
  expect(response.status).toBe(200); expect(await response.text()).toBe("# Launch brief\n\nSynthetic local attachment.\n");
  const productBefore = (await req(`${base}/products/${s.product.id}`)).product;
  const activityBefore = (await req(`${base}/activity?limit=500`)).activity.length;
  const result = await req(`${base}/orders/${s.order.id}/fulfill`, "POST", { idempotencyKey: "original-fulfillment-key" });
  expect(result.replayed).toBe(true); expect(result.order.totalCents).toBe(15148);
  expect((await req(`${base}/products/${s.product.id}`)).product.stock).toBe(productBefore.stock);
  expect((await req(`${base}/activity?limit=500`)).activity.length).toBe(activityBefore);
  expect((await req(base + "/sync")).revision).toBe(s.revision);
});
