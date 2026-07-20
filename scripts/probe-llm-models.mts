import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { env } from "@config/env";
import { CommentsInsightsJsonSchema, CommentsInsightsSchema } from "@config/schemas";
import { HttpClient } from "@utils/http-client";
import { OpenRouter, type ChatMessage, type JsonSchema, type StructuredOutputOptions } from "@utils/openrouter";
import { SummaryGuardSchema, SummaryGuardStrictJsonSchema } from "@utils/summary-guard";
import { TagsResponseSchema, TagsStrictJsonSchema } from "@utils/tags-extract";

export type ProbeRole = "comments-groq" | "comments-openrouter" | "guard" | "tags";
type ProbeProvider = "groq" | "openrouter";

export type ProbeResult = {
  role: ProbeRole;
  provider: ProbeProvider;
  model: string;
  latencyMs: number;
  result: string;
};

export type ProbeModels = {
  tags: string;
  guard: string;
  commentsGroq: string;
  commentsOpenRouter: string;
};

export type ProbeClients = {
  groq: OpenRouter;
  openrouter: OpenRouter;
};

type ProbeRoute = {
  role: ProbeRole;
  provider: ProbeProvider;
  model: string;
  request: () => Promise<unknown>;
};

/** Insight kinds required by CommentsInsightsSchema — keep in the probe prompt or models invent free-form kinds. */
export const PROBE_COMMENTS_INSIGHT_KINDS = ["consensus", "dispute", "advice"] as const;

export const COMMENTS_MESSAGES: ChatMessage[] = [
  {
    role: "system",
    content:
      'Return only a JSON object. Required keys: bottom_line (string >= 20 chars), insights (non-empty array of {kind,text}), best_quote (null). kind must be one of: "consensus", "dispute", "advice". insight text >= 20 chars.',
  },
  {
    role: "user",
    content:
      'Synthetic probe, not an article. Example shape: {"bottom_line":"The thread adds a clear operational caveat about rollout risk.","insights":[{"kind":"consensus","text":"Operators agree the migration needs a staged canary before full cutover."}],"best_quote":null}',
  },
];

const TAGS_MESSAGES: ChatMessage[] = [
  {
    role: "system",
    content: "Return only a JSON object that conforms to the supplied schema.",
  },
  {
    role: "user",
    content: "This is a synthetic probe. Return an empty tags array.",
  },
];

const GUARD_MESSAGES: ChatMessage[] = [
  {
    role: "system",
    content: "Return only a JSON object that conforms to the supplied schema.",
  },
  {
    role: "user",
    content:
      "This is a synthetic probe. Return ok true, is_article true, refusal false, verdict ok, an empty reasons array, and confidence 1.",
  },
];

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
}

function isSafeSummaryCharacter(character: string): boolean {
  return character === "." || character === "/" || character === ":" || character === "@" || character === "-" || /\w/u.test(character);
}

function safeSummaryCell(value: string): string {
  return [...value]
    .map((character) => (isSafeSummaryCharacter(character) ? character : "_"))
    .join("")
    .slice(0, 200);
}

/** Format the only data allowed in the GitHub Actions Job Summary. */
export function formatProbeSummary(results: ProbeResult[]): string {
  const rows = results.map(
    ({ role, provider, model, latencyMs, result }) =>
      `| ${role} | ${provider} | ${safeSummaryCell(model)} | ${latencyMs} | ${safeSummaryCell(result)} |`
  );
  return [
    "## LLM model probe",
    "",
    "| role | provider | model | latency_ms | result |",
    "| --- | --- | --- | ---: | --- |",
    ...rows,
    "",
  ].join("\n");
}

async function runRoute(route: ProbeRoute, attempts: number): Promise<ProbeResult> {
  let successes = 0;
  let totalLatencyMs = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      await route.request();
      successes += 1;
    } catch {
      // Errors deliberately stay out of stdout and Job Summary: upstream bodies can
      // contain prompts or other sensitive provider diagnostics.
    } finally {
      totalLatencyMs += elapsedMs(startedAt);
    }
  }

  return {
    role: route.role,
    provider: route.provider,
    model: route.model,
    latencyMs: Math.round(totalLatencyMs / attempts),
    result: successes === attempts ? "pass" : `fail_${successes}_of_${attempts}`,
  };
}

