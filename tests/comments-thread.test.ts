import { describe, expect, test } from "bun:test";

import {
  buildCommentsPromptV2,
  buildCommentsSystemInstructionV2,
  buildCommentsThread,
  commentsInputHash,
} from "../utils/comments-thread.ts";

import type { NormalizedComment } from "../config/schemas.ts";

const STORY = { id: 100, title: "Deterministic thread trees" };

function comment(
  id: number,
  parent: number,
  textPlain: string,
  overrides: Partial<NormalizedComment> = {}
): NormalizedComment {
  return {
    id,
    parent,
    textPlain,
    by: `user${id}`,
    timeISO: "2026-01-01T00:00:00.000Z",
    depth: parent === STORY.id ? 0 : 1,
    ...overrides,
  };
}

function renderedCommentText(thread: string, id: number): string {
  const marker = `[comment_id=${id} `;
  const line = thread.split("\n").find((candidate) => candidate.includes(marker));
  if (line === undefined) {
    throw new Error(`Missing rendered comment ${id}`);
  }
  return line.slice(line.indexOf("] ") + 2);
}

describe("comments thread", () => {
  test("promotes comments whose parent is absent and includes all represented ids", () => {
    const comments = [comment(1, STORY.id, "normal root"), comment(2, 999, "orphaned reply")];
    const result = buildCommentsThread(STORY, comments, { maxChars: 10_000 });
    expect(result.sampleIds).toEqual([1, 2]);
    expect(result.droppedIds).toEqual([]);
    expect(result.text).toContain("[comment_id=2 @user2] orphaned reply");
  });

  test("cuts cycles by promoting the earliest stable node", () => {
    const comments = [comment(1, 2, "first cycle node"), comment(2, 1, "second cycle node")];
    const result = buildCommentsThread(STORY, comments, { maxChars: 10_000 });
    expect(result.sampleIds).toEqual([1, 2]);
    expect(result.text.split("\n")[0]).toContain("comment_id=1");
    expect((result.text.split("\n")[1] ?? "").startsWith("  > [comment_id=2")).toBeTrue();
  });

  test("ranks branches by subtree size and preserves original order for ties", () => {
    const comments = [
      comment(1, STORY.id, "small first root"),
      comment(2, STORY.id, "large later root"),
      comment(3, 2, "large child"),
      comment(4, STORY.id, "small tied root"),
    ];
    const result = buildCommentsThread(STORY, comments, { maxChars: 10_000 });
    expect(result.sampleIds).toEqual([2, 3, 1, 4]);
  });

  test("uses top-five and remaining-branch root and reply caps", () => {
    const comments: NormalizedComment[] = [];
    for (let branch = 0; branch < 6; branch += 1) {
      const rootId = branch * 10 + 1;
      comments.push(comment(rootId, STORY.id, `${String(branch)}${"r".repeat(1000)}`));
      comments.push(comment(rootId + 1, rootId, `${String(branch)}${"a".repeat(700)}`));
    }
    const result = buildCommentsThread(STORY, comments, { maxChars: 20_000 });
    expect(renderedCommentText(result.text, 1).length).toBe(900);
    expect(renderedCommentText(result.text, 2).length).toBe(500);
    expect(renderedCommentText(result.text, 51).length).toBe(400);
    expect(renderedCommentText(result.text, 52).length).toBe(250);
  });

  test("drops an oversized branch whole and can still include a later branch", () => {
    const large = [comment(1, STORY.id, "large root"), comment(2, 1, "x".repeat(500))];
    const small = comment(3, STORY.id, "small branch");
    const smallLength = buildCommentsThread(STORY, [small], { maxChars: 10_000 }).text.length;
    const result = buildCommentsThread(STORY, [...large, small], { maxChars: smallLength });
    expect(result.sampleIds).toEqual([3]);
    expect(result.droppedIds).toEqual([1, 2]);
    expect(result.text).not.toContain("large root");
  });

  test("accounts for every nonempty comment as included or explicitly dropped", () => {
    const comments = [
      comment(1, STORY.id, "first branch"),
      comment(2, STORY.id, "second branch"),
      comment(3, STORY.id, "   "),
      comment(4, 999, "orphan branch"),
    ];
    const result = buildCommentsThread(STORY, comments, { maxChars: 0 });
    expect(result.sampleIds).toEqual([]);
    expect(result.droppedIds).toEqual([1, 2, 4]);
    expect(new Set([...result.sampleIds, ...result.droppedIds])).toEqual(new Set([1, 2, 4]));
  });
});

