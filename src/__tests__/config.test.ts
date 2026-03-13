import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";

import {
  clearServerCaches,
  detectAutoRequestMode,
  getAuthHeaders,
  getConfig,
  isOllamaServer,
} from "../config.ts";

/** Simulates package.json defaults, matching what VS Code returns when no user value is set. */
const PACKAGE_DEFAULTS: Record<string, unknown> = {
  enable: true,
  debug: false,
  endpoint: "http://localhost:11434/v1",
  model: "",
  maxTokens: 256,
  temperature: 0.2,
  stop: ["\n\n"],
  "fim.mode": "auto",
  "fim.prefix": "",
  "fim.suffix": "",
  "fim.middle": "",
  userAgent: "vscode-autocomplete/0.1.0",
  debounceMs: 300,
  contextLines: 100,
  systemPrompt: "",
};

function mockConfiguration(values: Record<string, unknown> = {}) {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: vi.fn<(key: string, defaultValue?: unknown) => unknown>(
      (key, defaultValue) => values[key] ?? defaultValue ?? PACKAGE_DEFAULTS[key]
    ),
  } as unknown as vscode.WorkspaceConfiguration);
}

function makeDocument(uri = "file:///test.ts"): vscode.TextDocument {
  return { uri } as unknown as vscode.TextDocument;
}

function textResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, { status: 200, ...init });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, { status: 200, ...init });
}

describe("getConfig", () => {
  it("uses default endpoint when endpoint is not set", () => {
    mockConfiguration({ model: "test-model" });
    const config = getConfig(makeDocument());
    expect(config).toBeDefined();
    expect(config!.endpoint).toBe("http://localhost:11434/v1");
  });

  it("returns undefined when model is missing", () => {
    mockConfiguration({ endpoint: "http://localhost:11434/v1" });
    expect(getConfig(makeDocument())).toBeUndefined();
  });

  it("returns config with defaults when endpoint and model are set", () => {
    mockConfiguration({
      endpoint: "http://localhost:11434/v1",
      model: "qwen2.5-coder:1.5b",
    });

    const config = getConfig(makeDocument());
    expect(config).toBeDefined();
    expect(config!.endpoint).toBe("http://localhost:11434/v1");
    expect(config!.model).toBe("qwen2.5-coder:1.5b");
    expect(config!.maxTokens).toBe(256);
    expect(config!.temperature).toBe(0.2);
    expect(config!.debounceMs).toBe(300);
    expect(config!.contextLines).toBe(100);
    expect(config!.stop).toEqual(["\n\n"]);
  });

  it("resolves server-managed FIM mode", () => {
    mockConfiguration({
      endpoint: "http://localhost:11434/v1",
      model: "test",
      "fim.mode": "server-managed",
    });

    const config = getConfig(makeDocument());
    expect(config!.fim).toBe(true);
    expect(config!.requestMode).toBe("fim");
    expect(config!.fimMode).toBe("server-managed");
  });

  it("resolves custom FIM mode with tokens", () => {
    mockConfiguration({
      endpoint: "http://localhost:11434/v1",
      model: "test",
      "fim.mode": "custom",
      "fim.prefix": "<PRE>",
      "fim.suffix": "<SUF>",
      "fim.middle": "<MID>",
    });

    const config = getConfig(makeDocument());
    expect(config!.fim).toEqual({
      prefix: "<PRE>",
      suffix: "<SUF>",
      middle: "<MID>",
    });
    expect(config!.requestMode).toBe("fim");
  });

  it("falls back to undefined FIM when custom tokens are incomplete", () => {
    mockConfiguration({
      endpoint: "http://localhost:11434/v1",
      model: "test",
      "fim.mode": "custom",
      "fim.prefix": "<PRE>",
      // missing suffix and middle
    });

    const config = getConfig(makeDocument());
    expect(config!.fim).toBeUndefined();
    expect(config!.requestMode).toBe("chat");
  });

  it("leaves fim undefined and starts in chat mode for auto and off modes", () => {
    for (const mode of ["auto", "off"]) {
      mockConfiguration({
        endpoint: "http://localhost:11434/v1",
        model: "test",
        "fim.mode": mode,
      });

      const config = getConfig(makeDocument());
      expect(config!.fim).toBeUndefined();
      expect(config!.requestMode).toBe("chat");
      expect(config!.fimMode).toBe(mode);
    }
  });

  it("passes apiKey parameter through to config", () => {
    mockConfiguration({
      endpoint: "http://localhost:11434/v1",
      model: "test",
    });

    expect(getConfig(makeDocument(), "sk-key")!.apiKey).toBe("sk-key");
    expect(getConfig(makeDocument())!.apiKey).toBeUndefined();
  });
});

