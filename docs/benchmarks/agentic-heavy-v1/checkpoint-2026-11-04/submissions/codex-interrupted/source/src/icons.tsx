import type { CSSProperties } from 'react';
export function Icon({name,size=20,style}:{name:string,size?:number,style?:CSSProperties}) {
 const paths:Record<string, React.ReactNode>={
 overview:<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
 customers:<><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M21 21v-3a6 6 0 0 0-3-5"/></>,
 inventory:<><path d="m12 3 9 5-9 5-9-5 9-5ZM3 8v9l9 5 9-5V8M12 13v9M7.5 5.5l9 5"/></>,
 orders:<><rect x="4" y="4" width="16" height="18" rx="2"/><path d="M9 4V2h6v2M8 10h8M8 14h8M8 18h5"/></>,
 invoices:<><path d="M5 3h14v19l-3-2-4 2-4-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h3"/></>,
 projects:<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16M5.5 9h1M11.5 13h1M17.5 8h1"/></>,
 activity:<><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
 team:<><circle cx="12" cy="8" r="3"/><path d="M6 21v-3a6 6 0 0 1 12 0v3M4 5a3 3 0 0 0 0 6M20 5a3 3 0 0 1 0 6M2 20v-3a4 4 0 0 1 2-3M22 20v-3a4 4 0 0 0-2-3"/></>,
 plus:<path d="M12 5v14M5 12h14"/>,arrow:<path d="m9 5 7 7-7 7"/>,close:<path d="m6 6 12 12M6 18 18 6"/>,search:<><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
 download:<><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,upload:<><path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/></>,
 edit:<><path d="m15 4 5 5M3 21l2-7L17 2l5 5-12 12-7 2Z"/></>,trash:<><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></>,
 check:<path d="m5 12 4 4L19 6"/>,clock:<><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,money:<><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M6 9v6M18 9v6"/></>,logout:<><path d="M9 4H4v16h5M14 7l5 5-5 5M8 12h12"/></>,menu:<path d="M4 6h16M4 12h16M4 18h16"/>,folder:<path d="M3 7V4h7l2 3h9v14H3V7Z"/>,spark:<><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/></>,file:<><path d="M5 2h9l5 5v15H5V2ZM14 2v6h5M9 13h6M9 17h6"/></>,link:<><path d="m9 15 6-6M8 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/></>,
 };
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]||paths.folder}</svg>;
}
