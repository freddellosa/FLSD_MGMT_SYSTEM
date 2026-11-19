/** Central policy; route handlers must enforce this before calling database services. */
export const roles = ['OWNER','ADMIN','BILLING','OPERATIONS','VIEWER'] as const;
export type Role = typeof roles[number];
export type Permission = 'master:read'|'master:write'|'customer:write'|'customer:vat'|'trip:read'|'trip:write'|'soa:read'|'soa:write'|'invoice:read'|'invoice:write'|'invoice:print'|'payment:read'|'payment:write'|'report:read'|'user:manage'|'audit:read';
const policies: Record<Role, readonly Permission[]> = {
  OWNER: ['master:read','master:write','customer:write','customer:vat','trip:read','trip:write','soa:read','soa:write','invoice:read','invoice:write','invoice:print','payment:read','payment:write','report:read','user:manage','audit:read'],
  ADMIN: ['master:read','master:write','customer:write','customer:vat','trip:read','trip:write','soa:read','soa:write','invoice:read','invoice:write','invoice:print','payment:read','payment:write','report:read','user:manage','audit:read'],
  BILLING: ['master:read','customer:write','trip:read','trip:write','soa:read','soa:write','invoice:read','invoice:write','invoice:print','payment:read','payment:write','report:read'],
  OPERATIONS: ['master:read','master:write','customer:write','trip:read','trip:write','soa:read'],
  VIEWER: ['master:read','trip:read','soa:read','invoice:read','payment:read','report:read']
};
export function can(role: Role, permission: Permission): boolean { return policies[role].includes(permission); }
export function canManageUserRole(actor: Role, current: Role | undefined, requested: Role): boolean {
  return can(actor,'user:manage') && (actor==='OWNER' || (current!=='OWNER' && requested!=='OWNER'));
}
export function requirePermission(role: Role | null | undefined, permission: Permission): void {
  if (!role || !can(role,permission)) throw new Error('Forbidden');
}
