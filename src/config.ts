/**
 * Configuration reading and FIM auto-detection.
 *
 * All settings are read from `vscode.workspace.getConfiguration("autocomplete")`,
 * scoped to the document’s workspace folder.
 */
import * as vscode from "vscode";

import * as log from "./log.ts";
import type { AutocompleteConfig, FimConfig } from "./types.ts";

/** Maps each `autocomplete.*` setting key to its TypeScript type. */
interface SettingsMap {
  readonly enable: boolean;
  readonly debug: boolean;
  readonly endpoint: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly stop: string[];
  readonly "fim.mode": string;
  readonly "fim.prefix": string;
  readonly "fim.suffix": string;
  readonly "fim.middle": string;
  readonly userAgent: string | null;
  readonly debounceMs: number;
  readonly contextLines: number;
  readonly systemPrompt: string;
}

const SECRET_KEY = "autocomplete.apiKey";
let secrets: vscode.SecretStorage | undefined;

/** Initialize secret storage (called once from activate). */
export function initSecrets(storage: vscode.SecretStorage): void {
  secrets = storage;
}

/** Read the API key from VS Code SecretStorage. */
export async function getApiKey(): Promise<string | undefined> {
  const key = await secrets?.get(SECRET_KEY);
  return key || undefined;
}

/** Store the API key in VS Code SecretStorage. */
export async function setApiKey(value: string): Promise<void> {
  await secrets?.store(SECRET_KEY, value);
}

/** Delete the API key from VS Code SecretStorage. */
export async function clearApiKey(): Promise<void> {
  await secrets?.delete(SECRET_KEY);
}

/** Read a single `autocomplete.*` setting with full type safety. */
export function getSetting<K extends keyof SettingsMap>(key: K): SettingsMap[K] {
  return vscode.workspace.getConfiguration("autocomplete").get(key) as SettingsMap[K];
}

/** Shared HTTP headers for all outgoing requests. */
export function defaultHeaders(): Record<string, string> {
  const ua = getSetting("userAgent");
  return ua !== null ? { "User-Agent": ua } : {};
}

