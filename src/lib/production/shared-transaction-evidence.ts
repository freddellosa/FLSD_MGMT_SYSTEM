import {createHash} from 'node:crypto';
import {roles,type Role} from '../security/permissions';
import {isSharedTransactionResourceKind,type SharedTransactionDiscovery} from './shared-transaction-lock-plan';

type Kind = keyof SharedTransactionDiscovery['resources'];
type ResourceRef = {kind: Kind; id: string};
type Resource = ResourceRef & {
  revision: string;
  customerId: string | null;
  state: string;
  eligible?: boolean;
  amounts?: readonly {name: string; centavos: bigint}[];
};
export type SharedDependencyEvidence = {
  authority: string;
  operationKey: string;
  actor: {id:string; role:Role; active:boolean; authorizationRevision:string};
  session: {id:string; expiresAt:string; revokedAt:string | null};
  resources: readonly Resource[];
  relationships: readonly {role:string; from:ResourceRef; to:ResourceRef}[];
  absences: readonly {predicate:string; subject:ResourceRef; parent:ResourceRef; parentRevision:string}[];
  receipt: {actorId:string;kind:string;requestDigest:string;result:ResourceRef} | null;
};

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const version = /^[1-9][0-9]{0,18}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const sha256 = /^[a-f0-9]{64}$/;
const refKey = ({kind,id}:ResourceRef) => JSON.stringify([kind,id]);
const order = (values:unknown[][]) => values.map(value=>JSON.stringify(value)).sort();

/** Canonicalizes trusted evidence. The repository owns scope and discovery completeness. */
export function buildSharedDependencyDiscovery(input: SharedDependencyEvidence): SharedTransactionDiscovery {
  const {authority,operationKey,actor,session,resources,relationships,absences,receipt} = input;
  const validId = (id:unknown):id is string => typeof id==='string' && identifier.test(id);
  const validVersion = (value:unknown) => typeof value==='string' && version.test(value) && BigInt(value)<=9223372036854775807n;
  const validTime = (value:unknown) => typeof value==='string' && timestamp.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,23)===value.slice(0,23);
  if (!validId(authority)||!validId(operationKey)||!validId(actor.id)||!roles.includes(actor.role)||
      typeof actor.active!=='boolean'||!validVersion(actor.authorizationRevision)||!validId(session.id)||
      !validTime(session.expiresAt)||(session.revokedAt!==null&&!validTime(session.revokedAt))) {
    throw new Error('Invalid shared dependency authorization evidence');
  }

  const byKey = new Map<string,Resource>();
  const resourceIds: {CUSTOMER:string[]} & Partial<Record<Kind,string[]>> = {CUSTOMER:[]};
  const rows = resources.map(row=>{
    const key=refKey(row);
    if (!isSharedTransactionResourceKind(row.kind)||byKey.has(key)||!validId(row.id)||!validVersion(row.revision)||!validId(row.state)||
        (row.customerId!==null&&!validId(row.customerId))||(row.kind==='CUSTOMER'&&row.customerId!==row.id)||
        (row.eligible!==undefined&&typeof row.eligible!=='boolean')) {
      throw new Error('Invalid or duplicate shared dependency resource');
    }
    const names=new Set<string>();
    const amounts=(row.amounts??[]).map(({name,centavos})=>{
      if(!validId(name)||names.has(name)||typeof centavos!=='bigint')throw new Error('Invalid or duplicate shared dependency amount');
      names.add(name);
      return [name,centavos.toString()];
    });
    byKey.set(key,row);
    (resourceIds[row.kind]??=[]).push(row.id);
    return [row.kind,row.id,row.revision,row.customerId,row.state,row.eligible??null,order(amounts)];
  });
  for(const row of resources) {
    if(row.customerId!==null&&!byKey.has(refKey({kind:'CUSTOMER',id:row.customerId}))) {
      throw new Error('Missing customer coordination evidence');
    }
  }

  const seenRelationships=new Set<string>();
  const edges=relationships.map(({role,from,to})=>{
    const fromKey=refKey(from),toKey=refKey(to),key=JSON.stringify([role,fromKey,toKey]);
    if(!validId(role)||!byKey.has(fromKey)||!byKey.has(toKey)||seenRelationships.has(key)) {
      throw new Error('Invalid or duplicate shared dependency relationship');
    }
    seenRelationships.add(key);
    return [role,fromKey,toKey];
  });
  const seenAbsences=new Set<string>();
  const missing=absences.map(({predicate,subject,parent,parentRevision})=>{
    const subjectKey=refKey(subject),parentKey=refKey(parent),key=JSON.stringify([predicate,subjectKey]);
    if(!validId(predicate)||!byKey.has(subjectKey)||byKey.get(parentKey)?.revision!==parentRevision||
        !validVersion(parentRevision)||seenAbsences.has(key)) throw new Error('Invalid or duplicate shared dependency absence');
    seenAbsences.add(key);
    return [predicate,subjectKey,parentKey,parentRevision];
  });
  if(receipt&&(!validId(receipt.actorId)||!validId(receipt.kind)||typeof receipt.requestDigest!=='string'||
      !sha256.test(receipt.requestDigest)||!byKey.has(refKey(receipt.result)))) throw new Error('Invalid shared dependency receipt evidence');

  const canonical=JSON.stringify([
    1,authority,operationKey,[actor.id,actor.role,actor.active,actor.authorizationRevision],
    [session.id,session.expiresAt,session.revokedAt],order(rows),order(edges),order(missing),
    receipt?[receipt.actorId,receipt.kind,receipt.requestDigest,refKey(receipt.result)]:null,
  ]);
  if(!resourceIds.CUSTOMER.length) throw new Error('Missing customer coordination evidence');
  return {authority,actorId:actor.id,operationKey,
    dependencyDigest:createHash('sha256').update(canonical,'utf8').digest('hex'),resources:resourceIds};
}
