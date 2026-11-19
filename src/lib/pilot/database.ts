import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PrismaClient,type Prisma} from '@prisma/client';
export type PilotTx=Prisma.TransactionClient;
const pilotClientHolder=globalThis as unknown as {flsdIsolatedPilotClient?:PrismaClient};
export function pilotDatabase(){if(pilotClientHolder.flsdIsolatedPilotClient)return pilotClientHolder.flsdIsolatedPilotClient;const config=JSON.parse(readFileSync(join(process.cwd(),'.pilot/runtime.json'),'utf8'));if(config.marker!=='FLSD_ISOLATED_PILOT_ONLY'||config.host!=='127.0.0.1'||config.port!==55437||config.database!=='flsd_pilot_validation'||config.user!=='flsd_pilot_app'||typeof config.password!=='string')throw new Error('Isolated pilot configuration required');const url='postgresql://'+config.user+':'+encodeURIComponent(config.password)+'@127.0.0.1:55437/flsd_pilot_validation?schema=public&connection_limit=5';const client=new PrismaClient({datasources:{db:{url}},log:[]});pilotClientHolder.flsdIsolatedPilotClient=client;return client;}
export async function assertPilotDatabase(db:PilotTx){const rows=await db.$queryRaw<{marker:string;schema_version:number}[]>`SELECT marker,schema_version FROM pilot_meta WHERE id=1`;if(rows[0]?.marker!=='FLSD_ISOLATED_PILOT_ONLY'||![3,4].includes(rows[0].schema_version))throw new Error('Isolated pilot marker missing');return rows[0].schema_version;}

export function retryablePilotError(error:unknown){const e=error as {code?:string;meta?:{code?:string}};return e?.code==='P2034'||(e?.code==='P2010'&&['40001','40P01'].includes(e.meta?.code??''));}
export async function pilotSerializable<T>(fn:(db:PilotTx)=>Promise<T>){for(let attempt=0;attempt<3;attempt++)try{return await pilotDatabase().$transaction(fn,{isolationLevel:'Serializable',timeout:30000,maxWait:15000});}catch(e){if(!retryablePilotError(e)||attempt===2)throw e;await new Promise(resolve=>setTimeout(resolve,10*(attempt+1)));}throw new Error('Pilot transaction retry exhausted');}
