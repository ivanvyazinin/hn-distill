declare module 'pdf-parse' {
  import { Buffer } from 'buffer';

  export interface PdfData {
    text: string;
    numpages: number;
    info: Record<string, unknown>;
    metadata: Record<string, unknown>;
    version: string;
  }

  export default function pdfParse(buffer: Buffer): Promise<PdfData>;
}