import { Buffer } from 'node:buffer';

import pdfParse from 'pdf-parse/lib/pdf-parse.js';

import { log } from '@utils/log';

export type PdfToTextOptions = {
  maxPages?: number;
  softMaxBytes?: number;
  joinLines?: boolean;
  url?: string;
};

const DEFAULTS = {
  PDF_MAX_PAGES: 12,
  PDF_JOIN_LINES: true,
} as const;

export async function pdfToText(bytes: Uint8Array, opts?: PdfToTextOptions): Promise<string> {
  const maxPages = opts?.maxPages ?? DEFAULTS.PDF_MAX_PAGES;
  const joinLines = opts?.joinLines ?? DEFAULTS.PDF_JOIN_LINES;

  // Log warning if size exceeds soft limit
  if (opts?.softMaxBytes !== undefined && bytes.length > opts.softMaxBytes) {
    log.warn('pdf', 'PDF size exceeds soft limit', { bytes: bytes.length, limit: opts.softMaxBytes });
  }

  try {
    // Use pdf-parse which is designed for Node.js
    const data = await pdfParse(Buffer.from(bytes));
    const { text: initialText, numpages } = data;
    let text = initialText;

    // Limit pages if specified
    if (maxPages && numpages > maxPages) {
      log.warn('pdf', `PDF has ${numpages} pages, limiting to ${maxPages}`, { url: opts?.url ?? 'unknown' });
      // Split by page breaks and take first N pages
      const pages = text.split('\f').flatMap(page => page.split(/\nPage\s+\d+\s*/u));
      text = pages.slice(0, maxPages).join('\n\n');
    }

    // Normalize text
    text = text.replaceAll('\u0000', ''); // Remove null bytes

    // Collapse sequences of more than 3 line breaks to 2
    text = text.replaceAll(/\n{4,}/gu, '\n\n\n');

    if (joinLines) {
      // Join hard line breaks within paragraphs
      text = text.replaceAll(/(?<char>[^!.?])\n(?=[^.])/gu, '$<char> ');
    }

    return text.trim();
  } catch (error) {
    throw new Error(`PDF parsing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
