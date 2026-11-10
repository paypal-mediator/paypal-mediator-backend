import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/database/prisma.service.js';

interface DashboardData {
  merchant: {
    id: string;
    displayName: string;
    role: string;
    policy: {
      allowInvestigations: boolean;
      allowSubmissions: boolean;
      requireMerchantApproval: boolean;
    };
    integration: {
      connectionStatus: string;
      disputesReadStatus: string;
      lastCheckedAt: Date | null;
    };
  } | null;

  transactions: {
    total: number;
    ready: number;
    incomplete: number;
    needsReview: number;
    recent: Array<{
      id: string;
      paypalCaptureId: string;
      paypalOrderId: string;
      merchantOrderReference: string | null;
      invoiceId: string | null;
      status: string;
      amount: { currencyCode: string; value: string };
      capturedAt: string;
      readiness: { status: 'READY' | 'INCOMPLETE' | 'NEEDS_REVIEW' };
      order: {
        externalId: string;
        items: Array<{ sku: string; quantity: number }>;
      } | null;
    }>;
    totalAmount: string;
  };

  disputes: {
    total: number;
    open: number;
    byStatus: Record<string, number>;
    byReason: Record<string, number>;
    recent: Array<{
      id: string;
      paypalDisputeId: string;
      paypalStatus: string;
      paypalStage: string;
      paypalReason: string;
      internalState: string;
      amount: { currencyCode: string; value: string } | null;
      disputedAt: string;
      deadlineAt: string | null;
      linkStatus: string;
    }>;
    totalAmount: string;
  };

  metrics: {
    totalEvents: number;
    eventsByType: Record<string, number>;
    eventsByOutcome: Record<string, number>;
    avgDurationMs: number;
    errorRate: number;
    topErrors: Array<{ code: string; count: number }>;
    eventsByTypeDetail: Record<string, number>;
    eventsByOutcomeDetail: Record<string, number>;
    avgDurationByType: Record<string, number>;
  };

  activity: {
    items: Array<{
      id: string;
      timestamp: string;
      eventType: string;
      actor: string;
      action: string;
      outcome: string;
      entityType: string;
      entityId: string;
      durationMs: number | null;
      errorCode: string | null;
    }>;
    total: number;
  };
}

interface QueryResult {
  jsonb_build_object: DashboardData;
}

