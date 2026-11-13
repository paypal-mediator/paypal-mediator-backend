import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateSubmissionGuard } from '../../src/modules/submissions/submission-guard.js';

const eligible = () => ({
  internalState: 'LINKED',
  linkStatus: 'LINKED',
  verificationVerdict: 'APPROVED' as const,
  verifiedEvidenceIds: [randomUUID()],
  merchantAllowSubmissions: true,
  merchantRequireApproval: true,
  merchantApproved: true,
  paypalStatus: 'WAITING_FOR_SELLER_RESPONSE',
  paypalStage: 'CHARGEBACK',
  existingSubmission: false,
});
describe('M08 deterministic authorization', () => {
  it('accepts an explicitly approved eligible request with no blocking reasons', () => {
    expect(evaluateSubmissionGuard(eligible())).toEqual({
      verdict: 'ALLOWED',
      reasons: [],
    });
  });
  it.each([
    { merchantApproved: false },
    { merchantAllowSubmissions: false },
    { verificationVerdict: null },
    { verifiedEvidenceIds: [] },
    { paypalStatus: 'UNDER_REVIEW' },
    { paypalStatus: 'RESOLVED' },
    { linkStatus: 'CONFLICT' },
    { existingSubmission: true },
  ])('fails closed when a prerequisite fails: %j', (override) => {
    expect(
      evaluateSubmissionGuard({ ...eligible(), ...override }).verdict,
    ).toBe('BLOCKED');
  });
  it('requires explicit approval when policy is unknown', () => {
    expect(
      evaluateSubmissionGuard({
        ...eligible(),
        merchantRequireApproval: null,
        merchantApproved: false,
      }).verdict,
    ).toBe('BLOCKED');
  });
});
