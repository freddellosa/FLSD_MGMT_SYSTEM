import type {DemoState} from '../demo/store';
import type {PilotTx} from './database';
import {PilotError} from './http';

/** Database bytes remain outside aggregate JSON and client workspace payloads. */
export function storageState(s:DemoState):DemoState{return {...s,collectionEvidence:s.collectionEvidence.map(e=>({...e,files:e.files.map(f=>({name:f.name,type:f.type,size:f.size,data:''}))}))};}

/** Restore evidence only inside the authorized caller's transaction for validation. */
export async function hydrateEvidence(db:PilotTx,s:DemoState){
 if(!s.collectionEvidence.some(e=>e.files.some(f=>!f.data)))return;
 const rows=await db.$queryRaw<{id:string;content:Uint8Array}[]>`SELECT id,content FROM pilot_attachments`,files=new Map(rows.map(f=>[f.id,f.content]));
 for(const e of s.collectionEvidence)for(const [i,f]of e.files.entries()){
  if(f.data)continue;
  const bytes=files.get(e.id+'-'+i);
  if(!bytes||bytes.byteLength!==f.size)throw new PilotError(503,'Stored evidence integrity check failed');
  f.data='data:'+f.type+';base64,'+Buffer.from(bytes).toString('base64');
 }
}
