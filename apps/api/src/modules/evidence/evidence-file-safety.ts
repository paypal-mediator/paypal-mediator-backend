import { ApiException } from '../../common/http/api.exception.js';
import { MAX_EVIDENCE_FILE_BYTES } from '@resolve-ai/contracts';
export function assertEvidenceFileFormat(bytes: Buffer, mediaType: string) {
  const signatures: Record<string, Buffer> = {
    'application/pdf': Buffer.from('%PDF-'),
    'image/png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    'image/jpeg': Buffer.from([255, 216, 255]),
  };
  const signature = signatures[mediaType];
  if (
    !signature ||
    !bytes.length ||
    bytes.length > MAX_EVIDENCE_FILE_BYTES ||
    !bytes.subarray(0, signature.length).equals(signature)
  )
    throw new ApiException(
      'EVIDENCE_FILE_INVALID',
      'Invalid file size, encoding or signature',
      400,
    );
}
// Basic active-content screening, not a claim of antivirus certification.
// Originals are never rewritten to make a rejected upload appear safe.
export function assertEvidenceFileSafety(bytes: Buffer, mediaType: string) {
  const raw = bytes.toString('latin1');
  if (
    raw.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ||
    (mediaType === 'application/pdf' &&
      /\/(?:JavaScript|JS|Launch|OpenAction|AA|EmbeddedFile|RichMedia)\b/i.test(
        raw,
      ))
  )
    throw new ApiException(
      'EVIDENCE_UNSAFE_FILE',
      'Active or unsafe file content is not accepted',
      422,
    );
}
