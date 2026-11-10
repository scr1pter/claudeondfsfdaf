import {createClient} from './sdk.mjs'
const args=process.argv.slice(2)
const c=createClient({baseUrl:process.env.LEDGER_URL||'http://127.0.0.1:3000',apiKey:process.env.LEDGER_KEY||''})
try{
  let result
  if(args.length===1&&['help','--help','-h'].includes(args[0]))result={commands:['accounts list','quote <accountId> <period>','usage add <accountId> <eventId> <units> <occurredAt>','invoice issue <accountId> <period> <requestId>','invoice show <invoiceId>','credit add <invoiceId> <requestId> <amountCents> <reason>']}
  else if(args.length===2&&args[0]==='accounts'&&args[1]==='list')result=await c.listAccounts()
  else if(args.length===3&&args[0]==='quote')result=await c.quote(args[1],args[2])
  else if(args.length===6&&args[0]==='usage'&&args[1]==='add')result=await c.recordUsage(args[2],{eventId:args[3],units:Number(args[4]),occurredAt:args[5]})
  else if(args.length===5&&args[0]==='invoice'&&args[1]==='issue')result=await c.issueInvoice(args[2],{period:args[3],requestId:args[4]})
  else if(args.length===3&&args[0]==='invoice'&&args[1]==='show')result=await c.getInvoice(args[2])
  else if(args.length===6&&args[0]==='credit'&&args[1]==='add')result=await c.creditInvoice(args[2],{requestId:args[3],amountCents:Number(args[4]),reason:args[5]})
  else throw Object.assign(Error('Unknown or incomplete command'),{code:'invalid_command'})
  console.log(JSON.stringify(result))
}catch(error){console.error(JSON.stringify({error:{code:error.code||'client_error',message:error.status?error.message:'Invalid command or unavailable service'}}));process.exitCode=1}
