/** Pure, typed relational projections. Does not connect, authorize or post. */
import type {DemoState} from '../demo/store';
import {fromCentavos} from '../domain/billing';
import {canonicalWire} from './wire';

type SqlType='text'|'boolean'|'numeric'|'date'|'int'|'jsonb';
const schemas={
 pilot_vehicles:{id:'text',label:'text',plate:'text',active:'boolean',archived:'boolean',payload:'jsonb'},
 pilot_drivers:{id:'text',label:'text',name:'text',active:'boolean',archived:'boolean',payload:'jsonb'},
 pilot_invoice_formats:{id:'text',name:'text',version:'int',payload:'jsonb'},
 pilot_customers:{id:'text',name:'text',tin:'text',address:'text',active:'boolean',archived:'boolean',payload:'jsonb'},
 pilot_trips:{id:'text',customer_id:'text',amount:'numeric',workflow:'text',service_date:'date',archived:'boolean',vehicle_key:'text',driver_key:'text',payload:'jsonb'},
 pilot_documents:{id:'text',customer_id:'text',amount:'numeric',document_type:'text',payload:'jsonb'},
 pilot_receipts:{id:'text',trip_id:'text',customer_id:'text',amount:'numeric',state:'text',payload:'jsonb'},
 pilot_allocations:{id:'text',receipt_id:'text',trip_id:'text',amount:'numeric',reversed:'numeric',payload:'jsonb'},
 pilot_refunds:{id:'text',receipt_id:'text',amount:'numeric',state:'text',payload:'jsonb'},
 pilot_remittances:{id:'text',receipt_id:'text',tendered:'numeric',accepted:'numeric',payload:'jsonb'},
 pilot_import_batches:{id:'text',digest:'text',file_name:'text',state:'text',version:'int',payload:'jsonb'},
} as const satisfies Record<string,Record<string,SqlType>>;
export type ProjectionTable=keyof typeof schemas;
type SqlValue<T>=T extends 'boolean'?boolean:T extends 'int'?number:T extends 'numeric'?string:T extends 'text'|'date'?string|null:unknown;
type Row<T extends ProjectionTable>={[K in keyof typeof schemas[T]]:SqlValue<typeof schemas[T][K]>}&{id:string};
type ProjectionRows={[T in ProjectionTable]:Row<T>[]};
type AnyRow={id:string}&Record<string,unknown>;
export type ProjectionBatch={table:ProjectionTable;upserts:AnyRow[];archiveIds:string[]};
export type ProjectionPlan={batches:ProjectionBatch[];customerFormats:{customerId:string;formatId:string}[];memberships:{documentId:string;tripIds:string[]}[];settings:{id:'dashboard'|'invoice_stock';payload:unknown}[]};

/** Foreign-key parents precede children; all amounts remain decimal strings. */
export function projectedRows(s:DemoState):ProjectionRows{return {
 pilot_vehicles:s.vehicles.map(v=>({id:v.id,label:v.label,plate:v.plate,active:v.active!==false,archived:false,payload:v})),
 pilot_drivers:s.drivers.map(d=>({id:d.id,label:d.label,name:d.name,active:d.active!==false,archived:false,payload:d})),
 pilot_invoice_formats:s.invoiceFormats.map(f=>({id:f.id,name:f.name,version:f.version,payload:f})),
 pilot_customers:s.customers.map(c=>({id:c.id,name:c.name,tin:c.tin??'',address:c.address,active:c.active!==false,archived:false,payload:c})),
 pilot_trips:s.trips.map(t=>({id:t.id,customer_id:t.customerId,amount:fromCentavos(t.amount),workflow:t.workflow,service_date:t.date,archived:false,vehicle_key:t.vehicle||null,driver_key:t.driver||null,payload:t})),
 pilot_documents:s.documents.map(d=>({id:d.id,customer_id:d.customerId,amount:fromCentavos(d.amountSnapshot),document_type:d.type,payload:d})),
 pilot_receipts:s.payments.map(p=>({id:p.id,trip_id:p.tripId,customer_id:p.customerId,amount:fromCentavos(p.amount),state:p.state,payload:p})),
 pilot_allocations:s.allocations.map(a=>({id:a.id,receipt_id:a.paymentId,trip_id:a.tripId,amount:fromCentavos(a.amount),reversed:fromCentavos(a.reversed),payload:a})),
 pilot_refunds:s.refunds.map(r=>({id:r.id,receipt_id:r.paymentId,amount:fromCentavos(r.amount),state:r.state,payload:r})),
 pilot_remittances:s.remittances.map(r=>({id:r.id,receipt_id:r.paymentId,tendered:fromCentavos(r.tendered),accepted:fromCentavos(r.accepted),payload:r})),
 pilot_import_batches:s.importBatches.map(b=>({id:b.id,digest:b.digest,file_name:b.fileName,state:b.state,version:b.version,payload:b})),
};}

