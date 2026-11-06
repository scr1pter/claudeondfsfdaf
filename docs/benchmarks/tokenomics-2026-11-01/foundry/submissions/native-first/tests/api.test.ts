import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

const origin = `http://127.0.0.1:${process.env.PORT || 3000}`;
const suffix = Date.now();
const password = "synthetic-password-42";
class Client {
  cookie = "";
  w = "";
  async req(path: string, method = "GET", data?: unknown, expected = 200) {
    const response = await fetch(origin + path, {
      method, headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...(data !== undefined && !(data instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
      body: data instanceof FormData ? data : data === undefined ? undefined : JSON.stringify(data),
    });
    const session = response.headers.get("set-cookie");
    if (session) this.cookie = session.split(";")[0];
    const result = response.status === 204 ? null : response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
    expect(response.status, `${method} ${path}: ${JSON.stringify(result).slice(0, 220)}`).toBe(expected);
    if (expected >= 400) { expect(result.error.code).toBeTruthy(); expect(result.error.message).toBeTruthy(); }
    return result;
  }
  call(path: string, method = "GET", data?: unknown, status = 200) { return this.req(`/api/w/${this.w}${path}`, method, data, status); }
  async signup(name: string, email: string) {
    const result = await this.req("/api/auth/signup", "POST", { name, email, password }, 201);
    this.w = result.workspace.id; return result;
  }
}
const owner = new Client(), outsider = new Client(), member = new Client(), reader = new Client();
let customer: any, product: any, second: any, order: any, invoice: any, project: any, task: any, attachment: any, user: any, invite: any;

test("authentication, salted hashes, sessions and independent workspaces", async () => {
  expect(await owner.req("/api/health")).toEqual({ ok: true });
  await owner.req("/api/unknown", "GET", undefined, 404);
  await owner.req("/api/auth/me", "GET", undefined, 401);
  await owner.req("/api/auth/signup", "POST", { name: " ", email: `bad-${suffix}@example.invalid`, password }, 400);
  await owner.req("/api/auth/signup", "POST", { name: "Bad", email: "invalid", password }, 400);
  await owner.req("/api/auth/signup", "POST", { name: "Bad", email: `bad-${suffix}@example.invalid`, password: "short" }, 400);
  user = (await owner.signup("Morgan Reed", `morgan-${suffix}@example.invalid`)).user;
  expect(owner.cookie.split("=")[1].length).toBeGreaterThanOrEqual(32);
  const other = await outsider.signup("Alex North", `alex-${suffix}@example.invalid`);
  await member.signup("Jamie Park", `jamie-${suffix}@example.invalid`);
  await reader.signup("Robin Lane", `robin-${suffix}@example.invalid`);
  await outsider.req("/api/auth/signup", "POST", { name: "Duplicate", email: user.email.toUpperCase(), password }, 409);
  const login = new Client();
  await login.req("/api/auth/login", "POST", { email: user.email, password: "incorrect-password" }, 401);
  await login.req("/api/auth/login", "POST", { email: user.email.toUpperCase(), password });
  const oldCookie = login.cookie;
  await login.req("/api/auth/logout", "POST", {}, 204);
  login.cookie = oldCookie;
  await login.req("/api/auth/me", "GET", undefined, 401);
  const database = new Database(join(process.env.DATA_DIR!, "foundry.sqlite"), { readonly: true });
  const row = database.query("SELECT email,password_hash FROM users WHERE id=?").get(user.id) as any;
  expect(row.email).toBe(user.email); expect(row.password_hash.startsWith("$argon2id$")).toBe(true);
  expect(await Bun.password.verify(password, row.password_hash)).toBe(true); expect(row.password_hash).not.toContain(password);
  database.close();
  await outsider.req(`/api/workspaces/${owner.w}/select`, "POST", {}, 404);
  expect((await outsider.req("/api/auth/me")).activeWorkspaceId).toBe(other.workspace.id);
  const original = owner.w;
  const extra = (await owner.req("/api/workspaces", "POST", { name: "Foundry Studio" }, 201)).workspace;
  expect(extra.role).toBe("owner");
  await owner.req(`/api/workspaces/${original}/select`, "POST", {});
  expect((await owner.req("/api/auth/me")).activeWorkspaceId).toBe(original);
});

test("customers, strict CRUD, tenant isolation and atomic CSV", async () => {
  customer = (await owner.call("/customers", "POST", { name: "Cedar & Co.", email: "hello@cedar.example.invalid", company: "Cedar Collective", notes: "Launch collection, thoughtfully made." }, 201)).customer;
  expect((await owner.call("/customers?q=CEDAR")).customers.length).toBe(1);
  expect((await owner.call(`/customers/${customer.id}`, "PATCH", { notes: "Deliver together. Keep the original promise." })).customer.name).toBe(customer.name);
  await owner.call("/customers", "POST", { name: "Duplicate", email: customer.email.toUpperCase() }, 409);
  await owner.call("/customers", "POST", { name: " " }, 400);
  await outsider.call("/customers", "POST", { name: "Own customer", email: customer.email }, 201);
  await outsider.req(`/api/w/${owner.w}/customers`, "GET", undefined, 404);
  await outsider.call(`/customers/${customer.id}`, "GET", undefined, 404);
  await outsider.req(`/api/w/${owner.w}/activity`, "GET", undefined, 404);
  await outsider.req(`/api/w/${owner.w}/sync`, "GET", undefined, 404);
  const revision = (await owner.call("/sync")).revision;
  await owner.call("/import/customers", "POST", { csv: 'name,email,company,notes\nValid,valid@example.invalid,,ok\n"Bad",invalid,,oops' }, 400);
  expect((await owner.call("/sync")).revision).toBe(revision);
  await owner.call("/import/customers", "POST", { csv: `name,email,company,notes\nValid,valid@example.invalid,,ok\nDuplicate,${customer.email.toUpperCase()},,duplicate` }, 409);
  expect((await owner.call("/customers")).customers.length).toBe(1);
  const csv = 'name,email,company,notes\r\n"Juniper, Studio",juniper@example.invalid,"Juniper ""Design""","Line one\nLine two"\r\n=Formula,formula@example.invalid,," +formula"\r\n';
  expect((await owner.call("/import/customers", "POST", { csv }, 201)).imported).toBe(2);
  const exported = await owner.call("/export.csv?type=customers");
  expect(exported).toContain('"Juniper, Studio"'); expect(exported).toContain("'=Formula"); expect(exported).toContain("' +formula");
  expect((await owner.call("/customers?q=juniper")).customers[0].notes).toBe("Line one\nLine two");
  const unused = (await owner.call("/customers", "POST", { name: "Unused" }, 201)).customer;
  await owner.call(`/customers/${unused.id}`, "DELETE", undefined, 204);
  await owner.call(`/customers/${unused.id}`, "GET", undefined, 404);
});

test("inventory validation and immutable stock", async () => {
  product = (await owner.call("/products", "POST", { sku: " obj-001 ", name: "Everyday vessel", description: "Matte ceramic · sand", priceCents: 2450 }, 201)).product;
  second = (await owner.call("/products", "POST", { sku: "OBJ-002", name: "Linen table set", description: "Natural linen · set of four", priceCents: 3899 }, 201)).product;
  expect(product.sku).toBe("OBJ-001"); expect(product.stock).toBe(0);
  await owner.call("/products", "POST", { sku: "obj-001", name: "Duplicate", priceCents: 10 }, 409);
  for (const priceCents of [-1, 1.1, "10", 100000001]) await owner.call("/products", "POST", { sku: "BAD", name: "Invalid", priceCents }, 400);
  await owner.call(`/products/${product.id}`, "PATCH", { stock: 100 }, 400);
  await owner.call("/products", "POST", { sku: "BAD", name: "Invalid", priceCents: 1, stock: 1 }, 400);
  await owner.call("/stock-movements", "POST", { productId: product.id, delta: 0, reason: "Zero" }, 400);
  await owner.call("/stock-movements", "POST", { productId: product.id, delta: -1, reason: "No stock" }, 409);
  const movement = (await owner.call("/stock-movements", "POST", { productId: product.id, delta: 20, reason: "Opening receipt · batch 01" }, 201)).movement;
  await owner.call("/stock-movements", "POST", { productId: second.id, delta: 10, reason: "Opening receipt · batch 01" }, 201);
  expect(movement.createdBy).toBe(user.id); expect(movement.kind).toBe("adjustment"); expect(movement.orderId).toBeNull();
  await owner.call(`/stock-movements/${movement.id}`, "PATCH", { delta: 200 }, 404);
  await owner.call(`/products/${product.id}`, "DELETE", undefined, 409);
  expect((await owner.call(`/stock-movements?productId=${product.id}`)).movements.length).toBe(1);
});

test("order snapshots, cents-exact invoices and terminal states", async () => {
  const before = (await owner.call("/orders")).orders.length;
  await owner.call("/orders", "POST", { customerId: customer.id, items: [{ productId: product.id, quantity: 2 }, { productId: "foreign-product", quantity: 1 }] }, 404);
  await owner.call("/orders", "POST", { customerId: customer.id, items: [{ productId: product.id, quantity: 1.5 }] }, 400);
  await owner.call("/orders", "POST", { customerId: customer.id, items: [{ productId: product.id, quantity: 1 }, { productId: product.id, quantity: 1 }] }, 400);
  expect((await owner.call("/orders")).orders.length).toBe(before);
  order = (await owner.call("/orders", "POST", { customerId: customer.id, items: [{ productId: product.id, quantity: 3 }, { productId: second.id, quantity: 2 }] }, 201)).order;
  expect(order.totalCents).toBe(15148); expect(order.number).toMatch(/^ORD-\d{6}$/);
  await owner.call("/invoices", "POST", { orderId: order.id }, 409);
  await owner.call("/invoices", "POST", { orderId: order.id, totalCents: 1 }, 400);
  await owner.call(`/products/${product.id}`, "PATCH", { priceCents: 2599, name: "Everyday vessel · revised" });
  expect((await owner.call(`/orders/${order.id}`)).order.items[0].unitPriceCents).toBe(2450);
  await owner.call(`/customers/${customer.id}`, "DELETE", undefined, 409);
  const fulfilled = await owner.call(`/orders/${order.id}/fulfill`, "POST", { idempotencyKey: "original-fulfillment-key" });
  expect(fulfilled.replayed).toBe(false); expect(fulfilled.order.status).toBe("fulfilled");
  const rev = (await owner.call("/sync")).revision;
  expect((await owner.call(`/orders/${order.id}/fulfill`, "POST", { idempotencyKey: "original-fulfillment-key" })).replayed).toBe(true);
  expect((await owner.call("/sync")).revision).toBe(rev);
  await owner.call(`/orders/${order.id}/fulfill`, "POST", { idempotencyKey: "different-key" }, 409);
  await owner.call(`/orders/${order.id}/cancel`, "POST", {}, 409);
  await owner.call(`/orders/${order.id}`, "PATCH", { customerId: customer.id }, 409);
  await owner.call(`/orders/${order.id}`, "DELETE", undefined, 409);
  invoice = (await owner.call("/invoices", "POST", { orderId: order.id }, 201)).invoice;
  expect(invoice.totalCents).toBe(15148); expect(invoice.subtotalCents).toBe(15148); expect(invoice.status).toBe("draft"); expect(invoice.paidAt).toBeNull();
  await owner.call("/invoices", "POST", { orderId: order.id }, 409);
  await owner.call(`/invoices/${invoice.id}`, "PATCH", { status: "paid" }, 409);
  await owner.call(`/customers/${customer.id}`, "PATCH", { name: "Cedar & Co. · updated" });
  expect((await owner.call(`/invoices/${invoice.id}`)).invoice.billTo.name).toBe("Cedar & Co.");
  await owner.call(`/invoices/${invoice.id}`, "PATCH", { status: "sent" });
  const paid = (await owner.call(`/invoices/${invoice.id}`, "PATCH", { status: "paid" })).invoice;
  expect(paid.paidAt).toBeTruthy();
  await owner.call(`/invoices/${invoice.id}`, "PATCH", { status: "void" }, 409);
  expect((await owner.call("/summary")).revenueCents).toBe(15148);
  expect((await owner.call("/summary")).unpaidCents).toBe(0);
});

test("atomic rollback, retryable keys and concurrent fulfillment", async () => {
  const scarce = (await owner.call("/products", "POST", { sku: "STU-003", name: "Studio notebook", description: "Recycled paper · moss", priceCents: 1899 }, 201)).product;
  await owner.call("/stock-movements", "POST", { productId: scarce.id, delta: 5, reason: "Limited opening batch" }, 201);
  const make = async (items: any[]) => (await owner.call("/orders", "POST", { customerId: customer.id, items }, 201)).order;
  const rollback = await make([{ productId: product.id, quantity: 1 }, { productId: scarce.id, quantity: 6 }]);
  const stockBefore = (await owner.call(`/products/${product.id}`)).product.stock;
  const revision = (await owner.call("/sync")).revision, activity = (await owner.call("/activity?limit=500")).activity.length;
  await owner.call(`/orders/${rollback.id}/fulfill`, "POST", { idempotencyKey: "retry-after-restock" }, 409);
  expect((await owner.call(`/products/${product.id}`)).product.stock).toBe(stockBefore);
  expect((await owner.call("/sync")).revision).toBe(revision);
  expect((await owner.call("/activity?limit=500")).activity.length).toBe(activity);
  expect((await owner.call("/stock-movements")).movements.filter((m: any) => m.orderId === rollback.id).length).toBe(0);
  await owner.call("/stock-movements", "POST", { productId: scarce.id, delta: 6, reason: "Restock for pending delivery" }, 201);
  await owner.call(`/orders/${rollback.id}/fulfill`, "POST", { idempotencyKey: "retry-after-restock" });
  const a = await make([{ productId: scarce.id, quantity: 4 }]), b = await make([{ productId: scarce.id, quantity: 4 }]);
  const raw = (o: any, key: string) => fetch(`${origin}/api/w/${owner.w}/orders/${o.id}/fulfill`, { method: "POST", headers: { cookie: owner.cookie, "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: key }) });
  const competing = await Promise.all([raw(a, "competing-key-a"), raw(b, "competing-key-b")]);
  expect(competing.map(r => r.status).sort()).toEqual([200, 409]);
  expect((await owner.call(`/products/${scarce.id}`)).product.stock).toBe(1);
  const same = await make([{ productId: scarce.id, quantity: 1 }]);
  const sameResults = await Promise.all([raw(same, "concurrent-same-key"), raw(same, "concurrent-same-key")]);
  expect(sameResults.map(r => r.status)).toEqual([200, 200]);
  expect((await Promise.all(sameResults.map(r => r.json()))).map(r => r.replayed).sort()).toEqual([false, true]);
  expect((await owner.call("/stock-movements")).movements.filter((m: any) => m.orderId === same.id).length).toBe(1);
  await owner.call(`/orders/${a.id}/fulfill`, "POST", { idempotencyKey: "original-fulfillment-key" }, 409);
});

test("draft edits refresh snapshots atomically; cancellation, deletion and malformed requests", async () => {
  const draft = (await owner.call("/orders", "POST", { customerId: customer.id, items: [{ productId: product.id, quantity: 1 }] }, 201)).order;
  await owner.call(`/products/${product.id}`, "PATCH", { priceCents: 2699 });
  expect((await owner.call(`/orders/${draft.id}`)).order.totalCents).toBe(2599);
  const edited = (await owner.call(`/orders/${draft.id}`, "PATCH", { customerId: customer.id })).order;
  expect(edited.totalCents).toBe(2699);
  const revision = (await owner.call("/sync")).revision;
  await owner.call(`/orders/${draft.id}`, "PATCH", { customerId: null }, 400);
  await owner.call(`/orders/${draft.id}`, "PATCH", { customerId: "foreign-customer", items: [{ productId: second.id, quantity: 3 }] }, 404);
  expect((await owner.call(`/orders/${draft.id}`)).order).toEqual(edited);
  expect((await owner.call("/sync")).revision).toBe(revision);
  const stock = (await owner.call(`/products/${product.id}`)).product.stock;
  await owner.call(`/orders/${draft.id}/cancel`, "POST", {});
  expect((await owner.call(`/products/${product.id}`)).product.stock).toBe(stock);
  await owner.call(`/orders/${draft.id}`, "DELETE", undefined, 409);
  const removable = (await owner.call("/orders", "POST", { customerId: customer.id, items: [{ productId: product.id, quantity: 1 }] }, 201)).order;
  await owner.call(`/orders/${removable.id}`, "DELETE", undefined, 204);
  const freeProduct = (await owner.call("/products", "POST", { sku: "FREE-999", name: "Unused product", priceCents: 0 }, 201)).product;
  await owner.call(`/products/${freeProduct.id}`, "DELETE", undefined, 204);
  for (const [path, value] of [["/orders?status=", "bad"], ["/invoices?status=", "bad"], ["/tasks?priority=", "bad"], ["/activity?limit=", "0"]]) await owner.call(path + value, "GET", undefined, 400);
  const malformed = await fetch(`${origin}/api/w/${owner.w}/customers`, { method: "POST", headers: { cookie: owner.cookie, "Content-Type": "application/json" }, body: "{broken" });
  expect(malformed.status).toBe(400); expect((await malformed.json()).error.code).toBe("invalid_json");
});

test("invitations, role enforcement, projects, filters and safe comments", async () => {
  await owner.call("/invites", "POST", { email: `jamie-${suffix}@example.invalid`, role: "owner" }, 400);
  invite = (await owner.call("/invites", "POST", { email: `jamie-${suffix}@example.invalid`, role: "member" }, 201)).invite;
  expect(invite.token.length).toBeGreaterThanOrEqual(32);
  expect(Date.parse(invite.expiresAt) - Date.now()).toBeLessThanOrEqual(7 * 86400000);
  expect(JSON.stringify(await owner.call("/invites"))).not.toContain(invite.token);
  await outsider.req("/api/invites/accept", "POST", { token: invite.token }, 404);
  await member.req("/api/invites/accept", "POST", { token: invite.token });
  member.w = owner.w;
  await member.req("/api/invites/accept", "POST", { token: invite.token }, 409);
  const readInvite = (await owner.call("/invites", "POST", { email: `robin-${suffix}@example.invalid`, role: "read_only" }, 201)).invite;
  await reader.req("/api/invites/accept", "POST", { token: readInvite.token }); reader.w = owner.w;
  await owner.call(`/members/${user.id}`, "PATCH", { role: "member" }, 409);
  await owner.call(`/members/${user.id}`, "DELETE", undefined, 409);
  const memberUser = (await member.req("/api/auth/me")).user;
  await owner.call(`/members/${memberUser.id}`, "PATCH", { role: "owner" }, 400);
  await member.call("/products", "POST", { sku: "DENY", name: "Denied", priceCents: 1 }, 403);
  await member.call("/invites", "POST", { email: "deny@example.invalid", role: "member" }, 403);
  await reader.call("/customers", "POST", { name: "Denied" }, 403);
  await reader.call("/import/customers", "POST", { csv: "name,email,company,notes\nDenied,,," }, 403);
  expect(await reader.call("/export.csv?type=products")).toContain("priceCents");
  project = (await member.call("/projects", "POST", { name: "Autumn collection launch", description: "A considered launch, from first sample to final delivery." }, 201)).project;
  task = (await member.call(`/projects/${project.id}/tasks`, "POST", { title: "Prepare launch materials", description: "Bring the collection story to life.", status: "in_progress", priority: "high", assigneeId: memberUser.id, dueDate: "2026-11-12" }, 201)).task;
  const foreignUser = (await outsider.req("/api/auth/me")).user;
  const rev = (await owner.call("/sync")).revision;
  await member.call(`/tasks/${task.id}`, "PATCH", { title: "Should not save", dueDate: "2026-02-30" }, 400);
  await member.call(`/tasks/${task.id}`, "PATCH", { assigneeId: foreignUser.id }, 404);
  expect((await owner.call("/sync")).revision).toBe(rev);
  expect((await owner.call(`/tasks/${task.id}`)).task.title).toBe(task.title);
  expect((await owner.call(`/tasks?q=LAUNCH&status=in_progress&priority=high&assigneeId=${memberUser.id}&projectId=${project.id}`)).tasks.length).toBe(1);
  expect((await owner.call(`/projects/${project.id}/tasks?q=launch&status=done`)).tasks.length).toBe(0);
  await member.call(`/projects/${project.id}/tasks`, "POST", { title: "Confirm packaging samples", priority: "medium", dueDate: "2026-11-08" }, 201);
  await owner.call(`/projects/${project.id}/tasks`, "POST", { title: "Approve collection palette", status: "done", priority: "low", assigneeId: user.id }, 201);
  const comment = (await member.call(`/tasks/${task.id}/comments`, "POST", { body: '<script>window.foundryUnsafe=true</script> Sample review is ready.' }, 201)).comment;
  expect(comment.author.name).toBe("Jamie Park");
  await reader.call(`/tasks/${task.id}/comments`, "POST", { body: "Denied" }, 403);
  await owner.call(`/tasks/${task.id}/comments`, "POST", { body: " " }, 400);
  await owner.call(`/tasks/${task.id}/comments`, "POST", { body: "x".repeat(2001) }, 400);
  const ownerComment = (await owner.call(`/tasks/${task.id}/comments`, "POST", { body: "Ready for the team review." }, 201)).comment;
  await member.call(`/comments/${ownerComment.id}`, "DELETE", undefined, 403);
  await member.call(`/comments/${comment.id}`, "DELETE", undefined, 204);
  await member.call(`/tasks/${task.id}/comments`, "POST", { body: "Samples are looking good. Ready for review." }, 201);
  await owner.call(`/members/${memberUser.id}`, "PATCH", { role: "manager" });
  const managerProduct = (await member.call("/products", "POST", { sku: "MGR-004", name: "Sample swatch pack", priceCents: 999 }, 201)).product;
  await member.call(`/products/${managerProduct.id}`, "DELETE", undefined, 204);
  await owner.call(`/members/${memberUser.id}`, "PATCH", { role: "member" });
});

test("owned files, exact bytes, rejection paths and cascades", async () => {
  const upload = async (client: Client, fileName: string, bytes: string | Uint8Array, entityType = "task", entityId = task.id, status = 201) => {
    const f = new FormData(); f.set("file", new File([bytes], fileName)); f.set("entityType", entityType); f.set("entityId", entityId);
    return client.call("/attachments", "POST", f, status);
  };
  attachment = (await upload(owner, "launch-brief.md", "# Launch brief\n\nSynthetic local attachment.\n")).attachment;
  const download = await fetch(`${origin}/api/w/${owner.w}/attachments/${attachment.id}/download`, { headers: { cookie: member.cookie } });
  expect(download.status).toBe(200); expect(await download.text()).toBe("# Launch brief\n\nSynthetic local attachment.\n");
  await outsider.req(`/api/w/${owner.w}/attachments/${attachment.id}/download`, "GET", undefined, 404);
  await member.call(`/attachments/${attachment.id}`, "DELETE", undefined, 403);
  await upload(reader, "denied.txt", "denied", "task", task.id, 403);
  await upload(owner, "unsafe.html", "<script>bad</script>", "task", task.id, 415);
  await upload(owner, "large.txt", new Uint8Array(2 * 1024 * 1024 + 1), "task", task.id, 413);
  await upload(owner, "foreign.txt", "foreign", "task", "foreign-task", 404);
  const boundary = "foundry-local-boundary";
  const rawMultipart = `--${boundary}\r\nContent-Disposition: form-data; name="entityType"\r\n\r\ntask\r\n--${boundary}\r\nContent-Disposition: form-data; name="entityId"\r\n\r\n${task.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="bad\r\ninjected.txt"\r\nContent-Type: text/plain\r\n\r\nunsafe\r\n--${boundary}--\r\n`;
  const injected = await fetch(`${origin}/api/w/${owner.w}/attachments`, { method: "POST", headers: { cookie: owner.cookie, "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: rawMultipart });
  expect(injected.status).toBe(400);
  const traversal = await upload(owner, "../../safe.txt", "Owned path only.");
  expect(traversal.attachment.fileName).toBe("safe.txt");
  await owner.call(`/attachments/${traversal.attachment.id}`, "DELETE", undefined, 204);
  await owner.call(`/attachments/${traversal.attachment.id}/download`, "GET", undefined, 404);
  const tempProject = (await owner.call("/projects", "POST", { name: "Cascade test" }, 201)).project;
  const tempTask = (await owner.call(`/projects/${tempProject.id}/tasks`, "POST", { title: "Temporary" }, 201)).task;
  const directlyDeleted = (await owner.call(`/projects/${tempProject.id}/tasks`, "POST", { title: "Direct deletion" }, 201)).task;
  await owner.call(`/tasks/${directlyDeleted.id}`, "DELETE", undefined, 204);
  const tempAttachment = (await upload(owner, "temporary.txt", "temporary", "task", tempTask.id)).attachment;
  await owner.call(`/tasks/${tempTask.id}/comments`, "POST", { body: "Temporary comment" }, 201);
  await owner.call(`/projects/${tempProject.id}`, "DELETE", undefined, 204);
  await owner.call(`/tasks/${tempTask.id}`, "GET", undefined, 404);
  await owner.call(`/attachments/${tempAttachment.id}/download`, "GET", undefined, 404);
  expect(await Bun.file(join(process.env.DATA_DIR!, "attachments", tempAttachment.id)).exists()).toBe(false);
  for (const type of ["customers", "products", "orders", "invoices", "tasks"]) expect(typeof await owner.call(`/export.csv?type=${type}`)).toBe("string");
  const activity = (await owner.call("/activity?limit=500")).activity;
  for (const action of ["customer.created", "stock.adjusted", "order.fulfilled", "invoice.paid", "task.created", "comment.created", "attachment.created"]) expect(activity.some((a: any) => a.action === action)).toBe(true);
  expect(JSON.stringify(activity)).not.toContain(invite.token);
  const summary = await owner.call("/summary");
  const outsiderRevision = (await outsider.call("/sync")).revision;
  await owner.call(`/tasks/${task.id}`, "PATCH", { description: "Bring the collection story to life. Team review on Thursday." });
  expect((await outsider.call("/sync")).revision).toBe(outsiderRevision);
  await Bun.write(join(process.env.DATA_DIR!, "verification-state.json"), JSON.stringify({ cookie: owner.cookie, w: owner.w, user, customer, product, order, invoice, project, task, attachment, summary: await owner.call("/summary"), revision: (await owner.call("/sync")).revision, memberCookie: member.cookie, readerCookie: reader.cookie }));
  expect(summary.customers).toBe(3);
});

test("membership revocation applies immediately to data, downloads and sync", async () => {
  const readUser = (await reader.req("/api/auth/me")).user;
  await owner.call(`/members/${readUser.id}`, "DELETE", undefined, 204);
  await reader.call("/customers", "GET", undefined, 404);
  await reader.call(`/attachments/${attachment.id}/download`, "GET", undefined, 404);
  await reader.call("/sync", "GET", undefined, 404);
  await reader.call("/activity", "GET", undefined, 404);
  expect((await reader.req("/api/workspaces")).workspaces.some((w: any) => w.id === owner.w)).toBe(false);
  // Persist the final revision, after the revocation.
  const file = join(process.env.DATA_DIR!, "verification-state.json");
  const state = await Bun.file(file).json(); state.revision = (await owner.call("/sync")).revision;
  await Bun.write(file, JSON.stringify(state));
});
