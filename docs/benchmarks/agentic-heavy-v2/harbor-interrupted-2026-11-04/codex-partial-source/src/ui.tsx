import {useEffect, useRef, type ReactNode} from 'react';
import type {AuditEvent, Step} from './types';

export function Icon({name, size = 20}: {name: string; size?: number}) {
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    projects: <><path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 11h18"/></>,
    runbooks: <><path d="M5 3h12a2 2 0 0 1 2 2v16H7a3 3 0 0 1-3-3V4a1 1 0 0 1 1-1Z"/><path d="M4 17h15M8 7h7M8 11h5"/></>,
    releases: <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/></>,
    jobs: <><path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 12h8m-4-4v8"/></>,
    incidents: <><path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.2"/></>,
    audit: <><path d="M5 4h14v17H5zM9 4V2m6 2V2M9 9h6M9 13h6M9 17h3"/></>,
    arrow: <><path d="M5 12h14m-5-5 5 5-5 5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    shield: <><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z"/><path d="m8 12 3 3 5-6"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    play: <path d="m8 4 12 8-12 8V4Z"/>,
    anchor: <><circle cx="12" cy="5" r="2"/><path d="M12 7v14M7 11h10M3 14c0 9 18 9 18 0M3 14l-1 4m19-4 1 4"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{paths[name] || paths.overview}</svg>;
}

