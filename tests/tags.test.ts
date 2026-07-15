import { describe, expect, test, mock } from "bun:test";

import { env } from "@config/env";
import {
  buildTagsPrompt,
  CAT_ENUM,
  combineAndCanon,
  stripJsonFence,
  summarizeTagsStructured,
} from "@utils/tags-extract";
import { canonicalize, slugify, heuristicTags } from "@utils/tags";

import type { OpenRouter } from "@utils/openrouter";
import type { NormalizedStory } from "@config/schemas";

describe("Tags extraction & canonicalization", () => {
  test("buildTagsPrompt includes domain and summaries when provided", () => {
    const story: Pick<NormalizedStory, "title" | "url"> = {
      title: "Test Story",
      url: "https://sub.example.com/x",
    };
    const postSummary = "This is the post summary.";
    const commentsSummary = "This is the comments summary.";

    const prompt = buildTagsPrompt(story, postSummary, commentsSummary);

    expect(prompt).toContain(`URL: ${story.url}`);
    expect(prompt).toContain("Domain: sub.example.com");
    expect(prompt).toContain(postSummary);
    expect(prompt).toContain(commentsSummary);
  });

  test("combineAndCanon merges LLM + heuristics, dedupes, keeps order", () => {
    const llm = [{ name: "react" }, { name: "Open AI" }, { name: "postgres" }];
    const title = "A story about OpenAI, ReactJS, and PostgreSQL";
    const domain = "github.com"; // for "github" heuristic tag

    const result = combineAndCanon({ llm, title, domain, max: 10 });

    expect(result).toEqual(["reactjs", "openai", "postgresql", "github"]);
  });

  test("slugify handles symbols and case consistently", () => {
    expect(slugify("C++/CLI & .NET")).toBe("c++-cli-.net");
    expect(slugify("  Web Assembly  ")).toBe("web-assembly");
    expect(slugify("don’t-test—me")).toBe("dont-test-me");
  });

  test("canonicalize applies aliases", () => {
    expect(canonicalize({ name: "JS" }).slug).toBe("javascript");
    expect(canonicalize({ name: "react" }).slug).toBe("reactjs");
    expect(canonicalize({ name: "psql" }).slug).toBe("postgresql");
  });

  test("heuristicTags domain detection and cap", () => {
    const domain = "github.com";
    const title =
      "Rust, Python, React, Docker, K8s, GraphQL, Redis, Postgres, Tailwind, Go, Swift, Kotlin, Elixir";
    const tags = heuristicTags(title, domain);

    expect(tags).toContain("github");
    expect(tags).toContain("rust");
    expect(tags).toContain("python");
    expect(tags).toContain("reactjs");
    expect(tags.length).toBeLessThanOrEqual(12);
  });

  test("summarizeTagsStructured falls back to JSON-mode and validates (negative)", async () => {
    const mockOr = {
      chatStructured: mock(async () => {
        throw new Error("Structured call failed");
      }),
      chat: mock(async () =>
        JSON.stringify({
          tags: [
            { name: "python", cat: "lang" },
            { name: "openai", cat: "company" },
          ],
        })
      ),
    } as unknown as OpenRouter;

    const result = await summarizeTagsStructured(mockOr, "prompt", env);

    expect(result).toEqual([
      { name: "python", cat: "lang" },
      { name: "openai", cat: "company" },
    ]);
    expect(mockOr.chatStructured).toHaveBeenCalledTimes(1);
    expect(mockOr.chat).toHaveBeenCalledTimes(1);
  });

  test("summarizeTagsStructured hard-bad JSON → error surfaced (negative)", () => {
    const mockOr = {
      chatStructured: mock(async () => {
        throw new Error("Structured call failed");
      }),
      chat: mock(async () => "not json"),
    } as unknown as OpenRouter;

    return expect(summarizeTagsStructured(mockOr, "prompt", env)).rejects.toThrow(
      "Failed to parse fallback JSON from LLM"
    );
  });

  test("cat enum + mapping hints appear in BOTH structured and fallback prompts", async () => {
    let structuredSystem = "";
    let fallbackSystem = "";
    const mockOr = {
      chatStructured: mock(async (messages: Array<{ role: string; content: string }>) => {
        structuredSystem = messages[0]?.content ?? "";
        throw new Error("force fallback");
      }),
      chat: mock(async (messages: Array<{ role: string; content: string }>) => {
        fallbackSystem = messages[0]?.content ?? "";
        return JSON.stringify({ tags: [{ name: "go", cat: "lang" }] });
      }),
    } as unknown as OpenRouter;

    await summarizeTagsStructured(mockOr, "prompt", env);

    const enumList = CAT_ENUM.join(", ");
    for (const content of [structuredSystem, fallbackSystem]) {
      expect(content).toContain(enumList);
      expect(content).toContain("programming language → lang");
      expect(content).toContain("library → lib");
    }
  });

  test("fallback tolerates a markdown ```json fence", async () => {
    const mockOr = {
      chatStructured: mock(async () => {
        throw new Error("Structured call failed");
      }),
      chat: mock(async () => '```json\n{"tags":[{"name":"go","cat":"lang"}]}\n```'),
    } as unknown as OpenRouter;

    const result = await summarizeTagsStructured(mockOr, "prompt", env);

    expect(result).toEqual([{ name: "go", cat: "lang" }]);
  });

  test("fallback coerces out-of-enum cat instead of throwing", async () => {
    const mockOr = {
      chatStructured: mock(async () => {
        throw new Error("Structured call failed");
      }),
      chat: mock(async () =>
        JSON.stringify({
          tags: [
            { name: "go", cat: "programming_language" }, // known alias → lang
            { name: "widget", cat: "totally_made_up" }, // unknown → undefined
          ],
        })
      ),
    } as unknown as OpenRouter;

    const result = await summarizeTagsStructured(mockOr, "prompt", env);

    expect(result).toEqual([
      { name: "go", cat: "lang" },
      { name: "widget", cat: undefined },
    ]);
  });

  test("stripJsonFence strips fences and passes plain JSON through", () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFence("```\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
    expect(stripJsonFence('  {"a":1}  ')).toBe('{"a":1}');
  });
});
