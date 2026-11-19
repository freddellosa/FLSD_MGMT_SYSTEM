import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = 'D:\\FLSD-Batch7-Validation';
const source = 'flsd_pilot_validation';
const adapter = process.argv[2] === '--prepare-fictional-adapter';
const qa = process.argv[2] === '--prepare-fictional-receipt-qa';
const browser = qa || process.argv[2] === '--prepare-fictional-receipt-browser';
const office = browser || process.argv[2] === '--prepare-fictional-office';
const target = qa ? 'flsd_batch7_receipt_qa_rehearsal' : browser ? 'flsd_batch7_receipt_browser_rehearsal' : office ? 'flsd_batch7_receipt_office_rehearsal' : adapter ? 'flsd_batch7_receipt_adapter_rehearsal' : 'flsd_batch7_receipt_rehearsal';
const marker = qa ? 'FLSD_BATCH7_RECEIPT_QA_ONLY' : browser ? 'FLSD_BATCH7_RECEIPT_BROWSER_ONLY' : office ? 'FLSD_BATCH7_RECEIPT_OFFICE_ONLY' : adapter ? 'FLSD_BATCH7_RECEIPT_ADAPTER_ONLY' : 'FLSD_BATCH7_RECEIPT_REHEARSAL_ONLY';
const writer = qa ? 'flsd_batch7_receipt_qa_writer' : browser ? 'flsd_batch7_receipt_browser_writer' : office ? 'flsd_batch7_receipt_office_writer' : adapter ? 'flsd_batch7_receipt_adapter_writer' : 'flsd_batch7_receipt_rehearsal_writer';
const schema = 'flsd_batch7_commit_rehearsal';
const evidence = qa ? 'artifacts/batch7-receipt-qa-bootstrap.json' : browser ? 'artifacts/batch7-receipt-browser-bootstrap.json' : office ? 'artifacts/batch7-receipt-office-bootstrap.json' : adapter ? 'artifacts/batch7-receipt-adapter-bootstrap.json' : 'artifacts/batch7-multi-invoice-receipt-rehearsal.json';
let stage = 'PREFLIGHT';

