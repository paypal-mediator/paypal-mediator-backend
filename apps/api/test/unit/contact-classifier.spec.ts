import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { ConciliationPolicySchema } from '@resolve-ai/contracts';
import {
  ContactClassifier,
  fastContactClassification,
} from '../../src/modules/conciliations/contact-classifier.js';
import {
  contactDecision,
  DEFAULT_CONCILIATION_POLICY,
} from '../../src/modules/conciliations/conciliation-rules.js';

describe('preventive NLP gate (real local NLP.js, no generative AI)', () => {
  it.each([
    'llegó bien',
    'Todo perfecto!',
    'Thanks, everything arrived fine.',
    'GRACIAS',
  ])('skips inference for an unambiguous acknowledgement: %s', async (text) => {
    expect((await new ContactClassifier().classify(text)).source).toBe(
      'FAST_FILTER',
    );
    const decision = contactDecision(
      fastContactClassification(text)!,
      { ...DEFAULT_CONCILIATION_POLICY, enabled: true },
      'es',
    );
    expect(decision.generate).toBe(false);
    expect(decision.automaticText).toBeNull();
  });
  it('does not swallow mixed, negated or interrogative acknowledgements', async () => {
    const classifier = new ContactClassifier();
    for (const text of [
      'llego bien pero falta una pieza',
      'It arrived fine but one item is missing',
      'No llego bien',
      'llego bien?',
    ]) {
      expect(fastContactClassification(text)).toBeNull();
      const result = await classifier.classify(text);
      expect(['COMPLAINT', 'QUESTION', 'UNCERTAIN']).toContain(result.category);
    }
  });
  it('recognizes held-out English and Spanish support messages without an LLM', async () => {
    const classifier = new ContactClassifier();
    expect(await classifier.classify('Where is my package?')).toMatchObject({
      category: 'QUESTION',
      issue: 'SHIPPING',
      source: 'LOCAL_NLP',
    });
    expect(
      await classifier.classify('No me ha llegado mi pedido y necesito ayuda'),
    ).toMatchObject({ category: 'COMPLAINT', issue: 'SHIPPING' });
    expect(
      await classifier.classify('Voy a abrir un caso con PayPal'),
    ).toMatchObject({ category: 'DISPUTE_INTENT' });
  });
  it('requires explicit rules and uses approved bilingual text, never a generated automatic promise', () => {
    const classification = {
      category: 'COMPLAINT' as const,
      issue: 'SHIPPING' as const,
      score: 0.99,
      margin: 0.5,
      source: 'LOCAL_NLP' as const,
    };
    const rule = {
      category: 'COMPLAINT' as const,
      issue: 'SHIPPING' as const,
      automatic: true,
      instructions: 'Request delivery details',
      replyEs: 'Revisaremos tu entrega.',
      replyEn: 'We will review your delivery.',
    };
    const policy = {
      ...DEFAULT_CONCILIATION_POLICY,
      enabled: true,
      rules: [rule],
    };
    expect(contactDecision(classification, policy, 'en')).toMatchObject({
      automaticText: rule.replyEn,
      generate: false,
    });
    expect(
      contactDecision(classification, { ...policy, enabled: false }, 'en'),
    ).toMatchObject({ automaticText: null, generate: false });
    expect(
      contactDecision({ ...classification, score: 0.6 }, policy, 'en'),
    ).toMatchObject({
      automaticText: null,
      generate: false,
      needsReview: true,
    });
    expect(
      contactDecision(classification, { ...policy, rules: [] }, 'es'),
    ).toMatchObject({ automaticText: null, generate: true });
    expect(
      ConciliationPolicySchema.safeParse({
        ...policy,
        rules: [{ ...rule, replyEn: '' }],
      }).success,
    ).toBe(false);
  });
});