describe("comments prompt v2", () => {
  test("localizes title/context, includes exact schema and respects total budget", () => {
    const longSummary = `${"А".repeat(400)}НЕ_ДОЛЖНО_ПОПАСТЬ`;
    const result = buildCommentsPromptV2({
      story: STORY,
      comments: [comment(1, STORY.id, "Участники приводят конкретные аргументы и сравнивают два подхода.")],
      postSummary: { summary: longSummary },
      language: "ru",
      maxChars: 5000,
    });
    expect(result.prompt.length).toBeLessThanOrEqual(5000);
    expect(result.prompt).toContain(`Тема поста: ${STORY.title}`);
    expect(result.prompt).toContain(`Суть статьи: ${"А".repeat(400)}`);
    expect(result.prompt).not.toContain("НЕ_ДОЛЖНО_ПОПАСТЬ");
    expect(result.prompt).toContain('"comment_id"');
    expect(result.prompt).toContain('"source_text"');
    expect(result.prompt).toContain('"translation"');
    expect(result.sampleIds).toEqual([1]);
  });

  test("omits article gist for no-article degraded posts", () => {
    const result = buildCommentsPromptV2({
      story: STORY,
      comments: [],
      postSummary: { summary: "garbage navigation", degraded: "no-article" },
      language: "en",
      maxChars: 5000,
    });
    expect(result.prompt).toContain(`Story topic: ${STORY.title}`);
    expect(result.prompt).not.toContain("Article gist:");
    expect(result.prompt).not.toContain("garbage navigation");
  });

  test("provides distinct RU and EN system instructions", () => {
    const ru = buildCommentsSystemInstructionV2("ru");
    const en = buildCommentsSystemInstructionV2("en");
    expect(ru).toContain("русском");
    expect(en).toContain("Analyze Hacker News");
    expect(en).toContain("generated semantic field in English");
    expect(en).toContain("translation to null");
    expect(ru).not.toBe(en);
  });

  test("folds story title and post summary changes into the prompt hash", async () => {
    const common = {
      comments: [comment(1, STORY.id, "A concrete comment about the design trade-offs and rollout plan.")],
      language: "en" as const,
      maxChars: 5000,
    };
    const base = buildCommentsPromptV2({
      ...common,
      story: STORY,
      postSummary: { summary: "The article proposes a staged migration." },
    });
    const changedTitle = buildCommentsPromptV2({
      ...common,
      story: { ...STORY, title: "A different story title" },
      postSummary: { summary: "The article proposes a staged migration." },
    });
    const changedPost = buildCommentsPromptV2({
      ...common,
      story: STORY,
      postSummary: { summary: "The article proposes an immediate migration." },
    });

    expect(changedTitle.prompt).not.toBe(base.prompt);
    expect(changedPost.prompt).not.toBe(base.prompt);
    const baseHash = await commentsInputHash("en", "2", base.prompt);
    expect(await commentsInputHash("en", "2", changedTitle.prompt)).not.toBe(baseHash);
    expect(await commentsInputHash("en", "2", changedPost.prompt)).not.toBe(baseHash);
  });

  test("hash changes with language, policy version, and prompt", async () => {
    const base = await commentsInputHash("ru", "2", "prompt");
    expect(await commentsInputHash("ru", "2", "prompt")).toBe(base);
    expect(await commentsInputHash("en", "2", "prompt")).not.toBe(base);
    expect(await commentsInputHash("ru", "3", "prompt")).not.toBe(base);
    expect(await commentsInputHash("ru", "2", "changed prompt")).not.toBe(base);
  });
});
