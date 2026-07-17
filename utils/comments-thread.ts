import { CommentsInsightsJsonSchema } from "@config/schemas";
import { sha256Hex } from "@utils/hash";

import type { NormalizedComment, NormalizedStory, PostSummary } from "@config/schemas";

export type CommentsLanguage = "en" | "ru";

export type CommentsThreadResult = {
  text: string;
  sampleIds: number[];
  droppedIds: number[];
};

export type BuildCommentsThreadOptions = {
  maxChars: number;
};

export type BuildCommentsPromptV2Input = {
  story: Pick<NormalizedStory, "id" | "title">;
  comments: readonly NormalizedComment[];
  postSummary?: Pick<PostSummary, "degraded" | "summary">;
  language: CommentsLanguage;
  maxChars: number;
};

export type CommentsPromptV2Result = CommentsThreadResult & {
  prompt: string;
  maxInsights: number;
};

type ThreadNode = {
  comment: NormalizedComment;
  index: number;
  text: string;
  parentId?: number;
  children: ThreadNode[];
};

const TOP_BRANCH_COUNT = 5;
const TOP_ROOT_MAX_CHARS = 900;
const TOP_REPLY_MAX_CHARS = 500;
const OTHER_ROOT_MAX_CHARS = 400;
const OTHER_REPLY_MAX_CHARS = 250;
const POST_SUMMARY_CONTEXT_MAX_CHARS = 400;
const SUBSTANTIVE_COMMENT_MIN_CHARS = 80;
const COMMENTS_INSIGHTS_HARD_CEILING = 15;

/** True when a comment has enough non-whitespace content to count toward the insights ceiling. */
export function isSubstantiveComment(comment: Pick<NormalizedComment, "textPlain">): boolean {
  return comment.textPlain.replaceAll(/\s+/gu, " ").trim().length >= SUBSTANTIVE_COMMENT_MIN_CHARS;
}

export function countSubstantiveComments(comments: readonly Pick<NormalizedComment, "textPlain">[]): number {
  return comments.reduce((count, comment) => count + (isSubstantiveComment(comment) ? 1 : 0), 0);
}

/**
 * Dynamic insights ceiling from substantive-comment count (S):
 * 3–9 → 5, 10–19 → 8, 20–29 → 12, ≥30 → 15.
 * S < 3 is handled by the too-few-comments gate before prompt build.
 */
export function commentsInsightsCeiling(substantiveCount: number): number {
  if (substantiveCount >= 30) return COMMENTS_INSIGHTS_HARD_CEILING;
  if (substantiveCount >= 20) return 12;
  if (substantiveCount >= 10) return 8;
  return 5;
}

/** Inject maxItems into the provider-facing contract text (provider schema itself has no maxItems). */
export function commentsJsonContract(maxInsights: number): string {
  const schema = {
    ...CommentsInsightsJsonSchema,
    properties: {
      ...CommentsInsightsJsonSchema.properties,
      insights: {
        ...CommentsInsightsJsonSchema.properties.insights,
        maxItems: maxInsights,
      },
    },
  };
  return JSON.stringify(schema);
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function assertMaxChars(maxChars: number): void {
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be a non-negative integer");
  }
}

function makeNodes(comments: readonly NormalizedComment[]): ThreadNode[] {
  const seenIds = new Set<number>();
  const nodes: ThreadNode[] = [];
  for (const [index, comment] of comments.entries()) {
    const text = singleLine(comment.textPlain);
    if (text.length === 0 || seenIds.has(comment.id)) {
      continue;
    }
    seenIds.add(comment.id);
    nodes.push({ comment, index, text, children: [] });
  }
  return nodes;
}

function assignParents(storyId: number, nodes: ThreadNode[], nodesById: ReadonlyMap<number, ThreadNode>): void {
  for (const node of nodes) {
    const parentId = node.comment.parent;
    if (parentId !== storyId && nodesById.has(parentId)) {
      node.parentId = parentId;
    }
  }
}

function cutParentCycles(nodes: ThreadNode[], nodesById: ReadonlyMap<number, ThreadNode>): void {
  const resolved = new Set<number>();
  for (const start of nodes) {
    if (resolved.has(start.comment.id)) {
      continue;
    }
    const path: ThreadNode[] = [];
    const positions = new Map<number, number>();
    let current: ThreadNode | undefined = start;
    while (current !== undefined && !resolved.has(current.comment.id)) {
      const cycleStart = positions.get(current.comment.id);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart);
        const promoted = cycle.reduce((earliest, node) => (node.index < earliest.index ? node : earliest));
        delete promoted.parentId;
        break;
      }
      positions.set(current.comment.id, path.length);
      path.push(current);
      current = current.parentId === undefined ? undefined : nodesById.get(current.parentId);
    }
    for (const node of path) {
      resolved.add(node.comment.id);
    }
  }
}