describe("getAuthHeaders", () => {
  it("returns only default headers when no apiKey is provided", () => {
    const headers = getAuthHeaders();
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("returns only default headers when apiKey is undefined", () => {
    mockConfiguration();
    const headers = getAuthHeaders(undefined);
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("returns only default headers when apiKey is empty string", () => {
    mockConfiguration();
    const headers = getAuthHeaders("");
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("includes Authorization header when apiKey is provided", () => {
    const headers = getAuthHeaders("sk-test-key");
    expect(headers.Authorization).toBe("Bearer sk-test-key");
  });
});

describe("isOllamaServer", () => {
  beforeEach(() => {
    clearServerCaches();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns true when server responds with Ollama banner", async () => {
    vi.mocked(fetch).mockResolvedValue(textResponse("Ollama is running"));

    const result = await isOllamaServer("http://localhost:11434/v1");
    expect(result).toBe(true);

    // Should strip /v1 and probe the root
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:11434",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("returns false for non-Ollama server", async () => {
    vi.mocked(fetch).mockResolvedValue(textResponse("OK"));

    const result = await isOllamaServer("http://localhost:8080/v1");
    expect(result).toBe(false);
  });

  it("returns false when server is unreachable", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await isOllamaServer("http://localhost:99999/v1");
    expect(result).toBe(false);
  });

  it("caches results per endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue(textResponse("Ollama is running"));

    await isOllamaServer("http://localhost:11434/v1");
    await isOllamaServer("http://localhost:11434/v1");

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("suppresses re-probes for non-OK responses within negative cache TTL", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    vi.mocked(fetch).mockResolvedValue(textResponse("Bad Gateway", { status: 502 }));

    await isOllamaServer("http://localhost:11434/v1");
    // Within TTL, should not re-probe
    await isOllamaServer("http://localhost:11434/v1");
    expect(fetch).toHaveBeenCalledOnce();

    // Past TTL, should re-probe
    now.mockReturnValue(1000 + 31_000);
    await isOllamaServer("http://localhost:11434/v1");
    expect(fetch).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it("caches successful negative result", async () => {
    // Server reachable but not Ollama. Safe to cache
    vi.mocked(fetch).mockResolvedValue(textResponse("OK"));

    await isOllamaServer("http://localhost:8080/v1");
    await isOllamaServer("http://localhost:8080/v1");

    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries after negative cache TTL expires for transient HTTP errors", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    vi.mocked(fetch)
      // First call: 502 proxy error
      .mockResolvedValueOnce(textResponse("Bad Gateway", { status: 502 }))
      // Second call: server recovered
      .mockResolvedValueOnce(textResponse("Ollama is running"));

    const r1 = await isOllamaServer("http://localhost:11434/v1");
    expect(r1).toBe(false);

    // Advance past negative cache TTL
    now.mockReturnValue(1000 + 31_000);
    const r2 = await isOllamaServer("http://localhost:11434/v1");
    expect(r2).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it("clearServerCaches resets the cache", async () => {
    vi.mocked(fetch).mockResolvedValue(textResponse("Ollama is running"));

    await isOllamaServer("http://localhost:11434/v1");
    clearServerCaches();
    await isOllamaServer("http://localhost:11434/v1");

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("recovers after transient network failure once TTL expires", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(textResponse("Ollama is running"));

    const r1 = await isOllamaServer("http://localhost:11434/v1");
    expect(r1).toBe(false);

    // Advance past negative cache TTL
    now.mockReturnValue(1000 + 31_000);
    const r2 = await isOllamaServer("http://localhost:11434/v1");
    expect(r2).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);

    now.mockRestore();
  });

  it("sends Authorization header when apiKey is provided", async () => {
    vi.mocked(fetch).mockResolvedValue(textResponse("Ollama is running"));

    await isOllamaServer("http://localhost:11434/v1", "sk-test-key");

    const headers = vi.mocked(fetch).mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test-key");
  });

  it("handles endpoint without /v1 suffix", async () => {
    vi.mocked(fetch).mockResolvedValue(textResponse("Ollama is running"));

    await isOllamaServer("http://localhost:11434");
    expect(fetch).toHaveBeenCalledWith("http://localhost:11434", expect.any(Object));
  });

  it("caches separately for different API keys", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      .mockResolvedValueOnce(textResponse("Not authorized"));

    const r1 = await isOllamaServer("http://localhost:11434/v1", "key-a");
    const r2 = await isOllamaServer("http://localhost:11434/v1", "key-b");

    expect(r1).toBe(true);
    expect(r2).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("detectAutoRequestMode", () => {
  beforeEach(() => {
    clearServerCaches();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns FIM mode when Ollama reports insert capability", async () => {
    // First call: isOllamaServer probe → "Ollama is running"
    // Second call: /api/show → capabilities
    vi.mocked(fetch)
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      .mockResolvedValueOnce(jsonResponse({ capabilities: ["completion", "insert"] }));

    const result = await detectAutoRequestMode(
      "http://localhost:11434/v1",
      "qwen2.5-coder:1.5b"
    );
    expect(result).toEqual({ requestMode: "fim", fim: true });

    // Verify both calls were made
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "http://localhost:11434",
      expect.any(Object)
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "http://localhost:11434/api/show",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("returns completion mode for prompt-only templates", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: ["completion"], template: "{{ .Prompt }}" })
      );

    const result = await detectAutoRequestMode("http://localhost:11434/v1", "llama3");
    expect(result).toEqual({ requestMode: "completion" });
  });

  it("returns chat mode when model lacks insert capability and is not prompt-only", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      .mockResolvedValueOnce(
        jsonResponse({
          capabilities: ["completion"],
          template: "{{ .System }}{{ .Prompt }}",
        })
      );

    const result = await detectAutoRequestMode("http://localhost:11434/v1", "llama3");
    expect(result).toEqual({ requestMode: "chat" });
  });

  it("skips /api/show for non-Ollama servers", async () => {
    vi.mocked(fetch).mockResolvedValue(textResponse("OK"));

    const result = await detectAutoRequestMode("http://localhost:8080/v1", "test-model");
    expect(result).toBeUndefined();

    // Only the isOllamaServer probe should have been called
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "http://localhost:8080",
      expect.any(Object)
    );
  });

  it("returns undefined when server is unreachable", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await detectAutoRequestMode("http://localhost:99999/v1", "test");
    expect(result).toBeUndefined();
  });

  it("does not cache when /api/show returns non-OK HTTP status", async () => {
    vi.mocked(fetch)
      // First: isOllamaServer succeeds
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      // First: /api/show returns 500
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal Server Error"),
      } as Response)
      // Second: isOllamaServer cached from first call
      // Second: /api/show succeeds
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: ["completion"], template: "{{ .Prompt }}" })
      );

    const r1 = await detectAutoRequestMode("http://localhost:11434/v1", "model");
    expect(r1).toBeUndefined();

    const r2 = await detectAutoRequestMode("http://localhost:11434/v1", "model");
    expect(r2).toEqual({ requestMode: "completion" });
  });

  it("recovers mode detection after transient isOllamaServer failure once TTL expires", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    vi.mocked(fetch)
      // First call: network error from isOllamaServer
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      // Second call: server recovered, isOllamaServer succeeds
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      // Second call: /api/show returns prompt-only completion support
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: ["completion"], template: "{{ .Prompt }}" })
      );

    const r1 = await detectAutoRequestMode("http://localhost:11434/v1", "model");
    expect(r1).toBeUndefined();

    // Advance past negative cache TTL
    now.mockReturnValue(1000 + 31_000);
    const r2 = await detectAutoRequestMode("http://localhost:11434/v1", "model");
    expect(r2).toEqual({ requestMode: "completion" });

    now.mockRestore();
  });

  it("sends Authorization header to both probes when apiKey is provided", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      .mockResolvedValueOnce(jsonResponse({ capabilities: ["insert"] }));

    await detectAutoRequestMode("http://localhost:11434/v1", "model", "sk-test-key");

    const ollamaHeaders = vi.mocked(fetch).mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(ollamaHeaders.Authorization).toBe("Bearer sk-test-key");

    const showHeaders = vi.mocked(fetch).mock.calls[1]![1]!.headers as Record<
      string,
      string
    >;
    expect(showHeaders.Authorization).toBe("Bearer sk-test-key");
  });

  it("caches results per endpoint+model", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: ["completion"], template: "{{ .Prompt }}" })
      );

    await detectAutoRequestMode("http://localhost:11434/v1", "model-a");
    await detectAutoRequestMode("http://localhost:11434/v1", "model-a");

    // isOllamaServer (1) + /api/show (1) = 2, second detectAutoRequestMode is cached
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("caches chat-mode results too", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: [], template: "{{ .System }}{{ .Prompt }}" })
      );

    await detectAutoRequestMode("http://localhost:11434/v1", "no-fim");
    await detectAutoRequestMode("http://localhost:11434/v1", "no-fim");

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("caches separately for different API keys", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: ["completion"], template: "{{ .Prompt }}" })
      )
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: [], template: "{{ .System }}{{ .Prompt }}" })
      );

    const r1 = await detectAutoRequestMode("http://localhost:11434/v1", "model", "key-a");
    const r2 = await detectAutoRequestMode("http://localhost:11434/v1", "model", "key-b");

    expect(r1).toEqual({ requestMode: "completion" });
    expect(r2).toEqual({ requestMode: "chat" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("clearServerCaches resets both caches", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: ["completion"], template: "{{ .Prompt }}" })
      )
      // After cache clear: isOllamaServer probe again + /api/show again
      .mockResolvedValueOnce(textResponse("Ollama is running"))
      .mockResolvedValueOnce(
        jsonResponse({ capabilities: ["completion"], template: "{{ .Prompt }}" })
      );

    await detectAutoRequestMode("http://localhost:11434/v1", "model");
    clearServerCaches();
    await detectAutoRequestMode("http://localhost:11434/v1", "model");

    // 2 calls per detectAutoRequestMode (isOllamaServer + /api/show) × 2 = 4
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
