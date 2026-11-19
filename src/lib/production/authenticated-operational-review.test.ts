import {describe, expect, it, vi} from 'vitest';
import {
  reviewAuthenticatedOperationalCommand,
  type OperationalReviewReader,
} from './authenticated-operational-review';
import {
  reviewOperationalReplay,
  type ExpectedOperationalVersion,
  type OperationalReviewActor,
  type OperationalReviewReceipt,
} from './operational-envelope';

const operationId = '12345678-1234-4234-8234-123456789abc';
const actor: OperationalReviewActor = {authority:'office-a', id:'staff-1', role:'BILLING', active:true};
const current: ExpectedOperationalVersion[] = [{kind:'TRIP', id:'trip-1', version:'7'}];
const command = {schemaVersion:1, operationId, action:{type:'CREATE_SOA', tripIds:['trip-1']}, expectedVersions:current};
const request = new Request('http://localhost/commands', {headers:{'x-role':'OWNER', 'x-actor-id':'forged'}});
const receipt: OperationalReviewReceipt = {
  operationId, authority:actor.authority, actorId:actor.id, commandType:'CREATE_SOA',
  digest:reviewOperationalReplay(command, actor, null, current).digest,
  result:{entityId:'soa-1', version:'1'},
};

function setup() {
  const reader = {
    resolveCurrentActor: vi.fn<OperationalReviewReader['resolveCurrentActor']>().mockResolvedValue(actor),
    allowsCommand: vi.fn<OperationalReviewReader['allowsCommand']>().mockResolvedValue(true),
    findReceipt: vi.fn<OperationalReviewReader['findReceipt']>().mockResolvedValue(null),
    allowsReceiptResult: vi.fn<OperationalReviewReader['allowsReceiptResult']>().mockResolvedValue(true),
    readTargetVersions: vi.fn<OperationalReviewReader['readTargetVersions']>().mockResolvedValue(current),
  };
  const snapshotOpened = vi.fn();
  const readSnapshot = <T>(review:(source:OperationalReviewReader)=>Promise<T>) => {
    snapshotOpened();
    return review(reader);
  };
  return {reader, snapshotOpened, review:(input:unknown = command) => reviewAuthenticatedOperationalCommand({readSnapshot}, request, input)};
}

describe('Authenticated operational command review', () => {
  it('validates the envelope before opening a provider snapshot', () => {
    const {review, snapshotOpened} = setup();
    expect(() => review({...command, actorId:'forged'})).toThrow();
    expect(snapshotOpened).not.toHaveBeenCalled();
  });

  it.each([null, {...actor, active:false}, {...actor, role:'VIEWER' as const}])(
    'refuses an invalid or unauthorized current actor before business reads (%j)',
    async currentActor => {
      const {review, reader} = setup();
      reader.resolveCurrentActor.mockResolvedValue(currentActor);
      await expect(review()).rejects.toThrow('Forbidden');
      expect(reader.allowsCommand).not.toHaveBeenCalled();
      expect(reader.findReceipt).not.toHaveBeenCalled();
      expect(reader.readTargetVersions).not.toHaveBeenCalled();
    },
  );

  it('checks current command scope before looking up even a matching receipt', async () => {
    const {review, reader} = setup();
    reader.findReceipt.mockResolvedValue(receipt);
    reader.allowsCommand.mockResolvedValue(false);
    await expect(review()).rejects.toThrow('Forbidden');
    expect(reader.findReceipt).not.toHaveBeenCalled();
    expect(reader.allowsReceiptResult).not.toHaveBeenCalled();
    expect(reader.readTargetVersions).not.toHaveBeenCalled();
  });

  it('uses the provider actor and exact target selectors within a single snapshot', async () => {
    const {review, reader, snapshotOpened} = setup();
    await expect(review()).resolves.toMatchObject({status:'VALIDATED_REVIEW_ONLY', executionAuthorized:false, postingEnabled:false});
    expect(snapshotOpened).toHaveBeenCalledTimes(1);
    expect(reader.resolveCurrentActor).toHaveBeenCalledWith(request);
    expect(reader.allowsCommand).toHaveBeenCalledWith(actor, command);
    expect(reader.findReceipt).toHaveBeenCalledWith('office-a', operationId);
    expect(reader.readTargetVersions).toHaveBeenCalledWith('office-a', [{kind:'TRIP', id:'trip-1'}]);
    expect(reader.allowsCommand.mock.invocationCallOrder[0]).toBeLessThan(reader.findReceipt.mock.invocationCallOrder[0]);
  });

  it('returns an authorized replay without reading stale versions and denies it after revocation', async () => {
    const {review, reader} = setup();
    reader.findReceipt.mockResolvedValue(receipt);
    reader.readTargetVersions.mockResolvedValue([]);
    await expect(review()).resolves.toMatchObject({status:'REPLAY_REVIEW_ONLY', result:receipt.result, executionAuthorized:false, postingEnabled:false});
    expect(reader.readTargetVersions).not.toHaveBeenCalled();
    expect(reader.allowsReceiptResult).toHaveBeenCalledWith(actor, 'CREATE_SOA', receipt.result);
    reader.resolveCurrentActor.mockResolvedValue({...actor, active:false});
    await expect(review()).rejects.toThrow('Forbidden');
    expect(reader.findReceipt).toHaveBeenCalledTimes(1);
    expect(reader.allowsReceiptResult).toHaveBeenCalledTimes(1);
  });

  it('denies replay when the committed entity is no longer visible to the actor', async () => {
    const {review, reader} = setup();
    reader.findReceipt.mockResolvedValue(receipt);
    reader.allowsReceiptResult.mockResolvedValue(false);
    await expect(review()).rejects.toThrow('Forbidden');
    expect(reader.allowsReceiptResult).toHaveBeenCalledWith(actor, 'CREATE_SOA', receipt.result);
    expect(reader.readTargetVersions).not.toHaveBeenCalled();
  });

  it('rejects a receipt from another authority and stale versions for new commands', async () => {
    const {review, reader} = setup();
    reader.findReceipt.mockResolvedValueOnce({...receipt, authority:'office-b'});
    await expect(review()).rejects.toThrow('receipt conflict');
    expect(reader.allowsReceiptResult).not.toHaveBeenCalled();
    expect(reader.readTargetVersions).not.toHaveBeenCalled();
    reader.readTargetVersions.mockResolvedValue([]);
    await expect(review()).rejects.toThrow('Stale');
  });
});
