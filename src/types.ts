/** FIM token delimiters for manual token embedding. */
export interface FimTokens {
  prefix: string;
  suffix: string;
  middle: string;
}

/**
 * `true`: server-managed FIM (Ollama, LM Studio).
 *   Sends `suffix` as a separate request field; server applies its own FIM template.
 *
 * `{ prefix, suffix, middle }`: manual token embedding (vLLM, llama.cpp).
 *   Embeds FIM tokens directly into the prompt string.
 */
export type FimConfig = true | FimTokens;
export type RequestMode = "chat" | "completion" | "fim";

/** Resolved configuration for a completion request. */
export interface AutocompleteConfig {
  /** OpenAI-compatible API base URL (e.g. `http://localhost:11434/v1`). */
  readonly endpoint: string;
  /** Model identifier (e.g. `qwen2.5-coder:1.5b`). */
  readonly model: string;
  /** Bearer token for authenticated endpoints. */
  readonly apiKey?: string;
  /** Maximum tokens in the completion response. */
  readonly maxTokens: number;
  /** Sampling temperature (0 = deterministic). */
  readonly temperature: number;
  /** Sequences that terminate generation. */
  readonly stop: string[];
  /**
   * Resolved FIM configuration. Present only when `requestMode === "fim"`.
   * Set by {@link getConfig} for explicit modes, or by auto-detection when
   * `fimMode` is `"auto"`.
   */
  fim?: FimConfig;
  /** Resolved request path for the current model. */
  requestMode: RequestMode;
  /** Raw setting value. Determines how `fim` is resolved. */
  readonly fimMode: "auto" | "custom" | "off" | "server-managed";
  /** Milliseconds to wait after the last keystroke before requesting. */
  readonly debounceMs: number;
  /** Lines of context around the cursor (nominal 60/40 prefix/suffix, rebalanced near boundaries). */
  readonly contextLines: number;
  /** System prompt for chat completions. Empty string uses the built-in default. */
  readonly systemPrompt: string;
  /** Custom User-Agent header, or `null` to omit. */
  readonly userAgent: string | null;
}

export const CONFIG_DEFAULTS = {
  endpoint: "http://localhost:11434/v1",
  maxTokens: 256,
  temperature: 0.2,
  stop: ["\n\n"],
  debounceMs: 300,
  contextLines: 100,
  systemPrompt: "",
} satisfies Partial<AutocompleteConfig>;

/** A single message in a chat completion request. */
export interface ChatMessage {
  readonly role: "assistant" | "system" | "user";
  readonly content: string;
}

/** A single choice returned by the completion API. */
export interface CompletionChoice {
  /** Returned by `/completions` (FIM). */
  readonly text?: string;
  /** Returned by `/chat/completions`. */
  readonly message?: { content: string };
  readonly finish_reason: string | null;
}

/** Response shape shared by `/completions` and `/chat/completions`. */
export interface CompletionResponse {
  readonly choices: readonly CompletionChoice[];
}
