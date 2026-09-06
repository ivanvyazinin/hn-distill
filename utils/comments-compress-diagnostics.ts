import { env } from "@config/env";
import { log } from "@utils/log";

import type { HeuristicTrigger } from "@utils/summary-heuristics";

export type CommentsCompressRejectDiagnostic = {
  schemaVersion: 1;
  createdISO: string;
  storyId: number;
  model: string;
  hop: number;
  reason: string;
  triggers: HeuristicTrigger[];
  text: string;
  sourceHash: string;
  sourceChars: number;
};

/**
 * Best-effort per-hop diagnostic for semantic compression rejects.
 * Node filesystem modules are loaded only when diagnostics are explicitly enabled,
 * keeping the default Worker path free of node FS execution.
 */
export async function writeCommentsCompressRejectDiagnostic(
  diagnostic: CommentsCompressRejectDiagnostic,
  directory: string = env.COMMENTS_COMPRESS_DIAGNOSTICS_DIR
): Promise<string | undefined> {
  const outputDir = directory.trim();
  if (outputDir.length === 0) {
    return undefined;
  }

  try {
    const [{ mkdir, writeFile }, { join }, { randomUUID }] = await Promise.all([
      import("node:fs/promises"),
      import("node:path"),
      import("node:crypto"),
    ]);
    await mkdir(outputDir, { recursive: true });
    const filename = `${diagnostic.storyId}-${diagnostic.hop}-${randomUUID()}.json`;
    const outputPath = join(outputDir, filename);
    await writeFile(outputPath, `${JSON.stringify(diagnostic, undefined, 2)}\n`, "utf8");
    return outputPath;
  } catch (error) {
    log.warn("summarize/comments", "Comments compress diagnostic write failed", {
      id: diagnostic.storyId,
      hop: diagnostic.hop,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
