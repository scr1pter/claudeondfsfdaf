import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ApiError, json, empty, readJson, requiredString, optionalString, integer, allowFields, requireRole, parseCsv, csvResponse } from './common';
import { DATA_DIR, db, transaction, recordActivity, getRecord, listRecords, putRecord, deleteRecord, nextNumber as durableNextNumber, type WorkspaceContext } from './data';

const editors = ['owner', 'manager', 'member'];
const managers = ['owner', 'manager'];
const uuid = () => crypto.randomUUID();
const timestamp = () => new Date().toISOString();
const fail = (status: number, message: string): never => { throw new ApiError(status, status === 409 ? 'conflict' : status === 404 ? 'not_found' : 'invalid_input', message); };
const choice = (value: unknown, choices: string[], label: string): string => typeof value === 'string' && choices.includes(value) ? value : fail(400, `${label} is invalid.`);
const emailValue = (value: unknown): string => {
  const email = optionalString(value, 'Email', 320).trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Email must be a valid email address.');
  return email;
};
const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const copyPublicAttachment = (a: any) => { const { path: _path, ...pub } = a; return pub; };

export async function businessRoutes(request: Request, url: URL, ctx: WorkspaceContext, segments: string[]): Promise<Response | null> {
  const method = request.method, wid = ctx.workspaceId;
  const [kind, rid, sub] = segments;
  const list = (type: string): any[] => listRecords(type, wid);
  const get = (type: string, id: unknown): any => getRecord(type, requiredString(id, `${type} ID`, 200), wid);
  const put = (type: string, obj: any) => putRecord(type, wid, obj);
  const del = (type: string, id: string) => deleteRecord(type, id, wid);
  const log = (action: string, type: string, id: string) => recordActivity(ctx, action, type, id);
  const pendingFileDeletes: string[] = [];
  const mutate = <T>(fn: () => T): T => {
    const queueStart = pendingFileDeletes.length;
    let result: T;
    try { result = transaction(fn); }
    catch (error) { pendingFileDeletes.length = queueStart; throw error; }
    // The metadata deletion has committed. A later filesystem failure must never
    // roll it back and restore a record whose original bytes are already gone.
    for (const path of pendingFileDeletes.splice(queueStart)) {
      try { unlinkSync(path); }
      catch (error: any) { if (error.code !== 'ENOENT') console.error('Owned attachment cleanup failed:', error.code || 'filesystem_error'); }
    }
    return result;
  };
  const createBase = () => ({ id: uuid(), createdAt: timestamp(), updatedAt: timestamp() });
  const unique = (type: string, field: string, value: string, except?: string) => {
    if (value && list(type).some(x => x.id !== except && String(x[field]).toLowerCase() === value.toLowerCase())) fail(409, `${field === 'email' ? 'Email' : 'SKU'} is already in use in this workspace.`);
  };
  const nextNumber = (type: 'order' | 'invoice', _prefix: string) => durableNextNumber(wid, type);
  const entityType = (value: unknown): string => choice(value, ['customer', 'order', 'task'], 'Entity type');
  const removeAttachment = (a: any) => {
    del('attachment', a.id);
    pendingFileDeletes.push(join(DATA_DIR, 'attachments', a.id));
  };
  const removeOwnedAttachments = (type: string, id: string) => { for (const a of list('attachment').filter(a => a.entityType === type && a.entityId === id)) removeAttachment(a); };
  const removeTask = (task: any) => {
    for (const comment of list('comment').filter(c => c.taskId === task.id)) del('comment', comment.id);
    removeOwnedAttachments('task', task.id); del('task', task.id);
  };
  const customerValues = (b: Record<string, any>, old?: any) => {
    allowFields(b, ['name', 'email', 'company', 'notes']);
    const value = {...old};
    if (!old || has(b, 'name')) value.name = requiredString(b.name, 'Name', 500);
    if (!old || has(b, 'email')) value.email = emailValue(b.email);
    if (!old || has(b, 'company')) value.company = optionalString(b.company, 'Company', 1000);
    if (!old || has(b, 'notes')) value.notes = optionalString(b.notes, 'Notes', 100000);
    return value;
  };
  const taskValues = (b: Record<string, any>, old?: any) => {
    allowFields(b, ['title', 'description', 'status', 'priority', 'assigneeId', 'dueDate']);
    const value = {...old};
    if (!old || has(b, 'title')) value.title = requiredString(b.title, 'Title', 1000);
    if (!old || has(b, 'description')) value.description = optionalString(b.description, 'Description', 100000);
    if (!old || has(b, 'status')) value.status = choice(b.status === undefined ? 'todo' : b.status, ['todo', 'in_progress', 'done'], 'Task status');
    if (!old || has(b, 'priority')) value.priority = choice(b.priority === undefined ? 'medium' : b.priority, ['low', 'medium', 'high'], 'Priority');
    if (!old || has(b, 'assigneeId')) {
      value.assigneeId = b.assigneeId ?? null;
      if (value.assigneeId !== null) {
        requiredString(value.assigneeId, 'Assignee', 200);
        if (!db.query('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?').get(wid, value.assigneeId)) fail(404, 'Assignee is not a member of this workspace.');
      }
    }
    if (!old || has(b, 'dueDate')) {
      const date = b.dueDate ?? null;
      if (date !== null && (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) fail(400, 'Due date must be a valid YYYY-MM-DD date.');
      value.dueDate = date;
    }
    return value;
  };
  const taskFilter = (tasks: any[]) => {
    const q = (url.searchParams.get('q') || '').toLowerCase();
    const status = url.searchParams.get('status'), priority = url.searchParams.get('priority'), assignee = url.searchParams.get('assigneeId'), projectId = url.searchParams.get('projectId');
    if (status) choice(status, ['todo', 'in_progress', 'done'], 'Status');
    if (priority) choice(priority, ['low', 'medium', 'high'], 'Priority');
    return tasks.filter(t => (!q || `${t.title}\n${t.description}`.toLowerCase().includes(q)) && (!status || t.status === status) && (!priority || t.priority === priority) && (!assignee || t.assigneeId === assignee) && (!projectId || t.projectId === projectId));
  };
  const orderItems = (raw: unknown) => {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) fail(400, 'Orders require 1 to 50 distinct products.');
    const seen = new Set<string>();
    return (raw as any[]).map(line => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) fail(400, 'Each order item must be an object.');
      allowFields(line, ['productId', 'quantity']);
      const product = get('product', line.productId);
      if (seen.has(product.id)) fail(400, 'An order cannot contain duplicate products.');
      seen.add(product.id);
      const quantity = integer(line.quantity, 'Quantity', 1, 10000);
      return {productId: product.id, sku: product.sku, name: product.name, unitPriceCents: product.priceCents, quantity, lineTotalCents: product.priceCents * quantity};
    });
  };

  if (kind === 'customers') {
    if (!rid && method === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      return json({customers: list('customer').filter(c => `${c.name}\n${c.email}\n${c.company}`.toLowerCase().includes(q))});
    }
    if (!rid && method === 'POST') {
      requireRole(ctx, editors); const b = await readJson(request);
      return json({customer: mutate(() => { const values = customerValues(b); unique('customer', 'email', values.email); const customer = {...createBase(), ...values}; put('customer', customer); log('customer.created', 'customer', customer.id); return customer; })}, 201);
    }
    if (rid && !sub && method === 'GET') return json({customer: get('customer', rid)});
    if (rid && !sub && method === 'PATCH') {
      requireRole(ctx, editors); const b = await readJson(request);
      return json({customer: mutate(() => {const old = get('customer', rid), values = customerValues(b, old); unique('customer', 'email', values.email, rid); const customer = {...values, updatedAt: timestamp()}; put('customer', customer); log('customer.updated', 'customer', rid); return customer;})});
    }
    if (rid && !sub && method === 'DELETE') {
      requireRole(ctx, editors); mutate(() => {get('customer', rid); if (list('order').some(o => o.customerId === rid) || list('invoice').some(i => i.customerId === rid)) fail(409, 'Customer is referenced by an order or invoice.'); removeOwnedAttachments('customer', rid); del('customer', rid); log('customer.deleted', 'customer', rid);}); return empty();
    }
  }
  if (kind === 'products') {
    if (!rid && method === 'GET') { const q = (url.searchParams.get('q') || '').toLowerCase(); return json({products: list('product').filter(p => `${p.sku}\n${p.name}\n${p.description}`.toLowerCase().includes(q))}); }
    if ((!rid && method === 'POST') || (rid && !sub && method === 'PATCH')) {
      requireRole(ctx, managers); const b = await readJson(request); allowFields(b, ['sku', 'name', 'description', 'priceCents']);
      const product = mutate(() => {
        const old = rid ? get('product', rid) : null;
        const values: any = {...(old || createBase())};
        if (!old || has(b, 'sku')) values.sku = requiredString(b.sku, 'SKU', 200).toUpperCase();
        if (!old || has(b, 'name')) values.name = requiredString(b.name, 'Product name', 1000);
        if (!old || has(b, 'description')) values.description = optionalString(b.description, 'Description', 100000);
        if (!old || has(b, 'priceCents')) values.priceCents = integer(b.priceCents, 'Unit price', 0, 100000000);
        unique('product', 'sku', values.sku, rid);
        if (!old) values.stock = 0; values.updatedAt = timestamp();
        put('product', values); log(old ? 'product.updated' : 'product.created', 'product', values.id); return values;
      });
      return json({product}, rid ? 200 : 201);
    }
    if (rid && !sub && method === 'GET') return json({product: get('product', rid)});
    if (rid && !sub && method === 'DELETE') {requireRole(ctx, managers); mutate(() => {get('product', rid); if (list('movement').some(m => m.productId === rid) || list('order').some(o => o.items.some((i: any) => i.productId === rid))) fail(409, 'Product has stock history or order lines.'); del('product', rid); log('product.deleted', 'product', rid);}); return empty();}
  }
  if (kind === 'stock-movements') {
    if (!rid && method === 'GET') { const productId = url.searchParams.get('productId'); if (productId) get('product', productId); return json({movements: list('movement').filter(m => !productId || m.productId === productId).reverse()}); }
    if (!rid && method === 'POST') {
      requireRole(ctx, managers); const b = await readJson(request); allowFields(b, ['productId', 'delta', 'reason']);
      const delta = integer(b.delta, 'Quantity change', -1000000000, 1000000000); if (delta === 0) fail(400, 'Quantity change cannot be zero.'); const reason = requiredString(b.reason, 'Reason', 5000);
      return json(mutate(() => {const product = get('product', b.productId); if (product.stock + delta < 0 || product.stock + delta > 1000000000) fail(409, 'Stock must remain between 0 and 1000000000.'); product.stock += delta; product.updatedAt = timestamp(); const movement = {id: uuid(), productId: product.id, delta, reason, kind: 'adjustment', orderId: null, createdBy: ctx.user.id, createdAt: timestamp()}; put('product', product); put('movement', movement); log('stock.adjusted', 'product', product.id); return {movement, product};}), 201);
    }
  }
  if (kind === 'orders') {
    if (!rid && method === 'GET') {const status = url.searchParams.get('status'); if (status) choice(status, ['draft','fulfilled','cancelled'], 'Order status'); return json({orders: list('order').filter(o => !status || o.status === status)});}
    if (!rid && method === 'POST') {
      requireRole(ctx, managers); const b = await readJson(request); allowFields(b, ['customerId', 'items']);
      return json({order: mutate(() => {const customer = get('customer', b.customerId), items = orderItems(b.items); const order = {...createBase(), number: nextNumber('order', 'ORD'), customerId: customer.id, status: 'draft', items, totalCents: items.reduce((sum, i) => sum + i.lineTotalCents, 0), fulfilledAt: null}; put('order', order); log('order.created', 'order', order.id); return order;})}, 201);
    }
    if (rid && !sub && method === 'GET') return json({order: get('order', rid)});
    if (rid && !sub && method === 'PATCH') {
      requireRole(ctx, managers); const b = await readJson(request); allowFields(b, ['customerId', 'items']);
      return json({order: mutate(() => {const order = get('order', rid); if (order.status !== 'draft') fail(409, 'Only draft orders can be edited.'); if (has(b,'customerId')) order.customerId = get('customer', b.customerId).id; if (has(b,'items')) order.items = orderItems(b.items); order.totalCents = order.items.reduce((s: number,i: any) => s+i.lineTotalCents,0); order.updatedAt = timestamp(); put('order',order); log('order.updated','order',rid); return order;})});
    }
    if (rid && !sub && method === 'DELETE') {requireRole(ctx, managers); mutate(() => {const order = get('order',rid); if(order.status!=='draft') fail(409,'Only draft orders can be deleted.'); removeOwnedAttachments('order',rid); del('order',rid); log('order.deleted','order',rid);}); return empty();}
    if (rid && sub === 'cancel' && method === 'POST' && segments.length === 3) {requireRole(ctx, managers); return json({order: mutate(() => {const order = get('order',rid); if(order.status!=='draft') fail(409,'Only draft orders can be cancelled.'); order.status='cancelled'; order.updatedAt=timestamp(); put('order',order); log('order.cancelled','order',rid); return order;})});}
    if (rid && sub === 'fulfill' && method === 'POST' && segments.length === 3) {
      requireRole(ctx, managers); const b = await readJson(request); allowFields(b, ['idempotencyKey']); const key = requiredString(b.idempotencyKey,'Idempotency key',100); if(key.length<8) fail(400,'Idempotency key must contain 8 to 100 characters.');
      return json(mutate(() => {
        const order=get('order',rid);
        const previous = db.query('SELECT order_id, response_json FROM idempotency WHERE workspace_id = ? AND key = ?').get(wid,key) as any;
        if(previous) {if(previous.order_id!==rid) fail(409,'Idempotency key was already used for another order.'); return {order:JSON.parse(previous.response_json),replayed:true};}
        if(order.status!=='draft') fail(409,'Only draft orders can be fulfilled.');
        const products = order.items.map((line:any) => {const product=get('product',line.productId); if(product.stock<line.quantity) fail(409,`Insufficient stock for ${product.sku}.`); return product;});
        const when=timestamp();
        order.items.forEach((line:any,index:number) => {const product=products[index]; product.stock-=line.quantity; product.updatedAt=when; put('product',product); put('movement',{id:uuid(),productId:product.id,delta:-line.quantity,reason:`Fulfilled ${order.number}`,kind:'fulfillment',orderId:rid,createdBy:ctx.user.id,createdAt:when});});
        order.status='fulfilled';order.fulfilledAt=when;order.updatedAt=when;put('order',order);
        db.query('INSERT INTO idempotency(workspace_id,key,order_id,response_json) VALUES (?,?,?,?)').run(wid,key,rid,JSON.stringify(order)); log('order.fulfilled','order',rid); return {order,replayed:false};
      }));
    }
  }
  if (kind === 'invoices') {
    if (!rid && method === 'GET') {const status=url.searchParams.get('status');if(status)choice(status,['draft','sent','paid','void'],'Invoice status');return json({invoices:list('invoice').filter(i=>!status||i.status===status)});}
    if (!rid && method === 'POST') {requireRole(ctx,managers);const b=await readJson(request);allowFields(b,['orderId']);return json({invoice:mutate(()=>{const order=get('order',b.orderId);if(order.status!=='fulfilled')fail(409,'Only fulfilled orders can be invoiced.');if(list('invoice').some(i=>i.orderId===order.id))fail(409,'This order already has an invoice.');const customer=get('customer',order.customerId);const invoice={id:uuid(),number:nextNumber('invoice','INV'),orderId:order.id,customerId:customer.id,billTo:{name:customer.name,email:customer.email,company:customer.company},status:'draft',currency:'USD',items:structuredClone(order.items),subtotalCents:order.totalCents,totalCents:order.totalCents,createdAt:timestamp(),paidAt:null};put('invoice',invoice);log('invoice.created','invoice',invoice.id);return invoice;})},201);}
    if (rid && !sub && method==='GET')return json({invoice:get('invoice',rid)});
    if (rid && !sub && method==='PATCH') {requireRole(ctx,managers);const b=await readJson(request);allowFields(b,['status']);const status=choice(b.status,['sent','paid','void'],'Invoice status');return json({invoice:mutate(()=>{const invoice=get('invoice',rid);if(!((invoice.status==='draft'&&['sent','void'].includes(status))||(invoice.status==='sent'&&['paid','void'].includes(status))))fail(409,'This invoice status transition is not allowed.');invoice.status=status;if(status==='paid')invoice.paidAt=timestamp();put('invoice',invoice);log(`invoice.${status}`,'invoice',rid);return invoice;})});}
  }
  if (kind==='projects') {
    if(!rid&&method==='GET')return json({projects:list('project')});
    if((!rid&&method==='POST')||(rid&&!sub&&method==='PATCH')) {requireRole(ctx,editors);const b=await readJson(request);allowFields(b,['name','description']);const project=mutate(()=>{const old=rid?get('project',rid):null;const project={...(old||createBase())};if(!old||has(b,'name'))project.name=requiredString(b.name,'Project name',1000);if(!old||has(b,'description'))project.description=optionalString(b.description,'Description',100000);project.updatedAt=timestamp();put('project',project);log(old?'project.updated':'project.created','project',project.id);return project;});return json({project},rid?200:201);}
    if(rid&&!sub&&method==='GET')return json({project:get('project',rid)});
    if(rid&&!sub&&method==='DELETE'){requireRole(ctx,editors);mutate(()=>{get('project',rid);for(const task of list('task').filter(t=>t.projectId===rid))removeTask(task);del('project',rid);log('project.deleted','project',rid);});return empty();}
    if(rid&&sub==='tasks'&&segments.length===3){get('project',rid);if(method==='GET')return json({tasks:taskFilter(list('task').filter(t=>t.projectId===rid))});if(method==='POST'){requireRole(ctx,editors);const b=await readJson(request);return json({task:mutate(()=>{get('project',rid);const task={...createBase(),...taskValues(b),projectId:rid};put('task',task);log('task.created','task',task.id);return task;})},201);}}
  }
  if(kind==='tasks') {
    if(!rid&&method==='GET')return json({tasks:taskFilter(list('task'))});
    if(rid&&!sub&&method==='GET')return json({task:get('task',rid)});
    if(rid&&!sub&&method==='PATCH'){requireRole(ctx,editors);const b=await readJson(request);return json({task:mutate(()=>{const task={...taskValues(b,get('task',rid)),updatedAt:timestamp()};put('task',task);log('task.updated','task',rid);return task;})});}
    if(rid&&!sub&&method==='DELETE'){requireRole(ctx,editors);mutate(()=>{removeTask(get('task',rid));log('task.deleted','task',rid);});return empty();}
    if(rid&&sub==='comments'&&segments.length===3){get('task',rid);if(method==='GET')return json({comments:list('comment').filter(c=>c.taskId===rid)});if(method==='POST'){requireRole(ctx,editors);const b=await readJson(request);allowFields(b,['body']);const body=requiredString(b.body,'Comment',2000);return json({comment:mutate(()=>{get('task',rid);const comment={id:uuid(),taskId:rid,body,author:{id:ctx.user.id,name:ctx.user.name},createdAt:timestamp()};put('comment',comment);log('comment.created','comment',comment.id);return comment;})},201);}}
  }
  if(kind==='comments'&&rid&&!sub&&method==='DELETE'){requireRole(ctx,editors);mutate(()=>{const comment=get('comment',rid);if(!managers.includes(ctx.workspace.role)&&comment.author.id!==ctx.user.id)throw new ApiError(403,'forbidden','You can delete only your own comments.');del('comment',rid);log('comment.deleted','comment',rid);});return empty();}

  if(kind==='import'&&rid==='customers'&&!sub&&method==='POST'){
    requireRole(ctx,editors);const b=await readJson(request);allowFields(b,['csv']);if(typeof b.csv!=='string'||new TextEncoder().encode(b.csv).length>1048576)fail(400,'CSV must be a string of at most 1 MB.');const rows=parseCsv(b.csv);if(!rows.length||JSON.stringify(rows[0])!==JSON.stringify(['name','email','company','notes']))fail(400,'CSV header must be name,email,company,notes.');if(rows.length>201)fail(400,'CSV may contain at most 200 data rows.');const values=rows.slice(1).map((row,index)=>{if(row.length!==4)fail(400,`CSV row ${index+2} must have four columns.`);return customerValues({name:row[0],email:row[1],company:row[2],notes:row[3]});});
    const imported=mutate(()=>{const seen=new Set(list('customer').map(c=>c.email.toLowerCase()).filter(Boolean));for(const v of values){if(v.email){const normalized=v.email.toLowerCase();if(seen.has(normalized))fail(409,'CSV contains a duplicate customer email.');seen.add(normalized);}}for(const v of values){const customer={...createBase(),...v};put('customer',customer);log('customer.created','customer',customer.id);}return values.length;});return json({imported},201);
  }
  if(kind==='export.csv'&&!rid&&method==='GET'){
    const type=url.searchParams.get('type')||'';const configs:Record<string,{type:string,headers:string[]}>= {customers:{type:'customer',headers:['id','name','email','company','notes']},products:{type:'product',headers:['id','sku','name','description','priceCents','stock']},orders:{type:'order',headers:['id','number','customerId','status','totalCents']},invoices:{type:'invoice',headers:['id','number','orderId','status','totalCents']},tasks:{type:'task',headers:['id','projectId','title','description','status','priority','assigneeId','dueDate']}};const config=configs[type];if(!config)fail(400,'Export type is invalid.');return csvResponse([config.headers,...list(config.type).map(row=>config.headers.map(h=>row[h]))],`${type}.csv`);
  }
  if(kind==='attachments'){
    if(!rid&&method==='GET'){const type=entityType(url.searchParams.get('entityType'));const entity=get(type,url.searchParams.get('entityId'));return json({attachments:list('attachment').filter(a=>a.entityType===type&&a.entityId===entity.id).map(copyPublicAttachment)});}
    if(!rid&&method==='POST'){
      requireRole(ctx,editors);let form:FormData;try{form=await request.formData();}catch{fail(400,'A valid multipart form is required.');}
      const type=entityType(form!.get('entityType')), target=requiredString(form!.get('entityId'),'Entity ID',200), file=form!.get('file');get(type,target);
      if(!(file instanceof File))fail(400,'Choose a file to upload.');const upload=file as File;
      if(upload.size>2*1024*1024)throw new ApiError(413,'file_too_large','Attachments must be 2 MiB or smaller.');
      if(/[\r\n]/.test(upload.name)||/[\/\\]/.test(upload.name)||upload.name==='.'||upload.name==='..')fail(400,'Attachment filename is unsafe.');
      const filename=requiredString(upload.name,'Filename',255),extension=extname(filename).toLowerCase();const types:Record<string,string>={'.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'};if(!types[extension])throw new ApiError(415,'unsupported_file','Allowed files are TXT, MD, CSV, PDF, PNG and JPG.');
      const bytes=new Uint8Array(await upload.arrayBuffer()), attachment={id:uuid(),entityType:type,entityId:target,fileName:filename,size:bytes.byteLength,mimeType:types[extension],createdBy:ctx.user.id,createdAt:timestamp()};mkdirSync(join(DATA_DIR,'attachments'),{recursive:true});const path=join(DATA_DIR,'attachments',attachment.id);
      try{writeFileSync(path,bytes);mutate(()=>{get(type,target);put('attachment',attachment);log('attachment.created','attachment',attachment.id);});}catch(error){try{unlinkSync(path);}catch{}throw error;}return json({attachment},201);
    }
    if(rid&&sub==='download'&&segments.length===3&&method==='GET'){const attachment=get('attachment',rid);let bytes:Buffer;try{bytes=readFileSync(join(DATA_DIR,'attachments',attachment.id));}catch{fail(404,'Attachment file was not found.');}const ascii=attachment.fileName.replace(/[^\x20-\x7e]|["\\]/g,'_');return new Response(bytes!,{headers:{'Content-Type':attachment.mimeType,'Content-Disposition':`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});}
    if(rid&&!sub&&method==='DELETE'){requireRole(ctx,editors);mutate(()=>{const attachment=get('attachment',rid);if(!managers.includes(ctx.workspace.role)&&attachment.createdBy!==ctx.user.id)throw new ApiError(403,'forbidden','You can delete only your own attachments.');removeAttachment(attachment);log('attachment.deleted','attachment',rid);});return empty();}
  }
  if(kind==='activity'&&!rid&&method==='GET'){const raw=url.searchParams.get('limit'),limit=raw===null?50:Number(raw);if(raw!==null&&(!/^\d+$/.test(raw)||!Number.isSafeInteger(limit)||limit<1||limit>500))fail(400,'Activity limit must be an integer from 1 to 500.');return json({activity:list('activity').slice(0,limit)});}
  if(kind==='sync'&&!rid&&method==='GET'){const workspace=db.query('SELECT revision FROM workspaces WHERE id = ?').get(wid) as any;return json({revision:workspace.revision});}
  if(kind==='summary'&&!rid&&method==='GET'){const customers=list('customer'),products=list('product'),orders=list('order'),invoices=list('invoice'),tasks=list('task');return json({customers:customers.length,products:products.length,lowStockProducts:products.filter(p=>p.stock<=5).length,openOrders:orders.filter(o=>o.status==='draft').length,fulfilledOrders:orders.filter(o=>o.status==='fulfilled').length,revenueCents:invoices.filter(i=>i.status==='paid').reduce((sum,i)=>sum+i.totalCents,0),unpaidCents:invoices.filter(i=>['draft','sent'].includes(i.status)).reduce((sum,i)=>sum+i.totalCents,0),openTasks:tasks.filter(t=>t.status!=='done').length,completedTasks:tasks.filter(t=>t.status==='done').length});}
  return null;
}
