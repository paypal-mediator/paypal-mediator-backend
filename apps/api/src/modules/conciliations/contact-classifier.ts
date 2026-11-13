import { Injectable } from '@nestjs/common';
import type { ContactClassification } from '@resolve-ai/contracts';

import { CONTACT_CORPUS } from './contact-corpus.js';

export const CONTACT_MODEL = 'nlpjs-contact-v1';
const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[.,!¡¿?]+/gu, ' ')
    .replace(/😊|👍|🙏|❤️|✅/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const positive = new Set([
  'llego bien',
  'todo llego bien',
  'todo perfecto',
  'muchas gracias',
  'gracias',
  'excelente servicio',
  'thanks',
  'thank you',
  'everything arrived fine',
  'thanks everything arrived fine',
  'everything arrived correctly',
  'all good',
]);

export function fastContactClassification(
  text: string,
): ContactClassification | null {
  if (/[?¿]/.test(text) || !positive.has(normalize(text))) return null;
  return {
    category: /gracias|thank/.test(normalize(text)) ? 'THANKS' : 'COMPLIMENT',
    issue: 'GENERAL',
    score: 1,
    margin: 1,
    source: 'FAST_FILTER',
  };
}

@Injectable()
export class ContactClassifier {
  private model?: Promise<import('@nlpjs/nlp').Nlp>;
  private running = false;
  private async pipeline() {
    if (!this.model)
      this.model = (async () => {
        const [{ containerBootstrap }, { Nlp }, { LangEn }, { LangEs }] =
          await Promise.all([
            import('@nlpjs/core'),
            import('@nlpjs/nlp'),
            import('@nlpjs/lang-en'),
            import('@nlpjs/lang-es'),
          ]);
        const container = containerBootstrap();
        container.use(LangEn);
        container.use(LangEs);
        const nlp = new Nlp(
          { autoSave: false, autoLoad: false, nlu: { log: false } },
          container,
        );
        nlp.addLanguage('en');
        nlp.addLanguage('es');
        for (const [intent, examples] of Object.entries(CONTACT_CORPUS))
          for (const language of ['es', 'en'] as const)
            for (const text of examples[language])
              nlp.addDocument(language, text, intent);
        await nlp.train();
        return nlp;
      })();
    return this.model;
  }
  async classify(
    text: string,
    language?: 'es' | 'en',
  ): Promise<ContactClassification> {
    const fast = fastContactClassification(text);
    if (fast) return fast;
    if (this.running)
      return {
        category: 'UNCERTAIN',
        issue: 'GENERAL',
        score: 0,
        margin: 0,
        source: 'UNAVAILABLE',
      };
    this.running = true;
    try {
      const model = await this.pipeline();
      const result = language
        ? await model.process(language, text)
        : await model.process(text);
      if (!Object.hasOwn(CONTACT_CORPUS, result.intent))
        return {
          category: 'UNCERTAIN',
          issue: 'GENERAL',
          score: 0,
          margin: 0,
          source: 'LOCAL_NLP',
        };
      const [category, issue] = result.intent.split('.');
      const sorted = [...(result.classifications ?? [])].sort(
        (a, b) => b.score - a.score,
      );
      const score = Math.min(1, Math.max(0, result.score));
      const margin = Math.max(0, score - (sorted[1]?.score ?? 0));
      // Unknown/ambiguous text is never silently discarded or sent to the LLM.
      const mixed = /\b(pero|but|however|aunque)\b/i.test(text);
      const risk =
        /\b(paypal|chargeback|disputa|contracargo|demanda|fraud|fraude)\b/i.test(
          text,
        );
      const negative =
        /\b(no|not|never|missing|broken|damaged|roto|rota|falta|incompleto|problema|problem)\b/i.test(
          text,
        ) || /[?¿]/.test(text);
      const forceReview =
        result.intent === 'None' ||
        !Object.hasOwn(CONTACT_CORPUS, result.intent) ||
        score < 0.8 ||
        margin < 0.2 ||
        ((mixed || negative) &&
          !['COMPLAINT', 'QUESTION', 'DISPUTE_INTENT'].includes(category!));
      return {
        category: risk
          ? 'DISPUTE_INTENT'
          : forceReview
            ? 'UNCERTAIN'
            : (category as ContactClassification['category']),
        issue: forceReview
          ? 'GENERAL'
          : (issue as ContactClassification['issue']),
        score,
        margin,
        source: 'LOCAL_NLP',
      };
    } catch {
      this.model = undefined;
      return {
        category: 'UNCERTAIN',
        issue: 'GENERAL',
        score: 0,
        margin: 0,
        source: 'UNAVAILABLE',
      };
    } finally {
      this.running = false;
    }
  }
}
