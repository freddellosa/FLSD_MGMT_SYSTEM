/** Sanitized staging contract only: no persistence, financial mapping or execution authorization. */
import {parseCsvTable} from './csv';
import {sixTableSchemas, type SixTableKind} from './six-table-schemas';
export {sixTableSchemas, type SixTableKind} from './six-table-schemas';

const requiredHeaders: Record<SixTableKind, readonly string[]> = {
  Driver_tbl: ['DriverID', 'DriverName'], vehicle_tbl: ['VehicleID', 'MakeModel', 'PlateNo'],
  company_tbl: ['CompanyID', 'CompanyName'],
  Trips_Tbl: ['tmpInvoiceNo', 'CompanyID', 'VehicleID', 'DriverID', 'DateOfTrip_Start', 'InvoiceTotAmt'],
  SOA_Tbl: ['SOANo', 'ChargeTo', 'InvoiceNo', 'Status'],
  Invoice_Tbl: ['InvoiceNo', 'SOANo', 'ChargeTo', 'InvoiceTotAmt', 'Status'],
};
export function stageSixTableCsv(kind: SixTableKind, text: string) {
  if (!Object.hasOwn(sixTableSchemas, kind) || typeof text !== 'string' || text.length > 30 * 1024 * 1024) throw new Error('Unsupported source table or export bound');
  const schema = sixTableSchemas[kind], parsed = parseCsvTable(text, {strictQuotes: true});
  if (parsed.rows.length > 100000) throw new Error('Export exceeds 100,000 row staging bound');
  if (parsed.headers.some(h => /password|secret|token|credential/i.test(h))) throw new Error('Security fields are outside the transport import contract');
  const missingRequired = requiredHeaders[kind].filter(h => !parsed.headers.includes(h));
  if (missingRequired.length) throw new Error('Missing required source headers: ' + missingRequired.join(', '));
  const known = new Set<string>(schema.headers), excluded = new Set<string>(schema.excluded);
  const unknownHeaders = parsed.headers.filter(h => !known.has(h));
  const missingOptional = schema.headers.filter(h => !parsed.headers.includes(h) && !excluded.has(h) && !requiredHeaders[kind].includes(h));
  const retained = parsed.headers.filter(h => known.has(h) && !excluded.has(h));
  const counts = new Map<string, number>();
  for (const row of parsed.rows) {const key = row[schema.key]; if (key) counts.set(key, (counts.get(key) ?? 0) + 1);}
  const rows = parsed.rows.map((row, i) => {
    const key = row[schema.key], issues: string[] = [];
    if (!key?.trim()) issues.push('MISSING_SOURCE_KEY');
    else if (key !== key.trim()) issues.push('SOURCE_KEY_WHITESPACE_REQUIRES_REVIEW');
    if ((counts.get(key) ?? 0) > 1) issues.push('DUPLICATE_SOURCE_KEY');
    // Payroll/unknown fields are deliberately absent, including from rejected row payloads.
    return {logicalRow: i + 2, sourceKey: key, payload: Object.fromEntries(retained.map(h => [h, row[h]])), issues};
  });
  return {kind: 'SIX_TABLE_HEADER_STAGING' as const, version: 1, sourceTable: kind,
    importEnabled: false as const, executionAuthorized: false as const, headerMatching: 'NAME' as const,
    headers: parsed.headers, excludedHeaders: parsed.headers.filter(h => excluded.has(h)), unknownHeaders, missingOptional,
    structuralStatus: unknownHeaders.length || missingOptional.length || rows.some(r => r.issues.length) ? 'REVIEW' as const : 'STAGED' as const,
    counts: {rows: rows.length, rowsWithKeyIssues: rows.filter(r => r.issues.length).length, excludedFields: parsed.headers.filter(h => excluded.has(h)).length}, rows,
    note: 'Header/key staging only; does not validate money, tax, relationships, contract scope or import readiness.'};
}
