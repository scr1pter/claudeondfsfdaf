import {createContext, useContext, useEffect, useState, type ReactNode} from 'react';
import {api, query, useData} from './api';
import type {Actor, Project} from './types';
import {ErrorBox, Icon, Loading} from './ui';
import {Overview, Projects, ProjectDetail, Runbooks, RunbookDetail, Releases, ReleaseDetail, Jobs, JobDetail, Incidents, IncidentDetail, Audit} from './screens';

type Context = {actor: Actor; projectId: string; projects: Project[]; revision: number; refresh: () => void; navigate: (href: string) => void; scoped: (path: string, project?: string) => string; canWrite: boolean; isAdmin: boolean};
const AppContext = createContext<Context | null>(null);
export function useApp() {const value = useContext(AppContext); if (!value) throw new Error('Workspace unavailable.'); return value;}
export function Link({to, children, className, ...props}: {to: string; children: ReactNode; className?: string; 'aria-label'?: string}) {const {navigate} = useApp(); return <a href={to} className={className} {...props} onClick={e => {if (!e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) {e.preventDefault(); navigate(to);}}}>{children}</a>;}
const nav = ['Overview','Projects','Runbooks','Releases','Jobs','Incidents','Audit'];

export default function App() {
  const [url, setUrl] = useState(() => window.location.pathname + window.location.search);
  const [actor, setActor] = useState<Actor | null>(null);
  const [actors, setActors] = useState<Actor[]>([]);
  const [revision, setRevision] = useState(0);
  const [sessionError, setSessionError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [lastProject, setLastProject] = useState(() => localStorage.getItem('harbor-project') || '');
  const parsed = new URL(url, window.location.origin); const [section = 'overview', id] = parsed.pathname.split('/').filter(Boolean);
  const {data: projectData} = useData<{projects: Project[]}>(actor ? '/api/projects' : null, revision);
  const projects = projectData?.projects || [];
  const requestedProject = section === 'projects' && id ? id : parsed.searchParams.get('project') || lastProject;
  const projectId = projects.some(p => p.id === requestedProject) ? requestedProject : projects[0]?.id || '';
  const refresh = () => setRevision(value => value + 1);
  const navigate = (href: string) => {window.history.pushState({}, '', href); setUrl(window.location.pathname + window.location.search); window.scrollTo({top:0});};
  const scoped = (path: string, project = projectId) => `${path}${query({project})}`;
  useEffect(() => {const handler = () => setUrl(window.location.pathname + window.location.search); window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler);}, []);
  useEffect(() => {void (async () => {try {const available = await api<{actors: Actor[]}>('/api/actors'); setActors(available.actors); let session: {actor: Actor}; try {session = await api('/api/session');} catch {session = await api('/api/session','POST',{actorId:'operator'});} setActor(session.actor); setSessionError('');} catch (e) {setSessionError((e as Error).message);}})();}, []);
  useEffect(() => {if (projectId) {setLastProject(projectId); localStorage.setItem('harbor-project', projectId);}}, [projectId]);
  const selectActor = async (actorId: string) => {setSwitching(true); try {const result = await api<{actor: Actor}>('/api/session','POST',{actorId}); setActor(result.actor); setSessionError(''); refresh();} catch (e) {setSessionError((e as Error).message);} finally {setSwitching(false);}};
  if (!actor) return <div className="boot"><div className="brand-mark"><Icon name="anchor" size={32}/></div><h1>Harbor</h1>{sessionError ? <ErrorBox message={sessionError}/> : <Loading/>}</div>;
  const context: Context = {actor,projectId,projects,revision,refresh,navigate,scoped,canWrite:actor.role !== 'viewer',isAdmin:actor.role === 'admin'};
  const scopedScreen = ['runbooks','releases','incidents','audit','jobs'].includes(section);
  let screen: ReactNode;
  if (section === 'projects') screen = id ? <ProjectDetail id={id}/> : <Projects/>;
  else if (section === 'runbooks') screen = id ? <RunbookDetail id={id}/> : <Runbooks/>;
  else if (section === 'releases') screen = id ? <ReleaseDetail id={id}/> : <Releases/>;
  else if (section === 'jobs') screen = id ? <JobDetail id={id}/> : <Jobs/>;
  else if (section === 'incidents') screen = id ? <IncidentDetail id={id}/> : <Incidents/>;
  else if (section === 'audit') screen = <Audit/>;
  else screen = <Overview/>;
  return <AppContext.Provider value={context}><div className="app-shell"><aside className="sidebar"><Link to="/overview" className="brand"><span className="brand-mark"><Icon name="anchor" size={25}/></span><span>harbor<span className="brand-dot">.</span></span></Link><div className="workspace-label"><span className="workspace-avatar">H</span><div>Local workspace<small>Synthetic operations</small></div><span className="workspace-chevron">⌄</span></div><div className="nav-label">WORKSPACE</div><nav aria-label="Primary navigation">{nav.map(item => <Link key={item} to={item === 'Overview' || item === 'Projects' ? `/${item.toLowerCase()}` : scoped(`/${item.toLowerCase()}`)} className={`nav-link${section === item.toLowerCase() ? ' active' : ''}`}><Icon name={item.toLowerCase()}/><span>{item}</span>{section === item.toLowerCase() && <span className="nav-active-dot"/>}</Link>)}</nav><div className="sidebar-bottom"><div className="local-indicator"><i/> All systems local</div><p>Simulated releases.<br/>Real operational clarity.</p><div className="sidebar-version">HARBOR CONSOLE <span>v1.0</span></div></div></aside><div className="workspace-main"><header className="topbar"><div className="breadcrumb"><span>Workspace</span><span className="slash">/</span><strong>{nav.find(item => item.toLowerCase() === section) || 'Overview'}</strong>{id && <><span className="slash">/</span><span>Details</span></>}</div><div className="topbar-right"><span className="local-pill"><i/>LOCAL SIMULATOR</span><div className="actor-control"><span className={`avatar avatar-${actor.role}`}>{actor.name.split(' ').map(n => n[0]).join('')}</span><label className="actor-select"><span>Actor <small>· {actor.role}</small></span><select aria-label="Actor" value={actor.id} disabled={switching} onChange={e => void selectActor(e.target.value)}>{actors.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label></div></div></header><main className="main-content"><ErrorBox message={sessionError}/>{scopedScreen && <div className="scope-bar"><label><Icon name="projects" size={16}/><span>Project</span><select aria-label="Project" value={projectId} onChange={e => {setLastProject(e.target.value); localStorage.setItem('harbor-project',e.target.value); navigate(`/${section}${query({project:e.target.value})}`);}}>{!projects.length && <option value="">No projects yet</option>}{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><span>{actor.role === 'viewer' ? 'Read-only access · switch actor to make changes' : actor.role === 'operator' ? 'Operator access · approvals require an admin' : 'Admin access · release authors cannot self-approve'}</span></div>}{screen}</main><footer className="app-footer"><span><Icon name="anchor" size={14}/> Harbor · local release operations</span><span>Everything stays in this workspace.</span></footer></div></div></AppContext.Provider>;
}
