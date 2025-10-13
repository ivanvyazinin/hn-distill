import { Buffer } from "node:buffer";

import pdfParse from "pdf-parse/lib/pdf-parse";

import { log } from "@utils/log";

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

type PdfParseResult = {
  text: string;
  numpages: number;
};

type PdfParseFn = (dataBuffer: Buffer) => Promise<unknown>;

const parsePdf: PdfParseFn = pdfParse as unknown as PdfParseFn;

function isPdfParseResult(value: unknown): value is PdfParseResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as PdfParseResult;
  return typeof candidate.text === "string" && typeof candidate.numpages === "number";
}

export async function pdfToText(bytes: Uint8Array, opts?: PdfToTextOptions): Promise<string> {
  const maxPages = opts?.maxPages ?? DEFAULTS.PDF_MAX_PAGES;
  const joinLines = opts?.joinLines ?? DEFAULTS.PDF_JOIN_LINES;

  // Log warning if size exceeds soft limit
  if (opts?.softMaxBytes !== undefined && bytes.length > opts.softMaxBytes) {
    log.warn("pdf", "PDF size exceeds soft limit", { bytes: bytes.length, limit: opts.softMaxBytes });
  }

  try {
    // Use pdf-parse which is designed for Node.js
    const parsed = await parsePdf(Buffer.from(bytes));

    if (!isPdfParseResult(parsed)) {
      log.error("pdf", "Unexpected pdf-parse response", {
        keys:
          typeof parsed === "object" && parsed !== null ? Object.keys(parsed as Record<string, unknown>) : undefined,
      });
      throw new Error("Unexpected pdf-parse response");
    }

    const { text, numpages } = parsed;
    let result = text;

    // Limit pages if specified
    if (maxPages && numpages > maxPages) {
      log.warn("pdf", `PDF has ${numpages} pages, limiting to ${maxPages}`, { url: opts?.url ?? "unknown" });
      // Split by page breaks and take first N pages
      const pages = result.split("\f").flatMap((page) => page.split(/\nPage\s+\d+\s*/u));
      result = pages.slice(0, maxPages).join("\n\n");
    }

    // Normalize text
    result = result.replaceAll("\u0000", ""); // Remove null bytes

    // Collapse sequences of more than 3 line breaks to 2
    result = result.replaceAll(/\n{4,}/gu, "\n\n\n");

    if (joinLines) {
      // Join hard line breaks within paragraphs
      result = result.replaceAll(/(?<char>[^!.?])\n(?=[^.])/gu, "$<char> ");
    }

    return result.trim();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PDF parsing failed: ${message}`);
  }
}
