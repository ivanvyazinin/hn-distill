/**
 * Curated candidates for offline article-summary scoring.
 *
 * A candidate is either:
 *  - a plain string → an OpenRouter slug (label === model, key === OPENROUTER_API_KEY), or
 *  - a CandidateSpec → an explicit provider (any OpenAI-compatible /chat/completions endpoint).
 *
 * OpenRouter slugs verified against GET /api/v1/models (ids ending in :free) — refresh when
 * bench shows mass 404. Retired: x-ai/grok-4.1-fast:free, xiaomi/mimo-v2-flash:free,
 * mistralai/devstral-2512:free, z-ai/glm-4.5-air:free, tngtech/deepseek-r1t2-chimera:free.
 */

/**
 * Local 9Router gateway (OpenAI-compatible, no auth). Fronts multiple providers:
 * xAI Grok (`xai/…`) and Groq (`groq/…`). List live models via `GET /v1/models`.
 */
export const NINEROUTER_BASE_URL = "http://localhost:20128/v1/chat/completions";

export type CandidateSpec = {
  /** Unique display id used as the leaderboard key (e.g. "groq:llama-3.3-70b-versatile"). */
  label: string;
  /** Model id sent to the provider. */
  model: string;
  /** OpenAI-compatible chat/completions URL. Omit → OpenRouter. */
  baseUrl?: string;
  /** process.env var holding the provider key. Omit → OPENROUTER_API_KEY (or none for keyless gateways). */
  apiKeyEnv?: string;
};

export const MODELS_UNDER_TEST: ReadonlyArray<CandidateSpec | string> = [
  // --- OpenRouter free slugs ---
  // NB: "openrouter/free" removed — it's an auto-router (picks a different :free model per call),
  // so it's non-deterministic and not a valid single-model benchmark subject.
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "qwen/qwen3-coder:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-20b:free",
  "openai/gpt-oss-120b:free",

  // --- 9Router (local gateway, keyless) — xAI Grok ---
  // On this 9Router, xai/grok-4, xai/grok-4-fast-reasoning and xai/grok-3 all remap to grok-4.3,
  // xai/grok-4.5 is 403, and grok-code-fast-1 / grok-composer-2.5-fast are coding models (not
  // summarizers) → grok-4.3 is the only distinct usable xAI summarizer here.
  { label: "9router:grok-4.3", model: "xai/grok-4.3", baseUrl: NINEROUTER_BASE_URL },

  // --- Groq via 9Router (keyless; ids from `GET /v1/models`, groq/ prefix) ---
  { label: "groq:llama-3.3-70b-versatile", model: "groq/llama-3.3-70b-versatile", baseUrl: NINEROUTER_BASE_URL },
  { label: "groq:qwen3-32b", model: "groq/qwen/qwen3-32b", baseUrl: NINEROUTER_BASE_URL },
  { label: "groq:gpt-oss-120b", model: "groq/openai/gpt-oss-120b", baseUrl: NINEROUTER_BASE_URL },
  // Note: groq/meta-llama/llama-4-maverick-17b-128e-instruct is listed by 9Router's /v1/models
  // but 404s on call (not provisioned) — re-add if it becomes available.
];

/** Normalize a candidate entry (string → OpenRouter CandidateSpec). */
export function normalizeCandidate(candidate: CandidateSpec | string): CandidateSpec {
  return typeof candidate === "string" ? { label: candidate, model: candidate } : candidate;
}

/** All candidates as CandidateSpec, deduplicated by label (first-seen wins). */
export function resolveCandidates(): CandidateSpec[] {
  const seen = new Set<string>();
  const out: CandidateSpec[] = [];
  for (const entry of MODELS_UNDER_TEST) {
    const spec = normalizeCandidate(entry);
    if (!seen.has(spec.label)) {
      seen.add(spec.label);
      out.push(spec);
    }
  }
  return out;
}

/**
 * Resolve CLI --models names. Matches a known candidate by label or model id; an unknown
 * name is treated as a bare OpenRouter slug so ad-hoc models still work.
 */
export function selectCandidates(names: string[]): CandidateSpec[] {
  const all = resolveCandidates();
  const byLabel = new Map(all.map((c) => [c.label, c]));
  const byModel = new Map(all.map((c) => [c.model, c]));
  return names.map((name) => byLabel.get(name) ?? byModel.get(name) ?? { label: name, model: name });
}
