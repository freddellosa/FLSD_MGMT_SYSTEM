import {describe, expect, it} from 'vitest';
import {proposeBusinessNumber, seedBusinessNumberCounter, type BusinessNumberKind} from './business-numbering';
describe('business number counter preparation', () => {
  it('starts after the highest complete imported range without renumbering existing records', () => {
    const values = ['77740', '78390', '00125'], before = [...values];
    const counter = seedBusinessNumberCounter('TRIP', values), result = proposeBusinessNumber(counter, 0);
    expect(result).toMatchObject({businessNumber: '78391', nextCounter: {next: 78392n, revision: 1}, executionAuthorized: false});
    expect(values).toEqual(before); expect(counter).toMatchObject({next: 78391n, revision: 0});
  });
  it('keeps independent business series and rejects stale revisions after a transition', () => {
    const trip = seedBusinessNumberCounter('TRIP', ['100']), driver = seedBusinessNumberCounter('DRIVER', ['5']);
    expect(proposeBusinessNumber(driver, 0).businessNumber).toBe('6');
    const first = proposeBusinessNumber(trip, 0);
    expect(() => proposeBusinessNumber(first.nextCounter, 0)).toThrow('revision');
    expect(proposeBusinessNumber(first.nextCounter, 1).businessNumber).toBe('102');
  });
  it('preserves precision beyond JavaScript safe integers', () => {
    const counter = seedBusinessNumberCounter('SOA', ['9007199254740993']);
    expect(proposeBusinessNumber(counter, 0).businessNumber).toBe('9007199254740994');
  });
  it.each([['1', '1'], ['ABC-1'], ['1.5'], [' 1'], ['0'], ['9223372036854775808']].map(values => ({values})))('requires explicit review for invalid or duplicate seed $values', ({values}) => {
    expect(() => seedBusinessNumberCounter('VEHICLE', values)).toThrow();
  });
  it('never substitutes generic numbering for invoice stock', () => {
    expect(() => seedBusinessNumberCounter('INVOICE' as BusinessNumberKind, ['49523'])).toThrow('invoice stock');
  });
  it('rejects an invalid seed-list shape rather than iterating characters as source numbers', () => {
    expect(() => seedBusinessNumberCounter('TRIP', '123' as unknown as string[])).toThrow('list');
  });
  it('stops at exhaustion without wrapping or reusing a number', () => {
    const counter = seedBusinessNumberCounter('COMPANY', ['9223372036854775806']);
    const last = proposeBusinessNumber(counter, 0);
    expect(last.businessNumber).toBe('9223372036854775807'); expect(last.nextCounter.next).toBeNull();
    expect(() => proposeBusinessNumber(last.nextCounter, 1)).toThrow('exhausted');
    expect(seedBusinessNumberCounter('COMPANY', ['9223372036854775807']).next).toBeNull();
  });
});
