import { createHash } from "node:crypto";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/** Sync SHA-256 for pure/hot paths (aggregate, compress sourceHash). */
export function sha256HexSync(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
    return bytesToHex(new Uint8Array(digest));
  }
  return sha256HexSync(input);
}

