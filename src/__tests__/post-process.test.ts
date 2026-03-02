import { describe, expect, it } from "vitest";

import type { DocumentContext } from "../context.ts";
import {
  countBrackets,
  postProcessCompletion,
  trimTrailingWhitespace,
  truncateAtBracketImbalance,
  truncateAtUnclosedString,
} from "../post-process.ts";

const mockContext: DocumentContext = {
  prefix: "function foo() {\n  ",
  suffix: "\n}",
  languageId: "typescript",
  relativePath: "src/index.ts",
  relatedSnippets: [],
};

describe("truncateAtBracketImbalance", () => {
  it("returns text unchanged when brackets are balanced", () => {
    expect(truncateAtBracketImbalance("foo(bar())")).toBe("foo(bar())");
  });

  it("truncates before extra closing paren", () => {
    expect(truncateAtBracketImbalance("foo(bar))")).toBe("foo(bar)");
  });

  it("truncates before extra closing brace", () => {
    expect(truncateAtBracketImbalance("if (x) {\n  return 1;\n}\n}")).toBe(
      "if (x) {\n  return 1;\n}\n"
    );
  });

  it("truncates before extra closing bracket", () => {
    expect(truncateAtBracketImbalance("[1, 2]]")).toBe("[1, 2]");
  });

  it("ignores brackets inside strings", () => {
    expect(truncateAtBracketImbalance('"some ) text"')).toBe('"some ) text"');
    expect(truncateAtBracketImbalance("'some } text'")).toBe("'some } text'");
  });

  it("ignores brackets inside line comments", () => {
    expect(truncateAtBracketImbalance("x // extra )\ny")).toBe("x // extra )\ny");
  });

  it("ignores brackets inside block comments", () => {
    expect(truncateAtBracketImbalance("x /* } */ y")).toBe("x /* } */ y");
  });

  it("handles escaped quotes in strings", () => {
    // The string "a\"b" is properly closed, so the ) after it has no opener
    expect(truncateAtBracketImbalance(String.raw`"a\"b"`)).toBe(String.raw`"a\"b"`);
    // With a balanced paren, everything passes through
    expect(truncateAtBracketImbalance(String.raw`("a\"b")`)).toBe(String.raw`("a\"b")`);
  });

  it("handles template literals", () => {
    expect(truncateAtBracketImbalance("`foo }`")).toBe("`foo }`");
  });

  it("returns empty string for immediate closer", () => {
    expect(truncateAtBracketImbalance("}")).toBe("");
  });
});

describe("truncateAtUnclosedString", () => {
  it("returns text unchanged when no unclosed strings", () => {
    expect(truncateAtUnclosedString('"hello"')).toBe('"hello"');
  });

  it("truncates at last safe newline for unclosed double quote", () => {
    expect(truncateAtUnclosedString('let x = 1;\n"unclosed')).toBe("let x = 1;");
  });

  it("truncates at last safe newline for unclosed single quote", () => {
    expect(truncateAtUnclosedString("let x = 1;\n'unclosed")).toBe("let x = 1;");
  });

  it("allows template literals to span lines", () => {
    const text = "`line1\nline2`";
    expect(truncateAtUnclosedString(text)).toBe(text);
  });

  it("handles escaped quotes inside strings", () => {
    expect(truncateAtUnclosedString(String.raw`"hello\"world"`)).toBe(
      String.raw`"hello\"world"`
    );
  });

  it("rejects single-line unclosed string with no safe newline", () => {
    expect(truncateAtUnclosedString('"unclosed')).toBe("");
  });
});

describe("trimTrailingWhitespace", () => {
  it("trims trailing spaces from each line", () => {
    expect(trimTrailingWhitespace("foo   \nbar  ")).toBe("foo\nbar");
  });

  it("removes trailing blank lines", () => {
    expect(trimTrailingWhitespace("foo\n\n\n")).toBe("foo");
  });

  it("handles empty string", () => {
    expect(trimTrailingWhitespace("")).toBe("");
  });

  it("preserves indentation", () => {
    expect(trimTrailingWhitespace("  foo  \n    bar  ")).toBe("  foo\n    bar");
  });
});

describe("countBrackets", () => {
  it("counts unclosed openers in balanced prefix", () => {
    expect(countBrackets("foo(bar())")).toEqual({ "(": 0, "{": 0, "[": 0 });
  });

  it("counts unclosed openers", () => {
    expect(countBrackets("function foo() {\n  ")).toEqual({ "(": 0, "{": 1, "[": 0 });
  });

  it("counts multiple unclosed openers", () => {
    expect(countBrackets("if (x) { arr[")).toEqual({ "(": 0, "{": 1, "[": 1 });
  });

  it("clamps negatives to zero (extra closers in prefix)", () => {
    expect(countBrackets("}")).toEqual({ "(": 0, "{": 0, "[": 0 });
  });

  it("ignores brackets inside strings and comments", () => {
    expect(countBrackets('"({[" // )]}')).toEqual({ "(": 0, "{": 0, "[": 0 });
  });
});

describe("truncateAtBracketImbalance with prefix context", () => {
  it("allows closer that matches opener in prefix", () => {
    const prefixCounts = countBrackets("function foo() {\n  return 1;\n");
    expect(truncateAtBracketImbalance("}\n", prefixCounts)).toBe("}\n");
  });

  it("still truncates at double closer when prefix has one opener", () => {
    const prefixCounts = countBrackets("function foo() {\n");
    expect(truncateAtBracketImbalance("}}", prefixCounts)).toBe("}");
  });

  it("allows nested closers matching prefix", () => {
    const prefixCounts = countBrackets("if (arr[");
    expect(truncateAtBracketImbalance("0])")).toBe("0");
    expect(truncateAtBracketImbalance("0])", prefixCounts)).toBe("0])");
  });
});

describe("postProcessCompletion", () => {
  it("runs the full pipeline", () => {
    // Has an extra closing brace and trailing whitespace
    const input = "return 1;\n}  \n\n";
    const result = postProcessCompletion(input, mockContext);
    // The prefix "function foo() {\n  " has one unclosed brace,
    // so the first } is valid but the second would be excess.
    expect(result).toBe("return 1;\n}");
  });

  it("passes through clean completions", () => {
    const input = "const x = 1;";
    expect(postProcessCompletion(input, mockContext)).toBe("const x = 1;");
  });

  it("allows completion starting with closer when prefix has opener", () => {
    const context: DocumentContext = {
      prefix: "function foo() {\n  return 1;\n",
      suffix: "\n",
      languageId: "typescript",
      relativePath: "src/index.ts",
      relatedSnippets: [],
    };
    expect(postProcessCompletion("}", context)).toBe("}");
  });
});
