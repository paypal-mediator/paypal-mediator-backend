import { z } from 'zod';

export interface OdooPaymentReference {
  merchantId: string;
  paypalCaptureId: string;
  paypalOrderId: string | null;
  merchantOrderReference: string | null;
  invoiceId: string | null;
  currencyCode: string;
  amount: string;
}
export interface OdooRecordSnapshot {
  id: string;
  connectionId: string;
  recordType: string;
  externalId: string;
  sourceHash: string;
  normalizedPayload: Record<string, unknown>;
}
const ref = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
export const odooReference = ref;
const ids = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((id) => Number.isSafeInteger(id) && Number(id) > 0)
        .map(String)
    : [];

export function odooDirectMatch(
  record: OdooRecordSnapshot,
  context: OdooPaymentReference,
) {
  const p = record.normalizedPayload;
  const same = (value: unknown, expected: string | null) =>
    expected !== null && ref(value) === expected;
  const explicit =
    same(p.paypalCaptureId, context.paypalCaptureId) ||
    same(p.paypalOrderId, context.paypalOrderId);
  if (explicit) return true;
  if (record.recordType === 'sales_order')
    return (
      same(p.orderNumber, context.merchantOrderReference) ||
      same(p.clientOrderReference, context.merchantOrderReference) ||
      same(p.clientOrderReference, context.paypalOrderId) ||
      same(p.clientOrderReference, context.paypalCaptureId)
    );
  if (record.recordType === 'invoice')
    return (
      same(p.invoiceNumber, context.invoiceId) ||
      same(p.paymentReference, context.paypalCaptureId) ||
      same(p.paymentReference, context.paypalOrderId) ||
      same(p.paymentReference, context.merchantOrderReference)
    );
  if (record.recordType === 'payment')
    return [
      context.paypalCaptureId,
      context.paypalOrderId,
      context.merchantOrderReference,
      context.invoiceId,
    ].some((r) => same(p.reference, r));
  return same(p.originOrder, context.merchantOrderReference);
}

export function odooRecordsRelated(
  a: OdooRecordSnapshot,
  b: OdooRecordSnapshot,
) {
  if (a.connectionId !== b.connectionId || a.id === b.id) return false;
  const x = a.normalizedPayload,
    y = b.normalizedPayload;
  if (x.companyId && y.companyId && x.companyId !== y.companyId) return false;
  const same = (one: unknown, two: unknown) =>
    ref(one) !== null && ref(one) === ref(two);
  const order =
    a.recordType === 'sales_order'
      ? a
      : b.recordType === 'sales_order'
        ? b
        : null;
  const other = order === a ? b : a;
  if (order) {
    const p = order.normalizedPayload,
      q = other.normalizedPayload;
    if (other.recordType === 'invoice')
      return (
        ids(p.invoiceIds).includes(other.externalId) ||
        same(p.orderNumber, q.invoiceOrigin)
      );
    if (other.recordType === 'shipment')
      return (
        same(p.orderNumber, q.originOrder) ||
        String(q.saleOrderId ?? '') === order.externalId
      );
    if (other.recordType === 'payment') return same(p.orderNumber, q.reference);
  }
  if (a.recordType === 'invoice' && b.recordType === 'payment')
    return same(x.invoiceNumber, y.reference);
  if (b.recordType === 'invoice' && a.recordType === 'payment')
    return same(y.invoiceNumber, x.reference);
  return false;
}

export function selectOdooRecords(
  records: OdooRecordSnapshot[],
  context: OdooPaymentReference,
) {
  const direct = records.filter((r) => odooDirectMatch(r, context));
  const selected = new Map(direct.map((r) => [r.id, r]));
  for (let iteration = 0; iteration < 4; iteration++) {
    const before = selected.size;
    for (const record of records)
      if ([...selected.values()].some((r) => odooRecordsRelated(r, record)))
        selected.set(record.id, record);
    if (before === selected.size) break;
  }
  const chosen = [...selected.values()];
  const issues: string[] = [];
  if (new Set(chosen.map((r) => r.connectionId)).size > 1)
    issues.push('ODOO_AMBIGUOUS_CONNECTION');
  if (chosen.filter((r) => r.recordType === 'sales_order').length > 1)
    issues.push('ODOO_AMBIGUOUS_ORDER');
  if (
    new Set(chosen.map((r) => r.normalizedPayload.companyId).filter(Boolean))
      .size > 1
  )
    issues.push('ODOO_COMPANY_CONFLICT');
  // Amount/name/email similarity is never an association rule.
  return {
    records: chosen,
    directIds: new Set(direct.map((r) => r.id)),
    issues,
  };
}

export const OdooSnapshotSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  recordType: z.string(),
  externalId: z.string(),
  sourceHash: z.string(),
  normalizedPayload: z.record(z.string(), z.unknown()),
});
