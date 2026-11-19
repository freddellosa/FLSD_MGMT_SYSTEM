/** Offline Access-export review only. No database, network or posting adapter. */
import {parseLegacyDate} from './trips';
import {toCentavos} from '../domain/billing';
import {moneyGuard} from '../domain/trip-payments';
import type {MonthlyUsageEvidence} from './monthly-billing';

export type AccessRow=Record<string,string>;
export type ReferenceKind='customer'|'vehicle'|'driver';
export type AccessColumns={id:string;startDate:string;agreedCharge?:string;customer?:string;vehicle?:string;driver?:string;vat?:string;withholding?:string};
export type AccessReference={idColumn:string;rows:AccessRow[]};
export type AccessStagingInput={trips:AccessRow[];columns:AccessColumns;references?:Partial<Record<ReferenceKind,AccessReference>>;minYear?:number;monthlyUsageEvidence?:readonly MonthlyUsageEvidence[]};
export type AccessDiagnostic={field:string;sourceColumn:string;sourceValue:string;referenceColumn?:string};
export type AccessStagedTrip={row:number;sourceId:string;date?:string;agreedCentavos?:bigint;vatCentavos?:bigint;withholdingCentavos?:bigint;billingRole?:'MONTHLY_USAGE';fixedChargeTripId?:string;status:'EXCLUDED'|'REJECTED'|'REVIEW'|'VALIDATED';errors:string[];review:string[];diagnostics:AccessDiagnostic[]};
export type AccessRelationshipCheck={kind:ReferenceKind;tripColumn?:string;referenceColumn?:string;checked:number;matched:number;missing:number;ambiguous:number;unassigned:number;unverified:number};
export type AccessStagingReport={rows:AccessStagedTrip[];counts:Record<AccessStagedTrip['status'],number>;referenceIssues:{kind:ReferenceKind;row:number;message:string}[];relationshipChecks:AccessRelationshipCheck[];validatedAgreedCentavos:bigint;selectedChecksOnly:true;importEnabled:false};

/** PHP text and trailing zero precision are exact; never round sub-cent values. */
export function accessMoney(value:string){
 const text=value.trim();
 if(text.length>128)throw new Error('Amount text is too long; review the selected source column');
 const match=/^(?:PHP\s*|₱\s*)?(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,20}))?$/i.exec(text);
 if(!match)throw new Error('Use PHP currency with a decimal point and correctly grouped thousands; other currencies and formats need review');
 const fraction=match[2]??'';
 if(/[1-9]/.test(fraction.slice(2)))throw new Error('Meaningful precision below one centavo needs review; no rounding was applied');
 return moneyGuard(toCentavos(match[1].replaceAll(',','')+'.'+fraction.slice(0,2).padEnd(2,'0')));
}
function validColumn(rows:AccessRow[],column:string){return !!column&&rows.every(r=>Object.hasOwn(r,column));}
const preview=(value:string)=>value.length>100?value.slice(0,100)+'…':value;

/** Suggestions are exact, unique-key overlaps only; never change a mapping. */
export function suggestReferenceColumns(values:string[],rows:AccessRow[]){
 if(!rows.length)return [];
 const counts=new Map<string,number>();for(const value of values){const key=value.trim();if(key)counts.set(key,(counts.get(key)??0)+1);}
 return Object.keys(rows[0]).map(column=>{
  const keys=rows.map(r=>r[column]?.trim()??'').filter(Boolean),unique=new Set(keys);
  if(unique.size!==keys.length)return {column,matched:0};
  return {column,matched:[...unique].reduce((sum,key)=>sum+(counts.get(key)??0),0)};
 }).filter(c=>c.matched>0).sort((a,b)=>b.matched-a.matched||a.column.localeCompare(b.column)).slice(0,3);
}

