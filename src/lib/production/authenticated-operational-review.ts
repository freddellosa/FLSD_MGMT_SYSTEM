import {
  assertOperationalReviewPermission,
  reviewOperationalReplay,
  validateOperationalReviewEnvelope,
  type ExpectedOperationalVersion,
  type OperationalReviewEnvelope,
  type OperationalReviewActor,
  type OperationalReviewReceipt,
} from './operational-envelope';

type OperationalTarget = Pick<ExpectedOperationalVersion, 'kind' | 'id'>;

export interface OperationalReviewReader {
  /** Verify the request's session and read the current actor from this snapshot. */
  resolveCurrentActor(request: Request): Promise<OperationalReviewActor | null>;
  /** Resolve resource scope from server records, including dependencies absent from the envelope. */
  allowsCommand(actor: OperationalReviewActor, envelope: OperationalReviewEnvelope): Promise<boolean>;
  findReceipt(authority: string, operationId: string): Promise<OperationalReviewReceipt | null>;
  /** A previously committed result can now belong to a different resource scope. */
  allowsReceiptResult(
    actor: OperationalReviewActor,
    commandType: OperationalReviewReceipt['commandType'],
    result: OperationalReviewReceipt['result'],
  ): Promise<boolean>;
  readTargetVersions(authority: string, targets: readonly OperationalTarget[]): Promise<readonly ExpectedOperationalVersion[]>;
}

export interface OperationalReviewProvider {
  /** Keep session, scope, receipt, and version reads in one consistent read-only snapshot. */
  readSnapshot<T>(review: (reader: OperationalReviewReader) => Promise<T>): Promise<T>;
}

/** Server-side review only. The supplied provider owns session verification and persistence reads. */
export function reviewAuthenticatedOperationalCommand(
  provider: OperationalReviewProvider,
  request: Request,
  input: unknown,
) {
  const envelope = validateOperationalReviewEnvelope(input);
  return provider.readSnapshot(async reader => {
    const actor = await reader.resolveCurrentActor(request);
    assertOperationalReviewPermission(actor, envelope.action);
    if (await reader.allowsCommand(actor, envelope) !== true) throw new Error('Forbidden');

    const receipt = await reader.findReceipt(actor.authority, envelope.operationId);
    const versions = receipt === null && envelope.expectedVersions.length > 0
      ? await reader.readTargetVersions(actor.authority, envelope.expectedVersions.map(({kind, id}) => ({kind, id})))
      : [];
    const review = reviewOperationalReplay(envelope, actor, receipt, versions);
    if (receipt !== null && review.status === 'REPLAY_REVIEW_ONLY' &&
        await reader.allowsReceiptResult(actor, receipt.commandType, review.result) !== true) {
      throw new Error('Forbidden');
    }
    return review;
  });
}
