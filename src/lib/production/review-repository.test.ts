import {describe, expect, it} from 'vitest';
import {createSyntheticReviewRepository} from './review-repository';
function mutate() {
  return createSyntheticReviewRepository({id: 'verified-test-actor', role: 'ADMIN'});
}
describe('disconnected production repository reference', () => {
  it('rolls back state if a transaction fails and exposes no live adapter', async () => {
    const f = mutate();
    await expect(f.repository.serializable(async tx => {tx.state.entities.push({id: 'new', kind: 'company_tbl', version: '1', businessNumber: null, typedFacts: {}, foreignKeys: {}, reviewSlots: [], visibility: 'REVIEW_HOLD'}); throw new Error('failure');})).rejects.toThrow('failure');
    expect(f.snapshot().entities).toEqual([]); expect(f.repository.environment).toBe('DISCONNECTED_SYNTHETIC');
  });
  it('rejects a changed transaction without an atomic immutable receipt and audit', async () => {
    const f = mutate();
    await expect(f.repository.serializable(async tx => {tx.state.entities.push({id: 'new', kind: 'company_tbl', version: '1', businessNumber: null, typedFacts: {}, foreignKeys: {}, reviewSlots: [], visibility: 'REVIEW_HOLD'}); tx.state.history.push(structuredClone(tx.state.entities[0]));})).rejects.toThrow('receipt required');
    expect(f.snapshot().revision).toBe(0);
  });
  it('rejects caller revision mutation and missing typed FK targets', async () => {
    const f = mutate(); await expect(f.repository.serializable(async tx => {tx.state.revision++;})).rejects.toThrow('server-controlled');
    await expect(f.repository.serializable(async tx => {tx.state.entities.push({id: 'trip', kind: 'Trips_Tbl', version: '1', businessNumber: null, typedFacts: {}, foreignKeys: {CompanyID: 'missing'}, reviewSlots: [], visibility: 'REVIEW_HOLD'});})).rejects.toThrow('foreign key');
  });
});
