// Explicit MOCK Orders v2 response; never presented as an external verification.
export function mockPayPalOrder(
  orderId = 'MOCKORDER',
  captureId = 'MOCKCAPTURE',
) {
  const money = (value: string) => ({ currency_code: 'USD', value });
  return {
    id: orderId,
    create_time: '2026-11-05T00:00:00Z',
    purchase_units: [
      {
        reference_id: 'MOCKUNIT',
        custom_id: 'MOCKREFERENCE',
        invoice_id: 'MOCKINVOICE',
        amount: {
          ...money('1.00'),
          breakdown: {
            item_total: money('0.80'),
            shipping: money('0.10'),
            tax_total: money('0.10'),
            handling: money('0.00'),
            insurance: money('0.00'),
            shipping_discount: money('0.00'),
            discount: money('0.00'),
          },
        },
        items: [
          {
            name: 'MOCK item A',
            sku: 'MOCKA',
            quantity: '2',
            unit_amount: money('0.30'),
          },
          {
            name: 'MOCK item B',
            sku: 'MOCKB',
            quantity: '1',
            unit_amount: money('0.20'),
          },
        ],
        payments: {
          captures: [
            {
              id: captureId,
              status: 'COMPLETED',
              amount: money('1.00'),
              final_capture: true,
            },
          ],
        },
      },
    ],
  };
}
