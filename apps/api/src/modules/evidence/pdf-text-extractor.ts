import { Injectable } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import { ApiException } from '../../common/http/api.exception.js';

@Injectable()
export class PdfTextExtractor {
  async extract(buffer: Buffer): Promise<string> {
    let parser: PDFParse | undefined;
    try {
      parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      return result.text ?? '';
    } catch {
      throw new ApiException(
        'PDF_TEXT_EXTRACTION_FAILED',
        'No se pudo extraer texto del PDF',
        422,
      );
    } finally {
      await parser?.destroy().catch(() => undefined);
    }
  }
}
