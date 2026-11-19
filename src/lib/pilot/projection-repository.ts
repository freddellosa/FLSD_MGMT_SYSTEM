/** Uses the caller's transaction; never opens or commits an independent one. */
import type {PilotTx} from './database';
import type {DemoState} from '../demo/store';
import {buildProjectionPlan,projectionUpsertSql} from './entity-projections';
import {encodeWire} from './wire';

export async function persistProjections(db:PilotTx,before:DemoState|undefined,next:DemoState){
 // Account management can advance the workspace revision before any business
 // save. Revision alone therefore cannot prove projections were initialized.
 const initialized=await db.$queryRaw<{initialized:boolean}[]>`SELECT EXISTS(SELECT 1 FROM pilot_settings WHERE id='invoice_stock') AS initialized`;
 const plan=buildProjectionPlan(initialized[0]?.initialized?before:undefined,next);
 for(const batch of plan.batches){
  // Archive only removed rows, before inserts that may reuse active unique keys.
  if(batch.archiveIds.length)await db.$executeRawUnsafe('UPDATE '+batch.table+' SET archived=true WHERE id = ANY($1::text[])',batch.archiveIds);
  if(batch.upserts.length)await db.$executeRawUnsafe(projectionUpsertSql(batch.table),encodeWire(batch.upserts));
 }
 for(const c of plan.customerFormats)await db.$executeRaw`INSERT INTO pilot_customer_formats(customer_id,format_id) VALUES(${c.customerId},${c.formatId}) ON CONFLICT(customer_id) DO UPDATE SET format_id=EXCLUDED.format_id`;
 for(const d of plan.memberships){
  await db.$executeRaw`UPDATE pilot_document_trips SET current_membership=false WHERE document_id=${d.documentId}`;
  for(const tripId of d.tripIds)await db.$executeRaw`INSERT INTO pilot_document_trips(document_id,trip_id,current_membership) VALUES(${d.documentId},${tripId},true) ON CONFLICT(document_id,trip_id) DO UPDATE SET current_membership=true`;
 }
 for(const setting of plan.settings)await db.$executeRaw`INSERT INTO pilot_settings(id,payload) VALUES(${setting.id},${encodeWire(setting.payload)}::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload`;
 // Append-only evidence is checked against stored identities, never rewritten.
 const existingFiles=new Set((await db.$queryRaw<{id:string}[]>`SELECT id FROM pilot_attachments`).map(f=>f.id));
 for(const evidence of next.collectionEvidence)for(const [i,f]of evidence.files.entries())if(!existingFiles.has(evidence.id+'-'+i))await db.$executeRaw`INSERT INTO pilot_attachments(id,invoice_id,name,mime_type,content) VALUES(${evidence.id+'-'+i},${evidence.invoiceId},${f.name},${f.type},decode(${f.data.slice(f.data.indexOf(',')+1)},'base64')) ON CONFLICT DO NOTHING`;
}
