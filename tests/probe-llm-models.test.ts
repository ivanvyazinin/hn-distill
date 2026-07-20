import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import type { HttpClient, SafeRequestInit } from "../utils/http-client.ts";
import { OpenRouter } from "../utils/openrouter.ts";
import {
  COMMENTS_MESSAGES,
  formatProbeSummary,
  PROBE_COMMENTS_INSIGHT_KINDS,
  runLlmModelProbes,
  type ProbeClients,
  type ProbeModels,
} from "../scripts/probe-llm-models.mts";

type RequestBody = {
  model: string;
  response_format?: unknown;
};

const models: ProbeModels = {
  tags: "groq-tags",
  guard: "groq-guard",
  commentsGroq: "groq-comments",
  commentsOpenRouter: "openrouter-comments",
};

const commentsResponse = {
  bottom_line: "Synthetic probe response is valid.",
  insights: [{ kind: "consensus", text: "This synthetic insight is long enough." }],
  best_quote: null,
};

function responseFor(model: string): unknown {
  switch (model) {
    case models.tags:
      return { tags: [] };
    case models.guard:
      return { ok: true, is_article: true, refusal: false, verdict: "ok", reasons: [], confidence: 1 };
    default:
      return commentsResponse;
  }
}

function makeClients(requests: RequestBody[]): ProbeClients {
  const http = {
    json: async <T>(_url: string, init?: SafeRequestInit): Promise<T> => {
      if (typeof init?.body !== "string") {
        throw new TypeError("Expected string request body");
      }
      const body = JSON.parse(init.body) as RequestBody;
      requests.push(body);
      return {
        choices: [{ message: { role: "assistant", content: JSON.stringify(responseFor(body.model)) } }],
      } as T;
    },
  } as unknown as HttpClient;

  return {
    groq: new OpenRouter(http, "groq-test-key", "unused", "https://groq.test/chat", { gateway: "groq" }),
    openrouter: new OpenRouter(http, "openrouter-test-key", "unused", "https://openrouter.test/chat"),
  };
}

describe("LLM model probe", () => {
  test("uses production schemas and extraction modes for every route", async () => {
    const requests: RequestBody[] = [];
    const results = await runLlmModelProbes(makeClients(requests), models);

    expect(results.map((result) => result.result)).toEqual(["pass", "pass", "pass", "pass"]);
    expect(requests.length).toBe(4);

    const byModel = new Map(requests.map((request) => [request.model, request]));
    const tagsFormat = byModel.get(models.tags)?.response_format as
      | { type: string; json_schema: { name: string; strict: boolean; schema: { type: string; required: string[] } } }
      | undefined;
    expect(tagsFormat?.type).toBe("json_schema");
    expect(tagsFormat?.json_schema.name).toBe("tags_extraction");
    expect(tagsFormat?.json_schema.strict).toBeTrue();
    expect(tagsFormat?.json_schema.schema.type).toBe("object");
    expect(tagsFormat?.json_schema.schema.required).toEqual(["tags"]);

    const guardFormat = byModel.get(models.guard)?.response_format as
      | { type: string; json_schema: { name: string; strict: boolean; schema: { type: string; required: string[] } } }
      | undefined;
    expect(guardFormat?.type).toBe("json_schema");
    expect(guardFormat?.json_schema.name).toBe("summary_guard");
    expect(guardFormat?.json_schema.strict).toBeTrue();
    expect(guardFormat?.json_schema.schema.type).toBe("object");
    expect(guardFormat?.json_schema.schema.required).toEqual([
      "ok",
      "is_article",
      "refusal",
      "verdict",
      "reasons",
      "confidence",
    ]);

    expect(byModel.get(models.commentsGroq)?.response_format).toBeUndefined();

    const commentsFormat = byModel.get(models.commentsOpenRouter)?.response_format as
      | { type: string; json_schema: { name: string; strict: boolean; schema: { type: string; required: string[] } } }
      | undefined;
    expect(commentsFormat?.type).toBe("json_schema");
    expect(commentsFormat?.json_schema.name).toBe("comments_insights_v2");
    expect(commentsFormat?.json_schema.strict).toBeTrue();
    expect(commentsFormat?.json_schema.schema.type).toBe("object");
    expect(commentsFormat?.json_schema.schema.required).toEqual(["bottom_line", "insights", "best_quote"]);
  });

  test("summary contains only the permitted fields and no failure details", () => {
    const summary = formatProbeSummary([
      {
        role: "tags",
        provider: "groq",
        model: "model|with\nmarkdown",
        latencyMs: 7,
        result: "fail_0_of_1",
      },
    ]);

    expect(summary).toContain("| tags | groq | model_with_markdown | 7 | fail_0_of_1 |");
    expect(summary).not.toContain("API key");
    expect(summary).not.toContain("prompt");
    expect(summary).not.toContain("article");
  });

  test("comments probe prompt pins the CommentsInsights kind enum", () => {
    const prompt = COMMENTS_MESSAGES.map((message) => message.content).join("\n");
    for (const kind of PROBE_COMMENTS_INSIGHT_KINDS) {
      expect(prompt).toContain(`"${kind}"`);
    }
    expect(prompt).toContain("kind must be one of");
  });

  test("failed probe routes stay quiet under LOG_LEVEL=silent", () => {
    // Child process: env.LOG_LEVEL is fixed at module load; workflow sets silent.
    const script = `
      import { OpenRouter } from "./utils/openrouter.ts";
      import { runLlmModelProbes } from "./scripts/probe-llm-models.mts";
      const http = {
        json: async () => {
          throw new Error('HTTP 404 {"error":{"message":"The model secret-model does not exist","code":"model_not_found"}}');
        },
      };
      const clients = {
        groq: new OpenRouter(http, "k", "u", "https://groq.test/chat", { gateway: "groq" }),
        openrouter: new OpenRouter(http, "k", "u", "https://openrouter.test/chat"),
      };
      const results = await runLlmModelProbes(clients, {
        tags: "t", guard: "g", commentsGroq: "c", commentsOpenRouter: "o",
      });
      if (!results.every((r) => r.result.startsWith("fail_"))) process.exit(2);
    `;
    const result = spawnSync("bun", ["-e", script], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, LOG_LEVEL: "silent" },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const joined = `${result.stdout}\n${result.stderr}`;
    expect(joined).not.toContain("model_not_found");
    expect(joined).not.toContain("secret-model");
    expect(joined).not.toContain("HTTP 404");
    expect(joined).not.toContain("openrouter");
  });
});