/** Execute each selected provider/role route without reading or writing pipeline data. */
export async function runLlmModelProbes(
  clients: ProbeClients,
  models: ProbeModels,
  // eslint-disable-next-line @typescript-eslint/typedef -- inferred from the default.
  attempts = 1
): Promise<ProbeResult[]> {
  const requestTimeoutMs = env.COMMENTS_LLM_REQUEST_TIMEOUT_MS;
  const commentsOptions: Pick<
    StructuredOutputOptions,
    "maxTokens" | "requestTimeoutMs" | "temperature" | "transportRetries"
  > = {
    temperature: 0,
    maxTokens: Math.min(env.COMMENTS_SUMMARY_MAX_TOKENS, 512),
    transportRetries: 0,
    requestTimeoutMs,
  };
  const routes: ProbeRoute[] = [
    {
      role: "tags",
      provider: "groq",
      model: models.tags,
      request: async () =>
        await clients.groq.chatStructured(
          TAGS_MESSAGES,
          {
            temperature: 0,
            maxTokens: Math.min(env.TAGS_MAX_TOKENS, 128),
            model: models.tags,
            label: "tags",
            transportRetries: 0,
            requestTimeoutMs,
            responseFormat: {
              type: "json_schema",
              json_schema: { name: "tags_extraction", strict: true, schema: TagsStrictJsonSchema },
            },
          },
          TagsResponseSchema(env.TAGS_MAX_PER_STORY),
          1
        ),
    },
    {
      role: "guard",
      provider: "groq",
      model: models.guard,
      request: async () =>
        await clients.groq.chatStructured(
          GUARD_MESSAGES,
          {
            temperature: 0,
            maxTokens: Math.min(env.POST_GUARD_MAX_TOKENS, 128),
            model: models.guard,
            label: "guard",
            transportRetries: 0,
            requestTimeoutMs,
            responseFormat: {
              type: "json_schema",
              json_schema: { name: "summary_guard", strict: true, schema: SummaryGuardStrictJsonSchema },
            },
          },
          SummaryGuardSchema,
          1
        ),
    },
    {
      role: "comments-groq",
      provider: "groq",
      model: models.commentsGroq,
      request: async () =>
        await clients.groq.chatStructured(
          COMMENTS_MESSAGES,
          {
            ...commentsOptions,
            model: models.commentsGroq,
            label: "comments",
            jsonExtraction: "balanced-object",
          },
          CommentsInsightsSchema,
          1
        ),
    },
    {
      role: "comments-openrouter",
      provider: "openrouter",
      model: models.commentsOpenRouter,
      request: async () =>
        await clients.openrouter.chatStructured(
          COMMENTS_MESSAGES,
          {
            ...commentsOptions,
            model: models.commentsOpenRouter,
            label: "comments",
            jsonExtraction: "strict",
            responseFormat: {
              type: "json_schema",
              json_schema: {
                name: "comments_insights_v2",
                strict: true,
                schema: CommentsInsightsJsonSchema as unknown as JsonSchema,
              },
            },
          },
          CommentsInsightsSchema,
          1
        ),
    },
  ];

  return await Promise.all(routes.map(async (route) => await runRoute(route, attempts)));
}

function requiredInput(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function probeAttempts(): number {
  const raw = process.env["PROBE_ATTEMPTS"] ?? "1";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
    throw new Error("PROBE_ATTEMPTS must be an integer from 1 through 3");
  }
  return parsed;
}

async function appendJobSummary(results: ProbeResult[]): Promise<void> {
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath === undefined || summaryPath.length === 0) {
    return;
  }
  await appendFile(summaryPath, formatProbeSummary(results), "utf8");
}

async function main(): Promise<void> {
  const http = new HttpClient(
    {
      retries: 0,
      baseBackoffMs: 0,
      timeoutMs: env.COMMENTS_LLM_REQUEST_TIMEOUT_MS,
      retryOnStatuses: [],
    },
    { headers: {} }
  );
  const clients: ProbeClients = {
    groq: new OpenRouter(http, env.GROQ_API_KEY ?? "", "unused", env.GROQ_BASE_URL, { gateway: "groq" }),
    openrouter: new OpenRouter(http, env.OPENROUTER_API_KEY ?? "", "unused", env.OPENROUTER_BASE_URL),
  };
  const results = await runLlmModelProbes(
    clients,
    {
      tags: requiredInput("PROBE_TAGS_MODEL"),
      guard: requiredInput("PROBE_GUARD_MODEL"),
      commentsGroq: requiredInput("PROBE_COMMENTS_GROQ_MODEL"),
      commentsOpenRouter: requiredInput("PROBE_COMMENTS_OPENROUTER_MODEL"),
    },
    probeAttempts()
  );
  await appendJobSummary(results);
  if (results.some((result) => result.result !== "pass")) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch(() => {
    // The Job Summary intentionally contains the complete safe diagnostic surface.
    process.exitCode = 1;
  });
}
