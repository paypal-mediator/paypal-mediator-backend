import { Inject, Injectable } from '@nestjs/common';
import { AuditWriteSchema, type AuditWrite } from '@resolve-ai/contracts';
import { PrismaService } from '../../common/database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // Call inside the owning module's transaction: no best-effort writes.
  async append(input: AuditWrite, tx: Prisma.TransactionClient = this.prisma) {
    const value = AuditWriteSchema.parse(input);
    const action = value.record.action;
    const module = action.startsWith('INVESTIGATION_')
      ? 'M05'
      : action.startsWith('VERIFICATION_')
        ? 'M06'
        : action.startsWith('EVIDENCE_')
          ? 'M04'
          : action.startsWith('WEBHOOK_') || action.startsWith('INGESTION_')
            ? 'M02'
            : action.startsWith('ORDER_') || action.startsWith('TRANSACTION_')
              ? 'M03'
              : 'M01';
    return tx.auditEvent.create({ data: { ...value, module, action } });
  }

  async agentSteps(
    context: Pick<
      AuditWrite,
      'merchantId' | 'actorUserId' | 'transactionId' | 'resourceId'
    >,
    kind: 'INVESTIGATION' | 'VERIFICATION',
    trace: Array<{
      step: number;
      action: string;
      evidenceId: string | null;
      outcome: string;
      durationMs?: number;
      observedAt?: string;
    }>,
    tx: Prisma.TransactionClient,
  ) {
    for (const step of trace)
      await this.append(
        {
          ...context,
          actorKind: 'AGENT',
          resourceType: kind,
          outcome:
            step.outcome === 'UNSUPPORTED_PDF' ||
            step.outcome === 'IMAGE_BUDGET_EXCEEDED'
              ? 'BLOCKED'
              : 'SUCCEEDED',
          durationMs: step.durationMs ?? null,
          record: {
            action: `${kind}_STEP`,
            details: {
              step: step.step,
              tool: step.action as 'READ_EVIDENCE' | 'FINISH',
              toolResult: step.outcome as 'JSON_ORIGINAL',
              ...(step.evidenceId ? { evidenceId: step.evidenceId } : {}),
              ...(step.observedAt ? { observedAt: step.observedAt } : {}),
            },
          },
        },
        tx,
      );
  }
}
