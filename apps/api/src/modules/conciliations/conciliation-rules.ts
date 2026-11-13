import type {
  ConciliationPolicy,
  ContactClassification,
} from '@resolve-ai/contracts';

export const DEFAULT_CONCILIATION_POLICY: ConciliationPolicy = {
  enabled: true,
  minScore: 0.9,
  rules: [],
};
export function contactDecision(
  classification: ContactClassification,
  policy: ConciliationPolicy,
  language: 'es' | 'en',
) {
  const actionable = ['COMPLAINT', 'QUESTION'].includes(
    classification.category,
  );
  const confident =
    classification.score >= policy.minScore && classification.margin >= 0.2;
  const rule = policy.rules.find(
    (r) =>
      r.category === classification.category &&
      r.issue === classification.issue,
  );
  // Automatic delivery ONLY uses merchant-approved text, never free-form model output.
  const automaticText =
    policy.enabled && actionable && confident && rule?.automatic
      ? language === 'es'
        ? rule.replyEs
        : rule.replyEn
      : null;
  return {
    generate: policy.enabled && actionable && confident && !automaticText,
    automaticText,
    rule,
    needsReview:
      classification.category === 'UNCERTAIN' ||
      classification.category === 'DISPUTE_INTENT' ||
      !confident,
  };
}
