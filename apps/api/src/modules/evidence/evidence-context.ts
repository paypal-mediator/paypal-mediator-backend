import type { TransactionResponse } from '@resolve-ai/contracts';

// M03 supplies its authoritative context. M04 never reads or writes M03 tables.
export interface EvidenceContext {
  merchantId: string;
  transactionId: string;
  paypalCaptureId: string;
  paypalOrderId: string | null;
  merchantOrderReference: string | null;
  currencyCode: string;
  amount: string;
  capturedAt: string;
  sourceEventId: string;
  order: TransactionResponse['order'];
  orders?: Array<NonNullable<TransactionResponse['order']>>;
  orderRecordComplete?: boolean;
  orderRecordedBy: string | null;
  orderLinkError: string | null;
}

export function paymentRecord(context: EvidenceContext) {
  return {
    paypalCaptureId: context.paypalCaptureId,
    paypalOrderId: context.paypalOrderId,
    amount: context.amount,
    currencyCode: context.currencyCode,
    capturedAt: context.capturedAt,
    sourceEventId: context.sourceEventId,
  };
}
