function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export type BoardPdfPage = { base64: string; width: number; height: number };

/** Small dependency-free PDF wrapper. Each Artboard becomes one JPEG-backed page. */
export function jpegPagesToPdf(pages: readonly BoardPdfPage[]): Uint8Array {
  if (!pages.length) throw new Error("PDF export requires at least one page");
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let length = 0;
  const append = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? ascii(value) : value;
    chunks.push(bytes); length += bytes.length;
  };
  append("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const object = (number: number, body: string | (() => void)) => {
    offsets[number] = length;
    append(`${number} 0 obj\n`);
    typeof body === "string" ? append(body) : body();
    append("\nendobj\n");
  };
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index * 3} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  pages.forEach((page, index) => {
    if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0)
      throw new Error("PDF pages require positive dimensions");
    const binary = atob(page.base64), jpeg = new Uint8Array(binary.length);
    for (let byte = 0; byte < binary.length; byte++) jpeg[byte] = binary.charCodeAt(byte);
    const pageId = 3 + index * 3, imageId = pageId + 1, contentId = pageId + 2;
    object(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /Im${index} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    object(imageId, () => {
      append(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
      append(jpeg); append("\nendstream");
    });
    const commands = `q\n${page.width} 0 0 ${page.height} 0 0 cm\n/Im${index} Do\nQ\n`;
    object(contentId, `<< /Length ${ascii(commands).length} >>\nstream\n${commands}endstream`);
  });
  const xref = length;
  const size = 3 + pages.length * 3;
  append(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let number = 1; number < size; number++)
    append(`${String(offsets[number]).padStart(10, "0")} 00000 n \n`);
  append(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const result = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
  return result;
}

export function jpegBase64ToPdf(base64: string, width: number, height: number): Uint8Array {
  return jpegPagesToPdf([{ base64, width, height }]);
}
