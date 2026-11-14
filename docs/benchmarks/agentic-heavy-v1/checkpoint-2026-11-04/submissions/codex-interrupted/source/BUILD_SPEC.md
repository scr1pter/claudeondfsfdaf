# Foundry — business operations, together

Build a complete, polished **Foundry** business-operations SaaS prototype from this empty scaffold. It connects customers, inventory, orders, invoicing and project delivery in one coherent workspace. This is a substantial single-product build, not a collection of mock screens. Build all application code yourself; no implementation is provided. Finish and verify useful behavior; do not spend the task allowance merely to exhaust it.

This is a functional prototype, not a production-readiness claim. All people/data must be synthetic (`example.invalid` email addresses). No external services, deployment, payments, SMTP, customer APIs or telemetry. All fonts/assets/code must load locally. Do not inspect benchmark tools or other applications outside this workspace.

## Runtime and delivery

- Use the pinned React/TypeScript/Vite and Bun dependencies already supplied. Use `bun:sqlite` and a Bun HTTP server; avoid additional dependencies. You may implement CSV parsing yourself.
- `bun run typecheck` checks real frontend/backend TypeScript; `bun run build` builds the actual frontend; `bun run start` serves the built frontend and API from **one origin**, listening on `127.0.0.1`, `PORT` (default3000).
- Store everything durably under `DATA_DIR` (default `.foundry-data`): database **`foundry.sqlite`** and owned attachment files. Accounts, memberships, records, idempotency results and files survive server restart. No in-memory replacement for persisted business data.
- Support direct navigation to frontend routes and return JSON errors for unknown `/api` routes. `GET /api/health` returns200 `{ "ok": true }`.
- Stop verification servers before finishing. Use only isolated/headless browser profiles. `PLAYWRIGHT_MODULE`, `CHROME_PATH`, and `NODE_EXE`, when present, identify installed browser tooling. Do not use an existing signed-in browser profile.

## Shared API conventions

All endpoints below are required. JSON fields use camelCase. IDs are opaque strings; timestamps are ISO8601 strings with a UTC offset (for example the JavaScript `Date.toISOString()` format). Singular responses are `{customer}`, `{product}`, `{order}`, etc.; lists are `{customers:[...]}`, `{products:[...]}`, etc. Creation returns201, reads/updates200, deletion/logout204 with no body. Error bodies are `{ "error": { "code": "...", "message": "..." } }` with a nonempty code/message. Use400 for malformed/invalid input,401 for missing/bad authentication,403 for a member's insufficient role,404 for missing or foreign-workspace resources,409 for state/uniqueness/stock conflicts,413 for oversized files,415 for unsupported attachments. Do not return a successful status for an error.

Authenticated workspace endpoints use **`/api/w/:workspaceId`**, abbreviated **W** below. Check actual membership on every request; an outsider must receive404, including download/sync/activity requests. Never trust workspace/user IDs supplied by a client to change ownership. Cross-workspace child references return404 and cause no partial changes. Fields that attempt protected business-state changes (e.g. product `stock`, invoice totals/status at creation) return400. Extra client `workspaceId`/`userId` ownership overrides may be rejected400 or safely ignored; ownership always comes from the authenticated user and URL workspace, never those fields. Whitespace-only required names are invalid. Reject invalid integer quantities/enums/cents, rather than silently coercing them. Limit list sizes reasonably, but these prototype lists must show all rows in the supplied small test data.

## Authentication, workspaces and roles

`POST /api/auth/signup {name,email,password}` returns201 and creates a user, signs them in, and creates **`<name> workspace`** with that user as owner. It returns `{user,workspace}`. Passwords must have at least12 characters; email matching/uniqueness is case-insensitive. `POST /api/auth/login {email,password}` returns200 `{user}` and creates a new session. `GET /api/auth/me` returns `{user,activeWorkspaceId,workspaces:[{id,name,role}]}`. `POST /api/auth/logout` revokes the session on the server. Never log plaintext passwords.

