import { join, resolve, extname } from "node:path";
import { writeFileSync } from "node:fs";
import { db, dataDir, one, all, run, list, get, save, remove, unlinkOwned, id, token, now, fail, ApiError, text, integer, choice, fields, email, event, memberships, makeWorkspace, parseCSV, csvCell, type Row } from "./store";

const json = (data: any, status = 200, headers: HeadersInit = {}) => Response.json(data, { status, headers });
const empty = () => new Response(null, { status: 204 });
const safeUser = (u: Row) => ({ id: u.id, name: u.name, email: u.email });
const roles = ["manager", "member", "read_only"];
const statuses = ["todo", "in_progress", "done"];
const priorities = ["low", "medium", "high"];
const cookie = (session: string, clear = false) => ({ "Set-Cookie": `foundry_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${clear ? 0 : 2592000}` });
function userFor(req: Request) {
  const session = req.headers.get("cookie")?.match(/(?:^|;\s*)foundry_session=([^;]+)/)?.[1];
  const user = session && one("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?", session, now());
  if (!user) fail(401, "unauthenticated", "Please sign in to continue.");
  return user;
}
function sessionFor(userId: string) {
  const value = token();
  run("INSERT INTO sessions VALUES(?,?,?)", value, userId, new Date(Date.now() + 30 * 86400000).toISOString());
  return value;
}
async function body(req: Request) {
  try {
    const b = await req.json();
    if (!b || typeof b !== "object" || Array.isArray(b)) fail(400, "invalid_json", "A JSON object is required.");
    return b as Row;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    fail(400, "invalid_json", "The request must contain valid JSON.");
  }
}
function customerData(b: Row, old?: Row) {
  fields(b, ["name", "email", "company", "notes"]);
  const out = { ...old };
  for (const key of ["name", "email", "company", "notes"]) {
    if (key in b || !old) out[key] = key === "email" ? email(b[key] ?? "") : text(b[key] ?? "", key, key === "name");
  }
  return out;
}
function uniqueCustomer(w: string, c: Row, additional: Row[] = []) {
  if (c.email && [...list(w, "customer"), ...additional].some(r => r.id !== c.id && r.email.toLowerCase() === c.email.toLowerCase()))
    fail(409, "duplicate_email", "This email already belongs to a customer in this workspace.");
}
function productData(b: Row, old?: Row) {
  fields(b, ["sku", "name", "description", "priceCents"]);
  const out = { ...old };
  for (const key of ["sku", "name", "description", "priceCents"]) {
    if (key in b || !old) out[key] = key === "priceCents" ? integer(b[key], key, 0, 100000000) : text(b[key] ?? "", key, key !== "description");
  }
  out.sku = out.sku.trim().toUpperCase();
  return out;
}
function orderData(w: string, b: Row, old?: Row) {
  fields(b, ["customerId", "items"]);
  const customerId = "customerId" in b ? b.customerId : old?.customerId;
  get(w, "customer", text(customerId, "Customer", true));
  let items = old?.items;
  if ("items" in b || !old) {
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 50) fail(400, "invalid_items", "An order needs 1 to 50 distinct products.");
    const seen = new Set<string>();
    items = b.items.map((line: Row) => {
      fields(line, ["productId", "quantity"]);
      const p = get(w, "product", text(line.productId, "Product", true));
      if (seen.has(p.id)) fail(400, "duplicate_product", "Add each product only once.");
      seen.add(p.id);
      const quantity = integer(line.quantity, "Quantity", 1, 10000);
      return { productId: p.id, sku: p.sku, name: p.name, unitPriceCents: p.priceCents, quantity, lineTotalCents: p.priceCents * quantity };
    });
  } else {
    // An explicit draft edit refreshes all catalog snapshots.
    items = items.map((l: Row) => {
      const p = get(w, "product", l.productId);
      return { ...l, sku: p.sku, name: p.name, unitPriceCents: p.priceCents, lineTotalCents: p.priceCents * l.quantity };
    });
  }
  return { ...old, customerId, items, totalCents: items.reduce((sum: number, l: Row) => sum + l.lineTotalCents, 0) };
}
function taskData(w: string, b: Row, old?: Row) {
  fields(b, ["title", "description", "status", "priority", "assigneeId", "dueDate"]);
  const out: Row = { title: "", description: "", status: "todo", priority: "medium", assigneeId: null, dueDate: null, ...old };
  for (const k of ["title", "description"]) if (k in b || !old) out[k] = text(b[k] ?? "", k, k === "title");
  if ("status" in b) out.status = choice(b.status, "status", statuses);
  if ("priority" in b) out.priority = choice(b.priority, "priority", priorities);
  if ("assigneeId" in b) {
    if (b.assigneeId !== null && (typeof b.assigneeId !== "string" || !one("SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?", w, b.assigneeId))) fail(404, "assignee_not_found", "The assignee is not a workspace member.");
    out.assigneeId = b.assigneeId;
  }
  if ("dueDate" in b) {
    if (b.dueDate !== null && (typeof b.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.dueDate) || Number.isNaN(Date.parse(b.dueDate)) || new Date(b.dueDate).toISOString().slice(0, 10) !== b.dueDate))
      fail(400, "invalid_date", "Due date must be a valid YYYY-MM-DD date.");
    out.dueDate = b.dueDate;
  }
  return out;
}
function workspaceRoute(req: Request, url: URL, w: string, path: string, user: Row, b: Row, upload?: { file: File; entityType: string; entityId: string; bytes: Uint8Array }) : Response {
  const member = one("SELECT role FROM memberships WHERE workspace_id=? AND user_id=?", w, user.id);
  if (!member) fail(404, "workspace_not_found", "Workspace not found.");
  const role = member.role;
  const method = req.method;
  const write = method !== "GET";
  const permit = (level: "owner" | "manager" | "member") => {
    if (level === "owner" ? role !== "owner" : level === "manager" ? !["owner", "manager"].includes(role) : role === "read_only")
      fail(403, "forbidden", "Your workspace role does not allow this action.");
  };
  const audit = (action: string, kind: string, key: string) => event(w, user, action, kind, key);
  const q = (url.searchParams.get("q") || "").toLowerCase();
  const segments = path.split("/").filter(Boolean);
  const [collection, key, sub] = segments;
  if (path === "/sync" && method === "GET") return json({ revision: one("SELECT revision FROM workspaces WHERE id=?", w)!.revision });
  if (path === "/summary" && method === "GET") {
    const products = list(w, "product"), orders = list(w, "order"), invoices = list(w, "invoice"), tasks = list(w, "task");
    return json({
      customers: list(w, "customer").length, products: products.length,
      lowStockProducts: products.filter(p => p.stock <= 5).length,
      openOrders: orders.filter(o => o.status === "draft").length, fulfilledOrders: orders.filter(o => o.status === "fulfilled").length,
      revenueCents: invoices.filter(i => i.status === "paid").reduce((s, i) => s + i.totalCents, 0),
      unpaidCents: invoices.filter(i => ["draft", "sent"].includes(i.status)).reduce((s, i) => s + i.totalCents, 0),
      openTasks: tasks.filter(t => t.status !== "done").length, completedTasks: tasks.filter(t => t.status === "done").length,
    });
  }
  if (path === "/activity" && method === "GET") {
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
    integer(limit, "Limit", 1, 500);
    return json({ activity: all("SELECT id,action,entity_type AS entityType,entity_id AS entityId,actor_id AS actorId,actor_name AS actorName,created_at AS createdAt FROM activity WHERE workspace_id=? ORDER BY rowid DESC LIMIT ?", w, limit) });
  }
  if (collection === "members") {
    if (method === "GET" && !key) return json({ members: all("SELECT u.id AS userId,u.name,u.email,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=? ORDER BY m.rowid", w) });
    if (key && ["PATCH", "DELETE"].includes(method)) {
      permit("owner");
      if (!one("SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?", w, key)) fail(404, "not_found", "Member not found.");
      if (one("SELECT owner_id FROM workspaces WHERE id=?", w)!.owner_id === key) fail(409, "original_owner", "The original owner cannot be removed or demoted.");
      if (method === "PATCH") {
        fields(b, ["role"]);
        const newRole = choice(b.role, "role", roles);
        run("UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?", newRole, w, key);
        audit("member.updated", "member", key);
        return json({ member: { ...one("SELECT id AS userId,name,email FROM users WHERE id=?", key), role: newRole } });
      }
      run("DELETE FROM memberships WHERE workspace_id=? AND user_id=?", w, key);
      // Unassign removed members without leaving invalid references.
      for (const task of list(w, "task").filter(t => t.assigneeId === key)) save(w, "task", { ...task, assigneeId: null, updatedAt: now() });
      audit("member.removed", "member", key);
      return empty();
    }
  }
  if (path === "/invites") {
    permit("owner");
    if (method === "GET") return json({ invites: all("SELECT id,email,role,expires_at AS expiresAt,consumed FROM invites WHERE workspace_id=?", w) });
    if (method === "POST") {
      fields(b, ["email", "role"]);
      const invite = { id: id(), email: email(b.email, true), role: choice(b.role, "role", roles), token: token(), expiresAt: new Date(Date.now() + 7 * 86400000 - 60000).toISOString() };
      run("INSERT INTO invites VALUES(?,?,?,?,?,?,0)", invite.id, w, invite.email, invite.role, invite.token, invite.expiresAt);
      audit("invite.created", "invite", invite.id);
      return json({ invite }, 201);
    }
  }
  if (path === "/import/customers" && method === "POST") {
    permit("member"); fields(b, ["csv"]);
    if (typeof b.csv !== "string" || Buffer.byteLength(b.csv) > 1048576) fail(400, "invalid_csv", "CSV must be a string of at most 1MB.");
    const rows = parseCSV(b.csv.replace(/^\uFEFF/, ""));
    if (JSON.stringify(rows.shift()) !== JSON.stringify(["name", "email", "company", "notes"]) || rows.length > 200) fail(400, "invalid_csv", "Use the exact name,email,company,notes header and at most 200 rows.");
    const customers: Row[] = [];
    for (const r of rows) {
      if (r.length !== 4) fail(400, "invalid_csv", "Each CSV row must have four fields.");
      const c = { ...customerData(Object.fromEntries(["name", "email", "company", "notes"].map((k, i) => [k, r[i]]))), id: id(), createdAt: now(), updatedAt: now() };
      uniqueCustomer(w, c, customers); customers.push(c);
    }
    for (const c of customers) { save(w, "customer", c); audit("customer.created", "customer", c.id); }
    return json({ imported: customers.length }, 201);
  }
  if (path === "/export.csv" && method === "GET") {
    const type = choice(url.searchParams.get("type"), "export type", ["customers", "products", "orders", "invoices", "tasks"]);
    const headers: Record<string, string[]> = {
      customers: ["id", "name", "email", "company", "notes"], products: ["id", "sku", "name", "description", "priceCents", "stock"],
      orders: ["id", "number", "customerId", "status", "totalCents"], invoices: ["id", "number", "orderId", "status", "totalCents"],
      tasks: ["id", "projectId", "title", "description", "status", "priority", "assigneeId", "dueDate"],
    };
    const h = headers[type];
    const csv = [h.join(","), ...list(w, type.slice(0, -1)).map(r => h.map(k => csvCell(r[k])).join(","))].join("\r\n");
    return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${type}.csv"` } });
  }
  if (collection === "attachments") {
    if (method === "POST" && !key) {
      permit("member");
      if (!upload) fail(400, "invalid_file", "Choose an attachment.");
      const { file, entityType, entityId, bytes } = upload;
      choice(entityType, "entity type", ["customer", "order", "task"]);
      get(w, entityType, entityId);
      const fileName = file.name.split(/[\\/]/).pop() || "";
      if (!fileName || /[\r\n]/.test(fileName) || fileName === "." || fileName === "..") fail(400, "invalid_filename", "Invalid attachment filename.");
      if (file.size > 2 * 1024 * 1024) fail(413, "file_too_large", "Attachments must be at most 2 MiB.");
      const mimeTypes: Record<string, string> = { ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
      const mimeType = mimeTypes[extname(fileName).toLowerCase()];
      if (!mimeType) fail(415, "unsupported_file", "Use a TXT, MD, CSV, PDF, PNG or JPEG file.");
      const attachment = { id: id(), entityType, entityId, fileName, size: file.size, mimeType, createdBy: user.id, createdAt: now() };
      writeFileSync(join(dataDir, "attachments", attachment.id), bytes);
      save(w, "attachment", attachment); audit("attachment.created", "attachment", attachment.id);
      return json({ attachment }, 201);
    }
    if (method === "GET" && !key) {
      const entityType = choice(url.searchParams.get("entityType"), "entity type", ["customer", "order", "task"]);
      const entityId = url.searchParams.get("entityId") || ""; get(w, entityType, entityId);
      return json({ attachments: list(w, "attachment").filter(a => a.entityType === entityType && a.entityId === entityId) });
    }
    if (key) {
      const a = get(w, "attachment", key);
      if (method === "GET" && sub === "download") {
        const fallback = a.fileName.replace(/[^\x20-\x7E]|["\\]/g, "_");
        return new Response(Bun.file(join(dataDir, "attachments", a.id)), { headers: { "Content-Type": a.mimeType, "Content-Disposition": `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(a.fileName)}`, "X-Content-Type-Options": "nosniff" } });
      }
      if (method === "DELETE" && !sub) {
        permit("member");
        if (!["owner", "manager"].includes(role) && a.createdBy !== user.id) fail(403, "forbidden", "Only the author or a manager may delete this attachment.");
        unlinkOwned(a.id); remove(w, "attachment", a.id); audit("attachment.deleted", "attachment", a.id); return empty();
      }
    }
  }
  if (collection === "comments" && key && method === "DELETE" && !sub) {
    permit("member"); const comment = get(w, "comment", key);
    if (!["owner", "manager"].includes(role) && comment.author.id !== user.id) fail(403, "forbidden", "Only the author or a manager may delete this comment.");
    remove(w, "comment", key); audit("comment.deleted", "comment", key); return empty();
  }
  if (collection === "stock-movements" && !key) {
    if (method === "GET") {
      const productId = url.searchParams.get("productId");
      if (productId) get(w, "product", productId);
      return json({ movements: list(w, "movement").filter(m => !productId || m.productId === productId) });
    }
    if (method === "POST") {
      permit("manager"); fields(b, ["productId", "delta", "reason"]);
      const p = get(w, "product", text(b.productId, "Product", true));
      const delta = integer(b.delta, "Delta", -1000000000, 1000000000);
      if (!delta) fail(400, "invalid_delta", "Quantity change cannot be zero.");
      const reason = text(b.reason, "Reason", true);
      if (p.stock + delta < 0 || p.stock + delta > 1000000000) fail(409, "stock_conflict", "This change would put stock outside its allowed range.");
      const movement = { id: id(), productId: p.id, delta, reason, kind: "adjustment", orderId: null, createdBy: user.id, createdAt: now() };
      const product = save(w, "product", { ...p, stock: p.stock + delta, updatedAt: now() });
      save(w, "movement", movement); audit("stock.adjusted", "product", p.id); return json({ movement, product }, 201);
    }
  }
  if (collection === "projects" && key && sub === "tasks") {
    get(w, "project", key);
    if (method === "GET") return json({ tasks: filterTasks(w, url, key) });
    if (method === "POST") {
      permit("member");
      const task = { ...taskData(w, b), id: id(), projectId: key, createdAt: now(), updatedAt: now() };
      save(w, "task", task); audit("task.created", "task", task.id); return json({ task }, 201);
    }
  }
  if (collection === "tasks" && key && sub === "comments") {
    get(w, "task", key);
    if (method === "GET") return json({ comments: list(w, "comment").filter(c => c.taskId === key).reverse() });
    if (method === "POST") {
      permit("member"); fields(b, ["body"]);
      const comment = { id: id(), taskId: key, body: text(b.body, "Comment", true, 2000), author: { id: user.id, name: user.name }, createdAt: now() };
      save(w, "comment", comment); audit("comment.created", "comment", comment.id); return json({ comment }, 201);
    }
  }
  if (collection === "orders" && key && sub) {
    if (method !== "POST") fail(404, "not_found", "Endpoint not found.");
    permit("manager"); let order = get(w, "order", key);
    if (sub === "cancel") {
      fields(b, []);
      if (order.status !== "draft") fail(409, "order_state", "Only a draft order can be cancelled.");
      order = save(w, "order", { ...order, status: "cancelled", updatedAt: now() });
      audit("order.cancelled", "order", key); return json({ order });
    }
    if (sub === "fulfill") {
      fields(b, ["idempotencyKey"]);
      const idem = text(b.idempotencyKey, "Idempotency key", true, 100);
      if (idem.length < 8) fail(400, "invalid_key", "Idempotency key must have 8 to 100 characters.");
      const prior = one("SELECT * FROM idempotency WHERE workspace_id=? AND key=?", w, idem);
      if (prior) {
        if (prior.order_id !== key) fail(409, "key_conflict", "This key was used for a different order.");
        return json({ order: JSON.parse(prior.result), replayed: true });
      }
      if (order.status !== "draft") fail(409, "order_state", "Only a draft order can be fulfilled.");
      const products = order.items.map((line: Row) => {
        const p = get(w, "product", line.productId);
        if (p.stock < line.quantity) fail(409, "insufficient_stock", `Not enough stock for ${p.sku}. Receive more stock and retry.`);
        return p;
      });
      order.items.forEach((line: Row, i: number) => {
        save(w, "product", { ...products[i], stock: products[i].stock - line.quantity, updatedAt: now() });
        save(w, "movement", { id: id(), productId: line.productId, delta: -line.quantity, reason: `Fulfilled ${order.number}`, kind: "fulfillment", orderId: key, createdBy: user.id, createdAt: now() });
      });
      order = save(w, "order", { ...order, status: "fulfilled", fulfilledAt: now(), updatedAt: now() });
      run("INSERT INTO idempotency VALUES(?,?,?,?)", w, idem, key, JSON.stringify(order));
      audit("order.fulfilled", "order", key); return json({ order, replayed: false });
    }
  }
  const kinds: Record<string, string> = { customers: "customer", products: "product", orders: "order", invoices: "invoice", projects: "project", tasks: "task" };
  const kind = kinds[collection];
  if (kind && !sub && segments.length <= 2) {
    if (write) permit(["product", "order", "invoice"].includes(kind) ? "manager" : "member");
    if (method === "GET") {
      if (key) return json({ [kind]: get(w, kind, key) });
      let rows = kind === "task" ? filterTasks(w, url) : list(w, kind);
      if (["customer", "product"].includes(kind)) rows = rows.filter(r => [r.name, r.email, r.company, r.sku, r.description].some(v => typeof v === "string" && v.toLowerCase().includes(q)));
      if (["order", "invoice"].includes(kind) && url.searchParams.get("status")) {
        const status = choice(url.searchParams.get("status"), "status", kind === "order" ? ["draft", "fulfilled", "cancelled"] : ["draft", "sent", "paid", "void"]);
        rows = rows.filter(r => r.status === status);
      }
      return json({ [collection]: rows });
    }
    if (method === "POST" && !key) {
      let record: Row;
      const base = { id: id(), createdAt: now(), updatedAt: now() };
      if (kind === "customer") {
        record = { ...customerData(b), ...base }; uniqueCustomer(w, record);
      } else if (kind === "product") {
        record = { ...productData(b), ...base, stock: 0 };
        if (list(w, kind).some(p => p.sku === record.sku)) fail(409, "duplicate_sku", "This SKU already exists in this workspace.");
      } else if (kind === "order") {
        record = { ...orderData(w, b), ...base, status: "draft", fulfilledAt: null };
        run("UPDATE workspaces SET order_sequence=order_sequence+1 WHERE id=?", w);
        record.number = `ORD-${String(one("SELECT order_sequence FROM workspaces WHERE id=?", w)!.order_sequence).padStart(6, "0")}`;
      } else if (kind === "invoice") {
        fields(b, ["orderId"]); const o = get(w, "order", text(b.orderId, "Order", true));
        if (o.status !== "fulfilled") fail(409, "order_state", "Fulfill the order before creating an invoice.");
        if (list(w, kind).some(i => i.orderId === o.id)) fail(409, "duplicate_invoice", "An invoice already exists for this order.");
        const c = get(w, "customer", o.customerId);
        run("UPDATE workspaces SET invoice_sequence=invoice_sequence+1 WHERE id=?", w);
        record = { id: base.id, createdAt: base.createdAt, number: `INV-${String(one("SELECT invoice_sequence FROM workspaces WHERE id=?", w)!.invoice_sequence).padStart(6, "0")}`,
          orderId: o.id, customerId: o.customerId, billTo: { name: c.name, email: c.email, company: c.company }, status: "draft", currency: "USD",
          items: o.items, subtotalCents: o.totalCents, totalCents: o.totalCents, paidAt: null };
      } else if (kind === "project") {
        fields(b, ["name", "description"]); record = { ...base, name: text(b.name, "Project name", true), description: text(b.description ?? "", "Description") };
      } else fail(404, "not_found", "Create tasks within a project.");
      save(w, kind, record); audit(`${kind}.created`, kind, record.id); return json({ [kind]: record }, 201);
    }
    if (key && method === "PATCH") {
      const old = get(w, kind, key); let record: Row;
      if (kind === "customer") { record = customerData(b, old); uniqueCustomer(w, record); }
      else if (kind === "product") {
        record = productData(b, old);
        if (list(w, kind).some(p => p.id !== key && p.sku === record.sku)) fail(409, "duplicate_sku", "This SKU already exists.");
      } else if (kind === "order") {
        if (old.status !== "draft") fail(409, "order_state", "Only a draft can be edited.");
        record = orderData(w, b, old);
      } else if (kind === "invoice") {
        fields(b, ["status"]);
        const status = choice(b.status, "status", ["sent", "paid", "void"]);
        if (!(old.status === "draft" && ["sent", "void"].includes(status) || old.status === "sent" && ["paid", "void"].includes(status))) fail(409, "invoice_state", "This invoice status transition is not allowed.");
        record = { ...old, status, paidAt: status === "paid" ? now() : null };
        save(w, kind, record); audit(`invoice.${status}`, kind, key); return json({ invoice: record });
      } else if (kind === "task") record = taskData(w, b, old);
      else {
        fields(b, ["name", "description"]); record = { ...old };
        if ("name" in b) record.name = text(b.name, "Project name", true);
        if ("description" in b) record.description = text(b.description, "Description");
      }
      record.updatedAt = now(); save(w, kind, record); audit(`${kind}.updated`, kind, key); return json({ [kind]: record });
    }
    if (key && method === "DELETE") {
      const old = get(w, kind, key);
      if (kind === "invoice") fail(404, "not_found", "Invoices cannot be deleted.");
      if (kind === "customer" && [...list(w, "order"), ...list(w, "invoice")].some(r => r.customerId === key)) fail(409, "customer_in_use", "This customer is referenced by an order or invoice.");
      if (kind === "product" && (list(w, "movement").some(m => m.productId === key) || list(w, "order").some(o => o.items.some((l: Row) => l.productId === key)))) fail(409, "product_in_use", "This product has stock history or order lines.");
      if (kind === "order" && old.status !== "draft") fail(409, "order_state", "Only draft orders can be deleted.");
      const deleteTask = (taskId: string) => {
        for (const c of list(w, "comment").filter(c => c.taskId === taskId)) remove(w, "comment", c.id);
        remove(w, "task", taskId);
      };
      if (kind === "project") for (const t of list(w, "task").filter(t => t.projectId === key)) deleteTask(t.id);
      if (kind === "task") deleteTask(key); else remove(w, kind, key);
      audit(`${kind}.deleted`, kind, key); return empty();
    }
  }
  fail(404, "not_found", "API endpoint not found.");
}
function filterTasks(w: string, url: URL, projectId?: string) {
  let rows = list(w, "task");
  const q = (url.searchParams.get("q") || "").toLowerCase();
  const status = url.searchParams.get("status"), priority = url.searchParams.get("priority"), assignee = url.searchParams.get("assigneeId");
  projectId ||= url.searchParams.get("projectId") || undefined;
  if (projectId) get(w, "project", projectId);
  if (status) choice(status, "status", statuses);
  if (priority) choice(priority, "priority", priorities);
  return rows.filter(t => (!projectId || t.projectId === projectId) && (!q || `${t.title} ${t.description}`.toLowerCase().includes(q)) &&
    (!status || t.status === status) && (!priority || t.priority === priority) && (!assignee || t.assigneeId === assignee));
}
async function api(req: Request, url: URL) {
  const path = url.pathname;
  if (path === "/api/health" && req.method === "GET") return json({ ok: true });
  if (path === "/api/auth/signup" && req.method === "POST") {
    const b = await body(req); fields(b, ["name", "email", "password"]);
    const name = text(b.name, "Name", true, 200), address = email(b.email, true);
    if (typeof b.password !== "string" || b.password.length < 12 || b.password.length > 256) fail(400, "invalid_password", "Password must contain 12 to 256 characters.");
    const hash = await Bun.password.hash(b.password, { algorithm: "argon2id" });
    return db.transaction(() => {
      if (one("SELECT 1 FROM users WHERE email=?", address)) fail(409, "duplicate_email", "An account with this email already exists.");
      const user = { id: id(), name, email: address };
      run("INSERT INTO users(id,name,email,password_hash) VALUES(?,?,?,?)", user.id, name, address, hash);
      const workspace = makeWorkspace(`${name} workspace`, user.id);
      return json({ user, workspace }, 201, cookie(sessionFor(user.id)));
    }).immediate();
  }
  if (path === "/api/auth/login" && req.method === "POST") {
    const b = await body(req); fields(b, ["email", "password"]);
    const address = email(b.email, true);
    const user = one("SELECT * FROM users WHERE email=?", address);
    if (typeof b.password !== "string" || !user || !await Bun.password.verify(b.password, user.password_hash)) fail(401, "invalid_credentials", "Email or password is incorrect.");
    return json({ user: safeUser(user) }, 200, cookie(sessionFor(user.id)));
  }
  const knownGlobal = ["/api/auth/me", "/api/auth/logout", "/api/workspaces", "/api/invites/accept"];
  if (!path.startsWith("/api/w/") && !knownGlobal.includes(path) && !/^\/api\/workspaces\/[^/]+\/select$/.test(path)) fail(404, "not_found", "API endpoint not found.");
  const user = userFor(req);
  if (path === "/api/auth/me" && req.method === "GET") {
    const ws = memberships(user.id);
    return json({ user: safeUser(user), activeWorkspaceId: ws.find(w => w.id === user.active_workspace_id)?.id ?? ws[0]?.id ?? null, workspaces: ws });
  }
  if (path === "/api/auth/logout" && req.method === "POST") {
    const session = req.headers.get("cookie")?.match(/(?:^|;\s*)foundry_session=([^;]+)/)?.[1];
    run("DELETE FROM sessions WHERE id=?", session); return new Response(null, { status: 204, headers: cookie("", true) });
  }
  if (path === "/api/workspaces") {
    if (req.method === "GET") return json({ workspaces: memberships(user.id) });
    if (req.method === "POST") {
      const b = await body(req); fields(b, ["name"]);
      return db.transaction(() => json({ workspace: makeWorkspace(text(b.name, "Workspace name", true, 200), user.id) }, 201)).immediate();
    }
  }
  const select = path.match(/^\/api\/workspaces\/([^/]+)\/select$/);
  if (select && req.method === "POST") {
    const workspace = memberships(user.id).find(w => w.id === select[1]);
    if (!workspace) fail(404, "not_found", "Workspace not found.");
    run("UPDATE users SET active_workspace_id=? WHERE id=?", workspace.id, user.id); return json({ workspace });
  }
  if (path === "/api/invites/accept" && req.method === "POST") {
    const b = await body(req); fields(b, ["token"]); text(b.token, "Invite token", true, 200);
    return db.transaction(() => {
      const inv = one("SELECT * FROM invites WHERE token=? AND email=?", b.token, user.email);
      if (!inv) fail(404, "not_found", "Invite not found for this email.");
      if (inv.consumed) fail(409, "invite_consumed", "This invite has already been used.");
      if (inv.expires_at <= now()) fail(404, "invite_expired", "This invite has expired.");
      if (one("SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?", inv.workspace_id, user.id)) fail(409, "already_member", "You are already a member of this workspace.");
      run("INSERT INTO memberships VALUES(?,?,?)", inv.workspace_id, user.id, inv.role);
      run("UPDATE invites SET consumed=1 WHERE id=?", inv.id);
      run("UPDATE users SET active_workspace_id=? WHERE id=?", inv.workspace_id, user.id);
      event(inv.workspace_id, user, "member.joined", "member", user.id);
      return json({ workspace: memberships(user.id).find(w => w.id === inv.workspace_id) });
    }).immediate();
  }
  const match = path.match(/^\/api\/w\/([^/]+)(\/.*)$/);
  if (match) {
    let upload: { file: File; entityType: string; entityId: string; bytes: Uint8Array } | undefined;
    let b: Row = {};
    // Authenticate before parsing uploads; never allow an outsider to write a file.
    if (!one("SELECT 1 FROM memberships WHERE workspace_id=? AND user_id=?", match[1], user.id)) fail(404, "not_found", "Workspace not found.");
    if (path.endsWith("/attachments") && req.method === "POST") {
      if (Number(req.headers.get("content-length")) > 3 * 1024 * 1024) fail(413, "file_too_large", "Attachments must be at most 2 MiB.");
      const contentType = req.headers.get("content-type") || "";
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
      const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
      if (!contentType.toLowerCase().startsWith("multipart/form-data") || !boundary || boundary.length > 200) fail(400, "invalid_multipart", "A multipart file upload is required.");
      const rawBody = await req.arrayBuffer();
      if (rawBody.byteLength > 3 * 1024 * 1024) fail(413, "file_too_large", "Attachments must be at most 2 MiB.");
      // Validate original headers before the platform parser can normalize filenames.
      const raw = Buffer.from(rawBody).toString("latin1");
      for (const part of raw.split(`--${boundary}`).slice(1)) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd < 0) continue;
        const headers = part.slice(0, headerEnd);
        const filename = headers.match(/;\s*filename\s*=\s*"([^"]*)"/i)?.[1];
        if (filename && /[\r\n]/.test(filename)) fail(400, "invalid_filename", "Attachment filenames cannot contain CR or LF.");
      }
      let form: FormData;
      try { form = await new Response(rawBody, { headers: { "Content-Type": contentType } }).formData(); } catch { fail(400, "invalid_multipart", "A multipart file upload is required."); }
      const file = form.get("file");
      if (!(file instanceof File)) fail(400, "invalid_file", "Choose an attachment.");
      if (file.size > 2 * 1024 * 1024) fail(413, "file_too_large", "Attachments must be at most 2 MiB.");
      upload = { file, entityType: String(form.get("entityType") ?? ""), entityId: String(form.get("entityId") ?? ""), bytes: new Uint8Array(await file.arrayBuffer()) };
    } else if (["POST", "PATCH"].includes(req.method)) b = await body(req);
    return db.transaction(() => workspaceRoute(req, url, match[1], match[2], user, b, upload)).immediate();
  }
  fail(404, "not_found", "API endpoint not found.");
}

const dist = resolve("dist");
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.PORT || 3000), maxRequestBodySize: 5 * 1024 * 1024,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return await api(req, url);
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Not found", { status: 404 });
      const requested = resolve(dist, "." + decodeURIComponent(url.pathname));
      if (!requested.startsWith(dist + "/") && !requested.startsWith(dist + "\\") && requested !== dist) return new Response("Not found", { status: 404 });
      const file = Bun.file(requested);
      const isFile = extname(requested) && await file.exists();
      return new Response(isFile ? file : Bun.file(join(dist, "index.html")), { headers: {
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'",
      } });
    } catch (e) {
      if (e instanceof ApiError) return json({ error: { code: e.code, message: e.message } }, e.status);
      console.error("Request failed", e instanceof Error ? e.message : "Unknown error");
      return json({ error: { code: "internal_error", message: "Something went wrong. Please try again." } }, 500);
    }
  },
});
console.log(`Foundry listening on http://127.0.0.1:${server.port}`);
