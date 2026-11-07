import type { InvestigationDraft } from '@resolve-ai/contracts';

// Partition ALL draft text on the server, including claims outside cited findings.
// Each exact unit must be reviewed once; the model cannot choose the inventory.
export function draftUnits(draft: InvestigationDraft) {
  const fields = [
    { path: 'summary', text: draft.summary },
    ...draft.findings.map((f, i) => ({
      path: `findings.${i}`,
      text: f.statement,
    })),
    ...draft.contradictions.map((f, i) => ({
      path: `contradictions.${i}`,
      text: f.statement,
    })),
    { path: 'suggestedResponse', text: draft.suggestedResponse },
  ];
  return fields.flatMap((field) =>
    field.text
      .split(/(?<=[.!?])\s+|\n+/u)
      .map((text) => text.trim())
      .filter(Boolean)
      .map((statement, index) => ({
        unitId: `${field.path}.${index}`,
        statement,
      })),
  );
}
