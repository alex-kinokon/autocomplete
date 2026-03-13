/**
 * API request layer.
 *
 * Supports three request modes:
 * - FIM (`/completions`): sends prefix and suffix separately or with
 *   embedded tokens, depending on the FIM configuration.
 * - Plain completion (`/completions`): sends only the prefix as a raw prompt.
 * - Chat (`/chat/completions`): falls back to a system-prompted chat
 *   completion when FIM is not available.
 */
import type { ChatCompletionCreateParamsBase } from "openai/resources/chat/completions";
import type { CompletionCreateParamsNonStreaming } from "openai/resources/completions";

import type { DocumentContext, RelatedSnippet } from "./context.ts";
import { commentPrefix } from "./context.ts";
import * as log from "./log.ts";
import { postProcessCompletion } from "./post-process.ts";
import { mergeStopTokens } from "./stop-tokens.ts";
import type { AutocompleteConfig, CompletionResponse } from "./types.ts";

const DEFAULT_SYSTEM_PROMPT = [
  "You are a code completion engine.",
  "Continue the code from where the prefix ends.",
  "Output ONLY the raw code to insert.",
  "NEVER output explanations, comments about the code, conversational text, or markdown.",
  "Do not repeat existing code.",
  "Match the indentation and style.",
  "If unsure, output nothing.",
].join(" ");

const quote = JSON.stringify;

/** Thrown when the server reports the requested model does not exist. */
export class ModelNotFoundError extends Error {
  override name = "ModelNotFoundError";
  constructor(readonly model: string) {
    super(`Model "${model}" not found`);
  }
}

/** Thrown when the model cannot be loaded (out of memory, too large, etc.). */
// eslint-disable-next-line unicorn/custom-error-definition -- https://github.com/sindresorhus/eslint-plugin-unicorn/issues/1993
export class ModelLoadError extends Error {
  override name = "ModelLoadError";
}

/** Thrown when the server is overloaded. */
// eslint-disable-next-line unicorn/custom-error-definition
export class ServerBusyError extends Error {
  override name = "ServerBusyError";
}

/** Thrown when the model does not support the requested mode (chat or generate). */
export class UnsupportedModeError extends Error {
  override name = "UnsupportedModeError";
  constructor(
    readonly model: string,
    readonly mode: string
  ) {
    super(`Model "${model}" does not support ${mode}`);
  }
}

/** Dispatch a completion request using the resolved model request mode. */
export async function requestCompletion(
  config: AutocompleteConfig,
  context: DocumentContext,
  signal: AbortSignal
): Promise<string | undefined> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.userAgent != null) {
    headers["User-Agent"] = config.userAgent;
  }
  if (config.apiKey != null) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  if (config.requestMode === "fim") {
    return requestFimCompletion(config, context, headers, signal);
  }

  if (config.requestMode === "completion") {
    return requestPlainCompletion(config, context, headers, signal);
  }

  return requestChatCompletion(config, context, headers, signal);
}

function buildCompletionPreamble(context: DocumentContext): string {
  const comment = commentPrefix(context.languageId);
  let preamble = `${comment} Path: ${context.relativePath}\n`;
  if (context.relatedSnippets.length > 0) {
    preamble += formatSnippetsAsComments(context.relatedSnippets, comment);
  }
  return preamble;
}

async function requestPlainCompletion(
  config: AutocompleteConfig,
  context: DocumentContext,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<string | undefined> {
  const { endpoint, model, maxTokens, temperature } = config;
  const stop = mergeStopTokens(config.stop, model);
  const preamble = buildCompletionPreamble(context);
  const url = `${normalizeEndpoint(endpoint)}/completions`;
  const { relatedSnippets, prefix } = context;
  const body: CompletionCreateParamsNonStreaming = {
    model,
    prompt: preamble + prefix,
    max_tokens: maxTokens,
    temperature,
    stop,
    stream: false,
  };

  log.debug(`Completion mode: plain`);
  log.debug(`Preamble:\n${preamble}`);
  log.debug(`Prefix (${prefix.length} chars):\n${prefix}`);
  log.debug(
    `Related snippets: ${relatedSnippets.length} files: [${relatedSnippets.map(s => s.relativePath).join(", ")}]`
  );
  log.debug(`Completion request URL: ${url}`);
  log.debug(`Completion request body:\n${JSON.stringify(body, null, 2)}`);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log.error(`Completion request failed: ${response.status}`, text);
    throwApiError(response.status, text, model);
  }

  let data: Partial<CompletionResponse>;
  try {
    data = (await response.json()) as Partial<CompletionResponse>;
  } catch {
    log.error("Completion response is not valid JSON");
    return;
  }
  log.debug(`Completion raw response:\n${JSON.stringify(data, null, 2)}`);

  const raw = data.choices?.[0]?.text;
  if (!raw) return;

  log.debug(`Completion raw text: ${JSON.stringify(raw)}`);

  const cleaned = postProcessCompletion(cleanCompletion(raw), context);
  log.debug(`Completion cleaned text: ${JSON.stringify(cleaned)}`);

  return cleaned || undefined;
}

