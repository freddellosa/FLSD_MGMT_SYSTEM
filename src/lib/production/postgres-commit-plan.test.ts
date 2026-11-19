import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {createSyntheticReviewRepository} from './review-repository';
import {seedSyntheticBusinessCounter, createSyntheticNumberedEntity} from './import-execution';
import {planPostgresReviewCommit} from './postgres-commit-plan';
const actor = {id: '00000000-0000-4000-8000-000000000001', role: 'ADMIN' as const};
describe('disconnected production SQL commit planning', () => {
  it('binds text/JSON values instead of interpolating them and keeps execution disabled', async () => {
    const f = createSyntheticReviewRepository(actor);
    await seedSyntheticBusinessCounter(f.repository, {operationId: 'seed', expectedRevision: 0, kind: 'COMPANY', reviewedNumbers: [], reviewRef: 'SYNTHETIC', scope: 'COMPLETE_SYNTHETIC_HISTORY'});
    const before = f.snapshot(), hostile = "Name '; DROP TABLE customers; --";
    await createSyntheticNumberedEntity(f.repository, {operationId: 'create', expectedRevision: 1, expectedCounterRevision: 0, kind: 'COMPANY', typedFacts: {'facts.customers.registered_name': hostile}});
    const plan = planPostgresReviewCommit(before, f.snapshot());
    expect(plan).toMatchObject({executionAuthorized: false, postingEnabled: false, requiredIsolation: 'SERIALIZABLE'});
    expect(plan.statements.every(s => !s.text.includes(hostile))).toBe(true); expect(plan.statements.some(s => s.values.includes(hostile))).toBe(true);
    expect(plan.statements.some(s => s.text.includes('::jsonb'))).toBe(true); expect(plan.statements.some(s => s.text.includes('AND revision=$4'))).toBe(true);
    const schema = readFileSync('prisma/production-review/transport-import-v1.sql', 'utf8');
    const known = new Set([...schema.matchAll(/CREATE TABLE flsd_core_review\.([a-z_]+)/g)].map(m => m[1]));
    for (const s of plan.statements) {const match = /(?:INSERT INTO|UPDATE) flsd_core_review\.([a-z_]+)/.exec(s.text); expect(match && known.has(match[1])).toBe(true);}
    expect(schema).toContain("RAISE EXCEPTION 'REVIEW_ONLY:");
  });
  it('serializes exact Decimal amounts beyond floating-point precision and retains the zero-capable trip schema', async () => {
    const f = createSyntheticReviewRepository(actor);
    await seedSyntheticBusinessCounter(f.repository, {operationId: 'seed', expectedRevision: 0, kind: 'TRIP', reviewedNumbers: [], reviewRef: 'SYNTHETIC', scope: 'COMPLETE_SYNTHETIC_HISTORY'});
    const before = f.snapshot();
    await createSyntheticNumberedEntity(f.repository, {operationId: 'create', expectedRevision: 1, expectedCounterRevision: 0, kind: 'TRIP', typedFacts: {'facts.trip_charges.agreed_gross': '999999999999999999'}});
    const plan = planPostgresReviewCommit(before, f.snapshot());
    expect(plan.statements.flatMap(s => s.values)).toContain('9999999999999999.99');
    expect(readFileSync('prisma/production-review/transport-import-v1.sql', 'utf8')).toContain('agreed_gross NUMERIC(18,2) CHECK(agreed_gross>=0)');
  });
  it('rejects old-entity mutation instead of generating an overwrite plan', async () => {
    const f = createSyntheticReviewRepository(actor);
    await seedSyntheticBusinessCounter(f.repository, {operationId: 'seed', expectedRevision: 0, kind: 'COMPANY', reviewedNumbers: [], reviewRef: 'SYNTHETIC', scope: 'COMPLETE_SYNTHETIC_HISTORY'});
    await createSyntheticNumberedEntity(f.repository, {operationId: 'one', expectedRevision: 1, expectedCounterRevision: 0, kind: 'COMPANY', typedFacts: {}});
    const before = f.snapshot();
    await createSyntheticNumberedEntity(f.repository, {operationId: 'two', expectedRevision: 2, expectedCounterRevision: 1, kind: 'COMPANY', typedFacts: {}});
    const after = f.snapshot(); after.entities[0].typedFacts['facts.customers.registered_name'] = 'overwrite';
    expect(() => planPostgresReviewCommit(before, after)).toThrow('Immutable production history');
  });
});