export function human(value: string) {return value.replaceAll('_', ' ');}
export function date(value?: string | null) {return value ? new Date(value).toLocaleString(undefined, {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : '—';}
export function Badge({value, children}: {value: string; children?: ReactNode}) {return <span className={`badge badge-${value}`}><i/>{children || human(value)}</span>;}
export function ErrorBox({message}: {message?: string}) {return message ? <div className="error" role="alert"><Icon name="incidents" size={18}/><span>{message}</span></div> : null;}
export function Empty({title, children, icon = 'projects'}: {title: string; children?: ReactNode; icon?: string}) {return <div className="empty"><div className="empty-icon"><Icon name={icon} size={28}/></div><h3>{title}</h3><div>{children}</div></div>;}
export function Loading() {return <div className="loading" role="status"><span className="spinner"/>Loading your workspace…</div>;}
export function Field({label, children, hint, wide}: {label: string; children: ReactNode; hint?: string; wide?: boolean}) {return <label className={`field${wide ? ' field-wide' : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;}
export function Modal({title, subtitle, children, onClose}: {title: string; subtitle?: string; children: ReactNode; onClose: () => void}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {const prior = document.activeElement as HTMLElement | null; const first = ref.current?.querySelector<HTMLElement>('input,select,textarea,button'); first?.focus();
    const handler = (e: KeyboardEvent) => {if (e.key === 'Escape') closeRef.current(); if (e.key === 'Tab') {const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]') || []); const firstControl = controls[0]; const last = controls[controls.length - 1]; if (e.shiftKey && document.activeElement === firstControl) {e.preventDefault(); last?.focus();} else if (!e.shiftKey && document.activeElement === last) {e.preventDefault(); firstControl?.focus();}}};
    document.addEventListener('keydown', handler); const original = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => {document.removeEventListener('keydown', handler); document.body.style.overflow = original; prior?.focus();};
  }, []);
  return <div className="modal-overlay"><div className="modal" ref={ref} role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="modal-header"><div><div className="eyebrow">WORKSPACE ACTION</div><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button type="button" className="icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></button></div>{children}</div></div>;
}

export type DraftStep = {key: string; name: string; kind: Step['kind']; dependencies: string; duration: string; failureMode: Step['failureMode']};
export function draftSteps(steps?: Step[]): DraftStep[] {return steps?.length ? steps.map(step => ({...step, dependencies:step.dependsOn.join(', '), duration:String(step.durationMs)})) : [{key:'check',name:'Preflight check',kind:'check',dependencies:'',duration:'500',failureMode:'never'}];}
export function planSignature(steps: Step[]) {return JSON.stringify(steps.map(s => [s.key,s.name,s.kind,s.dependsOn,s.durationMs,s.failureMode]));}
export function parseSteps(drafts: DraftStep[]): Step[] {
  if (drafts.length < 1 || drafts.length > 12) throw new Error('A plan needs between 1 and 12 steps.');
  const steps: Step[] = drafts.map((s, i) => {
    if (!/^[a-z0-9-]{1,32}$/.test(s.key)) throw new Error(`Step ${i + 1}: use a key of 1–32 lowercase letters, digits or hyphens.`);
    if (!s.name.trim()) throw new Error(`Step ${i + 1}: enter a step name.`);
    if (!/^\d+$/.test(s.duration) || Number(s.duration) < 100 || Number(s.duration) > 5000) throw new Error(`Step ${i + 1}: duration must be a whole number from 100 to 5000 ms.`);
    return {key:s.key,name:s.name,kind:s.kind,dependsOn:s.dependencies.trim() ? s.dependencies.split(',').map(d => d.trim()) : [],durationMs:Number(s.duration),failureMode:s.failureMode};
  });
  const keys = steps.map(s => s.key);
  if (new Set(keys).size !== keys.length) throw new Error('Step keys must be unique.');
  for (const step of steps) {if (new Set(step.dependsOn).size !== step.dependsOn.length) throw new Error(`${step.key}: dependencies must be distinct.`); for (const dep of step.dependsOn) {if (dep === step.key) throw new Error(`${step.key}: a step cannot depend on itself.`); if (!keys.includes(dep)) throw new Error(`${step.key}: dependency “${dep}” does not exist.`);}}
  const visited = new Set<string>(); const visiting = new Set<string>();
  const visit = (key: string) => {if (visiting.has(key)) throw new Error('This plan contains a dependency cycle. Give each step a clear path forward.'); if (visited.has(key)) return; visiting.add(key); steps.find(s => s.key === key)!.dependsOn.forEach(visit); visiting.delete(key); visited.add(key);}; keys.forEach(visit);
  return steps;
}
export function StepEditor({steps, onChange}: {steps: DraftStep[]; onChange: (steps: DraftStep[]) => void}) {
  const update = (index: number, patch: Partial<DraftStep>) => onChange(steps.map((step, i) => i === index ? {...step,...patch} : step));
  return <div className="step-editor"><div className="section-title"><div><h3>Execution plan</h3><p>Local simulation only. Dependencies run first.</p></div><span className="count">{steps.length} / 12 steps</span></div>{steps.map((step, i) => <fieldset className="step-edit" key={i}><legend><span className="step-number">{String(i+1).padStart(2,'0')}</span> Step {i+1}</legend><div className="form-grid"><Field label={`Step ${i+1} key`}><input value={step.key} onChange={e => update(i, {key:e.target.value})}/></Field><Field label={`Step ${i+1} name`}><input value={step.name} onChange={e => update(i, {name:e.target.value})}/></Field><Field label={`Step ${i+1} kind`}><select value={step.kind} onChange={e => update(i, {kind:e.target.value as Step['kind']})}><option value="check">Check</option><option value="build">Build</option><option value="deploy">Deploy</option></select></Field><Field label={`Step ${i+1} dependencies`} hint="Comma-separated step keys; blank runs independently."><input value={step.dependencies} onChange={e => update(i, {dependencies:e.target.value})} placeholder="e.g. check, build"/></Field><Field label={`Step ${i+1} duration`} hint="100–5000 milliseconds"><input type="number" min="100" max="5000" step="1" value={step.duration} onChange={e => update(i, {duration:e.target.value})}/></Field><Field label={`Step ${i+1} failure mode`}><select value={step.failureMode} onChange={e => update(i, {failureMode:e.target.value as Step['failureMode']})}><option value="never">Never fail</option><option value="once">Fail once, then succeed</option><option value="always">Always fail</option></select></Field></div>{steps.length > 1 && <button className="text-button danger-text" type="button" onClick={() => onChange(steps.filter((_,n) => n !== i))}>Remove step {i+1}</button>}</fieldset>)}<button type="button" className="button secondary" disabled={steps.length >= 12} onClick={() => onChange([...steps,{key:`step-${steps.length+1}`,name:`Step ${steps.length+1}`,kind:'build',dependencies:steps[steps.length-1].key,duration:'500',failureMode:'never'}])}><Icon name="plus" size={16}/>Add step</button></div>;
}

export function StepPlan({steps}: {steps: Step[]}) {return <div className="plan">{steps.map((step, i) => <div className="plan-step" key={step.key}><span className={`plan-symbol plan-${step.kind}`}><Icon name={step.kind === 'check' ? 'shield' : step.kind === 'build' ? 'jobs' : 'releases'} size={20}/></span><div className="plan-info"><div className="plan-title"><strong>{step.name}</strong><code>{step.key}</code></div><p>{step.dependsOn.length ? `Depends on ${step.dependsOn.join(', ')}` : 'No dependencies · starts independently'}</p></div><div className="plan-meta"><span>{step.kind}</span><span>{step.durationMs} ms</span><span>{step.failureMode === 'never' ? 'No simulated failure' : `Failure: ${step.failureMode}`}</span></div><span className="plan-order">{String(i+1).padStart(2,'0')}</span></div>)}</div>;}

export function AuditFeed({events, compact = false}: {events: AuditEvent[]; compact?: boolean}) {return events.length ? <div className={`audit-feed${compact ? ' compact' : ''}`}>{events.map(event => <div className="audit-event" key={event.id}><div className="audit-node"><Icon name={event.type.includes('incident') ? 'incidents' : event.type.includes('job') ? 'jobs' : 'releases'} size={16}/></div><div className="audit-content"><div className="audit-heading"><strong>{event.type}</strong><time>{date(event.createdAt)}</time></div><p>{event.actorId || 'system'} <span>·</span> Event #{event.sequence}</p>{!compact && <div className="event-details">{Object.entries(event.details || {}).map(([key,value]) => <span key={key}><b>{human(key)}</b> {typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>)}</div>}</div></div>)}</div> : <Empty icon="audit" title="A clean slate"><p>Changes made in Harbor will appear here.</p></Empty>;}

export function requireText(value: string, label: string) {if (!value.trim()) throw new Error(`${label} is required.`);}