// FIM mode (/completions)

/**
 * Request a FIM completion.
 *
 * Builds a preamble with the file path and related snippets (as comments),
 * then sends either:
 * - Server-managed (`fim === true`): `prompt` + `suffix` as separate fields.
 *   The server (Ollama, LM Studio) wraps them with its own FIM template.
 * - Manual (`fim` has token strings): FIM tokens embedded directly in `prompt`.
 */
async function requestFimCompletion(
  config: AutocompleteConfig,
  context: DocumentContext,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<string | undefined> {
  const { fim, endpoint, model, maxTokens, temperature } = config;
  const stop = mergeStopTokens(config.stop, model);
  const preamble = buildCompletionPreamble(context);

  const url = `${normalizeEndpoint(endpoint)}/completions`;
  const { relatedSnippets, prefix, suffix } = context;

  const body: CompletionCreateParamsNonStreaming =
    fim === true
      ? // Server-managed FIM: Ollama/LM Studio apply their own template.
        {
          model,
          prompt: preamble + prefix,
          suffix,
          max_tokens: maxTokens,
          temperature,
          stop,
          stream: false,
        }
      : {
          model,
          prompt: fim!.prefix + preamble + prefix + fim!.suffix + suffix + fim!.middle,
          max_tokens: maxTokens,
          temperature,
          stop,
          stream: false,
        };

  log.debug(`FIM mode: ${fim === true ? "server-managed" : "manual tokens"}`);
  log.debug(`Preamble:\n${preamble}`);
  log.debug(`Prefix (${prefix.length} chars):\n${prefix}`);
  log.debug(`Suffix (${suffix.length} chars):\n${suffix}`);
  log.debug(
    `Related snippets: ${relatedSnippets.length} files: [${relatedSnippets.map(s => s.relativePath).join(", ")}]`
  );
  log.debug(`FIM request URL: ${url}`);
  log.debug(`FIM request body:\n${JSON.stringify(body, null, 2)}`);

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log.error(`FIM request failed: ${response.status}`, text);
    throwApiError(response.status, text, model);
  }

  let data: Partial<CompletionResponse>;
  try {
    data = (await response.json()) as Partial<CompletionResponse>;
  } catch {
    log.error("FIM response is not valid JSON");
    return;
  }
  log.debug(`FIM raw response:\n${JSON.stringify(data, null, 2)}`);

  const raw = data.choices?.[0]?.text;
  if (!raw) return;

  log.debug(`FIM raw text: ${JSON.stringify(raw)}`);

  const cleaned = postProcessCompletion(cleanCompletion(raw), context);
  log.debug(`FIM cleaned text: ${JSON.stringify(cleaned)}`);

  return cleaned || undefined;
}

// Chat mode (/chat/completions)
/**
 * Request a chat completion as a fallback when FIM is unavailable.
 *
 * Sends the code context as an XML-structured user message with explicit
 * `<prefix>` and `<suffix>` markers so the model knows where to insert.
 */
