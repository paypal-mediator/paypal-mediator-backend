import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ShipmentObservationSchema,
  TrackingNumberSchema,
  type ShipmentObservation,
} from '@resolve-ai/contracts';
import { PayPalOrderSource } from '../transactions/index.js';
import type { Transaction } from '../../generated/prisma/client.js';
import {
  iso,
  normalizeStatus,
  TrackingProviderError,
} from './tracking-normalization.js';
import { OrderSourceError } from '../transactions/sources/order-information-source.js';

@Injectable()
export class PayPalTrackingSource {
  constructor(
    @Inject(PayPalOrderSource) private readonly paypal: PayPalOrderSource,
  ) {}
  async fetch(row: Transaction, trackingNumber?: string) {
    const results: Array<{
      observation: ShipmentObservation;
      original: Record<string, unknown>;
    }> = [];
    try {
      let numbers = trackingNumber ? [trackingNumber] : [];
      if (!numbers.length && row.paypalOrderId) {
        const { original } = await this.paypal.fetch(row);
        const order = z
          .object({
            id: z.string(),
            purchase_units: z
              .array(
                z.object({
                  payments: z
                    .object({
                      captures: z
                        .array(z.object({ id: z.string() }))
                        .optional(),
                    })
                    .optional(),
                  shipping: z
                    .object({
                      trackers: z
                        .array(
                          z.object({
                            id: z.string(),
                            tracking_number: z.string().optional(),
                          }),
                        )
                        .optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          })
          .parse(original);
        if (order.id !== row.paypalOrderId)
          throw new TrackingProviderError('PAYPAL_TRACKING_ORDER_MISMATCH');
        const units = (order.purchase_units ?? []).filter((u) =>
          u.payments?.captures?.some((c) => c.id === row.paypalCaptureId),
        );
        if (units.length > 1)
          throw new TrackingProviderError('PAYPAL_TRACKING_AMBIGUOUS_ORDER');
        numbers = [
          ...new Set(
            (units[0]?.shipping?.trackers ?? []).flatMap((t) => {
              const prefix = `${row.paypalCaptureId}-`;
              const value =
                t.tracking_number ??
                (t.id.startsWith(prefix) ? t.id.slice(prefix.length) : '');
              return TrackingNumberSchema.safeParse(value).success &&
                value !== 'NOTRACKER'
                ? [value]
                : [];
            }),
          ),
        ];
        if (numbers.length > 5)
          throw new TrackingProviderError('PAYPAL_TRACKING_TOO_MANY_SHIPMENTS');
      }
      for (const number of numbers) {
        const original = await this.paypal.getShipmentTracker(row, number);
        const item = z
          .object({
            transaction_id: z.string(),
            tracking_number: z.string(),
            status: z.string(),
            carrier: z.string().nullish(),
            carrier_name_other: z.string().nullish(),
            last_updated_time: z.string().nullish(),
            shipment_date: z.string().nullish(),
          })
          .parse(original);
        if (
          item.transaction_id !== row.paypalCaptureId ||
          item.tracking_number !== number
        )
          throw new TrackingProviderError('PAYPAL_TRACKING_IDENTITY_MISMATCH');
        const status = normalizeStatus(item.status);
        const updatedAt = iso(item.last_updated_time);
        const carrier = item.carrier_name_other ?? item.carrier ?? null;
        results.push({
          original,
          observation: ShipmentObservationSchema.parse({
            source: 'paypal',
            sourceSystem: 'paypal-sandbox:shipping-v1',
            trackingNumber: number,
            carrier,
            carrierCode: null,
            status,
            updatedAt,
            deliveredAt: null,
            deliveryReported: status === 'DELIVERED',
            documentaryProof: false,
            // This is a PayPal tracking-status update, not a carrier delivery scan or a POD.
            events: updatedAt
              ? [
                  {
                    occurredAt: updatedAt,
                    status,
                    carrier,
                    description: `PayPal tracking status: ${item.status}`,
                    location: null,
                  },
                ]
              : [],
            issues: [],
          }),
        });
      }
      return results;
    } catch (e) {
      if (e instanceof TrackingProviderError) throw e;
      if (e instanceof OrderSourceError) {
        if (e.httpStatus === 404) return results;
        throw new TrackingProviderError(
          e.code === 'NOT_CONFIGURED'
            ? 'PAYPAL_TRACKING_NOT_CONFIGURED'
            : 'PAYPAL_TRACKING_UNAVAILABLE',
          e.retryable,
          e.httpStatus,
        );
      }
      throw new TrackingProviderError('PAYPAL_TRACKING_INVALID_RESPONSE');
    }
  }
}
