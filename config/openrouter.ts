/** Tag extraction fallbacks when structured output fails on the primary TAGS_MODEL. */
export const TAGS_FALLBACK_MODELS = [
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
] as const;