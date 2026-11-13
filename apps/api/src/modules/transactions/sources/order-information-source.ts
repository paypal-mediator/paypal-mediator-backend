import type { OrderSourceResult } from '@resolve-ai/contracts';
import type { Transaction, Prisma } from '../../../generated/prisma/client.js';
import type { UploadEvidenceFile } from '@resolve-ai/contracts';

export interface OrderSourceFetch {
  original: Record<string, unknown>;
  result: OrderSourceResult;
  files?: Array<Omit<UploadEvidenceFile, 'sourceKind'>>;
}

export const ORDER_INFORMATION_SOURCES = Symbol('ORDER_INFORMATION_SOURCES');
// Server-only adapters: neither credentials nor arbitrary endpoint URLs are public input.
export interface OrderInformationSource {
  readonly providerId: string;
  readonly sourceKind: 'PAYPAL' | 'CONNECTED_SYSTEM';
  readonly sourceSystem: string;
  readonly pollIntervalMs?: number;
  available?(
    merchantId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean>;
  commit?(
    transaction: Transaction,
    fetched: OrderSourceFetch,
    tx: Prisma.TransactionClient,
  ): Promise<void>;
  supports(transaction: Transaction): boolean;
  fetch(transaction: Transaction): Promise<OrderSourceFetch>;
}
export class OrderSourceError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable = false,
    public readonly httpStatus: number | null = null,
  ) {
    super(code);
  }
}
