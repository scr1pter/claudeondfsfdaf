import { date, money, useApp, useResource } from './api';
import type { Activity, Invoice, Summary } from './types';
import { Badge, Button, Empty, Icon, PageHeader, ResourceState } from './ui';

export function Dashboard({onNavigate}: {onNavigate:(page:string)=>void}) {
  const {base, session, canManage, canEdit} = useApp();
  const summary = useResource<Summary>(`${base}/summary`);
  const invoices = useResource<{invoices: Invoice[]}>(`${base}/invoices`);
  const activity = useResource<{activity: Activity[]}>(`${base}/activity?limit=6`);
  const s=summary.data;
  const cards = s ? [
    {name:'Revenue',value:money(s.revenueCents),hint:'Paid invoices · all time',icon:'Invoices',page:'Invoices',accent:true},
    {name:'Unpaid invoices',value:money(s.unpaidCents),hint:'Draft & sent invoices',icon:'Orders',page:'Invoices'},
    {name:'Open orders',value:s.openOrders,hint:`${s.fulfilledOrders} fulfilled to date`,icon:'Orders',page:'Orders'},
    {name:'Low stock',value:s.lowStockProducts,hint:`Of ${s.products} inventory products`,icon:'Inventory',page:'Inventory'},
    {name:'Open tasks',value:s.openTasks,hint:`${s.completedTasks} completed`,icon:'Projects',page:'Projects'},
    {name:'Customers',value:s.customers,hint:'Relationships, in one place',icon:'Customers',page:'Customers'},
  ] : [];
  const states=['draft','sent','paid','void'];
  const totals=states.map(state=>invoices.data?.invoices.filter(i=>i.status===state).reduce((n,i)=>n+i.totalCents,0)||0);
  const largest=Math.max(1,...totals);
  const completed=s?.completedTasks||0,open=s?.openTasks||0,total=completed+open;
  return <><PageHeader eyebrow="THE BIG PICTURE" title={`A clearer day, ${session.user.name.split(' ')[0]}.`} description="Everything that moves your business forward, in one place."><span className="today">{new Date().toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'})}</span></PageHeader><ResourceState {...summary} hasData={!!s}/>
    <div className="stats-grid">{cards.map(c=><section aria-label={c.name} key={c.name} className={`stat-card ${c.accent?'accent':''}`}><div className="stat-top"><span>{c.name}</span><Icon name={c.icon}/></div><strong>{c.value}</strong><div className="stat-bottom"><small>{c.hint}</small><button aria-label={`View ${c.name}`} onClick={()=>onNavigate(c.page)}>↗</button></div></section>)}</div>
    <div className="dashboard-grid"><section className="panel financial-panel"><div className="section-heading"><div><h2>Money in motion</h2><p>Invoice value, by current status</p></div><Button tone="ghost" onClick={()=>onNavigate('Invoices')}>View invoices <Icon name="arrow" size={16}/></Button></div><ResourceState {...invoices} hasData={!!invoices.data}/><div className="bar-chart" role="img" aria-label={states.map((state,i)=>`${state}: ${money(totals[i])}`).join(', ')}>{states.map((state,i)=><div className="bar-column" key={state}><span className="bar-value">{money(totals[i])}</span><div className="bar-track"><div className={`bar-fill ${state}`} style={{height:`${totals[i]/largest*100}%`,minHeight:totals[i]?4:0}}/></div><Badge value={state}/></div>)}</div><div className="chart-note"><span className="local-dot"/> Live totals from your actual invoices. No projections.</div></section>
    <section className="panel delivery-panel"><div className="section-heading"><div><h2>A little momentum</h2><p>Your team’s delivery at a glance</p></div></div><div className="progress-ring" style={{background:`conic-gradient(var(--orange) ${total?completed/total*360:0}deg, #ece9e2 0)`}} role="img" aria-label={`${completed} of ${total} tasks completed`}><div><strong>{total?Math.round(completed/total*100):0}<span>%</span></strong><small>tasks completed</small></div></div><div className="ring-legend"><span><i className="dot orange"/>{completed} done</span><span><i className="dot pale"/>{open} open</span></div><Button onClick={()=>onNavigate('Projects')}>Find your next task <Icon name="arrow" size={16}/></Button></section></div>
    <div className="dashboard-lower"><section className="panel"><div className="section-heading"><div><h2>The latest, together</h2><p>Real work, as it happens</p></div><Button tone="ghost" onClick={()=>onNavigate('Activity')}>All activity <Icon name="arrow" size={16}/></Button></div><ResourceState {...activity} hasData={!!activity.data}/>{activity.data && <ActivityList entries={activity.data.activity}/>}</section><section className="next-step"><div className="eyebrow">SPACE TO MAKE PROGRESS</div><h2>Small steps.<br/>Stronger business.</h2><p>Keep the essentials connected. Give the important things room to grow.</p><div className="quick-links">{canEdit&&<button onClick={()=>onNavigate('Customers')}><Icon name="Customers"/>Build a customer relationship<span>↗</span></button>}{canManage&&<button onClick={()=>onNavigate('Orders')}><Icon name="Orders"/>Move an order forward<span>↗</span></button>}<button onClick={()=>onNavigate('Projects')}><Icon name="Projects"/>See what’s next for the team<span>↗</span></button></div><span className="decorative-asterisk" aria-hidden="true">✳</span></section></div>
  </>;
}
export function ActivityList({entries}: {entries: Activity[]}) {
  if (!entries.length) return <Empty title="Your story starts here">New activity will appear as your team gets to work.</Empty>;
  return <ol className="activity-list">{entries.map(a=><li key={a.id}><span className="event-avatar">{a.actorName.slice(0,1).toUpperCase()}</span><div><p><strong>{a.actorName}</strong> {humanAction(a.action)}</p><small>{date(a.createdAt)} · {new Date(a.createdAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}</small></div><span className="event-type">{a.entityType.replaceAll('_',' ')}</span></li>)}</ol>;
}
function humanAction(action:string) {const [entity,verb]=action.split('.');const verbs:Record<string,string>={created:'created',updated:'updated',deleted:'deleted',fulfilled:'fulfilled',cancelled:'cancelled',paid:'marked paid',sent:'marked sent',voided:'voided',adjusted:'adjusted',removed:'removed',accepted:'accepted',role_changed:'changed the role of a'};return `${verbs[verb]||verb||'updated'} ${entity?.replaceAll('_',' ')||'a record'}`;}
export function ActivityPage() {const {base}=useApp();const resource=useResource<{activity:Activity[]}>(`${base}/activity?limit=500`);return <><PageHeader title="Activity" description="A shared record of the work that moves things forward."/><section className="panel"><div className="section-heading"><div><h2>Workspace timeline</h2><p>Latest 500 events · automatically updated</p></div><span className="badge done">Persisted audit trail</span></div><ResourceState {...resource} hasData={!!resource.data}/>{resource.data&&<ActivityList entries={resource.data.activity}/>}</section></>;}
