// Small deterministic text PDF, with lossless ASCII JSON escapes for Unicode.
// All source evidence is retained; lines/pages are wrapped, never truncated.
export function dossierPdf(packet: unknown): Buffer {
  const ascii = JSON.stringify(packet, null, 2).replace(
    /[^\x20-\x7e\n]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  const lines = ascii
    .split('\n')
    .flatMap((line) => line.match(/.{1,95}/g) ?? ['']);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 64) pages.push(lines.slice(i, i + 64));
  const objects: string[] = [
    '',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
  ];
  const pageIds: number[] = [];
  for (const page of pages) {
    const pageId = objects.length + 1,
      streamId = pageId + 1;
    pageIds.push(pageId);
    const escaped = page
      .map((line) => `(${line.replace(/([\\()])/g, '\\$1')}) Tj T*`)
      .join('\n');
    const stream = `BT /F1 8 Tf 10 TL 30 810 Td\n${escaped}\nET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  let output = '%PDF-1.4\n',
    offset = Buffer.byteLength(output);
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(offset);
    const encoded = `${i + 1} 0 obj\n${object}\nendobj\n`;
    output += encoded;
    offset += Buffer.byteLength(encoded);
  });
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${n.toString().padStart(10, '0')} 00000 n \n`)
    .join(
      '',
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.from(output, 'ascii');
}