async function requestChatCompletion(
  config: AutocompleteConfig,
  context: DocumentContext,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<string | undefined> {
  const { endpoint, model, maxTokens, temperature, stop } = config;
  const systemPrompt = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const url = `${normalizeEndpoint(endpoint)}/chat/completions`;

  const { relatedSnippets, prefix, suffix } = context;

  // eslint-disable-next-line unicorn/consistent-destructuring
  let userContent = `<file path=${quote(context.relativePath)} language=${quote(context.languageId)}>\n`;

  if (relatedSnippets.length > 0) {
    userContent += "<related_context>\n";
    for (const snippet of relatedSnippets) {
      userContent += `--- ${escapeXmlTags(snippet.relativePath)} ---\n${escapeXmlTags(snippet.content)}\n`;
    }
    userContent += "</related_context>\n";
  }

  userContent += `<prefix>${escapeXmlTags(prefix)}</prefix>\n`;
  userContent += `<suffix>${escapeXmlTags(suffix)}</suffix>\n`;
  userContent += "</file>";

  log.debug(`Chat: prefix (${prefix.length} chars):\n${prefix}`);
  log.debug(`Chat: suffix (${suffix.length} chars):\n${suffix}`);
  log.debug(
    `Chat: related snippets: ${relatedSnippets.length} files: [${relatedSnippets.map(s => s.relativePath).join(", ")}]`
  );
  log.debug(`Chat request URL: ${url}`);
  log.debug(`Chat user content:\n${userContent}`);

  const body: ChatCompletionCreateParamsBase = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
    max_tokens: maxTokens,
    temperature,
    stop,
    stream: false,
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log.error(`Chat request failed: ${response.status}`, text);
    throwApiError(response.status, text, model);
  }

  let data: Partial<CompletionResponse>;
  try {
    data = (await response.json()) as Partial<CompletionResponse>;
  } catch {
    log.error("Chat response is not valid JSON");
    return;
  }
  log.debug(`Chat raw response:\n${JSON.stringify(data, null, 2)}`);

  const raw = data.choices?.[0]?.message?.content;
  if (!raw) return;

  log.debug(`Chat raw text: ${JSON.stringify(raw)}`);

  const cleaned = postProcessCompletion(cleanCompletion(raw), context);
  log.debug(`Chat cleaned text: ${JSON.stringify(cleaned)}`);

  return cleaned || undefined;
}

// Helpers

/** Throw a typed error based on the HTTP status and response body. */
function throwApiError(status: number, body: string, model: string): never {
  const lower = body.toLowerCase();

  if (
    status === 404 &&
    lower.includes("not found") &&
    lower.includes(model.toLowerCase())
  ) {
    throw new ModelNotFoundError(model);
  }

  if (
    lower.includes("does not support chat") ||
    lower.includes("does not support generate")
  ) {
    throw new UnsupportedModeError(model, lower.includes("chat") ? "chat" : "generate");
  }

  if (lower.includes("too large") || lower.includes("requires more system memory")) {
    throw new ModelLoadError(body);
  }

  if (lower.includes("server busy") || lower.includes("maximum pending requests")) {
    throw new ServerBusyError(body);
  }

  throw new Error(`API error ${status}: ${body}`);
}

/** Strip trailing slashes from an endpoint URL. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

/**
 * Post-process a raw completion to strip markdown fences.
 *
 * Chat models frequently wrap output in `` ```lang ... ``` `` despite being
 * told not to. This strips the opening fence and truncates at the closing one.
 */
export function cleanCompletion(text: string): string {
  let result = text;

  // Strip opening fence (``` or ```lang, including non-word chars like c++)
  result = result.replace(/^\s*```[^\n]*\n?/, "");

  // Truncate at closing fence (discard it and everything after)
  const fenceIdx = result.indexOf("```");
  if (fenceIdx !== -1) {
    result = result.slice(0, fenceIdx);
  }

  return result;
}

/**
 * Escape XML-like tags used as prompt delimiters so that source code
 * containing literal `<prefix>`, `</prefix>`, `<suffix>`, etc. does not break framing.
 *
 * Inserts a zero-width space (`\u200B`) to break the tag pattern for both
 * opening and closing delimiter tags.
 */
function escapeXmlTags(text: string): string {
  return text
    .replaceAll(/<\/(prefix|suffix|file|related_context)>/g, "</$1\u200B>")
    .replaceAll(/<((?:prefix|suffix|file|related_context)[\s>])/g, "<\u200B$1");
}

/** Closing delimiter for block-comment prefixes, if any. */
const COMMENT_CLOSERS = new Map<string, string>([
  // eslint-disable-next-line unicorn/string-content
  ["<!--", " -->"],
  ["/*", " */"],
]);

/** Format related snippets as comment blocks for the FIM preamble. */
function formatSnippetsAsComments(
  snippets: readonly RelatedSnippet[],
  comment: string
): string {
  const closer = COMMENT_CLOSERS.get(comment) ?? "";
  let result = "";
  for (const snippet of snippets) {
    result += `${comment} --- ${snippet.relativePath} ---${closer}\n`;
    for (const line of snippet.content.split("\n")) {
      result += `${comment} ${line}${closer}\n`;
    }
  }
  return result;
}