function makeForest(storyId: number, comments: readonly NormalizedComment[]): { nodes: ThreadNode[]; roots: ThreadNode[] } {
  const nodes = makeNodes(comments);
  const nodesById = new Map(nodes.map((node) => [node.comment.id, node]));
  assignParents(storyId, nodes, nodesById);
  cutParentCycles(nodes, nodesById);

  const roots: ThreadNode[] = [];
  for (const node of nodes) {
    const parent = node.parentId === undefined ? undefined : nodesById.get(node.parentId);
    if (parent === undefined) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }
  for (const node of nodes) {
    node.children.sort((left, right) => left.index - right.index);
  }
  return { nodes, roots };
}

function subtreeSizes(roots: readonly ThreadNode[]): ReadonlyMap<number, number> {
  const sizes = new Map<number, number>();
  for (const root of roots) {
    const stack: Array<{ node: ThreadNode; visited: boolean }> = [{ node: root, visited: false }];
    while (stack.length > 0) {
      const entry = stack.pop();
      if (entry === undefined) {
        continue;
      }
      if (entry.visited) {
        sizes.set(
          entry.node.comment.id,
          1 + entry.node.children.reduce((sum, child) => sum + (sizes.get(child.comment.id) ?? 0), 0)
        );
        continue;
      }
      stack.push({ node: entry.node, visited: true });
      for (let index = entry.node.children.length - 1; index >= 0; index -= 1) {
        const child = entry.node.children[index];
        if (child !== undefined) {
          stack.push({ node: child, visited: false });
        }
      }
    }
  }
  return sizes;
}

function orderedBranchNodes(root: ThreadNode): Array<{ node: ThreadNode; depth: number }> {
  const ordered: Array<{ node: ThreadNode; depth: number }> = [];
  const stack: Array<{ node: ThreadNode; depth: number }> = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) {
      continue;
    }
    ordered.push(entry);
    for (let index = entry.node.children.length - 1; index >= 0; index -= 1) {
      const child = entry.node.children[index];
      if (child !== undefined) {
        stack.push({ node: child, depth: entry.depth + 1 });
      }
    }
  }
  return ordered;
}

function renderBranch(root: ThreadNode, isTopBranch: boolean): { text: string; ids: number[] } {
  const rootCap = isTopBranch ? TOP_ROOT_MAX_CHARS : OTHER_ROOT_MAX_CHARS;
  const replyCap = isTopBranch ? TOP_REPLY_MAX_CHARS : OTHER_REPLY_MAX_CHARS;
  const lines: string[] = [];
  const ids: number[] = [];
  for (const { node, depth } of orderedBranchNodes(root)) {
    const cap = depth === 0 ? rootCap : replyCap;
    const author = singleLine(node.comment.by);
    const marker = `[comment_id=${node.comment.id} @${author}]`;
    const prefix = depth === 0 ? "" : `${"  ".repeat(depth)}> `;
    lines.push(`${prefix}${marker} ${node.text.slice(0, cap)}`);
    ids.push(node.comment.id);
  }
  return { text: lines.join("\n"), ids };
}

export function buildCommentsThread(
  story: Pick<NormalizedStory, "id" | "title">,
  comments: readonly NormalizedComment[],
  options: BuildCommentsThreadOptions
): CommentsThreadResult {
  assertMaxChars(options.maxChars);
  const { nodes, roots } = makeForest(story.id, comments);
  const sizes = subtreeSizes(roots);
  const rankedRoots = [...roots].sort((left, right) => {
    const sizeDifference = (sizes.get(right.comment.id) ?? 0) - (sizes.get(left.comment.id) ?? 0);
    return sizeDifference === 0 ? left.index - right.index : sizeDifference;
  });

  const blocks: string[] = [];
  const sampleIds: number[] = [];
  const includedIds = new Set<number>();
  let currentLength = 0;
  for (const [rank, root] of rankedRoots.entries()) {
    const branch = renderBranch(root, rank < TOP_BRANCH_COUNT);
    const separatorLength = blocks.length === 0 ? 0 : 2;
    if (currentLength + separatorLength + branch.text.length > options.maxChars) {
      continue;
    }
    blocks.push(branch.text);
    currentLength += separatorLength + branch.text.length;
    sampleIds.push(...branch.ids);
    for (const id of branch.ids) {
      includedIds.add(id);
    }
  }

  const droppedIds = nodes.filter((node) => !includedIds.has(node.comment.id)).map((node) => node.comment.id);
  return { text: blocks.join("\n\n"), sampleIds, droppedIds };
}

