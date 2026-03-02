/**
 * Model selection command.
 *
 * Fetches available models from an OpenAI-compatible `/v1/models` endpoint,
 * enriches with Ollama metadata when available, and presents a quick pick.
 * The selected model is written to workspace (or global) settings.
 */
import * as vscode from "vscode";

import { getApiKey, getAuthHeaders, getSetting, isOllamaServer } from "./config.ts";
import * as log from "./log.ts";

/** Model info from the OpenAI-compatible `/v1/models` endpoint. */
interface OpenAIModel {
  readonly id: string;
}

interface OpenAIModelsResponse {
  readonly data: readonly OpenAIModel[];
}

/** Model info from Ollama’s `/api/tags` endpoint. */
interface OllamaModel {
  readonly name: string;
  readonly size: number;
  readonly parameter_size?: string;
  readonly quantization_level?: string;
}

interface OllamaTagsResponse {
  readonly models: readonly OllamaModel[];
}

/** Unified model info for display. */
interface ModelInfo {
  readonly id: string;
  readonly size?: number;
  readonly parameter_size?: string;
  readonly quantization_level?: string;
}

/**
 * Fetch models from the OpenAI-compatible `/v1/models` endpoint.
 * Returns `undefined` if the request fails.
 */
async function fetchOpenAIModels(
  endpoint: string,
  apiKey?: string
): Promise<OpenAIModel[] | undefined> {
  try {
    const url = endpoint.replace(/\/+$/, "") + "/models";
    const response = await fetch(url, {
      headers: getAuthHeaders(apiKey),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    const data = (await response.json()) as OpenAIModelsResponse;
    return Array.isArray(data.data) ? data.data : undefined;
  } catch {
    return;
  }
}

/**
 * Fetch models from Ollama’s `/api/tags` endpoint.
 * Returns `undefined` if the request fails.
 */
async function fetchOllamaModels(
  endpoint: string,
  apiKey?: string
): Promise<OllamaModel[] | undefined> {
  try {
    const base = endpoint.replace(/\/v1\/?$/, "");
    const response = await fetch(`${base}/api/tags`, {
      headers: getAuthHeaders(apiKey),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    const data = (await response.json()) as OllamaTagsResponse;
    return Array.isArray(data.models) ? data.models : undefined;
  } catch {
    return;
  }
}

/**
 * Build a unified model list. Uses `/v1/models` as primary source and enriches
 * with Ollama `/api/tags` metadata when the server is Ollama. Falls back to
 * `/api/tags` alone for backward compatibility with older Ollama versions.
 */
async function fetchModels(endpoint: string, apiKey?: string): Promise<ModelInfo[]> {
  const ollama = await isOllamaServer(endpoint, apiKey);

  const openaiModels = await fetchOpenAIModels(endpoint, apiKey);
  // Always attempt /api/tags when /v1/models is empty. `isOllamaServer` may
  // have returned false due to a transient probe failure.
  const ollamaModels =
    ollama || !openaiModels?.length
      ? await fetchOllamaModels(endpoint, apiKey)
      : undefined;

  // Build from /v1/models if available
  if (openaiModels && openaiModels.length > 0) {
    if (ollamaModels) {
      // Enrich with Ollama metadata
      const ollamaMap = new Map(ollamaModels.map(m => [m.name, m]));
      return openaiModels.map(m => {
        const enrichment = ollamaMap.get(m.id);
        return {
          id: m.id,
          size: enrichment?.size,
          parameter_size: enrichment?.parameter_size,
          quantization_level: enrichment?.quantization_level,
        };
      });
    }
    return openaiModels.map(m => ({ id: m.id }));
  }

  // Fall back to /api/tags alone (older Ollama without /v1/models)
  if (ollamaModels && ollamaModels.length > 0) {
    return ollamaModels.map(m => ({
      id: m.name,
      size: m.size,
      parameter_size: m.parameter_size,
      quantization_level: m.quantization_level,
    }));
  }

  return [];
}

/**
 * Show a quick pick of available models and update `autocomplete.model`.
 * Requires `autocomplete.endpoint` to be set.
 */
export async function selectModel(target: vscode.ConfigurationTarget): Promise<void> {
  const endpoint = getSetting("endpoint");
  if (!endpoint) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Set autocomplete.endpoint first.")
    );
    return;
  }

  const apiKey = await getApiKey();

  let models: readonly ModelInfo[];
  try {
    models = await fetchModels(endpoint, apiKey);
  } catch (e) {
    log.error("Failed to fetch models", e);
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Failed to fetch models from {0}", endpoint)
    );
    return;
  }

  if (models.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t("No models found on {0}", endpoint)
    );
    return;
  }

  const currentModel = getSetting("model");

  const items: vscode.QuickPickItem[] = models.map(m => {
    const parts: string[] = [];
    if (m.parameter_size) parts.push(m.parameter_size);
    if (m.quantization_level) parts.push(m.quantization_level);
    if (m.size) parts.push(`${(m.size / 1e9).toFixed(1)} GB`);
    const detail = parts.join(" / ") || undefined;
    return {
      label: m.id,
      description: m.id === currentModel ? vscode.l10n.t("(current)") : "",
      detail,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t("Select Model"),
    placeHolder: vscode.l10n.t("Choose a model"),
  });
  if (!picked) return;

  await vscode.workspace
    .getConfiguration("autocomplete")
    .update("model", picked.label, target);
  log.info(
    `Model changed to ${picked.label} (${target === vscode.ConfigurationTarget.Workspace ? "workspace" : "global"})`
  );
}
