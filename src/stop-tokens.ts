/**
 * Per-model stop token registry.
 *
 * Different model families use different sentinel tokens to signal the end of
 * a FIM completion. When these are not in the stop list, models generate past
 * completion boundaries.
 */

/** Known model families and their FIM sentinel tokens. */
const MODEL_STOP_TOKENS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly tokens: readonly string[];
}> = [
  {
    pattern: /starcoder/i,
    tokens: ["<|endoftext|>"],
  },
  {
    pattern: /deepseek/i,
    tokens: ["<|eos_token|>", "<\uFF5Cend\u2581of\u2581sentence\uFF5C>"],
  },
  {
    pattern: /codellama/i,
    tokens: ["<|endoftext|>", "\x04"],
  },
  {
    pattern: /qwen/i,
    tokens: ["<|endoftext|>", "<|fim_pad|>"],
  },
  {
    pattern: /codestral/i,
    tokens: ["[SUFFIX]"],
  },
  {
    pattern: /codegemma/i,
    tokens: ["<|file_separator|>"],
  },
];

/**
 * Return stop tokens for a given model identifier.
 *
 * Performs case-insensitive substring matching against known model families.
 * Returns an empty array for unrecognized models.
 *
 * @param modelId Model name or ID (e.g. `"qwen2.5-coder:1.5b"`, `"deepseek-coder"`)
 */
export function getModelStopTokens(modelId: string): readonly string[] {
  for (const { pattern, tokens } of MODEL_STOP_TOKENS) {
    if (pattern.test(modelId)) {
      return tokens;
    }
  }
  return [];
}

/**
 * Merge user-configured stop tokens with model-specific sentinels.
 *
 * Deduplicates and appends model stops after user stops. User stops take
 * priority (appear first) to preserve any ordering intent.
 *
 * @param userStops Stop tokens from the user’s `autocomplete.stop` setting
 * @param modelId Model name used to look up model-family sentinels
 */
export function mergeStopTokens(userStops: string[], modelId: string): string[] {
  const modelStops = getModelStopTokens(modelId);
  if (modelStops.length === 0) return userStops;

  const seen = new Set(userStops);
  const merged = [...userStops];
  for (const token of modelStops) {
    if (!seen.has(token)) {
      merged.push(token);
    }
  }
  return merged;
}
