import { Injectable } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';

@Injectable()
export class PdfTextExtractor {
  async extract(buffer: Buffer): Promise<string> {
    let parser: PDFParse | undefined;
    try {
      parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      return result.text ?? '';
    } catch {
      // PDFs escaneados o sin texto embebido: no bloquear la subida.
      // El investigador/verificador ya reportan UNSUPPORTED_PDF.
      return '';
    } finally {
      await parser?.destroy().catch(() => undefined);
    }
  }
}
