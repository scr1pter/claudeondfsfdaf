import React, { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type D = Record<string, any>;
type ModalState = { type: string; record?: D; title?: string; action?: () => Promise<void> };
const sections = ["Overview", "Customers", "Inventory", "Orders", "Invoices", "Projects", "Activity", "Team"];
const emptyData: D = { customers: [], products: [], orders: [], invoices: [], projects: [], tasks: [], members: [], activity: [], summary: {} };
const money = (c: number = 0) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(c / 100);
const date = (s: string | null) => s ? new Date(s.length === 10 ? s + "T12:00:00" : s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "No due date";
const titleCase = (s: string) => s.replaceAll("_", " ").replace(/^\w/, x => x.toUpperCase());
async function api(path: string, method = "GET", body?: unknown): Promise<D> {
  const response = await fetch(path, { method, headers: body instanceof FormData ? undefined : body === undefined ? undefined : { "Content-Type": "application/json" }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 204) return {};
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "The request could not be completed.");
  return data;
}
function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    Overview: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    Customers: <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/></>,
    Inventory: <><path d="m12 3 9 5v9l-9 5-9-5V8Zm-9 5 9 5 9-5m-9 5v9M7 5.8l9 5"/></>,
    Orders: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z"/><path d="M9 8h6M9 12h6"/></>,
    Invoices: <><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M9 6h6m-6 4h6m-6 4h2m3 0h1m-6 4h2m3 0h1"/></>,
    Projects: <><path d="M3 7h7l2-3h9v16H3Z"/><path d="m8 13 3 3 5-6"/></>,
    Activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
    Team: <><circle cx="12" cy="7" r="3"/><circle cx="4" cy="11" r="2"/><circle cx="20" cy="11" r="2"/><path d="M7 21v-3a5 5 0 0 1 10 0v3M1 21v-4a3 3 0 0 1 4-3m18 7v-4a3 3 0 0 0-4-3"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
    edit: <><path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14Z"/></>,
    trash: <><path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>, menu: <path d="M3 6h18M3 12h18M3 18h18"/>,
    check: <path d="m5 12 4 4L19 6"/>, logout: <><path d="M9 3H4v18h5m0-9h12m-5-5 5 5-5 5"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    file: <><path d="M14 2H5v20h14V7Zm0 0v5h5M8 12h8m-8 4h8"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.file}</svg>;
}
function Brand() { return <div className="brand"><span className="brand-mark"><span/><span/><span/></span>foundry<span className="brand-dot">.</span></div>; }
function Button({ children, onClick, variant = "", type = "button", disabled, label }: { children: ReactNode; onClick?: () => void; variant?: string; type?: "button" | "submit"; disabled?: boolean; label?: string }) {
  return <button type={type} className={`button ${variant}`} onClick={onClick} disabled={disabled} aria-label={label}>{children}</button>;
}
function Action({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return <button className="icon-button" type="button" aria-label={label} title={label} onClick={onClick}><Icon name={icon} size={16}/></button>;
}
function Field({ label, name, value, type = "text", required, children, min, max, step, placeholder }: { label: string; name: string; value?: any; type?: string; required?: boolean; children?: ReactNode; min?: string; max?: string; step?: string; placeholder?: string }) {
  return <label className={`field ${type === "textarea" ? "wide" : ""}`}><span>{label}</span>{children ? <select aria-label={label} name={name} defaultValue={value ?? ""} required={required}>{children}</select> : type === "textarea" ? <textarea aria-label={label} name={name} defaultValue={value ?? ""} rows={3} required={required} placeholder={placeholder}/> : <input aria-label={label} name={name} type={type} defaultValue={value ?? ""} required={required} min={min} max={max} step={step} placeholder={placeholder}/>}</label>;
}
function Badge({ value }: { value: string }) { return <span className={`badge ${value}`}><span/>{titleCase(value)}</span>; }
function Avatar({ name, small = false }: { name: string; small?: boolean }) { return <span className={`avatar ${small ? "small" : ""}`}>{name.split(" ").map(s => s[0]).slice(0, 2).join("").toUpperCase()}</span>; }
function Empty({ noun, action }: { noun: string; action?: ReactNode }) { return <div className="empty"><span className="empty-icon"><Icon name="Projects" size={27}/></span><h3>No {noun} yet</h3><p>Your next great workflow starts here.</p>{action}</div>; }
function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => { ref.current?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === ref.current) onClose(); }}>
    <div className="dialog-header"><div><span className="eyebrow">FOUNDRY WORKSPACE</span><h2 id="dialog-title">{title}</h2></div><Action label="Close dialog" icon="close" onClick={onClose}/></div>{children}
  </dialog>;
}
function App() {
  const [me, setMe] = useState<D | null>(null);
  const [booting, setBooting] = useState(true);
  const [workspaceId, setWorkspaceId] = useState("");
  const [page, setPage] = useState(location.pathname.split("/")[1] || "overview");
  const [data, setData] = useState<D>(emptyData);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const [projectId, setProjectId] = useState("");
  const [lines, setLines] = useState<D[]>([]);
  const [lineProduct, setLineProduct] = useState("");
  const [lineQty, setLineQty] = useState("1");
  const [inviteToken, setInviteToken] = useState("");
  const [toast, setToast] = useState("");
  const revision = useRef(-1);
  const activeScope = useRef("");
  const role = me?.workspaces.find((w: D) => w.id === workspaceId)?.role || "read_only";
  const canManage = ["owner", "manager"].includes(role), canEdit = role !== "read_only", isOwner = role === "owner";
  const base = `/api/w/${workspaceId}`;
  const wapi = (p: string, method = "GET", b?: unknown) => api(base + p, method, b);
  const currentWorkspace = me?.workspaces.find((w: D) => w.id === workspaceId);
  useEffect(() => { setModal(null); }, [role]);
  async function boot() {
    try {
      const result = await api("/api/auth/me");
      setMe(result); setWorkspaceId(result.activeWorkspaceId || "");
    } catch { setMe(null); }
    finally { setBooting(false); }
  }
  async function load(w = workspaceId) {
    if (!w) return;
    const prefix = `/api/w/${w}`;
    const names = ["customers", "products", "orders", "invoices", "projects", "tasks", "members", "activity", "summary"];
    const results = await Promise.all(names.map(n => api(prefix + "/" + n)));
    if (activeScope.current !== w) return;
    const next: D = {};
    names.forEach((n, i) => { next[n] = n === "summary" ? results[i] : results[i][n]; });
    setData(next); setLoaded(true);
  }
  useEffect(() => { void boot(); const pop = () => { setPage(location.pathname.split("/")[1] || "overview"); setModal(null); }; window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
  useEffect(() => {
    activeScope.current = workspaceId; revision.current = -1; setLoaded(false); setData(emptyData); setLive(false); setProjectId(""); setModal(null); setError("");
    if (!workspaceId) return;
    let stopped = false, polling = false;
    async function poll() {
      if (polling) return;
      polling = true;
      try {
        const identity = await api("/api/auth/me");
        if (stopped) return;
        setMe(identity);
        if (!identity.workspaces.some((w: D) => w.id === workspaceId)) {
          setWorkspaceId(identity.activeWorkspaceId || ""); return;
        }
        const result = await api(`/api/w/${workspaceId}/sync`);
        if (!stopped && result.revision !== revision.current) {
          await load(workspaceId);
          if (!stopped) revision.current = result.revision;
        }
        if (!stopped) setLive(true);
      } catch (e) { if (!stopped) { setLive(false); setError((e as Error).message); } }
      finally { polling = false; }
    }
    void poll();
    const timer = setInterval(poll, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [workspaceId]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(""), 3500); return () => clearTimeout(t); } }, [toast]);
  function navigate(name: string) {
    const path = "/" + name.toLowerCase(); history.pushState({}, "", path); setPage(name.toLowerCase()); setMobile(false); setSearch(""); setStatus(""); setPriority(""); setAssignee(""); setProjectId(""); setError(""); setModal(null);
  }
  function open(type: string, record?: D) { setError(""); setInviteToken(""); setModal({ type, record }); if (type === "New order") { setLines([]); setLineProduct(data.products[0]?.id || ""); setLineQty("1"); } }
  async function execute(fn: () => Promise<void>, close = true, message = "Changes saved") {
    if (busy) return;
    setBusy(true); setError("");
    try { await fn(); await load(); if (close) setModal(null); setToast(message); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function confirmDelete(label: string, fn: () => Promise<void>) { setError(""); setModal({ type: "Confirm delete", title: label, action: fn }); }
  async function authSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true); setError("");
    try {
      await api(`/api/auth/${page === "signup" ? "signup" : "login"}`, "POST", f);
      await boot(); navigate("Overview");
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (booting) return <div className="boot"><Brand/><p>Opening your workspace...</p></div>;
  if (!me) return <div className="auth-layout"><section className="auth-story"><Brand/><div><span className="eyebrow">LESS BUSYWORK. MORE POSSIBILITY.</span><h1>Good business.<br/>Better together.</h1><p>From the first customer to the final delivery.<br/>One calm place to keep everything moving.</p><div className="auth-visual"><div className="visual-square one"/><div className="visual-square two"/><div className="visual-square three"/><span className="visual-caption">YOUR WORK, CONNECTED.</span></div></div><small>Built for the way your business works.</small></section><section className="auth-form"><div><span className="eyebrow">WELCOME TO FOUNDRY</span><h2>{page === "signup" ? "Make room for better work." : "Back to good business."}</h2><p className="muted">{page === "signup" ? "Create your account and bring it all together." : "Sign in to pick up where you left off."}</p><form onSubmit={authSubmit}>
    {page === "signup" && <Field label="Name" name="name" required/>}<Field label="Email" name="email" type="email" required/><Field label="Password" name="password" type="password" required/>
    <small className="muted">At least 12 characters. This is a local prototype.</small>{error && <p role="alert" className="alert">{error}</p>}<Button type="submit" disabled={busy}>{busy ? "Please wait..." : page === "signup" ? "Create account" : "Sign in"}<Icon name="arrow" size={17}/></Button></form>
    <p className="auth-switch">{page === "signup" ? "Already have an account?" : "New to Foundry?"} <button onClick={() => navigate(page === "signup" ? "signin" : "signup")}>{page === "signup" ? "Sign in" : "Create account"}</button></p></div></section></div>;
  const customerName = (key: string) => data.customers.find((c: D) => c.id === key)?.name || "Customer";
  const project = data.projects.find((p: D) => p.id === projectId);
  const filteredTasks = data.tasks.filter((t: D) => (!projectId || t.projectId === projectId) && (!search || `${t.title} ${t.description}`.toLowerCase().includes(search.toLowerCase())) && (!status || t.status === status) && (!priority || t.priority === priority) && (!assignee || t.assigneeId === assignee));
  const searchBox = (label: string, placeholder: string) => <label className="search"><Icon name="search" size={18}/><input aria-label={label} value={search} placeholder={placeholder} onChange={e => setSearch(e.target.value)}/></label>;
  const exportLink = (type: string) => <a className="button secondary" href={`${base}/export.csv?type=${type}`} download><Icon name="download" size={16}/>Export {type}</a>;
  const newButton = (label: string) => <Button onClick={() => open(label)}><Icon name="plus" size={17}/>{label}</Button>;
  const headings: Record<string, [string, string]> = {
    overview: ["A little clarity. A lot of momentum.", "Your business at a glance. Everything in its place."],
    customers: ["Good relationships start here.", "The people and companies behind your business."],
    inventory: ["Everything you need, accounted for.", "Your products, pricing and stock in one place."],
    orders: ["From request to ready.", "Keep every order moving in the right direction."],
    invoices: ["Great work deserves a clear invoice.", "Track what is owed, sent and settled."],
    projects: [project?.name || "Make great things happen.", project?.description || "Turn plans into progress, together."],
    activity: ["The story of your workspace.", "A real-time record of the work that moves you forward."],
    team: ["Better with the right people.", "One workspace. A shared sense of purpose."],
    join: ["A place on the team.", "Use your local invite token to join a workspace."],
  };
  const [heading, subtitle] = headings[page] || headings.overview;
  const modalRecord = modal?.record && ({ "Customer details": data.customers, "Order details": data.orders, "Invoice details": data.invoices, "Task details": data.tasks }[modal.type]?.find((r: D) => r.id === modal.record!.id) || modal.record);
  async function submitModal(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget, f = new FormData(form), v = Object.fromEntries(f) as D, type = modal!.type, r = modal!.record;
    await execute(async () => {
      if (type === "New workspace") {
        const result = await api("/api/workspaces", "POST", { name: v.name }); await boot(); setWorkspaceId(result.workspace.id);
      } else if (type === "Invite member") {
        const result = await wapi("/invites", "POST", v); setInviteToken(result.invite.token);
      } else if (type.includes("customer") && type !== "Import customers") await wapi("/customers" + (r ? "/" + r.id : ""), r ? "PATCH" : "POST", v);
      else if (type.includes("product")) {
        if (!/^\d+(\.\d{1,2})?$/.test(String(v.price))) throw new Error("Enter a price with no more than two decimal places.");
        const [d, c = ""] = String(v.price).split("."); const priceCents = Number(d) * 100 + Number(c.padEnd(2, "0")); delete v.price;
        await wapi("/products" + (r ? "/" + r.id : ""), r ? "PATCH" : "POST", { ...v, priceCents });
      } else if (type === "Adjust stock") await wapi("/stock-movements", "POST", { productId: r!.id, delta: Number(v.delta), reason: v.reason });
      else if (type === "New order") {
        if (!lines.length) throw new Error("Add at least one product line.");
        await wapi("/orders", "POST", { customerId: v.customerId, items: lines.map(l => ({ productId: l.productId, quantity: l.quantity })) });
      } else if (type === "New project" || type === "Edit project") await wapi("/projects" + (r ? "/" + r.id : ""), r ? "PATCH" : "POST", v);
      else if (type === "New task" || type === "Edit task") {
        await wapi(r ? `/tasks/${r.id}` : `/projects/${projectId}/tasks`, r ? "PATCH" : "POST", { ...v, assigneeId: v.assigneeId || null, dueDate: v.dueDate || null });
      } else if (type === "Import customers") {
        const file = f.get("csv") as File; if (!file.size) throw new Error("Choose a CSV file.");
        const result = await wapi("/import/customers", "POST", { csv: await file.text() }); setToast(`${result.imported} customers imported`);
      }
    }, type !== "Invite member", type === "Invite member" ? "Local invite created" : "Changes saved");
  }
  const detailAction = (path: string, method: string, b: D, message: string) => execute(async () => { await wapi(path, method, b); }, false, message);
  function renderModal() {
    if (!modal) return null;
    const t = modal.type, r = modalRecord || modal.record;
    let content: ReactNode;
    let submit = "";
    if (t === "Confirm delete") content = <><p className="dialog-copy">Delete {modal.title}? This cannot be undone.</p><div className="form-footer"><Button variant="secondary" onClick={() => setModal(null)}>Keep it</Button><Button variant="danger" disabled={busy} onClick={() => execute(modal.action!)}>Confirm delete</Button></div></>;
    else if (t === "New workspace") { submit = "Create workspace"; content = <Field label="Workspace name" name="name" required/>; }
    else if (t === "Invite member") {
      submit = inviteToken ? "" : "Create invite";
      content = inviteToken ? <div className="invite-success"><span className="success-symbol"><Icon name="check"/></span><h3>Your invitation is ready.</h3><p>Share this local token with the invited person. It is single-use and expires in seven days. No email was sent.</p><label className="field"><span>Invite token</span><input readOnly value={inviteToken} onFocus={e => e.currentTarget.select()}/></label><Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(inviteToken).then(() => setToast("Token copied")).catch(() => setToast("Select the token to copy it")); }}>Copy token</Button></div> : <><Field label="Email" name="email" type="email" required/><Field label="Role" name="role" value="member"><option value="manager">Manager</option><option value="member">Member</option><option value="read_only">Read only</option></Field><p className="hint">A local invitation, not an email. You will receive a token to share.</p></>;
    } else if (t === "New customer" || t === "Edit customer") {
      submit = r ? "Save changes" : "Create customer"; content = <div className="form-grid"><Field label="Name" name="name" value={r?.name} required/><Field label="Email" name="email" type="email" value={r?.email}/><Field label="Company" name="company" value={r?.company}/><Field label="Notes" name="notes" type="textarea" value={r?.notes}/></div>;
    } else if (t === "New product" || t === "Edit product") {
      submit = r ? "Save changes" : "Create product"; content = <div className="form-grid"><Field label="SKU" name="sku" value={r?.sku} required/><Field label="Product name" name="name" value={r?.name} required/><Field label="Unit price (USD)" name="price" value={r ? (r.priceCents / 100).toFixed(2) : ""} type="number" min="0" max="1000000" step="0.01" required/><Field label="Description" name="description" type="textarea" value={r?.description}/><p className="hint wide">Stock is tracked separately through immutable movements.</p></div>;
    } else if (t === "Adjust stock") {
      submit = "Save stock change"; content = <><div className="context-box"><strong>{r?.sku} · {r?.name}</strong><span>{data.products.find((p: D) => p.id === r?.id)?.stock} units on hand</span></div><div className="form-grid"><Field label="Quantity change" name="delta" type="number" step="1" required/><Field label="Reason" name="reason" required/></div><p className="hint">Use a positive number to receive stock, or a negative number to remove it.</p></>;
    } else if (t === "Stock history") content = <StockHistory base={base} product={data.products.find((p: D) => p.id === r!.id) || r!} revision={data.activity[0]?.id}/>;
    else if (t === "Import customers") {
      submit = "Import CSV"; content = <><p className="dialog-copy">Import up to 200 customers. All rows are checked before anything is saved.</p><div className="csv-template">name,email,company,notes</div><Field label="CSV file" name="csv" type="file" required/><p className="hint">CSV, at most 1 MB. Quoted commas and multiline notes are supported.</p></>;
    } else if (t === "New order") {
      submit = "Create order"; content = <><Field label="Customer" name="customerId" required>{data.customers.map((c: D) => <option key={c.id} value={c.id}>{c.name}{c.company ? ` · ${c.company}` : ""}</option>)}</Field>
        <div className="line-editor"><label className="field"><span>Product</span><select aria-label="Product" value={lineProduct} onChange={e => setLineProduct(e.target.value)}>{data.products.map((p: D) => <option key={p.id} value={p.id}>{p.sku} — {p.name}</option>)}</select></label><label className="field quantity"><span>Quantity</span><input aria-label="Quantity" type="number" min="1" max="10000" step="1" value={lineQty} onChange={e => setLineQty(e.target.value)}/></label><Button variant="secondary" onClick={() => {
          const quantity = Number(lineQty); if (!lineProduct || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000) { setError("Choose a product and a whole quantity from 1 to 10000."); return; }
          if (lines.some(l => l.productId === lineProduct)) { setError("This product is already on the order. Remove the line to change it."); return; }
          const p = data.products.find((p: D) => p.id === lineProduct); setLines([...lines, { productId: p.id, name: p.name, sku: p.sku, quantity, unitPriceCents: p.priceCents }]); setError("");
        }}>Add line</Button></div>
        <div className="order-lines">{lines.map((l, i) => <div key={l.productId}><span><strong>{l.name}</strong><small>{l.quantity} × {money(l.unitPriceCents)}</small></span><strong>{money(l.quantity * l.unitPriceCents)}</strong><Action label={`Remove line ${l.sku}`} icon="close" onClick={() => setLines(lines.filter((_, j) => i !== j))}/></div>)}</div><div className="total-row"><span>Order total</span><strong>{money(lines.reduce((s, l) => s + l.quantity * l.unitPriceCents, 0))}</strong></div>{!data.customers.length || !data.products.length ? <p className="hint">Create a customer and a product before placing an order.</p> : null}</>;
    } else if (t === "New project" || t === "Edit project") {
      submit = r ? "Save changes" : "Create project"; content = <><Field label="Project name" name="name" value={r?.name} required/><Field label="Description" name="description" type="textarea" value={r?.description}/></>;
    } else if (t === "New task" || t === "Edit task") {
      submit = r ? "Save changes" : "Create task"; content = <div className="form-grid"><div className="wide"><Field label="Title" name="title" value={r?.title} required/></div><Field label="Description" name="description" type="textarea" value={r?.description}/><Field label="Status" name="status" value={r?.status || "todo"}><option value="todo">Todo</option><option value="in_progress">In progress</option><option value="done">Done</option></Field><Field label="Priority" name="priority" value={r?.priority || "medium"}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Field><Field label="Assignee" name="assigneeId" value={r?.assigneeId || ""}><option value="">Unassigned</option>{data.members.map((m: D) => <option value={m.userId} key={m.userId}>{m.name}</option>)}</Field><Field label="Due date" name="dueDate" type="date" value={r?.dueDate}/></div>;
    } else if (t === "Customer details") content = <><div className="detail-identity"><Avatar name={r!.name}/><div><h3>{r!.name}</h3><p>{r!.company || "Independent customer"}</p></div></div><dl className="detail-grid"><div><dt>Email</dt><dd>{r!.email || "Not provided"}</dd></div><div><dt>Customer since</dt><dd>{date(r!.createdAt)}</dd></div><div className="wide"><dt>Notes</dt><dd className="preserve">{r!.notes || "No notes yet."}</dd></div></dl><Attachments base={base} entityType="customer" entityId={r!.id} canEdit={canEdit} canManage={canManage} userId={me!.user.id} revision={data.activity[0]?.id} onChange={load}/></>;
    else if (t === "Order details" || t === "Invoice details") {
      const invoice = t === "Invoice details";
      content = <><div className="document-heading"><div><span className="eyebrow">{invoice ? "INVOICE" : "SALES ORDER"}</span><h3>{r!.number}</h3></div><Badge value={r!.status}/></div><dl className="detail-grid"><div><dt>{invoice ? "Bill to" : "Customer"}</dt><dd>{invoice ? r!.billTo.name : customerName(r!.customerId)}{invoice && <><small>{r!.billTo.company}</small><small>{r!.billTo.email}</small></>}</dd></div><div><dt>Created</dt><dd>{date(r!.createdAt)}</dd></div></dl><div className="table-scroll"><table className="line-table"><thead><tr><th>Product</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>{r!.items.map((l: D) => <tr key={l.productId}><td><strong>{l.name}</strong><small>{l.sku}</small></td><td>{l.quantity}</td><td>{money(l.unitPriceCents)}</td><td>{money(l.lineTotalCents)}</td></tr>)}</tbody></table></div><div className="total-row"><span>Total · USD</span><strong>{money(r!.totalCents)}</strong></div>
        {canManage && <div className="detail-actions">{!invoice && r!.status === "draft" && <><Button disabled={busy} onClick={() => detailAction(`/orders/${r!.id}/fulfill`, "POST", { idempotencyKey: `ui-${r!.id}` }, "Order fulfilled")}>Fulfill order</Button><Button variant="secondary" disabled={busy} onClick={() => detailAction(`/orders/${r!.id}/cancel`, "POST", {}, "Order cancelled")}>Cancel order</Button></>}{!invoice && r!.status === "fulfilled" && !data.invoices.some((i: D) => i.orderId === r!.id) && <Button disabled={busy} onClick={() => detailAction("/invoices", "POST", { orderId: r!.id }, "Invoice created")}>Create invoice</Button>}
        {invoice && r!.status === "draft" && <Button disabled={busy} onClick={() => detailAction(`/invoices/${r!.id}`, "PATCH", { status: "sent" }, "Invoice marked sent")}>Mark sent</Button>}{invoice && r!.status === "sent" && <Button disabled={busy} onClick={() => detailAction(`/invoices/${r!.id}`, "PATCH", { status: "paid" }, "Invoice marked paid")}>Mark paid</Button>}{invoice && ["draft", "sent"].includes(r!.status) && <Button variant="secondary" disabled={busy} onClick={() => detailAction(`/invoices/${r!.id}`, "PATCH", { status: "void" }, "Invoice voided")}>Void invoice</Button>}</div>}
        {invoice && r!.paidAt && <p className="paid-note"><Icon name="check" size={16}/> Payment recorded locally on {date(r!.paidAt)}</p>}
        {!invoice && <Attachments base={base} entityType="order" entityId={r!.id} canEdit={canEdit} canManage={canManage} userId={me!.user.id} revision={data.activity[0]?.id} onChange={load}/>}</>;
    } else if (t === "Task details") content = <><div className="task-detail-title"><h3>{r!.title}</h3><Badge value={r!.status}/></div><p className="preserve muted">{r!.description || "No description yet."}</p><dl className="detail-grid"><div><dt>Priority</dt><dd><Badge value={r!.priority}/></dd></div><div><dt>Due date</dt><dd>{date(r!.dueDate)}</dd></div><div><dt>Assignee</dt><dd>{data.members.find((m: D) => m.userId === r!.assigneeId)?.name || "Unassigned"}</dd></div></dl><Comments base={base} taskId={r!.id} canEdit={canEdit} canManage={canManage} userId={me!.user.id} revision={data.activity[0]?.id} onChange={load}/><Attachments base={base} entityType="task" entityId={r!.id} canEdit={canEdit} canManage={canManage} userId={me!.user.id} revision={data.activity[0]?.id} onChange={load}/></>;
    return <Modal title={t} onClose={() => { setModal(null); setError(""); }} key={`${t}-${r?.id || ""}`}>{submit ? <form onSubmit={submitModal}><div className="dialog-body">{content}{error && <p className="alert" role="alert">{error}</p>}</div><div className="form-footer"><Button variant="secondary" onClick={() => setModal(null)}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving..." : submit}</Button></div></form> : <><div className="dialog-body">{content}{error && <p className="alert" role="alert">{error}</p>}</div></>}</Modal>;
  }
  return <div className="app-shell">
    <aside className={`sidebar ${mobile ? "visible" : ""}`}><Brand/><div className="workspace-picker"><label htmlFor="workspace">Workspace</label><select id="workspace" value={workspaceId} onChange={e => { const selected = e.target.value; void execute(async () => { await api(`/api/workspaces/${selected}/select`, "POST", {}); setWorkspaceId(selected); await boot(); }, true, "Workspace switched"); }}>{me.workspaces.map((w: D) => <option key={w.id} value={w.id}>{w.name}</option>)}</select><button className="new-workspace" onClick={() => open("New workspace")}><Icon name="plus" size={13}/>New workspace</button></div>
      <div className="nav-label">WORKSPACE</div><nav aria-label="Main navigation">{sections.map((s, i) => <a key={s} aria-label={s} href={"/" + s.toLowerCase()} className={page === s.toLowerCase() ? "active" : ""} onClick={e => { e.preventDefault(); navigate(s); }}><Icon name={s}/><span>{s}</span>{s === "Orders" && data.summary.openOrders > 0 && <span className="nav-count" aria-hidden="true">{data.summary.openOrders}</span>}{i === 0 && <span className="nav-active-dot"/>}</a>)}</nav>
      <div className="sidebar-bottom"><div className="workspace-note"><span className="note-spark">✳</span><h4>A little more connected.</h4><p>One workspace for the<br/>business you are building.</p><span className="local-tag">LOCAL WORKSPACE</span></div><div className="user-block"><Avatar name={me.user.name} small/><div><strong>{me.user.name}</strong><small>{titleCase(role)}</small></div><button className="signout-icon" aria-label="Sign out" title="Sign out" onClick={() => { void api("/api/auth/logout", "POST", {}).then(() => { setMe(null); setWorkspaceId(""); navigate("Signin"); }); }}><Icon name="logout" size={17}/></button></div></div></aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="mobile-toggle icon-button" aria-label="Open navigation" aria-expanded={mobile} onClick={() => setMobile(!mobile)}><Icon name="menu"/></button><span className="breadcrumb-workspace">Workspace</span><span className="slash">/</span><strong>{titleCase(page)}</strong></div><div className="topbar-right"><span className={`live-state ${live ? "" : "disconnected"}`}><span/>{live ? "Live workspace" : "Connecting..."}</span><span className="topbar-date">{new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span></div></header>
      <main><div className="page-heading"><div><span className="eyebrow">{page === "overview" ? `THE BIG PICTURE · ${currentWorkspace?.name || "YOUR WORKSPACE"}` : `YOUR WORKSPACE / ${page.toUpperCase()}`}</span><h1>{heading}</h1><p>{subtitle}</p></div><div className="heading-actions">{page === "overview" && canManage && <Button onClick={() => { navigate("Orders"); open("New order"); }}><Icon name="plus" size={17}/>New order</Button>}{page === "customers" && canEdit && newButton("New customer")}{page === "inventory" && canManage && newButton("New product")}{page === "orders" && canManage && newButton("New order")}{page === "projects" && canEdit && newButton(project ? "New task" : "New project")}{page === "team" && isOwner && newButton("Invite member")}</div></div>
      {error && !modal && <div role="alert" className="alert">{error}</div>}
      {!loaded && workspaceId && <div className="loading-bar" role="status">Loading workspace...</div>}
      {page === "overview" && <Overview data={data} navigate={navigate} open={open}/>}
      {page === "customers" && <section className="panel"><div className="panel-toolbar">{searchBox("Search customers", "Search customers...")}<div className="toolbar-actions">{canEdit && <Button variant="secondary" onClick={() => open("Import customers")}><Icon name="file" size={16}/>Import customers</Button>}{exportLink("customers")}</div></div><Table headers={["Customer", "Company", "Email", "Added", ""]} empty="customers" rows={data.customers.filter((c: D) => [c.name, c.email, c.company].some(v => v.toLowerCase().includes(search.toLowerCase()))).map((c: D) => <tr key={c.id}><td><button className="person-link" aria-label={`Open customer ${c.name}`} onClick={() => open("Customer details", c)}><Avatar name={c.name} small/><strong>{c.name}</strong></button></td><td>{c.company || <span className="muted">Independent</span>}</td><td>{c.email || "—"}</td><td className="muted">{date(c.createdAt)}</td><td><div className="row-actions">{canEdit && <><Action label={`Edit customer ${c.name}`} icon="edit" onClick={() => open("Edit customer", c)}/><Action label={`Delete customer ${c.name}`} icon="trash" onClick={() => confirmDelete(c.name, async () => { await wapi(`/customers/${c.id}`, "DELETE"); })}/></>}</div></td></tr>)}/><PanelFoot count={data.customers.length} noun="customers" text="Relationships, not just records."/></section>}
      {page === "inventory" && <><div className="mini-stats"><div><span>Catalog products</span><strong>{data.products.length}</strong></div><div><span>Units on hand</span><strong>{data.products.reduce((s: number, p: D) => s + p.stock, 0).toLocaleString()}</strong></div><div><span>Low stock products</span><strong>{data.summary.lowStockProducts || 0}<span className="mini-tag">≤ 5 units</span></strong></div></div><section className="panel"><div className="panel-toolbar">{searchBox("Search products", "Search products...")}{exportLink("products")}</div><Table headers={["Product", "SKU", "Unit price", "On hand", ""]} empty="products" rows={data.products.filter((p: D) => [p.name, p.sku, p.description].some(v => v.toLowerCase().includes(search.toLowerCase()))).map((p: D) => <tr key={p.id}><td><div className="product-cell"><span className="product-icon"><Icon name="Inventory"/></span><div><strong>{p.name}</strong><small>{p.description || "Catalog product"}</small></div></div></td><td><code>{p.sku}</code></td><td className="numeric">{money(p.priceCents)}</td><td><span className={`stock ${p.stock <= 5 ? "low-stock" : ""}`}>{p.stock} <small>units</small></span></td><td><div className="row-actions">{canManage && <><Action label={`Edit product ${p.sku}`} icon="edit" onClick={() => open("Edit product", p)}/><button className="small-button" aria-label={`Adjust stock ${p.sku}`} onClick={() => open("Adjust stock", p)}><Icon name="plus" size={14}/>Adjust</button></>}<Action label={`Stock history ${p.sku}`} icon="clock" onClick={() => open("Stock history", p)}/>{canManage && <Action label={`Delete product ${p.sku}`} icon="trash" onClick={() => confirmDelete(p.name, async () => { await wapi(`/products/${p.id}`, "DELETE"); })}/>}</div></td></tr>)}/><PanelFoot count={data.products.length} noun="products" text="Every movement tells a story."/></section></>}
      {(page === "orders" || page === "invoices") && <section className="panel">
        <div className="panel-toolbar">
          <label className="filter">
            <span className="sr-only" id="document-status-label">{page === "orders" ? "Order status filter" : "Invoice status filter"}</span>
            <select aria-labelledby="document-status-label" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {(page === "orders" ? ["draft", "fulfilled", "cancelled"] : ["draft", "sent", "paid", "void"]).map(s => <option key={s} value={s}>{titleCase(s)}</option>)}
            </select>
          </label>
          {exportLink(page)}
        </div>
        <Table headers={[page === "orders" ? "Order" : "Invoice", "Customer", "Status", "Created", "Total", ""]} empty={page} rows={data[page].filter((r: D) => !status || r.status === status).map((r: D) => <tr key={r.id}><td><button className="text-link mono" aria-label={`Open ${page === "orders" ? "order" : "invoice"} ${r.number}`} onClick={() => open(page === "orders" ? "Order details" : "Invoice details", r)}>{r.number}</button></td><td><strong>{page === "invoices" ? r.billTo.name : customerName(r.customerId)}</strong></td><td><Badge value={r.status}/></td><td className="muted">{date(r.createdAt)}</td><td className="numeric"><strong>{money(r.totalCents)}</strong></td><td><div className="row-actions"><Action label={`View ${r.number}`} icon="arrow" onClick={() => open(page === "orders" ? "Order details" : "Invoice details", r)}/>{page === "orders" && canManage && r.status === "draft" && <Action label={`Delete order ${r.number}`} icon="trash" onClick={() => confirmDelete(r.number, async () => { await wapi(`/orders/${r.id}`, "DELETE"); })}/>}</div></td></tr>)}/><PanelFoot count={data[page].length} noun={page} text={page === "orders" ? "From the first line to the last mile." : "Cents-exact. Always."}/>
      </section>}
      {page === "projects" && <>{project && <div className="project-subnav"><button className="text-link" onClick={() => { setProjectId(""); setSearch(""); setStatus(""); }}>← All projects</button><div className="row-actions">{canEdit && <><Button variant="secondary" onClick={() => open("Edit project", project)}>Edit project</Button><Action label={`Delete project ${project.name}`} icon="trash" onClick={() => confirmDelete(project.name, async () => { await wapi(`/projects/${project.id}`, "DELETE"); setProjectId(""); })}/></>}</div></div>}
        {!project && <div className="project-grid">{!data.projects.length && <Empty noun="projects"/>}{data.projects.map((p: D, i: number) => { const tasks = data.tasks.filter((t: D) => t.projectId === p.id), done = tasks.filter((t: D) => t.status === "done").length; return <button className={`project-card color-${i % 3}`} aria-label={`Open project ${p.name}`} key={p.id} onClick={() => { setProjectId(p.id); setSearch(""); setStatus(""); setPriority(""); }}><div className="project-card-top"><span><Icon name="Projects" size={23}/></span><Icon name="arrow" size={18}/></div><h3>{p.name}</h3><p>{p.description || "A fresh space for your next big thing."}</p><div className="project-progress"><span style={{ width: `${tasks.length ? done / tasks.length * 100 : 0}%` }}/></div><div className="project-card-bottom"><span>{done} of {tasks.length} tasks done</span><small>{tasks.length ? Math.round(done / tasks.length * 100) : 0}%</small></div></button>; })}</div>}
        {(project || data.tasks.length > 0) && <section className="board-section"><div className="panel-toolbar task-toolbar">{searchBox("Search tasks", "Search tasks...")}<div className="task-filters"><select aria-label="Status filter" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{["todo", "in_progress", "done"].map(s => <option key={s} value={s}>{titleCase(s)}</option>)}</select><select aria-label="Priority filter" value={priority} onChange={e => setPriority(e.target.value)}><option value="">All priorities</option>{["low", "medium", "high"].map(s => <option key={s} value={s}>{titleCase(s)}</option>)}</select><select aria-label="Assignee filter" value={assignee} onChange={e => setAssignee(e.target.value)}><option value="">All assignees</option>{data.members.map((m: D) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select>{exportLink("tasks")}</div></div><div className="board">{["todo", "in_progress", "done"].map(s => <section className={`board-column ${s}`} aria-label={titleCase(s)} key={s}><div className="column-heading"><span/><h3>{titleCase(s)}</h3><small>{filteredTasks.filter((t: D) => t.status === s).length}</small></div>{filteredTasks.filter((t: D) => t.status === s).map((t: D) => <article className="task-card" key={t.id}><div className="task-card-top"><Badge value={t.priority}/>{canEdit && <div className="row-actions"><Action label={`Edit task ${t.title}`} icon="edit" onClick={() => open("Edit task", t)}/><Action label={`Delete task ${t.title}`} icon="trash" onClick={() => confirmDelete(t.title, async () => { await wapi(`/tasks/${t.id}`, "DELETE"); })}/></div>}</div><button className="task-title" aria-label={`Open task ${t.title}`} onClick={() => open("Task details", t)}>{t.title}</button>{t.description && <p>{t.description}</p>}<div className="task-bottom"><span><Icon name="clock" size={13}/>{date(t.dueDate)}</span>{t.assigneeId && <span title={data.members.find((m: D) => m.userId === t.assigneeId)?.name}><Avatar name={data.members.find((m: D) => m.userId === t.assigneeId)?.name || "?"} small/></span>}</div></article>)}{!filteredTasks.some((t: D) => t.status === s) && <p className="column-empty">Room for what is next.</p>}</section>)}</div></section>}</>}
      {page === "activity" && <section className="panel"><div className="panel-title"><div><h2>Workspace activity</h2><p>The real work, as it happens.</p></div><span className="pill">{data.activity.length} recent events</span></div><Activity events={data.activity}/></section>}
      {page === "team" && <><div className="team-banner"><div className="team-symbol"><Icon name="Team" size={30}/></div><div><h2>A shared space for good work.</h2><p>Give everyone the right access. Keep every workspace separate.</p></div><span className="pill">{data.members.length} {data.members.length === 1 ? "member" : "members"}</span></div><section className="panel"><div className="panel-title"><h2>People in your workspace</h2><a className="text-link" href="/join" onClick={e => { e.preventDefault(); navigate("Join"); }}>Join with a token <Icon name="arrow" size={14}/></a></div><Table headers={["Member", "Access", "Manage role", ""]} empty="members" rows={data.members.map((m: D) => <TeamRow key={`${m.userId}-${m.role}`} member={m} isOwner={isOwner} busy={busy} onSave={newRole => execute(async () => { await wapi(`/members/${m.userId}`, "PATCH", { role: newRole }); }, false, "Role updated")} onRemove={() => confirmDelete(m.name + " from this workspace", async () => { await wapi(`/members/${m.userId}`, "DELETE"); })}/>)}/><div className="role-guide"><strong>A place for every role</strong><p><b>Owner</b> manages the team. <b>Managers</b> handle inventory and finances. <b>Members</b> work with customers and projects. <b>Read only</b> members can explore and export.</p></div></section></>}
      {page === "join" && <section className="panel join-panel"><h2>Join a workspace</h2><p className="muted">Tokens are bound to the email address on your account: {me.user.email}</p><form onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void execute(async () => { const result = await api("/api/invites/accept", "POST", { token: f.get("token") }); await boot(); setWorkspaceId(result.workspace.id); navigate("Overview"); }, true, "Welcome to the workspace"); }}><Field label="Invite token" name="token" required/><Button type="submit" disabled={busy}>Join workspace</Button></form></section>}
      <footer className="page-footer"><span>foundry<span className="footer-dot">.</span> <span>Business, together.</span></span><small>Your work. Your local workspace.</small></footer></main>
    </div>{renderModal()}{toast && <div className="toast" role="status"><span><Icon name="check" size={15}/></span>{toast}</div>}
  </div>;
}
function Table({ headers, rows, empty }: { headers: string[]; rows: ReactNode[]; empty: string }) {
  return rows.length ? <div className="table-scroll"><table><thead><tr>{headers.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead><tbody>{rows}</tbody></table></div> : <Empty noun={empty}/>;
}
function PanelFoot({ count, noun, text }: { count: number; noun: string; text: string }) { return <div className="panel-foot"><span>{count} {noun}</span><span>{text}</span></div>; }
function TeamRow({ member: m, isOwner, busy, onSave, onRemove }: { member: D; isOwner: boolean; busy: boolean; onSave: (s: string) => void; onRemove: () => void }) {
  const [role, setRole] = useState(m.role);
  return <tr><td><div className="person-cell"><Avatar name={m.name} small/><div><strong>{m.name}</strong><small>{m.email}</small></div></div></td><td><Badge value={m.role}/></td><td>{isOwner && m.role !== "owner" ? <div className="role-editor"><select aria-label={`Role for ${m.email}`} value={role} onChange={e => setRole(e.target.value)}><option value="manager">Manager</option><option value="member">Member</option><option value="read_only">Read only</option></select><button className="small-button" disabled={busy} aria-label={`Save role for ${m.email}`} onClick={() => onSave(role)}>Save</button></div> : <span className="muted">{m.role === "owner" ? "Original owner" : "Managed by owner"}</span>}</td><td>{isOwner && m.role !== "owner" && <Action label={`Remove member ${m.email}`} icon="trash" onClick={onRemove}/>}</td></tr>;
}
function Overview({ data, navigate, open }: { data: D; navigate: (s: string) => void; open: (s: string, r?: D) => void }) {
  const s = data.summary;
  const cards = [
    ["Revenue", money(s.revenueCents), "Paid invoices, all time", "Invoices", "green"],
    ["Unpaid invoices", money(s.unpaidCents), "Draft and sent invoices", "Invoices", "purple"],
    ["Open orders", s.openOrders || 0, "Ready for the next step", "Orders", "orange"],
    ["Low stock", s.lowStockProducts || 0, "Products with 5 units or less", "Inventory", "pink"],
    ["Open tasks", s.openTasks || 0, "Good work in progress", "Projects", "blue"],
    ["Customers", s.customers || 0, "Relationships growing here", "Customers", "olive"],
  ];
  const totalTasks = data.tasks.length, completed = s.completedTasks || 0, pct = totalTasks ? Math.round(completed / totalTasks * 100) : 0;
  return <><div className="stat-grid">{cards.map(([name, value, description, target, color]) => <section className={`stat-card ${color}`} aria-label={String(name)} key={String(name)}><div className="stat-top"><span>{name}</span><span className="stat-icon"><Icon name={String(target)} size={17}/></span></div><strong className="stat-number">{value}</strong><div className="stat-bottom"><span>{description}</span><button aria-label={`View ${name}`} onClick={() => navigate(String(target))}><Icon name="arrow" size={16}/></button></div></section>)}</div>
    <div className="overview-middle"><section className="panel orders-panel"><div className="panel-title"><div><span className="eyebrow">KEEP THINGS MOVING</span><h2>Recent orders</h2></div><button className="text-link" onClick={() => navigate("Orders")}>View all<Icon name="arrow" size={15}/></button></div>{data.orders.length ? <div className="table-scroll"><table><thead><tr><th>Order / Customer</th><th>Status</th><th className="numeric">Total</th></tr></thead><tbody>{data.orders.slice(0, 5).map((o: D) => <tr key={o.id}><td><button className="text-link mono" onClick={() => open("Order details", o)}>{o.number}</button><small>{data.customers.find((c: D) => c.id === o.customerId)?.name}</small></td><td><Badge value={o.status}/></td><td className="numeric"><strong>{money(o.totalCents)}</strong></td></tr>)}</tbody></table></div> : <Empty noun="orders" action={<Button variant="secondary" onClick={() => navigate("Orders")}>Explore orders<Icon name="arrow" size={15}/></Button>}/>}</section>
      <section className="panel progress-panel"><div className="panel-title"><div><span className="eyebrow">SMALL STEPS. REAL PROGRESS.</span><h2>Work in motion</h2></div><Icon name="Projects" size={19}/></div><div className="donut" style={{ background: `conic-gradient(#375f4e 0% ${pct}%, #e8ece6 ${pct}% 100%)` }} role="img" aria-label={`${completed} of ${totalTasks} tasks complete`}><div><strong>{pct}<span>%</span></strong><small>tasks complete</small></div></div><div className="chart-legend"><span><i className="legend-dot done"/>{completed} completed</span><span><i className="legend-dot"/>{s.openTasks || 0} open</span></div><p className="chart-caption">{totalTasks ? "A little closer to the finish line." : "Your next project starts a new story."}</p></section></div>
    <div className="overview-bottom"><section className="panel"><div className="panel-title"><div><h2>Latest activity</h2><p>A shared view of what is happening.</p></div><button className="text-link" onClick={() => navigate("Activity")}>All activity<Icon name="arrow" size={15}/></button></div><Activity events={data.activity.slice(0, 4)} compact/></section><section className="workspace-poster"><span className="eyebrow">A LITTLE LESS SCATTERED.</span><h2>More space<br/>for what matters.</h2><p>Customers. Stock. Orders. Projects.<br/>Different moving parts, one clear view.</p><div className="poster-art" aria-hidden="true"><span/><span/><span/><span/></div><button onClick={() => navigate("Projects")}>Make your next move<Icon name="arrow" size={18}/></button></section></div></>;
}
function Activity({ events, compact = false }: { events: D[]; compact?: boolean }) {
  if (!events.length) return <div className="empty small-empty"><Icon name="Activity" size={26}/><h3>A fresh start.</h3><p>Your workspace activity will appear here.</p></div>;
  return <div className={`activity-list ${compact ? "compact" : ""}`}>{events.map((a: D) => <div className="activity-item" key={a.id}><span className={`event-icon ${a.entityType}`}><Icon name={({ customer: "Customers", product: "Inventory", order: "Orders", invoice: "Invoices", task: "Projects", project: "Projects", member: "Team" } as D)[a.entityType] || "Activity"} size={17}/></span><div><p><strong>{a.actorName}</strong> <span>{a.action.replace(".", " ").replaceAll("_", " ")}</span></p><small>{titleCase(a.entityType)} · {date(a.createdAt)}</small></div><time dateTime={a.createdAt}>{new Date(a.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</time></div>)}</div>;
}
function StockHistory({ base, product, revision }: { base: string; product: D; revision: string }) {
  const [movements, setMovements] = useState<D[] | null>(null), [error, setError] = useState("");
  useEffect(() => { void api(`${base}/stock-movements?productId=${product.id}`).then(r => setMovements(r.movements)).catch(e => setError(e.message)); }, [base, product.id, revision]);
  return <><div className="context-box"><strong>{product.sku} · {product.name}</strong><span>Immutable stock ledger</span></div>{error && <p role="alert" className="alert">{error}</p>}{movements === null ? <p className="muted">Loading stock history...</p> : !movements.length ? <Empty noun="stock movements"/> : <div className="stock-history">{movements.map(m => <div key={m.id}><span className={m.delta > 0 ? "positive" : "negative"}>{m.delta > 0 ? "+" : ""}{m.delta}</span><div><strong>{m.reason}</strong><small>{m.kind} · {date(m.createdAt)}</small></div></div>)}</div>}</>;
}
function Attachments({ base, entityType, entityId, canEdit, canManage, userId, revision, onChange }: { base: string; entityType: string; entityId: string; canEdit: boolean; canManage: boolean; userId: string; revision: string; onChange: () => Promise<void> }) {
  const [items, setItems] = useState<D[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false), [deleting, setDeleting] = useState("");
  const fetchItems = () => api(`${base}/attachments?entityType=${entityType}&entityId=${entityId}`).then(r => setItems(r.attachments));
  useEffect(() => { void fetchItems().catch(e => setError(e.message)); }, [base, entityType, entityId, revision]);
  async function upload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget, f = new FormData(form); f.set("entityType", entityType); f.set("entityId", entityId);
    setBusy(true); setError("");
    try { await api(base + "/attachments", "POST", f); form.reset(); await fetchItems(); await onChange(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="attachments"><h3><Icon name="file" size={17}/>Attachments <span>{items.length}</span></h3>{items.map(a => <div className="attachment-item" key={a.id}><Icon name="file" size={17}/><a href={`${base}/attachments/${a.id}/download`} aria-label={`Download attachment ${a.fileName}`} download>{a.fileName}<small>{a.size < 1024 ? a.size + " B" : Math.ceil(a.size / 1024) + " KB"}</small></a>{canEdit && (canManage || a.createdBy === userId) && <Action label={`Delete attachment ${a.fileName}`} icon="trash" onClick={() => setDeleting(a.id)}/>}</div>)}{!items.length && <p className="muted small-text">Keep useful files right beside the work.</p>}
    {deleting && <div className="inline-confirm"><span>Delete this attachment?</span><Button variant="secondary" onClick={() => setDeleting("")}>Keep it</Button><Button variant="danger" disabled={busy} onClick={async () => { setBusy(true); try { await api(`${base}/attachments/${deleting}`, "DELETE"); setDeleting(""); await fetchItems(); await onChange(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Confirm delete</Button></div>}
    {canEdit && <form onSubmit={upload} className="upload-form"><Field label="Attachment" name="file" type="file" required/><Button type="submit" variant="secondary" disabled={busy}>{busy ? "Uploading..." : "Upload attachment"}</Button></form>}<p className="hint">TXT, MD, CSV, PDF, PNG or JPEG · Up to 2 MiB</p>{error && <p role="alert" className="alert">{error}</p>}</section>;
}
function Comments({ base, taskId, canEdit, canManage, userId, revision, onChange }: { base: string; taskId: string; canEdit: boolean; canManage: boolean; userId: string; revision: string; onChange: () => Promise<void> }) {
  const [comments, setComments] = useState<D[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false), [deleting, setDeleting] = useState("");
  const fetchComments = () => api(`${base}/tasks/${taskId}/comments`).then(r => setComments(r.comments));
  useEffect(() => { void fetchComments().catch(e => setError(e.message)); }, [base, taskId, revision]);
  return <section className="comments"><h3>Conversation <span>{comments.length}</span></h3>{comments.map(c => <div className="comment" key={c.id}><Avatar name={c.author.name} small/><div><strong>{c.author.name}</strong><time>{date(c.createdAt)}</time><p className="preserve">{c.body}</p></div>{canEdit && (canManage || c.author.id === userId) && <Action label={`Delete comment by ${c.author.name}`} icon="trash" onClick={() => setDeleting(c.id)}/>}</div>)}
    {deleting && <div className="inline-confirm"><span>Delete this comment?</span><Button variant="secondary" onClick={() => setDeleting("")}>Keep it</Button><Button variant="danger" disabled={busy} onClick={async () => { setBusy(true); try { await api(`${base}/comments/${deleting}`, "DELETE"); setDeleting(""); await fetchComments(); await onChange(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Confirm delete</Button></div>}
    {canEdit && <form onSubmit={async e => { e.preventDefault(); const form = e.currentTarget, body = new FormData(form).get("body"); setBusy(true); setError(""); try { await api(`${base}/tasks/${taskId}/comments`, "POST", { body }); form.reset(); await fetchComments(); await onChange(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><Field label="Comment" name="body" type="textarea" required/><Button type="submit" variant="secondary" disabled={busy}>Add comment</Button></form>}{error && <p role="alert" className="alert">{error}</p>}</section>;
}
createRoot(document.getElementById("root")!).render(<App/>);
