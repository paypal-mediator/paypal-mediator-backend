import type { OrderSourceResult } from '@resolve-ai/contracts';
import type { Transaction } from '../../../generated/prisma/client.js';

export const ORDER_INFORMATION_SOURCES = Symbol('ORDER_INFORMATION_SOURCES');
// Server-only adapters: neither credentials nor arbitrary endpoint URLs are public input.
export interface OrderInformationSource {
  readonly providerId: string;
  readonly sourceKind: 'PAYPAL' | 'CONNECTED_SYSTEM';
  readonly sourceSystem: string;
  supports(transaction: Transaction): boolean;
  fetch(
    transaction: Transaction,
  ): Promise<{ original: Record<string, unknown>; result: OrderSourceResult }>;
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
