declare module '@nlpjs/core' {
  export function containerBootstrap(): { use(plugin: unknown): void };
}
declare module '@nlpjs/lang-en' {
  export class LangEn {}
}
declare module '@nlpjs/lang-es' {
  export class LangEs {}
}
declare module '@nlpjs/nlp' {
  export class Nlp {
    constructor(
      settings: { autoSave: boolean; autoLoad: boolean; nlu: { log: boolean } },
      container: unknown,
    );
    addLanguage(language: string): void;
    addDocument(language: string, utterance: string, intent: string): void;
    train(): Promise<void>;
    process(
      language: string,
      utterance?: string,
    ): Promise<{
      intent: string;
      score: number;
      classifications?: Array<{ intent: string; score: number }>;
    }>;
  }
}
