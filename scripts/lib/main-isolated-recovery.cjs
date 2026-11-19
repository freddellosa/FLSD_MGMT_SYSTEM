// eslint-disable-next-line @typescript-eslint/no-require-imports -- Node-only recovery tooling.
const {createHash} = require('node:crypto');

const runId = '75435c87-0a31-42b7-9761-738db6c5c866';
const schema = 'flsd_iso_' + runId.replaceAll('-', '');
const tables = {
  meta: ['id', 'run_id', 'marker'],
  actors: ['id', 'role', 'active'],
  sessions: ['token_hash', 'actor_id', 'expires_at'],
  workspace: ['id', 'revision', 'payload'],
  records: ['kind', 'id', 'version', 'customer_id', 'amount', 'payload'],
  operations: ['operation_id', 'actor_id', 'digest', 'receipt'],
  audit: ['operation_id', 'actor_id', 'event'],
  history: ['operation_id', 'payload'],
};
const primaryKeys = {meta:'id', actors:'id', sessions:'token_hash COLLATE "C"', workspace:'id', records:'kind COLLATE "C",id COLLATE "C"', operations:'operation_id', audit:'operation_id', history:'operation_id'};
const hash = value => createHash('sha256').update(value).digest('hex').toUpperCase();
const migrationHash = '0B73853CB8A5D82651785FF35C9C9F9DC898205429C3AAE50708A1A7E8426FDC';

function selectedCopyBlocks(decoded) {
  const blocks = new Map();
  let table, key, unrestricted = false;
  for (const line of decoded.replaceAll('\r\n', '\n').split('\n')) {
    if (table) {
      blocks.get(table).push(line);
      if (line === '\\.') table = undefined;
      continue;
    }
    if (/^\s*$|^--/.test(line)) continue;
    const restrict = /^\\(restrict|unrestrict) ([A-Za-z0-9]+)$/.exec(line);
    if (restrict) {
      if (restrict[1] === 'restrict' && !key && !blocks.size) key = restrict[2];
      else if (restrict[1] === 'unrestrict' && key === restrict[2] && !unrestricted && blocks.size === Object.keys(tables).length) unrestricted = true;
      else throw new Error('Unexpected archive control command');
      continue;
    }
    if (!unrestricted && blocks.size === 0 && (
      /^SET (?:statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout) = 0;$/.test(line) ||
      /^SET (?:client_encoding = 'UTF8'|standard_conforming_strings = on|check_function_bodies = false|xmloption = content|client_min_messages = warning|row_security = off);$/.test(line) ||
      line === "SELECT pg_catalog.set_config('search_path', '', false);"
    )) continue;
    const copy = /^COPY ([a-z0-9_]+)\.([a-z_]+) \(([^)]+)\) FROM stdin;$/.exec(line);
    if (unrestricted || !copy || copy[1] !== schema || !Object.hasOwn(tables, copy[2]) ||
        copy[3] !== tables[copy[2]].join(', ') || blocks.has(copy[2])) throw new Error('Unexpected decoded archive statement');
    table = copy[2];
    blocks.set(table, [line]);
  }
  if (table || (key && !unrestricted) || blocks.size !== Object.keys(tables).length) throw new Error('Incomplete archive data');
  return Object.keys(tables).map(name => blocks.get(name).join('\n')).join('\n');
}

function validateArchiveList(list, owner) {
  if (!/^flsd_test_owner_[a-f0-9]{12}$/.test(owner)) throw new Error('Invalid recovery owner');
  const required = new Set([
    `SCHEMA - ${schema}`, `COMMENT - SCHEMA ${schema}`,
    ...Object.keys(tables).flatMap(table => [
      `TABLE ${schema} ${table}`, `TABLE DATA ${schema} ${table}`,
      `CONSTRAINT ${schema} ${table} ${table}_pkey`,
    ]),
    ...['immutable_history()', 'require_atomic_history()'].map(name=>`FUNCTION ${schema} ${name}`),
    ...['sessions actor_id', 'operations actor_id', 'audit actor_id', 'audit operation_id', 'history operation_id'].map(pair=>{
      const [table,column]=pair.split(' ');
      return `FK CONSTRAINT ${schema} ${table} ${table}_${column}_fkey`;
    }),
    ...['operations immutable_operations','audit immutable_audit','history immutable_history','operations atomic_history'].map(trigger=>`TRIGGER ${schema} ${trigger}`),
  ]);
  for (const line of list.split(/\r?\n/)) {
    if (/^\s*$|^;/.test(line)) continue;
    const item = /^\d+; \d+ \d+ (.+) (\S+)$/.exec(line.trim());
    if (!item || item[2] !== owner || !required.delete(item[1])) throw new Error('Unexpected archive object');
  }
  if (required.size) throw new Error('Incomplete archive object list');
}