/** Default headers plus an optional `Authorization` bearer token. */
export function getAuthHeaders(apiKey?: string): Record<string, string> {
  const headers = defaultHeaders();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Read the autocomplete configuration scoped to the given document.
 * Returns `undefined` if `model` is not set (extension stays dormant).
 *
 * @param apiKey Pre-fetched API key from SecretStorage (caller resolves it
 *   once per completion request to avoid repeated async calls).
 */
export function getConfig(
  document: vscode.TextDocument,
  apiKey?: string
): AutocompleteConfig | undefined {
  const cfg = vscode.workspace.getConfiguration("autocomplete", document.uri);
  const get = <K extends keyof SettingsMap>(key: K) => cfg.get(key) as SettingsMap[K];

  if (!get("enable")) return;

  const endpoint = get("endpoint");
  const model = get("model");
  if (!model) return;

  const fimMode = get("fim.mode");
  let fim: FimConfig | undefined;
  if (fimMode === "server-managed") {
    fim = true;
  } else if (fimMode === "custom") {
    const prefix = get("fim.prefix");
    const suffix = get("fim.suffix");
    const middle = get("fim.middle");
    if (prefix && suffix && middle) {
      fim = { prefix, suffix, middle };
    }
  }

  const userAgent = get("userAgent");

  return {
    endpoint,
    model,
    apiKey,
    maxTokens: get("maxTokens"),
    temperature: get("temperature"),
    stop: get("stop"),
    // "auto" and "off" → fim stays undefined (auto is resolved later by detectFimSupport)
    fim,
    fimMode: fimMode as AutocompleteConfig["fimMode"],
    debounceMs: get("debounceMs"),
    contextLines: get("contextLines"),
    systemPrompt: get("systemPrompt"),
    userAgent,
  };
}

// Ollama detection

/** Cache keyed by endpoint base URL. */
const ollamaCache = new Map<string, boolean>();
/** Short-lived negative cache to avoid re-probing endpoints returning non-2xx. */
const ollamaNegativeCache = new Map<string, number>();
/** How long (ms) to suppress re-probes after a non-OK response. */
const NEGATIVE_CACHE_TTL_MS = 30_000;

/**
 * Detect whether the given endpoint is an Ollama server by probing `GET /`
 * for the `"Ollama is running"` response. Results are cached per endpoint.
 */
export async function isOllamaServer(
  endpoint: string,
  apiKey?: string
): Promise<boolean> {
  const cacheKey = apiKey ? `${endpoint}::${apiKey}` : endpoint;
  const cached = ollamaCache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Short-lived negative cache: avoid re-probing after recent non-OK responses
  const negExpiry = ollamaNegativeCache.get(cacheKey);
  if (negExpiry !== undefined && Date.now() < negExpiry) return false;

  try {
    const base = endpoint.replace(/\/v1\/?$/, "");
    const res = await fetch(base, {
      headers: getAuthHeaders(apiKey),
      signal: AbortSignal.timeout(3000),
    });
    // Only cache on successful (2xx) responses. Transient errors like
    // 401/502/503 should not permanently mark an endpoint as non-Ollama.
    if (!res.ok) {
      ollamaNegativeCache.set(cacheKey, Date.now() + NEGATIVE_CACHE_TTL_MS);
      return false;
    }

    const text = await res.text();
    const isOllama = text.includes("Ollama is running");
    ollamaCache.set(cacheKey, isOllama);
    return isOllama;
  } catch {
    // Short-lived negative cache for network errors too
    ollamaNegativeCache.set(cacheKey, Date.now() + NEGATIVE_CACHE_TTL_MS);
    return false;
  }
}

// FIM auto-detection

/** Cache keyed by `endpoint::model`. `false` means "probed, no FIM support". */
const fimCache = new Map<string, false | FimConfig>();

/**
 * Probe the server to determine if the model supports FIM.
 *
 * For Ollama servers, calls `/api/show` and checks for the `"insert"` capability.
 * For non-Ollama servers, skips the probe and returns `undefined` immediately.
 * Results are cached per endpoint+model pair.
 */
export async function detectFimSupport(
  endpoint: string,
  model: string,
  apiKey?: string
): Promise<FimConfig | undefined> {
  const key = apiKey ? `${endpoint}::${model}::${apiKey}` : `${endpoint}::${model}`;
  const cached = fimCache.get(key);
  if (cached !== undefined) return cached || undefined;

  if (!(await isOllamaServer(endpoint, apiKey))) {
    // Don’t cache. `isOllamaServer` may have returned false due to a transient
    // network error. Its own cache handles confirmed non-Ollama results.
    log.info(`Non-Ollama server at ${endpoint}, skipping FIM detection for ${model}`);
    return;
  }

  try {
    const base = endpoint.replace(/\/v1\/?$/, "");
    const response = await fetch(`${base}/api/show`, {
      method: "POST",
      headers: { ...getAuthHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      // Transient HTTP errors (401/429/500/startup race). Don’t cache,
      // retry on next request.
      log.info(`FIM detection got HTTP ${response.status} for ${model}, will retry`);
      return;
    }

    const data = (await response.json()) as {
      capabilities?: readonly string[];
    };
    if (Array.isArray(data.capabilities) && data.capabilities.includes("insert")) {
      log.info(`Auto-detected FIM support for ${model}`);
      fimCache.set(key, true);
      return true;
    }

    // Successful probe explicitly reports no insert capability, safe to cache.
    log.info(`No FIM support detected for ${model}, using chat mode`);
    fimCache.set(key, false);
    return;
  } catch {
    // Don’t cache network errors. Retry on next request
    log.info(`FIM detection failed for ${model} (network error), will retry`);
    return;
  }
}

/** Clear all server detection and FIM caches (called when settings change). */
export function clearServerCaches(): void {
  ollamaCache.clear();
  ollamaNegativeCache.clear();
  fimCache.clear();
}
