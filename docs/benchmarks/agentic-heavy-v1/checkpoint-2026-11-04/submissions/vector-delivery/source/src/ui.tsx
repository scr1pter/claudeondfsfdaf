import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { api, date, json, useAction, useApp, useResource } from './api';
import type { Attachment } from './types';

export function Icon({name, size = 20}: {name: string; size?: number}) {
  const paths: Record<string, ReactNode> = {
    Overview: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    Customers: <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 5"/></>,
    Inventory: <><path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10v9M3 8l9 5 9-5M8 5l9 5"/></>,
    Orders: <><path d="M6 3h12v19H6zM9 8h6M9 12h6M9 16h4"/></>,
    Invoices: <><path d="M5 3h14v19l-3-2-4 2-4-2-3 2V3Z"/><path d="M15 8H9v4h6v4H9m3-10v12"/></>,
    Projects: <><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M9 4v17M15 4v17M5 9h2m4 4h2m4-5h2"/></>,
    Activity: <path d="M2 13h5l3-9 4 16 3-7h5"/>,
    Team: <><circle cx="12" cy="8" r="3"/><path d="M6 21v-3a6 6 0 0 1 12 0v3M4 5a3 3 0 0 0 0 6M20 5a3 3 0 0 1 0 6M2 16v4m20-4v4"/></>,
    plus: <path d="M12 5v14M5 12h14"/>, search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6"/>, download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>,
    close: <path d="m6 6 12 12M6 18 18 6"/>, menu: <path d="M3 6h18M3 12h18M3 18h18"/>,
    check: <path d="m5 12 4 4L19 6"/>, logout: <path d="M9 4H4v16h5m5-14 6 6-6 6m-6-6h12"/>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.Overview}</svg>;
}
export function Brand() { return <span className="brand"><span className="brand-mark"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M5 6h18v5H11v4h9v5h-9v5H5Z" fill="currentColor"/><path d="m18 2 5 4H5l5-4Z" fill="currentColor" opacity=".6"/></svg></span>foundry<span className="brand-dot">.</span></span>; }
export function Button({children, tone = 'secondary', ...props}: React.ButtonHTMLAttributes<HTMLButtonElement> & {tone?: 'primary'|'secondary'|'danger'|'ghost'}) { return <button type="button" {...props} className={`button ${tone} ${props.className || ''}`}>{children}</button>; }
export function ErrorNotice({error}: {error?: string}) { return error ? <div role="alert" className="error-notice">{error}</div> : null; }
export function Notice({children}: {children: ReactNode}) { return <div className="notice" role="status">{children}</div>; }
function restoreDialogFocus(previous: HTMLElement | null) {
  const fallback = () => {
    const root = document.querySelector<HTMLDialogElement>('dialog[open]') || document.querySelector<HTMLElement>('#main-content') || document;
    const target = root.querySelector<HTMLElement>('input[type="search"]') || root.querySelector<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') || document.querySelector<HTMLElement>('#workspace-select');
    target?.focus({preventScroll: true});
  };
  queueMicrotask(() => {
    if (!previous?.isConnected) { fallback(); return; }
    previous.focus({preventScroll: true});
    // The trigger can still exist at dialog cleanup, then disappear when the
    // asynchronous refreshed results arrive (for example a filtered task).
    let timer: ReturnType<typeof setTimeout>;
    const stop = () => { observer.disconnect(); document.removeEventListener('focusin', moved, true); clearTimeout(timer); };
    const moved = (event: FocusEvent) => { if (event.target !== previous) stop(); };
    const observer = new MutationObserver(() => {
      if (!previous.isConnected) {
        stop();
        if (document.activeElement === document.body || !document.activeElement) fallback();
      }
    });
    observer.observe(document.body, {childList: true, subtree: true});
    document.addEventListener('focusin', moved, true);
    timer = setTimeout(stop, 5000);
  });
}
export function Modal({title, children, onClose, wide = false}: {title: string; children: ReactNode; onClose: () => void; wide?: boolean}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!; dialog.showModal();
    const cancel = (e: Event) => { e.preventDefault(); close.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); restoreDialogFocus(previous); };
  }, []);
  return <dialog ref={ref} aria-labelledby={id} className={`modal ${wide ? 'wide' : ''}`} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><header className="modal-header"><h2 id={id}>{title}</h2><Button tone="ghost" aria-label={`Close ${title}`} onClick={onClose}><Icon name="close"/></Button></header><div className="modal-body">{children}</div></dialog>;
}
export function Field({label, children, hint}: {label: string; children: ReactNode; hint?: string}) {
  const labelId = useId();
  const hintId = `${labelId}-hint`;
  const control = isValidElement(children) ? children as ReactElement<{'aria-labelledby'?: string; 'aria-describedby'?: string}> : null;
  const describedBy = [control?.props['aria-describedby'], hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return <label className="field"><span id={labelId}>{label}</span>{control ? cloneElement(control, {'aria-labelledby': labelId, 'aria-describedby': describedBy}) : children}{hint && <small id={hintId}>{hint}</small>}</label>;
}
export function FormActions({busy, submit, onClose}: {busy: boolean; submit: string; onClose: () => void}) { return <footer className="form-actions"><Button onClick={onClose}>Cancel</Button><Button tone="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : submit}</Button></footer>; }
export function PageHeader({eyebrow, title, description, children}: {eyebrow?: string; title: string; description: string; children?: ReactNode}) { return <header className="page-header"><div><div className="eyebrow">{eyebrow || 'YOUR WORKSPACE, CONNECTED'}</div><h1>{title}</h1><p>{description}</p></div><div className="page-actions">{children}</div></header>; }
export function Badge({value}: {value: string}) { return <span className={`badge ${value}`}>{value === 'todo' ? 'Todo' : value.replaceAll('_', ' ')}</span>; }
export function Empty({title, children}: {title: string; children?: ReactNode}) { return <div className="empty"><span className="empty-icon"><Icon name="Inventory" size={28}/></span><h3>{title}</h3><p>{children || 'Your next chapter starts here. Add your first record to get moving.'}</p></div>; }
export function Loading() { return <div className="loading" role="status"><span className="spinner"/> Loading your workspace…</div>; }
export function ResourceState({loading, error, retry, hasData}: {loading: boolean; error: string; retry: () => void; hasData: boolean}) { return <>{error && <><ErrorNotice error={error}/><Button onClick={retry}>Try again</Button></>}{loading && !hasData && <Loading/>}</>; }
export function Search({label, value, onChange}: {label: string; value: string; onChange: (v: string) => void}) { return <label className="search"><Icon name="search"/><input type="search" aria-label={label} placeholder={label} value={value} onChange={e => onChange(e.target.value)}/></label>; }
export function ExportButton({type}: {type: string}) { const {base} = useApp(); return <a className="button secondary" href={`${base}/export.csv?type=${type}`} download><Icon name="download" size={16}/>Export {type}</a>; }
export function Confirm({title, description, onClose, onConfirm}: {title: string; description: string; onClose: () => void; onConfirm: () => Promise<void>}) { const action = useAction(); return <Modal title={title} onClose={onClose}><p>{description}</p><ErrorNotice error={action.error}/><div className="form-actions"><Button onClick={onClose}>Keep it</Button><Button tone="danger" disabled={action.busy} onClick={() => action.run(onConfirm)}>{action.busy ? 'Deleting…' : 'Confirm delete'}</Button></div></Modal>; }

export function Attachments({entityType, entityId}: {entityType: 'customer'|'order'|'task'; entityId: string}) {
  const {base, refresh, canEdit, canManage, session} = useApp();
  const resource = useResource<{attachments: Attachment[]}>(`${base}/attachments?entityType=${entityType}&entityId=${encodeURIComponent(entityId)}`);
  const action = useAction(); const file = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Attachment | null>(null);
  return <section className="detail-section"><div className="section-heading"><h3>Files & attachments</h3><span className="muted">Local, secure storage</span></div>
    <ResourceState {...resource} hasData={!!resource.data}/>
    <div className="file-list">{resource.data?.attachments.map(a => <div className="file-row" key={a.id}><span className="file-icon">↗</span><div className="file-info"><a href={`${base}/attachments/${a.id}/download`} aria-label={`Download attachment ${a.fileName}`} download>{a.fileName}</a><small>{(a.size / 1024).toFixed(1)} KB · {date(a.createdAt)}</small></div>{canEdit && (canManage || a.createdBy === session.user.id) && <Button tone="ghost" aria-label={`Delete attachment ${a.fileName}`} onClick={() => setPending(a)}>Delete</Button>}</div>)}</div>
    {resource.data?.attachments.length === 0 && <p className="muted">No files attached yet.</p>}
    {canEdit && <form className="upload-form" onSubmit={e => {e.preventDefault(); void action.run(async () => { const selected = file.current?.files?.[0]; if (!selected) throw new Error('Choose a file to upload.'); if (selected.size > 2 * 1024 * 1024) throw new Error('File must be 2 MiB or smaller.'); if (!/\.(txt|md|csv|pdf|png|jpg|jpeg)$/i.test(selected.name)) throw new Error('Unsupported file. Choose TXT, MD, CSV, PDF, PNG or JPEG.'); const data = new FormData(); data.set('file', selected); data.set('entityType', entityType); data.set('entityId', entityId); await api(`${base}/attachments`, {method:'POST',body:data}); if (file.current) file.current.value=''; refresh(); }); }}><Field label="Attachment" hint="TXT, MD, CSV, PDF, PNG or JPEG · up to 2 MiB"><input ref={file} type="file" accept=".txt,.md,.csv,.pdf,.png,.jpg,.jpeg" required/></Field><Button type="submit" disabled={action.busy}>{action.busy ? 'Uploading…' : 'Upload attachment'}</Button></form>}
    <ErrorNotice error={action.error}/>
    {pending && <Confirm title="Delete attachment" description={`Permanently delete ${pending.fileName}?`} onClose={() => setPending(null)} onConfirm={async () => {await api(`${base}/attachments/${pending.id}`, json('DELETE'));setPending(null);refresh();}}/>}
  </section>;
}
