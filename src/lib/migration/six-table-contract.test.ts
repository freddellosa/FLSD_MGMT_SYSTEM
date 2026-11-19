import {describe, expect, it} from 'vitest';
import {stageSixTableCsv, sixTableSchemas} from './six-table-contract';
describe('production six-table header staging contract', () => {
  it('keeps CompanyID and DriverID correct when columns change position', () => {
    const a = stageSixTableCsv('Trips_Tbl', 'tmpInvoiceNo,CompanyID,VehicleID,DriverID,DateOfTrip_Start,InvoiceTotAmt\n0001,C68,V1,D2,9/1/2026,112.00');
    const b = stageSixTableCsv('Trips_Tbl', 'DriverID,InvoiceTotAmt,tmpInvoiceNo,VehicleID,DateOfTrip_Start,CompanyID\nD2,112.00,0001,V1,9/1/2026,C68');
    expect(a.rows).toEqual(b.rows);
    expect(a.rows[0].payload).toMatchObject({CompanyID: 'C68', DriverID: 'D2', tmpInvoiceNo: '0001'});
    expect(a.importEnabled).toBe(false); expect(a.executionAuthorized).toBe(false);
  });
  it('never retains payroll or unknown field values in transport payloads', () => {
    const staged = stageSixTableCsv('Driver_tbl', 'DriverID,DriverName,SSSNo,SSS_Rate,Unreviewed\n1,QA driver,DO-NOT-RETAIN,987.12,UNMAPPED');
    expect(staged.rows[0].payload).toEqual({DriverID: '1', DriverName: 'QA driver'});
    expect(staged.excludedHeaders).toEqual(['SSSNo', 'SSS_Rate']); expect(staged.unknownHeaders).toEqual(['Unreviewed']);
    expect(JSON.stringify(staged)).not.toContain('DO-NOT-RETAIN'); expect(JSON.stringify(staged)).not.toContain('987.12');
    expect(staged.structuralStatus).toBe('REVIEW');
  });
  it('preserves leading-zero source identities, raw amounts and statuses without synthesizing financial records', () => {
    const staged = stageSixTableCsv('Invoice_Tbl', 'InvoiceNo,SOANo,ChargeTo,InvoiceTotAmt,Status\n001,0,QA,9999999999999999.99,Paid\n1,0,QA,0,Cancelled');
    expect(staged.rows.map(r => r.sourceKey)).toEqual(['001', '1']);
    expect(staged.rows.every(r => !r.issues.length)).toBe(true);
    expect(staged.rows[0].payload).toMatchObject({InvoiceTotAmt: '9999999999999999.99', Status: 'Paid'});
    expect(staged).not.toHaveProperty('receipts');
  });
  it('flags every duplicate without deduplicating, and does not silently trim identity values', () => {
    const staged = stageSixTableCsv('company_tbl', 'CompanyID,CompanyName\n1,QA\n1,QA\n 1,QA\n,QA');
    expect(staged.rows).toHaveLength(4);
    expect(staged.rows[0].issues).toContain('DUPLICATE_SOURCE_KEY'); expect(staged.rows[1].issues).toContain('DUPLICATE_SOURCE_KEY');
    expect(staged.rows[2]).toMatchObject({sourceKey: ' 1', issues: ['SOURCE_KEY_WHITESPACE_REQUIRES_REVIEW']});
    expect(staged.rows[3].issues).toContain('MISSING_SOURCE_KEY');
  });
  it.each(['DriverID,DriverID,DriverName\n1,2,QA', 'driverid,DriverName\n1,QA', 'DriverName\nQA'])('rejects missing, duplicate or unapproved case aliases: %s', text => {
    expect(() => stageSixTableCsv('Driver_tbl', text)).toThrow();
  });
  it('validates header-only exports without inventing a data row or an import approval', () => {
    const headers = sixTableSchemas.vehicle_tbl.headers;
    const staged = stageSixTableCsv('vehicle_tbl', '\uFEFF' + headers.join(','));
    expect(staged.counts.rows).toBe(0); expect(staged.headers).toEqual([...headers]); expect(staged.executionAuthorized).toBe(false);
  });
  it('rejects unsafe source headers and malformed quoted CSV', () => {
    expect(() => stageSixTableCsv('Driver_tbl', 'DriverID,DriverName,password\n1,QA,hidden')).toThrow('Security fields');
    expect(() => stageSixTableCsv('Driver_tbl', 'DriverID,DriverName\n1,"QA"extra')).toThrow('closing quote');
  });
});
