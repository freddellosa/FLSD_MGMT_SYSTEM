import { describe, it, expect } from 'vitest';
import { can, requirePermission } from './permissions';
describe('role permission matrix', () => {
  it('prevents viewers from creating invoices or printing', () => {
    expect(can('VIEWER','invoice:write')).toBe(false);
    expect(can('VIEWER','invoice:print')).toBe(false);
    expect(() => requirePermission('VIEWER','invoice:print')).toThrow('Forbidden');
  });
  it('allows billing staff to print but not manage users', () => {
    expect(can('BILLING','invoice:print')).toBe(true);
    expect(can('BILLING','user:manage')).toBe(false);
  });
  it('denies missing sessions', () => expect(() => requirePermission(null,'trip:read')).toThrow('Forbidden'));
});
