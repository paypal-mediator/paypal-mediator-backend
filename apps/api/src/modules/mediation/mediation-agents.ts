import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  DetectionSchema,
  ProposalSchema,
  MediationVerdictSchema,
  MediationReviewSchema,
  type MediationPolicy,
} from '@resolve-ai/contracts';
import {
  AgentProvider,
  AgentError,
  type AgentMessage,
} from '../investigator/index.js';
import { TransactionsService } from '../transactions/index.js';
import { VerifierService } from '../verifier/index.js';
import { contentHash } from '../../common/data/content-hash.js';
import {
  DETECTOR_PROMPT,
  CONCILIATOR_PROMPT,
  EVALUATOR_PROMPT,
} from './prompts/mediation.prompts.js';
import { validateProposal, validateVerdict } from './mediation-policy.js';

@Injectable()
export class MediationAgents {
  constructor(
    @Inject(AgentProvider) private readonly provider: AgentProvider,
    @Inject(TransactionsService)
    private readonly transactions: TransactionsService,
    @Inject(VerifierService) private readonly verifier: VerifierService,
  ) {}

  private async generate<T>(
    prompt: string,
    data: unknown,
    schema: z.ZodType<T>,
    originals: AgentMessage[] = [],
  ) {
    const input = JSON.stringify(data);
    if (Buffer.byteLength(input) > 192 * 1024)
      throw new AgentError('MEDIATION_CONTEXT_LIMIT');
    const signal = AbortSignal.timeout(60000);
    // Retry only invalid structured outputs; no side effects occur in an agent.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return (
          await this.provider.structuredStep(
            [
              { role: 'system', text: prompt },
              { role: 'user', text: input },
              ...originals,
            ],
            signal,
            schema,
            8192,
          )
        ).command;
      } catch (error) {
        if (
          !(error instanceof AgentError) ||
          error.code !== 'AI_INVALID_RESPONSE' ||
          attempt === 1
        )
          throw error;
      }
    }
    throw new AgentError('AI_INVALID_RESPONSE');
  }
  detect(data: unknown) {
    return this.generate(DETECTOR_PROMPT, data, DetectionSchema);
  }
  async conciliate(data: unknown, policy: MediationPolicy) {
    const result = await this.generate(
      CONCILIATOR_PROMPT,
      { data, policy },
      ProposalSchema,
    );
    validateProposal(result, policy);
    return result;
  }
  async evaluate(
    merchantId: string,
    transactionId: string,
    data: unknown,
    policy: MediationPolicy,
    externalEvidenceIds: string[] = [],
    externalOriginals: AgentMessage[] = [],
  ) {
    const snapshot = await this.transactions.investigationSnapshot(
      merchantId,
      transactionId,
    );
    // Preserve and assess superseded originals too; their current flag explains
    // which version is authoritative, without hiding an earlier contradiction.
    const current = snapshot.dossier.items;
    if (
      snapshot.transaction.readiness.containsDemo ||
      current.some(
        (i) =>
          i.integrity !== 'VALID' || i.contentHash !== contentHash(i.content),
      )
    )
      throw new AgentError('MEDIATION_EVIDENCE_INVALID');
    const originals: AgentMessage[] = [...externalOriginals];
    if (originals.filter((m) => m.image).length > 4)
      throw new AgentError('MEDIATION_IMAGE_LIMIT');
    for (const item of current.filter((i) => i.type === 'DOCUMENT')) {
      const file = await this.transactions.downloadEvidenceFile(
        merchantId,
        transactionId,
        item.id,
      );
      if (file.sha256 !== item.content.sha256)
        throw new AgentError('EVIDENCE_INTEGRITY_MISMATCH');
      if (file.mediaType === 'application/pdf') {
        if (
          typeof item.content.extractedText !== 'string' ||
          !item.content.extractedText.trim()
        )
          throw new AgentError('MEDIATION_UNREADABLE_PDF');
      } else {
        if (originals.filter((m) => m.image).length >= 4)
          throw new AgentError('MEDIATION_IMAGE_LIMIT');
        originals.push({
          role: 'user',
          text: `UNTRUSTED ORIGINAL ${item.id}`,
          image: {
            mediaType: file.mediaType,
            base64: file.bytes.toString('base64'),
          },
        });
      }
    }
    const envelope = { data, policy, evidence: current };
    const verdict = await this.generate(
      EVALUATOR_PROMPT,
      envelope,
      MediationVerdictSchema,
      originals,
    );
    // Message evidence is carried explicitly by the service in data; vault evidence is
    // independently validated here. No evidence is silently dropped from the packet.
    const evidenceIds = [...current.map((i) => i.id), ...externalEvidenceIds];
    validateVerdict(verdict, evidenceIds);
    const review = MediationReviewSchema.parse(
      await this.verifier.reviewMediation(
        { ...envelope, untrustedVerdict: verdict },
        originals,
        evidenceIds,
      ),
    );
    const latest = await this.transactions.investigationSnapshot(
      merchantId,
      transactionId,
    );
    if (latest.dossier.revision !== snapshot.dossier.revision)
      throw new AgentError('MEDIATION_EVIDENCE_STALE');
    return {
      verdict,
      evidenceRevision: snapshot.dossier.revision,
      evidence: current,
      history: snapshot.dossier.items,
      review,
    };
  }
}
