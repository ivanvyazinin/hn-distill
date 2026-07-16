import { describe, expect, test } from "bun:test";

import { parseEnv } from "../config/env";
import type { NormalizedStory } from "../config/schemas";
import type { HttpClient } from "../utils/http-client";
import { createUsageCollector } from "../utils/llm-usage";
import type { ChatMessage } from "../utils/openrouter";
import { makeServices, summarizeComments, summarizePost, type Services } from "../pipeline/summarize";
import { story as makeStory } from "./helpers";

// ── Collector unit behavior (R3: drop out-of-scope, stamp in-scope) ────────────
describe("createUsageCollector", () => {
  test("drops events recorded without an active story scope (R3)", () => {
    const usage = createUsageCollector();
    usage.record({ label: "post", gateway: "openrouter", modelRequested: "m", status: "ok" });
    expect(usage.size()).toBe(0);
    expect(usage.drain()).toEqual([]);
  });

  test("stamps storyId + createdAt while scoped, and drain clears the buffer", () => {
    const usage = createUsageCollector();
    usage.setStory(42);
    usage.record({ label: "post", gateway: "openrouter", modelRequested: "m", status: "ok", totalTokens: 10 });
    usage.record({ label: "comments", gateway: "groq", modelRequested: "n", status: "error" });
    expect(usage.size()).toBe(2);

    const rows = usage.drain();
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.storyId === 42 && typeof r.createdAt === "string")).toBeTrue();
    expect(rows.map((r) => r.label)).toEqual(["post", "comments"]);
    // Buffer emptied after drain.
    expect(usage.size()).toBe(0);
    expect(usage.drain()).toEqual([]);

    // Clearing scope drops subsequent records again.
    usage.setStory(undefined);
    usage.record({ label: "tags", gateway: "groq", modelRequested: "n", status: "ok" });
    expect(usage.size()).toBe(0);
  });
});

// ── Label attribution through the call chain (R1 / R7a) ─────────────────────────
function makeAttributionServices(): { services: Services; usage: ReturnType<typeof createUsageCollector> } {
  const usage = createUsageCollector();
  const chat = async (_messages: ChatMessage[], options?: { model?: string; label?: string }): Promise<string> => {
    // Mirror the real client: emit one usage event carrying the caller's label.
    usage.record({
      label: options?.label ?? "unknown",
      gateway: "openrouter",
      modelRequested: options?.model ?? "primary",
      status: "ok",
      totalTokens: 5,
    });
    return "- пункт один\n- пункт два\n- пункт три";
  };
  const orMock = { chat, chatStructured: async () => ({}) } as unknown as Services["openrouter"];
  const services = {
    http: {} as Services["http"],
    openrouter: orMock,
    guardTagsClient: orMock,
    fetchArticleMarkdown: async () => ({ md: "", sourceKind: "empty" as const }),
    usage,
  } as unknown as Services;
  return { services, usage };
}

describe("usage label attribution", () => {
  test("post is labeled 'post' and comments 'comments' — labels are not swapped", async () => {
    const { services, usage } = makeAttributionServices();
    const story = makeStory({ id: 7 }) as unknown as NormalizedStory;

    usage.setStory(7);
    await summarizePost(services, story, "some article slice");
    await summarizeComments(services, 7, "comments prompt");
    const rows = usage.drain();

    expect(rows.map((r) => r.label)).toEqual(["post", "comments"]);
    expect(rows.every((r) => r.storyId === 7)).toBeTrue();
  });
});

// ── makeServices flag gating (R4) + gateway assignment ─────────────────────────
function stubHttp(): HttpClient {
  return {
    json: async () => ({
      choices: [{ message: { role: "assistant", content: "hi" } }],
      model: "served-model",
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
  } as unknown as HttpClient;
}

describe("makeServices usage wiring", () => {
  test("flag ON wires the sink: openrouter→gateway 'openrouter', groq client→'groq'", async () => {
    const e = parseEnv({ LLM_USAGE_ENABLED: "true", OPENROUTER_API_KEY: "k", GROQ_API_KEY: "g" });
    const services = makeServices(e, { http: stubHttp() });
    services.usage.setStory(1);

    await services.openrouter.chat([{ role: "user", content: "x" }], { label: "post" });
    await services.guardTagsClient.chat([{ role: "user", content: "y" }], { label: "tags" });
    const rows = services.usage.drain();

    expect(rows.map((r) => [r.label, r.gateway, r.modelUsed, r.totalTokens])).toEqual([
      ["post", "openrouter", "served-model", 3],
      ["tags", "groq", "served-model", 3],
    ]);
  });

  test("flag OFF leaves the sink unwired: no usage recorded", async () => {
    const e = parseEnv({ LLM_USAGE_ENABLED: "false", OPENROUTER_API_KEY: "k", GROQ_API_KEY: "g" });
    const services = makeServices(e, { http: stubHttp() });
    services.usage.setStory(1);

    await services.openrouter.chat([{ role: "user", content: "x" }], { label: "post" });
    expect(services.usage.size()).toBe(0);
    expect(services.usage.drain()).toEqual([]);
  });
});
