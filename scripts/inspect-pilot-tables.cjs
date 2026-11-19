// Read-only schema inspection. Never exports row data or credentials.
const fs=require('node:fs'),path=require('node:path'),{PrismaClient}=require('@prisma/client');
const root=path.resolve(__dirname,'..');let db;
(async()=>{
 const c=JSON.parse(fs.readFileSync(path.join(root,'.pilot/runtime.json'),'utf8'));
 if(root!=='D:\\FLSD-Batch7-Validation'||c.marker!=='FLSD_ISOLATED_PILOT_ONLY'||c.host!=='127.0.0.1'||c.port!==55437||c.database!=='flsd_pilot_validation'||c.user!=='flsd_pilot_app')throw Error('Isolated pilot required');
 db=new PrismaClient({datasources:{db:{url:'postgresql://'+c.user+':'+encodeURIComponent(c.password)+'@127.0.0.1:55437/flsd_pilot_validation?schema=public'}},log:[]});
 const columns=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  const meta=await tx.$queryRawUnsafe('SELECT marker,schema_version FROM pilot_meta WHERE id=1');
  if(meta[0]?.marker!==c.marker||meta[0]?.schema_version!==3)throw Error('Pilot identity mismatch');
  return tx.$queryRawUnsafe("SELECT table_name,column_name,data_type,is_nullable,numeric_precision,numeric_scale FROM information_schema.columns WHERE table_schema='public' AND table_name LIKE 'pilot\\_%' ESCAPE '\\' ORDER BY table_name,ordinal_position");
 });
 const tables=[...new Set(columns.map(c=>c.table_name))];
 const lines=['# Actual isolated pilot database tables','',`Inspected: ${new Date().toISOString()}. Database: flsd_pilot_validation; host: 127.0.0.1; port: 55437; schema: public; pilot schema version: 3.`, '',
 'Read-only catalog inspection; no row values, passwords, password hashes, tokens, attachments or connection secrets are exported.', '',
 'Enter or edit business records through the application, not these tables. The current pilot keeps an authoritative workspace aggregate with relational projections. Direct SQL edits to projections can be overwritten or invisible in the application, and bypass validation, financial relationships and audit. This is a private MVP persistence design, not a completed production database-administration workflow.', '',
 'Use Customers, Vehicles and Drivers to add master records, then Trips > New trip. Use the payment, remittance, SOA and invoice workflows for financial test records. Existing QA records are retained automated-test data; they are not live opening balances.', '',
 '## Table inventory','',...tables.map(t=>'- `'+t+'`'),'',
 '## Columns',''];
 for(const table of tables){lines.push('### '+table,'','| Column | PostgreSQL type | Nullable |','| --- | --- | --- |');for(const c of columns.filter(c=>c.table_name===table)){const type=c.data_type==='numeric'?`numeric(${c.numeric_precision},${c.numeric_scale})`:c.data_type;lines.push(`| ${c.column_name} | ${type} | ${c.is_nullable} |`);}lines.push('');}
 lines.push('## Optional database viewer','',
 'A PostgreSQL viewer such as pgAdmin would connect to 127.0.0.1, port 55437, database flsd_pilot_validation, schema public. The application Owner login is not a PostgreSQL login. Use a separately provisioned read-only database role for inspection; do not share the runtime or maintenance credentials or enable table editing. No new database login is created by this inspection.', '',
 'Read-only SQL examples after a suitable connection is provisioned:','',
 '```sql',"SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;",'SELECT id, name, tin, address, active FROM public.pilot_customers WHERE archived = false ORDER BY name;','SELECT id, customer_id, service_date, workflow, amount FROM public.pilot_trips WHERE archived = false ORDER BY service_date DESC LIMIT 100;','```','');
 fs.writeFileSync(path.join(root,'docs/PILOT_DATABASE_TABLES.md'),lines.join('\n'));
 console.log('Read-only catalog verified: '+tables.length+' tables. Column inventory saved to docs/PILOT_DATABASE_TABLES.md. No row data or credentials exported.');
})().catch(()=>{console.error('Read-only pilot inspection stopped; no secret details logged.');process.exitCode=1;}).finally(async()=>{if(db)await db.$disconnect();});
