import { z } from 'zod';
import {
  OrderSourceResultSchema,
  type OrderSourceResult,
} from '@resolve-ai/contracts';
import { Prisma, type Transaction } from '../../../generated/prisma/client.js';
const Money = Prisma.Decimal.clone({ precision: 64 });

const money = z.object({
  currency_code: z.string().regex(/^[A-Z]{3}$/),
  value: z.string().regex(/^\d+(?:\.\d{1,2})?$/),
});
const reference = z.string().min(1).max(255);
const amount = money.extend({
  breakdown: z.record(z.string(), money).optional(),
});
const unit = z.object({
  reference_id: reference.optional(),
  custom_id: reference.optional(),
  invoice_id: reference.optional(),
  amount: amount.optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(500).optional(),
        sku: reference.optional(),
        quantity: z.string().regex(/^\d+$/).optional(),
        unit_amount: money.optional(),
      }),
    )
    .max(100)
    .optional(),
  payments: z
    .object({
      captures: z
        .array(
          z.object({
            id: reference,
            status: z.string().optional(),
            amount: money.optional(),
            final_capture: z.boolean().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});
const payload = z.object({
  id: reference,
  create_time: z.iso.datetime().optional(),
  purchase_units: z.array(unit).max(100).optional(),
});

export function normalizePayPalOrder(
  original: unknown,
  capture: Transaction,
): OrderSourceResult {
  const parsed = payload.safeParse(original);
  if (!parsed.success)
    return {
      order: null,
      association: 'UNRESOLVED',
      missingFields: [],
      issues: ['INVALID_PAYPAL_ORDER_RESPONSE'],
    };
  const data = parsed.data;
  const issues: string[] = [];
  const missingFields: string[] = [];
  if (data.id !== capture.paypalOrderId)
    issues.push('PAYPAL_ORDER_ID_MISMATCH');
  const units = (data.purchase_units ?? []).filter((u) =>
    u.payments?.captures?.some((c) => c.id === capture.paypalCaptureId),
  );
  if (units.length !== 1)
    return {
      order: null,
      association: units.length ? 'CONFLICT' : 'UNRESOLVED',
      missingFields: ['captureAssociation'],
      issues: [
        ...issues,
        units.length ? 'AMBIGUOUS_CAPTURE_ASSOCIATION' : 'CAPTURE_NOT_IN_ORDER',
      ],
    };
  const selected = units[0]!;
  const captures = selected.payments!.captures!;
  const matched = captures.find((c) => c.id === capture.paypalCaptureId)!;
  if (captures.length !== 1 || matched.final_capture === false)
    issues.push('UNSUPPORTED_MULTIPLE_OR_PARTIAL_CAPTURES');
  if (matched.status !== 'COMPLETED') issues.push('CAPTURE_STATUS_MISMATCH');
  for (const [name, value] of [
    ['capture', matched.amount],
    ['purchaseUnit', selected.amount],
  ] as const) {
    if (!value) missingFields.push(`${name}.amount`);
    else {
      if (value.currency_code !== capture.currencyCode)
        issues.push('ORDER_CURRENCY_MISMATCH');
      if (!new Prisma.Decimal(value.value).equals(capture.amount))
        issues.push('ORDER_AMOUNT_MISMATCH');
    }
  }
  if (
    capture.merchantOrderReference &&
    selected.custom_id &&
    capture.merchantOrderReference !== selected.custom_id
  )
    issues.push('ORDER_REFERENCE_CONFLICT');
  if (
    capture.invoiceId &&
    selected.invoice_id &&
    capture.invoiceId !== selected.invoice_id
  )
    issues.push('ORDER_INVOICE_CONFLICT');
  if (
    data.create_time &&
    Date.parse(data.create_time) > capture.capturedAt.getTime()
  )
    issues.push('ORDER_AFTER_PAYMENT');
  const field = (key: string) => {
    const m = selected.amount?.breakdown?.[key];
    if (!m) missingFields.push(`breakdown.${key}`);
    else if (m.currency_code !== capture.currencyCode)
      issues.push('BREAKDOWN_CURRENCY_MISMATCH');
    return m ? { currencyCode: m.currency_code, value: m.value } : null;
  };
  const breakdown = {
    itemTotal: field('item_total'),
    shipping: field('shipping'),
    tax: field('tax_total'),
    handling: field('handling'),
    insurance: field('insurance'),
    shippingDiscount: field('shipping_discount'),
    discount: field('discount'),
  };
  const items = (selected.items ?? []).map((item, index) => {
    const n = item.quantity === undefined ? null : Number(item.quantity);
    const quantity = n !== null && Number.isSafeInteger(n) && n > 0 ? n : null;
    const result = {
      sku: item.sku ?? null,
      description: item.name ?? null,
      quantity,
      unitAmount: item.unit_amount?.value ?? null,
      currencyCode: item.unit_amount?.currency_code ?? null,
    };
    for (const [key, v] of Object.entries(result))
      if (v === null) missingFields.push(`items.${index}.${key}`);
    if (result.currencyCode && result.currencyCode !== capture.currencyCode)
      issues.push('ITEM_CURRENCY_MISMATCH');
    return result;
  });
  if (!items.length) missingFields.push('items');
  if (!selected.custom_id) missingFields.push('merchantOrderReference');
  if (!selected.invoice_id) missingFields.push('invoiceId');
  if (!selected.reference_id) missingFields.push('purchaseUnitReference');
  if (!data.create_time) missingFields.push('orderedAt');
  if (
    breakdown.itemTotal &&
    items.length &&
    items.every((i) => i.quantity !== null && i.unitAmount !== null)
  ) {
    const total = items.reduce(
      (v, i) => v.add(new Money(i.unitAmount!).mul(i.quantity!)),
      new Money(0),
    );
    if (!total.equals(breakdown.itemTotal.value))
      issues.push('ITEM_TOTAL_MISMATCH');
  }
  if (selected.amount && Object.values(breakdown).every((v) => v !== null)) {
    const total = new Money(breakdown.itemTotal!.value)
      .add(breakdown.shipping!.value)
      .add(breakdown.tax!.value)
      .add(breakdown.handling!.value)
      .add(breakdown.insurance!.value)
      .sub(breakdown.shippingDiscount!.value)
      .sub(breakdown.discount!.value);
    if (!total.equals(selected.amount.value))
      issues.push('BREAKDOWN_TOTAL_MISMATCH');
  }
  return OrderSourceResultSchema.parse({
    association: issues.length ? 'CONFLICT' : 'MATCHED',
    missingFields: [...new Set(missingFields)],
    issues: [...new Set(issues)],
    order: {
      providerId: 'PAYPAL',
      sourceKind: 'PAYPAL',
      sourceSystem: 'paypal-sandbox:orders-v2',
      externalId: data.id,
      paypalOrderId: data.id,
      merchantOrderReference: selected.custom_id ?? null,
      invoiceId: selected.invoice_id ?? null,
      purchaseUnitReference: selected.reference_id ?? null,
      currencyCode: selected.amount?.currency_code ?? null,
      totalAmount: selected.amount?.value ?? null,
      shippingAmount: breakdown.shipping?.value ?? null,
      taxAmount: breakdown.tax?.value ?? null,
      discountAmount: breakdown.discount?.value ?? null,
      orderedAt: data.create_time ?? null,
      items,
      breakdown,
    },
  });
}
