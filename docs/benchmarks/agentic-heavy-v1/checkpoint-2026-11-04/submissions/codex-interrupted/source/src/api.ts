export async function api(path:string, options:RequestInit={}) {
 const isForm=options.body instanceof FormData;
 const res=await fetch(path,{credentials:'same-origin',...options,headers:{...(!isForm&&options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
 if(!res.ok){let message='Something went wrong. Please try again.';try{const data=await res.json();message=data.error?.message||message;}catch{} throw Object.assign(new Error(message),{status:res.status});}
 return res.status===204?{}:res.json();
}
export const json=(method:string,body?:unknown):RequestInit=>({method,...(body!==undefined?{body:JSON.stringify(body)}:{})});
export const money=(cents:number=0)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
export const date=(value:string|null)=>value?new Date(value).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—';
export const initials=(name:string='')=>name.split(' ').map(n=>n[0]).slice(0,2).join('').toUpperCase();
export const statusName=(value:string)=>({todo:'Todo',in_progress:'In progress',done:'Done',read_only:'Read only'}[value]||value.charAt(0).toUpperCase()+value.slice(1));
export type Row=Record<string,any>;
