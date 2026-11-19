const resourceOrder = [
  'CUSTOMER', 'VEHICLE', 'DRIVER', 'PAYMENT', 'TRIP', 'TRIP_RECEIVABLE',
  'SOA', 'INVOICE', 'REFUND', 'REMITTANCE', 'BUSINESS_COUNTER', 'INVOICE_STOCK',
] as const;

type ResourceKind = typeof resourceOrder[number];
export const isSharedTransactionResourceKind = (value: unknown): value is ResourceKind =>
  typeof value === 'string' && (resourceOrder as readonly string[]).includes(value);
export type SharedTransactionDiscovery = {
  authority: string;
  actorId: string;
  operationKey: string;
  /** Trusted discovery evidence, including revisions, relationship roles and confirmed absences. */
  dependencyDigest: string;
  resources: {CUSTOMER: readonly string[]} & Partial<Record<ResourceKind, readonly string[]>>;
};

export type SharedTransactionLock = Readonly<{
  authority: string;
  id: string;
} & (
  {kind:'STAFF_AUTHORIZATION'; mode:'SHARE'} |
  {kind:'OPERATION'; mode:'EXCLUSIVE_KEY'} |
  {kind:ResourceKind; mode:'UPDATE'}
)>;
export type SharedTransactionLockPlan = Readonly<{
  dependencyDigest: string;
  locks: readonly SharedTransactionLock[];
}>;

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const digest = /^[a-f0-9]{64}$/;
const validIdentifier = (value: unknown): value is string => typeof value === 'string' && identifier.test(value);
const sameLocks = (planned: readonly SharedTransactionLock[], actual: readonly SharedTransactionLock[]) =>
  planned.length === actual.length && planned.every((lock,index) => {
    const seen = actual[index];
    return seen?.authority === lock.authority && seen.kind === lock.kind && seen.id === lock.id && seen.mode === lock.mode;
  });

/** Disconnected ordering only. The repository must prove discovery completeness and acquire actual locks. */
export function buildSharedTransactionLockPlan(discovery: SharedTransactionDiscovery): SharedTransactionLockPlan {
  const {authority,actorId,operationKey,dependencyDigest,resources} = discovery;
  if (!validIdentifier(authority) || !validIdentifier(actorId) || !validIdentifier(operationKey) ||
      typeof dependencyDigest !== 'string' || !digest.test(dependencyDigest)) {
    throw new Error('Invalid shared transaction identity');
  }
  if (!resources || Object.getPrototypeOf(resources) !== Object.prototype ||
      Reflect.ownKeys(resources).some(kind => !isSharedTransactionResourceKind(kind)) ||
      !Object.hasOwn(resources,'CUSTOMER') || !Array.isArray(resources.CUSTOMER) || !resources.CUSTOMER.length) {
    throw new Error('Shared transaction requires customer coordination and known resources');
  }

  const locks: SharedTransactionLock[] = [
    {authority,kind:'STAFF_AUTHORIZATION',id:actorId,mode:'SHARE'},
    {authority,kind:'OPERATION',id:operationKey,mode:'EXCLUSIVE_KEY'},
  ];
  for (const kind of resourceOrder) {
    if (!Object.hasOwn(resources,kind)) continue;
    const ids = resources[kind];
    if (!Array.isArray(ids) || !Array.from(ids).every(validIdentifier)) throw new Error('Invalid shared transaction resource IDs');
    // Canonical identifiers are ASCII, so default string order is bytewise and locale-independent.
    for (const id of [...new Set(ids)].sort()) locks.push({authority,kind,id,mode:'UPDATE'});
  }
  return Object.freeze({dependencyDigest,locks:Object.freeze(locks.map(lock => Object.freeze(lock)))});
}

export function assertSharedTransactionLockAcquisition(plan: SharedTransactionLockPlan, acquired: readonly SharedTransactionLock[]) {
  if (!sameLocks(plan.locks,acquired)) throw new Error('Shared transaction locks differ from acquisition plan');
}

/** Recompare trusted discovery after acquisition. Any difference requires a fresh transaction. */
export function assertSharedTransactionDiscoveryUnchanged(plan: SharedTransactionLockPlan, discovery: SharedTransactionDiscovery) {
  const current = buildSharedTransactionLockPlan(discovery);
  if (plan.dependencyDigest !== current.dependencyDigest || !sameLocks(plan.locks,current.locks)) {
    throw new Error('Shared transaction dependencies changed');
  }
}