function main() {
  assert.ok(office || adapter || process.argv[2] === '--fresh-fictional-rehearsal');
  assert.equal(resolve('.'), root);
  assert.ok(!existsSync(evidence));
  const configPath = resolve('.pilot/maintenance.json');
  assert.equal(realpathSync(configPath).toLowerCase(), configPath.toLowerCase());
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.ok(config.marker === 'FLSD_ISOLATED_PILOT_ONLY' && config.host === '127.0.0.1' &&
    config.port === 55437 && config.database === source && config.user === 'flsd_pilot_admin' &&
    typeof config.password === 'string' && config.password);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key)));
  Object.assign(env, {PGPASSWORD: config.password, PGHOSTADDR: config.host, PGCONNECT_TIMEOUT: '5',
    PGOPTIONS: '-c statement_timeout=20000 -c lock_timeout=5000'});
  function pg(database, input) {
    const run = spawnSync('C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe',
      ['-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1', '-h', config.host, '-p', '55437', '-U', config.user, '-d', database, '-f', '-'],
      {env, input: input+'\n', encoding: 'utf8', windowsHide: true, timeout: 30000});
    if (run.status !== 0) {
      const state = run.stderr?.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1];
      throw Error(state ?? 'PSQL_FAILED');
    }
    return run.stdout.trim();
  }
  const exactConnection = "current_user='flsd_pilot_admin' AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=55437 AND NOT pg_is_in_recovery()";
  stage = 'ISOLATED_CLUSTER_IDENTITY';
  assert.equal(pg(source, `BEGIN READ ONLY;
    SELECT (${exactConnection} AND current_database()='${source}' AND
      (SELECT oid FROM pg_database WHERE datname=current_database())=16384 AND
      EXISTS (SELECT 1 FROM public.pilot_meta WHERE id=1 AND schema_version=3 AND marker='FLSD_ISOLATED_PILOT_ONLY'))::int;
    ROLLBACK;`), '1');
  stage = 'CREATE_FRESH_TARGET';
  const oid = pg(source, `DO $$ BEGIN
    IF NOT coalesce((${exactConnection}),false) OR current_database()<>'${source}'
       OR (SELECT oid FROM pg_database WHERE datname=current_database())<>16384
       OR NOT EXISTS (SELECT 1 FROM public.pilot_meta WHERE id=1 AND schema_version=3 AND marker='FLSD_ISOLATED_PILOT_ONLY')
       OR EXISTS (SELECT 1 FROM pg_database WHERE datname='${target}')
       OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${writer}')
    THEN RAISE EXCEPTION 'Target must be fresh'; END IF; END $$;
    CREATE DATABASE ${target} TEMPLATE template0 ALLOW_CONNECTIONS false;
    REVOKE CONNECT,TEMPORARY ON DATABASE ${target} FROM PUBLIC;
    COMMENT ON DATABASE ${target} IS '${marker}';
    ALTER DATABASE ${target} ALLOW_CONNECTIONS true;
    SELECT oid FROM pg_database WHERE datname='${target}';`);
  assert.match(oid, /^[1-9][0-9]+$/);
  const guard = `DO $$ BEGIN
    IF NOT coalesce((${exactConnection}),false) OR current_database()<>'${target}'
       OR NOT EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND oid=${oid}
         AND shobj_description(oid,'pg_database')='${marker}')
    THEN RAISE EXCEPTION 'Target identity refused'; END IF; END $$;`;
  const load = file => readFileSync(resolve('prisma/migration-review', file+'.sql'), 'utf8');
  const receiptSql = file => load(file).replaceAll('flsd_batch7_receipt_rehearsal_writer',writer)
    .replaceAll('flsd_batch7_receipt_rehearsal',target).replaceAll('FLSD_BATCH7_RECEIPT_REHEARSAL_ONLY',marker);
  const old = tail => '70000000-0000-4000-8000-0000000000'+tail;
  const receipt = tail => '71000000-0000-4000-8000-0000000000'+tail;
  const before = `jsonb_build_array(
     (SELECT to_jsonb(a) FROM "PaymentAllocation" a WHERE "paymentId"='${old('06')}'),
     (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM "FinancialOperation" o WHERE "paymentId"='${old('06')}'),
     (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM "PaymentAllocationEvent" e WHERE "paymentId"='${old('06')}'),
     (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM "PaymentRefund" r WHERE "paymentId"='${old('06')}'),
     (SELECT to_jsonb(s) FROM operation_scope s WHERE operation_id='${old('07')}'),
     (SELECT to_jsonb(r) FROM invoice_reservation r WHERE operation_id='${old('07')}'),
     (SELECT to_jsonb(a) FROM "AuditEvent" a WHERE id='${old('13')}'))`;
  stage = 'SERIALIZABLE_SCHEMA_AND_FIXTURE';
  pg(target, `\\set VERBOSITY verbose
    BEGIN ISOLATION LEVEL SERIALIZABLE;
    ${guard}
    CREATE ROLE ${writer} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    COMMENT ON ROLE ${writer} IS '${marker}';
    CREATE SCHEMA ${schema};
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    SET LOCAL search_path TO ${schema}, pg_catalog;
    ${load('batch7-committed-candidate-baseline')}
    ${load('batch7-committed-upgrade-v1')}
    ${load('batch7-committed-candidate-seed')}
    ${load('batch7-committed-upgrade-evidence')}
    CREATE TEMP TABLE opening AS SELECT ${before} AS facts;
    ${receiptSql('batch7-multi-invoice-receipt-rehearsal')}
    ${receiptSql('batch7-multi-invoice-receipt-fixture')}
    DO $$ BEGIN
      IF (SELECT facts FROM opening) IS DISTINCT FROM (${before})
        THEN RAISE EXCEPTION 'Opening history changed'; END IF;
    END $$;
    SET LOCAL ROLE ${writer};
    DO $$ BEGIN
      BEGIN
        INSERT INTO operation_scope VALUES ('${receipt('07')}','${receipt('06')}','${old('02')}',
          '${old('05')}','${old('14')}','DUPLICATE');
        RAISE EXCEPTION 'Duplicate line accepted';
      EXCEPTION WHEN unique_violation THEN NULL; END;
      BEGIN
        INSERT INTO operation_scope VALUES ('${old('08')}','${old('06')}','${old('02')}',
          '${old('05')}','${receipt('14')}','WRONG-ATTRIBUTION');
        RAISE EXCEPTION 'Wrong attribution accepted';
      EXCEPTION WHEN foreign_key_violation THEN NULL; END;
      IF has_table_privilege(current_user,'operation_scope','UPDATE, DELETE, TRUNCATE')
        OR has_table_privilege(current_user,'"PaymentAllocation"','UPDATE, DELETE, TRUNCATE')
        OR has_table_privilege(current_user,'invoice_reservation','INSERT, UPDATE, DELETE')
        THEN RAISE EXCEPTION 'Receipt role can change accepted history'; END IF;
    END $$;
    RESET ROLE;
    COMMIT;`);
  stage = 'READ_ONLY_POST_COMMIT';
  const record = JSON.parse(pg(target, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
    ${guard}
    SET LOCAL search_path TO ${schema}, pg_catalog;
    SELECT json_build_object(
      'payments',(SELECT count(*) FROM "Payment" WHERE id='${receipt('06')}'),
      'scopes',(SELECT count(*) FROM operation_scope WHERE operation_id='${receipt('07')}'),
      'events',(SELECT count(*) FROM "PaymentAllocationEvent" WHERE "operationId"='${receipt('07')}'),
      'auditRows',(SELECT count(*) FROM "AuditEvent" WHERE id='${receipt('13')}'),
      'receivedCentavos',(SELECT (100*amount)::bigint::text FROM "Payment" WHERE id='${receipt('06')}'),
      'allocatedCentavos',(SELECT (100*sum(amount))::bigint::text FROM "PaymentAllocation" WHERE "paymentId"='${receipt('06')}'),
      'openingProjectionCentavos',(SELECT (100*amount)::bigint::text FROM "PaymentAllocation" WHERE "paymentId"='${old('06')}'),
      'closingReceivablesCentavos',((SELECT 100*sum(payable) FROM receivable)-(SELECT 100*sum(amount) FROM "PaymentAllocation"))::bigint::text,
      'retiredWriter',(SELECT NOT rolcanlogin FROM pg_roles WHERE rolname='${writer}'));
    ROLLBACK;`));
  assert.deepEqual(record, {payments:1, scopes:2, events:2, auditRows:1, receivedCentavos:'3001',
    allocatedCentavos:'3001', openingProjectionCentavos:'1001', closingReceivablesCentavos:'5498', retiredWriter:true});
  const report = {status:'BATCH7_MULTI_INVOICE_SCHEMA_REHEARSED', synthetic:true, databaseOid:oid, ...record};
  writeFileSync(evidence, JSON.stringify(report, null, 2)+'\n', {flag:'wx'});
  console.log(JSON.stringify(report));
}
try { main(); }
catch (error) {
  const code = /^[A-Z0-9_]+$/.test(error.message) ? error.message : error.code;
  console.error(JSON.stringify({status:'BATCH7_RECEIPT_REHEARSAL_STOPPED', stage, code}));
  process.exitCode = 1;
}
