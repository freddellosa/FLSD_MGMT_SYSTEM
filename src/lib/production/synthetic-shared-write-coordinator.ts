import {applyLockedBatch7Allocation} from './locked-batch7-allocation';
import {buildSharedDependencyDiscovery} from './shared-transaction-evidence';
import {buildSharedTransactionLockPlan,type SharedTransactionLock} from './shared-transaction-lock-plan';

type AllocationInput = Parameters<typeof applyLockedBatch7Allocation>[0];
type Command = AllocationInput['command'];
type Discovery = Pick<AllocationInput,'evidence'|'payment'|'invoices'|'receivables'>;

export interface SyntheticSharedWriteTransaction {
  discover(command: Command): Promise<Discovery>;
  /** Resolves only after the requested lock has been acquired. */
  acquire(lock: SharedTransactionLock): Promise<void>;
  effects: AllocationInput['effects'];
}

type Result = Awaited<ReturnType<typeof applyLockedBatch7Allocation>>;
/** The binding must verify the disposable target, start a Serializable transaction and await commit. */
export type WithSyntheticSharedWriteTransaction = (
  work: (transaction: SyntheticSharedWriteTransaction) => Promise<Result>,
) => Promise<Result>;

export async function runSyntheticSharedWrite(
  withTransaction: WithSyntheticSharedWriteTransaction,
  input: Command,
): Promise<Result> {
  const command = structuredClone(input);
  if (command.allocations.length !== 1) throw new Error('Synthetic rehearsal requires one invoice');
  return withTransaction(async transaction => {
    const initial = await transaction.discover(command);
    if (initial.evidence.authority !== 'flsd-synthetic-shared-write' ||
        initial.evidence.operationKey !== command.idempotencyKey) {
      throw new Error('Synthetic rehearsal scope mismatch');
    }
    const plan = buildSharedTransactionLockPlan(buildSharedDependencyDiscovery(initial.evidence));
    const acquired: SharedTransactionLock[] = [];
    for (const lock of plan.locks) {
      await transaction.acquire(lock);
      acquired.push(lock);
    }
    const observed = await transaction.discover(command);
    return applyLockedBatch7Allocation({...observed,command,plan,acquired,effects:transaction.effects});
  });
}