const archivable=new Set<ProjectionTable>(['pilot_vehicles','pilot_drivers','pilot_customers','pilot_trips']);
export function projectionUpsertSql(table:ProjectionTable){
 const schema=schemas[table],columns=Object.keys(schema),names=columns.join(',');
 const definitions=Object.entries(schema).map(([column,type])=>column+' '+type).join(',');
 return 'INSERT INTO '+table+'('+names+') SELECT '+names+' FROM jsonb_to_recordset($1::jsonb) AS v('+definitions+') ON CONFLICT(id) DO UPDATE SET '+columns.filter(c=>c!=='id').map(c=>c+'=EXCLUDED.'+c).join(',');
}

/** Undefined predecessor explicitly means first-write/full reconciliation. */
export function buildProjectionPlan(before:DemoState|undefined,next:DemoState):ProjectionPlan{
 const old=before?projectedRows(before):undefined,current=projectedRows(next),batches:ProjectionBatch[]=[];
 for(const table of Object.keys(schemas) as ProjectionTable[]){
  const prior=new Map<string,AnyRow>((old?.[table]??[]).map(r=>[r.id,r])),ids=new Set(current[table].map(r=>r.id));
  if(ids.size!==current[table].length)throw new Error('Duplicate projection identity');
  const archiveIds=[...prior.keys()].filter(id=>!ids.has(id));
  if(archiveIds.length&&!archivable.has(table))throw new Error('Persistent financial or document history cannot be removed');
  const upserts=current[table].filter(row=>!prior.has(row.id)||canonicalWire(row)!==canonicalWire(prior.get(row.id)));
  if(upserts.length||archiveIds.length)batches.push({table,upserts,archiveIds});
 }
 const priorCustomers=new Map(before?.customers.map(c=>[c.id,c.invoiceFormatId??'FORMAT-GENERIC'])??[]);
 const customerFormats=next.customers.filter(c=>priorCustomers.get(c.id)!==(c.invoiceFormatId??'FORMAT-GENERIC')).map(c=>({customerId:c.id,formatId:c.invoiceFormatId??'FORMAT-GENERIC'}));
 const currentTripIds=(d:DemoState['documents'][number])=>d.stage==='VOIDED'?[]:[...d.tripIds];
 const priorDocuments=new Map(before?.documents.map(d=>[d.id,canonicalWire(currentTripIds(d).sort())])??[]);
 const memberships=next.documents.filter(d=>priorDocuments.get(d.id)!==canonicalWire(currentTripIds(d).sort()))
  .map(d=>({documentId:d.id,tripIds:currentTripIds(d)}));
 const settings:ProjectionPlan['settings']=[];
 if(!before||canonicalWire(before.dashboard)!==canonicalWire(next.dashboard))settings.push({id:'dashboard',payload:next.dashboard});
 if(!before||canonicalWire(before.invoiceStock)!==canonicalWire(next.invoiceStock))settings.push({id:'invoice_stock',payload:next.invoiceStock});
 return {batches,customerFormats,memberships,settings};
}