function recoveryDdl(migration, parentRunId) {
  if (hash(migration) !== migrationHash || parentRunId !== 'b813e743-9f4c-4121-b8ab-b01ca51b9335') throw new Error('Recovery DDL provenance mismatch');
  const sql = migration.toString('utf8');
  const start = sql.indexOf('CREATE SCHEMA flsd_adapter_test;');
  const end = sql.indexOf('REVOKE ALL ON SCHEMA flsd_adapter_test FROM PUBLIC;');
  if (start < 0 || end <= start) throw new Error('Recovery DDL boundaries missing');
  return sql.slice(start,end).replaceAll('flsd_adapter_test',schema)
    .replace(/^INSERT INTO .*\.meta VALUES[^\r\n]+\r?\n/m,'') +
    `COMMENT ON SCHEMA ${schema} IS 'FLSD_ISOLATED:${parentRunId}:${runId}:${schema}';\n` +
    `REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;\nREVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC;\nREVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC;\n`;
}

function manifestSql() {
  const rows = Object.keys(tables).map(table => `'${table}', (
    SELECT jsonb_build_array(count(*),encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(t) ORDER BY ${primaryKeys[table]})::text,'[]'),'UTF8')),'hex'))
    FROM ${schema}.${table} t
  )`).join(',');
  const catalog = `SELECT jsonb_build_array(
    (SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname COLLATE "C",a.attnum)
       FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
       WHERE c.relnamespace='${schema}'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped),
    (SELECT jsonb_agg(jsonb_build_array(conname,pg_get_constraintdef(oid),convalidated,condeferrable,condeferred) ORDER BY conname COLLATE "C")
       FROM pg_constraint WHERE connamespace='${schema}'::regnamespace),
    (SELECT jsonb_agg(jsonb_build_array(tgname,pg_get_triggerdef(t.oid),tgenabled) ORDER BY tgname COLLATE "C")
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='${schema}'::regnamespace AND NOT t.tgisinternal),
    (SELECT jsonb_agg(pg_get_functiondef(oid) ORDER BY proname COLLATE "C") FROM pg_proc WHERE pronamespace='${schema}'::regnamespace),
    (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY k.relname COLLATE "C")
       FROM pg_index i JOIN pg_class k ON k.oid=i.indexrelid WHERE k.relnamespace='${schema}'::regnamespace)
  )`;
  return `SELECT jsonb_build_object('data',jsonb_build_object(${rows}),
    'catalogSha256',encode(sha256(convert_to((${catalog})::text,'UTF8')),'hex'),
    'revision',(SELECT revision::text FROM ${schema}.workspace WHERE id=1),
    'integrity', (
      (SELECT count(*)=1 AND bool_and(run_id='${runId}' AND marker='FLSD_SYNTHETIC_ADAPTER_V1') FROM ${schema}.meta)
      AND (SELECT count(*)=1 FROM ${schema}.workspace)
      AND NOT EXISTS (SELECT 1 FROM ${schema}.operations o LEFT JOIN ${schema}.audit a USING(operation_id)
        LEFT JOIN ${schema}.history h USING(operation_id) WHERE a.actor_id IS DISTINCT FROM o.actor_id OR h.operation_id IS NULL)
      AND (NOT EXISTS (SELECT 1 FROM ${schema}.operations) OR EXISTS (
        SELECT 1 FROM ${schema}.history h JOIN ${schema}.workspace w ON w.payload=h.payload
        WHERE h.operation_id=(SELECT operation_id FROM ${schema}.audit ORDER BY (event->>'occurredAt')::timestamptz DESC,operation_id DESC LIMIT 1)
      ))
    ))`;
}

module.exports = {selectedCopyBlocks,validateArchiveList,recoveryDdl,manifestSql,runId,schema};