Use a random server-side session identifier of at least32 characters in cookie **`foundry_session`**, HttpOnly, SameSite=Lax, Path=/. HTTPS deployments are outside this local benchmark; do not require a Secure cookie on local HTTP. Passwords must be genuinely salted Argon2id or bcrypt, using `Bun.password` or an equivalent real implementation. The SQLite **`users`** table must expose `email` and **`password_hash`** columns for independent storage verification; no plaintext passwords in the database or logs.

- `GET /api/workspaces` → `{workspaces:[{id,name,role}]}` for this user only.
- `POST /api/workspaces {name}` → `{workspace}`; creator becomes owner.
- `POST /api/workspaces/:id/select` → `{workspace}` and persist that user's active workspace. Nonmembers receive404. Selection never changes another user's selection or membership.
- `GET W/members` → `{members:[{userId,name,email,role}]}`.
- `PATCH W/members/:userId {role}` and `DELETE W/members/:userId`: owner only. The original owner cannot be removed/demoted; do not create another owner via role updates/invites. Reject original-owner removal/demotion conflicts409. Attempting to invite or promote another owner may return400 (invalid role) or409 (owner conflict); it must never grant ownership.
- `POST W/invites {email,role}` → `{invite:{id,email,role,token,expiresAt}}`. Owner only; roles `manager`, `member`, `read_only`. A local token is at least32 unpredictable characters, single-use, expires within7days, and is bound to the invited email/workspace. No email is sent. `GET W/invites` lists metadata without raw tokens.
- `POST /api/invites/accept {token}` returns200 on success and requires an authenticated user with the matching email and returns `{workspace}`. Invalid/foreign-email token404; consumed token409. Membership is durable. An owner can copy/display the token locally.

All members can read business data. **Owner/manager** can create/edit inventory, stock, orders and invoices. **Owner/manager/member** can create/edit customers, projects, tasks and comments, and upload attachments. **Read only** cannot mutate business data. Only the owner manages members/invites. A member can delete their own comments/attachments; owner/manager can delete any in that workspace. Server enforcement is required even when UI actions are hidden. Revoked membership takes effect immediately on API requests.

## Customers

Customer fields: `{id,name,email,company,notes,createdAt,updatedAt}`. Name is required; other strings default empty. Nonempty email must be valid and unique case-insensitively within the workspace. Same email is allowed in another workspace.

- `GET W/customers?q=...` searches name/email/company case-insensitively.
- `POST W/customers {name,email?,company?,notes?}`; `GET/PATCH/DELETE W/customers/:id`.
- Patches update supplied fields only. Deleting a customer referenced by an order/invoice returns409; deleting an unused customer returns204.

## Inventory and immutable stock

Product: `{id,sku,name,description,priceCents,stock,createdAt,updatedAt}`. SKU is required, uppercase-normalized, unique case-insensitively per workspace. `priceCents` is an integer0..100000000; `stock` starts0 and changes only through stock movements/fulfillment. Never use floating-point dollar arithmetic for stored totals.

- `GET W/products?q=...`; `POST W/products {sku,name,description?,priceCents}`; `GET/PATCH/DELETE W/products/:id`.
- Product patch cannot directly set stock. Product deletion409 if referenced by stock movements or order lines; otherwise204.
- `GET W/stock-movements?productId=...` → `{movements:[{id,productId,delta,reason,kind,orderId,createdBy,createdAt}]}`. `kind` is `adjustment` or `fulfillment`; `orderId` is null for adjustments.
- `POST W/stock-movements {productId,delta,reason}` → `{movement,product}`. Delta is a nonzero integer in -1000000000..1000000000; reason is required. Apply atomically and keep resulting stock in0..1000000000; out-of-range/negative resulting stock returns409. Movements cannot be edited/deleted (404 or405 for unsupported mutation routes). Keep their actual author/time.

## Orders and transactional fulfillment

Order: `{id,number,customerId,status,items,totalCents,createdAt,updatedAt,fulfilledAt}`. Number is unique within workspace, `ORD-000001` style. Status is `draft`, `fulfilled`, `cancelled`. Items are `{productId,sku,name,unitPriceCents,quantity,lineTotalCents}` snapshots from creation; quantity is integer1..10000,1..50 distinct products, total is the exact integer sum. Store snapshots so later catalog edits do not rewrite an existing order.