@Injectable()
export class DashboardOptimizedService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboardData(merchantId: string): Promise<DashboardData> {
    const query = `
      WITH 
      merchant_info AS (
        SELECT 
          m.id,
          m.display_name,
          mm.role,
          m.allow_investigations,
          m.allow_submissions,
          m.require_merchant_approval,
          mi.connection_status,
          mi.disputes_read_status,
          mi.last_checked_at
        FROM "Merchant" m
        LEFT JOIN "MerchantMember" mm ON mm.merchant_id = m.id
        LEFT JOIN "MerchantIntegration" mi ON mi.merchant_id = m.id
        WHERE m.id = $1::uuid
        LIMIT 1
      ),
      txn_stats AS (
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE t.readiness_status = 'READY') as ready,
          COUNT(*) FILTER (WHERE t.readiness_status = 'INCOMPLETE') as incomplete,
          COUNT(*) FILTER (WHERE t.readiness_status = 'NEEDS_REVIEW') as needs_review,
          COALESCE(SUM(t.amount::numeric), 0) as total_amount
        FROM "Transaction" t
        WHERE t.merchant_id = $1::uuid
      ),
      recent_transactions AS (
        SELECT 
          t.id,
          t.paypal_capture_id,
          t.paypal_order_id,
          t.merchant_order_reference,
          t.invoice_id,
          t.status,
          t.currency_code,
          t.amount,
          t.captured_at,
          t.readiness_status,
          t.readiness_basis,
          t.readiness_reasons,
          mo.external_id,
          mo.items
        FROM "Transaction" t
        LEFT JOIN "MerchantOrder" mo ON mo.id = t.merchant_order_id AND mo.merchant_id = t.merchant_id
        WHERE t.merchant_id = $1::uuid
          AND t.created_at >= (NOW() - INTERVAL '30 days')
        ORDER BY t.captured_at DESC
        LIMIT 10
      ),
      dsp_stats AS (
        SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE d.internal_state NOT IN ('CLOSED', 'SUBMITTED')) as open,
          jsonb_object_agg(d.internal_state, cnt) as by_status,
          jsonb_object_agg(d.reason_category, cnt) as by_reason,
          COALESCE(SUM(d.amount::numeric), 0) as total_amount
        FROM (
          SELECT 
            d.internal_state,
            d.reason_category,
            d.amount,
            COUNT(*) as cnt
          FROM "Dispute" d
          WHERE d.merchant_id = $1::uuid
            AND d.created_at >= (NOW() - INTERVAL '30 days')
          GROUP BY d.internal_state, d.reason_category
        ) d
      ),
      recent_disputes AS (
        SELECT 
          d.id,
          d.paypal_dispute_id,
          d.paypal_status,
          d.paypal_stage,
          d.paypal_reason,
          d.reason_category,
          d.internal_state,
          d.currency_code,
          d.amount,
          d.disputed_at,
          d.deadline_at,
          d.link_status
        FROM "Dispute" d
        WHERE d.merchant_id = $1::uuid
          AND d.created_at >= (NOW() - INTERVAL '30 days')
        ORDER BY d.disputed_at DESC
        LIMIT 10
      ),
      metrics_agg AS (
        SELECT 
          COUNT(*) as total_events,
          jsonb_object_agg(event_type, cnt) as events_by_type,
          jsonb_object_agg(outcome, cnt_outcome) as events_by_outcome,
          AVG(duration_ms)::numeric as avg_duration_ms,
          (COUNT(*) FILTER (WHERE outcome = 'FAILURE') * 100.0 / NULLIF(COUNT(*), 0)) as error_rate,
          jsonb_agg(jsonb_build_object('code', error_code, 'count', cnt) ORDER BY cnt DESC) FILTER (WHERE error_code IS NOT NULL) as top_errors
        FROM (
          SELECT 
            ae.event_type,
            ae.outcome,
            ae.error_code,
            ae.duration_ms,
            COUNT(*) as cnt,
            COUNT(*) as cnt_outcome
          FROM "AuditEvent" ae
          WHERE ae.merchant_id = $1::uuid
            AND ae.created_at >= (NOW() - INTERVAL '24 hours')
          GROUP BY ae.event_type, ae.outcome, ae.error_code, ae.duration_ms
        ) m
      ),
      duration_by_type AS (
        SELECT 
          jsonb_object_agg(event_type, avg_dur) as avg_duration_by_type
        FROM (
          SELECT 
            event_type,
            AVG(duration_ms)::numeric as avg_dur
          FROM "AuditEvent"
          WHERE merchant_id = $1::uuid
            AND created_at >= (NOW() - INTERVAL '24 hours')
            AND duration_ms IS NOT NULL
          GROUP BY event_type
        ) d
      ),
      top_errors AS (
        SELECT 
          jsonb_agg(jsonb_build_object('code', error_code, 'count', cnt) ORDER BY cnt DESC) as top_errors
        FROM (
          SELECT error_code, COUNT(*) as cnt
          FROM "AuditEvent"
          WHERE merchant_id = $1::uuid
            AND created_at >= (NOW() - INTERVAL '24 hours')
            AND error_code IS NOT NULL
          GROUP BY error_code
          ORDER BY cnt DESC
          LIMIT 5
        ) e
      ),
      recent_activity AS (
        SELECT 
          ae.id,
          ae.created_at,
          ae.event_type,
          ae.actor,
          ae.action,
          ae.outcome,
          ae.entity_type,
          ae.entity_id,
          ae.duration_ms,
          ae.error_code
        FROM "AuditEvent" ae
        WHERE ae.merchant_id = $1::uuid
          AND ae.created_at >= (NOW() - INTERVAL '24 hours')
        ORDER BY ae.created_at DESC
        LIMIT 50
      )
      SELECT 
        jsonb_build_object(
          'merchant', jsonb_build_object(
            'id', mi.id,
            'displayName', mi.display_name,
            'role', mi.role,
            'policy', jsonb_build_object(
              'allowInvestigations', mi.allow_investigations,
              'allowSubmissions', mi.allow_submissions,
              'requireMerchantApproval', mi.require_merchant_approval
            ),
            'integration', jsonb_build_object(
              'connectionStatus', mi.connection_status,
              'disputesReadStatus', mi.disputes_read_status,
              'lastCheckedAt', mi.last_checked_at
            )
          ),
          'transactions', jsonb_build_object(
            'total', txs.total,
            'ready', txs.ready,
            'incomplete', txs.incomplete,
            'needsReview', txs.needs_review,
            'recent', rt.recent,
            'totalAmount', txs.total_amount
          ),
          'disputes', jsonb_build_object(
            'total', ds.total,
            'open', ds.open,
            'byStatus', ds.by_status,
            'byReason', ds.by_reason,
            'recent', rd.recent,
            'totalAmount', ds.total_amount
          ),
          'metrics', jsonb_build_object(
            'totalEvents', ma.total_events,
            'eventsByType', ma.events_by_type,
            'eventsByOutcome', ma.events_by_outcome,
            'avgDurationMs', ma.avg_duration_ms,
            'errorRate', ma.error_rate,
            'topErrors', te.top_errors,
            'eventsByTypeDetail', ma.events_by_type,
            'eventsByOutcomeDetail', ma.events_by_outcome,
            'avgDurationByType', dbt.avg_duration_by_type
          ),
          'activity', jsonb_build_object(
            'items', ra.activity,
            'total', ra.total
          )
        FROM merchant_info mi
        CROSS JOIN txn_stats txs
        CROSS JOIN dsp_stats ds
        CROSS JOIN metrics_agg ma
        CROSS JOIN duration_by_type dbt
        CROSS JOIN top_errors te
        CROSS JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
            'id', rt.id,
            'paypalCaptureId', rt.paypal_capture_id,
            'paypalOrderId', rt.paypal_order_id,
            'merchantOrderReference', rt.merchant_order_reference,
            'invoiceId', rt.invoice_id,
            'status', rt.status,
            'amount', jsonb_build_object('currencyCode', rt.currency_code, 'value', rt.amount::text),
            'capturedAt', rt.captured_at,
            'readiness', jsonb_build_object('status', rt.readiness_status),
            'order', CASE WHEN rt.external_id IS NOT NULL THEN jsonb_build_object('externalId', rt.external_id, 'items', rt.items) ELSE NULL END
          )) as recent
        FROM recent_transactions rt
        ) rt
        CROSS JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
            'id', rd.id,
            'paypalDisputeId', rd.paypal_dispute_id,
            'paypalStatus', rd.paypal_status,
            'paypalStage', rd.paypal_stage,
            'paypalReason', rd.paypal_reason,
            'internalState', rd.internal_state,
            'amount', CASE WHEN rd.currency_code IS NOT NULL AND rd.amount IS NOT NULL 
              THEN jsonb_build_object('currencyCode', rd.currency_code, 'value', rd.amount::text)
              ELSE NULL END,
            'disputedAt', rd.disputed_at,
            'deadlineAt', rd.deadline_at,
            'internalState', rd.internal_state,
            'linkStatus', rd.link_status
          )) as recent
        FROM recent_disputes rd
        ) rd
        CROSS JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
            'id', ra.id,
            'timestamp', ra.created_at,
            'eventType', ra.event_type,
            'actor', ra.actor,
            'action', ra.action,
            'outcome', ra.outcome,
            'entityType', ra.entity_type,
            'entityId', ra.entity_id,
            'durationMs', ra.duration_ms,
            'errorCode', ra.error_code
          )) as activity,
          COUNT(*) as total
        FROM recent_activity ra
        ) ra;
    `;

    const rows = await this.prisma.$queryRawUnsafe<QueryResult[]>(
      query,
      merchantId,
    );
    return rows[0]?.jsonb_build_object || this.getEmptyDashboard();
  }

  private getEmptyDashboard(): DashboardData {
    return {
      merchant: null,
      transactions: {
        total: 0,
        ready: 0,
        incomplete: 0,
        needsReview: 0,
        recent: [],
        totalAmount: '0',
      },
      disputes: {
        total: 0,
        open: 0,
        byStatus: {},
        byReason: {},
        recent: [],
        totalAmount: '0',
      },
      metrics: {
        totalEvents: 0,
        eventsByType: {},
        eventsByOutcome: {},
        avgDurationMs: 0,
        errorRate: 0,
        topErrors: [],
        eventsByTypeDetail: {},
        eventsByOutcomeDetail: {},
        avgDurationByType: {},
      },
      activity: { items: [], total: 0 },
    };
  }
}
