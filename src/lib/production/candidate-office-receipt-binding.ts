import {PrismaClient} from '@prisma/client';

let client:PrismaClient|undefined;

export function officeReceiptBinding(){
  const {FLSD_BATCH7_OFFICE_QA,FLSD_BATCH7_OFFICE_PASSWORD,FLSD_BATCH7_OFFICE_DB_OID,FLSD_BATCH7_OFFICE_SCHEMA_OID,
    FLSD_BATCH7_OFFICE_ROLE_OID}=process.env;
  const mode=FLSD_BATCH7_OFFICE_QA==='fictional-qa-loopback'?'qa':FLSD_BATCH7_OFFICE_QA==='fictional-browser-loopback'?'browser':FLSD_BATCH7_OFFICE_QA==='fictional-loopback'?'office':undefined;
  if(!mode||!FLSD_BATCH7_OFFICE_PASSWORD||
    !FLSD_BATCH7_OFFICE_DB_OID||!FLSD_BATCH7_OFFICE_SCHEMA_OID||!FLSD_BATCH7_OFFICE_ROLE_OID){
    return;
  }
  client??=new PrismaClient({log:[],datasources:{db:{url:'postgresql://flsd_batch7_receipt_'+mode+'_writer:'+
    encodeURIComponent(FLSD_BATCH7_OFFICE_PASSWORD)+'@127.0.0.1:55437/flsd_batch7_receipt_'+mode+'_rehearsal?connection_limit=3&connect_timeout=5'}}});
  return {client,mode,identity:{
    databaseOid:FLSD_BATCH7_OFFICE_DB_OID,schemaOid:FLSD_BATCH7_OFFICE_SCHEMA_OID,roleOid:FLSD_BATCH7_OFFICE_ROLE_OID,
  }} as const;
}

