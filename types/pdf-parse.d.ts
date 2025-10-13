declare module "pdf-parse/lib/pdf-parse" {
  import { Buffer } from "node:buffer";

  export interface PdfParseResult {
    numpages: number;
    text: string;
  }

  export type PdfParseInput = Buffer | Uint8Array;

  export default function pdfParse(buffer: PdfParseInput, options?: unknown): Promise<PdfParseResult>;
}
