import { describe, expect, it } from 'vitest';
import {
  MEDIATION_NOTICE,
  MediationStateSchema,
  MediationPolicySchema,
  DetectionSchema,
  MediationMessageInputSchema,
  MediationVerdictSchema,
  type MediationPolicy,
  type MediationVerdict,
  type MediationProposal,
} from '@resolve-ai/contracts';
import {
  assertTransition,
  mediationDeadlines,
  MEDIATION_TRANSITIONS,
  validateProposal,
  validateVerdict,
  assertSafeAgentText,
  DAY,
} from '../../src/modules/mediation/mediation-policy.js';
import { assertEvidenceFileSafety } from '../../src/modules/evidence/evidence-file-safety.js';
import { dossierPdf } from '../../src/modules/mediation/dossier-pdf.js';
import { PdfTextExtractor } from '../../src/modules/evidence/pdf-text-extractor.js';

export const policy: MediationPolicy = {
  enabled: true,
  conciliationDays: 3,
  claimHours: 24,
  evidenceHours: 24,
  deadlineMarginHours: 24,
  returns: 'Devoluciones hasta 30 días con evidencia.',
  warranty: 'Garantía por defectos de fabricación.',
  businessDeadlines: 'Envíos en cinco días.',
  allowedSolutions: ['REPLACEMENT', 'RESHIPMENT', 'FULL_REFUND_RECOMMENDATION'],
  automaticSubmission: true,
};
const verdict = (): MediationVerdict => ({
  recommendation: 'SELLER',
  evidenceBalance: 'EQUIVALENT',
  summary: 'Las pruebas son equivalentes.',
  grounds: [{ statement: 'La orden coincide.', evidenceIds: ['e1'] }],
  assessedEvidence: [{ evidenceId: 'e1', assessment: 'Orden original.' }],
  notice: MEDIATION_NOTICE,
  humanReview: false,
});
describe('mediation transitions, deadlines, typed outputs and integrity', () => {
  for (const from of MediationStateSchema.options)
    for (const to of MediationStateSchema.options)
      it(`${from} -> ${to}`, () => {
        if (MEDIATION_TRANSITIONS[from].includes(to))
          expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow();
      });
  it('caps conciliation and reserves claim, evidence and safety windows', () => {
    const start = new Date('2026-11-01T00:00:00Z'),
      now = new Date('2026-11-02T00:00:00Z');
    const dates = mediationDeadlines(
      { ...policy, conciliationDays: 20 },
      now,
      start,
      new Date('2026-11-08T00:00:00Z'),
    );
    expect(dates.conciliation.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(dates.claim.toISOString()).toBe('2026-11-06T00:00:00.000Z');
    expect(dates.paypal.toISOString()).toBe('2026-11-08T00:00:00.000Z');
    expect(
      mediationDeadlines(
        { ...policy, conciliationDays: 20 },
        now,
        start,
        null,
      ).paypal.getTime(),
    ).toBe(start.getTime() + 20 * DAY);
  });
  it('rejects insufficient time at the exact boundary', () => {
    const now = new Date('2026-11-01T00:00:00Z');
    expect(() =>
      mediationDeadlines(policy, now, now, new Date(now.getTime() + 3 * DAY)),
    ).toThrow();
    expect(() =>
      mediationDeadlines(
        policy,
        now,
        now,
        new Date(now.getTime() + 3 * DAY + 1),
      ),
    ).not.toThrow();
  });
  it('rejects invalid business configuration, amounts of confidence and injection fields', () => {
    expect(
      MediationPolicySchema.safeParse({ ...policy, conciliationDays: 21 })
        .success,
    ).toBe(false);
    expect(
      MediationPolicySchema.safeParse({ ...policy, allowedSolutions: [] })
        .success,
    ).toBe(false);
    expect(
      MediationMessageInputSchema.safeParse({
        text: 'hola',
        idempotencyKey: crypto.randomUUID(),
        role: 'BUYER',
      }).success,
    ).toBe(false);
    expect(
      DetectionSchema.safeParse({
        complaint: true,
        type: 'SHIPPING_ERROR',
        severity: 'LOW',
        summary: 'test',
        confidence: 1.1,
        humanReview: false,
      }).success,
    ).toBe(false);
  });
  it('requires transparency and citations', () => {
    expect(
      MediationVerdictSchema.safeParse({ ...verdict(), notice: 'neutral' })
        .success,
    ).toBe(false);
    expect(
      MediationVerdictSchema.safeParse({ ...verdict(), grounds: [] }).success,
    ).toBe(false);
    expect(() => validateVerdict(verdict(), ['e1'])).not.toThrow();
    expect(() => validateVerdict(verdict(), ['e2'])).toThrow();
    expect(() => validateVerdict(verdict(), ['e1', 'e2'])).toThrow();
    expect(() =>
      validateVerdict(
        {
          ...verdict(),
          assessedEvidence: [
            ...verdict().assessedEvidence,
            ...verdict().assessedEvidence,
          ],
        },
        ['e1'],
      ),
    ).toThrow();
    expect(() =>
      validateVerdict(
        {
          ...verdict(),
          grounds: [{ statement: 'Inventada', evidenceIds: ['unknown'] }],
        },
        ['e1'],
      ),
    ).toThrow();
  });
  it('favors seller on equal evidence and buyer on clear buyer evidence', () => {
    expect(() =>
      validateVerdict({ ...verdict(), recommendation: 'BUYER' }, ['e1']),
    ).toThrow();
    expect(() =>
      validateVerdict(
        {
          ...verdict(),
          evidenceBalance: 'CLEAR_BUYER',
          recommendation: 'BUYER',
        },
        ['e1'],
      ),
    ).not.toThrow();
    expect(() =>
      validateVerdict({ ...verdict(), evidenceBalance: 'CLEAR_BUYER' }, ['e1']),
    ).toThrow();
  });
  it('enforces business options and sale preservation priority', () => {
    const proposal: MediationProposal = {
      summary: 'Opciones voluntarias',
      notice: MEDIATION_NOTICE,
      humanReview: false,
      options: [
        {
          solution: 'REPLACEMENT' as const,
          description: 'Se propone reposición.',
        },
      ],
    };
    expect(() => validateProposal(proposal, policy)).not.toThrow();
    expect(() =>
      validateProposal(
        {
          ...proposal,
          options: [{ solution: 'STORE_CREDIT', description: 'Crédito.' }],
        },
        policy,
      ),
    ).toThrow();
    expect(() =>
      validateProposal(
        {
          ...proposal,
          options: [
            {
              solution: 'FULL_REFUND_RECOMMENDATION',
              description: 'Recomendación.',
            },
            ...proposal.options,
          ],
        },
        policy,
      ),
    ).toThrow();
  });
  it.each([
    'We will refund the order',
    'refund executed',
    'somos neutrales',
    'mediación neutral',
    'La plataforma devolverá el dinero',
    'We will issue a full refund',
  ])('blocks unsafe output: %s', (text) => {
    expect(() => assertSafeAgentText({ text })).toThrow();
  });
  it.each([
    '/JavaScript',
    '/Launch',
    '/OpenAction',
    '/EmbeddedFile',
    'EICAR-STANDARD-ANTIVIRUS-TEST-FILE',
  ])('blocks active file content %s', (text) => {
    expect(() =>
      assertEvidenceFileSafety(
        Buffer.from(`%PDF-1.4 ${text}`),
        'application/pdf',
      ),
    ).toThrow();
  });
  it('preserves safe original bytes and builds complete paginated PDF', () => {
    const bytes = Buffer.from('%PDF-1.4 safe');
    assertEvidenceFileSafety(bytes, 'application/pdf');
    expect(bytes.toString()).toBe('%PDF-1.4 safe');
    const pdf = dossierPdf({
      summary: 'Español: devolución',
      records: Array.from({ length: 120 }, (_, i) => `EVIDENCE-${i}`),
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString()).toContain('EVIDENCE-119');
    expect(pdf.toString()).toContain('/Count 2');
    expect(pdf.toString()).toContain('%%EOF');
  });
  it('produces a PDF readable by the existing vault extractor without losing the final record', async () => {
    const pdf = dossierPdf({
      summary: 'MOCK mediation dossier',
      evidence: Array.from({ length: 150 }, (_, i) => `ORIGINAL-${i}`),
    });
    const extracted = await new PdfTextExtractor().extract(pdf);
    expect(extracted).toContain('MOCK mediation dossier');
    expect(extracted).toContain('ORIGINAL-149');
  });
});