export function stageAccessTrips(input:AccessStagingInput):AccessStagingReport{
 const {trips,columns,references={}}=input,minYear=input.minYear??2025;
 if(!Number.isInteger(minYear)||minYear<1900||minYear>2100)throw new Error('Invalid cutoff year');
 if(!trips.length||trips.length>100000)throw new Error('Choose between 1 and 100,000 trip rows');
 if(!validColumn(trips,columns.id)||!validColumn(trips,columns.startDate))throw new Error('Select existing trip ID and start-date columns');
 const mapped=Object.values(columns).filter((v):v is string=>!!v);
 const monthlyUsage=new Map<string,MonthlyUsageEvidence>();
 const monthlyIndex=new Map<string,AccessRow[]>();
 if(input.monthlyUsageEvidence?.length){if(input.monthlyUsageEvidence.length>trips.length)throw new Error('Too many monthly usage declarations');for(const row of trips){const key=row[columns.id],group=monthlyIndex.get(key)??[];group.push(row);monthlyIndex.set(key,group);}}
 for(const evidence of input.monthlyUsageEvidence??[]){
  if(!evidence.sourceTripId?.trim()||monthlyUsage.has(evidence.sourceTripId)||!evidence.customerId?.trim()||!/^\d{4}-(0[1-9]|1[0-2])$/.test(evidence.month)||!evidence.fixedChargeTripId?.trim()||evidence.fixedChargeTripId===evidence.sourceTripId||!columns.customer||!columns.agreedCharge)throw new Error('Invalid monthly usage evidence');
  const matches=monthlyIndex.get(evidence.sourceTripId)??[],anchors=monthlyIndex.get(evidence.fixedChargeTripId)??[];
  if(matches.length!==1||anchors.length!==1||matches[0][columns.customer]!==evidence.customerId||anchors[0][columns.customer]!==evidence.customerId||parseLegacyDate(matches[0][columns.startDate])?.toISOString().slice(0,7)!==evidence.month||parseLegacyDate(anchors[0][columns.startDate])?.toISOString().slice(0,7)!==evidence.month||accessMoney(anchors[0][columns.agreedCharge])<=0n)throw new Error('Monthly usage must link to one charge-bearing row for the same customer and month');
  monthlyUsage.set(evidence.sourceTripId,evidence);
 }
 if(new Set(mapped).size!==mapped.length)throw new Error('Map each selected source column to only one field');
 for(const column of mapped)if(!validColumn(trips,column))throw new Error('A selected source column is missing');
 const referenceIssues:AccessStagingReport['referenceIssues']=[],indexes=new Map<ReferenceKind,Map<string,number>>();
 for(const kind of ['customer','vehicle','driver'] as const){
  const reference=references[kind];if(!reference)continue;
  if(reference.rows.length>100000||!reference.idColumn||!validColumn(reference.rows,reference.idColumn))throw new Error('Select an existing reference ID column');
  const index=new Map<string,number>();
  reference.rows.forEach((r,i)=>{const id=r[reference.idColumn].trim();if(!id)referenceIssues.push({kind,row:i+2,message:'Missing reference identifier'});else index.set(id,(index.get(id)??0)+1);});
  reference.rows.forEach((r,i)=>{if((index.get(r[reference.idColumn].trim())??0)>1)referenceIssues.push({kind,row:i+2,message:'Duplicate reference identifier; resolve before mapping trips'});});
  indexes.set(kind,index);
 }
 const dates=trips.map(r=>parseLegacyDate(r[columns.startDate])),idCounts=new Map<string,number>();
 trips.forEach((r,i)=>{if(dates[i]&&dates[i]!.getUTCFullYear()<minYear)return;const id=r[columns.id].trim();if(id)idCounts.set(id,(idCounts.get(id)??0)+1);});
 const relationshipChecks:AccessRelationshipCheck[]=(['customer','vehicle','driver'] as const).map(kind=>({kind,tripColumn:columns[kind],referenceColumn:references[kind]?.idColumn,checked:0,matched:0,missing:0,ambiguous:0,unassigned:0,unverified:0}));
 const rows=trips.map((r,i):AccessStagedTrip=>{
  const result:AccessStagedTrip={row:i+2,sourceId:r[columns.id].trim(),status:'REVIEW',errors:[],review:[],diagnostics:[]},date=dates[i];
  if(date){result.date=date.toISOString().slice(0,10);if(date.getUTCFullYear()<minYear){result.status='EXCLUDED';return result;}}
  else result.errors.push('Missing or invalid trip start date');
  if(!result.sourceId)result.errors.push('Missing source trip identifier');
  else if((idCounts.get(result.sourceId)??0)>1)result.errors.push('Duplicate source trip identifier; every affected row requires review');
  if(columns.agreedCharge){try{result.agreedCentavos=accessMoney(r[columns.agreedCharge]);const monthly=monthlyUsage.get(result.sourceId);if(monthly){result.billingRole='MONTHLY_USAGE';result.fixedChargeTripId=monthly.fixedChargeTripId;}else moneyGuard(result.agreedCentavos,true);}catch(e){result.errors.push('Agreed total: '+(e instanceof Error?e.message:'Invalid exact amount'));result.diagnostics.push({field:'Agreed total',sourceColumn:columns.agreedCharge,sourceValue:preview(r[columns.agreedCharge])});}}
  else result.review.push('Agreed total charge column has not been mapped');
  for(const [field,key]of [['vat','vatCentavos'],['withholding','withholdingCentavos']] as const){
   const column=columns[field];if(!column)continue;
   if(!r[column].trim()){result.review.push((field==='vat'?'VAT':'Withholding')+' is blank in the source; confirm its meaning before import. No zero was assumed');result.diagnostics.push({field,sourceColumn:column,sourceValue:preview(r[column])});continue;}
   try{result[key]=accessMoney(r[column]);if(result[key]!>0n)result.review.push(field==='vat'?'VAT value retained; inclusive/exclusive treatment requires accounting confirmation':'Withholding value retained; evidence and treatment require accounting confirmation');}catch(e){result.errors.push('Invalid '+field+' amount: '+(e instanceof Error?e.message:'Review source format'));result.diagnostics.push({field,sourceColumn:column,sourceValue:preview(r[column])});}
  }
  for(const kind of ['customer','vehicle','driver'] as const){
   const check=relationshipChecks.find(c=>c.kind===kind)!,column=columns[kind];check.checked++;
   if(!column){check.unverified++;result.review.push('Source '+kind+' reference has not been mapped');continue;}
   const id=r[column].trim();if(!id){check.unassigned++;result.review.push('Source '+kind+' is unassigned');continue;}
   const index=indexes.get(kind);if(!index){check.unverified++;result.review.push('Exported '+kind+' reference table is needed to verify this relationship');continue;}
   const count=index.get(id)??0;if(count!==1){if(count===0)check.missing++;else check.ambiguous++;result.errors.push(count===0?'Source '+kind+' reference was not found':'Source '+kind+' reference is ambiguous');result.diagnostics.push({field:kind,sourceColumn:column,sourceValue:preview(r[column]),referenceColumn:references[kind]?.idColumn});}else check.matched++;
  }
  result.status=result.errors.length?'REJECTED':result.review.length?'REVIEW':'VALIDATED';return result;
 });
 const counts={EXCLUDED:0,REJECTED:0,REVIEW:0,VALIDATED:0};let validatedAgreedCentavos=0n;
 for(const row of rows){counts[row.status]++;if(row.status==='VALIDATED')validatedAgreedCentavos+=row.agreedCentavos??0n;}
 return {rows,counts,referenceIssues,relationshipChecks,validatedAgreedCentavos,selectedChecksOnly:true,importEnabled:false};
}
