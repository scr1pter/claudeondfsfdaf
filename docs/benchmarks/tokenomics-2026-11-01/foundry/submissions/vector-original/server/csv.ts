export function parseCsv(input: string): string[][] {
  const rows: string[][]=[]; let row: string[]=[],cell='',quoted=false,closed=false;
  if(input.charCodeAt(0)===0xfeff) input=input.slice(1);
  for(let i=0;i<input.length;i++) {
    const c=input[i];
    if(quoted) { if(c==='"') { if(input[i+1]==='"') { cell+='"'; i++; } else {quoted=false;closed=true;} } else cell+=c; }
    else if(c==='"') { if(cell || closed) throw new Error('Invalid CSV quoting'); quoted=true; }
    else if(c===',') {row.push(cell);cell='';closed=false;}
    else if(c==='\n' || c==='\r') { if(c==='\r' && input[i+1]==='\n') i++; row.push(cell);rows.push(row);row=[];cell='';closed=false; }
    else {if(closed) throw new Error('Unexpected text after a CSV quote');cell+=c;}
  }
  if(quoted) throw new Error('Unclosed CSV quote');
  if(cell || row.length || closed) {row.push(cell);rows.push(row);}
  return rows;
}
export function exportCsv(headers: string[], records: Record<string,any>[]) {
  const escape=(value: unknown)=>{ let s=value==null ? '' : String(value); if(typeof value==='string' && (/^[\t\r]/.test(s) || /^[\s]*[=+\-@]/.test(s))) s="'"+s; return /[",\r\n]/.test(s) ? '"'+s.replaceAll('"','""')+'"' : s; };
  return [headers.join(','),...records.map(r=>headers.map(h=>escape(r[h])).join(','))].join('\r\n')+'\r\n';
}