- `GET W/orders?status=...`; `POST W/orders {customerId,items:[{productId,quantity}]}`; `GET/PATCH/DELETE W/orders/:id`. Patch may replace customer/items only while draft, refreshing price snapshots at that explicit edit. Delete only a draft. Invalid/foreign references leave no partial order.
- `POST W/orders/:id/cancel` changes a draft to cancelled; no stock movements. Fulfilled/cancelled conflicts409.
- `POST W/orders/:id/fulfill {idempotencyKey}` → `{order,replayed}`. Key is8..100 characters. Atomically check **all** inventory, decrement each product once, create one linked immutable fulfillment movement per line and mark fulfilled. Insufficient stock409 leaves all products/order/movements unchanged and must not consume the idempotency key; after receiving enough stock, that same key must be retryable.
- Replaying the same key for the same order returns200, identical fulfilled order, `replayed:true`, with no additional decrement/movement/activity. A different key for an already fulfilled order or the same key for a different order returns409. Idempotency is scoped to workspace and persists across restart.
- Concurrent fulfillment of two orders competing for insufficient shared stock must yield one success and one409, never negative stock. Concurrent same-key fulfillment of one order must apply once.

## Cents-exact invoices

- `POST W/invoices {orderId}` creates exactly one invoice for a fulfilled order. Unfulfilled order409; duplicate invoice409. `GET W/invoices?status=...` and `GET W/invoices/:id`.
- Invoice: `{id,number,orderId,customerId,billTo,status,currency,items,subtotalCents,totalCents,createdAt,paidAt}`. Unique atomic workspace numbers `INV-000001` style; currencyUSD; newly created invoice status is `draft` and `paidAt` is null. `billTo:{name,email,company}` and item prices/names/quantities are immutable snapshots of that order/customer at invoice creation. Total/subtotal are exact integer sums, without tax/discount in this prototype. Later catalog/customer edits cannot rewrite issued invoices.
- `PATCH W/invoices/:id {status}` permits draft→sent/void and sent→paid/void only. Paid/void are terminal. `paidAt` is set on payment. Do not edit amounts or fake a payment service; this records a local status decision.

## Projects, kanban tasks and comments

- Project `{id,name,description,createdAt,updatedAt}`: `GET/POST W/projects`; `GET/PATCH/DELETE W/projects/:id`. Deleting cascades that project's tasks/comments/attachments.
- `GET W/projects/:id/tasks` and `GET W/tasks` return `{tasks:[...]}`. Both support case-insensitive `q` over title/description, `status`, `priority`, and `assigneeId` filters, composed together. Global task list additionally supports `projectId`.
- `POST W/projects/:id/tasks {title,description?,status?,priority?,assigneeId?,dueDate?}`; `GET/PATCH/DELETE W/tasks/:id`. Task `{id,projectId,title,description,status,priority,assigneeId,dueDate,createdAt,updatedAt}`. Status `todo`/`in_progress`/`done` (defaulttodo); priority `low`/`medium`/`high` (defaultmedium); assignee is null or an actual workspace member; dueDate null or valid `YYYY-MM-DD`. Reject foreign assignees404 and invalid dates400. Task patch is atomic when any field is invalid.
- `GET/POST W/tasks/:id/comments` → `{comments:[...]}` / `{comment}`; create `{body}`. Comment `{id,taskId,body,author:{id,name},createdAt}`; nonempty body max2000 characters. `DELETE W/comments/:id` follows author/manager permissions. Comments persist; render user text safely.

## Safe CSV, owned local files, audit and live data

- `POST W/import/customers {csv}` →201 `{imported:<count>}`. RFC4180-style quoted commas, quotes and newlines must work. Exact header `name,email,company,notes`, max200 rows and1MB. Validate all rows and duplicate emails before committing; invalid400/duplicate409 must import **nothing**. No formula execution, HTML execution or partial-row success.
- `GET W/export.csv?type=customers|products|orders|invoices|tasks` returns a UTF-8 attachment `text/csv`. Headers respectively:
  - customers: `id,name,email,company,notes`
  - products: `id,sku,name,description,priceCents,stock`
  - orders: `id,number,customerId,status,totalCents`
  - invoices: `id,number,orderId,status,totalCents`
  - tasks: `id,projectId,title,description,status,priority,assigneeId,dueDate`
