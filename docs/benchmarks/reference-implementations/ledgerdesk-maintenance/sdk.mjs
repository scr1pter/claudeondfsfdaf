export class ApiError extends Error {
  constructor(status, code, message){super(message);this.name='ApiError';this.status=status;this.code=code}
}
export function createClient({baseUrl,apiKey}){
  async function call(method,path,body){
    const response=await fetch(baseUrl.replace(/\/$/,'')+path,{method,headers:{Authorization:'Bearer '+apiKey,
      ...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})})
    const data=await response.json()
    if(!response.ok)throw new ApiError(response.status,data.error?.code||'api_error',data.error?.message||'Request failed')
    return data
  }
  const id=encodeURIComponent
  return {
    listAccounts:()=>call('GET','/api/accounts'),createAccount:body=>call('POST','/api/accounts',body),
    recordUsage:(a,body)=>call('POST','/api/accounts/'+id(a)+'/usage',body),
    listUsage:(a,period)=>call('GET','/api/accounts/'+id(a)+'/usage'+(period?'?period='+id(period):'')),
    quote:(a,p)=>call('GET','/api/accounts/'+id(a)+'/quote?period='+id(p)),
    issueInvoice:(a,body)=>call('POST','/api/accounts/'+id(a)+'/invoices',body),
    getInvoice:i=>call('GET','/api/invoices/'+id(i)),creditInvoice:(i,body)=>call('POST','/api/invoices/'+id(i)+'/credits',body),
    listCredits:i=>call('GET','/api/invoices/'+id(i)+'/credits'),createKey:body=>call('POST','/api/access-keys',body),
    revokeKey:k=>call('POST','/api/access-keys/'+id(k)+'/revoke',{})
  }
}
