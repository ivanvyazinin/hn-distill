/**
 * Tag extraction fallbacks when structured output fails on the primary TAGS_MODEL.
 * Free slugs verified live via OpenRouter /models on 2026-08-25; most :free slugs
 * from the previous list (nemotron, llama-3.3-70b, qwen3-next) already 404.
 */
export const TAGS_FALLBACK_MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
] as const;