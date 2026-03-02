import { describe, expect, it } from "vitest";

import { getModelStopTokens, mergeStopTokens } from "../stop-tokens.ts";

describe("getModelStopTokens", () => {
  it("returns tokens for starcoder models", () => {
    expect(getModelStopTokens("starcoder2:3b")).toContain("<|endoftext|>");
    expect(getModelStopTokens("StarCoder2-7B")).toContain("<|endoftext|>");
  });

  it("returns tokens for deepseek models", () => {
    const tokens = getModelStopTokens("deepseek-coder-v2:latest");
    expect(tokens).toContain("<|eos_token|>");
    expect(tokens.length).toBeGreaterThanOrEqual(2);
  });

  it("returns tokens for codellama models", () => {
    expect(getModelStopTokens("codellama:7b")).toContain("<|endoftext|>");
  });

  it("returns tokens for qwen models", () => {
    const tokens = getModelStopTokens("qwen2.5-coder:1.5b");
    expect(tokens).toContain("<|endoftext|>");
    expect(tokens).toContain("<|fim_pad|>");
  });

  it("returns tokens for codestral models", () => {
    expect(getModelStopTokens("codestral:latest")).toContain("[SUFFIX]");
  });

  it("returns tokens for codegemma models", () => {
    expect(getModelStopTokens("codegemma:7b")).toContain("<|file_separator|>");
  });

  it("returns empty array for unknown models", () => {
    expect(getModelStopTokens("gpt-4")).toEqual([]);
    expect(getModelStopTokens("my-custom-model")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(getModelStopTokens("STARCODER2:3b")).toContain("<|endoftext|>");
    expect(getModelStopTokens("DeepSeek-Coder")).toContain("<|eos_token|>");
  });
});

describe("mergeStopTokens", () => {
  it("appends model tokens after user tokens", () => {
    const result = mergeStopTokens(["\n\n"], "starcoder2:3b");
    expect(result[0]).toBe("\n\n");
    expect(result).toContain("<|endoftext|>");
  });

  it("deduplicates tokens already in user stops", () => {
    const result = mergeStopTokens(["\n\n", "<|endoftext|>"], "starcoder2:3b");
    const endoftextCount = result.filter(t => t === "<|endoftext|>").length;
    expect(endoftextCount).toBe(1);
  });

  it("returns user stops unchanged for unknown models", () => {
    const userStops = ["\n\n"];
    const result = mergeStopTokens(userStops, "unknown-model");
    expect(result).toBe(userStops); // same reference
  });

  it("handles empty user stops", () => {
    const result = mergeStopTokens([], "qwen2.5-coder:1.5b");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain("<|endoftext|>");
  });
});