export function buildCommentsSystemInstructionV2(language: CommentsLanguage, maxInsights: number): string {
  if (language === "en") {
    return [
      "Analyze Hacker News discussions accurately and concisely.",
      "Write every generated semantic field in English; when best_quote is emitted, set translation to null.",
      "Return only JSON matching the requested schema, without Markdown fences or commentary.",
      "Preserve usernames and technical terms, and never invent claims, consensus, disputes, advice, or quotes.",
      'Use kind="dispute" only for genuine disagreements with substantive arguments from both sides, and put both sides inside text.',
      "Attribute experience when present (e.g. 'per @user in production…'); prefer voices with direct operational experience.",
      `Rank densest insights first. ${maxInsights} is a ceiling, not a quota. One fact = one insight; two dense items beat five vague ones.`,
    ].join("\n");
  }
  return [
    "Точно и кратко анализируй обсуждения Hacker News на русском языке.",
    "Возвращай только JSON по запрошенной схеме, без Markdown-ограждений и пояснений.",
    "Сохраняй ники и технические термины; не выдумывай тезисы, консенсус, споры, советы и цитаты.",
    'kind="dispute" только при настоящем споре с содержательными аргументами обеих сторон — обе стороны внутри text.',
    "Атрибутируй опыт, когда он есть (например: «по опыту @ник в проде…»); предпочитай голоса с прямым опытом.",
    `Ранжируй: самое ценное первым. ${maxInsights} — потолок, не план. Один факт = один insight; 2 плотных лучше 5 общих.`,
  ].join("\n");
}

function promptParts(
  input: BuildCommentsPromptV2Input,
  maxInsights: number
): { prefix: string; suffix: string } {
  const title = singleLine(input.story.title);
  const postSummary =
    input.postSummary?.degraded === "no-article"
      ? ""
      : singleLine(input.postSummary?.summary ?? "").slice(0, POST_SUMMARY_CONTEXT_MAX_CHARS);
  const hasGist = postSummary.length > 0;
  const contract = commentsJsonContract(maxInsights);
  const contextLines =
    input.language === "ru"
      ? [`Тема поста: ${title}`, ...(hasGist ? [`Суть статьи: ${postSummary}`] : []), "Обсуждение:"]
      : [`Story topic: ${title}`, ...(hasGist ? [`Article gist: ${postSummary}`] : []), "Discussion:"];
  const quoteRule =
    input.language === "ru"
      ? "best_quote — null либо объект с comment_id из обсуждения, дословным source_text и отдельным translation; для EN translation=null."
      : "best_quote is null or an object with a discussion comment_id, verbatim source_text, and translation=null for English.";
  const deltaRule =
    input.language === "ru"
      ? hasGist
        ? "Не повторяй суть статьи; извлекай только то, что тред ДОБАВЛЯЕТ (опыт эксплуатации, возражения, цифры из практики, механизмы). bottom_line — что тред добавляет к статье: подтверждает/опровергает/дополняет — и чем."
        : "bottom_line — главный вывод треда."
      : hasGist
        ? "Do not restate the article gist; extract only what the thread ADDS (ops experience, objections, practice numbers, mechanisms). bottom_line = what the thread adds to the article: confirms/refutes/extends — and how."
        : "bottom_line is the thread's main takeaway.";
  const suffixLines =
    input.language === "ru"
      ? [
          "Верни только один JSON-объект по этой точной JSON Schema:",
          contract,
          quoteRule,
          deltaRule,
          "Не добавляй сведения, которых нет во включённых комментариях.",
        ]
      : [
          "Return exactly one JSON object matching this JSON Schema:",
          contract,
          quoteRule,
          deltaRule,
          "Do not add information absent from the included comments.",
        ];
  return { prefix: `${contextLines.join("\n")}\n`, suffix: `\n${suffixLines.join("\n")}` };
}

export function buildCommentsPromptV2(input: BuildCommentsPromptV2Input): CommentsPromptV2Result {
  assertMaxChars(input.maxChars);
  const maxInsights = commentsInsightsCeiling(countSubstantiveComments(input.comments));
  const { prefix, suffix } = promptParts(input, maxInsights);
  const fixedChars = prefix.length + suffix.length;
  if (fixedChars > input.maxChars) {
    throw new RangeError(`maxChars is too small for the comments prompt contract: ${fixedChars}`);
  }
  const thread = buildCommentsThread(input.story, input.comments, { maxChars: input.maxChars - fixedChars });
  const prompt = `${prefix}${thread.text}${suffix}`;
  return {
    prompt,
    text: thread.text,
    sampleIds: thread.sampleIds,
    droppedIds: thread.droppedIds,
    maxInsights,
  };
}

export async function commentsInputHash(
  language: CommentsLanguage,
  policyVersion: string,
  prompt: string
): Promise<string> {
  return await sha256Hex(JSON.stringify({ language, policyVersion, prompt }));
}
