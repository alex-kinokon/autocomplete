import { describe, expect, it } from "vitest";

import { getGrammarName, isLanguageSupported } from "../../tree-sitter/languages.ts";

describe("getGrammarName", () => {
  it("maps typescript to tree-sitter-typescript", () => {
    expect(getGrammarName("typescript")).toBe("tree-sitter-typescript");
  });

  it("maps typescriptreact to tree-sitter-tsx", () => {
    expect(getGrammarName("typescriptreact")).toBe("tree-sitter-tsx");
  });

  it("maps javascript and javascriptreact to tree-sitter-javascript", () => {
    expect(getGrammarName("javascript")).toBe("tree-sitter-javascript");
    expect(getGrammarName("javascriptreact")).toBe("tree-sitter-javascript");
  });

  it("maps python to tree-sitter-python", () => {
    expect(getGrammarName("python")).toBe("tree-sitter-python");
  });

  it("maps all supported languages", () => {
    const expected: Record<string, string> = {
      rust: "tree-sitter-rust",
      go: "tree-sitter-go",
      java: "tree-sitter-java",
      c: "tree-sitter-c",
      cpp: "tree-sitter-cpp",
      csharp: "tree-sitter-c_sharp",
    };

    for (const [lang, grammar] of Object.entries(expected)) {
      expect(getGrammarName(lang)).toBe(grammar);
    }
  });

  it("returns undefined for unsupported languages", () => {
    expect(getGrammarName("html")).toBeUndefined();
    expect(getGrammarName("css")).toBeUndefined();
    expect(getGrammarName("markdown")).toBeUndefined();
    expect(getGrammarName("")).toBeUndefined();
  });
});

describe("isLanguageSupported", () => {
  it("returns true for supported languages", () => {
    expect(isLanguageSupported("typescript")).toBe(true);
    expect(isLanguageSupported("python")).toBe(true);
    expect(isLanguageSupported("rust")).toBe(true);
  });

  it("returns false for unsupported languages", () => {
    expect(isLanguageSupported("html")).toBe(false);
    expect(isLanguageSupported("unknown")).toBe(false);
  });
});
