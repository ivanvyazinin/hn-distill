export function looksLikePdf(opts: { url?: string; contentType?: string | undefined; bytesHead?: Uint8Array }): boolean {
  const { url, contentType, bytesHead } = opts;

  // Check Content-Type
  if (contentType !== undefined && contentType !== '' && contentType.includes('application/pdf')) {
    return true;
  }

  // Check URL extension
  if (url !== undefined && url !== '' && url.toLowerCase().endsWith('.pdf')) {
    return true;
  }

  // Check magic bytes for PDF signature
  if (bytesHead && bytesHead.length >= 4) {
    const pdfSignature = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    for (let i = 0; i < 4; i++) {
      if (bytesHead[i] !== pdfSignature[i]) {
        return false;
      }
    }
    return true;
  }

  return false;
}

export function looksLikeHtml(contentType?: string): boolean {
  if (contentType === undefined || contentType === '') {
    return false;
  }
  return contentType.includes('text/html') || contentType.includes('+html');
}

export function decodeText(bytes: Uint8Array, contentType?: string): string {
  // Extract charset from Content-Type
  let charset = 'utf8';
  if (contentType !== undefined && contentType !== '') {
    const charsetRegex = /charset=(?<charset>[^;]+)/iu;
    const charsetMatch = charsetRegex.exec(contentType);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (charsetMatch?.groups?.['charset'] !== undefined && charsetMatch?.groups?.['charset'] !== '') {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      charset = charsetMatch.groups?.['charset'].trim();
    }
  }

  try {
    const decoder = new TextDecoder(charset, { fatal: false });
    return decoder.decode(bytes);
  } catch {
    // Fallback to utf8
    const decoder = new TextDecoder('utf8', { fatal: false });
    return decoder.decode(bytes);
  }
}