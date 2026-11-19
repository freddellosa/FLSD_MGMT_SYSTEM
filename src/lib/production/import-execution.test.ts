import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {prepareNormalizedSource} from '../migration/normalized-source';
import {sixTableSchemas, type SixTableKind} from '../migration/six-table-contract';
import {createSyntheticReviewRepository} from './review-repository';
import {planPostgresReviewCommit} from './postgres-commit-plan';
import {prepareSyntheticImportManifest, executeSyntheticImportChunk, seedSyntheticBusinessCounter, createSyntheticNumberedEntity, decimalColumnsForReviewEntity, type NumberedCreateCommand} from './import-execution';
const mapping = readFileSync('docs/LEGACY_SIX_TABLE_FIELD_MAP.csv', 'utf8');
function source(companyName = 'SYNTHETIC Customer', tripKey = '0001') {
  const rows: Record<SixTableKind, Record<string, string>> = {
    Driver_tbl: {DriverID: 'D1', DriverName: 'SYNTHETIC Driver', isActv: 'Y', SSSNo: 'EXCLUDED PAYROLL'},
    vehicle_tbl: {VehicleID: 'V1', MakeModel: 'SYNTHETIC Vehicle', PlateNo: 'QA 001', NoOfSeats: '10', Active: 'Y'},
    company_tbl: {CompanyID: 'C1', CompanyName: companyName, NeedPO: 'N', NeedRequestor: 'N'},
    Trips_Tbl: {tmpInvoiceNo: tripKey, CompanyID: 'C1', VehicleID: 'V1', DriverID: 'D1', DateOfTrip_Start: '9/1/2026 08:00:00', DateOfTrip_End: '9/1/2026 17:00:00',
      BaseAmount: '100', OTFee: '0', Evat: '0', Gas: '0', TollFee: '0', ParkingFee: '0', FoodExp: '0', Lodging: '0', InvoiceTotAmt: '100.01', SOANo: 'S1'},
    SOA_Tbl: {SOANo: 'S1', InvoiceNo: 'I1', ChargeTo: 'SYNTHETIC snapshot', Status: 'Received'},
    Invoice_Tbl: {InvoiceNo: 'I1', SOANo: 'S1', ChargeTo: 'SYNTHETIC snapshot', InvoiceTotAmt: '100.01', Evat: '0', Status: 'Paid'},
  };
  const files = (Object.keys(rows) as SixTableKind[]).map(table => {
    const headers = sixTableSchemas[table].headers, q = (v: string) => '"' + v.replaceAll('"', '""') + '"';
    return {id: table + '.csv', table, bytes: new TextEncoder().encode(headers.map(q).join(',') + '\n' + headers.map(h => q(rows[table][h] ?? '')).join(','))};
  });
  const prepared = prepareNormalizedSource(files, {namespace: 'SYNTHETIC', from: '2026-09-01', through: '2026-10-31', retainMissingSoaReferences: true}, mapping);
  if (!prepared.sourceSnapshot) throw new Error('fixture');
  const data = prepared.sourceSnapshot;
  return {data, manifest: prepareSyntheticImportManifest(data, prepared.mappingSha256, data.coverageSha256, 2)};
}
function fixture(options: {failAtCheckpoint?: number; failAfterCommitOnce?: boolean} = {}) {
  const repo = createSyntheticReviewRepository({id: '00000000-0000-4000-8000-000000000001', role: 'ADMIN'}, options), s = source();
  const command = (i: number) => ({operationId: 'chunk-' + i, batchId: 'batch-1', chunkIndex: i, expectedRevision: repo.snapshot().revision});
  const load = async () => {for (let i = 0; i < s.manifest.chunks; i++) await executeSyntheticImportChunk(repo.repository, s.data, s.manifest, command(i));};
  return {...repo, ...s, command, load};
}
describe('PR-1 synthetic import execution and atomic numbering', () => {
  it('resumes bounded dependency-ordered chunks into held entities without cash events, number consumption or invented parents', async () => {
    const f = fixture(); await f.load(); const state = f.snapshot();
    expect(state.entities).toHaveLength(6); expect(state.mappings).toHaveLength(6); expect(state.sourceRows).toHaveLength(6); expect(state.history).toHaveLength(6);
    expect(state.batches[0]).toMatchObject({state: 'RECONCILING', chunks: [0, 1, 2]});
    expect(state.entities.every(e => e.visibility === 'REVIEW_HOLD' && e.businessNumber === null)).toBe(true); expect(state.counters).toEqual([]);
    expect(state.audit).toHaveLength(3); expect(Object.keys(state.receipts)).toHaveLength(3);
    const trip = state.entities.find(e => e.kind === 'Trips_Tbl')!;
    expect(trip.legacyBusinessNumber).toBe('0001'); expect(trip.foreignKeys.CompanyID).toBe(state.entities.find(e => e.kind === 'company_tbl')!.id);
    expect(decimalColumnsForReviewEntity(trip)['facts.trip_charges.agreed_gross']).toBe('100.01');
    expect(state.entities.find(e => e.kind === 'Invoice_Tbl')!.typedFacts['facts.invoices.source_status']).toBe('Paid');
    expect(state).not.toHaveProperty('payments'); expect(JSON.stringify(state)).not.toContain('EXCLUDED PAYROLL');
  });
  it('returns the same IDs for same-operation concurrent retries without duplicate audit/source/history', async () => {
    const f = fixture(), cmd = f.command(0);
    const [a, b] = await Promise.all([executeSyntheticImportChunk(f.repository, f.data, f.manifest, cmd), executeSyntheticImportChunk(f.repository, f.data, f.manifest, cmd)]);
    expect(a.entityIds).toEqual(b.entityIds); expect([a.replayed, b.replayed]).toEqual([false, true]);
    expect(f.snapshot().entities).toHaveLength(2); expect(f.snapshot().audit).toHaveLength(1); expect(f.snapshot().revision).toBe(1);
  });
  it('rejects changed actor/payload and current permission revocation before replay', async () => {
    const f = fixture(), cmd = f.command(0); await executeSyntheticImportChunk(f.repository, f.data, f.manifest, cmd);
    await expect(executeSyntheticImportChunk(f.repository, f.data, f.manifest, {...cmd, batchId: 'different'})).rejects.toThrow('Operation ID reused');
    f.setActorForTest({id: 'other-actor', role: 'ADMIN'}); await expect(executeSyntheticImportChunk(f.repository, f.data, f.manifest, cmd)).rejects.toThrow('actor');
    f.setActorForTest({id: 'server-test-actor', role: 'VIEWER'}); await expect(executeSyntheticImportChunk(f.repository, f.data, f.manifest, cmd)).rejects.toThrow('Forbidden');
  });
  it('rolls back entity/source/mapping/history/batch/audit on failure before receipt commit', async () => {
    const f = fixture({failAtCheckpoint: 2}), before = f.snapshot();
    await expect(executeSyntheticImportChunk(f.repository, f.data, f.manifest, f.command(0))).rejects.toThrow('injected'); expect(f.snapshot()).toEqual(before);
  });
  it('recovers unknown-commit outcome by replaying the original operation', async () => {
    const f = fixture({failAfterCommitOnce: true}), cmd = f.command(0);
    await expect(executeSyntheticImportChunk(f.repository, f.data, f.manifest, cmd)).rejects.toThrow('outcome unknown');
    const ids = f.snapshot().entities.map(e => e.id), result = await executeSyntheticImportChunk(f.repository, f.data, f.manifest, cmd);
    expect(result).toMatchObject({replayed: true, entityIds: ids}); expect(f.snapshot().revision).toBe(1);
  });
  it('rejects skipped chunks, stale revisions and reapplying an already committed chunk under another key', async () => {
    const f = fixture(); await expect(executeSyntheticImportChunk(f.repository, f.data, f.manifest, f.command(1))).rejects.toThrow('chunk');
    const original = f.command(0); await executeSyntheticImportChunk(f.repository, f.data, f.manifest, original);
    await expect(executeSyntheticImportChunk(f.repository, f.data, f.manifest, {...f.command(1), expectedRevision: 0})).rejects.toThrow('revision changed');
    await expect(executeSyntheticImportChunk(f.repository, f.data, f.manifest, {...f.command(0), operationId: 'another'})).rejects.toThrow('already committed');
  });
  it('retains existing entities when revised source evidence is supplied', async () => {
    const f = fixture(); await f.load(); const changed = source('CHANGED SYNTHETIC Customer');
    const manifest = prepareSyntheticImportManifest(changed.data, changed.manifest.mappingSha256, changed.data.coverageSha256, 100), before = f.snapshot();
    await expect(executeSyntheticImportChunk(f.repository, changed.data, manifest, {operationId: 'revised', batchId: 'revised-batch', chunkIndex: 0, expectedRevision: before.revision})).rejects.toThrow('requires review');
    expect(f.snapshot()).toEqual(before);
  });
  it('refuses an alternative batch ID for the same manifest and refuses forged actors in commands', async () => {
    const f = fixture(); await executeSyntheticImportChunk(f.repository, f.data, f.manifest, f.command(0));
    await expect(executeSyntheticImportChunk(f.repository, f.data, f.manifest, {...f.command(0), operationId: 'alternative', batchId: 'alternative'})).rejects.toThrow('Manifest already staged');
    await expect(executeSyntheticImportChunk(f.repository, f.data, f.manifest, {...f.command(1), actorId: 'forged'} as ReturnType<typeof f.command>)).rejects.toThrow('Unsupported');
  });
  it('seeds only the exact reviewed synthetic history and atomically assigns the next new number', async () => {
    const f = fixture(); await f.load();
    await expect(seedSyntheticBusinessCounter(f.repository, {operationId: 'bad-seed', expectedRevision: 3, kind: 'TRIP', reviewedNumbers: [], reviewRef: 'synthetic-review', scope: 'COMPLETE_SYNTHETIC_HISTORY'})).rejects.toThrow('coverage');
    await seedSyntheticBusinessCounter(f.repository, {operationId: 'seed', expectedRevision: 3, kind: 'TRIP', reviewedNumbers: ['0001'], reviewRef: 'synthetic-review', scope: 'COMPLETE_SYNTHETIC_HISTORY'});
    const cmd: NumberedCreateCommand = {operationId: 'new-trip', expectedRevision: 4, kind: 'TRIP', expectedCounterRevision: 0, typedFacts: {'facts.trips.service_start_local': '2026-11-01T08:00:00', 'facts.trip_charges.agreed_gross': '0'}};
    const created = await createSyntheticNumberedEntity(f.repository, cmd), repeated = await createSyntheticNumberedEntity(f.repository, cmd);
    expect(created.businessNumber).toBe('2'); expect(repeated).toMatchObject({replayed: true, entityIds: created.entityIds}); expect(f.counterForTest('TRIP')).toMatchObject({next: 3n, revision: 1});
    expect(f.snapshot().entities.find(e => e.id === created.entityIds[0])!.legacyBusinessNumber).toBeNull();
    expect(f.snapshot().entities.find(e => e.legacyBusinessNumber === '0001')!.businessNumber).toBeNull();
  });
  it('rolls back a counter reservation if entity creation fails', async () => {
    const options: {failAtCheckpoint?: number} = {}, f = fixture(options);
    await seedSyntheticBusinessCounter(f.repository, {operationId: 'empty-reviewed-seed', expectedRevision: 0, kind: 'TRIP', reviewedNumbers: [], reviewRef: 'synthetic-empty-history', scope: 'COMPLETE_SYNTHETIC_HISTORY'});
    const before = f.snapshot(); options.failAtCheckpoint = 2;
    await expect(createSyntheticNumberedEntity(f.repository, {operationId: 'failed-new', expectedRevision: 1, kind: 'TRIP', expectedCounterRevision: 0, typedFacts: {}})).rejects.toThrow('injected');
    expect(f.snapshot()).toEqual(before);
  });
  it('fails closed for official invoice generic numbering and malformed money/date values', async () => {
    const f = fixture();
    await expect(createSyntheticNumberedEntity(f.repository, {operationId: 'invalid', expectedRevision: 0, kind: 'INVOICE', expectedCounterRevision: 0, typedFacts: {}} as unknown as NumberedCreateCommand)).rejects.toThrow('invoice stock');
    const invalidFields: Record<string, string | boolean | null>[] = [{'facts.trip_charges.agreed_gross': '0.001'}, {'facts.trips.service_start_local': '2026-02-30T08:00:00'}];
    for (const typedFacts of invalidFields) {
      await expect(createSyntheticNumberedEntity(f.repository, {operationId: 'invalid', expectedRevision: 0, kind: 'TRIP', expectedCounterRevision: 0, typedFacts})).rejects.toThrow();
    }
    expect(f.snapshot().revision).toBe(0);
  });
  it('preserves bigint number precision at the signed-64-bit ceiling and never wraps an exhausted series', async () => {
    const s = source('SYNTHETIC', '9223372036854775806'), f = createSyntheticReviewRepository({id: 'server-actor', role: 'ADMIN'});
    for (let i = 0; i < s.manifest.chunks; i++) await executeSyntheticImportChunk(f.repository, s.data, s.manifest, {operationId: 'max-chunk-' + i, batchId: 'max-batch', chunkIndex: i, expectedRevision: f.snapshot().revision});
    await seedSyntheticBusinessCounter(f.repository, {operationId: 'max-seed', expectedRevision: 3, kind: 'TRIP', reviewedNumbers: ['9223372036854775806'], reviewRef: 'SYNTHETIC', scope: 'COMPLETE_SYNTHETIC_HISTORY'});
    const result = await createSyntheticNumberedEntity(f.repository, {operationId: 'last-number', expectedRevision: 4, kind: 'TRIP', expectedCounterRevision: 0, typedFacts: {}});
    expect(result.businessNumber).toBe('9223372036854775807'); expect(f.counterForTest('TRIP')!.next).toBeNull();
    const before = f.snapshot();
    await expect(createSyntheticNumberedEntity(f.repository, {operationId: 'exhausted', expectedRevision: 5, kind: 'TRIP', expectedCounterRevision: 1, typedFacts: {}})).rejects.toThrow('exhausted');
    expect(f.snapshot()).toEqual(before);
  });
  it('rejects stale counter revisions without consuming a number', async () => {
    const f = fixture();
    await seedSyntheticBusinessCounter(f.repository, {operationId: 'seed', expectedRevision: 0, kind: 'TRIP', reviewedNumbers: [], reviewRef: 'SYNTHETIC', scope: 'COMPLETE_SYNTHETIC_HISTORY'});
    const before = f.snapshot();
    await expect(createSyntheticNumberedEntity(f.repository, {operationId: 'stale-counter', expectedRevision: 1, kind: 'TRIP', expectedCounterRevision: 9, typedFacts: {}})).rejects.toThrow('revision');
    expect(f.snapshot()).toEqual(before);
  });
  it('plans one atomic SQL write set for a complete synthetic six-table chunk with exact legacy references and typed mappings', async () => {
    const f = fixture(), before = f.snapshot(), manifest = prepareSyntheticImportManifest(f.data, f.manifest.mappingSha256, f.data.coverageSha256, 100);
    await executeSyntheticImportChunk(f.repository, f.data, manifest, f.command(0));
    const plan = planPostgresReviewCommit(before, f.snapshot());
    expect(plan.statements.filter(s => s.text.startsWith('INSERT INTO flsd_core_review.legacy_entity_mappings'))).toHaveLength(6);
    expect(plan.statements.filter(s => s.text.startsWith('INSERT INTO flsd_core_review.import_source_rows'))).toHaveLength(6);
    const trip = plan.statements.find(s => s.text.startsWith('INSERT INTO flsd_core_review.trips '))!;
    expect(trip.text).toContain('legacy_soa_reference'); expect(trip.values).toContain('S1');
    expect(plan.statements.every(s => !s.text.includes('Payment') && !s.text.includes('Receipt'))).toBe(true);
    expect(plan.statements.every(s => s.expectedRows === 1)).toBe(true);
  });
});
