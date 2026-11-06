import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, AppContext, json, label, message, useAction } from './api';
import type { Session, Workspace } from './types';
import { Brand, Button, ErrorNotice, Field, FormActions, Icon, Loading, Modal, Notice } from './ui';
import { Dashboard, ActivityPage } from './Dashboard';
import { Customers } from './Customers';
import { Inventory } from './Inventory';
import { Orders, Invoices } from './Sales';
import { Projects } from './Projects';
import { Team } from './Team';

const pages = ['Overview', 'Customers', 'Inventory', 'Orders', 'Invoices', 'Projects', 'Activity', 'Team'] as const;
type Page = typeof pages[number];
function currentPage(): Page { const segment = location.pathname.split('/')[1]?.toLowerCase(); return pages.find(p => p.toLowerCase() === segment) || 'Overview'; }

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [path, setPath] = useState(location.pathname);
  const [version, setVersion] = useState(0);
  const [online, setOnline] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState(false);
  const action = useAction();
  const selected = useRef<string | null>(null);
  const revision = useRef<number | null>(null);
  const navigate = (target: string) => { history.pushState({}, '', target); setPath(target); setMobile(false); };
  useEffect(() => { const handler = () => setPath(location.pathname); window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler); }, []);
  const reloadSession = useCallback(async () => {
    const me = await api<Session>('/api/auth/me');
    setSession(old => JSON.stringify(old) === JSON.stringify(me) ? old : me);
    return;
  }, []);
  useEffect(() => { reloadSession().catch(e => { if (!(e instanceof ApiError && e.status === 401)) setError(message(e)); }).finally(() => setLoading(false)); }, [reloadSession]);
  const workspace = session?.workspaces.find(w => w.id === session.activeWorkspaceId) || session?.workspaces[0];
  selected.current = workspace?.id || null;
  useEffect(() => { revision.current = null; setVersion(v => v + 1); }, [workspace?.id]);
  // A serialized polling loop avoids overlapping requests. Authentication is rechecked even
  // when the revision does not change, so role changes and membership revocation take effect.
  useEffect(() => {
    if (!session) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const started = Date.now();
      try {
        const me = await api<Session>('/api/auth/me');
        if (stopped) return;
        setSession(old => JSON.stringify(old) === JSON.stringify(me) ? old : me);
        const id = me.workspaces.find(w => w.id === me.activeWorkspaceId)?.id || me.workspaces[0]?.id;
        if (id) {
          const sync = await api<{revision: number}>(`/api/w/${encodeURIComponent(id)}/sync`);
          if (stopped) return;
          if (selected.current === id && revision.current !== sync.revision) { revision.current = sync.revision; setVersion(v => v + 1); }
        }
        setOnline(true); setError('');
      } catch (e) {
        if (!stopped) { setOnline(false); if (e instanceof ApiError && e.status === 401) { setSession(null); setError('Your session has ended. Please sign in again.'); } else setError(message(e)); }
      }
      if (!stopped) timer = setTimeout(poll, Math.max(100, 1500 - (Date.now() - started)));
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [!!session]);
  const refresh = useCallback(() => setVersion(v => v + 1), []);
  if (loading) return <div className="startup"><Brand/><Loading/></div>;
  if (!session) return <Auth path={path} navigate={navigate} error={error} onDone={async () => { await reloadSession(); navigate(path === '/join' ? '/join' : '/overview'); }}/>;
  if (!workspace) return <div className="startup"><Brand/><h1>A fresh workspace awaits</h1><Button tone="primary" onClick={() => setNewWorkspace(true)}>New workspace</Button><Button onClick={() => navigate('/join')}>Join workspace</Button>{path === '/join' && <Join onDone={async () => { await reloadSession(); navigate('/overview'); }}/>}<Button onClick={() => action.run(async () => {await api('/api/auth/logout',json('POST'));setSession(null);navigate('/signin');})}>Sign out</Button><ErrorNotice error={action.error}/>{newWorkspace && <NewWorkspace onClose={() => setNewWorkspace(false)} onDone={async () => {await reloadSession();setNewWorkspace(false);}}/>}</div>;
  const page = currentPage();
  return <AppContext.Provider value={{session, workspace, base: `/api/w/${encodeURIComponent(workspace.id)}`, version, refresh, reloadSession, canEdit: workspace.role !== 'read_only', canManage: workspace.role === 'owner' || workspace.role === 'manager', isOwner: workspace.role === 'owner'}}>
    <div className="app-shell"><aside className={`sidebar ${mobile ? 'mobile-open' : ''}`}>
      <a className="brand-link" href="/overview" onClick={e => {e.preventDefault();navigate('/overview');}}><Brand/></a><button className="nav-close" aria-label="Close navigation" onClick={() => setMobile(false)}><Icon name="close"/></button>
      <div className="workspace-switch"><label htmlFor="workspace-select">Workspace</label><select id="workspace-select" value={workspace.id} disabled={action.busy} onChange={e => {const id=e.target.value; void action.run(async () => {await api(`/api/workspaces/${encodeURIComponent(id)}/select`,json('POST'));revision.current=null;await reloadSession();setVersion(v=>v+1);});}}>{session.workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select><button className="new-workspace" onClick={() => setNewWorkspace(true)}><Icon name="plus" size={14}/>New workspace</button></div>
      <div className="nav-heading">WORKSPACE</div><nav aria-label="Main navigation">{pages.map((p, i) => <a href={`/${p.toLowerCase()}`} aria-current={page === p && path !== '/join' ? 'page' : undefined} key={p} onClick={e => {e.preventDefault();navigate(`/${p.toLowerCase()}`);}}><Icon name={p}/><span>{p}</span>{i === 0 && <span className="nav-shortcut" aria-hidden="true">⌘ 1</span>}</a>)}</nav>
      <div className="sidebar-bottom"><div className="local-card"><span className="local-dot"/><strong>Made for working together</strong><p>One workspace. A clearer picture.</p></div><button className="join-link" onClick={() => navigate('/join')}>Have an invite? Join workspace <span>↗</span></button><div className="profile"><span className="avatar">{session.user.name.slice(0,2).toUpperCase()}</span><div><strong>{session.user.name}</strong><small>{label(workspace.role)}</small></div><Button tone="ghost" aria-label="Sign out" title="Sign out" disabled={action.busy} onClick={() => action.run(async () => {await api('/api/auth/logout',json('POST'));setSession(null);navigate('/signin');})}><Icon name="logout" size={18}/></Button></div></div>
    </aside><div className="workspace-main"><header className="topbar"><div className="breadcrumb"><button className="mobile-toggle" aria-label="Open navigation" aria-expanded={mobile} onClick={() => setMobile(!mobile)}><Icon name="menu"/></button><span>{workspace.name}</span><span className="breadcrumb-slash">/</span><strong>{path === '/join' ? 'Join workspace' : page}</strong></div><div className="topbar-right"><span className={`live-status ${online ? 'connected' : ''}`}><i/>{online ? 'Live workspace' : 'Connecting…'}</span><span className="role-pill">{label(workspace.role)}</span><span className="avatar small">{session.user.name.slice(0,1).toUpperCase()}</span></div></header>
      <main id="main-content" key={`${workspace.id}:${workspace.role}`}><ErrorNotice error={error || action.error}/>{path === '/join' ? <Join onDone={async () => {await reloadSession();navigate('/overview');}}/> : page === 'Overview' ? <Dashboard onNavigate={p => navigate(`/${p.toLowerCase()}`)}/> : page === 'Customers' ? <Customers/> : page === 'Inventory' ? <Inventory/> : page === 'Orders' ? <Orders/> : page === 'Invoices' ? <Invoices/> : page === 'Projects' ? <Projects/> : page === 'Activity' ? <ActivityPage/> : <Team/>}</main>
      <footer className="workspace-footer"><span>Foundry · A little less busywork. A lot more clarity.</span><span>Local prototype · USD</span></footer>
    </div></div>{newWorkspace && <NewWorkspace onClose={() => setNewWorkspace(false)} onDone={async () => {await reloadSession();setNewWorkspace(false);navigate('/overview');}}/>}
  </AppContext.Provider>;
}

function Auth({path, navigate, error, onDone}: {path: string; navigate: (path: string) => void; error: string; onDone: () => Promise<void>}) {
  const signup = path === '/signup';
  const action = useAction();
  const [name,setName] = useState(''); const [email,setEmail] = useState(''); const [password,setPassword] = useState('');
  return <div className="auth-shell"><section className="auth-story"><Brand/><div><div className="eyebrow">LESS FRICTION. MORE FORWARD.</div><h1>Good work starts<br/>with a clear view.</h1><p>Your customers, operations, and next big idea.<br/>Finally, all in one place.</p><div className="auth-art" aria-hidden="true"><div className="art-orbit"/><div className="art-card"><span>WORK, IN HARMONY</span><div className="art-bars"><i/><i/><i/><i/><i/><i/></div><strong>Make room for what’s next.</strong></div><span className="art-label"><Icon name="check"/> Everything, connected.</span></div></div><small>A thoughtful home for your business.</small></section><section className="auth-form-panel"><div className="auth-form"><div className="eyebrow">WELCOME TO FOUNDRY</div><h2>{signup ? 'Build something great.' : 'Welcome back.'}</h2><p>{signup ? 'Create your account and bring your work together.' : path === '/join' ? 'Sign in first to accept your workspace invitation.' : 'A little clarity for the day ahead.'}</p><ErrorNotice error={error || action.error}/><form onSubmit={e => {e.preventDefault();void action.run(async () => {if(signup) await api('/api/auth/signup',json('POST',{name,email,password}));else await api('/api/auth/login',json('POST',{email,password}));await onDone();});}}>{signup && <Field label="Name"><input value={name} onChange={e=>setName(e.target.value)} required autoComplete="name" placeholder="Your full name"/></Field>}<Field label="Email"><input type="email" value={email} onChange={e=>setEmail(e.target.value)} required autoComplete="email" placeholder="you@example.invalid"/></Field><Field label="Password" hint={signup ? 'Use at least 12 characters.' : undefined}><input type="password" value={password} onChange={e=>setPassword(e.target.value)} minLength={signup ? 12 : undefined} required autoComplete={signup?'new-password':'current-password'}/></Field><Button tone="primary" type="submit" disabled={action.busy} className="auth-submit">{action.busy?'Please wait…':signup?'Create account':'Sign in'}<Icon name="arrow" size={18}/></Button></form><p className="auth-switch">{signup?'Already have an account?':'New to Foundry?'} <a href={signup?'/signin':'/signup'} onClick={e=>{e.preventDefault();action.setError('');navigate(signup?'/signin':'/signup');}}>{signup?'Sign in':'Create an account'}</a></p><div className="privacy-note"><span className="local-dot"/> Local-first prototype. Synthetic data only.</div></div></section></div>;
}
function NewWorkspace({onClose,onDone}: {onClose:()=>void;onDone:()=>Promise<void>}) {const [name,setName]=useState('');const action=useAction();return <Modal title="New workspace" onClose={onClose}><p className="muted">A separate home for a new team or business. Your data stays independent.</p><form onSubmit={e=>{e.preventDefault();void action.run(async()=>{const result=await api<{workspace:Workspace}>('/api/workspaces',json('POST',{name}));await api(`/api/workspaces/${encodeURIComponent(result.workspace.id)}/select`,json('POST'));await onDone();});}}><Field label="Workspace name"><input required value={name} onChange={e=>setName(e.target.value)} autoFocus/></Field><ErrorNotice error={action.error}/><FormActions busy={action.busy} submit="Create workspace" onClose={onClose}/></form></Modal>;}
function Join({onDone}: {onDone:()=>Promise<void>}) {const [token,setToken]=useState('');const [success,setSuccess]=useState(false);const action=useAction();return <section className="join-panel panel"><div className="eyebrow">BETTER, TOGETHER</div><h1>Join a workspace</h1><p className="muted">Paste the local invite token shared by your workspace owner. Your account email must match the invitation.</p>{success && <Notice>Welcome to your new workspace.</Notice>}<form onSubmit={e=>{e.preventDefault();void action.run(async()=>{const result=await api<{workspace:Workspace}>('/api/invites/accept',json('POST',{token}));await api(`/api/workspaces/${encodeURIComponent(result.workspace.id)}/select`,json('POST'));setSuccess(true);await onDone();});}}><Field label="Invite token"><input value={token} onChange={e=>setToken(e.target.value)} required autoComplete="off"/></Field><ErrorNotice error={action.error}/><Button type="submit" tone="primary" disabled={action.busy}>{action.busy?'Joining…':'Join workspace'}</Button></form></section>;}