- CSV escaping must preserve commas/quotes/newlines. Prefix an apostrophe when a string's first non-whitespace character is `=`, `+`, `-`, `@`, or its first character is tab/CR. Do not alter stored values. Owner/manager/member may import customers; read_only may export/read, not import.
- `POST W/attachments` accepts multipart `file`, `entityType` (`customer`/`order`/`task`), `entityId`; return201 `{attachment}`. Allow `.txt,.md,.csv,.pdf,.png,.jpg,.jpeg` only, max2MiB. Require an existing same-workspace entity. Reject CR/LF filename injection400. A raw multipart filename containing `/`, `\` or traversal components may be rejected400 or normalized to its safe basename by the platform parser; if accepted, the returned/download filename must be that basename and storage must remain an opaque owned path under DATA_DIR. Never write outside DATA_DIR, including when the parser normalizes a traversal filename. Unsupported415; oversized413. Store opaque owned file paths under DATA_DIR, never a client filename as an arbitrary server path.
- Attachment `{id,entityType,entityId,fileName,size,mimeType,createdBy,createdAt}`. `GET W/attachments?entityType=...&entityId=...` → `{attachments}`; `GET W/attachments/:id/download` returns exact original bytes as an attachment with appropriate content type. Auth/membership checks apply to every download. `DELETE W/attachments/:id` removes metadata/file; entity deletion removes its attachments too. Repeated download then404.
- Every successful business mutation produces real persisted activity, with no new activity for failed atomic operations or idempotent replays. `GET W/activity?limit=50` (limit1..500, default50) → `{activity:[{id,action,entityType,entityId,actorId,actorName,createdAt}]}`, newest first. Required action names include `customer.created`, `stock.adjusted`, `order.fulfilled`, `invoice.paid`, `task.created`, `comment.created`, `attachment.created`. Do not log passwords/session/invite tokens.
- `GET W/sync` → `{revision:<nonnegative integer>}`. Increment the workspace revision on successful business/member changes, never for another tenant's changes or failed writes. A change by another client must appear on an open relevant page within **3seconds** without manual reload; polling<=2seconds or SSE is acceptable. No fake live-update indicator disconnected from real data.

## Overview analytics

`GET W/summary` returns `{customers,products,lowStockProducts,openOrders,fulfilledOrders,revenueCents,unpaidCents,openTasks,completedTasks}`. Counts reflect that workspace only. Low stock means stock<=5; open orders are draft; revenue is the sum of paid invoices; unpaid is draft+sent invoices; open tasks are todo+in_progress; completed tasks are done. Values update after actual mutations and survive restart. Give the overview useful summary cards, clear visual hierarchy and at least one meaningful locally rendered visual (e.g. invoice status or task distribution); do not invent data to fill charts.

## Required user interface and accessible contract

Design a convincing, coherent operations product with Foundry branding, strong typography, careful spacing, useful empty/loading/error states, readable tables, clear money/status displays, responsive navigation and well-designed forms. The UI must exercise real API data. Do not substitute screenshots or static arrays for interactions. Use inline SVG/CSS/local assets for visuals. Do not require users to enter IDs, JSON, idempotency keys or other backend implementation details in normal flows.

The visible navigation names are **Overview**, **Customers**, **Inventory**, **Orders**, **Invoices**, **Projects**, **Activity**, **Team** (buttons or links). If mobile navigation is collapsed, its toggle has accessible name **Open navigation**; inline mobile navigation is also acceptable. A native select labelled **Workspace** lists membership workspace names; switching updates visible data immediately and persists selected workspace. Expose **New workspace** → dialog **New workspace**, field **Workspace name**, button **Create workspace**.

- `/signup`: labels **Name**, **Email**, **Password**, button **Create account**. `/signin`: **Email**, **Password**, **Sign in**. Persistent **Sign out** action. Show current workspace and user's role.
- Team: **Invite member** → dialog **Invite member**, fields **Email**, native select **Role** (Manager/Member/Read only), button **Create invite**. On success show a read-only field labelled **Invite token** for local copy/display. Member rows identify email, expose owner-only native select **Role for <email>** and button **Save role for <email>**, and **Remove member <email>** where allowed. The owner row cannot be demoted/removed. `/join`: **Invite token**, button **Join workspace**; authenticated invitee joins and can select that workspace.
- Customers: search label **Search customers**, **New customer** → dialog **New customer** with **Name**, **Email**, **Company**, **Notes**, button **Create customer**. Actions **Edit customer <name>** (dialog **Edit customer**, **Save changes**), **Delete customer <name>**, **Open customer <name>** (dialog **Customer details**). Provide **Import customers** (dialog **Import customers**, file input **CSV file**, submit **Import CSV**) and **Export customers**.
- Inventory: **Search products**, **New product** → dialog **New product**, labels **SKU**, **Product name**, **Description**, **Unit price (USD)**, **Create product**. Dollar input is converted to exact cents. **Edit product <sku>** → dialog **Edit product**, **Save changes**. **Adjust stock <sku>** → dialog **Adjust stock**, **Quantity change**, **Reason**, **Save stock change**. Show current stock; **Stock history <sku>** opens dialog **Stock history** listing actual movement reason/delta/date. **Export products**.
- Orders: **New order** → dialog **New order** with native **Customer**, **Product** (labels `<sku> — <name>`), **Quantity**, **Add line**, **Create order**. One line-editor control pair is sufficient; added lines show quantities/prices. List number/customer/status/total; **Open order <number>** → dialog **Order details** with **Fulfill order**, **Cancel order**, and **Create invoice** when valid. UI generates idempotency keys. **Order status filter** select All statuses/Draft/Fulfilled/Cancelled. **Export orders**.
- Invoices: list number/customer/status/total; **Open invoice <number>** → dialog **Invoice details** showing immutable bill-to/line snapshots. Buttons **Mark sent**, **Mark paid**, **Void invoice** as valid. **Invoice status filter** All statuses/Draft/Sent/Paid/Void. **Export invoices**.
- Projects: **New project** → dialog **New project**, **Project name**, **Description**, **Create project**; **Open project <name>** opens its board. **New task** → dialog **New task**, **Title**, **Description**, native **Status** (Todo/In progress/Done), native **Priority** (Low/Medium/High), native **Assignee** (Unassigned/member names), **Due date**, **Create task**. Board regions **Todo**, **In progress**, **Done**. Task cards are article/listitem. **Edit task <title>** → **Edit task** dialog/**Save changes**; **Delete task <title>**. **Open task <title>** → **Task details** dialog with **Comment**, **Add comment** and visible author/body. **Search tasks**, native **Status filter** All statuses/Todo/In progress/Done and **Priority filter** All priorities/Low/Medium/High compose. **Export tasks**.
- Customer/order/task details: file input **Attachment**, button **Upload attachment**, listed **Download attachment <fileName>**, **Delete attachment <fileName>** actions. A browser-visible error explains rejected files. No external upload service.
- Overview cards are accessible regions named **Revenue**, **Unpaid invoices**, **Open orders**, **Low stock**, **Open tasks**, **Customers**, displaying actual values. Activity shows actual human-readable events. Member UI hides/disables actions its role cannot perform; role/membership changes are respected by open pages within3seconds.

Searches must have the specified accessible labels; either searchbox or textbox inputs are acceptable. Use native selects for specified choices. Dialogs have matching accessible names, labelled controls, keyboard focus, Escape close and focus return. Destructive actions use native confirmation or accessible confirmation with a **Confirm delete** button. Use real visible error messages with `role="alert"`, not console-only failures. At390px wide the page must not scroll horizontally; a contained table/board region may scroll. Desktop1440px and mobile390px screenshots, keyboard operation, actual browser/API flows, errors and visual quality will be independently reviewed.

## Acceptance

All domains must work coherently: create customers/products, receive stock, create and fulfill multi-line orders, issue/pay correct invoices, organize projects/tasks/comments, manage roles/invites, import/export, attach files and see real overview/activity/live changes. Verify concurrency, tenant isolation, malformed input, atomic rollback, durable sessions/data and full restart. Keep the feature contracts intact when polishing the UI. Report checks/limitations honestly; a skipped test is not a pass.
