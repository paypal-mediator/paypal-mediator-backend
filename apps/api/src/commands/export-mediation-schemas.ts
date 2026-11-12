import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  DetectorEnvelopeSchema,
  DetectionSchema,
  ProposalSchema,
  MediationVerdictSchema,
  MediationReviewSchema,
  MediationMessageInputSchema,
  MediationStartSchema,
  MediationActionSchema,
  MediationEvidenceInputSchema,
  MediationPolicySchema,
  MediationViewSchema,
} from '@resolve-ai/contracts';
const schemas = {
  detectorOutput: DetectorEnvelopeSchema,
  detection: DetectionSchema,
  proposal: ProposalSchema,
  verdict: MediationVerdictSchema,
  independentReview: MediationReviewSchema,
  messageInput: MediationMessageInputSchema,
  startInput: MediationStartSchema,
  actionInput: MediationActionSchema,
  evidenceInput: MediationEvidenceInputSchema,
  businessPolicy: MediationPolicySchema,
  view: MediationViewSchema,
};
await writeFile(
  resolve('docs/mediation-schemas.json'),
  `${JSON.stringify(Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema, { target: 'draft-7' })])), null, 2)}\n`,
);
