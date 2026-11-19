
import { describe, expect, it, vi } from 'vitest';
import { createPrismaAllocationStore } from './prisma-allocation-store';
import type { PrismaClient } from '../../../generated/batch7-client';

type MockError = Error & {
  code: string;
  meta?: { target: string[] };
};

function prismaError(code: string, target?: string[]): MockError {
  const error = new Error('Simulated Prisma failure') as MockError;
  error.code = code;
  if (target) error.meta = { target };
  return error;
}

function mockPrisma(failures: MockError[]) {
  let attempts = 0;

  const transaction = vi.fn(async (callback: (db: unknown) => Promise<unknown>) => {
    attempts++;

    if (attempts <= failures.length) {
      throw failures[attempts - 1];
    }

    return callback({});
  });

  return {
    prisma: { $transaction: transaction } as unknown as PrismaClient,
    transaction,
    getAttempts: () => attempts,
  };
}

describe('Batch 7 Prisma transaction retries', () => {
  it('retries an idempotency-key conflict', async () => {
    const mock = mockPrisma([
      prismaError('P2002', ['idempotencyKey']),
    ]);

    const store = createPrismaAllocationStore(mock.prisma, {
      enablePosting: true,
    });

    const result = await store.serializable(async () => 'success');

    expect(result).toBe('success');
    expect(mock.getAttempts()).toBe(2);
  });

  it('does not retry unrelated unique conflicts', async () => {
    const mock = mockPrisma([
      prismaError('P2002', ['storageKey']),
    ]);

    const store = createPrismaAllocationStore(mock.prisma, {
      enablePosting: true,
    });

    await expect(
      store.serializable(async () => 'success'),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(mock.getAttempts()).toBe(1);
  });

  it('retries serialization conflicts', async () => {
    const mock = mockPrisma([
      prismaError('P2034'),
    ]);

    const store = createPrismaAllocationStore(mock.prisma, {
      enablePosting: true,
    });

    const result = await store.serializable(async () => 'success');

    expect(result).toBe('success');
    expect(mock.getAttempts()).toBe(2);
  });

  it('stops after three failed attempts', async () => {
    const mock = mockPrisma([
      prismaError('P2034'),
      prismaError('P2034'),
      prismaError('P2034'),
    ]);

    const store = createPrismaAllocationStore(mock.prisma, {
      enablePosting: true,
    });

    await expect(
      store.serializable(async () => 'success'),
    ).rejects.toMatchObject({ code: 'P2034' });

    expect(mock.getAttempts()).toBe(3);
  });

  it('refuses to construct a posting store when disabled', () => {
    const mock = mockPrisma([]);

    expect(() =>
      createPrismaAllocationStore(mock.prisma, {
        enablePosting: false,
      }),
    ).toThrow(/Financial posting disabled/);

    expect(mock.getAttempts()).toBe(0);
  });


  it('includes VAT when calculating outstanding invoice balance', async () => {
    const invoiceId = '11111111-1111-4111-8111-111111111111';

    const db = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: invoiceId }]),
      officialInvoice: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: invoiceId,
            customerId: 'customer-1',
            grossAmount: '1000.00',
            vatAmount: '120.00',
            withholdingAmount: '0.00',
            state: 'PRINTED',
            payments: [
              { amount: '200.00', withheldTax: '0.00' },
            ],
          },
        ]),
      },
    };

    const prisma = {
      $transaction: vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) =>
        callback(db)),
    } as unknown as PrismaClient;

    const store = createPrismaAllocationStore(prisma, {
      enablePosting: true,
    });

    const outstanding = await store.serializable(async tx => {
      const invoices = await tx.lockInvoices([invoiceId]);
      return invoices[0].outstandingCentavos;
    });

    expect(outstanding).toBe(92000n);
  });

});
